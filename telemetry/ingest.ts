// Ingest: read-only tail of every source into the store. Never writes, moves,
// truncates or locks a source file: open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK), read,
// close. Symlinks, FIFOs, sockets and devices are skipped (and counted).
//
// Streamed sources (api-log, request-trace, synaps.log.*) keep a byte offset per
// (logical source, inode), plus the file's first 64 bytes as a fingerprint.
// Synaps rotates by rename (X → X.1, fresh X), so the old inode shows up as
// X.1: we finish it from its saved offset, then start the new X at 0. A file
// smaller than its offset, or whose head changed, was truncated/replaced →
// restart at 0. Only complete lines are consumed. An inode's state is dropped
// only after it has been absent for 2 passes (a rotation landing mid-pass must
// not cost a re-read); if it vanishes with unread bytes, they're counted in
// meta lost_bytes. Inserts are INSERT OR IGNORE on natural keys, so re-reading
// anything is harmless (idempotent).
//
// Whole-file sources (sessions/*.json, subagent-history/*/sa_N.json) are
// re-read only when mtime or size change, and only a bounded head is parsed;
// archive_path links are found by a chunked scan. Deleted files are pruned.
//
// After the sources, the pass refreshes what the HTTP side reads: the derived
// sessions table (origin host + grain), daily rollups for the days it touched,
// and table counts in meta.

import type { Database } from "bun:sqlite";
import { openSync, readSync, closeSync, readdirSync, existsSync, fstatSync, lstatSync, constants } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { parseLine, parseApiLog, parseTrace, parseLegacy, parseSession, parseWorkerHead, archiveRefs, type RequestRow, type TraceRow } from "./parse.ts";
import { cacheSavings, cacheNetSavings } from "./pricing.ts";
import { dayOf } from "./tz.ts";
import { metaGet, metaSet } from "./schema.ts";
import { rebuildRollupDays } from "./rollup.ts";

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

/** The running machine, profile-aware like main.ts sessionsDir() and Synaps' own paths:
 *  sessions + synaps.log.* live in <base>/<profile>/, subagent-history in <base>/, and the
 *  api-log/trace in ~/.cache/synaps (shared by every profile). */
export function localRoot(host: string, profile: string | null = null): HostRoot {
  const home = homedir();
  const base = process.env.SYNAPS_BASE_DIR || join(home, ".synaps-cli");
  const pdir = profile ? join(base, profile) : base;
  return { host, root: home, cacheDir: join(home, ".cache", "synaps"), sessionsDir: join(pdir, "sessions"), subagentsDir: join(base, "subagent-history"), logsDir: pdir };
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

export type IngestStats = { ms: number; requests: number; traces: number; legacy: number; sessions: number; workers: number; bad_lines: number; errors: number; lost_bytes: number; pruned: number };
export type IngestOpts = { budgetMs?: number; chunk?: number; headBytes?: number; onProgress?: () => void };

const HEAD = 64;
const LEGACY_MARK = Buffer.from("Token Usage:");
const ARCHIVE_MARK = Buffer.from("subagent-history/");
const RO = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Open a regular file read-only without following a symlink or blocking on a FIFO. */
export function openRegular(path: string): number | null {
  let fd: number;
  try { fd = openSync(path, RO); } catch { return null; }
  try { if (fstatSync(fd).isFile()) return fd; } catch {}
  closeSync(fd);
  return null;
}

type Ctx = {
  db: Database; st: IngestStats; stmts: ReturnType<typeof prepare>; chunk: number; headBytes: number;
  onError: (where: string, e: unknown) => void; progress: () => void;
  dirtyDays: Set<string>; dirtyLegacy: Set<string>; sessionsDirty: boolean; skipped: number;
};

function prepare(db: Database) {
  return {
    req: db.prepare(`INSERT OR IGNORE INTO requests VALUES (
      $request_id,$host,$ts,$day,$wd,$hour,$model,$attempt,$ttft_ms,$total_ms,$stop,$input,$output,$cache_read,$cache_write,$cw5m,$cw1h,$cw_unknown,
      $ctx_messages,$ctx_tools,$system_bytes,$worker,$keepwarm,$miss_reason,$missed_tokens,$refusal_retries,$cost,$saved,$saved_net,$cost_reported,
      $session_id,$turn_id,$runtime_session_id,$trace_request_id,$timing_v2,$agent,$handle,$parent_session,$parent_runtime_session_id,$sid)`),
    trace: db.prepare(`INSERT OR IGNORE INTO traces VALUES (
      $key,$host,$ts,$session_id,$turn_id,$local_request_id,$attempt,$provider_request_id,$model,$wire_bytes,$message_count,$tool_count,
      $headers_ms,$first_byte_ms,$first_event_ms,$stream_end_ms,$retries,$losses,$http_status,$stop)`),
    reqDay: db.prepare(`SELECT day FROM requests WHERE request_id = ?`),
    legacy: db.prepare(`INSERT OR IGNORE INTO legacy_usage VALUES (?,?,?,?,?,?,?,?,?)`),
    stateGet: db.prepare(`SELECT offset, head FROM ingest_state WHERE source = ? AND inode = ?`),
    statePut: db.prepare(`INSERT INTO ingest_state VALUES (?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(source, inode) DO UPDATE SET path=excluded.path, size=excluded.size, offset=excluded.offset, head=excluded.head, updated_at=excluded.updated_at, missing=0`),
    fileGet: db.prepare(`SELECT mtime, size FROM file_state WHERE path = ?`),
    filePut: db.prepare(`INSERT INTO file_state VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, status=excluded.status`),
    copy: db.prepare(`INSERT INTO session_copies VALUES ($host,$id,$path,$mtime,$title,$title_raw,$model,$created,$updated,$input,$output,$cache_read,$cache_write,$cost,$message_count)
      ON CONFLICT(host, id) DO UPDATE SET path=excluded.path, mtime=excluded.mtime, title=excluded.title, title_raw=excluded.title_raw, model=excluded.model, created=excluded.created,
        updated=excluded.updated, input=excluded.input, output=excluded.output, cache_read=excluded.cache_read, cache_write=excluded.cache_write,
        cost=excluded.cost, message_count=excluded.message_count
      WHERE excluded.path = session_copies.path OR excluded.updated >= session_copies.updated`),
    unlink: db.prepare(`DELETE FROM worker_links WHERE host = ? AND session_id = ?`),
    link: db.prepare(`INSERT OR IGNORE INTO worker_links VALUES (?,?,?,?)`),
    worker: db.prepare(`INSERT INTO workers VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(host, proc, handle) DO UPDATE SET agent=excluded.agent, model=excluded.model, status=excluded.status, mtime=excluded.mtime, path=excluded.path`),
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
    if (!existsSync(path)) continue;
    const fd = openRegular(path);
    if (fd === null) { ctx.skipped++; continue; } // symlink, FIFO, socket, device
    try {
      const s = fstatSync(fd);
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
        stmts.statePut.run(source, inode, host, kind, path, size, offset, head, Date.now());
        continue;
      }
      let pos = offset, consumed = offset, carry: Buffer = Buffer.alloc(0), pending = 0;
      const b = Buffer.allocUnsafe(Math.min(ctx.chunk, size - offset)); // one read buffer per file
      const commit = () => db.transaction(() => { flush(); stmts.statePut.run(source, inode, host, kind, path, size, consumed, head, Date.now()); })();
      while (pos < size) {
        const n = Math.min(b.length, size - pos);
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
        if (pending >= 5000) { commit(); pending = 0; }
      }
      commit();
    } catch (e) {
      ctx.onError(`${kind} ${path}`, e);
    } finally {
      closeSync(fd);
    }
  }
  // Generations not seen this pass: count, drop at the 2nd consecutive miss, and count
  // any unread tail as lost (e.g. two rotations between passes).
  const known = db.query(`SELECT inode, offset, size, missing FROM ingest_state WHERE source = ?`).all(source) as any[];
  for (const k of known) {
    if (live.has(k.inode)) continue;
    if (k.missing + 1 >= 2) {
      if (k.offset < k.size) ctx.st.lost_bytes += k.size - k.offset;
      db.query(`DELETE FROM ingest_state WHERE source = ? AND inode = ?`).run(source, k.inode);
    } else db.query(`UPDATE ingest_state SET missing = missing + 1 WHERE source = ? AND inode = ?`).run(source, k.inode);
  }
  ctx.progress();
}

/** X.N … X.1, X: oldest first. Synaps keeps 1 rotated generation by default and up to 100
 *  with telemetry_log_generations (SynapsCLI #322); rotation shifts each X.k to X.k+1. */
export function generations(path: string): string[] {
  const dir = join(path, ".."), base = basename(path);
  let ks: number[] = [];
  try {
    ks = readdirSync(dir).map((n) => (n.startsWith(base + ".") ? /^\d{1,3}$/.exec(n.slice(base.length + 1))?.[0] : undefined)).filter((x): x is string => !!x).map(Number).filter((k) => k >= 1 && k <= 100);
  } catch {}
  return [...ks.sort((a, b) => b - a).map((k) => `${path}.${k}`), path];
}

function ingestJsonl(ctx: Ctx, r: HostRoot) {
  const { stmts, st } = ctx;
  let reqs: RequestRow[] = [], traces: TraceRow[] = [];
  const api = join(r.cacheDir, "api-log.jsonl");
  streamSource(ctx, r.host, "api-log", `${r.host}:api-log`, generations(api), (line) => {
    const objs = parseLine(line);
    if (!objs.length) st.bad_lines++;
    for (const o of objs) { const row = parseApiLog(o, r.host); if (row) reqs.push(row); else st.bad_lines++; }
  }, () => {
    for (const x of reqs) if (stmts.req.run(bind(x)).changes) { st.requests++; ctx.dirtyDays.add(x.day); }
    reqs = [];
  });
  const tr = join(r.cacheDir, "request-trace.jsonl");
  streamSource(ctx, r.host, "request-trace", `${r.host}:request-trace`, generations(tr), (line) => {
    const objs = parseLine(line);
    if (!objs.length) st.bad_lines++;
    for (const o of objs) { const row = parseTrace(o, r.host); if (row) traces.push(row); else st.bad_lines++; }
  }, () => {
    for (const x of traces) {
      if (!stmts.trace.run(bind(x)).changes) continue;
      st.traces++;
      // the joined request's day needs its TTFT/retry rollup redone
      const d = x.provider_request_id ? (stmts.reqDay.get(x.provider_request_id) as any)?.day : null;
      if (d) ctx.dirtyDays.add(d);
    }
    traces = [];
  });
}

function ingestLegacy(ctx: Ctx, r: HostRoot) {
  let names: string[];
  try {
    names = readdirSync(r.logsDir, { withFileTypes: true }).filter((e) => e.isFile() && /^synaps\.log\.\d{4}-\d\d-\d\d$/.test(e.name)).map((e) => e.name).sort();
  } catch { return; }
  let rows: any[][] = [];
  for (const n of names) {
    streamSource(ctx, r.host, "log", `${r.host}:log:${n}`, [join(r.logsDir, n)], (line, off) => {
      const x = parseLegacy(line);
      if (x) rows.push([r.host, n, off, x.ts, x.day, x.input, x.output, x.cache_read, x.cache_create]);
    }, () => {
      for (const x of rows) if (ctx.stmts.legacy.run(...x).changes) { ctx.st.legacy++; ctx.dirtyLegacy.add(`${x[4]}|${x[0]}`); }
      rows = [];
    }, LEGACY_MARK);
  }
}

/** Read up to `max` bytes from the start of an open fd. */
function readHead(fd: number, max: number): Buffer {
  const size = fstatSync(fd).size;
  const n = Math.min(size, max);
  const b = Buffer.allocUnsafe(n);
  let got = 0;
  while (got < n) { const k = readSync(fd, b, got, n - got, got); if (k <= 0) break; got += k; }
  return b.subarray(0, got);
}

/** archive_path references, by a chunked scan (bounded memory on multi-MB session files). */
export function scanArchiveRefs(fd: number, chunk: number): [string, string][] {
  const out = new Map<string, [string, string]>();
  const size = fstatSync(fd).size;
  const BEFORE = 256, AFTER = 256;
  let pos = 0, carry = Buffer.alloc(0), done = -1; // done = abs offset of the last processed hit
  const b = Buffer.allocUnsafe(Math.max(1, Math.min(chunk, size)));
  while (pos < size) {
    const n = Math.min(b.length, size - pos);
    const got = readSync(fd, b, 0, n, pos);
    if (got <= 0) break;
    const base = pos - carry.length;
    pos += got;
    const eof = pos >= size;
    const buf = carry.length ? Buffer.concat([carry, b.subarray(0, got)]) : b.subarray(0, got);
    let at = buf.indexOf(ARCHIVE_MARK);
    while (at >= 0) {
      if (!eof && at + AFTER > buf.length) break; // need more bytes after it: next round
      if (base + at > done) {
        for (const ref of archiveRefs(buf.toString("utf8", Math.max(0, at - BEFORE), Math.min(buf.length, at + AFTER)))) out.set(ref.join("/"), ref);
        done = base + at;
      }
      at = buf.indexOf(ARCHIVE_MARK, at + 1);
    }
    carry = Buffer.from(buf.subarray(Math.max(0, buf.length - (BEFORE + AFTER + ARCHIVE_MARK.length))));
  }
  return [...out.values()];
}

type Entry = { path: string; mtime: number; size: number; regular: boolean };

/** lstat-based listing: symlinks/FIFOs come back as non-regular (never followed). */
function listFiles(dir: string, filter?: (name: string) => boolean): Entry[] | null {
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return null; }
  const out: Entry[] = [];
  for (const n of names) {
    if (filter && !filter(n)) continue;
    const path = join(dir, n);
    try {
      const s = lstatSync(path);
      if (s.isDirectory()) continue;
      out.push({ path, mtime: Math.floor(s.mtimeMs), size: s.size, regular: s.isFile() });
    } catch {}
  }
  return out;
}

const unchanged = (ctx: Ctx, e: Entry) => {
  const prev = ctx.stmts.fileGet.get(e.path) as { mtime: number; size: number } | null;
  return !!prev && prev.mtime === e.mtime && prev.size === e.size;
};

/** Forget files that disappeared under `dir` (file_state rows + what they produced). */
function prune(ctx: Ctx, host: string, kind: string, dir: string, seen: Set<string>) {
  const { db } = ctx;
  const rows = db.query(`SELECT path FROM file_state WHERE host = ? AND kind = ? AND substr(path, 1, ?) = ?`).all(host, kind, dir.length + 1, dir + "/") as { path: string }[];
  for (const { path } of rows) {
    if (seen.has(path)) continue;
    db.transaction(() => {
      if (kind === "session") {
        const c = db.query(`SELECT id FROM session_copies WHERE host = ? AND path = ?`).get(host, path) as { id: string } | null;
        if (c) {
          db.query(`DELETE FROM session_copies WHERE host = ? AND path = ?`).run(host, path);
          ctx.stmts.unlink.run(host, c.id);
          ctx.sessionsDirty = true;
        }
      } else db.query(`DELETE FROM workers WHERE host = ? AND path = ?`).run(host, path);
      db.query(`DELETE FROM file_state WHERE path = ?`).run(path);
    })();
    ctx.st.pruned++;
  }
}

const HEAD_STEPS = (first: number) => [first, first * 8, 16 << 20];

function ingestSessions(ctx: Ctx, r: HostRoot, deadline: number) {
  const entries = listFiles(r.sessionsDir);
  if (!entries) return;
  const { db, stmts } = ctx;
  const seen = new Set<string>();
  let batch: (() => void)[] = [];
  const flush = () => { if (batch.length) db.transaction(() => { for (const f of batch) f(); })(); batch = []; };
  for (const e of entries) {
    seen.add(e.path);
    if (unchanged(ctx, e)) continue;
    if (!e.regular || !e.path.endsWith(".json")) { batch.push(() => stmts.filePut.run(e.path, r.host, "session", e.mtime, e.size, "skip")); continue; }
    const fd = openRegular(e.path);
    if (fd === null) { batch.push(() => stmts.filePut.run(e.path, r.host, "session", e.mtime, e.size, "skip")); continue; }
    let s = null, refs: [string, string][] = [];
    try {
      // Header: grow the head read until it holds `"api_messages":` (or the whole file).
      for (const cap of HEAD_STEPS(ctx.headBytes)) {
        const text = readHead(fd, cap).toString("utf8");
        if (text.includes(',"api_messages":') || e.size <= cap) { s = parseSession(text); break; }
      }
      if (s) refs = scanArchiveRefs(fd, ctx.chunk);
    } catch (err) { ctx.onError(`session ${e.path}`, err); } finally { closeSync(fd); }
    const row = s;
    batch.push(() => {
      if (row) {
        ctx.st.sessions += stmts.copy.run(bind({ ...row, host: r.host, path: e.path, mtime: e.mtime })).changes;
        stmts.unlink.run(r.host, row.id);
        for (const [proc, handle] of refs) stmts.link.run(r.host, proc, handle, row.id);
        ctx.sessionsDirty = true;
      }
      stmts.filePut.run(e.path, r.host, "session", e.mtime, e.size, row ? "ok" : "skip");
    });
    if (batch.length >= 50) flush();
    if (Date.now() > deadline) break;
  }
  flush();
  if (Date.now() <= deadline) prune(ctx, r.host, "session", r.sessionsDir, seen);
  ctx.progress();
}

function ingestWorkers(ctx: Ctx, r: HostRoot, deadline: number) {
  let procs: string[];
  try { procs = readdirSync(r.subagentsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return; }
  const { db, stmts } = ctx;
  const seen = new Set<string>();
  let batch: (() => void)[] = [];
  const flush = () => { if (batch.length) db.transaction(() => { for (const f of batch) f(); })(); batch = []; };
  let complete = true;
  for (const proc of procs) {
    for (const e of listFiles(join(r.subagentsDir, proc), (n) => /^sa_\d+\.json$/.test(n)) ?? []) {
      seen.add(e.path);
      if (unchanged(ctx, e)) continue;
      const fd = e.regular ? openRegular(e.path) : null;
      let h = null;
      if (fd !== null) {
        try {
          for (const cap of HEAD_STEPS(ctx.headBytes)) {
            h = parseWorkerHead(readHead(fd, cap).toString("utf8"));
            if (h || e.size <= cap) break;
          }
        } catch (err) { ctx.onError(`worker ${e.path}`, err); } finally { closeSync(fd); }
      }
      const head = h;
      batch.push(() => {
        if (head) ctx.st.workers += stmts.worker.run(r.host, proc, basename(e.path, ".json"), head.agent, head.model, head.status, e.mtime, e.path).changes;
        stmts.filePut.run(e.path, r.host, "worker", e.mtime, e.size, head ? "ok" : "skip");
      });
      if (batch.length >= 200) flush();
    }
    if (Date.now() > deadline) { complete = false; break; }
  }
  flush();
  if (complete) prune(ctx, r.host, "worker", r.subagentsDir, seen);
  ctx.progress();
}

/** Derive `sessions` from every host's copies.
 *  - data (title, totals, cost) from the newest copy;
 *  - host = ORIGIN, decided among the hosts holding a copy, in order:
 *      1. the host whose api-log span covers `created`;
 *      2. (several or none) the host with the most activity inside [created, updated]: api-log
 *         rows + synaps.log `Token Usage:` lines (that machine was doing the work);
 *      3. the earliest copy: oldest `updated`, then oldest file mtime at 1 s precision
 *         (copies made with cp -p/rsync keep whole-second mtimes), then host name;
 *  - grain = 'session' only when no request row on ANY host overlaps [created, updated]:
 *    otherwise its spend is (at least partly) request-level already, and adding
 *    session_cost would double-count. Sessions straddling a cutover are request grain.
 *    One decision per session, independent of the host filter, so per-host sums add up. */
const originMemo = new Map<string, { sig: string; host: string }>();

export function rebuildSessions(db: Database) {
  const spans = new Map((db.query(`SELECT host, MIN(ts) a, MAX(ts) b FROM requests GROUP BY host`).all() as any[]).map((x) => [x.host, x]));
  const spanSig = [...spans.values()].map((s) => `${s.host}:${s.a}`).join(",");
  const copies = db.query(`SELECT * FROM session_copies ORDER BY id`).all() as any[];
  const overlap = db.query(`SELECT 1 FROM requests WHERE ts >= ? AND ts <= ? LIMIT 1`);
  const legacyAct = db.query(`SELECT COUNT(*) n FROM (SELECT 1 FROM legacy_usage WHERE host = ? AND ts >= ? AND ts <= ? LIMIT 500)`);
  const reqAct = db.query(`SELECT COUNT(*) n FROM (SELECT 1 FROM requests WHERE host = ? AND ts >= ? AND ts <= ? LIMIT 500)`);
  const activity = { get: (h: string, a: number, b: number) => ({ n: (legacyAct.get(h, a, b) as any).n + (reqAct.get(h, a, b) as any).n }) };
  const ins = db.prepare(`INSERT INTO sessions VALUES ($id,$host,$copies,$title,$title_raw,$model,$created,$updated,$created_day,$input,$output,$cache_read,$cache_write,$cost,$saved,$saved_net,$message_count,$grain)`);
  const earliest = (a: any, b: any) => a.updated - b.updated || Math.floor(a.mtime / 1000) - Math.floor(b.mtime / 1000) || (a.host < b.host ? -1 : 1);
  const origin = (group: any[], created: number, updated: number): string => {
    if (group.length === 1) return group[0].host;
    const sig = `${spanSig}|${group.map((c) => `${c.host}:${c.updated}:${c.mtime}`).join(",")}`;
    const memo = originMemo.get(group[0].id);
    if (memo && memo.sig === sig) return memo.host;
    let cands = group.filter((c) => { const s = spans.get(c.host); return s && s.a <= created && created <= s.b; });
    if (cands.length !== 1) {
      const pool = cands.length ? cands : group;
      const act = pool.map((c) => ({ c, n: (activity.get(c.host, created, updated) as any).n as number }));
      const best = Math.max(...act.map((x) => x.n));
      cands = best > 0 ? act.filter((x) => x.n === best).map((x) => x.c) : pool;
    }
    const host = cands.slice().sort(earliest)[0].host;
    originMemo.set(group[0].id, { sig, host });
    return host;
  };
  db.transaction(() => {
    db.exec(`DELETE FROM sessions`);
    for (let i = 0; i < copies.length;) {
      const group: any[] = [];
      const id = copies[i].id;
      for (; i < copies.length && copies[i].id === id; i++) group.push(copies[i]);
      const newest = group.reduce((a, b) => (b.updated > a.updated || (b.updated === a.updated && b.mtime > a.mtime) ? b : a));
      const created = Math.min(...group.map((c) => c.created));
      const prompt = newest.input + (newest.cache_read ?? 0) + (newest.cache_write ?? 0);
      // Per-request prompt size picks the Haiku 5.5 tier; a session total is not one prompt.
      const perReq = prompt / Math.max(1, Math.round((newest.message_count ?? 2) / 2));
      ins.run(bind({
        id, host: origin(group, created, newest.updated), copies: group.length, title: newest.title, title_raw: newest.title_raw, model: newest.model, created, updated: newest.updated,
        created_day: dayOf(created), input: newest.input, output: newest.output, cache_read: newest.cache_read, cache_write: newest.cache_write,
        cost: newest.cost, message_count: newest.message_count,
        saved: cacheSavings(newest.model, newest.input, newest.cache_read ?? 0, newest.cache_write ?? 0, 0, perReq),
        saved_net: cacheNetSavings(newest.model, newest.input, newest.cache_read ?? 0, newest.cache_write ?? 0, 0, perReq),
        grain: overlap.get(created, newest.updated) ? "request" : "session",
      }));
    }
  })();
}

function rebuildLegacyDaily(db: Database, keys: Iterable<string>) {
  const q = db.prepare(`INSERT OR REPLACE INTO legacy_daily SELECT day, host, COUNT(*), SUM(input), SUM(output), SUM(cache_read), SUM(cache_create) FROM legacy_usage WHERE day = ? AND host = ? GROUP BY day, host`);
  db.transaction(() => { for (const k of keys) { const [day, host] = k.split("|"); q.run(day, host); } })();
}

export function refreshCounts(db: Database) {
  const n = (sql: string) => (db.query(sql).get() as any).n as number;
  db.transaction(() => {
    metaSet(db, "count_requests", n("SELECT COUNT(*) n FROM requests"));
    metaSet(db, "count_traces", n("SELECT COUNT(*) n FROM traces"));
    metaSet(db, "count_sessions", n("SELECT COUNT(*) n FROM sessions"));
    metaSet(db, "count_workers", n("SELECT COUNT(*) n FROM workers"));
    metaSet(db, "count_legacy", n("SELECT COUNT(*) n FROM legacy_usage"));
    metaSet(db, "count_skipped", n("SELECT COUNT(*) n FROM file_state WHERE status = 'skip'"));
  })();
}

/** One full pass over every root. Never throws: failures are counted in meta. */
export function ingestOnce(db: Database, roots: HostRoot[], opts: IngestOpts = {}): IngestStats {
  const t0 = performance.now();
  const deadline = Date.now() + (opts.budgetMs ?? 10 * 60_000);
  const st: IngestStats = { ms: 0, requests: 0, traces: 0, legacy: 0, sessions: 0, workers: 0, bad_lines: 0, errors: 0, lost_bytes: 0, pruned: 0 };
  const ctx: Ctx = {
    db, st, stmts: prepare(db), chunk: Math.max(1, opts.chunk ?? 1 << 20), headBytes: Math.max(256, opts.headBytes ?? 64 << 10),
    onError: (where, e) => {
      st.errors++;
      try { metaSet(db, "last_error", `${new Date().toISOString()} ${where}: ${String(e).slice(0, 300)}`); } catch {}
    },
    progress: opts.onProgress ?? (() => {}),
    dirtyDays: new Set(), dirtyLegacy: new Set(), sessionsDirty: false, skipped: 0,
  };
  for (const r of roots) {
    for (const [name, fn] of [["jsonl", () => ingestJsonl(ctx, r)], ["legacy", () => ingestLegacy(ctx, r)], ["sessions", () => ingestSessions(ctx, r, deadline)], ["workers", () => ingestWorkers(ctx, r, deadline)]] as const) {
      const before = st.requests + st.traces + st.legacy + st.sessions + st.workers;
      try { fn(); } catch (e) { ctx.onError(`${r.host} ${name}`, e); }
      // A backfill phase leaves tens of MB of parsed-JSON garbage; collect it before the
      // next phase so the extension's peak RSS stays near one phase's, not the sum.
      if (st.requests + st.traces + st.legacy + st.sessions + st.workers - before > 1000) Bun.gc(true);
    }
  }
  const changed = st.requests || st.traces || st.legacy || st.sessions || st.workers || st.pruned || ctx.sessionsDirty;
  for (const [name, fn] of [
    ["sessions-derive", () => { if (st.requests || ctx.sessionsDirty) rebuildSessions(db); }],
    ["rollups", () => { if (ctx.dirtyDays.size) rebuildRollupDays(db, ctx.dirtyDays); }],
    ["legacy-daily", () => { if (ctx.dirtyLegacy.size) rebuildLegacyDaily(db, ctx.dirtyLegacy); }],
    ["counts", () => { if (changed || metaGet(db, "count_requests") === null) refreshCounts(db); }],
  ] as const) {
    try { fn(); } catch (e) { ctx.onError(name, e); }
  }
  st.ms = Math.round(performance.now() - t0);
  try {
    db.transaction(() => {
      metaSet(db, "last_run", Date.now());
      metaSet(db, "last_run_ms", st.ms);
      const add = (k: string, v: number) => metaSet(db, k, Number(metaGet(db, k) ?? 0) + v);
      add("errors", st.errors);
      add("bad_lines", st.bad_lines);
      add("lost_bytes", st.lost_bytes);
      metaSet(db, "skipped_special", ctx.skipped);
      metaSet(db, "roots", JSON.stringify(roots.map((r) => ({ host: r.host, root: r.root }))));
    })();
  } catch {}
  return st;
}

/** Synaps release tags for the cache chart. Async (never blocks a thread on git); the result
 *  lands in meta and the HTTP side serves whatever is there. */
export async function refreshReleases(db: Database, repo: string): Promise<void> {
  let v: { tag: string; ts: number }[] = [];
  try {
    if (existsSync(join(repo, ".git"))) {
      const p = Bun.spawn(["git", "-C", repo, "for-each-ref", "refs/tags", "--format=%(refname:short) %(creatordate:unix)"], { stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => p.kill(), 5000);
      const out = await new Response(p.stdout).text();
      clearTimeout(timer);
      if ((await p.exited) === 0)
        v = out.split("\n").map((l) => l.trim().split(" ")).filter((x) => x.length === 2 && /^\d+$/.test(x[1])).map(([tag, t]) => ({ tag, ts: Number(t) * 1000 })).sort((a, b) => a.ts - b.ts);
    }
  } catch {}
  try { metaSet(db, "releases", JSON.stringify(v)); metaSet(db, "releases_at", Date.now()); } catch {}
}
