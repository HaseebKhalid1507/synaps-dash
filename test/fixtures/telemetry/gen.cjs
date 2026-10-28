// Regenerates the telemetry fixtures (API.md v1 shapes) with a seeded PRNG, so
// they're realistic and stable: `node test/fixtures/telemetry/gen.cjs`.
// Story: data starts 2026-04-10 (session grain), request-level from 2026-06-12,
// ramping to ~5–6K requests/day; opus-4-6 hands over to opus-5-5 in late July.
const fs = require("fs");
const path = require("path");
const OUT = __dirname;
let seed = 0x5eed;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const noise = (a) => 1 + (rnd() * 2 - 1) * a;
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;
const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj) + "\n");

const DAY = 86400000;
const first = new Date(2026, 3, 10), last = new Date(2026, 9, 28);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const days = [];
for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) days.push(new Date(d));
const N = days.length;
const REQ_FROM = "2026-06-12";
const isReq = (d) => ymd(d) >= REQ_FROM;
const sstep = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// requests/day: ramp to ~5.5K with weekend dips
const req = days.map((d, i) => {
  const t = i / (N - 1);
  const base = 350 + 5250 * Math.pow(t, 1.6);
  const wk = [0.62, 1, 1.04, 1.02, 1.05, 0.98, 0.7][(d.getDay() + 6) % 7];
  return Math.round(base * wk * noise(0.09));
});
req[N - 1] = Math.round(req[N - 1] * 0.38); // today: partial
// spend share: opus-4-6 → opus-5-5 handover, sonnet/fable small
const mix = days.map((d, i) => {
  const s = ymd(d);
  const o55 = s < "2026-07-20" ? 0 : 0.86 * sstep(i, 101, 125);
  const fable = s >= "2026-09-01" ? 0.025 * noise(0.4) : 0;
  const sonnet = s >= "2026-05-20" ? 0.055 * noise(0.35) : 0;
  const o46 = Math.max(0, 1 - o55 - fable - sonnet);
  return { "claude-opus-5-5": o55, "claude-opus-4-6": o46, "claude-sonnet-5-5": sonnet, "fable-5-1": fable };
});
const rawSpend = req.map((r, i) => r * (0.055 + 0.03 * sstep(i, 0, N)) * noise(0.12));
const scale = 53679 / rawSpend.reduce((a, b) => a + b, 0);
const spend = rawSpend.map((x) => x * scale);

const MODELS = ["claude-opus-5-5", "claude-opus-4-6", "claude-sonnet-5-5", "fable-5-1"];
const grain = [["2026-04-10", "session"], [REQ_FROM, "request"]];
const series = (keys, share) => keys.map((k) => ({ key: k, points: days.map((d, i) => [ymd(d), r2(spend[i] * share(i, k))]) }));
write("spend-model.json", { bucket: "day", group: "model", series: series(MODELS, (i, k) => mix[i][k]), grain });
const wShare = (i) => 0.12 + 0.24 * sstep(i, 40, N);
write("spend-role.json", { bucket: "day", group: "role", series: series(["main", "worker"], (i, k) => (k === "worker" ? wShare(i) : 1 - wShare(i))), grain });
const jShare = (i) => (i < 60 ? 0.04 : 0.17 + 0.05 * Math.sin(i / 9));
write("spend-host.json", { bucket: "day", group: "host", series: series(["bella", "jade"], (i, k) => (k === "jade" ? jShare(i) : 1 - jShare(i))), grain });

const totalReq = req.reduce((a, b) => a + b, 0);
const now = new Date(2026, 9, 28, 2, 14, 8).getTime();
write("summary.json", {
  generated_at: now,
  now: { spend_today: r2(spend[N - 1]), burn_rate_per_hour: 38.6, requests_today: req[N - 1], hit_pct_1h: 98.4, ttft_p50_ms_1h: 480, total_p50_ms_1h: 3800, live_sessions: 4, live_workers: 2 },
  all: { spend: 53679.0, requests: totalReq, sessions: 1138, first_ts: first.getTime() + 9 * 3600000, last_ts: now,
    tokens: { input: 1842113400, output: 412880210, cache_read: 31877455120, cache_write: 1210448770 }, saved_by_cache: 412318.4, saved_by_cache_net: 396104.9 },
});

// agents
const AG = [["spike", 212, 0.18], ["jet", 168, 0.12], ["faye", 141, 0.095], ["reviewer", 133, 0.08], ["ed", 97, 0.06], ["redactor-fix", 74, 0.045],
  ["scout", 66, 0.036], ["vicious", 41, 0.028], ["ein", 38, 0.02], ["julia", 22, 0.014], ["annie", 15, 0.008], ["gren", 9, 0.004]];
const workerSpend = spend.reduce((a, s, i) => a + s * wShare(i), 0);
write("agents.json", { agents: AG.map(([name, runs, sh]) => ({ name, runs, requests: Math.round(totalReq * wShare(N - 1) * sh * 1.7), spend: r1(workerSpend * sh * 1.6),
  models: sh > 0.05 ? ["claude-opus-5-5", "claude-opus-4-6"] : sh > 0.02 ? ["claude-opus-5-5"] : ["claude-sonnet-5-5"] })) });

// cache — request-level days only
const reqDays = days.map((d, i) => [d, i]).filter(([d]) => isReq(d));
// before the cutover the store reads synaps.log "Token Usage:" lines: un-split writes
const legacyDaily = days.map((d, i) => [d, i]).filter(([d]) => !isReq(d)).map(([d, i]) => {
  const hit = 86 + 6 * sstep(i, 0, 60) + (rnd() - 0.5) * 3, total = req[i] * 45000 * noise(0.08), read = Math.round(total * hit / 100), wr = total - read;
  const w = Math.round(wr * 0.8);
  return { day: ymd(d), grain: "legacy", hit_pct: r1(hit), read, write_5m: null, write_1h: null, write_unknown: w, write: w, fresh_input: Math.round(wr * 0.2) };
});
const releases = [["v0.8.0", "2026-06-20"], ["v0.9.0", "2026-08-14"], ["v0.10.0", "2026-09-18"], ["v0.11.0", "2026-10-16"]]
  .map(([tag, s]) => { const [y, m, dd] = s.split("-").map(Number); return { tag, ts: new Date(y, m - 1, dd, 15, 30).getTime() }; });
const cacheDaily = reqDays.map(([d, i]) => {
  const s = ymd(d);
  const hit = s < "2026-08-14" ? 93.2 + 3 * sstep(i, 63, 120) + (rnd() - 0.5) * 1.6 : 96.7 + rnd() * 2.0;
  const ctx = 60000 + 70000 * sstep(i, 60, N);
  const total = req[i] * ctx * noise(0.05);
  const read = Math.round(total * hit / 100);
  const wr = total - read;
  const oneH = s < "2026-08-14" ? 0.08 : 0.78;
  // the cutover day mixes legacy lines and api-log rows; early api-log rows have no TTL split
  const mixed = s === REQ_FROM, unknown = s < "2026-07-01" ? Math.round(wr * 0.82 * (mixed ? 0.6 : 0.25)) : null;
  const w5 = Math.round((wr * 0.82 - (unknown || 0)) * (1 - oneH)), w1 = Math.round((wr * 0.82 - (unknown || 0)) * oneH);
  return { day: s, grain: mixed ? "mixed" : "request", hit_pct: r1(hit), read, write_5m: w5, write_1h: w1, write_unknown: unknown, write: w5 + w1 + (unknown || 0), fresh_input: Math.round(wr * 0.18) };
});
write("cache.json", {
  daily: [...legacyDaily, ...cacheDaily],
  miss_reasons: [{ reason: "messages_changed", count: 238 }, { reason: "tools_changed", count: 23 }, { reason: "previous_message_not_found", count: 22 }, { reason: "model_changed", count: 3 }],
  keepwarm: { pings: 185, cost: 1.2, est_saved: 9.8 },
  releases,
});

// latency
const latDaily = reqDays.map(([d, i]) => {
  const s = ymd(d);
  const tt = s < "2026-07-02" ? null : Math.round(480 * noise(0.12));
  const p50 = Math.round(3800 * noise(0.1)), p95 = Math.round(21600 * noise(0.14));
  return { day: s, ttft_p50: tt, ttft_p95: tt && Math.round(1900 * noise(0.15)), ttft_p99: tt && Math.round(4200 * noise(0.2)), total_p50: p50, total_p95: p95, n: req[i] };
});
const byCtx = [];
for (let k = 0; k < 2000; k++) {
  const c = Math.round(8000 + Math.pow(rnd(), 0.8) * 190000);
  const base = 1200 + c * 0.018;
  const ms = Math.round(base * Math.exp((rnd() + rnd() + rnd() - 1.5) * 0.9) + (rnd() < 0.06 ? rnd() * 30000 : 0));
  byCtx.push([c, ms]);
}
write("latency.json", { daily: latDaily, split: { headers_p50: 310, first_event_p50: 480, stream_p50: 3290 }, retries: { requests_with_retry: 2146, rate_pct: 0.71 }, by_context: byCtx });

// heatmap — weekdays busy 10–18 + a late-night shift, weekends lighter
const cells = [];
for (let wd = 0; wd < 7; wd++) for (let hr = 0; hr < 24; hr++) {
  const day = Math.exp(-((hr - 14) ** 2) / 18), night = Math.exp(-(((hr + 24 - 23) % 24) ** 2) / 4) * 0.8, dawn = hr >= 4 && hr <= 8 ? 0.04 : 0.15;
  const wk = wd >= 5 ? 0.45 : 1;
  cells.push([wd, hr, Math.round(totalReq / 168 * 2.4 * (day + night + dawn) * wk * noise(0.15))]);
}
write("heatmap.json", { cells });

// health
write("health.json", {
  stops: [{ stop: "tool_use", count: 38651 }, { stop: "end_turn", count: 5915 }, { stop: "max_tokens", count: 184 }, { stop: "refusal", count: 92 }, { stop: null, count: 74 }],
  refusal_retries: 67, translation_losses: 0, tools_changed_misses: 23,
  ingest: { last_run: now - 94000, last_run_ms: 1840, rows: { requests: totalReq, traces: 61204, sessions: 1138, workers: 2871, legacy: 412 }, errors: 0, bad_lines: 3, lost_bytes: 0, last_error: null, skipped_files: 158,
    sources: [{ host: "bella", kind: "api", path: "/home/haseeb/.synaps-cli/cache/api-log.jsonl", offset: 412883912, size: 412883912 },
      { host: "bella", kind: "trace", path: "/home/haseeb/.synaps-cli/cache/request-trace.jsonl", offset: 96112004, size: 96112004 },
      { host: "bella", kind: "log", path: "/home/haseeb/.synaps-cli/logs/synaps.log.*", offset: 18220110, size: 18220110, files: 61 },
      { host: "jade", kind: "api", path: "/home/haseeb/Jawz/workspace/synaps-telemetry/raw/jade/cache/api-log.jsonl", offset: 88120456, size: 88120456 }] },
});

// sessions — 1138 rows, newest last-updated first
const TITLES = ["telemetry store: api-log ingest", "synaps·dash rail drawer curves", "fix redactor double-escape", "myx MXC fade sync", "review: compaction model swap",
  "agent-runtime release v0.11.0", "jade backup rotation", "playwright flake hunt", "context meter thresholds", "subagent tray polish", "prompt cache TTL experiment",
  "vault confluence index", "bella nvme migration", "refactor tool views", "steer delivery semantics", "write the pricing table", "daemon reload token rotation",
  "axel memory backend", "fable model eval", "keep-warm ping cost study", "SEO audit for the blog", "trip planning: Lisbon", "kitchen inventory script"];
const rows = [];
const hosts = (i) => (rnd() < 0.18 ? "jade" : "bella");
for (let k = 0; k < 1138; k++) {
  const t = k / 1137;
  const created = first.getTime() + 9 * 3600000 + Math.round(t * (now - first.getTime() - 12 * 3600000)) + Math.round(rnd() * 3600000);
  const dur = Math.round(Math.pow(rnd(), 2) * 9 * 3600000) + 120000;
  const updated = Math.min(now - 60000, created + dur);
  const reqs = Math.max(1, Math.round(Math.pow(rnd(), 2.2) * 1400 * (0.3 + t)));
  const dIdx = Math.min(N - 1, Math.floor((created - first.getTime()) / DAY));
  const model = Object.entries(mix[dIdx]).sort((a, b) => b[1] - a[1])[rnd() < 0.85 ? 0 : 2][0];
  const lvl = isReq(days[dIdx]);
  const chain = rnd() < 0.15 ? "↳ ".repeat(1 + Math.floor(rnd() * 3)) : "";
  const title = TITLES[Math.floor(rnd() * TITLES.length)];
  rows.push({
    grain: lvl ? "request" : "session", title_raw: chain + title,
    id: `${ymd(new Date(created)).replace(/-/g, "")}-${String(new Date(created).getHours()).padStart(2, "0")}${String(new Date(created).getMinutes()).padStart(2, "0")}${String(new Date(created).getSeconds()).padStart(2, "0")}-${Math.floor(rnd() * 65536).toString(16).padStart(4, "0")}`,
    host: hosts(), title, model, created, updated, requests: reqs,
    spend: r2(reqs * (0.06 + rnd() * 0.06)), hit_pct: lvl ? r1(95 + rnd() * 3.9) : null,
    peak_context_tokens: lvl ? Math.round((40 + rnd() * 150) * 1000) : null, workers: Math.floor(Math.pow(rnd(), 2) * 7),
  });
}
const sumSpend = rows.reduce((a, r) => a + r.spend, 0);
for (const r of rows) r.spend = r2(r.spend * 53679 / sumSpend);
for (const r of rows) if (rnd() < 0.02) r.spend = null; // session files without session_cost
for (const r of rows) if (rnd() < 0.01) r.host = "unknown"; // origin host undecidable (store v2)
rows.sort((a, b) => b.updated - a.updated);
// a showcase session: recent, rich, with a timeline
const star = rows[3];
Object.assign(star, { title: "telemetry store: api-log ingest + pricing", title_raw: "↳ telemetry store: api-log ingest + pricing", grain: "request", model: "claude-opus-5-5", host: "bella", requests: 412, spend: 18.4, hit_pct: 97.1, peak_context_tokens: 182400, workers: 3 });
write("sessions.json", { total: rows.length, rows });

const tl = [];
let ctx = 18000, ts = star.created;
for (let k = 0; k < 412; k++) {
  ts += Math.round(4000 + rnd() * 40000);
  const worker = rnd() < 0.22;
  let compaction = false;
  if (!worker) {
    ctx += Math.round(400 + rnd() * 1600);
    if (ctx > 178000 && k > 20) { ctx = Math.round(ctx * (0.22 + rnd() * 0.1)); compaction = true; }
  }
  const c = worker ? Math.round(20000 + rnd() * 50000) : ctx;
  const stopR = rnd();
  tl.push({ ts, context_tokens: c, output: Math.round(80 + Math.pow(rnd(), 2) * 6000), hit_pct: compaction ? r1(6 + rnd() * 10) : r1(Math.min(99.9, 94 + rnd() * 5.8)),
    total_ms: Math.round(1500 + c * 0.02 * Math.exp((rnd() - 0.5) * 1.2)), ttft_ms: Math.round(380 + rnd() * 500),
    stop: k === 411 ? "end_turn" : stopR < 0.86 ? "tool_use" : stopR < 0.97 ? "end_turn" : stopR < 0.99 ? "max_tokens" : null, worker, compaction });
}
star.updated = ts;
write("session-star.json", { session: star, timeline: tl,
  workers: [{ handle: "sa_1", agent: "redactor-fix", model: "claude-opus-5-5", spend: 2.1 }, { handle: "sa_2", agent: "reviewer", model: "claude-opus-5-5", spend: 1.38 },
    { handle: "sa_3", agent: "scout", model: "claude-sonnet-5-5", spend: 0.21 }] });
write("sessions.json", { total: rows.length, rows });
console.log(`days ${N}, requests ${totalReq}, star ${star.id}`);
