// Antilibrary — application shell, state and views.
import * as store from "./store.js";
import * as backup from "./backup.js";
import {
  SCHEMA_VERSION, defaultSettings, effective, eventsByBook, currentPage, bookDates, localDayKey,
  logPage, logPages, undoLast, changeStatus, manualBook, planImport, resolveAsk, makeArchive,
  validateArchive, mergeArchives, byQueue, byTime,
} from "./domain.js";
import { migrate } from "./migrations.js";
import * as M from "./model.js";
import * as H from "./helper.js";
import { csvObjects, goodreadsRows, isGoodreadsExport } from "./csv.js";
import { keysBetween, compareKeys } from "./keys.js";
import * as O from "./order.js";
import { html, raw, esc, longDate, shortDate, relativeDay, plural } from "./format.js";

const S = {
  books: new Map(), events: [], tombstones: [], settings: null, byBook: new Map(),
  auto: { handle: null, state: null, lastWrite: null }, notice: null, plan: null, planSource: null,
  pendingArchive: null, confirm: null, query: "", ready: false, error: null,
  helper: { connected: false, status: null, estimate: null, asks: [] },
  menu: null, listNote: null, undoOrder: null, focusRow: null,
};

const now = () => new Date().toISOString();
const books = () => [...S.books.values()];
const evs = id => S.byBook.get(id) || [];
const archive = () => makeArchive({ books: books(), events: S.events, tombstones: S.tombstones, settings: S.settings }, now());

function reindex() { S.byBook = eventsByBook(S.events); S.version = (S.version || 0) + 1; }

/** Everything the model derives, recomputed once per change (and once a day). */
let derivedCache = null;
function derived() {
  const day = localDayKey(now());
  if (derivedCache && derivedCache.version === S.version && derivedCache.day === day) return derivedCache;
  const t = new Date();
  const p = M.params(S.settings);
  const all = books();
  const earned = M.earnings(all, S.byBook, p);
  const firstUse = M.firstUseOf(S.events);
  const led = M.ledger({ earned, events: S.events, settings: S.settings, now: t, firstUse });
  const earnedTodayBy = new Map();
  for (const e of earned) if (e.day === day) earnedTodayBy.set(e.bookId, (earnedTodayBy.get(e.bookId) || 0) + e.tokens);
  const fc = M.forecast({ books: all, byBook: S.byBook, settings: S.settings, now: t, earnedToday: led ? led.todayTokens : 0, earnedTodayBy, earned, firstUse });
  const spread = M.paceSpread(earned, t, firstUse);
  const band = M.readingBand(earned, t);
  const todayPagesBy = new Map();
  for (const e of earned) if (e.day === day) todayPagesBy.set(e.bookId, (todayPagesBy.get(e.bookId) || 0) + e.pages);
  derivedCache = { version: S.version, day, p, earned, firstUse, ledger: led, fc, spread, band, todayPagesBy };
  return derivedCache;
}

/** "At your current pace…" words for a book, or null. */
function finishWords(id) {
  const d = derived(), f = d.fc.get(id);
  if (!f) return null;
  if (f.unknown) return { phrase: "Add a page count to see when it finishes.", short: "pages unknown", plain: true };
  if (f.beyond) return { phrase: "beyond twenty years at this pace", short: "beyond 2046" };
  if (f.finish == null) return null;
  return M.when(Math.max(0.01, f.finish), d.spread, new Date(), d.band);
}
function startWords(id) {
  const d = derived(), f = d.fc.get(id);
  if (!f || f.start == null || f.beyond) return null;
  if (f.start === 0) return { phrase: "today", short: "today" };
  return M.when(f.start + 0.5, d.spread, new Date(), null);
}
const pagesFromTokens = (id, tokens) => { const f = derived().fc.get(id); return f && f.tpp ? tokens / f.tpp : 0; };

function load({ books: bs, events, tombstones, settings }) {
  S.books = new Map(bs.map(b => [b.id, b]));
  S.events = [...events].sort(byTime);
  S.tombstones = tombstones || [];
  S.settings = settings;
  reindex();
}

// --- Writing ---------------------------------------------------------------------

/** Apply a change to memory and storage in one go, then schedule the auto-backup. */
async function commit({ books: putBooks = [], events: putEvents = [], removeEvents = [], removeBooks = [], settings = null }) {
  const t = now();
  const gone = new Set([...removeEvents, ...S.events.filter(e => removeBooks.includes(e.bookId)).map(e => e.id)]);
  const newTombs = [...gone, ...removeBooks].map(id => ({ id, at: t }));
  for (const b of putBooks) S.books.set(b.id, b);
  for (const id of removeBooks) S.books.delete(id);
  S.events = [...S.events.filter(e => !gone.has(e.id)), ...putEvents].sort(byTime);
  S.tombstones.push(...newTombs);
  if (settings) S.settings = settings;
  reindex();
  await store.write({
    put: { books: putBooks, events: putEvents, tombstones: newTombs, ...(settings ? { settings: [settings] } : {}) },
    del: { events: [...gone], books: removeBooks },
  });
  await store.setMeta("lastChangeAt", t);
  scheduleAutoBackup();
  render();
}

function patchBook(book, patch, t) {
  return { ...book, ...patch, updatedAt: t };
}

// --- Auto-backup ------------------------------------------------------------------

let autoTimer = null;
function scheduleAutoBackup() {
  if (!S.auto.handle || S.auto.state !== "granted") return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(writeAutoNow, 1500);
}

async function writeAutoNow() {
  try {
    await backup.writeAuto(S.auto.handle, archive());
    S.auto.lastWrite = now();
    await store.setMeta("autoLastWrite", S.auto.lastWrite);
  } catch (e) {
    S.auto.state = "error";
    S.notice = `The backup file couldn't be saved: ${e.message}`;
  }
  render();
}

/** On open (or reconnect): fold in anything newer from the shared file, then save. */
async function syncWithAutoFile() {
  const remote = await backup.readAuto(S.auto.handle);
  if (remote && !validateArchive(remote)) {
    const lastChange = (await store.getMeta("lastChangeAt")) || "";
    if ((remote.exportedAt || "") > lastChange) {
      const m = mergeArchives(archive(), migrate(remote));
      if (m.stats.booksAdded || m.stats.booksUpdated || m.stats.eventsAdded) {
        await store.snapshot("before merging the backup file", archive());
        await store.replaceAll(m);
        load(m);
        S.notice = `Brought in changes from the backup file: ${plural(m.stats.eventsAdded, "entry", "entries")}, ${plural(m.stats.booksAdded + m.stats.booksUpdated, "book")}.`;
      }
    }
  }
  await writeAutoNow();
}

// --- The Mac helper ------------------------------------------------------------------

let helperPoll = null;

/** Look for the helper; if it's there, bring in what it has. Never blocks the app. */
async function connectHelper() {
  try {
    S.helper.status = await H.status();
    S.helper.connected = true;
  } catch {
    S.helper.connected = false;
    S.helper.status = null;
    return render();
  }
  await pullFromHelper();
  watchHelper();
}

function watchHelper() {
  clearTimeout(helperPoll);
  if (!S.helper.connected) return;
  const busy = S.helper.status?.job || S.helper.status?.queued;
  helperPoll = setTimeout(async () => {
    const wasBusy = busy;
    try { S.helper.status = await H.status(); } catch { S.helper.connected = false; render(); return; }
    if (wasBusy && !S.helper.status.job && !S.helper.status.queued) await pullFromHelper();
    else if (route()[0] === "settings") render();
    watchHelper();
  }, busy ? 2500 : 60000);
}

/** Shelves (new books, changes) and the catalogue (covers, quotes, scores) from the helper. */
async function pullFromHelper() {
  const t = now();
  const shelf = await H.shelves().catch(() => null);
  if (shelf && shelf.synced_at && shelf.synced_at !== (await store.getMeta("helperShelvesApplied"))) {
    const plan = planImport(books(), H.incomingFromShelves(shelf), { now: t, source: "goodreads-helper" });
    const putBooks = [
      ...plan.creates.map(c => c.book),
      ...plan.updates.map(u => patchBook(S.books.get(u.id), { synced: u.synced, refs: u.refs }, t)),
      ...plan.gone.map(id => patchBook(S.books.get(id), { flags: { ...S.books.get(id).flags, goneFromGoodreads: t } }, t)),
      ...plan.back.map(id => patchBook(S.books.get(id), { flags: { ...S.books.get(id).flags, goneFromGoodreads: null } }, t)),
    ];
    S.helper.asks = plan.asks;
    if (putBooks.length) {
      if (plan.creates.length > 5) await store.snapshot("before a Goodreads sync", archive());
      await commit({ books: putBooks, events: plan.creates.flatMap(c => c.events) });
    }
    if (plan.creates.length || plan.gone.length) {
      const bits = [plan.creates.length && plural(plan.creates.length, "new book"), plan.gone.length && `${plan.gone.length} no longer on Goodreads`].filter(Boolean);
      S.notice = `From Goodreads: ${bits.join(", ")}.`;
    }
    await store.setMeta("helperShelvesApplied", shelf.synced_at);
  }
  const cat = await H.catalogue().catch(() => null);
  if (cat) {
    const putBooks = [];
    for (const b of books()) {
      const e = cat.entries[H.keyOf(b)];
      if (!e) continue;
      const d = e.details || {}, s = b.synced || {};
      const synced = { ...s };
      if (d.coverUrl && !s.coverUrl) synced.coverUrl = d.coverUrl;
      if (e.quote && e.quote.text && s.quote !== e.quote.text) synced.quote = e.quote.text;
      if (!s.pages && d.pages) synced.pages = d.pages;
      if (!s.year && d.year) synced.year = d.year;
      if (!s.publisher && d.publisher) synced.publisher = d.publisher;
      const refs = d.workId && !b.refs?.goodreadsWorkId ? { ...b.refs, goodreadsWorkId: d.workId } : b.refs;
      const score = e.score || b.score || null;
      if (JSON.stringify(synced) !== JSON.stringify(s) || refs !== b.refs || JSON.stringify(score) !== JSON.stringify(b.score || null)) {
        putBooks.push(patchBook(b, { synced, refs, score }, t));
      }
    }
    if (putBooks.length) await commit({ books: putBooks });
  }
  render();
}

function unscored() {
  return books().filter(b => b.status !== "abandoned" && !b.score && effective(b).title);
}

function helperBlock() {
  const h = S.helper, st = h.status;
  if (!h.connected) {
    return html`<p>Not found on this computer. The helper is optional: it brings in your Goodreads shelves, covers and quotes by itself, and scores each book's difficulty.
      <span class="quiet small">See the README to install it on a Mac; everything else works without it.</span>
      <button class="link" data-act="helper-retry">Look again</button></p>`;
  }
  const job = st.job ? `${{ sync: "Reading your Goodreads shelves", enrich: "Fetching Goodreads quotes, a few an hour", score: "Scoring difficulty" }[st.job.kind]}: ${st.job.done} of ${st.job.total || "…"}${st.job.kind === "score" && st.job.spent != null ? ` ($${st.job.spent.toFixed(3)} so far)` : ""}` : null;
  const scored = books().filter(b => b.score).length, todo = unscored().length;
  const e = h.estimate;
  return html`
    <p>Connected${st.goodreads_user_id ? `, Goodreads account ${st.goodreads_user_id}` : ""}. ${st.synced_at ? `Shelves last read ${relativeDay(st.synced_at)}.` : "Shelves not read yet."}
      ${st.signed_in === false ? raw('<b>Goodreads asked to sign in: open goodreads.com in Chrome and sign in.</b>') : ""}</p>
    ${job ? html`<p class="notice quiet">${job}…</p>` : html`<p><button data-act="helper-sync">Read Goodreads now</button></p>`}
    ${st.last_error ? html`<p class="notice">${st.last_error}</p>` : ""}
    ${h.asks.length ? html`<p class="notice">${plural(h.asks.length, "book")} from Goodreads ${h.asks.length === 1 ? "looks" : "look"} like one you already have. <button class="link" data-act="helper-asks">Decide</button></p>` : ""}
    <h3 class="sc small">Difficulty scores</h3>
    <p>${scored} of ${scored + todo} books scored${todo ? `; ${todo} waiting` : ""}. Scores come from ${st.model === "claude-haiku-5-5" ? "Claude Haiku 5.5" : st.model}, the cheapest model, checked before they're kept.
      ${st.spent_usd ? raw(`<span class="quiet small">Spent so far: $${st.spent_usd.toFixed(3)}.</span>`) : ""}</p>
    ${!st.scoring_ready ? html`<p class="quiet">The helper has no Claude API key, so it can't score yet (see the README).</p>`
      : todo && !(st.job && st.job.kind === "score") ? (e ? html`<p class="notice">Scoring ${plural(e.books, "book")} should cost about <b>$${e.usd.toFixed(2)}</b>${e.learned ? "" : " (a first estimate)"}. It stops by itself if it reaches $${e.cap.toFixed(2)}.
            <button data-act="helper-score">Score them</button> <button class="link" data-act="helper-estimate-cancel">Not now</button></p>`
          : html`<p><button data-act="helper-estimate">What would scoring ${todo === 1 ? "it" : `the ${todo}`} cost?</button></p>`) : ""}`;
}

// --- Start-up -----------------------------------------------------------------------

async function boot() {
  try {
    let data = await store.loadAll();
    if (!data.settings) {
      data.settings = defaultSettings(now());
      await store.write({ put: { settings: [data.settings] } });
    }
    if (data.settings.schemaVersion < SCHEMA_VERSION) {
      const before = makeArchive({ ...data, tombstones: data.tombstones }, now());
      before.schemaVersion = data.settings.schemaVersion;
      await store.snapshot(`before upgrading from version ${before.schemaVersion}`, before);
      const after = migrate(before);
      after.settings = { ...after.settings, schemaVersion: SCHEMA_VERSION };
      await store.replaceAll(after);
      data = after;
    }
    load(data);
    store.persist().catch(() => {});
    S.auto.handle = await backup.autoHandle();
    S.auto.lastWrite = await store.getMeta("autoLastWrite");
    if (S.auto.handle) {
      S.auto.state = await backup.autoPermission(S.auto.handle).catch(() => "error");
      if (S.auto.state === "granted") await syncWithAutoFile().catch(e => { S.notice = `Couldn't read the backup file: ${e.message}`; });
    }
    S.ready = true;
    connectHelper();
  } catch (e) {
    S.error = e.message || String(e);
  }
  render();
}

// --- Views ------------------------------------------------------------------------

const route = () => (location.hash.replace(/^#\/?/, "").split("#")[0] || "desk").split("/");

function nav(active) {
  const item = (href, label, key) => html`<a href="#/${href}" class="${active === key ? "on" : ""}">${label}</a>`;
  return html`<nav class="masthead">
    <a class="brand" href="#/">Antilibrary</a>
    <span class="tabs">${[item("", "The Desk", "desk"), item("list", "The List", "list"), item("settings", "Settings", "settings")]}</span>
  </nav>`;
}

function notices() {
  const out = [];
  if (S.notice) out.push(html`<p class="notice">${S.notice} <button class="link" data-act="dismiss">Dismiss</button></p>`);
  if (S.auto.handle && S.auto.state === "prompt") {
    out.push(html`<p class="notice">Your backup file needs permission again. <button class="link" data-act="auto-reconnect">Reconnect it</button></p>`);
  }
  if (S.ready && S.books.size && !S.auto.handle) {
    const last = S.settings.lastExportAt;
    if (!last || Date.now() - new Date(last) > 30 * 864e5) {
      out.push(html`<p class="notice quiet">Your library lives only in this browser. <a href="#/settings">Keep a backup</a>.</p>`);
    }
  }
  return out;
}

function pagesToday(bookId) {
  const today = localDayKey(now());
  return evs(bookId).filter(e => e.type === "progress" && localDayKey(e.at) === today).reduce((n, e) => n + (e.page - e.prevPage), 0);
}

function lastActivity(bookId) {
  const list = evs(bookId);
  return list.length ? list.at(-1).at : "";
}

function progressRule(page, pages) {
  const pct = pages ? Math.min(100, (page / pages) * 100) : 0;
  return html`<div class="rule" role="img" aria-label="${pages ? Math.round(pct) + "% read" : "page count unknown"}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}

function deskEntry(b) {
  const e = effective(b), page = currentPage(evs(b.id)), today = pagesToday(b.id);
  const f = derived().fc.get(b.id) || {};
  const planned = Math.round(Math.max(0, today) + pagesFromTokens(b.id, f.todayTokens || 0));
  const fin = finishWords(b.id);
  const undo = [...evs(b.id)].reverse().find(x => x.type === "progress" && x.source === "app");
  const done = e.pages && page >= e.pages;
  return html`<article class="entry">
    ${coverImg(b, "thumb")}
    <a class="t" href="#/book/${b.id}">${e.title}</a>
    <div class="a sc">${[e.author, e.year].filter(Boolean).join(" · ")}</div>
    ${progressRule(page, e.pages)}
    <div class="row">
      <span class="where">${planned > 0 || today > 0
        ? raw(`<b>${today > 0 ? `${today} of ${Math.max(planned, today)}` : planned} ${Math.max(planned, today) === 1 ? "page" : "pages"} today</b> · `) : ""}${page ? `page ${page}${e.pages ? ` of ${e.pages}` : ""}` : `not begun${e.pages ? ` · ${e.pages} pages` : ""}`}</span>
      <span class="btns">
        <button data-act="add" data-id="${b.id}" data-n="1" aria-label="Add one page">+1</button>
        <button data-act="add" data-id="${b.id}" data-n="2" aria-label="Add two pages">+2</button>
        <button data-act="add" data-id="${b.id}" data-n="5" aria-label="Add five pages">+5</button>
        <form class="pageform" data-form="page" data-id="${b.id}">
          <label class="vh" for="p-${b.id}">Page reached</label>
          <input id="p-${b.id}" name="page" type="number" inputmode="numeric" min="0" ${e.pages ? raw(`max="${e.pages}"`) : ""} placeholder="p." autocomplete="off">
        </form>
      </span>
    </div>
    ${fin && !done ? html`<p class="when">${fin.plain ? fin.phrase : `At your current pace, finishes ${fin.phrase}.`}</p>` : ""}
    <div class="fin">
      ${done ? raw(`<button class="link strong" data-act="status" data-id="${esc(b.id)}" data-to="read">Mark as finished</button> · `) : ""}
      ${undo ? raw(`<button class="link" data-act="undo" data-id="${esc(b.id)}">Undo p. ${undo.prevPage} → ${undo.page}</button> <span class="quiet">(${esc(relativeDay(undo.at))})</span>`) : ""}
    </div>
  </article>`;
}

function ledgerBlock(reading) {
  const d = derived(), goal = S.settings.dailyTokens;
  const today = d.ledger ? d.ledger.todayTokens : 0;
  const ref = reading.map(b => [b, d.fc.get(b.id)]).filter(([, f]) => f && f.tpp).sort((a, b) => (b[1].share || 0) - (a[1].share || 0))[0];
  const words = d.ledger ? M.ledgerWords(d.ledger, goal, ref ? effective(ref[0]).title : null, ref ? ref[1].tpp : null) : null;
  return html`<div class="ledger">
    <p>${words ? words.text : "The ledger begins with your first entry."}
      <span class="quiet">${today >= goal ? `Today's ${goal} tokens are read.` : today > 0 ? `Today: ${Math.round(today * 10) / 10} of ${goal} tokens.` : `Today: none of ${goal} tokens yet.`}${d.ledger ? (d.ledger.days < 28 ? ` Counted since ${shortDate(d.firstUse)}.` : " Counted over the last 28 days.") : ""}</span></p>
  </div>`;
}

function viewDesk() {
  const reading = books().filter(b => b.status === "reading").sort((a, b) => (lastActivity(b.id) > lastActivity(a.id) ? 1 : -1));
  const next = waiting().slice(0, O.bandsOf(S.settings).next);
  const empty = !S.books.size;
  return html`
    <div class="dateline sc"><span>${longDate(new Date())}</span><span>The Desk</span></div>
    ${empty ? html`<section class="welcome">
      <h1>An empty antilibrary</h1>
      <p>Bring in your Goodreads library (My Books › Import and export › Export library, then choose the file here), or add a book by hand.</p>
      <p><a class="button" href="#/import">Import from Goodreads</a> <a class="button quietbtn" href="#/add">Add a book</a></p>
    </section>` : html`
    <h1>In hand</h1>
    ${reading.length ? reading.map(deskEntry) : html`<p class="quiet">Nothing in hand. Begin something from the list below.</p>`}
    ${ledgerBlock(reading)}
    <h2 class="sc small">Next on the shelf</h2>
    <ol class="shelf">${next.map((b, i) => { const e = effective(b); return html`<li>
      <span class="n">${i + 1}</span><a href="#/book/${b.id}"><i>${e.title}</i> <span class="quiet">${e.author}</span>
        ${startWords(b.id) ? html`<span class="d">begins ${startWords(b.id).short}</span>` : ""}</a>
      <button class="link" data-act="status" data-id="${b.id}" data-to="reading">Begin</button></li>`; })}</ol>
    <p><a href="#/list">The whole list</a> · <a href="#/add">Add a book</a></p>`}`;
}

function listRow(b, i) {
  const e = effective(b), page = currentPage(evs(b.id)), d = bookDates(evs(b.id));
  const fw = finishWords(b.id);
  const right = b.status === "read" ? `finished ${shortDate(d.finished)}`
    : b.status === "abandoned" ? `set aside ${shortDate(d.finished || d.started || d.added)}`
    : b.status === "reading" ? `p. ${page}${e.pages ? ` of ${e.pages}` : ""}${fw && !fw.plain ? ` · ${fw.short}` : ""}`
    : e.pages ? `${e.pages} pp.${fw && !fw.plain ? ` · ${fw.short}` : ""}` : "pages unknown";
  return html`<li class="${b.flags?.goneFromGoodreads ? "flagged" : ""}">
    <span class="n">${i ?? ""}</span>
    <a href="#/book/${b.id}"><i>${e.title}</i> <span class="quiet">${e.author}${e.year ? `, ${e.year}` : ""}</span>
      ${b.flags?.goneFromGoodreads ? raw('<span class="flag">no longer on Goodreads</span>') : ""}</a>
    <span class="d">${right}</span>
  </li>`;
}

function viewList() {
  const q = S.query.trim().toLowerCase();
  const match = b => { if (!q) return true; const e = effective(b); return `${e.title} ${e.author}`.toLowerCase().includes(q); };
  const group = (status, sort) => books().filter(b => b.status === status).sort(sort);
  const sections = [
    ["In hand", group("reading", byQueue)],
    ["Paused", group("paused", byQueue)],
    ["Read", group("read", (a, b) => ((bookDates(evs(b.id)).finished || "") > (bookDates(evs(a.id)).finished || "") ? 1 : -1))],
    ["Set aside", group("abandoned", byQueue)],
  ];
  const plain = ([name, list]) => {
    if (!list.length) return "";
    const shown = list.filter(match);
    return html`<section><h2 class="sc small">${name} <span class="quiet">${list.length}</span></h2>
      ${shown.length ? html`<ol class="shelf">${shown.map(b => listRow(b, null))}</ol>` : html`<p class="quiet">None match.</p>`}</section>`;
  };
  return html`
    <div class="dateline sc"><span>${plural(S.books.size, "volume")}</span><span>The List</span></div>
    <form class="search" data-form="search" role="search"><label class="vh" for="q">Find a book</label>
      <input id="q" name="q" type="search" placeholder="Find by title or author" value="${S.query}" autocomplete="off"></form>
    ${plain(sections[0])}
    ${waitingBlock(match, !!q)}
    ${sections.slice(1).map(plain)}
    <p><a href="#/add">Add a book</a> · <a href="#/import">Import from Goodreads</a></p>`;
}

// --- The waiting list: bands, Move to…, dragging, keys ------------------------------------

const waiting = () => books().filter(b => b.status === "want").sort(byQueue);
const titleOf = id => effective(S.books.get(id)).title;
const ital = id => html`<i>${titleOf(id)}</i>`;
const BAND_NAME = { next: "Next", soon: "Soon", stacks: "The stacks" };

function waitingBlock(match, searching) {
  const list = waiting();
  if (!list.length) return "";
  const bands = O.bandsOf(S.settings);
  const groups = { next: [], soon: [], stacks: [] };
  list.forEach((b, i) => { if (match(b)) groups[O.bandAt(i, bands)].push([b, i]); });
  const count = k => (k === "next" ? Math.min(bands.next, list.length) : k === "soon" ? Math.max(0, Math.min(bands.soon, list.length - bands.next)) : Math.max(0, list.length - bands.next - bands.soon));
  const nSugg = O.suggestions(books(), H.keyOf).length;
  const band = k => html`<section class="band" data-band="${k}">
    <h2 class="bandhead"><span class="sc">${BAND_NAME[k]} <span class="quiet">${count(k)}</span></span>
      ${k !== "stacks" ? html`<span class="quiet small">holds ${bands[k]}
        <button class="link" data-act="band" data-k="${k}" data-d="-1" aria-label="${BAND_NAME[k]} holds fewer">fewer</button> ·
        <button class="link" data-act="band" data-k="${k}" data-d="1" aria-label="${BAND_NAME[k]} holds more">more</button></span>` : ""}</h2>
    <ol class="shelf waiting">${groups[k].length ? groups[k].map(([b, i]) => waitingRow(b, i)) : html`<li class="quiet small empty">${searching ? "None match here." : "Empty."}</li>`}</ol>
  </section>`;
  return html`<section class="waitingblock">
    <h2 class="sc small">Waiting <span class="quiet">${list.length}</span></h2>
    <p class="small orderlinks"><a href="#/order">Compare with the reading-youth order</a>${nSugg ? html` · <a href="#/order#after">${plural(nSugg, "suggested reading order")}</a>` : ""}
      ${S.undoOrder ? html` · <button class="link" data-act="undo-order">Put back the order before</button>` : ""}</p>
    ${S.listNote ? html`<p class="notice">${S.listNote} <button class="link" data-act="note-ok">OK</button></p>` : ""}
    ${band("next")}${band("soon")}${band("stacks")}
    <p class="quiet small keys">Keys: <kbd>↑</kbd> <kbd>↓</kbd> choose a book · <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> move it one place · <kbd>T</kbd> to the top · <kbd>N</kbd> <kbd>S</kbd> <kbd>B</kbd> to Next, Soon or the stacks · <kbd>M</kbd> Move to…</p>
  </section>`;
}

function waitingRow(b, i) {
  const e = effective(b), y = O.youthOf(b), D = M.difficultyOf(b, derived().p);
  const req = (b.prereqs || []).filter(id => S.books.has(id));
  const open = S.menu && S.menu.id === b.id && S.menu.where === "list";
  return html`<li class="row" id="row-${b.id}" data-id="${b.id}" tabindex="0" draggable="true">
    <span class="n">${i + 1}</span>
    <span class="body"><a href="#/book/${b.id}" tabindex="-1"><i>${e.title}</i> <span class="quiet">${e.author}</span></a>
      ${req.length ? html`<span class="after">after ${req.map(id => html`<i>${titleOf(id)}</i>`).reduce((a, x, k) => [...a, k ? ", " : "", x], [])}</span>` : ""}</span>
    <span class="right"><span class="d">${e.pages ? `${e.pages} pp. · ` : ""}difficulty ${Math.round(D.D * 10) / 10}${y.youth != null ? ` · youth ${y.youth}` : ""}</span>
      <button class="link" data-act="menu" data-id="${b.id}" aria-expanded="${open ? "true" : "false"}">Move to…</button>
      <span class="grip" aria-hidden="true" title="Drag to move">⠿</span></span>
  </li>${open ? html`<li class="menurow">${moveMenu(b)}</li>` : ""}`;
}

function moveMenu(b) {
  const m = S.menu;
  if (m.mode) return pickPanel(b, m.mode);
  return html`<div class="movemenu" role="group" aria-label="Move ${effective(b).title}">
    <button data-act="move" data-id="${b.id}" data-go="top">To the top</button>
    <button data-act="move" data-id="${b.id}" data-go="soon">To the top of Soon</button>
    <button data-act="move" data-id="${b.id}" data-go="stacks">To the top of the stacks</button>
    <button data-act="move" data-id="${b.id}" data-go="end">To the end</button>
    <button data-act="menu-mode" data-id="${b.id}" data-mode="after">Just after another book…</button>
    <button data-act="menu-mode" data-id="${b.id}" data-mode="req">Read it after another book…</button>
    <button class="link" data-act="menu-close">Close</button>
  </div>`;
}

/** Search for the other book: where to put this one, or what it reads after. */
function pickPanel(b, mode) {
  const q = (S.menu.q || "").trim().toLowerCase();
  const pool = mode === "after" ? waiting() : books().filter(x => ["want", "reading", "paused"].includes(x.status));
  const hits = pool.filter(x => x.id !== b.id && (!q || `${effective(x).title} ${effective(x).author}`.toLowerCase().includes(q))).slice(0, 30);
  const where = new Map(waiting().map((x, i) => [x.id, i + 1]));
  return html`<div class="movemenu pick">
    <label for="pick-q">${mode === "after" ? html`Put ${ital(b.id)} just after…` : html`${ital(b.id)} is read after…`}</label>
    <input id="pick-q" type="search" value="${S.menu.q || ""}" placeholder="Find a book" autocomplete="off">
    <ol>${hits.map(x => html`<li><button data-act="pick" data-id="${b.id}" data-other="${x.id}">${where.has(x.id) ? `${where.get(x.id)}. ` : ""}<i>${effective(x).title}</i> <span class="quiet">${effective(x).author}${x.status !== "want" ? ` · ${STATUS_LABEL[x.status].toLowerCase()}` : ""}</span></button></li>`)}</ol>
    <button class="link" data-act="menu-close">Cancel</button>
  </div>`;
}

/** Index (with the moving book taken out) of another waiting book. */
const restIndex = (id, other) => waiting().filter(b => b.id !== id).findIndex(b => b.id === other);

async function moveBook(id, index) {
  const r = O.moveTo(waiting(), id, index);
  S.listNote = r.blockedBy
    ? (r.at > index ? html`Placed just after ${ital(r.blockedBy)}, which it reads after.` : html`Placed just before ${ital(r.blockedBy)}, which reads after it.`)
    : null;
  S.focusRow = id;
  const b = S.books.get(id);
  const cur = waiting().findIndex(x => x.id === id);
  if (r.at === cur) return render();
  await commit({ books: [patchBook(b, { queueKey: r.queueKey }, now())] });
}

/** "id reads after other": refuses loops, and moves id down if it's above other. */
async function addPrereq(id, other) {
  const b = S.books.get(id);
  if (O.wouldLoop(O.prereqMap(books()), id, other)) {
    S.listNote = html`Can't: ${ital(other)} already reads after ${ital(id)}, so that would go round in a circle.`;
    return render();
  }
  const t = now();
  const nb = patchBook(b, { prereqs: [...new Set([...(b.prereqs || []), other])], prereqsDeclined: (b.prereqsDeclined || []).filter(x => x !== other) }, t);
  S.listNote = html`${ital(id)} now reads after ${ital(other)}.`;
  if (b.status === "want") {
    const list = waiting().map(x => (x.id === id ? nb : x));
    const cur = list.findIndex(x => x.id === id);
    const r = O.moveTo(list, id, cur);
    if (r.at !== cur) { nb.queueKey = r.queueKey; S.listNote = html`${ital(id)} now reads after ${ital(other)}, so it moved down to just after it.`; }
  }
  await commit({ books: [nb] });
}

/** Accept several suggested pairs at once, then let the order respect them. */
async function acceptSuggestions(pairs) {
  const t = now(), work = new Map(books().map(b => [b.id, b]));
  let n = 0;
  for (const { id, after } of pairs) {
    const map = O.prereqMap([...work.values()]);
    if (O.wouldLoop(map, id, after)) continue;
    const b = work.get(id);
    work.set(id, { ...b, prereqs: [...new Set([...(b.prereqs || []), after])], updatedAt: t });
    n++;
  }
  const list = [...work.values()].filter(b => b.status === "want").sort(byQueue);
  const ids = O.respectPrereqs(list.map(b => b.id), O.prereqMap(list));
  const moved = ids.some((id, i) => id !== list[i].id);
  if (moved) {
    await store.snapshot("before accepting suggested reading orders", archive());
    for (const p of O.rekey(list, ids)) work.set(p.id, { ...work.get(p.id), queueKey: p.queueKey, updatedAt: t });
  }
  const changed = [...work.values()].filter(b => b !== S.books.get(b.id));
  S.notice = `${plural(n, "reading order")} accepted${moved ? "; books that read after others moved down to follow them" : ""}.`;
  await commit({ books: changed });
}

// --- The youth-order preview ---------------------------------------------------------------

function viewOrder() {
  const list = waiting(), ids = list.map(b => b.id);
  const scored = list.filter(b => O.youthOf(b).youth != null).length;
  const yo = O.youthOrder(list), ypos = new Map(yo.map((id, i) => [id, i]));
  const mv = O.moves(ids, yo);
  const big = mv.slice().sort((a, b) => Math.abs(b.by) - Math.abs(a.by)).filter(m => m.by !== 0);
  const marked = new Set(big.slice(0, 12).map(m => m.id));
  const anyTime = list.filter(b => O.youthOf(b).anyTime);
  const sugg = O.suggestions(books(), H.keyOf);
  const same = mv.every(m => m.by === 0);
  const row = (id, i, withMove) => {
    const m = mv.find(x => x.id === id), y = O.youthOf(S.books.get(id));
    return html`<li><span class="n">${i + 1}</span><a href="#/book/${id}"><i>${titleOf(id)}</i> <span class="quiet">${effective(S.books.get(id)).author}</span></a>
      ${withMove ? html`<span class="mv ${marked.has(id) ? "big" : ""}" title="youth ${y.youth ?? "–"}">${m.by > 0 ? `↑ ${m.by}` : m.by < 0 ? `↓ ${-m.by}` : "—"}</span>` : ""}</li>`;
  };
  return html`
    <div class="dateline sc"><span>The waiting list</span><a href="#/list">The List</a></div>
    <h1>The reading-youth order</h1>
    <p>Each book has a reading-youth figure: when in a reading life it's going to be good to read. Early books are ways in that hit young; later ones ask more and pay back what came before. Ordering by it is an interpretation, not a ranking of worth.</p>
    ${scored < list.length ? html`<p class="notice quiet">${scored} of ${list.length} waiting books have a youth figure. The rest keep their places at the end until the Mac helper scores them, or you give them one.</p>` : ""}
    ${same ? html`<p class="notice quiet">Your list is already in reading-youth order.</p>` : html`
    <p class="quiet small">The first 25 of each. ↑ is how far a book would rise; the twelve largest moves are marked.${anyTime.length ? ` ${anyTime.map(b => effective(b).title).join(" and ")} ${anyTime.length === 1 ? "has" : "have"} no particular time, so ${anyTime.length === 1 ? "it goes" : "they go"} in as ${anyTime.length === 1 ? "an interlude" : "interludes"}.` : ""}</p>
    <div class="cmp">
      <section><h2 class="sc small">Your order now</h2><ol class="shelf">${ids.slice(0, 25).map((id, i) => row(id, i, false))}</ol></section>
      <section><h2 class="sc small">By reading-youth</h2><ol class="shelf">${yo.slice(0, 25).map((id, i) => row(id, i, true))}</ol></section>
    </div>
    <h2 class="sc small">The largest moves</h2>
    <ol class="moves">${big.slice(0, 8).map(m => { const y = O.youthOf(S.books.get(m.id)); return html`<li><a href="#/book/${m.id}"><i>${titleOf(m.id)}</i></a>: ${m.from + 1} → ${m.to + 1}
      <span class="quiet small">youth ${y.youth}${y.note ? `: ${y.note}` : ""}</span></li>`; })}</ol>
    <p class="actions"><button data-act="youth-accept">Use the reading-youth order</button> <a href="#/list">Keep my order</a></p>
    <p class="quiet small">A copy of your current order is kept, so you can put it back. Disagree with a book's place? Set your own youth figure on its page, and move it by hand afterwards whenever you like.</p>`}
    <h2 class="sc small" id="after">Suggested reading orders <span class="quiet">${sugg.length}</span></h2>
    ${sugg.length ? html`<p>Pairs where one book answers or builds on another. Accept one and the later book always stays after the earlier; ignore it and it isn't suggested again.</p>
      <ul class="sugg">${sugg.map(x => html`<li>Read ${ital(x.id)} after ${ital(x.after)}
        <span class="btns"><button data-act="sugg-yes" data-id="${x.id}" data-other="${x.after}">Accept</button> <button class="link" data-act="sugg-no" data-id="${x.id}" data-other="${x.after}">Ignore</button></span></li>`)}</ul>
      <p><button data-act="sugg-all">Accept all ${sugg.length}</button></p>`
      : html`<p class="quiet">None waiting.</p>`}`;
}

function youthText(b) {
  const y = O.youthOf(b);
  if (y.youth == null) return "not yet scored";
  const stage = O.STAGES[O.stageOfYouth(y.youth)];
  return y.source === "yours" ? `${y.youth}, ${stage} (your figure)` : `${y.youth}, ${stage}`;
}

/** On a book's page: what it reads after, suggestions, and adding one. */
function afterBlock(b) {
  if (!["want", "reading", "paused"].includes(b.status)) return "";
  const req = (b.prereqs || []).filter(id => S.books.has(id));
  const sugg = O.suggestions(books(), H.keyOf).filter(x => x.id === b.id);
  const later = books().filter(x => (x.prereqs || []).includes(b.id) && x.status === "want");
  const open = S.menu && S.menu.id === b.id && S.menu.where === "book";
  return html`<h2 class="sc small">Reading order</h2>
    ${req.length ? html`<ul class="sugg">${req.map(id => html`<li>Read after ${ital(id)}${S.books.get(id).status === "read" ? raw(' <span class="quiet small">(read)</span>') : ""}
      <button class="link" data-act="unreq" data-id="${b.id}" data-other="${id}">Remove</button></li>`)}</ul>` : ""}
    ${later.length ? html`<p class="quiet small">${later.map(x => effective(x).title).join(", ")} ${later.length === 1 ? "reads" : "read"} after this.</p>` : ""}
    ${sugg.map(x => html`<p class="notice quiet">Suggested: read this after ${ital(x.after)}.
      <button class="link" data-act="sugg-yes" data-id="${b.id}" data-other="${x.after}">Accept</button> · <button class="link" data-act="sugg-no" data-id="${b.id}" data-other="${x.after}">Ignore</button></p>`)}
    ${open ? pickPanel(b, "req") : html`<p><button class="link" data-act="book-req" data-id="${b.id}">Read it after another book…</button></p>`}`;
}

const STATUS_LABEL = { want: "Waiting", reading: "In hand", paused: "Paused", read: "Read", abandoned: "Set aside" };

function describe(e) {
  if (e.type === "progress") return e.prevPage === 0 && e.source !== "app" ? `p. ${e.page}` : `p. ${e.prevPage} → ${e.page}`;
  if (e.type === "status") {
    if (e.from == null) return "Added to the list";
    if (e.to === "reading") return e.from === "paused" ? "Resumed" : e.from === "read" ? "Begun again" : "Begun";
    return { want: "Returned to the list", paused: "Paused", read: "Finished", abandoned: "Set aside" }[e.to];
  }
  return e.type;
}

function viewBook(id) {
  const b = S.books.get(id);
  if (!b) return html`<p>That book isn't in your library. <a href="#/list">Back to the list</a></p>`;
  const e = effective(b), list = evs(id), page = currentPage(list), d = bookDates(list), m = b.mine || {}, s = b.synced || {};
  const actions = {
    want: [["reading", "Begin"], ["abandoned", "Set aside"]],
    reading: [["read", "Mark as finished"], ["paused", "Pause"], ["want", "Return to the list"], ["abandoned", "Set aside"]],
    paused: [["reading", "Resume"], ["want", "Return to the list"], ["abandoned", "Set aside"]],
    read: [["reading", "Read again"]],
    abandoned: [["reading", "Begin again"], ["want", "Return to the list"]],
  }[b.status] || [];
  const field = (key, label, type = "text") => html`<label>${label}
    <input name="${key}" type="${type}" value="${key in m ? m[key] : ""}" placeholder="${s[key] ?? ""}" ${type === "number" ? raw('inputmode="numeric" min="1"') : ""}>
    ${key in m && s[key] != null ? raw(`<button type="button" class="link" data-act="reset-field" data-id="${esc(id)}" data-key="${key}">Use Goodreads’ ${esc(String(s[key]))}</button>`) : ""}</label>`;
  return html`
    <div class="dateline sc"><span>${STATUS_LABEL[b.status]}</span><a href="#/list">The List</a></div>
    <article class="record">
      ${coverImg(b, "cover")}
      <h1 class="t">${e.title}</h1>
      <p class="a sc">${e.author}</p>
      ${e.annotation ? html`<blockquote class="epigraph">${e.annotation}</blockquote>` : ""}
      <dl class="colophon">
        <dt>First published</dt><dd>${e.year ?? "—"}</dd>
        <dt>Edition</dt><dd>${[e.edition, s.publisher].filter(Boolean).join(", ") || "—"}</dd>
        <dt>Pages</dt><dd>${e.pages ?? "unknown"}${"pages" in m ? raw(' <span class="quiet">(your count)</span>') : ""}</dd>
        <dt>Progress</dt><dd>${page ? `page ${page}` : "not begun"}${e.pages && page ? ` · ${Math.round((page / e.pages) * 100)}%` : ""}</dd>
        <dt>Difficulty</dt><dd>${diffText(b)}</dd>
        <dt>Reading-youth</dt><dd>${youthText(b)}${O.youthOf(b).note && O.youthOf(b).source === "ai" ? raw(`<br><span class="quiet small">${esc(O.youthOf(b).note)}</span>`) : ""}</dd>
        <dt>Pace</dt><dd>${paceText(b)}</dd>
        ${(b.status === "reading" || b.status === "want") && finishWords(id) ? html`<dt>${b.status === "want" ? "Expected" : "Finishes"}</dt><dd>${b.status === "want" && startWords(id) ? `begins ${startWords(id).phrase}; ` : ""}${finishWords(id).plain ? finishWords(id).phrase : `finishes ${finishWords(id).phrase}`}</dd>` : ""}
        <dt>Added</dt><dd>${shortDate(d.added) || "—"}</dd>
        ${d.started ? html`<dt>Begun</dt><dd>${shortDate(d.started)}</dd>` : ""}
        ${d.finished ? html`<dt>Finished</dt><dd>${shortDate(d.finished)}</dd>` : ""}
        ${b.refs?.goodreadsBookId ? html`<dt>Goodreads</dt><dd><a href="https://www.goodreads.com/book/show/${b.refs.goodreadsBookId}" target="_blank" rel="noopener">book ${b.refs.goodreadsBookId}</a></dd>` : ""}
      </dl>
      <p class="actions">${actions.map(([to, label]) => html`<button data-act="status" data-id="${id}" data-to="${to}">${label}</button>`)}</p>
      ${whyBlock(b)}
      ${b.flags?.goneFromGoodreads ? html`<p class="notice quiet">This book is no longer on your Goodreads Want to Read or Currently Reading shelves (noticed ${shortDate(b.flags.goneFromGoodreads)}). It stays here until you decide.
        <button class="link" data-act="clear-flag" data-id="${id}">Keep it</button></p>` : ""}

      ${b.status === "reading" ? shareBlock(b) : ""}
      ${S.listNote && S.menu === null && route()[0] === "book" ? html`<p class="notice">${S.listNote} <button class="link" data-act="note-ok">OK</button></p>` : ""}
      ${afterBlock(b)}
      <h2 class="sc small">Annotation</h2>
      <form class="annot" data-form="annotation" data-id="${id}">
        <label class="vh" for="annot">One line: a quote or a note</label>
        <input id="annot" name="annotation" value="${e.annotation}" placeholder="One line: a quote or a note" maxlength="400">
        <button>Save</button>
        ${e.annotationIsMine && s.quote ? raw(`<button type="button" class="link" data-act="annot-default" data-id="${esc(id)}">Use the Goodreads quote</button>`) : ""}
      </form>
      <p class="quiet small">${e.annotationIsMine ? "Your words. Syncing never changes them." : s.quote ? "From Goodreads. Edit it and it becomes yours." : "Goodreads quotes arrive with the Mac helper (Stage 4)."}</p>

      <details class="edit"><summary>Correct the details</summary>
        <form data-form="details" data-id="${id}">
          ${field("title", "Title")}${field("author", "Author")}${field("pages", "Pages", "number")}${field("year", "First published", "number")}${field("edition", "Edition")}
          <label>Difficulty, 1–10 <input name="difficulty" type="number" step="0.5" min="1" max="10" inputmode="decimal" value="${m.difficulty ?? ""}" placeholder="${M.difficultyOf({ ...b, mine: {} }, derived().p).source === "provisional" ? "not yet scored" : Math.round(M.difficultyOf({ ...b, mine: {} }, derived().p).D * 10) / 10}">
            <span class="quiet small">Reading effort, not merit: how slowly a page goes. Leave empty to use the AI's score.</span></label>
          <label>Reading-youth, 0–100 <input name="youth" type="number" step="1" min="0" max="100" inputmode="numeric" value="${m.youth ?? ""}" placeholder="${b.score?.youth ?? "not yet scored"}">
            <span class="quiet small">When in a reading life it's good to read: 0 late teens, 20 early twenties, 40 later twenties, 60 thirties, 80 forty on. Leave empty to use the AI's.</span></label>
          <button>Save</button> <span class="quiet small">Your corrections are kept even when Goodreads changes.</span>
        </form>
      </details>

      <h2 class="sc small">History</h2>
      <ol class="history">${[...list].reverse().map(x => html`<li><span class="d">${x.approx ? shortDate(x.at) : relativeDay(x.at)}</span><span>${describe(x)}${x.approx ? raw(' <span class="quiet">(from Goodreads)</span>') : ""}</span></li>`)}</ol>

      <p class="danger">${S.confirm === `delete:${id}`
        ? html`Remove <i>${e.title}</i> and its history from this library? This can't be undone, except from a backup.
           <button data-act="delete" data-id="${id}">Remove it</button> <button class="link" data-act="cancel">Keep it</button>`
        : html`<button class="link" data-act="ask-delete" data-id="${id}">Remove from the library…</button>`}</p>
    </article>`;
}

/** The book's cover: Goodreads' if known, else Open Library's by ISBN (hidden if it has none). */
function coverImg(b, cls) {
  const e = effective(b);
  const src = e.coverUrl || (b.refs?.isbn13 ? `https://covers.openlibrary.org/b/isbn/${b.refs.isbn13}-M.jpg?default=false` : null);
  if (!src) return "";
  return html`<img class="${cls}" src="${src}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`;
}

const COMPONENT_LABEL = { lexical: "Vocabulary", syntactic: "Sentences", conceptual: "Ideas", structural: "Structure" };

function whyBlock(b) {
  const sc = b.score;
  if (!sc || !sc.components) return "";
  const p = derived().p;
  const { pages } = effective(b);
  const D = M.difficultyOf({ ...b, mine: {} }, p).D;
  return html`<details class="why"><summary>Why difficulty ${Math.round(D * 10) / 10}${b.mine?.difficulty != null ? " (before your figure)" : ""}</summary>
    <dl class="colophon">${Object.entries(sc.components).map(([k, c]) => html`<dt>${COMPONENT_LABEL[k] || k}</dt><dd>${c.score} · ${c.reason}</dd>`)}
      <dt>Content</dt><dd>${sc.C}${sc.content_reason ? ` · ${sc.content_reason}` : ""}</dd>
      <dt>Length</dt><dd>about ${(Math.round(sc.words / 1000) * 1000).toLocaleString("en-GB")} words${pages ? `, so about ${Math.round(sc.words / pages)} a page in your edition` : ""} <span class="quiet small">(${sc.words_basis})</span>
        ${pages && (sc.words / pages < M.WPP_RANGE[0] || sc.words / pages > M.WPP_RANGE[1]) ? raw(`<br><span class="quiet small">That's an unusual page, so the difficulty assumes a typical one (${M.WPP_RANGE[0]}–${M.WPP_RANGE[1]} words). Check the page count, or set your own figure.</span>`) : ""}</dd>
    </dl>
    ${sc.flags && sc.flags.length ? html`<p class="notice quiet">${sc.flags.join("; ")}.</p>` : ""}
    <p class="quiet small">Difficulty is reading effort, not merit: how slowly a page of this text goes. Scored by ${sc.model === "claude-haiku-5-5" ? "Claude Haiku 5.5" : sc.model} on ${shortDate(sc.scored_at)}. If it feels wrong, set your own figure below.</p>
  </details>`;
}

function diffText(b) {
  const d = M.difficultyOf(b, derived().p);
  const n = Math.round(d.D * 10) / 10;
  return d.source === "yours" ? `${n} (your figure)` : d.source === "ai" ? `${n}` : `${n}, provisional (not yet scored)`;
}

function paceText(b) {
  const p = derived().p, D = M.difficultyOf(b, p).D;
  const pp = 10 * M.pagesPerToken(D, p), min = M.minutesPerPage(D, p);
  const q = x => (x >= 10 ? Math.round(x) : Math.round(x * 2) / 2);
  return raw(`about ${q(pp)} pages for 10 tokens <span class="quiet small">(≈ ${q(min)} min a page)</span>`);
}

function shareBlock(b) {
  const f = derived().fc.get(b.id) || {};
  const pct = Math.round((f.share || 0) * 100);
  return html`<h2 class="sc small">Share of the day</h2>
    ${b.sharePin != null
      ? html`<p>Fixed at ${b.sharePin} ${b.sharePin === 1 ? "token" : "tokens"} a day. <button class="link" data-act="unpin" data-id="${b.id}">Let it be learned</button></p>`
      : html`<p>About ${pct}% of the daily effort, learned from what you've read lately.</p>
        <form class="inline" data-form="pin" data-id="${b.id}"><label>Fix at <input name="pin" type="number" min="0" max="100" step="0.5" inputmode="decimal"> tokens a day</label><button>Fix</button></form>`}`;
}

function viewAdd() {
  return html`
    <div class="dateline sc"><span>By hand</span><span>Add a book</span></div>
    <h1>Add a book</h1>
    <form class="stack" data-form="add">
      <label>Title <input name="title" required autocomplete="off"></label>
      <label>Author <input name="author" autocomplete="off"></label>
      <label>Pages <input name="pages" type="number" inputmode="numeric" min="1"></label>
      <label>First published <input name="year" type="number" inputmode="numeric"></label>
      <p><button>Add to the end of the list</button> <a href="#/list">Cancel</a></p>
    </form>`;
}

function viewImport() {
  const p = S.plan;
  if (!p) {
    return html`
      <div class="dateline sc"><span>Goodreads</span><span>Import</span></div>
      <h1>Import from Goodreads</h1>
      <ol class="steps">
        <li>On goodreads.com: <i>My Books</i> › <i>Import and export</i> › <i>Export Library</i>, then download the file.</li>
        <li>Choose it here. Nothing changes until you've seen what the import will do.</li>
      </ol>
      <p><label class="button">Choose the Goodreads CSV file <input type="file" accept=".csv,text/csv" data-change="csv" hidden></label></p>
      <p class="quiet small">Want to Read and Currently Reading become your list; Read becomes history. Other shelves are left out. Re-importing later is safe: books are matched, your edits are kept, and nothing is deleted.</p>`;
  }
  const st = p.creates.reduce((m, c) => ((m[c.book.status] = (m[c.book.status] || 0) + 1), m), {});
  const skipped = Object.entries(p.skipped);
  return html`
    <div class="dateline sc"><span>Goodreads</span><span>Import</span></div>
    <h1>What this import will do</h1>
    <dl class="colophon">
      <dt>New books</dt><dd>${p.creates.length}${p.creates.length ? ` — ${[st.want && `${st.want} waiting`, st.reading && `${st.reading} in hand`, st.read && `${st.read} read`].filter(Boolean).join(", ")}` : ""}</dd>
      <dt>Updated from Goodreads</dt><dd>${p.updates.length}</dd>
      <dt>Unchanged</dt><dd>${p.unchanged}</dd>
      <dt>No longer on Goodreads</dt><dd>${p.gone.length ? `${p.gone.length} (flagged, not removed)` : "none"}</dd>
      <dt>Other shelves left out</dt><dd>${skipped.length ? skipped.map(([k, v]) => `${k} ${v}`).join(", ") : "none"}</dd>
    </dl>
    ${p.asks.length ? html`<h2 class="sc small">Questions</h2>
      <ul class="asks">${p.asks.map((a, i) => { const other = S.books.get(a.matchId); return html`<li>
        <i>${a.incoming.title}</i> (${a.incoming.author}) looks like <a href="#/book/${a.matchId}"><i>${effective(other).title}</i></a> already in your library${a.kind === "edition" ? " — another edition" : ""}.
        <span class="choice"><label><input type="radio" name="ask-${i}" value="link" data-change="ask" data-i="${i}" ${a.choice === "link" ? raw("checked") : ""}> Same book</label>
        <label><input type="radio" name="ask-${i}" value="add" data-change="ask" data-i="${i}" ${a.choice === "add" ? raw("checked") : ""}> Add separately</label>
        <label><input type="radio" name="ask-${i}" value="skip" data-change="ask" data-i="${i}" ${!a.choice || a.choice === "skip" ? raw("checked") : ""}> Leave out</label></span></li>`; })}</ul>` : ""}
    <p class="actions"><button data-act="apply-import">Import</button> <button class="link" data-act="cancel-import">Cancel</button></p>
    <p class="quiet small">A copy of your library is kept first, so this can be undone from Settings › Earlier copies.</p>`;
}

function viewSettings() {
  const counts = `${plural(S.books.size, "book")}, ${plural(S.events.length, "history entry", "history entries")}`;
  const auto = S.auto;
  return html`
    <div class="dateline sc"><span>${counts}</span><span>Settings</span></div>
    <h1>Settings</h1>

    <section><h2 class="sc small">Keeping your library safe</h2>
      <p>Your library lives in this browser. Nothing is sent anywhere.</p>
      ${backup.autoBackupSupported() ? html`
        <p><b>Backup file.</b> ${auto.handle
          ? html`Saved automatically after every change${auto.lastWrite ? `, last ${relativeDay(auto.lastWrite)}` : ""}.
              ${auto.state !== "granted" ? html` <button data-act="auto-reconnect">Reconnect</button>` : ""}
              <button class="link" data-act="auto-disconnect">Stop</button>`
          : html`Choose a file in Dropbox or iCloud Drive and Antilibrary keeps it up to date. The phone reads the same file.
              <button data-act="auto-connect">Choose a file…</button>`}</p>` : html`
        <p class="quiet">This browser can't keep a backup file up to date by itself. Save a copy after reading, and load the shared copy when you open the app.</p>`}
      <p><button data-act="export">Save a copy now</button>
        <label class="button quietbtn">Load from a copy… <input type="file" accept=".json,application/json" data-change="archive" hidden></label></p>
      ${S.pendingArchive ? html`<p class="notice">That copy holds ${plural(S.pendingArchive.books.length, "book")} and ${plural(S.pendingArchive.events.length, "entry", "entries")}, saved ${shortDate(S.pendingArchive.exportedAt)}.
        <button data-act="restore-merge">Merge it in</button> <button data-act="restore-replace">Replace everything with it</button> <button class="link" data-act="restore-cancel">Cancel</button></p>` : ""}
      <p class="quiet small">Merging keeps everything from both. Replacing makes this library exactly the copy. Either way an earlier copy is kept below.</p>
    </section>

    <section><h2 class="sc small">Earlier copies</h2>
      <div id="snapshots"><p class="quiet">Loading…</p></div>
    </section>

    <section><h2 class="sc small">Daily effort</h2>
      <form data-form="tokens" class="inline">
        <label>Tokens a day <input name="tokens" type="number" min="1" max="100" value="${S.settings.dailyTokens}" inputmode="numeric"></label>
        <button>Save</button></form>
      <p class="quiet small">${S.settings.dailyTokens} tokens ≈ ${S.settings.dailyTokens * S.settings.minutesPerToken} minutes of focused reading.</p>
    </section>

    <section><h2 class="sc small">The model</h2>
      <form data-form="model" class="stack">
        <label>Minutes per token <input name="tau" type="number" min="1" max="30" step="0.5" value="${S.settings.minutesPerToken}" inputmode="decimal">
          <span class="quiet small">Only changes the minutes shown in small print; pages and dates stay the same.</span></label>
        <label>Easy-text speed, words a minute <input name="v1" type="number" min="100" max="800" value="${S.settings.model.v1}" inputmode="numeric">
          <span class="quiet small">Your pace on the lightest prose (difficulty 1).</span></label>
        <label>Hard-text speed, words a minute <input name="v10" type="number" min="20" max="400" value="${S.settings.model.v10}" inputmode="numeric">
          <span class="quiet small">Your pace on the densest text (difficulty 10). The gap between the two sets how much harder hard books are: now ${Math.round((S.settings.model.v1 / S.settings.model.v10) * 10) / 10}×.</span></label>
        <label>Books in hand at once <select name="concurrency">
          <option value="auto" ${S.settings.concurrency === "auto" ? raw("selected") : ""}>As many as I'm reading now</option>
          ${[1, 2, 3, 4, 5].map(n => html`<option value="${n}" ${S.settings.concurrency === n ? raw("selected") : ""}>${n}</option>`)}</select>
          <span class="quiet small">When a book finishes, the next on the list begins only if you're below this.</span></label>
        <fieldset class="days"><legend>Reading days</legend>
          ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((n, i) => html`<label><input type="checkbox" name="day${i}" ${S.settings.readingDays[i] ? raw("checked") : ""}> ${n}</label>`)}</fieldset>
        <p><button>Save</button></p>
      </form>
      <p class="quiet small">A page of difficulty 1 takes about ${M.minutesPerPage(1, derived().p).toFixed(2)} minutes; difficulty 10, about ${M.minutesPerPage(10, derived().p).toFixed(1)}.</p>
    </section>

    <section><h2 class="sc small">The Mac helper</h2>${helperBlock()}</section>

    <section><h2 class="sc small">Library</h2>
      <p><a href="#/import">Import from Goodreads</a> · <a href="#/add">Add a book by hand</a></p>
      <p class="quiet small">Antilibrary ${APP_VERSION} · data version ${SCHEMA_VERSION}</p>
    </section>`;
}

async function fillSnapshots() {
  const el = document.getElementById("snapshots");
  if (!el) return;
  const list = await store.listSnapshots();
  el.innerHTML = list.length
    ? html`<ul class="snaps">${list.map(s => html`<li><span class="d">${relativeDay(s.at)}</span> ${s.reason} <span class="quiet">(${plural(s.books, "book")})</span>
        <button class="link" data-act="snapshot-restore" data-id="${s.id}">Restore</button></li>`)}</ul>`
    : '<p class="quiet">None yet. One is kept automatically before every import or restore.</p>';
}

function render() {
  const root = document.getElementById("app");
  if (S.error) { root.innerHTML = html`<main class="page"><h1>Antilibrary couldn't open</h1><p>${S.error}</p></main>`; return; }
  if (!S.ready) return;
  const [name, arg] = route();
  const view = { desk: viewDesk, list: viewList, order: viewOrder, book: () => viewBook(arg), add: viewAdd, import: viewImport, settings: viewSettings }[name] || viewDesk;
  const active = { desk: "desk", list: "list", order: "list", book: "list", add: "list", import: "settings", settings: "settings" }[name] || "desk";
  const focus = document.activeElement?.id;
  root.innerHTML = html`${nav(active)}<main class="page">${notices()}${view()}</main>`;
  if (S.focusRow && document.getElementById(`row-${S.focusRow}`)) {
    const el = document.getElementById(`row-${S.focusRow}`);
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
    S.focusRow = null;
  } else if (focus && document.getElementById(focus)) {
    const el = document.getElementById(focus);
    el.focus();
    if (el.type === "search") el.setSelectionRange(el.value.length, el.value.length);
  }
  if (name === "settings") fillSnapshots();
}

// --- Actions ------------------------------------------------------------------------

async function act(name, d) {
  const t = now();
  const b = d.id ? S.books.get(d.id) : null;
  switch (name) {
    case "dismiss": S.notice = null; return render();
    case "cancel": S.confirm = null; return render();
    case "add": {
      const r = logPages(b, evs(b.id), +d.n, t);
      if (r) await commit({ events: r.events, books: r.patch ? [patchBook(b, r.patch, t)] : [] });
      return;
    }
    case "undo": {
      const r = undoLast(b, evs(b.id));
      if (r) await commit({ removeEvents: r.remove, books: r.patch ? [patchBook(b, r.patch, t)] : [] });
      return;
    }
    case "status": {
      const r = changeStatus(b, evs(b.id), d.to, t);
      if (!r) return;
      const patch = { ...r.patch };
      if (d.to === "want" && !b.queueKey) patch.queueKey = keysBetween(null, books().filter(x => x.status === "want").map(x => x.queueKey).filter(Boolean).sort(compareKeys)[0] || null, 1)[0];
      await commit({ events: r.events, books: [patchBook(b, patch, t)] });
      if (d.to === "read") S.notice = `Finished: ${effective(b).title}.`;
      return render();
    }
    case "menu": S.menu = S.menu && S.menu.id === d.id ? null : { id: d.id, mode: null, q: "", where: "list" }; S.focusRow = d.id; return render();
    case "menu-mode": S.menu = { ...S.menu, mode: d.mode, q: "" }; render(); document.getElementById("pick-q")?.focus(); return;
    case "menu-close": { const id = S.menu?.id; S.menu = null; S.focusRow = route()[0] === "list" ? id : null; return render(); }
    case "book-req": S.menu = { id: d.id, mode: "req", q: "", where: "book" }; render(); document.getElementById("pick-q")?.focus(); return;
    case "note-ok": S.listNote = null; return render();
    case "move": {
      const bands = O.bandsOf(S.settings);
      const index = { top: 0, soon: bands.next, stacks: bands.next + bands.soon, end: 1e9 }[d.go];
      S.menu = null;
      return moveBook(d.id, index);
    }
    case "pick": {
      const mode = S.menu?.mode;
      S.menu = null;
      if (mode === "after") return moveBook(d.id, restIndex(d.id, d.other) + 1);
      return addPrereq(d.id, d.other);
    }
    case "unreq": S.listNote = null; return commit({ books: [patchBook(b, { prereqs: (b.prereqs || []).filter(x => x !== d.other) }, t)] });
    case "sugg-yes": return d.id && route()[0] === "book" ? addPrereq(d.id, d.other) : acceptSuggestions([{ id: d.id, after: d.other }]);
    case "sugg-no": return commit({ books: [patchBook(b, { prereqsDeclined: [...new Set([...(b.prereqsDeclined || []), d.other])] }, t)] });
    case "sugg-all": return acceptSuggestions(O.suggestions(books(), H.keyOf));
    case "band": {
      const bands = O.bandsOf(S.settings);
      const v = Math.max(d.k === "next" ? 1 : 0, Math.min(200, bands[d.k] + +d.d));
      return commit({ settings: { ...S.settings, bands: { ...bands, [d.k]: v }, updatedAt: t } });
    }
    case "youth-accept": {
      const list = waiting();
      const ids = O.youthOrder(list);
      await store.snapshot("before the reading-youth order", archive());
      S.undoOrder = list.map(x => [x.id, x.queueKey]);
      const patches = O.rekey(list, ids);
      S.notice = "Your waiting list is now in reading-youth order. Move anything by hand as you like.";
      await commit({ books: patches.map(p => patchBook(S.books.get(p.id), { queueKey: p.queueKey }, t)) });
      location.hash = "#/list";
      return;
    }
    case "undo-order": {
      const put = (S.undoOrder || []).filter(([id]) => S.books.has(id)).map(([id, queueKey]) => patchBook(S.books.get(id), { queueKey }, t));
      S.undoOrder = null;
      S.notice = "Your order is back as it was.";
      return commit({ books: put });
    }
    case "helper-retry": return connectHelper();
    case "helper-sync": await H.sync(); S.helper.status = await H.status(); render(); return watchHelper();
    case "helper-estimate": {
      const list = unscored();
      const e = await H.estimate(list.map(b => ({ key: H.keyOf(b) })));
      S.helper.estimate = { ...e, cap: Math.max(0.05, Math.ceil(e.usd * 1.5 * 100) / 100) };
      return render();
    }
    case "helper-estimate-cancel": S.helper.estimate = null; return render();
    case "helper-score": {
      const list = unscored().map(b => { const e = effective(b); return { key: H.keyOf(b), title: e.title, author: e.author, year: e.year, pages: e.pages, isbn13: b.refs?.isbn13 || null }; });
      await H.score(list, S.helper.estimate.cap);
      S.helper.estimate = null;
      S.helper.status = await H.status();
      render();
      return watchHelper();
    }
    case "helper-asks": {
      S.plan = { creates: [], updates: [], asks: S.helper.asks, gone: [], back: [], skipped: {}, unchanged: 0 };
      S.helper.asks = [];
      location.hash = "#/import";
      return;
    }
    case "unpin": return commit({ books: [patchBook(b, { sharePin: null }, t)] });
    case "clear-flag": return commit({ books: [patchBook(b, { flags: { ...b.flags, goneFromGoodreads: null } }, t)] });
    case "reset-field": { const mine = { ...b.mine }; delete mine[d.key]; return commit({ books: [patchBook(b, { mine }, t)] }); }
    case "annot-default": { const mine = { ...b.mine }; delete mine.annotation; return commit({ books: [patchBook(b, { mine }, t)] }); }
    case "ask-delete": S.confirm = `delete:${d.id}`; return render();
    case "delete": S.confirm = null; await commit({ removeBooks: [d.id] }); location.hash = "#/list"; return;
    case "export": {
      backup.download(archive());
      return commit({ settings: { ...S.settings, lastExportAt: t, updatedAt: t } });
    }
    case "auto-connect": {
      try { S.auto.handle = await backup.connectAuto(); } catch { return; }
      S.auto.state = "granted";
      await syncWithAutoFile();
      return render();
    }
    case "auto-reconnect": {
      S.auto.state = await backup.autoPermission(S.auto.handle, true);
      if (S.auto.state === "granted") await syncWithAutoFile();
      return render();
    }
    case "auto-disconnect": await backup.disconnectAuto(); S.auto = { handle: null, state: null, lastWrite: null }; return render();
    case "restore-cancel": S.pendingArchive = null; return render();
    case "restore-merge":
    case "restore-replace": {
      const incoming = migrate(S.pendingArchive);
      await store.snapshot(name === "restore-merge" ? "before merging a copy" : "before replacing with a copy", archive());
      const result = name === "restore-merge" ? mergeArchives(archive(), incoming) : incoming;
      await store.replaceAll(result);
      load(result);
      S.pendingArchive = null;
      S.notice = name === "restore-merge" ? `Merged: ${plural(result.stats.booksAdded, "new book")}, ${plural(result.stats.eventsAdded, "new entry", "new entries")}.` : "Your library now matches the copy.";
      await store.setMeta("lastChangeAt", now());
      scheduleAutoBackup();
      return render();
    }
    case "snapshot-restore": {
      const snap = await store.getSnapshot(d.id);
      if (!snap) return;
      S.pendingArchive = snap.archive;
      return render();
    }
    case "cancel-import": S.plan = null; return render();
    case "apply-import": {
      const p = S.plan;
      const extra = p.asks.filter(a => a.choice && a.choice !== "skip").map(a => resolveAsk(a, a.choice, books(), { now: t }));
      const creates = [...p.creates, ...extra.flatMap(x => x.creates)];
      const updates = [...p.updates, ...extra.flatMap(x => x.updates)];
      await store.snapshot("before a Goodreads import", archive());
      const putBooks = [
        ...creates.map(c => c.book),
        ...updates.map(u => patchBook(S.books.get(u.id), { synced: u.synced, refs: u.refs }, t)),
        ...p.gone.map(id => patchBook(S.books.get(id), { flags: { ...S.books.get(id).flags, goneFromGoodreads: t } }, t)),
        ...p.back.map(id => patchBook(S.books.get(id), { flags: { ...S.books.get(id).flags, goneFromGoodreads: null } }, t)),
      ];
      S.plan = null;
      S.notice = `Imported: ${plural(creates.length, "new book")}, ${plural(updates.length, "update")}.`;
      await commit({ books: putBooks, events: creates.flatMap(c => c.events) });
      location.hash = "#/";
      return;
    }
  }
}

async function submit(form) {
  const t = now();
  const d = form.dataset, f = new FormData(form);
  const b = d.id ? S.books.get(d.id) : null;
  switch (d.form) {
    case "page": {
      const v = f.get("page");
      if (v === "" || isNaN(+v)) return;
      const r = logPage(b, evs(b.id), +v, t);
      if (r) await commit({ events: r.events, books: r.patch ? [patchBook(b, r.patch, t)] : [] });
      return;
    }
    case "search": S.query = f.get("q") || ""; return render();
    case "annotation": return commit({ books: [patchBook(b, { mine: { ...b.mine, annotation: (f.get("annotation") || "").trim() } }, t)] });
    case "details": {
      const mine = { ...b.mine };
      for (const k of ["title", "author", "edition"]) { const v = (f.get(k) || "").trim(); if (v) mine[k] = v; else delete mine[k]; }
      for (const k of ["pages", "year"]) { const v = f.get(k); if (v && !isNaN(+v)) mine[k] = +v; else delete mine[k]; }
      { const v = f.get("difficulty"); if (v && !isNaN(+v)) mine.difficulty = Math.min(10, Math.max(1, +v)); else delete mine.difficulty; }
      { const v = f.get("youth"); if (v !== null && v !== "" && !isNaN(+v)) mine.youth = Math.round(Math.min(100, Math.max(0, +v))); else delete mine.youth; }
      S.notice = "Saved.";
      return commit({ books: [patchBook(b, { mine }, t)] });
    }
    case "add": {
      const last = books().map(x => x.queueKey).filter(Boolean).sort(compareKeys).at(-1) || null;
      const r = manualBook(Object.fromEntries(f), keysBetween(last, null, 1)[0], t);
      await commit({ books: [r.book], events: r.events });
      location.hash = `#/book/${r.book.id}`;
      return;
    }
    case "pin": {
      const v = +f.get("pin");
      if (isNaN(v) || f.get("pin") === "") return;
      return commit({ books: [patchBook(b, { sharePin: Math.max(0, v) }, t)] });
    }
    case "model": {
      const num = (k, lo, hi, dflt) => { const v = +f.get(k); return isNaN(v) || f.get(k) === "" ? dflt : Math.min(hi, Math.max(lo, v)); };
      const conc = f.get("concurrency");
      const settings = { ...S.settings, minutesPerToken: num("tau", 1, 30, 4), model: { ...S.settings.model, v1: num("v1", 100, 800, 300), v10: num("v10", 20, 400, 75) },
        concurrency: conc === "auto" ? "auto" : +conc, readingDays: [0, 1, 2, 3, 4, 5, 6].map(i => (f.get(`day${i}`) ? 1 : 0)), updatedAt: t };
      if (settings.model.v10 >= settings.model.v1) { S.notice = "The hard-text speed must be slower than the easy-text speed."; return render(); }
      S.notice = "Saved.";
      return commit({ settings });
    }
    case "tokens": {
      const n = Math.max(1, Math.min(100, Math.round(+f.get("tokens") || 10)));
      S.notice = "Saved.";
      return commit({ settings: { ...S.settings, dailyTokens: n, updatedAt: t }, events: n !== S.settings.dailyTokens ? [{ id: `e_goal_${Date.now()}`, at: t, type: "goal", dailyTokens: n, source: "app" }] : [] });
    }
  }
}

async function change(el) {
  const kind = el.dataset.change;
  if (kind === "ask") { S.plan.asks[+el.dataset.i].choice = el.value; return; }
  const file = el.files?.[0];
  if (!file) return;
  try {
    if (kind === "csv") {
      const objs = csvObjects(await file.text());
      if (!isGoodreadsExport(objs)) throw new Error("That doesn't look like a Goodreads library export.");
      S.plan = planImport(books(), goodreadsRows(objs), { now: now() });
      S.notice = null;
    }
    if (kind === "archive") {
      const a = await backup.readJsonFile(file);
      const problem = validateArchive(a);
      if (problem) throw new Error(problem);
      S.pendingArchive = a;
    }
  } catch (e) {
    S.notice = e.message;
  }
  el.value = "";
  render();
}

// --- Wiring --------------------------------------------------------------------------

function guard(p) { Promise.resolve(p).catch(e => { console.error(e); S.notice = `Something went wrong: ${e.message}`; render(); }); }

document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  e.preventDefault();
  guard(act(el.dataset.act, el.dataset));
});
document.addEventListener("submit", e => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  guard(submit(form));
});
document.addEventListener("input", e => {
  if (e.target.id === "q") { S.query = e.target.value; render(); }
  if (e.target.id === "pick-q" && S.menu) { S.menu.q = e.target.value; render(); }
});

// Keys on the waiting list (a row has focus)
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && S.menu) { const id = S.menu.id; S.menu = null; S.focusRow = route()[0] === "list" ? id : null; render(); return; }
  const li = e.target.closest?.("li.row");
  if (!li || e.metaKey || e.ctrlKey) return;
  const id = li.dataset.id, rows = [...document.querySelectorAll("li.row")], k = rows.indexOf(li);
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const nb = rows[k + (e.key === "ArrowUp" ? -1 : 1)]?.dataset.id; // one place among the books you can see
    if (nb) guard(moveBook(id, restIndex(id, nb) + (e.key === "ArrowUp" ? 0 : 1)));
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); rows[k + (e.key === "ArrowDown" ? 1 : -1)]?.focus(); return; }
  if (e.key === "Enter") { location.hash = `#/book/${id}`; return; }
  const bands = O.bandsOf(S.settings);
  const go = { t: 0, n: 0, s: bands.next, b: bands.next + bands.soon }[e.key.toLowerCase()];
  if (go !== undefined && !e.altKey) { e.preventDefault(); S.menu = null; guard(moveBook(id, go)); return; }
  if (e.key.toLowerCase() === "m") { e.preventDefault(); S.menu = { id, mode: null, q: "", where: "list" }; S.focusRow = id; render(); }
});

// Dragging: whole rows with a mouse, the ⠿ handle on a touch screen
let dragId = null, dropLine = null, lastDrop = null;
function dropAt(y) {
  const rows = [...document.querySelectorAll("li.row")].filter(r => r.dataset.id !== dragId);
  for (const r of rows) { const box = r.getBoundingClientRect(); if (y < box.top + box.height / 2) return { id: r.dataset.id, el: r, before: true }; }
  return rows.length ? { id: rows.at(-1).dataset.id, el: rows.at(-1), before: false } : null;
}
function showDrop(y) {
  const at = dropAt(y);
  if (!at) return null;
  dropLine ??= Object.assign(document.createElement("li"), { className: "dropline" });
  at.before ? at.el.before(dropLine) : at.el.after(dropLine);
  return at;
}
function endDrag(at) {
  dropLine?.remove(); dropLine = null;
  document.querySelector("li.row.dragging")?.classList.remove("dragging");
  const id = dragId; dragId = null; lastDrop = null;
  if (id && at) guard(moveBook(id, restIndex(id, at.id) + (at.before ? 0 : 1)));
}
document.addEventListener("dragstart", e => {
  const li = e.target.closest?.("li.row");
  if (!li) return;
  dragId = li.dataset.id; li.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId);
});
document.addEventListener("dragover", e => { if (!dragId) return; e.preventDefault(); lastDrop = showDrop(e.clientY); });
document.addEventListener("drop", e => { if (!dragId) return; e.preventDefault(); endDrag(lastDrop); });
document.addEventListener("dragend", () => { if (dragId) endDrag(null); });
document.addEventListener("pointerdown", e => {
  const grip = e.target.closest?.(".grip");
  if (!grip || e.pointerType === "mouse") return;
  e.preventDefault();
  const li = grip.closest("li.row");
  dragId = li.dataset.id; li.classList.add("dragging");
  grip.setPointerCapture(e.pointerId);
  let at = null;
  grip.onpointermove = ev => {
    at = showDrop(ev.clientY);
    if (ev.clientY < 70) window.scrollBy(0, -14);
    if (ev.clientY > innerHeight - 70) window.scrollBy(0, 14);
  };
  grip.onpointerup = grip.onpointercancel = ev => { grip.onpointermove = grip.onpointerup = grip.onpointercancel = null; endDrag(ev.type === "pointerup" ? at : null); };
});
document.addEventListener("change", e => {
  if (e.target.dataset.change) guard(change(e.target));
});
window.addEventListener("hashchange", () => {
  S.confirm = null; S.menu = null; S.listNote = null; render();
  const anchor = location.hash.split("#")[2];
  if (anchor && document.getElementById(anchor)) document.getElementById(anchor).scrollIntoView(); else window.scrollTo(0, 0);
});
window.addEventListener("focus", () => {
  if (S.ready && S.auto.state === "granted") guard(syncWithAutoFile());
  if (S.ready && S.helper.connected) guard(pullFromHelper());
});

export const APP_VERSION = "0.5.0 (Stage 5: ordering)";

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  // When a new version takes over, reload once so you see it straight away.
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register("./sw.js").then(r => r.update()).catch(() => {});
}

window.__antilibrary = S; // for debugging and browser tests
boot();
