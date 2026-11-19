import { test } from "node:test";
import assert from "node:assert/strict";
import { linksOf, linksFor, suggestedLinks, layout, KINDS } from "../app/js/links.js";

const ev = (id, from, to, kind, extra = {}) => ({ id, bookId: from, other: to, type: "link", kind, at: "2026-11-19T12:00:00Z", source: "app", ...extra });
const book = (id, extra = {}) => ({ id, status: "want", refs: { goodreadsBookId: id }, prereqs: [], ...extra });

test("links in force: both books present, a known kind, never to itself", () => {
  const events = [ev("l1", "a", "b", "answers"), ev("l2", "a", "gone", "together"), ev("l3", "a", "a", "together"), ev("l4", "b", "c", "nonsense"), { id: "p", type: "progress", bookId: "a" }];
  assert.deepEqual(linksOf(events, ["a", "b", "c"]).map(l => l.id), ["l1"]);
});

test("each book phrases a link from its own side", () => {
  const ls = linksOf([ev("l1", "fire", "malcolm", "answers"), ev("l2", "stoner", "fire", "together")], ["fire", "malcolm", "stoner"]);
  assert.deepEqual(linksFor(ls, "fire").map(x => [x.other, x.phrase]), [["malcolm", "answers"], ["stoner", "reads well with"]]);
  assert.deepEqual(linksFor(ls, "malcolm").map(x => x.phrase), ["is answered by"]);
  assert.ok(KINDS.together && !KINDS.together.directed && KINDS.answers.directed);
});

test("suggestions: your read-after orders and the AI's pairs, minus linked, ignored or missing", () => {
  const books = [
    book("a", { prereqs: ["b"] }),
    book("c", { score: { youth_after: ["d", "zz"] } }),
    book("d"), book("b"),
    book("e", { prereqs: ["d"], linksDeclined: ["d"] }),
    book("f", { prereqs: ["c"] }),
  ];
  const links = linksOf([ev("l1", "c", "f", "together")], books.map(b => b.id));
  const got = suggestedLinks(books, links, b => b.id).map(s => `${s.from}>${s.to}:${s.source}`);
  assert.deepEqual(got, ["a>b:yours", "c>d:ai"]);
});

test("map layout: inside the frame, deterministic, and linked books sit closer than unlinked ones", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "d", to: "e" }];
  const one = layout(ids, edges, { width: 600, height: 400 }), two = layout([...ids].reverse(), edges, { width: 600, height: 400 });
  for (const id of ids) {
    const p = one.get(id);
    assert.ok(p.x >= 40 && p.x <= 560 && p.y >= 40 && p.y <= 360, `${id} inside`);
    assert.ok(Math.abs(p.x - two.get(id).x) < 1e-6 && Math.abs(p.y - two.get(id).y) < 1e-6, "same map whatever the order");
  }
  const dist = (x, y) => Math.hypot(one.get(x).x - one.get(y).x, one.get(x).y - one.get(y).y);
  assert.ok(dist("a", "b") < dist("a", "f") && dist("d", "e") < dist("d", "a"), "linked books pull together");
  assert.equal(layout([], []).size, 0);
});

test("packed map: separate groups get their own frames, nothing overlaps, and the height fits", async () => {
  const { packedLayout, components } = await import("../app/js/links.js");
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const edges = [{ from: "a", to: "b" }, { from: "c", to: "d" }, { from: "e", to: "f" }, { from: "f", to: "g" }, { from: "g", to: "e" }];
  assert.deepEqual(components(ids, edges).map(g => g.length), [3, 2, 2, 1]);
  const { pos, height } = packedLayout(ids, edges, { width: 800 });
  const ps = ids.map(id => pos.get(id));
  for (const p of ps) assert.ok(p.x >= 0 && p.x <= 800 && p.y >= 0 && p.y <= height);
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) assert.ok(Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y) > 12, `${ids[i]} and ${ids[j]} apart`);
  const d = (a, b) => Math.hypot(pos.get(a).x - pos.get(b).x, pos.get(a).y - pos.get(b).y);
  assert.ok(d("a", "b") < d("a", "c"), "a pair sits together, apart from the next");
});
