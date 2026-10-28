# synaps·dash telemetry — API contract (v1)

Source of truth for the store worker (implements) and the UI worker (consumes).
If the store worker must change a shape, it updates THIS file and the change is
called out in its report. All endpoints: GET, JSON, behind synaps-dash's existing
token cookie (`tokenOk`), same as `/api/models`. All money is USD at API list price
(estimate, see pricing.ts) — the UI labels it "API-equivalent".

Common query params: `from`, `to` (unix ms, optional; default = all time),
`host` (`bella`|`jade`|`unknown`|omitted = all; `unknown` = sessions whose origin machine can't be
told apart, see the store notes). Day buckets are LOCAL days (America/New_York,
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
             "saved_by_cache": 412000.0, "saved_by_cache_net": 396000.0 } }
```
`live_*`: from the daemon session list if the extension has it, else `null`.
`saved_by_cache` (gross) = cost if every cache_read token had been billed as fresh input minus actual.
`saved_by_cache_net` = gross minus the write premium caching costs over plain input
(5m writes +0.25×, 1h writes +1×, TTL-unknown writes as 5m). Label gross as gross in the UI.

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
{ "stops": [ { "stop": "refusal", "count": 92 }, { "stop": null, "count": 703 } ],
  "refusal_retries": 67, "translation_losses": 0, "tools_changed_misses": 23,
  "ingest": { "last_run": 0, "rows": { "requests": 0, "traces": 0, "sessions": 0, "workers": 0, "legacy": 0 },
              "errors": 0, "skipped_files": 158, "sources": [ { "host": "bella", "path": "…", "offset": 0 } ] } }
```

## Store notes (feat/telemetry-store, v2 after review). Additive only: no shape above changed

Errors: `400 {"error"}` bad param, `404 {"error"}` unknown session/path, `405` non-GET,
`503 {"error"}` telemetry disabled/starting, `500 {"error":"telemetry query failed"}` (details
go to the extension log only).

- **Session host = origin host**, decided first, not the newest copy: among hosts holding a
  copy, (1) the host whose api-log span covers `created`; else (2) the host with the most
  api-log rows + `Token Usage:` lines inside the session's window; else (3) the earliest copy
  (oldest `updated`, then file mtime at 1 s). If nothing decides (identical copies, no activity
  anywhere) the host is **`"unknown"`**, never a coin flip. `unknown` is a host value like any
  other: `host=unknown` filters to it and it appears as a `spend?group=host` series.
  Title/totals/cost come from the newest copy.
- **Grain, one decision per session.** The session is `grain: "request"` (its `session_cost` is
  not added; its spend is in api-log rows) when (a) api-log rows link to it (#322 `session_id`,
  or `parent_session_id` for its workers), or (b) unlinked (pre-#322) api-log rows **on its
  origin host** fall inside `[created, updated]` (origin `unknown`: on any host holding a copy).
  Otherwise it's `grain: "session"` and its `session_cost` counts, on its `created` local day,
  role `main`. Another host's rows never cover a session. The decision doesn't depend on the
  `host` filter, so **per-host values (including `unknown`) add up to the all-hosts value**.
- **Compaction is not in the api-log** (before or after SynapsCLI #322): compaction calls send the
  whole transcript and are billed into `session_cost`, but write no api-log record. Request-grain
  spend therefore always undercounts `session_cost`. On bella since 2026-10-01 (all workers
  api-logged by then): main-role api-log spend $3.06K vs Σ session_cost of sessions created since
  $3.58K (+$0.76K for 2 sessions spanning the date) → at least ≈ $0.52K (≈ 15%) of main-session
  spend never reaches the api-log, compaction being the known contributor.
- **api-log fields read (SynapsCLI #322).** `session_id` = persisted conversation id (the
  `sessions/<id>.json` id) → links rows to sessions; worker rows have no `session_id` but
  `parent_session_id`, so they link to the parent. `worker_agent` / `worker_handle` → agent and
  per-worker spend. `runtime_session_id` / `trace_request_id` = the trace's `session_id` /
  `request_id`; `turn_id` is per *request* (`turn-<pid>-<n>`), not per user turn. `cost_usd` is
  stored beside our own `pricing.ts` cost (we report ours). Rotated generations `X.1 … X.N`
  (`telemetry_log_generations`) are all read, oldest first.
- `summary.all.spend` = request rows + session-grain sessions. With today's data: all ≈ $50.1K
  = bella $6.8K + jade $41.3K + unknown $2.0K (they add up). Σ session_cost ≈ $53.7K =
  session-grain $25.2K + request-grain sessions $28.5K; the api-log rows sum to $24.9K, so the
  api-log under-counts the request-grain sessions by ≈ $3.6K (≈ 13%): compaction (below) and
  jade's never-api-logged worker requests.
- `summary.now.burn_rate_per_hour` = spend in the trailing 60 min. `live_sessions` /
  `live_workers` are `null` (the extension doesn't hold the daemon session list).
- `spend`: only `bucket=day`. Range = first..last data day, widened to `from`/`to`.
  `grain` = first session-grain day, first request day.
- Model keys are normalized: provider prefix (`anthropic/`) and snapshot date suffix
  (`-20251001`, `@20250805`) are dropped, so they group together; cost is unaffected.
- `agents`: `runs` = worker archives per `meta.agent_name` (bella only; the jade snapshot has
  no subagent-history). `requests`/`spend` stay `null` until api-log rows carry worker identity.
- `cache.daily[]` adds `grain` (`"request" | "legacy" | "mixed"`), `write_unknown` (writes with no
  TTL split: legacy lines and api-log rows without `cache_write_5m/1h`; `null` when none) and
  `write` (all writes). `write_5m`/`write_1h` are `null` on days with no TTL-split data. A legacy
  `Token Usage:` line counts only on a day when **its own host** has no api-log rows (otherwise
  it's the same request again: verified 5,860/5,860 line-for-line on bella 2026-10-26), so
  bella's legacy days before its api-log and in its api-log gap (09-21..09-29) are included.
  Very low legacy hit % days (e.g. 1.7% on 05-29) are real: a handful of cold-cache requests
  (writes dominate); the parser's field mapping and duplicate handling were checked.
- `cache.releases`: minor releases only (`vX.Y.0`), inside `from`/`to`. Read by the ingest worker
  (git, async), served from the store.
- `cache.keepwarm.est_saved` = Σ over pings of cache_read × input price × (1.25 − read
  multiplier): the 5m rewrite the next turn would have paid. Gross, not net of `cost`.
- `latency`, two generations of api-log timing:
  - **old rows** (no `runtime_session_id`): api-log `ttft_ms` is never used (0 in ~99%, 1–40 ms
    otherwise, and even larger values are on the post-headers clock); their TTFT is the trace's
    `first_model_event_ms` when joined, else null. Their `total_ms` was measured from the
    *response headers*;
  - **SynapsCLI #322 rows** (have `runtime_session_id`): `ttft_ms`/`total_ms` are measured from
    the *send* (the trace's clock) and trusted as-is; 0 or absent = no model event (null).
  So `total_p50/p95` read higher from the day #322 lands — a measurement change, not a slowdown.
  TTFT = trace `first_model_event_ms` where joined, else (new rows only) api-log `ttft_ms`.
  Daily percentiles come from log-bucketed histograms (exact < 100 ms, then 2% buckets: within
  ±1%). `split.stream_p50` = `stream_end_ms − first_model_event_ms`. `retries` counts requests
  with `attempt > 1` or a non-empty trace `retries[]`. `by_context` x = prompt tokens
  (input + cache_read + cache_write), a rowid-strided sample (≤ 2000).
- `sessions`: `from`/`to` select sessions *overlapping* the range. Rows add `grain` and
  `title_raw`; `title` has leading `↳` chain markers stripped. `spend` = the session's
  `session_cost` (`null` when the file has none). `hit_pct` from the session's own totals
  (`null` for old files without cache totals). `requests` / `peak_context_tokens` are `null`
  unless api-log rows link to the session (forward-compat `session_id` / worker
  `parent_session_id`); the trace `session_id` is a runtime id, so the trace join can't link.
  `workers` = distinct subagent archives referenced by `archive_path` tool results.
- `session/:id` `timeline` follows the same linkage (`[]` until session_id lands);
  `workers[].spend` is `null` until requests carry the worker handle.
- `health.stops[].stop` is `null` for rows without a stop_reason. `translation_losses` counts loss
  entries whose `action` isn't `"synthesized"`. `ingest` adds `last_run_ms`, `bad_lines`,
  `lost_bytes` (a lower bound on log bytes that rotated away unread), `last_error`;
  `skipped_files` includes symlinks/FIFOs (never followed). `sources[]` adds `kind`, `size`;
  `synaps.log.*` files fold into one entry per host (`path` ends `synaps.log.*`, `files`).
- Local host label = plugin config `telemetry_host` (default: short hostname, `parabellum` on
  bella): set `extension.synaps-dash.telemetry_host = bella`. Profile daemons have telemetry off
  unless `telemetry = on`, and then use `telemetry-<profile>.db`. The telemetry plugin keys have
  no manifest default: Synaps passes a default as if it were configured, so a profile daemon
  must stay "unset". A profile daemon reads its own `<base>/<profile>/sessions` (plus the shared
  `~/.cache/synaps` api-log/trace), so its `host` values and session counts differ from the
  main store's. A `telemetry_sources` entry named like `telemetry_host` replaces the own sources
  (how to point a sandbox at the main data on purpose; see the README).
