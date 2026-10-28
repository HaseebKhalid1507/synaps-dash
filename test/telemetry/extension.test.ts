// The extension wiring: config → store → worker-thread ingest → queries, off the main thread.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTelemetry, telemetryConfig, defaultDbPath } from "../../telemetry/extension.ts";
import { sandbox, synthRoot, PERF, SLOW } from "./helpers.ts";

test("plugin config → TelemetryConfig; profiles are opt-in with their own DB", () => {
  expect(telemetryConfig({}).enabled).toBe(true);
  expect(telemetryConfig({ telemetry: "off" }).enabled).toBe(false);
  expect(telemetryConfig({}).dbPath).toBe(defaultDbPath());
  expect(defaultDbPath()).toEndWith("/synaps-telemetry/telemetry.db");
  const c = telemetryConfig({ telemetry_db: "/tmp/x.db", telemetry_host: "bella", telemetry_sources: "jade=/a" });
  expect([c.dbPath, c.host, c.sources]).toEqual(["/tmp/x.db", "bella", "jade=/a"]);
  // a profile daemon (sandbox, demo…): off by default, even with other keys set
  expect(telemetryConfig({}, "webproto").enabled).toBe(false);
  expect(telemetryConfig({ telemetry_host: "x" }, "webproto").enabled).toBe(false);
  const p = telemetryConfig({ telemetry: "on" }, "webproto");
  expect(p.enabled).toBe(true);
  expect(p.dbPath).toEndWith("/synaps-telemetry/telemetry-webproto.db");
  expect(p.profile).toBe("webproto");
  expect(startTelemetry(telemetryConfig({}, "demo"), () => {}).why).toContain("profile 'demo'");
});

test("disabled → no store, a reason for the 503", () => {
  const t = startTelemetry(telemetryConfig({ telemetry: "off" }), () => {});
  expect(t.query).toBeNull();
  expect(t.why).toContain("disabled");
});

test("unopenable db → telemetry off, never throws", () => {
  const t = startTelemetry({ enabled: true, dbPath: "/proc/definitely/not/here.db", host: "x", sources: "", includeLocal: false }, () => {});
  expect(t.query).toBeNull();
  expect(t.why).toContain("unavailable");
});

const TICK_GAP_MS = PERF ? 50 : 2500;
test(`a 60K-row backfill runs in the worker: main-thread tick gaps stay < ${TICK_GAP_MS} ms while querying`, async () => {
  const sb = sandbox();
  synthRoot(join(sb.dir, "syn"), 60_000, 120);
  const t = startTelemetry({ enabled: true, dbPath: sb.db, host: "bella", sources: `syn=${join(sb.dir, "syn")}`, includeLocal: false, intervalMs: 50 }, () => {});
  try {
    let last = performance.now(), maxGap = 0, ticks = 0;
    const timer = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 2);
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && (t.query!.health({}).ingest.rows.requests < 60_000)) {
      t.query!.summary({}); // the HTTP side keeps answering meanwhile
      await Bun.sleep(25);
    }
    clearInterval(timer);
    expect(t.query!.health({}).ingest.rows.requests).toBe(60_000);
    expect(ticks).toBeGreaterThan(50);
    expect(maxGap).toBeLessThan(TICK_GAP_MS);
    expect(t.query!.summary({}).all.requests).toBe(60_000);
  } finally {
    t.stop();
    sb.done();
  }
}, SLOW);

const fake = (dir: string, name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };

test("watchdog: a worker that stops beating is replaced", async () => {
  const sb = sandbox();
  const url = fake(sb.dir, "silent.ts", `self.onmessage = () => { /* never posts: wedged */ };`);
  const logs: string[] = [];
  const t = startTelemetry({ enabled: true, dbPath: sb.db, host: "x", sources: "", includeLocal: false, workerUrl: url, staleMs: 150, restartBaseMs: 20 }, (...a) => logs.push(a.join(" ")));
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && t.stats().spawns < 3) await Bun.sleep(20);
    expect(t.stats().spawns).toBeGreaterThanOrEqual(3);
    expect(logs.some((l) => l.includes("silent for"))).toBe(true);
  } finally { t.stop(); sb.done(); }
}, SLOW);

test("crash → restart with backoff; a successful pass resets the backoff", async () => {
  const sb = sandbox();
  const crash = fake(sb.dir, "crash.ts", `self.onmessage = () => { setTimeout(() => { throw new Error("boom"); }, 5); };`);
  const t1 = startTelemetry({ enabled: true, dbPath: sb.db, host: "x", sources: "", includeLocal: false, workerUrl: crash, restartBaseMs: 10 }, () => {});
  const healthy = fake(sb.dir, "passcrash.ts", `self.onmessage = () => { postMessage({ type: "pass", stats: { ms: 1, errors: 0 } }); setTimeout(() => { throw new Error("boom"); }, 5); };`);
  const t2 = startTelemetry({ enabled: true, dbPath: join(sb.dir, "t2.db"), host: "x", sources: "", includeLocal: false, workerUrl: healthy, restartBaseMs: 10 }, () => {});
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && (t1.stats().spawns < 5 || t2.stats().spawns < 5)) await Bun.sleep(10);
    expect(t1.stats().spawns).toBeGreaterThanOrEqual(5);
    expect(t1.stats().lastDelay).toBeGreaterThanOrEqual(80); // 10, 20, 40, 80… grows
    expect(t2.stats().spawns).toBeGreaterThanOrEqual(5);
    expect(t2.stats().lastDelay).toBe(10); // every pass reset it
  } finally { t1.stop(); t2.stop(); sb.done(); }
}, SLOW);

test("worker-thread ingest of the fixtures; releases come from meta, not a spawn on this thread", async () => {
  const sb = sandbox();
  const t = startTelemetry({ enabled: true, dbPath: sb.db, host: "bella", sources: `bella=${sb.bella},jade=${sb.jade}`, includeLocal: false, intervalMs: 50, releasesRepo: join(sb.dir, "no-repo") }, () => {});
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && t.query!.health({}).ingest.rows.requests < 12) await Bun.sleep(20);
    expect(t.query!.health({}).ingest.rows).toEqual({ requests: 12, traces: 2, sessions: 6, workers: 2, legacy: 3 });
    expect(t.query!.health({}).ingest.last_run).toBeGreaterThan(0);
    expect(t.query!.cache({}).releases).toEqual([]);
  } finally { t.stop(); sb.done(); }
}, SLOW);
