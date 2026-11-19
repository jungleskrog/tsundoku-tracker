import { test } from "node:test";
import assert from "node:assert/strict";
import { youthOf, youthOrder, respectPrereqs, prereqMap, needs, wouldLoop, moveTo, rekey, moves, suggestions, bandAt, bandsOf } from "../app/js/order.js";
import { keysBetween, compareKeys } from "../app/js/keys.js";
import { forecast } from "../app/js/model.js";
import { defaultSettings } from "../app/js/domain.js";

const keys = keysBetween(null, null, 10);
const bk = (id, i, youth, extra = {}) => ({
  id, status: "want", queueKey: keys[i], prereqs: [], mine: { pages: 100, difficulty: 4, ...(extra.mine || {}) }, synced: { title: id },
  score: youth == null ? null : { youth, youth_any_time: !!extra.anyTime, youth_after: extra.after || [] }, ...extra.book,
});
const order = bs => bs.slice().sort((a, b) => compareKeys(a.queueKey, b.queueKey)).map(b => b.id);

test("youth: your figure beats the AI's", () => {
  assert.equal(youthOf(bk("a", 0, 40)).youth, 40);
  const mine = youthOf(bk("a", 0, 40, { mine: { youth: 12 } }));
  assert.deepEqual([mine.youth, mine.source], [12, "yours"]);
  assert.equal(youthOf(bk("a", 0, null)).youth, null);
});

test("youth order: by youth, ties keep your order, unscored stay at the end", () => {
  const bs = [bk("a", 0, 50), bk("b", 1, null), bk("c", 2, 10), bk("d", 3, 50), bk("e", 4, 30)];
  assert.deepEqual(youthOrder(bs), ["c", "e", "a", "d", "b"]);
});

test("youth order: any-time books become evenly spread interludes", () => {
  const bs = [bk("a", 0, 10), bk("b", 1, 20), bk("c", 2, 30), bk("d", 3, 40), bk("x", 4, 5, { anyTime: true })];
  const o = youthOrder(bs);
  assert.equal(o.indexOf("x"), 2);
  assert.deepEqual(o.filter(id => id !== "x"), ["a", "b", "c", "d"]);
});

test("youth order: a prerequisite always comes first", () => {
  const bs = [bk("a", 0, 10, { book: { prereqs: ["c"] } }), bk("b", 1, 20), bk("c", 2, 80)];
  assert.deepEqual(youthOrder(bs), ["b", "c", "a"]);
});

test("prerequisites: transitive need, loops refused, and respectPrereqs survives a loop", () => {
  const map = new Map([["a", ["b"]], ["b", ["c"]], ["c", []]]);
  assert.ok(needs(map, "a", "c"));
  assert.ok(wouldLoop(map, "c", "a"));
  assert.ok(!wouldLoop(map, "a", "c"));
  assert.deepEqual(respectPrereqs(["a", "b", "c"], map), ["c", "b", "a"]);
  assert.deepEqual(respectPrereqs(["x", "a", "y", "b"], new Map([["a", ["b"]]])), ["x", "y", "b", "a"]);
  assert.deepEqual(respectPrereqs(["a", "b"], new Map([["a", ["b"]], ["b", ["a"]]])).sort(), ["a", "b"]);
});

test("moving: one key changes and the order is as asked", () => {
  const bs = [bk("a", 0, 1), bk("b", 1, 1), bk("c", 2, 1), bk("d", 3, 1)];
  const r = moveTo(bs, "d", 1);
  assert.deepEqual(r.ids, ["a", "d", "b", "c"]);
  const after = bs.map(b => (b.id === "d" ? { ...b, queueKey: r.queueKey } : b));
  assert.deepEqual(order(after), ["a", "d", "b", "c"]);
  assert.deepEqual(moveTo(bs, "a", 99).ids, ["b", "c", "d", "a"]);
});

test("moving: never above a book it needs, nor below one that needs it", () => {
  const bs = [bk("a", 0, 1), bk("b", 1, 1, { book: { prereqs: ["a"] } }), bk("c", 2, 1)];
  const up = moveTo(bs, "b", 0);
  assert.deepEqual([up.ids, up.blockedBy], [["a", "b", "c"], "a"]);
  const down = moveTo(bs, "a", 2);
  assert.deepEqual([down.ids, down.blockedBy], [["a", "b", "c"], "b"]);
});

test("rekey changes only what it must", () => {
  const bs = [bk("a", 0, 1), bk("b", 1, 1), bk("c", 2, 1)];
  const patches = rekey(bs, ["c", "a", "b"]);
  const after = bs.map(b => ({ ...b, ...(patches.find(p => p.id === b.id) || {}) }));
  assert.deepEqual(order(after), ["c", "a", "b"]);
  assert.ok(patches.length <= 3);
  assert.deepEqual(moves(["a", "b", "c"], ["c", "a", "b"]).map(m => m.by), [-1, -1, 2]);
});

test("suggestions: only waiting books, both in the library, no repeats, declines or loops", () => {
  const keyOf = b => "gr:" + b.id;
  const bs = [
    bk("a", 0, 10, { after: ["gr:b", "gr:zz"] }),
    bk("b", 1, 20),
    bk("c", 2, 30, { after: ["gr:a"], book: { prereqsDeclined: ["a"] } }),
    bk("d", 3, 30, { after: ["gr:e"] }),
    bk("e", 4, 30, { book: { prereqs: ["d"] } }),
    bk("f", 5, 30, { after: ["gr:g"] }),
    { ...bk("g", 6, 30), status: "read" },
  ];
  assert.deepEqual(suggestions(bs, keyOf), [{ id: "a", after: "b" }]);
});

test("bands are stretches of one list", () => {
  const bands = bandsOf({ bands: { next: 2 } });
  assert.deepEqual([0, 1, 2, 21, 22].map(i => bandAt(i, bands)), ["next", "next", "soon", "soon", "stacks"]);
});

test("forecast: a prerequisite that's set aside or deleted doesn't block for ever", () => {
  const S = { ...defaultSettings("2026-11-18T09:00:00.000Z"), concurrency: 1 };
  const bs = [bk("a", 0, 10, { book: { prereqs: ["gone"] } }), { ...bk("b", 1, 10, { book: { prereqs: ["x"] } }) }, { ...bk("x", 2, 10), status: "abandoned" }];
  const fc = forecast({ books: bs, byBook: new Map(), settings: S, now: new Date("2026-11-18T09:00:00") });
  assert.ok(fc.get("a").start != null && fc.get("b").start != null);
});
