// Phase-1.1 checks: activity batching, steer delivery status, mid-turn ordering,
// attach-hint suppression, replay. Real turn on the sandbox daemon (:7718).
//   node test/batching.cjs
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  const oldHash = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, oldHash, { timeout: 20000 });
  await p.fill("#input", "Use bash for each of these as SEPARATE tool calls, one after another: `sleep 2 && pwd`, `sleep 2 && ls /tmp | head -3`, `sleep 2 && uname -s`, `sleep 2 && date +%Y`. After all four, reply with one short sentence.");
  await p.press("#input", "Enter");
  // steer once the first tool card exists
  await p.waitForSelector(".tool", { state: "attached", timeout: 60000 });
  await p.fill("#input", "Also mention the word PINEAPPLE in your final sentence.");
  await p.press("#input", "Enter");
  const afterSteer = await p.evaluate(() => document.querySelector(".msg.user.steer")?.dataset.steer);
  await p.waitForFunction(() => document.getElementById("send").classList.contains("stop"), null, { timeout: 20000 }).catch(() => {});
  await p.waitForFunction(() => !document.getElementById("send").classList.contains("stop") && !document.querySelector(".msg.asst.live"), null, { timeout: 240000 });
  await p.waitForTimeout(600);
  const snap = () => p.evaluate(() => {
    const kids = [...document.getElementById("thread").children];
    const order = kids.map((k) => k.classList.contains("steer") ? "STEER" : k.classList.contains("user") ? "USER" : k.classList.contains("asst") ? `ASST${k.classList.contains("cont") ? "(cont)" : ""}` : k.className.split(" ")[0].toUpperCase());
    const groups = [...document.querySelectorAll(".activity")].map((g) => ({ single: g.classList.contains("single"), open: g.open, items: g.querySelector(".act-body").children.length, label: g.querySelector(".act-lbl").textContent }));
    const steer = document.querySelector(".msg.user.steer");
    const steerIdx = kids.indexOf(steer);
    const textAfterSteer = kids.slice(steerIdx + 1).some((k) => k.querySelector?.(".md")?.textContent);
    const textBeforeSteerMentionsPineapple = kids.slice(0, steerIdx).some((k) => [...(k.querySelectorAll?.(".md") || [])].some((m) => /PINEAPPLE/i.test(m.textContent)));
    return {
      order, groups, steer: steer ? { state: steer.dataset.steer, meta: steer.querySelector(".meta").textContent } : null,
      textAfterSteer, pineappleAboveSteer: textBeforeSteerMentionsPineapple,
      pineappleInReply: [...document.querySelectorAll(".msg.asst .md")].some((m) => /PINEAPPLE/i.test(m.textContent)),
      attachHint: /attach with --takeover/.test(document.body.textContent),
      tools: document.querySelectorAll(".tool").length, toolsOk: document.querySelectorAll(".tool.ok").length, running: document.querySelectorAll(".tool .spinner").length,
    };
  });
  const live = await snap();
  console.log("STEER right after send:", afterSteer);
  console.log("LIVE", JSON.stringify(live, null, 1));
  // second observer tab joins mid-session → daemon broadcasts its CLI hint; must not render
  const p2 = await ctx.newPage();
  await p2.goto(url.replace(/\?token=.*/, "") + "#s=" + (await p.evaluate(() => location.hash.split("=")[1])));
  await p2.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p2.waitForTimeout(1500);
  console.log("HINT after 2nd tab joined (tab1):", await p.evaluate(() => /attach with --takeover/.test(document.body.textContent)));
  const rep = await p2.evaluate(() => ({ groups: [...document.querySelectorAll(".activity")].map((g) => ({ single: g.classList.contains("single"), items: g.querySelector(".act-body").children.length, label: g.querySelector(".act-lbl").textContent })), tools: document.querySelectorAll(".tool").length }));
  console.log("REPLAY (fresh tab)", JSON.stringify(rep));
  console.log("ERRORS", errs.length ? errs : "none");
  await b.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
