// Motion checks: animated toggles actually open AND close, rail indicator tracks
// the active session, send/stop morph, and everything still works with
// prefers-reduced-motion. Real turn on the sandbox (:7718).
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
async function run(reduced) {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: reduced ? "reduce" : "no-preference" });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  const oldHash = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, oldHash, { timeout: 20000 });
  await p.fill("#input", "Run `echo alpha` then `echo beta` with bash as two separate calls, then reply in one sentence.");
  const grew = await p.evaluate(() => document.getElementById("input").style.height);
  await p.press("#input", "Enter");
  await p.waitForFunction(() => document.getElementById("send").classList.contains("stop"), null, { timeout: 20000 });
  await p.waitForTimeout(350);
  const stopMorph = await p.evaluate(() => { const s = document.getElementById("send"); return { stop: s.classList.contains("stop"), stopIconOpacity: getComputedStyle(s.querySelector(".ico-stop")).opacity }; });
  await p.waitForFunction(() => !document.getElementById("send").classList.contains("stop") && !document.querySelector(".msg.asst.live"), null, { timeout: 120000 });
  await p.waitForTimeout(700);
  const r = {};
  // batch <details>: open, then close (close is animated → must still end closed)
  const g = ".activity:not(.single) > summary";
  r.batch = await p.$(g) ? "present" : "missing";
  if (await p.$(g)) {
    await p.click(g); await p.waitForTimeout(450);
    r.batchOpen = await p.evaluate(() => document.querySelector(".activity:not(.single)").open);
    await p.click(g); await p.waitForTimeout(450);
    r.batchClosedAfter = await p.evaluate(() => !document.querySelector(".activity:not(.single)").open);
    await p.click(g); await p.waitForTimeout(450);
  }
  // tool card toggle
  await p.click(".tool .tool-head"); await p.waitForTimeout(400);
  r.toolOpen = await p.evaluate(() => document.querySelector(".tool").classList.contains("open") && getComputedStyle(document.querySelector(".tool .tool-body")).display !== "none");
  await p.click(".tool .tool-head"); await p.waitForTimeout(400);
  r.toolClosed = await p.evaluate(() => !document.querySelector(".tool").classList.contains("open"));
  // checks drawn to completion
  r.checksDrawn = await p.evaluate(() => [...document.querySelectorAll(".i.draw path")].every((x) => Math.abs(parseFloat(getComputedStyle(x).strokeDashoffset) || 0) < 0.5));
  // rail indicator sits on the active row
  r.rail = await p.evaluate(() => { const ind = document.querySelector(".rail-ind"), a = document.querySelector("#sessions li.active"); if (!ind || !a) return "missing"; const m = /translateY\(([-\d.]+)px\)/.exec(ind.style.transform); return { onActive: m && Math.abs(parseFloat(m[1]) - a.offsetTop) < 1, h: ind.style.height === `${a.offsetHeight}px`, rows: document.querySelectorAll("#sessions li[data-id]").length }; });
  // rail must NOT be rebuilt by the 5s poll (same node identity)
  const before = await p.evaluate(() => { const li = document.querySelector("#sessions li.active"); li._probe = 1; return 1; });
  await p.waitForTimeout(5600);
  r.railStable = await p.evaluate(() => document.querySelector("#sessions li.active")?._probe === 1);
  r.presence = await p.evaluate(() => [...document.querySelectorAll("#presence .av")].map((a) => a.className));
  r.textareaHeightSet = !!grew;
  console.log(reduced ? "REDUCED" : "MOTION ", JSON.stringify({ stopMorph, ...r }), "| errors:", errs.length ? errs : "none");
  await b.close();
}
(async () => { await run(false); await run(true); })().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
