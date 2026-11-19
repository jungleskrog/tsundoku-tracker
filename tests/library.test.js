import { test } from "node:test";
import assert from "node:assert/strict";
import { inWords, duration, colophon, colophonText, measure, wallLabel, weekFacts, shelfLetter, weekStart, monthPhrase, letterWeeks, commonplace } from "../app/js/library.js";
import { params } from "../app/js/model.js";
import { defaultSettings, eventsByBook } from "../app/js/domain.js";

const p = params(defaultSettings("2026-11-01T00:00:00.000Z"));
const at = (day, h = 21) => new Date(2026, 10, day, h, 0, 0).toISOString();   // November 2026, local time
const book = (id, extra = {}) => ({ id, status: "read", refs: {}, synced: { title: id.toUpperCase(), author: "A", pages: 200 }, mine: { difficulty: 5 }, flags: {}, prereqs: [], createdAt: at(1), ...extra });
const ev = (bookId, a, extra) => ({ id: bookId + a + JSON.stringify(extra), bookId, at: a, source: "app", ...extra });

test("words: numbers and durations read naturally", () => {
  assert.deepEqual([inWords(0), inWords(7), inWords(40), inWords(45), inWords(120)], ["no", "seven", "forty", "forty-five", "120"]);
  assert.deepEqual([duration(3), duration(38), duration(60), duration(95), duration(400)], ["a few minutes", "forty minutes", "an hour", "an hour and a half", "six and a half hours"]);
});

test("colophon: dates, sittings, longest sitting; set aside with dignity; Goodreads-only books", () => {
  const events = [
    ev("x", at(3), { type: "status", from: "want", to: "reading" }),
    ev("x", at(3), { type: "progress", page: 40, prevPage: 0 }),
    ev("x", at(5), { type: "progress", page: 60, prevPage: 40 }),
    ev("x", at(5, 22), { type: "progress", page: 120, prevPage: 60 }),
    ev("x", at(9), { type: "progress", page: 200, prevPage: 120 }),
    ev("x", at(9), { type: "status", from: "reading", to: "read" }),
  ];
  const c = colophon(book("x"), events, p);
  assert.deepEqual([c.days, c.sittings, c.pagesHere, c.longest.pages], [7, 3, 200, 80]);
  const text = colophonText(c).join(" ");
  assert.match(text, /Begun Tuesday 3 November 2026 and finished Monday 9 November 2026: seven days, in three sittings/);
  assert.match(text, /The longest sitting: 80 pages, on Thursday 5 November/);
  const aside = colophonText(colophon(book("y", { status: "abandoned" }), [ev("y", at(2), { type: "progress", page: 50, prevPage: 0 }), ev("y", at(4), { type: "status", from: "reading", to: "abandoned" })], p)).join(" ");
  assert.match(aside, /Set aside on Wednesday 4 November 2026 at page 50 of 200 \(25%\), after one sitting\. It keeps its place/);
  const gr = colophonText(colophon(book("z"), [{ ...ev("z", at(1), { type: "status", from: "want", to: "read" }), approx: true, source: "goodreads-csv" }], p)).join(" ");
  assert.match(gr, /as recorded on Goodreads/);
});

test("wall label: totals, weights, and how Next compares", () => {
  const w = [...Array(5)].map((_, i) => book("h" + i, { status: "want", mine: { difficulty: 8 } })).concat([...Array(15)].map((_, i) => book("l" + i, { status: "want", mine: { difficulty: 3 } })));
  const m = measure(w, p);
  assert.equal(m.count, 20); assert.equal(m.pages, 4000);
  assert.deepEqual(m.weights, { light: 15, middling: 0, heavy: 5 });
  const label = wallLabel(w, { next: 5, soon: 10 }, p);
  assert.match(label.compare, /^The next five are heavier than the list as a whole/);
  assert.equal(label.parts.stacks.count, 5);
});

test("shelf letter: effort in words, finishes, begun, notes, outlook; a quiet week", () => {
  const books = [book("u", { status: "reading" }), book("c")];
  const events = [
    ...[16, 17, 18, 19, 20].map((d, i) => ev("u", at(d), { type: "progress", page: (i + 1) * 10, prevPage: i * 10 })),
    ev("c", at(17), { type: "progress", page: 200, prevPage: 150 }),
    ev("c", at(19), { type: "status", from: "reading", to: "read" }),
    ev("u", at(16, 8), { type: "status", from: "want", to: "reading" }),
    ev("u", at(18), { type: "note", text: "the chess game in the ship's saloon", page: 30 }),
  ];
  const f = weekFacts({ books, byBook: eventsByBook(events), p, start: weekStart(at(18)) });
  assert.equal(f.days, 5);
  const letter = shelfLetter(f, { outlook: { inHand: [{ title: "U", finishAt: new Date(2027, 0, 28).toISOString() }], next: "M", now: at(22) }, ital: t => `*${t}*` }).join(" ");
  assert.match(letter, /most evenings to \*U\*/);
  assert.match(letter, /finished \*C\* on Thursday/);
  assert.match(letter, /\*U\* was begun on Monday|You opened \*U\* on Monday/);
  assert.match(letter, /In the margin of \*U\*, at page 30, you wrote: “the chess game in the ship's saloon”/);
  assert.match(letter, /At the present rate \*U\* will see you to the end of January 2027; \*M\* waits next on the desk\./);
  const quiet = shelfLetter(weekFacts({ books, byBook: eventsByBook(events), p, start: weekStart(at(2)) })).join(" ");
  assert.match(quiet, /quiet week|No pages were logged|away from the page/);
  assert.equal(monthPhrase(new Date(2026, 11, 14), at(1)), "mid-December");
  assert.deepEqual(letterWeeks(events, at(24)).map(d => d.getDate()), [23, 16]);
});

test("commonplace: your own lines and margin notes, by year; Goodreads quotes are not yours", () => {
  const books = [book("a", { mine: { annotation: "Mine." } }), book("b", { synced: { title: "B", quote: "Theirs." } })];
  const events = [ev("b", at(4), { type: "note", text: "a note", page: 9 })];
  const years = commonplace(books, eventsByBook(events));
  assert.equal(years[0][0], 2026);
  assert.deepEqual(years[0][1].map(x => [x.kind, x.text]).sort(), [["line", "Mine."], ["note", "a note"]]);
});
