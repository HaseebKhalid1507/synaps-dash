import { test, expect, afterEach } from "bun:test";
import { appendFileSync, renameSync, writeFileSync, truncateSync, readFileSync, statSync, utimesSync, symlinkSync, rmSync, openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openDb } from "../../telemetry/schema.ts";
import { ingestOnce, resolveRoot, parseSources, scanArchiveRefs, localRoot } from "../../telemetry/ingest.ts";
import { sandbox, FIXTURES } from "./helpers.ts";

let sb: ReturnType<typeof sandbox> | null = null;
afterEach(() => { sb?.done(); sb = null; });

const counts = (db: any) => Object.fromEntries(["requests", "traces", "sessions", "workers", "worker_links", "legacy_usage", "rollup_daily", "legacy_daily"].map((t) => [t, (db.query(`SELECT COUNT(*) n FROM ${t}`).get() as any).n]));
const ids = (db: any) => (db.query("SELECT request_id FROM requests ORDER BY request_id").all() as any[]).map((r) => r.request_id);
const line = (i: number) => JSON.stringify({ ts: 1793120000000 + i, request_id: `req_new${i}`, model: "claude-opus-5-5", attempt: 1, ttft_ms: 0, total_ms: 1000, stop_reason: "end_turn", usage: { input: 1, output: 1, cache_read: 1, cache_write: 1, cache_write_5m: 1, cache_write_1h: 0 }, context: {} }) + "\n";

test("backfill counts; second pass inserts nothing (idempotent)", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  const roots = [resolveRoot("bella", sb.bella), resolveRoot("jade", sb.jade)];
  const a = ingestOnce(db, roots);
  expect(a.errors).toBe(0);
  // .1: fx1-3; current: fx4, fx5+fx6 glued, fx7-9 (the unterminated fx10 is not consumed yet); jade: 101-103
  expect(ids(db)).toEqual(["req_fx1", "req_fx2", "req_fx3", "req_fx4", "req_fx5", "req_fx6", "req_fx7", "req_fx8", "req_fx9", "req_fx101", "req_fx102", "req_fx103"].sort());
  expect(a.bad_lines).toBe(2); // the broken api-log line + the non-JSON trace line
  const c1 = counts(db);
  expect(c1).toEqual({ requests: 12, traces: 2, sessions: 6, workers: 2, worker_links: 1, legacy_usage: 3, rollup_daily: 6, legacy_daily: 2 });
  const b = ingestOnce(db, roots);
  expect([b.requests, b.traces, b.legacy, b.sessions, b.workers, b.bad_lines]).toEqual([0, 0, 0, 0, 0, 0]);
  expect(counts(db)).toEqual(c1);
  // a fresh DB over the same files gets the same rows
  const db2 = openDb(join(sb.dir, "t2.db"));
  ingestOnce(db2, roots);
  expect(counts(db2)).toEqual(c1);
});

test("sessions on both hosts: data from the newest copy, host = origin; junk files skipped + counted", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  ingestOnce(db, [resolveRoot("jade", sb.jade), resolveRoot("bella", sb.bella)]); // jade first: bella must still win
  // aaaa: no api-log span covers its start; bella has the request activity inside it → bella
  const s = db.query("SELECT host, cost, updated, copies FROM sessions WHERE id = '20261027-100000-aaaa'").get() as any;
  expect([s.host, s.cost, s.updated, s.copies]).toEqual(["bella", 12.5, Date.parse("2026-10-27T16:00:00Z"), 2]);
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
  const rows = db.query("SELECT path, offset, size FROM ingest_state WHERE source = 'bella:api-log' AND missing = 0 ORDER BY path").all() as any[];
  expect(rows.length).toBe(2); // + the vanished generation, kept one more pass (see the race test)
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

test("rotation landing mid-pass: the briefly unseen generation keeps its offset (no re-read)", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  const roots = [resolveRoot("bella", sb.bella)];
  ingestOnce(db, roots);
  const p = join(sb.bella, "cache", "api-log.jsonl");
  // The pass misses .1 (as if it were rotated away between our two reads)…
  renameSync(p + ".1", join(sb.dir, "parked"));
  expect(ingestOnce(db, roots).requests).toBe(0);
  expect((db.query("SELECT missing FROM ingest_state WHERE path = ?").get(p + ".1") as any).missing).toBe(1);
  // …and it is back next pass: resumed from its offset, nothing re-read, nothing lost.
  renameSync(join(sb.dir, "parked"), p + ".1");
  appendFileSync(p + ".1", line(7));
  const st = ingestOnce(db, roots);
  expect([st.requests, st.bad_lines, st.lost_bytes]).toEqual([1, 0, 0]);
});

test("double rotation between passes: the unread tail is counted in lost_bytes", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  const roots = [resolveRoot("bella", sb.bella)];
  ingestOnce(db, roots);
  const p = join(sb.bella, "cache", "api-log.jsonl");
  const unread = "\n" + line(8); // terminates the fx10 fragment + one new record, never read
  appendFileSync(p, unread);
  renameSync(p, p + ".1"); // rotation 1 (the old .1 is replaced)
  writeFileSync(p, line(9));
  renameSync(p, p + ".1"); // rotation 2: the generation holding the unread tail is gone
  writeFileSync(p, line(10));
  ingestOnce(db, roots);
  const st = ingestOnce(db, roots); // 2nd pass without it → state dropped, loss counted
  // a lower bound: the bytes we last saw unread (the dangling fx10 fragment); later appends were never seen
  const tailBytes = Buffer.byteLength(readFileSync(join(FIXTURES, "bella/cache/api-log.jsonl"), "utf8").split("\n").at(-1)!);
  expect(tailBytes).toBeGreaterThan(0);
  expect(st.lost_bytes).toBe(tailBytes);
  expect(Number((db.query("SELECT value FROM meta WHERE key = 'lost_bytes'").get() as any).value)).toBe(tailBytes);
  expect(ids(db)).toContain("req_new9");
  expect(ids(db)).not.toContain("req_new8");
});

test("chunk boundaries: any chunk size (incl. lines longer than a chunk) yields the same rows", () => {
  sb = sandbox();
  const roots = [resolveRoot("bella", sb.bella), resolveRoot("jade", sb.jade)];
  const ref = openDb(join(sb.dir, "ref.db"));
  ingestOnce(ref, roots);
  const dump = (db: any) => JSON.stringify([
    db.query("SELECT request_id, cost FROM requests ORDER BY 1").all(),
    db.query("SELECT key FROM traces ORDER BY 1").all(),
    db.query("SELECT file, off, ts FROM legacy_usage ORDER BY 1, 2").all(),
    db.query("SELECT host, proc, handle, session_id FROM worker_links ORDER BY 1, 2, 3").all(),
    db.query("SELECT id, host, grain FROM sessions ORDER BY 1").all(),
  ]);
  for (const chunk of [1, 7, 64, 333, 4096]) {
    const db = openDb(join(sb.dir, `c${chunk}.db`));
    const st = ingestOnce(db, roots, { chunk, headBytes: 256 });
    expect(st.bad_lines).toBe(2);
    expect(dump(db)).toBe(dump(ref));
  }
}, 60_000);

test("archive_path scan across chunk edges finds every reference once", () => {
  sb = sandbox();
  const p = join(sb.dir, "big.json");
  const ref = (i: number) => `{\\"archive_path\\":\\"/home/x/.synaps-cli/subagent-history/9-p/sa_${i}.json\\"}`;
  let body = '{"id":"s","created_at":"2026-10-27T14:00:00Z","api_messages":[';
  for (let i = 1; i <= 40; i++) body += `"${"x".repeat(i * 37)}${ref(i)}",`;
  writeFileSync(p, body + '"end"]}');
  for (const chunk of [1, 5, 100, 1000, 1 << 20]) {
    const fd = openSync(p, "r");
    const refs = scanArchiveRefs(fd, chunk).map((r) => r[1]).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
    closeSync(fd);
    expect(refs).toEqual(Array.from({ length: 40 }, (_, i) => `sa_${i + 1}`));
  }
});

test("symlinks and FIFOs are skipped, never followed or opened blocking", () => {
  sb = sandbox();
  const outside = join(sb.dir, "outside.json");
  writeFileSync(outside, readFileSync(join(sb.jade, "sessions", "20260420-100000-cccc.json"), "utf8").replace("cccc", "zzzz"));
  symlinkSync(outside, join(sb.bella, "sessions", "20260101-000000-zzzz.json"));
  spawnSync("mkfifo", [join(sb.bella, "sessions", "20260101-000000-fifo.json")]);
  // the api-log itself as a FIFO and the trace as a symlink
  const p = join(sb.bella, "cache", "api-log.jsonl");
  renameSync(p, join(sb.dir, "api-log.real"));
  spawnSync("mkfifo", [p]);
  const tr = join(sb.bella, "cache", "request-trace.jsonl");
  renameSync(tr, join(sb.dir, "trace.real"));
  symlinkSync(join(sb.dir, "trace.real"), tr);
  const db = openDb(sb.db);
  const t0 = Date.now();
  const st = ingestOnce(db, [resolveRoot("bella", sb.bella)]);
  expect(Date.now() - t0).toBeLessThan(5000); // did not block on the FIFO
  expect(st.errors).toBe(0);
  expect((db.query("SELECT COUNT(*) n FROM sessions WHERE id LIKE '%zzzz'").get() as any).n).toBe(0);
  expect((db.query("SELECT COUNT(*) n FROM traces").get() as any).n).toBe(0);
  expect(ids(db)).toEqual(["req_fx1", "req_fx2", "req_fx3"]); // only the regular .1
  const skipped = Number((db.query("SELECT value FROM meta WHERE key = 'count_skipped'").get() as any).value) + Number((db.query("SELECT value FROM meta WHERE key = 'skipped_special'").get() as any).value);
  expect(skipped).toBe(3 + 2 + 2); // .lock, index.jsonl, broken.json + symlink + fifo (sessions) + fifo + symlink (streams)
});

test("deleted session and worker files are pruned", () => {
  sb = sandbox();
  const db = openDb(sb.db);
  const roots = [resolveRoot("bella", sb.bella), resolveRoot("jade", sb.jade)];
  ingestOnce(db, roots);
  rmSync(join(sb.bella, "sessions", "20260501-100000-bbbb.json"));
  rmSync(join(sb.bella, "sessions", "20261027-100000-aaaa.json")); // jade still has a copy
  rmSync(join(sb.bella, "subagent-history", "1-abc", "sa_2.json"));
  const st = ingestOnce(db, roots);
  expect(st.pruned).toBe(3);
  expect((db.query("SELECT COUNT(*) n FROM sessions WHERE id = '20260501-100000-bbbb'").get() as any).n).toBe(0);
  const a = db.query("SELECT host, copies, cost FROM sessions WHERE id = '20261027-100000-aaaa'").get() as any;
  expect([a.host, a.copies, a.cost]).toEqual(["jade", 1, 11]);
  expect((db.query("SELECT COUNT(*) n FROM worker_links WHERE host = 'bella'").get() as any).n).toBe(0);
  expect((db.query("SELECT COUNT(*) n FROM workers").get() as any).n).toBe(1);
});

test("profile-aware local root (sessions + logs per profile; api-log and subagents shared)", () => {
  const d = localRoot("bella", null), p = localRoot("bella", "webproto");
  expect(p.sessionsDir).toBe(join(d.logsDir, "webproto", "sessions"));
  expect(p.logsDir).toBe(join(d.logsDir, "webproto"));
  expect([p.cacheDir, p.subagentsDir]).toEqual([d.cacheDir, d.subagentsDir]);
});
