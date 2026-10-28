// Ingest loop, in a Bun Worker so the extension's event loop never waits on a
// backfill. Own DB connection (WAL: the main thread reads while we write).
// Every pass is wrapped: an exception is counted in meta and the loop carries on.
// Posts "beat" between sources and "pass" after each pass, which is how the
// main thread's watchdog knows the worker is alive.

import { openDb, metaGet, metaSet } from "./schema.ts";
import { ingestOnce, refreshReleases, type HostRoot } from "./ingest.ts";

declare var self: Worker;

type Init = { dbPath: string; roots: HostRoot[]; intervalMs: number; releasesRepo?: string | null };
const RELEASES_EVERY = 10 * 60_000;

self.onmessage = async (e: MessageEvent<Init>) => {
  const { dbPath, roots, intervalMs, releasesRepo } = e.data;
  const db = openDb(dbPath);
  for (;;) {
    try {
      const st = ingestOnce(db, roots, { budgetMs: 60_000, onProgress: () => postMessage({ type: "beat" }) });
      if (releasesRepo && Date.now() - Number(metaGet(db, "releases_at") ?? 0) > RELEASES_EVERY) await refreshReleases(db, releasesRepo);
      postMessage({ type: "pass", stats: st });
    } catch (err) {
      try {
        metaSet(db, "errors", Number(metaGet(db, "errors") ?? 0) + 1);
        metaSet(db, "last_error", `${new Date().toISOString()} pass: ${String(err).slice(0, 300)}`);
      } catch {}
      postMessage({ type: "error", error: String(err) });
    }
    await Bun.sleep(intervalMs);
  }
};
