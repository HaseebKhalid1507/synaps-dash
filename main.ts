// synaps-dash — a SynapsCLI extension that serves a browser client for the
// session daemon. Zero changes to synaps: the daemon spawns this process like
// any extension; we answer the extension JSON-RPC on stdio, and separately
// bridge browser WebSockets to the daemon's own client socket (daemon.sock),
// one UDS connection per browser tab. Browser tabs are ordinary daemon
// clients — peers of the TUI on the same session.
//
// Security: the daemon trusts its uid (0600 socket, not an auth boundary), so
// THIS process is the boundary: loopback bind, per-boot token → HttpOnly
// cookie, Origin check on upgrade, and a client-frame allowlist (no
// shutdown/reload/purge, sanitised Attach::Create config). Config edits go
// through /api/config: a closed key allowlist, strict values, same-origin +
// JSON-only POSTs, and the same flock + atomic rename Synaps uses.
//
// stdout is reserved for framed JSON-RPC. Log to stderr only. Never console.log.

import { readFileSync, readdirSync, readlinkSync, writeFileSync, statSync, existsSync, openSync, closeSync, readSync, renameSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "0.1.0";
const log = (...a: unknown[]) => process.stderr.write(`[synaps-dash] ${a.map(String).join(" ")}\n`);

// ── extension JSON-RPC over stdio (Content-Length framing, LSP-style) ─────────

let rpcBuf = Buffer.alloc(0);
let serverStarted = false;

function rpcSend(msg: unknown) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function rpcHandle(msg: any) {
  const { id, method } = msg ?? {};
  switch (method) {
    case "initialize": {
      const cfgPort = Number(msg.params?.config?.port);
      if (Number.isInteger(cfgPort) && cfgPort > 0 && cfgPort < 65536) PORT = cfgPort;
      // Answer IMMEDIATELY: the daemon runs extension discovery before it
      // accepts connections, so we must not touch daemon.sock here.
      rpcSend({ jsonrpc: "2.0", id, result: { protocol_version: 1, capabilities: {} } });
      if (!serverStarted) {
        serverStarted = true;
        setTimeout(() => void startServer(), 0);
      }
      return;
    }
    case "hook.handle":
      rpcSend({ jsonrpc: "2.0", id, result: { action: "continue" } });
      return;
    case "shutdown":
      if (id !== undefined) rpcSend({ jsonrpc: "2.0", id, result: null });
      log("shutdown requested");
      shutdown(0);
      return;
    default:
      if (id !== undefined) {
        rpcSend({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  rpcBuf = Buffer.concat([rpcBuf, chunk]);
  for (;;) {
    const sep = rpcBuf.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const header = rpcBuf.subarray(0, sep).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      log("bad rpc header; dropping buffer");
      rpcBuf = Buffer.alloc(0);
      return;
    }
    const len = Number(m[1]);
    if (rpcBuf.length < sep + 4 + len) return;
    const body = rpcBuf.subarray(sep + 4, sep + 4 + len).toString("utf8");
    rpcBuf = rpcBuf.subarray(sep + 4 + len);
    try {
      rpcHandle(JSON.parse(body));
    } catch (e) {
      log("bad rpc body:", e);
    }
  }
});
// Parent gone (daemon exited / killed us) → never outlive it holding the port.
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));

// ── daemon discovery ──────────────────────────────────────────────────────────

type DaemonInfo = { socket: string; protocol_version: number; daemon_version: string; profile: string | null; pid: number };

function runDir(): string {
  if (process.env.SYNAPS_RUNTIME_DIR) return process.env.SYNAPS_RUNTIME_DIR;
  const base = process.env.SYNAPS_BASE_DIR || join(homedir(), ".synaps-cli");
  return join(base, "run");
}

/**
 * The daemon that spawned us: the `daemon*.json` whose pid == our ppid. NO
 * fallback — an in-process `synaps` also loads global plugins, and silently
 * bridging it to the default daemon.json pointed the web at the WRONG host
 * (S335 bug). Non-daemon hosts stay dormant instead.
 */
function hostDaemon(): DaemonInfo | null {
  if (process.env.SYNAPS_DASH_DAEMON_SOCKET) {
    // standalone/dev only — the daemon scrubs env, so this never reaches an extension
    return { socket: process.env.SYNAPS_DASH_DAEMON_SOCKET, protocol_version: Number(process.env.SYNAPS_DASH_PROTOCOL ?? 3), daemon_version: "?", profile: null, pid: 0 };
  }
  const dir = runDir();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^daemon(-.+)?\.json$/.test(f));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (d.pid === process.ppid) return d;
    } catch {}
  }
  return null;
}

function findDaemon(): DaemonInfo {
  const d = hostDaemon();
  if (!d) throw new Error(`host pid ${process.ppid} is not a registered synaps daemon`);
  return d;
}

/** Fast pre-check: a daemon's argv contains the `daemon` subcommand. */
function hostLooksLikeDaemon(): boolean {
  if (process.env.SYNAPS_DASH_DAEMON_SOCKET) return true;
  try {
    return readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0").includes("daemon");
  } catch {
    return false;
  }
}

/** Working dir for sessions the browser creates: the daemon's own cwd. */
function daemonCwd(): string {
  try {
    return readlinkSync(`/proc/${process.ppid}/cwd`);
  } catch {
    return homedir();
  }
}

// ── client-frame filter (browser → daemon) ────────────────────────────────────

// Session settings the browser may change (mirrors the TUI /settings session
// rows). NOT system_prompt / reload_prompt / grant_worker_model.
const ALLOWED_SETTINGS = new Set([
  "model", "reasoning_level", "context_window", "compaction_model", "api_retries",
  "subagent_timeout", "max_tool_output", "bash_timeout", "bash_max_timeout",
]);
const ALLOWED_CMDS = new Set([
  "submit", "set", "steer", "cancel", "answer", "query", "save", "compact", "new_session", "engine_command", "detach",
]);
const MODES = new Set(["mirror", "observe", "takeover"]);

type Verdict = { ok: true; frame: any } | { ok: false; why: string };

function filterFrame(f: any): Verdict {
  if (!f || typeof f !== "object" || typeof f.type !== "string") return { ok: false, why: "not a frame" };
  switch (f.type) {
    case "ping":
    case "sessions":
    case "bye":
      return { ok: true, frame: { type: f.type } };
    case "attach": {
      const mode = MODES.has(f.mode) ? f.mode : "mirror";
      if (f.attach === "existing" && typeof f.session_id === "string") {
        return { ok: true, frame: { type: "attach", attach: "existing", session_id: f.session_id, mode } };
      }
      if (f.attach === "create") {
        // Sanitise: never let a browser set prompt_manifest, env, or
        // auto_approve_confirms. Only a model override / continue survive.
        const c = f.config ?? {};
        const config: any = { auto_approve_confirms: false };
        if (typeof c.model_override === "string") config.model_override = c.model_override;
        if (typeof c.continue_session === "string") config.continue_session = c.continue_session;
        return { ok: true, frame: { type: "attach", attach: "create", config, mode } };
      }
      return { ok: false, why: "bad attach" };
    }
    case "cmd": {
      const name = f.cmd?.cmd;
      if (name === "set" && !ALLOWED_SETTINGS.has(f.cmd?.setting?.setting)) return { ok: false, why: `setting '${f.cmd?.setting?.setting}' not allowed from the web` };
      if (typeof f.session_id !== "string" || !ALLOWED_CMDS.has(name)) return { ok: false, why: `cmd '${name}' not allowed` };
      return { ok: true, frame: { type: "cmd", session_id: f.session_id, cmd: f.cmd } };
    }
    default:
      // hello (the bridge does the handshake itself), shutdown, reload, purge, …
      return { ok: false, why: `frame type '${f.type}' not allowed from the web` };
  }
}

// ── Synaps config (the daemon's config file) ──────────────────────────────────
// The browser may read and write a CLOSED set of keys. Provider keys, server.*,
// auth.*, bridge.* and shell.* are never readable or writable from here.
// Semantics mirror agent-core/src/core/config.rs:
//   read  = <base>/<profile>/config if it exists, else <base>/config
//   write = <base>/<profile>/config (profile) or <base>/config
//   lock  = flock(LOCK_EX) on <write dir>/config.lock, then tmp + rename, 0600
// The daemon loads config ONCE at start (host.reload_config has no callers), so
// most keys apply after `daemon reload`; `applies` says which.

type Applies = "reload" | "live" | "start" | "launch";
const MODEL_RE = /^[\w.-]+\/[\w.:-]+$/;
const oneOf = (...xs: string[]) => (v: string) => xs.includes(v);
const intIn = (lo: number, hi: number) => (v: string) => /^\d{1,9}$/.test(v) && +v >= lo && +v <= hi;
const listOf = (re: RegExp, max: number) => (v: string) => {
  const xs = v.split(",").map((x) => x.trim()).filter(Boolean);
  return xs.length <= max && xs.every((x) => re.test(x));
};
const CONFIG_KEYS: Record<string, { ok: (v: string) => boolean; applies: Applies }> = {
  model: { ok: (v) => MODEL_RE.test(v), applies: "reload" },
  thinking: { ok: oneOf("off", "adaptive", "low", "medium", "high", "xhigh", "max"), applies: "reload" },
  context_window: { ok: oneOf("200k", "1m"), applies: "reload" },
  compaction_model: { ok: (v) => MODEL_RE.test(v), applies: "reload" },
  compaction_mode: { ok: oneOf("remote", "local"), applies: "reload" },
  favorite_models: { ok: listOf(MODEL_RE, 40), applies: "live" },
  api_retries: { ok: intIn(0, 20), applies: "reload" },
  refusal_retries: { ok: intIn(0, 10), applies: "reload" },
  subagent_timeout: { ok: intIn(10, 86400), applies: "reload" },
  max_tool_output: { ok: intIn(1024, 4 * 1024 * 1024), applies: "reload" },
  bash_timeout: { ok: intIn(1, 3600), applies: "reload" },
  bash_max_timeout: { ok: intIn(1, 86400), applies: "reload" },
  "tools.activation_confirm": { ok: oneOf("auto", "prompt", "deny"), applies: "reload" },
  progressive_tool_disclosure: { ok: oneOf("true", "false"), applies: "reload" },
  "events.auto_turn": { ok: oneOf("true", "false"), applies: "reload" },
  "events.auto_turn_cap": { ok: intIn(0, 1000), applies: "reload" },
  "context_management.mode": { ok: oneOf("off", "auto"), applies: "reload" },
  cache_ttl: { ok: oneOf("5m", "1h", "hybrid"), applies: "reload" },
  "memory.backend": { ok: oneOf("legacy", "axel"), applies: "reload" },
  "daemon.idle_exit_secs": { ok: intIn(0, 604800), applies: "start" },
  "daemon.prompt_abandon_secs": { ok: intIn(0, 604800), applies: "live" },
  "daemon.parked_evict_secs": { ok: intIn(0, 604800), applies: "live" },
  "startup.quick_start": { ok: oneOf("on", "off"), applies: "launch" },
  "startup.extensions_ready_timeout_secs": { ok: intIn(1, 600), applies: "reload" },
  disabled_plugins: { ok: listOf(/^[\w.@-]+$/, 64), applies: "reload" },
};
const SELF_PLUGIN = "synaps-dash";

function synapsBase(): string {
  // The daemon scrubs SYNAPS_* from extension env, so this is ~/.synaps-cli in
  // practice — the same base the daemon resolved (it never sets a custom one
  // for the live profiles).
  return process.env.SYNAPS_BASE_DIR || join(homedir(), ".synaps-cli");
}
function sessionsDir(): string {
  const base = synapsBase();
  const profile = hostDaemon()?.profile ?? null;
  return profile ? join(base, profile, "sessions") : join(base, "sessions");
}

/**
 * Recent sessions on disk, most-recent first — the same shape the TUI's
 * `/sessions` builds: sort files by mtime, then read ONLY the top `limit`
 * headers. A session file is `{...header fields..., "api_messages": [...]}`;
 * the daemon writes every header key before `api_messages`, so we cut there
 * and parse just the prefix instead of the whole (megabytes) file.
 */
function listSessions(limit: number): { id: string; title: string; name: string | null; model: string; created_at: string | null; updated_at: string | null; session_cost: number; message_count: number }[] {
  const dir = sessionsDir();
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const withM = files
    .map((f) => { try { return { f, m: statSync(join(dir, f)).mtimeMs }; } catch { return null; } })
    .filter(Boolean) as { f: string; m: number }[];
  withM.sort((a, b) => b.m - a.m);
  const out: any[] = [];
  for (const { f } of withM.slice(0, limit)) {
    let fd: number | null = null;
    try {
      // Read a bounded prefix (headers are small; caps a pathological file).
      fd = openSync(join(dir, f), "r");
      const buf = Buffer.alloc(256 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, n).toString("utf8");
      const cut = text.indexOf('"api_messages"');
      const head = (cut < 0 ? text : text.slice(0, cut).replace(/[,\s]*$/, "") + "}");
      const h = JSON.parse(head);
      if (typeof h.id !== "string") continue;
      out.push({
        id: h.id,
        title: typeof h.title === "string" ? h.title.slice(0, 200) : "",
        name: typeof h.name === "string" ? h.name : null,
        model: typeof h.model === "string" ? h.model : "",
        created_at: h.created_at ?? null,
        updated_at: h.updated_at ?? null,
        session_cost: typeof h.session_cost === "number" ? h.session_cost : 0,
        message_count: typeof h.message_count === "number" ? h.message_count : 0,
      });
    } catch {
      // partial write / not-yet-flushed header — skip, it'll show once saved
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return out;
}

function configPaths() {
  const base = synapsBase();
  const profile = hostDaemon()?.profile ?? null;
  const write = profile ? join(base, profile, "config") : join(base, "config");
  const read = profile && !existsSync(write) ? join(base, "config") : write;
  return { base, profile, read, write };
}
/** key → raw value; LAST occurrence wins, like the Synaps parser. */
function parseConfig(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    m.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return m;
}
function readConfig(): Map<string, string> {
  try { return parseConfig(readFileSync(configPaths().read, "utf8")); } catch { return new Map(); }
}
/** Only the allowlisted keys — never provider.*, server.*, auth.*, … */
function exposedValues(cfg: Map<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of Object.keys(CONFIG_KEYS)) out[k] = cfg.has(k) ? cfg.get(k)! : null;
  return out;
}

// flock via libc: the same advisory lock Synaps takes (fs4 → flock on Linux),
// so a browser write and a TUI /settings write can't interleave their RMW.
const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
let flockFn: ((fd: number, op: number) => number) | null | undefined;
function flock(): ((fd: number, op: number) => number) | null {
  if (flockFn !== undefined) return flockFn;
  try {
    const { dlopen, FFIType } = require("bun:ffi");
    const lib = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    flockFn = (fd, op) => lib.symbols.flock(fd, op);
  } catch (e) {
    log(`flock unavailable (${e}) — config writes disabled`);
    flockFn = null;
  }
  return flockFn;
}
async function withConfigLock<T>(dir: string, fn: () => T): Promise<T> {
  const f = flock();
  if (!f) throw new Error("cannot lock the config file on this system");
  const fd = openSync(join(dir, "config.lock"), "a", 0o600);
  try {
    const deadline = Date.now() + 3000;
    while (f(fd, LOCK_EX | LOCK_NB) !== 0) {
      if (Date.now() > deadline) throw new Error("the config file is locked by another writer — try again");
      await Bun.sleep(25);
    }
    try { return fn(); } finally { f(fd, LOCK_UN); }
  } finally {
    closeSync(fd);
  }
}
/**
 * Set (or with null, remove) one key. Replaces the first live occurrence and
 * drops later duplicates — the parser is last-wins, so a stale duplicate
 * further down would otherwise silently override the write. Comments and
 * every other line are preserved byte-for-byte.
 */
function rewriteKey(text: string, key: string, value: string | null): string {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const out: string[] = [];
  let done = false;
  for (const line of lines) {
    const t = line.trimStart();
    const eq = t.indexOf("=");
    const isKey = !t.startsWith("#") && eq > 0 && t.slice(0, eq).trim() === key;
    if (!isKey) { out.push(line); continue; }
    if (!done && value !== null) out.push(`${key} = ${value}`);
    done = true;
  }
  if (!done && value !== null) out.push(`${key} = ${value}`);
  return out.join("\n") + "\n";
}
async function writeConfigKey(key: string, value: string | null): Promise<void> {
  const { profile, write, base } = configPaths();
  if (profile && !existsSync(write)) {
    // Synaps would create a one-line profile config, and from then on the
    // profile reads ONLY that file — every other setting would vanish.
    throw new Error(`profile '${profile}' has no config of its own (it reads ${join(base, "config")}). Create ${write} first so a write doesn't hide the rest.`);
  }
  const dir = write.slice(0, write.lastIndexOf("/"));
  await withConfigLock(dir, () => {
    const cur = existsSync(write) ? readFileSync(write, "utf8") : "";
    const next = rewriteKey(cur, key, value);
    if (next === cur) return;
    const tmp = join(dir, "config.tmp");
    writeFileSync(tmp, next, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, write);
  });
}

/** Config at daemon start (we're spawned right after it loads) — the baseline
 *  for "which reload-class changes are still waiting for a reload". */
let bootConfig: Map<string, string> | null = null;
function pendingReload(cur: Map<string, string>): string[] {
  if (!bootConfig) return [];
  return Object.entries(CONFIG_KEYS)
    .filter(([k, d]) => d.applies === "reload" && (bootConfig!.get(k) ?? null) !== (cur.get(k) ?? null))
    .map(([k]) => k);
}

function listPlugins(disabled: string[]) {
  // Same roots + precedence as the extension manager: global, then the
  // daemon cwd's project dir (a project plugin shadows a global one).
  const roots: [string, string][] = [[join(synapsBase(), "plugins"), "global"], [join(daemonCwd(), ".synaps", "plugins"), "project"]];
  const found = new Map<string, any>();
  for (const [dir, scope] of roots) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (/\.(backup|update-backup|bak|disabled|old|orig)$|\.backup\./i.test(name)) continue;
      let man: any = null;
      try { man = JSON.parse(readFileSync(join(dir, name, ".synaps-plugin", "plugin.json"), "utf8")); } catch { continue; }
      found.set(name, {
        name, scope,
        description: typeof man?.description === "string" ? man.description.slice(0, 200) : "",
        version: typeof man?.version === "string" ? man.version.slice(0, 32) : null,
        enabled: !disabled.includes(name),
        self: name === SELF_PLUGIN,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Provider STATUS only: names and kinds. No key, token or URL ever leaves. */
function listProviders(cfg: Map<string, string>) {
  const out: { name: string; kind: string; source: string; note?: string }[] = [];
  const seen = new Set<string>();
  for (const k of cfg.keys()) {
    const m = /^provider\.([\w-]+)(?:\.(\w+))?$/.exec(k);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ name: m[1], kind: m[2] === "url" ? "endpoint" : "API key", source: "config" });
  }
  const base = synapsBase(), prof = hostDaemon()?.profile;
  const authPath = prof && existsSync(join(base, prof, "auth.json")) ? join(base, prof, "auth.json") : join(base, "auth.json");
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    for (const [name, v] of Object.entries<any>(auth ?? {})) {
      if (!v || typeof v !== "object") continue;
      const oauth = v.type === "oauth";
      let note: string | undefined;
      if (oauth && typeof v.expires === "number") note = v.expires > Date.now() ? "token valid" : "token refreshes on next use";
      out.push({ name, kind: oauth ? "OAuth sign-in" : v.type === "api" || v.type === "api_key" ? "API key" : "credential", source: "login", note });
    }
  } catch {}
  return out;
}

function idleExitFlag(): number | null {
  try {
    const argv = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0");
    const i = argv.indexOf("--idle-exit");
    return i >= 0 && /^\d+$/.test(argv[i + 1] ?? "") ? Number(argv[i + 1]) : null;
  } catch {
    return null;
  }
}

function configSnapshot() {
  const { profile, read, write } = configPaths();
  const cfg = readConfig();
  const disabled = (cfg.get("disabled_plugins") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const d = hostDaemon();
  const exe = d && (d as any).exe ? String((d as any).exe).split("/").pop() : "synaps";
  const tilde = (p: string) => p.replace(homedir(), "~");
  return {
    profile,
    path: tilde(read),
    writePath: tilde(write),
    writable: !(profile && !existsSync(write)) && flock() !== null,
    values: exposedValues(cfg),
    applies: Object.fromEntries(Object.entries(CONFIG_KEYS).map(([k, v]) => [k, v.applies])),
    pending: pendingReload(cfg),
    reloadCmd: `${exe} daemon${profile ? ` --profile ${profile}` : ""} reload`,
    idleExitRunning: idleExitFlag(),
    plugins: listPlugins(disabled),
    providers: listProviders(cfg),
  };
}

async function handleConfigPost(req: Request): Promise<Response> {
  if (!originOk(req)) return Response.json({ ok: false, error: "bad origin" }, { status: 403 });
  if (!(req.headers.get("content-type") || "").startsWith("application/json")) return Response.json({ ok: false, error: "expected JSON" }, { status: 415 });
  const text = await req.text();
  if (text.length > 16 * 1024) return Response.json({ ok: false, error: "too large" }, { status: 413 });
  let body: any;
  try { body = JSON.parse(text); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }
  const key = body?.key;
  const def = typeof key === "string" && Object.hasOwn(CONFIG_KEYS, key) ? CONFIG_KEYS[key] : null;
  if (!def) return Response.json({ ok: false, error: `'${String(key)}' is not editable from the web` }, { status: 400 });
  let value: string | null = body.value === null ? null : typeof body.value === "string" ? body.value.trim() : undefined as any;
  if (value === undefined) return Response.json({ ok: false, error: "value must be a string or null" }, { status: 400 });
  if (value !== null && key !== "disabled_plugins" && key !== "favorite_models" && !def.ok(value)) {
    return Response.json({ ok: false, error: `invalid value for ${key}` }, { status: 400 });
  }
  if (value !== null && (key === "disabled_plugins" || key === "favorite_models")) {
    if (!def.ok(value)) return Response.json({ ok: false, error: `invalid value for ${key}` }, { status: 400 });
    const xs = [...new Set(value.split(",").map((x) => x.trim()).filter(Boolean))];
    if (key === "disabled_plugins" && xs.includes(SELF_PLUGIN)) {
      return Response.json({ ok: false, error: "synaps-dash can't disable itself from the browser — the next reload would take this page down. Use the TUI." }, { status: 400 });
    }
    value = xs.length ? xs.join(", ") : null;
  }
  try {
    await writeConfigKey(key, value);
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 409 });
  }
  log(`config: ${key} ${value === null ? "unset" : `= ${value}`} (${configPaths().write})`);
  return Response.json({ ok: true, ...configSnapshot() });
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

// NOTE: the daemon scrubs extension env to HOME/LANG/PATH/TERM/XDG_RUNTIME_DIR,
// so SYNAPS_* never reach us. Port comes from `extension.synaps-dash.port = N`
// in the profile config (delivered in initialize.params.config); env is a
// fallback for standalone runs only.
let PORT = Number(process.env.SYNAPS_DASH_PORT ?? 7717);
const HOST = "127.0.0.1";
const TOKEN = randomBytes(24).toString("hex");
const COOKIE = "synaps_dash";
const WEB_DIR = resolve(import.meta.dir, "web");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
  "/fonts/InterVariable.woff2": "fonts/InterVariable.woff2",
};
const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff2: "font/woff2" };

// ── MXC tap (Myx Color Protocol v1) ──────────────────────────────────────────
// Myx publishes a 16-token palette derived from album art as NDJSON on
// $XDG_RUNTIME_DIR/myx/theme.sock (snapshot-on-connect, full state per line).
// We hold the last-good palette and push it to every browser as
// {type:"mxc", palette}. Resilience mirrors the synaps TUI subscriber:
// absent socket → quiet capped backoff; EOF / bye:reload → keep last-good;
// bye:shutdown → palette:null (browser reverts to the static myx default);
// newer protocol / oversized line / bad frame → drop + retry; the socket's
// directory must be owned by our uid (squat defense).
const MXC_TOKENS = ["primary", "secondary", "accent", "error", "warning", "success", "info", "text", "text_muted",
  "background", "background_panel", "background_element", "border", "border_active", "border_subtle", "border_dimmest"];
const MXC_MAX_LINE = 64 * 1024;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
type MxcPalette = { colors: Record<string, string>; fade_ms: number; is_dark: boolean; seq: number };
let mxc: MxcPalette | null = null;
const wsClients = new Set<any>();

function mxcFrame(): string {
  return JSON.stringify({ type: "mxc", palette: mxc });
}
function broadcastMxc() {
  const f = mxcFrame();
  for (const ws of wsClients) {
    try { ws.send(f); } catch {}
  }
}
function parseMxcTheme(m: any): MxcPalette | null {
  if (!m || m.t !== "theme" || typeof m.colors !== "object" || !m.colors) return null;
  const colors: Record<string, string> = {};
  for (const k of MXC_TOKENS) {
    const v = m.colors[k];
    if (typeof v !== "string" || !HEX_RE.test(v)) return null;
    colors[k] = v.toLowerCase();
  }
  const fade = Number(m.fade_ms);
  return { colors, fade_ms: Number.isFinite(fade) ? Math.max(0, Math.min(fade, 5000)) : 600, is_dark: m.is_dark !== false, seq: Number(m.seq) || 0 };
}
async function mxcLoop() {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const dir = join(process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`, "myx");
  const sock = join(dir, "theme.sock");
  let backoff = 1000;
  for (;;) {
    let ok = false;
    try { ok = statSync(dir).uid === uid; } catch {}
    if (ok) {
      await new Promise<void>((done) => {
        let buf = "";
        const dec = new TextDecoder();
        const finish = () => done();
        Bun.connect({
          unix: sock,
          socket: {
            data(s, chunk) {
              buf += dec.decode(chunk, { stream: true });
              let nl: number;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim()) continue;
                let m: any;
                try { m = JSON.parse(line); } catch { continue; } // malformed line: skip
                if (Number(m.v) > 1) { log("mxc: newer protocol v" + m.v + " — dropping"); s.end(); return; }
                if (m.t === "bye") {
                  if (m.reason === "shutdown") { mxc = null; broadcastMxc(); }
                  s.end();
                  return;
                }
                const p = parseMxcTheme(m);
                if (p) { mxc = p; backoff = 1000; broadcastMxc(); }
              }
              if (buf.length > MXC_MAX_LINE) { log("mxc: oversized line — dropping"); s.end(); }
            },
            close: finish,
            error: finish,
          },
        }).catch(finish);
      });
    }
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

let server: ReturnType<typeof Bun.serve> | null = null;
let nextConn = 1;

function tokenOk(t: string | null | undefined): boolean {
  if (!t || t.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

function cookieToken(req: Request): string | null {
  const c = req.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`).exec(c);
  return m ? m[1] : null;
}

function originOk(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return false;
  if (o === `http://${HOST}:${PORT}` || o === `http://localhost:${PORT}`) return true;
  // Behind a tunnel/proxy (ngrok, Tailscale Funnel…): same-origin only — the
  // Origin must name the very host the request was addressed to. A page on
  // another site can never pass this; the host-scoped token cookie stays the gate.
  let u: URL;
  try { u = new URL(o); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")].filter(Boolean) as string[];
  return hosts.some((h) => h.split(",")[0].trim().toLowerCase() === u.host.toLowerCase());
}

type WsData = {
  id: number;
  uds: any | null;
  pending: string[]; // browser frames queued until the daemon handshake is done
  outBuf: Buffer; // unflushed bytes for the UDS (backpressure)
  inBuf: string; // partial line from the UDS
  dec: TextDecoder; // streaming: a UTF-8 char may straddle two chunks
  ready: boolean;
};

function udsWrite(d: WsData, line: string) {
  d.outBuf = Buffer.concat([d.outBuf, Buffer.from(line, "utf8")]);
  flushUds(d);
}
function flushUds(d: WsData) {
  if (!d.uds || d.outBuf.length === 0) return;
  const n = d.uds.write(d.outBuf); // returns BYTES written
  if (n > 0) d.outBuf = d.outBuf.subarray(n);
}

async function startServer() {
  if (!hostLooksLikeDaemon()) {
    log(`host pid ${process.ppid} is not a synaps daemon (in-process session?) — staying dormant, not binding :${PORT}`);
    return;
  }
  let host: DaemonInfo | null = null;
  for (let i = 0; i < 40 && !host; i++) {
    host = hostDaemon();
    if (!host) await Bun.sleep(250);
  }
  if (!host) {
    log(`no daemon*.json for host pid ${process.ppid} after 10s — staying dormant`);
    return;
  }
  try {
    server = Bun.serve<WsData, {}>({
      hostname: HOST,
      port: PORT,
      async fetch(req, srv) {
        const url = new URL(req.url);
        // Token bootstrap: ?token=… → HttpOnly cookie, strip it from the URL.
        const qt = url.searchParams.get("token");
        const secure = url.protocol === "https:" || (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim() === "https";
        if (qt !== null) {
          if (!tokenOk(qt)) return new Response("bad token\n", { status: 401 });
          return new Response(null, {
            status: 302,
            headers: { location: "/", "set-cookie": `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/${secure ? "; Secure" : ""}` },
          });
        }
        if (!tokenOk(cookieToken(req))) {
          return new Response(`synaps-dash: open the URL from ${urlFile()}\n`, { status: 401 });
        }
        if (url.pathname === "/ws") {
          if (!originOk(req)) return new Response("bad origin\n", { status: 403 });
          const ok = srv.upgrade(req, {
            data: { id: nextConn++, uds: null, pending: [], outBuf: Buffer.alloc(0), inBuf: "", dec: new TextDecoder(), ready: false },
          });
          return ok ? undefined : new Response("upgrade failed\n", { status: 400 });
        }
        if (url.pathname === "/api/models") {
          // Favorites + default model. Reads ONLY `model` and `favorite_models`
          // — the config also holds provider keys, which never leave this process.
          const cfg = readConfig();
          const favorites = (cfg.get("favorite_models") ?? "").split(",").map((x) => x.trim()).filter((x) => MODEL_RE.test(x));
          return Response.json({ model: cfg.get("model") ?? null, favorites });
        }
        if (url.pathname === "/api/config") {
          if (req.method === "GET") return Response.json(configSnapshot());
          if (req.method === "POST") return handleConfigPost(req);
          return new Response("method not allowed\n", { status: 405 });
        }
        if (url.pathname === "/api/sessions") {
          // Recent sessions on disk (headers only). Live/parked ones come over
          // the socket in session_list; the client merges the two by id.
          const n = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
          return Response.json({ sessions: listSessions(n) });
        }
        if (url.pathname === "/api/info") {
          try {
            const d = findDaemon();
            return Response.json({ daemon_version: d.daemon_version, protocol_version: d.protocol_version, profile: d.profile, pid: d.pid, bridge: VERSION });
          } catch (e) {
            return Response.json({ error: String(e) }, { status: 503 });
          }
        }
        const file = STATIC[url.pathname];
        if (!file) return new Response("not found\n", { status: 404 });
        const ext = file.split(".").pop()!;
        return new Response(Bun.file(join(WEB_DIR, file)), {
          headers: { "content-type": MIME[ext], "cache-control": ext === "woff2" ? "public, max-age=31536000, immutable" : "no-store" },
        });
      },
      websocket: {
        maxPayloadLength: 4 * 1024 * 1024,
        async open(ws) {
          const d = ws.data;
          wsClients.add(ws);
          ws.send(mxcFrame()); // palette first, so the UI paints in album colors before any daemon frame
          let info: DaemonInfo;
          try {
            info = findDaemon();
          } catch (e) {
            ws.send(JSON.stringify({ type: "error", session_id: null, message: `synaps-dash: ${e}` }));
            ws.close(1011, "no daemon");
            return;
          }
          try {
            d.uds = await Bun.connect({
              unix: info.socket,
              socket: {
                data(_s, chunk) {
                  d.inBuf += d.dec.decode(chunk, { stream: true });
                  let nl: number;
                  while ((nl = d.inBuf.indexOf("\n")) >= 0) {
                    const line = d.inBuf.slice(0, nl);
                    d.inBuf = d.inBuf.slice(nl + 1);
                    if (!line) continue;
                    if (!d.ready && line.includes('"type":"welcome"')) {
                      d.ready = true;
                      for (const p of d.pending.splice(0)) udsWrite(d, p);
                    }
                    ws.send(line);
                  }
                },
                drain() {
                  flushUds(d);
                },
                close() {
                  try { ws.close(1000, "daemon closed"); } catch {}
                },
                error(_s, e) {
                  log(`conn #${d.id} uds error: ${e}`);
                },
              },
            });
          } catch (e) {
            ws.send(JSON.stringify({ type: "error", session_id: null, message: `synaps-dash: cannot reach daemon at ${info.socket}: ${e}` }));
            ws.close(1011, "daemon unreachable");
            return;
          }
          // The bridge performs the handshake: the browser never sends Hello.
          const hello = {
            type: "hello",
            protocol_version: info.protocol_version,
            client: { kind: "server", terminal: null, instance: `synaps-dash#${d.id}`, history: "digest", tail_items: 200 },
            cwd: daemonCwd(),
            client_version: `synaps-dash/${VERSION}`,
          };
          udsWrite(d, JSON.stringify(hello) + "\n");
          log(`conn #${d.id} → ${info.socket} (protocol v${info.protocol_version})`);
        },
        message(ws, raw) {
          const d = ws.data;
          let f: any;
          try {
            f = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          } catch {
            ws.send(JSON.stringify({ type: "error", session_id: null, message: "synaps-dash: invalid JSON" }));
            return;
          }
          const v = filterFrame(f);
          if (!v.ok) {
            ws.send(JSON.stringify({ type: "error", session_id: null, message: `synaps-dash: refused — ${v.why}` }));
            return;
          }
          const line = JSON.stringify(v.frame) + "\n";
          if (d.ready) udsWrite(d, line);
          else d.pending.push(line);
        },
        close(ws) {
          const d = ws.data;
          wsClients.delete(ws);
          // Socket close = Detach on the daemon side; the turn keeps running.
          try { d.uds?.end(); } catch {}
          log(`conn #${d.id} closed`);
        },
      },
    });
  } catch (e) {
    // EADDRINUSE etc. (e.g. an in-process host also loaded us): stay dormant,
    // keep answering the extension RPC so the host sees a healthy extension.
    log(`not serving: ${e}`);
    return;
  }
  bootConfig = readConfig();
  log(`serving on http://${HOST}:${PORT} → ${host.socket} (profile ${host.profile ?? "default"})`);
  void mxcLoop();
  writeUrlFile(host.profile);
}

let urlPath: string | null = null;
function urlFile(): string {
  return urlPath ?? join(runDir(), "synaps-dash.url");
}

function writeUrlFile(profile: string | null) {
  urlPath = join(runDir(), profile ? `synaps-dash-${profile}.url` : "synaps-dash.url");
  try {
    writeFileSync(urlPath, `http://${HOST}:${PORT}/?token=${TOKEN}\n`, { mode: 0o600 });
    log(`url + token written to ${urlPath}`);
  } catch (e) {
    log(`could not write ${urlPath}: ${e}`);
  }
}

function shutdown(code: number) {
  try { server?.stop(true); } catch {}
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
