// Telemetry view (web/telemetry.js) against a mocked /api/telemetry/* (the
// backend lives on another branch): fixtures in test/fixtures/telemetry follow
// API.md v1. Covers: open from the rail + #telemetry deep link + back/Escape,
// every panel renders, number formatting, null → "—", range + group toggles,
// sorting/search/paging, session drill-down (rich + empty timeline), one
// endpoint 500 → only its panels fail (and Retry recovers), summary polling only
// while open AND the tab is visible (page.clock, no real 10s waits), the keyboard
// contract (Escape never cancels a turn, "/" in search, PageDown scrolls the view,
// focus restored), host/range param propagation + paging resets, 20 open/close
// cycles stay flat, XSS payloads in every string field render as text, small-$
// axes, distinct series colours on a near-monochrome album, chart a11y labels, a
// NaN/undefined/Infinity/[object scan, mobile layout + tab strip, reduced motion.
// Sandbox (:7718) by default; SD_URL=… to point elsewhere. SHOTS=dir saves screenshots.
// REAL=1: no mocks, against a sandbox running the telemetry store (feat/telemetry-store
// merged): data-agnostic checks only, screenshots prefixed real-.
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const path = require("path");
const url = process.env.SD_URL || fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
const SHOTS = process.env.SHOTS || "";
const FX = path.join(__dirname, "fixtures/telemetry");
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), "utf8"));
const DAY = 86400000;
const fail = [];
const expect = (name, ok, detail) => { if (!ok) fail.push(`${name}${detail !== undefined ? `: ${JSON.stringify(detail).slice(0, 400)}` : ""}`); };

// ── mock backend ──
// XSS: every string the UI renders gets a payload (ids stay usable for routing)
function xssify(name, d, X) {
  const x = (v) => `${v}${X}`;
  if (name === "spend") d.series.forEach((s) => (s.key = x(s.key)));
  if (name === "agents") d.agents.forEach((a) => { a.name = x(a.name); a.models = (a.models || []).map(x); });
  if (name === "cache") { d.miss_reasons.forEach((m) => (m.reason = x(m.reason))); d.releases.forEach((r) => (r.tag = x(r.tag))); }
  if (name === "health") { d.stops.forEach((st) => (st.stop = st.stop == null ? null : x(st.stop))); d.stops.push({ stop: "constructor", count: 7 }, { stop: "__proto__", count: 5 });
    d.ingest.last_error = x("disk full"); d.ingest.sources.forEach((s) => { s.path = x(s.path); s.kind = x(s.kind); }); }
  if (name === "sessions") d.rows.forEach((r) => { r.title = x(r.title); r.title_raw = x(r.title_raw); r.model = x(r.model); r.host = x(r.host); r.grain = x(r.grain); });
  if (name === "session") { const s = d.session; s.title = x(s.title); s.title_raw = x(s.title_raw); s.model = x(s.model); s.host = x(s.host); s.grain = x(s.grain || "request");
    (d.workers || []).forEach((w) => { w.handle = x(w.handle); w.agent = x(w.agent); w.model = x(w.model); }); (d.timeline || []).forEach((t, i) => { if (i % 50 === 0) t.stop = x(t.stop); }); }
  return d;
}
const GARBAGE = /NaN|undefined|Infinity|\[object/;
const garbage = (p) => p.evaluate((re) => { const t = (document.getElementById("telemetry").innerText || "") + " " + (document.querySelector(".tl-tip")?.innerText || ""); const m = t.match(new RegExp(re)); return m ? t.slice(Math.max(0, m.index - 60), m.index + 40) : null; }, GARBAGE.source);
const SESS = fx("sessions.json"), STAR = fx("session-star.json");
function mock(ctx, opts = {}) {
  const log = [];
  const fails = opts.fails || new Set();
  if (process.env.REAL) { // record, don't fulfil
    ctx.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/telemetry/")) { const ep = u.pathname.slice(15); log.push({ ep, name: ep.split("/")[0], q: Object.fromEntries(u.searchParams), at: Date.now() }); } });
    return Promise.resolve(log);
  }
  return ctx.route("**/api/telemetry/**", (route) => {
    const u = new URL(route.request().url());
    const ep = u.pathname.replace(/^\/api\/telemetry\//, "");
    const name = ep.split("/")[0];
    log.push({ ep, name, q: Object.fromEntries(u.searchParams), at: Date.now() });
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (fails.has(name)) return json({ error: opts.xss || "boom" }, 500);
    const from = Number(u.searchParams.get("from")) || 0;
    const keep = (arr) => (from ? arr.slice(-Math.ceil((Date.now() - from) / DAY)) : arr); // fixtures end "today"
    const out = (body) => json(opts.xss ? xssify(name, body, opts.xss) : body);
    switch (name) {
      case "summary": return out(opts.summary ? opts.summary(fx("summary.json")) : fx("summary.json"));
      case "spend": {
        const d = fx(`spend-${u.searchParams.get("group") || "model"}.json`);
        d.series.forEach((s) => (s.points = keep(s.points)));
        if (opts.spendMax) { const tot = d.series[0].points.map((_, i) => d.series.reduce((a, x) => a + x.points[i][1], 0)); const k = opts.spendMax / Math.max(...tot); d.series.forEach((x) => x.points.forEach((pt) => (pt[1] = Math.round(pt[1] * k * 1e4) / 1e4))); }
        return out(d);
      }
      case "agents": return out(opts.agents ? opts.agents(fx("agents.json")) : fx("agents.json"));
      case "cache": { const d = fx("cache.json"); d.daily = keep(d.daily); return out(d); }
      case "latency": { const d = fx("latency.json"); d.daily = keep(d.daily); return out(d); }
      case "heatmap": return out(fx("heatmap.json"));
      case "health": return out(fx("health.json"));
      case "sessions": {
        const key = { cost: "spend", updated: "updated", requests: "requests" }[u.searchParams.get("sort") || "cost"];
        const q = (u.searchParams.get("q") || "").toLowerCase();
        const off = +u.searchParams.get("offset") || 0, lim = +u.searchParams.get("limit") || 50;
        const rows = SESS.rows.filter((r) => !q || r.id.includes(q) || r.title.toLowerCase().includes(q)).sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
        return out({ total: rows.length, rows: rows.slice(off, off + lim).map((r) => ({ ...r })) });
      }
      case "session": {
        const id = decodeURIComponent(ep.split("/")[1] || "");
        const star = JSON.parse(JSON.stringify(STAR));
        if (id === STAR.session.id) return out(opts.star ? opts.star(star) : star);
        const row = SESS.rows.find((r) => r.id === id);
        return row ? out({ session: { ...row }, timeline: [], workers: [] }) : json({ error: "not found" }, 404);
      }
    }
    return json({ error: "not found" }, 404);
  }).then(() => log);
}

const PANELS = ["live", "headline", "spend", "agents", "hit", "keepwarm", "writes", "miss", "ttft", "total", "split", "scatter", "sessions", "heatmap", "stops", "ingest"];
const settled = (p) => p.waitForFunction((ids) => ids.every((id) => { const el = document.querySelector(`#telemetry [data-p="${id}"]`); return el && !el.classList.contains("is-loading") && !el.classList.contains("is-busy"); }), PANELS, { timeout: 15000 });
const shot = async (p, name, sel) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  if (sel) await p.evaluate((s) => { const el = document.querySelector(s); const r = document.getElementById("telemetry"); r.scrollTop += el.getBoundingClientRect().top - r.querySelector(".tl-head").offsetHeight - 6; }, sel);
  await p.waitForTimeout(1300);
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

async function real(page, b) {
  const P = (p) => p.evaluate(() => Object.fromEntries([...document.querySelectorAll("#telemetry [data-p]")].map((el) => [el.dataset.p, el.classList.contains("is-err") ? `err: ${el.querySelector(".tl-err span")?.textContent}` : el.querySelector(".tl-empty") ? "empty" : "ok"])));
  const d = await page();
  await d.click("#open-telemetry"); await settled(d);
  let ps = await P(d);
  console.log("panels (real):", ps);
  expect("real: no panel errors", Object.values(ps).every((v) => !v.startsWith("err")), ps);
  const tiles = await d.evaluate(() => Object.fromEntries([...document.querySelectorAll("#telemetry .tl-tile[data-k]")].map((t) => [t.dataset.k, t.querySelector(".tl-tile-v span").textContent])));
  console.log("live strip (real):", tiles);
  const sum = await d.evaluate(() => fetch("/api/telemetry/summary").then((r) => r.json()));
  expect("real: a null summary tile reads —", sum.now.live_sessions !== null || tiles.live === "—", { tiles, live: sum.now.live_sessions });
  expect("real: no NaN/undefined/Infinity/[object", !(await garbage(d)), await garbage(d));
  for (const [name, sel] of [["real-desktop-1-live-money", null], ["real-desktop-2-money", '.tl-sec[data-sec="money"]'], ["real-desktop-3-cache", '.tl-sec[data-sec="cache"]'], ["real-desktop-4-latency", '.tl-sec[data-sec="latency"]'], ["real-desktop-5-sessions", '.tl-sec[data-sec="sessions"]'], ["real-desktop-6-health", '.tl-sec[data-sec="health"]']]) await shot(d, name, sel);
  for (const r of ["7d", "90d", "All"]) {
    await d.click(`#telemetry .tl-range .seg-opt:text-is("${r}")`); await settled(d);
    ps = await P(d);
    expect(`real: range ${r} renders`, Object.values(ps).every((v) => !v.startsWith("err")), ps);
  }
  await shot(d, "real-desktop-2b-money-all", '.tl-sec[data-sec="money"]');
  await shot(d, "real-desktop-3b-cache-all", '.tl-sec[data-sec="cache"]');
  for (const g of ["Main vs worker", "Host"]) { await d.click(`#telemetry .tl-group .seg-opt:text-is("${g}")`); await settled(d); expect(`real: group ${g}`, !(await P(d)).spend.startsWith("err")); }
  await shot(d, "real-desktop-2c-money-host", '.tl-sec[data-sec="money"]');
  if (await d.$("#telemetry [data-p=sessions] tbody tr")) {
    await d.click("#telemetry [data-p=sessions] tbody tr");
    await d.waitForSelector("#telemetry .tl-d-stats", { timeout: 8000 }).catch(() => fail.push("real: session detail never loaded"));
    await shot(d, "real-desktop-7-session-detail");
    expect("real: detail has no garbage text", !(await garbage(d)), await garbage(d));
    await d.keyboard.press("Escape"); await d.waitForTimeout(400);
  } else {
    console.log("real: the store has no sessions in range: drill-down skipped (not a failure)");
  }
  await d.keyboard.press("Escape"); await d.waitForTimeout(500);
  expect("real: Escape back to the session", await d.evaluate(() => document.getElementById("telemetry").classList.contains("hidden")));
  expect("real desktop: no page errors", d.errs.length === 0, d.errs);
  const m = await page({ width: 390, height: 844, touch: true });
  await m.tap("#open-telemetry"); await settled(m);
  const ov = await m.evaluate(() => { const R = document.getElementById("telemetry"); return R.scrollWidth - R.clientWidth; });
  expect("real mobile: no horizontal overflow", ov <= 0, ov);
  for (const [name, sel] of [["real-mobile-1-live", null], ["real-mobile-2-money", '.tl-sec[data-sec="money"]'], ["real-mobile-3-cache", '.tl-sec[data-sec="cache"]'], ["real-mobile-4-latency", '.tl-sec[data-sec="latency"]'], ["real-mobile-5-sessions", '.tl-sec[data-sec="sessions"]'], ["real-mobile-6-health", '[data-p="heatmap"]'], ["real-mobile-6b-health", '[data-p="ingest"]']]) await shot(m, name, sel);
  expect("real mobile: no garbage text", !(await garbage(m)), await garbage(m));
  expect("real mobile: no page errors", m.errs.length === 0, m.errs);
  const r = await page({ reduced: true });
  await r.click("#open-telemetry"); await settled(r);
  expect("real reduced motion: renders", Object.values(await P(r)).every((v) => !v.startsWith("err")));
  await b.close();
  if (fail.length) { console.log("FAIL\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("telemetry (REAL backend): all checks pass");
}

(async () => {
  const b = await chromium.launch();
  const page = async ({ width = 1440, height = 900, reduced = false, touch = false, clock = false, ...mo } = {}) => {
    const ctx = await b.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1, reducedMotion: reduced ? "reduce" : "no-preference" });
    const log = await mock(ctx, mo);
    const p = await ctx.newPage();
    const errs = []; p.on("pageerror", (e) => errs.push(String(e))); p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await p.goto(url); await p.waitForSelector("#open-telemetry", { state: "attached" });
    // after load: a fake clock during navigation/screenshots can stall them; this
    // page only fast-forwards timers (the poll interval is created on open, so it's faked)
    if (clock) await p.clock.install();
    p.errs = errs; p.log = log; return p;
  };
  if (process.env.REAL) { await real(page, b); return; }
  const panelState = (p) => p.evaluate(() => Object.fromEntries([...document.querySelectorAll("#telemetry [data-p]")].map((el) => [el.dataset.p, el.classList.contains("is-err") ? "err" : el.classList.contains("is-loading") ? "loading" : "ok"])));

  // ── desktop ──
  const d = await page();
  const t0 = Date.now();
  await d.click("#open-telemetry");
  await settled(d);
  const focusAtOpen = await d.evaluate(() => document.activeElement === document.getElementById("telemetry"));
  let s = await d.evaluate(() => ({ hash: location.hash, on: document.getElementById("main").classList.contains("tl-on"), vis: getComputedStyle(document.getElementById("telemetry")).display !== "none",
    btn: document.getElementById("open-telemetry").getAttribute("aria-pressed"), thread: getComputedStyle(document.getElementById("scroller")).visibility }));
  expect("desktop: rail button opens the view", s.vis && s.on && s.hash === "#telemetry" && s.btn === "true" && s.thread === "hidden", s);
  const ps = await panelState(d);
  expect("desktop: every panel rendered (none loading / error)", PANELS.every((id) => ps[id] === "ok"), ps);
  s = await d.evaluate(() => {
    const T = (sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim() ?? null;
    const R = document.getElementById("telemetry");
    return {
      tiles: [...R.querySelectorAll(".tl-tile[data-k]")].map((t) => `${t.dataset.k}=${t.querySelector(".tl-tile-v span").textContent}`),
      headline: T("#telemetry [data-p=headline]"),
      usd: T("#telemetry .tl-usd"),
      spendDays: +R.querySelector('[data-p=spend] .tl-chart').dataset.n,
      spendBars: R.querySelectorAll('[data-p=spend] .tl-plot .tl-fill').length,
      legend: T('#telemetry [data-p=spend] .tl-legend'),
      grainMarker: !!R.querySelector('[data-p=spend] .tl-mk'),
      agents: R.querySelectorAll('[data-p=agents] tbody tr').length,
      hitLine: R.querySelectorAll('[data-p=hit] .tl-line').length, releases: [...R.querySelectorAll('[data-p=hit] .tl-mk-t')].map((x) => x.textContent),
      writes: R.querySelectorAll('[data-p=writes] .tl-fill').length, miss: R.querySelectorAll('[data-p=miss] .tl-hb-r').length, missTop: T('#telemetry [data-p=miss] .tl-hb-r'),
      keepwarm: T('#telemetry [data-p=keepwarm] .tl-kw-big'),
      ttft: R.querySelectorAll('[data-p=ttft] .tl-line').length, total: R.querySelectorAll('[data-p=total] .tl-line').length,
      split: T('#telemetry [data-p=split] .tl-wf-l'), retry: T('#telemetry [data-p=split] .tl-retry-stat'),
      scatterDots: (R.querySelector('[data-p=scatter] .tl-dots')?.getAttribute("d").match(/M/g) || []).length,
      rows: R.querySelectorAll('[data-p=sessions] tbody tr').length, pager: T('#telemetry .tl-pager span'),
      cells: R.querySelectorAll('[data-p=heatmap] .tl-hm-c[data-wd]').length, hot: R.querySelectorAll('[data-p=heatmap] .tl-hm-c.hot').length, peak: T('#telemetry .tl-peak'),
      stops: [...R.querySelectorAll('[data-p=stops] .tl-hb-r')].map((r) => `${r.className.replace(/tl-hb-r ?/, "") || "-"}:${r.querySelector(".tl-hb-k span").textContent}`),
      ingest: T('#telemetry [data-p=ingest] .tl-ing-top'), skipped: T('#telemetry [data-p=ingest] .tl-ing-grid'),
      overflowX: R.scrollWidth - R.clientWidth,
    };
  });
  expect("live strip: 6 tiles, formatted", s.tiles.length === 6 && s.tiles.includes("hit=98.4%") && s.tiles.includes("ttft=480 ms") && s.tiles.includes("live=4") && /^spend=\$\d/.test(s.tiles[0]) && s.tiles.includes("burn=$38.60/h"), s.tiles);
  expect("money headline: since April · $53.7K · cache saved (net) $396.1K", /since April/.test(s.headline) && s.headline.includes("$53.7K") && /cache saved \(net\) \$396\.1K/.test(s.headline), s.headline);
  s.gross = await d.evaluate(() => [...document.querySelectorAll("#telemetry [data-p=headline] [title]")].map((x) => x.title).join(" "));
  expect("cache saved: gross on hover, labelled gross", /Gross: \$412\.3K/.test(s.gross), s.gross);
  expect("labelled API-equivalent", /API-equivalent/.test(s.usd), s.usd);
  expect("spend: 30 days by default, stacked bars, 4 models in legend", s.spendDays === 30 && s.spendBars >= 30 && /opus-5-5/.test(s.legend) && /fable-5-1/.test(s.legend), s);
  expect("agents table", s.agents === 12, s.agents);
  expect("cache: hit line + in-range release markers", s.hitLine === 1 && s.releases.includes("v0.11.0"), s);
  expect("cache: write bars, miss reasons (top: messages changed 238)", s.writes >= 30 && s.miss === 4 && /messages changed/.test(s.missTop) && /238/.test(s.missTop), s);
  expect("cache: keep-warm return", /8\.2×/.test(s.keepwarm), s.keepwarm);
  expect("latency: TTFT 3 lines, total 2 lines, split, retry rate", s.ttft === 3 && s.total === 2 && /310 ms/.test(s.split) && /0\.71%/.test(s.retry), s);
  expect("latency: 2000-point scatter", s.scatterDots === 2000, s.scatterDots);
  expect("sessions: page of 50, pager", s.rows === 50 && /1–50 of 1,138/.test(s.pager), s);
  expect("heatmap: 168 cells, hot cells, peak", s.cells === 168 && s.hot >= 5 && /Peak/.test(s.peak), s);
  expect("health: stops, anomalies flagged", s.stops.length === 5 && s.stops.includes("bad:refusal") && s.stops.includes("warn:max tokens") && s.stops.includes("warn:no stop reason"), s.stops);
  expect("desktop: no horizontal overflow", s.overflowX <= 0, s.overflowX);
  expect("health: ingest status", /healthy/.test(s.ingest) && /took 1\.8 s/.test(s.ingest) && /158/.test(s.skipped) && /bad lines\s*3/.test(s.skipped), s);
  s = await d.evaluate(() => [...document.querySelectorAll("#telemetry .tl-host .seg-opt")].map((b) => b.textContent));
  expect("host filter built from the store's sources (+ unknown)", s.join() === "All hosts,bella,jade,unknown", s);
  const first = d.log.filter((r) => r.at >= t0);
  expect("no NaN/undefined/Infinity/[object in the rendered view", !(await garbage(d)), await garbage(d));
  s = await d.evaluate(() => ({ imgs: [...document.querySelectorAll("#telemetry svg[role=img]")].map((x) => x.getAttribute("aria-label")), heat: document.querySelector("#telemetry .tl-heat")?.getAttribute("aria-label") }));
  expect("charts carry role=img summaries (S8)", s.imgs.length >= 6 && s.imgs.every((l) => l && l.length > 30 && !/NaN|undefined/.test(l)) && /Peak/.test(s.heat || "") && s.imgs.some((l) => /^Spend per day, 30 days/.test(l)), s);
  expect("requests: every endpoint once, range sent as from", ["summary", "spend", "agents", "cache", "latency", "sessions", "heatmap", "health"].every((n) => first.some((r) => r.name === n)) && first.find((r) => r.name === "spend").q.from, first.map((r) => r.name));
  for (const [name, sel] of [["desktop-1-live-money", null], ["desktop-2-money", '.tl-sec[data-sec="money"]'], ["desktop-3-cache", '.tl-sec[data-sec="cache"]'], ["desktop-4-latency", '.tl-sec[data-sec="latency"]'], ["desktop-5-sessions", '.tl-sec[data-sec="sessions"]'], ["desktop-6-health", '.tl-sec[data-sec="health"]']]) await shot(d, name, sel);

  // tooltips
  await d.evaluate(() => document.querySelector('#telemetry .tl-sec[data-sec="money"]').scrollIntoView());
  await d.waitForTimeout(300);
  let bx = await d.locator("#telemetry [data-p=spend] svg").boundingBox();
  await d.mouse.move(bx.x + bx.width * 0.6, bx.y + bx.height / 2);
  s = await d.evaluate(() => ({ on: document.querySelector(".tl-tip").classList.contains("on"), text: document.querySelector(".tl-tip").textContent, band: !!document.querySelector("#telemetry [data-p=spend] .tl-hov .tl-band") }));
  expect("tooltip: spend hover shows the day's breakdown + total", s.on && /Total/.test(s.text) && /opus/.test(s.text) && s.band, s);
  if (SHOTS) await d.screenshot({ path: path.join(SHOTS, "desktop-tooltip-spend.png"), clip: { x: bx.x - 20, y: bx.y - 80, width: bx.width + 40, height: bx.height + 160 } });
  await d.mouse.move(5, 5);
  expect("tooltip hides on leave", !(await d.evaluate(() => document.querySelector(".tl-tip").classList.contains("on"))));
  await d.evaluate(() => document.querySelector('#telemetry [data-p="heatmap"]').scrollIntoView());
  await d.waitForTimeout(300);
  const cell = d.locator('#telemetry .tl-hm-c[data-wd="1"][data-h="14"]');
  await cell.hover();
  s = await d.evaluate(() => document.querySelector(".tl-tip").textContent);
  expect("tooltip: heatmap cell", /Tuesday · 2 PM–3 PM/.test(s) && /Requests/.test(s), s);
  if (SHOTS) { const hb = await d.locator("#telemetry [data-p=heatmap]").boundingBox(); await d.screenshot({ path: path.join(SHOTS, "desktop-tooltip-heatmap.png"), clip: { x: hb.x - 10, y: hb.y - 10, width: hb.width + 20, height: hb.height + 20 } }); }

  // range + group
  const rangeClick = async (label) => { await d.click(`#telemetry .tl-range .seg-opt:text-is("${label}")`); await settled(d); };
  await rangeClick("7d");
  s = await d.evaluate(() => ({ n: +document.querySelector("#telemetry [data-p=spend] .tl-chart").dataset.n, cache: document.querySelectorAll("#telemetry [data-p=writes] .tl-fill").length, sub: document.querySelector(".tl-spend-sub").textContent }));
  expect("range 7d: spend + cache follow", s.n === 7 && s.cache >= 7 && s.cache <= 14 && /last 7 days/.test(s.sub), s);
  const r7 = d.log.filter((r) => r.name === "spend").pop().q.from;
  expect("range 7d: from = local midnight six days ago", Math.abs(+r7 - (new Date(new Date().setHours(0, 0, 0, 0)).getTime() - 6 * DAY)) < 2 * 3600000, r7);
  await rangeClick("All");
  s = await d.evaluate(() => ({ n: +document.querySelector("#telemetry [data-p=spend] .tl-chart").dataset.n, area: document.querySelectorAll("#telemetry [data-p=spend] .tl-area").length, mk: [...document.querySelectorAll("#telemetry [data-p=spend] .tl-mk-t")].map((x) => x.textContent) }));
  expect("range All: 202 days as stacked areas, grain marker session → request", s.n === 202 && s.area === 4 && s.mk.some((x) => /request-level/.test(x)) && s.mk.some((x) => /session-level/.test(x)), s);
  s = await d.evaluate(() => document.querySelector("#telemetry [data-p=writes] .tl-legend").textContent);
  expect("range All: TTL-unknown writes (legacy + early api-log) beside 1h/5m", /TTL unknown/.test(s) && /1h TTL/.test(s) && /5m TTL/.test(s), s);
  expect("range All: no from param", !("from" in d.log.filter((r) => r.name === "spend").pop().q));
  await shot(d, "desktop-2b-money-all", '.tl-sec[data-sec="money"]');
  await d.click('#telemetry .tl-group .seg-opt:text-is("Main vs worker")');
  await settled(d);
  s = await d.evaluate(() => document.querySelector("#telemetry [data-p=spend] .tl-legend").textContent);
  expect("group: main vs worker", /Main sessions/.test(s) && /Workers/.test(s) && d.log.filter((r) => r.name === "spend").pop().q.group === "role", s);
  await d.click('#telemetry .tl-group .seg-opt:text-is("Host")');
  await settled(d);
  s = await d.evaluate(() => document.querySelector("#telemetry [data-p=spend] .tl-legend").textContent);
  expect("group: host (incl. its own unknown series)", /bella/.test(s) && /jade/.test(s) && /unknown host/.test(s), s);
  await rangeClick("30d");

  // sessions: sort, paging, search, drill-down
  await d.click('#telemetry [data-p=sessions] th[data-sort="requests"]');
  await settled(d);
  s = await d.evaluate(() => [...document.querySelectorAll("#telemetry [data-p=sessions] tbody tr")].slice(0, 3).map((tr) => +tr.children[3].textContent.replace(/,/g, "")));
  expect("sessions: sort by requests", d.log.filter((r) => r.name === "sessions").pop().q.sort === "requests" && s[0] >= s[1] && s[1] >= s[2], s);
  await d.click("#telemetry .tl-next");
  await settled(d);
  s = await d.evaluate(() => document.querySelector("#telemetry .tl-pager span").textContent);
  expect("sessions: next page", /51–100/.test(s) && d.log.filter((r) => r.name === "sessions").pop().q.offset === "50", s);
  await d.keyboard.press("/");
  expect("'/' focuses the session search", await d.evaluate(() => document.activeElement.matches("#telemetry .tl-search input")));
  await d.keyboard.type(STAR.session.id.slice(0, 15));
  await d.waitForFunction(() => document.querySelectorAll("#telemetry [data-p=sessions] tbody tr").length === 1, null, { timeout: 5000 }).catch(() => {});
  await settled(d);
  s = await d.evaluate(() => ({ n: document.querySelectorAll("#telemetry [data-p=sessions] tbody tr").length, pager: document.querySelector("#telemetry .tl-pager span").textContent }));
  expect("sessions: search", s.n === 1 && /1–1 of 1/.test(s.pager), s);
  await d.click("#telemetry [data-p=sessions] tbody tr");
  await d.waitForSelector("#telemetry .tl-d-ctx svg", { timeout: 5000 }).catch(() => {});
  await d.waitForTimeout(500);
  s = await d.evaluate(() => {
    const D = document.querySelector("#telemetry .tl-detail");
    return { vis: !D.classList.contains("hidden"), title: D.querySelector("h3").textContent, ctx: !!D.querySelector(".tl-d-ctx .tl-line"), comp: D.querySelectorAll(".tl-d-ctx .tl-mk.warn").length,
      hit: D.querySelectorAll(".tl-d-hit .tl-fill").length, workers: D.querySelectorAll(".tl-wk-r").length, stops: D.querySelector(".tl-chips")?.textContent || "", stats: D.querySelector(".tl-d-stats").textContent };
  });
  expect("drill-down: context curve + compaction drops, per-request hit, stops, workers", s.vis && /telemetry store/.test(s.title) && s.ctx && s.comp >= 1 && s.hit === 412 && s.workers === 3 && /tool use/.test(s.stops) && /\$18\.40/.test(s.stats), s);
  bx = await d.locator("#telemetry .tl-d-ctx svg").boundingBox();
  await d.mouse.move(bx.x + bx.width * 0.5, bx.y + bx.height / 2);
  expect("drill-down: context tooltip", /Request #/.test(await d.evaluate(() => document.querySelector(".tl-tip").textContent)));
  await d.mouse.move(5, 5);
  await shot(d, "desktop-7-session-detail");
  await d.keyboard.press("Escape");
  await d.waitForTimeout(400);
  s = await d.evaluate(() => ({ det: document.querySelector("#telemetry .tl-detail").classList.contains("hidden"), view: !document.getElementById("telemetry").classList.contains("hidden") }));
  expect("Escape closes the detail first, view stays", s.det && s.view, s);
  const old = SESS.rows.find((r) => r.hit_pct === null && r.id !== STAR.session.id);
  await d.fill("#telemetry .tl-search input", old.id);
  await d.waitForFunction((id) => document.querySelector("#telemetry [data-p=sessions] tbody tr")?.dataset.id === id, old.id, { timeout: 5000 }).catch(() => {});
  await settled(d);
  s = await d.evaluate(() => document.querySelector("#telemetry [data-p=sessions] tbody tr").textContent);
  expect("sessions: null hit % renders as —, never 0", s.includes("—"), s);
  const unk = SESS.rows.find((r) => r.host === "unknown");
  await d.fill("#telemetry .tl-search input", unk.id);
  await d.waitForFunction((id) => document.querySelector("#telemetry [data-p=sessions] tbody tr")?.dataset.id === id, unk.id, { timeout: 5000 }).catch(() => {});
  s = await d.evaluate(() => { const t = document.querySelector("#telemetry [data-p=sessions] tbody tr .tl-tag.dim"); return t ? [t.textContent, t.title] : null; });
  expect('session host "unknown" gets an explained label', s && s[0] === "unknown host" && /couldn't be decided/.test(s[1]), s);
  await d.fill("#telemetry .tl-search input", old.id);
  await d.waitForFunction((id) => document.querySelector("#telemetry [data-p=sessions] tbody tr")?.dataset.id === id, old.id, { timeout: 5000 }).catch(() => {});
  await d.click("#telemetry [data-p=sessions] tbody tr");
  await d.waitForSelector("#telemetry .tl-d-empty", { timeout: 5000 }).catch(() => {});
  s = await d.evaluate(() => document.querySelector("#telemetry .tl-d-empty")?.textContent || null);
  expect("drill-down: empty timeline → note", /No request-level data for this session/.test(s || ""), s);
  await shot(d, "desktop-8-session-empty");
  await d.click("#telemetry .tl-scrim", { position: { x: 30, y: 300 } });
  await d.waitForTimeout(400);
  expect("scrim closes the detail", await d.evaluate(() => document.querySelector("#telemetry .tl-detail").classList.contains("hidden")));

  const lastReq = (p, n) => p.log.filter((r) => r.name === n).pop();
  const count = (p, n) => p.log.filter((r) => r.name === n).length;

  // ── keyboard contract (B1/S1) ──
  expect("open: focus moves into the view (not the hidden composer)", focusAtOpen);
  await d.fill("#telemetry .tl-search input", ""); await settled(d);
  await d.evaluate(() => { const R = document.getElementById("telemetry"); R.scrollTop = 0; R.focus(); window.__sc0 = document.getElementById("scroller").scrollTop; });
  await d.keyboard.press("PageDown"); await d.waitForTimeout(500);
  s = await d.evaluate(() => ({ view: document.getElementById("telemetry").scrollTop, scroller: document.getElementById("scroller").scrollTop, was: window.__sc0 }));
  expect("PageDown scrolls the view, not #scroller", s.view > 100 && s.scroller === s.was, s);
  await d.keyboard.press("End"); await d.waitForTimeout(500);
  s = await d.evaluate(() => ({ view: document.getElementById("telemetry").scrollTop, max: document.getElementById("telemetry").scrollHeight - document.getElementById("telemetry").clientHeight, scroller: document.getElementById("scroller").scrollTop, was: window.__sc0 }));
  expect("End scrolls the view to the bottom, transcript untouched", s.view >= s.max - 4 && s.scroller === s.was, s);
  await d.keyboard.press("/");
  await d.keyboard.type("a/b");
  s = await d.evaluate(() => ({ v: document.querySelector("#telemetry .tl-search input").value, input: document.getElementById("input").value }));
  expect('"/" focuses search, and types a literal "/" inside it', s.v === "a/b" && !s.input.includes("a/b"), s);
  await d.keyboard.press("Escape"); // clears the box first
  await d.waitForTimeout(400);
  expect("Escape in a filled search clears it (view stays)", await d.evaluate(() => document.querySelector("#telemetry .tl-search input").value === "" && !document.getElementById("telemetry").classList.contains("hidden")));
  await settled(d);
  // detail focus: open by keyboard, Escape returns focus to that row
  await d.evaluate(() => document.querySelector("#telemetry [data-p=sessions] tbody tr:nth-child(3)").focus());
  const rowId = await d.evaluate(() => document.activeElement.dataset.id);
  await d.keyboard.press("Enter");
  await d.waitForSelector("#telemetry .tl-d-stats", { timeout: 5000 }).catch(() => {});
  s = await d.evaluate(() => ({ inert: document.querySelector("#telemetry .tl-body").inert && document.querySelector("#telemetry .tl-head").inert, modal: document.querySelector("#telemetry .tl-detail").getAttribute("aria-modal"), focusIn: document.querySelector("#telemetry .tl-detail").contains(document.activeElement) }));
  expect("detail: modal, background inert, focus inside", s.inert && s.modal === "true" && s.focusIn, s);
  await d.keyboard.press("Escape"); await d.waitForTimeout(400);
  s = await d.evaluate(() => ({ id: document.activeElement?.dataset?.id, inert: document.querySelector("#telemetry .tl-body").inert }));
  expect("detail close: focus back on the row that opened it, background live again", s.id === rowId && !s.inert, { ...s, rowId });

  // ── host + range: params propagate, paging resets (S2/S3) ──
  await d.click("#telemetry .tl-next"); await settled(d);
  expect("paged to 51–100", lastReq(d, "sessions").q.offset === "50");
  const tH = Date.now();
  await d.click('#telemetry .tl-host .seg-opt:text-is("bella")'); await settled(d);
  s = d.log.filter((r) => r.at >= tH);
  expect("host bella: every endpoint gets host=bella", ["summary", "spend", "agents", "cache", "latency", "sessions", "heatmap", "health"].every((n) => s.some((r) => r.name === n && r.q.host === "bella")), s.map((r) => `${r.name}:${r.q.host}`));
  expect("host change resets the sessions offset", lastReq(d, "sessions").q.offset === "0", lastReq(d, "sessions").q);
  await d.click('#telemetry .tl-host .seg-opt:text-is("unknown")'); await settled(d);
  expect("host unknown is a filter value", lastReq(d, "spend").q.host === "unknown" && lastReq(d, "sessions").q.host === "unknown", lastReq(d, "spend").q);
  await d.click('#telemetry .tl-host .seg-opt:text-is("All hosts")'); await settled(d);
  expect("All hosts drops the host param", !("host" in lastReq(d, "spend").q));
  await d.click("#telemetry .tl-next"); await settled(d);
  await d.click('#telemetry .tl-range .seg-opt:text-is("7d")'); await settled(d);
  s = { q: lastReq(d, "sessions").q, pager: await d.evaluate(() => document.querySelector("#telemetry .tl-pager span").textContent) };
  expect("range change after paging resets to the first page", s.q.offset === "0" && /^1–/.test(s.pager), s);
  expect("health receives the range (stops follow it)", !!lastReq(d, "health").q.from, lastReq(d, "health").q);
  await d.click('#telemetry .tl-range .seg-opt:text-is("30d")'); await settled(d);

  await d.keyboard.press("Escape"); await d.waitForTimeout(400); // close d; the clock tests get their own page
  const k = await page({ clock: true });
  await k.click("#open-telemetry"); await settled(k);
  // ── polling: page.clock, open + visible only ──
  let n0 = count(k, "summary");
  await k.clock.fastForward(10500); await k.waitForTimeout(300);
  expect("polls /summary every 10s while open", count(k, "summary") - n0 === 1, { n0, n1: count(k, "summary") });
  await k.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  n0 = count(k, "summary");
  await k.clock.fastForward(30500); await k.waitForTimeout(300);
  expect("hidden tab: no polls", count(k, "summary") === n0, { n0, n1: count(k, "summary") });
  await k.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  await k.waitForTimeout(300);
  expect("visible again: refreshes at once", count(k, "summary") === n0 + 1, { n0, n1: count(k, "summary") });

  // ── Escape while a turn streams: closes the view, never sends cancel ──
  await k.evaluate(() => {
    window.__sent = [];
    window.__realSend = S.ws?.send;
    if (S.ws) S.ws.send = (f) => window.__sent.push(String(f)); // swallow: nothing reaches the daemon
    window.__was = { streaming: S.streaming, owner: S.owner };
    S.streaming = true; S.owner = S.me ?? 1; if (S.me == null) S.me = 1;
  });
  await k.keyboard.press("Escape");
  await k.keyboard.press("Escape"); // a fast second one, right after the view closed
  await k.waitForTimeout(150);
  s = await k.evaluate(() => ({ sent: window.__sent.filter((f) => /cancel/.test(f)), closed: !__telemetry.isOpen, focus: document.activeElement?.id }));
  await k.evaluate(() => { if (S.ws) S.ws.send = window.__realSend; S.streaming = window.__was.streaming; S.owner = window.__was.owner; });
  expect("Escape while streaming: view closes, no cancel sent (even a fast second Escape)", s.closed && s.sent.length === 0, s);
  expect("view close: focus back on the Telemetry button", s.focus === "open-telemetry", s.focus);
  await k.waitForTimeout(300);
  s = await k.evaluate(() => ({ hidden: document.getElementById("telemetry").classList.contains("hidden"), hash: location.hash, on: document.getElementById("main").classList.contains("tl-on"), thread: getComputedStyle(document.getElementById("scroller")).visibility }));
  expect("Escape returns to the session view", s.hidden && !s.on && s.hash !== "#telemetry" && s.thread === "visible", s);
  n0 = count(k, "summary");
  await k.clock.fastForward(30500); await k.waitForTimeout(300);
  expect("no polling once closed", count(k, "summary") === n0, { n0, n1: count(k, "summary") });

  // ── 20 open/close cycles: DOM, animations and listeners stay flat ──
  const snap = () => k.evaluate(() => ({ nodes: document.querySelectorAll("#telemetry *").length + document.querySelectorAll(".tl-tip *").length, tips: document.querySelectorAll(".tl-tip").length, anims: document.getAnimations().filter((a) => a.playState === "running" && a.effect?.target?.closest?.("#telemetry, .tl-tip")).length }));
  await k.click("#open-telemetry"); await settled(k); await k.keyboard.press("Escape"); await k.waitForTimeout(400);
  const before = await snap();
  const nCyc = count(k, "summary");
  for (let i = 0; i < 20; i++) { await k.click("#open-telemetry"); await settled(k); await k.keyboard.press("Escape"); await k.waitForTimeout(260); }
  await k.waitForTimeout(500);
  const after = await snap();
  expect("20 cycles: DOM + running animations flat", after.nodes === before.nodes && after.tips === 1 && after.anims <= before.anims, { before, after });
  expect("20 cycles: exactly one /summary per open", count(k, "summary") - nCyc === 20, count(k, "summary") - nCyc);
  n0 = count(k, "summary");
  await k.clock.fastForward(60000); await k.waitForTimeout(300);
  expect("20 cycles: no orphaned poll timers", count(k, "summary") === n0, { n0, n1: count(k, "summary") });

  expect("clock page: no page errors", k.errs.length === 0, k.errs);
  await k.context().close();

  // back button + deep link
  await d.click("#open-telemetry"); await settled(d);
  await d.goBack(); await d.waitForTimeout(500);
  expect("browser back closes the view", await d.evaluate(() => document.getElementById("telemetry").classList.contains("hidden") && !location.hash.startsWith("#telemetry")));
  await d.goForward(); await d.waitForTimeout(500);
  expect("forward reopens it", await d.evaluate(() => !document.getElementById("telemetry").classList.contains("hidden")));
  await d.click("#telemetry .tl-close"); await d.waitForTimeout(400);
  await d.goto(new URL("/#telemetry", url).href); await settled(d);
  s = await d.evaluate(() => ({ open: !document.getElementById("telemetry").classList.contains("hidden"), hash: location.hash }));
  await d.waitForTimeout(1500); // the app attaches a session meanwhile: the hash must stay
  s.hashAfterAttach = await d.evaluate(() => location.hash);
  expect("deep link #telemetry opens the view and keeps the hash through attach", s.open && s.hash === "#telemetry" && s.hashAfterAttach === "#telemetry", s);
  await d.click("#telemetry .tl-close"); await d.waitForTimeout(400);
  s = await d.evaluate(() => ({ hidden: document.getElementById("telemetry").classList.contains("hidden"), hash: location.hash, sid: typeof S !== "undefined" ? S.sid : null }));
  expect("close after deep link → #s=<session>", s.hidden && (s.sid ? s.hash === `#s=${s.sid}` : !s.hash.startsWith("#telemetry")), s);
  const li = await d.$("#rail li[data-id]");
  if (li) {
    await d.click("#open-telemetry"); await settled(d);
    await li.click(); await d.waitForTimeout(600);
    expect("picking a session in the rail leaves the view", await d.evaluate(() => document.getElementById("telemetry").classList.contains("hidden") && !location.hash.startsWith("#telemetry")));
  }
  expect("desktop: no page errors", d.errs.length === 0, d.errs);

  // ── one endpoint fails → only its panels ──
  // today's backend: no live list, no per-agent spend, no linked timelines
  const e = await page({ fails: new Set(["cache"]), summary: (x) => { x.now.live_sessions = null; x.now.live_workers = null; x.now.ttft_p50_ms_1h = null; return x; },
    agents: (x) => { x.agents.forEach((a) => { a.requests = null; a.spend = null; a.models = []; }); return x; }, star: (x) => ({ ...x, timeline: [], workers: x.workers.map((w) => ({ ...w, spend: null })) }) });
  await e.click("#open-telemetry");
  await settled(e);
  const es = await panelState(e);
  expect("cache 500: hit/keepwarm/writes/miss show the error", ["hit", "keepwarm", "writes", "miss"].every((id) => es[id] === "err"), es);
  expect("cache 500: every other panel still renders", PANELS.filter((id) => !["hit", "keepwarm", "writes", "miss"].includes(id)).every((id) => es[id] === "ok"), es);
  s = await e.evaluate(() => ({ err: document.querySelector("#telemetry [data-p=hit] .tl-err")?.textContent.replace(/\s+/g, " "), tiles: [...document.querySelectorAll("#telemetry .tl-tile[data-k]")].map((t) => `${t.dataset.k}=${t.querySelector(".tl-tile-v span").textContent}|${t.querySelector(".tl-tile-s").textContent}`) }));
  expect("error names the endpoint, status and the {error} body", /\/api\/telemetry\/cache/.test(s.err) && /500 · boom/.test(s.err) && /Retry/.test(s.err), s.err);
  expect("null → — (never 0), and says why", s.tiles.some((t) => t.startsWith("live=—|") && /not tracked/.test(t)) && s.tiles.some((t) => t.startsWith("ttft=—|")), s.tiles);
  s = await e.evaluate(() => ({ spend: [...document.querySelectorAll("#telemetry [data-p=agents] tbody tr")].map((tr) => tr.children[3].textContent), runs: [...document.querySelectorAll("#telemetry [data-p=agents] tbody tr")].map((tr) => +tr.children[1].textContent.replace(/,/g, "")),
    pending: document.querySelector("#telemetry [data-p=agents] .tl-pending")?.textContent }));
  expect("agents without spend: —, ranked by runs, pending note", s.spend.every((x) => x === "—") && s.runs[0] >= s.runs[1] && /telemetry PR/.test(s.pending || ""), s);
  await shot(e, "desktop-10-pending-agents", '.tl-sec[data-sec="money"]');
  await shot(e, "desktop-9-error-panel", '.tl-sec[data-sec="cache"]');
  await e.unroute("**/api/telemetry/**");
  await mock(e.context());
  await e.click('#telemetry [data-p=hit] .tl-retry');
  await settled(e);
  expect("Retry recovers the panel", (await panelState(e)).hit === "ok");
  expect("error page: no garbage text", !(await garbage(e)), await garbage(e));
  expect("error page: no page errors", e.errs.length === 0, e.errs);

  // ── XSS: payloads in every string field render as text ──
  const XSS = `<img src=x onerror="window.__pwned=1">"><svg onload=window.__pwned=2>'`;
  const x = await page({ xss: XSS, fails: new Set(["latency"]) });
  await x.click("#open-telemetry"); await settled(x);
  await x.click('#telemetry .tl-range .seg-opt:text-is("All")'); await settled(x);
  for (const g of ["Main vs worker", "Model"]) { await x.click(`#telemetry .tl-group .seg-opt:text-is("${g}")`); await settled(x); }
  await x.fill("#telemetry .tl-search input", STAR.session.id);
  await x.waitForFunction((id) => document.querySelector("#telemetry [data-p=sessions] tbody tr")?.dataset.id === id, STAR.session.id, { timeout: 5000 }).catch(() => {});
  await x.click("#telemetry [data-p=sessions] tbody tr");
  await x.waitForSelector("#telemetry .tl-d-ctx svg", { timeout: 5000 }).catch(() => {});
  for (const sel of ["[data-p=spend] svg", "[data-p=hit] svg"]) { const bb = await x.locator(`#telemetry ${sel}`).boundingBox().catch(() => null); if (bb) await x.mouse.move(bb.x + bb.width * 0.7, bb.y + bb.height / 2); }
  await x.waitForTimeout(300);
  s = await x.evaluate(() => ({
    pwned: window.__pwned ?? null,
    injected: document.querySelectorAll('#telemetry img, .tl-tip img, svg[onload], [onerror]').length,
    literal: (document.getElementById("telemetry").innerText.match(/<img src=x onerror=/g) || []).length,
    stops: [...document.querySelectorAll("#telemetry [data-p=stops] .tl-hb-r")].map((r) => `${r.className}|${r.querySelector("span").textContent}`).filter((t) => /constructor|proto/.test(t)),
    hosts: [...document.querySelectorAll("#telemetry .tl-host .seg-opt")].length,
  }));
  expect("XSS: nothing injected, nothing ran", s.pwned === null && s.injected === 0, s);
  expect("XSS: payloads shown literally across panels + detail", s.literal >= 8, s.literal);
  expect('stop reasons "constructor" / "__proto__" stay plain strings', s.stops.length === 2 && s.stops.every((t) => /^tl-hb-r \|/.test(t) || /^tl-hb-r\|/.test(t) || /^tl-hb-r *\|/.test(t)), s.stops);
  expect("XSS page: no garbage text, no page errors", !(await garbage(x)) && x.errs.length === 0, { g: await garbage(x), e: x.errs });

  // ── small-$ axes (S4) ──
  for (const max of [0.37, 9]) {
    const a = await page({ spendMax: max });
    await a.click("#open-telemetry"); await settled(a);
    const labels = await a.evaluate(() => [...document.querySelectorAll("#telemetry [data-p=spend] svg text.tl-ax")].filter((t) => t.getAttribute("text-anchor") === "end" && /^\$/.test(t.textContent)).map((t) => t.textContent));
    expect(`axis with a $${max} max: distinct, honest labels`, labels.length >= 3 && new Set(labels).size === labels.length && labels.some((l) => l !== "$0"), labels);
    console.log(`  axis @ $${max}:`, labels.join(" "));
    await a.context().close();
  }

  // ── series colours on a near-monochrome album (S5) ──
  const c = await page();
  await c.evaluate(() => applyPalette({ colors: { primary: "#e0905a", secondary: "#d9a36f", accent: "#e39a62", error: "#e06c5a", warning: "#d8a56a", success: "#c9a46e", info: "#dd9d66", text: "#f1e3d3", text_muted: "#a08b78", background: "#17110d", background_panel: "#1f1712", background_element: "#2a2019", border: "#6b5546", border_active: "#9a7d68", border_subtle: "#45362c", border_dimmest: "#2b211b" }, fade_ms: 0 }, "test"));
  await c.click("#open-telemetry"); await settled(c);
  await c.click('#telemetry .tl-range .seg-opt:text-is("All")'); await settled(c);
  s = await c.evaluate(() => {
    const lab = (document.getElementById("telemetry").dataset.series || "").split(" ").map((x) => x.split(",").map(Number));
    let min = 9;
    for (let i = 0; i < lab.length; i++) for (let j = 0; j < i; j++) min = Math.min(min, Math.hypot(...lab[i].map((v, k) => v - lab[j][k])));
    const leg = [...document.querySelectorAll("#telemetry [data-p=spend] .tl-legend .tl-lg i")].map((i) => getComputedStyle(i).backgroundColor);
    return { n: lab.length, min: +min.toFixed(3), legend: leg, distinct: new Set(leg).size };
  });
  expect("near-monochrome album: 6 series colours, pairwise distinct (oklab ≥ .07)", s.n === 6 && s.min >= 0.07 && s.distinct === s.legend.length, s);
  if (SHOTS) await shot(c, "desktop-11-monochrome-album", '.tl-sec[data-sec="money"]');
  await c.context().close();

  // ── mobile ──
  const m = await page({ width: 390, height: 844, touch: true });
  s = await m.evaluate(() => { const b = document.getElementById("open-telemetry").getBoundingClientRect(); return { right: b.right, vw: innerWidth, top: b.top }; });
  expect("mobile: header button on screen", s.right <= s.vw && s.top < 56, s);
  await m.tap("#open-telemetry"); await m.waitForTimeout(700);
  await settled(m);
  s = await m.evaluate(() => {
    const R = document.getElementById("telemetry");
    const tiles = [...R.querySelectorAll(".tl-tile")].map((t) => Math.round(t.getBoundingClientRect().left));
    const hm = R.querySelector(".tl-heat").getBoundingClientRect();
    return { drawer: document.getElementById("app").classList.contains("rail-open"), open: !R.classList.contains("hidden"), overflowX: R.scrollWidth - R.clientWidth,
      cols: new Set(tiles).size, heatRight: hm.right, vw: innerWidth, close: R.querySelector(".tl-close").getBoundingClientRect().right <= innerWidth };
  });
  expect("mobile: opens from the header", s.open && !s.drawer, s);
  expect("mobile: no horizontal overflow, 2-col strip, heatmap fits", s.overflowX <= 0 && s.cols === 2 && s.heatRight <= s.vw && s.close, s);
  for (const [name, sel] of [["mobile-1-live", null], ["mobile-2-money", '.tl-sec[data-sec="money"]'], ["mobile-3-cache", '.tl-sec[data-sec="cache"]'], ["mobile-4-latency", '.tl-sec[data-sec="latency"]'], ["mobile-5-sessions", '.tl-sec[data-sec="sessions"]'], ["mobile-6-health", '[data-p="heatmap"]'], ["mobile-6b-health", '[data-p="stops"]']]) await shot(m, name, sel);
  await m.evaluate(() => document.querySelector('#telemetry [data-p="spend"]').scrollIntoView({ block: "center" }));
  bx = await m.locator("#telemetry [data-p=spend] svg").boundingBox();
  await m.tap("#telemetry [data-p=spend] svg", { position: { x: bx.width * 0.7, y: bx.height / 2 } });
  await m.waitForTimeout(200);
  expect("mobile: tap shows a tooltip and it stays", await m.evaluate(() => document.querySelector(".tl-tip").classList.contains("on")));
  await m.tap("#telemetry .tl-title"); await m.waitForTimeout(200);
  expect("mobile: tapping elsewhere hides it", !(await m.evaluate(() => document.querySelector(".tl-tip").classList.contains("on"))));
  await m.fill("#telemetry .tl-search input", STAR.session.id);
  await m.waitForFunction(() => document.querySelectorAll("#telemetry [data-p=sessions] tbody tr").length === 1, null, { timeout: 5000 }).catch(() => {});
  await settled(m);
  await m.tap("#telemetry [data-p=sessions] tbody tr");
  await m.waitForSelector("#telemetry .tl-d-ctx svg", { timeout: 5000 }).catch(() => {});
  s = await m.evaluate(() => { const r = document.querySelector("#telemetry .tl-detail").getBoundingClientRect(); return { w: Math.round(r.width), vw: innerWidth }; });
  expect("mobile: session detail is full-width", s.w === s.vw, s);
  await shot(m, "mobile-7-session-detail");
  await m.tap("#telemetry .tl-d-close"); await m.waitForTimeout(400);
  await m.tap("#telemetry .tl-close"); await m.waitForTimeout(500);
  expect("mobile: close returns to the session", await m.evaluate(() => document.getElementById("telemetry").classList.contains("hidden")));
  await m.tap("#open-telemetry"); await settled(m);
  await m.evaluate(() => { const R = document.getElementById("telemetry"); R.scrollTop = R.scrollHeight; });
  await m.waitForTimeout(900);
  s = await m.evaluate(() => { const t = document.querySelector("#telemetry .tl-tab.on"), strip = document.querySelector("#telemetry .tl-tabs"); const a = t.getBoundingClientRect(), b = strip.getBoundingClientRect(); return { tab: t.textContent, left: a.left - b.left, right: b.right - a.right }; });
  expect("mobile: active tab scrolled fully into the strip (S7)", s.tab === "Health" && s.left >= 0 && s.right >= 0, s);
  if (SHOTS) await m.screenshot({ path: path.join(SHOTS, "mobile-8-tabstrip-health.png"), clip: { x: 0, y: 0, width: 390, height: 140 } });
  expect("mobile: no garbage text", !(await garbage(m)), await garbage(m));
  expect("mobile: no page errors", m.errs.length === 0, m.errs);

  // ── reduced motion ──
  const r = await page({ reduced: true });
  await r.click("#open-telemetry");
  await settled(r);
  s = await r.evaluate(() => {
    const R = document.getElementById("telemetry");
    const running = document.getAnimations().filter((a) => R.contains(a.effect?.target) && a.playState === "running" && !(a.effect?.target?.closest?.(".tl-skel"))).length;
    const line = R.querySelector("[data-p=hit] .tl-line"), card = R.querySelector(".tl-card");
    const tile = R.querySelector('.tl-tile[data-k="req"] .tl-tile-v span');
    return { running, dash: getComputedStyle(line).strokeDashoffset, cardAnim: getComputedStyle(card).animationName, tile: tile.textContent, opacity: getComputedStyle(card).opacity };
  });
  expect("reduced motion: no running animations, lines fully drawn, numbers final at once", s.running === 0 && (s.dash === "0" || s.dash === "0px") && s.cardAnim === "none" && /\d,\d{3}/.test(s.tile) && s.opacity === "1", s);
  await r.click("#telemetry .tl-close");
  expect("reduced motion: closes instantly", await r.evaluate(() => document.getElementById("telemetry").classList.contains("hidden")));
  expect("reduced motion: no page errors", r.errs.length === 0, r.errs);

  await b.close();
  if (fail.length) { console.log("FAIL\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("telemetry: all checks pass");
})().catch((e) => { console.error(e); process.exit(1); });
