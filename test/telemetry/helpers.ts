import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const FIXTURES = join(import.meta.dir, "fixtures");

/** Fresh copy of the fixture roots + a db path, all under /tmp. */
export function sandbox(): { dir: string; db: string; bella: string; jade: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), "synaps-telemetry-test-"));
  cpSync(FIXTURES, join(dir, "src"), { recursive: true });
  return { dir, db: join(dir, "t.db"), bella: join(dir, "src", "bella"), jade: join(dir, "src", "jade"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A synthetic home-layout-free source root with `n` api-log rows over `days` days (for load tests). */
export function synthRoot(dir: string, n: number, days = 200, end = Date.parse("2026-10-27T16:00:00Z")): string {
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const cache = join(dir, "cache");
  mkdirSync(cache, { recursive: true });
  const models = ["claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"];
  const stops = ["tool_use", "tool_use", "end_turn", "max_tokens", "refusal"];
  const step = (days * 86_400_000) / n;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(JSON.stringify({
      ts: Math.round(end - i * step), request_id: `req_syn${i}`, model: models[i % 5], attempt: i % 97 === 0 ? 2 : 1, ttft_ms: i % 3 ? 0 : 200 + (i % 4000),
      total_ms: 500 + ((i * 7919) % 60_000), stop_reason: stops[i % 5],
      usage: { input: i % 50, output: 100 + (i % 900), cache_read: 1000 * (i % 300), cache_write: 500 + (i % 2000), cache_write_5m: i % 2 ? 500 + (i % 2000) : 0, cache_write_1h: i % 2 ? 0 : 500 + (i % 2000) },
      context: { messages: i % 400, tools: 20, system_bytes: 3000 }, ...(i % 5 === 0 ? { worker: true } : {}), ...(i % 211 === 0 ? { cache_diag: { miss_reason: "tools_changed" } } : {}),
    }));
  }
  writeFileSync(join(cache, "api-log.jsonl"), out.join("\n") + "\n");
  return dir;
}
