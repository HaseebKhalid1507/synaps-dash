// Synaps-config sections of the settings panel, end to end against the SANDBOX
// daemon (:7718, profile webproto). Every write is verified on disk in
// ~/.synaps-cli/webproto/config — never the live config (its hash is checked).
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const crypto = require("crypto");
const HOME = process.env.HOME;
const CFG = `${HOME}/.synaps-cli/webproto/config`;
const LIVE = `${HOME}/.synaps-cli/config`;
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const val = (k) => {
  let v = null;
  for (const line of fs.readFileSync(CFG, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    if (t.slice(0, i).trim() === k) v = t.slice(i + 1).trim();
  }
  return v;
};
const fail = [];
const expect = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); return ok; };

(async () => {
  const liveBefore = sha(LIVE);
  const pristine = fs.readFileSync(CFG, "utf8"); // restored in finally — the test is repeatable
  try { await run(liveBefore); } finally { fs.writeFileSync(CFG, pristine, { mode: 0o600 }); }
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });

async function run(liveBefore) {
  const url = fs.readFileSync(`${HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.keyboard.press("Control+,");
  await p.waitForSelector("#settings:not(.hidden) .set-tab.on");

  const R = {};
  R.nav = await p.evaluate(() => [...document.querySelectorAll(".set-tabs > *:not(.set-ind)")].map((x) => (x.classList.contains("set-grp") ? `[${x.textContent}]` : x.textContent)));
  // every tab fits in the nav without scrolling
  R.navFits = await p.evaluate(() => { const t = document.querySelector(".set-tabs"); const n = document.querySelector(".set-nav"); const last = [...t.querySelectorAll(".set-tab")].pop().getBoundingClientRect(); return last.bottom <= n.getBoundingClientRect().bottom - 30; });
  const tab = async (name) => { await p.click(`.set-tab >> text=${name}`); await p.waitForTimeout(350); };
  const writes = () => p.evaluate(() => window.__cfgWrites.length);
  const waitWrite = async (n0) => { await p.waitForFunction((n) => window.__cfgWrites.length > n, n0, { timeout: 8000 }); await p.waitForTimeout(250); return p.evaluate(() => window.__cfgWrites[window.__cfgWrites.length - 1]); };
  const rowSel = (label) => p.locator(".set-row", { has: p.locator(".set-name", { hasText: new RegExp(`^${label}`) }) }).first();

  // ── Defaults: thinking segmented → disk, pending banner + pill
  await tab("Defaults");
  R.path = await p.textContent(".set-path");
  let n0 = await writes();
  await rowSel("Thinking").locator(".seg-opt", { hasText: /^medium$/ }).click();
  R.thinkWrite = await waitWrite(n0);
  expect("thinking on disk", val("thinking"), "medium");
  R.pendingAfterThinking = await p.evaluate(() => ({ shown: !document.getElementById("set-pending").classList.contains("hidden"), text: document.querySelector(".set-pend-k")?.textContent, cmd: document.querySelector(".set-code")?.textContent, pill: [...document.querySelectorAll(".set-row")].find((r) => r.querySelector(".set-name").textContent.startsWith("Thinking"))?.querySelector(".set-pill")?.textContent }));
  // context window → Auto removes the key (it was unset or set)
  n0 = await writes();
  await rowSel("Context window").locator(".seg-opt", { hasText: /^1M$/ }).click();
  await waitWrite(n0);
  expect("context_window 1m", val("context_window"), "1m");
  n0 = await writes();
  await rowSel("Context window").locator(".seg-opt", { hasText: /^Auto$/ }).click();
  await waitWrite(n0);
  expect("context_window auto → removed", val("context_window"), null);
  // favorites: add two, remove one
  n0 = await writes();
  await p.fill(".fav-add", "anthropic/claude-opus-4-6"); await p.press(".fav-add", "Enter");
  await waitWrite(n0);
  n0 = await writes();
  await p.fill(".fav-add", "openai-codex/gpt-6-astra"); await p.press(".fav-add", "Enter");
  await waitWrite(n0);
  expect("favorites added", val("favorite_models"), "anthropic/claude-opus-4-6, openai-codex/gpt-6-astra");
  n0 = await writes();
  await p.locator(".fav", { hasText: "gpt-6-astra" }).locator(".fav-x").click();
  await waitWrite(n0);
  expect("favorite removed", val("favorite_models"), "anthropic/claude-opus-4-6");
  R.favChips = await p.evaluate(() => [...document.querySelectorAll(".fav-name")].map((x) => x.textContent));
  // invalid favorite never reaches the server
  n0 = await writes();
  await p.fill(".fav-add", "not a model"); await p.press(".fav-add", "Enter"); await p.waitForTimeout(300);
  expect("bad favorite not sent", await writes(), n0);

  // ── Agent: stepper, toggle, reset
  await tab("Agent");
  n0 = await writes();
  const bashBefore = Number(await rowSel("Bash timeout").locator(".stp-v").inputValue());
  await rowSel("Bash timeout").locator(".stp-b", { hasText: "+" }).click();
  await waitWrite(n0);
  expect("bash_timeout +5 on disk", val("bash_timeout"), String(bashBefore + 5));
  n0 = await writes();
  await rowSel("Progressive tool disclosure").locator(".tog").click();
  await waitWrite(n0);
  R.ptd = val("progressive_tool_disclosure");
  n0 = await writes();
  await rowSel("Progressive tool disclosure").locator(".tog").click();
  await waitWrite(n0);
  expect("ptd toggled back", val("progressive_tool_disclosure"), R.ptd === "true" ? "false" : "true");
  // reset: bash_timeout is set now → reset button removes it, stepper shows the default (30)
  await rowSel("Bash timeout").hover();
  n0 = await writes();
  await rowSel("Bash timeout").locator(".set-reset").click();
  await waitWrite(n0);
  expect("bash_timeout reset → removed", val("bash_timeout"), null);
  expect("stepper shows default", await rowSel("Bash timeout").locator(".stp-v").inputValue(), "30");
  R.activationOpts = await rowSel("Tool activation").locator(".seg-opt").allTextContents();

  // ── Daemon: idle-exit note + a live-class pill
  await tab("Daemon");
  R.daemonPills = await p.evaluate(() => [...document.querySelectorAll(".set-row")].map((r) => `${r.querySelector(".set-name").firstChild.textContent}: ${r.querySelector(".set-pill")?.textContent}`));

  // ── Plugins: self locked, toggling another writes disabled_plugins (and back)
  await tab("Plugins");
  R.plugins = await p.evaluate(() => [...document.querySelectorAll(".set-row[data-plugin]")].map((r) => ({ name: r.dataset.plugin, on: r.querySelector(".tog").classList.contains("on"), locked: r.querySelector(".tog").disabled })));
  const before = val("disabled_plugins");
  n0 = await writes();
  await p.locator('.set-row[data-plugin="chronos"] .tog').click();
  await waitWrite(n0);
  R.afterEnableChronos = val("disabled_plugins");
  n0 = await writes();
  await p.locator('.set-row[data-plugin="chronos"] .tog').click();
  await waitWrite(n0);
  R.afterDisableChronos = val("disabled_plugins");
  expect("chronos off again → same set", R.afterDisableChronos.split(", ").sort(), before.split(", ").sort());
  // a forged self-disable is refused server-side
  R.selfDisable = await p.evaluate(async () => (await (await fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "disabled_plugins", value: "synaps-dash" }) })).json()));

  // ── Providers: status only — no secret-shaped strings anywhere in the DOM or the API
  await tab("Providers");
  R.providers = await p.evaluate(() => [...document.querySelectorAll(".set-kv.prov")].map((r) => r.textContent));
  const apiText = await p.evaluate(async () => JSON.stringify(await (await fetch("/api/config")).json()));
  const dom = await p.evaluate(() => document.body.innerHTML);
  R.secretShaped = [apiText, dom].some((t) => /sk-[A-Za-z0-9]{8}|gsk_|nvapi-|"access"|"refresh"|eyJ[A-Za-z0-9]{10}/.test(t));
  expect("no secrets", R.secretShaped, false);

  // ── a failed write snaps the control back and shows the error
  await tab("Agent");
  await p.route("**/api/config", (route) => (route.request().method() === "POST" ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "the config file is locked by another writer — try again" }) }) : route.continue()));
  const retriesBefore = await rowSel("API retries").locator(".stp-v").inputValue();
  n0 = await writes();
  await rowSel("API retries").locator(".stp-b", { hasText: "+" }).click();
  await waitWrite(n0);
  R.failure = { value: await rowSel("API retries").locator(".stp-v").inputValue(), before: retriesBefore, err: await rowSel("API retries").locator(".set-err").textContent().catch(() => null), st: await rowSel("API retries").locator(".set-st").getAttribute("class") };
  expect("failed write snaps back", R.failure.value, retriesBefore);
  await p.unroute("**/api/config");

  // ── geometry: nothing in any config section overflows the sheet horizontally
  R.overflow = {};
  for (const t of ["Defaults", "Agent", "Context & memory", "Daemon", "Plugins", "Providers"]) {
    await tab(t);
    R.overflow[t] = await p.evaluate(() => { const b = document.getElementById("set-body"); return b.scrollWidth > b.clientWidth + 1; });
    if (R.overflow[t]) fail.push(`${t} overflows horizontally`);
  }
  await p.screenshot({ path: "/tmp/sd-config.png" });

  expect("live config untouched", sha(LIVE), liveBefore);
  // The forged self-disable (400) and the mocked lock conflict (409) are
  // deliberate; Chrome logs any non-2xx fetch as a console error.
  R.errs = errs.filter((e) => !/status of (400|409)/.test(e));
  if (errs.length - R.errs.length !== 2) fail.push(`expected exactly 2 deliberate 4xx logs, saw ${errs.length - R.errs.length}`);
  if (R.errs.length) fail.push(`page errors: ${R.errs.join(" | ")}`);
  console.log(JSON.stringify(R, null, 1));
  console.log(fail.length ? `FAIL\n  ${fail.join("\n  ")}` : "PASS");
  await b.close();
  process.exitCode = fail.length ? 1 : 0;
}
