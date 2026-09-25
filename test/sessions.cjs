// Past sessions in the rail, against the SANDBOX daemon (:7718, profile webproto):
//  - Live section = sessions in the daemon now; Recent = on-disk only
//  - /api/sessions leaks no message bodies / secrets
//  - clicking a Recent session resumes it (same id), its history loads, and it
//    moves from Recent into Live
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const HOME = process.env.HOME;
const fail = [];
const expect = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

(async () => {
  const url = fs.readFileSync(`${HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.waitForTimeout(800); // let /api/sessions land

  const R = {};
  // endpoint hygiene
  const api = await p.evaluate(async () => await (await fetch("/api/sessions?limit=60")).json());
  R.apiCount = api.sessions.length;
  R.apiKeys = [...new Set(api.sessions.flatMap((s) => Object.keys(s)))].sort();
  const apiText = JSON.stringify(api);
  R.noBodies = !/api_messages|system_prompt|"env"|"role"|sk-[A-Za-z0-9]{8}|"access"|"refresh"/.test(apiText);
  expect("no message bodies / secrets in /api/sessions", R.noBodies, true);

  // rail structure: Recent section shown, populated
  R.rail = await p.evaluate(() => ({
    liveLabelShown: [...document.querySelectorAll(".rail-label")].some((l) => l.textContent === "Live"),
    recentShown: !document.getElementById("past-wrap").classList.contains("hidden"),
    live: [...document.querySelectorAll("#sessions > li[data-id]")].map((li) => li.dataset.id),
    recent: [...document.querySelectorAll("#past-sessions > li[data-id]")].map((li) => li.dataset.id),
  }));
  if (!R.rail.recentShown || R.rail.recent.length === 0) fail.push("Recent section empty or hidden");
  // no id appears in both sections
  const dup = R.rail.live.filter((id) => R.rail.recent.includes(id));
  expect("no id in both Live and Recent", dup, []);

  // pick a Recent session with real history (message_count > 0)
  const target = api.sessions.find((s) => s.message_count > 0 && R.rail.recent.includes(s.id));
  if (!target) { fail.push("no recent session with history to resume"); throw new Error("no target"); }
  R.target = { id: target.id, title: target.title.slice(0, 40), msgs: target.message_count };

  // its row shows title + a Recent meta ("N msg" for disk-only, "idle" for a
  // detached session the daemon still holds) — never a client count.
  R.row = await p.evaluate((id) => { const li = document.querySelector(`#past-sessions > li[data-id="${id}"]`); return { title: li.querySelector(".s-title").textContent, meta: li.querySelector(".s-txt").textContent, restDot: li.querySelector(".s-dot").classList.contains("rest") }; }, target.id);
  if (!/\b(msg|idle)\b/.test(R.row.meta)) fail.push(`recent row meta unexpected: ${R.row.meta}`);

  // resume it
  await p.click(`#past-sessions > li[data-id="${target.id}"]`);
  await p.waitForFunction((id) => typeof S !== "undefined" && S.sid === id && !document.getElementById("input").disabled, target.id, { timeout: 20000 });
  await p.waitForTimeout(1000);
  R.afterResume = await p.evaluate((id) => ({
    sid: S.sid,
    threadMsgs: document.querySelectorAll("#thread .msg, #thread .turn, #thread [data-role]").length,
    threadHasText: document.getElementById("thread").textContent.trim().length,
    nowLive: [...document.querySelectorAll("#sessions > li[data-id]")].map((li) => li.dataset.id).includes(id),
    stillRecent: [...document.querySelectorAll("#past-sessions > li[data-id]")].map((li) => li.dataset.id).includes(id),
  }), target.id);
  expect("resumed session keeps its id", R.afterResume.sid, target.id);
  if (R.afterResume.threadHasText < 1) fail.push("resumed thread is empty (history didn't replay)");
  expect("resumed session moved into Live", R.afterResume.nowLive, true);
  expect("resumed session left Recent", R.afterResume.stillRecent, false);

  // ── deterministic sectioning: a 0-client session (detached but still in the
  // daemon, e.g. journal-less "live") belongs in Recent, not Live. Inject
  // synthetic daemon state and re-render — no dependency on real park timing.
  R.section = await p.evaluate(() => {
    const now = new Date().toISOString();
    const keepPast = S.past, keepSess = S.sessions;
    S.past = [];
    S.sessions = [
      { id: S.sid, name: null, title: "current", model: "anthropic/x", clients: 1, lifecycle: "live", created_at: now },
      { id: "ZZ-attached", name: null, title: "other attached", model: "anthropic/x", clients: 2, lifecycle: "live", created_at: now },
      { id: "ZZ-detached-live", name: null, title: "detached, no journal", model: "anthropic/x", clients: 0, lifecycle: "live", created_at: now },
      { id: "ZZ-parked", name: null, title: "parked", model: "anthropic/x", clients: 0, lifecycle: "parked", created_at: now },
    ];
    renderSessions();
    const ids = (sel) => [...document.querySelectorAll(sel + " > li[data-id]")].map((li) => li.dataset.id);
    const r = { live: ids("#sessions"), recent: ids("#past-sessions"), recentHidden: document.getElementById("past-wrap").classList.contains("hidden") };
    S.past = keepPast; S.sessions = keepSess; renderSessions(); // restore
    return r;
  });
  expect("attached (clients>0) session in Live", R.section.live.includes("ZZ-attached"), true);
  expect("detached live (0 clients) session in Recent", R.section.recent.includes("ZZ-detached-live"), true);
  expect("parked session in Recent", R.section.recent.includes("ZZ-parked"), true);
  expect("0-client session NOT in Live", R.section.live.includes("ZZ-detached-live") || R.section.live.includes("ZZ-parked"), false);
  expect("current session stays in Live", R.section.live.includes(R.afterResume.sid), true);

  await p.screenshot({ path: "/tmp/sd-sessions.png" });
  R.errs = errs;
  if (errs.length) fail.push(`page errors: ${errs.join(" | ")}`);
  console.log(JSON.stringify(R, null, 1));
  console.log(fail.length ? `FAIL\n  ${fail.join("\n  ")}` : "PASS");
  await b.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
