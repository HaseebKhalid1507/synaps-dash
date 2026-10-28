// America/New_York bucketing across both 2026 DST transitions.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { local, dayOf, daysBetween, dayStartMs, weekdayOf, nextDay } from "../../telemetry/tz.ts";
import { openDb } from "../../telemetry/schema.ts";
import { ingestOnce, resolveRoot } from "../../telemetry/ingest.ts";
import { TelemetryQuery } from "../../telemetry/query.ts";
import { sandbox } from "./helpers.ts";

test("fall back, 2026-11-01: a 25-hour local day, Sunday", () => {
  const start = dayStartMs("2026-11-01");
  expect(start).toBe(Date.parse("2026-11-01T04:00:00Z")); // EDT midnight
  expect(dayStartMs("2026-11-02")).toBe(Date.parse("2026-11-02T05:00:00Z")); // EST midnight
  expect(dayStartMs("2026-11-02") - start).toBe(25 * 3_600_000);
  expect(local(Date.parse("2026-11-01T05:30:00Z"))).toEqual({ day: "2026-11-01", wd: 6, hour: 1 }); // 1:30 EDT
  expect(local(Date.parse("2026-11-01T06:30:00Z"))).toEqual({ day: "2026-11-01", wd: 6, hour: 1 }); // 1:30 EST, again
  expect(local(Date.parse("2026-11-02T04:59:59Z")).day).toBe("2026-11-01"); // 23:59:59 EST
  expect(local(Date.parse("2026-11-02T05:00:00Z"))).toEqual({ day: "2026-11-02", wd: 0, hour: 0 });
});

test("spring forward, 2026-03-08: a 23-hour local day, no 02:00", () => {
  expect(dayStartMs("2026-03-09") - dayStartMs("2026-03-08")).toBe(23 * 3_600_000);
  expect(local(Date.parse("2026-03-08T06:59:59Z")).hour).toBe(1); // 01:59:59 EST
  expect(local(Date.parse("2026-03-08T07:00:00Z")).hour).toBe(3); // 03:00 EDT
  expect(weekdayOf("2026-03-08")).toBe(6);
  expect(dayOf(dayStartMs("2026-03-08") - 1)).toBe("2026-03-07");
});

test("calendar helpers are DST-proof", () => {
  expect(daysBetween("2026-10-31", "2026-11-03")).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  expect(daysBetween("2026-03-07", "2026-03-09")).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
  expect(nextDay("2026-11-01")).toBe("2026-11-02");
  for (const d of ["2026-01-05", "2026-11-01", "2026-11-02"]) expect(weekdayOf(d)).toBe(local(dayStartMs(d) + 3_600_000).wd);
});

let sb: ReturnType<typeof sandbox>;
let q: TelemetryQuery;
// One request per local hour around fall-back: 23:00 Oct 31 … 02:00 Nov 2 (UTC hours, so the
// repeated 01:00 appears twice), plus spring-forward hours.
const hours: number[] = [];
beforeAll(() => {
  sb = sandbox();
  const dir = join(sb.dir, "dst", "cache");
  mkdirSync(dir, { recursive: true });
  for (let t = Date.parse("2026-11-01T03:00:00Z"); t <= Date.parse("2026-11-02T07:00:00Z"); t += 3_600_000) hours.push(t);
  for (let t = Date.parse("2026-03-08T04:00:00Z"); t <= Date.parse("2026-03-09T05:00:00Z"); t += 3_600_000) hours.push(t);
  writeFileSync(join(dir, "api-log.jsonl"), hours.map((ts, i) => JSON.stringify({ ts, request_id: `req_dst${i}`, model: "claude-opus-5-5", attempt: 1, ttft_ms: 0, total_ms: 1000, stop_reason: "end_turn", usage: { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 }, context: {} })).join("\n") + "\n");
  const db = openDb(sb.db);
  ingestOnce(db, [resolveRoot("dst", join(sb.dir, "dst"))]);
  q = new TelemetryQuery(db);
}, 60_000);
afterAll(() => sb.done());

test("daily spend buckets: 25 requests on Nov 1, 23 on Mar 8 ($4 each)", () => {
  const s = q.spend({}, "model");
  const pts = new Map(s.series[0].points as [string, number][]);
  expect(pts.get("2026-11-01")).toBeCloseTo(25 * 4, 6);
  expect(pts.get("2026-03-08")).toBeCloseTo(23 * 4, 6);
  expect(pts.get("2026-10-31")).toBeCloseTo(1 * 4, 6); // 23:00 EDT Oct 31
  // a from/to range cut at local midnights gives exactly the day, via rollups or raw edges alike
  const one = q.summary({ from: dayStartMs("2026-11-01"), to: dayStartMs("2026-11-02") - 1 });
  expect(one.all.requests).toBe(25);
  const mid = q.summary({ from: dayStartMs("2026-11-01") + 90 * 60_000, to: dayStartMs("2026-11-02") + 30 * 60_000 });
  expect(mid.all.requests).toBe(24); // drops 00:00 EDT and 01:00 EDT, adds 00:00 EST Nov 2
});

test("heatmap: Sunday 01:00 counted twice on fall-back day, Sunday 02:00 absent on spring-forward", () => {
  const cells = new Map(q.heatmap({}).cells.map(([d, h, n]) => [`${d}:${h}`, n]));
  expect(cells.get("6:1")).toBe(2 + 1); // Nov 1 01:00 EDT + 01:00 EST, Mar 8 01:00 EST
  expect(cells.get("6:2")).toBe(1); // Nov 1 02:00 EST only; Mar 8 has no 02:00
  expect(cells.get("0:0")).toBe(2); // Mon Nov 2 00:00 + Mon Mar 9 00:00
  expect([...cells.values()].reduce((a, b) => a + b, 0)).toBe(hours.length);
});
