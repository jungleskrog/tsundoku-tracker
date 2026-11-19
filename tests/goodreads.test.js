import { test } from "node:test";
import assert from "node:assert/strict";
import { changesForGoodreads, doneMark, fromBookmarklet, bookUrl, searchUrl } from "../app/js/goodreads.js";
import { planImport } from "../app/js/domain.js";
import { youthSlot, moveTo } from "../app/js/order.js";
import { keysBetween, compareKeys } from "../app/js/keys.js";

const NOW = "2026-11-19T12:00:00.000Z";
const gr = (id, status, shelf, extra = {}) => ({
  id, status, refs: { goodreadsBookId: "g" + id }, synced: { title: id, author: "A", shelf, source: "goodreads-helper" }, mine: {}, flags: {}, prereqs: [], ...extra,
});
const inc = (id, shelf, extra = {}) => ({ goodreadsBookId: "g" + id, title: id, author: "A", shelf, ...extra });

test("for Goodreads: a shelf to change, a book to take off, a book not there; paused and matching books left alone", () => {
  const books = [
    gr("same", "want", "to-read"),
    gr("fin", "read", "currently-reading"),
    gr("began", "reading", "to-read"),
    gr("aside", "abandoned", "to-read"),
    gr("asideoff", "abandoned", null),
    gr("paused", "paused", "currently-reading"),
    gr("gone", "want", "to-read", { flags: { goneFromGoodreads: NOW } }),
    { id: "hand", status: "want", refs: {}, synced: null, mine: { title: "Hand" }, flags: {} },
  ];
  const got = changesForGoodreads(books).map(x => [x.id, x.kind, x.to]);
  assert.deepEqual(got, [["fin", "shelf", "read"], ["began", "shelf", "currently-reading"], ["aside", "off", null], ["hand", "missing", "to-read"]]);
});

test("for Goodreads: Done hides an item until the book or its shelf changes", () => {
  const b = gr("fin", "read", "currently-reading");
  const [item] = changesForGoodreads([b]);
  b.flags.grDone = doneMark(b, item);
  assert.equal(changesForGoodreads([b]).length, 0);
  assert.equal(changesForGoodreads([{ ...b, synced: { ...b.synced, shelf: "to-read" } }]).length, 1);
  assert.equal(changesForGoodreads([{ ...b, status: "abandoned" }])[0].kind, "off"); // a new change: shown again
  assert.equal(changesForGoodreads([{ ...b, status: "want" }])[0].to, "to-read");
});

test("links: the book page, or a search for one not on Goodreads", () => {
  assert.equal(bookUrl(gr("x", "want", "to-read")), "https://www.goodreads.com/book/show/gx");
  assert.equal(searchUrl("Stoner", "John Williams"), "https://www.goodreads.com/search?q=Stoner%20John%20Williams");
});

test("bookmarklet payload: mapped to incoming, unknown fields not blanked, wrong payload refused", () => {
  const got = fromBookmarklet({ format: "antilibrary-goodreads-sync", books: [{ book_id: 12, title: "T", author: "A", shelf: "to-read", pages: 200, year_original: 1965, position: 3 }] });
  assert.deepEqual(got[0], { goodreadsBookId: "12", workId: null, title: "T", author: "A", isbn13: null, pages: 200, year: 1965, shelf: "to-read", dateAdded: null, dateStarted: null, dateRead: null, position: 3, coverUrl: null });
  assert.ok(!("binding" in got[0]) && !("rating" in got[0]));
  assert.throws(() => fromBookmarklet({ books: [] }), /bookmarklet/);
});

test("shelf moved on Goodreads: followed when the app hadn't changed it, or when it's been read there", () => {
  const books = [
    gr("a", "want", "to-read"),            // started there → follow
    gr("b", "reading", "to-read"),         // started here and finished there → follow (read wins)
    gr("c", "abandoned", "to-read"),       // set aside here, started there → app stands
    gr("d", "reading", "currently-reading"),
  ];
  const plan = planImport(books, [inc("a", "currently-reading", { dateStarted: "2026-11-10" }), inc("b", "read", { dateRead: "2026-11-18" }), inc("c", "currently-reading"), inc("d", "currently-reading")], { now: NOW, source: "goodreads-helper" });
  assert.deepEqual(plan.adopt.map(m => [m.id, m.to]), [["a", "reading"], ["b", "read"]]);
  assert.equal(new Date(plan.adopt[0].at).getDate(), 10);
});

test("a finished book taken off Goodreads' shelves notes it's on none of them; new waiting books are flagged to be placed", () => {
  const keys = keysBetween(null, null, 2);
  const books = [gr("r", "read", "read"), { ...gr("w", "want", "to-read"), queueKey: keys[0] }];
  const plan = planImport(books, [inc("w", "to-read"), inc("n", "to-read")], { now: NOW, source: "goodreads-helper" });
  assert.equal(plan.updates.find(u => u.id === "r").synced.shelf, null);
  assert.equal(plan.creates[0].book.flags.placeByYouth, true);
  const first = planImport([], [inc("n", "to-read")], { now: NOW });
  assert.ok(!first.creates[0].book.flags.placeByYouth, "a first import keeps Goodreads' order");
});

test("youth slot: among neighbours in a youth-ordered list, before unscored books, best fit in a jumbled one", () => {
  const keys = keysBetween(null, null, 8);
  const b = (id, i, youth) => ({ id, status: "want", queueKey: keys[i], prereqs: [], mine: {}, score: youth == null ? null : { youth } });
  const list = [b("a", 0, 10), b("b", 1, 30), b("c", 2, 50), b("d", 3, 70), b("u", 4, null), b("x", 5, 40)];
  assert.equal(youthSlot(list, "x"), 2);                        // between 30 and 50
  assert.deepEqual(moveTo(list, "x", 2).ids, ["a", "b", "x", "c", "d", "u"]);
  assert.equal(youthSlot([...list.slice(0, 5), b("x", 5, 95)], "x"), 4); // after 70, before the unscored
  assert.equal(youthSlot([...list.slice(0, 5), b("x", 5, 30)], "x"), 2); // after an equal figure
  assert.equal(youthSlot([b("p", 0, 60), b("q", 1, 10), b("r", 2, 70), b("x", 3, 65)], "x"), 2);
  assert.equal(youthSlot([b("p", 0, 60), b("x", 1, null)], "x"), null);
});

test("editions: a switch on Goodreads is followed (same work, or the old book gone and a lookalike in its place)", () => {
  const books = [
    { ...gr("fiesta", "reading", "currently-reading"), refs: { goodreadsBookId: "266466", goodreadsWorkId: "589497" }, synced: { title: "Fiesta: The Sun Also Rises", author: "Ernest Hemingway", shelf: "currently-reading", pages: 216, source: "goodreads-helper" } },
    { ...gr("dq", "reading", "currently-reading"), refs: { goodreadsBookId: "3836", goodreadsWorkId: "121842" }, synced: { title: "Don Quixote", author: "Miguel de Cervantes Saavedra", shelf: "currently-reading", pages: 1023, source: "goodreads-helper" } },
    { ...gr("post", "reading", "currently-reading"), refs: { goodreadsBookId: "40409718" }, synced: { title: "Post Office", author: "Charles Bukowski", shelf: "currently-reading", source: "goodreads-helper" } },
  ];
  const plan = planImport(books, [
    { goodreadsBookId: "602925", workId: "589497", title: "Fiesta: The Sun Also Rises", author: "Ernest Hemingway", shelf: "currently-reading", pages: 240 },
    { goodreadsBookId: "975465", workId: "90895262", title: "Don Quixote, Part One", author: "Miguel de Cervantes Saavedra", shelf: "currently-reading", pages: 528 },
    { goodreadsBookId: "40409718", title: "Post Office", author: "Charles Bukowski", shelf: "currently-reading" },
  ], { now: NOW, source: "goodreads-helper" });
  assert.deepEqual(plan.relinks.sort(), ["dq", "fiesta"]);
  assert.equal(plan.creates.length, 0); assert.equal(plan.asks.length, 0); assert.equal(plan.gone.length, 0);
  const dq = plan.updates.find(u => u.id === "dq");
  assert.deepEqual([dq.refs.goodreadsBookId, dq.relink.sameWork, dq.relink.newPages], ["975465", false, 528]);
  assert.equal(plan.updates.find(u => u.id === "fiesta").relink.sameWork, true);
});

test("editions: while the old edition is still on the shelves, a lookalike is asked about, not merged", () => {
  const books = [{ ...gr("w", "want", "to-read"), refs: { goodreadsBookId: "66933", goodreadsWorkId: "865773" }, synced: { title: "The Wretched of the Earth", author: "Frantz Fanon", shelf: "to-read", source: "goodreads-helper" } }];
  const plan = planImport(books, [inc("w", "to-read", { goodreadsBookId: "66933" }), { goodreadsBookId: "539813", workId: "865773", title: "The Wretched of the Earth", author: "Frantz Fanon", shelf: "to-read" }], { now: NOW });
  assert.equal(plan.relinks.length, 0); assert.equal(plan.asks.length, 1);
});

test("editions: the edition you chose is matched when Goodreads catches up, and isn't flagged gone", () => {
  const b = { ...gr("w", "want", "to-read"), refs: { goodreadsBookId: "66933", goodreadsWorkId: "865773" }, mine: { grEdition: { id: "539813", pages: 316, coverUrl: "c.jpg", binding: "Paperback" } } };
  const plan = planImport([b], [{ goodreadsBookId: "539813", workId: "865773", title: "The Wretched of the Earth", author: "Frantz Fanon", shelf: "to-read" }], { now: NOW });
  assert.equal(plan.updates[0].refs.goodreadsBookId, "539813");
  assert.equal(plan.gone.length, 0); assert.equal(plan.creates.length, 0);
});

test("editions: what you chose shows (pages, cover, binding), and Goodreads is asked to switch", async () => {
  const { effective } = await import("../app/js/domain.js");
  const b = { ...gr("w", "want", "to-read"), refs: { goodreadsBookId: "66933", goodreadsWorkId: "865773" }, synced: { title: "W", shelf: "to-read", pages: 251, coverUrl: "old.jpg", source: "goodreads-helper" }, mine: { grEdition: { id: "539813", pages: 316, coverUrl: "new.jpg", binding: "Paperback", publisher: "Grove Press" } } };
  const e = effective(b);
  assert.deepEqual([e.pages, e.coverUrl, e.edition, e.publisher], [316, "new.jpg", "Paperback", "Grove Press"]);
  assert.deepEqual(changesForGoodreads([b]).map(x => [x.kind, x.to]), [["edition", "539813"]]);
  const coverOnly = { ...b, mine: { grEdition: { id: "539813", coverUrl: "new.jpg", coverOnly: true } } };
  assert.deepEqual([effective(coverOnly).pages, effective(coverOnly).coverUrl], [251, "new.jpg"]);
  assert.equal(changesForGoodreads([coverOnly]).length, 0);
});

test("a Goodreads link or number gives the book number", async () => {
  const { bookIdFrom } = await import("../app/js/goodreads.js");
  assert.equal(bookIdFrom("https://www.goodreads.com/book/show/539813.The_Wretched_of_the_Earth"), "539813");
  assert.equal(bookIdFrom("https://www.goodreads.com/book/show/210451639-tolerance-is-a-wasteland"), "210451639");
  assert.equal(bookIdFrom(" 975465 "), "975465");
  assert.equal(bookIdFrom("not a link"), null);
});

test("repair: a book added with no history that is really a new edition of one you have is merged into it", () => {
  const old = { ...gr("dq", "reading", "currently-reading"), createdAt: "2026-11-01", refs: { goodreadsBookId: "3836", goodreadsWorkId: "121842" }, synced: { title: "Don Quixote", author: "Miguel de Cervantes Saavedra", shelf: "currently-reading", pages: 1023, source: "goodreads-helper" }, flags: { goneFromGoodreads: NOW } };
  const dup = { ...gr("dq2", "reading", "currently-reading"), createdAt: "2026-11-19", refs: { goodreadsBookId: "975465", goodreadsWorkId: "90895262" }, synced: { title: "Don Quixote, Part One", author: "Miguel de Cervantes Saavedra", shelf: "currently-reading", pages: 528, source: "goodreads-helper" } };
  const plan = planImport([old, dup], [{ goodreadsBookId: "975465", workId: "90895262", title: "Don Quixote, Part One", author: "Miguel de Cervantes Saavedra", shelf: "currently-reading", pages: 528 }],
    { now: NOW, source: "goodreads-helper", hasHistory: id => id === "dq" });
  assert.deepEqual(plan.merges, [{ keep: "dq", drop: "dq2" }]);
  const u = plan.updates.find(x => x.id === "dq");
  assert.equal(u.refs.goodreadsBookId, "975465");
  assert.ok(plan.back.includes("dq") && !plan.gone.includes("dq") && !plan.updates.some(x => x.id === "dq2"));
  const careful = planImport([old, dup], [{ goodreadsBookId: "975465", workId: "90895262", title: "Don Quixote, Part One", author: "Miguel de Cervantes Saavedra", shelf: "currently-reading" }],
    { now: NOW, source: "goodreads-helper", hasHistory: () => true });
  assert.equal(careful.merges.length, 0, "a book you've read in is never merged away");
});
