// Spend accounting: one grain decision per session, origin host labels, additivity across hosts.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openDb, metaSet } from "../../telemetry/schema.ts";
import { ingestOnce, resolveRoot, refreshReleases } from "../../telemetry/ingest.ts";
import { TelemetryQuery, type Filter } from "../../telemetry/query.ts";
import { sandbox } from "./helpers.ts";

let sb: ReturnType<typeof sandbox>;
let q: TelemetryQuery;
beforeAll(() => {
  sb = sandbox();
  const db = openDb(sb.db);
  ingestOnce(db, [resolveRoot("bella", sb.bella), resolveRoot("jade", sb.jade)]);
  q = new TelemetryQuery(db);
});
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
