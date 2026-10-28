// Perf guard: a ~200K-request store (≈ 2× today's real data) keeps the heavy endpoints
// well inside the 250 ms bar, because they read daily rollups, not rows.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { openDb } from "../../telemetry/schema.ts";
import { ingestOnce, resolveRoot } from "../../telemetry/ingest.ts";
import { TelemetryQuery } from "../../telemetry/query.ts";
import { handleTelemetry } from "../../telemetry/http.ts";
import { sandbox, synthRoot } from "./helpers.ts";

let sb: ReturnType<typeof sandbox>;
let q: TelemetryQuery;
beforeAll(() => {
  sb = sandbox();
  const db = openDb(sb.db);
  ingestOnce(db, [resolveRoot("syn", synthRoot(join(sb.dir, "syn"), 200_000, 365))]);
  q = new TelemetryQuery(db);
}, 120_000);
afterAll(() => sb.done());

const BOUND_MS = 60;
const time = (path: string) => {
  const ts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const u = new URL(path, "http://x");
    const t0 = performance.now();
    const r = handleTelemetry(new Request(u), u, q)!;
    expect(r.status).toBe(200);
    ts.push(performance.now() - t0);
  }
  return ts.sort((a, b) => a - b)[2]; // median
};

test("200K rows in the store", () => {
  expect(q.health({}).ingest.rows.requests).toBe(200_000);
});

for (const p of ["/api/telemetry/latency", "/api/telemetry/health", "/api/telemetry/summary", "/api/telemetry/spend?group=model", "/api/telemetry/cache", "/api/telemetry/heatmap",
  `/api/telemetry/latency?from=${Date.parse("2026-06-01T13:17:00Z")}&to=${Date.parse("2026-09-15T02:00:00Z")}`])
  test(`${p.replace(/\?.*/, (m) => m.slice(0, 30))} < ${BOUND_MS} ms (median of 5)`, () => {
    expect(time(p)).toBeLessThan(BOUND_MS);
  });
