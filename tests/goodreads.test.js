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
