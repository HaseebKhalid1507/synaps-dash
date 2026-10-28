// synaps·dash telemetry view — what the agents cost, how the cache holds up,
// how fast the provider answers. Reads /api/telemetry/* (API.md v1). Loaded
// after app.js and shares its globals ($, h, esc, anim, EASE, motion, NARROW,
// S, toggleRail, closeDrawer). Charts are hand-rolled SVG painted with the
// palette tokens, so they cross-fade with the album like everything else.
"use strict";

const Telemetry = (() => {
  const API = "/api/telemetry";
  const DAY = 86400000;
  const DASH = "—";
  const st = { open: false, pushed: false, range: "30", host: "", group: "model", sort: "cost", q: "", offset: 0, limit: 50, data: {}, seq: {}, err: {}, poll: 0, detail: null };

  // ── format ────────────────────────────────────────────────────────────────
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const trim0 = (s) => s.replace(/\.0(?=[kKMB%s]|$)/, "");
  function num(v) {
    if (!isNum(v)) return DASH;
    const a = Math.abs(v);
    if (a >= 1e9) return trim0(`${(v / 1e9).toFixed(1)}B`);
    if (a >= 1e6) return trim0(`${(v / 1e6).toFixed(1)}M`);
    if (a >= 1e4) return trim0(`${(v / 1e3).toFixed(1)}k`);
    return Math.round(v).toLocaleString();
  }
  const int = (v) => (isNum(v) ? Math.round(v).toLocaleString() : DASH);
  function usd(v) {
    if (!isNum(v)) return DASH;
    const a = Math.abs(v);
    if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `$${(v / 1e3).toFixed(1)}K`;
    if (a >= 1000) return `$${Math.round(v).toLocaleString()}`;
    if (a >= 100) return `$${v.toFixed(0)}`;
    if (a === 0) return "$0";
    if (a < 0.01) return "<$0.01";
    return `$${v.toFixed(2)}`;
  }
  // axis labels carry as many decimals as the tick STEP needs ($0.37 max →
  // $0.10 steps, $9 → $2.50), so neighbouring ticks never print the same text
  const decimals = (x) => { const t = String(+(+x).toPrecision(6)); return t.includes("e-") ? +t.split("e-")[1] : (t.split(".")[1] || "").length; };
  function usdAxis(v, step = v) {
    if (v === 0) return "$0";
    if (v >= 1000) return step >= 100 ? `$${+(v / 1000).toFixed(decimals(step / 1000))}K` : `$${Math.round(v).toLocaleString()}`;
    const d = decimals(step);
    return `$${v.toFixed(d === 0 ? 0 : Math.max(2, d))}`;
  }
  const pct = (v, d = 1) => (isNum(v) ? `${v.toFixed(d)}%` : DASH);
  function ms(v) {
    if (!isNum(v)) return DASH;
    if (v < 1000) return `${Math.round(v)} ms`;
    if (v < 60000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)} s`;
    return `${Math.floor(v / 60000)}m ${Math.round((v % 60000) / 1000)}s`;
  }
  const msAxis = (v) => (v < 1000 ? `${v}ms` : trim0(`${(v / 1000).toFixed(1)}s`));
  const pday = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dShort = (s) => pday(s).toLocaleDateString([], { month: "short", day: "numeric" });
  const dLong = (s) => pday(s).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const tsLong = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  function rel(t) {
    if (!isNum(t) || t <= 0) return DASH;
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  }
  const span = (a, b) => { const m = Math.round((b - a) / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`; };
  function bytes(v) {
    if (!isNum(v)) return DASH;
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }
  const shortModel = (m = "") => String(m).replace(/^.*\//, "").replace(/^claude-/, "");
  const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const WDL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const hr12 = (hr) => `${hr % 12 || 12}${hr < 12 ? "a" : "p"}`;
  const hrLong = (hr) => `${hr % 12 || 12} ${hr < 12 ? "AM" : "PM"}`;
  const E = (s) => esc(String(s ?? ""));
  // Day buckets and heatmap hours are the STORE's local time (API.md: America/New_York).
  // Through a tunnel from another zone, say so instead of silently shifting.
  // "unknown" = the store couldn't decide which host a session started on
  const hostTag = (hst) => (hst === "unknown" ? `<span class="tl-tag dim" title="Origin host couldn't be decided (copies on several hosts, no api-log evidence)">unknown host</span>` : `<span class="tl-tag">${E(hst || DASH)}</span>`);
  const STORE_TZ = "America/New_York";
  const tzNote = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone === STORE_TZ ? "" : " (ET, the store's time zone)"; } catch { return ""; } };
  // stop reasons: Maps, never plain-object lookups (a stop called "constructor"
  // or "__proto__" must stay a string). null (and the store's old "none") = no stop reason.
  const NO_STOP = "\u0000none";
  const stopKey = (v) => (v == null || v === "none" ? NO_STOP : String(v));
  const stopLabel = (k) => (k === NO_STOP ? "no stop reason" : k.replace(/_/g, " "));
  const STOP_FLAG = new Map([["refusal", "bad"], ["max_tokens", "warn"], [NO_STOP, "warn"]]);

  // ── icons ─────────────────────────────────────────────────────────────────
  const IC = {
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    rail: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
    warn: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    retry: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    left: '<path d="M15 18l-6-6 6-6"/>', right: '<path d="M9 18l6-6-6-6"/>',
    flat: '<path d="M4 12h16"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  const ic = (n, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24">${IC[n]}</svg>`;

  // ── chart kit ─────────────────────────────────────────────────────────────
  let uid = 0;
  function nice(lo, hi, n = 4) {
    if (!(hi > lo)) hi = lo + 1;
    const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
    const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
    const a = Math.floor(lo / step + 1e-9) * step, out = [];
    for (let v = a; v <= hi + step * 0.999; v += step) out.push(+v.toFixed(10));
    return out;
  }
  const lastOf = (rows, k) => { for (let i = rows.length - 1; i >= 0; i--) if (isNum(rows[i][k])) return rows[i][k]; return null; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f1 = (v) => Math.round(v * 10) / 10;
  // x labels anchored on the newest day, ~one per 76px
  function xLabels(n, x, label, iw, y) {
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 76))));
    let s = "";
    for (let i = n - 1; i >= 0; i -= step) {
      const px = x(i), anchor = i === n - 1 && n > 1 ? "end" : i - step < 0 && px - 30 < x(0) ? "start" : "middle";
      s += `<text class="tl-ax" x="${f1(px)}" y="${y}" text-anchor="${anchor}">${E(label(i))}</text>`;
    }
    return s;
  }
  function yGrid(ticks, y, L, W, fmt) {
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : ticks[0] || 1;
    return ticks.map((t) => `<line class="tl-gl" x1="${L}" x2="${W}" y1="${f1(y(t))}" y2="${f1(y(t))}"/><text class="tl-ax" x="${L - 8}" y="${f1(y(t)) + 3.5}" text-anchor="end">${E(fmt(t, step))}</text>`).join("");
  }
  const tipRow = (cls, k, v, strong) => `<div class="tl-tt-r${strong ? " tt-tot" : ""}">${cls != null ? `<i class="tl-c${cls}"></i>` : ""}<span>${E(k)}</span><b>${E(v)}</b></div>`;

  // Stacked $ (or tokens) per day. ≤ 62 days: bars; beyond: stacked areas.
  function stack({ days, series, fmt, axis, H = 250, marker }) {
    return (W) => {
      const L = 50, R = 8, T = 14, B = 24, n = days.length, iw = W - L - R, ih = H - T - B;
      const tot = days.map((_, i) => series.reduce((a, s) => a + (s.vals[i] || 0), 0));
      const ticks = nice(0, Math.max(...tot, 0) || 1, 4), top = ticks[ticks.length - 1];
      const y = (v) => T + ih - (v / top) * ih, band = iw / n;
      const xc = (i) => L + (i + 0.5) * band;
      let plot = "";
      if (n <= 62) {
        const bw = Math.max(1, band * (n > 20 ? 0.7 : 0.56));
        for (let i = 0; i < n; i++) {
          let acc = 0;
          const last = series.reduce((k, s, j) => ((s.vals[i] || 0) > 0 ? j : k), -1);
          series.forEach((s, j) => {
            const v = s.vals[i] || 0;
            if (v <= 0) return;
            const y0 = y(acc), y1 = y(acc + v);
            acc += v;
            const x0 = f1(xc(i) - bw / 2), hh = Math.max(0.5, y0 - y1), r = j === last ? Math.min(3, bw / 3) : 0;
            plot += r ? `<path class="tl-c${s.c} tl-fill" d="M${x0},${f1(y0)}v${-f1(hh - r)}q0,${-r} ${r},${-r}h${f1(bw - 2 * r)}q${r},0 ${r},${r}v${f1(hh - r)}z"/>`
              : `<rect class="tl-c${s.c} tl-fill" x="${x0}" y="${f1(y1)}" width="${f1(bw)}" height="${f1(hh)}"/>`;
          });
        }
      } else {
        const base = days.map(() => 0);
        for (const s of series) {
          const top = base.map((b, i) => b + (s.vals[i] || 0));
          let d = `M${f1(xc(0))},${f1(y(top[0]))}`;
          for (let i = 1; i < n; i++) d += `L${f1(xc(i))},${f1(y(top[i]))}`;
          for (let i = n - 1; i >= 0; i--) d += `L${f1(xc(i))},${f1(y(base[i]))}`;
          let ln = `M${f1(xc(0))},${f1(y(top[0]))}`;
          for (let i = 1; i < n; i++) ln += `L${f1(xc(i))},${f1(y(top[i]))}`;
          plot += `<path class="tl-c${s.c} tl-area" d="${d}Z"/><path class="tl-c${s.c} tl-edge" d="${ln}"/>`;
          top.forEach((v, i) => (base[i] = v));
        }
      }
      let mark = "";
      if (marker) {
        const k = days.indexOf(marker.day);
        if (k > 0) {
          const mx = f1(L + k * band);
          mark = `<rect class="tl-tint" x="${L}" y="${T}" width="${f1(mx - L)}" height="${ih}"/><line class="tl-mk" x1="${mx}" x2="${mx}" y1="${T - 6}" y2="${T + ih}"/>`
            + `<text class="tl-mk-t" x="${mx + 6}" y="${T + 4}">${E(marker.right)}</text>`
            + (mx - L > 120 ? `<text class="tl-mk-t dim" x="${mx - 6}" y="${T + 4}" text-anchor="end">${E(marker.left)}</text>` : "");
        } else if (k === -1 && marker.allBefore && days.length && days[0] < marker.day) {
          mark = `<rect class="tl-tint" x="${L}" y="${T}" width="${iw}" height="${ih}"/>`;
        }
      }
      const svg = `<svg class="tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${yGrid(ticks, y, L, W - R, axis)}${mark}`
        + `<g class="tl-plot">${plot}</g><g class="tl-hov"></g>${xLabels(n, xc, (i) => dShort(days[i]), iw, H - 6)}</svg>`;
      const hover = (mx) => {
        const i = Math.floor((mx - L) / band);
        if (i < 0 || i >= n) return null;
        const rows = series.map((s) => [s, s.vals[i] || 0]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        return {
          g: `<rect class="tl-band" x="${f1(L + i * band)}" y="${T}" width="${f1(band)}" height="${ih}"/>`,
          html: `<div class="tl-tt-h">${E(dLong(days[i]))}</div>${rows.map(([s, v]) => tipRow(s.c, s.label, fmt(v))).join("")}${series.length > 1 ? tipRow(null, "Total", fmt(tot[i]), true) : ""}`,
        };
      };
      return { svg, hover };
    };
  }

  // Lines over an index axis (days, or request #). nulls break the line.
  function lines({ n, series, fmt, axis, label, head, H = 220, lo, hi, marks = [], area = true, ticksN = 4 }) {
    return (W) => {
      const L = 50, R = 10, T = marks.length ? 24 : 12, B = 24, iw = W - L - R, ih = H - T - B;
      const all = series.flatMap((s) => s.vals.filter(isNum));
      const mn = lo ?? Math.min(...all), mx = hi ?? Math.max(...all);
      const ticks = all.length ? nice(mn, mx, ticksN) : [0, 1];
      const t0 = lo ?? ticks[0], t1 = hi ?? ticks[ticks.length - 1];
      const y = (v) => T + ih - ((v - t0) / (t1 - t0 || 1)) * ih;
      const x = (i) => L + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
      const id = `tlg${++uid}`;
      let defs = "", plot = "";
      series.forEach((s, j) => {
        let d = "", a = "", run = [];
        const flush = () => {
          if (run.length && area && j === 0) a += `M${f1(x(run[0]))},${T + ih}` + run.map((i) => `L${f1(x(i))},${f1(y(s.vals[i]))}`).join("") + `L${f1(x(run[run.length - 1]))},${T + ih}Z`;
          run = [];
        };
        for (let i = 0; i < n; i++) {
          const v = s.vals[i];
          if (!isNum(v)) { flush(); continue; }
          d += `${run.length ? "L" : "M"}${f1(x(i))},${f1(y(clamp(v, t0, t1)))}`;
          run.push(i);
        }
        flush();
        if (a) { defs += `<linearGradient id="${id}" class="tl-c${s.c}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="tl-gs0"/><stop offset="1" class="tl-gs1"/></linearGradient>`; plot += `<path class="tl-grad" fill="url(#${id})" d="${a}"/>`; }
        if (d) plot += `<path class="tl-c${s.c} tl-line${s.dash ? " dash" : ""}${s.thin ? " thin" : ""}" pathLength="1" d="${d}"/>`;
      });
      let mk = "", lastL = -1e9;
      for (const m of marks.slice().sort((a, b) => b.i - a.i)) { // newest first keeps the latest tag labelled
        if (m.i < 0 || m.i > n - 1) continue;
        const px = f1(x(m.i));
        mk += `<line class="tl-mk${m.cls ? ` ${m.cls}` : ""}${m.label ? "" : " quiet"}" x1="${px}" x2="${px}" y1="${T - 4}" y2="${T + ih}"/>`;
        const room = Math.abs(lastL - px) > 9 + 6.2 * (m.label || "").length;
        if (m.label && room) lastL = px;
        if (m.label && room) mk += `<text class="tl-mk-t${m.cls ? ` ${m.cls}` : ""}" x="${px}" y="${T - 9}" text-anchor="${px > W - 50 ? "end" : px < L + 30 ? "start" : "middle"}">${E(m.label)}</text>`;
      }
      const svg = `<svg class="tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${yGrid(ticks.filter((t) => t >= t0 && t <= t1), y, L, W - R, axis)}${mk}`
        + `<g class="tl-plot">${plot}</g><g class="tl-hov"></g>${xLabels(n, x, label, iw, H - 6)}</svg>`;
      const hover = (mxp) => {
        const i = clamp(Math.round(((mxp - L) / iw) * (n - 1)), 0, n - 1);
        if (mxp < L - 10 || mxp > W) return null;
        const px = f1(x(i));
        const dots = series.filter((s) => isNum(s.vals[i])).map((s) => `<circle class="tl-c${s.c} tl-dot" cx="${px}" cy="${f1(y(clamp(s.vals[i], t0, t1)))}" r="3.5"/>`).join("");
        const ex = marks.filter((m) => m.i === i && m.tip).map((m) => `<div class="tl-tt-note">${E(m.tip)}</div>`).join("");
        return { g: `<line class="tl-guide" x1="${px}" x2="${px}" y1="${T}" y2="${T + ih}"/>${dots}`,
          html: `<div class="tl-tt-h">${E(head(i))}</div>${series.map((s) => tipRow(s.c, s.label, fmt(s.vals[i]))).join("")}${ex}` };
      };
      return { svg, hover };
    };
  }

  // latency vs context: dots + a binned median line; log time axis
  function scatter(pts, H = 260) {
    return (W) => {
      const L = 50, R = 10, T = 12, B = 24, iw = W - L - R, ih = H - T - B;
      const xs = pts.map((p) => p[0]), xt = nice(0, Math.max(...xs, 1), Math.max(3, Math.floor(iw / 110)));
      const x1 = xt[xt.length - 1];
      const ys = pts.map((p) => p[1]).filter((v) => v > 0);
      const lo = 10 ** Math.floor(Math.log10(Math.min(...ys, 1000))), hi = 10 ** Math.ceil(Math.log10(Math.max(...ys, 2000)));
      const yt = [];
      for (let d = lo; d <= hi; d *= 10) for (const m of [1, 2, 5]) if (d * m >= lo && d * m <= hi) yt.push(d * m);
      const ly = (v) => T + ih - ((Math.log10(clamp(v, lo, hi)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * ih;
      const x = (v) => L + (v / x1) * iw;
      let d = "";
      for (const [c, t] of pts) if (t > 0) d += `M${f1(x(c))},${f1(ly(t))}h0`;
      const bins = 18, bw = x1 / bins, med = [];
      for (let b = 0; b < bins; b++) {
        const v = pts.filter((p) => p[0] >= b * bw && p[0] < (b + 1) * bw && p[1] > 0).map((p) => p[1]).sort((a, c) => a - c);
        if (v.length >= 8) med.push([(b + 0.5) * bw, v[Math.floor(v.length / 2)]]);
      }
      const ml = med.map(([c, t], i) => `${i ? "L" : "M"}${f1(x(c))},${f1(ly(t))}`).join("");
      const svg = `<svg class="tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${yGrid(yt, ly, L, W - R, msAxis)}`
        + `<g class="tl-plot"><path class="tl-c0 tl-dots" d="${d}"/>${ml ? `<path class="tl-c2 tl-line" pathLength="1" d="${ml}"/>` : ""}</g><g class="tl-hov"></g>`
        + xt.map((t, i) => `<text class="tl-ax" x="${f1(x(t))}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === xt.length - 1 ? "end" : "middle"}">${E(num(t))}</text>`).join("") + `</svg>`;
      const hover = (mx, my) => {
        let best = null, bd = 196;
        for (const p of pts) { const dx = x(p[0]) - mx, dy = ly(p[1]) - my, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = p; } }
        if (!best) return null;
        return { g: `<circle class="tl-c0 tl-dot" cx="${f1(x(best[0]))}" cy="${f1(ly(best[1]))}" r="4.5"/>`,
          html: `<div class="tl-tt-h">One request</div>${tipRow(null, "Context", `${num(best[0])} tokens`)}${tipRow(null, "Total time", ms(best[1]))}` };
      };
      return { svg, hover };
    };
  }

  // ── tooltip (one, shared) ─────────────────────────────────────────────────
  const tip = h("div", "tl-tip");
  tip.setAttribute("role", "tooltip"); // lives in the view (inherits its series vars), appended below
  let tipOwner = null;
  function showTip(html, cx, cy) {
    tip.innerHTML = html;
    tip.classList.add("on");
    const r = tip.getBoundingClientRect(), pad = 12;
    let left = cx + 16, top = cy + 16;
    if (left + r.width > innerWidth - pad) left = cx - r.width - 16;
    if (top + r.height > innerHeight - pad) top = cy - r.height - 16;
    tip.style.transform = `translate(${Math.round(clamp(left, pad, innerWidth - r.width - pad))}px, ${Math.round(Math.max(pad, top))}px)`;
  }
  function hideTip() {
    tip.classList.remove("on");
    if (tipOwner) { const g = tipOwner.querySelector(".tl-hov"); if (g) g.innerHTML = ""; tipOwner = null; }
  }
  document.addEventListener("pointerdown", (e) => { if (tipOwner && !tipOwner.contains(e.target)) hideTip(); }, true);

  // draw a chart into a box at its current width; hover wiring survives redraws
  // label: a one-line summary for screen readers (the data otherwise lives in
  // pointer-only tooltips)
  function plot(box, make, label) {
    box._make = make;
    const W = Math.max(240, Math.floor(box.clientWidth));
    const { svg, hover } = make(W);
    box.innerHTML = svg;
    const el = box.querySelector("svg");
    if (el && label) { el.setAttribute("role", "img"); el.setAttribute("aria-label", label); }
    box._hover = hover;
    box._w = W;
    if (box._wired) return;
    box._wired = true;
    const move = (e) => {
      const s = box.querySelector("svg");
      if (!s || !box._hover) return;
      const r = s.getBoundingClientRect(), res = box._hover(e.clientX - r.left, e.clientY - r.top);
      if (!res) { if (tipOwner === box) hideTip(); return; }
      if (tipOwner && tipOwner !== box) hideTip();
      tipOwner = box;
      s.querySelector(".tl-hov").innerHTML = res.g;
      showTip(res.html, e.clientX, e.clientY);
    };
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerdown", move);
    box.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch" && tipOwner === box) hideTip(); });
  }

  // ── horizontal bars (HTML: crisp text, easy to wrap) ──────────────────────
  function hbars(rows, { fmt = int, total, cls = () => 0, sub } = {}) {
    const max = Math.max(...rows.map((r) => r.v), 1);
    return `<div class="tl-hb">${rows.map((r, i) => `<div class="tl-hb-r${r.flag ? ` ${r.flag}` : ""}" style="--i:${i}">
      <div class="tl-hb-k"><span>${E(r.k)}</span><b>${E(fmt(r.v))}${total ? `<em>${E(pct((r.v / total) * 100, r.v / total < 0.01 ? 2 : 1))}</em>` : ""}</b></div>
      <div class="tl-hb-t"><div class="tl-hb-f tl-c${cls(r, i)}" style="width:${Math.max(0.6, (r.v / max) * 100).toFixed(2)}%"></div></div>
      ${sub ? `<div class="tl-hb-s">${E(sub(r))}</div>` : ""}</div>`).join("")}</div>`;
  }

  // ── segmented control (same look as Settings) ─────────────────────────────
  function seg(options, value, onPick, label) {
    const wrap = h("div", "seg tl-seg");
    wrap.setAttribute("role", "radiogroup");
    if (label) wrap.setAttribute("aria-label", label);
    const thumb = h("div", "seg-thumb");
    wrap.append(thumb);
    const place = () => {
      const a = wrap.querySelector(".seg-opt.on");
      if (!a || !a.offsetWidth) { thumb.style.opacity = "0"; return; }
      thumb.style.opacity = "1";
      thumb.style.width = `${a.offsetWidth}px`;
      thumb.style.transform = `translateX(${a.offsetLeft - 3}px)`;
    };
    for (const [val, text] of options) {
      const b = h("button", `seg-opt${val === value ? " on" : ""}`, text);
      b.type = "button";
      b.dataset.v = val;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(val === value));
      b.onclick = () => {
        if (b.classList.contains("on")) return;
        wrap.querySelectorAll(".seg-opt").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
        place();
        onPick(val);
      };
      wrap.append(b);
    }
    wrap._place = () => { wrap.classList.add("no-anim"); place(); requestAnimationFrame(() => wrap.classList.remove("no-anim")); };
    return wrap;
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  const root = h("section", "tl hidden");
  root.id = "telemetry";
  root.tabIndex = -1;
  root.setAttribute("aria-label", "Telemetry");
  const SECS = [["live", "Live"], ["money", "Money"], ["cache", "Cache"], ["latency", "Latency"], ["sessions", "Sessions"], ["health", "Health"]];
  root.innerHTML = `
    <header class="tl-head">
      <div class="tl-bar">
        <button class="icon-btn tl-rail" type="button" title="Toggle sessions" aria-label="Toggle sessions">${ic("rail")}</button>
        <div class="tl-title"><span class="tl-mark">${ic("chart")}</span><h1>Telemetry</h1><span class="chip tl-usd" title="Estimated from API list prices — not what you were billed">API-equivalent USD</span></div>
        <span class="tl-pulse" title="Live strip refreshes every 10s while this view is open"><span class="dot"></span><span class="tl-pulse-t">live</span></span>
        <button class="icon-btn tl-close" type="button" title="Back to session (Esc)" aria-label="Back to session">${ic("x")}</button>
      </div>
      <div class="tl-sub">
        <nav class="tl-tabs" aria-label="Telemetry sections"><div class="tl-tab-ind"></div>${SECS.map(([k, t]) => `<button type="button" class="tl-tab" data-sec="${k}">${t}</button>`).join("")}</nav>
        <div class="tl-filters"></div>
      </div>
    </header>
    <div class="tl-body">
      <section class="tl-sec" data-sec="live"><div class="tl-strip" data-p="live"></div></section>
      <section class="tl-sec" data-sec="money">
        <div class="tl-sec-h"><h2>Money</h2><div class="tl-headline" data-p="headline"></div></div>
        <div class="tl-grid">
          <article class="tl-card w12" data-p="spend"><header><div><h3>Spend per day</h3><p class="tl-spend-sub">API-equivalent USD</p></div><div class="tl-ctl tl-group"></div></header><div class="tl-pb"></div></article>
          <article class="tl-card w12" data-p="agents"><header><div><h3>Top agents</h3><p>Worker runs by agent · API-equivalent USD</p></div></header><div class="tl-pb"></div></article>
        </div>
      </section>
      <section class="tl-sec" data-sec="cache">
        <div class="tl-sec-h"><h2>Cache</h2></div>
        <div class="tl-grid">
          <article class="tl-card w8" data-p="hit"><header><div><h3>Hit rate per day</h3><p>cache_read ÷ prompt tokens · Synaps releases marked</p></div></header><div class="tl-pb"></div></article>
          <article class="tl-card w4" data-p="keepwarm"><header><div><h3>Keep-warm pings</h3><p>What pinging the cache costs vs what it saves</p></div></header><div class="tl-pb"></div></article>
          <article class="tl-card w7" data-p="writes"><header><div><h3>Cache writes</h3><p>Tokens written per day, by TTL</p></div></header><div class="tl-pb"></div></article>
          <article class="tl-card w5" data-p="miss"><header><div><h3>Why the cache missed</h3><p>Miss reasons, all requests in range</p></div></header><div class="tl-pb"></div></article>
        </div>
      </section>
      <section class="tl-sec" data-sec="latency">
        <div class="tl-sec-h"><h2>Latency</h2></div>
        <div class="tl-grid">
          <article class="tl-card w6" data-p="ttft"><header><div><h3>Time to first token</h3><p>p50 · p95 · p99 per day</p></div></header><div class="tl-pb"></div></article>
          <article class="tl-card w6" data-p="total"><header><div><h3>Total request time</h3><p>p50 · p95 per day</p></div></header><div class="tl-pb"></div></article>
          <article class="tl-card w5" data-p="split"><header><div><h3>Where the time goes</h3><p>Median request, headers → first event → stream</p></div></header><div class="tl-pb"></div></article>
          <article class="tl-card w7" data-p="scatter"><header><div><h3>Latency vs context</h3><p>Sampled requests · median line</p></div></header><div class="tl-pb"></div></article>
        </div>
      </section>
      <section class="tl-sec" data-sec="sessions">
        <div class="tl-sec-h"><h2>Sessions</h2></div>
        <div class="tl-grid">
          <article class="tl-card w12 tl-sess" data-p="sessions">
            <header><div><h3>All sessions</h3><p class="tl-sess-sub">Click a row for its request timeline</p></div>
              <div class="tl-ctl"><label class="tl-search">${ic("search")}<input type="search" placeholder="Search title or id" aria-label="Search sessions" autocomplete="off" /><kbd>/</kbd></label></div></header>
            <div class="tl-pb"></div>
          </article>
        </div>
      </section>
      <section class="tl-sec" data-sec="health">
        <div class="tl-sec-h"><h2>Health</h2></div>
        <div class="tl-grid">
          <article class="tl-card w12" data-p="heatmap"><header><div><h3>When the agents work</h3><p class="tl-heat-sub">Requests by hour × weekday, local time</p></div><div class="tl-ctl tl-heat-peak"></div></header><div class="tl-pb"></div></article>
          <article class="tl-card w7" data-p="stops"><header><div><h3>Stop reasons</h3><p>Anomalies highlighted: refusal · max_tokens · no stop reason</p></div></header><div class="tl-pb"></div></article>
          <article class="tl-card w5" data-p="ingest"><header><div><h3>Ingest</h3><p>The telemetry store's own health</p></div></header><div class="tl-pb"></div></article>
        </div>
      </section>
      <footer class="tl-foot">Money is an API-equivalent estimate at list prices, not a bill. “—” means no data.</footer>
    </div>
    <div class="tl-scrim hidden"></div>
    <aside class="tl-detail hidden" role="dialog" aria-modal="true" aria-label="Session detail"></aside>`;
  $("main").append(root);
  root.append(tip);
  const q = (s) => root.querySelector(s);
  const body = q(".tl-body");
  const P = {};
  root.querySelectorAll("[data-p]").forEach((el) => { P[el.dataset.p] = { el, box: el.classList.contains("tl-card") ? el.querySelector(".tl-pb") : el }; });
  root.querySelectorAll(".tl-card").forEach((c, i) => c.style.setProperty("--i", i));

  // ── series palette: the album's tokens, most-distinct first ──────────────
  // Albums often offer only ~3 distinct hues (primary ≈ accent ≈ warning). Pick
  // six series colours greedily by oklab distance from the raw tokens AND
  // lighter/darker mixes of them (toward --text / --bg), so stacked bands stay
  // tellable apart. The vars are color-mix() over the tokens, so a track change
  // still cross-fades every chart; the picks are redone once the fade lands.
  // --error is a hue source too: on a near-monochrome album it's often the only
  // other hue there is (greedy order means it's picked only when it's needed)
  const CANDS = ["--primary", "--secondary", "--success", "--info", "--accent", "--warning", "--error"];
  function oklab(css) {
    const m = String(css).match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const [r, g, b] = m.slice(0, 3).map((v) => { v = +v / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s];
  }
  const mixLab = (a, b, k) => a.map((v, i) => v * k + b[i] * (1 - k)); // == color-mix(in oklab, a k%, b)
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  function assignSeries() {
    const cs = getComputedStyle(document.documentElement);
    const text = oklab(cs.getPropertyValue("--text")), bg = oklab(cs.getPropertyValue("--bg"));
    const toks = CANDS.map((n) => [n, oklab(cs.getPropertyValue(n))]).filter((x) => x[1]);
    if (toks.length < 2 || !text || !bg) return;
    const pool = [];
    for (const [n, lab] of toks) {
      pool.push({ css: `var(${n})`, lab });
      pool.push({ css: `color-mix(in oklab, var(${n}) 35%, var(--text))`, lab: mixLab(lab, text, 0.35) });
      pool.push({ css: `color-mix(in oklab, var(${n}) 65%, var(--text))`, lab: mixLab(lab, text, 0.65) });
      pool.push({ css: `color-mix(in oklab, var(${n}) 45%, var(--bg))`, lab: mixLab(lab, bg, 0.45) });
    }
    const muted = oklab(cs.getPropertyValue("--muted"));
    if (muted) pool.push({ css: "var(--muted)", lab: muted });
    const usable = pool.filter((c) => Math.abs(c.lab[0] - bg[0]) > 0.16); // never near-invisible on the background
    const out = [usable.shift()];
    while (out.length < 6 && usable.length) {
      let bi = 0, bs = -1;
      usable.forEach((c, i) => { const sc = Math.min(...out.map((o) => dist(o.lab, c.lab))); if (sc > bs) { bs = sc; bi = i; } });
      out.push(usable.splice(bi, 1)[0]);
    }
    out.forEach((c, i) => root.style.setProperty(`--s${i}`, c.css));
    root.dataset.series = out.map((c) => c.lab.map((v) => v.toFixed(3)).join(",")).join(" "); // test hook: picked colours
  }
  let palT = 0;
  new MutationObserver(() => {
    clearTimeout(palT);
    palT = setTimeout(assignSeries, (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fade")) || 600) + 60); // after the cross-fade lands
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

  // filters
  const RANGES = [["7", "7d"], ["30", "30d"], ["90", "90d"], ["all", "All"]];
  const pickHost = (v) => { st.host = v; st.offset = 0; loadAll(); };
  let hostSeg = seg([["", "All hosts"]], st.host, pickHost, "Host");
  let hosts = [];
  // hosts come from the store (health.ingest.sources), not a hardcoded list
  // + "unknown": sessions whose origin host the store couldn't decide are a
  // filter value of their own (and a spend?group=host series)
  function setHosts(list) {
    list = list.filter((x) => x !== "unknown").sort();
    if (list.length >= 2) list.push("unknown");
    if (list.join() === hosts.join()) return;
    hosts = list;
    const next = seg([["", "All hosts"], ...list.map((x) => [x, x === "unknown" ? "unknown" : x])], st.host, pickHost, "Host");
    next.querySelector('.seg-opt[data-v="unknown"]')?.setAttribute("title", "Sessions whose origin host couldn't be decided");
    next.classList.add("tl-host");
    next.classList.toggle("hidden", list.length < 2 && !st.host);
    hostSeg.replaceWith(next);
    segs[segs.indexOf(hostSeg)] = next;
    hostSeg = next;
    requestAnimationFrame(() => next._place());
  }
  const rangeSeg = seg(RANGES, st.range, (v) => { st.range = v; st.offset = 0; loadAll(false); }, "Range");
  hostSeg.classList.add("tl-host", "hidden");
  rangeSeg.classList.add("tl-range");
  q(".tl-filters").append(hostSeg, rangeSeg);
  const groupSeg = seg([["model", "Model"], ["role", "Main vs worker"], ["host", "Host"]], st.group, (v) => { st.group = v; load("spend"); }, "Group by");
  q(".tl-group").append(groupSeg);
  const segs = [hostSeg, rangeSeg, groupSeg];

  // ── data ──────────────────────────────────────────────────────────────────
  function range() {
    if (st.range === "all") return {};
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (Number(st.range) - 1));
    return { from: d.getTime() };
  }
  const qs = (o) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
    const s = u.toString();
    return s ? `?${s}` : "";
  };
  const host = () => ({ host: st.host || undefined });
  const EP = {
    summary: { url: () => `/summary${qs(host())}`, panels: ["live", "headline"] },
    spend: { url: () => `/spend${qs({ bucket: "day", group: st.group, ...range(), ...host() })}`, panels: ["spend"] },
    agents: { url: () => `/agents${qs({ ...range(), ...host() })}`, panels: ["agents"] },
    cache: { url: () => `/cache${qs({ ...range(), ...host() })}`, panels: ["hit", "keepwarm", "writes", "miss"] },
    latency: { url: () => `/latency${qs({ ...range(), ...host() })}`, panels: ["ttft", "total", "split", "scatter"] },
    sessions: { url: () => `/sessions${qs({ sort: st.sort, limit: st.limit, offset: st.offset, q: st.q, ...range(), ...host() })}`, panels: ["sessions"] },
    heatmap: { url: () => `/heatmap${qs({ ...range(), ...host() })}`, panels: ["heatmap"] },
    health: { url: () => `/health${qs({ ...range(), ...host() })}`, panels: ["stops", "ingest"] }, // stops follow the range; ingest isn't ranged
  };
  // One in-flight request per endpoint: a newer load aborts the older one, close()
  // aborts everything, and nothing waits longer than 15s. A hung store must not
  // pin the browser's per-host connection pool (6 over HTTP/1.1, e.g. a tunnel).
  const TIMEOUT_MS = 15000;
  const inflight = new Map();
  async function get(path, key) {
    if (key) inflight.get(key)?.abort(new DOMException("superseded", "AbortError"));
    const ctl = new AbortController();
    if (key) inflight.set(key, ctl);
    const timer = setTimeout(() => ctl.abort(new DOMException(`timed out after ${TIMEOUT_MS / 1000}s`, "TimeoutError")), TIMEOUT_MS);
    try {
      return await fetchJson(path, ctl.signal);
    } catch (e) {
      throw ctl.signal.aborted ? ctl.signal.reason : e;
    } finally {
      clearTimeout(timer);
      if (key && inflight.get(key) === ctl) inflight.delete(key);
    }
  }
  const abortAll = () => { for (const c of inflight.values()) c.abort(new DOMException("closed", "AbortError")); inflight.clear(); };
  async function fetchJson(path, signal) {
    const r = await fetch(API + path, { headers: { accept: "application/json" }, credentials: "same-origin", signal });
    if (!r.ok) {
      let msg = "";
      try { msg = (await r.json())?.error || ""; } catch {}
      throw new Error(`HTTP ${r.status}${msg ? ` · ${msg}` : r.statusText ? ` ${r.statusText}` : ""}`);
    }
    return r.json();
  }
  const SKEL = { live: "strip", headline: "line", spend: 290, agents: 220, hit: 240, keepwarm: 240, writes: 230, miss: 230, ttft: 230, total: 230, split: 200, scatter: 270, sessions: 420, heatmap: 260, stops: 220, ingest: 220 };
  function skeleton(id) {
    const { box, el } = P[id];
    el.classList.remove("is-err");
    el.classList.add("is-loading");
    const k = SKEL[id];
    if (k === "strip") box.innerHTML = Array.from({ length: 6 }, () => `<div class="tl-tile"><div class="tl-skel w40"></div><div class="tl-skel big"></div><div class="tl-skel w60"></div></div>`).join("");
    else if (k === "line") box.innerHTML = `<div class="tl-skel w-hl"></div>`;
    else box.innerHTML = `<div class="tl-skel blk" style="height:${k}px"></div>`;
  }
  function fail(id, ep, err) {
    const { box, el } = P[id];
    el.classList.remove("is-loading");
    el.classList.add("is-err");
    if (id === "headline") { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="tl-err" role="status" aria-live="polite">${ic("warn")}<div><b>Couldn't load this panel</b><span>${E(`/api/telemetry/${ep} — ${err?.message || err}`)}</span></div><button type="button" class="btn-ghost tl-retry">${ic("retry")}Retry</button></div>`;
    box.querySelector(".tl-retry").onclick = () => load(ep);
  }
  async function load(ep, quiet = false) {
    const seq = (st.seq[ep] = (st.seq[ep] || 0) + 1);
    const def = EP[ep];
    if (!quiet || !st.data[ep]) for (const id of def.panels) skeleton(id);
    else for (const id of def.panels) P[id].el.classList.add("is-busy");
    try {
      const d = await get(def.url(), ep);
      if (seq !== st.seq[ep]) return;
      st.data[ep] = d;
      st.err[ep] = null;
      for (const id of def.panels) draw(id);
    } catch (e) {
      if (seq !== st.seq[ep] || e?.name === "AbortError") return; // superseded or closed: not an error
      st.err[ep] = e;
      if (quiet && st.data[ep] && ep === "summary") { for (const id of def.panels) P[id].el.classList.remove("is-busy"); return; } // a failed background poll keeps the last good numbers
      for (const id of def.panels) fail(id, ep, e);
    }
  }
  // range/host changes: keep what's on screen and swap when the new data lands,
  // unless there's nothing yet (then skeletons)
  function loadAll(withSummary = true) {
    for (const ep of Object.keys(EP)) if (withSummary || ep !== "summary") load(ep, !!st.data[ep]);
  }

  // ── panels ────────────────────────────────────────────────────────────────
  let animate = true; // false on resize redraws: no entrance replays
  function draw(id, still = false) {
    const p = P[id];
    p.el.classList.remove("is-loading", "is-err", "is-busy");
    p.el.classList.toggle("tl-still", still || !animate);
    try { DRAW[id](p.box, p); } catch (e) { console.error(e); fail(id, Object.keys(EP).find((k) => EP[k].panels.includes(id)), e); }
  }
  const empty = (box, msg) => { box.innerHTML = `<div class="tl-empty">${E(msg)}</div>`; };
  function tween(el, to, fmt) {
    const from = el._v;
    el._v = to;
    if (!isNum(to) || !isNum(from) || from === to || !motion()) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), d = 650;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - k, 4);
      if (el._v !== to) return;
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const ring = (v) => {
    const r = 15, c = 2 * Math.PI * r, k = isNum(v) ? clamp(v / 100, 0, 1) : 0;
    return `<svg class="tl-ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="${r}" class="tl-ring-bg"/><circle cx="18" cy="18" r="${r}" class="tl-ring-fg" stroke-dasharray="${f1(c * k)} ${f1(c)}" transform="rotate(-90 18 18)"/></svg>`;
  };
  const DRAW = {
    live(box) {
      const n = st.data.summary?.now || {};
      const tiles = [
        ["spend", "Spend today", n.spend_today, usd, "API-equivalent"],
        ["burn", "Burn rate", n.burn_rate_per_hour, (v) => (isNum(v) ? `${usd(v)}/h` : DASH), "last hour"],
        ["req", "Requests today", n.requests_today, int, "since midnight"],
        ["hit", "Cache hit · 1h", n.hit_pct_1h, (v) => pct(v), "of prompt tokens"],
        ["ttft", "TTFT p50 · 1h", n.ttft_p50_ms_1h, ms, `total p50 ${ms(n.total_p50_ms_1h)}`],
        ["live", "Live now", n.live_sessions, int, !isNum(n.live_sessions) && !isNum(n.live_workers) ? "not tracked yet"
          : `sessions · ${int(n.live_workers)} worker${n.live_workers === 1 ? "" : "s"}`],
      ];
      if (!box.querySelector(".tl-tile[data-k]")) box.innerHTML = tiles.map(([k, l], i) => `<div class="tl-tile" data-k="${k}" style="--i:${i}"><div class="tl-tile-l">${l}</div><div class="tl-tile-v"><span></span></div><div class="tl-tile-s"></div></div>`).join("");
      for (const [k, , v, fmt, sub] of tiles) {
        const t = box.querySelector(`[data-k="${k}"]`);
        tween(t.querySelector(".tl-tile-v span"), v, fmt);
        t.classList.toggle("nil", !isNum(v));
        t.querySelector(".tl-tile-s").textContent = sub;
        if (k === "hit") { const old = t.querySelector(".tl-ring"); if (old) old.remove(); t.querySelector(".tl-tile-v").insertAdjacentHTML("beforeend", ring(v)); }
      }
      const g = st.data.summary?.generated_at;
      q(".tl-pulse").title = `Live strip refreshes every 10s while this view is open${isNum(g) ? ` · data as of ${new Date(g).toLocaleTimeString()}` : ""}`;
    },
    headline(box) {
      const a = st.data.summary?.all || {};
      const since = isNum(a.first_ts) ? new Date(a.first_ts).toLocaleDateString([], { month: "long", ...(new Date(a.first_ts).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }) : null;
      // net = gross minus the write premium caching costs; gross on hover, labelled as gross
      const net = isNum(a.saved_by_cache_net) ? a.saved_by_cache_net : null;
      const savedTitle = `Gross: ${usd(a.saved_by_cache)} (every cache read billed as fresh input, minus actual).${net != null ? ` Net subtracts the cache-write premium.` : ""}`;
      box.innerHTML = `<span class="tl-hl-g"><span class="tl-hl-k">${since ? `since ${E(since)}` : "all time"}</span> <b class="tl-hl-v">${E(usd(a.spend))}</b></span>`
        + `<span class="tl-hl-g" title="${E(savedTitle)}"><span class="tl-hl-k">cache saved${net != null ? " (net)" : " (gross)"}</span> <b class="tl-hl-v ok">${E(usd(net ?? a.saved_by_cache))}</b></span>`
        + `<span class="tl-hl-g"><span class="tl-hl-k">${E(num(a.requests))} requests · ${E(num(a.sessions))} sessions</span></span>`;
    },
    spend(box) {
      const d = st.data.spend;
      const ser = (d?.series || []).map((s) => ({ key: s.key, vals: s.points.map((p) => p[1]), tot: s.points.reduce((a, p) => a + (p[1] || 0), 0) }));
      const days = d?.series?.[0]?.points.map((p) => p[0]) || [];
      if (!days.length || !ser.length) return empty(box, "No spend in this range.");
      const ORDER = { main: 0, worker: 1, bella: 0, jade: 1, unknown: 8 };
      ser.sort((a, b) => (d.group === "model" ? b.tot - a.tot : (ORDER[a.key] ?? 9) - (ORDER[b.key] ?? 9)));
      // six colours: the long tail (old/rare models) folds into one "Other" band
      if (ser.length > 6) {
        const tail = ser.splice(5);
        ser.push({ key: "__other", vals: days.map((_, i) => tail.reduce((a, s) => a + (s.vals[i] || 0), 0)), tot: tail.reduce((a, s) => a + s.tot, 0), n: tail.length });
      }
      const label = (k) => (k === "__other" ? `Other (${ser.find((x) => x.key === k).n})` : d.group === "role" ? (k === "main" ? "Main sessions" : k === "worker" ? "Workers" : k) : d.group === "model" ? shortModel(k) : k === "unknown" ? "unknown host" : k);
      ser.forEach((s, i) => { s.c = i % 6; s.label = label(s.key); });
      const sw = (d.grain || []).find((g) => g[1] === "request");
      const marker = sw ? { day: sw[0], left: "session-level", right: "request-level →", allBefore: true } : null;
      const total = ser.reduce((a, s) => a + s.tot, 0);
      q(".tl-spend-sub").textContent = `${usd(total)} in ${st.range === "all" ? "all time" : `the last ${st.range} days`} · API-equivalent USD`;
      box.innerHTML = `<div class="tl-chart"></div><div class="tl-legend">${ser.map((s) => `<span class="tl-lg"><i class="tl-c${s.c}"></i>${E(s.label)}<b>${E(usd(s.tot))}</b><em>${E(pct(total ? (s.tot / total) * 100 : null, 0))}</em></span>`).join("")}${marker && days[0] < marker.day && days.includes(marker.day) ? `<span class="tl-lg tl-lg-mk"><i></i>data grain switches ${E(dShort(marker.day))}</span>` : ""}</div>`;
      const ch = box.querySelector(".tl-chart");
      ch.dataset.n = days.length;
      const tot = days.map((_, i) => ser.reduce((a, x) => a + (x.vals[i] || 0), 0)), pk = tot.indexOf(Math.max(...tot));
      plot(ch, stack({ days, series: ser, fmt: usd, axis: usdAxis, H: 260, marker }),
        `Spend per day, ${days.length} days, ${usd(total)} total (API-equivalent), peak ${dShort(days[pk])} ${usd(tot[pk])}; ${ser.map((x) => `${x.label} ${usd(x.tot)}`).join(", ")}`);
    },
    agents(box) {
      const raw = st.data.agents?.agents || [];
      if (!raw.length) return empty(box, "No worker runs in this range.");
      // spend/requests stay null until api-log rows carry worker identity: rank by runs then
      const bySpend = raw.some((a) => isNum(a.spend));
      const val = (a) => (bySpend ? a.spend : a.runs) || 0;
      const ag = raw.slice().sort((a, b) => val(b) - val(a));
      const max = Math.max(...ag.map(val), 1);
      P.agents.el.querySelector("header p").textContent = bySpend ? "Worker runs by agent · API-equivalent USD" : "Worker runs by agent · ranked by runs";
      box.innerHTML = `<div class="tl-tw"><table class="tl-table"><thead><tr><th>Agent</th><th class="num">Runs</th><th class="num">Requests</th><th class="num">Spend</th><th class="tl-bar-col"></th><th class="hide-sm">Models</th></tr></thead><tbody>${ag.slice(0, 12).map((a, i) => `<tr style="--i:${i}">
        <td><span class="tl-agent">${E(a.name)}</span></td><td class="num">${int(a.runs)}</td><td class="num">${num(a.requests)}</td><td class="num${isNum(a.spend) ? " strong" : " dim"}">${usd(a.spend)}</td>
        <td class="tl-bar-col"><div class="tl-mini"><div class="tl-c0" style="width:${((val(a) / max) * 100).toFixed(1)}%"></div></div></td>
        <td class="hide-sm">${(a.models || []).map((m) => `<span class="tl-tag">${E(shortModel(m))}</span>`).join("") || `<span class="dim">${DASH}</span>`}</td></tr>`).join("")}</tbody></table></div>
        ${raw.every((a) => !isNum(a.spend)) ? `<div class="tl-pending">${ic("clock")}<span>Per-agent requests and spend arrive with the Synaps telemetry PR, once api-log rows carry the worker's identity.</span></div>` : ""}`;
    },
    hit(box) {
      const d = st.data.cache?.daily || [];
      if (!d.length) return empty(box, "No cache data in this range.");
      const days = d.map((x) => x.day), vals = d.map((x) => x.hit_pct);
      const ok = vals.filter(isNum);
      const marks = (st.data.cache.releases || []).map((r) => ({ i: days.indexOf(ymd(new Date(r.ts))), label: r.tag, tip: `Synaps ${r.tag} released ${tsLong(r.ts)}` })).filter((m) => m.i >= 0);
      const cut = d.findIndex((x) => x.grain === "request" || x.grain === "mixed");
      if (cut > 0) marks.push({ i: cut, label: "", cls: "grain", tip: "Request-level data from here; before: synaps.log totals" });
      const lo = ok.length ? Math.max(0, Math.floor(Math.min(...ok) - 0.6)) : 0;
      const avg = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
      const lastD = d[d.length - 1];
      box.innerHTML = `<div class="tl-kpis"><div><span>${E(dShort(lastD.day))}</span><b>${pct(lastD.hit_pct)}</b></div><div><span>average</span><b>${pct(avg)}</b></div><div><span>lowest</span><b>${pct(ok.length ? Math.min(...ok) : null)}</b></div></div><div class="tl-chart"></div>`;
      plot(box.querySelector(".tl-chart"), lines({ n: days.length, series: [{ label: "Hit rate", vals, c: 0 }], fmt: (v) => pct(v), axis: (v) => `${trim0(v.toFixed(1))}%`, label: (i) => dShort(days[i]), head: (i) => dLong(days[i]), lo, hi: 100, marks, H: 210 }),
        `Cache hit rate per day, ${days.length} days: ${dShort(lastD.day)} ${pct(lastD.hit_pct)}, average ${pct(avg)}, lowest ${pct(ok.length ? Math.min(...ok) : null)}`);
    },
    keepwarm(box) {
      const k = st.data.cache?.keepwarm;
      if (!k || !isNum(k.pings) || k.pings <= 0) return empty(box, "No keep-warm pings in this range.");
      const max = Math.max(k.cost || 0, k.est_saved || 0, 0.0001);
      const roi = isNum(k.cost) && isNum(k.est_saved) && k.cost > 0 ? k.est_saved / k.cost : null;
      const net = isNum(k.cost) && isNum(k.est_saved) ? k.est_saved - k.cost : null;
      box.innerHTML = `<div class="tl-kw">
        <div class="tl-kw-big"><b class="${isNum(net) && net < 0 ? "bad" : "ok"}">${roi != null ? `${roi.toFixed(1)}×` : DASH}</b><span>return on ${int(k.pings)} pings</span></div>
        <div class="tl-kw-bars">
          <div class="tl-kw-r"><span>Cost</span><div class="tl-hb-t"><div class="tl-hb-f tl-cw" style="width:${(((k.cost || 0) / max) * 100).toFixed(1)}%"></div></div><b>${usd(k.cost)}</b></div>
          <div class="tl-kw-r"><span>Saved</span><div class="tl-hb-t"><div class="tl-hb-f tl-cs" style="width:${(((k.est_saved || 0) / max) * 100).toFixed(1)}%"></div></div><b>${usd(k.est_saved)}</b></div>
        </div>
        <div class="tl-kw-net">Net ${isNum(net) ? `${net >= 0 ? "+" : "−"}${usd(Math.abs(net))}` : DASH} · ${isNum(k.pings) && k.pings ? `${usd((k.cost || 0) / k.pings)} per ping` : DASH} · estimated</div></div>`;
    },
    writes(box) {
      const d = st.data.cache?.daily || [];
      if (!d.length) return empty(box, "No cache writes in this range.");
      const days = d.map((x) => x.day);
      // writes with no TTL split (legacy log lines, api-log rows without 5m/1h):
      // write_unknown; older stores only sent `write` on legacy days
      const unk = (x) => (isNum(x.write_unknown) ? x.write_unknown : x.grain === "legacy" && !isNum(x.write_5m) && !isNum(x.write_1h) && isNum(x.write) ? x.write : null);
      const series = [{ label: "1h TTL", vals: d.map((x) => x.write_1h), c: 0 }, { label: "5m TTL", vals: d.map((x) => x.write_5m), c: 1 }];
      if (d.some((x) => isNum(unk(x)) && unk(x) > 0)) series.push({ label: "TTL unknown", vals: d.map(unk), c: 2 });
      const sum = (v) => v.reduce((a, b) => a + (b || 0), 0);
      const legacy = (x) => x.grain === "legacy";
      const cut = d.find((x) => x.grain === "request" || x.grain === "mixed")?.day;
      box.innerHTML = `<div class="tl-chart"></div><div class="tl-legend">${series.map((x) => `<span class="tl-lg"><i class="tl-c${x.c}"></i>${E(x.label)}<b>${num(sum(x.vals))}</b><em>tokens</em></span>`).join("")}</div>`;
      plot(box.querySelector(".tl-chart"), stack({ days, series, fmt: (v) => `${num(v)} tokens`, axis: num, H: 200, marker: cut && d.some(legacy) ? { day: cut, left: "legacy log", right: "request-level →" } : null }),
        `Cache writes per day, ${days.length} days: ${series.map((x) => `${x.label} ${num(sum(x.vals))} tokens`).join(", ")}`);
    },
    miss(box) {
      const m = (st.data.cache?.miss_reasons || []).slice().sort((a, b) => b.count - a.count);
      if (!m.length) return empty(box, "No cache misses recorded.");
      const total = m.reduce((a, r) => a + r.count, 0);
      box.innerHTML = hbars(m.map((r) => ({ k: String(r.reason ?? "unknown").replace(/_/g, " "), v: r.count })), { total, cls: (r, i) => (i === 0 ? 0 : 1) })
        + `<div class="tl-note">${int(total)} misses with a reason, in range</div>`;
    },
    ttft(box) {
      const d = st.data.latency?.daily || [];
      if (!d.length || !d.some((x) => isNum(x.ttft_p50))) return empty(box, "No time-to-first-token data in this range.");
      const days = d.map((x) => x.day);
      plot(box, lines({ n: days.length, label: (i) => dShort(days[i]), head: (i) => `${dLong(days[i])} · ${int(d[i].n)} req`, fmt: ms, axis: msAxis, H: 220, lo: 0,
        series: [{ label: "p50", vals: d.map((x) => x.ttft_p50), c: 0 }, { label: "p95", vals: d.map((x) => x.ttft_p95), c: 1, thin: true }, { label: "p99", vals: d.map((x) => x.ttft_p99), c: 2, thin: true, dash: true }] }),
        `Time to first token per day, ${days.length} days; latest day p50 ${ms(lastOf(d, "ttft_p50"))}, p95 ${ms(lastOf(d, "ttft_p95"))}, p99 ${ms(lastOf(d, "ttft_p99"))}`);
    },
    total(box) {
      const d = st.data.latency?.daily || [];
      if (!d.length) return empty(box, "No latency data in this range.");
      const days = d.map((x) => x.day);
      plot(box, lines({ n: days.length, label: (i) => dShort(days[i]), head: (i) => `${dLong(days[i])} · ${int(d[i].n)} req`, fmt: ms, axis: msAxis, H: 220, lo: 0,
        series: [{ label: "p50", vals: d.map((x) => x.total_p50), c: 0 }, { label: "p95", vals: d.map((x) => x.total_p95), c: 1, thin: true }] }),
        `Total request time per day, ${days.length} days; latest day p50 ${ms(lastOf(d, "total_p50"))}, p95 ${ms(lastOf(d, "total_p95"))}`);
    },
    split(box) {
      const s = st.data.latency?.split || {}, r = st.data.latency?.retries || {};
      const hd = s.headers_p50, fe = s.first_event_p50, sm = s.stream_p50;
      const parts = [["Headers", hd, 2], ["First event", isNum(fe) && isNum(hd) ? Math.max(0, fe - hd) : fe, 1], ["Stream", sm, 0]];
      const tot = parts.reduce((a, p) => a + (isNum(p[1]) ? p[1] : 0), 0);
      box.innerHTML = `<div class="tl-wf">${tot ? parts.map(([k, v, c]) => (isNum(v) && v > 0 ? `<div class="tl-wf-s tl-c${c}" style="flex:${v}" title="${E(`${k} ${ms(v)}`)}"></div>` : "")).join("") : `<div class="tl-wf-nil"></div>`}</div>
        <div class="tl-wf-l">${parts.map(([k, v, c]) => `<div><i class="tl-c${c}"></i><span>${k}</span><b>${ms(v)}</b></div>`).join("")}</div>
        <div class="tl-wf-cum"><span>headers at <b>${ms(hd)}</b></span><span>first event at <b>${ms(fe)}</b></span><span>done ≈ <b>${ms(isNum(fe) && isNum(sm) ? fe + sm : null)}</b></span></div>
        <div class="tl-retry-stat"><div><span>Retry rate</span><b class="${isNum(r.rate_pct) && r.rate_pct > 2 ? "bad" : ""}">${pct(r.rate_pct, 2)}</b></div><div><span>Requests retried</span><b>${int(r.requests_with_retry)}</b></div></div>`;
    },
    scatter(box) {
      const pts = (st.data.latency?.by_context || []).filter((p) => isNum(p[0]) && isNum(p[1]));
      if (pts.length < 2) return empty(box, "Not enough sampled requests yet.");
      box.innerHTML = `<div class="tl-chart"></div><div class="tl-legend"><span class="tl-lg"><i class="tl-c0"></i>request</span><span class="tl-lg"><i class="tl-c2 ln"></i>median by context</span><span class="tl-lg dim">x: prompt tokens · y: total time (log) · ${int(pts.length)} samples</span></div>`;
      plot(box.querySelector(".tl-chart"), scatter(pts, 250), `Latency against prompt size: ${int(pts.length)} sampled requests, total time on a log scale against prompt tokens, with a median line`);
    },
    sessions(box) {
      const d = st.data.sessions;
      const rows = d?.rows || [];
      const COLS = [["title", "Session"], ["host", "Host", "hide-sm"], ["model", "Model", "hide-md"], ["requests", "Requests", "num", "requests"], ["spend", "Spend", "num", "cost"],
        ["hit", "Hit", "num hide-sm"], ["ctx", "Peak ctx", "num hide-md"], ["workers", "Workers", "num hide-md"], ["updated", "Updated", "num", "updated"]];
      const total = isNum(d?.total) ? d.total : rows.length;
      const a = total ? st.offset + 1 : 0, b = st.offset + rows.length;
      root.querySelector(".tl-sess-sub").textContent = `${int(total)} session${total === 1 ? "" : "s"}${st.q ? ` matching “${st.q}”` : ""} · click a row for its request timeline`;
      box.innerHTML = `<div class="tl-tw"><table class="tl-table tl-rows"><thead><tr>${COLS.map(([k, t, cls = "", s]) => `<th class="${cls}${s ? " sortable" : ""}${s === st.sort ? " on" : ""}"${s ? ` data-sort="${s}" tabindex="0" aria-sort="${s === st.sort ? "descending" : "none"}"` : ""}>${t}${s ? `<span class="tl-arrow">↓</span>` : ""}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r, i) => `<tr data-id="${E(r.id)}" tabindex="0" style="--i:${Math.min(i, 20)}">
          <td><div class="tl-st"${r.title_raw && r.title_raw !== r.title ? ` title="${E(r.title_raw)}"` : ""}>${E(r.title || r.id)}</div><div class="tl-sid">${E(r.id)}</div></td>
          <td class="hide-sm">${hostTag(r.host)}</td><td class="hide-md mono">${E(shortModel(r.model) || DASH)}</td>
          <td class="num">${int(r.requests)}</td><td class="num strong">${usd(r.spend)}</td><td class="num hide-sm">${pct(r.hit_pct)}</td>
          <td class="num hide-md">${num(r.peak_context_tokens)}</td><td class="num hide-md">${int(r.workers)}</td><td class="num dim" title="${E(isNum(r.updated) ? new Date(r.updated).toLocaleString() : "")}">${rel(r.updated)}</td></tr>`).join("")}</tbody></table>
        ${rows.length ? "" : `<div class="tl-empty">${st.q ? "No sessions match that search." : "No sessions in this range."}</div>`}</div>
        <div class="tl-pager"><span>${int(a)}–${int(b)} of ${int(total)}</span><button type="button" class="icon-btn tl-prev" aria-label="Previous page" ${st.offset <= 0 ? "disabled" : ""}>${ic("left")}</button><button type="button" class="icon-btn tl-next" aria-label="Next page" ${b >= total ? "disabled" : ""}>${ic("right")}</button></div>`;
      box.querySelectorAll("th[data-sort]").forEach((th) => {
        const go = () => { if (st.sort === th.dataset.sort) return; st.sort = th.dataset.sort; st.offset = 0; load("sessions", true); };
        th.onclick = go;
        th.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
      });
      box.querySelector(".tl-prev").onclick = () => { st.offset = Math.max(0, st.offset - st.limit); load("sessions", true); };
      box.querySelector(".tl-next").onclick = () => { st.offset += st.limit; load("sessions", true); };
      box.querySelectorAll("tbody tr").forEach((tr) => {
        tr.onclick = () => openDetail(tr.dataset.id);
        tr.onkeydown = (e) => { if (e.key === "Enter") openDetail(tr.dataset.id); };
      });
    },
    heatmap(box) {
      const cells = st.data.heatmap?.cells || [];
      const grid = Array.from({ length: 7 }, () => Array(24).fill(null));
      for (const [wd, hr, n] of cells) if (wd >= 0 && wd < 7 && hr >= 0 && hr < 24) grid[wd][hr] = n;
      const flat = cells.map((c) => c[2]).filter(isNum);
      const sum = flat.reduce((a, b) => a + b, 0);
      if (!sum) { q(".tl-heat-peak").innerHTML = ""; return empty(box, "No requests in this range."); }
      const max = Math.max(...flat);
      const top = [...flat].sort((a, b) => b - a)[Math.min(4, flat.length - 1)];
      const rowT = grid.map((r) => r.reduce((a, b) => a + (b || 0), 0)), colT = Array.from({ length: 24 }, (_, hr) => grid.reduce((a, r) => a + (r[hr] || 0), 0));
      const rMax = Math.max(...rowT, 1), cMax = Math.max(...colT, 1);
      let pk = [0, 0];
      grid.forEach((r, wd) => r.forEach((n, hr) => { if ((n || 0) > (grid[pk[0]][pk[1]] || 0)) pk = [wd, hr]; }));
      q(".tl-heat-peak").innerHTML = `<span class="tl-peak">Peak <b>${WD[pk[0]]} ${hrLong(pk[1])}</b> · ${num(grid[pk[0]][pk[1]])} req</span>`;
      q(".tl-heat-sub").textContent = `Requests by hour × weekday, local time${tzNote()}`;
      const busiest = rowT.indexOf(Math.max(...rowT)), quiet = colT.indexOf(Math.min(...colT));
      const aria = `Heatmap of ${num(sum)} requests by weekday and hour${tzNote()}. Peak ${WDL[pk[0]]} ${hrLong(pk[1])} with ${int(grid[pk[0]][pk[1]])} requests; busiest day ${WDL[busiest]}; quietest hour ${hrLong(quiet)}.`;
      let html = `<div class="tl-heat" style="--rows:7" role="img" aria-label="${E(aria)}"><div class="tl-hm-corner"></div><div class="tl-hm-cols">${colT.map((t, hr) => `<div class="tl-hm-col" data-h="${hr}"><i style="height:${((t / cMax) * 100).toFixed(1)}%"></i></div>`).join("")}</div><div></div>`;
      grid.forEach((r, wd) => {
        html += `<div class="tl-hm-wd">${WD[wd]}</div><div class="tl-hm-row">${r.map((n, hr) => {
          const v = isNum(n) ? Math.sqrt(n / max) : 0;
          return `<div class="tl-hm-c${!isNum(n) ? " nil" : n === 0 ? " zero" : ""}${isNum(n) && n >= top && n > 0 ? " hot" : ""}" data-wd="${wd}" data-h="${hr}" style="--v:${v.toFixed(3)};--d:${wd + hr}"></div>`;
        }).join("")}</div><div class="tl-hm-rt"><i style="width:${((rowT[wd] / rMax) * 100).toFixed(1)}%"></i><span>${num(rowT[wd])}</span></div>`;
      });
      html += `<div></div><div class="tl-hm-hrs">${Array.from({ length: 24 }, (_, hr) => `<span>${hr % 3 === 0 ? hr12(hr) : ""}</span>`).join("")}</div><div></div></div>
        <div class="tl-hm-leg"><span>Less</span>${[0.08, 0.3, 0.5, 0.72, 1].map((v) => `<i class="tl-hm-c" style="--v:${v}"></i>`).join("")}<span>More</span><span class="dim tl-hm-sum">${num(sum)} requests · square-root scale</span></div>`;
      box.innerHTML = html;
      const hm = box.querySelector(".tl-heat");
      const over = (e) => {
        const c = e.target.closest(".tl-hm-c[data-wd]");
        hm.querySelectorAll(".tl-hm-c.on").forEach((x) => x.classList.remove("on"));
        if (!c) { if (tipOwner === hm) hideTip(); return; }
        c.classList.add("on");
        const wd = +c.dataset.wd, hr = +c.dataset.h, n = grid[wd][hr];
        tipOwner = hm;
        showTip(`<div class="tl-tt-h">${WDL[wd]} · ${hrLong(hr)}–${hrLong((hr + 1) % 24)}</div>${tipRow(null, "Requests", int(n))}${tipRow(null, "Share of week", isNum(n) ? pct((n / sum) * 100, 2) : DASH)}${tipRow(null, `vs ${WD[wd]} avg`, isNum(n) && rowT[wd] ? `${((n / (rowT[wd] / 24)) || 0).toFixed(1)}×` : DASH)}`, e.clientX, e.clientY);
      };
      hm.addEventListener("pointermove", over);
      hm.addEventListener("pointerdown", over);
      hm.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") { hm.querySelectorAll(".tl-hm-c.on").forEach((x) => x.classList.remove("on")); if (tipOwner === hm) hideTip(); } });
    },
    stops(box) {
      const d = st.data.health || {};
      const s = (d.stops || []).slice().sort((a, b) => b.count - a.count);
      if (!s.length) return empty(box, "No stop reasons recorded.");
      const total = s.reduce((a, r) => a + r.count, 0);
      box.innerHTML = hbars(s.map((r) => { const k = stopKey(r.stop); return { k: stopLabel(k), v: r.count, flag: STOP_FLAG.get(k) }; }), { total, cls: (r) => (r.flag === "bad" ? "e" : r.flag === "warn" ? "w" : 0) })
        + `<div class="tl-chips"><span class="tl-chip2">${ic("retry")}<b>${int(d.refusal_retries)}</b> refusal retries</span><span class="tl-chip2${d.translation_losses > 0 ? " warn" : ""}"><b>${int(d.translation_losses)}</b> translation losses</span><span class="tl-chip2"><b>${int(d.tools_changed_misses)}</b> tools-changed misses</span></div>`;
    },
    ingest(box) {
      const g = st.data.health?.ingest;
      if (!g) return empty(box, "The store hasn't reported an ingest run.");
      const rows = g.rows || {};
      const stale = isNum(g.last_run) && g.last_run > 0 && Date.now() - g.last_run > 3600000;
      const never = !isNum(g.last_run) || g.last_run <= 0;
      const cls = g.errors > 0 ? "bad" : stale || never ? "warn" : "ok";
      const label = g.errors > 0 ? `${int(g.errors)} error${g.errors === 1 ? "" : "s"}` : never ? "no run yet" : stale ? "stale" : "healthy";
      box.innerHTML = `<div class="tl-ing-top"><div class="tl-ing-st ${cls}"><span class="dot"></span>${label}</div>
          <div class="tl-ing-when" title="${E(!never ? new Date(g.last_run).toLocaleString() : "")}">last run <b>${rel(g.last_run)}</b>${isNum(g.last_run_ms) ? ` · took ${ms(g.last_run_ms)}` : ""}</div></div>
        ${g.last_error ? `<div class="tl-ing-err">${ic("warn")}<span>${E(g.last_error)}</span></div>` : ""}
        <div class="tl-ing-grid">${["requests", "traces", "sessions", "workers", "legacy"].map((k) => `<div><span>${k}</span><b>${num(rows[k])}</b></div>`).join("")}<div><span>errors</span><b class="${g.errors > 0 ? "bad" : ""}">${int(g.errors)}</b></div><div><span>bad lines</span><b class="${g.bad_lines > 0 ? "warnc" : ""}">${int(g.bad_lines)}</b></div><div title="A lower bound on log bytes that rotated away before they were read"><span>lost</span><b class="${g.lost_bytes > 0 ? "warnc" : ""}">${isNum(g.lost_bytes) ? bytes(g.lost_bytes) : DASH}</b></div><div><span>skipped files</span><b>${int(g.skipped_files)}</b></div></div>
        ${(g.sources || []).length ? `<div class="tl-srcs">${g.sources.map((x) => {
          const p = isNum(x.size) && x.size > 0 && isNum(x.offset) ? clamp(x.offset / x.size, 0, 1) : null;
          return `<div class="tl-src"><span class="tl-tag">${E(x.host)}</span>${x.kind ? `<span class="tl-tag kind">${E(x.kind)}</span>` : ""}<span class="tl-src-p" title="${E(x.path)}">${E(tildify(x.path))}${isNum(x.files) ? ` <em>· ${int(x.files)} files</em>` : ""}</span>
            <span class="tl-src-o" title="${E(`read ${int(x.offset)} of ${int(x.size)} bytes`)}">${p != null ? `<i class="tl-src-bar"><i style="width:${(p * 100).toFixed(1)}%"></i></i>${E(bytes(x.size))}` : isNum(x.offset) && x.offset > 0 ? E(bytes(x.offset)) : ""}</span></div>`;
        }).join("")}</div>` : ""}`;
      setHosts([...new Set((g.sources || []).map((x) => x.host).filter(Boolean))]);
    },
  };

  // ── session detail (slide-over) ───────────────────────────────────────────
  const det = q(".tl-detail"), scrim = q(".tl-scrim");
  scrim.onclick = () => closeDetail();
  // the detail is modal: everything behind the scrim goes inert while it's open
  const behind = () => [q(".tl-head"), body];
  async function openDetail(id) {
    hideTip();
    if (!st.detail) st.detailFrom = id; // the row to hand focus back to
    st.detail = id;
    behind().forEach((el) => (el.inert = true));
    const row = st.data.sessions?.rows?.find((r) => r.id === id);
    det.classList.remove("hidden");
    scrim.classList.remove("hidden");
    det.innerHTML = `<header class="tl-d-head"><button type="button" class="icon-btn tl-d-close" aria-label="Close session detail" title="Close (Esc)">${ic("back")}</button><div class="tl-d-t"><h3>${E(row?.title || id)}</h3><div class="tl-sid">${E(id)}</div></div></header><div class="tl-d-body" tabindex="-1"><div class="tl-skel blk" style="height:120px"></div><div class="tl-skel blk" style="height:220px"></div><div class="tl-skel blk" style="height:140px"></div></div>`;
    det.querySelector(".tl-d-close").onclick = () => closeDetail();
    anim(det, [{ transform: "translateX(24px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 380 });
    anim(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
    det.querySelector(".tl-d-body").focus({ preventScroll: true }); // arrows/PageDown scroll the detail
    try {
      const d = await get(`/session/${encodeURIComponent(id)}`, "detail");
      if (st.detail !== id) return;
      st.detailData = d;
      drawDetail(d);
    } catch (e) {
      if (st.detail !== id || e?.name === "AbortError") return;
      det.querySelector(".tl-d-body").innerHTML = `<div class="tl-err" role="status" aria-live="polite">${ic("warn")}<div><b>Couldn't load this session</b><span>${E(`/api/telemetry/session/${id} — ${e.message || e}`)}</span></div><button type="button" class="btn-ghost tl-retry">${ic("retry")}Retry</button></div>`;
      det.querySelector(".tl-retry").onclick = () => openDetail(id);
    }
  }
  function drawDetail(d, still = false) {
    const s = d.session || {}, tl = d.timeline || [], wk = d.workers || [];
    det.classList.toggle("tl-still", still);
    det.querySelector(".tl-d-t h3").textContent = s.title || s.id;
    if (s.title_raw && s.title_raw !== s.title) det.querySelector(".tl-d-t h3").title = s.title_raw;
    const stats = [["Spend", usd(s.spend)], ["Requests", int(s.requests)], ["Hit", pct(s.hit_pct)], ["Peak context", num(s.peak_context_tokens)], ["Workers", int(s.workers)], ["Duration", isNum(s.created) && isNum(s.updated) ? span(s.created, s.updated) : DASH]];
    let html = `<div class="tl-d-chips">${hostTag(s.host)}<span class="tl-tag mono">${E(shortModel(s.model) || DASH)}</span>${s.grain ? `<span class="tl-tag" title="${E(s.grain === "session" ? "Spend from the session file (no request rows overlap it)" : "Spend from request-level api-log rows")}">${E(`${s.grain} grain`)}</span>` : ""}<span class="dim">${isNum(s.created) ? E(new Date(s.created).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })) : ""}</span></div>
      <div class="tl-d-stats">${stats.map(([k, v]) => `<div><span>${k}</span><b>${E(v)}</b></div>`).join("")}</div>`;
    if (!tl.length) {
      html += `<div class="tl-d-empty"><div class="tl-d-empty-g">${ic("flat")}</div><b>No request-level data for this session</b><span>Request timelines need api-log rows linked to the session (the Synaps telemetry PR adds <code>session_id</code>). The totals above come from the session file.</span></div>`;
    } else {
      const main = tl.map((r, i) => ({ ...r, i })).filter((r) => !r.worker);
      const comp = main.filter((r) => r.compaction).length;
      html += `<div class="tl-d-sec"><h4>Context growth <span>${int(main.length)} main requests${comp ? ` · ${comp} compaction${comp === 1 ? "" : "s"}` : ""}</span></h4><div class="tl-chart tl-d-ctx"></div></div>
        <div class="tl-d-sec"><h4>Cache hit per request <span>workers in a second colour</span></h4><div class="tl-chart tl-d-hit"></div></div>`;
      const stops = new Map();
      for (const r of tl) { const k = stopKey(r.stop); stops.set(k, (stops.get(k) || 0) + 1); }
      html += `<div class="tl-d-sec"><h4>Stop reasons</h4><div class="tl-chips">${[...stops].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="tl-chip2 ${STOP_FLAG.get(k) || ""}"><b>${int(n)}</b> ${E(stopLabel(k))}</span>`).join("")}</div></div>`;
    }
    html += `<div class="tl-d-sec"><h4>Workers <span>${int(wk.length)}</span></h4>${wk.length ? `<div class="tl-wk">${wk.map((w) => `<div class="tl-wk-r"><span class="tl-tag mono">${E(w.handle)}</span><span class="tl-agent">${E(w.agent)}</span><span class="mono dim">${E(shortModel(w.model))}</span><b>${usd(w.spend)}</b></div>`).join("")}</div>` : `<div class="tl-note">No subagents ran in this session.</div>`}</div>`;
    det.querySelector(".tl-d-body").innerHTML = html;
    if (!tl.length) return;
    const main = tl.filter((r) => !r.worker);
    const marks = main.map((r, i) => (r.compaction && i > 0 ? { i, label: "", cls: "warn", tip: `Compacted: ${num(main[i - 1].context_tokens)} → ${num(r.context_tokens)} (−${Math.round((1 - r.context_tokens / main[i - 1].context_tokens) * 100)}%)` } : null)).filter(Boolean);
    plot(det.querySelector(".tl-d-ctx"), lines({ n: main.length, label: (i) => `#${i + 1}`, head: (i) => `Request #${i + 1} · ${new Date(main[i].ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, fmt: (v) => `${num(v)} tokens`, axis: num, lo: 0, H: 200, marks,
      series: [{ label: "Context", vals: main.map((r) => r.context_tokens), c: 0 }] }),
      `Context growth over ${main.length} main requests, peak ${num(Math.max(...main.map((r) => r.context_tokens || 0)))} tokens, ${marks.length} compaction${marks.length === 1 ? "" : "s"}`);
    plot(det.querySelector(".tl-d-hit"), (W) => {
      const L = 50, R = 10, T = 8, B = 20, H = 120, n = tl.length, iw = W - L - R, ih = H - T - B, band = iw / n;
      const y = (v) => T + ih - (v / 100) * ih;
      let bars = "";
      tl.forEach((r, i) => { if (isNum(r.hit_pct)) bars += `<rect class="tl-c${r.worker ? 1 : r.hit_pct < 50 ? "w" : 0} tl-fill" x="${f1(L + i * band)}" y="${f1(y(r.hit_pct))}" width="${f1(Math.max(0.8, band - (band > 3 ? 1 : 0)))}" height="${f1(T + ih - y(r.hit_pct))}"/>`; });
      const svg = `<svg class="tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${yGrid([0, 50, 100], y, L, W - R, (v) => `${v}%`)}<g class="tl-plot">${bars}</g><g class="tl-hov"></g>${xLabels(n, (i) => L + (i + 0.5) * band, (i) => `#${i + 1}`, iw, H - 4)}</svg>`;
      return { svg, hover: (mx) => {
        const i = Math.floor((mx - L) / band);
        if (i < 0 || i >= n) return null;
        const r = tl[i];
        return { g: `<rect class="tl-band" x="${f1(L + i * band)}" y="${T}" width="${f1(Math.max(band, 2))}" height="${ih}"/>`,
          html: `<div class="tl-tt-h">Request #${i + 1}${r.worker ? " · worker" : ""}</div>${tipRow(null, "Cache hit", pct(r.hit_pct))}${tipRow(null, "Context", `${num(r.context_tokens)} tokens`)}${tipRow(null, "Output", `${num(r.output)} tokens`)}${tipRow(null, "Total", ms(r.total_ms))}${tipRow(null, "TTFT", ms(r.ttft_ms))}${tipRow(null, "Stop", stopLabel(stopKey(r.stop)))}${r.compaction ? `<div class="tl-tt-note">compaction</div>` : ""}` };
      } };
    }, `Cache hit per request, ${tl.length} requests, average ${pct(tl.filter((r) => isNum(r.hit_pct)).reduce((a, r, _, xs) => a + r.hit_pct / xs.length, 0))}`);
  }
  function closeDetail({ refocus = true } = {}) {
    if (!st.detail) return false;
    st.detail = null;
    st.detailData = null;
    inflight.get("detail")?.abort(new DOMException("closed", "AbortError"));
    behind().forEach((el) => (el.inert = false));
    hideTip();
    const a = anim(det, [{ transform: "none", opacity: 1 }, { transform: "translateX(24px)", opacity: 0 }], { duration: 200, easing: EASE.move });
    anim(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE.move });
    const done = () => { if (!st.detail) { det.classList.add("hidden"); scrim.classList.add("hidden"); } };
    after(a, done, 200);
    // back to the row that opened it (the table may have redrawn since: look it up by id)
    const from = st.detailFrom;
    st.detailFrom = null;
    if (refocus) (from && [...root.querySelectorAll(".tl-rows tr[data-id]")].find((tr) => tr.dataset.id === from) || root).focus({ preventScroll: true });
    return true;
  }

  // ── search / tabs / scroll ────────────────────────────────────────────────
  const search = q(".tl-search input");
  let qTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { const v = search.value.trim(); if (v === st.q) return; st.q = v; st.offset = 0; load("sessions", true); }, 250);
  });
  const ind = q(".tl-tab-ind");
  let curSec = null;
  function markTab(k) {
    if (k === curSec) return;
    curSec = k;
    const b = q(`.tl-tab[data-sec="${k}"]`);
    root.querySelectorAll(".tl-tab").forEach((x) => x.classList.toggle("on", x === b));
    if (!b) return;
    ind.style.width = `${b.offsetWidth}px`;
    ind.style.transform = `translateX(${b.offsetLeft}px)`;
    // keep the active tab visible in a scrolled strip (scrollLeft, not scrollIntoView: that would move the page)
    const t = b.parentElement;
    if (b.offsetLeft < t.scrollLeft + 8 || b.offsetLeft + b.offsetWidth > t.scrollLeft + t.clientWidth - 8)
      t.scrollTo({ left: Math.max(0, b.offsetLeft - (t.clientWidth - b.offsetWidth) / 2), behavior: motion() ? "smooth" : "auto" });
  }
  root.querySelectorAll(".tl-tab").forEach((b) => (b.onclick = () => {
    const sec = q(`.tl-sec[data-sec="${b.dataset.sec}"]`);
    const top = sec.offsetTop - q(".tl-head").offsetHeight - 8;
    root.scrollTo({ top: Math.max(0, top), behavior: motion() ? "smooth" : "auto" });
    markTab(b.dataset.sec);
    lockTabs = performance.now() + 700;
  }));
  let scrollRaf = 0, lockTabs = 0;
  root.addEventListener("scroll", () => {
    if (tipOwner) hideTip();
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (performance.now() < lockTabs) return;
      const line = q(".tl-head").offsetHeight + 60;
      let k = "live";
      for (const s of root.querySelectorAll(".tl-sec")) if (s.getBoundingClientRect().top - root.getBoundingClientRect().top <= line) k = s.dataset.sec;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) k = "health";
      markTab(k);
    });
  }, { passive: true });

  // redraw charts at the new width (no entrance replays)
  let lastW = 0;
  new ResizeObserver(() => {
    if (!st.open) return;
    const w = body.clientWidth;
    if (Math.abs(w - lastW) < 2) return;
    const first = !lastW;
    lastW = w;
    segs.forEach((s) => s._place());
    const k = curSec || "live";
    curSec = null; markTab(k);
    if (first) return;
    animate = false;
    for (const ep of Object.keys(EP)) if (st.data[ep]) for (const id of EP[ep].panels) if (P[id].el.classList.contains("is-err") === false) draw(id, true);
    if (st.detailData) drawDetail(st.detailData, true);
    animate = true;
  }).observe(body);

  // finish an exit animation, but never hang on it (a throttled/backgrounded
  // tab can leave a WAAPI animation pending)
  function after(a, fn, ms) {
    if (!a) return fn();
    let ran = false;
    const go = () => { if (!ran) { ran = true; fn(); } };
    a.onfinish = go;
    setTimeout(go, ms + 80);
  }

  // ── open / close / routing ────────────────────────────────────────────────
  const btn = $("open-telemetry");
  function poll() {
    clearInterval(st.poll);
    st.poll = setInterval(() => { if (st.open && !document.hidden) load("summary", true); }, 10000);
  }
  document.addEventListener("visibilitychange", () => { if (st.open && !document.hidden) load("summary", true); });
  const isTlHash = () => location.hash === "#telemetry";
  const sessionHash = () => (S.sid ? `#s=${S.sid}` : location.pathname + location.search);
  function open({ push = true } = {}) {
    if (st.open) return;
    st.open = true;
    const a = document.activeElement;
    st.opener = a && a !== document.body && !root.contains(a) ? a : null;
    closeDrawer();
    if ($("ctx-pop") && !$("ctx-pop").classList.contains("hidden")) { $("ctx-pop").classList.add("hidden"); $("st-ctx")?.setAttribute("aria-expanded", "false"); }
    if (push && !isTlHash()) { history.pushState(null, "", "#telemetry"); st.pushed = true; }
    assignSeries();
    root.classList.remove("hidden");
    $("main").classList.add("tl-on");
    btn?.classList.add("on");
    btn?.setAttribute("aria-pressed", "true");
    // focus moves INTO the view: the composer behind is hidden, and keys must not
    // reach it (type-to-start would send a turn nobody can see); native keyboard
    // scrolling then targets the view
    root.focus({ preventScroll: true });
    anim(root, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 380 });
    lastW = 0;
    requestAnimationFrame(() => { segs.forEach((s) => s._place()); curSec = null; markTab("live"); });
    root.scrollTop = 0;
    loadAll();
    poll();
  }
  function close({ nav = true, refocus = true } = {}) {
    if (!st.open) return;
    st.open = false;
    st.escGuard = performance.now() + 300; // a fast extra Escape must not fall through and cancel the turn
    clearInterval(st.poll);
    abortAll();
    hideTip();
    closeDetail({ refocus: false });
    $("main").classList.remove("tl-on");
    btn?.classList.remove("on");
    btn?.setAttribute("aria-pressed", "false");
    const a = anim(root, [{ opacity: 1 }, { opacity: 0, transform: "translateY(6px)" }], { duration: 200, easing: EASE.move });
    const done = () => { if (!st.open) root.classList.add("hidden"); };
    after(a, done, 200);
    if (refocus) {
      const o = st.opener;
      (o?.isConnected && o.offsetParent !== null && !o.closest("[inert]") ? o : btn)?.focus({ preventScroll: true });
    }
    st.opener = null;
    if (!nav) return;
    if (st.pushed) { st.pushed = false; history.back(); }
    else history.replaceState(null, "", sessionHash());
  }
  // leaving via the rail (pick a session / new session): pop our own entry, the app sets the hash next
  function leaveForRail() {
    if (!st.open) return;
    const pushed = st.pushed;
    st.pushed = false;
    close({ nav: false, refocus: false });
    if (pushed) history.back();
    else history.replaceState(null, "", sessionHash());
  }
  btn?.addEventListener("click", () => (st.open ? close() : open()));
  q(".tl-close").onclick = () => close();
  q(".tl-rail").onclick = () => toggleRail();
  $("rail").addEventListener("click", (e) => { if (e.target.closest("li[data-id], #new-session")) leaveForRail(); }, true);
  addEventListener("popstate", () => {
    if (isTlHash() && !st.open) open({ push: false });
    else if (!isTlHash() && st.open) { st.pushed = false; close({ nav: false }); }
  });
  addEventListener("hashchange", () => { if (isTlHash() && !st.open) open({ push: false }); });
  // Keyboard, while the view is open (capture phase, so the app's document
  // handlers never see these keys): Escape closes detail → view; "/" focuses
  // search (and types a "/" when already typing); navigation keys scroll the
  // view natively instead of the hidden transcript.
  const NAV = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"]);
  document.addEventListener("keydown", (e) => {
    if (!st.open) {
      if (e.key === "Escape" && performance.now() < (st.escGuard || 0)) e.stopImmediatePropagation();
      return;
    }
    const ae = document.activeElement;
    const typing = !!ae?.closest?.("input, textarea, select, [contenteditable]");
    if (e.key === "Escape") {
      if (S.prompt || (NARROW.matches && $("app").classList.contains("rail-open"))) return; // the app's: answer / close drawer
      if (!$("settings").classList.contains("hidden")) return; // settings' own capture handler
      e.stopImmediatePropagation();
      if (typing && ae === search && search.value) { search.value = ""; search.dispatchEvent(new Event("input")); return; }
      if (!closeDetail()) close();
    } else if (e.key === "/") {
      if (!root.contains(ae) && ae !== document.body && ae !== null) return; // e.g. settings is open
      e.stopImmediatePropagation();
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return; // a literal "/" in the box
      e.preventDefault();
      if (!st.detail) search.focus();
    } else if (NAV.has(e.key) && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (ae && ae !== document.body && !root.contains(ae)) return;
      e.stopImmediatePropagation(); // no preventDefault: the browser scrolls the focused view
      if (!root.contains(ae)) root.focus({ preventScroll: true });
    }
  }, true);
  if (isTlHash()) open({ push: false });

  return { open, close, get isOpen() { return st.open; }, _st: st };
})();
window.__telemetry = Telemetry;
