import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { csvObjects, goodreadsRows, isGoodreadsExport, parseCsv } from "../app/js/csv.js";
import { keyBetween, keysBetween } from "../app/js/keys.js";
import {
  planImport, effective, eventsByBook, currentPage, logPage, logPages, undoLast, changeStatus,
  bookDates, mergeArchives, makeArchive, validateArchive, manualBook, normTitle, resolveAsk, byQueue, defaultSettings,
} from "../app/js/domain.js";
import { migrate } from "../app/js/migrations.js";

const NOW = "2026-11-18T20:00:00.000Z";
const sample = () => goodreadsRows(csvObjects(readFileSync(new URL("./fixtures/goodreads-sample.csv", import.meta.url), "utf8")));
const importAll = (books = [], inc = sample()) => {
  const plan = planImport(books, inc, { now: NOW });
  return { plan, books: [...books, ...plan.creates.map(c => c.book)], events: plan.creates.flatMap(c => c.events) };
};

test("CSV: quotes, embedded commas, doubled quotes, BOM", () => {
  const rows = parseCsv('﻿a,b\n"x, y","say ""hi"""\n');
  assert.deepEqual(rows, [["a", "b"], ["x, y", 'say "hi"']]);
});

test("Goodreads export: fields mapped, ISBN unwrapped, original year preferred", () => {
  const objs = csvObjects(readFileSync(new URL("./fixtures/goodreads-sample.csv", import.meta.url), "utf8"));
  assert.ok(isGoodreadsExport(objs));
  const r = goodreadsRows(objs);
  const chess = r.find(x => x.goodreadsBookId === "59219");
  assert.equal(chess.isbn13, "9781590171691");
  assert.equal(chess.year, 1942);
  assert.equal(chess.pages, 96);
  assert.equal(chess.dateAdded, "2026-11-01");
  assert.equal(r.find(x => x.title === "Don Quixote").isbn13, null);
  assert.equal(r.find(x => x.title === "Ulysses").position, 1);
});

test("keys: always strictly between, stay short for hundreds", () => {
  const ks = keysBetween(null, null, 500);
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i - 1] < ks[i]);
  assert.ok(Math.max(...ks.map(k => k.length)) <= 3);
  const k = keyBetween(ks[10], ks[11]);
  assert.ok(ks[10] < k && k < ks[11]);
  assert.ok(!k.endsWith("0"));
});

test("import: shelves -> statuses, custom shelves skipped, queue in Goodreads order", () => {
  const { plan, books, events } = importAll();
  assert.equal(plan.creates.length, 5);
  assert.deepEqual(plan.skipped, { climbing: 1 });
  const want = books.filter(b => b.status === "want").sort(byQueue).map(b => effective(b).title);
  assert.deepEqual(want, ["Ulysses", "Don Quixote", "The Master and Margarita"]);
  const sid = books.find(b => b.synced.title === "Siddhartha");
  assert.equal(sid.status, "read");
  const ev = eventsByBook(events).get(sid.id);
  assert.equal(currentPage(ev), 152);
  assert.equal(bookDates(ev).finished.slice(0, 10), "2025-12-27");
  assert.equal(books.find(b => b.synced.title === "Chess Story").status, "reading");
});

test("re-import is idempotent and never touches your edits", () => {
  const first = importAll();
  const chess = first.books.find(b => b.synced.title === "Chess Story");
  chess.mine = { pages: 110, annotation: "" };
  const again = planImport(first.books, sample(), { now: "2026-11-19T00:00:00.000Z" });
  assert.equal(again.creates.length, 0);
  assert.equal(again.updates.length, 0);
  assert.equal(again.unchanged, 5);
  assert.equal(effective(chess).pages, 110);
  assert.equal(effective(chess).annotation, "");
});

test("import updates synced facts only; mine wins on display", () => {
  const first = importAll();
  const inc = sample();
  inc.find(x => x.title === "Ulysses").pages = 800;
  const plan = planImport(first.books, inc, { now: NOW });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].synced.pages, 800);
  assert.equal("mine" in plan.updates[0], false);
});

test("a book gone from Goodreads is flagged, not deleted; a lookalike is asked about", () => {
  const first = importAll();
  const inc = sample().filter(x => x.title !== "Don Quixote");
  inc.push({ ...sample().find(x => x.title === "Ulysses"), goodreadsBookId: "999", isbn13: null, title: "Ulysses (Annotated)" });
  const plan = planImport(first.books, inc, { now: NOW });
  assert.equal(plan.gone.length, 1);
  assert.equal(plan.asks.length, 1);
  assert.equal(plan.asks[0].kind, "same-book");
  const res = resolveAsk(plan.asks[0], "link", first.books, { now: NOW });
  assert.equal(res.updates[0].refs.goodreadsBookId, "999");
});

test("logging: +pages clamps to the book, starts a want-book, undo reverses both", () => {
  const { books, events } = importAll();
  const uly = books.find(b => b.synced.title === "Ulysses");
  const evs = eventsByBook(events).get(uly.id);
  const r = logPages(uly, evs, 5, NOW);
  assert.equal(r.events[0].page, 5);
  assert.equal(r.patch.status, "reading");
  const after = [...evs, ...r.events];
  assert.equal(logPage({ ...uly, status: "reading" }, after, 10000, NOW).events[0].page, 783);
  const u = undoLast({ ...uly, status: "reading" }, after);
  assert.equal(u.remove.length, 2);
  assert.equal(u.patch.status, "want");
  assert.equal(logPage(uly, evs, 0, NOW), null);
});

test("finishing jumps to the last page and records the date", () => {
  const { books, events } = importAll();
  const chess = books.find(b => b.synced.title === "Chess Story");
  const evs = eventsByBook(events).get(chess.id);
  const r = changeStatus(chess, evs, "read", NOW);
  const all = [...evs, ...r.events];
  assert.equal(currentPage(all), 96);
  assert.equal(bookDates(all).finished, NOW);
});

test("archives: merge unions events, newer book wins, deletions stick", () => {
  const { books, events } = importAll();
  const settings = defaultSettings(NOW);
  const a = makeArchive({ books, events, tombstones: [], settings }, NOW);
  const b = structuredClone(a);
  const uly = b.books.find(x => x.synced.title === "Ulysses");
  uly.status = "reading"; uly.updatedAt = "2026-11-20T00:00:00.000Z";
  const added = { id: "e_X", bookId: uly.id, at: "2026-11-20T00:00:00.000Z", type: "progress", page: 12, prevPage: 0, source: "app" };
  b.events.push(added);
  const gone = a.events.find(e => e.type === "status");
  a.tombstones.push({ id: gone.id, at: NOW });
  const m = mergeArchives(a, b);
  assert.equal(m.books.find(x => x.id === uly.id).status, "reading");
  assert.ok(m.events.some(e => e.id === "e_X"));
  assert.ok(!m.events.some(e => e.id === gone.id));
  assert.equal(m.stats.eventsAdded, 1);
  assert.equal(validateArchive(a), null);
  assert.match(validateArchive({ format: "x" }), /isn't a Tsundoku Tracker/);
});

test("migrations run in order and refuse gaps", () => {
  const table = { 1: a => ({ ...a, schemaVersion: 2, extra: true }), 2: a => ({ ...a, schemaVersion: 3 }) };
  assert.equal(migrate({ schemaVersion: 1 }, table, 3).extra, true);
  assert.throws(() => migrate({ schemaVersion: 1 }, {}, 2), /No migration/);
});

test("manual books and title normalisation", () => {
  const { book } = manualBook({ title: " Nausea ", author: "Jean-Paul Sartre", pages: "178" }, "V", NOW);
  assert.equal(effective(book).title, "Nausea");
  assert.equal(effective(book).pages, 178);
  assert.equal(normTitle("The Fire Next Time (Vintage International)"), "fire next time");
  assert.equal(normTitle("Fiesta: The Sun Also Rises"), "fiesta");
});

const real = `${process.env.HOME}/Downloads/goodreads_library_export (2).csv`;
test("your real export imports cleanly (local only)", { skip: !existsSync(real) }, () => {
  const inc = goodreadsRows(csvObjects(readFileSync(real, "utf8")));
  const plan = planImport([], inc, { now: NOW });
  const st = plan.creates.reduce((m, c) => ((m[c.book.status] = (m[c.book.status] || 0) + 1), m), {});
  assert.deepEqual(st, { want: 162, reading: 4, read: 14 });
  assert.equal(plan.asks.length, 0);
  const again = planImport(plan.creates.map(c => c.book), inc, { now: NOW });
  assert.equal(again.creates.length + again.updates.length, 0);
});
