// Live multi-client check: attach (mirror), wait for a PEER turn to start and
// finish, then dump. Optional 2nd phase: take over + submit from the web.
//   node test/live.cjs [profile] [--takeover "prompt"]
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const dumpFn = () => ({
  clients: [...document.querySelectorAll("#clients .chip")].map((c) => c.className.replace("chip", "").trim() + ":" + c.textContent),
  watch: document.getElementById("watch-bar").classList.contains("hidden") ? "(hidden — we own input)" : document.getElementById("watch-text").textContent,
  inputDisabled: document.getElementById("input").disabled,
  state: document.getElementById("st-state").textContent,
  transcript: [...document.querySelectorAll("#transcript > *")].map((b) => {
    if (b.classList.contains("asst")) return "ASST: " + [...b.children].slice(1).map((c) => c.classList.contains("tool") ? `[tool ${c.querySelector(".tool-name").textContent}: ${c.querySelector(".tool-sum").textContent} ${c.querySelector(".tool-st").textContent}]` : c.classList.contains("thinking") ? `(thinking…)` : c.classList.contains("dots") ? "●●●" : c.textContent.replace(/\s+/g, " ").slice(0, 150)).join(" ");
    return `${b.className.replace("blk", "").trim().toUpperCase()}: ${b.textContent.replace(/\s+/g, " ").slice(0, 150)}`;
  }),
});
(async () => {
  const profile = process.argv[2] || "webproto";
  const ti = process.argv.indexOf("--takeover");
  const takeoverPrompt = ti > 0 ? process.argv[ti + 1] : null;
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-web-${profile}.url`, "utf8").trim();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(`console.error: ${m.text()}`); });
  await page.goto(url);
  await page.waitForSelector(".sys.own", { timeout: 10000 });
  await page.waitForTimeout(800);
  console.log("== ON ATTACH ==\n" + JSON.stringify(await page.evaluate(dumpFn), null, 1));
  fs.writeFileSync("/tmp/sw-live.ready", "1");
  if (!takeoverPrompt) {
    // wait for a peer turn: streaming then idle
    await page.waitForFunction(() => document.getElementById("st-state").textContent.includes("streaming"), null, { timeout: 60000 });
    const mid = await page.evaluate(dumpFn);
    console.log("== MID-TURN (last 2 blocks) ==\n" + JSON.stringify({ state: mid.state, tail: mid.transcript.slice(-2) }, null, 1));
    await page.waitForFunction(() => document.getElementById("st-state").textContent === "idle", null, { timeout: 90000 });
    await page.waitForTimeout(500);
    console.log("== AFTER PEER TURN ==\n" + JSON.stringify(await page.evaluate(dumpFn), null, 1));
  } else {
    await page.click("#takeover");
    await page.waitForFunction(() => document.getElementById("watch-bar").classList.contains("hidden"), null, { timeout: 10000 });
    await page.waitForTimeout(500);
    console.log("== AFTER TAKEOVER ==\n" + JSON.stringify(await page.evaluate(dumpFn), null, 1));
    await page.fill("#input", takeoverPrompt);
    await page.press("#input", "Enter");
    await page.waitForFunction(() => document.getElementById("st-state").textContent.includes("streaming"), null, { timeout: 30000 });
    await page.waitForFunction(() => document.getElementById("st-state").textContent === "idle", null, { timeout: 90000 });
    await page.waitForTimeout(500);
    const d = await page.evaluate(dumpFn);
    console.log("== AFTER WEB TURN (last 3) ==\n" + JSON.stringify({ ...d, transcript: d.transcript.slice(-3) }, null, 1));
  }
  if (errs.length) console.log("ERRORS:\n" + errs.join("\n"));
  await browser.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
