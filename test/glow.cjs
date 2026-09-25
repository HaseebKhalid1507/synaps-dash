// Ambient glow drifts while the agent works and settles when idle, against a
// REAL streaming turn on the sandbox daemon (:7718).
//  - at rest: static (no inline transform, rAF not running, the old look)
//  - turn starts → speed ramps 0→1 slow-fast-slow (acceleration peaks mid-ramp)
//  - blobs actually move while streaming
//  - idle → speed ramps 1→0 with the same shape, blobs return home, rAF stops
//  - reduced motion → stays static even while streaming
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const fail = [];
const expect = (name, ok, detail) => { if (!ok) fail.push(`${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`); };

// Mean |dv/dt| in each third of a ramp (frames strictly between the endpoints).
function thirds(samples, lo, hi) {
  const r = samples.filter((s) => s.v > lo && s.v < hi);
  if (r.length < 9) return null;
  const t0 = r[0].t, span = r[r.length - 1].t - t0;
  const acc = [[], [], []];
  for (let i = 1; i < r.length; i++) {
    const dt = r[i].t - r[i - 1].t;
    if (dt <= 0) continue;
    const seg = Math.min(2, Math.floor(((r[i].t - t0) / span) * 3));
    acc[seg].push(Math.abs(r[i].v - r[i - 1].v) / dt);
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  return { frames: r.length, ms: Math.round(span), first: mean(acc[0]), middle: mean(acc[1]), last: mean(acc[2]) };
}

(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.evaluate(() => { localStorage.setItem("sd.prefs", JSON.stringify({ ...JSON.parse(localStorage.getItem("sd.prefs") || "{}"), motion: "full", glow: true })); });
  await p.reload();
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.waitForFunction(() => S.sid || /No live sessions/.test(document.getElementById("thread").textContent), null, { timeout: 15000 }); // let the page's own auto-attach settle first
  const h0 = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, h0, { timeout: 20000 });
  await p.waitForTimeout(600);

  const R = {};
  R.rest = await p.evaluate(() => {
    const a = document.getElementById("glow-a");
    return { inline: a.style.transform, active: window.__glow.active, speed: window.__glow.speed, opacity: getComputedStyle(a).opacity, oldPseudo: getComputedStyle(document.body, "::before").content };
  });
  expect("static at rest", R.rest.inline === "" && !R.rest.active && R.rest.speed === 0, R.rest);
  expect("resting opacity matches the old glow", Math.abs(Number(R.rest.opacity) - 0.815) < 0.001, R.rest.opacity);
  expect("old body::before glow is gone (no double glow)", R.rest.oldPseudo === "none" || R.rest.oldPseudo === "normal", R.rest.oldPseudo);

  // record speed + blob position on every frame the GLOW computed, stamped with
  // the glow's own frame time (a sampler's own rAF time would be one frame off).
  await p.evaluate(() => {
    window.__gs = [];
    let lastStamp = -1;
    const tick = () => {
      const g = window.__glow;
      const t = g.active ? g.stamp : performance.now();
      if (t !== lastStamp) { window.__gs.push({ t, v: g.speed, streaming: S.streaming, tf: document.getElementById("glow-a").style.transform }); lastStamp = t; }
      if (!window.__gsStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await p.fill("#input", "Write about 180 words on why lighthouses were painted in stripes. Plain prose, no headings.");
  await p.press("#input", "Enter");
  await p.waitForFunction(() => S.streaming, null, { timeout: 20000 });
  await p.waitForFunction(() => !S.streaming, null, { timeout: 120000 });
  await p.waitForFunction(() => !window.__glow.active, null, { timeout: 8000 });
  await p.waitForTimeout(200);
  const gs = await p.evaluate(() => { window.__gsStop = true; return window.__gs; });

  const startIdx = gs.findIndex((s) => s.streaming);
  const endIdx = gs.findIndex((s, i) => i > startIdx && !s.streaming);
  R.turnMs = Math.round(gs[endIdx].t - gs[startIdx].t);
  const up = gs.slice(startIdx, endIdx);
  const down = gs.slice(endIdx);
  R.peak = Math.max(...up.map((s) => s.v));
  R.up = thirds(up, 0.001, 0.999);
  R.down = thirds(down, 0.001, 0.999);
  // No snaps: the steepest legit rate is smootherstep's peak, 1.875/dur (up ramp
  // 1800ms → ~0.00104/ms). A snap is ~1 per frame (~0.06/ms). Rate, not step —
  // a long frame gap legitimately makes a big step.
  const rates = gs.slice(1).map((s, i) => { const dt = s.t - gs[i].t; return dt > 0 ? Math.abs(s.v - gs[i].v) / dt : 0; });
  R.maxRate = Math.max(...rates);
  R.moved = new Set(up.filter((s) => s.v > 0.9).map((s) => s.tf)).size;
  R.end = await p.evaluate(() => ({ inline: document.getElementById("glow-a").style.transform, active: window.__glow.active, speed: window.__glow.speed }));

  expect("reaches full speed during the turn", R.peak > 0.99, R.peak);
  expect("up-ramp measured", !!R.up, R.up);
  if (R.up) expect("up-ramp: slow → fast → slow (middle accel > first & last)", R.up.middle > R.up.first * 1.4 && R.up.middle > R.up.last * 1.4, R.up);
  expect("down-ramp measured", !!R.down, R.down);
  if (R.down) expect("down-ramp: slow → fast → slow", R.down.middle > R.down.first * 1.4 && R.down.middle > R.down.last * 1.4, R.down);
  expect("no speed snaps (rate ≤ 1.3× smootherstep peak)", R.maxRate <= 1.3 * (1.875 / 1800), R.maxRate);
  expect("blobs move while streaming", R.moved > 20, R.moved);
  expect("settles home + rAF stops when idle", R.end.inline === "" && !R.end.active && R.end.speed === 0, R.end);

  // reduced motion → static even while the agent works
  await p.evaluate(() => setPref("motion", "reduced"));
  await p.fill("#input", "Reply with one short sentence about fog.");
  await p.press("#input", "Enter");
  await p.waitForFunction(() => S.streaming, null, { timeout: 20000 });
  await p.waitForTimeout(700);
  R.reduced = await p.evaluate(() => ({ speed: window.__glow.speed, active: window.__glow.active, inline: document.getElementById("glow-a").style.transform }));
  expect("reduced motion: static while streaming", R.reduced.speed === 0 && !R.reduced.active && R.reduced.inline === "", R.reduced);
  await p.waitForFunction(() => !S.streaming, null, { timeout: 60000 });
  await p.evaluate(() => setPref("motion", "system"));

  if (errs.length) fail.push(`page errors: ${errs.join(" | ")}`);
  console.log(JSON.stringify(R, null, 1));
  console.log(fail.length ? `FAIL\n  ${fail.join("\n  ")}` : "PASS");
  await b.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
