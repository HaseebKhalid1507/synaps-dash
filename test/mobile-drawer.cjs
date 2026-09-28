// Mobile rail drawer: once open it covers the toggle, so it must close some
// other way. Pins every exit: scrim tap, Escape, New session, picking a row is
// covered by rail.cjs. Also pins the 860px boundary (JS used innerWidth < 860,
// CSS max-width: 860px — at exactly 860 the toggle collapsed a rail that was
// already an off-screen drawer, so it could never open) and that desktop keeps
// its push-rail with no scrim.
// Needs no daemon: SD_URL=http://127.0.0.1:PORT/ against a static serve of web/.
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const url = process.env.SD_URL || fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
const fail = [];
const expect = (name, ok, detail) => { if (!ok) fail.push(`${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`); };

(async () => {
  const b = await chromium.launch();
  const page = async (width, height) => {
    const p = await (await b.newContext({ viewport: { width, height }, hasTouch: width < 900 })).newPage();
    const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
    await p.goto(url); await p.waitForSelector("#rail-toggle");
    p.errs = errs; return p;
  };
  const state = (p) => p.evaluate(() => {
    const app = document.getElementById("app"), rail = document.getElementById("rail"), t = document.getElementById("rail-toggle");
    const r = rail.getBoundingClientRect(), tb = t.getBoundingClientRect();
    const hit = document.elementFromPoint(tb.x + tb.width / 2, tb.y + tb.height / 2);
    return {
      open: app.classList.contains("rail-open"), collapsed: app.classList.contains("rail-collapsed"),
      aria: t.getAttribute("aria-expanded"), railVisible: getComputedStyle(rail).visibility === "visible" && r.right > 10,
      railRight: Math.round(r.right), scrim: (() => { const a = getComputedStyle(app, "::after"); return a.content === "none" || a.visibility !== "visible" ? 0 : +a.opacity; })(),
      toggleCovered: !t.contains(hit),
    };
  });
  const settle = (p) => p.waitForTimeout(700);
  const open = async (p) => {
    await p.click("#rail-toggle", { timeout: 2000 }).catch(() => fail.push(`toggle unreachable at ${p.viewportSize().width}px (covered by the open drawer)`));
    await settle(p);
  };

  // ── phone ──
  const m = await page(390, 844);
  let s = await state(m);
  expect("phone: starts closed", !s.open && !s.railVisible && s.aria === "false", s);
  await open(m); s = await state(m);
  expect("phone: toggle opens drawer", s.open && s.railVisible && s.aria === "true", s);
  expect("phone: scrim shows under the drawer", s.scrim > 0.9, s);
  expect("phone: (why this matters) open drawer covers the toggle", s.toggleCovered, s);

  await m.mouse.click(372, 500); await settle(m); s = await state(m);   // right of the 300px drawer
  expect("phone: tapping the scrim closes", !s.open && !s.railVisible && s.aria === "false" && s.scrim < 0.05, s);

  await open(m); await m.keyboard.press("Escape"); await settle(m); s = await state(m);
  expect("phone: Escape closes", !s.open && s.aria === "false", s);

  await open(m); await m.click("#new-session"); await settle(m); s = await state(m);
  expect("phone: New session closes", !s.open && s.aria === "false", s);

  // inside the drawer, on its own chrome (not a session row: picking one navigates and closes it)
  await open(m); { const r = await m.locator("#rail .brand").boundingBox(); await m.mouse.click(r.x + r.width - 8, r.y + r.height / 2); } await settle(m); s = await state(m);
  expect("phone: tapping inside the drawer keeps it open", s.open && s.railVisible, s);
  expect("phone: no page errors", m.errs.length === 0, m.errs);

  // ── exactly the breakpoint ──
  const e = await page(860, 900);
  await open(e); s = await state(e);
  expect("860px: toggle opens the drawer (CSS says mobile here)", s.open && s.railVisible, s);
  await e.mouse.click(700, 500); await settle(e); s = await state(e);
  expect("860px: scrim closes", !s.open, s);

  // ── desktop: push rail, no scrim, #app clicks harmless ──
  const d = await page(1400, 900);
  s = await state(d);
  expect("desktop: rail shown", s.railVisible && !s.collapsed && s.scrim === 0, s);
  await open(d); s = await state(d);
  expect("desktop: toggle collapses", s.collapsed && s.aria === "false" && s.scrim === 0, s);
  await open(d); s = await state(d);
  expect("desktop: toggle expands", !s.collapsed && s.aria === "true", s);
  await d.keyboard.press("Escape"); await settle(d); s = await state(d);
  expect("desktop: Escape leaves the rail alone", !s.collapsed, s);
  expect("desktop: no page errors", d.errs.length === 0, d.errs);

  await b.close();
  if (fail.length) { console.log("FAIL\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("mobile-drawer: all checks pass");
})().catch((e) => { console.error(e); process.exit(1); });
