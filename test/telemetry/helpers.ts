import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const FIXTURES = join(import.meta.dir, "fixtures");

/** Fresh copy of the fixture roots + a db path, all under /tmp. */
export function sandbox(): { dir: string; db: string; bella: string; jade: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), "synaps-telemetry-test-"));
  cpSync(FIXTURES, join(dir, "src"), { recursive: true });
  return { dir, db: join(dir, "t.db"), bella: join(dir, "src", "bella"), jade: join(dir, "src", "jade"), done: () => rmSync(dir, { recursive: true, force: true }) };
}
