// HTTP routing for /api/telemetry/*. main.ts calls handleTelemetry() after its
// tokenOk gate; this module never sees an unauthenticated request.

import type { TelemetryQuery, Filter } from "./query.ts";

const intParam = (v: string | null, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : dflt;
};

function filter(u: URL): Filter | string {
  const f: Filter = {};
  for (const k of ["from", "to"] as const) {
    const v = u.searchParams.get(k);
    if (v === null || v === "") continue;
    if (!/^\d{1,16}$/.test(v)) return `bad ${k}: unix ms expected`;
    f[k] = Number(v);
  }
  const h = u.searchParams.get("host");
  if (h) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(h)) return "bad host";
    f.host = h;
  }
  return f;
}

const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });

/** Returns a Response for /api/telemetry/* paths, or null if the path is not ours. */
export function handleTelemetry(req: Request, url: URL, q: TelemetryQuery | null, why?: string, onError?: (e: unknown) => void): Response | null {
  const p = url.pathname;
  if (p !== "/api/telemetry" && !p.startsWith("/api/telemetry/")) return null;
  if (req.method !== "GET") return bad("method not allowed", 405);
  if (!q) return bad(why ?? "telemetry is disabled", 503);
  const f = filter(url);
  if (typeof f === "string") return bad(f);
  const sp = url.searchParams;
  try {
    switch (p) {
      case "/api/telemetry/summary": return Response.json(q.summary(f));
      case "/api/telemetry/spend": {
        const bucket = sp.get("bucket") ?? "day";
        if (bucket !== "day") return bad("bucket: only 'day' is supported");
        const group = sp.get("group") ?? "model";
        if (!["model", "role", "host"].includes(group)) return bad("group: model|role|host");
        return Response.json(q.spend(f, group));
      }
      case "/api/telemetry/agents": return Response.json(q.agents(f));
      case "/api/telemetry/cache": return Response.json(q.cache(f));
      case "/api/telemetry/latency": {
        const m = sp.get("model");
        if (m && !/^[\w.:@\/-]{1,128}$/.test(m)) return bad("bad model");
        return Response.json(q.latency(f, m ? m.replace(/^[^/]+\//, "") : null));
      }
      case "/api/telemetry/sessions": {
        const sort = sp.get("sort") ?? "cost";
        if (!["cost", "updated", "requests"].includes(sort)) return bad("sort: cost|updated|requests");
        const qs = (sp.get("q") ?? "").slice(0, 200) || null;
        return Response.json(q.sessions(f, sort, intParam(sp.get("limit"), 1, 500, 50), intParam(sp.get("offset"), 0, 1e9, 0), qs));
      }
      case "/api/telemetry/heatmap": return Response.json(q.heatmap(f));
      case "/api/telemetry/health": return Response.json(q.health(f));
    }
    const m = /^\/api\/telemetry\/session\/([^/]{1,200})$/.exec(p);
    if (m) {
      let id: string;
      try { id = decodeURIComponent(m[1]); } catch { return bad("bad id"); }
      const r = q.session(id);
      return r ? Response.json(r) : bad("no such session", 404);
    }
    return bad("not found", 404);
  } catch (e) {
    // details go to the extension log, never to the client
    try { onError?.(e); } catch {}
    return bad("telemetry query failed", 500);
  }
}
