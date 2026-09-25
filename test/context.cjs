// Context meter on the SANDBOX (:7718).
// Real: fresh attach → daemon estimate (~); a real turn → MEASURED value equal
//   to input + cache_read + cache_create of the last Usage event captured off
//   the wire; budget + compaction flag equal a direct context_assessment query.
// Injected: TUI colour thresholds, formatting, compaction → back to estimate,
//   popover (open / Esc / outside click / aria), layout, reduced motion.
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const fail = [];
const expect = (name, ok, detail) => { if (!ok) fail.push(`${name}${detail !== undefined ? `: ${JSON.stringify(detail).slice(0, 400)}` : ""}`); };

(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  // capture every Usage event the page receives
  await p.evaluate(() => { window.__usage = []; const orig = window.onStream; window.onStream = (s, ts) => { if (s && s.kind === "session" && s.session === "usage") window.__usage.push(s); return orig(s, ts); }; });
  // Let the page's own auto-attach settle BEFORE reading the current session —
  // otherwise that late attach satisfies the "new session ready" wait below and
  // Enter lands mid-switch (the original flake).
  const R = {};
  await p.waitForFunction(() => S.sid || /No live sessions/.test(document.getElementById("thread").textContent), null, { timeout: 15000 });
  await p.waitForTimeout(200);
  const h0 = await p.evaluate(() => location.hash);
  // The product race itself: text typed, "new session" clicked, Enter in the same
  // tick → the message must stay in the box, not vanish into a closing socket.
  if (await p.evaluate(() => !!S.sid && isOwner())) {
    R.race = await p.evaluate(() => { const i = document.getElementById("input"); i.value = "typed during a switch"; document.getElementById("new-session").click(); doSend(); return i.value; });
  }
  await p.waitForFunction((h) => location.hash && location.hash !== h && S.sid && location.hash.includes(S.sid) && !document.getElementById("input").disabled, h0, { timeout: 20000 }).catch((e) => { throw new Error(`[new-session attach] ${e.message}`); });
  if (R.race !== undefined) {
    expect("Enter mid-switch keeps the message in the box", R.race === "typed during a switch", R.race);
    await p.fill("#input", "");
  }
  const meter = () => p.evaluate(() => {
    const b = document.getElementById("st-ctx"), f = b.querySelector(".ctx-fill"), t = b.querySelector(".ctx-tick");
    const m = /scaleX\(([\d.]+)\)/.exec(f.style.transform);
    return { hidden: b.classList.contains("hidden"), cls: [...b.classList].filter((c) => c !== "ctx").sort().join(" "), txt: getComputedStyle(b.querySelector(".ctx-txt"), "::before").content.replace(/"/g, "").replace("none", "") + b.querySelector(".ctx-txt").textContent,
      scale: m ? +m[1] : null, tick: t.classList.contains("hidden") ? null : parseFloat(t.style.left), aria: b.getAttribute("aria-label"), expanded: b.getAttribute("aria-expanded"), state: window.__ctx.state };
  });

  // ── real: fresh attach shows the daemon's estimate ──
  await p.waitForFunction(() => !document.getElementById("st-ctx").classList.contains("hidden"), null, { timeout: 8000 });
  R.fresh = await meter();
  expect("fresh attach: estimate shown (~), window from the daemon", R.fresh.cls.includes("est") && R.fresh.txt.startsWith("~") && R.fresh.state.window === 200000 && R.fresh.state.estimate > 0, R.fresh);
  expect("fresh attach: compaction tick at budget/window", R.fresh.state.budget > 0 && Math.abs(R.fresh.tick - (R.fresh.state.budget / 200000) * 100) < 0.1, [R.fresh.tick, R.fresh.state.budget]);

  // ── real turn → measured ──
  await p.fill("#input", "Reply with exactly: ok");
  await p.press("#input", "Enter");
  await p.waitForFunction(() => S.streaming, null, { timeout: 20000 }).catch(async (e) => { throw new Error(`[turn start] ${e.message} | idle=${await p.evaluate(() => JSON.stringify({ sid: S.sid, own: isOwner(), streaming: S.streaming, input: document.getElementById("input").value, last: [...document.querySelectorAll("#thread .msg")].slice(-2).map((m) => m.className + ":" + m.textContent.slice(0, 60)) }))}`); });
  await p.waitForFunction(() => !S.streaming, null, { timeout: 90000 });
  await p.waitForTimeout(800);
  R.turn = await meter();
  const usage = await p.evaluate(() => window.__usage);
  const last = usage[usage.length - 1] || {};
  const expected = (last.input_tokens || 0) + (last.cache_read_input_tokens || 0) + (last.cache_creation_input_tokens || 0);
  R.turn.expected = expected; R.turn.usageEvents = usage.length;
  expect("turn: Usage events arrived", usage.length >= 1, usage.length);
  expect("turn: measured == input + cache_read + cache_create of the last Usage", R.turn.state.measured === expected && expected > 0, { measured: R.turn.state.measured, expected });
  expect("turn: no longer an estimate", !R.turn.cls.includes("est") && !R.turn.txt.startsWith("~"), R.turn);
  expect("turn: fill = used / window", Math.abs(R.turn.scale - expected / 200000) < 0.001, [R.turn.scale, expected / 200000]);
  const direct = await p.evaluate(() => new Promise((res) => query({ query: "context_assessment" }, res)));
  R.direct = direct;
  expect("budget + compaction flag match a direct assessment", R.turn.state.budget === direct.budget_tokens && R.turn.state.shouldCompact === direct.should_compact && R.turn.state.window === direct.provider_window, { meter: R.turn.state, direct });
  expect("aria-label states used, window, left", /Context: .+ of 200k used \(\d+%\), .+ left/.test(R.turn.aria), R.turn.aria);

  // ── popover ──
  await p.click("#st-ctx");
  await p.waitForTimeout(250);
  R.pop = await p.evaluate(() => { const pop = document.getElementById("ctx-pop"), r = pop.getBoundingClientRect(); return { open: !pop.classList.contains("hidden"), keys: [...pop.querySelectorAll(".cp-k")].map((x) => x.textContent), foot: pop.querySelector(".cp-foot")?.textContent, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0, expanded: document.getElementById("st-ctx").getAttribute("aria-expanded") }; });
  expect("popover opens with the details", R.pop.open && R.pop.expanded === "true" && ["Used", "Left in window", "Reserved per request", "Compaction"].every((k) => R.pop.keys.includes(k)) && R.pop.keys.some((k) => /Room before compaction|Compaction point/.test(k)), R.pop);
  expect("popover says measured + fits the viewport", /^Measured on the last request/.test(R.pop.foot) && R.pop.inView, R.pop);
  // room before compaction must use Synaps's own basis: budget − estimate
  R.room = await p.evaluate(() => { const s = window.__ctx.state; const row = [...document.querySelectorAll("#ctx-pop .cp-row")].find((r) => /Room before compaction|Compaction point/.test(r.textContent)); return { text: row?.querySelector(".cp-v").textContent, budget: s.budget, estimate: s.estimate, measured: s.measured }; });
  const fmtK = (n) => (n >= 1e3 ? `${+(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n));
  expect("room before compaction = budget − daemon estimate (not − measured)", R.room.estimate <= R.room.budget ? R.room.text.startsWith(fmtK(R.room.budget - R.room.estimate)) : /passed by/.test(R.room.text), R.room);
  await p.keyboard.press("Escape");
  R.popEsc = await p.evaluate(() => document.getElementById("ctx-pop").classList.contains("hidden"));
  await p.click("#st-ctx"); await p.waitForTimeout(150);
  await p.mouse.click(700, 300);
  R.popOutside = await p.evaluate(() => document.getElementById("ctx-pop").classList.contains("hidden") && document.getElementById("st-ctx").getAttribute("aria-expanded") === "false");
  expect("popover closes on Esc and on an outside click", R.popEsc && R.popOutside, [R.popEsc, R.popOutside]);

  // ── injected: thresholds + formatting ──
  const inject = (inp, cr, cc) => p.evaluate(([inp, cr, cc]) => { onStream({ kind: "session", session: "usage", input_tokens: inp, output_tokens: 1, cache_read_input_tokens: cr, cache_creation_input_tokens: cc }); }, [inp, cr, cc]).then(meter);
  R.lo = await inject(40000, 50000, 9000);   // 99k  → 49.5%
  R.mid = await inject(40000, 50000, 10000); // 100k → 50%
  R.hi = await inject(100000, 40000, 10000); // 150k → 75%
  expect("thresholds: <50% lo · 50% mid · 75% hi (TUI)", R.lo.cls.includes("lo") && R.mid.cls.includes("mid") && R.hi.cls.includes("hi"), [R.lo.cls, R.mid.cls, R.hi.cls]);
  expect("formatting: 99k / 100k / 150k of 200k", R.lo.txt === "99k / 200k" && R.mid.txt === "100k / 200k" && R.hi.txt === "150k / 200k", [R.lo.txt, R.mid.txt, R.hi.txt]);
  R.small = await inject(1234, 0, 0);
  expect("formatting: 1.2k", R.small.txt === "1.2k / 200k", R.small.txt);
  R.over = await inject(250000, 0, 0);
  expect("over the window: bar caps at 100%", R.over.scale === 1 && R.over.cls.includes("hi"), R.over);

  // ── compaction → history changed → back to the estimate ──
  await p.evaluate(() => onEvent({ ev: "compaction_applied", msg_count: 4 }, new Date().toISOString()));
  await p.waitForTimeout(900);
  R.afterCompact = await meter();
  expect("compaction: measured dropped, estimate re-queried", R.afterCompact.state.measured === null && R.afterCompact.cls.includes("est") && R.afterCompact.state.estimate > 0, R.afterCompact.state);

  // ── layout ──
  for (const w of [1400, 760]) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.waitForTimeout(250);
    R[`layout${w}`] = await p.evaluate(() => {
      const els = ["st-ctx", "st-model", "st-tokens", "st-cost"].map((id) => document.getElementById(id).getBoundingClientRect()).filter((r) => r.width);
      const overlap = els.some((a, i) => els.some((b, j) => j > i && a.right > b.left + 0.5 && b.right > a.left + 0.5));
      const m = els[0];
      return { overlap, inView: m.left >= 0 && m.right <= innerWidth };
    });
    expect(`layout ${w}px: no overlap, in view`, !R[`layout${w}`].overlap && R[`layout${w}`].inView, R[`layout${w}`]);
  }
  await p.setViewportSize({ width: 1400, height: 900 });

  // ── reduced motion: the fill doesn't glide ──
  await p.evaluate(() => setPref("motion", "reduced"));
  R.reduced = await p.evaluate(() => getComputedStyle(document.querySelector("#st-ctx .ctx-fill")).transitionDuration);
  expect("reduced motion: no fill transition", /^(0s|0\.001s|1ms)/.test(R.reduced), R.reduced);
  await p.evaluate(() => setPref("motion", "system"));

  if (errs.length) fail.push(`page errors: ${errs.join(" | ")}`);
  console.log(JSON.stringify({ race: R.race ?? "not exercised (page wasn't input owner)", fresh: R.fresh.txt, turn: { txt: R.turn.txt, measured: R.turn.state.measured, expected: R.turn.expected, budget: R.turn.state.budget, shouldCompact: R.turn.state.shouldCompact }, direct: R.direct, pop: R.pop.keys, over: R.over.txt }, null, 1));
  console.log(fail.length ? `FAIL\n  ${fail.join("\n  ")}` : "PASS");
  await b.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
