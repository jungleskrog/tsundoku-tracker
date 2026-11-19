// Tsundoku Tracker domain rules. Pure functions: no storage, no DOM.
// Records follow the approved schema (architecture note §5):
//   book.synced  — written only by import/sync
//   book.mine    — written only by the user; any key present wins
//   events       — append-only history; current page and dates derive from it
import { bookId, eventId } from "./ids.js";
import { keysBetween, compareKeys } from "./keys.js";

export const SCHEMA_VERSION = 1;
export const STATUSES = ["want", "reading", "paused", "read", "abandoned"];
export const IMPORT_SHELVES = ["to-read", "currently-reading", "read"];

export function defaultSettings(now) {
  return {
    id: "settings",
    schemaVersion: SCHEMA_VERSION,
    dailyTokens: 10,
    minutesPerToken: 4,
    model: { v1: 300, v10: 75, emin: 0.75, emax: 6 },
    concurrency: "auto",
    readingDays: [1, 1, 1, 1, 1, 1, 1],
    goodreadsUserId: null,
    lastExportAt: null,
    gettingStarted: { show: true },   // new libraries only: the first-run checklist on the Desk
    updatedAt: now,
  };
}

// --- Reading a book ---------------------------------------------------------

const pick = (mine, synced, key) => (mine && key in mine ? mine[key] : synced ? synced[key] ?? null : null);

/** The values the app shows: your override, else synced, else empty. */
export function effective(book) {
  const m = book.mine || {}, s = book.synced || {};
  // An edition you chose from Goodreads (mine.grEdition) stands between your own corrections and the synced facts.
  const ge = m.grEdition && !m.grEdition.coverOnly ? m.grEdition : null;
  return {
    title: pick(m, s, "title") || "Untitled",
    author: pick(m, s, "author") || "",
    pages: "pages" in m ? m.pages : (ge && ge.pages) || s.pages || null,
    year: pick(m, s, "year"),
    edition: ("edition" in m ? m.edition : null) ?? (ge && ge.binding) ?? s.binding ?? null,
    publisher: (ge && ge.publisher) || s.publisher || null,
    coverUrl: m.coverUrl || (m.grEdition && m.grEdition.coverUrl) || s.coverUrl || null,
    // "" in mine.annotation means deliberately blank; absent means use the synced quote
    annotation: "annotation" in m ? m.annotation : s.quote ?? "",
    annotationIsMine: "annotation" in m,
    pagesEstimated: !("pages" in m) && !(ge && ge.pages) && !s.pages,
  };
}

export const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Map bookId -> events (sorted oldest first). */
export function eventsByBook(events) {
  const map = new Map();
  for (const e of events) {
    if (!e.bookId) continue;
    if (!map.has(e.bookId)) map.set(e.bookId, []);
    map.get(e.bookId).push(e);
  }
  for (const list of map.values()) list.sort(byTime);
  return map;
}

export function currentPage(bookEvents = []) {
  let page = 0;
  for (const e of bookEvents) if (e.type === "progress") page = e.page;
  return page;
}

/** Dates derived from history: first start, last finish, added. */
export function bookDates(bookEvents = []) {
  let added = null, started = null, finished = null;
  for (const e of bookEvents) {
    if (e.type !== "status") continue;
    if (e.from == null && !added) added = e.at;
    if (e.to === "reading" && !started) started = e.at;
    if (e.to === "read") finished = e.at;
    if (e.from === "read" && e.to !== "read") finished = null; // re-opened
  }
  return { added, started, finished };
}

// --- Dates ------------------------------------------------------------------

/** "2026-11-18" or "2026-11" -> ISO instant at local noon (date-only facts). */
export function dateToAt(d) {
  if (!d) return null;
  const [y, m = "01", day = "01"] = d.split("-");
  return new Date(+y, +m - 1, +day, 12, 0, 0).toISOString();
}

export function localDayKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// --- Actions (return new events + a patch for the book) ---------------------

function statusEvent(book, to, at, extra = {}) {
  return { id: eventId(), bookId: book.id, at, type: "status", from: book.status ?? null, to, source: "app", ...extra };
}

/** Set the current page. Starting a not-yet-started book is implied. */
export function logPage(book, bookEvents, page, now) {
  const { pages } = effective(book);
  const cur = currentPage(bookEvents);
  const next = Math.max(0, Math.min(Math.round(page), pages || Infinity));
  if (next === cur) return null;
  const progress = { id: eventId(), bookId: book.id, at: now, type: "progress", page: next, prevPage: cur, source: "app" };
  const events = [progress];
  let patch = null;
  if (book.status === "want" || book.status === "paused") {
    events.push(statusEvent(book, "reading", now, { with: progress.id }));
    patch = { status: "reading" };
  }
  return { events, patch };
}

export const logPages = (book, bookEvents, delta, now) => logPage(book, bookEvents, currentPage(bookEvents) + delta, now);

/** Undo the most recent progress entry made in the app (and any status change made with it). */
export function undoLast(book, bookEvents) {
  const last = [...bookEvents].reverse().find(e => e.type === "progress" && e.source === "app");
  if (!last) return null;
  const linked = bookEvents.filter(e => e.with === last.id);
  const remove = [last.id, ...linked.map(e => e.id)];
  const revert = linked.find(e => e.type === "status");
  return { remove, patch: revert ? { status: revert.from } : null, event: last };
}

/** Change status (start, pause, finish, abandon, back to the list). */
export function changeStatus(book, bookEvents, to, now) {
  if (!STATUSES.includes(to)) throw new Error(`unknown status ${to}`);
  if (book.status === to) return null;
  const events = [statusEvent(book, to, now)];
  const { pages } = effective(book);
  if (to === "read" && pages && currentPage(bookEvents) < pages) {
    events.unshift({ id: eventId(), bookId: book.id, at: now, type: "progress", page: pages, prevPage: currentPage(bookEvents), source: "app" });
  }
  return { events, patch: { status: to } };
}

// --- Creating books -----------------------------------------------------------

export function newBook({ synced = null, mine = {}, refs = {}, status = "want", queueKey = null, now }) {
  return { id: bookId(), refs, status, queueKey, sharePin: null, prereqs: [], synced, mine, flags: {}, createdAt: now, updatedAt: now };
}

export function manualBook({ title, author, pages, year }, queueKey, now) {
  const mine = {};
  if (title) mine.title = title.trim();
  if (author) mine.author = author.trim();
  if (pages) mine.pages = +pages;
  if (year) mine.year = +year;
  const book = newBook({ mine, queueKey, now });
  const events = [{ id: eventId(), bookId: book.id, at: now, type: "status", from: null, to: "want", source: "app" }];
  return { book, events };
}

const SHELF_STATUS = { "to-read": "want", "currently-reading": "reading", read: "read" };

function syncedFrom(inc, source, now) {
  const { goodreadsBookId, ...facts } = inc;
  return { ...facts, source, syncedAt: now };
}

function bookFromIncoming(inc, queueKey, source, now) {
  const status = SHELF_STATUS[inc.shelf];
  const book = newBook({
    synced: syncedFrom(inc, source, now),
    refs: { goodreadsBookId: inc.goodreadsBookId, goodreadsWorkId: inc.workId || null, isbn13: inc.isbn13 || null },
    status, queueKey, now,
  });
  const ev = (at, extra) => ({ id: eventId(), bookId: book.id, at, source, approx: true, ...extra });
  const added = dateToAt(inc.dateAdded) || now;
  const events = [ev(added, { type: "status", from: null, to: "want" })];
  if (status === "reading" || inc.dateStarted) {
    events.push(ev(dateToAt(inc.dateStarted) || added, { type: "status", from: "want", to: "reading" }));
  }
  if (status === "read") {
    const at = dateToAt(inc.dateRead) || added;
    const from = events.at(-1).to;
    if (inc.pages) events.push(ev(at, { type: "progress", page: inc.pages, prevPage: 0 }));
    events.push(ev(at, { type: "status", from, to: "read" }));
  }
  return { book, events };
}

// --- Matching and import planning ---------------------------------------------

export function normTitle(s) {
  return (s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .split(/[:;]/)[0]
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/^\s*(the|a|an)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normAuthor(s) {
  const words = (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").trim().split(/\s+/);
  return words.at(-1) || "";
}

const SAME_FACTS = (a, b) => {
  const strip = o => { const { syncedAt, ...rest } = o || {}; return JSON.stringify(Object.entries(rest).sort()); };
  return strip(a) === strip(b);
};

/**
 * Plan an import of incoming Goodreads facts against the library.
 * Never overwrites `mine`, never deletes. Returns what would change.
 */
export function planImport(books, incoming, { now, source = "goodreads-csv", shelves = IMPORT_SHELVES, hasHistory = null } = {}) {
  const plan = { creates: [], updates: [], asks: [], gone: [], back: [], adopt: [], relinks: [], merges: [], skipped: {}, unchanged: 0 };
  const byGr = new Map(books.filter(b => b.refs?.goodreadsBookId).map(b => [b.refs.goodreadsBookId, b]));
  for (const b of books) { const id = b.mine?.grEdition?.id; if (id && !byGr.has(id)) byGr.set(id, b); } // the edition you chose, once Goodreads has it
  const incomingIds = new Set(incoming.filter(i => shelves.includes(i.shelf)).map(i => i.goodreadsBookId));
  const relinked = new Set();
  /** The book's old Goodreads edition has left the shelves: an incoming lookalike is the same book in another edition. */
  const relink = (book, inc, sameWork) => {
    if (!book || relinked.has(book.id) || !book.refs?.goodreadsBookId || incomingIds.has(book.refs.goodreadsBookId)) return false;
    relinked.add(book.id);
    const synced = { ...syncedFrom(inc, source, now) };
    const refs = { ...book.refs, goodreadsBookId: inc.goodreadsBookId, goodreadsWorkId: inc.workId || (sameWork ? book.refs.goodreadsWorkId : null) || null, isbn13: inc.isbn13 || null };
    plan.updates.push({ id: book.id, synced, refs, relink: { from: book.refs.goodreadsBookId, to: inc.goodreadsBookId, sameWork, oldPages: book.synced?.pages || null, newPages: inc.pages || null, oldTitle: effective(book).title, newTitle: inc.title } });
    plan.relinks.push(book.id);
    return true;
  };
  const byLoose = (inc) => {
    // "Don Quixote, Part One" for "Don Quixote": same author, one title begins the other, same shelf as before
    const t = normTitle(inc.title).replace(/ /g, ""), a = normAuthor(inc.author);
    return books.find(b => {
      if (!b.refs?.goodreadsBookId || incomingIds.has(b.refs.goodreadsBookId) || b.synced?.shelf !== inc.shelf) return false;
      const e = effective(b), u = normTitle(e.title).replace(/ /g, "");
      return normAuthor(e.author) === a && u.length >= 4 && t.length >= 4 && (t.startsWith(u) || u.startsWith(t));
    }) || null;
  };
  const byIsbn = new Map(books.filter(b => b.refs?.isbn13).map(b => [b.refs.isbn13, b]));
  const byWork = new Map(books.filter(b => b.refs?.goodreadsWorkId).map(b => [b.refs.goodreadsWorkId, b]));
  const fuzzyKey = b => { const e = effective(b); return `${normTitle(e.title)}|${normAuthor(e.author)}`; };
  const byFuzzy = new Map(books.map(b => [fuzzyKey(b), b]));
  const seen = new Set();
  const wanted = [];

  for (const inc of incoming) {
    if (!shelves.includes(inc.shelf)) { plan.skipped[inc.shelf] = (plan.skipped[inc.shelf] || 0) + 1; continue; }
    if (seen.has(inc.goodreadsBookId)) continue;
    seen.add(inc.goodreadsBookId);

    const existing = byGr.get(inc.goodreadsBookId) || (inc.isbn13 && byIsbn.get(inc.isbn13));
    if (existing) {
      relinked.add(existing.id); // found on the shelves (perhaps under the edition you chose): not gone
      const synced = { ...existing.synced, ...syncedFrom(inc, source, now) };
      const refs = { ...existing.refs, goodreadsBookId: inc.goodreadsBookId, goodreadsWorkId: inc.workId || existing.refs.goodreadsWorkId || null, isbn13: inc.isbn13 || existing.refs.isbn13 || null };
      if (SAME_FACTS(existing.synced, synced) && JSON.stringify(refs) === JSON.stringify(existing.refs)) plan.unchanged++;
      else plan.updates.push({ id: existing.id, synced, refs });
      if (existing.flags?.goneFromGoodreads) plan.back.push(existing.id);
      const move = shelfMove(existing, inc);
      if (move) plan.adopt.push(move);
      continue;
    }
    const sameWork = inc.workId && byWork.get(inc.workId);
    if (sameWork) { if (!relink(sameWork, inc, true)) plan.asks.push({ kind: "edition", incoming: inc, matchId: sameWork.id }); continue; }
    const fuzzy = byFuzzy.get(`${normTitle(inc.title)}|${normAuthor(inc.author)}`);
    if (fuzzy) { if (!relink(fuzzy, inc, false)) plan.asks.push({ kind: "same-book", incoming: inc, matchId: fuzzy.id }); continue; }
    if (relink(byLoose(inc), inc, false)) continue;
    wanted.push(inc);
  }

  // New books: want-list in Goodreads order (shelf position, then date added), after the existing queue.
  const lastKey = books.map(b => b.queueKey).filter(Boolean).sort(compareKeys).at(-1) || null;
  const order = (a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || (a.dateAdded || "").localeCompare(b.dateAdded || "");
  const queued = wanted.filter(i => i.shelf !== "read").sort(order);
  const keys = keysBetween(lastKey, null, queued.length);
  // Joining a list that already exists: each new waiting book takes its place by reading-youth once it has a figure.
  const placeLater = books.some(b => b.status === "want");
  queued.forEach((inc, i) => {
    const c = bookFromIncoming(inc, keys[i], source, now);
    if (placeLater && c.book.status === "want") c.book.flags.placeByYouth = true;
    plan.creates.push(c);
  });
  wanted.filter(i => i.shelf === "read").forEach(inc => plan.creates.push(bookFromIncoming(inc, null, source, now)));

  // Repair: a book added from Goodreads with no history of its own that is really a new edition of a book
  // you already had (its old edition gone from the shelves) is merged into that book, which keeps its history.
  if (hasHistory) {
    const lookalike = (x, y) => {
      if (x.refs?.goodreadsWorkId && x.refs.goodreadsWorkId === y.refs?.goodreadsWorkId) return true;
      const ex = effective(x), ey = effective(y);
      if (normAuthor(ex.author) !== normAuthor(ey.author)) return false;
      const a = normTitle(ex.title).replace(/ /g, ""), b = normTitle(ey.title).replace(/ /g, "");
      return a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
    };
    for (const x of books) {
      if (!x.refs?.goodreadsBookId || !incomingIds.has(x.refs.goodreadsBookId) || hasHistory(x.id)) continue;
      const y = books.find(o => o.id !== x.id && o.refs?.goodreadsBookId && !incomingIds.has(o.refs.goodreadsBookId) && !relinked.has(o.id) && (hasHistory(o.id) || (o.createdAt || "") < (x.createdAt || "")) && lookalike(x, o));
      if (!y) continue;
      const upd = plan.updates.find(u => u.id === x.id);
      const synced = upd ? upd.synced : x.synced, refs = upd ? upd.refs : x.refs;
      plan.updates = plan.updates.filter(u => u.id !== x.id);
      plan.adopt = plan.adopt.filter(m => m.id !== x.id);
      const sameWork = !!(refs.goodreadsWorkId && refs.goodreadsWorkId === y.refs.goodreadsWorkId);
      plan.updates.push({ id: y.id, synced, refs, relink: { from: y.refs.goodreadsBookId, to: refs.goodreadsBookId, sameWork, oldPages: y.synced?.pages || null, newPages: synced?.pages || null, oldTitle: effective(y).title, newTitle: synced?.title || effective(x).title } });
      plan.merges.push({ keep: y.id, drop: x.id });
      relinked.add(y.id);
      if (y.flags?.goneFromGoodreads) plan.back.push(y.id);
    }
  }

  // Books that came from Goodreads but are no longer on an imported shelf: flag, never delete.
  for (const b of books) {
    const id = b.refs?.goodreadsBookId;
    if (!id || seen.has(id) || relinked.has(b.id)) continue;
    if (!b.flags?.goneFromGoodreads && (b.status === "want" || b.status === "reading")) plan.gone.push(b.id);
    // A finished or set-aside book taken off its shelf there: note that it's on none of the three now.
    else if (b.status !== "want" && b.status !== "reading" && b.synced?.shelf && shelves.includes(b.synced.shelf)) {
      plan.updates.push({ id: b.id, synced: { ...b.synced, shelf: null, syncedAt: now }, refs: b.refs });
    }
  }
  return plan;
}

/**
 * A book moved shelf on Goodreads. The app follows when its own status still matches
 * the old shelf (nothing changed here since), or when Goodreads says it's been read.
 * Otherwise the app's status stands, and it shows under "For Goodreads" instead.
 */
function shelfMove(book, inc) {
  const from = book.synced?.shelf, to = SHELF_STATUS[inc.shelf];
  if (!from || from === inc.shelf || !to || book.status === to) return null;
  const unchangedHere = book.status === SHELF_STATUS[from];
  const finishedThere = to === "read" && ["want", "reading", "paused"].includes(book.status);
  if (!unchangedHere && !finishedThere) return null;
  const date = to === "read" ? inc.dateRead : to === "reading" ? inc.dateStarted : null;
  return { id: book.id, to, at: dateToAt(date), shelf: inc.shelf };
}

/** Resolve an ask: "link" makes the incoming facts update the matched book; "add" creates a new book. */
export function resolveAsk(ask, choice, books, { now, source = "goodreads-csv" }) {
  if (choice === "link") {
    const b = books.find(x => x.id === ask.matchId);
    return { updates: [{ id: b.id, synced: { ...b.synced, ...syncedFrom(ask.incoming, source, now) },
      refs: { ...b.refs, goodreadsBookId: ask.incoming.goodreadsBookId, isbn13: ask.incoming.isbn13 || b.refs.isbn13 || null } }], creates: [] };
  }
  if (choice === "add") {
    const lastKey = books.map(x => x.queueKey).filter(Boolean).sort(compareKeys).at(-1) || null;
    const key = ask.incoming.shelf === "read" ? null : keysBetween(lastKey, null, 1)[0];
    return { updates: [], creates: [bookFromIncoming(ask.incoming, key, source, now)] };
  }
  return { updates: [], creates: [] };
}

// --- Archives (export, import, merge) ------------------------------------------

export function makeArchive({ books, events, tombstones, settings }, now) {
  return { format: "antilibrary-archive", schemaVersion: SCHEMA_VERSION, exportedAt: now, books, events, tombstones, settings };
}

export function validateArchive(a) {
  if (!a || a.format !== "antilibrary-archive") return "This isn't a Tsundoku Tracker backup file.";
  if (typeof a.schemaVersion !== "number") return "The backup has no version number.";
  if (a.schemaVersion > SCHEMA_VERSION) return "This backup was made by a newer version of Tsundoku Tracker. Update the app first.";
  for (const k of ["books", "events"]) if (!Array.isArray(a[k])) return `The backup is missing its ${k}.`;
  return null;
}

/** Union of two archives: newer book records win, events and deletions are unioned. */
export function mergeArchives(local, remote) {
  const tomb = new Map([...(local.tombstones || []), ...(remote.tombstones || [])].map(t => [t.id, t]));
  const books = new Map(local.books.map(b => [b.id, b]));
  let booksAdded = 0, booksUpdated = 0, eventsAdded = 0;
  for (const b of remote.books) {
    if (tomb.has(b.id)) continue;
    const mine = books.get(b.id);
    if (!mine) { books.set(b.id, b); booksAdded++; }
    else if ((b.updatedAt || "") > (mine.updatedAt || "")) { books.set(b.id, b); booksUpdated++; }
  }
  for (const id of tomb.keys()) books.delete(id);
  const events = new Map(local.events.map(e => [e.id, e]));
  for (const e of remote.events) if (!events.has(e.id)) { events.set(e.id, e); eventsAdded++; }
  for (const id of tomb.keys()) events.delete(id);
  for (const [id, e] of events) if (e.bookId && !books.has(e.bookId)) events.delete(id);
  const settings = (remote.settings?.updatedAt || "") > (local.settings?.updatedAt || "") ? remote.settings : local.settings;
  return {
    books: [...books.values()], events: [...events.values()].sort(byTime), tombstones: [...tomb.values()], settings,
    stats: { booksAdded, booksUpdated, eventsAdded },
  };
}

/** Queue order for want-list books. */
export const byQueue = (a, b) => compareKeys(a.queueKey || "~", b.queueKey || "~");
