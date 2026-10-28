import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, statSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, SCHEMA_VERSION } from "../../telemetry/schema.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

test("DB 0600 (incl. -wal/-shm) in a 0700 dir, whatever the umask", () => {
  const dir = mkdtempSync(join(tmpdir(), "synaps-telemetry-perm-"));
  const old = process.umask(0o022);
  try {
    const p = join(dir, "a", "b", "t.db");
    const db = openDb(p);
    db.exec("CREATE TABLE IF NOT EXISTS x(y); INSERT INTO x VALUES (1)");
    expect(mode(join(dir, "a", "b"))).toBe(0o700);
    for (const f of [p, p + "-wal", p + "-shm"]) expect(mode(f)).toBe(0o600);
    db.close();
    // an existing world-readable dir + file of ours are tightened on open
    const d2 = join(dir, "loose");
    mkdirSync(d2, { mode: 0o755 });
    chmodSync(d2, 0o755);
    writeFileSync(join(d2, "t.db"), "", { mode: 0o644 });
    chmodSync(join(d2, "t.db"), 0o644);
    openDb(join(d2, "t.db")).close();
    expect(mode(d2)).toBe(0o700);
    expect(mode(join(d2, "t.db"))).toBe(0o600);
    // a shared sticky dir (like /tmp) is never chmodded
    const sticky = join(dir, "sticky");
    mkdirSync(sticky);
    chmodSync(sticky, 0o1777);
    openDb(join(sticky, "t.db")).close();
    expect(statSync(sticky).mode & 0o7777).toBe(0o1777);
    expect(mode(join(sticky, "t.db"))).toBe(0o600);
  } finally {
    process.umask(old);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two processes cold-opening the same DB both migrate cleanly (BEGIN IMMEDIATE)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synaps-telemetry-race-"));
  try {
    for (let round = 0; round < 3; round++) {
      const p = join(dir, `r${round}.db`);
      const script = `import { openDb } from ${JSON.stringify(join(import.meta.dir, "../../telemetry/schema.ts"))};
        const go = Number(process.argv[2]); while (Date.now() < go) {}
        const db = openDb(${JSON.stringify(p)});
        console.log(db.query("PRAGMA user_version").get().user_version);`;
      writeFileSync(join(dir, "open.ts"), script);
      const go = Date.now() + 400;
      const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", join(dir, "open.ts"), String(go)], { stdout: "pipe", stderr: "pipe" }));
      const outs = await Promise.all(procs.map(async (pr) => ({ code: await pr.exited, out: (await new Response(pr.stdout).text()).trim(), err: await new Response(pr.stderr).text() })));
      for (const o of outs) {
        expect(o.err).toBe("");
        expect(o.code).toBe(0);
        expect(o.out).toBe(String(SCHEMA_VERSION));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
