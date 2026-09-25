// Proves the "on reload" badge is honest, against the real sandbox daemon:
//   1. write thinking=high via /api/config
//   2. a NEW session created before reload still starts on the old default
//   3. `daemon reload` → the page's token rotates, pending clears, and a new
//      session starts on thinking=high
// Restores the sandbox config afterwards (and reloads again so the daemon matches).
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const { execFileSync } = require("child_process");
const HOME = process.env.HOME;
const CFG = `${HOME}/.synaps-cli/webproto/config`;
const URLF = `${HOME}/.synaps-cli/run/synaps-dash-webproto.url`;
const reload = () => execFileSync(`${HOME}/.local/bin/synaps-dev`, ["daemon", "--profile", "webproto", "reload"], { cwd: "/tmp/synaps-web-sandbox", encoding: "utf8", timeout: 60000 }).trim();
const fail = [];

async function newSessionThinking(b, url) {
  const p = await (await b.newContext()).newPage();
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.waitForFunction(() => S.sid || /No live sessions/.test(document.getElementById("thread").textContent), null, { timeout: 15000 }); // let the page's own auto-attach settle first
  const h0 = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, h0, { timeout: 20000 });
  await p.waitForTimeout(500);
  const t = await p.evaluate(() => S.view?.thinking_level);
  await p.context().close();
  return t;
}
const waitNewUrl = async (old) => { for (let i = 0; i < 60; i++) { try { const u = fs.readFileSync(URLF, "utf8").trim(); if (u !== old) return u; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error("url file never rotated"); };

(async () => {
  const pristine = fs.readFileSync(CFG, "utf8");
  const R = {};
  const b = await chromium.launch();
  try {
    let url = fs.readFileSync(URLF, "utf8").trim();
    R.before = await newSessionThinking(b, url);
    const target = R.before === "high" ? "medium" : "high";
    const p = await (await b.newContext()).newPage();
    await p.goto(url);
    R.write = await p.evaluate(async (v) => (await (await fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "thinking", value: v }) })).json()).pending, target);
    R.beforeReload = await newSessionThinking(b, url);
    if (R.beforeReload !== R.before) fail.push(`config applied WITHOUT reload (${R.beforeReload}) — the badge would be lying`);
    R.reload = reload();
    url = await waitNewUrl(url);
    R.oldTokenAfterReload = await p.evaluate(async () => (await fetch("/api/config")).status);
    if (R.oldTokenAfterReload !== 401) fail.push(`old token still works after reload (${R.oldTokenAfterReload})`);
    R.afterReload = await newSessionThinking(b, url);
    if (R.afterReload !== target) fail.push(`after reload new session thinking=${R.afterReload}, want ${target}`);
    const p2 = await (await b.newContext()).newPage();
    await p2.goto(url);
    R.pendingAfterReload = await p2.evaluate(async () => (await (await fetch("/api/config")).json()).pending);
    if (R.pendingAfterReload.length) fail.push(`pending not cleared by reload: ${R.pendingAfterReload}`);
  } finally {
    fs.writeFileSync(CFG, pristine, { mode: 0o600 });
    await b.close();
    try { reload(); await waitNewUrl(""); } catch {}
  }
  console.log(JSON.stringify(R, null, 1));
  console.log(fail.length ? `FAIL\n  ${fail.join("\n  ")}` : "PASS");
  process.exitCode = fail.length ? 1 : 0;
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
