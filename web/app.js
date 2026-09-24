// synaps-web client — speaks synaps daemon protocol v3 through the bridge.
// The bridge already did Hello; we get Welcome and drive attach/cmd from here.
"use strict";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ── state ─────────────────────────────────────────────────────────────────────
const S = {
  ws: null,
  welcome: null,
  sessions: [],
  sid: null, // attached session id
  me: null, // our ClientId
  owner: null, // input owner ClientId
  clients: new Map(), // ClientId -> kind
  streaming: false,
  wantSid: null, // session to attach on (re)connect
  wantMode: "mirror",
  wantCreate: false,
  intentionalClose: false,
  retry: 0,
  frames: 0,
  model: "",
  cur: null, // current assistant group {root, thinkingEl, thinkingRaw, textEl, textRaw, tools: Map}
  localSubmit: null, // text we submitted; the actor doesn't echo it back
  localSteers: [],
  qid: 1,
  queries: new Map(),
  prompt: null,
};

const T = $("transcript");

// ── markdown-lite (escape first, then a few safe transforms) ──────────────────
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}
function md(src) {
  const out = [];
  const parts = src.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const body = nl >= 0 ? part.slice(nl + 1) : part;
      out.push(`<pre><code>${esc(body.replace(/\n$/, ""))}</code></pre>`);
      return;
    }
    let list = null;
    const flush = () => { if (list) { out.push(`</${list}>`); list = null; } };
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(esc(para.join("\n"))).replace(/\n/g, "<br>")}</p>`); para = []; } };
    for (const line of part.split("\n")) {
      let m;
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flushPara(); flush(); out.push(`<h${m[1].length}>${inline(esc(m[2]))}</h${m[1].length}>`); }
      else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { flushPara(); if (list !== "ul") { flush(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(esc(m[1]))}</li>`); }
      else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); if (list !== "ol") { flush(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(esc(m[1]))}</li>`); }
      else if (line.trim() === "") { flushPara(); flush(); }
      else { flush(); para.push(line); }
    }
    flushPara(); flush();
  });
  return out.join("");
}

// ── transcript rendering ──────────────────────────────────────────────────────
function nearBottom() { return T.scrollHeight - T.scrollTop - T.clientHeight < 120; }
function stick(fn) { const b = nearBottom(); fn(); if (b) T.scrollTop = T.scrollHeight; }

function kindOf(cid) { return S.clients.get(cid) ?? "?"; }
function who(cid) {
  if (cid == null) return "";
  const k = kindOf(cid);
  const label = k === "server" ? "web" : k;
  return cid === S.me ? `#${cid} ${label} (you)` : `#${cid} ${label}`;
}

function addUser(text, src, extraCls = "") {
  const b = el("div", `blk user ${extraCls}`);
  const r = el("div", "role");
  r.append("user");
  if (src) { r.append(" · "); r.append(el("span", "src", src)); }
  b.append(r, el("div", "bubble", text));
  stick(() => T.append(b));
  return b;
}
function addSys(text, cls = "") { stick(() => T.append(el("div", `sys ${cls}`, text))); }

function newAsst() {
  const root = el("div", "blk asst");
  root.append(el("div", "role", "assistant"));
  const dots = el("div", "dots");
  root.append(dots);
  stick(() => T.append(root));
  S.cur = { root, dots, thinkingEl: null, thinkingRaw: "", textEl: null, textRaw: "", tools: new Map(), last: null };
  return S.cur;
}
function asst() { return S.cur ?? newAsst(); }
function undot(c) { if (c.dots) { c.dots.remove(); c.dots = null; } }

function appendThinking(t) {
  const c = asst(); undot(c);
  if (!c.thinkingEl || c.last !== "thinking") {
    c.thinkingEl = el("div", "thinking");
    c.thinkingEl.onclick = () => c.thinkingEl.classList.toggle("open");
    c.thinkingRaw = "";
    stick(() => c.root.append(c.thinkingEl));
  }
  c.thinkingRaw += t;
  c.thinkingEl.textContent = c.thinkingRaw;
  c.last = "thinking";
}
const mdDirty = new Set();
let mdPending = null;
function flushMd() {
  mdPending = null;
  stick(() => { for (const n of mdDirty) n.innerHTML = md(n._raw); });
  mdDirty.clear();
}
function appendText(t) {
  const c = asst(); undot(c);
  if (!c.textEl || c.last !== "text") {
    c.textEl = el("div", "text-body");
    c.textRaw = "";
    stick(() => c.root.append(c.textEl));
  }
  c.textRaw += t;
  c.textEl._raw = c.textRaw;
  c.last = "text";
  mdDirty.add(c.textEl);
  if (!mdPending) mdPending = requestAnimationFrame(flushMd);
}
function summarize(name, input) {
  if (input == null) return "";
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { return input; } }
  if (typeof input !== "object") return String(input);
  const k = input.command ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.task ?? input.agent;
  return k !== undefined ? String(k) : JSON.stringify(input);
}
function toolCard(id, name, inputStr) {
  const c = asst(); undot(c);
  const card = el("div", "blk tool");
  const head = el("div", "tool-head");
  const st = el("span", "tool-st", "◌ running");
  const sum = el("span", "tool-sum", "");
  head.append(el("span", "tool-name", name), sum, st);
  const io = el("div", "tool-io");
  const inp = el("div"); const res = el("div");
  io.append(inp, res);
  head.onclick = () => card.classList.toggle("open");
  card.append(head, io);
  stick(() => c.root.append(card));
  const t = { card, st, sum, inp, res, inRaw: "", resRaw: "", name };
  c.tools.set(id, t);
  c.last = "tool";
  if (inputStr !== undefined) setToolInput(t, inputStr);
  return t;
}
function setToolInput(t, input) {
  t.sum.textContent = summarize(t.name, input);
  const pretty = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  t.inp.innerHTML = `<span class="lbl">input</span>\n${esc(pretty)}`;
}
function setToolResult(t, text) {
  t.resRaw = text;
  const lines = text.split("\n");
  const shown = lines.length > 200 ? lines.slice(0, 200).join("\n") + `\n… ${lines.length - 200} more lines` : text;
  t.res.innerHTML = `\n<span class="lbl">result</span>\n${esc(shown)}`;
}
function toolDone(t, cls = "done", label = "✓ done") { t.card.classList.add(cls); t.st.textContent = label; }

function renderTail(tail, cutAfterLastUser = false) {
  if (!tail) return;
  let items = tail.items ?? [];
  if (cutAfterLastUser) {
    // Mid-turn attach: the current turn's partial progress is rebuilt from
    // the replay ring; keep its prompt, drop what replay will redraw.
    let i = items.length - 1;
    while (i >= 0 && items[i].kind !== "user") i--;
    if (i >= 0) items = items.slice(0, i + 1);
  }
  if (tail.omitted) T.append(el("div", "omitted", `… ${tail.omitted} earlier items not shown`));
  for (const it of items) {
    switch (it.kind) {
      case "user": S.cur = null; addUser(it.text); break;
      case "thinking": appendThinking(it.text); break;
      case "text": appendText(it.text); break;
      case "tool_use": { const t = toolCard(it.tool_id, it.tool_name, it.input); toolDone(t, "done", "✓"); break; }
    }
  }
  if (S.cur) undot(S.cur);
  S.cur = null;
}

// ── chrome ────────────────────────────────────────────────────────────────────
function setConn(state, text) {
  const c = $("conn");
  c.className = `conn ${state}`;
  $("conn-text").textContent = text;
}
function isOwner() { return S.me != null && S.owner === S.me; }
function renderClients() {
  const box = $("clients");
  box.innerHTML = "";
  for (const [cid] of [...S.clients].sort((a, b) => a[0] - b[0])) {
    const ch = el("span", "chip", who(cid));
    if (cid === S.me) ch.classList.add("me");
    if (cid === S.owner) ch.classList.add("owner");
    box.append(ch);
  }
}
function renderComposer() {
  const own = isOwner();
  $("watch-bar").classList.toggle("hidden", own || !S.sid);
  if (!own && S.sid) {
    $("watch-text").textContent = S.owner != null
      ? `👁 watching — input is owned by ${who(S.owner)}`
      : "👁 watching — nobody owns input";
  }
  $("input").disabled = !own;
  $("send").disabled = !own;
  $("send").textContent = S.streaming ? "steer" : "send";
  $("stop").classList.toggle("hidden", !(own && S.streaming));
  const st = $("st-state");
  st.textContent = S.streaming ? "● streaming" : S.sid ? "idle" : "";
  st.className = S.streaming ? "streaming" : "";
}
function renderSessions() {
  const ul = $("sessions");
  ul.innerHTML = "";
  if (!S.sessions.length) ul.append(el("li", "s-meta", "no sessions — start one in the TUI or click + new"));
  for (const s of [...S.sessions].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
    const li = el("li");
    if (s.id === S.sid) li.classList.add("active");
    li.append(el("div", "s-id", s.id));
    const meta = el("div", "s-meta");
    meta.append(`${s.model.replace(/^.*\//, "")} · `);
    meta.append(el("span", s.clients > 0 ? "s-live" : "", `${s.clients} client${s.clients === 1 ? "" : "s"}`));
    meta.append(` · ${s.lifecycle ?? ""}`);
    li.append(meta);
    li.onclick = () => { if (s.id !== S.sid) switchTo(s.id, "mirror"); };
    ul.append(li);
  }
}
function toast(msg, ms = 3500) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function fmtTokens(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

// ── protocol ──────────────────────────────────────────────────────────────────
function send(f) {
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(f));
}
function cmd(c) { send({ type: "cmd", session_id: S.sid, cmd: c }); }
function query(q, cb) {
  const id = S.qid++;
  S.queries.set(id, cb);
  cmd({ cmd: "query", id, query: q });
}

function connect() {
  setConn("", "connecting…");
  const ws = new WebSocket(`ws://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => { S.retry = 0; };
  ws.onmessage = (m) => onFrame(JSON.parse(m.data), m.data);
  ws.onclose = () => {
    S.me = null; S.owner = null; S.clients.clear(); S.streaming = false; S.cur = null;
    renderClients(); renderComposer();
    if (S.intentionalClose) { S.intentionalClose = false; connect(); return; }
    setConn("down", "disconnected — retrying…");
    const delay = Math.min(5000, 300 * 2 ** S.retry++);
    setTimeout(connect, delay);
  };
}
function switchTo(sid, mode, create = false) {
  S.wantSid = sid; S.wantMode = mode; S.wantCreate = create;
  S.intentionalClose = true;
  S.ws?.close();
}

function onFrame(f, raw) {
  S.frames++;
  $("frame-count").textContent = S.frames;
  if (!$("raw").classList.contains("hidden")) {
    const log = $("raw-log");
    log.textContent += raw.slice(0, 600) + "\n";
    if (log.textContent.length > 200000) log.textContent = log.textContent.slice(-150000);
  }
  switch (f.type) {
    case "welcome": return onWelcome(f);
    case "refused": setConn("down", `refused: ${f.message}`); return;
    case "session_list": S.sessions = f.sessions; renderSessions(); return;
    case "attached": return onAttached(f);
    case "event": if (f.session_id === S.sid) onEvent(f.event); return;
    case "error": toast(f.message, 6000); return;
    case "bye": return;
    case "pong": return;
  }
}

function onWelcome(w) {
  S.welcome = w;
  S.sessions = w.sessions;
  setConn("up", `daemon ${w.daemon_version} · proto ${w.protocol_version}`);
  $("daemon-info").textContent = `profile ${w.profile ?? "default"} · pid ${w.pid} · gen ${w.generation}`;
  renderSessions();
  let target = S.wantSid;
  if (S.wantCreate) {
    S.wantCreate = false;
    send({ type: "attach", attach: "create", config: {}, mode: "mirror" });
    return;
  }
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("s");
  if (!target && fromHash && w.sessions.some((s) => s.id === fromHash)) target = fromHash;
  if (!target || !w.sessions.some((s) => s.id === target)) {
    // Prefer the session someone is already on (e.g. the TUI), newest first.
    const sorted = [...w.sessions].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    target = (sorted.find((s) => s.clients > 0) ?? sorted[0])?.id ?? null;
  }
  if (target) send({ type: "attach", attach: "existing", session_id: target, mode: S.wantMode });
  else { T.innerHTML = ""; T.append(el("div", "omitted", "No live sessions. Start one in the TUI (synaps --attach) or click + new.")); }
  S.wantMode = "mirror";
}

function onAttached(a) {
  S.sid = a.meta.id;
  S.wantSid = S.sid;
  S.me = a.client;
  S.owner = a.input_owner ?? null;
  S.clients = new Map(a.clients.map(([c, k]) => [c, k]));
  S.streaming = !!a.streaming;
  S.model = a.view?.model ?? a.meta.model;
  S.cur = null; S.localSubmit = null;
  history.replaceState(null, "", `#s=${S.sid}`);
  const title = a.conversation?.header?.title;
  $("sess-title").textContent = `${S.sid}${title ? " — " + title : ""}`;
  $("st-model").textContent = `${S.model.replace(/^.*\//, "")} · thinking ${a.view?.thinking_level ?? "?"}`;
  updateCost(a.conversation);
  T.innerHTML = "";
  // `replay` is the LAST turn's ring even after it finished (the actor only
  // clears it at the next turn start), so apply it only mid-turn — else the
  // finished turn renders twice (display_tail already has it).
  const replay = a.streaming ? (a.replay ?? []) : [];
  const ts0 = replay.find((env) => env.event.ev === "turn_started")?.event;
  renderTail(a.display_tail, !!ts0 && (ts0.trigger === "user" || ts0.trigger === "plugin_command"));
  S.replaying = true;
  for (const env of replay) onEvent(env.event);
  S.replaying = false;
  S.streaming = !!a.streaming;
  if (S.streaming && !S.cur) newAsst();
  for (const p of a.pending_prompts ?? []) showPrompt(p);
  addSys(`attached as ${who(S.me)}${isOwner() ? " — you own input" : ""}`, "own");
  renderClients(); renderComposer(); renderSessions();
  T.scrollTop = T.scrollHeight;
}

function updateCost(c) {
  if (!c) return;
  const t = c.tokens ?? {};
  $("st-tokens").textContent = `↑${fmtTokens(t.input ?? 0)} ↓${fmtTokens(t.output ?? 0)}${t.cache_read ? ` ⟳${fmtTokens(t.cache_read)}` : ""}`;
  $("st-cost").textContent = `$${(c.cost ?? 0).toFixed(4)}`;
}

function onEvent(e) {
  switch (e.ev) {
    case "stream": return onStream(e.event);
    case "turn_started": {
      S.streaming = true;
      const trig = e.trigger;
      if (trig === "user" || trig === "plugin_command") {
        if (S.replaying) {
          // prompt already rendered from the display tail
        } else if (S.localSubmit !== null) {
          S.localSubmit = null; // we already drew our own prompt
        } else {
          // A peer (e.g. the TUI) submitted. The actor does not echo the text,
          // so fetch it from the display tail and fill the placeholder.
          const b = addUser("…", S.owner != null ? `via ${who(S.owner)}` : "via peer", "pending");
          query({ query: "display_tail", items: 12 }, (v) => {
            const items = v?.items ?? v?.display_tail?.items ?? [];
            const u = [...items].reverse().find((i) => i.kind === "user");
            b.classList.remove("pending");
            b.querySelector(".bubble").textContent = u ? u.text : "(prompt not available)";
          });
        }
      } else if (trig === "queued_auto" && e.user_text) {
        addUser(e.user_text, "queued");
      } else if (trig !== "user") {
        addSys(`turn started (${trig})`);
      }
      newAsst();
      renderComposer();
      return;
    }
    case "conversation": updateCost(e.digest); return;
    case "idle":
      S.streaming = false;
      if (S.cur) undot(S.cur);
      S.cur = null;
      renderComposer();
      return;
    case "prompt": return showPrompt(e.request);
    case "prompt_resolved": if (S.prompt?.id === e.prompt_id) hidePrompt(); return;
    case "system_notice": return addSys(e.text);
    case "steered": {
      const i = S.localSteers.indexOf(e.text);
      if (i >= 0) S.localSteers.splice(i, 1);
      else addUser(e.text, "steer · peer");
      return;
    }
    case "dequeued": return addSys(`dequeued: ${e.text}`);
    case "client_joined":
      S.clients.set(e.client, e.kind);
      if (e.client !== S.me) addSys(`${who(e.client)} joined`);
      renderClients(); renderComposer(); return;
    case "client_left":
      addSys(`${who(e.client)} left`);
      S.clients.delete(e.client);
      renderClients(); renderComposer(); return;
    case "input_owner_changed":
      S.owner = e.to ?? null;
      addSys(`input → ${e.to != null ? who(e.to) : "nobody"} (${e.reason})`, "own");
      renderClients(); renderComposer(); return;
    case "aborted":
      S.streaming = false;
      if (S.cur) { undot(S.cur); for (const t of S.cur.tools.values()) if (!t.card.classList.contains("done")) toolDone(t, "aborted", "✕ aborted"); }
      S.cur = null;
      addSys("⎋ turn aborted", "err");
      renderComposer(); return;
    case "ended": addSys(`session ended (${JSON.stringify(e.reason)})`, "err"); S.sid = null; renderComposer(); return;
    case "cleared": T.innerHTML = ""; S.sid = e.session_id; addSys(`session cleared → ${e.session_id}`); return;
    case "refused":
      if (e.client === S.me) {
        toast(`refused: ${e.reason}`, 5000);
        const last = T.querySelector(".user:last-of-type");
        if (S.localSubmit !== null && last) last.classList.add("refused");
        S.localSubmit = null;
      }
      return;
    case "attach_refused": toast(`attach refused: ${e.message}`, 6000); return;
    case "query_result": {
      const cb = S.queries.get(e.id);
      if (cb) { S.queries.delete(e.id); cb(e.value); }
      return;
    }
    case "reloading": addSys(`daemon reloading (gen ${e.generation}) — reconnecting…`); return;
    case "compaction_started": return addSys("compacting…");
    case "compaction_applied": return addSys(`compacted ${e.msg_count} messages → ${e.session_id}`);
    case "compaction_failed": return addSys(`compaction failed: ${e.message}`, "err");
    case "cost_cap_reached": return addSys(`cost cap reached (${e.scope}): $${e.cost.toFixed(2)} / $${e.cap.toFixed(2)}`, "err");
    case "driver_armed": return addSys(`driver armed: ${e.plugin_id}`);
    case "driver_revoked": return addSys(`driver revoked: ${e.reason}`);
    default: return; // lifecycle, subagent_rows, loader_progress, unknown …
  }
}

function onStream(s) {
  if (s.kind === "llm") {
    switch (s.llm) {
      case "response_start": asst(); return;
      case "response_reset": if (S.cur) { S.cur.textRaw = ""; S.cur.textEl?.remove(); S.cur.textEl = null; } return;
      case "thinking": return appendThinking(s.text);
      case "text": return appendText(s.text);
      case "tool_use_start": toolCard(s.tool_id, s.tool_name); return;
      case "tool_use_delta": { const t = asst().tools.get(s.tool_id); if (t) { t.inRaw += s.delta; t.sum.textContent = t.inRaw.slice(0, 200); } return; }
      case "tool_use": { const t = asst().tools.get(s.tool_id) ?? toolCard(s.tool_id, s.tool_name); setToolInput(t, s.input); return; }
      case "tool_result_delta": { const t = S.cur?.tools.get(s.tool_id); if (t) setToolResult(t, t.resRaw + s.delta); return; }
      case "tool_result": { const t = S.cur?.tools.get(s.tool_id); if (t) { setToolResult(t, s.result); toolDone(t); } if (S.cur) S.cur.last = "tool"; return; }
    }
  } else if (s.kind === "session") {
    switch (s.session) {
      case "usage": if (s.model) $("st-model").textContent = s.model.replace(/^.*\//, ""); return;
      case "error": return addSys(`error: ${s.message}`, "err");
      case "notice": return addSys(s.text);
      case "done": return;
    }
  } else if (s.kind === "agent") {
    switch (s.agent) {
      case "subagent_start": return addSys(`⇢ subagent ${s.agent_name}: ${s.task_preview}`);
      case "subagent_done": return addSys(`⇠ subagent ${s.agent_name} done (${s.duration_secs.toFixed(1)}s)`);
      case "steering_delivered": return addSys(`steering delivered: ${s.message}`);
    }
  }
}

// ── prompts (confirm / secret) ────────────────────────────────────────────────
function showPrompt(p) {
  S.prompt = p;
  $("modal-title").textContent = p.title;
  $("modal-prompt").textContent = p.prompt;
  const secret = p.kind === "secret";
  $("modal-secret").classList.toggle("hidden", !secret);
  $("modal-secret").value = "";
  $("modal-yes").textContent = secret ? "submit" : "allow";
  $("modal").classList.remove("hidden");
  if (secret) $("modal-secret").focus();
}
function hidePrompt() { S.prompt = null; $("modal").classList.add("hidden"); }
function answer(value) {
  if (!S.prompt) return;
  cmd({ cmd: "answer", prompt_id: S.prompt.id, value });
  hidePrompt();
}
$("modal-yes").onclick = () => answer(S.prompt?.kind === "secret" ? $("modal-secret").value : "y");
$("modal-no").onclick = () => answer(S.prompt?.kind === "secret" ? null : "n");

// ── composer ──────────────────────────────────────────────────────────────────
function doSend() {
  const input = $("input");
  const text = input.value.trim();
  if (!text || !S.sid) return;
  if (!isOwner()) { toast("you don't own input — take over first"); return; }
  if (S.streaming) {
    S.localSteers.push(text);
    addUser(text, "steer · you");
    cmd({ cmd: "steer", text });
  } else {
    S.cur = null;
    addUser(text, who(S.me));
    S.localSubmit = text;
    cmd({ cmd: "submit", text, attachments: [] });
  }
  input.value = "";
  autosize();
}
function autosize() { const i = $("input"); i.style.height = "auto"; i.style.height = Math.min(220, i.scrollHeight) + "px"; }
$("input").addEventListener("input", autosize);
$("input").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); doSend(); }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (S.prompt) { answer(S.prompt.kind === "secret" ? null : "n"); return; }
    if (S.streaming && isOwner()) cmd({ cmd: "cancel" });
  }
});
$("send").onclick = doSend;
$("stop").onclick = () => cmd({ cmd: "cancel" });
$("takeover").onclick = () => { if (S.sid) switchTo(S.sid, "takeover"); };
$("new-session").onclick = () => switchTo(null, "mirror", true);
$("toggle-raw").onclick = () => $("raw").classList.toggle("hidden");

// Keep the session list fresh (control fast path; no session needed).
setInterval(() => send({ type: "sessions" }), 4000);
connect();
