// Subagents, on the SANDBOX (:7718): the tray above the composer (the TUI's
// subagent HUD), the header's "N agents (M done)", the Subagent section on
// subagent cards, and the status / collect / steer / models views.
// Part A — deterministic: real-shaped daemon events (shapes captured from a real
//   run on SynapsCLI 0.10) through the page's own onEvent/onStream.
// Part B — a real turn: a blocking subagent, then a background one that outlives
//   the turn (idle polling + the external completion event). SKIP_LIVE=1 skips it.
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const fail = [];
const expect = (name, ok, detail) => { if (!ok) fail.push(`${name}${detail !== undefined ? `: ${JSON.stringify(detail).slice(0, 500)}` : ""}`); };

(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "warning" && /tool view/.test(m.text())) errs.push(m.text()); });
  const queries = [];
  p.on("websocket", (ws) => ws.on("framesent", (f) => { try { const m = JSON.parse(f.payload); if (m.cmd?.cmd === "query" && m.cmd.query?.query === "subagent_rows") queries.push(Date.now()); } catch {} }));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.waitForFunction(() => S.sid || /No live sessions/.test(document.getElementById("thread").textContent), null, { timeout: 15000 });
  const h0 = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, h0, { timeout: 20000 });
  await p.waitForTimeout(300);

  // ── Part A ──
  const ev = (e) => p.evaluate((e) => onEvent(e, new Date().toISOString()), e);
  const st = (s) => ev({ ev: "stream", event: s });
  const agent = (a) => st({ kind: "agent", ...a });
  const tool = async (id, name, input, result) => {
    await st({ kind: "llm", llm: "tool_use_start", tool_id: id, tool_name: name });
    await st({ kind: "llm", llm: "tool_use", tool_id: id, tool_name: name, input });
    if (result !== undefined) await st({ kind: "llm", llm: "tool_result", tool_id: id, result });
  };
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const snap = () => p.evaluate(() => {
    const box = document.getElementById("agents");
    const rows = [...box.querySelectorAll(".ag")].map((a) => ({
      state: a.dataset.state, name: a.querySelector(".ag-name").textContent, id: a.querySelector(".ag-id").textContent,
      step: a.querySelector(".ag-step").textContent, think: a.querySelector(".ag-step").classList.contains("think"),
      tools: a.querySelector(".ag-tools").textContent, time: a.querySelector(".ag-time").textContent,
      spinner: !!a.querySelector(".ag-glyph .spinner"),
    }));
    const cards = [...document.querySelectorAll("#thread .tool")].map((c) => ({
      name: c.querySelector(".tool-name").textContent, sum: c.querySelector(".tool-sum").textContent, st: c.querySelector(".tool-st").textContent,
      cls: c.className, agent: c.querySelector(".tool-sec.agent")?.textContent ?? null, agentSteps: c.querySelectorAll(".tool-sec.agent .ag-trail li").length,
      outHidden: c.querySelector(".tool-sec.out").classList.contains("hidden"), out: c.querySelector(".tool-sec.out .out-view").textContent,
      pill: c.querySelector(".ag-pill")?.textContent ?? null, fg: c.querySelector(".kchip.fg")?.textContent ?? null, chips: c.querySelectorAll(".tool-sec.out .kchip").length,
    }));
    return {
      hidden: box.classList.contains("hidden"), rows, cards,
      run: document.getElementById("run-state").textContent, runState: document.getElementById("run-state").dataset.state,
      sys: [...document.querySelectorAll("#thread .sys")].map((x) => x.textContent),
      groups: [...document.querySelectorAll("#thread .activity:not(.single) .act-lbl")].map((x) => x.textContent),
      agentsH: T.style.getPropertyValue("--agents-h"),
    };
  });
  const card = (s, name, i = -1) => s.cards.filter((c) => c.name === name).at(i);

  // A1 background start: a failed start, then a real one; the agent event lands before the ack
  const TASK = "Run `sleep 20; echo hello-from-sub` with bash, then run `ls /tmp | head -3`, and report both outputs.";
  await ev({ ev: "turn_started", turn_baseline: 1, trigger: "plugin_command", user_text: null });
  await tool("tA", "subagent_start", { role: "implementer", task: TASK }, "Tool execution failed: Must provide either 'agent' (name) or 'system_prompt' (inline). Got neither.");
  await tool("tB", "subagent_start", { role: "implementer", system_prompt: "You run shell commands.", task: TASK, timeout: 120 });
  await agent({ agent: "subagent_start", subagent_id: 1, agent_name: "inline", task_preview: Array.from(TASK).slice(0, 80).join("") });
  await st({ kind: "llm", llm: "tool_result", tool_id: "tB", result: JSON.stringify({ agent_name: "inline", handle_id: "sa_1", status: "running" }) });
  await frame();
  let s = await snap();
  expect("A1 tray: one running row, role label, handle", !s.hidden && s.rows.length === 1 && s.rows[0].state === "running" && s.rows[0].name === "implementer" && s.rows[0].id === "sa_1" && s.rows[0].spinner, s.rows);
  expect("A1 run state: 1 agent (0 done)", s.runState === "agents" && /1 agent \(0 done\)/.test(s.run), s.run);
  expect("A1 only the successful start card is linked", card(s, "subagent_start", 0).agent === null && /Subagent/.test(card(s, "subagent_start", 1).agent || ""), s.cards.map((c) => c.agent));
  expect("A1 ack JSON folded into the agent section", card(s, "subagent_start", 1).outHidden === true, card(s, "subagent_start", 1));
  expect("A1 start card status is the agent's (spinner, not a ✓)", /ag-/.test(await p.evaluate(() => [...document.querySelectorAll("#thread .tool")][1].querySelector(".tool-st").innerHTML)) && !/ag-bad/.test(card(s, "subagent_start", 1).cls), card(s, "subagent_start", 1));
  expect("A1 group: 2 subagents, not more", s.groups.includes("2 subagents"), s.groups);

  // A2 live steps
  await agent({ agent: "subagent_update", subagent_id: 1, agent_name: "inline", status: "💭 thinking..." });
  await frame(); s = await snap();
  expect("A2 thinking step", s.rows[0].step === "thinking…" && s.rows[0].think, s.rows[0]);
  await agent({ agent: "subagent_update", subagent_id: 1, agent_name: "inline", status: "⚙ bash (tool #1)" });
  await agent({ agent: "subagent_update", subagent_id: 1, agent_name: "inline", status: "$ sleep 20; echo hello-from-sub" });
  await agent({ agent: "subagent_update", subagent_id: 1, agent_name: "inline", status: "$ sleep 20; echo hello-from-sub" });
  await agent({ agent: "subagent_update", subagent_id: 1, agent_name: "inline", status: "⚙ bash (tool #2)" });
  await agent({ agent: "subagent_update", subagent_id: 1, agent_name: "inline", status: "$ ls /tmp | head -3 <img src=x onerror=window.__pwn=1>" });
  await frame(); s = await snap();
  expect("A2 current step + tool count", /^\$ ls \/tmp/.test(s.rows[0].step) && s.rows[0].tools === "2 tools" && !s.rows[0].think, s.rows[0]);
  expect("A2 steps trail on the card (deduped)", card(s, "subagent_start", 1).agentSteps === 2, card(s, "subagent_start", 1));

  // A3 status → a status card, not JSON; summary names the agent
  const AUTH = { catalog_digest: "d60d", correlation_id: "sa_1", network_attempted: false, selection_source: "foreground_inheritance" };
  await tool("tC", "subagent_status", { handle_id: "sa_1" }, JSON.stringify({ agent_name: "inline", authorization: AUTH, elapsed_secs: 6.2, handle_id: "sa_1", model: "anthropic/claude-opus-4-6", output_length: 75, partial_output: "I'll run **both** commands.", status: "running", terminal_cause: null, tool_count: 3 }));
  await frame(); s = await snap();
  let c = card(s, "subagent_status");
  expect("A3 status summary + pill + chips, digests tucked away", c.sum === "implementer · sa_1" && c.pill === "running" && c.chips >= 3 && /so far/.test(c.out) && !/catalog_digest/.test(c.out.replace(/details[\s\S]*/, "")), c);
  expect("A3 tool_count feeds the tray", s.rows[0].tools === "3 tools", s.rows[0]);
  // A4 steer
  await tool("tD", "subagent_steer", { handle_id: "sa_1", message: "also say the word banana" }, JSON.stringify({ acknowledged: true }));
  await frame(); s = await snap();
  c = card(s, "subagent_steer");
  expect("A4 steer card", /implementer · sa_1\s+← also say the word banana/.test(c.sum) && /delivered/.test(c.out), c);
  expect("A4 steer lands in the steps", card(s, "subagent_start", 1).agentSteps === 3, card(s, "subagent_start", 1));
  expect("A4 groups: check + steer are not subagents", s.groups.includes("2 subagents · 1 agent check · 1 agent steer"), s.groups);

  // A5 registry rows: adopt running strangers (serde + Debug shapes), ignore finished ones
  await ev({ ev: "subagent_rows", rows: [
    { subagent_id: 1, agent_name: "inline", status: "running", cancel_requested: false, elapsed_secs: 7.5, finished_elapsed: null },
    { subagent_id: 6, agent_name: "gone", status: { failed: "boom" }, cancel_requested: false, elapsed_secs: 3, finished_elapsed: null },
    { subagent_id: 7, agent_name: "scout", status: "Running", cancel_requested: false, elapsed_secs: 65 },
  ] });
  await frame(); s = await snap();
  expect("A5 adopts the running stranger only", s.rows.length === 2 && s.rows[1].name === "scout" && s.rows[1].id === "sa_7" && /^1:0[5-6]$/.test(s.rows[1].time), s.rows);
  expect("A5 run state counts both", /2 agents \(0 done\)/.test(s.run), s.run);
  await ev({ ev: "subagent_rows", rows: [{ subagent_id: 7, agent_name: "scout", status: "Failed(\"provider 529\")", cancel_requested: false, elapsed_secs: 70 }] });
  await frame(); s = await snap();
  expect("A5 Debug Failed(…) finishes it, with the reason", s.rows[1].state === "failed" && /provider 529/.test(s.rows[1].step) && s.sys.some((x) => /scout \(sa_7\) failed · 1:10/.test(x)), { rows: s.rows, sys: s.sys });

  // A6 completion (external) → done + one transcript line; a later subagent_done doesn't repeat it
  await ev({ ev: "external", event: { source: { source_type: "subagent", name: "inline" }, content: { content_type: "subagent_completion", severity: "High",
    text: "Subagent 'inline' (sa_1) finished with status 'completed' after 28.2s. Call subagent_collect with handle_id \"sa_1\" to retrieve the full result. Preview: Both done: hello-from-sub",
    data: { agent_name: "inline", duration_secs: 28.2, handle_id: "sa_1", status: "completed", subagent_id: 1 } } } });
  await frame(); s = await snap();
  expect("A6 external completion alone finishes it, preview from the text", s.rows[0].state === "completed" && s.rows[0].step === "Both done: hello-from-sub", s.rows[0]);
  await agent({ agent: "subagent_done", subagent_id: 1, agent_name: "inline", result_preview: "Both done", duration_secs: 28.19 });
  await frame(); s = await snap();
  expect("A6 completed row: ✓, time frozen at 28s", s.rows[0].state === "completed" && s.rows[0].time === "28s" && !s.rows[0].spinner, s.rows[0]);
  expect("A6 exactly one finished line", s.sys.filter((x) => /implementer \(sa_1\) finished · 28s/.test(x)).length === 1, s.sys);
  expect("A6 run state: ✔ 0 agents (2 done)", /✔\s*0 agents \(2 done\)/.test(s.run), s.run);
  expect("A6 start card: ✓ 28s", /28s/.test(card(s, "subagent_start", 1).st), card(s, "subagent_start", 1).st);

  // A7 collect → result on the start card; tray detail + show-in-transcript
  await tool("tE", "subagent_collect", { handle_id: "sa_1", reconciled: true }, JSON.stringify({ authorization: AUTH, collected: false, handle_id: "sa_1", model: "anthropic/claude-opus-4-6", output: "## Outputs\n- `hello-from-sub`\n- **banana**", status: "completed", terminal_cause: { category: "completed", code: "completed", safe_message: "worker completed" } }));
  await frame(); s = await snap();
  c = card(s, "subagent_collect");
  expect("A7 collect card: completed + result markdown", c.pill === "completed" && /result/.test(c.out) && /banana/.test(c.out) && !/worker completed/.test(c.out.replace(/details[\s\S]*/, "")), c);
  expect("A7 start card carries the result", /result[\s\S]*banana/.test(card(s, "subagent_start", 1).agent || ""), card(s, "subagent_start", 1).agent);
  await p.click("#agents .ag:first-child .ag-row");
  await frame();
  const det = await p.evaluate(() => { const d = document.querySelector("#agents .ag .ag-detail"); return { hidden: d.classList.contains("hidden"), text: d.textContent, strong: d.querySelectorAll(".tmd strong").length, go: !!d.querySelector(".ag-go") }; });
  expect("A7 tray detail: task, steps, result, go button", !det.hidden && /task/.test(det.text) && /steps · 3/.test(det.text) && /banana/.test(det.text) && det.strong >= 1 && det.go, det);
  await p.evaluate(() => { SC.scrollTop = 0; });
  await p.click("#agents .ag-go");
  await p.waitForTimeout(700);
  const go = await p.evaluate(() => { const c = [...document.querySelectorAll("#thread .tool")][1]; const r = c.getBoundingClientRect(); return { open: c.classList.contains("open"), flash: c.classList.contains("flash"), inView: r.top >= 0 && r.top < innerHeight, pinned: S.pinned }; });
  expect("A7 show in transcript: scrolls, opens, flashes, unpins", go.open && go.flash && go.inView && go.pinned === false, go);
  await p.click("#agents .ag:first-child .ag-row"); // collapse again (an open row is kept past its flash)

  // A8 blocking oneshot: linked by a unicode task prefix, fails → no transcript line
  const LONG = "Résumé — ünïcödé ✓ task that is definitely longer than eighty characters so the preview is cut short somewhere";
  await tool("tF", "subagent", { role: "reviewer", system_prompt: "Review.", task: LONG });
  await agent({ agent: "subagent_start", subagent_id: 8, agent_name: "inline", task_preview: Array.from(LONG).slice(0, 80).join("") });
  await agent({ agent: "subagent_update", subagent_id: 8, agent_name: "inline", status: "reading app.js" });
  await frame(); s = await snap();
  const r8 = s.rows.find((r) => r.id === "sa_8");
  expect("A8 oneshot row + card link", r8 && r8.name === "reviewer" && r8.step === "reading app.js" && /reading app\.js/.test(card(s, "subagent").agent || ""), { r8, c: card(s, "subagent") });
  await st({ kind: "llm", llm: "tool_result", tool_id: "tF", result: "[subagent:inline ERROR] provider request failed" });
  await frame(); s = await snap();
  expect("A8 oneshot result: failed, card says so, no finished line", s.rows.find((r) => r.id === "sa_8")?.state === "failed" && /subagent failed/.test(card(s, "subagent").out) && !s.sys.some((x) => /sa_8/.test(x)), { rows: s.rows, sys: s.sys, out: card(s, "subagent").out });

  // A9 models view
  await tool("tG", "subagent_models", {}, JSON.stringify({ foreground_model: "anthropic/claude-opus-4-6", model_omission: "inherit_foreground", models: ["anthropic/claude-opus-4-6", "openai-codex/gpt-5.5"] }));
  await frame(); s = await snap();
  expect("A9 models: chips, foreground marked", card(s, "subagent_models").fg === "anthropic/claude-opus-4-6", card(s, "subagent_models"));

  // A10 layout: the thread makes room for the tray; the tray sits above the composer
  const lay = await p.evaluate(() => { const a = document.getElementById("agents").getBoundingClientRect(), c = document.getElementById("composer").getBoundingClientRect(); return { aBottom: a.bottom, cTop: c.top, aw: a.width, cw: c.width, h: a.height, pad: parseFloat(getComputedStyle(T).paddingBottom) }; });
  expect("A10 tray above the composer, same column", lay.aBottom <= lay.cTop + 0.5 && Math.abs(lay.aw - lay.cw) < 1, lay);
  expect("A10 thread padding grows with the tray", Math.abs(lay.pad - (200 + Math.round(lay.h + 8))) <= 1, lay);

  // A11 turn stops mid-oneshot → cancelled
  await tool("tH", "subagent", { task: "never finishes" });
  await agent({ agent: "subagent_start", subagent_id: 9, agent_name: "inline", task_preview: "never finishes" });
  await ev({ ev: "aborted", context_saved: true });
  await frame(); s = await snap();
  expect("A11 aborted turn cancels its oneshot", s.rows.find((r) => r.id === "sa_9")?.state === "cancelled", s.rows);

  // A12 escaping
  const pwn = await p.evaluate(() => ({ pwn: window.__pwn ?? null, imgs: document.querySelectorAll("#agents img, #thread .tool img").length }));
  expect("A12 nothing injected", pwn.pwn === null && pwn.imgs === 0, pwn);

  // A13 finished rows leave after the flash; the tray collapses and gives the room back
  await p.waitForTimeout(9500);
  s = await snap();
  expect("A13 flash expiry empties the tray", s.hidden && s.rows.length === 0 && (s.agentsH === "0px" || s.agentsH === ""), { hidden: s.hidden, rows: s.rows, h: s.agentsH });
  expect("A13 run state back to ready", s.runState === "ready", s.run);

  // A14 attach resets
  await p.evaluate(() => Agents.rows([{ subagent_id: 42, agent_name: "x", status: "Running", cancel_requested: false, elapsed_secs: 1 }]));
  await frame();
  await p.evaluate(() => Agents.reset());
  await frame(); s = await snap();
  expect("A14 reset clears the tray", s.hidden && !s.rows.length, s.rows);
  if (errs.length) fail.push(`page errors (A): ${errs.join(" | ")}`);

  // ── Part B: a real turn ──
  if (!process.env.SKIP_LIVE) {
    const h1 = await p.evaluate(() => location.hash);
    await p.click("#new-session");
    await p.waitForFunction((h) => location.hash !== h && !document.getElementById("input").disabled, h1, { timeout: 20000 });
    await p.fill("#input", "Subagent UI test. (1) Activate subagent tools if needed. (2) Call the blocking `subagent` tool with role 'tester', system_prompt 'You run shell commands.', task 'Run bash: for i in 1 2 3; do echo $i; sleep 1; done — reply with the output.' (3) Call subagent_start with role 'researcher', system_prompt 'You run shell commands.', task 'Run bash: sleep 14; echo woke — reply with the output.' (4) END YOUR TURN right away with one short line. Do not call subagent_status or subagent_collect. When woken by the completion, reply only 'ok'.");
    await p.press("#input", "Enter");
    await p.waitForFunction(() => [...document.querySelectorAll("#agents .ag")].some((a) => a.querySelector(".ag-name").textContent === "tester"), null, { timeout: 90000 });
    const B1 = await p.evaluate(() => [...document.querySelectorAll("#thread .tool")].filter((c) => c.querySelector(".tool-name").textContent === "subagent").map((c) => !!c.querySelector(".tool-sec.agent")));
    expect("B1 blocking subagent: tray row + linked card", B1.includes(true), B1);
    await p.waitForFunction(() => !S.streaming && [...document.querySelectorAll("#agents .ag")].some((a) => a.querySelector(".ag-name").textContent === "researcher" && a.dataset.state === "running"), null, { timeout: 120000 });
    const q0 = queries.length;
    const t1 = await p.evaluate(() => [...document.querySelectorAll("#agents .ag")].find((a) => a.querySelector(".ag-name").textContent === "researcher").querySelector(".ag-time").textContent);
    await p.waitForTimeout(3500);
    const t2 = await p.evaluate(() => [...document.querySelectorAll("#agents .ag")].find((a) => a.querySelector(".ag-name").textContent === "researcher")?.querySelector(".ag-time").textContent);
    expect("B2 idle: background agent keeps ticking + polls the registry", t1 !== t2 && queries.length > q0, { t1, t2, polls: queries.length - q0 });
    await p.waitForFunction(() => [...document.querySelectorAll("#thread .sys")].some((x) => /researcher \(sa_\d+\) finished/.test(x.textContent)), null, { timeout: 90000 });
    await p.waitForFunction(() => !S.streaming, null, { timeout: 90000 });
    await p.waitForFunction(() => document.getElementById("agents").classList.contains("hidden"), null, { timeout: 20000 });
    const B3 = await p.evaluate(() => ({ run: document.getElementById("run-state").dataset.state, st: [...document.querySelectorAll("#thread .tool")].filter((c) => c.querySelector(".tool-name").textContent === "subagent_start").map((c) => c.querySelector(".tool-st").textContent) }));
    expect("B3 completion: line, tray empties, start card ✓ with duration", B3.run === "ready" && B3.st.some((x) => /^\d+s$/.test(x.trim())), B3);
    if (errs.length) fail.push(`page errors (B): ${errs.join(" | ")}`);
  }

  console.log(fail.length ? `FAIL\n  ${fail.join("\n  ")}` : "PASS");
  await b.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
