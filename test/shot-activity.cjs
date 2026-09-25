// Screenshot an expanded activity batch (thought + tools) for visual review.
const { chromium } = require(process.env.HOME + "/Projects/SynapsDASH/node_modules/playwright");
const fs = require("fs");
(async () => {
  const url = fs.readFileSync(`${process.env.HOME}/.synaps-cli/run/synaps-dash-webproto.url`, "utf8").trim();
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 })).newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.getElementById("conn").classList.contains("up"), null, { timeout: 15000 });
  await p.waitForFunction(() => S.sid || /No live sessions/.test(document.getElementById("thread").textContent), null, { timeout: 15000 }); // let the page's own auto-attach settle first
  const oldHash = await p.evaluate(() => location.hash);
  await p.click("#new-session");
  await p.waitForFunction((h) => location.hash && location.hash !== h && !document.getElementById("input").disabled, oldHash, { timeout: 20000 });
  await p.fill("#input", "Think briefly, then run these as SEPARATE bash tool calls: `cd /tmp && ls | head -3; echo \"branch: $(git -C /tmp branch --show-current 2>/dev/null || echo none)\" && uname -s`, then `date +%Y && echo done`. Then read the file /etc/hostname with the read tool. Then reply in one sentence.");
  await p.press("#input", "Enter");
  await p.waitForFunction(() => document.getElementById("send").classList.contains("stop"), null, { timeout: 20000 }).catch(() => {});
  await p.waitForFunction(() => !document.getElementById("send").classList.contains("stop") && !document.querySelector(".msg.asst.live"), null, { timeout: 180000 });
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    const g = document.querySelector(".activity:not(.single)"); if (g) g.open = true;
    const t = document.querySelector(".activity .tool"); if (t) t.classList.add("open");
    const th = document.querySelector(".activity .think"); if (th) th.open = true;
  });
  await p.waitForTimeout(300);
  const el = await p.$(".msg.asst");
  await el.screenshot({ path: "/tmp/sd-activity.png" });
  const info = await p.evaluate(() => ({
    groups: [...document.querySelectorAll(".activity")].map((g) => ({ single: g.classList.contains("single"), steps: g.querySelector(".act-body").children.length, label: g.querySelector(".act-lbl")?.textContent })),
    cmdLines: [...document.querySelectorAll(".cmd-line")].map((l) => l.textContent).slice(0, 6),
    sums: [...document.querySelectorAll(".tool-sum")].map((s) => s.textContent),
    rowHeights: [...document.querySelectorAll(".act-head, .think > summary, .tool-head")].filter((r) => r.offsetParent).map((r) => Math.round(r.getBoundingClientRect().height)),
    rail: (() => { const g = document.querySelector(".activity:not(.single)"); if (!g) return null; const cs = getComputedStyle(g, "::before"); return { content: cs.content, left: cs.left, top: cs.top, bottom: cs.bottom, width: cs.width, bg: cs.backgroundColor, surface: getComputedStyle(g).backgroundColor }; })(),
    headerStatus: document.querySelector(".act-st")?.textContent,
    iconX: [...document.querySelectorAll(".activity:not(.single) .act-ico, .activity:not(.single) .tool-ico, .activity:not(.single) .think > summary > .i:first-child")].map((i) => Math.round(i.getBoundingClientRect().left)),
  }));
  console.log(JSON.stringify(info, null, 1)); console.log("ERRORS", errs.length ? errs : "none");
  await b.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
