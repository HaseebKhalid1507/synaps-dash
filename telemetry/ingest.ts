// Ingest: read-only tail of every source into the store. Never writes, moves,
// truncates or locks a source file — open(O_RDONLY), read, close.
//
// Streamed sources (api-log, request-trace, synaps.log.*) keep a byte offset per
// (logical source, inode), plus the file's first 64 bytes as a fingerprint.
// Synaps rotates by rename (X → X.1, fresh X), so the old inode shows up as
// X.1: we finish it from its saved offset, then start the new X at 0. A file
// smaller than its offset, or whose head changed, was truncated/replaced →
// restart at 0. Only complete lines are consumed. Inserts are INSERT OR IGNORE
// on natural keys, so re-reading anything is harmless (idempotent).
//
// Whole-file sources (sessions/*.json, subagent-history/*/sa_N.json) are
// re-read only when mtime or size change.

import type { Database } from "bun:sqlite";
import { openSync, readSync, closeSync, statSync, readdirSync, existsSync, fstatSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { parseLine, parseApiLog, parseTrace, parseLegacy, parseSession, parseWorkerHead, archiveRefs, type RequestRow, type TraceRow } from "./parse.ts";
import { cacheSavings } from "./pricing.ts";
import { dayOf } from "./tz.ts";
import { metaGet, metaSet } from "./schema.ts";

export type HostRoot = { host: string; root: string; cacheDir: string; sessionsDir: string; subagentsDir: string; logsDir: string };

/** A source root is either a home dir (~/.cache/synaps + ~/.synaps-cli) or a
 *  snapshot dir laid out as {cache/, sessions/, subagent-history/, logs/}. */
export function resolveRoot(host: string, root: string): HostRoot {
  root = root.replace(/^~(?=$|\/)/, homedir());
  if (existsSync(join(root, ".synaps-cli")) || existsSync(join(root, ".cache", "synaps"))) {
    const base = join(root, ".synaps-cli");
    return { host, root, cacheDir: join(root, ".cache", "synaps"), sessionsDir: join(base, "sessions"), subagentsDir: join(base, "subagent-history"), logsDir: base };
  }
  return { host, root, cacheDir: join(root, "cache"), sessionsDir: join(root, "sessions"), subagentsDir: join(root, "subagent-history"), logsDir: join(root, "logs") };
}

/** The running machine: honours SYNAPS_BASE_DIR like main.ts does. */
export function localRoot(host: string): HostRoot {
  const home = homedir();
  const base = process.env.SYNAPS_BASE_DIR || join(home, ".synaps-cli");
  return { host, root: home, cacheDir: join(home, ".cache", "synaps"), sessionsDir: join(base, "sessions"), subagentsDir: join(base, "subagent-history"), logsDir: base };
}

/** "jade=/path, lab=/other" → roots. Invalid entries are ignored. */
export function parseSources(spec: string | null | undefined): HostRoot[] {
  const out: HostRoot[] = [];
  for (const part of (spec ?? "").split(/[,;\n]/)) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/.exec(part);
    if (m) out.push(resolveRoot(m[1], m[2]));
  }
  return out;
}

export type IngestStats = { ms: number; requests: number; traces: number; legacy: number; sessions: number; workers: number; bad_lines: number; errors: number };

const CHUNK = 4 << 20;
const BATCH = 5000;
const HEAD = 64;
const LEGACY_MARK = Buffer.from("Token Usage:");

type Ctx = { db: Database; st: IngestStats; stmts: ReturnType<typeof prepare>; onError: (where: string, e: unknown) => void };

function prepare(db: Database) {
  return {
    req: db.prepare(`INSERT OR IGNORE INTO requests VALUES (
      $request_id,$host,$ts,$day,$wd,$hour,$model,$attempt,$ttft_ms,$total_ms,$stop,$input,$output,$cache_read,$cache_write,$cw5m,$cw1h,
      $ctx_messages,$ctx_tools,$system_bytes,$worker,$keepwarm,$miss_reason,$missed_tokens,$refusal_retries,$cost,$saved,$cost_reported,
      $session_id,$turn_id,$agent,$handle,$parent_session,$sid)`),
    trace: db.prepare(`INSERT OR IGNORE INTO traces VALUES (
      $key,$host,$ts,$session_id,$turn_id,$local_request_id,$attempt,$provider_request_id,$model,$wire_bytes,$message_count,$tool_count,
      $headers_ms,$first_byte_ms,$first_event_ms,$stream_end_ms,$retries,$losses,$http_status,$stop)`),
    legacy: db.prepare(`INSERT OR IGNORE INTO legacy_usage VALUES (?,?,?,?,?,?,?,?,?)`),
    stateGet: db.prepare(`SELECT offset, head FROM ingest_state WHERE source = ? AND inode = ?`),
    statePut: db.prepare(`INSERT INTO ingest_state VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source, inode) DO UPDATE SET path=excluded.path, size=excluded.size, offset=excluded.offset, head=excluded.head, updated_at=excluded.updated_at`),
    fileGet: db.prepare(`SELECT mtime, size FROM file_state WHERE path = ?`),
    filePut: db.prepare(`INSERT INTO file_state VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, status=excluded.status`),
    session: db.prepare(`INSERT INTO sessions VALUES ($id,$host,$title,$model,$created,$updated,$created_day,$input,$output,$cache_read,$cache_write,$cost,$saved,$message_count,$path)
      ON CONFLICT(id) DO UPDATE SET host=excluded.host, title=excluded.title, model=excluded.model, created=excluded.created, updated=excluded.updated,
        created_day=excluded.created_day, input=excluded.input, output=excluded.output, cache_read=excluded.cache_read, cache_write=excluded.cache_write,
        cost=excluded.cost, saved=excluded.saved, message_count=excluded.message_count, path=excluded.path
      WHERE excluded.updated > sessions.updated OR (excluded.host = sessions.host AND excluded.updated >= sessions.updated)`),
    link: db.prepare(`INSERT OR IGNORE INTO worker_links VALUES (?,?,?)`),
    worker: db.prepare(`INSERT INTO workers VALUES (?,?,?,?,?,?,?) ON CONFLICT(host, proc, handle) DO UPDATE SET agent=excluded.agent, model=excluded.model, status=excluded.status, mtime=excluded.mtime`),
  };
}

const bind = (o: Record<string, unknown>) => {
  const b: Record<string, any> = {};
  for (const k in o) b["$" + k] = o[k];
  return b;
};

/** Tail one logical source across its generations (oldest first). */
function streamSource(ctx: Ctx, host: string, kind: string, source: string, files: string[], onLine: (line: string, absOff: number, file: string) => void, flush: () => void, marker?: Buffer) {
  const { db, stmts } = ctx;
  const live = new Set<number>();
  for (const path of files) {
    let fd: number;
    try { fd = openSync(path, "r"); } catch { continue; }
    try {
      const s = fstatSync(fd);
      if (!s.isFile()) continue;
      const inode = Number(s.ino), size = s.size;
      live.add(inode);
      const hb = Buffer.alloc(Math.min(HEAD, size));
      if (hb.length) readSync(fd, hb, 0, hb.length, 0);
      const head = hb.toString("base64");
      const prev = stmts.stateGet.get(source, inode) as { offset: number; head: string } | null;
      let offset = 0;
      if (prev) {
        const ph = Buffer.from(prev.head, "base64");
        const sameHead = ph.length <= hb.length && hb.subarray(0, ph.length).equals(ph);
        offset = sameHead && size >= prev.offset ? prev.offset : 0; // else truncated / replaced
      }
      if (offset === size) {
        if (!prev || prev.head !== head) stmts.statePut.run(source, inode, host, kind, path, size, offset, head, Date.now());
        continue;
      }
      let pos = offset, consumed = offset, carry: Buffer = Buffer.alloc(0), pending = 0;
      const commit = () => db.transaction(() => { flush(); stmts.statePut.run(source, inode, host, kind, path, size, consumed, head, Date.now()); })();
      while (pos < size) {
        const n = Math.min(CHUNK, size - pos);
        const b = Buffer.allocUnsafe(n);
        const got = readSync(fd, b, 0, n, pos);
        if (got <= 0) break;
        const base = pos - carry.length; // absolute offset of buf[0]
        pos += got;
        const buf = carry.length ? Buffer.concat([carry, b.subarray(0, got)]) : b.subarray(0, got);
        let start = 0;
        if (marker) {
          // Sparse scan: only lines containing the marker are decoded.
          const lastNl = buf.lastIndexOf(10);
          let at = buf.indexOf(marker, 0);
          while (at >= 0 && at < lastNl) {
            const ls = buf.lastIndexOf(10, at) + 1, le = buf.indexOf(10, at);
            onLine(buf.toString("utf8", ls, le), base + ls, path);
            pending++;
            at = buf.indexOf(marker, le);
          }
          start = lastNl + 1;
        } else {
          let nl: number;
          while ((nl = buf.indexOf(10, start)) >= 0) {
            if (nl > start) { onLine(buf.toString("utf8", start, nl), base + start, path); pending++; }
            start = nl + 1;
          }
        }
        carry = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
        consumed = base + start;
        if (pending >= BATCH) { commit(); pending = 0; }
      }
      commit();
    } catch (e) {
      ctx.onError(`${kind} ${path}`, e);
    } finally {
      closeSync(fd);
    }
  }
  // Generations that no longer exist (e.g. the old .1 after a second rotation).
  const known = db.query(`SELECT inode FROM ingest_state WHERE source = ?`).all(source) as { inode: number }[];
  for (const k of known) if (!live.has(k.inode)) db.query(`DELETE FROM ingest_state WHERE source = ? AND inode = ?`).run(source, k.inode);
}

function ingestJsonl(ctx: Ctx, r: HostRoot) {
  const { stmts, st } = ctx;
  let reqs: RequestRow[] = [], traces: TraceRow[] = [];
  const api = join(r.cacheDir, "api-log.jsonl");
  streamSource(ctx, r.host, "api-log", `${r.host}:api-log`, [api + ".1", api], (line) => {
    const objs = parseLine(line);
    if (!objs.length) st.bad_lines++;
    for (const o of objs) { const row = parseApiLog(o, r.host); if (row) reqs.push(row); else st.bad_lines++; }
  }, () => { for (const x of reqs) st.requests += stmts.req.run(bind(x)).changes; reqs = []; });
  const tr = join(r.cacheDir, "request-trace.jsonl");
  streamSource(ctx, r.host, "request-trace", `${r.host}:request-trace`, [tr + ".1", tr], (line) => {
    const objs = parseLine(line);
    if (!objs.length) st.bad_lines++;
    for (const o of objs) { const row = parseTrace(o, r.host); if (row) traces.push(row); else st.bad_lines++; }
  }, () => { for (const x of traces) st.traces += stmts.trace.run(bind(x)).changes; traces = []; });
}

function ingestLegacy(ctx: Ctx, r: HostRoot) {
  let names: string[];
  try { names = readdirSync(r.logsDir).filter((n) => /^synaps\.log\.\d{4}-\d\d-\d\d$/.test(n)).sort(); } catch { return; }
  let rows: any[][] = [];
  for (const n of names) {
    streamSource(ctx, r.host, "log", `${r.host}:log:${n}`, [join(r.logsDir, n)], (line, off) => {
      const x = parseLegacy(line);
      if (x) rows.push([r.host, n, off, x.ts, x.day, x.input, x.output, x.cache_read, x.cache_create]);
    }, () => { for (const x of rows) ctx.st.legacy += ctx.stmts.legacy.run(...x).changes; rows = []; }, LEGACY_MARK);
  }
}

function changed(ctx: Ctx, path: string): { mtime: number; size: number } | null {
  let s;
  try { s = statSync(path); } catch { return null; }
  if (!s.isFile()) return null;
  const prev = ctx.stmts.fileGet.get(path) as { mtime: number; size: number } | null;
  const mtime = Math.floor(s.mtimeMs);
  if (prev && prev.mtime === mtime && prev.size === s.size) return null;
  return { mtime, size: s.size };
}

function ingestSessions(ctx: Ctx, r: HostRoot, deadline: number) {
  let names: string[];
  try { names = readdirSync(r.sessionsDir).sort(); } catch { return; }
  const { db, stmts } = ctx;
  let batch: (() => void)[] = [];
  const flush = () => { if (batch.length) db.transaction(() => { for (const f of batch) f(); })(); batch = []; };
  for (const n of names) {
    const path = join(r.sessionsDir, n);
    const c = changed(ctx, path);
    if (!c) continue;
    if (!n.endsWith(".json")) { batch.push(() => stmts.filePut.run(path, r.host, "session", c.mtime, c.size, "skip")); continue; }
    let text: string;
    try { text = readFileText(path); } catch (e) { ctx.onError(`session ${path}`, e); continue; }
    const s = parseSession(text);
    const refs = s ? archiveRefs(text) : [];
    batch.push(() => {
      if (s) {
        ctx.st.sessions += stmts.session.run(bind({ ...s, host: r.host, created_day: dayOf(s.created), saved: cacheSavings(s.model, s.input, s.cache_read ?? 0, s.cache_write ?? 0, 0), path })).changes;
        for (const [proc, handle] of refs) stmts.link.run(proc, handle, s.id);
      }
      stmts.filePut.run(path, r.host, "session", c.mtime, c.size, s ? "ok" : "skip");
    });
    if (batch.length >= 50) flush();
    if (Date.now() > deadline) break;
  }
  flush();
}

function readFileText(path: string, max = Infinity): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, max);
    const b = Buffer.allocUnsafe(n);
    let got = 0;
    while (got < n) { const k = readSync(fd, b, got, n - got, got); if (k <= 0) break; got += k; }
    return b.toString("utf8", 0, got);
  } finally { closeSync(fd); }
}

function ingestWorkers(ctx: Ctx, r: HostRoot, deadline: number) {
  let procs: string[];
  try { procs = readdirSync(r.subagentsDir).sort(); } catch { return; }
  const { db, stmts } = ctx;
  let batch: (() => void)[] = [];
  const flush = () => { if (batch.length) db.transaction(() => { for (const f of batch) f(); })(); batch = []; };
  for (const proc of procs) {
    let files: string[];
    try { files = readdirSync(join(r.subagentsDir, proc)).filter((f) => /^sa_\d+\.json$/.test(f)); } catch { continue; }
    for (const f of files) {
      const path = join(r.subagentsDir, proc, f);
      const c = changed(ctx, path);
      if (!c) continue;
      let h = null;
      try {
        h = parseWorkerHead(readFileText(path, 256 << 10));
        if (!h && c.size > 256 << 10) h = parseWorkerHead(readFileText(path));
      } catch (e) { ctx.onError(`worker ${path}`, e); continue; }
      batch.push(() => {
        if (h) ctx.st.workers += stmts.worker.run(r.host, proc, basename(f, ".json"), h.agent, h.model, h.status, c.mtime).changes;
        stmts.filePut.run(path, r.host, "worker", c.mtime, c.size, h ? "ok" : "skip");
      });
      if (batch.length >= 200) flush();
    }
    if (Date.now() > deadline) break;
  }
  flush();
}

/** One full pass over every root. Never throws: failures are counted in meta. */
export function ingestOnce(db: Database, roots: HostRoot[], opts: { budgetMs?: number } = {}): IngestStats {
  const t0 = performance.now();
  const deadline = Date.now() + (opts.budgetMs ?? 10 * 60_000);
  const st: IngestStats = { ms: 0, requests: 0, traces: 0, legacy: 0, sessions: 0, workers: 0, bad_lines: 0, errors: 0 };
  const ctx: Ctx = {
    db, st, stmts: prepare(db),
    onError: (where, e) => {
      st.errors++;
      try { metaSet(db, "last_error", `${new Date().toISOString()} ${where}: ${String(e).slice(0, 300)}`); } catch {}
    },
  };
  for (const r of roots) {
    for (const [name, fn] of [["jsonl", () => ingestJsonl(ctx, r)], ["legacy", () => ingestLegacy(ctx, r)], ["sessions", () => ingestSessions(ctx, r, deadline)], ["workers", () => ingestWorkers(ctx, r, deadline)]] as const) {
      try { fn(); } catch (e) { ctx.onError(`${r.host} ${name}`, e); }
    }
  }
  st.ms = Math.round(performance.now() - t0);
  try {
    db.transaction(() => {
      metaSet(db, "last_run", Date.now());
      metaSet(db, "last_run_ms", st.ms);
      metaSet(db, "errors", Number(metaGet(db, "errors") ?? 0) + st.errors);
      metaSet(db, "bad_lines", Number(metaGet(db, "bad_lines") ?? 0) + st.bad_lines);
      metaSet(db, "roots", JSON.stringify(roots.map((r) => ({ host: r.host, root: r.root }))));
    })();
  } catch {}
  return st;
}
