// SQLite schema + migrations (PRAGMA user_version). bun:sqlite only.

import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, openSync, closeSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

// ┌────────────────────────────────────────────────────────────────────────────────────┐
// │ v3+ MIGRATIONS MUST BE ADDITIVE. Never DROP or rebuild `requests`, `traces` or      │
// │ `legacy_usage`: Synaps rotates its logs (50 MB, 1 generation by default), so for    │
// │ anything older than the oldest live generation this store is the ONLY copy left.   │
// │ v2's drop-and-rebuild was safe only because no v1 store was ever deployed. Add     │
// │ columns/indexes/tables; derived tables (sessions, rollup_*, legacy_daily) may be   │
// │ rebuilt from those three, never the other way round.                               │
// └────────────────────────────────────────────────────────────────────────────────────┘
const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE requests (
    request_id TEXT PRIMARY KEY, host TEXT NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL, wd INTEGER NOT NULL, hour INTEGER NOT NULL,
    model TEXT NOT NULL, attempt INTEGER NOT NULL, ttft_ms INTEGER, total_ms INTEGER, stop TEXT,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
    cw5m INTEGER NOT NULL, cw1h INTEGER NOT NULL,
    ctx_messages INTEGER, ctx_tools INTEGER, system_bytes INTEGER,
    worker INTEGER NOT NULL, keepwarm INTEGER NOT NULL, miss_reason TEXT, missed_tokens INTEGER, refusal_retries INTEGER NOT NULL,
    cost REAL NOT NULL, saved REAL NOT NULL, cost_reported REAL,
    session_id TEXT, turn_id TEXT, agent TEXT, handle TEXT, parent_session TEXT, sid TEXT
  );
  CREATE INDEX requests_ts ON requests(ts);
  CREATE INDEX requests_day ON requests(day, host);
  CREATE INDEX requests_sid ON requests(sid, ts) WHERE sid IS NOT NULL;
  CREATE INDEX requests_agent ON requests(agent) WHERE agent IS NOT NULL;

  CREATE TABLE traces (
    key TEXT PRIMARY KEY, host TEXT NOT NULL, ts INTEGER, session_id TEXT, turn_id TEXT, local_request_id TEXT, attempt INTEGER,
    provider_request_id TEXT, model TEXT, wire_bytes INTEGER, message_count INTEGER, tool_count INTEGER,
    headers_ms INTEGER, first_byte_ms INTEGER, first_event_ms INTEGER, stream_end_ms INTEGER,
    retries INTEGER NOT NULL, losses INTEGER NOT NULL, http_status INTEGER, stop TEXT
  );
  CREATE INDEX traces_prid ON traces(provider_request_id) WHERE provider_request_id IS NOT NULL;
  CREATE INDEX traces_ts ON traces(ts);

  -- one row per session id; the newest updated_at across hosts wins (and its host)
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, host TEXT NOT NULL, title TEXT, model TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    created_day TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER, cache_write INTEGER,
    cost REAL NOT NULL, saved REAL NOT NULL, message_count INTEGER, path TEXT NOT NULL
  );
  CREATE INDEX sessions_updated ON sessions(updated);
  CREATE INDEX sessions_cost ON sessions(cost);

  CREATE TABLE workers (
    host TEXT NOT NULL, proc TEXT NOT NULL, handle TEXT NOT NULL, agent TEXT, model TEXT, status TEXT, mtime INTEGER NOT NULL,
    PRIMARY KEY (host, proc, handle)
  );
  CREATE INDEX workers_agent ON workers(agent);
  -- parent session → worker archive, from "archive_path" in the session's tool results (first mention wins)
  CREATE TABLE worker_links (proc TEXT NOT NULL, handle TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (proc, handle));
  CREATE INDEX worker_links_session ON worker_links(session_id);

  CREATE TABLE legacy_usage (
    host TEXT NOT NULL, file TEXT NOT NULL, off INTEGER NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_create INTEGER NOT NULL,
    PRIMARY KEY (host, file, off)
  ) WITHOUT ROWID;
  CREATE INDEX legacy_day ON legacy_usage(day, host, ts, input, cache_read, cache_create);

  -- streamed sources: one row per (logical source, inode); offset = bytes consumed through the last full line
  CREATE TABLE ingest_state (
    source TEXT NOT NULL, inode INTEGER NOT NULL, host TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
    size INTEGER NOT NULL, offset INTEGER NOT NULL, head TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (source, inode)
  );
  -- whole-file sources (sessions, worker archives): re-read only when mtime/size change
  CREATE TABLE file_state (
    path TEXT PRIMARY KEY, host TEXT NOT NULL, kind TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `,
  // v2 (store review fixes). The store is a rebuildable cache of read-only sources, so v2
  // drops the v1 tables and recreates them; the next ingest pass backfills (seconds).
  `
  DROP TABLE IF EXISTS requests; DROP TABLE IF EXISTS traces; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS workers;
  DROP TABLE IF EXISTS worker_links; DROP TABLE IF EXISTS legacy_usage; DROP TABLE IF EXISTS ingest_state;
  DROP TABLE IF EXISTS file_state; DROP TABLE IF EXISTS meta;

  CREATE TABLE requests (
    request_id TEXT PRIMARY KEY, host TEXT NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL, wd INTEGER NOT NULL, hour INTEGER NOT NULL,
    model TEXT NOT NULL, attempt INTEGER NOT NULL, ttft_ms INTEGER, total_ms INTEGER, stop TEXT,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
    cw5m INTEGER, cw1h INTEGER, cw_unknown INTEGER NOT NULL,           -- cw5m/cw1h NULL = no TTL split in the record
    ctx_messages INTEGER, ctx_tools INTEGER, system_bytes INTEGER,
    worker INTEGER NOT NULL, keepwarm INTEGER NOT NULL, miss_reason TEXT, missed_tokens INTEGER, refusal_retries INTEGER NOT NULL,
    cost REAL NOT NULL, saved REAL NOT NULL, saved_net REAL NOT NULL, cost_reported REAL,
    -- SynapsCLI #322: session_id = persisted conversation id; runtime_session_id/trace_request_id =
    -- the trace's session_id/request_id; timing_v2 = 1 when ttft/total are send-based (has runtime id)
    session_id TEXT, turn_id TEXT, runtime_session_id TEXT, trace_request_id TEXT, timing_v2 INTEGER NOT NULL,
    agent TEXT, handle TEXT, parent_session TEXT, parent_runtime_session_id TEXT, sid TEXT
  );
  CREATE INDEX requests_ts ON requests(ts);
  CREATE INDEX requests_host_ts ON requests(host, ts);
  CREATE INDEX requests_day ON requests(day, host);
  CREATE INDEX requests_sid ON requests(sid, ts) WHERE sid IS NOT NULL;
  CREATE INDEX requests_agent ON requests(agent) WHERE agent IS NOT NULL;
  CREATE INDEX requests_miss ON requests(ts) WHERE miss_reason IS NOT NULL;
  CREATE INDEX requests_keepwarm ON requests(ts) WHERE keepwarm = 1;

  CREATE TABLE traces (
    key TEXT PRIMARY KEY, host TEXT NOT NULL, ts INTEGER, session_id TEXT, turn_id TEXT, local_request_id TEXT, attempt INTEGER,
    provider_request_id TEXT, model TEXT, wire_bytes INTEGER, message_count INTEGER, tool_count INTEGER,
    headers_ms INTEGER, first_byte_ms INTEGER, first_event_ms INTEGER, stream_end_ms INTEGER,
    retries INTEGER NOT NULL, losses INTEGER NOT NULL, http_status INTEGER, stop TEXT
  );
  CREATE INDEX traces_prid ON traces(provider_request_id) WHERE provider_request_id IS NOT NULL;
  CREATE INDEX traces_ts ON traces(ts);

  -- every parsed copy of a session file, per host
  CREATE TABLE session_copies (
    host TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, mtime INTEGER NOT NULL, title TEXT, title_raw TEXT, model TEXT NOT NULL,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
    cache_read INTEGER, cache_write INTEGER, cost REAL, message_count INTEGER,
    PRIMARY KEY (host, id)
  );
  CREATE INDEX session_copies_path ON session_copies(path);
  -- one row per session id, derived from session_copies after each pass:
  -- data from the newest copy, host = ORIGIN host, grain = 'session' only when no request row
  -- on any host overlaps [created, updated] (else its spend is already in requests)
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, host TEXT NOT NULL, copies INTEGER NOT NULL, title TEXT, title_raw TEXT, model TEXT NOT NULL,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, created_day TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER, cache_write INTEGER,
    cost REAL, saved REAL NOT NULL, saved_net REAL NOT NULL, message_count INTEGER, grain TEXT NOT NULL
  );
  CREATE INDEX sessions_updated ON sessions(updated);
  CREATE INDEX sessions_cost ON sessions(cost);
  CREATE INDEX sessions_grain ON sessions(grain, created);

  CREATE TABLE workers (
    host TEXT NOT NULL, proc TEXT NOT NULL, handle TEXT NOT NULL, agent TEXT, model TEXT, status TEXT, mtime INTEGER NOT NULL, path TEXT NOT NULL,
    PRIMARY KEY (host, proc, handle)
  );
  CREATE INDEX workers_agent ON workers(agent);
  CREATE INDEX workers_path ON workers(path);
  -- parent session → worker archive, from "archive_path" in that host's copy of the session (first mention wins)
  CREATE TABLE worker_links (host TEXT NOT NULL, proc TEXT NOT NULL, handle TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (host, proc, handle));
  CREATE INDEX worker_links_session ON worker_links(session_id);

  CREATE TABLE legacy_usage (
    host TEXT NOT NULL, file TEXT NOT NULL, off INTEGER NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_create INTEGER NOT NULL,
    PRIMARY KEY (host, file, off)
  ) WITHOUT ROWID;
  CREATE INDEX legacy_day ON legacy_usage(day, host, ts, input, cache_read, cache_create);
  CREATE INDEX legacy_host_ts ON legacy_usage(host, ts);

  CREATE TABLE rollup_daily (
    day TEXT NOT NULL, host TEXT NOT NULL, model TEXT NOT NULL, worker INTEGER NOT NULL,
    n INTEGER, cost REAL, saved REAL, saved_net REAL, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
    cw5m INTEGER, cw1h INTEGER, cw_unknown INTEGER, split_n INTEGER, retried INTEGER, refusal_retries INTEGER, tools_changed INTEGER, keepwarm_n INTEGER,
    ttft TEXT, total TEXT, stops TEXT, hours TEXT, gen INTEGER NOT NULL,
    PRIMARY KEY (day, host, model, worker)
  ) WITHOUT ROWID;
  CREATE INDEX rollup_gen ON rollup_daily(gen);
  CREATE TABLE legacy_daily (
    day TEXT NOT NULL, host TEXT NOT NULL, n INTEGER, input INTEGER, output INTEGER, cache_read INTEGER, cache_create INTEGER,
    PRIMARY KEY (day, host)
  ) WITHOUT ROWID;

  -- streamed sources: one row per (logical source, inode); offset = bytes consumed through the last full line.
  -- missing = consecutive passes the inode was absent (state dropped at 2)
  CREATE TABLE ingest_state (
    source TEXT NOT NULL, inode INTEGER NOT NULL, host TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
    size INTEGER NOT NULL, offset INTEGER NOT NULL, head TEXT NOT NULL, updated_at INTEGER NOT NULL, missing INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, inode)
  );
  CREATE TABLE file_state (
    path TEXT PRIMARY KEY, host TEXT NOT NULL, kind TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL
  );
  CREATE INDEX file_state_kind ON file_state(host, kind);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `,
  // v3 (additive): unlinked (pre-#322) rows per host, for the session-grain probe
  `
  CREATE INDEX IF NOT EXISTS requests_unlinked ON requests(host, ts) WHERE runtime_session_id IS NULL;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** The store holds session titles, costs and paths: owner-only. The dir is 0700 (an existing
 *  dir of ours is tightened too, but never a shared/sticky dir like /tmp, nor $HOME), the file
 *  is created 0600 before SQLite opens it, and -wal/-shm take the main file's mode. */
export function securePath(path: string) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const st = statSync(dir);
    const mine = typeof process.getuid === "function" && st.uid === process.getuid();
    if (mine && !(st.mode & 0o1000) && dir !== homedir() && (st.mode & 0o077)) chmodSync(dir, 0o700);
  } catch {}
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  for (const x of ["-wal", "-shm"]) if (existsSync(path + x)) chmodSync(path + x, 0o600);
}

export function openDb(path: string, opts: { readonly?: boolean } = {}): Database {
  if (!opts.readonly) securePath(path);
  const db = new Database(path, opts.readonly ? { readonly: true } : { create: true });
  db.exec("PRAGMA busy_timeout = 10000");
  if (opts.readonly) return db;
  // Switching to WAL needs an exclusive lock and SQLite doesn't run the busy handler for it,
  // so a concurrent cold open can see SQLITE_BUSY: retry briefly (it's a one-time switch).
  for (let i = 0; ; i++) {
    try {
      if ((db.query("PRAGMA journal_mode").get() as any).journal_mode !== "wal") db.exec("PRAGMA journal_mode = WAL");
      break;
    } catch (e) {
      if (i >= 200 || !/locked|busy/i.test(String(e))) throw e;
      Bun.sleepSync(25 + Math.floor(Math.random() * 25));
    }
  }
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  for (const x of ["-wal", "-shm"]) if (existsSync(path + x)) try { chmodSync(path + x, 0o600); } catch {}
  return db;
}

/** BEGIN IMMEDIATE takes the write lock up front and re-reads user_version under it, so two
 *  processes cold-opening the same file serialize instead of racing (no SQLITE_BUSY_SNAPSHOT). */
export function migrate(db: Database) {
  const ver = () => (db.query("PRAGMA user_version").get() as any).user_version as number;
  if (ver() >= MIGRATIONS.length) return;
  db.transaction(() => {
    for (let v = ver(); v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  }).immediate();
}

export function metaGet(db: Database, key: string): string | null {
  const r = db.query("SELECT value FROM meta WHERE key = ?").get(key) as any;
  return r ? r.value : null;
}
export function metaSet(db: Database, key: string, value: string | number) {
  db.query("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}
