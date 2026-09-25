// Settings panel: open/close, nav, every control type, session settings applied
// via the daemon (setting_changed), client prefs applied + persisted, watcher
// read-only, bridge refuses unsafe settings. Real session on the sandbox (:7718).
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.waitForFunction(() => S.sid || /No live sessions/.test(document.getElementById("thread").textContent), null, { timeout: 15000 }); // let the page's own auto-attach settle first
  const oldHash = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, oldHash, { timeout: 20000 });
  const R = {};
  // gear bottom-left
  R.gear = await p.evaluate(() => { const g = document.getElementById("open-settings").getBoundingClientRect(); return { left: Math.round(g.left), bottomGap: Math.round(innerHeight - g.bottom) }; });
  // open with Ctrl+,
  await p.keyboard.press("Control+,");
  await p.waitForSelector("#settings:not(.hidden) .set-tab.on", { timeout: 5000 });
  await p.waitForTimeout(500);
  R.opened = await p.evaluate(() => ({ tabs: [...document.querySelectorAll(".set-tab")].map((t) => t.textContent), title: document.getElementById("set-sec-title").textContent, rows: document.querySelectorAll(".set-row").length }));
  // session: thinking → high
  const seg = async (rowName, opt) => { await p.locator(".set-row", { hasText: rowName }).locator(".seg-opt", { hasText: new RegExp(`^${opt}$`) }).click(); };
  const KEY = { "Thinking": "reasoning_level", "Context window": "context_window", "Bash timeout": "bash_timeout", "Model": "model" };
  const waitApplied = async (rowName) => {
    const key = KEY[rowName];
    const n0 = await p.evaluate(() => window.__applied.length);
    await p.waitForFunction(([k, n]) => window.__applied.slice(n).some((a) => a.setting === k) || window.__applied.some((a) => a.setting === k && n === 0), [key, 0], { timeout: 10000 });
    await p.waitForTimeout(450); // past the re-render
    return p.evaluate((k) => { const ev = [...window.__applied].reverse().find((a) => a.setting === k); const r = document.querySelector(`.set-row[data-key="${k}"]`); return { event: ev, rowStatus: r?.querySelector(".set-st").className, rowErr: r?.querySelector(".set-err")?.textContent || null }; }, key);
  };
  await seg("Thinking", "high");
  R.thinking = await waitApplied("Thinking");
  await p.waitForTimeout(500);
  R.chipAfterThinking = await p.evaluate(() => document.querySelector("#model-chip span").textContent);
  // context window → 1M
  await seg("Context window", "1M");
  R.context = await waitApplied("Context window");
  // advanced: bash timeout +5
  await p.click(".set-adv > summary");
  const before = await p.locator(".set-row", { hasText: "Bash timeout" }).first().locator(".stp-v").inputValue();
  await p.locator(".set-row", { hasText: "Bash timeout" }).first().locator(".stp-b", { hasText: "+" }).click();
  R.bash = { before, ...(await waitApplied("Bash timeout")) };
  R.advStillOpen = await p.evaluate(() => document.querySelector(".set-adv")?.open);
  // model via custom input
  await p.click(".mdl-btn"); await p.waitForTimeout(250);
  R.pickerOpts = await p.evaluate(() => [...document.querySelectorAll(".mdl-opt")].map((o) => o.textContent));
  await p.fill(".mdl-custom input", "anthropic/claude-opus-4-8"); await p.press(".mdl-custom input", "Enter");
  R.model = await waitApplied("Model");
  await p.waitForTimeout(600);
  R.chipAfterModel = await p.evaluate(() => document.querySelector("#model-chip span").textContent);
  // appearance
  await p.click(".set-tab >> text=Appearance"); await p.waitForTimeout(350);
  await seg("Palette", "Midnight"); await p.waitForTimeout(900);
  await seg("Text size", "L");
  await p.locator(".set-row", { hasText: "Ambient glow" }).locator(".tog").click();
  R.appearance = await p.evaluate(() => ({ bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), fsL: document.documentElement.classList.contains("fs-l"), noGlow: document.documentElement.classList.contains("no-glow"), glowDisplay: getComputedStyle(document.getElementById("glow")).display, label: document.querySelector("#swatches .lbl").textContent }));
  // motion slider
  await p.click(".set-tab >> text=Motion"); await p.waitForTimeout(300);
  await p.evaluate(() => { const i = document.querySelector(".sld input"); i.value = "320"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  R.motion = await p.evaluate(() => ({ bubble: document.querySelector(".sld-val").textContent, saved: JSON.parse(localStorage.getItem("sd.prefs")).lag }));
  // behavior: send with Ctrl+Enter
  await p.click(".set-tab >> text=Behavior"); await p.waitForTimeout(300);
  await p.locator(".set-row", { hasText: "Send with" }).locator(".seg-opt").nth(1).click();
  // about
  await p.click(".set-tab >> text=About"); await p.waitForTimeout(700);
  R.about = await p.evaluate(() => [...document.querySelectorAll(".set-kv")].map((r) => `${r.querySelector(".k").textContent}=${r.querySelector(".v").textContent}`));
  // Esc closes
  await p.keyboard.press("Escape"); await p.waitForTimeout(400);
  R.closedByEsc = await p.evaluate(() => document.getElementById("settings").classList.contains("hidden"));
  // send-with: plain Enter must NOT send; Ctrl+Enter must
  await p.fill("#input", "hi (ctrl+enter test) — reply with one word");
  await p.press("#input", "Enter"); await p.waitForTimeout(400);
  const kept = await p.evaluate(() => document.getElementById("input").value.length > 0);
  await p.press("#input", "Control+Enter"); await p.waitForTimeout(500);
  R.sendKey = { enterKeptText: kept, ctrlEnterSent: await p.evaluate(() => document.getElementById("input").value === "" && document.querySelectorAll(".msg.user").length > 0) };
  // persistence across reload
  await p.reload(); await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 }); await p.waitForTimeout(800);
  R.persisted = await p.evaluate(() => ({ fsL: document.documentElement.classList.contains("fs-l"), noGlow: document.documentElement.classList.contains("no-glow"), palette: JSON.parse(localStorage.getItem("sd.prefs")).palette, sendKey: JSON.parse(localStorage.getItem("sd.prefs")).sendKey }));
  // watcher tab: session rows read-only
  const p2 = await ctx.newPage();
  await p2.goto(url.replace(/\?token=.*/, "") + location_hash(await p.evaluate(() => location.hash)));
  await p2.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 }); await p2.waitForTimeout(800);
  await p2.click("#open-settings"); await p2.waitForTimeout(500);
  R.watcher = await p2.evaluate(() => ({ note: document.querySelector(".set-note.warn")?.textContent?.slice(0, 60) || null, disabledControls: document.querySelectorAll(".set-row.disabled").length, pickerDisabled: document.querySelector(".mdl-btn")?.disabled }));
  // bridge refuses an unsafe setting
  R.refused = await p2.evaluate(() => new Promise((res) => {
    const ws = new WebSocket(`ws://${location.host}/ws`); let sid = null;
    ws.onmessage = (m) => { const f = JSON.parse(m.data);
      if (f.type === "welcome") { sid = f.sessions[0]?.id; ws.send(JSON.stringify({ type: "cmd", session_id: sid, cmd: { cmd: "set", id: 1, setting: { setting: "system_prompt", text: "pwned" } } })); }
      if (f.type === "error") { res(f.message); ws.close(); } };
    setTimeout(() => res("no error frame"), 4000);
  }));
  // reset prefs so other tests aren't affected
  await p.evaluate(() => localStorage.removeItem("sd.prefs"));
  console.log(JSON.stringify(R, null, 1)); console.log("ERRORS", errs.length ? errs : "none");
  await b.close();
  function location_hash(h) { return h || ""; }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
