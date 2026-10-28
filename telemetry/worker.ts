// Ingest loop, in a Bun Worker so the extension's event loop never waits on a
// backfill. Own DB connection (WAL: the main thread reads while we write).
// Every pass is wrapped: an exception is counted in meta and the loop carries on.

import { openDb, metaGet, metaSet } from "./schema.ts";
import { ingestOnce, type HostRoot } from "./ingest.ts";

declare var self: Worker;

type Init = { dbPath: string; roots: HostRoot[]; intervalMs: number };

self.onmessage = async (e: MessageEvent<Init>) => {
  const { dbPath, roots, intervalMs } = e.data;
  const db = openDb(dbPath);
  for (;;) {
    try {
      const st = ingestOnce(db, roots, { budgetMs: 60_000 });
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
