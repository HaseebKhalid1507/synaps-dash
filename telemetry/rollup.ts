// Daily rollups per (day, host, model, worker): the worker maintains them after
// each ingest pass (only the days that pass touched), so the HTTP thread reads
// O(days) rows instead of every request. Percentiles come from log-bucketed
// histograms: exact below 100 ms, then 2% buckets (≤1% error at the midpoint).
// The same builder also aggregates raw rows on the fly for partial edge days
// of a from/to range, so results are exact at the ms edges.

import type { Database } from "bun:sqlite";

/** Dense log-bucket histogram (bucket → count); the last bucket absorbs everything ≥ ~4 h. */
export type Hist = Uint32Array;
export const NB = 700;
export const newHist = () => new Uint32Array(NB);
export type Roll = {
  day: string; host: string; model: string; worker: number;
  n: number; cost: number; saved: number; saved_net: number;
  input: number; output: number; cache_read: number; cache_write: number;
  cw5m: number; cw1h: number; cw_unknown: number; split_n: number;
  retried: number; refusal_retries: number; tools_changed: number; keepwarm_n: number;
  ttft: Hist; total: Hist; stops: Record<string, number>; hours: number[];
};

const RATIO = Math.log(1.02);
export const hbucket = (v: number) => { v = Math.max(0, Math.round(v)); return Math.min(NB - 1, v < 100 ? v : 100 + Math.floor(Math.log(v / 100) / RATIO)); };
export const hvalue = (b: number) => (b < 100 ? b : Math.round(100 * Math.exp((b - 100 + 0.5) * RATIO)));

export function hquantile(h: Hist, q: number): number | null {
  let n = 0;
  for (let i = 0; i < NB; i++) n += h[i];
  if (!n) return null;
  const target = Math.max(1, Math.ceil(q * n));
  let cum = 0;
  for (let i = 0; i < NB; i++) { cum += h[i]; if (cum >= target) return hvalue(i); }
  return null;
}

export const emptyRoll = (day: string, host: string, model: string, worker: number): Roll => ({
  day, host, model, worker, n: 0, cost: 0, saved: 0, saved_net: 0, input: 0, output: 0, cache_read: 0, cache_write: 0,
  cw5m: 0, cw1h: 0, cw_unknown: 0, split_n: 0, retried: 0, refusal_retries: 0, tools_changed: 0, keepwarm_n: 0,
  ttft: newHist(), total: newHist(), stops: {}, hours: new Array(24).fill(0),
});

const SUMS = ["n", "cost", "saved", "saved_net", "input", "output", "cache_read", "cache_write", "cw5m", "cw1h", "cw_unknown", "split_n", "retried", "refusal_retries", "tools_changed", "keepwarm_n"] as const;

export function mergeRoll(into: Roll, r: Roll): Roll {
  for (const k of SUMS) (into as any)[k] += r[k];
  for (let i = 0; i < NB; i++) { into.ttft[i] += r.ttft[i]; into.total[i] += r.total[i]; }
  for (const k in r.stops) into.stops[k] = (into.stops[k] ?? 0) + r.stops[k];
  for (let i = 0; i < 24; i++) into.hours[i] += r.hours[i];
  return into;
}

/** Aggregate raw request rows (joined to traces for TTFT/retries) matching `where`. */
export function buildRollups(db: Database, where: string, args: any[]): Roll[] {
  const rows = db.query(`SELECT r.day, r.host, r.model, r.worker, r.hour, r.cost, r.saved, r.saved_net, r.input, r.output, r.cache_read, r.cache_write,
      r.cw5m, r.cw1h, r.cw_unknown, COALESCE(t.first_event_ms, r.ttft_ms) ttft, r.total_ms, r.stop,
      (r.attempt > 1 OR COALESCE(t.retries, 0) > 0) retried, r.refusal_retries, r.miss_reason = 'tools_changed' tc, r.keepwarm
    FROM requests r LEFT JOIN traces t ON t.provider_request_id = r.request_id WHERE ${where}`).all(...args) as any[];
  const m = new Map<string, Roll>();
  for (const x of rows) {
    const key = `${x.day}|${x.host}|${x.model}|${x.worker}`;
    let r = m.get(key);
    if (!r) m.set(key, (r = emptyRoll(x.day, x.host, x.model, x.worker)));
    r.n++; r.cost += x.cost; r.saved += x.saved; r.saved_net += x.saved_net;
    r.input += x.input; r.output += x.output; r.cache_read += x.cache_read; r.cache_write += x.cache_write;
    if (x.cw5m !== null) { r.cw5m += x.cw5m; r.cw1h += x.cw1h ?? 0; r.split_n++; }
    r.cw_unknown += x.cw_unknown;
    if (x.retried) r.retried++;
    r.refusal_retries += x.refusal_retries;
    if (x.tc) r.tools_changed++;
    if (x.keepwarm) r.keepwarm_n++;
    if (x.ttft !== null) r.ttft[hbucket(x.ttft)]++;
    if (x.total_ms !== null) r.total[hbucket(x.total_ms)]++;
    const s = x.stop ?? ""; // "" = no stop_reason in the record (served as null)
    r.stops[s] = (r.stops[s] ?? 0) + 1;
    r.hours[x.hour]++;
  }
  return [...m.values()];
}

// stored sparse: [[bucket, count], …]
const enc = (h: Hist) => { const o: [number, number][] = []; for (let i = 0; i < NB; i++) if (h[i]) o.push([i, h[i]]); return JSON.stringify(o); };
const dec = (s: string): Hist => { const h = newHist(); for (const [b, c] of JSON.parse(s) as [number, number][]) h[Math.min(NB - 1, b)] += c; return h; };

export function rollFromDb(x: any): Roll {
  const r = emptyRoll(x.day, x.host, x.model, x.worker);
  for (const k of SUMS) (r as any)[k] = x[k];
  r.ttft = dec(x.ttft); r.total = dec(x.total); r.stops = JSON.parse(x.stops); r.hours = JSON.parse(x.hours);
  return r;
}

/** Recompute the stored rollups for these days (worker side). */
/** Recompute the stored rollups for these days (worker side). Every rewritten row gets a new
 *  generation number, so readers re-parse only what changed (meta rollup_gen = the latest). */
export function rebuildRollupDays(db: Database, days: Iterable<string>) {
  const del = db.prepare("DELETE FROM rollup_daily WHERE day = ?");
  const ins = db.prepare(`INSERT INTO rollup_daily VALUES (${new Array(4 + SUMS.length + 5).fill("?").join(",")})`);
  db.transaction(() => {
    const gen = Number((db.query("SELECT value FROM meta WHERE key = 'rollup_gen'").get() as any)?.value ?? 0) + 1;
    for (const day of days) {
      del.run(day);
      for (const r of buildRollups(db, "r.day = ?", [day]))
        ins.run(r.day, r.host, r.model, r.worker, ...SUMS.map((k) => r[k]), enc(r.ttft), enc(r.total), JSON.stringify(r.stops), JSON.stringify(r.hours), gen);
    }
    db.query("INSERT INTO meta(key, value) VALUES('rollup_gen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(gen));
  })();
}

export const ROLLUP_COLUMNS = SUMS;
