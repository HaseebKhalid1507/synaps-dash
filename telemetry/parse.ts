// Pure parsers: one source record in, one row out (or null). No I/O here.

import { costOptionalSplit, cacheSavings } from "./pricing.ts";
import { local } from "./tz.ts";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** "anthropic/claude-opus-5-5" → "claude-opus-5-5" (display/group key). */
export const modelKey = (m: string | null | undefined): string => (m ? m.replace(/^[^/]+\//, "") : "unknown");

export const TTFT_FLOOR_MS = 50;

export type RequestRow = {
  request_id: string; host: string; ts: number; day: string; wd: number; hour: number;
  model: string; attempt: number; ttft_ms: number | null; total_ms: number | null; stop: string | null;
  input: number; output: number; cache_read: number; cache_write: number; cw5m: number; cw1h: number;
  ctx_messages: number | null; ctx_tools: number | null; system_bytes: number | null;
  worker: number; keepwarm: number; miss_reason: string | null; missed_tokens: number | null; refusal_retries: number;
  cost: number; saved: number; cost_reported: number | null;
  session_id: string | null; turn_id: string | null; agent: string | null; handle: string | null; parent_session: string | null; sid: string | null;
};

/** Concurrent appenders occasionally glue two records onto one line
 *  (`{…}{…}`). Split at top-level object boundaries (string-aware). */
export function splitObjects(line: string): string[] {
  const out: string[] = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123) { if (depth++ === 0) start = i; }
    else if (c === 125 && depth > 0 && --depth === 0) out.push(line.slice(start, i + 1));
  }
  return out;
}

/** Every JSON object on a line: normally one; several when appends collided; none if malformed. */
export function parseLine(line: string): any[] {
  try { return [JSON.parse(line)]; } catch {}
  const parts = splitObjects(line);
  if (parts.length < 2) return [];
  const out: any[] = [];
  for (const p of parts) { try { out.push(JSON.parse(p)); } catch {} }
  return out;
}

export function parseApiLog(line: string | object, host: string): RequestRow | null {
  let d: any = line;
  if (typeof line === "string") { try { d = JSON.parse(line); } catch { return null; } }
  if (!d || typeof d !== "object") return null;
  const rid = str(d.request_id), ts = optNum(d.ts);
  if (!rid || ts === null) return null;
  const u = d.usage ?? {};
  const input = num(u.input), output = num(u.output), cr = num(u.cache_read), cw = num(u.cache_write);
  const c5 = optNum(u.cache_write_5m), c1 = optNum(u.cache_write_1h);
  const model = modelKey(str(d.model));
  // Bill exactly like pricing.rs: known TTL buckets kept, remainder at 1h.
  const cw5 = c5 ?? (c1 === null ? cw : 0);
  const cw1 = (c1 ?? 0) + (c5 !== null || c1 !== null ? Math.max(0, cw - ((c5 ?? 0) + (c1 ?? 0))) : 0);
  const w = d.worker;
  const wobj = w && typeof w === "object" ? w : {};
  const isWorker = w === true || (w && typeof w === "object") || !!str(d.parent_session_id) ? 1 : 0;
  const session_id = str(d.session_id);
  const parent = str(wobj.parent_session_id) ?? str(wobj.parent) ?? str(d.parent_session_id);
  const L = local(ts);
  const ttft = optNum(d.ttft_ms);
  return {
    request_id: rid, host, ts, day: L.day, wd: L.wd, hour: L.hour,
    model, attempt: num(d.attempt) || 1,
    // api-log ttft_ms is broken upstream: 0 in ~99% of rows, and the rest are 1–40 ms
    // (no real TTFT is that fast). Below TTFT_FLOOR_MS → null; the trace join fills TTFT in.
    ttft_ms: ttft !== null && ttft >= TTFT_FLOOR_MS ? ttft : null,
    total_ms: optNum(d.total_ms), stop: str(d.stop_reason),
    input, output, cache_read: cr, cache_write: cw, cw5m: cw5, cw1h: cw1,
    ctx_messages: optNum(d.context?.messages), ctx_tools: optNum(d.context?.tools), system_bytes: optNum(d.context?.system_bytes),
    worker: isWorker, keepwarm: d.keepwarm === true ? 1 : 0,
    miss_reason: str(d.cache_diag?.miss_reason), missed_tokens: optNum(d.cache_diag?.missed_tokens),
    refusal_retries: num(d.refusal_retries_used),
    cost: costOptionalSplit(model, input, output, cr, cw, c5, c1),
    saved: cacheSavings(model, input, cr, cw5, cw1),
    cost_reported: optNum(d.cost_usd),
    session_id, turn_id: str(d.turn_id),
    agent: str(wobj.agent_name) ?? str(wobj.agent) ?? str(wobj.name) ?? str(d.agent_name),
    handle: str(wobj.handle_id) ?? str(wobj.handle) ?? str(d.handle_id),
    parent_session: parent,
    sid: parent ?? session_id,
  };
}

export type TraceRow = {
  key: string; host: string; ts: number | null; session_id: string | null; turn_id: string | null; local_request_id: string | null;
  attempt: number; provider_request_id: string | null; model: string; wire_bytes: number | null; message_count: number | null;
  tool_count: number | null; headers_ms: number | null; first_byte_ms: number | null; first_event_ms: number | null;
  stream_end_ms: number | null; retries: number; losses: number; http_status: number | null; stop: string | null;
};

export function parseTrace(line: string | object, host: string): TraceRow | null {
  let d: any = line;
  if (typeof line === "string") { try { d = JSON.parse(line); } catch { return null; } }
  if (!d || typeof d !== "object" || typeof d.schema !== "string" || !d.schema.startsWith("synaps-request-trace/")) return null;
  const o = d.outcome ?? {}, t = o.timings ?? {};
  const prid = str(o.provider_request_id);
  const sid = str(d.session_id), lrid = str(d.request_id);
  const attempt = num(d.attempt) || 1;
  const key = prid ?? `${host}:${sid}:${lrid}:${attempt}:${num(t.send_start_unix_ms)}`;
  const losses = Array.isArray(d.translation_losses) ? d.translation_losses.filter((x: any) => x?.action !== "synthesized").length : 0;
  return {
    key, host, ts: optNum(t.send_start_unix_ms), session_id: sid, turn_id: str(d.turn_id), local_request_id: lrid, attempt,
    provider_request_id: prid, model: modelKey(str(d.model)), wire_bytes: optNum(d.wire?.byte_len),
    message_count: optNum(d.anatomy?.message_count), tool_count: optNum(d.anatomy?.tool_count),
    headers_ms: optNum(t.headers_ms), first_byte_ms: optNum(t.first_byte_ms), first_event_ms: optNum(t.first_model_event_ms),
    stream_end_ms: optNum(t.stream_end_ms), retries: Array.isArray(o.retries) ? o.retries.length : 0, losses,
    http_status: optNum(o.http_status), stop: str(o.stop_reason),
  };
}

// 2026-05-18T02:50:45.824568Z DEBUG ThreadId(05) Token Usage: 6 input | 3 output | 0 cache_read | 4731 cache_create
const LEGACY_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s.*?Token Usage: (\d+) input \| (\d+) output \| (\d+) cache_read \| (\d+) cache_create/;

export type LegacyRow = { ts: number; day: string; input: number; output: number; cache_read: number; cache_create: number };

export function parseLegacy(line: string): LegacyRow | null {
  if (!line.includes("Token Usage:")) return null;
  const m = LEGACY_RE.exec(line);
  if (!m) return null;
  const iso = m[1].length > 24 ? m[1].slice(0, 23) + "Z" : m[1];
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return { ts, day: local(ts).day, input: +m[2], output: +m[3], cache_read: +m[4], cache_create: +m[5] };
}

export type SessionRow = {
  id: string; title: string | null; model: string; created: number; updated: number;
  input: number; output: number; cache_read: number | null; cache_write: number | null; cost: number; message_count: number | null;
};

/** Header-only parse when possible: everything before "api_messages" (a raw,
 *  unescaped `"api_messages":` can only be a key), full parse as fallback. */
export function parseSession(text: string): SessionRow | null {
  let d: any = null;
  const i = text.indexOf(',"api_messages":');
  if (i > 0) { try { d = JSON.parse(text.slice(0, i) + "}"); } catch { d = null; } }
  if (!d) { try { d = JSON.parse(text); } catch { return null; } }
  if (!d || typeof d !== "object" || typeof d.id !== "string") return null;
  const created = Date.parse(d.created_at), updated = Date.parse(d.updated_at ?? d.created_at);
  if (!Number.isFinite(created)) return null;
  return {
    id: d.id, title: str(d.title) ?? str(d.name), model: modelKey(str(d.model)), created, updated: Number.isFinite(updated) ? updated : created,
    input: num(d.total_input_tokens), output: num(d.total_output_tokens),
    // older session files predate the cache totals: unknown, not zero
    cache_read: optNum(d.total_cache_read_tokens), cache_write: optNum(d.total_cache_creation_tokens), cost: num(d.session_cost), message_count: optNum(d.message_count),
  };
}

// Tool results of subagent dispatch/collect carry `"archive_path":"…/subagent-history/<proc>/<sa_N>.json"`
// (JSON-escaped inside the session file). That is the only parent→worker link on disk.
const ARCHIVE_RE = /archive_path\\?"\s*:\s*\\?"[^"\\]*?subagent-history\/([\w.-]+)\/(sa_\d+)\.json/g;

export function archiveRefs(text: string): [string, string][] {
  const out = new Map<string, [string, string]>();
  if (!text.includes("subagent-history/")) return [];
  for (const m of text.matchAll(ARCHIVE_RE)) out.set(`${m[1]}/${m[2]}`, [m[1], m[2]]);
  return [...out.values()];
}

export type WorkerHead = { handle: string; agent: string | null; model: string; status: string | null };

/** Only the head of a subagent archive: version, handle_id, meta, status. */
export function parseWorkerHead(text: string): WorkerHead | null {
  let d: any = null;
  for (const marker of [',"output":', ',"history":']) {
    const i = text.indexOf(marker);
    if (i > 0) { try { d = JSON.parse(text.slice(0, i) + "}"); break; } catch { d = null; } }
  }
  if (!d) { try { d = JSON.parse(text); } catch { return null; } }
  if (!d || typeof d !== "object" || typeof d.handle_id !== "string") return null;
  return { handle: d.handle_id, agent: str(d.meta?.agent_name), model: modelKey(str(d.meta?.model)), status: str(d.status) };
}
