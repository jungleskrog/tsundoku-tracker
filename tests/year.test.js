import { test } from "node:test";
import assert from "node:assert/strict";
import { yearData, yearHtml, yearSummary, readingYears } from "../app/js/year.js";
import { params } from "../app/js/model.js";
import { defaultSettings, eventsByBook } from "../app/js/domain.js";

const p = params(defaultSettings("2026-01-01T00:00:00.000Z"));
const at = (m, d, h = 21) => new Date(2026, m - 1, d, h).toISOString();
const book = (id, status, extra = {}) => ({ id, status, refs: {}, synced: { title: "Title " + id, author: extra.author || "Author " + id, pages: extra.pages ?? 200, ...(extra.synced || {}) }, mine: { difficulty: extra.D ?? 5, ...(extra.mine || {}) }, flags: {}, prereqs: [], createdAt: at(1, 1) });
const ev = (bookId, a, extra) => ({ id: `${bookId}-${a}-${extra.type}-${extra.to || extra.page || extra.text}`, bookId, at: a, source: "app", ...extra });

function library() {
  const books = [
    book("a", "read", { pages: 600, D: 7.5, author: "Zweig", mine: { annotation: "My own line <b>" } }),
    book("b", "read", { pages: 150, D: 3, author: "Zweig", synced: { quote: "Their quote." } }),
    book("c", "abandoned", { pages: 400 }),
    book("d", "read", { pages: 100 }),
    book("e", "reading"), book("f", "want"),
  ];
  const events = [
    ev("a", at(3, 2), { type: "status", from: "want", to: "reading" }), ev("a", at(3, 2), { type: "progress", page: 300, prevPage: 0 }),
    ev("a", at(3, 9), { type: "progress", page: 600, prevPage: 300 }), ev("a", at(3, 9), { type: "status", from: "reading", to: "read" }),
    ev("a", at(3, 5), { type: "note", text: "the chess game", page: 300 }),
    { ...ev("b", at(7, 1), { type: "status", from: "want", to: "read" }), approx: true, source: "goodreads-csv" },
    ev("c", at(5, 1), { type: "progress", page: 80, prevPage: 0 }), ev("c", at(5, 2), { type: "status", from: "reading", to: "abandoned" }),
    { ...ev("d", new Date(2025, 11, 30).toISOString(), { type: "status", from: "want", to: "read" }), approx: true, source: "goodreads-csv" },
  ];
  return { books, byBook: eventsByBook(events), events };
}

test("year: finishes in order, set aside, months, figures; other years left out", () => {
  const { books, byBook } = library();
  const y = yearData({ books, byBook, p, year: 2026, now: new Date(2026, 10, 19) });
  assert.deepEqual(y.finished.map(f => f.book.id), ["a", "b"]);
  assert.deepEqual(y.aside.map(a => a.book.id), ["c"]);
  assert.equal(y.months[2], 1); assert.equal(y.months[6], 1);
  assert.equal(y.pages, 750);
  assert.equal(y.longest.book.id, "a"); assert.equal(y.heaviest.book.id, "a");
  assert.deepEqual(y.topAuthor, { name: "Zweig", n: 2 });
  assert.equal(y.loggedPages, 680);
  const s = yearSummary(y).join(" ");
  assert.match(s, /In 2026 so far you finished two books, 750 pages, and set one aside\./);
  assert.match(s, /The longest was <i>Title a<\/i> \(600 pages\); the heaviest, <i>Title a<\/i> \(difficulty 7\.5\)/);
  assert.match(s, /two books by Zweig/);
  assert.equal(yearData({ books, byBook, p, year: 2025 }).finished.length, 1);
});

test("year document: title page, numbered books, quotes marked by source, notes, set aside, commonplace, colophon; text escaped", () => {
  const { books, byBook } = library();
  const y = yearData({ books, byBook, p, year: 2026, now: new Date(2026, 10, 19) });
  const doc = yearHtml(y, { reader: "A <Reader>", made: at(11, 19), links: false });
  assert.match(doc, /The Reading Year of A &lt;Reader&gt;/);
  assert.match(doc, /No\. 1<\/p>\s*<h3><i>Title a<\/i><\/h3>/);
  assert.match(doc, /My own line &lt;b&gt;/);
  assert.match(doc, /Their quote\.<span class="y-src">most-liked quote on Goodreads/);
  assert.match(doc, /<span class="y-p">p\. 300<\/span> the chess game/);
  assert.match(doc, /Set aside on Saturday 2 May 2026 at page 80 of 400 \(20%\)/);
  assert.match(doc, /Commonplace book/);
  assert.match(doc, /Made with Tsundoku Tracker on 19 November 2026/);
  assert.ok(!doc.includes("#/book/"), "no app links in the export");
  assert.ok(yearHtml(y).includes('href="#/book/a"'), "links on screen");
});

test("reading years: any year with a finish, a set-aside or logged reading, plus this one", () => {
  const { events } = library();
  assert.deepEqual(readingYears(events, new Date(2027, 0, 5)), [2027, 2026, 2025]);
});
