// USD cost of one model request — a straight port of SynapsCLI's pricing table:
//   agent-runtime/crates/agent-core/src/pricing.rs @ a9e9840c (2026-10-10, "fix/pricing-table")
// Keep it in lockstep with that file; it is the single source of truth.
// Prices are USD per million tokens, API list price (an estimate, not an invoice).
//
// Cache, relative to the input price: reads × cacheReadMultiplier (0.10 default,
// 0.05 Opus/Sonnet 5.5, 0.025 Fable/Mythos 5.1), 5m writes 1.25×, 1h writes 2×.
// Haiku 5.5 is tiered on the prompt (input + cache read + cache writes) > 100k.

const HAIKU_5_5_TIER_TOKENS = 100_000;

function suffixOk(rest: string): boolean {
  if (rest === "" || rest === "-latest" || rest === ":0" || rest === "-v1:0") return true;
  let date: string;
  if (rest.startsWith("-") || rest.startsWith("@")) date = rest.slice(1);
  else return false;
  return date.length >= 8 && /^\d{8}/.test(date) && (date.slice(8) === "" || date.slice(8) === "-v1:0");
}

/** Whole-version match, dotted or hyphenated minor (`opus-5-5` ≡ `opus-5.5`). */
export function isVersion(model: string, version: string): boolean {
  const cands = [version];
  const i = version.lastIndexOf("-");
  if (i > 0) {
    const prefix = version.slice(0, i), minor = version.slice(i + 1);
    if (/\d$/.test(prefix) && /^\d*$/.test(minor)) cands.push(`${prefix}.${minor}`);
  }
  for (const v of cands) {
    let from = 0;
    for (;;) {
      const at = model.indexOf(v, from);
      if (at < 0) break;
      const before = at === 0 ? "" : model[at - 1];
      if ((at === 0 || before === "-" || before === "/" || before === ".") && suffixOk(model.slice(at + v.length))) return true;
      from = at + 1;
    }
  }
  return false;
}

export const isLegacyOpus = (m: string) => ["3-opus", "opus-3", "opus-4", "opus-4-0", "opus-4-1"].some((v) => isVersion(m, v));

/** [input, output] USD per MTok. Unknown models fall back to Sonnet. */
export function modelPrices(m: string, promptTokens: number): [number, number] {
  if (m === "inferx/deepseek-v4-flash" || m === "deepseek-v4-flash") return [0, 0];
  if (m.includes("fable") || m.includes("mythos")) return [10, 50];
  if (isVersion(m, "opus-5-5")) return [4, 20];
  if (isLegacyOpus(m)) return [15, 75];
  if (m.includes("opus")) return [5, 25];
  if (isVersion(m, "sonnet-5-5")) return [2, 10];
  if (isVersion(m, "sonnet-5")) return [2, 10];
  if (m.includes("sonnet")) return [3, 15];
  if (isVersion(m, "haiku-5-5")) return promptTokens > HAIKU_5_5_TIER_TOKENS ? [0.5, 2.5] : [0.1, 0.5];
  if (isVersion(m, "haiku-3-5") || isVersion(m, "3-5-haiku") || isVersion(m, "3.5-haiku")) return [0.8, 4];
  if (isVersion(m, "3-haiku") || isVersion(m, "haiku-3")) return [0.25, 1.25];
  if (m.includes("haiku")) return [1, 5];
  return [3, 15];
}

export function cacheReadMultiplier(m: string): number {
  if (isVersion(m, "fable-5-1") || isVersion(m, "mythos-5-1")) return 0.025;
  if (isVersion(m, "opus-5-5") || isVersion(m, "sonnet-5-5")) return 0.05;
  return 0.1;
}

export function costSplit(model: string, input: number, output: number, cacheRead: number, w5m: number, w1h: number): number {
  const prompt = input + cacheRead + w5m + w1h;
  const [ip, op] = modelPrices(model, prompt);
  return (input / 1e6) * ip + (cacheRead / 1e6) * ip * cacheReadMultiplier(model) + (w5m / 1e6) * ip * 1.25 + (w1h / 1e6) * ip * 2 + (output / 1e6) * op;
}

/** Aggregate cache_creation billed at the 5m rate (no TTL split known). */
export function cost(model: string, input: number, output: number, cacheRead: number, cacheCreation: number): number {
  return costSplit(model, input, output, cacheRead, cacheCreation, 0);
}

/** pricing.rs calculate_cost_optional_split: known split buckets kept, remainder → 1h (conservative). */
export function costOptionalSplit(model: string, input: number, output: number, cacheRead: number, cacheCreation: number, c5?: number | null, c1?: number | null): number {
  if (c5 == null && c1 == null) return cost(model, input, output, cacheRead, cacheCreation);
  const a = c5 ?? 0, b = c1 ?? 0;
  const rem = Math.max(0, cacheCreation - (a + b));
  return costSplit(model, input, output, cacheRead, a, b + rem);
}

/** Gross: what the cache reads saved, i.e. reads billed as fresh input minus billed as reads.
 *  `promptTokens` picks the Haiku 5.5 tier (defaults to this request's prompt). */
export function cacheSavings(model: string, input: number, cacheRead: number, w5m: number, w1h: number, promptTokens?: number): number {
  const [ip] = modelPrices(model, promptTokens ?? input + cacheRead + w5m + w1h);
  return (cacheRead / 1e6) * ip * (1 - cacheReadMultiplier(model));
}

/** Net: gross savings minus the write premium caching costs over plain input
 *  (5m writes +0.25×, 1h writes +1×; TTL-unknown writes billed as 5m, like pricing.rs). */
export function cacheNetSavings(model: string, input: number, cacheRead: number, w5m: number, w1h: number, promptTokens?: number): number {
  const p = promptTokens ?? input + cacheRead + w5m + w1h;
  const [ip] = modelPrices(model, p);
  return cacheSavings(model, input, cacheRead, w5m, w1h, p) - (w5m / 1e6) * ip * 0.25 - (w1h / 1e6) * ip * 1.0;
}
