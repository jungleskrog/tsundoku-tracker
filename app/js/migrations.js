// Schema migrations. migrations[n] turns an archive of version n into n+1.
// Runs on startup (after a snapshot) and on importing an older backup.
// New optional fields need no migration; renames and restructures always do.
import { SCHEMA_VERSION } from "./domain.js";

export const migrations = {
  // 1: (v1 -> v2) will go here, e.g.
  // 1: a => ({ ...a, books: a.books.map(b => ({ ...b, newField: null })), schemaVersion: 2 }),
};

export function migrate(archive, table = migrations, target = SCHEMA_VERSION) {
  let a = archive;
  while (a.schemaVersion < target) {
    const step = table[a.schemaVersion];
    if (!step) throw new Error(`No migration from version ${a.schemaVersion}`);
    const next = step(a);
    if (next.schemaVersion !== a.schemaVersion + 1) throw new Error(`Migration ${a.schemaVersion} did not advance the version`);
    a = next;
  }
  return a;
}
