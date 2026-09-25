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
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  link: '<path d="M10 14a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 10a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.1-1.1"/>',
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
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14.5 8.5l2 2"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
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
  ws: null, welcome: null, sessions: [], past: [],
  sid: null, me: null, owner: null, clients: new Map(),
  streaming: false, compacting: false, replaying: false,
  wantSid: null, wantMode: "mirror", wantCreate: false, wantContinue: null, intentionalClose: false, retry: 0,
  cur: null, localSubmit: null, steers: [], // steer bubbles + their delivery state
  qid: 1, queries: new Map(), prompt: null, model: "",
  turnTools: new Map(), // tool_id → card, across split segments of the current turn
  pinned: true, // follow the bottom until the user deliberately scrolls up
};
const T = $("thread");
const SC = $("scroller");

// ── client preferences (this browser) ─────────────────────────────────────────
const PREF_DEFAULTS = { palette: "album", fontSize: "m", density: "comfy", glow: true, grain: true, motion: "system", lag: 256, autoscroll: true, sendKey: "enter" };
const PREFS = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem("sd.prefs") || "{}"); } catch {}
  const legacy = localStorage.getItem("sd.revealLag"); // pre-settings ?lag value
  if (p.lag == null && legacy !== null && Number.isFinite(Number(legacy))) p.lag = Number(legacy);
  const q = new URLSearchParams(location.search);
  if (q.has("lag") && Number(q.get("lag")) >= 0 && Number(q.get("lag")) <= 2000) p.lag = Number(q.get("lag"));
  return { ...PREF_DEFAULTS, ...p };
})();
function savePrefs() { localStorage.setItem("sd.prefs", JSON.stringify(PREFS)); }
savePrefs();

// ── motion ────────────────────────────────────────────────────────────────────
// One vocabulary (mirrors the CSS tokens). transform/opacity only, plus height
// for expand/collapse. Everything is skipped under prefers-reduced-motion.
const RM = matchMedia("(prefers-reduced-motion: reduce)");
const motion = () => (PREFS.motion === "full" ? true : PREFS.motion === "reduced" ? false : !RM.matches);
const EASE = { out: "cubic-bezier(.16,1,.3,1)", move: "cubic-bezier(.65,0,.35,1)", pop: "cubic-bezier(.34,1.45,.64,1)" };
function anim(el, frames, opts = {}) {
  if (!el || !el.animate || !motion()) return null;
  return el.animate(frames, { duration: 220, easing: EASE.out, ...opts });
}

// ── ambient glow: drifts while the agent works, settles when it's idle ────────
// Not a CSS keyframe loop (that can only snap on/off). A phase advances at a
// SPEED v ∈ [0,1]; v follows a smootherstep ramp (zero acceleration at both
// ends → starts slow, picks up through the middle, eases into cruise; the same
// shape in reverse when idle). Displacement also scales with v, so as it slows
// the blobs drift home to exactly the static pose. rAF runs only while moving.
const Glow = (() => {
  const a = $("glow-a"), b = $("glow-b");
  const UP_MS = 1800, DOWN_MS = 2600, RATE = 1.3; // RATE: phase rad/s at full speed
  const ease = (x) => x * x * x * (x * (x * 6 - 15) + 10); // smootherstep
  let on = false, from = 0, to = 0, t0 = 0, dur = UP_MS, v = 0, ph = 0, last = 0, raf = 0, stamp = 0;
  function paint() {
    // Two incommensurate Lissajous paths so the blobs never sync up.
    a.style.transform = `translate3d(${(Math.sin(ph * 0.71) * 6 * v).toFixed(3)}vw, ${(Math.cos(ph * 0.53) * 5 * v).toFixed(3)}vh, 0) scale(${(1 + 0.1 * v).toFixed(4)})`;
    b.style.transform = `translate3d(${(Math.cos(ph * 0.47 + 1) * 7 * v).toFixed(3)}vw, ${(Math.sin(ph * 0.61 + 2) * 6 * v).toFixed(3)}vh, 0) scale(${(1 + 0.12 * v).toFixed(4)})`;
    a.style.opacity = b.style.opacity = (0.815 + 0.185 * v).toFixed(4); // brighter while working
  }
  function rest() {
    cancelAnimationFrame(raf);
    raf = 0; last = 0; v = 0; from = to = 0;
    a.style.transform = b.style.transform = a.style.opacity = b.style.opacity = "";
  }
  function frame(now) {
    const dt = Math.min(0.05, (now - (last || now)) / 1000); // clamp: no jump after a hidden tab
    last = now;
    const k = Math.min(1, (now - t0) / dur);
    v = from + (to - from) * ease(k);
    stamp = now;
    ph += dt * v * RATE;
    paint();
    if (k >= 1 && to === 0) return rest();
    raf = requestAnimationFrame(frame);
  }
  function set(streaming) {
    if (!motion() || !PREFS.glow) { on = false; if (raf || v) rest(); return; } // reduced motion / glow off: static
    const want = !!streaming;
    if (want === on) return;
    on = want;
    // Ramp from the CURRENT speed, so a turn that ends mid-ramp turns around
    // smoothly; shorter distance → proportionally shorter ramp.
    from = v; to = on ? 1 : 0; t0 = performance.now();
    dur = Math.max(400, (on ? UP_MS : DOWN_MS) * Math.abs(to - from));
    if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
  }
  // stamp: the rAF time v was computed at (tests pair samples with it, not with
  // their own frame time — callbacks in one frame see the previous frame's v).
  return { set, get speed() { return v; }, get active() { return !!raf; }, get stamp() { return stamp; } };
})();
window.__glow = Glow; // test hook

// ── run state (header) — mirrors the TUI header's status span ─────────────────
//   not connected → ⠋ connecting…   compacting → ⠋ compacting…
//   streaming     → ● streaming (pulsing)   idle → ○ ready
// Same glyphs as the TUI (SPINNER_FRAMES), same cadence (a frame every 3 ticks
// × 16ms = 48ms). render() is idempotent: it only touches the DOM on a change.
const RunState = (() => {
  const el = $("run-state"), glyph = el.querySelector(".rs-glyph"), text = el.querySelector(".rs-text");
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const VIEW = {
    connecting: { glyph: null, text: "connecting…", cls: "busy" },
    compacting: { glyph: null, text: "compacting…", cls: "busy" },
    streaming: { glyph: "●", text: "streaming", cls: "streaming" },
    ready: { glyph: "○", text: "ready", cls: "ready" },
  };
  let state = null, spin = 0, fi = 0;
  function spinner(on) {
    if (on && !spin) {
      fi = 0; glyph.textContent = FRAMES[0];
      if (motion()) spin = setInterval(() => { fi = (fi + 1) % FRAMES.length; glyph.textContent = FRAMES[fi]; }, 48);
    } else if (!on && spin) { clearInterval(spin); spin = 0; }
  }
  function current() {
    if (S.ws?.readyState !== WebSocket.OPEN) return "connecting";
    if (!S.sid) return null; // connected, no session → nothing to report
    if (S.compacting) return "compacting";
    return S.streaming ? "streaming" : "ready";
  }
  function render() {
    const next = current();
    if (next === state) return;
    const prev = state;
    state = next;
    el.classList.toggle("hidden", !next);
    if (!next) { spinner(false); return; }
    const v = VIEW[next];
    el.classList.remove("busy", "streaming", "ready");
    el.classList.add(v.cls);
    el.dataset.state = next;
    text.textContent = v.text;
    spinner(v.glyph === null);
    if (v.glyph !== null) glyph.textContent = v.glyph;
    if (prev) anim(el, [{ opacity: 0.35, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 240 });
  }
  return { render, get state() { return state; } };
})();
function slideOpen(body) {
  const hgt = body.scrollHeight;
  return anim(body, [{ height: "0px", opacity: 0, overflow: "hidden" }, { height: `${hgt}px`, opacity: 1, overflow: "hidden" }], { duration: 260 });
}
function slideClose(body, done) {
  const a = anim(body, [{ height: `${body.offsetHeight}px`, opacity: 1, overflow: "hidden" }, { height: "0px", opacity: 0, overflow: "hidden" }], { duration: 180, easing: EASE.move });
  if (a) a.onfinish = done; else done();
}
// <details> (batches, thoughts) animate BOTH ways: intercept the toggle click.
document.addEventListener("click", (ev) => {
  const sum = ev.target.closest("summary");
  const d = sum?.parentElement;
  if (!d || !d.matches("details.activity, details.think") || d.classList.contains("single")) return;
  const body = d.querySelector(":scope > .act-body, :scope > .think-body");
  if (!body || !motion()) return;
  ev.preventDefault();
  if (d._busy) return;
  d._busy = true;
  if (d.open) slideClose(body, () => { d.open = false; d._busy = false; });
  else { d.open = true; const a = slideOpen(body); if (a) a.onfinish = () => { d._busy = false; }; else d._busy = false; }
});
function toggleTool(card) {
  const body = card.querySelector(".tool-body");
  if (card._busy) return;
  if (card.classList.contains("open")) {
    card._busy = true;
    slideClose(body, () => { card.classList.remove("open"); card._busy = false; });
  } else {
    card.classList.add("open");
    slideOpen(body);
  }
}
// cross-fade a label when its text actually changes
function swapText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (!S.replaying) anim(el, [{ opacity: 0.25, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 180 });
}

// ── MXC palette ───────────────────────────────────────────────────────────────
const MXC_VARS = {
  background: "--bg", background_panel: "--panel", background_element: "--elem", text: "--text", text_muted: "--muted",
  primary: "--primary", secondary: "--secondary", accent: "--accent", error: "--error", warning: "--warning",
  success: "--success", info: "--info", border: "--border", border_active: "--border-active",
  border_subtle: "--border-subtle", border_dimmest: "--border-dim",
};
function applyPalette(p, label) {
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
  sw.append(h("span", "lbl", label || (p ? "♪ album palette" : "myx default")));
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

// ── scroll: pinned by intent, not by position ─────────────────────────────────
// The transcript stays glued to the bottom through ANY growth (streaming, rows
// expanding, steer flights) until the user DELIBERATELY scrolls up: wheel up,
// touch drag, PageUp/↑/Home, or dragging the scrollbar. Scrolls we make never
// unpin. Scrolling back to the very bottom (or the pill, or sending) re-pins.
const atEnd = () => SC.scrollHeight - SC.scrollTop - SC.clientHeight <= 2;
const stick = () => { SC.scrollTop = SC.scrollHeight; };
let intentAt = 0, dragging = false, touchY = null, noRepinUntil = 0;
const intent = () => performance.now() - intentAt < 400 || dragging;
function setPinned() { S.pinned = true; $("jump").classList.remove("show"); }
function pin() { setPinned(); stick(); } // explicit: attach, send
function unpin() { if (S.pinned) S.pinned = false; }
// An upward gesture wins for a moment: a stale scroll event from our own
// stick-to-bottom (fired a frame late) must not re-pin and yank the view back.
function unpinGesture() { unpin(); noRepinUntil = performance.now() + 700; }
SC.addEventListener("wheel", (e) => { intentAt = performance.now(); if (e.deltaY < 0) unpinGesture(); }, { passive: true });
SC.addEventListener("touchstart", (e) => { touchY = e.touches[0]?.clientY ?? null; intentAt = performance.now(); }, { passive: true });
SC.addEventListener("touchmove", (e) => {
  const y = e.touches[0]?.clientY;
  if (touchY != null && y != null && y - touchY > 6) unpinGesture(); // finger down = content up
  intentAt = performance.now();
}, { passive: true });
SC.addEventListener("pointerdown", (e) => { if (e.target === SC) dragging = true; }); // scrollbar
addEventListener("pointerup", () => { dragging = false; });
// Navigation keys scroll the transcript whenever you're not typing.
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
  const page = SC.clientHeight * 0.85;
  const moves = { PageUp: -page, PageDown: page, ArrowUp: -64, ArrowDown: 64, Home: -SC.scrollHeight, End: SC.scrollHeight };
  if (!(e.key in moves)) return;
  e.preventDefault();
  intentAt = performance.now();
  if (moves[e.key] < 0) unpinGesture();
  if (e.key === "End") { pin(); return; }
  SC.scrollBy({ top: moves[e.key], behavior: Math.abs(moves[e.key]) > 100 ? "smooth" : "auto" });
});
SC.addEventListener("scroll", () => {
  if (!intent()) return; // our own scrolls
  if (!atEnd()) unpin();
  else if (performance.now() > noRepinUntil) setPinned(); // back at the bottom by hand
}, { passive: true });
// Growth anywhere in the thread (or a viewport resize) keeps a pinned view glued.
new ResizeObserver(() => {
  if (S.pinned && PREFS.autoscroll) stick();
  else if (S.streaming) $("jump").classList.add("show");
}).observe(T);
new ResizeObserver(() => { if (S.pinned && PREFS.autoscroll) stick(); }).observe(SC);
let followQueued = false;
function follow() {
  if (followQueued) return;
  followQueued = true;
  requestAnimationFrame(() => {
    followQueued = false;
    if (S.pinned && PREFS.autoscroll) stick();
    else if (S.streaming) $("jump").classList.add("show");
  });
}
$("jump").onclick = () => { S.pinned = true; $("jump").classList.remove("show"); SC.scrollTo({ top: SC.scrollHeight, behavior: "smooth" }); };
// Pending steers live in a tray that is always the LAST child of the thread;
// normal output inserts above it. A steer leaves the tray only when an event
// tells us where it actually entered the conversation.
const trayEl = () => { const t = document.getElementById("steer-tray"); return t && t.parentNode === T ? t : null; };
function tray() { let t = trayEl(); if (!t) { t = h("div"); t.id = "steer-tray"; T.append(t); } return t; }
const add = (node, parent = T) => {
  if (S.replaying && node.classList) node.classList.add("static");
  if (parent === T) T.insertBefore(node, trayEl()); else parent.append(node);
  follow();
  return node;
};

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
const clockS = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const toDate = (ts) => { const d = ts ? new Date(ts) : new Date(); return isNaN(d) ? new Date() : d; };
// Times come from the daemon's event envelope (`ts`), not the browser clock:
// typed = `steered` (daemon got it), received = `steering_delivered` (model read it).
function setSteer(st, state, ts) {
  st.state = state;
  st.m.dataset.steer = state;
  if (ts && state !== "sending") st.at = toDate(ts);
  const [ico, label] = STEER[state];
  st.st.innerHTML = "";
  st.st.append(h("span", "ico", ico), h("span", null, label));
  const typed = clockS(st.typedAt);
  if (state === "delivered" && st.at) {
    const lag = Math.max(0, Math.round((st.at - st.typedAt) / 1000));
    st.when.textContent = `received ${clockS(st.at)} · ${lag}s after typed`;
    st.m.title = `typed ${typed} · received by the model ${clockS(st.at)}`;
  } else if (state === "followup" && st.at) {
    st.when.textContent = `sent as follow-up ${clockS(st.at)}`;
    st.m.title = `typed ${typed} · sent as the next message ${clockS(st.at)}`;
  } else {
    st.when.textContent = `typed ${typed}`;
    st.m.title = `typed ${typed}`;
  }
}
function addSteer(text, by, local, state, ts) {
  const m = h("div", "msg user steer pending");
  const meta = h("div", "meta");
  const st = h("span", "steer-st");
  const when = h("span", "steer-when");
  meta.append(`steer · ${by} · `, when, " · ", st);
  m.append(h("div", "bubble", text), meta);
  // Queued: pinned to the bottom (the tray is always the thread's last child);
  // output the model produces before it reads the steer flows in ABOVE it.
  tray().append(m);
  follow();
  const rec = { text, m, st, when, local, state: "", typedAt: toDate(ts), at: null };
  S.steers.push(rec);
  setSteer(rec, state);
  return rec;
}
const findSteer = (text, states = STEER_OPEN) => S.steers.find((x) => x.text === text && states.includes(x.state));
// Delivered (or follow-up / returned / lost): leave the pinned tray and drop in
// at the exact point it took effect — end the current reply segment, insert the
// bubble there, and let the reply continue below it.
function landSteer(st) {
  if (!st || !st.m.classList.contains("pending")) return;
  splitAsst();
  const first = st.m.getBoundingClientRect();
  st.m.classList.remove("pending");
  T.insertBefore(st.m, trayEl());
  const last = st.m.getBoundingClientRect();
  const dx = first.left - last.left, dy = first.top - last.top;
  if (Math.abs(dy) > 2 || Math.abs(dx) > 2) anim(st.m, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 440, easing: EASE.move });
  st.m.classList.add("landed");
  setTimeout(() => st.m.classList.remove("landed"), 1400);
  follow();
}

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
  if (!S.replaying) el.classList.add("row-in");
  add(el, c.body);
  c.group = { el, body: el.querySelector(".act-body"), lbl: el.querySelector(".act-lbl"), st: el.querySelector(".act-st"), items: [], start: S.replaying ? 0 : performance.now() };
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
    const key = `${cur}|${items.length}`;
    if (g.lbl._key !== key) {
      const changedStep = (g.lbl._cur ?? cur) !== cur;
      g.lbl._key = key; g.lbl._cur = cur;
      g.lbl.innerHTML = "";
      g.lbl.append(h("span", "act-now", cur), h("span", "act-meta", ` · ${items.length} steps`));
      if (changedStep && !S.replaying) anim(g.lbl, [{ opacity: 0.2, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 200 });
    }
    if (g.st._html !== "spin") { g.st._html = "spin"; g.st.innerHTML = '<span class="spinner"></span>'; }
    g.el.classList.add("live");
  } else {
    g.lbl._key = null;
    swapText(g.lbl, parts.join(" · "));
    const secs = g.start ? (performance.now() - g.start) / 1000 : 0;
    const took = g.start ? (secs < 10 ? `${secs.toFixed(1)}s` : `${Math.round(secs)}s`) : "";
    const html = errs ? `<span>${errs} failed</span>${svg("x", "i draw")}` : `<span>${took}</span>${svg("check", S.replaying ? "i" : "i draw")}`;
    if (g.st._html !== (errs ? `e${errs}` : "ok")) { g.st._html = errs ? `e${errs}` : "ok"; g.st.innerHTML = html; }
    g.el.classList.toggle("has-err", errs > 0);
    g.el.classList.remove("live");
  }
}

function closeThinking(c) {
  if (!c || !c.think || !c.think.classList.contains("active")) return;
  c.think.classList.remove("active");
  const secs = c.thinkStart ? Math.max(1, Math.round((performance.now() - c.thinkStart) / 1000)) : 0;
  c.think.querySelector(".lbl").textContent = "Thought";
  c.think.querySelector(".think-st").textContent = secs && !S.replaying ? `${secs}s` : "";
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
  if (c.text) { c.text._live = false; markDirty(c.text); }
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
    d.innerHTML = `<summary>${svg("brain")}<span class="lbl">Thinking…</span><span class="think-sum"></span><span class="think-st"></span>${svg("chev", "i chev")}</summary><div class="think-body"></div>`;
    c.think = d; c.thinkRaw = ""; c.thinkStart = performance.now();
    if (!S.replaying) d.classList.add("row-in");
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
  c.think.querySelector(".think-sum").textContent = c.thinkRaw.trim().split("\n")[0].slice(0, 160);
  c.last = "think";
}

// ── streaming text: paced reveal + incremental markdown ────────────────────────
// Deltas arrive in ~10-char clumps every ~60ms; painting them as they land steps
// the text at ~17Hz (grows on ~1 frame in 4). Instead we buffer and reveal
// backlog/REVEAL_LAG_MS worth each frame: ~3 chars EVERY frame, trailing the
// wire by ~140ms, catching up faster after a burst. When a block ends, the rest
// drains within a few frames. Replay and reduced-motion render instantly.
// Stream smoothing buffer (Settings → Motion; `?lag=N` also sets it). Default 256ms
// glides over the model's own mid-sentence pauses (170–340ms at the source).
let REVEAL_LAG_MS = PREFS.lag;
const typers = new Set();
let typerRaf = 0;
function markDirty(n) {
  typers.add(n);
  if (!typerRaf) typerRaf = requestAnimationFrame(typeTick);
}
let lastTick = 0;
function typeTick(now) {
  typerRaf = 0;
  const dt = Math.min(64, now - (lastTick || now - 16.7));
  lastTick = now;
  for (const n of typers) {
    const target = n._raw.length;
    let shown = n._shown || 0;
    if (n._instant || !motion()) shown = target;
    else if (shown < target) {
      const backlog = target - shown;
      const lag = n._live ? REVEAL_LAG_MS : 70; // a finished block drains fast
      shown = Math.min(target, shown + Math.max(1, Math.ceil(backlog * dt / lag)));
    }
    n._shown = shown;
    renderMd(n);
    if (shown >= target) typers.delete(n);
  }
  if (typers.size) typerRaf = requestAnimationFrame(typeTick);
  else lastTick = 0;
  follow();
}
// Completed paragraphs render once and freeze; only the paragraph still being
// written re-renders per frame (never split inside a ``` fence).
function renderMd(n) {
  const text = n._raw.slice(0, n._shown);
  if (!n._stable) {
    n.textContent = "";
    n._stable = h("div", "md-stable");
    n._tail = h("div", "md-tail");
    n.append(n._stable, n._tail);
    n._cut = 0;
  }
  let cut = text.lastIndexOf("\n\n");
  while (cut > 0 && ((text.slice(0, cut).match(/^```/gm) || []).length % 2)) cut = text.lastIndexOf("\n\n", cut - 1);
  if (cut < 0) cut = 0;
  if (cut !== n._cut) { n._stable.innerHTML = cut ? md(text.slice(0, cut)) : ""; n._cut = cut; }
  const typing = n._live || n._shown < n._raw.length;
  n._tail.innerHTML = md(text.slice(cut)) + (typing && !n._instant ? '<span class="caret"></span>' : "");
}

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
  if (S.replaying) c.text._instant = true;
  c.last = "text";
  markDirty(c.text);
}

const PRIMARY_KEYS = ["command", "cmd", "path", "file_path", "pattern", "query", "url", "upload_id", "task", "agent", "name"];
function parseInput(input) {
  if (typeof input === "string") { try { return JSON.parse(input); } catch { return input; } }
  return input;
}
const primaryKey = (o) => (o && typeof o === "object" ? PRIMARY_KEYS.find((k) => typeof o[k] === "string") : undefined);
// Split a shell command at top-level `;`, `&&`, `||` (outside quotes and
// $(…)/(…) nesting) — display only, the operator stays at the end of its line.
function shellSegments(cmd) {
  const out = []; let cur = "", q = null, depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i], two = cmd.slice(i, i + 2);
    if (q) { cur += ch; if (ch === "\\" && q === '"') { cur += cmd[++i] ?? ""; } else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (two === "&&" || two === "||")) { out.push((cur.trim() + " " + two).trim()); cur = ""; i++; continue; }
    if (depth === 0 && ch === ";") { out.push(cur.trim() + ";"); cur = ""; continue; }
    if (depth === 0 && ch === "\n") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [cmd];
}
function summarize(input) {
  input = parseInput(input);
  if (input == null) return "";
  if (typeof input !== "object") return String(input);
  const k = primaryKey(input);
  if (!k) return JSON.stringify(input);
  if (k === "command" || k === "cmd") {
    const segs = shellSegments(input[k]);
    return segs.length > 1 ? `${segs[0].replace(/\s*(;|&&|\|\|)$/, "")}  +${segs.length - 1}` : segs[0];
  }
  return input[k];
}
// ── tool views ────────────────────────────────────────────────────────────────
// Per-tool rendering over the generic card: a diff for edit, file views for
// write/read, grouped matches for grep, listings for ls/find, ANSI colour and
// exit codes for bash, a task card for subagents, a link card for fetch, a
// JSON tree for JSON results. Unknown tools keep the generic view, and a view
// that throws falls back to it — a renderer can never break a card.
// Wire facts (SynapsCLI 0.9.x, verified): ToolResult is {tool_id, result} with
// NO error flag — failures are text prefixes; read → "N\t…" lines; grep →
// `grep -rn` (file:line:text, context file-line-text, "--" between groups);
// ls → `ls -lah`; find → one path per line; edit/write results are one-line
// summaries ("Edited … — replaced N line(s) with M line(s)", "Wrote N lines …").
const TOOL_FAIL = /^(Tool execution failed|Tool call denied|Unknown tool)\b|^(error\b|Error:|✗)/;
function toolFailure(text = "") {
  if (!TOOL_FAIL.test(text)) return null;
  const exit = /Command failed \(exit (\d+)\)/.exec(text);
  if (exit) return `exit ${exit[1]}`;
  const to = /timed out after (\d+s)/.exec(text);
  if (to) return `timed out ${to[1]}`;
  if (/^Tool call denied/.test(text)) return "denied";
  if (/^Unknown tool/.test(text)) return "unknown tool";
  return "failed";
}
const stripFail = (text) => text.replace(/^Tool execution failed: (Command failed \(exit \d+\):\n?)?/, "");
const baseName = (n = "") => n.toLowerCase().replace(/^.*[:.]/, "");
function toolKind(name) {
  const n = baseName(name);
  if (/^(edit|multiedit|multi_edit|str_replace)$/.test(n)) return "edit";
  if (n === "write") return "write";
  if (n === "read") return "read";
  if (/^(bash|shell|exec|powershell|run_command)$/.test(n)) return "bash";
  if (n === "grep") return "grep";
  if (/^(find|glob)$/.test(n)) return "find";
  if (n === "ls") return "ls";
  if (/^subagent(_start)?$/.test(n)) return "subagent";
  if (/fetch/.test(n)) return "fetch";
  return null;
}
const CODE_EXT = /\.(m?[jt]sx?|cjs|rs|py|go|sh|bash|zsh|fish|rb|java|kts?|c|h|cc|cpp|hpp|cs|swift|lua|toml|ya?ml|json|css|scss|html?|sql|php|vue|svelte)$/i;
const tildify = (p = "") => String(p).replace(/^\/home\/[^/]+(?=\/|$)/, "~");
const splitPath = (p = "") => { const i = p.lastIndexOf("/"); return i >= 0 ? [p.slice(0, i + 1), p.slice(i + 1)] : ["", p]; };
const fileBase = (p = "") => splitPath(String(p))[1] || String(p);
function copyBtn(get, title = "Copy") {
  const b = h("button", "tcopy");
  b.title = title;
  b.innerHTML = svg("copy");
  b.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(get()).then(() => { b.classList.add("done"); b.innerHTML = svg("check"); setTimeout(() => { b.classList.remove("done"); b.innerHTML = svg("copy"); }, 1200); }, () => {});
  };
  return b;
}
function fileHead(path, extra) {
  const [dir, base] = splitPath(tildify(path));
  const el = h("div", "fhead");
  el.innerHTML = `${svg("file")}<span class="fdir">${esc(dir)}</span><span class="fbase">${esc(base)}</span>`;
  if (extra) el.append(extra);
  el.append(copyBtn(() => String(path), "Copy path"));
  return el;
}
function moreBar(label, onClick) {
  const b = h("button", "more-bar", label);
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : /(s|x|z|ch|sh)$/.test(w) ? "es" : "s"}`;
// Gutter + code rows; long views render `keep` rows and a "show all" bar
// (eagerly rendering thousands of rows is the slow part, not the data).
function codeView(lines, { start = 1, nums = null, hl = true, keep = 80, cls = "" } = {}) {
  const wrap = h("div", `cview ${cls}`.trim());
  const row = (i) => `<div class="cl"><span class="ln">${nums ? nums[i] : start + i}</span><span class="cc">${(hl ? highlight(lines[i]) : esc(lines[i])) || " "}</span></div>`;
  const render = (n) => {
    const rows = [];
    for (let i = 0; i < Math.min(n, lines.length); i++) rows.push(row(i));
    wrap.innerHTML = rows.join("");
    if (lines.length > n) wrap.append(moreBar(`Show ${plural(lines.length - n, "more line")}`, () => render(lines.length)));
  };
  render(keep);
  return wrap;
}

// Line diff: trim the common prefix/suffix, LCS on the middle (capped — past
// the cap a changed block renders as all-removed / all-added, still correct).
function lcs(A, B) {
  const n = A.length, m = B.length, L = [];
  for (let i = 0; i <= n; i++) L.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  return L;
}
function diffLines(a, b) {
  let pre = 0, suf = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf), ops = [];
  for (let i = 0; i < pre; i++) ops.push([" ", a[i]]);
  if (A.length * B.length > 250000) {
    for (const x of A) ops.push(["-", x]);
    for (const y of B) ops.push(["+", y]);
  } else {
    const L = lcs(A, B);
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) { ops.push([" ", A[i]]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) ops.push(["-", A[i++]]);
      else ops.push(["+", B[j++]]);
    }
    while (i < A.length) ops.push(["-", A[i++]]);
    while (j < B.length) ops.push(["+", B[j++]]);
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push([" ", a[i]]);
  return ops;
}
// Word-level marks for a removed/added line pair.
function wordMarks(a, b) {
  const tok = (s) => s.match(/\w+|\s+|[^\w\s]/g) || [];
  const ta = tok(a), tb = tok(b);
  if (ta.length * tb.length > 40000) return [`<mark>${esc(a)}</mark>`, `<mark>${esc(b)}</mark>`];
  const L = lcs(ta, tb), xa = [], xb = [];
  let i = 0, j = 0;
  while (i < ta.length && j < tb.length) {
    if (ta[i] === tb[j]) { xa.push(esc(ta[i++])); xb.push(esc(tb[j++])); }
    else if (L[i + 1][j] >= L[i][j + 1]) xa.push(`<mark>${esc(ta[i++])}</mark>`);
    else xb.push(`<mark>${esc(tb[j++])}</mark>`);
  }
  while (i < ta.length) xa.push(`<mark>${esc(ta[i++])}</mark>`);
  while (j < tb.length) xb.push(`<mark>${esc(tb[j++])}</mark>`);
  const join = (x) => x.join("").replace(/<\/mark><mark>/g, "");
  return [join(xa), join(xb)];
}
// Unified diff view. Changed runs list removals then additions; paired lines
// get word marks, the rest syntax colour. Long unchanged runs fold.
function diffView(oldText, newText, hlOn) {
  const ops = diffLines(String(oldText).split("\n"), String(newText).split("\n"));
  const H = (s) => (hlOn ? highlight(s) : esc(s)) || " ";
  const rows = [];
  let adds = 0, dels = 0;
  for (let i = 0; i < ops.length; ) {
    if (ops[i][0] === " ") { rows.push({ k: "ctx", html: H(ops[i][1]) }); i++; continue; }
    const D = [], A = [];
    while (i < ops.length && ops[i][0] !== " ") (ops[i][0] === "-" ? D : A).push(ops[i++][1]);
    dels += D.length; adds += A.length;
    const pairs = Math.min(D.length, A.length);
    const dh = D.map(H), ah = A.map(H);
    for (let k = 0; k < pairs; k++) { const [x, y] = wordMarks(D[k], A[k]); dh[k] = x || " "; ah[k] = y || " "; }
    for (const x of dh) rows.push({ k: "del", html: x });
    for (const y of ah) rows.push({ k: "add", html: y });
  }
  // fold unchanged runs: keep 3 lines of context around each change
  const out = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i].k !== "ctx") { out.push(rows[i++]); continue; }
    let j = i;
    while (j < rows.length && rows[j].k === "ctx") j++;
    const run = rows.slice(i, j), lead = i === 0, trail = j === rows.length;
    const keepA = lead ? 0 : 3, keepB = trail ? 0 : 3;
    if (run.length > keepA + keepB + 2) {
      out.push(...run.slice(0, keepA), { k: "fold", rows: run.slice(keepA, run.length - keepB) }, ...run.slice(run.length - keepB));
    } else out.push(...run);
    i = j;
  }
  const wrap = h("div", "diff");
  const sign = { add: "+", del: "−", ctx: " " };
  const render = (list, limit) => {
    wrap.innerHTML = "";
    const shown = list.slice(0, limit);
    for (const r of shown) {
      if (r.k === "fold") {
        const f = moreBar(`⋯ ${plural(r.rows.length, "unchanged line")}`, () => render(list.flatMap((x) => (x === r ? x.rows : [x])), limit + r.rows.length));
        f.classList.add("dfold");
        wrap.append(f);
        continue;
      }
      wrap.insertAdjacentHTML("beforeend", `<div class="dl ${r.k}"><span class="ds">${sign[r.k]}</span><span class="dc">${r.html}</span></div>`);
    }
    if (list.length > limit) wrap.append(moreBar(`Show ${plural(list.length - limit, "more line")}`, () => render(list, list.length)));
  };
  render(out, 200);
  return { el: wrap, adds, dels };
}
function diffStat(adds, dels) {
  const s = h("span", "dstat");
  s.innerHTML = `<span class="da">+${adds}</span><span class="dd">−${dels}</span>`;
  return s;
}

// ANSI SGR → classes (palette colours); other escapes and control chars are
// dropped; `\r` progress redraws keep only the last frame of each line.
const ANSI_FG = { 30: "k", 31: "r", 32: "g", 33: "y", 34: "b", 35: "m", 36: "c", 37: "w", 90: "k", 91: "r", 92: "g", 93: "y", 94: "b", 95: "m", 96: "c", 97: "w" };
function ansiHtml(text) {
  text = text.split("\n").map((l) => { l = l.replace(/\r$/, ""); const k = l.lastIndexOf("\r"); return k >= 0 ? l.slice(k + 1) : l; }).join("\n");
  const re = /\x1b\[([\d;]*)m|\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g;
  let out = "", last = 0, m, fg = null;
  const st = new Set();
  const flush = (s) => {
    if (!s) return;
    const cls = [...st, ...(fg ? [`a-${fg}`] : [])];
    out += cls.length ? `<span class="${cls.join(" ")}">${esc(s)}</span>` : esc(s);
  };
  while ((m = re.exec(text))) {
    flush(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      if (c === 0) { st.clear(); fg = null; }
      else if (c === 1) st.add("a-bold");
      else if (c === 2) st.add("a-dim");
      else if (c === 3) st.add("a-it");
      else if (c === 4) st.add("a-ul");
      else if (c === 22) { st.delete("a-bold"); st.delete("a-dim"); }
      else if (c === 23) st.delete("a-it");
      else if (c === 24) st.delete("a-ul");
      else if (ANSI_FG[c]) fg = ANSI_FG[c];
      else if (c === 39) fg = null;
      else if (c === 38 || c === 48) k += codes[k + 1] === 5 ? 2 : codes[k + 1] === 2 ? 4 : 0; // 256/truecolor: skip params
    }
  }
  flush(text.slice(last));
  return out;
}
// Terminal output: ANSI colour; long output shows head + tail with a bar.
function termView(text) {
  const pre = h("pre", "tout");
  const lines = text.split("\n");
  const render = (all) => {
    if (all || lines.length <= 260) { pre.innerHTML = ansiHtml(text) || " "; return; }
    pre.innerHTML = ansiHtml(lines.slice(0, 120).join("\n"));
    pre.append(moreBar(`⋯ ${plural(lines.length - 200, "line")} hidden — show all`, () => render(true)));
    pre.insertAdjacentHTML("beforeend", ansiHtml(lines.slice(-80).join("\n")));
  };
  render(false);
  return pre;
}
function plainView(text) {
  const pre = h("pre", "tout plain");
  const lines = text.split("\n");
  const render = (all) => {
    if (all || lines.length <= 260) { pre.textContent = text; return; }
    pre.textContent = lines.slice(0, 120).join("\n");
    pre.append(moreBar(`⋯ ${plural(lines.length - 200, "line")} hidden — show all`, () => render(true)));
    pre.append(document.createTextNode(lines.slice(-80).join("\n")));
  };
  render(false);
  return pre;
}

// grep: BRE-ish patterns → JS for highlighting only (cosmetic; fall back to literal).
function grepRegex(p) {
  if (!p) return null;
  try { return new RegExp(String(p).replace(/\\([|(){}+?])/g, "$1"), "g"); }
  catch { try { return new RegExp(String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"); } catch { return null; } }
}
function markRe(s, re) {
  if (!re) return esc(s) || " ";
  let out = "", last = 0, m, guard = 0;
  re.lastIndex = 0;
  while ((m = re.exec(s)) && guard++ < 200) {
    if (m[0] === "") { re.lastIndex++; continue; }
    out += esc(s.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return (out + esc(s.slice(last))) || " ";
}
function grepView(text, pattern) {
  if (/^No matches( found)?\.?$/i.test(text.trim())) return h("div", "t-empty", "No matches");
  const files = new Map();
  let parsed = 0, hits = 0, cur = null;
  for (const line of text.split("\n")) {
    if (line === "--") { cur?.push({ sep: true }); continue; }
    let m = /^(.+?):(\d+):(.*)$/.exec(line), ctx = false;
    if (!m) { m = /^(.+?)-(\d+)-(.*)$/.exec(line); ctx = !!m; }
    if (!m) continue;
    parsed++;
    if (!ctx) hits++;
    if (!files.has(m[1])) files.set(m[1], []);
    cur = files.get(m[1]);
    cur.push({ n: m[2], text: m[3], ctx });
  }
  if (!parsed) return null;
  const re = grepRegex(pattern), wrap = h("div", "grep");
  wrap.append(h("div", "t-note", `${plural(hits, "match")} in ${plural(files.size, "file")}`));
  let shown = 0;
  for (const [file, rows] of files) {
    if (shown++ >= 60) { wrap.append(h("div", "t-note", `+ ${plural(files.size - 60, "more file")}`)); break; }
    const g = h("div", "gfile");
    g.append(fileHead(file, h("span", "fcount", String(rows.filter((r) => !r.ctx && !r.sep).length))));
    const body = h("div", "cview");
    body.innerHTML = rows.slice(0, 200).map((r) => (r.sep ? `<div class="cl gap"><span class="ln">⋯</span><span class="cc"> </span></div>` : `<div class="cl${r.ctx ? " ctx" : ""}"><span class="ln">${r.n}</span><span class="cc">${markRe(r.text, re)}</span></div>`)).join("");
    g.append(body);
    wrap.append(g);
  }
  return wrap;
}
function rel(p, root) {
  const r = String(root || "").replace(/\/+$/, "");
  return r && p.startsWith(r + "/") ? p.slice(r.length + 1) : tildify(p);
}
function findView(text, root) {
  const paths = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!paths.length) return h("div", "t-empty", "Nothing found");
  const wrap = h("div", "flist");
  wrap.append(h("div", "t-note", plural(paths.length, "result")));
  const list = h("div", "frows");
  const render = (n) => {
    list.innerHTML = paths.slice(0, n).map((p) => { const [d, b] = splitPath(rel(p, root)); return `<div class="frow">${svg("file")}<span class="fdir">${esc(d)}</span><span class="fbase">${esc(b)}</span></div>`; }).join("");
    if (paths.length > n) list.append(moreBar(`Show ${plural(paths.length - n, "more result")}`, () => render(paths.length)));
  };
  render(150);
  wrap.append(list);
  return wrap;
}
const LS_RE = /^([-dlbcps])[-rwxsStT]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+(\S+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s(.+)$/;
function lsView(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const m = LS_RE.exec(line);
    if (m && m[4] !== "." && m[4] !== "..") rows.push({ t: m[1], size: m[2], date: m[3].replace(/\s+/g, " "), name: m[4] });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (a.t === "d") === (b.t === "d") ? a.name.localeCompare(b.name) : a.t === "d" ? -1 : 1);
  const wrap = h("div", "ls");
  wrap.innerHTML = rows.map((r) => {
    const [name, target] = r.t === "l" ? r.name.split(" -> ") : [r.name];
    const ico = r.t === "d" ? "folder" : r.t === "l" ? "link" : "file";
    return `<div class="lsr ${ico}">${svg(ico)}<span class="lsn">${esc(name)}${r.t === "d" ? "/" : ""}${target ? `<span class="lst"> → ${esc(target)}</span>` : ""}</span><span class="lss">${r.t === "d" ? "" : esc(r.size)}</span><span class="lsd">${esc(r.date)}</span></div>`;
  }).join("");
  return wrap;
}
// JSON tree: nodes deeper than the first level render lazily on first open.
function jsonTree(v, depth = 0) {
  if (v === null || typeof v !== "object") {
    const t = v === null ? "k" : typeof v === "string" ? "s" : typeof v === "number" ? "n" : "k";
    const s = typeof v === "string" ? JSON.stringify(v.length > 400 ? v.slice(0, 400) + "…" : v) : String(v);
    return h("span", `jt-${t}`, s);
  }
  const arr = Array.isArray(v), keys = arr ? v.map((_, i) => i) : Object.keys(v);
  const d = h("details", "jt");
  const sum = h("summary");
  sum.innerHTML = `<span class="jt-b">${arr ? "[" : "{"}</span><span class="jt-c">${arr ? plural(keys.length, "item") : plural(keys.length, "key")}</span><span class="jt-b">${arr ? "]" : "}"}</span>`;
  d.append(sum);
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    const body = h("div", "jt-body");
    for (const k of keys.slice(0, 200)) {
      const row = h("div", "jt-row");
      if (!arr) row.append(h("span", "jt-key", k), document.createTextNode(": "));
      row.append(jsonTree(v[k], depth + 1));
      body.append(row);
    }
    if (keys.length > 200) body.append(h("div", "t-note", `+ ${keys.length - 200} more`));
    d.append(body);
  };
  d.addEventListener("toggle", () => { if (d.open) build(); });
  if (depth < 1) { d.open = true; build(); }
  return d;
}
function jsonOut(text) {
  const s = text.trim();
  if (!/^[[{]/.test(s) || s.length > 400000) return null;
  try { const w = h("div", "jtree"); w.append(jsonTree(JSON.parse(s))); return w; } catch { return null; }
}
function chipRow(pairs) {
  const chips = h("div", "chips");
  for (const [k, val] of pairs) {
    if (val == null || val === "") continue;
    const c = h("span", "kchip");
    c.append(h("span", "ck", k), h("span", "cv", String(val)));
    chips.append(c);
  }
  return chips.children.length ? chips : null;
}
const httpUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x : null; } catch { return null; } };

// input(t, v) fills t.inp (return false → generic); output(t, text, fail)
// returns an Element, "hide" (success line already folded into the summary),
// or null (→ generic). summary(v) → header text.
const TOOL_VIEWS = {
  edit: {
    summary: (v) => fileBase(v.path || v.file_path),
    input(t, v) {
      const path = v.path || v.file_path;
      const edits = Array.isArray(v.edits) ? v.edits : [{ old_string: v.old_string, new_string: v.new_string }];
      if (!path || edits.some((e) => typeof e?.old_string !== "string" || typeof e?.new_string !== "string")) return false;
      const hl = CODE_EXT.test(path);
      let adds = 0, dels = 0;
      const views = edits.map((e) => { const d = diffView(e.old_string, e.new_string, hl); adds += d.adds; dels += d.dels; return d.el; });
      t.inp.append(fileHead(path, diffStat(adds, dels)));
      for (const el of views) t.inp.append(el);
      const c = chipRow([["replace_all", v.replace_all ? "true" : null]]);
      if (c) t.inp.append(c);
      t.sum.textContent = `${fileBase(path)}  +${adds} −${dels}`;
    },
    output: (t, text, fail) => (fail ? null : "hide"),
  },
  write: {
    summary: (v) => fileBase(v.path || v.file_path),
    input(t, v) {
      const path = v.path || v.file_path;
      if (!path || typeof v.content !== "string") return false;
      const lines = v.content.replace(/\n$/, "").split("\n");
      t.inp.append(fileHead(path, h("span", "fcount", plural(lines.length, "line"))), codeView(lines, { hl: CODE_EXT.test(path), keep: 40 }));
      t.sum.textContent = `${fileBase(path)} · ${plural(lines.length, "line")}`;
    },
    output: (t, text, fail) => (fail ? null : "hide"),
  },
  read: {
    summary: (v) => fileBase(v.path || v.file_path),
    input(t, v) {
      const path = v.path || v.file_path;
      if (!path) return false;
      const from = Number(v.offset) || 0, lim = Number(v.limit) || 0;
      const range = lim ? `lines ${from + 1}–${from + lim}` : from ? `from line ${from + 1}` : null;
      t.inp.append(fileHead(path, range ? h("span", "fcount", range) : null));
      if (range) t.sum.textContent = `${fileBase(path)} · ${range}`;
    },
    output(t, text, fail) {
      if (fail) return null;
      const src = text.replace(/\n$/, "").split("\n"), nums = [], lines = [];
      let hitsN = 0;
      for (const l of src) { const m = /^\s*(\d+)\t(.*)$/.exec(l); if (m) { hitsN++; nums.push(m[1]); lines.push(m[2]); } else { nums.push(""); lines.push(l); } }
      if (hitsN < src.length * 0.6) return null; // not the numbered format → generic
      const path = t.inputV?.path || t.inputV?.file_path || "";
      return codeView(lines, { nums, hl: CODE_EXT.test(path), keep: 120 });
    },
  },
  bash: {
    output: (t, text) => termView(text),
  },
  grep: {
    summary: (v) => `${v.pattern ?? ""}${v.path ? `  in ${tildify(v.path)}` : ""}`,
    output: (t, text, fail) => (fail ? null : grepView(text, t.inputV?.pattern)),
  },
  find: {
    summary: (v) => `${v.pattern ?? v.name ?? ""}${v.path ? `  in ${tildify(v.path)}` : ""}`,
    output: (t, text, fail) => (fail ? null : findView(text, t.inputV?.path)),
  },
  ls: {
    output: (t, text, fail) => (fail ? null : lsView(text)),
  },
  subagent: {
    summary: (v) => `${v.agent || v.role || "agent"}: ${String(v.task || "").split("\n")[0]}`,
    input(t, v) {
      if (typeof v.task !== "string") return false;
      const c = chipRow([["agent", v.agent], ["role", v.role], ["model", v.model], ["timeout", v.timeout ? `${v.timeout}s` : null], ["writes", v.write_policy?.mode]]);
      if (c) { c.classList.add("first"); t.inp.append(c); }
      const task = h("div", "md tmd");
      task.innerHTML = md(v.task);
      t.inp.append(h("div", "kv-key", "task"), task);
      if (typeof v.system_prompt === "string" && v.system_prompt) {
        const d = h("details", "tdet");
        d.append(h("summary", null, `system prompt · ${plural(v.system_prompt.split("\n").length, "line")}`), h("pre", "blk", v.system_prompt));
        t.inp.append(d);
      }
    },
    output(t, text, fail) {
      if (fail || !text.trim() || jsonOut(text)) return null;
      const d = h("div", "md tmd");
      d.innerHTML = md(text);
      return d;
    },
  },
  fetch: {
    summary: (v) => { const u = httpUrl(v.url); return u ? `${u.hostname}${u.pathname === "/" ? "" : u.pathname}` : String(v.url ?? ""); },
    input(t, v) {
      const u = httpUrl(v.url);
      if (!u) return false;
      const a = h("a", "tlink");
      a.href = u.href; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.innerHTML = `${svg("globe")}<span class="th">${esc(u.hostname)}</span><span class="tp">${esc(u.pathname + u.search)}</span>`;
      t.inp.append(a);
      const rest = Object.entries(v).filter(([k]) => k !== "url");
      const c = chipRow(rest.map(([k, x]) => [k, typeof x === "object" ? JSON.stringify(x) : x]));
      if (c) t.inp.append(c);
    },
  },
};
function renderToolOutput(t) {
  const text = t.outRaw ?? "";
  const fail = toolFailure(text);
  const body = fail ? stripFail(text) : text;
  const view = TOOL_VIEWS[t.kind];
  let el = null;
  if (view?.output) { try { el = view.output(t, body, fail); } catch (e) { console.warn("synaps-dash: tool view", t.kind, e); el = null; } }
  if (el === "hide") { t.outSec.classList.add("hidden"); updateGroup(t.group); return; }
  if (!el) el = (!fail && jsonOut(body)) || (t.kind === "bash" ? termView(body) : plainView(body));
  t.outView.replaceChildren(el);
  t.outSec.classList.toggle("fail", !!fail);
  t.outSec.classList.remove("hidden");
  updateGroup(t.group);
}

function toolCard(id, name, input) {
  const c = asst();
  closeThinking(c);
  if (c.text) { c.text._live = false; markDirty(c.text); }
  const card = h("div", "tool");
  card.innerHTML = `<button class="tool-head"><span class="tool-ico">${svg(toolIcon(name))}</span><span class="tool-name"></span><span class="tool-sum"></span><span class="tool-st"><span class="spinner"></span></span>${svg("chev", "i chev")}</button><div class="tool-body"><div class="tool-sec in"><div class="lbl">Input</div><div class="in-view"></div></div><div class="tool-sec out ${/bash|shell|exec/.test(name) ? "term" : ""} hidden"><div class="lbl">Output</div><div class="out-view"></div></div></div>`;
  card.querySelector(".tool-name").textContent = name || "tool";
  card.querySelector(".tool-head").onclick = () => toggleTool(card);
  if (!S.replaying) card.classList.add("row-in");
  const g = groupFor(c);
  add(card, g.body);
  const t = { card, name, kind: toolKind(name), start: performance.now(), inRaw: "", outRaw: "", done: false,
    sum: card.querySelector(".tool-sum"), st: card.querySelector(".tool-st"),
    inp: card.querySelector(".in-view"), outView: card.querySelector(".out-view"), outSec: card.querySelector(".out") };
  card.querySelector(".tool-sec.in").append(copyBtn(() => { const v = t.inputV; return v && typeof v === "object" ? (typeof v.command === "string" ? v.command : JSON.stringify(v, null, 2)) : String(v ?? t.inRaw); }, "Copy input"));
  t.outSec.append(copyBtn(() => stripFail(t.outRaw), "Copy output"));
  c.tools.set(id, t);
  S.turnTools.set(id, t);
  c.last = "tool";
  t.group = g;
  g.items.push({ kind: "tool", t });
  if (input !== undefined) setToolInput(t, input);
  updateGroup(g);
  return t;
}
// Tool input as a readable view, not raw JSON: shell commands as `$` lines
// (one per top-level statement, hanging indent on wrap), the primary field as a
// block, short scalars as chips, long text / objects as labelled blocks.
function setToolInput(t, input) {
  t.sum.textContent = summarize(input);
  const v = parseInput(input);
  t.inputV = v;
  const box = t.inp;
  box.innerHTML = "";
  const view = TOOL_VIEWS[t.kind];
  if (view && v && typeof v === "object" && !Array.isArray(v)) {
    try { if (view.summary) t.sum.textContent = view.summary(v); } catch {}
    if (view.input) {
      try {
        if (view.input(t, v) !== false) { if (t.outRaw) renderToolOutput(t); updateGroup(t.group); return; }
      } catch (e) { console.warn("synaps-dash: tool view", t.kind, e); }
      box.innerHTML = ""; // view declined or threw → generic
    }
  }
  if (v == null || typeof v !== "object") { box.append(h("pre", "blk", String(v ?? ""))); updateGroup(t.group); return; }
  const k = primaryKey(v);
  if (k === "command" || k === "cmd") {
    const pre = h("div", "cmd");
    let cont = false;
    for (const seg of shellSegments(v[k])) {
      const line = h("div", `cmd-line${cont ? " cont" : ""}`);
      line.append(h("span", "prompt", cont ? "" : "$"), document.createTextNode(seg));
      pre.append(line);
      cont = /(&&|\|\|)$/.test(seg);
    }
    box.append(pre);
  } else if (k) {
    box.append(h("div", "kv-key", k), h("pre", "blk", v[k]));
  }
  const chips = h("div", "chips");
  for (const [key, val] of Object.entries(v)) {
    if (key === k) continue;
    if (val == null || (typeof val !== "object" && String(val).length <= 60 && !String(val).includes("\n"))) {
      const c = h("span", "kchip");
      c.append(h("span", "ck", key), h("span", "cv", String(val)));
      chips.append(c);
    } else {
      box.append(h("div", "kv-key", key), h("pre", "blk", typeof val === "string" ? val : JSON.stringify(val, null, 2)));
    }
  }
  if (chips.children.length) box.append(chips);
  updateGroup(t.group);
}
function setToolOutput(t, text) {
  t.outRaw = text;
  // Streamed output (tool_result_delta) arrives in many small pieces; rich views
  // re-parse the whole text, so coalesce to one render per frame.
  if (t._outRaf) return;
  t._outRaf = requestAnimationFrame(() => { t._outRaf = 0; renderToolOutput(t); });
}
function toolDone(t, cls = "ok", label) {
  if (t.done) return;
  t.done = true;
  t.card.classList.add(cls);
  const ms = performance.now() - t.start;
  const dur = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  t.st.innerHTML = `<span>${label || (S.replaying ? "" : dur)}</span>${svg(cls === "ok" ? "check" : "x", S.replaying ? "i" : "i draw")}`;
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
function setConn(state, text) { $("conn").className = state; $("conn-text").textContent = text; RunState.render(); }
const isOwner = () => S.me != null && S.owner === S.me;
function renderPresence() {
  const box = $("presence");
  const have = new Map([...box.children].filter((x) => !x._leaving).map((x) => [x._cid, x]));
  const want = [...S.clients].sort((a, b) => a[0] - b[0]);
  for (const [cid, el] of have) {
    if (S.clients.has(cid)) continue;
    el._leaving = true;
    const a = anim(el, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.4)" }], { duration: 180, easing: EASE.move });
    if (a) a.onfinish = () => el.remove(); else el.remove();
  }
  let prev = null;
  for (const [cid, kind] of want) {
    let a = have.get(cid);
    if (!a) {
      a = h("div", "av", kindLabel(kind).slice(0, 1).toUpperCase());
      a._cid = cid;
      anim(a, [{ opacity: 0, transform: "scale(.4)" }, { opacity: 1, transform: "scale(1)" }], { duration: 320, easing: EASE.pop });
    }
    a.title = who(cid) + (cid === S.owner ? " — owns input" : "");
    a.classList.toggle("me", cid === S.me);
    a.classList.toggle("owner", cid === S.owner);
    if (prev ? prev.nextSibling !== a : box.firstChild !== a) box.insertBefore(a, prev ? prev.nextSibling : box.firstChild);
    prev = a;
  }
}
function renderComposer() {
  window.__settings?.rerender();
  Glow.set(S.streaming); // idempotent — only acts when streaming flips
  RunState.render();
  const own = isOwner();
  $("watchbar").classList.toggle("hidden", own || !S.sid);
  if (!own && S.sid) $("watch-text").textContent = S.owner != null ? `Watching — ${who(S.owner)} is driving` : "Watching — nobody owns input";
  $("input").disabled = !own;
  $("input").placeholder = own ? (S.streaming ? "Steer the running turn…" : "Message synaps…") : "Take over to type";
  const send = $("send");
  const stop = own && S.streaming && !$("input").value.trim();
  send.classList.toggle("stop", stop);
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
// The rail lists LIVE sessions (someone attached now, clients>0) and, below
// them, RECENT sessions nobody's on: in-daemon-but-detached (0 clients — whether
// lifecycle=parked or a journal-less session the daemon won't park) plus
// sessions that live only on disk. Clicking an in-daemon one attaches (it's in
// memory); clicking a disk-only one resumes it (attach:create + continue).
function railItems() {
  const daemon = S.sessions;
  const daemonIds = new Set(daemon.map((s) => s.id));
  let live = daemon.filter((s) => s.clients > 0 && s.id !== S.sid);
  // The attached session is always live, even before the daemon's session_list
  // catches up (just-resumed / just-created) — synthesize it so it never
  // flickers into Recent for a poll cycle.
  if (S.sid) {
    const cur = daemon.find((s) => s.id === S.sid);
    live.unshift(cur ? { ...cur } : { id: S.sid, name: null, title: S.title, model: S.model, clients: 1, created_at: new Date().toISOString() });
  }
  live.sort((a, b) => (a.id === S.sid ? -1 : b.id === S.sid ? 1 : a.created_at < b.created_at ? 1 : -1));
  const detached = daemon.filter((s) => s.clients === 0 && s.id !== S.sid).map((s) => ({ ...s, parked: true }));
  const disk = S.past.filter((s) => !daemonIds.has(s.id) && s.id !== S.sid);
  const recent = [...detached, ...disk].sort((a, b) => ((a.updated_at || a.created_at) < (b.updated_at || b.created_at) ? 1 : -1));
  return { live, recent };
}
function fillRow(li, s, isRecent) {
  const title = s.name || (s.id === S.sid && S.title) || s.title || s.id;
  if (li.firstChild.textContent !== title) li.firstChild.textContent = title;
  const dot = li.querySelector(".s-dot");
  dot.classList.toggle("live", !isRecent && s.clients > 0);
  dot.classList.toggle("rest", isRecent);
  const model = (s.model || "").replace(/^.*\//, "");
  const when = ago(s.updated_at || s.created_at);
  const meta = !isRecent ? `${model} · ${s.clients} · ${when}`
    : s.parked ? `${model} · idle · ${when}`
    : `${model} · ${s.message_count || 0} msg · ${when}`;
  const txt = li.querySelector(".s-txt");
  if (txt.textContent !== meta) txt.textContent = meta;
}
function reconcileList(ul, list, past) {
  let ind = ul.querySelector(":scope > .rail-ind");
  if (!ind) { ind = h("div", "rail-ind"); ul.prepend(ind); }
  const rows = new Map([...ul.querySelectorAll(":scope > li[data-id]")].map((li) => [li.dataset.id, li]));
  for (const [id, li] of rows) if (!list.some((s) => s.id === id)) {
    const a = anim(li, [{ opacity: 1 }, { opacity: 0, transform: "translateX(-8px)" }], { duration: 160 });
    rows.delete(id);
    if (a) a.onfinish = () => li.remove(); else li.remove();
  }
  let prev = ind;
  for (const s of list) {
    let li = rows.get(s.id);
    if (!li) {
      li = h("li");
      li.dataset.id = s.id;
      li.innerHTML = '<div class="s-title"></div><div class="s-meta"><span class="s-dot"></span><span class="s-txt"></span></div>';
      li.onclick = () => {
        if (s.id === S.sid) return;
        // In the daemon (live or detached-in-memory) → attach; disk-only → resume.
        if (S.sessions.some((x) => x.id === s.id)) switchTo(s.id, "mirror");
        else switchTo(s.id, "mirror", { continue: s.id });
        if (innerWidth < 860) { $("app").classList.remove("rail-open"); $("rail-toggle").setAttribute("aria-expanded", "false"); }
      };
      if (ul._ready) anim(li, [{ opacity: 0, transform: "translateX(-10px)" }, { opacity: 1, transform: "none" }], { duration: 260 });
    }
    li.classList.toggle("active", s.id === S.sid);
    li.classList.toggle("rest", past);
    fillRow(li, s, past);
    if (prev.nextSibling !== li) ul.insertBefore(li, prev.nextSibling);
    prev = li;
  }
  ul._ready = true;
  const act = ul.querySelector(":scope > li.active");
  if (act) { ind.style.opacity = "1"; ind.style.transform = `translateY(${act.offsetTop}px)`; ind.style.height = `${act.offsetHeight}px`; }
  else ind.style.opacity = "0";
}
function renderSessions() {
  const { live, recent } = railItems();
  reconcileList($("sessions"), live, false);
  $("live-empty").classList.toggle("hidden", live.length > 0);
  const pastWrap = $("past-wrap");
  pastWrap.classList.toggle("hidden", recent.length === 0);
  if (recent.length) reconcileList($("past-sessions"), recent, true);
}
function toast(msg, cls = "", ms = 3600) {
  const t = h("div", `toast ${cls}`, msg);
  $("toasts").append(t);
  setTimeout(() => {
    const a = anim(t, [{ opacity: 1, transform: "none", height: `${t.offsetHeight}px` }, { opacity: 0, transform: "translateX(16px)", height: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "-8px" }], { duration: 240, easing: EASE.move });
    if (a) a.onfinish = () => t.remove(); else t.remove();
  }, ms);
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
    S.me = null; S.owner = null; S.clients.clear(); S.streaming = false; S.compacting = false;
    finishAsst(); renderPresence(); renderComposer();
    if (S.intentionalClose) { S.intentionalClose = false; connect(); return; }
    setConn("down", "reconnecting…");
    setTimeout(connect, Math.min(5000, 300 * 2 ** S.retry++));
  };
}
function loadPast() {
  fetch("/api/sessions?limit=60").then((r) => r.json()).then((d) => { S.past = d.sessions || []; renderSessions(); }).catch(() => {});
}
function switchTo(sid, mode, create = false) {
  S.threadFade = anim(T, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-6px)" }], { duration: 140, easing: EASE.move, fill: "forwards" });
  S.wantSid = sid; S.wantMode = mode;
  // create can be `true` (blank new session) or `{ continue: <id> }` (resume a
  // past session on disk into the daemon).
  S.wantCreate = !!create;
  S.wantContinue = create && typeof create === "object" ? create.continue : null;
  S.intentionalClose = true;
  S.ws?.close();
}

function onFrame(f) {
  switch (f.type) {
    case "mxc": S.album = f.palette; return applyTheme();
    case "welcome": return onWelcome(f);
    case "refused": setConn("down", "refused"); toast(f.message, "err", 8000); return;
    case "session_list": S.sessions = f.sessions; renderSessions(); return;
    case "attached": return onAttached(f);
    case "event": if (f.session_id === S.sid) onEvent(f.event, f.ts); return;
    case "error": toast(f.message, "err", 6000); return;
  }
}

function onWelcome(w) {
  S.welcome = w;
  S.sessions = w.sessions;
  setConn("up", `v${w.daemon_version}`);
  $("daemon-info").textContent = `${w.profile ?? "default"} · daemon ${w.daemon_version} · gen ${w.generation}`;
  renderSessions();
  loadPast();
  if (S.wantCreate) {
    S.wantCreate = false;
    const config = S.wantContinue ? { continue_session: S.wantContinue } : {};
    S.wantContinue = null;
    send({ type: "attach", attach: "create", config, mode: "mirror" });
    return;
  }
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
  S.view = a.view || null;
  $("st-model").textContent = S.model.replace(/^.*\//, "");
  updateCost(a.conversation);
  T.innerHTML = "";
  S.steers = [];
  // `replay` holds the LAST turn even after it finished — apply it only mid-turn,
  // else the finished turn renders twice (display_tail already has it).
  const replay = a.streaming ? (a.replay ?? []) : [];
  const ts0 = replay.find((env) => env.event.ev === "turn_started")?.event;
  renderTail(a.display_tail, !!ts0 && (ts0.trigger === "user" || ts0.trigger === "plugin_command"));
  if (!T.children.length) emptyState(S.title || "New session", "Say something — every client on this session sees it live.");
  S.threadFade?.cancel(); S.threadFade = null;
  anim(T, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 320 });
  S.replaying = true;
  for (const env of replay) onEvent(env.event, env.ts);
  S.replaying = false;
  S.streaming = !!a.streaming;
  S.compacting = false;
  if (S.streaming && !S.cur) newAsst();
  for (const p of a.pending_prompts ?? []) showPrompt(p);
  renderPresence(); renderComposer(); renderSessions();
  send({ type: "sessions" }); // refresh the live list so a just-resumed session moves out of Recent
  loadPast();
  requestAnimationFrame(pin);
  if (isOwner()) $("input").focus();
}

function onEvent(e, ts) {
  switch (e.ev) {
    case "stream": return onStream(e.event, ts);
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
        if (st) { setSteer(st, "followup", ts); landSteer(st); } else addUser(e.user_text, "queued");
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
      for (const st of S.steers) if (st.state === "sending") { setSteer(st, "lost", ts); landSteer(st); }
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
      const st = findSteer(e.text, ["sending"]) || addSteer(e.text, S.owner != null && S.owner !== S.me ? who(S.owner) : "peer", false, "sending", ts);
      st.typedAt = toDate(ts); // daemon receipt time — authoritative "typed"
      setSteer(st, e.delivered ? "queued" : "waiting", ts);
      return;
    }
    case "dequeued": {
      const st = findSteer(e.text);
      if (!st) { toast(`Not delivered: ${e.text.slice(0, 80)}`); return; }
      setSteer(st, "returned", ts);
      landSteer(st);
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
    case "cleared": T.innerHTML = ""; S.steers = []; S.sid = e.session_id; emptyState("Fresh session", "The conversation was cleared."); return;
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
    case "compaction_started": S.compacting = true; RunState.render(); return addSys("compacting…");
    case "compaction_applied": S.compacting = false; RunState.render(); return addSys(`compacted ${e.msg_count} messages`);
    case "compaction_failed": S.compacting = false; RunState.render(); return addSys(`compaction failed: ${e.message}`, "err");
    case "setting_changed": {
      const ap = e.applied || {};
      if (ap.view) {
        S.view = ap.view;
        S.model = ap.view.model || S.model;
        const chip = $("model-chip").querySelector("span");
        if (chip) swapText(chip, `${S.model.replace(/^.*\//, "")} · ${ap.view.thinking_level ?? "?"}`);
        $("st-model").textContent = S.model.replace(/^.*\//, "");
      }
      window.__settings?.applied(ap);
      return;
    }
    case "cost_cap_reached": return addSys(`cost cap reached (${e.scope})`, "err");
  }
}

function onStream(s, ts) {
  if (s.kind === "llm") {
    switch (s.llm) {
      case "response_start": asst(); return;
      case "response_reset": if (S.cur?.text) { typers.delete(S.cur.text); S.cur.text.remove(); S.cur.text = null; S.cur.textRaw = ""; } return;
      case "thinking": return appendThinking(s.text);
      case "text": return appendText(s.text);
      case "tool_use_start": toolCard(s.tool_id, s.tool_name); return;
      case "tool_use_delta": { const t = S.turnTools.get(s.tool_id); if (t) { t.inRaw += s.delta; t.sum.textContent = t.inRaw.slice(0, 200); updateGroup(t.group); } return; }
      case "tool_use": { const t = S.turnTools.get(s.tool_id) ?? toolCard(s.tool_id, s.tool_name); setToolInput(t, s.input); return; }
      case "tool_result_delta": { const t = S.turnTools.get(s.tool_id); if (t) setToolOutput(t, t.outRaw + s.delta); return; }
      case "tool_result": { const t = S.turnTools.get(s.tool_id); if (t) { const fail = toolFailure(s.result || ""); setToolOutput(t, s.result); toolDone(t, fail ? "err" : "ok", fail || undefined); } if (S.cur) S.cur.last = "tool"; return; }
    }
  } else if (s.kind === "session") {
    if (s.session === "usage" && s.model) $("st-model").textContent = s.model.replace(/^.*\//, "");
    else if (s.session === "error") addSys(`error: ${s.message}`, "err");
    else if (s.session === "notice") addSys(s.text);
  } else if (s.kind === "agent") {
    if (s.agent === "steering_delivered") { const st = findSteer(s.message); if (st) { setSteer(st, "delivered", ts); landSteer(st); } }
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
function hidePrompt() {
  S.prompt = null;
  const m = $("modal");
  const a = anim(m, [{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: EASE.move });
  anim(m.querySelector(".sheet"), [{ transform: "none" }, { transform: "translateY(6px) scale(.97)" }], { duration: 150, easing: EASE.move });
  if (a) a.onfinish = () => { if (!S.prompt) m.classList.add("hidden"); }; else m.classList.add("hidden");
}
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
  pin();
  input.value = ""; autosize(); renderComposer();
}
function autosize() {
  const i = $("input");
  const old = i.offsetHeight;
  i.style.height = "auto";
  const target = Math.min(240, i.scrollHeight);
  i.style.height = `${old}px`;
  void i.offsetHeight; // commit the start height so the CSS transition runs
  i.style.height = `${target}px`;
}
$("input").addEventListener("input", () => { autosize(); renderComposer(); });
$("input").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && (PREFS.sendKey !== "mod" || ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); doSend(); } });
$("send").onclick = doSend;
$("takeover").onclick = () => { if (S.sid) switchTo(S.sid, "takeover"); };
$("new-session").onclick = () => switchTo(null, "mirror", true);
// Rail drawer. CSS moves the panel (asymmetric curves, see style.css #app);
// on open, EVERY session row that's on screen cascades in after it with a hint
// of overshoot. No count cap (tall screens show 30+ rows): instead the whole
// wave fits a fixed window — the per-row beat shrinks as the row count grows.
const CASCADE_WINDOW_MS = 420, CASCADE_STEP_MS = 28;
function railShown() { const a = $("app").classList; return innerWidth < 860 ? a.contains("rail-open") : !a.contains("rail-collapsed"); }
function toggleRail() {
  $("app").classList.toggle(innerWidth < 860 ? "rail-open" : "rail-collapsed");
  const shown = railShown();
  $("rail-toggle").setAttribute("aria-expanded", String(shown));
  if (!shown || !motion()) return;
  const box = $("rail").querySelector(".rail-scroll").getBoundingClientRect();
  const rows = [...$("rail").querySelectorAll(".rail-scroll li[data-id], .rail-scroll .rail-label")]
    .filter((li) => { const r = li.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; });
  const step = rows.length > 1 ? Math.min(CASCADE_STEP_MS, CASCADE_WINDOW_MS / (rows.length - 1)) : 0;
  rows.forEach((li, i) => anim(li, [{ opacity: 0, transform: "translateX(-14px)" }, { opacity: 1, transform: "none" }],
    { duration: 380, delay: 140 + i * step, easing: EASE.pop, fill: "backwards" }));
}
$("rail-toggle").setAttribute("aria-expanded", String(railShown()));
$("rail-toggle").onclick = toggleRail;
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

// ── settings ──────────────────────────────────────────────────────────────────
// Like the TUI's /settings, minus the TUI-only rows (theme, sidecar key, fps):
//  - Session: live, over the wire (`Set`, owner-only, confirmed by setting_changed)
//  - Synaps config: the daemon's config file via /api/config (closed key
//    allowlist, bridge-validated, flock + atomic rename). Most keys apply on
//    `daemon reload` — the daemon reads its config once at start.
//  - Appearance / motion / behavior: this browser (localStorage).
const PRESETS = {
  myx: null,
  midnight: { colors: { primary: "#7aa2ff", secondary: "#b18cff", accent: "#ff9e64", error: "#ff6b81", warning: "#ffc46b", success: "#7ee2a8", info: "#7aa2ff", text: "#dfe4f5", text_muted: "#8089a8", background: "#0b0d16", background_panel: "#12152a", background_element: "#1a1e36", border: "#5b6392", border_active: "#8b93c2", border_subtle: "#343a5e", border_dimmest: "#1f2340" }, fade_ms: 700 },
  ember: { colors: { primary: "#ff9f5a", secondary: "#ff6f91", accent: "#ffd166", error: "#ff5d6c", warning: "#ffd166", success: "#9be58c", info: "#ffb38a", text: "#f3e6dc", text_muted: "#a08d80", background: "#140d0a", background_panel: "#1d1410", background_element: "#2a1d17", border: "#6e5446", border_active: "#a48070", border_subtle: "#44342b", border_dimmest: "#2a201b" }, fade_ms: 700 },
  mono: { colors: { primary: "#d6d6d6", secondary: "#a8a8a8", accent: "#e6e6e6", error: "#ff7a7a", warning: "#e0c070", success: "#9fd0a0", info: "#cfcfcf", text: "#ededed", text_muted: "#8c8c8c", background: "#0e0e0e", background_panel: "#161616", background_element: "#202020", border: "#555555", border_active: "#8a8a8a", border_subtle: "#383838", border_dimmest: "#242424" }, fade_ms: 700 },
};
const PALETTE_LABEL = { album: "♪ album palette", myx: "myx", midnight: "midnight", ember: "ember", mono: "mono" };
function applyTheme() {
  if (PREFS.palette === "album") applyPalette(S.album || null, S.album ? "♪ album palette" : "myx default");
  else applyPalette(PRESETS[PREFS.palette] || null, PALETTE_LABEL[PREFS.palette]);
}
function applyPrefs() {
  const c = document.documentElement.classList;
  for (const x of ["fs-s", "fs-m", "fs-l"]) c.toggle(x, PREFS.fontSize === x.slice(3));
  c.toggle("dense", PREFS.density === "compact");
  c.toggle("no-glow", !PREFS.glow);
  c.toggle("no-grain", !PREFS.grain);
  c.toggle("motion-off", PREFS.motion === "reduced");
  c.toggle("motion-full", PREFS.motion === "full");
  REVEAL_LAG_MS = PREFS.lag;
  $("input").placeholder = $("input").placeholder; // re-evaluated by renderComposer
  applyTheme();
  Glow.set(S.streaming); // motion/glow prefs may have just changed
}
function setPref(k, v) { PREFS[k] = v; savePrefs(); applyPrefs(); if (k === "autoscroll" && v) pin(); }

const Settings = (() => {
  const root = $("settings");
  const body = $("set-body");
  const tabs = root.querySelector(".set-tabs");
  const ind = root.querySelector(".set-ind");
  const pending = new Map(); // setting id → row
  const recent = new Map();  // setting key → {ok, message, until} — survives re-renders
  window.__applied = [];     // test hook: every setting_changed seen
  let section = "session";
  let models = null; // {model, favorites}
  let advOpen = false;
  const SECTIONS = [
    { id: "session", group: "This session", icon: "cpu", title: "Session", sub: "Applies to this session live — same as /settings in the TUI." },
    { id: "defaults", group: "Synaps config", icon: "layers", title: "Defaults", sub: "What new sessions start with.", cfg: true },
    { id: "agent", group: "Synaps config", icon: "wrench", title: "Agent", sub: "Tool limits, retries and tool policy.", cfg: true },
    { id: "memory", group: "Synaps config", icon: "brain", title: "Context & memory", sub: "Context management, prompt caching and the memory backend.", cfg: true },
    { id: "daemon", group: "Synaps config", icon: "server", title: "Daemon", sub: "Session daemon timers and startup.", cfg: true },
    { id: "plugins", group: "Synaps config", icon: "plug", title: "Plugins", sub: "Turn extensions on or off.", cfg: true },
    { id: "providers", group: "Synaps config", icon: "key", title: "Providers", sub: "Which model providers are set up. Status only — keys never reach the browser.", cfg: true },
    { id: "appearance", group: "This browser", icon: "palette", title: "Appearance", sub: "Saved in this browser." },
    { id: "motion", group: "This browser", icon: "sparkles", title: "Motion", sub: "Animation and streaming feel. Saved in this browser." },
    { id: "behavior", group: "This browser", icon: "sliders", title: "Behavior", sub: "Scrolling and sending. Saved in this browser." },
    { id: "about", group: "", icon: "info", title: "About", sub: "Connection and versions." },
  ];
  let cfg = null; // /api/config snapshot
  window.__cfgWrites = []; // test hook: every config write + result
  P.palette = '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A5.6 5.6 0 0 0 22 10c0-4.4-4.5-8-10-8z"/>';
  P.sliders = '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>';
  P.info = '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>';
  let lastGroup = null;
  for (const sec of SECTIONS) {
    if (sec.group !== lastGroup) {
      lastGroup = sec.group;
      tabs.append(h("div", `set-grp${sec.group ? "" : " gap"}`, sec.group));
    }
    const b = h("button", "set-tab");
    b.dataset.sec = sec.id;
    b.innerHTML = `${svg(sec.icon)}<span>${sec.title}</span>`;
    b.onclick = () => show(sec.id);
    tabs.append(b);
  }

  // ── controls ────────────────────────────────────────────────────────────────
  function row(label, help, control, opts = {}) {
    const r = h("div", "set-row");
    const l = h("div", "set-lbl");
    l.append(h("div", "set-name", label));
    if (help) l.append(h("div", "set-help", help));
    const right = h("div", "set-ctl");
    right.append(control);
    const st = h("span", "set-st");
    right.append(st);
    r.append(l, right);
    if (opts.disabled) r.classList.add("disabled");
    r._st = st;
    return r;
  }
  function segmented(options, value, onPick) {
    const wrap = h("div", "seg");
    const thumb = h("div", "seg-thumb");
    wrap.append(thumb);
    const place = () => {
      const a = wrap.querySelector(".seg-opt.on");
      if (!a) { thumb.style.opacity = "0"; return; }
      thumb.style.opacity = "1";
      thumb.style.width = `${a.offsetWidth}px`;
      thumb.style.transform = `translateX(${a.offsetLeft - 3}px)`;
    };
    for (const o of options) {
      const [val, text, sw] = Array.isArray(o) ? o : [o, o];
      const b = h("button", `seg-opt${val === value ? " on" : ""}`);
      if (sw) { const d = h("span", "seg-sw"); d.style.background = sw; b.append(d); }
      b.append(document.createTextNode(text));
      b.onclick = () => {
        if (wrap.classList.contains("locked")) return;
        wrap.querySelectorAll(".seg-opt").forEach((x) => x.classList.toggle("on", x === b));
        place();
        onPick(val);
      };
      wrap.append(b);
    }
    requestAnimationFrame(() => { wrap.classList.add("no-anim"); place(); requestAnimationFrame(() => wrap.classList.remove("no-anim")); });
    return wrap;
  }
  function toggle(on, onChange) {
    const b = h("button", `tog${on ? " on" : ""}`);
    b.setAttribute("role", "switch");
    b.setAttribute("aria-checked", String(on));
    b.append(h("span", "tog-knob"));
    b.onclick = () => { if (b.disabled) return; const v = !b.classList.contains("on"); b.classList.toggle("on", v); b.setAttribute("aria-checked", String(v)); onChange(v); };
    return b;
  }
  function slider(min, max, step, value, fmt, onInput) {
    const w = h("div", "sld");
    const inp = h("input");
    inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
    const bub = h("span", "sld-val", fmt(value));
    const paint = () => w.style.setProperty("--pct", `${((inp.value - min) / (max - min)) * 100}%`);
    inp.oninput = () => { bub.textContent = fmt(Number(inp.value)); paint(); onInput(Number(inp.value)); };
    paint();
    w.append(inp, bub);
    return w;
  }
  function stepper(value, { min, max, step, unit, toView = (v) => v, fromView = (v) => v }, onCommit) {
    const w = h("div", "stp");
    const dec = h("button", "stp-b", "−"), inc = h("button", "stp-b", "+");
    const inp = h("input", "stp-v");
    inp.inputMode = "numeric";
    inp.value = toView(value);
    const u = h("span", "stp-u", unit || "");
    let t = 0;
    const commit = () => { clearTimeout(t); t = setTimeout(() => { const v = Math.min(max, Math.max(min, Number(inp.value) || 0)); inp.value = v; onCommit(fromView(v)); }, 450); };
    dec.onclick = () => { inp.value = Math.max(min, (Number(inp.value) || 0) - step); commit(); };
    inc.onclick = () => { inp.value = Math.min(max, (Number(inp.value) || 0) + step); commit(); };
    inp.onchange = commit;
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } };
    w.append(dec, inp, u, inc);
    return w;
  }
  function modelPicker(current, list, onPick) {
    const w = h("div", "mdl");
    const btn = h("button", "mdl-btn");
    const label = (m) => { if (!m) return '<span class="mdl-name dim">not set — Synaps default</span>'; const [prov, name] = m.includes("/") ? m.split(/\/(.*)/) : ["", m]; return `<span class="mdl-prov">${esc(prov)}</span><span class="mdl-name">${esc(name)}</span>`; };
    btn.innerHTML = `${label(current)}${svg("chev", "i chev")}`;
    const pop = h("div", "mdl-pop hidden");
    const all = [...new Set([current, ...(list || [])].filter(Boolean))];
    const groups = {};
    for (const m of all) (groups[m.split("/")[0] || "other"] ||= []).push(m);
    for (const [prov, ms] of Object.entries(groups)) {
      pop.append(h("div", "mdl-grp", prov));
      for (const m of ms) {
        const o = h("button", `mdl-opt${m === current ? " on" : ""}`);
        o.innerHTML = `<span>${esc(m.split(/\/(.*)/)[1] || m)}</span>${m === current ? svg("check") : ""}`;
        o.onclick = () => { close(); if (m !== current) onPick(m); };
        pop.append(o);
      }
    }
    const custom = h("div", "mdl-custom");
    const ci = h("input");
    ci.placeholder = "provider/model — Enter to use";
    ci.onkeydown = (e) => { if (e.key === "Enter" && /^[\w.-]+\/[\w.:-]+$/.test(ci.value.trim())) { close(); onPick(ci.value.trim()); } else if (e.key === "Escape") { e.stopPropagation(); close(); } };
    custom.append(ci);
    pop.append(custom);
    const close = () => { pop.classList.add("hidden"); w.classList.remove("open"); };
    btn.onclick = (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const open = pop.classList.contains("hidden");
      document.querySelectorAll(".mdl-pop").forEach((x) => x.classList.add("hidden"));
      if (open) { pop.classList.remove("hidden"); w.classList.add("open"); anim(pop, [{ opacity: 0, transform: "translateY(-6px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 200 }); }
      else close();
    };
    w.append(btn, pop);
    w._btn = btn;
    return w;
  }

  // ── session settings over the wire ──────────────────────────────────────────
  function setSession(r, setting) {
    if (!S.sid || !isOwner()) { toast("Take over input to change session settings"); return; }
    r.dataset.key = setting.setting;
    const id = S.qid++;
    pending.set(id, r);
    r._st.className = "set-st busy";
    r._st.innerHTML = '<span class="spinner"></span>';
    cmd({ cmd: "set", id, setting });
  }
  function paintStatus(r, ok, message, draw) {
    r._st.className = `set-st ${ok ? "ok" : "err"}`;
    r._st.innerHTML = ok ? svg("check", draw ? "i draw" : "i") : svg("x", draw ? "i draw" : "i");
    r.querySelector(".set-err")?.remove();
    if (!ok && message) r.querySelector(".set-lbl").append(h("div", "set-err", message));
  }
  function applied(ap) {
    window.__applied.push({ setting: ap.setting, ok: ap.ok, message: ap.message || null });
    recent.set(ap.setting, { ok: ap.ok, message: ap.message, until: performance.now() + (ap.ok ? 1800 : 8000) });
    const r = pending.get(ap.id);
    pending.delete(ap.id);
    if (r && r.isConnected) {
      paintStatus(r, ap.ok, ap.message, true);
      setTimeout(() => { if (r._st.classList.contains("ok")) { r._st.className = "set-st"; r._st.innerHTML = ""; } }, 1800);
    }
    if (ap.clamp) toast(`Thinking → ${ap.clamp.to} (not supported: ${ap.clamp.from})`);
    if (ap.ok) setTimeout(rerender, 350); // key-based: only if model/thinking/etc. changed
  }

  // ── sections ────────────────────────────────────────────────────────────────
  const fmtBytes = (b) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
  function renderSession() {
    const v = S.view;
    const own = isOwner();
    const frag = document.createDocumentFragment();
    if (!S.sid || !v) { frag.append(h("div", "set-note", "No session attached.")); return frag; }
    if (!own) {
      const n = h("div", "set-note warn");
      n.append(h("span", null, `You're watching — ${S.owner != null ? who(S.owner) : "nobody"} owns input. Take over to change session settings.`));
      const b = h("button", "btn-ghost", "Take over");
      b.onclick = () => { close(); switchTo(S.sid, "takeover"); };
      n.append(b);
      frag.append(n);
    }
    const dis = { disabled: !own };
    const mr = row("Model", "Which model this session uses. Favorites come from your Synaps config.", h("span"), dis);
    mr.dataset.key = "model";
    const mp = modelPicker(v.model, models?.favorites, (m) => setSession(mr, { setting: "model", model: m }));
    mr.querySelector(".set-ctl").replaceChild(mp, mr.querySelector(".set-ctl").firstChild);
    mp._btn.disabled = !own;
    frag.append(mr);
    const tr = row("Thinking", "Reasoning depth. The daemon validates it against the model.", h("span"), dis);
    tr.dataset.key = "reasoning_level";
    tr.querySelector(".set-ctl").replaceChild(segmented(["off", "low", "medium", "high", "xhigh", "max"], v.thinking_level, (lvl) => setSession(tr, { setting: "reasoning_level", level: lvl })), tr.querySelector(".set-ctl").firstChild);
    frag.append(tr);
    const cw = v.context_window >= 1_000_000 ? "1m" : v.context_window >= 200_000 ? "200k" : "auto";
    const cr = row("Context window", `Current limit: ${Number(v.context_window).toLocaleString()} tokens.`, h("span"), dis);
    cr.dataset.key = "context_window";
    cr.querySelector(".set-ctl").replaceChild(segmented([["200k", "200k"], ["1m", "1M"], ["auto", "Auto"]], cw, (x) => setSession(cr, { setting: "context_window", tokens: x === "auto" ? null : x === "1m" ? 1_000_000 : 200_000 })), cr.querySelector(".set-ctl").firstChild);
    frag.append(cr);
    const adv = h("details", "set-adv");
    adv.open = advOpen;
    adv.addEventListener("toggle", () => { advOpen = adv.open; });
    adv.innerHTML = `<summary>${svg("chev", "i chev")}<span>Advanced — tool limits & retries</span></summary>`;
    const ab = h("div", "set-adv-body");
    const num = (label, help, key, value, o) => { const r = row(label, help, h("span"), dis); r.dataset.key = key; r.querySelector(".set-ctl").replaceChild(stepper(value, o, (val) => setSession(r, { setting: key, ...o.payload(val) })), r.querySelector(".set-ctl").firstChild); ab.append(r); };
    num("Bash timeout", "Default time limit for a shell command.", "bash_timeout", v.bash_timeout, { min: 1, max: 3600, step: 5, unit: "s", payload: (x) => ({ secs: x }) });
    num("Bash max timeout", "Upper bound a command may request.", "bash_max_timeout", v.bash_max_timeout, { min: 1, max: 86400, step: 30, unit: "s", payload: (x) => ({ secs: x }) });
    num("Max tool output", "Tool output kept per call.", "max_tool_output", v.max_tool_output, { min: 1, max: 4096, step: 4, unit: "KB", toView: (b) => Math.round(b / 1024), fromView: (k) => k * 1024, payload: (x) => ({ bytes: x }) });
    num("Subagent timeout", "Time limit for a delegated subagent.", "subagent_timeout", v.subagent_timeout, { min: 10, max: 86400, step: 30, unit: "s", payload: (x) => ({ secs: x }) });
    num("API retries", "Retries on transient provider errors.", "api_retries", v.api_retries, { min: 0, max: 20, step: 1, unit: "", payload: (x) => ({ n: x }) });
    adv.append(ab);
    frag.append(adv);
    if (!own) frag.querySelectorAll("button:not(.btn-ghost), input").forEach((x) => { if (!x.closest(".set-adv > summary")) x.disabled = true; });
    return frag;
  }
  // ── Synaps config (via the bridge's /api/config) ────────────────────────────
  const APPLIES = { reload: "on reload", live: "live", start: "next daemon start", launch: "next TUI launch" };
  const APPLIES_HELP = {
    reload: "The daemon reads its config once, at start. Takes effect after a daemon reload.",
    live: "Takes effect right away.",
    start: "Read when a client auto-starts a daemon; a reload keeps the current value.",
    launch: "Read by the TUI when it launches.",
  };
  const LABEL = {}; // config key → row label (for the pending banner)
  async function loadConfig() {
    try { cfg = await (await fetch("/api/config")).json(); } catch { cfg = null; }
    if (SECTIONS.find((x) => x.id === section)?.cfg) render(true);
  }
  function pill(key) {
    const pend = cfg?.pending?.includes(key);
    const a = cfg?.applies?.[key] || "reload";
    const p = h("span", `set-pill${pend ? " pending" : ""} ap-${a}`, pend ? "reload pending" : APPLIES[a]);
    p.title = APPLIES_HELP[a];
    return p;
  }
  function addReset(r, key) {
    if (key === "disabled_plugins" || r.querySelector(".set-reset")) return;
    const rs = h("button", "set-reset");
    rs.innerHTML = svg("reset");
    rs.title = `Reset to default (removes ${key} from the config)`;
    rs.onclick = () => setConfig(r, key, null, true);
    r.querySelector(".set-ctl").prepend(rs);
  }
  function crow(key, label, help, control) {
    LABEL[key] = label;
    const r = row(label, help, control);
    r.dataset.cfg = key;
    r.dataset.key = `cfg:${key}`;
    r.querySelector(".set-name").append(pill(key));
    if (cfg.values[key] !== null) addReset(r, key);
    if (!cfg.writable) r.querySelectorAll("button, input").forEach((x) => (x.disabled = true));
    return r;
  }
  const cv = (key, dflt) => (cfg.values[key] ?? dflt);
  async function setConfig(r, key, value, rerenderAfter) {
    if (!cfg?.writable) { toast("This config is read-only from here"); return; }
    r._st.className = "set-st busy";
    r._st.innerHTML = '<span class="spinner"></span>';
    let res;
    try {
      const x = await fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, value }) });
      res = await x.json();
    } catch (e) {
      res = { ok: false, error: `bridge unreachable: ${e}` };
    }
    window.__cfgWrites.push({ key, value, ok: !!res.ok, error: res.error || null });
    recent.set(`cfg:${key}`, { ok: !!res.ok, message: res.error, until: performance.now() + (res.ok ? 1800 : 8000) });
    if (res.ok) { const { ok, ...snap } = res; cfg = snap; }
    if (key === "favorite_models" || key === "model") fetch("/api/models").then((x) => x.json()).then((m) => { models = m; }).catch(() => {});
    if (!res.ok || rerenderAfter) { render(true); return; } // failed → controls snap back to the real value
    if (r.isConnected) {
      paintStatus(r, true, null, true);
      setTimeout(() => { if (r._st.classList.contains("ok")) { r._st.className = "set-st"; r._st.innerHTML = ""; } }, 1800);
      if (value !== null) addReset(r, key); // the key is now explicitly set
      else r.querySelector(".set-reset")?.remove(); // e.g. context window → Auto
    }
    refreshPending();
  }
  function pendingNote() {
    const n = h("div", "set-note warn set-pending");
    n.id = "set-pending";
    const keys = cfg?.pending || [];
    if (!keys.length) { n.classList.add("hidden"); return n; }
    const txt = h("div", "set-pend-txt");
    txt.append(h("div", "set-pend-h", `${keys.length} change${keys.length > 1 ? "s" : ""} waiting for a daemon reload`));
    txt.append(h("div", "set-pend-k", keys.map((k) => LABEL[k] || k).join(" · ")));
    const cmdRow = h("div", "set-pend-cmd");
    cmdRow.append(h("code", "set-code", cfg.reloadCmd));
    const b = h("button", "copy");
    b.innerHTML = `${svg("copy")}<span>Copy</span>`;
    b.onclick = () => { navigator.clipboard?.writeText(cfg.reloadCmd); b.lastChild.textContent = "Copied"; setTimeout(() => (b.lastChild.textContent = "Copy"), 1200); };
    cmdRow.append(b);
    txt.append(cmdRow);
    txt.append(h("div", "set-pend-foot", "Sessions survive a reload. This page gets a new token — reopen its URL afterwards."));
    n.append(txt);
    return n;
  }
  function refreshPending() {
    const old = body.querySelector("#set-pending");
    if (old) old.replaceWith(pendingNote());
    for (const r of body.querySelectorAll(".set-row[data-cfg]")) {
      const p = r.querySelector(".set-pill");
      if (p) p.replaceWith(pill(r.dataset.cfg));
    }
  }
  function cfgHead(frag) {
    const where = h("div", "set-path");
    where.innerHTML = `${svg("file")}<span>${esc(cfg.path)}</span>${cfg.profile ? `<span class="set-pill">profile ${esc(cfg.profile)}</span>` : ""}`;
    frag.append(where);
    if (!cfg.writable) frag.append(h("div", "set-note warn", `Read-only: ${cfg.profile ? `profile '${cfg.profile}' has no config file of its own (it reads the default one). Create ${cfg.writePath} to edit it here.` : "the config file can't be locked on this system."}`));
    frag.append(pendingNote());
  }
  function sub(frag, text) { frag.append(h("div", "set-subhd", text)); }
  const ctl = (r, el) => { r.querySelector(".set-ctl").append(el); return r; };
  function cseg(frag, key, label, help, options, dflt, map = (x) => x) {
    const r = crow(key, label, help, h("span"));
    const cur = cv(key, dflt);
    r.querySelector(".set-ctl").replaceChild(segmented(options, cur, (v) => setConfig(r, key, map(v))), r.querySelector(".set-ctl > span:not(.set-st)"));
    frag.append(r);
    return r;
  }
  function cnum(frag, key, label, help, dflt, o) {
    const r = crow(key, label, help, h("span"));
    r.querySelector(".set-ctl").replaceChild(stepper(Number(cv(key, dflt)), o, (v) => setConfig(r, key, String(v))), r.querySelector(".set-ctl > span:not(.set-st)"));
    frag.append(r);
    return r;
  }
  function ctog(frag, key, label, help, dflt, on = "true", off = "false") {
    const r = crow(key, label, help, h("span"));
    r.querySelector(".set-ctl").replaceChild(toggle(cv(key, dflt) === on, (v) => setConfig(r, key, v ? on : off)), r.querySelector(".set-ctl > span:not(.set-st)"));
    frag.append(r);
    return r;
  }
  function cmodel(frag, key, label, help) {
    const r = crow(key, label, help, h("span"));
    const mp = modelPicker(cfg.values[key], models?.favorites, (m) => setConfig(r, key, m, true));
    r.querySelector(".set-ctl").replaceChild(mp, r.querySelector(".set-ctl > span:not(.set-st)"));
    if (!cfg.writable) mp._btn.disabled = true;
    frag.append(r);
    return r;
  }
  function needCfg() {
    if (cfg) return null;
    const frag = document.createDocumentFragment();
    frag.append(h("div", "set-note", "Loading config…"));
    return frag;
  }

  function renderDefaults() {
    const frag = needCfg(); if (frag) return frag;
    const f = document.createDocumentFragment();
    cfgHead(f);
    cmodel(f, "model", "Model", "The model a new session starts on.");
    const thinkOpts = ["off", "low", "medium", "high", "xhigh", "max"];
    const t = cfg.values.thinking;
    if (t && !thinkOpts.includes(t)) thinkOpts.push(t);
    cseg(f, "thinking", "Thinking", "Starting reasoning depth; the daemon clamps it to what the model supports.", thinkOpts, t);
    cseg(f, "context_window", "Context window", "Auto lets Synaps pick per model.", [["200k", "200k"], ["1m", "1M"], ["auto", "Auto"]], "auto", (x) => (x === "auto" ? null : x));
    sub(f, "Compaction");
    cmodel(f, "compaction_model", "Compaction model", "Model that writes the summary when a session is compacted. Not set = the session's own model.");
    cseg(f, "compaction_mode", "Compaction mode", "Remote uses the provider's API; local keeps it on this machine.", [["remote", "Remote"], ["local", "Local"]], "remote");
    sub(f, "Favorites");
    const fr = crow("favorite_models", "Favorite models", "Shown first in every model picker — here and in the TUI.", h("span"));
    fr.classList.add("set-row-wide");
    const favs = (cfg.values.favorite_models || "").split(",").map((x) => x.trim()).filter(Boolean);
    const box = h("div", "fav-list");
    for (const m of favs) {
      const c = h("span", "fav");
      c.append(h("span", "fav-name", m));
      const x = h("button", "fav-x");
      x.innerHTML = svg("x");
      x.title = `Remove ${m}`;
      x.onclick = () => { const next = favs.filter((y) => y !== m); setConfig(fr, "favorite_models", next.length ? next.join(", ") : null, true); };
      c.append(x);
      box.append(c);
    }
    const add = h("input", "fav-add");
    add.placeholder = "provider/model — Enter to add";
    add.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      const v = add.value.trim();
      if (!/^[\w.-]+\/[\w.:-]+$/.test(v)) { toast("Use provider/model, e.g. anthropic/claude-opus-4-6"); return; }
      if (!favs.includes(v)) setConfig(fr, "favorite_models", [...favs, v].sort().join(", "), true);
      add.value = "";
    };
    box.append(add);
    fr.querySelector(".set-ctl").replaceChild(box, fr.querySelector(".set-ctl > span:not(.set-st)"));
    if (!cfg.writable) fr.querySelectorAll("button, input").forEach((x) => (x.disabled = true));
    f.append(fr);
    return f;
  }
  function renderAgent() {
    const frag = needCfg(); if (frag) return frag;
    const f = document.createDocumentFragment();
    cfgHead(f);
    sub(f, "Tools");
    cnum(f, "bash_timeout", "Bash timeout", "Default time limit for a shell command.", 30, { min: 1, max: 3600, step: 5, unit: "s" });
    cnum(f, "bash_max_timeout", "Bash max timeout", "Upper bound a command may request.", 300, { min: 1, max: 86400, step: 30, unit: "s" });
    cnum(f, "max_tool_output", "Max tool output", "Tool output kept per call.", 30000, { min: 1, max: 4096, step: 4, unit: "KB", toView: (b) => Math.max(1, Math.round(b / 1024)), fromView: (k) => k * 1024 });
    cnum(f, "subagent_timeout", "Subagent timeout", "Time limit for a delegated subagent.", 300, { min: 10, max: 86400, step: 30, unit: "s" });
    cseg(f, "tools.activation_confirm", "Tool activation", "When the model asks to switch on a tool it found via search_tools: allow it, ask you, or refuse.", [["auto", "Auto"], ["prompt", "Ask"], ["deny", "Deny"]], "auto");
    ctog(f, "progressive_tool_disclosure", "Progressive tool disclosure", "Start with a small core toolset; the model finds the rest with search_tools. Saves tokens.", "false");
    sub(f, "Retries");
    cnum(f, "api_retries", "API retries", "Retries on transient provider errors.", 3, { min: 0, max: 20, step: 1, unit: "" });
    cnum(f, "refusal_retries", "Refusal retries", "Retries when the provider returns a refusal.", 2, { min: 0, max: 10, step: 1, unit: "" });
    sub(f, "Events");
    ctog(f, "events.auto_turn", "Auto-turn on events", "Let inbox events (watchers, subagent completions) wake the agent without a new message from you.", "true");
    cnum(f, "events.auto_turn_cap", "Auto-turn cap", "Most auto-turns in a row before it waits for you. 0 = unlimited.", 5, { min: 0, max: 1000, step: 1, unit: "" });
    return f;
  }
  function renderMemory() {
    const frag = needCfg(); if (frag) return frag;
    const f = document.createDocumentFragment();
    cfgHead(f);
    cseg(f, "context_management.mode", "Context management", "Auto watches context pressure and wraps up or rolls over before the window fills.", [["off", "Off"], ["auto", "Auto"]], "off");
    cseg(f, "cache_ttl", "Prompt cache TTL", "How long the provider keeps the prompt cache warm. 1h costs more to write and saves on long pauses.", [["5m", "5 min"], ["1h", "1 hour"], ["hybrid", "Hybrid"]], "5m");
    cseg(f, "memory.backend", "Memory backend", "Axel needs its memory service configured (memory.axel.*); switching back to legacy leaves those keys alone.", [["legacy", "Legacy"], ["axel", "Axel"]], "legacy");
    return f;
  }
  function renderDaemon() {
    const frag = needCfg(); if (frag) return frag;
    const f = document.createDocumentFragment();
    cfgHead(f);
    const run = cfg.idleExitRunning;
    cnum(f, "daemon.idle_exit_secs", "Idle exit", `How long an auto-started daemon waits with no clients before it exits. 0 = never.${run !== null ? ` This one was started with --idle-exit ${run}.` : ""}`, 10, { min: 0, max: 604800, step: 10, unit: "s" });
    cnum(f, "daemon.prompt_abandon_secs", "Prompt abandon", "A session waiting on your answer with nobody attached gives up after this. 0 = never.", 3600, { min: 0, max: 604800, step: 60, unit: "s" });
    cnum(f, "daemon.parked_evict_secs", "Parked eviction", "An idle, detached session is dropped from memory after this (it stays on disk). 0 = never.", 3600, { min: 0, max: 604800, step: 60, unit: "s" });
    sub(f, "Startup");
    ctog(f, "startup.quick_start", "Quick start", "Don't wait for extensions before the first turn. Faster, but a slow extension's tools may miss turn 1.", "on", "on", "off");
    cnum(f, "startup.extensions_ready_timeout_secs", "Extensions-ready wait", "With quick start off: the longest to wait for extensions.", 30, { min: 1, max: 600, step: 5, unit: "s" });
    return f;
  }
  function renderPlugins() {
    const frag = needCfg(); if (frag) return frag;
    const f = document.createDocumentFragment();
    cfgHead(f);
    LABEL.disabled_plugins = "Plugins";
    const disabled = (cfg.values.disabled_plugins || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!cfg.plugins.length) f.append(h("div", "set-note", "No plugins installed."));
    for (const pl of cfg.plugins) {
      const help = pl.self ? "This page. Turn it off from the TUI — a browser can't unplug itself." : pl.description || "";
      const r = crow("disabled_plugins", pl.name, help, h("span"));
      r.dataset.key = `cfg:plugin:${pl.name}`;
      r.dataset.plugin = pl.name;
      const nm = r.querySelector(".set-name");
      nm.insertBefore(h("span", "set-pill ghost", `${pl.scope}${pl.version ? ` · v${pl.version}` : ""}`), nm.querySelector(".set-pill"));
      const tg = toggle(pl.enabled, (on) => {
        const next = on ? disabled.filter((x) => x !== pl.name) : [...new Set([...disabled, pl.name])];
        setConfig(r, "disabled_plugins", next.length ? next.join(", ") : null, true);
      });
      if (pl.self || !cfg.writable) tg.disabled = true;
      r.querySelector(".set-ctl").replaceChild(tg, r.querySelector(".set-ctl > span:not(.set-st)"));
      f.append(r);
    }
    const unknown = disabled.filter((x) => !cfg.plugins.some((p) => p.name === x));
    if (unknown.length) f.append(h("div", "set-note", `Also disabled, not installed here: ${unknown.join(", ")}. Left as they are.`));
    return f;
  }
  function renderProviders() {
    const frag = needCfg(); if (frag) return frag;
    const f = document.createDocumentFragment();
    if (!cfg.providers.length) f.append(h("div", "set-note", "No providers set up."));
    else {
      const card = h("div", "set-card");
      for (const pv of cfg.providers) {
        const r = h("div", "set-kv prov");
        r.append(h("span", "k", pv.name));
        const v = h("span", "v");
        v.append(document.createTextNode(pv.kind));
        if (pv.note) v.append(h("span", "prov-note", ` · ${pv.note}`));
        r.append(v, h("span", "set-pill ghost", pv.source === "login" ? "signed in" : "config"));
        card.append(r);
      }
      f.append(card);
    }
    f.append(h("div", "set-note", "Keys and tokens never reach the browser. Add or rotate them with synaps login, or in the config file."));
    return f;
  }

  function renderAppearance() {
    const frag = document.createDocumentFragment();
    const sw = (k) => PRESETS[k] ? `linear-gradient(135deg, ${PRESETS[k].colors.primary}, ${PRESETS[k].colors.secondary})` : k === "album" ? "conic-gradient(from 0deg, var(--primary), var(--secondary), var(--accent), var(--primary))" : "linear-gradient(135deg, #82aaff, #c099ff)";
    frag.append(row("Palette", "Album follows Myx live — the UI takes the current album's colors.", segmented(["album", "myx", "midnight", "ember", "mono"].map((k) => [k, k === "album" ? "Album" : k[0].toUpperCase() + k.slice(1), sw(k)]), PREFS.palette, (v) => setPref("palette", v))));
    frag.append(row("Text size", null, segmented([["s", "S"], ["m", "M"], ["l", "L"]], PREFS.fontSize, (v) => setPref("fontSize", v))));
    frag.append(row("Density", "Spacing between messages.", segmented([["comfy", "Comfortable"], ["compact", "Compact"]], PREFS.density, (v) => setPref("density", v))));
    frag.append(row("Ambient glow", "Soft album-colored light behind the UI.", toggle(PREFS.glow, (v) => setPref("glow", v))));
    frag.append(row("Film grain", "A whisper of texture.", toggle(PREFS.grain, (v) => setPref("grain", v))));
    return frag;
  }
  function renderMotion() {
    const frag = document.createDocumentFragment();
    frag.append(row("Animations", `System follows your OS setting (${RM.matches ? "reduced" : "full"} right now).`, segmented([["system", "System"], ["full", "Full"], ["reduced", "Reduced"]], PREFS.motion, (v) => setPref("motion", v))));
    frag.append(row("Stream smoothing", "How far the text trails the model so it flows instead of jumping. 0 = raw.", slider(0, 600, 8, PREFS.lag, (v) => (v ? `${v} ms` : "off"), (v) => { PREFS.lag = v; REVEAL_LAG_MS = v; savePrefs(); })));
    return frag;
  }
  function renderBehavior() {
    const frag = document.createDocumentFragment();
    frag.append(row("Stick to bottom", "Follow new output until you scroll up.", toggle(PREFS.autoscroll, (v) => setPref("autoscroll", v))));
    frag.append(row("Send with", "Shift+Enter always adds a new line.", segmented([["enter", "Enter"], ["mod", `${/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}+Enter`]], PREFS.sendKey, (v) => setPref("sendKey", v))));
    return frag;
  }
  function renderAbout() {
    const frag = document.createDocumentFragment();
    const w = S.welcome || {};
    const kv = (k, v, copy) => {
      const r = h("div", "set-kv");
      r.append(h("span", "k", k));
      const val = h("span", "v", v ?? "—");
      r.append(val);
      if (copy && v) { const b = h("button", "copy"); b.innerHTML = `${svg("copy")}<span>Copy</span>`; b.onclick = () => { navigator.clipboard?.writeText(v); b.lastChild.textContent = "Copied"; setTimeout(() => (b.lastChild.textContent = "Copy"), 1200); }; r.append(b); }
      return r;
    };
    const card = h("div", "set-card");
    card.append(kv("Session", S.sid, true), kv("Client", S.me != null ? who(S.me) : null), kv("Model", S.view?.model), kv("Daemon", w.daemon_version && `v${w.daemon_version} · pid ${w.pid} · gen ${w.generation}`), kv("Protocol", w.protocol_version && `v${w.protocol_version}`), kv("Profile", w.profile || "default"), kv("synaps·dash", S.bridgeVersion ? `v${S.bridgeVersion}` : null));
    frag.append(card);
    return frag;
  }
  const RENDER = { session: renderSession, defaults: renderDefaults, agent: renderAgent, memory: renderMemory, daemon: renderDaemon, plugins: renderPlugins, providers: renderProviders, appearance: renderAppearance, motion: renderMotion, behavior: renderBehavior, about: renderAbout };

  function render(quiet) {
    if (section === "session") lastKey = sessionKey();
    const sec = SECTIONS.find((x) => x.id === section);
    $("set-sec-title").textContent = sec.title;
    $("set-sec-sub").textContent = sec.sub;
    const keep = quiet ? body.scrollTop : 0;
    body.replaceChildren(RENDER[section]());
    body.scrollTop = keep;
    const now = performance.now();
    for (const r of body.querySelectorAll(".set-row[data-key]")) {
      const x = recent.get(r.dataset.key);
      if (x && x.until > now) paintStatus(r, x.ok, x.message, false);
    }
    if (!quiet) anim(body, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 220 });
  }
  function show(id) {
    section = id;
    tabs.querySelectorAll(".set-tab").forEach((b) => b.classList.toggle("on", b.dataset.sec === id));
    const a = tabs.querySelector(".set-tab.on");
    ind.style.transform = `translateY(${a.offsetTop}px)`;
    ind.style.height = `${a.offsetHeight}px`;
    render();
  }
  async function open(sec) {
    root.classList.remove("hidden");
    const g = $("open-settings");
    anim(g.querySelector(".i"), [{ transform: "rotate(0)" }, { transform: "rotate(120deg)" }], { duration: 420, easing: EASE.out });
    fetch("/api/models").then((r) => r.json()).then((m) => { models = m; if (section === "session") render(true); }).catch(() => {});
    fetch("/api/info").then((r) => r.json()).then((i) => { S.bridgeVersion = i.bridge; if (section === "about") render(true); }).catch(() => {});
    void loadConfig();
    show(sec || section);
  }
  function close() {
    if (root.classList.contains("hidden")) return;
    const a = anim(root, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE.move });
    anim(root.querySelector(".set-sheet"), [{ transform: "none" }, { transform: "translateY(8px) scale(.97)" }], { duration: 160, easing: EASE.move });
    if (a) a.onfinish = () => root.classList.add("hidden"); else root.classList.add("hidden");
  }
  $("open-settings").onclick = () => open();
  $("close-settings").onclick = close;
  root.addEventListener("click", (e) => {
    if (e.target === root) { close(); return; }
    root.querySelectorAll(".mdl.open").forEach((w) => { if (!w.contains(e.target)) { w.classList.remove("open"); w.querySelector(".mdl-pop").classList.add("hidden"); } });
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); root.classList.contains("hidden") ? open() : close(); }
    else if (e.key === "Escape" && !root.classList.contains("hidden")) { e.stopImmediatePropagation(); close(); }
  }, true);
  // Re-render ONLY when what the session section shows actually changed
  // (never on every stream event — that would close dropdowns / eat input).
  let lastKey = "";
  const sessionKey = () => [S.sid, isOwner(), S.owner, S.view?.model, S.view?.thinking_level, S.view?.context_window, !!models].join("|");
  function rerender() {
    if (root.classList.contains("hidden") || section !== "session") return;
    const k = sessionKey();
    if (k !== lastKey) { lastKey = k; render(true); }
  }
  return { open, close, applied, rerender };
})();
window.__settings = Settings;

applyPrefs();
setInterval(() => send({ type: "sessions" }), 5000);
setInterval(loadPast, 15000);
connect();
