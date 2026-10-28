// The extension wiring: config → store → worker-thread ingest → queries, off the main thread.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { startTelemetry, telemetryConfig, defaultDbPath } from "../../telemetry/extension.ts";
import { sandbox } from "./helpers.ts";

test("plugin config → TelemetryConfig", () => {
  expect(telemetryConfig({}).enabled).toBe(true);
  expect(telemetryConfig({ telemetry: "off" }).enabled).toBe(false);
  expect(telemetryConfig({}).dbPath).toBe(defaultDbPath());
  expect(defaultDbPath()).toEndWith("/synaps-telemetry/telemetry.db");
  const c = telemetryConfig({ telemetry_db: "/tmp/x.db", telemetry_host: "bella", telemetry_sources: "jade=/a" });
  expect([c.dbPath, c.host, c.sources]).toEqual(["/tmp/x.db", "bella", "jade=/a"]);
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

test("worker thread ingests; main thread stays free and can query meanwhile", async () => {
  const sb = sandbox();
  const logs: string[] = [];
  const t = startTelemetry({ enabled: true, dbPath: sb.db, host: "bella", sources: `bella=${sb.bella},jade=${sb.jade}`, includeLocal: false, intervalMs: 50 }, (...a) => logs.push(a.join(" ")));
  try {
    expect(t.query).not.toBeNull();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (t.query!.health({}).ingest.rows.requests < 11)) await Bun.sleep(20);
    clearInterval(timer);
    expect(t.query!.health({}).ingest.rows).toEqual({ requests: 11, traces: 2, sessions: 3, workers: 2, legacy: 3 });
    expect(ticks).toBeGreaterThan(0);
    expect(t.query!.summary({}).all.requests).toBe(11);
    expect(t.query!.health({}).ingest.last_run).toBeGreaterThan(0);
  } finally {
    t.stop();
    sb.done();
  }
});
