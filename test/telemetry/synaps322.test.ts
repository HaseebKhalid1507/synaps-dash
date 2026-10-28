// Records in exactly SynapsCLI #322's api-log shape (feat/telemetry-fields): persisted session_id,
// runtime_session_id/turn_id/trace_request_id, flat worker identity, cost_usd, send-based timings.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../telemetry/schema.ts";
import { ingestOnce, resolveRoot, generations } from "../../telemetry/ingest.ts";
import { TelemetryQuery } from "../../telemetry/query.ts";
import { parseApiLog } from "../../telemetry/parse.ts";
import { sandbox } from "./helpers.ts";

// verbatim from the #322 PR body ("After: one real request with this branch's debug binary")
const MAIN = `{"ts":1793166098184,"request_id":"req_011CgU6mofA3iRUyvJHPuxCT","msg_id":"msg_011CgU6moqKjnbedxMi3dz9H","model":"claude-haiku-4-5","attempt":1,"ttft_ms":626,"total_ms":802,"stop_reason":"end_turn","usage":{"input":10,"output":41,"cache_read":0,"cache_write":7260,"cache_write_5m":7260,"cache_write_1h":0,"hit_pct":0.0},"cost_usd":0.00929,"context":{"messages":1,"tools":27,"system_bytes":202,"breakpoints":[0]},"session_id":"20261028-054137-d610","runtime_session_id":"session-1628584-1793166097321","turn_id":"turn-1628584-0","trace_request_id":"req-1628584-0"}`;
// a worker record per #322 §3 (worker:true + flat worker_agent/worker_handle/parent ids; no own session_id)
const WORKER = `{"ts":1793166099500,"request_id":"req_011CgU6wrk0000000000000001","msg_id":"msg_011CgU6wrk0000000000000001","model":"claude-opus-5-5","attempt":1,"ttft_ms":30,"total_ms":1900,"stop_reason":"tool_use","usage":{"input":4,"output":200,"cache_read":40000,"cache_write":3000,"cache_write_5m":3000,"cache_write_1h":0,"hit_pct":93.0},"cost_usd":0.0202,"context":{"messages":3,"tools":22,"system_bytes":2567,"breakpoints":[2]},"worker":true,"worker_agent":"spike","worker_handle":"sa_7","parent_session_id":"20261028-054137-d610","parent_runtime_session_id":"session-1628584-1793166097321","runtime_session_id":"session-1628584-1793166099001","turn_id":"turn-1628584-1","trace_request_id":"req-1628584-1"}`;
// pre-#322 row from the same PR body ("Before"), for the timing contrast
const OLD = `{"ts":1793164206881,"request_id":"req_011CgU4N9oxtxUw6H7dm5Rsg","msg_id":"msg_011CgU4NA1cpGpbU3HbmEM11","model":"claude-opus-5-5","attempt":1,"ttft_ms":30,"total_ms":3271,"stop_reason":"tool_use","usage":{"input":2,"output":451,"cache_read":10851,"cache_write":12281,"cache_write_5m":12281,"cache_write_1h":0,"hit_pct":46.9},"context":{"messages":5,"tools":22,"system_bytes":2567,"breakpoints":[4]},"worker":true}`;
const TRACE = JSON.stringify({ schema: "synaps-request-trace/1", session_id: "session-1628584-1793166097321", turn_id: "turn-1628584-0", request_id: "req-1628584-0", attempt: 1, model: "anthropic/claude-haiku-4-5", anatomy: { message_count: 1 }, wire: { byte_len: 30000 }, translation_losses: [], outcome: { timings: { send_start_unix_ms: 1793166097380, headers_ms: 626, first_byte_ms: 626, first_model_event_ms: 626, stream_end_ms: 802 }, retries: [], provider_request_id: "req_011CgU6mofA3iRUyvJHPuxCT", http_status: 200, stop_reason: "end_turn" } });

let sb: ReturnType<typeof sandbox>;
let q: TelemetryQuery;
beforeAll(() => {
  sb = sandbox();
  const root = join(sb.dir, "h322");
  mkdirSync(join(root, "cache"), { recursive: true });
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, "cache", "api-log.jsonl"), [OLD, MAIN, WORKER].join("\n") + "\n");
  writeFileSync(join(root, "cache", "request-trace.jsonl"), TRACE + "\n");
  writeFileSync(join(root, "sessions", "20261028-054137-d610.json"), JSON.stringify({ id: "20261028-054137-d610", title: "↳ ↳ smoke", model: "anthropic/claude-haiku-4-5", created_at: "2026-10-28T05:41:37Z", updated_at: "2026-10-28T05:41:45Z", total_input_tokens: 10, total_output_tokens: 41, session_cost: 0.0093, message_count: 2, api_messages: [] }));
  const db = openDb(sb.db);
  ingestOnce(db, [resolveRoot("bella", root)]);
  q = new TelemetryQuery(db);
}, 60_000);
afterAll(() => sb.done());

test("#322 fields parse: persisted vs runtime ids, flat worker identity, cost_usd kept beside ours", () => {
  const m = parseApiLog(MAIN, "bella")!;
  expect([m.session_id, m.runtime_session_id, m.turn_id, m.trace_request_id, m.sid, m.worker]).toEqual(["20261028-054137-d610", "session-1628584-1793166097321", "turn-1628584-0", "req-1628584-0", "20261028-054137-d610", 0]);
  expect(m.cost_reported).toBe(0.00929);
  expect(m.cost).toBeCloseTo(0.00929, 5); // same pricing source: our number agrees with theirs
  const w = parseApiLog(WORKER, "bella")!;
  expect([w.worker, w.agent, w.handle, w.parent_session, w.parent_runtime_session_id, w.session_id, w.sid]).toEqual([1, "spike", "sa_7", "20261028-054137-d610", "session-1628584-1793166097321", null, "20261028-054137-d610"]);
});

test("timing marker: #322 rows' ttft trusted as-is (no 50 ms floor); old rows floored", () => {
  expect(parseApiLog(WORKER, "bella")!.ttft_ms).toBe(30); // has runtime_session_id
  expect(parseApiLog(OLD, "bella")!.ttft_ms).toBeNull(); // no marker: 30 ms is the old bug
  expect(parseApiLog(MAIN.replace('"ttft_ms":626', '"ttft_ms":0'), "bella")!.ttft_ms).toBeNull(); // 0 is still "no event"
  expect(parseApiLog(MAIN.replace('"ttft_ms":626,', ""), "bella")!.ttft_ms).toBeNull(); // absent
  expect([parseApiLog(MAIN, "bella")!.timing_v2, parseApiLog(OLD, "bella")!.timing_v2]).toEqual([1, 0]);
});

test("per-session request linkage lights up: requests, peak context, timeline, worker spend", () => {
  const s = q.sessions({}, "updated", 10, 0, null).rows.find((r: any) => r.id === "20261028-054137-d610")!;
  expect(s).toMatchObject({ requests: 2, peak_context_tokens: 43004, title: "smoke", title_raw: "↳ ↳ smoke" });
  const d = q.session("20261028-054137-d610")!;
  expect(d.timeline.map((t: any) => [t.worker, t.ttft_ms, t.total_ms])).toEqual([[false, 626, 802], [true, 30, 1900]]);
  const w = q.db.query("SELECT SUM(cost) c FROM requests WHERE handle = 'sa_7'").get() as any;
  // the archive isn't on disk here, so the session's worker list comes only from links; spend per handle via requests
  expect(w.c).toBeGreaterThan(0);
});

test("agent spend lights up from worker_agent", () => {
  const spike = q.agents({}).agents.find((a: any) => a.name === "spike")!;
  expect(spike.requests).toBe(1);
  expect(spike.spend).toBeCloseTo(parseApiLog(WORKER, "bella")!.cost, 4);
  expect(spike.models).toEqual(["claude-opus-5-5"]);
});

test("N log generations (telemetry_log_generations): X.N … X.1, X read oldest first", () => {
  const root = join(sb.dir, "gens");
  mkdirSync(join(root, "cache"), { recursive: true });
  const p = join(root, "cache", "api-log.jsonl");
  const rec = (i: number) => MAIN.replace("req_011CgU6mofA3iRUyvJHPuxCT", `req_gen${i}`) + "\n";
  writeFileSync(p + ".3", rec(1)); writeFileSync(p + ".2", rec(2)); writeFileSync(p + ".1", rec(3)); writeFileSync(p, rec(4));
  writeFileSync(p + ".bak", rec(9)); writeFileSync(p + ".101", rec(9));
  expect(generations(p).map((x) => x.slice(p.length))).toEqual([".3", ".2", ".1", ""]);
  const db = openDb(join(sb.dir, "gens.db"));
  expect(ingestOnce(db, [resolveRoot("g", root)]).requests).toBe(4);
  // a rotation shifts every generation by one: nothing re-read, the new tail picked up
  appendFileSync(p, rec(5));
  for (const [a, b] of [[".3", ".4"], [".2", ".3"], [".1", ".2"], ["", ".1"]]) renameSync(p + a, p + b);
  writeFileSync(p, rec(6));
  const st = ingestOnce(db, [resolveRoot("g", root)]);
  expect([st.requests, st.bad_lines, st.lost_bytes]).toEqual([2, 0, 0]);
});
