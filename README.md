# synaps·dash

A sleek browser client for the [SynapsCLI](https://github.com/HaseebKhalid1507/SynapsCLI)
session daemon, shipped as a **plain extension, with zero changes to Synaps**. A browser tab
becomes an ordinary daemon client, a peer of the TUI on the same session: same event
stream, same input-ownership rules. Type in the terminal, watch it stream in the browser,
or the other way round.

```
daemon ──spawns──▶ synaps-dash (this extension) ◀── HTTP/WS 127.0.0.1:7717 ──▶ browser tabs
   ▲                     │
   └──── daemon.sock ◀───┘  one UDS connection per tab, as a normal client (kind "server")
```

About 3.7k lines (`web/app.js`, `main.ts`, `web/style.css`, `web/index.html`), with no
dependencies: the server uses only Bun built-ins, and the client is plain JS with no
framework and no build step.

## Features

- **Live, shared sessions.** Attach to any daemon session, see every client (TUI and web)
  as presence avatars, take over input, answer approval and secret prompts, and switch
  sessions from the rail.
- **Session rail with history.** **Live** lists sessions someone is attached to right
  now. **Recent** lists the ones nobody is on: detached sessions the daemon still holds, and
  sessions that exist only on disk. Clicking a session attaches if the daemon still has it
  in memory, or resumes it from disk (history loads, and it moves up to Live). Disk sessions
  are read header-only from `~/.synaps-cli/sessions` (`/api/sessions`), never the message
  bodies.
- **Run state in the header**, mirroring the TUI's status span: `● streaming` (pulsing on
  the TUI's ~2s cycle), `⠋ compacting…` / `⠋ connecting…` (the TUI's braille spinner, same
  speed), `○ ready`.
- **Context meter** in the status line: used vs window, measured exactly like the TUI
  (`input + cache_read + cache_create` of the last request's `Usage`), same colour thresholds
  (<50% · <75% · beyond). A fresh attach shows the daemon's estimate (`~`) until the next
  request reports. The tick marks Synaps's compaction point. Click it for details: left in the
  window, what's reserved per request (max output, thinking, next tool result, margin), and room
  before compaction by the daemon's own estimate.
- **Ambient glow that works with the agent.** The album-coloured background glow drifts
  while a turn is running and settles back when it's idle. The speed ramps up and down
  smoothly (slow start, fastest in the middle, eased finish). Only transform and opacity
  change, and nothing runs while idle, under reduced motion, or with the glow off.
- **Album-reactive palette.** Subscribes to [Myx](https://github.com/HaseebKhalid1507)'s
  MXC colour protocol (`$XDG_RUNTIME_DIR/myx/theme.sock`). The whole UI takes the current
  album's 16 colour tokens and cross-fades on track change, in sync with the TUI, the
  desktop and the lights. Falls back to the static myx palette.
- **Activity timeline.** Consecutive thinking and tool calls batch into one collapsible row
  ("Thought for 6s · 3 commands · 1 read"). Every step shares one row anatomy on a
  vertical rail.
- **Tool views.** Each tool gets its own card view, built from what Synaps actually sends:
  - **edit:** a unified diff with word-level marks, syntax colouring, `+N −M`, and long
    unchanged runs folded.
  - **write** / **read:** a numbered, highlighted file view (read shows the file's real line
    numbers).
  - **grep:** matches grouped by file, with line numbers and highlighted hits.
  - **ls** / **find:** listings.
  - **bash:** a terminal view with ANSI colour for tools that keep it, `exit N` / `timed out`
    status, and head + tail for long output.
  - **subagent:** a task card with markdown for the task and the result.
  - **fetch:** a link card.
  - **JSON results:** a collapsible tree.

  Every card has copy buttons. Unknown tools keep the generic view (shell as `$` lines,
  args as chips), and a view that throws falls back to it. All tool data is escaped: a
  diff line or grep hit containing HTML renders as text.
- **Steering you can follow.** A steer stays pinned at the bottom (`typed <time>`) until
  the model reads it, then flies to that exact point in the transcript
  (`received <time> · Ns after typed`). It can also end as sent-as-follow-up,
  returned-to-input (on cancel) or not-delivered.
- **Smooth streaming.** The provider sends about 12 characters every ~60ms. synaps-dash
  buffers them and reveals about 3 characters every frame (default 256ms buffer,
  `?lag=N` to tune, remembered). Completed paragraphs render once. Only the one being
  written re-renders.
- **Motion system.** One vocabulary (expo-out, in-out, a hint of overshoot;
  120/220/380ms) for message entrances, rows sliding off the rail, ✓ drawing itself,
  expand and collapse both ways, the send↔stop morph, the gliding session indicator,
  toasts and sheets. Everything turns off under `prefers-reduced-motion`.
- **Scroll by intent.** The transcript stays glued to the bottom until you deliberately
  scroll up (wheel, touch, PageUp/↑/Home, scrollbar). Scrolling back to the bottom, the
  "New messages" pill, `End` or sending a message re-pins it. Navigation keys scroll the
  transcript whenever you're not typing.
- **Markdown** with tables, links, blockquotes and highlighted code blocks with copy.
- **Settings** (gear bottom-left, or `Ctrl+,`), modelled on the TUI's `/settings` minus the
  terminal-only rows (theme, sidecar key, fps):
  - **Session:** model (your config's `favorite_models` + custom), thinking level, context
    window, and advanced tool limits and retries. Applied live to the session through the
    daemon (owner-only, each confirmed with a ✓).
  - **Synaps config** — the daemon's config file (`~/.synaps-cli/config`, or the profile's):
    - **Defaults:** default model, thinking, context window, compaction model/mode, favorite models.
    - **Agent:** tool limits, tool-activation policy, progressive disclosure, retries, event auto-turns.
    - **Context & memory:** context management, prompt-cache TTL, memory backend.
    - **Daemon:** idle exit, prompt abandon, parked eviction, quick start, extensions-ready wait.
    - **Plugins:** turn installed plugins (global + project) on or off.
    - **Providers:** which providers are set up — status only.

    Every row says when it takes effect. The daemon reads its config **once, at start**, so
    most changes apply on `synaps daemon reload`; the panel lists what's waiting and gives
    you the command. (Sessions survive a reload; this page gets a new token.)
  - **Appearance:** palette (Album live / Myx / Midnight / Ember / Mono), text size, density,
    glow, grain.
  - **Motion:** animations System / Full / Reduced, and the stream-smoothing slider.
  - **Behavior:** stick to bottom, send with Enter or Ctrl/⌘+Enter.
  - **About:** connection and version details.

  What the browser can't touch: the system prompt and worker-model grants (session), and in
  the config file anything outside a fixed allowlist — provider keys, `server.*` (the web
  token, allowed origins, auto-approve), `auth.*`, `bridge.*`, `shell.*`. Provider keys and
  OAuth tokens are never sent to the browser. Config writes are same-origin JSON only,
  validated by the bridge, and use the same `flock` + atomic rename as Synaps, so they can't
  collide with a TUI `/settings` write. synaps-dash can't disable itself from the browser.

## Install (on your main daemon)

```bash
git clone https://github.com/HaseebKhalid1507/synaps-dash ~/Projects/synaps-dash
ln -sfn ~/Projects/synaps-dash ~/.synaps-cli/plugins/synaps-dash
synaps daemon reload                                   # extensions load at daemon start/reload
xdg-open "$(cat ~/.synaps-cli/run/synaps-dash.url)"     # one-time token → cookie
```

- **Requirements:** [Bun](https://bun.sh) on `PATH`, a Synaps daemon speaking protocol v3.
- **Port:** 7717 by default. Change it with `extension.synaps-dash.port = N` in the Synaps
  profile config. Environment variables do **not** reach extensions.
- **Updating:** the server reads `web/` from disk on every request, so a UI change only
  needs a page refresh. Changes to `main.ts` need `synaps daemon reload`, which also
  issues a **new token**, so re-open the URL from the file.
- **Profiles:** the URL file is `synaps-dash-<profile>.url` for non-default profiles.

### Remote access (ngrok, Tailscale…)

The WebSocket accepts same-origin requests behind a tunnel (the `Origin` must match the
forwarded host), the cookie is `Secure` over HTTPS, and the client uses `wss://`. So
`ngrok http 7717`, then open `https://<host>/?token=<token>` once.

⚠️ This exposes an agent with shell access to your machine, guarded only by that token.
Add tunnel-side auth (`ngrok http 7717 --basic-auth "you:<long-password>"` or OAuth),
never share the URL, and stop the tunnel when you're done.

## Security boundary

The daemon trusts its uid (0600 socket), so **this process is the boundary**:

- binds `127.0.0.1` only; a per-boot random token, `?token=` → an HttpOnly SameSite=Lax cookie
- WebSocket upgrade needs the cookie and a loopback or same-origin `Origin`
- the bridge does the protocol `hello` itself. The browser may only send `ping`,
  `sessions`, `attach`, `cmd` and `bye`
- `cmd` allowlist: submit set steer cancel answer query save compact new_session engine_command detach;
  `set` only for model, reasoning_level, context_window, compaction_model, api_retries,
  subagent_timeout, max_tool_output, bash_timeout, bash_max_timeout
- `/api/models` returns only `model` + `favorite_models` from the Synaps config (never keys)
- `/api/config` reads and writes a fixed allowlist of config keys, with each value validated
  by the bridge. Provider keys, `server.*`, `auth.*`, `bridge.*` and `shell.*` can't be read
  or written. Writes must be same-origin `application/json` (a form-style cross-site POST
  gets 415), they take the same `flock` on `config.lock` plus atomic rename as Synaps, and
  they're refused for a profile that has no config file of its own (writing would shadow the
  default config)
- `/api/sessions` returns session headers only (id, title, model, times, cost, message count):
  never messages, system prompts or env
- `attach create` config is sanitised (no `prompt_manifest`/`env`; `auto_approve_confirms=false`)
- `shutdown` / `reload` / `purge` / `hello` / `end` are refused
- serves only when hosted by a registered daemon (its `daemon*.json` pid == our ppid).
  An in-process Synaps that also loads the plugin stays dormant.

## Development

A separate sandbox profile keeps experiments away from your live daemon:

```bash
# ~/.synaps-cli/webproto/config: its own sessions, other plugins disabled,
#   extension.synaps-dash.port = 7718
mkdir -p /tmp/synaps-web-sandbox/.synaps/plugins
ln -sfn "$PWD" /tmp/synaps-web-sandbox/.synaps/plugins/synaps-dash
cd /tmp/synaps-web-sandbox && SYNAPS_PROFILE=webproto synaps daemon --profile webproto --detach
xdg-open "$(cat ~/.synaps-cli/run/synaps-dash-webproto.url)"
```

The tests are Playwright scripts that drive real turns against the sandbox. They only ever
target the sandbox; the config tests restore the sandbox config and check that the live
config's hash is unchanged.

| Test | Covers |
|---|---|
| `test/redesign.cjs` | palette, fonts, thinking, tool card, markdown table/code, copy, mobile |
| `test/batching.cjs` | activity batching, steer delivery, mid-turn ordering, replay |
| `test/steer-move.cjs` | steer pinned while queued, lands where the model read it |
| `test/motion.cjs` | animated open/close, ✓ draw, rail indicator, reduced motion |
| `test/scroll-pin.cjs` | stick-to-bottom by intent, unpin/re-pin gestures |
| `test/stream-probe.cjs` | streaming smoothness: wire cadence vs per-frame reveal |
| `test/shot-activity.cjs` | screenshot of an expanded activity batch |
| `test/settings.cjs` | settings panel: every control, session settings via the daemon, persistence, watcher read-only, unsafe-setting refusal |
| `test/config.cjs` | Synaps config sections: UI → disk for every control type, reset, favorites, plugins, providers leak nothing, failed writes snap back |
| `test/config-reload.cjs` | a config change is ignored until `daemon reload`, applied after it; the old token dies |
| `test/sessions.cjs` | Live/Recent split by client count, no bodies in `/api/sessions`, resume keeps the id and history |
| `test/run-state.cjs` | header pill states, TUI spinner frames + cadence, pulse, layout, reconnect, reduced motion |
| `test/glow.cjs` | glow speed ramps slow → fast → slow both ways, never snaps, settles and stops at idle, static under reduced motion |
| `test/tool-views.cjs` | every tool view against real-shaped events, failure detection, folding / truncation / streamed deltas, fallbacks, HTML escaping; then a real turn with real tools |
| `test/rail.cjs` | rail drawer: exact curves by pausing and seeking the running transitions (close in-out, open expo-out, desktop + mobile), solid panel at every step, no re-wrap, cascade, aria-expanded, mobile layout, reduced motion |
| `test/context.cjs` | context meter: estimate on attach, measured == the wire's `Usage` after a real turn, budget/flag == a direct assessment, thresholds, formatting, compaction → estimate, popover, layout; plus Enter mid-switch keeps the message |
| `test/live.cjs` | multi-client: mirror a peer's turn, optionally take over and submit |
| `test/headless.cjs` | headless DOM smoke check |
| `test/probe.ts` | raw protocol through the bridge + frame-filter refusals |

## Protocol notes (verified on SynapsCLI 0.9.1, protocol v3)

- Extensions spawn once per daemon (thin TUIs don't load extensions). `daemon reload`
  stops them before exec and respawns them after, and the port is rebound cleanly.
- The daemon **scrubs extension env** down to `HOME LANG PATH TERM XDG_RUNTIME_DIR`.
- `TurnStarted.user_text` is only set for queued turns, so a *peer* never sees another
  client's prompt text. synaps-dash fills it in with a `display_tail` query.
- `Attached.replay` holds the *last* turn even after it finished, so synaps-dash applies
  it only while streaming.
- The daemon broadcasts its CLI attach hint ("input is owned by client #N …") to every
  client, and synaps-dash filters it out.
- Streaming cadence is set by the provider (~12 chars / ~60ms from Anthropic, measured
  directly). The daemon → socket hop adds ~0.1ms.
- The daemon reads its config **once, at start**: `host.reload_config()` has no callers.
  Config edits (from here or the TUI) apply to new sessions only after `daemon reload`.
  `daemon.prompt_abandon_secs` / `parked_evict_secs` are the exception, read live.
- `session_list` metadata carries `clients` and `lifecycle`. A session with no journal on disk
  never parks: it stays `lifecycle=live` at 0 clients until eviction (default 1h). That's why
  the rail splits Live/Recent on `clients`, not on `lifecycle` or daemon membership.
- Compaction sends a **non-streaming** request, and the runtime's HTTP client drops a request
  after 90s without receiving data. On a very large session the summary can't finish
  generating in 90s, so every retry times out the same way (shows up as a "hung"
  compaction). Fix upstream: stream the compaction request.
- `ToolResult` is `{tool_id, result}` with **no error flag**. Failures are text prefixes
  (`Tool execution failed:`, `Tool call denied:`, `Unknown tool:`), and bash failures read
  `Command failed (exit N):`. The `bash` tool strips ANSI before the result is sent.
- Each session fans events out through a 1024-event broadcast buffer
  (`SYNAPS_SESSION_EVENTS_CAP`). A client that falls further behind gets its oldest events
  dropped and an `event stream lagged; N dropped` notice. That happens mostly while a huge
  tool call streams its arguments. The session itself loses nothing; `Resync { since_seq }`
  exists for recovery.
- The `context_assessment` query returns `used_tokens`, `budget_tokens`, `provider_window` and
  `should_compact`. The budget is the window **minus per-request reserves**: the model's max
  output (128k for Opus), thinking, the next tool result, and a margin. So an Opus session with
  a 200k window has a **32k** budget, and Synaps's compaction trigger fires past it. The estimate
  is conservative: it counts every tool schema even with progressive disclosure, so it reads
  well above the measured `Usage`.

## Roadmap

Toward an agentic development environment. First, things the protocol already sends that
the client doesn't use yet:

- **Subagents panel.** Subagent start/update/done events, live parallel agents, steer them
  (plus `N agents` in the run-state pill, like the TUI).
- **Command palette + slash commands** (`⌘K`) over `engine_command` / `plugin_command`.
- **Context meter + compact.** `ContextReport` / `ContextAssessment` queries; handle
  `CompactionCancelled`.
- **Auto mode and events.** The `Driver*` events, `AutoTurnCapReached`, `External`,
  `ExtensionNotification`.
- **"Needs you" browser notifications** when the agent is waiting on input.

Needing the bridge (same host): a workspace file tree/viewer and `@`-mentions, git status/diff/commit,
a read-only view of the agent's PTY sessions.

Needing Synaps: per-turn file checkpoints (undo/rewind), a structured file-change event,
diff-before-write approval, plan/todo events, streaming compaction.

Smaller: presence icons · attachments · lag → auto-resync · reconnect ownership restore ·
long-turn handling.

MIT
