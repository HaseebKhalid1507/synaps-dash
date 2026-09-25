// Rail drawer animation, measured frame by frame on the SANDBOX (:7718).
//  desktop: close = in-out (fastest mid-way), open = expo-out (fast launch,
//  soft landing); the panel moves as one piece (content edge == column edge,
//  content never re-wraps); rows cascade in on open; aria-expanded tracks it
//  mobile: overlay slides in/out (not instant), hidden after closing
//  reduced motion: instant
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const fail = [];
const expect = (name, ok, detail) => { if (!ok) fail.push(`${name}${detail !== undefined ? `: ${JSON.stringify(detail).slice(0, 300)}` : ""}`); };

// Mean |speed| in each third of the moving part of a sampled series. `from`/`to`
// must be the ACTUAL rest values (the collapsed rail keeps its 1px border).
function shape(s, key, from, to) {
  const moving = s.filter((x) => Math.abs(x[key] - from) > 0.5 && Math.abs(x[key] - to) > 0.5);
  if (moving.length < 6) return null;
  const t0 = moving[0].t, span = moving[moving.length - 1].t - t0, acc = [[], [], []];
  for (let i = 1; i < moving.length; i++) {
    const dt = moving[i].t - moving[i - 1].t;
    if (dt > 0) acc[Math.min(2, Math.floor(((moving[i].t - t0) / span) * 3))].push(Math.abs(moving[i][key] - moving[i - 1][key]) / dt);
  }
  const m = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  return { frames: moving.length, first: +m(acc[0]).toFixed(3), middle: +m(acc[1]).toFixed(3), last: +m(acc[2]).toFixed(3) };
}

(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.evaluate(() => setPref("motion", "full"));
  await p.waitForTimeout(900); // load animations settle
  // click the toggle, then sample rects every frame for `ms`
  const sample = (ms) => p.evaluate(async (ms) => {
    const out = [], t0 = performance.now();
    document.getElementById("rail-toggle").click();
    await new Promise((res) => {
      const f = () => {
        const r = document.getElementById("rail").getBoundingClientRect(), br = document.querySelector("#rail .brand").getBoundingClientRect();
        const th = document.getElementById("thread").getBoundingClientRect();
        const rows = [...document.querySelectorAll("#rail .rail-scroll li[data-id]")].slice(0, 4).map((li) => +getComputedStyle(li).opacity);
        out.push({ t: performance.now() - t0, w: r.width, left: r.left, right: r.right, brandRight: br.right, brandW: br.width, threadW: th.width, rows });
        performance.now() - t0 < ms ? requestAnimationFrame(f) : res();
      };
      requestAnimationFrame(f);
    });
    return { s: out, aria: document.getElementById("rail-toggle").getAttribute("aria-expanded"), vis: getComputedStyle(document.getElementById("rail")).visibility };
  }, ms);
  const R = {};
  // Exact curve, independent of headless frame rate: click, grab the running
  // CSS transitions (grid track on #app + the rail's contents), pause them all,
  // seek through the duration in even steps and read the geometry at each.
  const seek = (steps, mobile) => p.evaluate(async ([steps, mobile]) => {
    document.getElementById("rail-toggle").click();
    await new Promise((r) => requestAnimationFrame(r));
    const rail = document.getElementById("rail");
    const anims = document.getAnimations().filter((a) => a instanceof CSSTransition && [document.getElementById("app"), rail, ...rail.children].includes(a.effect.target));
    const main = anims.find((a) => a.transitionProperty === (mobile ? "transform" : "grid-template-columns") && a.effect.target === (mobile ? rail : document.getElementById("app")));
    if (!main) return { none: anims.map((a) => a.transitionProperty) };
    anims.forEach((a) => a.pause());
    const T = main.effect.getComputedTiming().duration, out = [];
    for (let i = 0; i <= steps; i++) {
      const t = (T * i) / steps;
      anims.forEach((a) => { a.currentTime = t; });
      const r = rail.getBoundingClientRect(), br = rail.querySelector(".brand").getBoundingClientRect();
      out.push({ t, v: mobile ? r.left : r.width, gap: Math.abs(br.right - r.right) });
    }
    anims.forEach((a) => a.finish());
    await new Promise((r) => requestAnimationFrame(r));
    return { easing: main.effect.getTiming().easing, duration: T, out };
  }, [steps, !!mobile]);
  // speed per third of an evenly-seeked curve
  const thirds = (out) => { const sp = out.slice(1).map((x, i) => Math.abs(x.v - out[i].v)); const n = sp.length / 3, m = (a) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2); return { first: m(sp.slice(0, n)), middle: m(sp.slice(n, 2 * n)), last: m(sp.slice(2 * n)) }; };
  R.start = await p.evaluate(() => ({ w: document.getElementById("rail").getBoundingClientRect().width, aria: document.getElementById("rail-toggle").getAttribute("aria-expanded") }));
  expect("starts open at 272px, aria-expanded=true", Math.round(R.start.w) === 272 && R.start.aria === "true", R.start);

  // ── desktop close ──
  const c = await sample(800);
  const cw = c.s.map((x) => x.w);
  const cEnd = cw[cw.length - 1];
  R.close = { shape: shape(c.s, "w", cw[0], cEnd), end: Math.round(cEnd), doneAt: Math.round(c.s.find((x) => x.w <= cEnd + 0.5)?.t ?? -1), aria: c.aria,
    maxEdgeGap: Math.max(...c.s.filter((x) => x.w > 1).map((x) => Math.abs(x.brandRight - x.right))), brandW: [...new Set(c.s.map((x) => Math.round(x.brandW)))],
    monotonic: cw.every((w, i) => i === 0 || w <= cw[i - 1] + 0.5), threadW: [...new Set(c.s.map((x) => Math.round(x.threadW)))] };
  // Wall-clock "finished" only proves it isn't stuck — frames under load are slow.
  // The exact duration + curve are asserted by seeking the live transition below.
  expect("close: ends collapsed (0 + the 1px border)", R.close.end <= 1 && R.close.doneAt > 250 && R.close.doneAt < 1500, R.close);
  expect("close: monotonic (no bounce)", R.close.monotonic, cw.map(Math.round));
  expect("close: one solid panel (content edge = column edge)", R.close.maxEdgeGap <= 2, R.close.maxEdgeGap);
  expect("close: rail content never re-wraps", JSON.stringify(R.close.brandW) === "[272]", R.close.brandW);
  expect("close: transcript doesn't reflow at this width", R.close.threadW.length === 1, R.close.threadW);
  expect("close: aria-expanded=false", R.close.aria === "false", R.close.aria);

  // ── desktop open ──
  const o = await sample(900);
  const ow = o.s.map((x) => x.w);
  R.open = { shape: shape(o.s, "w", ow[0], ow[ow.length - 1]), end: Math.round(ow[ow.length - 1]), max: Math.round(Math.max(...ow)), aria: o.aria,
    maxEdgeGap: Math.max(...o.s.filter((x) => x.w > 1).map((x) => Math.abs(x.brandRight - x.right))), monotonic: ow.every((w, i) => i === 0 || w >= ow[i - 1] - 0.5),
    rowsHidden: o.s.filter((x) => x.t > 60 && x.t < 200).some((x) => x.rows.some((op) => op < 0.9)), rowsEnd: o.s[o.s.length - 1].rows };
  expect("open: ends at 272, no overshoot", R.open.end === 272 && R.open.max <= 273, R.open);
  // (curve shape is asserted exactly by the seeked check below — frame sampling can't under load)
  expect("open: monotonic", R.open.monotonic, ow.map(Math.round));
  expect("open: one solid panel", R.open.maxEdgeGap <= 2, R.open.maxEdgeGap);
  expect("open: rows cascade in, then fully visible", R.open.rowsHidden && R.open.rowsEnd.every((x) => x === 1), [R.open.rowsHidden, R.open.rowsEnd]);
  expect("open: aria-expanded=true", R.open.aria === "true", R.open.aria);

  // ── exact curves (seeked) ──
  const sc = await seek(30);
  R.curveClose = sc.out ? { easing: sc.easing, duration: sc.duration, ...thirds(sc.out), maxGap: +Math.max(...sc.out.filter((x) => x.v > 1).map((x) => x.gap)).toFixed(2) } : sc;
  expect("close curve: in-out 380ms", /0\.65, 0, 0\.35, 1/.test(R.curveClose.easing) && R.curveClose.duration === 380, R.curveClose);
  expect("close curve: slow → fastest mid-way → slow", R.curveClose.middle > 1.4 * R.curveClose.first && R.curveClose.middle > 1.4 * R.curveClose.last, R.curveClose);
  expect("close curve: solid panel at every step", R.curveClose.maxGap <= 1, R.curveClose.maxGap);
  const so = await seek(30);
  R.curveOpen = so.out ? { easing: so.easing, duration: so.duration, ...thirds(so.out), maxGap: +Math.max(...so.out.filter((x) => x.v > 1).map((x) => x.gap)).toFixed(2) } : so;
  expect("open curve: expo-out 520ms", /0\.16, 1, 0\.3, 1/.test(R.curveOpen.easing) && R.curveOpen.duration === 520, R.curveOpen);
  expect("open curve: fast launch → soft landing", R.curveOpen.first > R.curveOpen.middle && R.curveOpen.middle > R.curveOpen.last && R.curveOpen.first > 4 * R.curveOpen.last, R.curveOpen);
  expect("open curve: solid panel at every step", R.curveOpen.maxGap <= 1, R.curveOpen.maxGap);

  // ── cascade on a tall screen: every on-screen row animates, no cap ──
  await p.setViewportSize({ width: 1400, height: 1700 });
  await p.waitForTimeout(300);
  await p.click("#rail-toggle"); // close
  await p.waitForTimeout(600);
  R.cascade = await p.evaluate(async () => {
    document.getElementById("rail-toggle").click(); // open
    await new Promise((r) => requestAnimationFrame(r));
    const box = document.querySelector("#rail .rail-scroll").getBoundingClientRect();
    const all = [...document.querySelectorAll("#rail .rail-scroll li[data-id], #rail .rail-scroll .rail-label")];
    const onScreen = all.filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; });
    const anims = document.getAnimations().filter((a) => all.includes(a.effect?.target));
    const targets = new Set(anims.map((a) => a.effect.target));
    const delays = anims.map((a) => a.effect.getTiming().delay);
    return { total: all.length, onScreen: onScreen.length, animated: targets.size, perRow: anims.length, offScreenAnimated: [...targets].filter((t) => !onScreen.includes(t)).length, missing: onScreen.filter((t) => !targets.has(t)).length, maxDelay: Math.max(...delays) };
  });
  expect("tall screen: more than the old 14-row cap on screen", R.cascade.onScreen > 14, R.cascade);
  expect("tall screen: every on-screen row animates, exactly once", R.cascade.missing === 0 && R.cascade.animated === R.cascade.onScreen && R.cascade.perRow === R.cascade.onScreen, R.cascade);
  expect("tall screen: off-screen rows untouched", R.cascade.offScreenAnimated === 0, R.cascade);
  expect("tall screen: whole wave starts within the window", R.cascade.maxDelay <= 140 + 420 + 1, R.cascade.maxDelay);
  await p.waitForTimeout(900);
  await p.setViewportSize({ width: 1400, height: 900 });
  await p.waitForTimeout(300);

  // ── mobile overlay ──
  await p.setViewportSize({ width: 760, height: 900 });
  await p.waitForTimeout(500);
  R.mClosed = await p.evaluate(() => { const r = document.getElementById("rail"); const m = document.getElementById("main").getBoundingClientRect(); const pr = document.getElementById("conn").getBoundingClientRect(); return { vis: getComputedStyle(r).visibility, right: Math.round(r.getBoundingClientRect().right), mainW: Math.round(m.width), mainLeft: Math.round(m.left), connRight: Math.round(pr.right) }; });
  expect("mobile: rail off-screen + hidden at rest", R.mClosed.vis === "hidden" && R.mClosed.right <= 0, R.mClosed);
  expect("mobile: chat keeps the full width (rail out of flow)", R.mClosed.mainLeft === 0 && R.mClosed.mainW >= 750 && R.mClosed.connRight > 700, R.mClosed);
  const mo = await sample(800);
  R.mOpen = { shape: shape(mo.s, "left", mo.s[0].left, 0), end: Math.round(mo.s[mo.s.length - 1].left), vis: mo.vis, mid: mo.s.filter((x) => x.left < -5 && x.left > -250).length };
  expect("mobile open: slides in (not instant), lands at 0", R.mOpen.end === 0 && R.mOpen.mid >= 1 && R.mOpen.vis === "visible", R.mOpen);
  // (mobile curve shape: exact seeked check below)
  const mc = await sample(800);
  R.mClose = { end: Math.round(mc.s[mc.s.length - 1].right), vis: mc.vis, mid: mc.s.filter((x) => x.left < -5 && x.right > 5).length, aria: mc.aria };
  expect("mobile close: slides out, then hidden", R.mClose.end <= 0 && R.mClose.mid >= 1 && R.mClose.vis === "hidden" && R.mClose.aria === "false", R.mClose);
  const mso = await seek(30, true);
  R.mCurveOpen = mso.out ? { easing: mso.easing, duration: mso.duration, ...thirds(mso.out) } : mso;
  expect("mobile open curve: expo-out, fast → soft", /0\.16, 1, 0\.3, 1/.test(R.mCurveOpen.easing) && R.mCurveOpen.first > 4 * R.mCurveOpen.last, R.mCurveOpen);
  const msc = await seek(30, true);
  R.mCurveClose = msc.out ? { easing: msc.easing, duration: msc.duration, ...thirds(msc.out) } : msc;
  expect("mobile close curve: in-out, fastest mid-way", /0\.65, 0, 0\.35, 1/.test(R.mCurveClose.easing) && R.mCurveClose.middle > 1.4 * R.mCurveClose.first && R.mCurveClose.middle > 1.4 * R.mCurveClose.last, R.mCurveClose);
  await p.setViewportSize({ width: 1400, height: 900 });
  await p.waitForTimeout(400);

  // ── reduced motion: instant ──
  await p.evaluate(() => setPref("motion", "reduced"));
  const rm = await sample(120);
  R.reduced = { firstW: Math.round(rm.s[0].w), frames: rm.s.length };
  expect("reduced motion: collapses immediately", R.reduced.firstW <= 1, R.reduced);
  await p.evaluate(() => { document.getElementById("rail-toggle").click(); setPref("motion", "system"); });

  if (errs.length) fail.push(`page errors: ${errs.join(" | ")}`);
  console.log(JSON.stringify(R, null, 1));
  console.log(fail.length ? `FAIL\n  ${fail.join("\n  ")}` : "PASS");
  await b.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
