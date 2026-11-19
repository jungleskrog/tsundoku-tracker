import { test } from "node:test";
import assert from "node:assert/strict";
import { setFetch, syncOnce, signInUrl, finishSignIn, freshToken, download, contentOf, SignedOut } from "../app/js/dropbox.js";
import { mergeArchives, makeArchive, defaultSettings } from "../app/js/domain.js";

/** A pretend Dropbox: one file with a revision; optionally another device writes just before us. */
function fakeDropbox({ file = null, raceOnce = null } = {}) {
  const box = { file, rev: file ? 1 : 0, uploads: 0, raceOnce };
  setFetch(async (url, opts) => {
    const arg = opts.headers && opts.headers["Dropbox-API-Arg"] ? JSON.parse(opts.headers["Dropbox-API-Arg"]) : null;
    const reply = (status, body, headers = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), headers: { get: k => headers[k] ?? null } });
    if (url.endsWith("/oauth2/token")) {
      const b = Object.fromEntries(opts.body);
      if (b.grant_type === "authorization_code") return b.code === "good" && b.code_verifier ? reply(200, { access_token: "A1", refresh_token: "R1", expires_in: 14400, account_id: "dbid:x" }) : reply(400, { error_description: "bad code" });
      return reply(200, { access_token: "A2", expires_in: 14400 });
    }
    if (url.endsWith("/files/download")) {
      if (!box.file) return reply(409, { error_summary: "path/not_found/.." });
      return reply(200, JSON.stringify(box.file), { "Dropbox-API-Result": JSON.stringify({ rev: String(box.rev) }) });
    }
    if (url.endsWith("/files/upload")) {
      if (box.raceOnce) { box.file = box.raceOnce; box.rev++; box.raceOnce = null; }
      const want = arg.mode[".tag"] === "update" ? arg.mode.update : null;
      if ((want ?? "0") !== String(box.rev) && !(want === null && box.rev === 0)) return reply(409, { error_summary: "path/conflict/.." });
      box.file = JSON.parse(opts.body); box.rev++; box.uploads++;
      return reply(200, { rev: String(box.rev) });
    }
    return reply(404, {});
  });
  return box;
}

const NOW = "2026-11-19T12:00:00.000Z";
const lib = (books, events = [], t = NOW) => makeArchive({ books, events, tombstones: [], settings: { ...defaultSettings(t), updatedAt: t } }, t);
const book = (id, t = NOW, extra = {}) => ({ id, status: "want", refs: {}, synced: { title: id }, mine: {}, flags: {}, prereqs: [], updatedAt: t, ...extra });
const ev = (id, bookId, at) => ({ id, bookId, at, type: "progress", page: 5, prevPage: 0, source: "app" });

function run(state) {
  return syncOnce({ access: "A1", local: () => state.local, merge: mergeArchives, accept: async m => { state.local = { ...state.local, ...m }; state.accepted++; } });
}

test("first sync: no file yet, so the library is written to Dropbox", async () => {
  const box = fakeDropbox();
  const state = { local: lib([book("a")]), accepted: 0 };
  const r = await run(state);
  assert.deepEqual([r.pulled, r.pushed, box.uploads], [false, true, 1]);
  assert.equal(box.file.format, "antilibrary-archive");
  assert.equal(box.file.books[0].id, "a");
});

test("phone and Mac: each one's entries reach the other, and nothing is written when they agree", async () => {
  const box = fakeDropbox({ file: lib([book("a"), book("b")], [ev("e1", "a", NOW)]) });
  const state = { local: lib([book("a")], [ev("e2", "a", "2026-11-19T13:00:00.000Z")]), accepted: 0 };
  const r = await run(state);
  assert.ok(r.pulled && r.pushed);
  assert.deepEqual(state.local.events.map(e => e.id).sort(), ["e1", "e2"]);
  assert.deepEqual(box.file.events.map(e => e.id).sort(), ["e1", "e2"]);
  const again = await run(state);
  assert.deepEqual([again.pulled, again.pushed, box.uploads], [false, false, 1]);
});

test("a clash with another device's write starts the round again, and both survive", async () => {
  const other = lib([book("a"), book("c")], [ev("e3", "c", NOW)]);
  const box = fakeDropbox({ file: lib([book("a")]), raceOnce: other });
  const state = { local: lib([book("a"), book("d")]), accepted: 0 };
  await run(state);
  assert.deepEqual(box.file.books.map(b => b.id).sort(), ["a", "c", "d"]);
  assert.deepEqual(state.local.books.map(b => b.id).sort(), ["a", "c", "d"]);
});

test("a deletion on one device sticks on the other; the newer edit of a book wins", async () => {
  const remote = lib([book("a", "2026-11-19T14:00:00.000Z", { status: "reading" }), book("x")]);
  remote.tombstones = [{ id: "z", at: NOW }];
  fakeDropbox({ file: remote });
  const state = { local: lib([book("a"), book("z")]), accepted: 0 };
  await run(state);
  assert.equal(state.local.books.find(b => b.id === "a").status, "reading");
  assert.ok(!state.local.books.some(b => b.id === "z"));
});

test("sign-in: PKCE link, code swapped for tokens, refreshed when old; a bad code says so", async () => {
  fakeDropbox();
  const { url, pending } = await signInUrl("KEY", "https://example.test/app/");
  const q = new URL(url).searchParams;
  assert.deepEqual([q.get("client_id"), q.get("code_challenge_method"), q.get("token_access_type"), q.get("redirect_uri")], ["KEY", "S256", "offline", "https://example.test/app/"]);
  assert.ok(pending.verifier.length > 40 && !url.includes(pending.verifier));
  const rec = await finishSignIn(pending, "good");
  assert.deepEqual([rec.refresh, rec.access], ["R1", "A1"]);
  assert.equal((await freshToken({ ...rec, expiresAt: 0 })).access, "A2");
  await assert.rejects(finishSignIn(pending, "bad"), SignedOut);
  const paste = await signInUrl("KEY");
  assert.ok(!new URL(paste.url).searchParams.has("redirect_uri"), "the paste-a-code flow has no redirect");
  assert.equal(await download("A1"), null);
  assert.equal(contentOf(lib([book("a")])), contentOf({ ...lib([book("a")]), exportedAt: "later" }));
});
