// Phase-1 redesign check: real turn through the dev build, DOM-level assertions.
//   node test/redesign.cjs [profile] [port]
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
(async () => {
  const profile = process.argv[2] || "webproto";
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-${profile}.url`, "utf8").trim();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(`console.error: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url().replace(/token=[0-9a-f]+/, "token=…")}`); });
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await page.click("#new-session");
  await page.waitForFunction(() => !document.getElementById("input").disabled, null, { timeout: 20000 });
  const pal = await page.evaluate(() => ({
    primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
    bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    fade: getComputedStyle(document.documentElement).getPropertyValue("--fade").trim(),
    swatch: document.querySelector("#swatches .lbl")?.textContent,
    font: getComputedStyle(document.body).fontFamily.split(",")[0],
    fontLoaded: document.fonts.check('14px "InterVariable"'),
  }));
  console.log("PALETTE", JSON.stringify(pal));
  await page.fill("#input", "Run `echo hello-dash && uname -s` with bash. Then reply with a short markdown table (2 columns: Thing, Value; 3 rows) and a tiny JavaScript code block that logs hi. Be brief.");
  await page.press("#input", "Enter");
  await page.waitForSelector(".msg.asst.live", { timeout: 20000 });
  const mid = await page.evaluate(() => ({ stopBtn: document.getElementById("send").classList.contains("stop"), think: !!document.querySelector(".think.active"), caret: !!document.querySelector(".caret") }));
  await page.waitForFunction(() => !document.querySelector(".msg.asst.live"), null, { timeout: 120000 });
  await page.waitForTimeout(400);
  const d = await page.evaluate(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const tool = document.querySelector(".tool");
    return {
      users: q(".msg.user"), assistants: q(".msg.asst"),
      thinkChip: document.querySelector(".think .lbl")?.textContent,
      tools: q(".tool"), toolOk: q(".tool.ok"), toolName: tool?.querySelector(".tool-name")?.textContent, toolSum: tool?.querySelector(".tool-sum")?.textContent, toolStatus: tool?.querySelector(".tool-st")?.textContent,
      tables: q(".md table"), tableRows: q(".md table tbody tr"), codeblocks: q(".codeblock"), copyBtns: q("[data-copy]"), highlighted: q(".codeblock .tok-k, .codeblock .tok-f, .codeblock .tok-s"),
      caretsLeft: q(".caret"), liveLeft: q(".msg.asst.live"),
      presence: [...document.querySelectorAll("#presence .av")].map((a) => a.className.replace("av", "").trim() + ":" + a.textContent),
      title: document.getElementById("sess-title").textContent, model: document.getElementById("model-chip").textContent,
      stat: [...document.querySelectorAll(".statline span")].map((s) => s.textContent).join(" | "),
      sendStop: document.getElementById("send").classList.contains("stop"), watchHidden: document.getElementById("watchbar").classList.contains("hidden"),
      rail: [...document.querySelectorAll("#sessions li")].length, railActive: !!document.querySelector("#sessions li.active"),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  console.log("MIDTURN", JSON.stringify(mid));
  console.log("RESULT", JSON.stringify(d, null, 1));
  await page.screenshot({ path: "/tmp/sd-phase1.png" });
  // copy button works
  await page.click("[data-copy]").catch(() => {});
  console.log("COPY", await page.evaluate(() => document.querySelector("[data-copy]")?.textContent));
  // mobile layout sanity
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  console.log("MOBILE", JSON.stringify(await page.evaluate(() => ({ railW: document.getElementById("rail").getBoundingClientRect().width, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, composerW: Math.round(document.getElementById("composer").getBoundingClientRect().width) }))));
  await page.screenshot({ path: "/tmp/sd-phase1-mobile.png" });
  if (errs.length) console.log("ERRORS\n" + errs.join("\n")); else console.log("ERRORS none");
  await browser.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
