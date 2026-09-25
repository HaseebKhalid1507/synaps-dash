// Headless DOM check of the web client (borrows SynapsDASH's playwright).
//   node test/headless.cjs [profile]
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
(async () => {
  const profile = process.argv[2] || "webproto";
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-${profile}.url`, "utf8").trim();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errs.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url().replace(/token=[0-9a-f]+/, "token=<redacted>")}`); });
  await page.goto(url);
  try { await page.waitForSelector(".sys.own", { timeout: 8000 }); } catch { errs.push("never attached (.sys.own missing)"); }
  await page.waitForTimeout(1500);
  const dump = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    conn: document.getElementById("conn-text").textContent,
    session: document.getElementById("sess-title").textContent,
    clients: [...document.querySelectorAll("#clients .chip")].map((c) => c.className.replace("chip", "").trim() + ":" + c.textContent),
    watch: document.getElementById("watch-bar").classList.contains("hidden") ? "(hidden — we own input)" : document.getElementById("watch-text").textContent,
    inputDisabled: document.getElementById("input").disabled,
    status: [...document.querySelectorAll("#status span")].map((s) => s.textContent).filter(Boolean).join(" | "),
    sessions: [...document.querySelectorAll("#sessions li")].map((l) => l.textContent.replace(/\s+/g, " ").trim()),
    transcript: [...document.querySelectorAll("#transcript > *")].map((b) => {
      const cls = b.className.replace("blk", "").trim();
      if (b.classList.contains("asst")) return "ASST: " + [...b.children].slice(1).map((c) => c.classList.contains("tool") ? `[tool ${c.querySelector(".tool-name").textContent}: ${c.querySelector(".tool-sum").textContent} ${c.querySelector(".tool-st").textContent}]` : c.classList.contains("thinking") ? `(thinking: ${c.textContent.slice(0, 60)}…)` : c.textContent.slice(0, 160)).join(" ");
      return `${cls.toUpperCase() || "?"}: ${b.textContent.replace(/\s+/g, " ").slice(0, 160)}`;
    }),
  }));
  await page.screenshot({ path: "/tmp/sw-headless.png" });
  console.log(JSON.stringify(dump, null, 2));
  if (errs.length) console.log("ERRORS:\n" + errs.join("\n"));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
