// Query layer: one function per /api/telemetry endpoint (shapes: docs/telemetry-api.md).
// Rule from the contract: a metric with no data is null, never 0 (sums in
// dense series are the one exception — 0 is a real sum there).
//
// Request aggregates come from the worker-maintained daily rollups (O(days));
// only the partial first/last day of a from/to range is aggregated from raw rows
// with the same builder, so results stay exact at the ms edges. Nothing here
// spawns processes or touches the filesystem.

import type { Database } from "bun:sqlite";
import { dayOf, daysBetween, dayStartMs, nextDay, prevDay, weekdayOf } from "./tz.ts";
import { modelPrices, cacheReadMultiplier } from "./pricing.ts";
import { metaGet } from "./schema.ts";
import { buildRollups, rollFromDb, mergeRoll, emptyRoll, hquantile, type Roll } from "./rollup.ts";

export type Filter = { from?: number | null; to?: number | null; host?: string | null };
export type Live = () => { sessions: number | null; workers: number | null } | null;

const r1 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r4 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const pct = (num: number, den: number) => (den > 0 ? r1((num / den) * 100) : null);

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
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

// Effective TTFT: the trace's first model event, else api-log ttft_ms (bogus values nulled at ingest).
const TTFT = "COALESCE(t.first_event_ms, r.ttft_ms)";
const JOIN_T = "LEFT JOIN traces t ON t.provider_request_id = r.request_id";

/** Split [from, to] into whole local days (served from rollups) and partial edge days (raw). */
function daySplit(f: Filter): { a: string | null; b: string | null; empty: boolean } {
  let a: string | null = null, b: string | null = null;
  if (f.from != null) { const d = dayOf(f.from); a = f.from === dayStartMs(d) ? d : nextDay(d); }
  if (f.to != null) { const d = dayOf(f.to); b = f.to >= dayStartMs(nextDay(d)) - 1 ? d : prevDay(d); }
  return { a, b, empty: a !== null && b !== null && a > b };
}

export class TelemetryQuery {
  constructor(public db: Database, public opts: { live?: Live } = {}) {}

  private get<T = any>(sql: string, ...args: any[]): T { return this.db.query(sql).get(...args) as T; }
  private all<T = any>(sql: string, ...args: any[]): T[] { return this.db.query(sql).all(...args) as T[]; }

  // Parsed rollups, per day, kept in memory: only rows with a newer generation are re-read.
  private rollCache = new Map<string, Roll[]>();
  private rollGen = 0;
  private freshRolls(): Map<string, Roll[]> {
    const gen = Number(metaGet(this.db, "rollup_gen") ?? 0);
    if (gen < this.rollGen) { this.rollCache.clear(); this.rollGen = 0; } // store was rebuilt
    if (gen !== this.rollGen) {
      const byDay = new Map<string, Roll[]>();
      for (const x of this.all(`SELECT * FROM rollup_daily WHERE gen > ?`, this.rollGen)) {
        let l = byDay.get(x.day);
        if (!l) byDay.set(x.day, (l = []));
        l.push(rollFromDb(x));
      }
      for (const [d, l] of byDay) this.rollCache.set(d, l);
      this.rollGen = gen;
    }
    return this.rollCache;
  }

  /** Rollups for the filter (+ model): whole days from rollup_daily, edge days built from raw rows. */
  rolls(f: Filter, model?: string | null): Roll[] {
    const { a, b, empty } = daySplit(f);
    const out: Roll[] = [];
    if (!empty) {
      for (const [day, l] of this.freshRolls()) {
        if ((a && day < a) || (b && day > b)) continue;
        for (const r of l) if ((!f.host || r.host === f.host) && (!model || r.model === model)) out.push(r);
      }
    }
    if (f.from != null || f.to != null) {
      const w = ["1"], wa: any[] = [];
      if (f.from != null) { w.push("r.ts >= ?"); wa.push(f.from); }
      if (f.to != null) { w.push("r.ts <= ?"); wa.push(f.to); }
      if (f.host) { w.push("r.host = ?"); wa.push(f.host); }
      if (model) { w.push("r.model = ?"); wa.push(model); }
      if (!empty) {
        const inner: string[] = [];
        if (a) inner.push("r.day >= ?"), wa.push(a);
        if (b) inner.push("r.day <= ?"), wa.push(b);
        if (inner.length) w.push(`NOT (${inner.join(" AND ")})`);
      }
      out.push(...buildRollups(this.db, w.join(" AND "), wa));
    }
    return out;
  }

  /** Merge rolls by a key function. */
  private group(rs: Roll[], key: (r: Roll) => string): Map<string, Roll> {
    const m = new Map<string, Roll>();
    for (const r of rs) {
      const k = key(r);
      let g = m.get(k);
      if (!g) m.set(k, (g = emptyRoll(r.day, r.host, r.model, r.worker)));
      mergeRoll(g, r);
    }
    return m;
  }
  private total(rs: Roll[]): Roll { return rs.reduce((g, r) => mergeRoll(g, r), emptyRoll("", "", "", 0)); }

  /** Session-grain sessions (no overlapping request rows on any host), in range. */
  private sessionGrain(f: Filter, cols: string, tail = "") {
    const w = where(f, "created", "", ["grain = 'session'"]);
    return this.all(`SELECT ${cols} FROM sessions ${w.sql} ${tail}`, ...w.args);
  }

  summary(f: Filter) {
    const now = Date.now();
    const today = dayOf(now);
    const h = f.host ? " AND r.host = ?" : "";
    const ha = f.host ? [f.host] : [];
    const td = this.get(`SELECT COUNT(*) n, SUM(cost) c FROM requests r WHERE r.ts >= ?${h}`, dayStartMs(today), ...ha);
    const lat = this.all<{ ttft: number | null; total: number | null; cost: number; cr: number; den: number }>(
      `SELECT ${TTFT} ttft, r.total_ms total, r.cost, r.cache_read cr, r.input + r.cache_read + r.cache_write den FROM requests r ${JOIN_T} WHERE r.ts >= ?${h}`, now - 3_600_000, ...ha);
    const live = this.opts.live?.() ?? null;

    const R = this.total(this.rolls(f));
    const rt = where(f, "ts");
    const span = R.n ? this.get(`SELECT MIN(ts) a, MAX(ts) b FROM requests ${rt.sql}`, ...rt.args) : { a: null, b: null };
    const S = this.sessionGrain(f, "COUNT(*) n, SUM(cost) c, MIN(created) a, MAX(updated) b, SUM(input) i, SUM(output) o, SUM(cache_read) cr, SUM(cache_write) cw, SUM(saved) sv, SUM(saved_net) svn")[0];
    const sw = this.sessionWhere(f);
    const sessions = this.get(`SELECT COUNT(*) n FROM sessions s ${sw.sql}`, ...sw.args).n as number;
    const has = R.n > 0 || S.n > 0;
    const add = (x: number | null, y: number | null) => (has ? (x ?? 0) + (y ?? 0) : null);
    const ends = (xs: (number | null)[], pick: (...v: number[]) => number) => { const v = xs.filter((x): x is number => x != null); return v.length ? pick(...v) : null; };
    const hr = lat.reduce((s, x) => ({ c: s.c + x.cost, cr: s.cr + x.cr, den: s.den + x.den }), { c: 0, cr: 0, den: 0 });
    return {
      generated_at: now,
      now: {
        spend_today: td.n ? r4(td.c) : null,
        burn_rate_per_hour: lat.length ? r4(hr.c) : null,
        requests_today: td.n || null,
        hit_pct_1h: lat.length ? pct(hr.cr, hr.den) : null,
        ttft_p50_ms_1h: quantile(sortNum(lat.map((x) => x.ttft).filter((x): x is number => x != null)), 0.5),
        total_p50_ms_1h: quantile(sortNum(lat.map((x) => x.total).filter((x): x is number => x != null)), 0.5),
        live_sessions: live?.sessions ?? null,
        live_workers: live?.workers ?? null,
      },
      all: {
        spend: r4(add(R.cost, S.c)),
        requests: R.n || null,
        sessions: sessions || null,
        first_ts: ends([span.a, S.a], Math.min),
        last_ts: ends([span.b, S.b], Math.max),
        tokens: { input: add(R.input, S.i), output: add(R.output, S.o), cache_read: add(R.cache_read, S.cr), cache_write: add(R.cache_write, S.cw) },
        saved_by_cache: r4(add(R.saved, S.sv)),
        saved_by_cache_net: r4(add(R.saved_net, S.svn)),
      },
    };
  }

  spend(f: Filter, group: string) {
    const key = (r: Roll) => (group === "role" ? (r.worker ? "worker" : "main") : group === "host" ? r.host : r.model);
    const scol = group === "role" ? "'main'" : group === "host" ? "host" : "model";
    const rows: { k: string; d: string; c: number }[] = [];
    for (const r of this.rolls(f)) rows.push({ k: key(r), d: r.day, c: r.cost });
    const srows = this.sessionGrain(f, `${scol} k, created_day d, SUM(cost) c`, "GROUP BY k, d") as { k: string; d: string; c: number | null }[];
    const all = [...srows.map((x) => ({ ...x, c: x.c ?? 0 })), ...rows];
    const grain: [string, string][] = [];
    const firstS = srows.reduce<string | null>((m, x) => (m === null || x.d < m ? x.d : m), null);
    const firstR = rows.reduce<string | null>((m, x) => (m === null || x.d < m ? x.d : m), null);
    if (firstS) grain.push([firstS, "session"]);
    if (firstR) grain.push([firstR, "request"]);
    if (!all.length) return { bucket: "day", group, series: [], grain };
    let a = all[0].d, b = all[0].d;
    for (const x of all) { if (x.d < a) a = x.d; if (x.d > b) b = x.d; }
    if (f.from != null && dayOf(f.from) < a) a = dayOf(f.from);
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

  /** (host|day) pairs that have api-log rows: a legacy line on such a day is the same request
   *  again (verified line-for-line), so legacy lines count only on days their own host has none. */
  private requestDays(): Set<string> {
    const out = new Set<string>();
    for (const [day, l] of this.freshRolls()) for (const r of l) out.add(`${r.host}|${day}`);
    return out;
  }

  private legacyDaily(f: Filter): { day: string; host: string; read: number; w: number; fresh: number }[] {
    const covered = this.requestDays();
    const { a, b, empty } = daySplit(f);
    const out: { day: string; host: string; read: number; w: number; fresh: number }[] = [];
    const c: string[] = [], args: any[] = [];
    if (f.host) { c.push("host = ?"); args.push(f.host); }
    if (!empty) {
      const w = [...c], wa = [...args];
      if (a) { w.push("day >= ?"); wa.push(a); }
      if (b) { w.push("day <= ?"); wa.push(b); }
      for (const x of this.all(`SELECT day, host, cache_read read, cache_create w, input fresh FROM legacy_daily ${w.length ? "WHERE " + w.join(" AND ") : ""}`, ...wa)) out.push(x);
    }
    if (f.from != null || f.to != null) {
      const lw = where(f, "ts");
      const inner: string[] = [], ia: any[] = [];
      if (!empty) { if (a) inner.push("day >= ?"), ia.push(a); if (b) inner.push("day <= ?"), ia.push(b); }
      const sql = `SELECT day, host, SUM(cache_read) read, SUM(cache_create) w, SUM(input) fresh FROM legacy_usage ${lw.sql}${inner.length ? `${lw.sql ? " AND" : " WHERE"} NOT (${inner.join(" AND ")})` : ""} GROUP BY day, host`;
      out.push(...this.all<any>(sql, ...lw.args, ...ia));
    }
    return out.filter((x) => !covered.has(`${x.host}|${x.day}`));
  }

  cache(f: Filter) {
    const byDay = new Map<string, any>();
    const row = (day: string) => {
      let r = byDay.get(day);
      if (!r) byDay.set(day, (r = { day, read: 0, fresh: 0, w5: 0, w1: 0, wu: 0, w: 0, split: 0, req: 0, leg: 0 }));
      return r;
    };
    for (const r of this.rolls(f)) {
      const x = row(r.day);
      x.read += r.cache_read; x.fresh += r.input; x.w += r.cache_write; x.w5 += r.cw5m; x.w1 += r.cw1h; x.wu += r.cw_unknown; x.split += r.split_n; x.req += r.n;
    }
    for (const l of this.legacyDaily(f)) {
      const x = row(l.day);
      x.read += l.read; x.fresh += l.fresh; x.w += l.w; x.wu += l.w; x.leg++;
    }
    const daily = [...byDay.values()].sort((p, q) => (p.day < q.day ? -1 : 1)).map((x) => ({
      day: x.day, hit_pct: pct(x.read, x.fresh + x.read + x.w), read: x.read,
      write_5m: x.split ? x.w5 : null, write_1h: x.split ? x.w1 : null, write_unknown: x.leg || x.wu ? x.wu : null, write: x.w,
      fresh_input: x.fresh, grain: x.req && x.leg ? "mixed" : x.leg ? "legacy" : "request",
    }));
    const mw = where(f, "ts", "", ["miss_reason IS NOT NULL"]);
    const miss = this.all(`SELECT miss_reason reason, COUNT(*) count FROM requests INDEXED BY requests_miss ${mw.sql} GROUP BY 1 ORDER BY 2 DESC`, ...mw.args);
    const kw = where(f, "ts", "", ["keepwarm = 1"]);
    const pings = this.all<{ model: string; cr: number; cost: number }>(`SELECT model, cache_read cr, cost FROM requests INDEXED BY requests_keepwarm ${kw.sql}`, ...kw.args);
    // A ping keeps a prefix warm; without it the next turn would rewrite that prefix at the 5m write
    // rate (1.25×) instead of reading it. Gross estimate: Σ cache_read × input × (1.25 − read multiplier).
    let kcost = 0, ksaved = 0;
    for (const p of pings) {
      kcost += p.cost;
      ksaved += (p.cr / 1e6) * modelPrices(p.model, p.cr)[0] * (1.25 - cacheReadMultiplier(p.model));
    }
    return {
      daily,
      miss_reasons: miss,
      keepwarm: { pings: pings.length, cost: pings.length ? r4(kcost) : null, est_saved: pings.length ? r4(ksaved) : null },
      releases: this.releases(f),
    };
  }

  /** Minor releases (vX.Y.0) inside the range. Tags are read off-thread by the ingest worker
   *  (git for-each-ref) and served from meta. */
  releases(f: Filter = {}): { tag: string; ts: number }[] {
    let all: { tag: string; ts: number }[] = [];
    try { all = JSON.parse(metaGet(this.db, "releases") ?? "[]"); } catch {}
    return all.filter((r) => /^v?\d+\.\d+\.0$/.test(r.tag) && (f.from == null || r.ts >= f.from) && (f.to == null || r.ts <= f.to));
  }

  latency(f: Filter, model?: string | null) {
    const rs = this.rolls(f, model);
    const days = [...this.group(rs, (r) => r.day).entries()].sort((p, q) => (p[0] < q[0] ? -1 : 1));
    let n = 0, retried = 0;
    const daily = days.map(([day, r]) => {
      n += r.n; retried += r.retried;
      return { day, ttft_p50: hquantile(r.ttft, 0.5), ttft_p95: hquantile(r.ttft, 0.95), ttft_p99: hquantile(r.ttft, 0.99), total_p50: hquantile(r.total, 0.5), total_p95: hquantile(r.total, 0.95), n: r.n };
    });
    const tw = where(f, "ts", "t", model ? ["t.model = ?"] : []);
    const tr = this.all<{ h: number | null; e: number | null; s: number | null }>(`SELECT t.headers_ms h, t.first_event_ms e, t.stream_end_ms - t.first_event_ms s FROM traces t ${tw.sql}`, ...(model ? [model, ...tw.args] : tw.args));
    const col = (k: "h" | "e" | "s") => quantile(sortNum(tr.map((x) => x[k]).filter((x): x is number => x != null)), 0.5);
    // Scatter: prompt tokens (input + cache read + cache write) vs total_ms; ≤ 2000 points
    // picked in SQL by a rowid stride (rowid ≈ ingest order), never materialising every row.
    const k = Math.max(1, Math.ceil(n / 2000));
    const sw = where(f, "ts", "r", [...(model ? ["r.model = ?"] : []), "r.total_ms IS NOT NULL", "r.rowid % ? = 0"]);
    const by_context = this.all<{ p: number; t: number }>(`SELECT r.input + r.cache_read + r.cache_write p, r.total_ms t FROM requests r ${sw.sql} LIMIT 2000`, ...(model ? [model, k, ...sw.args] : [k, ...sw.args]))
      .map((x) => [x.p, x.t] as [number, number]);
    return {
      daily,
      split: { headers_p50: col("h"), first_event_p50: col("e"), stream_p50: col("s") },
      retries: { requests_with_retry: n ? retried : null, rate_pct: n ? pct(retried, n) : null },
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

  private static SESSION_COLS = `s.id, s.host, s.title, s.title_raw, s.model, s.created, s.updated, s.cost, s.input, s.cache_read, s.cache_write, s.grain,
    (SELECT COUNT(*) FROM requests r WHERE r.sid = s.id) nreq,
    (SELECT MAX(r.input + r.cache_read + r.cache_write) FROM requests r WHERE r.sid = s.id) peak,
    (SELECT COUNT(DISTINCT l.proc || '/' || l.handle) FROM worker_links l WHERE l.session_id = s.id) nworkers`;

  private sessionRow(x: any) {
    return {
      id: x.id, host: x.host, title: x.title, title_raw: x.title_raw, model: x.model, created: x.created, updated: x.updated,
      requests: x.nreq || null, spend: r4(x.cost), hit_pct: x.cache_read === null ? null : pct(x.cache_read, x.input + x.cache_read + (x.cache_write ?? 0)),
      peak_context_tokens: x.peak ?? null, workers: x.nworkers, grain: x.grain,
    };
  }

  sessions(f: Filter, sort: string, limit: number, offset: number, q: string | null) {
    const extra: string[] = [], ea: any[] = [];
    if (q) { extra.push("(s.title LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\')"); const p = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%"; ea.push(p, p); }
    const w = this.sessionWhere(f, extra, ea);
    const total = this.get(`SELECT COUNT(*) n FROM sessions s ${w.sql}`, ...w.args).n as number;
    const order = sort === "updated" ? "s.updated DESC" : sort === "requests" ? "nreq DESC, s.updated DESC" : "s.cost IS NULL, s.cost DESC";
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
    // A link per host copy of the session; one row per archive, preferring the copy whose host has it.
    const links = this.all<any>(`SELECT l.proc, l.handle, w.agent, w.model, w.host wh,
        (SELECT SUM(r.cost) FROM requests r WHERE r.sid = l.session_id AND r.handle = l.handle) spend
      FROM worker_links l LEFT JOIN workers w ON w.host = l.host AND w.proc = l.proc AND w.handle = l.handle
      WHERE l.session_id = ? ORDER BY CAST(SUBSTR(l.handle, 4) AS INTEGER), l.proc, wh IS NULL`, id);
    const seen = new Set<string>();
    const workers = links.filter((w) => { const k = `${w.proc}/${w.handle}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((w) => ({ handle: w.handle, agent: w.agent ?? null, model: w.model ?? null, spend: r4(w.spend ?? null) }));
    return { session: this.sessionRow(x), timeline, workers };
  }

  heatmap(f: Filter) {
    const grid = new Array(168).fill(0);
    for (const r of this.rolls(f)) { const wd = weekdayOf(r.day); for (let h = 0; h < 24; h++) grid[wd * 24 + h] += r.hours[h]; }
    const cells: [number, number, number][] = [];
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) cells.push([d, h, grid[d * 24 + h]]);
    return { cells };
  }

  health(f: Filter) {
    const R = this.total(this.rolls(f));
    const stops = Object.entries(R.stops).map(([stop, count]) => ({ stop: stop === "" ? null : stop, count })).sort((a, b) => b.count - a.count);
    const tw = where(f, "ts");
    const tl = this.get(`SELECT COUNT(*) n, SUM(losses) l FROM traces ${tw.sql}`, ...tw.args);
    const num = (k: string) => { const v = metaGet(this.db, k); return v === null ? null : Number(v); };
    const streams = this.all<any>(`SELECT host, kind, path, offset, size FROM ingest_state WHERE kind != 'log' AND missing = 0 ORDER BY host, kind, path`);
    const logs = this.all<any>(`SELECT host, COUNT(*) files, SUM(offset) offset, SUM(size) size, MAX(path) path FROM ingest_state WHERE kind = 'log' AND missing = 0 GROUP BY host`);
    return {
      stops,
      refusal_retries: R.n ? R.refusal_retries : null,
      translation_losses: tl.n ? tl.l : null,
      tools_changed_misses: R.n ? R.tools_changed : null,
      ingest: {
        last_run: num("last_run"),
        last_run_ms: num("last_run_ms"),
        rows: { requests: num("count_requests") ?? 0, traces: num("count_traces") ?? 0, sessions: num("count_sessions") ?? 0, workers: num("count_workers") ?? 0, legacy: num("count_legacy") ?? 0 },
        errors: num("errors") ?? 0,
        bad_lines: num("bad_lines") ?? 0,
        lost_bytes: num("lost_bytes") ?? 0,
        last_error: metaGet(this.db, "last_error"),
        skipped_files: (num("count_skipped") ?? 0) + (num("skipped_special") ?? 0),
        sources: [
          ...streams.map((s) => ({ host: s.host, kind: s.kind, path: s.path, offset: s.offset, size: s.size })),
          ...logs.map((s) => ({ host: s.host, kind: "log", path: s.path.replace(/synaps\.log\.[^/]*$/, "synaps.log.*"), offset: s.offset, size: s.size, files: s.files })),
        ],
      },
    };
  }
}
