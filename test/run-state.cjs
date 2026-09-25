// Header run-state pill (mirrors the TUI header status) on the SANDBOX (:7718):
//  ready ○ → streaming ● (pulsing 2.01s) on a real turn → ready ○ on idle
//  compaction_started → ⠋ compacting… (TUI braille frames, ~48ms/frame) → ready
//  socket drop → ⠋ connecting… → ready after reconnect
//  sits right after the title, before the model chip, no overlap at 1400/760px
//  reduced motion: no pulse, static spinner glyph
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const fail = [];
const expect = (name, ok, detail) => { if (!ok) fail.push(`${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`); };

(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.evaluate(() => setPref("motion", "full"));
  const h0 = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, h0, { timeout: 20000 });
  await p.waitForTimeout(400);

  const snap = () => p.evaluate(() => {
    const el = document.getElementById("run-state");
    const kids = [...el.children].map((c) => getComputedStyle(c));
    return { state: el.dataset.state || null, hidden: el.classList.contains("hidden"), glyph: el.querySelector(".rs-glyph").textContent, text: el.querySelector(".rs-text").textContent, anim: kids.map((c) => `${c.animationName}/${c.animationDuration}`), color: getComputedStyle(el).color };
  });
  const R = {};
  R.ready = await snap();
  expect("ready at rest", R.ready.state === "ready" && !R.ready.hidden && R.ready.glyph === "○" && R.ready.text === "ready", R.ready);
  expect("no pulse when ready", R.ready.anim.every((a) => a.startsWith("none")), R.ready.anim);

  // placement: title │ pill │ model chip, no overlaps
  R.layout = await p.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const t = r("sess-title"), s = r("run-state"), c = r("model-chip"), pr = r("presence"), cn = r("conn");
    return { titleRight: Math.round(t.right), pillLeft: Math.round(s.left), pillRight: Math.round(s.right), chipLeft: Math.round(c.left), presenceLeft: Math.round(pr.left), connLeft: Math.round(cn.left), pillMidY: Math.round(s.top + s.height / 2), titleMidY: Math.round(t.top + t.height / 2) };
  });
  const L = R.layout;
  expect("pill after title, before chip", L.titleRight <= L.pillLeft && L.pillRight <= L.chipLeft, L);
  expect("pill vertically centered with the title", Math.abs(L.pillMidY - L.titleMidY) <= 2, L);

  // real turn → streaming (pulsing) → idle → ready
  await p.fill("#input", "Write about 90 words on tide pools. Plain prose.");
  await p.press("#input", "Enter");
  await p.waitForFunction(() => document.getElementById("run-state").dataset.state === "streaming", null, { timeout: 20000 });
  await p.waitForTimeout(300);
  R.streaming = await snap();
  expect("streaming state", R.streaming.glyph === "●" && R.streaming.text === "streaming", R.streaming);
  expect("pulse = tui-pulse 2.01s on glyph + text", R.streaming.anim.every((a) => a === "tui-pulse/2.01s"), R.streaming.anim);
  expect("streaming uses the accent color", R.streaming.color !== R.ready.color, [R.ready.color, R.streaming.color]);
  await p.waitForFunction(() => !S.streaming, null, { timeout: 120000 });
  await p.waitForTimeout(300);
  R.afterIdle = await snap();
  expect("back to ready on idle", R.afterIdle.state === "ready" && R.afterIdle.glyph === "○", R.afterIdle);

  // compaction (the daemon's real event names, through the page's own handler)
  await p.evaluate(() => onEvent({ ev: "compaction_started" }, new Date().toISOString()));
  const spinSamples = await p.evaluate(async () => {
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 600) { out.push(document.querySelector("#run-state .rs-glyph").textContent); await new Promise((r) => setTimeout(r, 8)); }
    return out;
  });
  R.compacting = await snap();
  const seq = spinSamples.filter((g, i) => i === 0 || g !== spinSamples[i - 1]);
  R.spin = { distinct: seq.length, seq: seq.join("") };
  expect("compacting state", R.compacting.state === "compacting" && R.compacting.text === "compacting…", R.compacting);
  expect("spinner uses the TUI frames, in order", seq.every((g, i) => i === 0 || FRAMES.indexOf(g) === (FRAMES.indexOf(seq[i - 1]) + 1) % FRAMES.length) && seq.every((g) => FRAMES.includes(g)), R.spin);
  expect("spinner cadence ≈ 48ms (600ms → ~12 frames)", seq.length >= 9 && seq.length <= 15, R.spin);
  await p.evaluate(() => onEvent({ ev: "compaction_applied", msg_count: 4 }, new Date().toISOString()));
  R.afterCompact = await snap();
  expect("ready after compaction", R.afterCompact.state === "ready", R.afterCompact);

  // socket drop → connecting… → ready after reconnect
  await p.evaluate(() => S.ws.close());
  await p.waitForFunction(() => document.getElementById("run-state").dataset.state === "connecting", null, { timeout: 3000 });
  R.connecting = await snap();
  expect("connecting spinner on drop", R.connecting.text === "connecting…" && FRAMES.includes(R.connecting.glyph), R.connecting);
  await p.waitForFunction(() => document.getElementById("run-state").dataset.state === "ready", null, { timeout: 15000 });

  // narrow header: pill still clear of presence/conn (title truncates instead)
  await p.setViewportSize({ width: 760, height: 900 });
  await p.waitForTimeout(300);
  R.narrow = await p.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const s = r("run-state"), pr = r("presence"), cn = r("conn"), c = r("model-chip");
    return { pillRight: Math.round(s.right), chipRight: Math.round(c.right), presenceLeft: Math.round(pr.left), connLeft: Math.round(cn.left), pillWidth: Math.round(s.width) };
  });
  expect("narrow: pill + chip don't run into presence/conn", R.narrow.chipRight <= Math.min(R.narrow.presenceLeft || 1e9, R.narrow.connLeft) + 1 && R.narrow.pillWidth > 40, R.narrow);
  await p.setViewportSize({ width: 1400, height: 900 });

  // reduced motion: no pulse, spinner static
  await p.evaluate(() => setPref("motion", "reduced"));
  await p.evaluate(() => onEvent({ ev: "compaction_started" }, new Date().toISOString()));
  const g1 = await p.evaluate(() => document.querySelector("#run-state .rs-glyph").textContent);
  await p.waitForTimeout(300);
  const g2 = await p.evaluate(() => document.querySelector("#run-state .rs-glyph").textContent);
  R.reduced = { g1, g2 };
  expect("reduced motion: static spinner", g1 === g2, R.reduced);
  await p.evaluate(() => onEvent({ ev: "compaction_applied", msg_count: 4 }, new Date().toISOString()));
  await p.evaluate(() => setPref("motion", "system"));

  if (errs.length) fail.push(`page errors: ${errs.join(" | ")}`);
  console.log(JSON.stringify(R, null, 1));
  console.log(fail.length ? `FAIL\n  ${fail.join("\n  ")}` : "PASS");
  await b.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
