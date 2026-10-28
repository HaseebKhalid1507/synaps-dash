// Telemetry inside the synaps-dash extension: open the store, hand queries to
// the HTTP layer, run ingest in a worker thread. Nothing here may throw into
// the extension — any failure leaves telemetry disabled with a reason.

import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { openDb } from "./schema.ts";
import { TelemetryQuery, type Live } from "./query.ts";
import { localRoot, parseSources } from "./ingest.ts";

export type TelemetryConfig = { enabled: boolean; dbPath: string; host: string; sources: string; intervalMs?: number; includeLocal?: boolean };

export function defaultDbPath(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "synaps-telemetry", "telemetry.db");
}

/** Plugin config (strings, as the daemon delivers them) → TelemetryConfig. */
export function telemetryConfig(c: Record<string, unknown> | undefined): TelemetryConfig {
  const s = (k: string) => (typeof c?.[k] === "string" ? (c[k] as string).trim() : "");
  const flag = s("telemetry").toLowerCase();
  return {
    enabled: !["off", "false", "0", "no", "disabled"].includes(flag),
    dbPath: (s("telemetry_db") || defaultDbPath()).replace(/^~(?=$|\/)/, homedir()),
    host: s("telemetry_host") || hostname().split(".")[0],
    sources: s("telemetry_sources"),
  };
}

export type Telemetry = { query: TelemetryQuery | null; why: string | null; stop(): void };

export function startTelemetry(cfg: TelemetryConfig, log: (...a: unknown[]) => void, live?: Live): Telemetry {
  if (!cfg.enabled) return { query: null, why: "telemetry is disabled (plugin config telemetry = off)", stop() {} };
  let query: TelemetryQuery;
  try {
    query = new TelemetryQuery(openDb(cfg.dbPath), { live });
  } catch (e) {
    log(`telemetry: cannot open ${cfg.dbPath}: ${e} — telemetry off`);
    return { query: null, why: `telemetry store unavailable: ${String(e).slice(0, 200)}`, stop() {} };
  }
  const extra = parseSources(cfg.sources);
  const roots = cfg.includeLocal === false ? extra : [localRoot(cfg.host), ...extra.filter((r) => r.host !== cfg.host)];
  let worker: Worker | null = null, stopped = false, restarts = 0;
  const spawn = () => {
    if (stopped) return;
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url).href);
      worker.addEventListener("message", (e: MessageEvent) => {
        const m = e.data;
        if (m?.type === "error") log(`telemetry: ingest pass failed: ${m.error}`);
        else if (m?.type === "pass" && (m.stats.ms > 2000 || m.stats.errors)) log(`telemetry: ingest ${JSON.stringify(m.stats)}`);
      });
      worker.addEventListener("error", (e: any) => log(`telemetry: worker error: ${e?.message ?? e}`));
      worker.addEventListener("close", () => {
        worker = null;
        if (stopped) return;
        const wait = Math.min(300_000, 5_000 * 2 ** Math.min(restarts++, 6));
        log(`telemetry: worker exited — restarting in ${wait / 1000}s`);
        setTimeout(spawn, wait);
      });
      worker.postMessage({ dbPath: cfg.dbPath, roots, intervalMs: cfg.intervalMs ?? 5000 });
    } catch (e) {
      log(`telemetry: cannot start ingest worker: ${e}`);
    }
  };
  spawn();
  log(`telemetry: ${cfg.dbPath} ← ${roots.map((r) => `${r.host}:${r.root}`).join(", ")}`);
  return { query, why: null, stop() { stopped = true; try { worker?.terminate(); } catch {} } };
}
