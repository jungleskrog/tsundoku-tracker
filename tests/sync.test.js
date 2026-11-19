import { test } from "node:test";
import assert from "node:assert/strict";
import { syncOnce, contentOf, Conflict, SignedOut } from "../app/js/sync.js";
import { setFetch, driveStore, signInUrl, parseReturn } from "../app/js/gdrive.js";
import { mergeArchives, makeArchive, defaultSettings } from "../app/js/domain.js";

/** A pretend Google Drive app space: one file with a version; optionally another device writes just before us. */
function fakeDrive({ file = null, raceOnce = null, expired = false } = {}) {
  const d = { file, version: file ? 1 : 0, id: file ? "F1" : null, writes: 0, raceOnce };
  setFetch(async (url, opts = {}) => {
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => (typeof body === "string" ? JSON.parse(body) : body) });
    if (expired) return reply(401, { error: { message: "expired" } });
    const u = new URL(url);
    if (u.pathname === "/drive/v3/files" && !opts.method) return reply(200, { files: d.id ? [{ id: d.id, version: String(d.version) }] : [] });
    if (u.pathname === `/drive/v3/files/${d.id}` && u.searchParams.get("alt") === "media") return reply(200, JSON.stringify(d.file));
    if (u.pathname === `/drive/v3/files/${d.id}` && u.searchParams.get("fields") === "version") {
      if (d.raceOnce) { d.file = d.raceOnce; d.version++; d.raceOnce = null; }
      return reply(200, { version: String(d.version) });
    }
    if (u.pathname === "/upload/drive/v3/files" && opts.method === "POST") {
      const json = opts.body.split("\r\n\r\n")[2].split("\r\n--")[0];
      d.file = JSON.parse(json); d.id = "F1"; d.version = 1; d.writes++;
      return reply(200, { id: "F1", version: "1" });
    }
    if (u.pathname === `/upload/drive/v3/files/${d.id}` && opts.method === "PATCH") { d.file = JSON.parse(opts.body); d.version++; d.writes++; return reply(200, { version: String(d.version) }); }
    return reply(404, {});
  });
  return d;
}

const NOW = "2026-11-19T12:00:00.000Z";
const lib = (books, events = [], t = NOW) => makeArchive({ books, events, tombstones: [], settings: { ...defaultSettings(t), updatedAt: t } }, t);
const book = (id, t = NOW, extra = {}) => ({ id, status: "want", refs: {}, synced: { title: id }, mine: {}, flags: {}, prereqs: [], updatedAt: t, ...extra });
const ev = (id, bookId, at) => ({ id, bookId, at, type: "progress", page: 5, prevPage: 0, source: "app" });
const run = state => syncOnce({ store: driveStore("T"), local: () => state.local, merge: mergeArchives, accept: async m => { state.local = { ...state.local, ...m }; } });

test("first sync: no file yet, so the library is written to Drive's app space", async () => {
  const d = fakeDrive();
  const r = await run({ local: lib([book("a")]) });
  assert.deepEqual([r.pulled, r.pushed, d.writes], [false, true, 1]);
  assert.equal(d.file.format, "antilibrary-archive");
});

test("phone and Mac: each one's entries reach the other; nothing is written when they agree", async () => {
  const d = fakeDrive({ file: lib([book("a"), book("b")], [ev("e1", "a", NOW)]) });
  const state = { local: lib([book("a")], [ev("e2", "a", "2026-11-19T13:00:00.000Z")]) };
  const r = await run(state);
  assert.ok(r.pulled && r.pushed);
  assert.deepEqual(state.local.events.map(e => e.id).sort(), ["e1", "e2"]);
  assert.deepEqual(d.file.events.map(e => e.id).sort(), ["e1", "e2"]);
  const again = await run(state);
  assert.deepEqual([again.pulled, again.pushed, d.writes], [false, false, 1]);
});

test("another device writes in between: the round starts again and both survive", async () => {
  const d = fakeDrive({ file: lib([book("a")]), raceOnce: lib([book("a"), book("c")]) });
  const state = { local: lib([book("a"), book("d")]) };
  await run(state);
  assert.deepEqual(d.file.books.map(b => b.id).sort(), ["a", "c", "d"]);
  assert.deepEqual(state.local.books.map(b => b.id).sort(), ["a", "c", "d"]);
});

test("deletions stick across devices; the newer edit of a book wins", async () => {
  const remote = lib([book("a", "2026-11-19T14:00:00.000Z", { status: "reading" }), book("x")]);
  remote.tombstones = [{ id: "z", at: NOW }];
  fakeDrive({ file: remote });
  const state = { local: lib([book("a"), book("z")]) };
  await run(state);
  assert.equal(state.local.books.find(b => b.id === "a").status, "reading");
  assert.ok(!state.local.books.some(b => b.id === "z"));
});

test("an expired token says so; sign-in links and returns are read correctly", async () => {
  fakeDrive({ expired: true });
  await assert.rejects(run({ local: lib([]) }), SignedOut);
  const { url, state } = signInUrl("CID", "https://example.test/app/", { silent: true });
  const q = new URL(url).searchParams;
  assert.deepEqual([q.get("response_type"), q.get("prompt"), q.get("scope"), q.get("state")], ["token", "none", "https://www.googleapis.com/auth/drive.appdata", state]);
  const back = parseReturn("#access_token=AT&token_type=Bearer&expires_in=3599&state=S1");
  assert.deepEqual([back.access, back.state], ["AT", "S1"]);
  assert.equal(parseReturn("#error=interaction_required&state=S1").error, "interaction_required");
  assert.equal(parseReturn("#/book/b_1"), null);
  assert.ok(new Conflict("x") instanceof Error);
  assert.equal(contentOf(lib([book("a")])), contentOf({ ...lib([book("a")]), exportedAt: "later" }));
});
