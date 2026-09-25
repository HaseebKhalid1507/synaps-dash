// synaps·dash client — speaks synaps daemon protocol v3 through the bridge,
// paints itself with the live MXC (album) palette the bridge forwards.
"use strict";

const $ = (id) => document.getElementById(id);
const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ── icons (lucide-style strokes, inline) ──────────────────────────────────────
const P = {
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 12.6 12.6 21a2.1 2.1 0 0 1-3-3L18 9.6l-1.3-1.3a4 4 0 0 0-5-5l2.4 2.4z"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 4 10.5 3 3 0 0 0 5 16a3 3 0 0 0 4 3h.5V4z"/><path d="M15 4a3 3 0 0 1 3 3v.5a3 3 0 0 1 2 3 3 3 0 0 1-1 5.5 3 3 0 0 1-4 3h-.5V4z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
};
const svg = (name, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24">${P[name] || P.wrench}</svg>`;
function toolIcon(name = "") {
  const n = name.toLowerCase();
  if (/bash|shell|exec|command|run/.test(n)) return "terminal";
  if (/^(read|cat|view|download|open)|read_|download/.test(n)) return "file";
  if (/write|edit|patch|replace|save/.test(n)) return "pencil";
  if (/grep|find|search|glob|list|ls/.test(n)) return "search";
  if (/fetch|web|http|url|browse/.test(n)) return "globe";
  if (/agent|subagent|delegate/.test(n)) return "sparkles";
  if (/mail/.test(n)) return "mail";
  if (/hubspot|crm|vault|knowledge/.test(n)) return "box";
  return "wrench";
}

// ── state ─────────────────────────────────────────────────────────────────────
const S = {
  ws: null, welcome: null, sessions: [],
  sid: null, me: null, owner: null, clients: new Map(),
  streaming: false, replaying: false,
  wantSid: null, wantMode: "mirror", wantCreate: false, intentionalClose: false, retry: 0,
  cur: null, localSubmit: null, steers: [], // steer bubbles + their delivery state
  qid: 1, queries: new Map(), prompt: null, model: "",
  turnTools: new Map(), // tool_id → card, across split segments of the current turn
  atBottom: true,
};
const T = $("thread");
const SC = $("scroller");

// ── MXC palette ───────────────────────────────────────────────────────────────
const MXC_VARS = {
  background: "--bg", background_panel: "--panel", background_element: "--elem", text: "--text", text_muted: "--muted",
  primary: "--primary", secondary: "--secondary", accent: "--accent", error: "--error", warning: "--warning",
  success: "--success", info: "--info", border: "--border", border_active: "--border-active",
  border_subtle: "--border-subtle", border_dimmest: "--border-dim",
};
function applyPalette(p) {
  const root = document.documentElement.style;
  if (p && p.colors) {
    root.setProperty("--fade", `${Math.max(0, Number(p.fade_ms) || 600)}ms`);
    for (const [k, v] of Object.entries(MXC_VARS)) if (p.colors[k]) root.setProperty(v, p.colors[k]);
  } else {
    for (const v of Object.values(MXC_VARS)) root.removeProperty(v);
  }
  const sw = $("swatches");
  sw.innerHTML = "";
  for (const k of ["primary", "secondary", "accent", "success", "error"]) {
    const s = h("span");
    s.style.background = `var(${MXC_VARS[k]})`;
    sw.append(s);
  }
  sw.append(h("span", "lbl", p ? "♪ album palette" : "myx default"));
}

// ── markdown (escape first, then safe transforms) ─────────────────────────────
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, "%22")}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, a, u) => `${a}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}
const KW = /\b(const|let|var|function|return|if|else|for|while|import|from|export|class|new|async|await|fn|pub|impl|struct|enum|match|use|mod|def|self|None|True|False|null|true|false|undefined|in|of|try|catch|throw|type|interface|echo|then|fi|do|done|case|esac)\b/g;
function highlight(code) {
  const out = [];
  const re = /(\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)/g;
  let last = 0, m;
  while ((m = re.exec(code))) {
    out.push(esc(code.slice(last, m.index)).replace(KW, '<span class="tok-k">$1</span>').replace(/\b([a-zA-Z_]\w*)(?=\()/g, '<span class="tok-f">$1</span>'));
    const cls = m[1] ? "tok-c" : m[2] ? "tok-s" : "tok-n";
    out.push(`<span class="${cls}">${esc(m[0])}</span>`);
    last = re.lastIndex;
  }
  out.push(esc(code.slice(last)).replace(KW, '<span class="tok-k">$1</span>').replace(/\b([a-zA-Z_]\w*)(?=\()/g, '<span class="tok-f">$1</span>'));
  return out.join("");
}
function codeBlock(lang, body) {
  return `<div class="codeblock"><div class="cb-head"><span>${esc(lang || "code")}</span><button class="copy" data-copy>${svg("copy")}Copy</button></div><pre><code>${highlight(body)}</code></pre></div>`;
}
function table(rows) {
  const cells = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => inline(c.trim()));
  const [head, , ...body] = rows;
  return `<table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function md(src) {
  const out = [];
  const parts = src.split(/^```/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      out.push(codeBlock(nl >= 0 ? part.slice(0, nl).trim() : "", (nl >= 0 ? part.slice(nl + 1) : "").replace(/\n$/, "")));
      return;
    }
    const lines = part.split("\n");
    let list = null, para = [], quote = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`); quote = []; } };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      let m;
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[j + 1] || "")) {
        flushAll();
        const rows = [line];
        while (j + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[j + 1])) rows.push(lines[++j]);
        out.push(table(rows));
      } else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flushAll(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
      else if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line)) { flushAll(); out.push("<hr>"); }
      else if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); }
      else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { flushPara(); flushQuote(); if (list !== "ul") { flushList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); flushQuote(); if (list !== "ol") { flushList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
      else if (line.trim() === "") flushAll();
      else { flushList(); flushQuote(); para.push(line); }
    }
    flushAll();
  });
  return out.join("");
}

// ── scroll follow ─────────────────────────────────────────────────────────────
SC.addEventListener("scroll", () => {
  S.atBottom = SC.scrollHeight - SC.scrollTop - SC.clientHeight < 90;
  if (S.atBottom) $("jump").classList.remove("show");
}, { passive: true });
let followQueued = false;
function follow() {
  if (followQueued) return;
  followQueued = true;
  requestAnimationFrame(() => {
    followQueued = false;
    if (S.atBottom) SC.scrollTop = SC.scrollHeight;
    else if (S.streaming) $("jump").classList.add("show");
  });
}
$("jump").onclick = () => { SC.scrollTo({ top: SC.scrollHeight, behavior: "smooth" }); $("jump").classList.remove("show"); };
const add = (node, parent = T) => { parent.append(node); follow(); return node; };

// ── transcript ────────────────────────────────────────────────────────────────
const kindLabel = (k) => (k === "server" ? "web" : k || "?");
function who(cid) {
  if (cid == null) return "";
  const label = `#${cid} ${kindLabel(S.clients.get(cid))}`;
  return cid === S.me ? `${label} (you)` : label;
}
const clock = (d = new Date()) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function addUser(text, src, extra = "") {
  splitAsst();
  const m = h("div", `msg user ${extra}`);
  m.append(h("div", "bubble", text), h("div", "meta", `${src ? src + " · " : ""}${clock()}`));
  return add(m);
}
function addSys(text, cls = "") { splitAsst(); return add(h("div", `sys ${cls}`, text)); }

// ── steering: a bubble per steer, with live delivery status ───────────────────
// steered{delivered} → queued/waiting; stream.agent.steering_delivered{message}
// → delivered; turn_started{queued_auto,user_text} → follow-up; dequeued (cancel)
// → returned to input; still unacknowledged at idle → lost.
const STEER = {
  sending: ["⋯", "sending"],
  queued: ["◷", "queued — lands at the next step"],
  waiting: ["◷", "queued — sends after this turn"],
  delivered: ["✓", "delivered"],
  followup: ["↻", "sent as follow-up"],
  returned: ["↩", "not delivered — back in your input"],
  lost: ["✗", "not delivered"],
};
const STEER_OPEN = ["sending", "queued", "waiting"];
function setSteer(st, state) {
  st.state = state;
  st.m.dataset.steer = state;
  const [ico, label] = STEER[state];
  st.st.innerHTML = "";
  st.st.append(h("span", "ico", ico), h("span", null, label));
}
function addSteer(text, by, local, state) {
  splitAsst();
  const m = h("div", "msg user steer");
  const meta = h("div", "meta");
  const st = h("span", "steer-st");
  meta.append(`steer · ${by} · ${clock()} · `, st);
  m.append(h("div", "bubble", text), meta);
  add(m);
  const rec = { text, m, st, local, state: "" };
  S.steers.push(rec);
  setSteer(rec, state);
  return rec;
}
const findSteer = (text, states = STEER_OPEN) => S.steers.find((x) => x.text === text && states.includes(x.state));

function newAsst(cont = false) {
  const root = h("div", `msg asst live${cont ? " cont" : ""}`);
  root.innerHTML = '<div class="avatar">S</div>';
  const body = h("div", "body");
  root.append(body);
  add(root);
  S.cur = { root, body, think: null, thinkRaw: "", thinkStart: 0, text: null, textRaw: "", tools: new Map(), last: null, group: null };
  return S.cur;
}
const asst = () => S.cur ?? newAsst(S.split);

// ── activity groups ───────────────────────────────────────────────────────────
// Consecutive thinking blocks and tool calls batch into ONE collapsible row
// ("Thought for 6s · ran 3 commands · read 2 files"); assistant text breaks the
// batch. A batch of one renders flat (no group chrome).
const CAT = {
  terminal: ["command", "commands", "Running"], file: ["read", "reads", "Reading"], pencil: ["edit", "edits", "Editing"],
  search: ["search", "searches", "Searching"], globe: ["fetch", "fetches", "Fetching"], sparkles: ["subagent", "subagents", "Delegating"],
  mail: ["email", "emails", "Emailing"], box: ["lookup", "lookups", "Looking up"], wrench: ["tool call", "tool calls", "Calling"],
};
function groupFor(c) {
  if (c.group && (c.last === "think" || c.last === "tool")) return c.group;
  const el = h("details", "activity single");
  el.innerHTML = `<summary class="act-head"><span class="act-ico">${svg("layers")}</span><span class="act-lbl"></span><span class="act-st"></span>${svg("chev", "i chev")}</summary><div class="act-body"></div>`;
  add(el, c.body);
  c.group = { el, body: el.querySelector(".act-body"), lbl: el.querySelector(".act-lbl"), st: el.querySelector(".act-st"), items: [] };
  return c.group;
}
function closeGroup(c) { if (c?.group) { updateGroup(c.group); c.group = null; } }
function updateGroup(g) {
  if (!g) return;
  const items = g.items;
  if (items.length < 2) { g.el.classList.add("single"); g.el.open = true; return; }
  // becoming a real batch: collapse once (never override a later user toggle)
  if (g.el.classList.contains("single")) { g.el.classList.remove("single"); g.el.open = false; }
  const running = items.find((it) => (it.kind === "think" ? it.el.classList.contains("active") : !it.t.done));
  const counts = new Map();
  let thinkSecs = 0, thinks = 0, errs = 0;
  for (const it of items) {
    if (it.kind === "think") { thinks++; thinkSecs += it.secs || 0; continue; }
    const k = toolIcon(it.t.name);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (it.t.card.classList.contains("err")) errs++;
  }
  const parts = [];
  if (thinks) parts.push(thinkSecs ? `Thought for ${thinkSecs}s` : thinks > 1 ? `Thought ${thinks}×` : "Thought");
  for (const [k, n] of counts) { const [one, many] = CAT[k] || CAT.wrench; parts.push(`${n} ${n === 1 ? one : many}`); }
  if (running && !S.replaying) {
    const cur = running.kind === "think" ? "Thinking…" : `${(CAT[toolIcon(running.t.name)] || CAT.wrench)[2]} ${running.t.sum.textContent || running.t.name}`;
    g.lbl.innerHTML = "";
    g.lbl.append(h("span", "act-now", cur), h("span", "act-meta", ` · ${items.length} steps`));
    g.st.innerHTML = '<span class="spinner"></span>';
    g.el.classList.add("live");
  } else {
    g.lbl.textContent = parts.join(" · ");
    g.st.innerHTML = errs ? `${svg("x")}<span>${errs} failed</span>` : svg("check");
    g.el.classList.toggle("has-err", errs > 0);
    g.el.classList.remove("live");
  }
}

function closeThinking(c) {
  if (!c || !c.think || !c.think.classList.contains("active")) return;
  c.think.classList.remove("active");
  const secs = c.thinkStart ? Math.max(1, Math.round((performance.now() - c.thinkStart) / 1000)) : 0;
  c.think.querySelector(".lbl").textContent = secs && !S.replaying ? `Thought for ${secs}s` : "Thoughts";
  if (c.think._item) { c.think._item.secs = S.replaying ? 0 : secs; updateGroup(c.think._group); }
}
function dropCaret(c) { c?.body.querySelectorAll(".caret").forEach((x) => x.remove()); }
// A mid-turn insert (steer bubble, notice) must not sink below later output:
// end the current assistant segment so the stream continues in a NEW segment
// below it. In-flight tools stay alive (resolved via S.turnTools).
function splitAsst() {
  const c = S.cur;
  if (!c || !S.streaming || S.replaying) return;
  closeThinking(c);
  dropCaret(c);
  if (c.text) { c.text._live = false; markDirty(c.text); }
  closeGroup(c);
  c.root.classList.remove("live");
  if (!c.body.children.length) c.root.remove();
  S.cur = null;
  S.split = true;
}
function finishAsst() {
  const c = S.cur;
  for (const t of S.turnTools.values()) if (!t.done) toolDone(t, "err", "stopped");
  S.turnTools.clear();
  S.split = false;
  if (!c) return;
  closeThinking(c);
  dropCaret(c);
  closeGroup(c);
  c.root.classList.remove("live");
  if (!c.body.children.length) c.root.remove();
  S.cur = null;
}

function appendThinking(text) {
  const c = asst();
  if (!c.think || c.last !== "think") {
    const d = h("details", "think active");
    d.innerHTML = `<summary>${svg("brain")}<span class="lbl">Thinking…</span>${svg("chev", "i chev")}</summary><div class="think-body"></div>`;
    c.think = d; c.thinkRaw = ""; c.thinkStart = performance.now();
    const g = groupFor(c);
    add(d, g.body);
    d._item = { kind: "think", el: d, secs: 0 };
    d._group = g;
    g.items.push(d._item);
    c.last = "think";
    updateGroup(g);
  }
  c.thinkRaw += text;
  c.think.querySelector(".think-body").textContent = c.thinkRaw;
  c.last = "think";
}

const mdDirty = new Set();
let mdQueued = false;
function flushMd() {
  mdQueued = false;
  for (const n of mdDirty) {
    n.innerHTML = md(n._raw);
    if (n._live) n.insertAdjacentHTML("beforeend", '<span class="caret"></span>');
  }
  mdDirty.clear();
  follow();
}
function markDirty(n) { mdDirty.add(n); if (!mdQueued) { mdQueued = true; requestAnimationFrame(flushMd); } }

function appendText(text) {
  const c = asst();
  closeThinking(c);
  if (!c.text || c.last !== "text") {
    closeGroup(c);
    if (c.text) { c.text._live = false; markDirty(c.text); }
    c.text = add(h("div", "md"), c.body);
    c.textRaw = "";
  }
  c.textRaw += text;
  c.text._raw = c.textRaw;
  c.text._live = !S.replaying;
  c.last = "text";
  markDirty(c.text);
}

function summarize(input) {
  if (input == null) return "";
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { return input; } }
  if (typeof input !== "object") return String(input);
  const k = input.command ?? input.cmd ?? input.path ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.upload_id ?? input.task ?? input.agent ?? input.name;
  return k !== undefined ? String(k) : JSON.stringify(input);
}
function toolCard(id, name, input) {
  const c = asst();
  closeThinking(c);
  if (c.text) { c.text._live = false; markDirty(c.text); }
  const card = h("div", "tool");
  card.innerHTML = `<button class="tool-head"><span class="tool-ico">${svg(toolIcon(name))}</span><span class="tool-name"></span><span class="tool-sum"></span><span class="tool-st"><span class="spinner"></span></span>${svg("chev", "i chev")}</button><div class="tool-body"><div class="tool-sec in"><div class="lbl">Input</div><pre></pre></div><div class="tool-sec out ${/bash|shell|exec/.test(name) ? "term" : ""} hidden"><div class="lbl">Output</div><pre></pre></div></div>`;
  card.querySelector(".tool-name").textContent = name || "tool";
  card.querySelector(".tool-head").onclick = () => card.classList.toggle("open");
  const g = groupFor(c);
  add(card, g.body);
  const t = { card, name, start: performance.now(), inRaw: "", outRaw: "", done: false,
    sum: card.querySelector(".tool-sum"), st: card.querySelector(".tool-st"),
    inp: card.querySelector(".in pre"), out: card.querySelector(".out pre"), outSec: card.querySelector(".out") };
  c.tools.set(id, t);
  S.turnTools.set(id, t);
  c.last = "tool";
  t.group = g;
  g.items.push({ kind: "tool", t });
  if (input !== undefined) setToolInput(t, input);
  updateGroup(g);
  return t;
}
function setToolInput(t, input) {
  t.sum.textContent = summarize(input);
  t.inp.textContent = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  updateGroup(t.group);
}
function setToolOutput(t, text) {
  t.outRaw = text;
  const lines = text.split("\n");
  t.out.textContent = lines.length > 400 ? lines.slice(0, 400).join("\n") + `\n… ${lines.length - 400} more lines` : text;
  t.outSec.classList.remove("hidden");
}
function toolDone(t, cls = "ok", label) {
  if (t.done) return;
  t.done = true;
  t.card.classList.add(cls);
  const ms = performance.now() - t.start;
  const dur = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  t.st.innerHTML = `${svg(cls === "ok" ? "check" : "x")}<span>${label || (S.replaying ? "" : dur)}</span>`;
  updateGroup(t.group);
}

function renderTail(tail, cutAfterLastUser = false) {
  if (!tail) return;
  let items = tail.items ?? [];
  if (cutAfterLastUser) {
    let i = items.length - 1;
    while (i >= 0 && items[i].kind !== "user") i--;
    if (i >= 0) items = items.slice(0, i + 1);
  }
  if (tail.omitted) T.append(h("div", "omitted", `${tail.omitted} earlier items not shown`));
  const was = S.replaying;
  S.replaying = true;
  for (const it of items) {
    switch (it.kind) {
      case "user": finishAsst(); addUser(it.text); break;
      case "thinking": appendThinking(it.text); closeThinking(S.cur); break;
      case "text": appendText(it.text); break;
      case "tool_use": { const t = toolCard(it.tool_id, it.tool_name, it.input); toolDone(t, "ok", ""); break; }
    }
  }
  finishAsst();
  S.replaying = was;
}

// ── chrome ────────────────────────────────────────────────────────────────────
function setConn(state, text) { $("conn").className = state; $("conn-text").textContent = text; }
const isOwner = () => S.me != null && S.owner === S.me;
function renderPresence() {
  const box = $("presence");
  box.innerHTML = "";
  for (const [cid, kind] of [...S.clients].sort((a, b) => a[0] - b[0])) {
    const a = h("div", "av", kindLabel(kind).slice(0, 1).toUpperCase());
    a.title = who(cid) + (cid === S.owner ? " — owns input" : "");
    if (cid === S.me) a.classList.add("me");
    if (cid === S.owner) a.classList.add("owner");
    box.append(a);
  }
}
function renderComposer() {
  const own = isOwner();
  $("watchbar").classList.toggle("hidden", own || !S.sid);
  if (!own && S.sid) $("watch-text").textContent = S.owner != null ? `Watching — ${who(S.owner)} is driving` : "Watching — nobody owns input";
  $("input").disabled = !own;
  $("input").placeholder = own ? (S.streaming ? "Steer the running turn…" : "Message synaps…") : "Take over to type";
  const send = $("send");
  const stop = own && S.streaming && !$("input").value.trim();
  send.classList.toggle("stop", stop);
  send.querySelector(".ico-send").classList.toggle("hidden", stop);
  send.querySelector(".ico-stop").classList.toggle("hidden", !stop);
  send.title = stop ? "Stop (Esc)" : S.streaming ? "Steer (Enter)" : "Send (Enter)";
  send.disabled = !own;
}
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function renderSessions() {
  const ul = $("sessions");
  ul.innerHTML = "";
  if (!S.sessions.length) { ul.append(h("li", "rail-empty", "No sessions yet — start one here or in the TUI.")); return; }
  for (const s of [...S.sessions].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
    const li = h("li");
    if (s.id === S.sid) li.classList.add("active");
    li.append(h("div", "s-title", s.name || (s.id === S.sid && S.title) || s.id));
    const meta = h("div", "s-meta");
    const dot = h("span", `s-dot ${s.clients > 0 ? "live" : ""}`);
    meta.append(dot, `${(s.model || "").replace(/^.*\//, "")} · ${s.clients} · ${ago(s.created_at)}`);
    li.append(meta);
    li.onclick = () => { if (s.id !== S.sid) switchTo(s.id, "mirror"); if (innerWidth < 860) $("app").classList.remove("rail-open"); };
    ul.append(li);
  }
}
function toast(msg, cls = "", ms = 3600) {
  const t = h("div", `toast ${cls}`, msg);
  $("toasts").append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 180); }, ms);
}
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
function updateCost(c) {
  if (!c) return;
  const title = c.header?.title;
  if (title && title !== S.title) { S.title = title; $("sess-title").textContent = title; renderSessions(); }
  const t = c.tokens ?? {};
  $("st-tokens").textContent = `↑${fmtTok(t.input ?? 0)} ↓${fmtTok(t.output ?? 0)}`;
  $("st-cost").textContent = `$${(c.cost ?? 0).toFixed(4)}`;
}
function emptyState(title, sub) {
  T.innerHTML = "";
  const e = h("div", "empty");
  e.innerHTML = `<div><div class="glyph">S</div><h2></h2><p></p></div>`;
  e.querySelector("h2").textContent = title;
  e.querySelector("p").textContent = sub;
  T.append(e);
}

// ── protocol ──────────────────────────────────────────────────────────────────
const send = (f) => { if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(f)); };
const cmd = (c) => send({ type: "cmd", session_id: S.sid, cmd: c });
function query(q, cb) { const id = S.qid++; S.queries.set(id, cb); cmd({ cmd: "query", id, query: q }); }

function connect() {
  setConn("", "connecting…");
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => { S.retry = 0; };
  ws.onmessage = (m) => onFrame(JSON.parse(m.data));
  ws.onclose = () => {
    S.me = null; S.owner = null; S.clients.clear(); S.streaming = false;
    finishAsst(); renderPresence(); renderComposer();
    if (S.intentionalClose) { S.intentionalClose = false; connect(); return; }
    setConn("down", "reconnecting…");
    setTimeout(connect, Math.min(5000, 300 * 2 ** S.retry++));
  };
}
function switchTo(sid, mode, create = false) {
  S.wantSid = sid; S.wantMode = mode; S.wantCreate = create;
  S.intentionalClose = true;
  S.ws?.close();
}

function onFrame(f) {
  switch (f.type) {
    case "mxc": return applyPalette(f.palette);
    case "welcome": return onWelcome(f);
    case "refused": setConn("down", "refused"); toast(f.message, "err", 8000); return;
    case "session_list": S.sessions = f.sessions; renderSessions(); return;
    case "attached": return onAttached(f);
    case "event": if (f.session_id === S.sid) onEvent(f.event); return;
    case "error": toast(f.message, "err", 6000); return;
  }
}

function onWelcome(w) {
  S.welcome = w;
  S.sessions = w.sessions;
  setConn("up", `v${w.daemon_version}`);
  $("daemon-info").textContent = `${w.profile ?? "default"} · daemon ${w.daemon_version} · gen ${w.generation}`;
  renderSessions();
  if (S.wantCreate) { S.wantCreate = false; send({ type: "attach", attach: "create", config: {}, mode: "mirror" }); return; }
  let target = S.wantSid;
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("s");
  if (!target && fromHash && w.sessions.some((s) => s.id === fromHash)) target = fromHash;
  if (!target || !w.sessions.some((s) => s.id === target)) {
    const sorted = [...w.sessions].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    target = (sorted.find((s) => s.clients > 0) ?? sorted[0])?.id ?? null;
  }
  if (target) send({ type: "attach", attach: "existing", session_id: target, mode: S.wantMode });
  else emptyState("No live sessions", "Start one with + New session, or run synaps --attach in a terminal.");
  S.wantMode = "mirror";
}

function onAttached(a) {
  S.sid = a.meta.id; S.wantSid = S.sid; S.me = a.client; S.owner = a.input_owner ?? null;
  S.clients = new Map(a.clients.map(([c, k]) => [c, k]));
  S.model = a.view?.model ?? a.meta.model;
  S.title = a.conversation?.header?.title || "";
  S.cur = null; S.localSubmit = null;
  history.replaceState(null, "", `#s=${S.sid}`);
  $("sess-title").textContent = S.title || S.sid;
  const chip = $("model-chip");
  chip.innerHTML = `${svg("cpu")}<span></span>`;
  chip.querySelector("span").textContent = `${S.model.replace(/^.*\//, "")} · ${a.view?.thinking_level ?? "?"}`;
  chip.classList.remove("hidden");
  $("st-model").textContent = S.model.replace(/^.*\//, "");
  updateCost(a.conversation);
  T.innerHTML = "";
  // `replay` holds the LAST turn even after it finished — apply it only mid-turn,
  // else the finished turn renders twice (display_tail already has it).
  const replay = a.streaming ? (a.replay ?? []) : [];
  const ts0 = replay.find((env) => env.event.ev === "turn_started")?.event;
  renderTail(a.display_tail, !!ts0 && (ts0.trigger === "user" || ts0.trigger === "plugin_command"));
  if (!T.children.length) emptyState(S.title || "New session", "Say something — every client on this session sees it live.");
  S.replaying = true;
  for (const env of replay) onEvent(env.event);
  S.replaying = false;
  S.streaming = !!a.streaming;
  if (S.streaming && !S.cur) newAsst();
  for (const p of a.pending_prompts ?? []) showPrompt(p);
  renderPresence(); renderComposer(); renderSessions();
  requestAnimationFrame(() => { SC.scrollTop = SC.scrollHeight; S.atBottom = true; });
  if (isOwner()) $("input").focus();
}

function onEvent(e) {
  switch (e.ev) {
    case "stream": return onStream(e.event);
    case "turn_started": {
      T.querySelector(".empty")?.remove();
      S.streaming = true;
      const trig = e.trigger;
      if (trig === "user" || trig === "plugin_command") {
        if (S.replaying) { /* prompt already rendered from the display tail */ }
        else if (S.localSubmit !== null) S.localSubmit = null;
        else {
          // A peer (e.g. the TUI) submitted; the actor does not echo the text.
          const b = addUser("…", S.owner != null ? `via ${who(S.owner)}` : "via peer", "pending");
          query({ query: "display_tail", items: 12 }, (v) => {
            const u = [...(v?.items ?? [])].reverse().find((i) => i.kind === "user");
            b.classList.remove("pending");
            b.querySelector(".bubble").textContent = u ? u.text : "(prompt not available)";
            follow();
          });
        }
      } else if (trig === "queued_auto" && e.user_text) {
        const st = findSteer(e.user_text);
        if (st) setSteer(st, "followup"); else addUser(e.user_text, "queued");
      }
      else addSys(`turn started · ${trig}`);
      finishAsst();
      newAsst();
      renderComposer();
      return;
    }
    case "conversation": return updateCost(e.digest);
    case "idle":
      S.streaming = false;
      for (const st of S.steers) if (st.state === "sending") setSteer(st, "lost");
      S.steers = S.steers.filter((st) => STEER_OPEN.includes(st.state));
      finishAsst(); renderComposer(); return;
    case "prompt": return showPrompt(e.request);
    case "prompt_resolved": if (S.prompt?.id === e.prompt_id) hidePrompt(); return;
    case "system_notice":
      // The daemon broadcasts its CLI attach hint ("input is owned by client #N …
      // attach with --takeover") to EVERY client whenever anyone mirror-attaches.
      // The web shows ownership in the watch bar; the hint is noise here.
      if (/^input is owned by client #\d+/.test(e.text)) return;
      return addSys(e.text);
    case "steered": {
      const st = findSteer(e.text, ["sending"]) || addSteer(e.text, S.owner != null && S.owner !== S.me ? who(S.owner) : "peer", false, "sending");
      setSteer(st, e.delivered ? "queued" : "waiting");
      return;
    }
    case "dequeued": {
      const st = findSteer(e.text);
      if (!st) { toast(`Not delivered: ${e.text.slice(0, 80)}`); return; }
      setSteer(st, "returned");
      const input = $("input");
      if (st.local && isOwner() && !input.value.trim()) { input.value = e.text; autosize(); renderComposer(); }
      return;
    }
    case "client_joined":
      S.clients.set(e.client, e.kind);
      if (e.client !== S.me && !S.replaying) toast(`${who(e.client)} joined`);
      renderPresence(); renderComposer(); return;
    case "client_left":
      if (!S.replaying) toast(`${who(e.client)} left`);
      S.clients.delete(e.client); renderPresence(); renderComposer(); return;
    case "input_owner_changed":
      S.owner = e.to ?? null;
      if (!S.replaying) addSys(`input → ${e.to != null ? who(e.to) : "nobody"}`, "own");
      renderPresence(); renderComposer(); return;
    case "aborted": S.streaming = false; finishAsst(); addSys("turn stopped", "err"); renderComposer(); return;
    case "ended": addSys("session ended", "err"); S.sid = null; renderComposer(); return;
    case "cleared": T.innerHTML = ""; S.sid = e.session_id; emptyState("Fresh session", "The conversation was cleared."); return;
    case "refused":
      if (e.client === S.me) {
        toast(`Refused: ${e.reason}`, "err", 5000);
        if (S.localSubmit !== null) T.querySelector(".msg.user:last-of-type")?.classList.add("refused");
        S.localSubmit = null;
      }
      return;
    case "attach_refused": toast(`Attach refused: ${e.message}`, "err", 6000); return;
    case "query_result": { const cb = S.queries.get(e.id); if (cb) { S.queries.delete(e.id); cb(e.value); } return; }
    case "reloading": toast("Daemon reloading — reconnecting…"); return;
    case "compaction_started": return addSys("compacting…");
    case "compaction_applied": return addSys(`compacted ${e.msg_count} messages`);
    case "compaction_failed": return addSys(`compaction failed: ${e.message}`, "err");
    case "cost_cap_reached": return addSys(`cost cap reached (${e.scope})`, "err");
  }
}

function onStream(s) {
  if (s.kind === "llm") {
    switch (s.llm) {
      case "response_start": asst(); return;
      case "response_reset": if (S.cur?.text) { S.cur.text.remove(); S.cur.text = null; S.cur.textRaw = ""; } return;
      case "thinking": return appendThinking(s.text);
      case "text": return appendText(s.text);
      case "tool_use_start": toolCard(s.tool_id, s.tool_name); return;
      case "tool_use_delta": { const t = S.turnTools.get(s.tool_id); if (t) { t.inRaw += s.delta; t.sum.textContent = t.inRaw.slice(0, 200); updateGroup(t.group); } return; }
      case "tool_use": { const t = S.turnTools.get(s.tool_id) ?? toolCard(s.tool_id, s.tool_name); setToolInput(t, s.input); return; }
      case "tool_result_delta": { const t = S.turnTools.get(s.tool_id); if (t) setToolOutput(t, t.outRaw + s.delta); return; }
      case "tool_result": { const t = S.turnTools.get(s.tool_id); if (t) { setToolOutput(t, s.result); toolDone(t, /^(error|Error:|✗)/.test(s.result || "") ? "err" : "ok"); } if (S.cur) S.cur.last = "tool"; return; }
    }
  } else if (s.kind === "session") {
    if (s.session === "usage" && s.model) $("st-model").textContent = s.model.replace(/^.*\//, "");
    else if (s.session === "error") addSys(`error: ${s.message}`, "err");
    else if (s.session === "notice") addSys(s.text);
  } else if (s.kind === "agent") {
    if (s.agent === "steering_delivered") { const st = findSteer(s.message); if (st) setSteer(st, "delivered"); }
    else if (s.agent === "subagent_start") addSys(`⇢ ${s.agent_name}: ${s.task_preview}`);
    else if (s.agent === "subagent_done") addSys(`⇠ ${s.agent_name} done · ${s.duration_secs.toFixed(1)}s`);
  }
}

// ── prompts ───────────────────────────────────────────────────────────────────
function showPrompt(p) {
  S.prompt = p;
  $("modal-title").textContent = p.title;
  $("modal-prompt").textContent = p.prompt;
  const secret = p.kind === "secret";
  $("modal-secret").classList.toggle("hidden", !secret);
  $("modal-secret").value = "";
  $("modal-yes").textContent = secret ? "Submit" : "Allow";
  $("modal").classList.remove("hidden");
  (secret ? $("modal-secret") : $("modal-yes")).focus();
}
function hidePrompt() { S.prompt = null; $("modal").classList.add("hidden"); }
function answer(value) { if (!S.prompt) return; cmd({ cmd: "answer", prompt_id: S.prompt.id, value }); hidePrompt(); }
$("modal-yes").onclick = () => answer(S.prompt?.kind === "secret" ? $("modal-secret").value : "y");
$("modal-no").onclick = () => answer(S.prompt?.kind === "secret" ? null : "n");

// ── composer ──────────────────────────────────────────────────────────────────
function doSend() {
  const input = $("input");
  const text = input.value.trim();
  if (!S.sid || !isOwner()) return;
  if (!text) { if (S.streaming) cmd({ cmd: "cancel" }); return; }
  T.querySelector(".empty")?.remove();
  if (S.streaming) { addSteer(text, "you", true, "sending"); cmd({ cmd: "steer", text }); }
  else { finishAsst(); addUser(text, "you"); S.localSubmit = text; cmd({ cmd: "submit", text, attachments: [] }); }
  S.atBottom = true; follow();
  input.value = ""; autosize(); renderComposer();
}
function autosize() { const i = $("input"); i.style.height = "auto"; i.style.height = Math.min(240, i.scrollHeight) + "px"; }
$("input").addEventListener("input", () => { autosize(); renderComposer(); });
$("input").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); doSend(); } });
$("send").onclick = doSend;
$("takeover").onclick = () => { if (S.sid) switchTo(S.sid, "takeover"); };
$("new-session").onclick = () => switchTo(null, "mirror", true);
$("rail-toggle").onclick = () => $("app").classList.toggle(innerWidth < 860 ? "rail-open" : "rail-collapsed");
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (S.prompt) { answer(S.prompt.kind === "secret" ? null : "n"); return; }
    if (S.streaming && isOwner()) cmd({ cmd: "cancel" });
  } else if (ev.key === "/" && document.activeElement !== $("input") && isOwner()) { ev.preventDefault(); $("input").focus(); }
});
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-copy]");
  if (!b) return;
  const code = b.closest(".codeblock")?.querySelector("code")?.innerText ?? "";
  const done = (ok) => { b.classList.toggle("done", ok); b.lastChild.textContent = ok ? "Copied" : "Copy failed"; setTimeout(() => { b.classList.remove("done"); b.lastChild.textContent = "Copy"; }, 1400); };
  const fallback = () => {
    const ta = h("textarea"); ta.value = code; ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {}
    ta.remove(); done(ok);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code).then(() => done(true), fallback);
  else fallback();
});

applyPalette(null);
setInterval(() => send({ type: "sessions" }), 5000);
connect();
