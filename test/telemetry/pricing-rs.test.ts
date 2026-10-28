// Every #[test] in agent-core/src/pricing.rs @ a9e9840c, ported 1:1 (same names, same cases).
// u64 note: JS numbers are doubles, so u64::MAX is 2^64 (inexact). The Rust cases assert that
// optional_split == split(billed5, billed1) and that the result is finite and > 0; both hold
// with doubles because every intermediate stays finite and remainder clamps at 0 like
// saturating_sub. Run the same assertions on the same values.
import { test, expect } from "bun:test";
import { cost, costSplit, costOptionalSplit, cacheReadMultiplier, isLegacyOpus } from "../../telemetry/pricing.ts";
import { parseApiLog } from "../../telemetry/parse.ts";

const U64_MAX = 18446744073709551615; // rounds to 2^64

test("optional_split_preserves_aggregate_known_ttls_and_request_tier", () => {
  // (input, aggregate, reported 5m, reported 1h, billed 5m, billed 1h)
  const cases: [number, number, number | null, number | null, number, number][] = [
    [0, 100_001, 0, null, 0, 100_001],
    [0, 100_001, null, 0, 0, 100_001],
    [60_000, 40_000, 10_000, null, 10_000, 30_000],
    [60_000, 40_001, 10_000, null, 10_000, 30_001],
    [60_000, 40_001, null, 10_000, 0, 40_001],
    [60_000, 40_001, 10_000, 10_000, 10_000, 30_001],
    [60_000, 1, 20_000, 20_001, 20_000, 20_001],
    [60_000, 1, 40_001, null, 40_001, 0],
    [60_000, 40_001, 40_001, null, 40_001, 0],
    [60_000, 40_001, null, 40_001, 0, 40_001],
    [60_000, 40_001, 10_000, 30_001, 10_000, 30_001],
    [0, U64_MAX, 1, null, 1, U64_MAX - 1],
    [0, 1, U64_MAX, U64_MAX, U64_MAX, U64_MAX],
  ];
  for (const [input, aggregate, c5, c1, b5, b1] of cases) {
    const actual = costOptionalSplit("claude-haiku-5.5", input, 1000, 0, aggregate, c5, c1);
    expect(actual).toBe(costSplit("claude-haiku-5.5", input, 1000, 0, b5, b1));
    expect(Number.isFinite(actual) && actual > 0).toBe(true);
  }
  expect(costOptionalSplit("claude-haiku-5.5", 60_000, 1000, 0, 40_001, null, null)).toBe(cost("claude-haiku-5.5", 60_000, 1000, 0, 40_001));
});

test("historical_haiku_3_is_bounded_and_not_haiku_3_5", () => {
  for (const m of ["claude-3-haiku", "claude-3-haiku-20240307", "haiku-3", "claude-haiku-3@20240307", "anthropic.claude-3-haiku-20240307-v1:0"]) {
    expect(cost(m, 1e6, 0, 0, 0)).toBe(0.25);
    expect(cost(m, 0, 1e6, 0, 0)).toBe(1.25);
  }
  for (const m of ["claude-3-5-haiku", "claude-3.5-haiku", "haiku-3-5", "haiku-3.5"]) expect(cost(m, 1e6, 1e6, 0, 0)).toBe(4.8);
  for (const m of ["haiku-30", "haiku-3garbage", "3-haikuish", "not3-haiku", "claude-3-haiku-20240307oops"]) expect(cost(m, 1e6, 1e6, 0, 0)).toBe(6);
});

test("version_aliases_preserve_prices_and_cache_rates", () => {
  for (const m of ["github-copilot/claude-opus-4.8", "claude-opus-4.7", "claude-opus-4-8", "claude-opus-4-7"]) expect(cost(m, 1e6, 1e6, 0, 0)).toBe(30);
  for (const m of ["claude-opus-4.1", "claude-opus-4-1", "claude-opus-4-20250514", "claude-opus-4.1@20250805", "anthropic.claude-opus-4-1-20250805-v1:0", "claude-3-opus-20240229"])
    expect(cost(m, 1e6, 1e6, 0, 0)).toBe(90);
  for (const [dotted, dashed] of [["opus-5.5", "opus-5-5"], ["sonnet-5.5", "sonnet-5-5"], ["haiku-5.5", "haiku-5-5"], ["fable-5.1", "fable-5-1"], ["mythos-5.1", "mythos-5-1"], ["haiku-3.5", "haiku-3-5"]]) {
    expect(costSplit(dotted, 60_000, 1000, 20_000, 5000, 10_000)).toBe(costSplit(dashed, 60_000, 1000, 20_000, 5000, 10_000));
    expect(cacheReadMultiplier(dotted)).toBe(cacheReadMultiplier(dashed));
  }
  for (const m of ["opus-4garbage", "opus-4.10", "opus-4-1oops", "opus-4-12345678oops", "opus-30", "notopus-4", "3-opusish"]) expect(isLegacyOpus(m)).toBe(false);
  expect(cacheReadMultiplier("opus-5-50")).toBe(0.1);
  expect(cacheReadMultiplier("fable-5.10")).toBe(0.1);
});

const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);
test("fable_pricing", () => near(cost("claude-fable-5", 1e6, 1e6, 0, 0), 60));
test("opus_pricing", () => near(cost("claude-opus-4-5", 1e6, 1e6, 0, 0), 30));
test("sonnet_pricing", () => near(cost("claude-sonnet-4-5", 1e6, 1e6, 0, 0), 18));
test("haiku_pricing", () => near(cost("claude-haiku-4-5", 1e6, 1e6, 0, 0), 6));
test("cache_read_bills_at_tenth_input_rate", () => near(cost("claude-sonnet-4-5", 0, 0, 1e6, 0), 0.3));
test("cache_creation_bills_at_125_percent_input_rate", () => near(cost("claude-sonnet-4-5", 0, 0, 0, 1e6), 3.75));
test("cache_write_1h_bills_at_double_input_rate", () => near(costSplit("claude-sonnet-4-5", 0, 0, 0, 0, 1e6), 6));
test("split_mixes_5m_and_1h_rates", () => near(costSplit("claude-sonnet-4-5", 0, 0, 0, 1e6, 1e6), 9.75));
test("wrapper_equals_split_with_zero_1h", () => {
  for (const [m, i, o, r, w] of [["claude-sonnet-4-5", 1000, 2000, 3000, 4000], ["claude-opus-4-5", 0, 0, 0, 1e6], ["claude-haiku-4-5", 123, 456, 789, 1011], ["gpt-99-turbo", 50, 60, 70, 80], ["claude-fable-5", 0, 0, 0, 0]] as [string, number, number, number, number][])
    near(cost(m, i, o, r, w), costSplit(m, i, o, r, w, 0), 1e-12);
});
test("inferx_deepseek_v4_flash_is_free", () => expect(cost("inferx/deepseek-v4-flash", 1e6, 1e6, 0, 0)).toBe(0));
test("unknown_model_falls_back_to_sonnet", () => near(cost("gpt-99-turbo", 1e6, 0, 0, 0), cost("claude-sonnet-4-5", 1e6, 0, 0, 0)));
test("zero_usage_is_zero_cost", () => expect(cost("claude-opus-4-5", 0, 0, 0, 0)).toBe(0));
test("opus_4_and_4_1_are_legacy_priced", () => {
  for (const m of ["claude-opus-4-0", "claude-opus-4-20250514", "claude-opus-4-1", "claude-opus-4-1-20250805", "claude-opus-4", "claude-3-opus-20240229", "claude-opus-4-1@20250805", "claude-opus-4@20250514", "claude-opus-4-0@20250514", "anthropic.claude-opus-4-1-20250805-v1:0", "anthropic.claude-opus-4-20250514-v1:0"])
    near(cost(m, 1e6, 1e6, 0, 0), 90);
  for (const m of ["claude-opus-4-5", "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-4-5@20251101", "claude-opus-4-6@20260101", "anthropic.claude-opus-4-5-20251101-v1:0"])
    near(cost(m, 1e6, 1e6, 0, 0), 30);
});
test("documented_cache_read_multipliers", () => {
  for (const [m, want] of [["claude-fable-5-1", 0.25], ["claude-mythos-5-1", 0.25], ["claude-opus-5-5", 0.2], ["claude-sonnet-5-5", 0.1], ["claude-opus-4-7", 0.5], ["claude-fable-5", 1], ["gpt-99-turbo", 0.3]] as [string, number][])
    near(cost(m, 0, 0, 1e6, 0), want);
});
test("sonnet_5_is_two_and_ten", () => {
  for (const m of ["claude-sonnet-5", "claude-sonnet-5@20260101", "claude-sonnet-5-20260101", "anthropic/claude-sonnet-5"]) {
    near(cost(m, 1e6, 1e6, 0, 0), 12);
    near(cost(m, 0, 0, 1e6, 0), 0.2);
    near(costSplit(m, 0, 0, 0, 1e6, 0), 2.5);
    near(costSplit(m, 0, 0, 0, 0, 1e6), 4);
  }
  near(cost("claude-sonnet-5-5", 1e6, 1e6, 0, 0), 12);
  near(cost("claude-sonnet-4-6", 1e6, 1e6, 0, 0), 18);
  near(cost("claude-sonnet-5-1", 1e6, 1e6, 0, 0), 18);
});
test("haiku_5_5_low_tier_up_to_100k_prompt", () => {
  near(cost("claude-haiku-5-5", 100_000, 1000, 0, 0), 0.0105, 1e-12);
  near(costSplit("claude-haiku-5-5", 40_000, 0, 50_000, 10_000, 0), 0.00575, 1e-12);
});
test("haiku_5_5_high_tier_over_100k_prompt", () => {
  near(cost("claude-haiku-5-5", 100_001, 0, 0, 0), 0.100001 * 0.5, 1e-12);
  near(costSplit("claude-haiku-5-5", 1000, 1e6, 90_000, 0, 10_000), 0.0005 + 0.0045 + 0.01 + 2.5, 1e-12);
});

test("an anthropic/-prefixed (and date-suffixed) model costs exactly what the bare name does", () => {
  const rec = (model: string) => parseApiLog(JSON.stringify({ ts: 1793116800000, request_id: "r", model, usage: { input: 1234, output: 5678, cache_read: 91011, cache_write: 1213, cache_write_5m: 1000, cache_write_1h: 213 }, context: {} }), "x")!;
  for (const [a, b] of [["anthropic/claude-opus-5-5", "claude-opus-5-5"], ["anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5"], ["anthropic/claude-opus-4-1", "claude-opus-4-1-20250805"]]) {
    expect(rec(a).model).toBe(rec(b).model);
    expect(rec(a).cost).toBe(rec(b).cost);
  }
});
