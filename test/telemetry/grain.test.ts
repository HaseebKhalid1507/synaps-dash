// Spend accounting: one grain decision per session, origin host labels, additivity across hosts.
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openDb, metaSet } from "../../telemetry/schema.ts";
import { ingestOnce, resolveRoot, refreshReleases, rebuildSessions } from "../../telemetry/ingest.ts";
import { handleTelemetry } from "../../telemetry/http.ts";
import { TelemetryQuery, type Filter } from "../../telemetry/query.ts";
import { sandbox, relaxTimeouts } from "./helpers.ts";

relaxTimeouts();

let sb: ReturnType<typeof sandbox>;
let q: TelemetryQuery;
beforeAll(() => {
  sb = sandbox();
  const db = openDb(sb.db);
  ingestOnce(db, [resolveRoot("bella", sb.bella), resolveRoot("jade", sb.jade)]);
  q = new TelemetryQuery(db);
}, 60_000);
afterAll(() => sb.done());

const sess = (id: string) => q.db.query("SELECT host, grain, cost, copies FROM sessions WHERE id = ?").get(id) as any;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test("additivity: per-host slices add up to the all-hosts total", () => {
  const ranges: Filter[] = [{}, { from: Date.parse("2026-06-01T00:00:00Z") }, { to: Date.parse("2026-07-03T12:34:56Z") }, { from: Date.parse("2026-04-20T15:00:00Z"), to: Date.parse("2026-10-27T16:30:00Z") }];
  for (const r of ranges) {
    const all = q.summary(r).all;
    const parts = ["bella", "jade"].map((host) => q.summary({ ...r, host }).all);
    expect(sum(parts.map((p) => p.spend ?? 0))).toBeCloseTo(all.spend ?? 0, 3);
    expect(sum(parts.map((p) => p.requests ?? 0))).toBe(all.requests ?? 0);
    expect(sum(parts.map((p) => p.sessions ?? 0))).toBe(all.sessions ?? 0);
    expect(sum(parts.map((p) => p.tokens.input ?? 0))).toBe(all.tokens.input ?? 0);
    expect(sum(parts.map((p) => p.saved_by_cache ?? 0))).toBeCloseTo(all.saved_by_cache ?? 0, 3);
    // the spend series agree with the summary, per host and in total
    const s = q.spend(r, "host");
    for (const p of s.series) expect(sum(p.points.map((x: any) => x[1]))).toBeCloseTo(q.summary({ ...r, host: p.key }).all.spend ?? 0, 3);
    const heat = (f: Filter) => sum(q.heatmap(f).cells.map((c) => c[2]));
    expect(heat({ ...r, host: "bella" }) + heat({ ...r, host: "jade" })).toBe(heat(r));
  }
});

test("a session straddling a cutover is request grain: its session_cost is never added", () => {
  expect(sess("20260625-100000-dddd")).toMatchObject({ host: "jade", grain: "request", cost: 100 });
  const reqCost = (q.db.query("SELECT SUM(cost) c FROM requests").get() as any).c;
  expect(q.summary({}).all.spend).toBeCloseTo(reqCost + 3.25 + 40 + 7.5, 3);
  // and not in any host's slice either
  expect(q.summary({ host: "jade" }).all.spend).toBeCloseTo((q.db.query("SELECT SUM(cost) c FROM requests WHERE host = 'jade'").get() as any).c + 40 + 7.5, 3);
});

test("a jade session copied to bella and resumed there: origin jade, newest data, counted once", () => {
  expect(sess("20260701-100000-eeee")).toEqual({ host: "jade", grain: "session", cost: 7.5, copies: 2 });
  const day = (host: string) => {
    const s = q.spend({ host }, "model");
    return sum(s.series.map((x: any) => x.points.find((p: any) => p[0] === "2026-07-01")?.[1] ?? 0));
  };
  expect(day("jade")).toBeCloseTo(7.5, 6);
  expect(day("bella")).toBe(0);
});

test("missing session_cost stays null and adds nothing", () => {
  expect(sess("20260502-100000-ffff")).toMatchObject({ host: "bella", grain: "session", cost: null });
});

test("legacy lines count only outside their own host's api-log days", () => {
  // bella legacy 05-01 (bella's api-log is 10-27 only) and jade legacy 04-20 (jade's: 06-29..07-19)
  const leg = q.cache({}).daily.filter((d: any) => d.grain !== "request").map((d: any) => d.day);
  expect(leg).toEqual(["2026-04-20", "2026-05-01"]);
  expect(q.cache({ host: "bella" }).daily.filter((d: any) => d.grain === "legacy").map((d: any) => d.day)).toEqual(["2026-05-01"]);
});

test("releases: minor releases (vX.Y.0) only, inside the range; read async by the worker", async () => {
  metaSet(q.db, "releases", JSON.stringify([{ tag: "v0.1.0", ts: 1000 }, { tag: "v0.1.3", ts: 2000 }, { tag: "v0.9.0", ts: 3000 }, { tag: "nightly", ts: 3500 }, { tag: "v0.10.0", ts: 4000 }]));
  expect(q.releases().map((r) => r.tag)).toEqual(["v0.1.0", "v0.9.0", "v0.10.0"]);
  expect(q.cache({ from: 2500, to: 3999 }).releases).toEqual([{ tag: "v0.9.0", ts: 3000 }]);
  const repo = mkdtempSync(join(tmpdir(), "synaps-telemetry-git-"));
  try {
    const git = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "x");
    git("tag", "v1.2.0");
    git("tag", "v1.2.1");
    await refreshReleases(q.db, repo);
    expect(q.releases().map((r) => r.tag)).toEqual(["v1.2.0"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("origin first, then grain on the origin host only", () => {
  // bella's api-log has a gap; jade's api-log spans it. A bella-only session in that gap with
  // bella Token Usage activity and no bella rows must keep its session_cost (it ran on bella).
  let sb2: ReturnType<typeof sandbox>;
  let q2: TelemetryQuery;
  const J = (o: unknown) => JSON.stringify(o);
  const req = (id: string, ts: number) => J({ ts, request_id: id, model: "claude-opus-5-5", attempt: 1, ttft_ms: 0, total_ms: 1000, stop_reason: "end_turn", usage: { input: 10, output: 10, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0 }, context: {} });
  const sessJ = (id: string, c: string, u: string, cost: number) => J({ id, title: id, model: "anthropic/claude-opus-5-5", created_at: c, updated_at: u, total_input_tokens: 1, total_output_tokens: 1, session_cost: cost, message_count: 2, api_messages: [] });
  const T = (s: string) => Date.parse(s);
  beforeAll(() => {
    sb2 = sandbox();
    const A = join(sb2.dir, "A"), B = join(sb2.dir, "B");
    for (const d of [join(A, "cache"), join(A, "sessions"), join(A, "logs"), join(B, "cache"), join(B, "sessions")]) mkdirSync(d, { recursive: true });
    // host B logs requests all through September; host A only from 09-30
    writeFileSync(join(B, "cache", "api-log.jsonl"), [req("b1", T("2026-09-01T12:00:00Z")), req("b2", T("2026-09-25T12:00:00Z")), req("b3", T("2026-09-29T12:00:00Z"))].join("\n") + "\n");
    writeFileSync(join(A, "cache", "api-log.jsonl"), [req("a1", T("2026-09-30T12:00:00Z"))].join("\n") + "\n");
    writeFileSync(join(A, "logs", "synaps.log.2026-09-25"), "2026-09-25T13:00:00.000000Z DEBUG ThreadId(1) Token Usage: 5 input | 5 output | 0 cache_read | 0 cache_create\n");
    // gap: A-only, inside B's span, B rows in its window (b2), no A rows → session grain, host A
    writeFileSync(join(A, "sessions", "gap.json"), sessJ("gap", "2026-09-25T10:00:00Z", "2026-09-25T14:00:00Z", 301));
    // A-only, A rows in its window → request grain
    writeFileSync(join(A, "sessions", "late.json"), sessJ("late", "2026-09-30T10:00:00Z", "2026-09-30T14:00:00Z", 5));
    // identical copies on both, no activity anywhere in the window, same whole-second mtime → unknown
    for (const R of [A, B]) {
      const p = join(R, "sessions", "twin.json");
      writeFileSync(p, sessJ("twin", "2026-08-10T10:00:00Z", "2026-08-10T11:00:00Z", 2)); // before any api-log span
      utimesSync(p, new Date(T("2026-08-10T11:00:00Z")), new Date(T("2026-08-10T11:00:00Z") + (R === A ? 100 : 700)));
    }
    const db = openDb(sb2.db);
    ingestOnce(db, [resolveRoot("A", A), resolveRoot("B", B)]);
    q2 = new TelemetryQuery(db);
  }, 60_000);
  afterAll(() => sb2.done());
  const row = (id: string) => q2.db.query("SELECT host, grain, cost FROM sessions WHERE id = ?").get(id) as any;

  test("a session on A only, during B's api-log span, with no A rows in its window, is session grain", () => {
    expect(row("gap")).toEqual({ host: "A", grain: "session", cost: 301 });
    expect(row("late")).toMatchObject({ host: "A", grain: "request" });
    expect(q2.summary({ host: "A" }).all.spend).toBeCloseTo(301 + (q2.db.query("SELECT SUM(cost) c FROM requests WHERE host = 'A'").get() as any).c, 3);
  });

  test("undecidable origin is 'unknown' (not alphabetical); filters and additivity include it", () => {
    expect(row("twin")).toEqual({ host: "unknown", grain: "session", cost: 2 });
    expect(q2.summary({ host: "unknown" }).all).toMatchObject({ spend: 2, sessions: 1, requests: null });
    const all = q2.summary({}).all;
    const parts = ["A", "B", "unknown"].map((host) => q2.summary({ host }).all);
    expect(sum(parts.map((p) => p.spend ?? 0))).toBeCloseTo(all.spend!, 3);
    expect(sum(parts.map((p) => p.sessions ?? 0))).toBe(all.sessions!);
    expect(q2.spend({}, "host").series.map((s: any) => s.key).sort()).toEqual(["A", "B", "unknown"]);
    const u = new URL("http://x/api/telemetry/sessions?host=unknown");
    expect(handleTelemetry(new Request(u), u, q2)!.status).toBe(200);
  });

  test("#322-linked rows decide grain directly (sid), even with no unlinked rows in the window", () => {
    const db = q2.db;
    db.query(`INSERT INTO requests SELECT 'linked1', host, ts, day, wd, hour, model, attempt, ttft_ms, total_ms, stop, input, output, cache_read, cache_write, cw5m, cw1h, cw_unknown,
      ctx_messages, ctx_tools, system_bytes, worker, keepwarm, miss_reason, missed_tokens, refusal_retries, cost, saved, saved_net, cost_reported,
      'gap', turn_id, 'session-1-1', trace_request_id, 1, agent, handle, parent_session, parent_runtime_session_id, 'gap' FROM requests WHERE request_id = 'b1'`).run();
    rebuildSessions(db);
    expect(row("gap").grain).toBe("request");
  });
});
