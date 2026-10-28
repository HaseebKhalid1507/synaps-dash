#!/usr/bin/env bun
// bun telemetry/cli.ts backfill --db <path> [--src host=root ...]
// bun telemetry/cli.ts stats    --db <path>
// bun telemetry/cli.ts query    --db <path> <endpoint path, e.g. /api/telemetry/summary?host=bella>
//
// Without --src, backfill reads this machine (host = --host, default: hostname).
// A root is a home dir (~/.cache/synaps + ~/.synaps-cli) or a snapshot dir
// {cache/, sessions/, subagent-history/, logs/}.

import { hostname } from "node:os";
import { openDb } from "./schema.ts";
import { ingestOnce, localRoot, resolveRoot, refreshReleases, type HostRoot } from "./ingest.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { TelemetryQuery } from "./query.ts";
import { handleTelemetry } from "./http.ts";

const args = process.argv.slice(2);
const cmd = args.shift();
let db: string | null = null, host = hostname().split(".")[0], releases = join(homedir(), "Projects", "agent-runtime"), profile: string | null = null;
const srcs: string[] = [], rest: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--db") db = args[++i];
  else if (a === "--src") srcs.push(args[++i]);
  else if (a === "--host") host = args[++i];
  else if (a === "--releases") releases = args[++i];
  else if (a === "--profile") profile = args[++i];
  else rest.push(a);
}
const out = (s: string) => process.stdout.write(s + "\n");
if (!cmd || !db || !["backfill", "stats", "query"].includes(cmd)) {
  process.stderr.write("usage: bun telemetry/cli.ts backfill|stats|query --db <path> [--src host=root ...] [--host name] [--profile p] [--releases repo]\n");
  process.exit(2);
}

const d = openDb(db);
if (cmd === "backfill") {
  const roots: HostRoot[] = srcs.length
    ? srcs.map((s) => { const m = /^([A-Za-z0-9_.-]+)=(.+)$/.exec(s); if (!m) { process.stderr.write(`bad --src ${s}\n`); process.exit(2); } return resolveRoot(m[1], m[2]); })
    : [localRoot(host, profile)];
  for (const r of roots) out(`source ${r.host}: cache=${r.cacheDir} sessions=${r.sessionsDir} subagents=${r.subagentsDir} logs=${r.logsDir}`);
  const t0 = performance.now();
  const st = ingestOnce(d, roots, { budgetMs: 24 * 3600_000 });
  await refreshReleases(d, releases);
  out(`backfill: ${((performance.now() - t0) / 1000).toFixed(2)}s  inserted ${JSON.stringify(st)}`);
}
if (cmd === "stats" || cmd === "backfill") {
  const q = new TelemetryQuery(d);
  const h = q.health({});
  out(JSON.stringify(h.ingest.rows));
  out(`errors=${h.ingest.errors} bad_lines=${h.ingest.bad_lines} skipped_files=${h.ingest.skipped_files}${h.ingest.last_error ? ` last_error=${h.ingest.last_error}` : ""}`);
  for (const r of d.query(`SELECT host, COUNT(*) n, MIN(day) a, MAX(day) b, ROUND(SUM(cost), 2) cost FROM requests GROUP BY host`).all() as any[])
    out(`requests ${r.host}: ${r.n} rows ${r.a} → ${r.b}  $${r.cost}`);
  for (const r of d.query(`SELECT host, grain, COUNT(*) n, ROUND(SUM(cost), 2) cost FROM sessions GROUP BY host, grain`).all() as any[])
    out(`sessions ${r.host} ${r.grain}-grain: ${r.n}  session_cost $${r.cost}`);
}
if (cmd === "query") {
  const q = new TelemetryQuery(d);
  for (const p of rest) {
    const u = new URL(p, "http://x");
    const t0 = performance.now();
    const res = handleTelemetry(new Request(u), u, q)!;
    const body = await res.text();
    out(`${res.status} ${p} ${(performance.now() - t0).toFixed(1)}ms ${body.length}B`);
    out(body.length > 4000 ? body.slice(0, 4000) + "…" : body);
  }
}
