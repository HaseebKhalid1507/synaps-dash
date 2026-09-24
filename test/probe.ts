// Dev probe: drive the daemon THROUGH the synaps-dash bridge exactly like a
// browser would (cookie + Origin), capture every frame for shape reference.
//   bun test/probe.ts [profile] [prompt]
// Writes all frames to /tmp/sw-probe.jsonl; prints a compact trace.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const profile = process.argv[2] ?? "webproto";
const prompt = process.argv[3] ?? "Say hello in exactly five words. Do not use any tools.";
const url = readFileSync(join(homedir(), ".synaps-cli/run", `synaps-dash-${profile}.url`), "utf8").trim();
const u = new URL(url);
const token = u.searchParams.get("token")!;
const origin = `${u.protocol}//${u.host}`;
const out = "/tmp/sw-probe.jsonl";
writeFileSync(out, "");

const ws = new WebSocket(`ws://${u.host}/ws`, { headers: { Cookie: `synaps_dash=${token}`, Origin: origin } } as any);
let sid: string | null = null;
let me: number | null = null;
let phase: "boot" | "turn" | "filter" | "done" = "boot";
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
const send = (f: unknown) => ws.send(JSON.stringify(f));

function brief(f: any): string {
  if (f.type !== "event") {
    if (f.type === "attached") return `attached client=${f.client} owner=${f.input_owner} clients=${JSON.stringify(f.clients)} tail=${f.display_tail?.items?.length ?? "-"} streaming=${f.streaming}`;
    if (f.type === "welcome") return `welcome daemon=${f.daemon_version} proto=${f.protocol_version} profile=${f.profile} sessions=${f.sessions.length}`;
    return `${f.type} ${JSON.stringify(f).slice(0, 160)}`;
  }
  const e = f.event;
  if (e.ev === "stream") {
    const s = e.event;
    const sub = s.llm ?? s.session ?? s.agent;
    const rest = { ...s };
    delete rest.kind; delete rest.llm; delete rest.session; delete rest.agent;
    return `  #${f.seq} stream.${s.kind}.${sub} ${JSON.stringify(rest).slice(0, 140)}`;
  }
  const rest = { ...e };
  delete rest.ev;
  return `  #${f.seq} ${e.ev} ${JSON.stringify(rest).slice(0, 160)}`;
}

ws.onopen = () => console.log(ts(), "ws open");
ws.onclose = (e) => { console.log(ts(), `ws closed ${e.code} ${e.reason}`); process.exit(0); };
ws.onerror = (e) => console.log(ts(), "ws error", (e as any).message ?? e);
ws.onmessage = (m) => {
  const f = JSON.parse(String(m.data));
  appendFileSync(out, JSON.stringify(f) + "\n");
  console.log(ts(), brief(f));
  if (f.type === "welcome") {
    send({ type: "attach", attach: "create", config: { auto_approve_confirms: true, prompt_manifest: "/etc/passwd" }, mode: "mirror" });
  } else if (f.type === "attached" && phase === "boot") {
    sid = f.meta.id; me = f.client; phase = "turn";
    console.log(ts(), `>>> submit (session ${sid})`);
    send({ type: "cmd", session_id: sid, cmd: { cmd: "submit", text: prompt, attachments: [] } });
  } else if (f.type === "event" && f.event.ev === "idle" && phase === "turn") {
    phase = "filter";
    console.log(ts(), ">>> filter test: shutdown / reload / purge / hello / end");
    send({ type: "shutdown", force: true });
    send({ type: "reload", now: true });
    send({ type: "purge" });
    send({ type: "hello", protocol_version: 3 });
    send({ type: "cmd", session_id: sid, cmd: { cmd: "end", reason: "client_quit" } });
    send({ type: "sessions" });
  } else if (f.type === "session_list" && phase === "filter") {
    phase = "done";
    setTimeout(() => ws.close(), 300);
  }
};
setTimeout(() => { console.log(ts(), "TIMEOUT"); process.exit(1); }, 90_000);
