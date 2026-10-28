// Cases lifted from agent-core/src/pricing.rs's own tests, plus real api-log records.
import { test, expect } from "bun:test";
import { cost, costSplit, costOptionalSplit, cacheReadMultiplier, isVersion } from "../../telemetry/pricing.ts";
import { parseApiLog } from "../../telemetry/parse.ts";

test("list prices (1M in + 1M out)", () => {
  for (const [m, want] of [
    ["claude-fable-5", 60], ["claude-opus-4-5", 30], ["claude-opus-5", 30], ["claude-opus-4-8", 30], ["claude-opus-5-5", 24],
    ["claude-opus-4-1", 90], ["claude-opus-4-20250514", 90], ["claude-3-opus-20240229", 90], ["anthropic.claude-opus-4-1-20250805-v1:0", 90],
    ["claude-sonnet-4-6", 18], ["claude-sonnet-5", 12], ["anthropic/claude-sonnet-5", 12], ["claude-sonnet-5-5", 12], ["claude-sonnet-5-1", 18],
    ["claude-3-5-haiku", 4.8], ["haiku-3.5", 4.8], ["claude-3-haiku-20240307", 1.5], ["haiku-30", 6], ["claude-haiku-4-5-20251001", 6],
    ["gpt-99-turbo", 18], ["inferx/deepseek-v4-flash", 0],
  ] as [string, number][]) expect(cost(m, 1e6, 1e6, 0, 0)).toBeCloseTo(want, 9);
});

test("cache-read multipliers", () => {
  for (const [m, want] of [["claude-fable-5-1", 0.25], ["claude-mythos-5-1", 0.25], ["claude-opus-5-5", 0.2], ["claude-sonnet-5-5", 0.1], ["claude-opus-4-7", 0.5], ["claude-fable-5", 1], ["gpt-99-turbo", 0.3]] as [string, number][])
    expect(cost(m, 0, 0, 1e6, 0)).toBeCloseTo(want, 9);
  expect(cacheReadMultiplier("opus-5-50")).toBe(0.1);
  expect(cacheReadMultiplier("fable-5.10")).toBe(0.1);
  expect(isVersion("opus-5.5", "opus-5-5")).toBe(true);
});

test("TTL split: 5m = 1.25×, 1h = 2×; optional split assigns remainder to 1h", () => {
  expect(costSplit("claude-sonnet-5", 0, 0, 0, 1e6, 0)).toBeCloseTo(2.5, 9);
  expect(costSplit("claude-sonnet-5", 0, 0, 0, 0, 1e6)).toBeCloseTo(4, 9);
  expect(costOptionalSplit("claude-haiku-5.5", 60_000, 1000, 0, 40_001, 10_000, null)).toBe(costSplit("claude-haiku-5.5", 60_000, 1000, 0, 10_000, 30_001));
  expect(costOptionalSplit("claude-haiku-5.5", 60_000, 1000, 0, 40_001, null, null)).toBe(cost("claude-haiku-5.5", 60_000, 1000, 0, 40_001));
});

test("Haiku 5.5 long-prompt tier at > 100k prompt tokens", () => {
  expect(cost("claude-haiku-5-5", 100_000, 1000, 0, 0)).toBeCloseTo(0.0105, 12);
  expect(costSplit("claude-haiku-5-5", 40_000, 0, 50_000, 10_000, 0)).toBeCloseTo(0.00575, 12);
  expect(cost("claude-haiku-5-5", 100_001, 0, 0, 0)).toBeCloseTo(0.100001 * 0.5, 12);
  expect(costSplit("claude-haiku-5-5", 1000, 1e6, 90_000, 0, 10_000)).toBeCloseTo(0.0005 + 0.0045 + 0.01 + 2.5, 12);
});

test("real api-log records", () => {
  // bella, 2026-10-27, opus 5.5 worker turn, 5m writes
  const a = parseApiLog('{"ts":1793164237663,"request_id":"req_011CgU4QUMUz9TxPcp8BLBPh","model":"claude-opus-5-5","attempt":1,"ttft_ms":0,"total_ms":2732,"stop_reason":"tool_use","usage":{"input":2,"output":213,"cache_read":40519,"cache_write":2863,"cache_write_5m":2863,"cache_write_1h":0,"hit_pct":93.4},"context":{"messages":19,"tools":22,"system_bytes":2567,"breakpoints":[18]},"worker":true}', "bella")!;
  expect(a.cost).toBeCloseTo((2 * 4 + 40519 * 0.2 + 2863 * 5 + 213 * 20) / 1e6, 12); // $0.0265498
  // opus 5.5 with 1h writes
  const b = parseApiLog('{"ts":1790796920866,"request_id":"req_011CfaBhGjaECm7gqU4BaLPy","model":"claude-opus-5-5","attempt":1,"ttft_ms":0,"total_ms":2872,"stop_reason":"tool_use","usage":{"input":64,"output":387,"cache_read":625508,"cache_write":823,"cache_write_5m":0,"cache_write_1h":823},"context":{}}', "bella")!;
  expect(b.cost).toBeCloseTo((64 * 4 + 625508 * 0.2 + 823 * 8 + 387 * 20) / 1e6, 12);
  // sonnet 4.6 (jade era), 0.1× reads
  const c = parseApiLog('{"ts":1789880411400,"request_id":"req_011CfE6sUQAdrxtJs2zs5Eok","model":"claude-sonnet-4-6","attempt":1,"ttft_ms":0,"total_ms":3061,"stop_reason":"end_turn","usage":{"input":10,"output":157,"cache_read":2821,"cache_write":619,"cache_write_5m":619,"cache_write_1h":0},"context":{}}', "jade")!;
  expect(c.cost).toBeCloseTo((10 * 3 + 2821 * 0.3 + 619 * 3.75 + 157 * 15) / 1e6, 12);
});
