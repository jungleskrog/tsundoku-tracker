import { test } from "node:test";
import assert from "node:assert/strict";
import { params, speed, minutesPerPage, pageDifficulty, pagesPerToken, forecast, learnedShares, phraseWhen, ledger, ledgerWords, paceSpread, readingBand, difficultyOf, earnings } from "../app/js/model.js";
import { defaultSettings, eventsByBook } from "../app/js/domain.js";

const S = defaultSettings("2026-11-18T09:00:00.000Z");
const P = params(S);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test("§7 step 1: speed falls 14% a step, 300 → 75 wpm", () => {
  near(speed(1, P), 300, 0.01, "C1"); near(speed(3, P), 220, 1, "C3"); near(speed(6, P), 139, 1, "C6"); near(speed(10, P), 75, 0.01, "C10");
});

test("§7 worked examples: D from words, pages and content", () => {
  near(pageDifficulty({ words: 26880, pages: 96, C: 3 }, P), 3.3, 0.05, "Chess Story");
  near(pageDifficulty({ words: 142080, pages: 384, C: 6 }, P), 6.5, 0.05, "Master and Margarita");
  near(pageDifficulty({ words: 260000, pages: 650, C: 10 }, P), 9.5, 0.05, "Ulysses");
});

test("§7: pages for 10 tokens at D 3, 6, 10 and the extremes", () => {
  near(10 * pagesPerToken(3, P), 33.6, 0.1, "D3"); near(10 * pagesPerToken(6, P), 16.8, 0.1, "D6"); near(10 * pagesPerToken(10, P), 6.7, 0.05, "D10");
  near(pagesPerToken(1, P), 5.33, 0.01, "D1"); near(minutesPerPage(10, P) / minutesPerPage(1, P), 8, 1e-9, "ratio");
});

test("edition independence: total effort is the same in large print", () => {
  const total = (words, pages, C) => pages * minutesPerPage(pageDifficulty({ words, pages, C }, P), P);
  near(total(142080, 384, 6), total(142080, 480, 6), 0.5, "minutes");
});

const book = (id, D, pages, status, page = 0, extra = {}) => ({ id, status, mine: { pages, difficulty: D }, synced: { title: id }, queueKey: extra.key || null, prereqs: extra.prereqs || [], sharePin: extra.pin ?? null });
const progress = (id, page, at = "2026-11-18T08:00:00.000Z") => ({ id: `e-${id}`, bookId: id, at, type: "progress", page, prevPage: 0, source: "import" });
const NOW = new Date(2026, 10, 18, 9, 0); // Wed 18 Nov 2026, 09:00 local
const run = (books, evs, extra = {}) => forecast({ books, byBook: eventsByBook(evs), settings: { ...S, ...extra.settings }, now: NOW, ...extra });

test("§8 your example: equal shares finish on days 6, 48, 118", () => {
  const books = [book("chess", 3, 96, "reading"), book("mm", 6, 384, "reading"), book("uly", 10, 650, "reading")];
  const r = run(books, [progress("chess", 38), progress("uly", 32)]);
  assert.equal(Math.ceil(r.get("chess").finish), 6);
  assert.equal(Math.ceil(r.get("mm").finish), 48);
  assert.equal(Math.ceil(r.get("uly").finish), 118);
});

test("§8: shares change the order books finish in, never the total", () => {
  const books = [book("chess", 3, 96, "reading"), book("mm", 6, 384, "reading"), book("uly", 10, 650, "reading")];
  const shares = new Map([["chess", 0.4], ["mm", 0.4], ["uly", 0.2]]);
  const r = run(books, [progress("chess", 38), progress("uly", 32)], { shares });
  assert.equal(Math.ceil(r.get("chess").finish), 5);
  assert.equal(Math.ceil(r.get("mm").finish), 37);
  assert.equal(Math.ceil(r.get("uly").finish), 118);
  near(r.get("chess").todayTokens * pagesPerToken(3, P), 13.4, 0.1, "Chess pages today");
});

test("queue: the next book starts when a slot frees; prerequisites wait", () => {
  const books = [book("a", 5, 50, "reading"), book("pre", 5, 100, "want", 0, { key: "V" }), book("b", 5, 40, "want", 0, { key: "M", prereqs: ["pre"] }), book("c", 5, 30, "want", 0, { key: "a" })];
  const r = run(books, []);
  assert.equal(r.get("b").start >= Math.floor(r.get("pre").finish), true, "b waits for its prerequisite (starts the day it finishes)");
  assert.ok(r.get("c").start >= r.get("pre").start, "c after pre in queue order");
  assert.ok(r.get("a").finish < r.get("pre").start + 1);
});

test("pinned share comes off the top; unknown page counts are reported", () => {
  const books = [book("pinned", 10, 650, "reading", 0, { pin: 2 }), book("other", 3, 96, "reading"), { id: "nopages", status: "want", mine: {}, synced: { title: "x" }, prereqs: [] }];
  const r = run(books, []);
  near(r.get("pinned").todayTokens, 2, 1e-6, "pin");
  near(r.get("other").todayTokens, 8, 1e-6, "rest");
  assert.equal(r.get("nopages").unknown, true);
});

test("learned shares: recent reading counts most, untouched books keep a floor", () => {
  const ev = d => ({ bookId: "uly", at: new Date(2026, 10, 18 - d, 20).toISOString(), tokens: 10 });
  const earned = [1, 2, 3, 4].map(ev);
  const s = learnedShares(["uly", "chess", "mm"], earned, NOW, { firstUse: new Date(2026, 9, 1) });
  assert.ok(s.get("uly") > 0.9);
  near(s.get("chess"), (0.1 / 3) / (1 + 0.2 / 3), 1e-9, "floor");
  const even = learnedShares(["uly", "chess"], earned, NOW, { firstUse: new Date(2026, 10, 10) });
  assert.equal(even.get("chess"), 0.5);
});

test("phrasing grows vaguer with distance", () => {
  const p = (c, e, l, band) => phraseWhen(c, e, l, NOW, band).phrase;
  assert.equal(p(0.4, 0.3, 0.5, "evening"), "this evening");
  assert.equal(p(5.5, 5.3, 5.8, "evening"), "on Monday evening");
  assert.equal(p(5.5, 5.3, 5.8, null), "on Monday");
  assert.equal(p(4.5, 3.6, 5.4), "on Saturday or Monday");
  assert.equal(p(20, 15, 28), "in the second week of December");
  assert.equal(p(110, 95, 140), "in early March 2027");
  assert.equal(p(110, 85, 155), "in spring 2027");
  assert.equal(p(300, 230, 430), "in autumn 2027");
  assert.equal(p(1500, 1150, 2100), "in 2030");
});

test("ledger: today never counts against you; ahead and behind in words", () => {
  const settings = { ...S, dailyTokens: 10 };
  const firstUse = new Date(2026, 10, 15, 10).toISOString();
  const earned = [{ day: "2026-11-15", tokens: 12 }, { day: "2026-11-16", tokens: 10 }, { day: "2026-11-17", tokens: 2 }, { day: "2026-11-18", tokens: 3 }];
  const l = ledger({ earned, events: [], settings, now: NOW, firstUse });
  assert.equal(l.planned, 30);
  assert.equal(l.earned, 27);
  assert.equal(l.todayTokens, 3);
  assert.equal(ledgerWords(l, 10).text, "On course.");
  const behind = ledgerWords({ ...l, balance: -14 }, 10, "Ulysses", minutesPerPage(10, P) / 4);
  assert.equal(behind.text, "A little behind: 14 tokens, about 9 pages of Ulysses.");
  assert.match(ledgerWords({ ...l, balance: 40 }, 10).text, /^About 4 days' reading ahead/);
});

test("goal changes don't rewrite the past", () => {
  const settings = { ...S, dailyTokens: 20 };
  const events = [{ type: "goal", at: new Date(2026, 10, 17, 8).toISOString(), dailyTokens: 20 }];
  const l = ledger({ earned: [], events, settings: { ...settings, dailyTokens: 10 }, now: NOW, firstUse: new Date(2026, 10, 15).toISOString() });
  assert.equal(l.planned, 10 + 10 + 20);
});

test("spread and reading time come from your history", () => {
  assert.deepEqual(paceSpread([], NOW, null), { lo: 0.7, hi: 1.3, measured: false });
  const earned = Array.from({ length: 30 }, (_, i) => ({ at: new Date(2026, 10, 17 - i, 21).toISOString(), tokens: i % 2 ? 6 : 14 }));
  const sp = paceSpread(earned, NOW, new Date(2026, 9, 1));
  assert.ok(sp.measured && sp.lo < 1 && sp.hi > 1);
  assert.equal(readingBand(earned, NOW), "evening");
});

test("difficulty: yours, then the AI's, then a provisional 5", () => {
  assert.deepEqual(difficultyOf({ mine: { difficulty: 7 } }, P), { D: 7, source: "yours" });
  assert.equal(difficultyOf({ mine: {}, synced: { pages: 96 }, score: { words: 26880, C: 3 } }, P).source, "ai");
  assert.equal(difficultyOf({ mine: {}, synced: {} }, P).source, "provisional");
  const e = earnings([{ id: "x", mine: { difficulty: 10 } }], new Map([["x", [{ type: "progress", source: "app", page: 6, prevPage: 0, at: NOW.toISOString() }]]]), P);
  near(e[0].tokens, 6 * 6 / 4, 1e-9, "tokens earned");
});

test("today: a book that has met its share is done; reading beyond it comes out of the others", () => {
  const books = [book("a", 5, 300, "reading"), book("b", 5, 300, "reading")];
  const shares = new Map([["a", 0.5], ["b", 0.5]]);
  const met = run(books, [], { shares, earnedToday: 5, earnedTodayBy: new Map([["a", 5]]) });
  near(met.get("a").todayTokens, 0, 1e-9, "a met its share");
  near(met.get("b").todayTokens, 5, 1e-9, "b keeps its share");
  const beyond = run(books, [], { shares, earnedToday: 7, earnedTodayBy: new Map([["a", 7]]) });
  near(beyond.get("a").todayTokens, 0, 1e-9, "a over");
  near(beyond.get("b").todayTokens, 3, 1e-9, "b gets what's left of the day");
  const part = run(books, [], { shares, earnedToday: 2, earnedTodayBy: new Map([["a", 2]]) });
  near(part.get("a").todayTokens, 3, 1e-9, "a has 3 left");
  near(part.get("b").todayTokens, 5, 1e-9, "b untouched");
});

test("an implausible words-a-page is treated as a typical page, not trusted", () => {
  const over = pageDifficulty({ words: 90000, pages: 128, C: 4 }, P);   // 703 words a page: estimate too high
  const typical = pageDifficulty({ words: 480 * 128, pages: 128, C: 4 }, P);
  near(over, typical, 1e-9, "clamped at 480");
  near(pageDifficulty({ words: 2400, pages: 56, C: 6 }, P), pageDifficulty({ words: 180 * 56, pages: 56, C: 6 }, P), 1e-9, "clamped at 180");
});
