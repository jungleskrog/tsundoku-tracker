import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrate, observed, bookPace, sessionLength, sessionsOf } from "../app/js/calib.js";
import { params, speed } from "../app/js/model.js";
import { defaultSettings, eventsByBook } from "../app/js/domain.js";

const p = params(defaultSettings("2026-11-01T00:00:00.000Z"));          // v1 300, v10 75
const book = (id, C, words = 60000, pages = 200) => ({ id, status: "reading", refs: {}, synced: { title: id, pages }, mine: {}, score: { C, words } });
let n = 0;
/** A session where you read at `wpm` words a minute for `minutes` on book b. */
const session = (b, wpm, minutes = 40) => {
  const wpp = b.score.words / b.synced.pages;                            // 300 words a page
  const pages = Math.round((wpm * minutes) / wpp);
  return { id: "s" + ++n, bookId: b.id, at: `2026-11-${10 + (n % 15)}T21:00:00.000Z`, type: "session", minutes, fromPage: 10, toPage: 10 + pages, source: "app" };
};

test("one session tells the speed at its book's difficulty; forgotten or tiny sessions tell nothing", () => {
  const b = book("a", 1);
  const o = observed(b, { ...session(b, 360), pages: 48 });
  assert.equal(Math.round(o.v), 360);
  assert.equal(observed(b, { minutes: 200, pages: 40, capped: true }), null);
  assert.equal(observed(b, { minutes: 3, pages: 2 }), null);
  assert.equal(observed({ ...b, score: null }, { minutes: 40, pages: 40 }), null);
});

test("calibration: a faster easy reader and a slower hard reader are found, held toward the settings at first", () => {
  const easy = book("e", 2), hard = book("h", 9);
  const truth = { v1: 420, v10: 55 };
  const at = C => truth.v1 * Math.pow(truth.v10 / truth.v1, (C - 1) / 9);
  const one = calibrate([easy], eventsByBook([session(easy, at(2))]), p);
  assert.ok(one.v1 > 300 && one.v1 < 420, `one session moves part way (${one.v1})`);
  assert.equal(one.ready, false);
  const evs = [];
  for (let i = 0; i < 6; i++) { evs.push(session(easy, at(2), 45)); evs.push(session(hard, at(9), 45)); }
  const many = calibrate([easy, hard], eventsByBook(evs), p);
  assert.ok(Math.abs(many.v1 - 420) < 40 && Math.abs(many.v10 - 55) < 10, `close to the truth (${many.v1}, ${many.v10})`);
  assert.deepEqual([many.ready, many.sure], [true, "good"]);
  assert.ok(Math.abs(speed(2, { ...p, v1: many.v1, v10: many.v10 }) - at(2)) / at(2) < 0.1);
});

test("one book's measured pace beside the model's; a session's length is capped", () => {
  const b = book("a", 5);
  const pace = bookPace(b, eventsByBook([session(b, 200, 30), session(b, 200, 30)]), p);
  assert.equal(pace.n, 2);
  assert.ok(Math.abs(pace.mpp - 1.5) < 0.1);
  assert.ok(pace.model > 0);
  assert.deepEqual(sessionLength("2026-11-19T20:00:00Z", "2026-11-19T20:42:10Z"), { minutes: 42, capped: false });
  assert.deepEqual(sessionLength("2026-11-19T10:00:00Z", "2026-11-19T20:00:00Z"), { minutes: 180, capped: true });
  assert.equal(sessionsOf([b], eventsByBook([{ id: "x", bookId: "a", type: "session", minutes: 0 }])).length, 0);
});
