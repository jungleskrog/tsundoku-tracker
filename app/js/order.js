// Ordering the waiting list (Stage 5). Pure functions: no storage, no DOM.
//   queueKey  — the book's place in the one waiting list (fractional keys)
//   prereqs   — ids of books it must come after ("read after")
//   bands     — Next / Soon / The stacks are stretches of that one list
//   youth     — when in a reading life a book is good to read: yours, else the AI's
import { keyBetween, keysBetween, compareKeys } from "./keys.js";

export const DEFAULT_BANDS = { next: 5, soon: 20 };
export const STAGES = ["", "opening out", "finding your feet", "taking on weight", "deepening", "the long view"];

export const bandsOf = settings => ({ ...DEFAULT_BANDS, ...(settings?.bands || {}) });
export function bandAt(i, bands) {
  return i < bands.next ? "next" : i < bands.next + bands.soon ? "soon" : "stacks";
}

/** The youth figure the app uses: yours, else the AI's, else none. */
export function youthOf(book) {
  if (book.mine && book.mine.youth != null) return { youth: book.mine.youth, source: "yours", anyTime: false };
  const s = book.score;
  if (s && s.youth != null) return { youth: s.youth, source: "ai", anyTime: !!s.youth_any_time, stage: s.youth_stage || null, note: s.youth_reason || "" };
  return { youth: null, source: null, anyTime: false };
}
export const stageOfYouth = y => (y == null ? null : Math.min(5, 1 + Math.floor(y / 20)));

// --- Prerequisites ----------------------------------------------------------------

export const prereqMap = books => new Map(books.map(b => [b.id, (b.prereqs || []).filter(Boolean)]));

/** Does `a` have to come after `b`, directly or through others? */
export function needs(map, a, b, seen = new Set()) {
  for (const x of map.get(a) || []) {
    if (x === b) return true;
    if (!seen.has(x)) { seen.add(x); if (needs(map, x, b, seen)) return true; }
  }
  return false;
}

/** Would "a reads after b" make a loop? */
export const wouldLoop = (map, a, b) => a === b || needs(map, b, a);

/**
 * Keep the given order, but a book waits until the books it needs have come:
 * it drops to just after the last of them (the needed book is never pulled up).
 */
export function respectPrereqs(ids, map) {
  const inList = new Set(ids), out = [], done = new Set();
  let pending = [];
  const ready = id => (map.get(id) || []).every(p => !inList.has(p) || done.has(p));
  const emit = id => {
    out.push(id); done.add(id);
    let freed;
    do {
      freed = pending.filter(ready);
      pending = pending.filter(x => !freed.includes(x));
      for (const f of freed) { out.push(f); done.add(f); }
    } while (freed.length);
  };
  for (const id of ids) ready(id) ? emit(id) : pending.push(id);
  return [...out, ...pending]; // anything left is in a loop: keep its order
}

// --- The youth order --------------------------------------------------------------------

/**
 * Waiting books in reading-youth order: by youth, ties keep the current order,
 * "any time" books spread evenly through the list as interludes, books without a
 * youth figure keep their places at the end, and prerequisites always come first.
 */
export function youthOrder(books) {
  const current = books.slice().sort(byKey);
  const rank = new Map(current.map((b, i) => [b.id, i]));
  const placed = [], anyTime = [], none = [];
  for (const b of current) {
    const y = youthOf(b);
    if (y.youth == null) none.push(b);
    else if (y.anyTime) anyTime.push(b);
    else placed.push([b, y.youth]);
  }
  placed.sort((a, b) => a[1] - b[1] || rank.get(a[0].id) - rank.get(b[0].id));
  const ids = placed.map(([b]) => b.id);
  // interludes: the k-th any-time book goes (k+1)/(n+1) of the way through
  anyTime.forEach((b, k) => ids.splice(Math.round(((k + 1) / (anyTime.length + 1)) * ids.length) + k, 0, b.id));
  return respectPrereqs([...ids, ...none.map(b => b.id)], prereqMap(books));
}

const byKey = (a, b) => compareKeys(a.queueKey || "~", b.queueKey || "~") || (a.id < b.id ? -1 : 1);

/** Fresh keys for a whole new order; returns only the books whose key changes. */
export function rekey(books, ids) {
  const byId = new Map(books.map(b => [b.id, b]));
  const keys = keysBetween(null, null, ids.length);
  return ids.map((id, i) => [byId.get(id), keys[i]]).filter(([b, k]) => b.queueKey !== k).map(([b, queueKey]) => ({ id: b.id, queueKey }));
}

/** How far each book would move between two orders (positive = earlier). */
export function moves(fromIds, toIds) {
  const to = new Map(toIds.map((id, i) => [id, i]));
  return fromIds.map((id, i) => ({ id, from: i, to: to.get(id), by: i - to.get(id) }));
}

/**
 * Where one book belongs by reading-youth in the current order (index counted with
 * the book removed): the place that leaves the fewest books out of youth order
 * around it, never past the last book with a youth figure. Null if it has none.
 * In a list already in youth order this is simply among its neighbours in age.
 */
export function youthSlot(books, id) {
  const me = books.find(b => b.id === id);
  const yo = me && youthOf(me);
  if (!yo || yo.youth == null || yo.anyTime) return null;
  const y = yo.youth;
  const rest = books.slice().sort(byKey).filter(b => b.id !== id);
  const ys = rest.map(b => { const o = youthOf(b); return o.youth == null || o.anyTime ? null : o.youth; });
  const last = ys.reduce((m, v, k) => (v == null ? m : k), -1);
  let cost = ys.filter(v => v != null && v < y).length; // slot 0: every younger book is after it
  let best = 0, bestCost = cost;
  for (let k = 1; k <= last + 1; k++) {
    const v = ys[k - 1];
    if (v != null) cost += v > y ? 1 : v < y ? -1 : 0;
    if (cost <= bestCost) { best = k; bestCost = cost; }
  }
  return best;
}

// --- Moving one book ----------------------------------------------------------------------

/**
 * Move one book to `index` in the waiting list (index counted as if the book were
 * already removed). It never goes above a book it needs or below a book that needs
 * it: then it stops just short, and `blockedBy` says which book stopped it.
 * Returns the new order, the one key that changes, and the blocker if any.
 */
export function moveTo(books, id, index) {
  const sorted = books.slice().sort(byKey);
  const rest = sorted.filter(b => b.id !== id);
  const map = prereqMap(books);
  let lo = 0, hi = rest.length;
  rest.forEach((b, k) => { if (needs(map, id, b.id)) lo = Math.max(lo, k + 1); if (needs(map, b.id, id)) hi = Math.min(hi, k); });
  const want = Math.max(0, Math.min(rest.length, index));
  const at = Math.max(lo, Math.min(hi, want));
  let blockedBy = null;
  if (at > want) blockedBy = rest.slice(0, at).reverse().find(b => needs(map, id, b.id))?.id || null;
  if (at < want) blockedBy = rest.slice(at).find(b => needs(map, b.id, id))?.id || null;
  const queueKey = keyBetween(rest[at - 1]?.queueKey || null, rest[at]?.queueKey || null);
  const ids = rest.map(b => b.id);
  ids.splice(at, 0, id);
  return { ids, queueKey, at, blockedBy };
}

// --- Suggested prerequisites (from the AI's "read after") ------------------------------------

/**
 * Pairs the AI suggests ("read B after A") where both books are in the library,
 * B is still waiting and A isn't already read, the pair isn't already set or declined, and it
 * wouldn't make a loop. keyOf maps a book to the helper's catalogue key.
 */
export function suggestions(books, keyOf) {
  const byKeyMap = new Map(books.map(b => [keyOf(b), b]));
  const map = prereqMap(books);
  const out = [];
  for (const b of books) {
    if (b.status !== "want") continue;
    for (const k of b.score?.youth_after || []) {
      const a = byKeyMap.get(k);
      if (!a || a.id === b.id || a.status === "abandoned" || a.status === "read") continue;
      if ((b.prereqs || []).includes(a.id) || (b.prereqsDeclined || []).includes(a.id)) continue;
      if (wouldLoop(map, b.id, a.id)) continue;
      out.push({ id: b.id, after: a.id });
    }
  }
  return out;
}
