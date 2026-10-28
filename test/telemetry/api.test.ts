// Every endpoint's shape against docs/telemetry-api.md, over the fixture roots.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { openDb } from "../../telemetry/schema.ts";
import { ingestOnce, resolveRoot } from "../../telemetry/ingest.ts";
import { TelemetryQuery } from "../../telemetry/query.ts";
import { handleTelemetry } from "../../telemetry/http.ts";
import { sandbox } from "./helpers.ts";

let sb: ReturnType<typeof sandbox>;
let q: TelemetryQuery;
beforeAll(() => {
  sb = sandbox();
  const db = openDb(sb.db);
  ingestOnce(db, [resolveRoot("bella", sb.bella), resolveRoot("jade", sb.jade)]);
  q = new TelemetryQuery(db, { releasesRepo: sb.dir /* not a git repo → [] */ });
});
afterAll(() => sb.done());

async function get(path: string, status = 200): Promise<any> {
  const u = new URL(path, "http://127.0.0.1:7717");
  const res = handleTelemetry(new Request(u), u, q);
  expect(res).not.toBeNull();
  expect(res!.status).toBe(status);
  expect(res!.headers.get("content-type")).toContain("application/json");
  return res!.json();
}

const NUM = "number", STR = "string", BOOL = "boolean";
type Spec = string | Spec[] | { [k: string]: Spec } | ((v: any) => boolean);
const nullable = (t: string) => (v: any) => v === null || typeof v === t;
/** Exact key set (extra keys allowed only where listed), recursive. */
function shape(v: any, spec: Spec, path = "$") {
  if (typeof spec === "function") { if (!spec(v)) throw new Error(`${path}: unexpected ${JSON.stringify(v)}`); return; }
  if (typeof spec === "string") { if (typeof v !== spec) throw new Error(`${path}: want ${spec}, got ${JSON.stringify(v)}`); return; }
  if (Array.isArray(spec)) {
    if (!Array.isArray(v)) throw new Error(`${path}: want array`);
    if (spec.length === 1) v.forEach((x: any, i: number) => shape(x, spec[0], `${path}[${i}]`));
    else { if (v.length !== spec.length) throw new Error(`${path}: want tuple ${spec.length}`); v.forEach((x: any, i: number) => shape(x, spec[i], `${path}[${i}]`)); }
    return;
  }
  if (!v || typeof v !== "object") throw new Error(`${path}: want object`);
  for (const k of Object.keys(spec)) { if (!(k in v)) throw new Error(`${path}.${k}: missing`); shape(v[k], spec[k], `${path}.${k}`); }
}

test("GET /api/telemetry/summary", async () => {
  const s = await get("/api/telemetry/summary");
  shape(s, {
    generated_at: NUM,
    now: { spend_today: nullable(NUM), burn_rate_per_hour: nullable(NUM), requests_today: nullable(NUM), hit_pct_1h: nullable(NUM), ttft_p50_ms_1h: nullable(NUM), total_p50_ms_1h: nullable(NUM), live_sessions: nullable(NUM), live_workers: nullable(NUM) },
    all: { spend: NUM, requests: NUM, sessions: NUM, first_ts: NUM, last_ts: NUM, tokens: { input: NUM, output: NUM, cache_read: NUM, cache_write: NUM }, saved_by_cache: NUM },
  });
  expect(s.all.requests).toBe(11);
  expect(s.all.sessions).toBe(3);
  // fixtures are in the past: nothing "today" → null, never 0
  expect(s.now.spend_today).toBeNull();
  expect(s.now.requests_today).toBeNull();
  // spend = request-level rows + sessions created before the first request (bella 20260501 $3.25 + jade 20260420 $40)
  const reqCost = (q.db.query("SELECT SUM(cost) c FROM requests").get() as any).c;
  expect(s.all.spend).toBeCloseTo(reqCost + 43.25, 3);
  expect(s.all.first_ts).toBe(Date.parse("2026-04-20T14:00:00Z"));
  const empty = await get("/api/telemetry/summary?host=nobody");
  expect(empty.all.spend).toBeNull();
  expect(empty.all.tokens.input).toBeNull();
});

test("GET /api/telemetry/spend (model | role | host), dense days, grain", async () => {
  for (const group of ["model", "role", "host"]) {
    const s = await get(`/api/telemetry/spend?bucket=day&group=${group}`);
    shape(s, { bucket: (v) => v === "day", group: (v) => v === group, series: [{ key: STR, points: [[STR, NUM]] }], grain: [[STR, (v) => v === "session" || v === "request"]] });
    const n = s.series[0].points.length;
    for (const x of s.series) {
      expect(x.points.length).toBe(n); // every day present for every series
      expect(x.points[0][0]).toBe(s.series[0].points[0][0]);
    }
    expect(s.series[0].points[0][0]).toBe("2026-04-20");
    expect(s.series[0].points.at(-1)[0]).toBe("2026-10-27");
    expect(s.grain).toEqual([["2026-04-20", "session"], ["2026-06-29", "request"]]);
  }
  const role = await get("/api/telemetry/spend?group=role");
  expect(role.series.map((x: any) => x.key).sort()).toEqual(["main", "worker"]);
  const host = await get("/api/telemetry/spend?group=host&host=bella");
  expect(host.series.map((x: any) => x.key)).toEqual(["bella"]);
  expect(host.grain.at(-1)).toEqual(["2026-10-27", "request"]);
  await get("/api/telemetry/spend?group=nope", 400);
  await get("/api/telemetry/spend?bucket=week", 400);
});

test("GET /api/telemetry/agents", async () => {
  const a = await get("/api/telemetry/agents");
  shape(a, { agents: [{ name: STR, runs: NUM, requests: nullable(NUM), spend: nullable(NUM), models: [STR] }] });
  const spike = a.agents.find((x: any) => x.name === "spike");
  expect(spike).toMatchObject({ runs: 1, requests: 1, models: ["claude-opus-5-5"] });
  expect(spike.spend).toBeGreaterThan(0);
  expect(a.agents.find((x: any) => x.name === "okarin")).toMatchObject({ runs: 1, requests: null, spend: null });
});

test("GET /api/telemetry/cache", async () => {
  const c = await get("/api/telemetry/cache");
  shape(c, {
    daily: [{ day: STR, hit_pct: nullable(NUM), read: NUM, write_5m: nullable(NUM), write_1h: nullable(NUM), fresh_input: NUM, grain: (v) => v === "request" || v === "legacy" }],
    miss_reasons: [{ reason: STR, count: NUM }],
    keepwarm: { pings: NUM, cost: nullable(NUM), est_saved: nullable(NUM) },
    releases: [{ tag: STR, ts: NUM }],
  });
  expect(c.miss_reasons).toEqual([{ reason: "tools_changed", count: 1 }]);
  expect(c.keepwarm.pings).toBe(1);
  expect(c.releases).toEqual([]);
  expect(c.daily.filter((d: any) => d.grain === "legacy").map((d: any) => d.day)).toEqual(["2026-04-20", "2026-05-01"]);
  const day = c.daily.find((d: any) => d.day === "2026-10-27");
  expect(day.read).toBe(90000 * 8 + 10000);
});

test("GET /api/telemetry/latency", async () => {
  const l = await get("/api/telemetry/latency");
  shape(l, {
    daily: [{ day: STR, ttft_p50: nullable(NUM), ttft_p95: nullable(NUM), ttft_p99: nullable(NUM), total_p50: nullable(NUM), total_p95: nullable(NUM), n: NUM }],
    split: { headers_p50: nullable(NUM), first_event_p50: nullable(NUM), stream_p50: nullable(NUM) },
    retries: { requests_with_retry: nullable(NUM), rate_pct: nullable(NUM) },
    by_context: [[NUM, NUM]],
  });
  const d = l.daily.find((x: any) => x.day === "2026-10-27");
  expect(d.n).toBe(9);
  expect(d.ttft_p50).toBe(480); // trace first_model_event_ms (fx1) and api-log 812 (fx7): p50 of [480, 812]
  expect(d.ttft_p99).toBe(812);
  expect(l.split).toEqual({ headers_p50: 300, first_event_p50: 480, stream_p50: 2420 });
  expect(l.retries.requests_with_retry).toBe(2); // fx1 (trace retry) + fx4 (attempt 2)
  expect(l.by_context.length).toBe(11);
  const m = await get("/api/telemetry/latency?model=anthropic/claude-fable-5-1");
  expect(m.daily.reduce((a: number, x: any) => a + x.n, 0)).toBe(1);
});

test("GET /api/telemetry/sessions (sort, paging, q)", async () => {
  const row = { id: STR, host: STR, title: nullable(STR), model: STR, created: NUM, updated: NUM, requests: nullable(NUM), spend: NUM, hit_pct: nullable(NUM), peak_context_tokens: nullable(NUM), workers: NUM };
  const s = await get("/api/telemetry/sessions?sort=cost&limit=50&offset=0");
  shape(s, { total: NUM, rows: [row] });
  expect(s.total).toBe(3);
  expect(s.rows.map((r: any) => r.spend)).toEqual([40, 12.5, 3.25]);
  const a = s.rows[1];
  expect(a).toMatchObject({ id: "20261027-100000-aaaa", host: "bella", requests: 3, workers: 1, hit_pct: 89.9 });
  expect(a.peak_context_tokens).toBe(91010);
  expect(s.rows[2].hit_pct).toBeNull(); // old file without cache totals
  expect((await get("/api/telemetry/sessions?sort=updated")).rows[0].id).toBe("20261027-100000-aaaa");
  expect((await get("/api/telemetry/sessions?sort=requests")).rows[0].requests).toBe(3);
  const p = await get("/api/telemetry/sessions?limit=1&offset=1");
  expect([p.total, p.rows.length, p.rows[0].spend]).toEqual([3, 1, 12.5]);
  const f = await get("/api/telemetry/sessions?q=cccc");
  expect([f.total, f.rows[0].host]).toEqual([1, "jade"]);
  expect((await get("/api/telemetry/sessions?q=%25")).total).toBe(0); // LIKE wildcards are literal
  await get("/api/telemetry/sessions?sort=bogus", 400);
});

test("GET /api/telemetry/session/:id", async () => {
  const s = await get("/api/telemetry/session/20261027-100000-aaaa");
  shape(s, {
    session: { id: STR, host: STR, model: STR, created: NUM, updated: NUM, spend: NUM, workers: NUM },
    timeline: [{ ts: NUM, context_tokens: NUM, output: NUM, hit_pct: nullable(NUM), total_ms: nullable(NUM), ttft_ms: nullable(NUM), stop: nullable(STR), worker: BOOL, compaction: BOOL }],
    workers: [{ handle: STR, agent: nullable(STR), model: nullable(STR), spend: nullable(NUM) }],
  });
  expect(s.timeline.map((t: any) => [t.worker, t.compaction])).toEqual([[false, false], [true, false], [false, true]]);
  expect(s.timeline[0]).toMatchObject({ context_tokens: 91010, ttft_ms: 812 });
  expect(s.workers).toEqual([{ handle: "sa_1", agent: "spike", model: "claude-opus-5-5", spend: expect.any(Number) }]);
  const none = await get("/api/telemetry/session/20260420-100000-cccc");
  expect(none.timeline).toEqual([]);
  await get("/api/telemetry/session/nope", 404);
});

test("GET /api/telemetry/heatmap", async () => {
  const h = await get("/api/telemetry/heatmap");
  shape(h, { cells: [[NUM, NUM, NUM]] });
  expect(h.cells.length).toBe(168);
  expect(h.cells.reduce((a: number, c: number[]) => a + c[2], 0)).toBe(11);
  expect(h.cells.find((c: number[]) => c[0] === 1 && c[1] === 12)[2]).toBe(3); // Tue 12:00 local: fx1–3
});

test("GET /api/telemetry/health", async () => {
  const h = await get("/api/telemetry/health");
  shape(h, {
    stops: [{ stop: STR, count: NUM }], refusal_retries: NUM, translation_losses: NUM, tools_changed_misses: NUM,
    ingest: { last_run: NUM, rows: { requests: NUM, traces: NUM, sessions: NUM, workers: NUM, legacy: NUM }, errors: NUM, skipped_files: NUM, sources: [{ host: STR, path: STR, offset: NUM }] },
  });
  expect(h.ingest.rows).toEqual({ requests: 11, traces: 2, sessions: 3, workers: 2, legacy: 3 });
  expect([h.refusal_retries, h.translation_losses, h.tools_changed_misses, h.ingest.skipped_files]).toEqual([1, 1, 1, 3]);
  expect(h.stops.find((s: any) => s.stop === "refusal").count).toBe(1);
});

test("common params, errors, non-GET, foreign paths", async () => {
  const from = Date.parse("2026-10-27T00:00:00Z");
  expect((await get(`/api/telemetry/summary?from=${from}`)).all.requests).toBe(9);
  expect((await get(`/api/telemetry/summary?host=jade`)).all.requests).toBe(2);
  expect((await get(`/api/telemetry/heatmap?to=${from}`)).cells.reduce((a: number, c: number[]) => a + c[2], 0)).toBe(2);
  await get("/api/telemetry/summary?from=yesterday", 400);
  await get("/api/telemetry/summary?host=a%20b", 400);
  await get("/api/telemetry/nope", 404);
  const u = new URL("http://x/api/telemetry/summary");
  expect(handleTelemetry(new Request(u, { method: "POST" }), u, q)!.status).toBe(405);
  expect(handleTelemetry(new Request(u), u, null, "telemetry is disabled")!.status).toBe(503);
  const o = new URL("http://x/api/models");
  expect(handleTelemetry(new Request(o), o, q)).toBeNull();
});
