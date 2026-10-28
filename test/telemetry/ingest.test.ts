import { test, expect, afterEach } from "bun:test";
import { appendFileSync, renameSync, writeFileSync, truncateSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../telemetry/schema.ts";
import { ingestOnce, resolveRoot, parseSources } from "../../telemetry/ingest.ts";
import { sandbox } from "./helpers.ts";

let sb: ReturnType<typeof sandbox> | null = null;
afterEach(() => { sb?.done(); sb = null; });

const counts = (db: any) => Object.fromEntries(["requests", "traces", "sessions", "workers", "worker_links", "legacy_usage"].map((t) => [t, (db.query(`SELECT COUNT(*) n FROM ${t}`).get() as any).n]));
const ids = (db: any) => (db.query("SELECT request_id FROM requests ORDER BY request_id").all() as any[]).map((r) => r.request_id);
const line = (i: number) => JSON.stringify({ ts: 1793120000000 + i, request_id: `req_new${i}`, model: "claude-opus-5-5", attempt: 1, ttft_ms: 0, total_ms: 1000, stop_reason: "end_turn", usage: { input: 1, output: 1, cache_read: 1, cache_write: 1, cache_write_5m: 1, cache_write_1h: 0 }, context: {} }) + "\n";

test("backfill counts; second pass inserts nothing (idempotent)", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  const roots = [resolveRoot("bella", sb.bella), resolveRoot("jade", sb.jade)];
  const a = ingestOnce(db, roots);
  expect(a.errors).toBe(0);
  // .1: fx1-3; current: fx4, fx5+fx6 glued, fx7-9 (the unterminated fx10 is not consumed yet); jade: 101, 102
  expect(ids(db)).toEqual(["req_fx1", "req_fx2", "req_fx3", "req_fx4", "req_fx5", "req_fx6", "req_fx7", "req_fx8", "req_fx9", "req_fx101", "req_fx102"].sort());
  expect(a.bad_lines).toBe(2); // the broken api-log line + the non-JSON trace line
  const c1 = counts(db);
  expect(c1).toEqual({ requests: 11, traces: 2, sessions: 3, workers: 2, worker_links: 1, legacy_usage: 3 });
  const b = ingestOnce(db, roots);
  expect([b.requests, b.traces, b.legacy, b.sessions, b.workers, b.bad_lines]).toEqual([0, 0, 0, 0, 0, 0]);
  expect(counts(db)).toEqual(c1);
  // a fresh DB over the same files gets the same rows
  const db2 = openDb(join(sb.dir, "t2.db"));
  ingestOnce(db2, roots);
  expect(counts(db2)).toEqual(c1);
});

test("sessions on both hosts: newest updated_at wins and keeps its host; junk files skipped + counted", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  ingestOnce(db, [resolveRoot("jade", sb.jade), resolveRoot("bella", sb.bella)]); // jade first: bella must still win
  const s = db.query("SELECT host, cost, updated FROM sessions WHERE id = '20261027-100000-aaaa'").get() as any;
  expect([s.host, s.cost, s.updated]).toEqual(["bella", 12.5, Date.parse("2026-10-27T16:00:00Z")]);
  expect((db.query("SELECT host FROM sessions WHERE id = '20260420-100000-cccc'").get() as any).host).toBe("jade");
  expect((db.query("SELECT COUNT(*) n FROM file_state WHERE status = 'skip'").get() as any).n).toBe(3); // .lock, index.jsonl, broken.json
  // the older copy changing later must not overwrite the newer winner
  const p = join(sb.jade, "sessions", "20261027-100000-aaaa.json");
  writeFileSync(p, readFileSync(p, "utf8").replace('"session_cost":11', '"session_cost":11.5'));
  ingestOnce(db, [resolveRoot("jade", sb.jade), resolveRoot("bella", sb.bella)]);
  expect((db.query("SELECT cost FROM sessions WHERE id = '20261027-100000-aaaa'").get() as any).cost).toBe(12.5);
});

test("partial last line waits for its newline; appends picked up", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  const roots = [resolveRoot("bella", sb.bella)];
  ingestOnce(db, roots);
  const p = join(sb.bella, "cache", "api-log.jsonl");
  // finish the dangling fx10 record
  const tail = readFileSync(p, "utf8").split("\n").at(-1)!;
  const rest = JSON.stringify({ ts: 1793120760000, request_id: "req_fx10", model: "claude-opus-5-5", attempt: 1, ttft_ms: 0, total_ms: 3000, stop_reason: "tool_use", usage: { input: 10, output: 100, cache_read: 90000, cache_write: 1000, cache_write_5m: 1000, cache_write_1h: 0, hit_pct: 0 }, context: { messages: 3, tools: 20, system_bytes: 2000, breakpoints: [2] } }).slice(tail.length);
  appendFileSync(p, rest + "\n" + line(1));
  const st = ingestOnce(db, roots);
  expect(st.requests).toBe(2);
  expect(st.bad_lines).toBe(0);
  expect(ids(db)).toContain("req_fx10");
  expect(ids(db)).toContain("req_new1");
});

test("rotation (rename X → X.1, fresh X): the old file is finished, the new one read from 0", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  const roots = [resolveRoot("bella", sb.bella)];
  ingestOnce(db, roots);
  const p = join(sb.bella, "cache", "api-log.jsonl");
  appendFileSync(p, "\n" + line(2)); // terminates fx10's fragment (malformed) and adds an unread record
  renameSync(p, p + ".1"); // Synaps' rotation: rename, then a fresh file
  writeFileSync(p, line(3) + line(4));
  const st = ingestOnce(db, roots);
  expect(st.requests).toBe(3);
  for (const id of ["req_new2", "req_new3", "req_new4"]) expect(ids(db)).toContain(id);
  // state follows inodes: exactly the two live generations remain, both fully consumed
  const rows = db.query("SELECT path, offset, size FROM ingest_state WHERE source = 'bella:api-log' ORDER BY path").all() as any[];
  expect(rows.length).toBe(2);
  for (const r of rows) expect(r.offset).toBe(r.size);
  expect(ingestOnce(db, roots).requests).toBe(0);
});

test("truncation / replacement restarts at 0 (rows are deduped)", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  const roots = [resolveRoot("bella", sb.bella)];
  ingestOnce(db, roots);
  const p = join(sb.bella, "cache", "api-log.jsonl");
  truncateSync(p, 0);
  writeFileSync(p, line(5));
  const st = ingestOnce(db, roots);
  expect(st.requests).toBe(1);
  expect(st.errors).toBe(0);
  // same size, different head → replaced, re-read
  writeFileSync(p, line(6));
  expect(ingestOnce(db, roots).requests).toBe(1);
});

test("unchanged whole files are not re-read; touched ones are", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  const roots = [resolveRoot("bella", sb.bella)];
  ingestOnce(db, roots);
  expect(ingestOnce(db, roots).sessions).toBe(0);
  const p = join(sb.bella, "sessions", "20261027-100000-aaaa.json");
  const t = statSync(p).mtime;
  writeFileSync(p, readFileSync(p, "utf8").replace('"updated_at":"2026-10-27T16:00:00Z"', '"updated_at":"2026-10-27T17:00:00Z"'));
  utimesSync(p, t, new Date(t.getTime() + 5000));
  expect(ingestOnce(db, roots).sessions).toBe(1);
});

test("sources never written: sizes and mtimes unchanged by ingest", () => {
  sb = sandbox();
  const files = ["cache/api-log.jsonl", "cache/api-log.jsonl.1", "cache/request-trace.jsonl", "sessions/20261027-100000-aaaa.json", "logs/synaps.log.2026-05-01"].map((f) => join(sb!.bella, f));
  const before = files.map((f) => { const s = statSync(f); return [s.size, s.mtimeMs, s.ino]; });
  ingestOnce(openDb(sb.db), [resolveRoot("bella", sb.bella)]);
  expect(files.map((f) => { const s = statSync(f); return [s.size, s.mtimeMs, s.ino]; })).toEqual(before);
});

test("missing roots are harmless; telemetry_sources parsing", () => {
  sb = sandbox();
  const st = ingestOnce(openDb(sb.db), [resolveRoot("ghost", join(sb.dir, "nope"))]);
  expect(st.errors).toBe(0);
  expect(st.requests).toBe(0);
  const r = parseSources(`jade=${sb.jade}, lab = /x/y ; bad`);
  expect(r.map((x) => [x.host, x.cacheDir])).toEqual([["jade", join(sb.jade, "cache")], ["lab", "/x/y/cache"]]);
});
