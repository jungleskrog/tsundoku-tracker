// Connections (1.6): how your books relate, only as you say. Each link is an event
//   { type: "link", bookId, other, kind, note, source: "app" }
// so it syncs, merges and undoes like everything else (removing one tombstones the event).
// Suggestions come from what's already there — your read-after orders, and the
// reading-youth pass's read-after pairs — shown faintly until you accept one.
// Pure functions: no storage, no DOM.

/** Kinds of link. Directed ones read "this book <out> that one" / "that one <in> this". */
export const KINDS = {
  answers: { out: "answers", in: "is answered by", directed: true, label: "answers" },
  builds: { out: "builds on", in: "is built on by", directed: true, label: "builds on" },
  influenced: { out: "was influenced by", in: "influenced", directed: true, label: "influenced by" },
  movement: { out: "is of a movement with", in: "is of a movement with", directed: false, label: "same movement" },
  together: { out: "reads well with", in: "reads well with", directed: false, label: "read together" },
  contrasts: { out: "contrasts with", in: "contrasts with", directed: false, label: "contrasts with" },
};
export const KIND_ORDER = ["answers", "builds", "influenced", "movement", "together", "contrasts"];

/** The links in force: link events whose two books are both still in the library. */
export function linksOf(events, bookIds) {
  const have = bookIds instanceof Set ? bookIds : new Set(bookIds);
  return events.filter(e => e.type === "link" && KINDS[e.kind] && have.has(e.bookId) && have.has(e.other) && e.bookId !== e.other)
    .map(e => ({ id: e.id, from: e.bookId, to: e.other, kind: e.kind, note: e.note || "", at: e.at }));
}

/** One book's links, each phrased from its side: { link, other, phrase }. */
export function linksFor(links, id) {
  const out = [];
  for (const l of links) {
    if (l.from === id) out.push({ link: l, other: l.to, phrase: KINDS[l.kind].out });
    else if (l.to === id) out.push({ link: l, other: l.from, phrase: KINDS[l.kind].in });
  }
  return out;
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Suggested links, from read-after orders you set (source "yours") and the AI's
 * reading-youth read-after pairs (source "ai"), minus any pair already linked or ignored.
 * Each is "from builds on to". keyOf maps a book to the helper's catalogue key.
 */
export function suggestedLinks(books, links, keyOf) {
  const byKey = new Map(books.map(b => [keyOf(b), b]));
  const have = new Set(books.map(b => b.id));
  const linked = new Set(links.map(l => pairKey(l.from, l.to)));
  const seen = new Set(), out = [];
  const add = (from, to, source) => {
    const k = pairKey(from, to);
    if (from === to || !have.has(to) || linked.has(k) || seen.has(k)) return;
    const a = books.find(b => b.id === from), b = books.find(x => x.id === to);
    if ((a.linksDeclined || []).includes(to) || (b.linksDeclined || []).includes(from)) return;
    seen.add(k); out.push({ from, to, kind: "builds", source });
  };
  for (const b of books) for (const p of b.prereqs || []) add(b.id, p, "yours");
  for (const b of books) for (const k of b.score?.youth_after || []) { const a = byKey.get(k); if (a) add(b.id, a.id, "ai"); }
  return out;
}

/**
 * A force-directed layout (Fruchterman–Reingold), deterministic: the same books and
 * links always give the same map. Linked books pull together, all books push apart,
 * and everything stays inside the frame. Returns Map id -> { x, y }.
 */
export function layout(ids, edges, { width = 800, height = 560, iterations = 300, pad = 40 } = {}) {
  const n = ids.length, pos = new Map();
  if (!n) return pos;
  // start on a circle, ordered by a stable hash so the result doesn't depend on input order
  const h = s => [...s].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381);
  const order = [...ids].sort((a, b) => h(a) - h(b));
  const cx = width / 2, cy = height / 2, R = Math.min(width, height) / 2 - pad;
  order.forEach((id, i) => { const t = (2 * Math.PI * i) / n; pos.set(id, { x: cx + R * Math.cos(t), y: cy + R * Math.sin(t) }); });
  if (n === 1) { pos.set(ids[0], { x: cx, y: cy }); return pos; }
  const area = (width - 2 * pad) * (height - 2 * pad), k = Math.sqrt(area / n);
  const E = edges.filter(e => pos.has(e.from) && pos.has(e.to));
  let temp = width / 8;
  for (let it = 0; it < iterations; it++) {
    const disp = new Map(ids.map(id => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = pos.get(order[i]), b = pos.get(order[j]);
      let dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 0.01;
      const f = (k * k) / d;
      dx = (dx / d) * f; dy = (dy / d) * f;
      disp.get(order[i]).x += dx; disp.get(order[i]).y += dy;
      disp.get(order[j]).x -= dx; disp.get(order[j]).y -= dy;
    }
    for (const e of E) {
      const a = pos.get(e.from), b = pos.get(e.to);
      let dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 0.01;
      const f = ((d * d) / k) * (e.weight ?? 1);
      dx = (dx / d) * f; dy = (dy / d) * f;
      disp.get(e.from).x -= dx; disp.get(e.from).y -= dy;
      disp.get(e.to).x += dx; disp.get(e.to).y += dy;
    }
    for (const id of ids) {
      const p = pos.get(id), d = disp.get(id), len = Math.hypot(d.x, d.y) || 1;
      // a gentle pull to the centre keeps separate clusters on the page
      p.x += (d.x / len) * Math.min(len, temp) + (cx - p.x) * 0.01;
      p.y += (d.y / len) * Math.min(len, temp) + (cy - p.y) * 0.01;
      p.x = Math.min(width - pad, Math.max(pad, p.x));
      p.y = Math.min(height - pad, Math.max(pad, p.y));
    }
    temp = Math.max(1, temp * 0.985);
  }
  return pos;
}

/** Groups of books joined by links (each group's ids, largest first). */
export function components(ids, edges) {
  const adj = new Map(ids.map(id => [id, []]));
  for (const e of edges) if (adj.has(e.from) && adj.has(e.to)) { adj.get(e.from).push(e.to); adj.get(e.to).push(e.from); }
  const seen = new Set(), out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const group = [], stack = [id];
    seen.add(id);
    while (stack.length) { const x = stack.pop(); group.push(x); for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); stack.push(y); } }
    out.push(group.sort());
  }
  return out.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
}

/**
 * The whole map: each group laid out in its own small frame, frames packed in rows
 * across the width (largest first), so separate pairs and clusters each read clearly.
 * Returns { pos: Map id -> {x, y}, height }.
 */
export function packedLayout(ids, edges, { width = 800, gap = 16, labelRoom = 130 } = {}) {
  const pos = new Map();
  let x = 0, y = 0, rowH = 0;
  for (const group of components(ids, edges)) {
    const n = group.length;
    const w = Math.min(width, Math.round(labelRoom + 50 + Math.sqrt(n - 1) * 125));
    const h = Math.round(n <= 2 ? 64 : 70 + Math.sqrt(n) * 70);
    if (x > 0 && x + w > width) { x = 0; y += rowH + gap; rowH = 0; }
    const inner = n === 1 ? new Map([[group[0], { x: 30, y: h / 2 }]])
      : n === 2 ? new Map([[group[0], { x: 30, y: 18 }], [group[1], { x: 30, y: h - 18 }]])
      : layout(group, edges.filter(e => group.includes(e.from) && group.includes(e.to)), { width: w - labelRoom * 0.6, height: h, pad: 22, iterations: 250 });
    for (const [id, p] of inner) pos.set(id, { x: x + p.x, y: y + p.y });
    x += w + gap; rowH = Math.max(rowH, h);
  }
  return { pos, height: y + rowH };
}
