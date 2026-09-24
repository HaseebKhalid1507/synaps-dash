// synaps-web — a SynapsCLI extension that serves a browser client for the
// session daemon. Zero changes to synaps: the daemon spawns this process like
// any extension; we answer the extension JSON-RPC on stdio, and separately
// bridge browser WebSockets to the daemon's own client socket (daemon.sock),
// one UDS connection per browser tab. Browser tabs are ordinary daemon
// clients — peers of the TUI on the same session.
//
// Security: the daemon trusts its uid (0600 socket, not an auth boundary), so
// THIS process is the boundary: loopback bind, per-boot token → HttpOnly
// cookie, Origin check on upgrade, and a client-frame allowlist (no
// shutdown/reload/purge, sanitised Attach::Create config).
//
// stdout is reserved for framed JSON-RPC. Log to stderr only. Never console.log.

import { readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "0.0.1";
const log = (...a: unknown[]) => process.stderr.write(`[synaps-web] ${a.map(String).join(" ")}\n`);

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
  if (process.env.SYNAPS_WEB_DAEMON_SOCKET) {
    // standalone/dev only — the daemon scrubs env, so this never reaches an extension
    return { socket: process.env.SYNAPS_WEB_DAEMON_SOCKET, protocol_version: Number(process.env.SYNAPS_WEB_PROTOCOL ?? 3), daemon_version: "?", profile: null, pid: 0 };
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
  if (process.env.SYNAPS_WEB_DAEMON_SOCKET) return true;
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

const ALLOWED_CMDS = new Set([
  "submit", "steer", "cancel", "answer", "query", "save", "compact", "new_session", "engine_command", "detach",
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
      if (typeof f.session_id !== "string" || !ALLOWED_CMDS.has(name)) return { ok: false, why: `cmd '${name}' not allowed` };
      return { ok: true, frame: { type: "cmd", session_id: f.session_id, cmd: f.cmd } };
    }
    default:
      // hello (the bridge does the handshake itself), shutdown, reload, purge, …
      return { ok: false, why: `frame type '${f.type}' not allowed from the web` };
  }
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

// NOTE: the daemon scrubs extension env to HOME/LANG/PATH/TERM/XDG_RUNTIME_DIR,
// so SYNAPS_* never reach us. Port comes from `extension.synaps-web.port = N`
// in the profile config (delivered in initialize.params.config); env is a
// fallback for standalone runs only.
let PORT = Number(process.env.SYNAPS_WEB_PORT ?? 7717);
const HOST = "127.0.0.1";
const TOKEN = randomBytes(24).toString("hex");
const COOKIE = "synaps_web";
const WEB_DIR = resolve(import.meta.dir, "web");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

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
  return o === `http://${HOST}:${PORT}` || o === `http://localhost:${PORT}`;
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
        if (qt !== null) {
          if (!tokenOk(qt)) return new Response("bad token\n", { status: 401 });
          return new Response(null, {
            status: 302,
            headers: { location: "/", "set-cookie": `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/` },
          });
        }
        if (!tokenOk(cookieToken(req))) {
          return new Response(`synaps-web: open the URL from ${urlFile()}\n`, { status: 401 });
        }
        if (url.pathname === "/ws") {
          if (!originOk(req)) return new Response("bad origin\n", { status: 403 });
          const ok = srv.upgrade(req, {
            data: { id: nextConn++, uds: null, pending: [], outBuf: Buffer.alloc(0), inBuf: "", dec: new TextDecoder(), ready: false },
          });
          return ok ? undefined : new Response("upgrade failed\n", { status: 400 });
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
          headers: { "content-type": MIME[ext], "cache-control": "no-store" },
        });
      },
      websocket: {
        maxPayloadLength: 4 * 1024 * 1024,
        async open(ws) {
          const d = ws.data;
          let info: DaemonInfo;
          try {
            info = findDaemon();
          } catch (e) {
            ws.send(JSON.stringify({ type: "error", session_id: null, message: `synaps-web: ${e}` }));
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
            ws.send(JSON.stringify({ type: "error", session_id: null, message: `synaps-web: cannot reach daemon at ${info.socket}: ${e}` }));
            ws.close(1011, "daemon unreachable");
            return;
          }
          // The bridge performs the handshake: the browser never sends Hello.
          const hello = {
            type: "hello",
            protocol_version: info.protocol_version,
            client: { kind: "server", terminal: null, instance: `synaps-web#${d.id}`, history: "digest", tail_items: 200 },
            cwd: daemonCwd(),
            client_version: `synaps-web/${VERSION}`,
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
            ws.send(JSON.stringify({ type: "error", session_id: null, message: "synaps-web: invalid JSON" }));
            return;
          }
          const v = filterFrame(f);
          if (!v.ok) {
            ws.send(JSON.stringify({ type: "error", session_id: null, message: `synaps-web: refused — ${v.why}` }));
            return;
          }
          const line = JSON.stringify(v.frame) + "\n";
          if (d.ready) udsWrite(d, line);
          else d.pending.push(line);
        },
        close(ws) {
          const d = ws.data;
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
  log(`serving on http://${HOST}:${PORT} → ${host.socket} (profile ${host.profile ?? "default"})`);
  writeUrlFile(host.profile);
}

let urlPath: string | null = null;
function urlFile(): string {
  return urlPath ?? join(runDir(), "synaps-web.url");
}

function writeUrlFile(profile: string | null) {
  urlPath = join(runDir(), profile ? `synaps-web-${profile}.url` : "synaps-web.url");
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
