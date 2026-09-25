// Streaming smoothness probe: WS arrival cadence vs what the user sees per frame.
//   node test/stream-probe.cjs [label]
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const stats = (a) => { if (!a.length) return {}; const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; const m = a.reduce((x, y) => x + y, 0) / a.length; const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); return { n: a.length, mean: +m.toFixed(1), p50: q(.5), p90: q(.9), p99: q(.99), max: s[s.length - 1], cv: +(sd / (m || 1)).toFixed(2) }; };
(async () => {
  const label = process.argv[2] || "run";
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  const arrivals = [];
  p.on("websocket", (ws) => ws.on("framereceived", (f) => {
    try { const m = JSON.parse(f.payload); const s = m?.event?.event; if (m?.event?.ev === "stream" && s?.llm === "text") arrivals.push({ t: Date.now(), n: s.text.length }); } catch {}
  }));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.waitForFunction(() => S.sid || /No live sessions/.test(document.getElementById("thread").textContent), null, { timeout: 15000 }); // let the page's own auto-attach settle first
  const oldHash = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, oldHash, { timeout: 20000 });
  // per-frame sampler of visible text length + long-task/frame time
  await p.evaluate(() => {
    window.__frames = []; let last = performance.now();
    const tick = (now) => {
      const el = [...document.querySelectorAll(".msg.asst .md")].pop();
      window.__frames.push({ dt: now - last, len: el ? el.textContent.length : 0 });
      last = now; requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await p.fill("#input", "Write a 500-word essay about tides, in plain paragraphs with a short bulleted list in the middle. No tools.");
  await p.press("#input", "Enter");
  await p.waitForFunction(() => document.getElementById("send").classList.contains("stop"), null, { timeout: 20000 }).catch(() => {});
  await p.waitForFunction(() => !document.getElementById("send").classList.contains("stop") && !document.querySelector(".msg.asst.live"), null, { timeout: 180000 });
  const frames = await p.evaluate(() => window.__frames);
  // only the streaming window: from first visible char to last growth
  const first = frames.findIndex((f) => f.len > 0);
  let lastGrow = first; for (let i = first; i < frames.length; i++) if (frames[i].len > frames[i - 1]?.len) lastGrow = i;
  const win = frames.slice(first, lastGrow + 1);
  const growth = win.slice(1).map((f, i) => f.len - win[i].len);
  const inter = arrivals.slice(1).map((a, i) => a.t - arrivals[i].t);
  // "choppiness": frames with NO growth between growth frames (stalls), and jump sizes
  let stall = 0, stalls = []; for (const g of growth) { if (g === 0) stall++; else { if (stall) stalls.push(stall); stall = 0; } }
  const out = {
    label,
    arrivals: { count: arrivals.length, charsPerDelta: stats(arrivals.map((a) => a.n)), interArrivalMs: stats(inter) },
    frames: { streamingFrames: win.length, frameMs: stats(win.map((f) => Math.round(f.dt))), charsPerFrame_whenGrowing: stats(growth.filter((g) => g > 0)), stallRunsInFrames: stats(stalls), framesWithGrowthPct: +(100 * growth.filter((g) => g > 0).length / (growth.length || 1)).toFixed(1) },
    finalLen: win.at(-1)?.len,
  };
  console.log(JSON.stringify(out, null, 1)); console.log("ERRORS", errs.length ? errs : "none");
  fs.writeFileSync(`/tmp/stream-probe-${label}.json`, JSON.stringify(out));
  await b.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
