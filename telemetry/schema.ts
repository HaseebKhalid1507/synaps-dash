// SQLite schema + migrations (PRAGMA user_version). bun:sqlite only.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path: string, opts: { readonly?: boolean } = {}): Database {
  if (!opts.readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, opts.readonly ? { readonly: true } : { create: true });
  db.exec("PRAGMA busy_timeout = 5000");
  if (opts.readonly) return db;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}

export function migrate(db: Database) {
  const cur = (db.query("PRAGMA user_version").get() as any).user_version as number;
  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export function metaGet(db: Database, key: string): string | null {
  const r = db.query("SELECT value FROM meta WHERE key = ?").get(key) as any;
  return r ? r.value : null;
}
export function metaSet(db: Database, key: string, value: string | number) {
  db.query("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}
