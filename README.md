# synaps-web

Browser client for the SynapsCLI session daemon, shipped as a **plain extension —
zero changes to synaps**. A browser tab becomes an ordinary daemon client, a peer
of the TUI on the same session (same event stream, same input-ownership rules).

```
daemon ──spawns──▶ synaps-web (this extension) ◀── HTTP/WS 127.0.0.1:7717 ──▶ browser tabs
   ▲                     │
   └──── daemon.sock ◀───┘  one UDS connection per tab, as a normal client (kind "server")
```

- `main.ts` — extension (JSON-RPC over stdio) + bridge (Bun HTTP/WS ⇄ daemon UDS).
- `web/` — vanilla client (no build): transcript, tool cards, thinking, ownership, takeover, prompts.
- `test/probe.ts` — raw protocol probe through the bridge (+ filter test).
- `test/headless.cjs`, `test/live.cjs` — Playwright DOM checks (borrows SynapsDASH's playwright).

## Run the prototype (sandboxed — never touches the live daemon)

```bash
# profile config: ~/.synaps-cli/webproto/config (global plugins disabled, own sessions)
mkdir -p /tmp/synaps-web-sandbox/.synaps/plugins
ln -sfn ~/Projects/synaps-web /tmp/synaps-web-sandbox/.synaps/plugins/synaps-web
cd /tmp/synaps-web-sandbox
SYNAPS_PROFILE=webproto synaps-dev daemon --profile webproto --detach
SYNAPS_PROFILE=webproto synaps-dev --profile webproto --attach --new     # the TUI
xdg-open "$(cat ~/.synaps-cli/run/synaps-web-webproto.url)"               # the browser
```

Port: `extension.synaps-web.port = N` in the profile config (env does NOT reach
extensions — see below). Tear down: `synaps-dev daemon --profile webproto stop`.

## Security boundary (the daemon trusts its uid, so this process is the boundary)

- binds 127.0.0.1 only; per-boot random token, `?token=` → HttpOnly SameSite=Strict cookie
- WS upgrade requires cookie + `Origin` = the page origin
- bridge does `Hello` itself; the browser may only send `ping`, `sessions`, `attach`, `cmd`, `bye`
- `cmd` allowlist: submit steer cancel answer query save compact new_session engine_command detach
- `attach create` config sanitised (no `prompt_manifest`/`env`; `auto_approve_confirms=false`)
- `shutdown` / `reload` / `purge` / `hello` / `end` refused (tested in `test/probe.ts`)

## Findings (verified on SynapsCLI dev @ 7f277492, daemon 0.9.1, protocol v3)

- Extensions spawn once per daemon (thin TUIs don't load extensions); `daemon reload`
  stops them before exec and respawns after — port released/rebound cleanly.
- The daemon **scrubs extension env** to `HOME LANG PATH TERM XDG_RUNTIME_DIR`. We find
  our daemon via `~/.synaps-cli/run/daemon*.json` whose `pid == ppid`.
- `docs/daemon-mode.md` says protocol v1; code + live daemon are **v3** (docs stale).
- **Upstream gap 1:** `TurnStarted.user_text` is only set for queued turns, so a *peer*
  client never sees another client's prompt text. The TUI shows the reply without the
  prompt; synaps-web works around it with a `display_tail` query.
- **Upstream gap 2:** `Attached.replay` holds the *last* turn's ring even after it
  finished (cleared only at the next turn start), and the TUI applies it
  unconditionally → likely double-render of the last turn when a second TUI attaches
  after a finished turn. synaps-web applies replay only when `streaming`.
- Cancel is an input-owner command → the web needs "take over" to stop a turn.

## Not done yet

Reconnect ownership restore (`reconnect_of`), slash commands, subagent panel, diffs,
attachments, lag → auto-resync, markdown tables/links, mobile layout, remote access.
