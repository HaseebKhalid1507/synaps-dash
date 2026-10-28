# synaps·dash telemetry — API contract (v1)

Source of truth for the store worker (implements) and the UI worker (consumes).
If the store worker must change a shape, it updates THIS file and the change is
called out in its report. All endpoints: GET, JSON, behind synaps-dash's existing
token cookie (`tokenOk`), same as `/api/models`. All money is USD at API list price
(estimate, see pricing.ts) — the UI labels it "API-equivalent".

Common query params: `from`, `to` (unix ms, optional; default = all time),
`host` (`bella`|`jade`|omitted = all). Day buckets are LOCAL days (America/New_York,
the machine's TZ) as `YYYY-MM-DD` strings. Any metric with no data is `null`, never 0.

## GET /api/telemetry/summary
```json
{ "generated_at": 1793163608349,
  "now":   { "spend_today": 41.2, "burn_rate_per_hour": 3.9, "requests_today": 122,
             "hit_pct_1h": 98.4, "ttft_p50_ms_1h": 480, "total_p50_ms_1h": 3800,
             "live_sessions": 4, "live_workers": 2 },
  "all":   { "spend": 53679.0, "requests": 87994, "sessions": 1138,
             "first_ts": 1775800000000, "last_ts": 1793163608349,
             "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 },
             "saved_by_cache": 412000.0 } }
```
`live_*`: from the daemon session list if the extension has it, else `null`.
`saved_by_cache` = cost if every cache_read token had been billed as fresh input minus actual.

## GET /api/telemetry/spend?bucket=day&group=model|role|host
```json
{ "bucket": "day", "group": "model",
  "series": [ { "key": "claude-opus-5-5", "points": [ ["2026-10-27", 812.4], ... ] } ],
  "grain":  [ ["2026-04-10", "session"], ["2026-06-12", "request"] ] }
```
`role` keys: `main` | `worker`. `grain` marks where data switches from session-level
(sessions/*.json + legacy log) to request-level (api-log). Points are sparse-free:
every day in range present for every series (0 allowed here — it is a sum).

## GET /api/telemetry/agents
```json
{ "agents": [ { "name": "spike", "runs": 212, "requests": 9100, "spend": 812.0,
                "models": ["claude-opus-5-5"] } ] }
```

## GET /api/telemetry/cache
```json
{ "daily": [ { "day": "2026-10-27", "hit_pct": 96.7, "read": 0, "write_5m": 0, "write_1h": 0,
               "fresh_input": 0 } ],
  "miss_reasons": [ { "reason": "messages_changed", "count": 238 } ],
  "keepwarm": { "pings": 185, "cost": 1.2, "est_saved": 9.8 },
  "releases": [ { "tag": "v0.9.0", "ts": 1790000000000 } ] }
```
`releases`: git tags from the SynapsCLI repo if readable (`~/Projects/agent-runtime`), else `[]`.

## GET /api/telemetry/latency?model=<optional>
```json
{ "daily": [ { "day": "2026-10-27", "ttft_p50": 480, "ttft_p95": 1900, "ttft_p99": 4200,
               "total_p50": 3800, "total_p95": 21600, "n": 5358 } ],
  "split":   { "headers_p50": 300, "first_event_p50": 480, "stream_p50": 8000 },
  "retries": { "requests_with_retry": 41, "rate_pct": 0.7 },
  "by_context": [ [121862, 8550], ... ] }
```
TTFT: api-log `ttft_ms` is broken (0 in ~99%); treat 0 as null and use trace
`outcome.timings.first_model_event_ms` where joined. `by_context` = up to 2000 sampled
`[wire_bytes|estimated_prompt_tokens, total_ms]` pairs for a scatter.

## GET /api/telemetry/sessions?sort=cost|updated|requests&limit=50&offset=0&q=
```json
{ "total": 1138,
  "rows": [ { "id": "20261024-084934-ca0d", "host": "bella", "title": "…", "model": "claude-opus-5-5",
              "created": 1793000000000, "updated": 1793000090000, "requests": 412,
              "spend": 18.4, "hit_pct": 97.1, "peak_context_tokens": 180000, "workers": 3 } ] }
```

## GET /api/telemetry/session/:id
```json
{ "session": { …row… },
  "timeline": [ { "ts": 0, "context_tokens": 0, "output": 0, "hit_pct": 0, "total_ms": 0,
                  "ttft_ms": null, "stop": "tool_use", "worker": false, "compaction": false } ],
  "workers": [ { "handle": "sa_1", "agent": "redactor-fix", "model": "…", "spend": 2.1 } ] }
```
`context_tokens` = input + cache_read + cache_write. `compaction` = true when
context_tokens drops > 40% vs the previous main-session request.
Request-level timeline only exists where api-log rows link to the session (trace join,
or session_id once the Synaps telemetry PR lands); otherwise `timeline: []`.

## GET /api/telemetry/heatmap
```json
{ "cells": [ [0, 0, 12], ... ] }
```
`[weekday 0=Mon..6=Sun, hour 0..23, requests]`, local time, all 168 cells present.

## GET /api/telemetry/health
```json
{ "stops": [ { "stop": "refusal", "count": 92 } ],
  "refusal_retries": 67, "translation_losses": 0, "tools_changed_misses": 23,
  "ingest": { "last_run": 0, "rows": { "requests": 0, "traces": 0, "sessions": 0, "workers": 0, "legacy": 0 },
              "errors": 0, "skipped_files": 158, "sources": [ { "host": "bella", "path": "…", "offset": 0 } ] } }
```

## Store v1 notes (feat/telemetry-store), all additive, no shape above changed

Errors: `400 {"error"}` bad param, `404 {"error"}` unknown session/path, `405` non-GET,
`503 {"error"}` telemetry disabled/starting, `500 {"error"}` query failure.

- **Cutover / grain.** Request-level data starts at the first api-log row *in the host scope*
  (all hosts: jade 2026-06-12; `host=bella`: 2026-09-20). Sessions created before that are
  accounted at session grain (their `session_cost`, on their `created` local day, role `main`);
  later sessions are covered by api-log rows. `summary.all.spend/tokens/saved_by_cache` and
  `spend` use that split. So `all.spend` is **not** the raw Σ session_cost (~$53.7K): today
  it is ≈ $47.3K, because the api-log sums lower than session_cost after the cutover (jade
  never logged worker requests to api-log, and some sessions weren't api-logged).
- `summary.now.burn_rate_per_hour` = spend in the trailing 60 min. `live_sessions` /
  `live_workers` are `null` for now (the extension doesn't hold the daemon session list).
- `spend`: only `bucket=day`. Range = first..last data day, widened to `from`/`to` if given.
- `agents`: `runs` = worker archives per `meta.agent_name` (bella only; the jade snapshot has
  no subagent-history). `requests`/`spend` are `null` until api-log rows carry worker identity
  (the Synaps telemetry PR); nothing on disk links a worker's requests to its agent today.
- `cache.daily[]` rows get `"grain": "request" | "legacy"`. Legacy rows (days before the
  cutover, from `synaps.log.*` `Token Usage:` lines) have `write_5m: null`, `write_1h: null`
  and an extra `write` (the un-split cache_create total).
- `cache.keepwarm.est_saved` = Σ over pings of cache_read × input price × (1.25 − read
  multiplier): the 5m rewrite the next turn would have paid without the ping. Gross, not net
  of `cost`. `cost`/`est_saved` are `null` when there were no pings.
- `latency`: api-log `ttft_ms` < 50 ms is treated as null too (the bug yields 0 in ~99%, and
  1–40 ms in the rest). TTFT = trace `first_model_event_ms` where joined, else api-log
  `ttft_ms`. `split.stream_p50` = `stream_end_ms − first_model_event_ms`. `retries` counts
  requests with api-log `attempt > 1` or trace `retries[]` non-empty. `by_context` x = prompt
  tokens (input + cache_read + cache_write), evenly strided over time.
- `sessions`: `from`/`to` select sessions *overlapping* the range. `spend` = the session
  file's `session_cost`. `hit_pct` from the session's own totals (`null` for old files without
  cache totals). `requests` / `peak_context_tokens` are `null` unless api-log rows link to the
  session (forward-compat `session_id` / worker `parent_session_id`). The trace `session_id`
  is a runtime id (`session-<pid>-<ms>`), not a session-file id, so the trace join can't link.
  `workers` = subagent archives referenced by the session's `archive_path` tool results.
- `session/:id` `timeline` follows the same linkage (`[]` until session_id lands);
  `workers[].spend` is `null` until requests carry the worker handle.
- `health.translation_losses` counts loss entries whose `action` isn't `"synthesized"` (every
  trace synthesizes a system segment; that's not a loss). `stops[].stop` is `"none"` for rows
  without a stop_reason. `ingest` adds `last_run_ms`, `bad_lines` (malformed source lines),
  `last_error`. `sources[]` adds `kind` and `size`; `synaps.log.*` files are folded into one
  entry per host (`path` ends `synaps.log.*`, `offset`/`size` summed, `files`).
- Host label of the local machine = plugin config `telemetry_host` (default: short hostname,
  `parabellum` on bella). Set `extension.synaps-dash.telemetry_host = bella`.
