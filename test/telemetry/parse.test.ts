import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseApiLog, parseTrace, parseLegacy, parseSession, parseWorkerHead, archiveRefs, splitObjects, parseLine, modelKey } from "../../telemetry/parse.ts";
import { FIXTURES } from "./helpers.ts";

const lines = (p: string) => readFileSync(join(FIXTURES, p), "utf8").split("\n");

test("api-log record → row (usage, context, cost, local day)", () => {
  const r = parseApiLog(lines("bella/cache/api-log.jsonl.1")[0], "bella")!;
  expect(r.request_id).toBe("req_fx1");
  expect(r.host).toBe("bella");
  expect(r.day).toBe("2026-10-27");
  expect(r.wd).toBe(1); // Tuesday
  expect(r.hour).toBe(12); // 16:00Z = 12:00 EDT
  expect([r.input, r.output, r.cache_read, r.cache_write, r.cw5m, r.cw1h]).toEqual([10, 100, 90000, 1000, 1000, 0]);
  expect(r.ttft_ms).toBeNull(); // 0 = never measured
  expect(r.ctx_tools).toBe(20);
  expect(r.worker).toBe(0);
  expect(r.sid).toBeNull();
  // opus 5.5: 10×$4 + 90k×$4×0.05 + 1k×$4×1.25 + 100×$20, per MTok
  expect(r.cost).toBeCloseTo((10 * 4 + 90000 * 0.2 + 1000 * 5 + 100 * 20) / 1e6, 12);
  expect(r.saved).toBeCloseTo((90000 * 4 * 0.95) / 1e6, 12);
});

test("ttft below the floor is the upstream bug → null; real values kept", () => {
  expect(parseApiLog(lines("bella/cache/api-log.jsonl.1")[1], "x")!.ttft_ms).toBeNull(); // 3 ms
  const r = parseApiLog(lines("bella/cache/api-log.jsonl")[3], "x")!; // req_fx7, 812 ms
  expect(r.request_id).toBe("req_fx7");
  expect(r.ttft_ms).toBe(812);
});

test("worker / keepwarm / cache_diag / refusal flags", () => {
  const w = parseApiLog(lines("bella/cache/api-log.jsonl.1")[2], "x")!;
  expect([w.worker, w.keepwarm, w.stop]).toEqual([1, 1, "max_tokens"]);
  const d = parseApiLog(lines("bella/cache/api-log.jsonl")[0], "x")!;
  expect([d.miss_reason, d.missed_tokens, d.attempt]).toEqual(["tools_changed", 5000, 2]);
});

test("forward-compat fields: session_id, turn_id, cost_usd, worker identity", () => {
  const L = lines("bella/cache/api-log.jsonl");
  const m = parseApiLog(L[3], "x")!;
  expect([m.session_id, m.turn_id, m.cost_reported, m.sid]).toEqual(["20261027-100000-aaaa", "t1", 0.5, "20261027-100000-aaaa"]);
  const w = parseApiLog(L[4], "x")!;
  expect([w.worker, w.agent, w.handle, w.parent_session, w.sid]).toEqual([1, "spike", "sa_1", "20261027-100000-aaaa", "20261027-100000-aaaa"]);
  expect(w.cost).not.toBe(0.1); // our own price, theirs kept alongside
  expect(w.cost_reported).toBe(0.1);
});

test("glued records split; malformed lines yield nothing", () => {
  const L = lines("bella/cache/api-log.jsonl");
  expect(parseLine(L[1]).map((o) => o.request_id)).toEqual(["req_fx5", "req_fx6"]);
  expect(parseLine(L[2])).toEqual([]);
  expect(parseApiLog(L[2], "x")).toBeNull();
  expect(splitObjects('{"a":"}{"}{"b":1}')).toEqual(['{"a":"}{"}', '{"b":1}']);
});

test("trace → row; synthesized system segments are not losses", () => {
  const [a, b, c] = lines("bella/cache/request-trace.jsonl");
  const t = parseTrace(a, "bella")!;
  expect([t.key, t.provider_request_id, t.first_event_ms, t.headers_ms, t.stream_end_ms, t.retries, t.losses, t.wire_bytes, t.model])
    .toEqual(["req_fx1", "req_fx1", 480, 300, 2900, 1, 1, 120000, "claude-opus-5-5"]);
  const u = parseTrace(b, "bella")!;
  expect(u.provider_request_id).toBeNull();
  expect(u.key.startsWith("bella:session-1-")).toBe(true);
  expect(parseTrace(c, "bella")).toBeNull();
  expect(parseTrace('{"schema":"other/1"}', "bella")).toBeNull();
});

test("legacy Token Usage line", () => {
  const L = lines("bella/logs/synaps.log.2026-05-01");
  expect(parseLegacy(L[0])).toBeNull();
  const r = parseLegacy(L[1])!;
  expect(r).toEqual({ ts: Date.parse("2026-05-01T14:00:05.000Z"), day: "2026-05-01", input: 10, output: 145, cache_read: 9000, cache_create: 1000 });
  expect(parseLegacy(L[3])!.ts).toBe(Date.parse("2026-05-01T14:10:05.5Z"));
});

test("session header parse; old files have unknown (null) cache totals; junk → null", () => {
  const t = readFileSync(join(FIXTURES, "bella/sessions/20261027-100000-aaaa.json"), "utf8");
  const s = parseSession(t)!;
  expect([s.id, s.model, s.cost, s.cache_read, s.message_count]).toEqual(["20261027-100000-aaaa", "claude-opus-5-5", 12.5, 90000, 4]);
  expect(s.created).toBe(Date.parse("2026-10-27T14:00:00Z"));
  const old = parseSession(readFileSync(join(FIXTURES, "bella/sessions/20260501-100000-bbbb.json"), "utf8"))!;
  expect(old.cache_read).toBeNull();
  expect(parseSession('{"id": "trunc')).toBeNull();
  expect(parseSession('{"id":"x"}')).toBeNull(); // no created_at
  expect(archiveRefs(t)).toEqual([["1-abc", "sa_1"]]);
});

test("worker archive head only", () => {
  const h = parseWorkerHead(readFileSync(join(FIXTURES, "bella/subagent-history/1-abc/sa_2.json"), "utf8"))!;
  expect(h).toEqual({ handle: "sa_2", agent: "okarin", model: "claude-sonnet-4-6", status: "failed" });
  // a truncated read that still holds the head parses
  const full = readFileSync(join(FIXTURES, "bella/subagent-history/1-abc/sa_1.json"), "utf8");
  expect(parseWorkerHead(full.slice(0, full.indexOf(',"history"') + 15))!.agent).toBe("spike");
  expect(modelKey("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
});
