// Steer position semantics: queued = pinned at the bottom (later output flows in
// ABOVE it); delivered = lands where the model received it. Real turn, sandbox.
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  const oldHash = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, oldHash, { timeout: 20000 });
  await p.fill("#input", "First write a 200-word paragraph about ocean currents. Then run `sleep 3 && echo tide` with bash. Then reply with one short closing sentence.");
  await p.press("#input", "Enter");
  await p.waitForFunction(() => (document.querySelector(".msg.asst .md")?.textContent || "").length > 20, null, { timeout: 60000 });
  await p.fill("#input", "In your closing sentence, include the word KIWI.");
  await p.press("#input", "Enter");
  const lab = () => p.evaluate(() => [...document.getElementById("thread").children].flatMap((k) => k.id === "steer-tray" ? (k.children.length ? ["TRAY[" + [...k.children].map((c) => c.dataset.steer).join(",") + "]"] : []) : [k]).map((k) => typeof k === "string" ? k : k.classList.contains("steer") ? `STEER[${k.dataset.steer}]` : k.classList.contains("user") ? "USER" : k.classList.contains("asst") ? `ASST${k.classList.contains("cont") ? "(cont)" : ""}${k.querySelector(".tool") ? "+tool" : ""}` : k.id || k.className.split(" ")[0]));
  await p.waitForTimeout(300);
  const typed = await lab();
  // while queued the steer must stay pinned LAST, with new output above it
  await p.waitForFunction(() => { const st = document.querySelector(".msg.user.steer"); return st && st.dataset.steer !== "delivered" && document.querySelector(".tool"); }, null, { timeout: 60000 }).catch(() => {});
  const beforeDelivery = await lab();
  await p.waitForFunction(() => document.querySelector(".msg.user.steer")?.dataset.steer === "delivered", null, { timeout: 90000 });
  const atDelivery = await lab();
  await p.waitForFunction(() => !document.getElementById("send").classList.contains("stop") && !document.querySelector(".msg.asst.live"), null, { timeout: 120000 });
  await p.waitForTimeout(400);
  const fin = await p.evaluate(() => {
    const kids = [...document.getElementById("thread").children]; const st = document.querySelector(".msg.user.steer"); const i = kids.indexOf(st);
    const txt = (arr) => arr.map((k) => [...(k.querySelectorAll?.(".md") || [])].map((m) => m.textContent).join(" ")).join(" ");
    return { meta: st.querySelector(".meta").textContent, toolAboveSteer: kids.slice(0, i).some((k) => k.querySelector?.(".tool")), kiwiBelow: /KIWI/i.test(txt(kids.slice(i + 1))), kiwiAbove: /KIWI/i.test(txt(kids.slice(0, i))) };
  });
  console.log("JUST TYPED      ", typed.join(" → "));
  console.log("BEFORE DELIVERY ", beforeDelivery.join(" → "));
  console.log("AT DELIVERY     ", atDelivery.join(" → "));
  console.log("FINAL           ", (await lab()).join(" → "));
  console.log("CHECK", JSON.stringify(fin));
  console.log("PINNED WHILE QUEUED:", /TRAY\[(queued|waiting)\]$/.test(beforeDelivery.join(" → ")) && /TRAY\[(queued|waiting)\]$/.test(typed.join(" → ")));
  console.log("ERRORS", errs.length ? errs : "none");
  await b.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
