// Per-tool views, on the SANDBOX (:7718).
// Part A — deterministic: real-shaped tool events (samples from real sessions)
//   through the page's own onStream handler. Every view, failure detection,
//   truncation, folding, streaming deltas, fallbacks and HTML escaping.
// Part B — a real agent turn with real tools in a temp dir.
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
const fail = [];
const expect = (name, ok, detail) => { if (!ok) fail.push(`${name}${detail !== undefined ? `: ${JSON.stringify(detail).slice(0, 400)}` : ""}`); };

(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.waitForFunction(() => S.sid || /No live sessions/.test(document.getElementById("thread").textContent), null, { timeout: 15000 }); // let the page's own auto-attach settle first
  const h0 = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, h0, { timeout: 20000 });
  await p.waitForTimeout(300);

  // ── Part A: inject ──
  const run = (id, name, input, result, deltas) => p.evaluate(async ([id, name, input, result, deltas]) => {
    onStream({ kind: "llm", llm: "tool_use_start", tool_id: id, tool_name: name });
    onStream({ kind: "llm", llm: "tool_use", tool_id: id, tool_name: name, input });
    if (deltas) { let acc = ""; for (const d of deltas) { acc += d; onStream({ kind: "llm", llm: "tool_result_delta", tool_id: id, delta: d }); } }
    if (result !== null) onStream({ kind: "llm", llm: "tool_result", tool_id: id, result });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t = S.turnTools.get(id);
    t.card.classList.add("open");
    const q = (s) => t.card.querySelector(s), qa = (s) => [...t.card.querySelectorAll(s)];
    return {
      kind: t.kind, cls: t.card.className, st: q(".tool-st")?.textContent || "", sum: q(".tool-sum")?.textContent || "",
      outHidden: q(".tool-sec.out")?.classList.contains("hidden"), outFail: q(".tool-sec.out")?.classList.contains("fail"),
      diff: { ctx: qa(".dl.ctx").length, del: qa(".dl.del").length, add: qa(".dl.add").length, marks: qa(".dl mark").map((m) => m.textContent), fold: qa(".dfold").length, stat: q(".dstat")?.textContent || null },
      lns: qa(".cl .ln").map((x) => x.textContent), ccs: qa(".cl .cc").slice(0, 4).map((x) => x.textContent),
      ansi: qa(".tout span[class^='a-'], .tout span[class*=' a-']").map((x) => `${x.className}:${x.textContent}`), tout: q(".tout")?.textContent ?? null,
      more: qa(".more-bar").map((x) => x.textContent),
      gfiles: qa(".gfile").length, gmarks: qa(".gfile mark").map((m) => m.textContent), gctx: qa(".gfile .cl.ctx").length, note: q(".t-note")?.textContent || null, empty: q(".t-empty")?.textContent || null,
      frows: qa(".frow").map((x) => x.textContent), lsr: qa(".lsr").map((x) => x.querySelector(".lsn").textContent),
      mdStrong: qa(".tmd strong").length, mdLi: qa(".tmd li").length, chips: qa(".kchip").map((x) => x.textContent),
      link: q(".tlink")?.getAttribute("href") || null, jt: qa(".jt-key").map((x) => x.textContent).slice(0, 6),
      fhead: q(".fhead") ? [...q(".fhead").querySelectorAll(".fdir, .fbase")].map((x) => x.textContent).join("") : null, copyBtns: qa(".tcopy").length,
      danger: qa("img, script, iframe, [onerror], [onload]").length, generic: qa(".kv-key").length,
    };
  }, [id, name, input, result, deltas || null]);
  const clickMore = (id, idx = 0) => p.evaluate(async ([id, idx]) => { const t = S.turnTools.get(id); t.card.querySelectorAll(".more-bar")[idx].click(); await new Promise((r) => requestAnimationFrame(r)); return { lns: t.card.querySelectorAll(".cl .ln").length, dl: t.card.querySelectorAll(".dl").length, more: t.card.querySelectorAll(".more-bar").length, toutLines: (t.card.querySelector(".tout")?.textContent || "").split("\n").length }; }, [id, idx]);
  const R = {};

  // edit
  R.edit = await run("e1", "edit", { path: "/home/haseeb/proj/app.ts", old_string: "const a = 1;\nconst b = 2;\nfoo(a, b);", new_string: "const a = 1;\nconst b = 3;\nfoo(a, b, c);\nbar();" }, "Edited /home/haseeb/proj/app.ts — replaced 3 line(s) with 4 line(s)");
  expect("edit: kind", R.edit.kind === "edit", R.edit.kind);
  expect("edit: rows ctx1 del2 add3", R.edit.diff.ctx === 1 && R.edit.diff.del === 2 && R.edit.diff.add === 3, R.edit.diff);
  expect("edit: word marks on changed tokens", R.edit.diff.marks.includes("2") && R.edit.diff.marks.includes("3") && R.edit.diff.marks.some((m) => m.includes("c")), R.edit.diff.marks);
  expect("edit: stat + summary", R.edit.diff.stat === "+3−2" && R.edit.sum === "app.ts  +3 −2", [R.edit.diff.stat, R.edit.sum]);
  expect("edit: success line folded away", R.edit.outHidden === true && /ok/.test(R.edit.cls), R.edit);
  expect("edit: path header tildified", R.edit.fhead === "~/proj/app.ts", R.edit.fhead);
  const ctxLines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  R.fold = await run("e2", "edit", { path: "/tmp/long.txt", old_string: [...ctxLines, "OLD", ...ctxLines].join("\n"), new_string: [...ctxLines, "NEW", ...ctxLines].join("\n") }, "Edited /tmp/long.txt — replaced 41 line(s) with 41 line(s)");
  expect("edit: long unchanged runs fold", R.fold.diff.fold === 2 && R.fold.diff.del === 1 && R.fold.diff.add === 1, R.fold.diff);
  R.foldOpen = await clickMore("e2", 0);
  expect("edit: fold expands", R.foldOpen.dl > R.fold.diff.ctx + 2, R.foldOpen);
  // multi-edit + fallback on a malformed input
  R.editBad = await run("e3", "edit", { path: "x.js", old_string: 5, new_string: null }, "Edited x.js — replaced 1 line(s) with 1 line(s)");
  expect("edit: malformed input → generic view, no crash", R.editBad.generic > 0 && R.editBad.diff.del === 0, R.editBad);

  // write
  const py = Array.from({ length: 60 }, (_, i) => (i === 0 ? "def f():" : `    x = ${i}  # n`)).join("\n") + "\n";
  R.write = await run("w1", "write", { path: "/tmp/x.py", content: py }, "Wrote 60 lines (900 bytes) to /tmp/x.py");
  expect("write: 40 numbered rows + more bar", R.write.lns.length === 40 && R.write.lns[0] === "1" && R.write.more.some((m) => /20 more/.test(m)), [R.write.lns.length, R.write.more]);
  expect("write: summary + hidden result", R.write.sum === "x.py · 60 lines" && R.write.outHidden, [R.write.sum, R.write.outHidden]);
  R.writeAll = await clickMore("w1", 0);
  expect("write: show all → 60 rows", R.writeAll.lns === 60 && R.writeAll.more === 0, R.writeAll);

  // read (real sample shape)
  R.read = await run("r1", "read", { path: "/home/haseeb/Projects/x/wire.rs", offset: 60, limit: 5 }, '61\t    env!("CARGO_PKG_VERSION").to_string()\n62\t}\n63\t\n64\t// ── client → daemon ──\n65\t/// Client → daemon.');
  expect("read: real line numbers in the gutter", JSON.stringify(R.read.lns) === JSON.stringify(["61", "62", "63", "64", "65"]), R.read.lns);
  expect("read: range in summary", R.read.sum === "wire.rs · lines 61–65", R.read.sum);
  expect("read: tab prefix stripped", R.read.ccs[0].startsWith("    env!"), R.read.ccs);

  // bash: ANSI, failure, timeout, head/tail
  R.bash = await run("b1", "bash", { command: "ls --color" }, "\x1b[1;34mdir\x1b[0m\nfile\x1b[32m ok\x1b[0m\n\x1b[2Kdone\rprogress 50%\rprogress 100%");
  expect("bash: ANSI → classes", R.bash.ansi.includes("a-bold a-b:dir") && R.bash.ansi.includes("a-g: ok"), R.bash.ansi);
  expect("bash: no raw escapes, \\r keeps last frame", !/\x1b/.test(R.bash.tout) && /progress 100%$/.test(R.bash.tout) && !/50%/.test(R.bash.tout), R.bash.tout);
  R.bashFail = await run("b2", "bash", { command: "false" }, "Tool execution failed: Command failed (exit 2):\nerror: nope");
  expect("bash fail: err + 'exit 2' + prefix stripped", /\berr\b/.test(R.bashFail.cls) && R.bashFail.st.startsWith("exit 2") && R.bashFail.outFail && R.bashFail.tout === "error: nope", R.bashFail);
  R.bashTo = await run("b3", "bash", { command: "sleep 99" }, "Tool execution failed: Command timed out after 30s");
  expect("bash timeout label", R.bashTo.st.startsWith("timed out 30s") && /\berr\b/.test(R.bashTo.cls), R.bashTo.st);
  const long = Array.from({ length: 1000 }, (_, i) => `row ${i}`).join("\n");
  R.bashLong = await run("b4", "bash", { command: "seq" }, long);
  expect("bash long: head/tail + bar", R.bashLong.tout.includes("row 0") && R.bashLong.tout.includes("row 999") && !R.bashLong.tout.includes("row 500") && R.bashLong.more.some((m) => /800 lines hidden/.test(m)), R.bashLong.more);
  R.bashLongAll = await clickMore("b4", 0);
  expect("bash long: show all", R.bashLongAll.toutLines === 1000, R.bashLongAll);
  // streaming deltas coalesce and land complete
  const chunks = Array.from({ length: 60 }, (_, i) => `chunk ${i}\n`);
  R.stream = await run("b5", "bash", { command: "stream" }, chunks.join(""), chunks);
  expect("bash stream: final output complete", R.stream.tout.startsWith("chunk 0") && R.stream.tout.includes("chunk 59"), R.stream.tout.slice(-40));

  // grep
  R.grep = await run("g1", "grep", { pattern: "foo\\|bar", path: "/home/haseeb/p", context: 1 }, "/home/haseeb/p/a.js:3:const foo = 1\n/home/haseeb/p/a.js-4-ctx <b>line</b>\n--\n/home/haseeb/p/b.js:10:bar()");
  expect("grep: grouped by file", R.grep.gfiles === 2 && R.grep.note === "2 matches in 2 files", [R.grep.gfiles, R.grep.note]);
  expect("grep: BRE \\| pattern marks both", R.grep.gmarks.includes("foo") && R.grep.gmarks.includes("bar"), R.grep.gmarks);
  expect("grep: context row dimmed, real line numbers", R.grep.gctx === 1 && R.grep.lns.includes("3") && R.grep.lns.includes("10"), R.grep.lns);
  R.grepNone = await run("g2", "grep", { pattern: "zzz", path: "/x" }, "No matches found.");
  expect("grep: empty state", R.grepNone.empty === "No matches", R.grepNone.empty);

  // find / ls
  R.find = await run("f1", "find", { path: "/home/haseeb/p", pattern: "*.rs" }, "/home/haseeb/p/src/a.rs\n/home/haseeb/p/b.rs\n");
  expect("find: rows relative to root", JSON.stringify(R.find.frows) === JSON.stringify(["src/a.rs", "b.rs"]), R.find.frows);
  R.ls = await run("l1", "ls", { path: "/home/haseeb/p" }, "total 16K\ndrwxr-xr-x 1 haseeb haseeb  92 Sep 24 21:02 .\ndrwxr-xr-x 1 haseeb haseeb 4.5K Sep 24 20:08 ..\n-rw-r--r-- 1 haseeb haseeb 1.2K Sep 24 19:04 zeta.txt\ndrwxr-xr-x 1 haseeb haseeb  30 Jul 25 16:38 alpha\nlrwxrwxrwx 1 haseeb haseeb  37 Sep 24 19:25 link -> /home/haseeb/x\n");
  expect("ls: dirs first, . and .. skipped, symlink target", JSON.stringify(R.ls.lsr) === JSON.stringify(["alpha/", "link → /home/haseeb/x", "zeta.txt"]), R.ls.lsr);

  // subagent / fetch / JSON
  R.sub = await run("s1", "subagent", { agent: "spike", model: "claude-opus-4-6", task: "Do **X** now", system_prompt: "You are\nspike" }, "## Done\n- item one\n- item **two**");
  expect("subagent: chips + task markdown + result markdown", R.sub.chips.some((c) => c === "agentspike") && R.sub.mdStrong >= 2 && R.sub.mdLi === 2 && /^spike: Do \*\*X\*\* now$/.test(R.sub.sum), R.sub);
  R.fetch = await run("x1", "ext.web-tools:fetch", { url: "https://example.com/a?b=1" }, "Example Domain\nThis domain is for use in examples.");
  expect("fetch: link card + summary", R.fetch.kind === "fetch" && R.fetch.link === "https://example.com/a?b=1" && R.fetch.sum === "example.com/a", R.fetch);
  R.fetchJs = await run("x2", "fetch", { url: "javascript:alert(1)" }, "nope");
  expect("fetch: non-http url never becomes a link", R.fetchJs.link === null, R.fetchJs.link);
  R.json = await run("j1", "search_tools", { query: "web" }, '{"generation":32,"tools":[{"id":"builtin:read","summary":"Read a file"}]}');
  expect("JSON result → tree", R.json.jt.includes("generation") && R.json.jt.includes("tools"), R.json.jt);

  // failure prefixes the old check missed
  R.denied = await run("d1", "subagent", { task: "x" }, "Tool call denied: tool is not activated for this session: builtin:subagent");
  expect("denied → err 'denied'", /\berr\b/.test(R.denied.cls) && R.denied.st.startsWith("denied"), [R.denied.cls, R.denied.st]);
  R.unknown = await run("d2", "ext.web-tools:fetch", { url: "https://x.y" }, "Unknown tool: ext.web-tools:fetch");
  expect("unknown tool → err", /\berr\b/.test(R.unknown.cls) && R.unknown.st.startsWith("unknown tool"), R.unknown.st);
  R.extFail = await run("d3", "web-tools_fetch", { url: "https://x.y" }, "Tool execution failed: Extension error: ✗ fetch failed: needs JS");
  expect("extension failure → err 'failed'", /\berr\b/.test(R.extFail.cls) && R.extFail.st.startsWith("failed"), R.extFail.st);

  // escaping: nothing from tool data becomes live markup
  const bad = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';
  const xs = [
    await run("z1", "edit", { path: "/tmp/<b>a.js", old_string: "a", new_string: bad }, "Edited"),
    await run("z2", "bash", { command: "echo" }, `\x1b[31m${bad}\x1b[0m`),
    await run("z3", "grep", { pattern: "img", path: "/p" }, `/p/a.html:1:${bad}`),
    await run("z4", "read", { path: "/p/a.html" }, `1\t${bad}`),
    await run("z5", "subagent", { task: bad }, bad),
    await run("z6", "ls", { path: "/p" }, `-rw-r--r-- 1 u g 1 Sep 24 19:04 ${bad}`),
    await run("z7", "search_tools", { q: 1 }, JSON.stringify({ [bad]: bad })),
  ];
  R.xss = { danger: xs.map((x) => x.danger), pwned: await p.evaluate(() => window.__pwn ?? null) };
  expect("no injected elements from any view", R.xss.danger.every((n) => n === 0) && R.xss.pwned === null, R.xss);
  R.copy = R.edit.copyBtns;
  expect("copy buttons present", R.copy >= 2, R.copy);

  // ── Part B: a real turn with real tools ──
  fs.rmSync("/tmp/sd-toolview", { recursive: true, force: true });
  fs.mkdirSync("/tmp/sd-toolview");
  await p.fill("#input", "Work only in /tmp/sd-toolview. In order, one tool call each: (1) write /tmp/sd-toolview/demo.js with 12 short lines of JS (a function named greet on line 3); (2) edit that file to rename greet to welcome everywhere on line 3 only; (3) read the file; (4) grep for 'welcome' in /tmp/sd-toolview; (5) ls /tmp/sd-toolview; (6) run bash: printf '\\033[32mgreen\\033[0m\\n'. Then reply 'done'.");
  await p.press("#input", "Enter");
  await p.waitForFunction(() => S.streaming, null, { timeout: 20000 });
  await p.waitForFunction(() => !S.streaming, null, { timeout: 180000 });
  await p.waitForTimeout(400);
  // S.turnTools is cleared when the turn ends — read the real cards from the DOM.
  R.real = await p.evaluate(() => [...document.querySelectorAll("#thread .tool")].slice(-12).map((card) => {
    card.classList.add("open");
    const q = (s) => card.querySelector(s);
    const name = q(".tool-name").textContent;
    return { name, ok: card.classList.contains("ok"), diff: !!q(".diff"), cview: card.querySelectorAll(".cl").length, grep: !!q(".gfile"), ls: card.querySelectorAll(".lsr").length, tout: q(".tout")?.textContent ?? null, sum: q(".tool-sum").textContent };
  }));
  const byKind = (k) => R.real.filter((x) => (x.name.toLowerCase().replace(/^.*[:.]/, "") === k));
  expect("real: write → numbered file view", byKind("write").some((x) => x.cview >= 10), byKind("write"));
  expect("real: edit → diff", byKind("edit").some((x) => x.diff && x.ok), byKind("edit"));
  expect("real: read → numbered rows", byKind("read").some((x) => x.cview >= 10), byKind("read"));
  expect("real: grep → grouped", byKind("grep").some((x) => x.grep), byKind("grep"));
  expect("real: ls → rows", byKind("ls").some((x) => x.ls >= 1), byKind("ls"));
  // Synaps strips ANSI from bash output (tools/bash.rs strip_ansi) — the real
  // result is plain text; ANSI rendering is covered by Part A (other tools/PTY).
  expect("real: bash → terminal view, ok", byKind("bash").some((x) => x.ok && /green/.test(x.tout || "")), byKind("bash"));

  if (errs.length) fail.push(`page errors: ${errs.join(" | ")}`);
  console.log(JSON.stringify({ real: R.real, xss: R.xss, fold: R.fold.diff, bashFail: R.bashFail.st }, null, 1));
  console.log(fail.length ? `FAIL\n  ${fail.join("\n  ")}` : "PASS");
  await b.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
