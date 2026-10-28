// Local-day bucketing. Days are America/New_York calendar days (the machine's
// TZ), as YYYY-MM-DD. Memoised per UTC hour: every NY offset change lands on
// an hour boundary, so one Intl call per hour of data is exact.

export const TZ = "America/New_York";

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hourCycle: "h23",
});
const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const memo = new Map<number, { day: string; wd: number; hour: number }>();

export function local(ts: number): { day: string; wd: number; hour: number } {
  const h = Math.floor(ts / 3_600_000);
  let v = memo.get(h);
  if (!v) {
    const p: Record<string, string> = {};
    for (const x of fmt.formatToParts(new Date(h * 3_600_000))) p[x.type] = x.value;
    v = { day: `${p.year}-${p.month}-${p.day}`, wd: WD[p.weekday] ?? 0, hour: Number(p.hour) % 24 };
    if (memo.size > 200_000) memo.clear();
    memo.set(h, v);
  }
  return v;
}

export const dayOf = (ts: number) => local(ts).day;

/** Every calendar day from a to b inclusive (YYYY-MM-DD strings). */
export function daysBetween(a: string, b: string): string[] {
  const out: string[] = [];
  let [y, m, d] = a.split("-").map(Number);
  for (let i = 0; i < 20000; i++) {
    const t = new Date(Date.UTC(y, m - 1, d + i));
    const s = t.toISOString().slice(0, 10);
    if (s > b) break;
    out.push(s);
  }
  return out;
}

const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
export const nextDay = (day: string) => addDays(day, 1);
export const prevDay = (day: string) => addDays(day, -1);

/** Unix ms of local midnight starting `day`. NY midnight is 04:00Z or 05:00Z, always on a UTC hour. */
export function dayStartMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  for (let h = 2; h <= 7; h++) if (local(base + h * 3_600_000).day === day) return base + h * 3_600_000;
  throw new Error(`no local midnight for ${day}`);
}

/** Monday = 0 … Sunday = 6, from a YYYY-MM-DD calendar day. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
