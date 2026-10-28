// Query layer: one function per /api/telemetry endpoint (shapes: docs/telemetry-api.md).
// Rule from the contract: a metric with no data is null, never 0 (sums in
// dense series are the one exception — 0 is a real sum there).

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { dayOf, daysBetween } from "./tz.ts";
import { modelPrices, cacheReadMultiplier } from "./pricing.ts";
import { metaGet } from "./schema.ts";

export type Filter = { from?: number | null; to?: number | null; host?: string | null };
export type Live = () => { sessions: number | null; workers: number | null } | null;

const r1 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r4 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const pct = (num: number, den: number) => (den > 0 ? r1((num / den) * 100) : null);

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}
const sortNum = (a: number[]) => a.sort((x, y) => x - y);

/** WHERE fragment + params for a table with a ts column and host column. */
function where(f: Filter, tsCol: string, alias = "", extra: string[] = []): { sql: string; args: any[] } {
  const p = alias ? alias + "." : "";
  const c: string[] = [...extra], args: any[] = [];
  if (f.from != null) { c.push(`${p}${tsCol} >= ?`); args.push(f.from); }
  if (f.to != null) { c.push(`${p}${tsCol} <= ?`); args.push(f.to); }
  if (f.host) { c.push(`${p}host = ?`); args.push(f.host); }
  return { sql: c.length ? "WHERE " + c.join(" AND ") : "", args };
}

// Effective TTFT: the trace's first model event, else api-log ttft_ms (0 already nulled at ingest).
const TTFT = "COALESCE(t.first_event_ms, r.ttft_ms)";
const JOIN_T = "LEFT JOIN traces t ON t.provider_request_id = r.request_id";

let releasesCache: { at: number; repo: string; v: { tag: string; ts: number }[] } | null = null;

export class TelemetryQuery {
  constructor(public db: Database, public opts: { live?: Live; releasesRepo?: string } = {}) {}

  private get<T = any>(sql: string, ...args: any[]): T { return this.db.query(sql).get(...args) as T; }
  private all<T = any>(sql: string, ...args: any[]): T[] { return this.db.query(sql).all(...args) as T[]; }

  /** First request-level timestamp for this host scope: before it, spend comes from session files. */
  cutover(f: Filter): number | null {
    const w = where({ host: f.host }, "ts");
    return this.get<{ m: number | null }>(`SELECT MIN(ts) m FROM requests ${w.sql}`, ...w.args).m;
  }

  /** Sessions accounted at session grain: created before the cutover (and in range). */
  private preSessions(f: Filter, cut: number | null) {
    const w = where(f, "created", "", cut === null ? [] : ["created < ?"]);
    const args = cut === null ? w.args : [cut, ...w.args];
    return { sql: w.sql, args };
  }

  summary(f: Filter) {
    const now = Date.now();
    const today = dayOf(now);
    const h = f.host ? " AND host = ?" : "";
    const ha = f.host ? [f.host] : [];
    const td = this.get(`SELECT COUNT(*) n, SUM(cost) c FROM requests WHERE day = ?${h}`, today, ...ha);
    const hr = this.get(`SELECT COUNT(*) n, SUM(cost) c, SUM(cache_read) cr, SUM(input + cache_read + cache_write) den FROM requests WHERE ts >= ?${h}`, now - 3_600_000, ...ha);
    const lat = this.all<{ ttft: number | null; total: number | null }>(`SELECT ${TTFT} ttft, r.total_ms total FROM requests r ${JOIN_T} WHERE r.ts >= ?${f.host ? " AND r.host = ?" : ""}`, now - 3_600_000, ...ha);
    const live = this.opts.live?.() ?? null;

    const cut = this.cutover(f);
    const rw = where(f, "ts");
    const ra = this.get(`SELECT COUNT(*) n, SUM(cost) c, MIN(ts) a, MAX(ts) b, SUM(input) i, SUM(output) o, SUM(cache_read) cr, SUM(cache_write) cw, SUM(saved) sv FROM requests ${rw.sql}`, ...rw.args);
    const ps = this.preSessions(f, cut);
    const sa = this.get(`SELECT COUNT(*) n, SUM(cost) c, MIN(created) a, MAX(updated) b, SUM(input) i, SUM(output) o, SUM(cache_read) cr, SUM(cache_write) cw, SUM(saved) sv FROM sessions ${ps.sql}`, ...ps.args);
    const sw = this.sessionWhere(f);
    const sessions = this.get(`SELECT COUNT(*) n FROM sessions s ${sw.sql}`, ...sw.args).n as number;
    const has = ra.n > 0 || sa.n > 0;
    const add = (a: number | null, b: number | null) => (has ? (a ?? 0) + (b ?? 0) : null);
    const lastTs = [ra.b, sa.b].filter((x) => x != null) as number[];
    const firstTs = [ra.a, sa.a].filter((x) => x != null) as number[];
    return {
      generated_at: now,
      now: {
        spend_today: td.n ? r4(td.c) : null,
        burn_rate_per_hour: hr.n ? r4(hr.c) : null,
        requests_today: td.n || null,
        hit_pct_1h: hr.n ? pct(hr.cr, hr.den) : null,
        ttft_p50_ms_1h: quantile(sortNum(lat.map((x) => x.ttft).filter((x): x is number => x != null)), 0.5),
        total_p50_ms_1h: quantile(sortNum(lat.map((x) => x.total).filter((x): x is number => x != null)), 0.5),
        live_sessions: live?.sessions ?? null,
        live_workers: live?.workers ?? null,
      },
      all: {
        spend: r4(add(ra.c, sa.c)),
        requests: ra.n || null,
        sessions: sessions || null,
        first_ts: firstTs.length ? Math.min(...firstTs) : null,
        last_ts: lastTs.length ? Math.max(...lastTs) : null,
        tokens: { input: add(ra.i, sa.i), output: add(ra.o, sa.o), cache_read: add(ra.cr, sa.cr), cache_write: add(ra.cw, sa.cw) },
        saved_by_cache: r4(add(ra.sv, sa.sv)),
      },
    };
  }

  spend(f: Filter, group: string) {
    const col = group === "role" ? "CASE WHEN worker = 1 THEN 'worker' ELSE 'main' END" : group === "host" ? "host" : "model";
    const scol = group === "role" ? "'main'" : group === "host" ? "host" : "model";
    const cut = this.cutover(f);
    const rw = where(f, "ts");
    const rows = this.all<{ k: string; d: string; c: number }>(`SELECT ${col} k, day d, SUM(cost) c FROM requests ${rw.sql} GROUP BY k, d`, ...rw.args);
    const ps = this.preSessions(f, cut);
    const srows = this.all<{ k: string; d: string; c: number }>(`SELECT ${scol} k, created_day d, SUM(cost) c FROM sessions ${ps.sql} GROUP BY k, d`, ...ps.args);
    const all = [...srows, ...rows];
    const grain: [string, string][] = [];
    const firstS = srows.reduce<string | null>((m, x) => (m === null || x.d < m ? x.d : m), null);
    const firstR = rows.reduce<string | null>((m, x) => (m === null || x.d < m ? x.d : m), null);
    if (firstS) grain.push([firstS, "session"]);
    if (firstR) grain.push([firstR, "request"]);
    if (!all.length) return { bucket: "day", group, series: [], grain };
    let a = all[0].d, b = all[0].d;
    for (const x of all) { if (x.d < a) a = x.d; if (x.d > b) b = x.d; }
    if (f.from != null) a = dayOf(f.from) < a ? dayOf(f.from) : a;
    if (f.to != null) { const t = dayOf(Math.min(f.to, Date.now())); if (t > b) b = t; }
    const days = daysBetween(a, b);
    const idx = new Map(days.map((d, i) => [d, i]));
    const series = new Map<string, number[]>();
    for (const x of all) {
      let s = series.get(x.k);
      if (!s) series.set(x.k, (s = new Array(days.length).fill(0)));
      const i = idx.get(x.d);
      if (i !== undefined) s[i] += x.c;
    }
    const out = [...series.entries()]
      .map(([key, v]) => ({ key, total: v.reduce((p, q) => p + q, 0), points: v.map((c, i) => [days[i], r4(c)] as [string, number]) }))
      .sort((p, q) => q.total - p.total)
      .map(({ key, points }) => ({ key, points }));
    return { bucket: "day", group, series: out, grain };
  }

  agents(f: Filter) {
    const ww = where({ host: f.host, from: f.from, to: f.to }, "mtime");
    const ws = this.all<{ agent: string; runs: number; models: string }>(
      `SELECT COALESCE(agent, 'unknown') agent, COUNT(*) runs, GROUP_CONCAT(DISTINCT model) models FROM workers ${ww.sql} GROUP BY 1`, ...ww.args);
    const rw = where(f, "ts", "", ["agent IS NOT NULL"]);
    const rs = this.all<{ agent: string; n: number; c: number; models: string; runs: number }>(
      `SELECT agent, COUNT(*) n, SUM(cost) c, GROUP_CONCAT(DISTINCT model) models, COUNT(DISTINCT COALESCE(handle, '') || ':' || COALESCE(sid, '')) runs FROM requests ${rw.sql} GROUP BY agent`, ...rw.args);
    const m = new Map<string, { name: string; runs: number; requests: number | null; spend: number | null; models: Set<string> }>();
    for (const w of ws) m.set(w.agent, { name: w.agent, runs: w.runs, requests: null, spend: null, models: new Set((w.models ?? "").split(",").filter(Boolean)) });
    for (const r of rs) {
      let e = m.get(r.agent);
      if (!e) m.set(r.agent, (e = { name: r.agent, runs: r.runs, requests: null, spend: null, models: new Set() }));
      e.requests = r.n;
      e.spend = r4(r.c);
      for (const x of (r.models ?? "").split(",")) if (x) e.models.add(x);
    }
    return { agents: [...m.values()].sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || b.runs - a.runs).map((e) => ({ ...e, models: [...e.models].sort() })) };
  }

  cache(f: Filter) {
    const rw = where(f, "ts");
    const daily: any[] = this.all(`SELECT day, SUM(cache_read) read, SUM(cw5m) w5, SUM(cw1h) w1, SUM(input) fresh, SUM(input + cache_read + cache_write) den FROM requests ${rw.sql} GROUP BY day ORDER BY day`, ...rw.args)
      .map((x: any) => ({ day: x.day, hit_pct: pct(x.read, x.den), read: x.read, write_5m: x.w5, write_1h: x.w1, fresh_input: x.fresh, grain: "request" }));
    // Before request-level data exists: the legacy "Token Usage:" log lines (no TTL split).
    const cut = this.cutover(f);
    const cutDay = cut === null ? null : dayOf(cut);
    const lw = where(f, "ts", "", cutDay === null ? [] : ["day < ?"]);
    const legacy = this.all(`SELECT day, SUM(cache_read) read, SUM(cache_create) w, SUM(input) fresh, SUM(input + cache_read + cache_create) den FROM legacy_usage ${lw.sql} GROUP BY day ORDER BY day`, ...(cutDay === null ? lw.args : [cutDay, ...lw.args]))
      .map((x: any) => ({ day: x.day, hit_pct: pct(x.read, x.den), read: x.read, write_5m: null, write_1h: null, write: x.w, fresh_input: x.fresh, grain: "legacy" }));
    const mw = where(f, "ts", "", ["miss_reason IS NOT NULL"]);
    const miss = this.all(`SELECT miss_reason reason, COUNT(*) count FROM requests ${mw.sql} GROUP BY 1 ORDER BY 2 DESC`, ...mw.args);
    const kw = where(f, "ts", "", ["keepwarm = 1"]);
    const pings = this.all<{ model: string; cr: number; cost: number }>(`SELECT model, cache_read cr, cost FROM requests ${kw.sql}`, ...kw.args);
    // A ping keeps a prefix warm; without it the next turn would rewrite that prefix at the 5m write
    // rate (1.25×) instead of reading it. Gross estimate: Σ cache_read × input × (1.25 − read multiplier).
    let kcost = 0, ksaved = 0;
    for (const p of pings) {
      kcost += p.cost;
      ksaved += (p.cr / 1e6) * modelPrices(p.model, p.cr)[0] * (1.25 - cacheReadMultiplier(p.model));
    }
    return {
      daily: [...legacy, ...daily],
      miss_reasons: miss,
      keepwarm: { pings: pings.length, cost: pings.length ? r4(kcost) : null, est_saved: pings.length ? r4(ksaved) : null },
      releases: this.releases(),
    };
  }

  releases(): { tag: string; ts: number }[] {
    const repo = this.opts.releasesRepo ?? join(homedir(), "Projects", "agent-runtime");
    if (releasesCache && releasesCache.repo === repo && Date.now() - releasesCache.at < 10 * 60_000) return releasesCache.v;
    let v: { tag: string; ts: number }[] = [];
    try {
      if (existsSync(join(repo, ".git"))) {
        const p = spawnSync("git", ["-C", repo, "for-each-ref", "refs/tags", "--format=%(refname:short) %(creatordate:unix)"], { encoding: "utf8", timeout: 2000 });
        if (p.status === 0) v = p.stdout.split("\n").map((l) => l.trim().split(" ")).filter((x) => x.length === 2 && /^\d+$/.test(x[1])).map(([tag, t]) => ({ tag, ts: Number(t) * 1000 })).sort((a, b) => a.ts - b.ts);
      }
    } catch {}
    releasesCache = { at: Date.now(), repo, v };
    return v;
  }

  latency(f: Filter, model?: string | null) {
    const extra = model ? ["r.model = ?"] : [];
    const rw = where(f, "ts", "r", extra);
    const args = model ? [model, ...rw.args] : rw.args;
    const rows = this.all<{ day: string; ttft: number | null; total: number | null; retried: number }>(
      `SELECT r.day day, ${TTFT} ttft, r.total_ms total, (r.attempt > 1 OR COALESCE(t.retries, 0) > 0) retried FROM requests r ${JOIN_T} ${rw.sql} ORDER BY r.day`, ...args);
    const daily: any[] = [];
    let retried = 0;
    for (let i = 0; i < rows.length;) {
      const d = rows[i].day, tt: number[] = [], to: number[] = [];
      let n = 0;
      for (; i < rows.length && rows[i].day === d; i++) {
        const x = rows[i];
        n++;
        if (x.retried) retried++;
        if (x.ttft != null) tt.push(x.ttft);
        if (x.total != null) to.push(x.total);
      }
      sortNum(tt); sortNum(to);
      daily.push({ day: d, ttft_p50: quantile(tt, 0.5), ttft_p95: quantile(tt, 0.95), ttft_p99: quantile(tt, 0.99), total_p50: quantile(to, 0.5), total_p95: quantile(to, 0.95), n });
    }
    const tw = where(f, "ts", "t", model ? ["t.model = ?"] : []);
    const tr = this.all<{ h: number | null; e: number | null; s: number | null }>(`SELECT t.headers_ms h, t.first_event_ms e, t.stream_end_ms - t.first_event_ms s FROM traces t ${tw.sql}`, ...(model ? [model, ...tw.args] : tw.args));
    const col = (k: "h" | "e" | "s") => quantile(sortNum(tr.map((x) => x[k]).filter((x): x is number => x != null)), 0.5);
    // Scatter: prompt tokens (input + cache read + cache write) vs total_ms, evenly strided ≤ 2000 points.
    const sw = where(f, "ts", "r", [...extra, "r.total_ms IS NOT NULL"]);
    const pts = this.all<{ p: number; t: number }>(`SELECT r.input + r.cache_read + r.cache_write p, r.total_ms t FROM requests r ${sw.sql} ORDER BY r.ts`, ...args);
    const step = Math.max(1, pts.length / 2000);
    const by_context: [number, number][] = [];
    for (let k = 0; k < pts.length && by_context.length < 2000; k += step) { const x = pts[Math.floor(k)]; by_context.push([x.p, x.t]); }
    return {
      daily,
      split: { headers_p50: col("h"), first_event_p50: col("e"), stream_p50: col("s") },
      retries: { requests_with_retry: rows.length ? retried : null, rate_pct: rows.length ? pct(retried, rows.length) : null },
      by_context,
    };
  }

  /** Sessions overlapping [from, to]. */
  private sessionWhere(f: Filter, extra: string[] = [], extraArgs: any[] = []) {
    const c: string[] = [...extra], args: any[] = [...extraArgs];
    if (f.from != null) { c.push("s.updated >= ?"); args.push(f.from); }
    if (f.to != null) { c.push("s.created <= ?"); args.push(f.to); }
    if (f.host) { c.push("s.host = ?"); args.push(f.host); }
    return { sql: c.length ? "WHERE " + c.join(" AND ") : "", args };
  }

  private static SESSION_COLS = `s.id, s.host, s.title, s.model, s.created, s.updated, s.cost, s.input, s.cache_read, s.cache_write,
    (SELECT COUNT(*) FROM requests r WHERE r.sid = s.id) nreq,
    (SELECT MAX(r.input + r.cache_read + r.cache_write) FROM requests r WHERE r.sid = s.id) peak,
    (SELECT COUNT(*) FROM worker_links l WHERE l.session_id = s.id) nworkers`;

  private sessionRow(x: any) {
    return {
      id: x.id, host: x.host, title: x.title, model: x.model, created: x.created, updated: x.updated,
      requests: x.nreq || null, spend: r4(x.cost), hit_pct: x.cache_read === null ? null : pct(x.cache_read, x.input + x.cache_read + (x.cache_write ?? 0)),
      peak_context_tokens: x.peak ?? null, workers: x.nworkers,
    };
  }

  sessions(f: Filter, sort: string, limit: number, offset: number, q: string | null) {
    const extra: string[] = [], ea: any[] = [];
    if (q) { extra.push("(s.title LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\')"); const p = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%"; ea.push(p, p); }
    const w = this.sessionWhere(f, extra, ea);
    const total = this.get(`SELECT COUNT(*) n FROM sessions s ${w.sql}`, ...w.args).n as number;
    const order = sort === "updated" ? "s.updated DESC" : sort === "requests" ? "nreq DESC, s.updated DESC" : "s.cost DESC";
    const rows = this.all(`SELECT ${TelemetryQuery.SESSION_COLS} FROM sessions s ${w.sql} ORDER BY ${order}, s.id LIMIT ? OFFSET ?`, ...w.args, limit, offset);
    return { total, rows: rows.map((x) => this.sessionRow(x)) };
  }

  session(id: string) {
    const x = this.get(`SELECT ${TelemetryQuery.SESSION_COLS} FROM sessions s WHERE s.id = ?`, id);
    if (!x) return null;
    const reqs = this.all<any>(`SELECT r.ts, r.input + r.cache_read + r.cache_write ctx, r.output, r.cache_read cr, r.total_ms, ${TTFT} ttft, r.stop, r.worker
      FROM requests r ${JOIN_T} WHERE r.sid = ? ORDER BY r.ts`, id);
    let prevMain: number | null = null;
    const timeline = reqs.map((r) => {
      const compaction = !r.worker && prevMain !== null && r.ctx < prevMain * 0.6;
      if (!r.worker) prevMain = r.ctx;
      return { ts: r.ts, context_tokens: r.ctx, output: r.output, hit_pct: pct(r.cr, r.ctx), total_ms: r.total_ms, ttft_ms: r.ttft ?? null, stop: r.stop, worker: !!r.worker, compaction };
    });
    const workers = this.all<any>(`SELECT l.handle, w.agent, w.model,
        (SELECT SUM(r.cost) FROM requests r WHERE r.sid = l.session_id AND r.handle = l.handle) spend
      FROM worker_links l LEFT JOIN workers w ON w.proc = l.proc AND w.handle = l.handle
      WHERE l.session_id = ? ORDER BY CAST(SUBSTR(l.handle, 4) AS INTEGER)`, id)
      .map((w) => ({ handle: w.handle, agent: w.agent ?? null, model: w.model ?? null, spend: r4(w.spend ?? null) }));
    return { session: this.sessionRow(x), timeline, workers };
  }

  heatmap(f: Filter) {
    const w = where(f, "ts");
    const rows = this.all<{ wd: number; hour: number; n: number }>(`SELECT wd, hour, COUNT(*) n FROM requests ${w.sql} GROUP BY wd, hour`, ...w.args);
    const grid = new Map(rows.map((r) => [r.wd * 24 + r.hour, r.n]));
    const cells: [number, number, number][] = [];
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) cells.push([d, h, grid.get(d * 24 + h) ?? 0]);
    return { cells };
  }

  health(f: Filter) {
    const w = where(f, "ts");
    const stops = this.all(`SELECT COALESCE(stop, 'none') stop, COUNT(*) count FROM requests ${w.sql} GROUP BY 1 ORDER BY 2 DESC`, ...w.args);
    const agg = this.get(`SELECT COUNT(*) n, SUM(refusal_retries) rr, SUM(miss_reason = 'tools_changed') tc FROM requests ${w.sql}`, ...w.args);
    const tw = where(f, "ts");
    const tl = this.get(`SELECT COUNT(*) n, SUM(losses) l FROM traces ${tw.sql}`, ...tw.args);
    const count = (t: string) => (this.get(`SELECT COUNT(*) n FROM ${t}`) as any).n as number;
    const streams = this.all<any>(`SELECT host, kind, path, offset, size FROM ingest_state WHERE kind != 'log' ORDER BY host, kind, path`);
    const logs = this.all<any>(`SELECT host, COUNT(*) files, SUM(offset) offset, SUM(size) size, MAX(path) path FROM ingest_state WHERE kind = 'log' GROUP BY host`);
    const num = (k: string) => { const v = metaGet(this.db, k); return v === null ? null : Number(v); };
    return {
      stops,
      refusal_retries: agg.n ? agg.rr : null,
      translation_losses: tl.n ? tl.l : null,
      tools_changed_misses: agg.n ? agg.tc : null,
      ingest: {
        last_run: num("last_run"),
        last_run_ms: num("last_run_ms"),
        rows: { requests: count("requests"), traces: count("traces"), sessions: count("sessions"), workers: count("workers"), legacy: count("legacy_usage") },
        errors: num("errors") ?? 0,
        bad_lines: num("bad_lines") ?? 0,
        last_error: metaGet(this.db, "last_error"),
        skipped_files: (this.get(`SELECT COUNT(*) n FROM file_state WHERE status = 'skip'`) as any).n,
        sources: [
          ...streams.map((s) => ({ host: s.host, kind: s.kind, path: s.path, offset: s.offset, size: s.size })),
          ...logs.map((s) => ({ host: s.host, kind: "log", path: s.path.replace(/synaps\.log\.[^/]*$/, "synaps.log.*"), offset: s.offset, size: s.size, files: s.files })),
        ],
      },
    };
  }
}
