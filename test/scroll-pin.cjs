// Scroll pinning by intent: glued while streaming; a deliberate wheel-up / PageUp
// unpins and STAYS unpinned as content streams; scrolling back to the bottom or
// the jump pill re-pins. Real streaming turn on the sandbox (:7718).
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1200, height: 700 } })).newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.waitForFunction(() => S.sid || /No live sessions/.test(document.getElementById("thread").textContent), null, { timeout: 15000 }); // let the page's own auto-attach settle first
  const oldHash = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, oldHash, { timeout: 20000 });
  await p.fill("#input", "Write a 700-word short story about a lighthouse keeper, in plain paragraphs. No tools.");
  await p.press("#input", "Enter");
  const st = () => p.evaluate(() => { const sc = document.getElementById("scroller"); return { gap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight), top: Math.round(sc.scrollTop), h: sc.scrollHeight, pill: document.getElementById("jump").classList.contains("show"), streaming: document.getElementById("send").classList.contains("stop") }; });
  // 1) glued while streaming
  await p.waitForFunction(() => document.getElementById("scroller").scrollHeight > document.getElementById("scroller").clientHeight + 400, null, { timeout: 90000 });
  const glued = [];
  for (let i = 0; i < 5; i++) { await p.waitForTimeout(400); glued.push((await st()).gap); }
  // 2) deliberate wheel up → unpinned, stays put while content grows
  const box = await (await p.$("#scroller")).boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.wheel(0, -500);
  await p.waitForTimeout(300);
  const afterUp = await st();
  await p.waitForTimeout(2500);
  const stillUp = await st();
  // 3) wheel back down to the very bottom → re-pinned, follows again
  for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, 900); await p.waitForTimeout(80); }
  await p.waitForTimeout(300);
  const repinned = []; for (let i = 0; i < 4; i++) { await p.waitForTimeout(400); repinned.push((await st()).gap); }
  // 4) PageUp (focus outside the input) unpins; the pill re-pins
  await p.click("#top");
  await p.keyboard.press("PageUp");
  await p.waitForTimeout(400);
  const afterPgUp = await st();
  let pillRepin = "turn ended before check";
  if ((await st()).streaming) {
    await p.waitForTimeout(800);
    const s1 = await st();
    if (s1.pill) { await p.click("#jump"); await p.waitForTimeout(900); const s2 = await st(); pillRepin = { pillShown: true, gapAfterClick: s2.gap }; }
    else pillRepin = { pillShown: false, gap: s1.gap };
  }
  const res = {
    gluedWhileStreaming: glued, gluedOK: glued.every((g) => g <= 2),
    wheelUp: { gap: afterUp.gap, pill: afterUp.pill }, stayedUpWhileGrowing: { topBefore: afterUp.top, topAfter: stillUp.top, grewBy: stillUp.h - afterUp.h, heldPosition: Math.abs(stillUp.top - afterUp.top) <= 2 },
    repinnedGaps: repinned, repinnedOK: repinned.every((g) => g <= 2),
    pageUp: { gap: afterPgUp.gap, unpinned: afterPgUp.gap > 2 }, pillRepin,
  };
  console.log(JSON.stringify(res, null, 1)); console.log("ERRORS", errs.length ? errs : "none");
  await b.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
