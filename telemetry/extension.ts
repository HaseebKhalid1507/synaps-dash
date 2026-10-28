// Telemetry inside the synaps-dash extension: open the store, hand queries to
// the HTTP layer, run ingest in a worker thread. Nothing here may throw into
// the extension — any failure leaves telemetry disabled with a reason.
//
// Profiles: only the default daemon (profile null) has telemetry on by default.
// A profile daemon (sandbox, demo…) stays off unless its plugin config says
// telemetry = on, and then it gets its own telemetry-<profile>.db and reads its
// own <base>/<profile>/sessions — it never writes into the default store.

import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { openDb } from "./schema.ts";
import { TelemetryQuery, type Live } from "./query.ts";
import { localRoot, parseSources } from "./ingest.ts";

export type TelemetryConfig = {
  enabled: boolean; dbPath: string; host: string; sources: string; profile?: string | null;
  intervalMs?: number; includeLocal?: boolean; releasesRepo?: string | null;
  // test seams
  workerUrl?: string; staleMs?: number; restartBaseMs?: number;
};

const dataDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "synaps-telemetry");

export function defaultDbPath(profile: string | null = null): string {
  return join(dataDir(), profile ? `telemetry-${profile.replace(/[^\w.-]/g, "_")}.db` : "telemetry.db");
}

/** Plugin config (strings, as the daemon delivers them) + the host daemon's profile → TelemetryConfig. */
export function telemetryConfig(c: Record<string, unknown> | undefined, profile: string | null = null): TelemetryConfig {
  const s = (k: string) => (typeof c?.[k] === "string" ? (c[k] as string).trim() : "");
  const flag = s("telemetry").toLowerCase();
  const on = ["on", "true", "1", "yes", "enabled"].includes(flag);
  const off = ["off", "false", "0", "no", "disabled"].includes(flag);
  // A profile daemon never writes the default daemon's store, even if a shared config
  // (plugins/synaps-dash/config is shared by every profile) names it.
  let dbPath = (s("telemetry_db") || defaultDbPath(profile)).replace(/^~(?=$|\/)/, homedir());
  if (profile && resolve(dbPath) === resolve(defaultDbPath(null))) dbPath = defaultDbPath(profile);
  return {
    // Unset (no manifest default, see plugin.json) → on for the default daemon only.
    enabled: profile ? on : !off,
    dbPath,
    host: s("telemetry_host") || hostname().split(".")[0],
    sources: s("telemetry_sources"),
    profile,
    releasesRepo: join(homedir(), "Projects", "agent-runtime"),
  };
}

/** This daemon's own sources (profile-aware) + telemetry_sources. A telemetry_sources entry
 *  named like telemetry_host REPLACES the own sources: that's how a sandbox/profile daemon is
 *  pointed at the main data on purpose (telemetry_host = bella, telemetry_sources = bella=$HOME). */
export function telemetryRoots(cfg: TelemetryConfig) {
  const extra = parseSources(cfg.sources);
  if (cfg.includeLocal === false || extra.some((r) => r.host === cfg.host)) return extra;
  return [localRoot(cfg.host, cfg.profile ?? null), ...extra];
}

export type Telemetry = { query: TelemetryQuery | null; why: string | null; stop(): void; stats(): { spawns: number; restarts: number; lastDelay: number } };

const off = (why: string): Telemetry => ({ query: null, why, stop() {}, stats: () => ({ spawns: 0, restarts: 0, lastDelay: 0 }) });

export function startTelemetry(cfg: TelemetryConfig, log: (...a: unknown[]) => void, live?: Live): Telemetry {
  if (!cfg.enabled) return off(cfg.profile ? `telemetry is off for profile '${cfg.profile}' (set telemetry = on to enable)` : "telemetry is disabled (plugin config telemetry = off)");
  let query: TelemetryQuery;
  try {
    query = new TelemetryQuery(openDb(cfg.dbPath), { live });
  } catch (e) {
    log(`telemetry: cannot open ${cfg.dbPath}: ${e} — telemetry off`);
    return off(`telemetry store unavailable: ${String(e).slice(0, 200)}`);
  }
  const roots = telemetryRoots(cfg);
  const staleMs = cfg.staleMs ?? 120_000, base = cfg.restartBaseMs ?? 5_000;
  let worker: Worker | null = null, stopped = false, restarts = 0, spawns = 0, lastDelay = 0, lastBeat = Date.now();
  let pending: ReturnType<typeof setTimeout> | null = null;
  const schedule = (why: string) => {
    if (stopped || pending) return;
    lastDelay = Math.min(300_000, base * 2 ** Math.min(restarts++, 6));
    log(`telemetry: worker ${why} — restarting in ${lastDelay / 1000}s`);
    pending = setTimeout(() => { pending = null; spawn(); }, lastDelay);
  };
  const spawn = () => {
    if (stopped) return;
    try {
      const w = new Worker(cfg.workerUrl ?? new URL("./worker.ts", import.meta.url).href);
      worker = w;
      spawns++;
      lastBeat = Date.now();
      w.addEventListener("message", (e: MessageEvent) => {
        const m = e.data;
        lastBeat = Date.now();
        if (m?.type === "pass") {
          restarts = 0; // healthy again: the next failure backs off from the start
          if (m.stats.ms > 2000 || m.stats.errors) log(`telemetry: ingest ${JSON.stringify(m.stats)}`);
        } else if (m?.type === "error") log(`telemetry: ingest pass failed: ${m.error}`);
      });
      w.addEventListener("error", (e: any) => log(`telemetry: worker error: ${e?.message ?? e}`));
      w.addEventListener("close", () => {
        if (worker === w) worker = null;
        schedule("exited");
      });
      w.postMessage({ dbPath: cfg.dbPath, roots, intervalMs: cfg.intervalMs ?? 5000, releasesRepo: cfg.releasesRepo ?? null });
    } catch (e) {
      log(`telemetry: cannot start ingest worker: ${e}`);
      schedule("failed to start");
    }
  };
  // Watchdog: a worker that stops beating (wedged on I/O, stuck loop) is replaced.
  const dog = setInterval(() => {
    if (stopped || !worker || Date.now() - lastBeat < staleMs) return;
    const w = worker;
    worker = null;
    try { w.terminate(); } catch {}
    schedule(`silent for ${Math.round((Date.now() - lastBeat) / 1000)}s`);
  }, Math.min(15_000, Math.max(10, staleMs / 4)));
  spawn();
  log(`telemetry: ${cfg.dbPath} ← ${roots.map((r) => `${r.host}:${r.root}`).join(", ")}`);
  return {
    query, why: null,
    stop() { stopped = true; clearInterval(dog); if (pending) clearTimeout(pending); try { worker?.terminate(); } catch {} },
    stats: () => ({ spawns, restarts, lastDelay }),
  };
}
