// Type to start, against the SANDBOX daemon (:7718, profile webproto):
//  - with no live session the page shows "No live sessions" and the message box is usable
//    before and while typing: enabled, its placeholder says Enter starts a new session, and
//    every letter stays (bug, 2026-10-05: the first keystroke ran renderComposer, which saw
//    "not the input owner" — there is no session to own — and disabled the box)
//  - Enter starts ONE new session (a double Enter does not make two) and sends the typed
//    text as its first turn: the box empties, the bubble shows it, you own the input
//  - the reply comes back (a real turn; SKIP_LIVE=1 skips that wait)
//  - a session that ends leaves the same usable box
// Needs a sandbox with NO live session: start it fresh (README › Development).
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const HOME = process.env.HOME;
const fail = [];
const expect = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const TEXT = "Reply with exactly the word pong and nothing else.";

(async () => {
  const url = fs.readFileSync(`${HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(url);
  await p.waitForFunction(() => S.sid || /No live sessions/.test(document.getElementById("thread").textContent), null, { timeout: 15000 });
  if (await p.evaluate(() => S.sid)) {
    console.log("FAIL\n  precondition: the sandbox has a live session; restart it so it has none (README › Development)");
    await b.close(); process.exit(1);
  }
  const box = () => p.evaluate(() => { const i = document.getElementById("input"); return { value: i.value, disabled: i.disabled, placeholder: i.placeholder }; });
  const R = {};

  // 1. the empty state's box is usable before any keystroke
  R.empty = await box();
  expect("empty: box enabled", R.empty.disabled, false);
  expect("empty: placeholder says Enter starts a session", /starts a new session/.test(R.empty.placeholder), true);

  // 2. every typed letter stays (the bug blocked input after one)
  await p.click("#input");
  await p.keyboard.type(TEXT, { delay: 10 });
  R.typed = await box();
  expect("typed text kept", R.typed.value, TEXT);
  expect("box still enabled after typing", R.typed.disabled, false);

  // 3. a double Enter starts ONE session and sends the text as its first turn
  const liveBefore = await p.evaluate(() => S.sessions.length);
  await p.keyboard.press("Enter");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => S.sid && S.me != null && S.owner === S.me, null, { timeout: 20000 });
  await p.waitForFunction((t) => [...document.querySelectorAll("#thread .msg.user .bubble")].some((m) => m.textContent.includes(t)), TEXT, { timeout: 10000 });
  await p.waitForTimeout(1500); // let the session list refresh after the attach
  R.started = await p.evaluate(() => ({
    sid: S.sid,
    live: S.sessions.length,
    userBubbles: document.querySelectorAll("#thread .msg.user").length,
    box: document.getElementById("input").value,
    placeholder: document.getElementById("input").placeholder,
    hash: location.hash,
  }));
  expect("exactly one new session", R.started.live - liveBefore, 1);
  expect("the text sent once", R.started.userBubbles, 1);
  expect("box empty after sending", R.started.box, "");
  expect("placeholder back to the session one", /starts a new session/.test(R.started.placeholder), false);
  expect("URL names the new session", R.started.hash, `#s=${R.started.sid}`);

  // 4. the reply comes back (real turn)
  if (!process.env.SKIP_LIVE) {
    await p.waitForFunction(() => !S.streaming && document.querySelector("#thread .msg.asst"), null, { timeout: 180000 });
    R.reply = await p.evaluate(() => [...document.querySelectorAll("#thread .msg.asst")].pop()?.textContent.trim().slice(-80));
    expect("reply says pong", /pong/i.test(R.reply || ""), true);
  }

  // 5. a session that ends leaves the same usable box (the other way to "no session")
  R.ended = await p.evaluate(() => {
    onEvent({ ev: "ended" }); // the daemon's "ended" event, as onFrame delivers it
    const i = document.getElementById("input");
    i.value = "x"; i.dispatchEvent(new Event("input"));
    return { sid: S.sid, disabled: i.disabled, placeholder: i.placeholder };
  });
  expect("after end: no session", R.ended.sid, null);
  expect("after end: box still enabled after typing", R.ended.disabled, false);
  expect("after end: placeholder says Enter starts a session", /starts a new session/.test(R.ended.placeholder), true);

  await p.screenshot({ path: "/tmp/sd-empty-start.png" });
  R.errs = errs;
  if (errs.length) fail.push(`page errors: ${errs.join(" | ")}`);
  console.log(JSON.stringify(R, null, 1));
  console.log(fail.length ? `FAIL\n  ${fail.join("\n  ")}` : "PASS");
  await b.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message.split("\n")[0]); if (fail.length) console.log(`FAIL (before the fatal step)\n  ${fail.join("\n  ")}`); process.exit(2); });
