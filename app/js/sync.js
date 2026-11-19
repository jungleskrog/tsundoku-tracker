// Syncing the library through a cloud file (Google Drive). Provider-neutral: a store
// downloads the file with a revision and uploads only if nobody wrote it since.
export class Conflict extends Error {}
export class SignedOut extends Error {}

/** What the content of an archive is, ignoring when it was written. */
export const contentOf = a => JSON.stringify([a.books, a.events, a.tombstones || [], a.settings || null].map(x => (Array.isArray(x) ? [...x].sort((p, q) => (p.id < q.id ? -1 : 1)) : x)));

/**
 * One round: read the cloud copy, merge it into the local library, and write back
 * only if the cloud copy lacks something. A clash (another device wrote meanwhile)
 * starts the round again, up to three times.
 *   local()            — the current local archive
 *   merge(a, b)        — mergeArchives
 *   accept(m)          — store the merged library locally (only called if it changed)
 *   store              — { download() → { archive, rev } | null, upload(archive, rev) → { rev }, throws Conflict on a clash }
 *   prepare(remote)    — check/upgrade the cloud copy (throws if it isn't a library)
 * Returns { pulled, pushed, rev }.
 */
export async function syncOnce({ store, local, merge, accept, prepare = x => x, stamp = () => new Date().toISOString() }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = await store.download();
    const mine = local();
    let merged = mine, pulled = false;
    if (remote) {
      merged = merge(mine, prepare(remote.archive));
      if (contentOf(merged) !== contentOf(mine)) { await accept(merged); pulled = true; }
    }
    if (remote && contentOf(merged) === contentOf(remote.archive)) return { pulled, pushed: false, rev: remote.rev };
    try {
      const out = { format: mine.format, schemaVersion: mine.schemaVersion, exportedAt: stamp(), books: merged.books, events: merged.events, tombstones: merged.tombstones || [], settings: merged.settings };
      const { rev } = await store.upload(out, remote ? remote.rev : null);
      return { pulled, pushed: true, rev };
    } catch (e) {
      if (!(e instanceof Conflict) || attempt === 2) throw e;
    }
  }
}
