// The REAL .synaps-plugin/plugin.json, resolved the way Synaps hands config to an extension at
// initialize. Mirror of agent-engine/src/extensions/manager.rs resolve_config_with_env (dev
// 4ba4e6b1): per declared key, first hit wins —
//   1. env SYNAPS_EXTENSION_<ID>_<KEY>      2. plugin config <base>/plugins/<id>/config (shared by all profiles)
//   3. legacy key extension.<id>.<key> in the (profile-resolved) Synaps config
//   4. the manifest `default`, inserted as if configured      5. otherwise the key is absent
// Step 4 is the trap: a manifest default of telemetry = "on" looked explicit to a profile daemon.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { telemetryConfig, telemetryRoots, defaultDbPath } from "../../telemetry/extension.ts";
import { relaxTimeouts } from "./helpers.ts";

relaxTimeouts();

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../.synaps-plugin/plugin.json"), "utf8"));
const ID = "synaps-dash";
const envVar = (key: string) => `SYNAPS_EXTENSION_${ID.replace(/-/g, "_").toUpperCase()}_${key.replace(/-/g, "_").toUpperCase()}`;

function resolveLikeSynaps(src: { env?: Record<string, string>; plugin?: Record<string, string>; legacy?: Record<string, string> } = {}) {
  const out: Record<string, unknown> = {};
  for (const e of manifest.extension.config as { key: string; default?: unknown }[]) {
    const v = src.env?.[envVar(e.key)] ?? src.plugin?.[e.key] ?? src.legacy?.[`extension.${ID}.${e.key}`];
    if (v !== undefined) out[e.key] = v;
    else if (e.default !== undefined) out[e.key] = e.default;
  }
  return out;
}

test("no telemetry_* key carries a manifest default (unset must stay distinguishable)", () => {
  const keys = (manifest.extension.config as any[]).filter((e) => e.key.startsWith("telemetry"));
  expect(keys.map((e) => e.key).sort()).toEqual(["telemetry", "telemetry_db", "telemetry_host", "telemetry_sources"]);
  for (const e of keys) expect("default" in e).toBe(false);
  expect(resolveLikeSynaps()).toEqual({ port: "7717" }); // what an unconfigured daemon receives
});

test("real manifest defaults: default daemon on, profile daemon OFF", () => {
  const cfg = resolveLikeSynaps();
  expect(telemetryConfig(cfg, null).enabled).toBe(true);
  for (const profile of ["webproto", "demo", "axon"]) expect(telemetryConfig(cfg, profile).enabled).toBe(false);
});

test("opting a profile in: its own config's extension.synaps-dash.telemetry = on (or the env override)", () => {
  const viaLegacy = telemetryConfig(resolveLikeSynaps({ legacy: { "extension.synaps-dash.telemetry": "on" } }), "webproto");
  expect(viaLegacy.enabled).toBe(true);
  expect(viaLegacy.dbPath).toBe(defaultDbPath("webproto"));
  expect(telemetryConfig(resolveLikeSynaps({ env: { [envVar("telemetry")]: "on" } }), "webproto").enabled).toBe(true);
  // the shared plugin config can switch everything off, and "off" beats nothing for the default daemon
  expect(telemetryConfig(resolveLikeSynaps({ plugin: { telemetry: "off" } }), null).enabled).toBe(false);
});

test("a profile daemon never writes the default daemon's DB, even when a shared config names it", () => {
  const cfg = telemetryConfig(resolveLikeSynaps({ legacy: { "extension.synaps-dash.telemetry": "on" }, plugin: { telemetry_db: defaultDbPath(null) } }), "webproto");
  expect(cfg.dbPath).toBe(defaultDbPath("webproto"));
  expect(telemetryConfig({ telemetry_db: "/tmp/x/elsewhere.db", telemetry: "on" }, "webproto").dbPath).toBe("/tmp/x/elsewhere.db");
});

test("roots: own (profile) sources by default; a telemetry_sources entry named like telemetry_host replaces them", () => {
  const own = telemetryRoots(telemetryConfig({ telemetry: "on", telemetry_host: "sbx", telemetry_sources: "jade=/snap/jade" }, "webproto"));
  expect(own.map((r) => r.host)).toEqual(["sbx", "jade"]);
  expect(own[0].sessionsDir).toEndWith("/webproto/sessions");
  const main = telemetryRoots(telemetryConfig({ telemetry: "on", telemetry_host: "bella", telemetry_sources: "bella=/home/someone,jade=/snap/jade" }, "webproto"));
  expect(main.map((r) => [r.host, r.root])).toEqual([["bella", "/home/someone"], ["jade", "/snap/jade"]]);
});
