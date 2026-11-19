// Tsundoku Tracker — application shell, state and views.
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
import * as G from "./goodreads.js";
import * as L from "./library.js";
import * as Y from "./year.js";
import { eventId } from "./ids.js";
import * as SY from "./sync.js";
import * as GD from "./gdrive.js";
import * as CB from "./calib.js";
import * as LK from "./links.js";
import { GOOGLE_CLIENT_ID } from "./config.js";
import { html, raw, esc, longDate, shortDate, relativeDay, plural } from "./format.js";

const S = {
  books: new Map(), events: [], tombstones: [], settings: null, byBook: new Map(),
  auto: { handle: null, state: null, lastWrite: null }, notice: null, plan: null, planSource: null,
  pendingArchive: null, confirm: null, query: "", ready: false, error: null,
  helper: { connected: false, status: null, estimate: null, asks: [] },
  menu: null, listNote: null, undoOrder: null, focusRow: null,
  bmHref: null, bmInbox: [], paste: false,
  noteFor: null, letterSeen: null, openRow: null, edPanel: null,
  timer: null, stopping: null, prevModel: null, listSort: "custom",
  linkPanel: null, mapSuggest: false,
  sync: { rec: null, state: "off", last: null, error: null, busy: false, again: false },
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
  const countFrom = S.settings.ledgerFrom && (!firstUse || S.settings.ledgerFrom > firstUse) ? S.settings.ledgerFrom : firstUse;
  const led = M.ledger({ earned, events: S.events, settings: S.settings, now: t, firstUse: countFrom });
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
  if (S.sync.rec?.on) { S.sync.dirty = true; scheduleSync(); }
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

/** Chrome can withdraw a file's permission at any time (after a while, or in the background): ask again quietly. */
const lostPermission = e => e && (e.name === "NotAllowedError" || e.name === "SecurityError" || /not allowed/i.test(e.message || ""));

async function writeAutoNow() {
  if (S.auto.state !== "granted") return;
  try {
    await backup.writeAuto(S.auto.handle, archive());
    S.auto.lastWrite = now();
    await store.setMeta("autoLastWrite", S.auto.lastWrite);
  } catch (e) {
    if (lostPermission(e)) S.auto.state = "prompt";
    else { S.auto.state = "error"; S.notice = `The backup file couldn't be saved: ${e.message}`; }
  }
  render();
}

/** Re-read the backup file when the window comes back, if Chrome still allows it. */
async function refreshAutoFile() {
  if (!S.auto.handle || S.auto.state !== "granted") return;
  S.auto.state = await backup.autoPermission(S.auto.handle).catch(() => "prompt");
  if (S.auto.state !== "granted") return render();
  try { await syncWithAutoFile(); }
  catch (e) { if (lostPermission(e)) { S.auto.state = "prompt"; render(); } else throw e; }
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

// --- Sync through Google Drive -----------------------------------------------------------
// rec (kept in IndexedDB): { on: true, access, expiresAt, fileId, rev }. The access token lasts
// about an hour; renewing it is a quick round trip to Google's sign-in page (no screens if
// you're still signed in), done by itself when the app opens, or with one tap mid-session.

const clientId = () => GOOGLE_CLIENT_ID || S.settings?.googleClientId || "";
const appBase = () => location.origin + location.pathname.replace(/[^/]*$/, "");
let syncTimer = null;

// Leaving the app (switching away, locking the phone, closing it): send what's waiting at once,
// in the few seconds the system allows, rather than after the usual short pause.
function flushSync() {
  if (!S.sync.rec?.on || !S.sync.dirty || !tokenGood()) return;
  clearTimeout(syncTimer);
  guard(syncNow());
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") return flushSync();
  if (S.sync.rec?.on && tokenGood()) scheduleSync(300);
});
window.addEventListener("pagehide", flushSync);
setInterval(() => { if (document.visibilityState === "visible" && S.sync.rec?.on && tokenGood()) scheduleSync(0); }, 3 * 60e3);

function scheduleSync(ms = 800) {
  if (!S.sync.rec?.on) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => guard(syncNow()), ms);
}

const tokenGood = () => !!(S.sync.rec?.access && S.sync.rec.expiresAt > Date.now());

/** One round with Drive: bring in the other devices' changes, send ours. */
async function syncNow() {
  if (!S.sync.rec?.on) return;
  if (!tokenGood()) { S.sync.state = "tap"; return render(); }
  if (S.sync.busy) { S.sync.again = true; return; }
  S.sync.busy = true; S.sync.state = "syncing";
  try {
    const drive = GD.driveStore(S.sync.rec.access, { fileId: S.sync.rec.fileId });
    const r = await SY.syncOnce({
      store: drive, local: archive, merge: mergeArchives,
      prepare: a => { const problem = validateArchive(a); if (problem) throw new Error(problem); return migrate(a); },
      accept: async m => {
        const merged = mergeArchives(archive(), m); // anything changed here meanwhile is kept
        if (merged.stats.booksAdded + merged.stats.booksUpdated > 20) await store.snapshot("before bringing in changes from Google Drive", archive());
        await store.replaceAll(merged);
        load(merged);
      },
    });
    S.sync.rec = { ...S.sync.rec, rev: r.rev, fileId: drive.fileId };
    await store.setMeta("gdrive", S.sync.rec);
    S.sync.last = now(); S.sync.state = "on"; S.sync.error = null;
    if (!S.sync.again) S.sync.dirty = false;
    await store.setMeta("gdriveLast", S.sync.last);
  } catch (e) {
    S.sync.state = e instanceof SY.SignedOut ? "tap" : navigator.onLine === false ? "offline" : "error";
    S.sync.error = e.message;
  } finally {
    S.sync.busy = false;
    render();
    if (S.sync.again) { S.sync.again = false; scheduleSync(500); }
  }
}

/** Off to Google's sign-in page and back. silent: no screens (used to renew). */
async function goToGoogle(silent) {
  if (!clientId()) { S.notice = "Google Drive sync isn't set up for this copy of the app yet (see the README)."; return render(); }
  const { url, state } = GD.signInUrl(clientId(), appBase(), { silent, hint: S.sync.rec?.hint || null });
  await store.setMeta("gdrivePending", { state, back: location.hash || "#/", silent, at: Date.now() });
  location.href = url;
}

/** Coming back from Google with #access_token=… (or an error) in the address. */
async function googleReturn() {
  const got = GD.parseReturn(location.hash);
  if (!got) return false;
  const pending = await store.getMeta("gdrivePending");
  await store.setMeta("gdrivePending", null);
  history.replaceState(null, "", appBase() + (pending?.back || "#/"));
  if (!pending || pending.state !== got.state) { S.notice = "That Google sign-in didn't match; try again from Settings."; return true; }
  if (got.error) {
    // Google wants a choice (several accounts signed in, say): the next tap goes the visible way
    if (pending.silent) { S.sync.state = "choose"; await store.setMeta("gdriveSilentFailedAt", Date.now()); }
    else S.notice = got.error === "access_denied" ? "Google Drive access wasn't given." : `Google said: ${got.error}`;
    return true;
  }
  const first = !S.sync.rec?.on;
  S.sync.rec = { ...(S.sync.rec || {}), on: true, access: got.access, expiresAt: got.expiresAt };
  if (!S.sync.rec.hint) S.sync.rec.hint = await GD.whoAmI(got.access);
  await store.setMeta("gdrive", S.sync.rec);
  await store.setMeta("gdriveSilentFailedAt", 0);
  if (first) S.notice = "Connected to Google Drive. This device now syncs; connect your other devices too.";
  return true;
}

function syncWords() {
  const sy = S.sync;
  if (!sy.rec?.on) return null;
  if (sy.state === "syncing") return "Syncing…";
  if (sy.state === "tap") return "Tap to sync";
  if (sy.state === "choose") return "Tap to sync (Google wants you to choose your account)";
  if (sy.state === "offline") return "Offline; will sync when back";
  if (sy.state === "error") return `Sync paused: ${sy.error}`;
  return sy.last ? `Synced ${relativeDay(sy.last).replace(/^today at /, "at ")}` : "Synced";
}

function syncBlock() {
  const sy = S.sync;
  if (!clientId()) return html`<p class="quiet">Google Drive sync isn't set up for this copy of the app. Whoever hosts it creates a Google client ID once (see the README); then everyone connects their own Google account.</p>`;
  if (!sy.rec?.on) return html`
    <p>Keep this library the same on your phone, your Mac and anywhere else. Connect Google Drive on each device: the library is kept as one file in Drive's private app space (it doesn't appear among your files), and every change is merged in, so nothing is lost if two devices change at once.</p>
    <p><button data-act="sync-start">Connect Google Drive</button></p>`;
  return html`
    <p>${syncWords()}. Syncs when you open the app, after each change, and every few minutes. Google's permission lasts about an hour at a time; the app renews it by itself when you open it, or with a tap on <i>Tap to sync</i>.</p>
    <p><button data-act="sync-now">Sync now</button> <button class="link" data-act="sync-stop">Stop syncing on this device</button></p>`;
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
  // Opening the app reads Goodreads again if the shelves are more than three hours old.
  const st = S.helper.status;
  if (st && st.signed_in !== false && !st.job && !st.queued && (!st.synced_at || Date.now() - new Date(st.synced_at) > 3 * 3600e3)) {
    await H.sync().catch(() => {});
    S.helper.status = await H.status().catch(() => st);
  }
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
  // PLAN_RULES: bump when the import rules change, so the shelves are looked at again once
  const PLAN_RULES = 2;
  const rulesChanged = (await store.getMeta("helperPlanRules")) !== PLAN_RULES;
  if (shelf && shelf.synced_at && (rulesChanged || shelf.synced_at !== (await store.getMeta("helperShelvesApplied")))) {
    const plan = planImport(books(), H.incomingFromShelves(shelf), { now: t, source: "goodreads-helper", hasHistory: id => evs(id).some(e => e.source === "app") });
    S.helper.asks = plan.asks;
    const said = await applyPlan(plan, { snapshotOver: 5, label: "before a Goodreads sync" });
    if (said) S.notice = `From Goodreads: ${said}.`;
    await store.setMeta("helperShelvesApplied", shelf.synced_at);
    await store.setMeta("helperPlanRules", PLAN_RULES);
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
  for (const b of books().filter(x => x.mine?.grEdition && x.mine.grEdition.pending)) {
    try { const ed = await H.edition(b.mine.grEdition.id); await commit({ books: [patchBook(b, { mine: { ...b.mine, grEdition: { ...b.mine.grEdition, ...ed, pending: false } } }, now())] }); } catch { /* next time */ }
  }
  const placed = await placeByYouth();
  if (placed.length) S.notice = [S.notice, `Placed by reading-youth: ${placed.map(([id, at]) => `${titleOf(id)} (no. ${at + 1})`).join(", ")}.`].filter(Boolean).join(" ");
  await autoScore().catch(e => console.warn("auto-score", e));
  render();
}

/**
 * Apply an import plan (helper, bookmarklet or CSV): new books, updated facts,
 * flags, and shelf moves made on Goodreads that the app follows. Returns a short
 * summary of what came in, or "" if nothing worth saying.
 */
async function applyPlan(plan, { snapshotOver = 0, label = "before a Goodreads import" } = {}) {
  const t = now(), work = new Map();
  const put = (id, patch) => work.set(id, patchBook(work.get(id) || S.books.get(id), patch, t));
  const extra = [];
  for (const u of plan.updates) {
    put(u.id, { synced: u.synced, refs: u.refs });
    const b = S.books.get(u.id);
    if (u.relink && b && !("pages" in (b.mine || {})) && !b.mine?.grEdition) {
      const cur = currentPage(evs(u.id)), to = mapPage(cur, u.relink.oldPages, u.relink.newPages, u.relink.sameWork);
      if (to != null) extra.push({ id: eventId(), bookId: u.id, at: t, type: "progress", page: to, prevPage: cur, source: "edition" });
    }
  }
  for (const id of plan.gone) put(id, { flags: { ...(work.get(id) || S.books.get(id)).flags, goneFromGoodreads: t } });
  for (const id of plan.back) put(id, { flags: { ...(work.get(id) || S.books.get(id)).flags, goneFromGoodreads: null } });
  const events = [...plan.creates.flatMap(c => c.events), ...extra];
  for (const m of plan.adopt || []) {
    const b = work.get(m.id) || S.books.get(m.id);
    const last = evs(m.id).at(-1)?.at || "";
    const at = m.at && m.at > last ? m.at : t;
    const r = changeStatus(b, evs(m.id), m.to, at);
    if (!r) continue;
    events.push(...r.events.map(e => ({ ...e, source: "goodreads", ...(at === m.at ? { approx: true } : {}) })));
    const patch = { ...r.patch };
    if (m.to === "want" && !b.queueKey) {
      patch.queueKey = keysBetween(waiting().at(-1)?.queueKey || null, null, 1)[0];
      patch.flags = { ...b.flags, placeByYouth: true };
    }
    put(m.id, patch);
  }
  const drop = (plan.merges || []).map(m => m.drop);
  for (const id of drop) work.delete(id);
  const putBooks = [...plan.creates.map(c => c.book), ...work.values()];
  if (!putBooks.length && !drop.length) return "";
  if ((snapshotOver >= 0 && plan.creates.length > snapshotOver) || drop.length) await store.snapshot(label, archive());
  await commit({ books: putBooks, events, removeBooks: drop });
  const moved = (plan.adopt || []).length;
  const eds = plan.updates.filter(u => u.relink).map(u => (u.relink.sameWork ? `${shortTitle(u.relink.oldTitle)} (another edition)` : `${shortTitle(u.relink.oldTitle)} → ${shortTitle(u.relink.newTitle)}`));
  return [plan.creates.length && plural(plan.creates.length, "new book"),
    eds.length && `edition changes followed: ${eds.join(", ")}`,
    moved && `${plural(moved, "book")} moved shelf there, so ${moved === 1 ? "it's" : "they're"} moved here too`,
    plan.gone.length && `${plan.gone.length} no longer on Goodreads`].filter(Boolean).join(", ");
}

/**
 * Waiting books flagged to find their place (new from Goodreads, or a youth figure
 * just changed) move to where their reading-youth fits, once they have one.
 * Returns [id, index] for each book placed.
 */
async function placeByYouth(ids = null) {
  const t = now();
  let list = waiting();
  const todo = ids || list.filter(b => b.flags?.placeByYouth && O.youthOf(b).youth != null).map(b => b.id);
  if (!todo.length) return [];
  const out = [], patched = new Map();
  for (const id of todo) {
    const slot = O.youthSlot(list, id);
    const b = patched.get(id) || S.books.get(id);
    const flags = { ...b.flags }; delete flags.placeByYouth;
    if (slot == null) { if (b.flags?.placeByYouth && O.youthOf(b).anyTime) patched.set(id, patchBook(b, { flags }, t)); continue; }
    const r = O.moveTo(list, id, slot);
    const nb = patchBook(b, { flags, ...(r.ids.indexOf(id) !== list.findIndex(x => x.id === id) ? { queueKey: r.queueKey } : {}) }, t);
    patched.set(id, nb);
    list = list.map(x => (x.id === id ? nb : x)).sort(byQueue);
    out.push([id, list.findIndex(x => x.id === id)]);
  }
  if (patched.size) await commit({ books: [...patched.values()] });
  return out;
}

/**
 * If you've turned it on: new books are scored as they arrive, with a monthly
 * ceiling. Each run is estimated first and stops itself at the agreed limit.
 */
async function autoScore() {
  const a = S.settings.autoScore;
  const st = S.helper.status;
  if (!a?.on || !S.helper.connected || !st?.scoring_ready || st.job || st.queued) return;
  const list = unscored();
  if (!list.length) return;
  const month = now().slice(0, 7);
  const spent = a.month === month ? a.spent || 0 : 0;
  const room = (a.monthCap ?? 0.25) - spent;
  const e = await H.estimate(list.map(b => ({ key: H.keyOf(b) })));
  const cap = Math.ceil(e.usd * 1.5 * 1000 + 5) / 1000;
  if (cap > room) { S.helper.autoHeld = { books: list.length, usd: e.usd, room }; return; }
  S.helper.autoHeld = null;
  await H.score(list.map(scoreRecord), cap);
  await commit({ settings: { ...S.settings, autoScore: { ...a, month, spent: Math.round((spent + cap) * 1000) / 1000 }, updatedAt: now() } });
  S.helper.status = await H.status();
  watchHelper();
}

const scoreRecord = b => { const e = effective(b); return { key: H.keyOf(b), title: e.title, author: e.author, year: e.year, pages: e.pages, isbn13: b.refs?.isbn13 || null }; };

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
          : html`<p><button data-act="helper-estimate">What would scoring ${todo === 1 ? "it" : `the ${todo}`} cost?</button></p>`) : ""}
    ${st.scoring_ready ? autoScoreBlock() : ""}`;
}

function autoScoreBlock() {
  const a = S.settings.autoScore || {}, month = now().slice(0, 7);
  const spent = a.month === month ? a.spent || 0 : 0, cap = a.monthCap ?? 0.25;
  return html`<form class="inline" data-form="autoscore">
      <label><input type="checkbox" name="on" ${a.on ? raw("checked") : ""} data-change="autoscore"> Score new books as they arrive</label>
      <label>at most $<input name="cap" type="number" min="0.05" max="5" step="0.05" value="${cap.toFixed(2)}" inputmode="decimal" style="width:5em"> a month</label>
      <button>Save</button></form>
    <p class="quiet small">About a tenth of a cent a book, so a new book can take its place by reading-youth without you asking.
      ${a.on ? `This month: up to $${spent.toFixed(3)} of $${cap.toFixed(2)} (counted at each run's limit, so the real figure is lower).` : "Off: new books wait at the end of the list until you score them."}
      ${S.helper.autoHeld ? ` Held back: scoring ${plural(S.helper.autoHeld.books, "book")} would pass this month's limit.` : ""}</p>`;
}

/** An import plan that remembers what it was made from, so it can be made again if the library changes meanwhile. */
function makePlan(incoming, source) {
  return { ...planImport(books(), incoming, { now: now(), source }), incoming, source, version: S.version };
}

// --- The bookmarklet ---------------------------------------------------------------------

/** Turn what the bookmarklet read into an import plan to look at (nothing changes yet). */
function takeBookmarklet(payload) {
  S.plan = makePlan(G.fromBookmarklet(payload), "goodreads-bookmarklet");
  S.notice = `From the bookmark: ${plural(payload.books.length, "book")} read on Goodreads.`;
  if (route()[0] !== "import") location.hash = "#/import";
}

let lastBookmarklet = null;
window.addEventListener("message", e => {
  if (e.origin !== G.GR || !e.data || e.data.format !== "antilibrary-goodreads-sync") return;
  try { e.source?.postMessage({ type: "antilibrary-received" }, e.origin); } catch {}
  if (e.data.synced_at === lastBookmarklet) return; // it repeats until we answer
  lastBookmarklet = e.data.synced_at;
  if (!S.ready) { S.bmInbox.push(e.data); return; }
  guard(Promise.resolve().then(() => { takeBookmarklet(e.data); render(); }));
});

async function loadBookmarklet() {
  try {
    const src = await (await fetch("bookmarklet.js", { cache: "no-cache" })).text();
    const app = new URL(".", location.href).href;
    const code = src.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n").replace("__APP__", app);
    S.bmHref = "javascript:" + encodeURIComponent(code);
    if (route()[0] === "import") render();
  } catch { /* offline: the CSV still works */ }
}

// --- Start-up -----------------------------------------------------------------------

async function boot() {
  try {
    let data = await store.loadAll();
    if (!data.settings) {
      data.settings = { ...defaultSettings(now()), updatedAt: "1970-01-01T00:00:00.000Z" }; // any real settings (another device's) win
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
      if (S.auto.state === "granted") await syncWithAutoFile().catch(e => { if (lostPermission(e)) S.auto.state = "prompt"; else S.notice = `Couldn't read the backup file: ${e.message}`; });
    }
    S.letterSeen = await store.getMeta("letterSeen");
    S.timer = (await store.getMeta("timer")) || null;
    S.listSort = (await store.getMeta("listSort")) || "custom";
    S.sync.rec = (await store.getMeta("gdrive")) || null;
    S.sync.last = (await store.getMeta("gdriveLast")) || null;
    if (S.sync.rec?.on) S.sync.state = "on";
    S.ready = true;
    for (const p of S.bmInbox.splice(0)) takeBookmarklet(p);
    loadBookmarklet();
    await googleReturn();
    if (S.sync.rec?.on) {
      // renew by itself on opening (not again within ten minutes of a failed try, to avoid loops)
      const failedAt = (await store.getMeta("gdriveSilentFailedAt")) || 0;
      if (!tokenGood() && document.visibilityState === "visible" && Date.now() - failedAt > 600e3 && navigator.onLine !== false) { goToGoogle(true); return; }
      guard(syncNow());
    }
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
    <a class="brand" href="#/">Tsundoku Tracker</a>
    <span class="tabs">${[item("", "The Desk", "desk"), item("list", "The List", "list"), item("library", "The Library", "library"), item("settings", "Settings", "settings")]}</span>
  </nav>`;
}

function notices() {
  const out = [];
  const inst = installLine();
  if (inst) out.push(inst);
  if (S.notice) out.push(html`<p class="notice">${S.notice} <button class="link" data-act="dismiss">Dismiss</button></p>`);
  if (S.auto.handle && S.auto.state === "prompt") {
    out.push(html`<p class="notice">Your backup file needs permission again. <button class="link" data-act="auto-reconnect">Reconnect it</button></p>`);
  }
  if (S.ready && S.books.size && !S.auto.handle && !S.sync.rec?.on && route()[0] !== "desk") {
    const last = S.settings.lastExportAt;
    if (!last || Date.now() - new Date(last) > 30 * 864e5) {
      out.push(html`<p class="notice quiet">Your library lives only in this browser. <a href="#/settings">Keep a backup</a>.</p>`);
    }
  }
  return out;
}

function pagesToday(bookId) {
  const today = localDayKey(now());
  return evs(bookId).filter(e => e.type === "progress" && e.source === "app" && localDayKey(e.at) === today).reduce((n, e) => n + (e.page - e.prevPage), 0);
}

function lastActivity(bookId) {
  const list = evs(bookId);
  return list.length ? list.at(-1).at : "";
}

function progressRule(page, pages) {
  const pct = pages ? Math.min(100, (page / pages) * 100) : 0;
  return html`<div class="rule" role="img" aria-label="${pages ? Math.round(pct) + "% read" : "page count unknown"}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}

// --- Installing as an app ------------------------------------------------------------------
// Chrome (and Edge, Android) say when the page can be installed; we offer it as a quiet line.
let installEvent = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvent = e; if (S.ready) render(); });
window.addEventListener("appinstalled", () => { installEvent = null; S.notice = "Installed. Tsundoku Tracker now opens as its own app (on a Mac, from Launchpad)."; if (S.ready) render(); });

function installLine() {
  if (!installEvent || isInstalled() || S.installDismissed) return "";
  return html`<p class="notice install">Install Tsundoku Tracker as an app: its own window, in Launchpad and the Dock, working offline.
    <button data-act="install">Install</button> <button class="link" data-act="install-later">Not now</button></p>`;
}

// --- Getting started (new libraries) and How it works ------------------------------------

const isInstalled = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

/** Note a first-run step as done (only while the checklist is in use). */
function gsDone(key) {
  const gs = S.settings.gettingStarted;
  if (!gs || !gs.show || gs[key]) return null;
  return { ...S.settings, gettingStarted: { ...gs, [key]: true }, updatedAt: now() };
}

function gettingStarted() {
  const gs = S.settings.gettingStarted;
  if (!gs || !gs.show || gs.dismissed) return "";
  const steps = [
    { key: "books", done: S.books.size > 0, title: "Bring in your books",
      body: html`From Goodreads (the export file, or a bookmark that reads your shelves), or one at a time by hand. Want to Read becomes your list; Read becomes your history.
        <span class="btns"><a class="button" href="#/import">Import from Goodreads</a> <a class="button quietbtn" href="#/add">Add a book</a></span>` },
    { key: "effort", done: !!gs.effort, title: "Choose your daily effort",
      body: html`Reading is counted in tokens: one token is about ${S.settings.minutesPerToken} minutes of focused reading, whatever the book. A hard page costs more tokens than an easy one, so dates stay honest.
        <form data-form="tokens" class="inline gs-form"><label>Tokens a day <input name="tokens" type="number" min="1" max="100" value="${S.settings.dailyTokens}" inputmode="numeric"></label> <button>Keep it</button>
        <span class="quiet small">${S.settings.dailyTokens} tokens ≈ ${S.settings.dailyTokens * S.settings.minutesPerToken} minutes</span></form>` },
    { key: "backup", done: !!(S.sync.rec?.on || S.auto.handle || S.settings.lastExportAt), title: "Sync or back up",
      body: html`The library lives in this browser. Connect Google Drive to keep it the same on your phone and Mac, or keep a backup file. <a href="#/settings#sync">Set it up</a>` },
    { key: "ordered", done: !!gs.ordered, title: "Put the list in order", need: S.books.size > 0,
      body: html`Next, Soon and The stacks are stretches of one list. Use <i>Move to…</i>, drag a book, or the keys (<kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Alt</kbd>+arrows). A book can be set to read after another. <a href="#/list">The List</a>` },
    { key: "installed", done: !!gs.installed || isInstalled(), title: "Install it",
      body: html`On a Mac in Chrome: <i>⋮ › Cast, save and share › Install page as app</i>, and it appears in Launchpad. On an iPhone in Safari: <i>Share › Add to Home Screen</i>. On Android: <i>⋮ › Install app</i>. It works offline.
        <button class="link" data-act="gs-installed">Done</button>` },
  ].filter(x => x.need !== false);
  const left = steps.filter(x => !x.done).length;
  if (!left) return html`<section class="gs"><p><b>All set.</b> The pile is in order. <a href="#/about">How it works</a> explains the rest. <button class="link" data-act="gs-hide">Hide this</button></p></section>`;
  return html`<section class="gs" aria-label="Getting started">
    <h2 class="sc small">Getting started <span class="quiet">${steps.length - left} of ${steps.length}</span></h2>
    <ol>${steps.map(x => html`<li class="${x.done ? "done" : ""}"><b>${x.title}</b>${x.done ? html` <span class="quiet small">done</span>` : html`<div class="small">${x.body}</div>`}</li>`)}</ol>
    <p class="quiet small">On a Mac and on Goodreads? <a href="#/about#helper">The optional helper</a> keeps your shelves in step by itself. · <button class="link" data-act="gs-hide">Hide this</button></p>
  </section>`;
}

function viewAbout() {
  const p = derived().p;
  return html`
    <div class="dateline sc"><span>Tsundoku Tracker</span><span>How it works</span></div>
    <h1>How it works</h1>
    <section class="about">
      <h2 class="sc small">The pile</h2>
      <p>One ordered list of the books you mean to read. <i>Next</i>, <i>Soon</i> and <i>The stacks</i> are stretches of that list, not separate shelves; you choose how many each holds. The Desk shows what's in hand and the next few.</p>
      <h2 class="sc small">Tokens, difficulty, pages</h2>
      <p>Effort is counted in tokens: one token is about ${S.settings.minutesPerToken} minutes of focused reading. Each book has a difficulty from 1 to 10 (reading effort, not merit), so a page of an easy novel costs about ${M.tokensPerPage(2, p).toFixed(2)} tokens and a page of dense philosophy about ${M.tokensPerPage(9, p).toFixed(2)}. You set tokens a day; the app works out pages a day for each book in hand, and when each will finish.</p>
      <p>When you read more than one book at once, each one's share of the day is learned from what you've actually read over the last fortnight. If you're behind, it says so in words; nothing turns red, and there are no streaks or badges.</p>
      <h2 class="sc small">Logging</h2>
      <p>On the Desk: <i>+1</i>, <i>+2</i>, <i>+5</i> pages, or type the page you reached. Every entry is kept with its time, so the history, the colophons, the weekly letters and the printed year all come from it. <i>Note in the margin</i> keeps a line at the page you're on.</p>
      <h2 class="sc small">Reading-youth</h2>
      <p>Optionally, each book gets a figure from 0 to 100 for when in a reading life it's good to read: ways in early, books that ask more later. It's a suggestion: The List can show your order beside the reading-youth order before anything moves, and your own figure on a book's page always wins.</p>
      <h2 class="sc small">Goodreads</h2>
      <p>Your shelves come in from the export file, from a bookmark you click on goodreads.com, or by themselves through the Mac helper. Goodreads has no way in for apps, so changes go back by hand: <i>For Goodreads</i> on the Desk lists what to change there, with links.</p>
      <h2 class="sc small" id="helper">The Mac helper (optional)</h2>
      <p>A small program on your own Mac that reads your Goodreads shelves through Chrome's existing sign-in, fetches covers and each book's most-liked quote, and (with your own Claude API key) scores difficulty and reading-youth. Scoring is shown with its cost first; a whole library of 180 books costs about ten cents. Setting it up takes a few Terminal commands: see the README.</p>
      <h2 class="sc small">Your data</h2>
      <p>Everything lives in this browser, on this device. Connect Google Drive (Settings) on each device and the library stays the same everywhere: it's one file in Drive's private app space, merged on every change. There's no server of ours; the helper, if you use it, talks only to Goodreads and, for scoring, to the Claude API.</p>
      <h2 class="sc small">The Library</h2>
      <p>A wall label for the pile (how much, how heavy, how long), a short letter each week written from what you logged, a colophon for every finished book, your commonplace book, and the printed year: a year of reading set as a small book to print or keep.</p>
    </section>
    <p><a href="#/">The Desk</a> · <a href="#/settings">Settings</a></p>`;
}

function viewDesk() {
  const reading = books().filter(b => b.status === "reading").sort((a, b) => (derived().fc.get(b.id)?.share || 0) - (derived().fc.get(a.id)?.share || 0) || (lastActivity(b.id) > lastActivity(a.id) ? 1 : -1));
  const empty = !S.books.size;
  return html`
    <div class="dateline sc"><span>${longDate(new Date())}</span><span>The Desk</span></div>
    ${empty ? html`<section class="welcome">
      <h1>Nothing piled up yet</h1>
      <p><i>Tsundoku</i> is the Japanese word for buying books and letting them pile up unread. This keeps the pile in order: one list of the books you mean to read, how much effort each takes, and a quiet record of what you read.</p>
      <p>Your library stays in this browser. Nothing is sent anywhere unless you set up sync or the optional helper. <a href="#/about">How it works</a></p>
    </section>${gettingStarted()}` : html`
    ${gettingStarted()}
    ${todayBlock()}
    ${figures(reading)}
    <h2 class="sc small deskhead"><span>In hand</span>${reading.length ? html`<span>today</span>` : ""}</h2>
    ${reading.length ? html`<ul class="hand">${reading.map(deskRow)}</ul>` : html`<p class="quiet">Nothing in hand. Begin the first book below, or any from <a href="#/list">the list</a>.</p>`}
    ${upNext(reading.length)}
    ${deskFooter()}`}`;
}

/** Today: tokens read against the day's goal, in one number and a bar, and where you stand. */
function todayBlock() {
  const d = derived(), goal = S.settings.dailyTokens;
  const today = d.ledger ? d.ledger.todayTokens : 0;
  const pct = Math.min(100, (today / goal) * 100);
  const left = Math.max(0, goal - today) * S.settings.minutesPerToken;
  const l = d.ledger, mag = l ? Math.abs(l.balance) : 0;
  const stand = !l ? "The record begins with your first entry." : mag < 0.5 * goal ? "On course." : mag < 2 * goal ? `A little ${l.balance > 0 ? "ahead" : "behind"}.` : `About ${Math.round(mag / goal)} days' reading ${l.balance > 0 ? "ahead" : "behind"}.`;
  const shown = Math.round(today * 10) / 10;
  return html`<section class="today" aria-label="Today">
    <div class="big"><span class="n">${shown}</span><small> / ${goal}</small><div class="lbl sc">tokens today</div></div>
    <div><div class="meter" role="img" aria-label="${`${Math.round(pct)}% of today's tokens`}"><i style="${`width:${pct.toFixed(1)}%`}"></i></div>
      <p class="words">${stand} <span class="quiet">${today >= goal ? "Today's reading is done." : `About ${L.duration(left)} left today.`}</span>
        ${l && l.balance < -0.5 * goal ? html` <button class="link small" data-act="ledger-reset">Count afresh from today</button>` : ""}</p></div>
  </section>`;
}

function figures(reading) {
  const d = derived(), year = new Date().getFullYear();
  const readThisYear = S.events.filter(e => e.type === "status" && e.to === "read" && new Date(e.at).getFullYear() === year).length;
  const soonest = reading.map(b => [b, d.fc.get(b.id)]).filter(([, f]) => f && f.finish != null && !f.beyond).sort((a, b) => a[1].finish - b[1].finish)[0];
  const fw = soonest && finishWords(soonest[0].id);
  return html`<div class="figs">
    <div><span class="n">${reading.length}</span><span class="l sc">in hand</span></div>
    <div><a href="#/list"><span class="n">${waiting().length}</span><span class="l sc">waiting</span></a></div>
    <div><a href="#/year"><span class="n">${readThisYear}</span><span class="l sc">read in ${year}</span></a></div>
    <div>${soonest ? html`<a href="#/book/${soonest[0].id}"><span class="n t"><i>${shortTitle(effective(soonest[0]).title)}</i></span><span class="l sc">next to finish${fw ? ` · ${fw.short}` : ""}</span></a>` : html`<span class="n">—</span><span class="l sc">next to finish</span>`}</div>
  </div>`;
}

// --- Timed sessions (pace calibration) -----------------------------------------------------

function clockText(start) {
  const m = Math.floor((Date.now() - new Date(start)) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}
setInterval(() => document.querySelectorAll(".clock[data-start]").forEach(el => { el.textContent = "● " + clockText(el.dataset.start); }), 15000);

function stopForm(b) {
  const len = CB.sessionLength(S.stopping.start, S.stopping.end);
  const page = Math.max(currentPage(evs(b.id)), S.stopping.startPage);
  return html`<form class="moreinfo stopform" data-form="timer-save" data-id="${b.id}">
    <p>${len.capped ? html`That timer ran for over three hours, so it counts as ${CB.MAX_MINUTES} minutes and won't be used to learn your pace.` : html`You read for ${L.duration(len.minutes)}${S.stopping.startPage ? ` from p. ${S.stopping.startPage}` : ""}.`}
      <label>Where did you get to? <input name="page" type="number" min="${S.stopping.startPage}" ${effective(b).pages ? raw(`max="${effective(b).pages}"`) : ""} value="${page}" inputmode="numeric" autofocus></label>
      <button>Save</button> <button type="button" class="link" data-act="timer-discard">Discard this session</button></p></form>`;
}

/** One book in hand: today's pages against its share, the controls, and where it stands. */
function deskRow(b) {
  const e = effective(b), page = currentPage(evs(b.id)), today = Math.max(0, pagesToday(b.id));
  const f = derived().fc.get(b.id) || {};
  const planned = Math.round(today + pagesFromTokens(b.id, f.todayTokens || 0));
  const fw = finishWords(b.id);
  const undo = [...evs(b.id)].reverse().find(x => x.type === "progress" && x.source === "app");
  const undoToday = undo && localDayKey(undo.at) === localDayKey(now());
  const done = e.pages && page >= e.pages;
  const open = S.openRow === b.id;
  const pct = e.pages ? Math.min(100, (page / e.pages) * 100) : 0;
  const tpct = planned ? Math.min(100, (today / planned) * 100) : today ? 100 : 0;
  return html`<li class="entry ${open ? "open" : ""}" data-id="${b.id}">
    ${coverImg(b, "thumb") || raw('<span class="thumb blank"></span>')}
    <span class="who"><a class="t" href="#/book/${b.id}" title="${e.title}"><i>${shortTitle(e.title)}</i></a><span class="a sc">${e.author}</span></span>
    <span class="todaycol ${planned && today >= planned ? "met" : ""}" data-planned="${planned}">${S.timer?.bookId === b.id
      ? html`<span class="clock" data-start="${S.timer.start}">● ${clockText(S.timer.start)}</span><button class="link strong" data-act="timer-stop" data-id="${b.id}">Stop</button>`
      : done
      ? html`<button class="link strong" data-act="status" data-id="${b.id}" data-to="read">Mark as finished</button>`
      : !planned && !today ? html`<span class="rest">nothing due today</span>`
      : html`<b>${today}</b> of ${Math.max(planned, today)} pp<span class="meter"><i style="${`width:${tpct.toFixed(0)}%`}"></i></span>`}</span>
    <span class="btns">
      <button data-act="add" data-id="${b.id}" data-n="1" aria-label="Add one page">+1</button>
      <button data-act="add" data-id="${b.id}" data-n="2" aria-label="Add two pages">+2</button>
      <button data-act="add" data-id="${b.id}" data-n="5" aria-label="Add five pages">+5</button>
      <form class="pageform" data-form="page" data-id="${b.id}"><label class="vh" for="p-${b.id}">Page reached</label>
        <input id="p-${b.id}" name="page" type="number" inputmode="numeric" min="0" ${e.pages ? raw(`max="${e.pages}"`) : ""} placeholder="p." autocomplete="off"></form>
    </span>
    <span class="prog">${page ? `p. ${page}${e.pages ? ` of ${e.pages.toLocaleString("en-GB")}` : ""}` : `not begun${e.pages ? ` · ${e.pages} pages` : ""}`}${fw && !done ? (fw.plain ? ` · ${fw.short}` : ` · finishes ${fw.short}`) : ""}
      ${undoToday ? html` · <button class="link" data-act="undo" data-id="${b.id}">Undo p. ${undo.prevPage} → ${undo.page}</button>` : ""}
      <button class="link more" data-act="row-more" data-id="${b.id}" aria-expanded="${open ? "true" : "false"}">${open ? "less" : "more"}</button>
      ${S.settings.showTimer && !S.timer && !done ? html`<button class="link timego" data-act="timer-start" data-id="${b.id}" title="Time this reading session, so the app learns your pace">▶ time it</button>` : ""}
      <span class="meter"><i style="${`width:${pct.toFixed(1)}%`}"></i></span></span>
    ${S.stopping?.bookId === b.id ? stopForm(b) : ""}
    ${open ? html`<div class="moreinfo">
      ${e.annotation ? html`<p class="q">“${e.annotation}”</p>` : ""}
      ${fw && !fw.plain ? html`<p>At your current pace, finishes ${fw.phrase}.</p>` : fw ? html`<p>${fw.phrase}</p>` : ""}
      ${S.noteFor === b.id ? noteForm(b, page) : ""}
      <p>${S.noteFor !== b.id ? html`<button class="link" data-act="note-open" data-id="${b.id}">Note in the margin</button> · ` : ""}<a href="#/book/${b.id}">Open the book</a>
        · <button class="link" data-act="status" data-id="${b.id}" data-to="paused">Pause</button></p>
    </div>` : ""}
  </li>`;
}

/** A title without its subtitle, for tight places: "Tolerance is a Wasteland". */
const shortTitle = t => (t || "").split(/:\s|\s\(/)[0];

function upNext(inHand) {
  const next = waiting().slice(0, 3);
  if (!next.length) return "";
  return html`<h2 class="sc small deskhead"><span>Up next</span></h2>
    <p class="next">${next.map((b, i) => html`${i ? " · " : ""}<a href="#/book/${b.id}"><i>${shortTitle(effective(b).title)}</i></a>`)}
      ${!inHand ? html` <button class="link" data-act="status" data-id="${next[0].id}" data-to="reading">Begin the first</button>` : ""}
      <a class="all" href="#/list">The whole list →</a></p>`;
}

/** The quiet line at the foot: the week, the letter, Goodreads, sync or backup. */
function deskFooter() {
  const d = derived();
  const wk = L.weekFacts({ books: books(), byBook: S.byBook, p: d.p, start: L.weekStart(new Date()) });
  const bits = [];
  bits.push(html`<span>This week: ${wk.pages ? `${plural(wk.pages, "page")}, about ${L.duration(wk.minutes)}` : "no pages yet"}</span>`);
  const letter = letterLine();
  if (letter) bits.push(letter);
  if (grCount()) bits.push(html`<a href="#/goodreads">${plural(grCount(), "change")} for Goodreads</a>`);
  if (S.sync.rec?.on) bits.push(S.sync.state === "tap" || S.sync.state === "choose" ? html`<button class="link warn" data-act="sync-tap">Tap to sync</button>` : html`<a href="#/settings#sync" class="${S.sync.state === "error" ? "warn" : ""}">${syncWords()}</a>`);
  else if (!S.auto.handle && (!S.settings.lastExportAt || Date.now() - new Date(S.settings.lastExportAt) > 30 * 864e5)) bits.push(html`<a href="#/settings#sync">Only in this browser: sync or back up</a>`);
  return html`<div class="deskfoot">${bits}</div>`;
}

/** The book's line (Goodreads' most-liked quote, or your own note), shown beside it. */
function quoteLine(e, cls) {
  return e.annotation ? html`<span class="${cls}">“${e.annotation}”</span>` : "";
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

// Ways to order The List. "custom" is your own order (the only one you can move books in);
// the others are views that leave it untouched.
const surname = a => { const w = (a || "").replace(/\(.*?\)/g, "").trim().split(/\s+/); return (w.at(-1) || "").toLowerCase(); };
const finishedAt = b => bookDates(evs(b.id)).finished || "";
const SORTS = {
  custom: { label: "Your order" },
  youth: { label: "Reading-youth", key: b => O.youthOf(b).youth ?? 999 },
  difficulty: { label: "Difficulty, lightest first", key: b => M.difficultyOf(b, derived().p).D },
  hardest: { label: "Difficulty, heaviest first", key: b => -M.difficultyOf(b, derived().p).D },
  short: { label: "Length, shortest first", key: b => effective(b).pages || 1e6 },
  long: { label: "Length, longest first", key: b => -(effective(b).pages || 0) },
  title: { label: "Title", key: b => effective(b).title.toLowerCase().replace(/^(the|a|an) /, "") },
  author: { label: "Author", key: b => surname(effective(b).author) + " " + effective(b).title.toLowerCase() },
  published: { label: "First published, oldest first", key: b => effective(b).year ?? 9999 },
  added: { label: "Added, newest first", key: b => -new Date(bookDates(evs(b.id)).added || b.createdAt || 0) },
  finish: { label: "Finishing soonest", key: b => { const f = derived().fc.get(b.id); return f && f.finish != null && !f.beyond ? f.finish : 1e9; } },
};
function sortBy(list, mode) {
  const s = SORTS[mode];
  if (!s || !s.key) return list;
  return list.map(b => [b, s.key(b)]).sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)).map(([b]) => b);
}

function viewList() {
  const q = S.query.trim().toLowerCase();
  const match = b => { if (!q) return true; const e = effective(b); return `${e.title} ${e.author}`.toLowerCase().includes(q); };
  const mode = SORTS[S.listSort] ? S.listSort : "custom";
  const group = (status, sort) => { const l = books().filter(b => b.status === status).sort(sort); return mode === "custom" ? l : sortBy(l, mode); };
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
    <div class="listbar"><form class="search" data-form="search" role="search"><label class="vh" for="q">Find a book</label>
      <input id="q" name="q" type="search" placeholder="Find by title or author" value="${S.query}" autocomplete="off"></form>
      <label class="sortby"><span class="sc small">Order by</span> <select data-change="list-sort">${Object.entries(SORTS).map(([k, v]) => html`<option value="${k}" ${k === mode ? raw("selected") : ""}>${v.label}</option>`)}</select></label></div>
    ${plain(sections[0])}
    ${mode === "custom" ? waitingBlock(match, !!q) : sortedWaiting(match, mode)}
    ${sections.slice(1).map(plain)}
    <p><a href="#/add">Add a book</a> · <a href="#/import">Import from Goodreads</a></p>`;
}

/** The waiting books in another order: a view only, numbered by your own order. */
function sortedWaiting(match, mode) {
  const list = waiting();
  if (!list.length) return "";
  const pos = new Map(list.map((b, i) => [b.id, i + 1]));
  const shown = sortBy(list, mode).filter(match);
  return html`<section class="waitingblock">
    <h2 class="sc small">Waiting <span class="quiet">${list.length}</span></h2>
    <p class="notice quiet small">Shown by ${SORTS[mode].label.toLowerCase()}. Your own order is kept as it was; the number beside each book is its place in it. To move books, choose <button class="link" data-act="sort-custom">Your order</button>.</p>
    ${shown.length ? html`<ol class="shelf">${shown.map(b => listRow(b, pos.get(b.id)))}</ol>` : html`<p class="quiet">None match.</p>`}
  </section>`;
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
      ${quoteLine(e, "q small")}
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

/** Ordering by hand counts as the "put the list in order" step. */
const orderedSettings = () => gsDone("ordered");

async function moveBook(id, index) {
  const r = O.moveTo(waiting(), id, index);
  S.listNote = r.blockedBy
    ? (r.at > index ? html`Placed just after ${ital(r.blockedBy)}, which it reads after.` : html`Placed just before ${ital(r.blockedBy)}, which reads after it.`)
    : null;
  S.focusRow = id;
  const b = S.books.get(id);
  const cur = waiting().findIndex(x => x.id === id);
  if (r.at === cur) return render();
  await commit({ books: [patchBook(b, { queueKey: r.queueKey }, now())], settings: orderedSettings() });
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
  await commit({ books: [nb], settings: orderedSettings() });
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
  await commit({ books: changed, settings: orderedSettings() });
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

// --- For Goodreads: changes to make there by hand -------------------------------------------

const grItems = () => G.changesForGoodreads(books());
const grCount = () => grItems().length;
const grItem = b => grItems().find(x => x.id === b.id) || null;

function grWords(b, x) {
  const fin = bookDates(evs(b.id)).finished, began = bookDates(evs(b.id)).started;
  if (x.kind === "off") return `Set aside here: take it off ${G.SHELF_NAME[x.from]} there (or put it on a did-not-finish shelf, if you keep one).`;
  if (x.kind === "missing") return `Not on Goodreads. Add it to ${G.SHELF_NAME[x.to]} if you want it there.`;
  if (x.kind === "edition") { const ge = b.mine.grEdition; return `Switch to the edition you chose (${[ge.binding, ge.publisher, ge.pages ? `${ge.pages} pages` : null].filter(Boolean).join(", ")}): open it on Goodreads and choose “Switch to this edition”. Your shelf, dates and review move with it.`; }
  const when = x.to === "read" && fin ? `, finished ${shortDate(fin)}` : x.to === "currently-reading" && began ? `, begun ${shortDate(began)}` : "";
  return `Put it on ${G.SHELF_NAME[x.to]}${when}${x.from ? ` (it's on ${G.SHELF_NAME[x.from]} there)` : ""}.${x.from === "read" ? " Moving a book off Read removes its read date there." : ""}`;
}

function viewGoodreads() {
  const items = grItems();
  const groups = [["shelf", "Change the shelf"], ["edition", "Switch edition"], ["off", "Set aside here"], ["missing", "Not on Goodreads"]];
  const link = (b, x) => (x.kind === "missing" ? G.searchUrl(effective(b).title, effective(b).author) : x.kind === "edition" ? G.editionUrl(x.to) : G.bookUrl(b));
  return html`
    <div class="dateline sc"><span>${plural(items.length, "change")}</span><span>For Goodreads</span></div>
    <h1>For Goodreads</h1>
    <p>Goodreads doesn't let apps change your shelves, so these are for you to do there. Each link opens the book; the next read of your shelves confirms the change and takes it off this list. <i>Done</i> hides one now.</p>
    <p class="quiet small">On Goodreads a book sits on only one of Want to Read, Currently Reading and Read (and any exclusive shelf of your own), so putting it on one takes it off the others. Your review stays.</p>
    ${items.length ? groups.map(([k, name]) => {
      const list = items.filter(x => x.kind === k);
      return list.length ? html`<section><h2 class="sc small">${name} <span class="quiet">${list.length}</span></h2>
        <ul class="grlist">${list.map(x => { const b = S.books.get(x.id); return html`<li>
          <a href="#/book/${b.id}"><i>${effective(b).title}</i></a> <span class="quiet">${effective(b).author}</span><br>
          <span class="small">${grWords(b, x)}</span>
          <span class="btns"><a class="button quietbtn" href="${link(b, x)}" target="_blank" rel="noopener">${x.kind === "missing" ? "Find it" : "Open"} on Goodreads</a>
            ${x.kind === "edition" && b.refs?.goodreadsWorkId ? html`<a class="small" href="${G.editionsUrl(b.refs.goodreadsWorkId)}" target="_blank" rel="noopener">All editions</a>` : ""}
            <button class="link" data-act="gr-done" data-id="${b.id}">Done</button></span></li>`; })}</ul></section>` : "";
    }) : html`<p class="quiet">Nothing to change: Goodreads matches the app.</p>`}
    ${S.helper.connected ? html`<p><button data-act="helper-sync">Read Goodreads now</button> <span class="quiet small">to confirm what you've changed.</span></p>` : ""}`;
}

// --- The Library: wall label, shelf letters, commonplace book, colophons, marginalia ------------

const italH = t => `<i>${t}</i>`;

function noteForm(b, page) {
  return html`<form class="note" data-form="note" data-id="${b.id}">
    <label class="vh" for="note-${b.id}">A note in the margin</label>
    <input id="note-${b.id}" name="text" maxlength="300" placeholder="A note in the margin${page ? `, at p. ${page}` : ""}" autocomplete="off">
    <button>Keep</button> <button type="button" class="link" data-act="note-close">Cancel</button></form>`;
}

function colophonBlock(b) {
  const c = L.colophon(b, evs(b.id), derived().p);
  const lines = L.colophonText(c, { ital: italH, esc });
  return html`<section class="colophon-page" aria-label="Colophon"><p class="sc small">Colophon</p>
    <p class="t"><i>${c.title}</i></p><p class="a sc">${c.author}</p>
    ${lines.map(l => html`<p>${raw(l)}</p>`)}</section>`;
}

function wallLabelBlock() {
  const list = waiting();
  if (!list.length) return html`<p class="quiet">Nothing waiting.</p>`;
  const d = derived(), w = L.wallLabel(list, O.bandsOf(S.settings), d.p), a = w.all;
  const last = list.map(b => d.fc.get(b.id)).filter(Boolean);
  const beyond = last.some(f => f.beyond), far = Math.max(0, ...last.map(f => f.finish ?? 0));
  const horizon = beyond ? "more than twenty years at your present pace"
    : far ? `at your present pace, the list as it stands runs to ${L.monthPhrase(new Date(Date.now() + far * 864e5), new Date())}` : "no forecast yet";
  const peak = Math.max(1, ...a.hist);
  const row = (name, m) => html`<tr><th scope="row">${name}</th><td>${m.count}</td><td>${m.pages.toLocaleString("en-GB")}</td><td>${Math.round(m.tokens).toLocaleString("en-GB")}</td><td>${m.mean == null ? "—" : (Math.round(m.mean * 10) / 10).toFixed(1)}</td></tr>`;
  return html`<figure class="wall-label">
    <p class="sc">The waiting list</p>
    <p class="maker">${plural(a.count, "volume")} · ${longDate(new Date())}</p>
    <dl class="tomb">
      <dt>Extent</dt><dd>${a.pages.toLocaleString("en-GB")} pages${a.unknown ? ` (and ${a.unknown} without a page count)` : ""}; about ${Math.round(a.tokens).toLocaleString("en-GB")} tokens, some ${Math.round(a.hours).toLocaleString("en-GB")} hours of reading</dd>
      <dt>Weight</dt><dd>median difficulty ${(Math.round(a.median * 10) / 10).toFixed(1)} · ${a.weights.light} light, ${a.weights.middling} middling, ${a.weights.heavy} heavy</dd>
      <dt>Horizon</dt><dd>${horizon}</dd>
    </dl>
    <div class="hist" role="img" aria-label="${`Books by difficulty, 1 to 10: ${a.hist.join(", ")}`}">${a.hist.map((n, i) => html`<span title="${`difficulty ${i + 1}: ${n}`}"><i style="${`height:${((n / peak) * 100).toFixed(0)}%`}"></i><b>${i + 1}</b></span>`)}</div>
    ${w.compare ? html`<p>${w.compare}</p>` : ""}
    <table class="stretches"><thead><tr><th></th><th>Books</th><th>Pages</th><th>Tokens</th><th>Difficulty</th></tr></thead>
      <tbody>${row("Next", w.parts.next)}${row("Soon", w.parts.soon)}${row("The stacks", w.parts.stacks)}</tbody></table>
    <figcaption class="quiet small">Difficulty is reading effort, not merit. Tokens at ${S.settings.minutesPerToken} minutes each.</figcaption>
  </figure>`;
}

/** The latest week's outlook: where the books in hand are heading, and what waits next. */
function outlook(facts) {
  const d = derived(), t = new Date();
  const order = new Map(facts.reading.map((r, i) => [r.id, i]));
  const inHand = books().filter(b => b.status === "reading").sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99)).map(b => {
    const f = d.fc.get(b.id);
    return { title: effective(b).title, page: currentPage(evs(b.id)), finishAt: f && f.finish != null && !f.beyond ? new Date(+t + f.finish * 864e5).toISOString() : null };
  });
  return { inHand, next: waiting()[0] ? effective(waiting()[0]).title : null, now: t.toISOString() };
}

function letters() {
  const d = derived(), t = new Date(), thisWeek = +L.weekStart(t);
  return L.letterWeeks(S.events, t).map(start => {
    const f = L.weekFacts({ books: books(), byBook: S.byBook, p: d.p, start });
    const current = +start === thisWeek;
    if (!current && !f.reading.length && !f.finished.length && !f.begun.length && !f.aside.length && !f.notes.length) return null;
    return { start, current, f, text: L.shelfLetter(f, { outlook: current ? outlook(f) : null, ital: italH, esc }) };
  }).filter(Boolean);
}

function letterBlock(l) {
  const f = l.f;
  return html`<article class="letter">
    <p class="dateline sc"><span>${l.current ? "This week, so far" : `The week of ${shortDate(l.start)}`}</span></p>
    ${l.text.map(x => html`<p>${raw(x)}</p>`)}
    ${f.pages ? html`<p class="quiet small">${plural(f.pages, "page")} · about ${L.duration(f.minutes)} · ${plural(f.days, "reading day")}</p>` : ""}
  </article>`;
}

/** On the Desk: a quiet line when last week's letter hasn't been read. */
function letterLine() {
  const last = +L.weekStart(new Date()) - 7 * 864e5;
  if (S.letterSeen && +new Date(S.letterSeen) >= last) return "";
  const had = S.events.some(e => e.source === "app" && e.at >= new Date(last).toISOString() && e.at < new Date(last + 7 * 864e5).toISOString());
  return had ? html`<a href="#/library#letters">Last week's letter</a>` : "";
}
function markLetterSeen() {
  const last = new Date(+L.weekStart(new Date()) - 7 * 864e5).toISOString();
  if (S.letterSeen && S.letterSeen >= last) return;
  S.letterSeen = last;
  store.setMeta("letterSeen", last).catch(() => {});
}

// --- The printed year -------------------------------------------------------------------

function yearDoc(year, links = true) {
  const y = Y.yearData({ books: books(), byBook: S.byBook, p: derived().p, year });
  return { y, html: Y.yearHtml(y, { reader: S.settings.readerName || "", links }) };
}

function viewYear(arg) {
  const years = Y.readingYears(S.events);
  const year = +arg || years.find(y => Y.yearData({ books: books(), byBook: S.byBook, p: derived().p, year: y }).finished.length) || years[0];
  const { html: doc } = yearDoc(year);
  return html`
    <div class="dateline sc"><span>${year}</span><a href="#/library">The Library</a></div>
    <div class="yeartools">
      <label>Year <select data-change="year">${years.map(y => html`<option value="${y}" ${y === year ? raw("selected") : ""}>${y}</option>`)}</select></label>
      <form data-form="reader" class="inline"><label>Name on the title page <input name="reader" value="${S.settings.readerName || ""}" placeholder="optional" maxlength="60" autocomplete="off"></label> <button>Save</button></form>
      <button data-act="year-print" data-year="${year}">Print or save as PDF</button>
      <button class="quietbtn" data-act="year-download" data-year="${year}">Download as one page</button>
    </div>
    <p class="quiet small yeartools">Printing sets it as a small book (A5 pages, numbered). In the print dialog choose <i>Save as PDF</i> to keep it as a file; turn off headers and footers for a clean page.</p>
    ${raw(doc)}`;
}

/** The year as one self-contained HTML file: its own styles and the typeface inside it. */
async function downloadYear(year) {
  const { html: doc } = yearDoc(year, false);
  const css = await (await fetch("css/year.css")).text();
  const font = async (file, style) => {
    const buf = new Uint8Array(await (await fetch(`fonts/${file}`)).arrayBuffer());
    let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return `@font-face{font-family:'Source Serif 4';font-style:${style};font-weight:200 900;src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2');}`;
  };
  const fonts = (await font("source-serif-4-normal-latin.woff2", "normal")) + (await font("source-serif-4-italic-latin.woff2", "italic"));
  const name = S.settings.readerName ? `The Reading Year of ${S.settings.readerName}` : "A Reading Year";
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — ${year}</title>
<style>${fonts}
:root { --ink: #1E1B18; --quiet: #6B645B; --rule: #D6CDBE; --accent: #7A1F1F; --paper: #F4EFE6; }
@media (prefers-color-scheme: dark) { :root { --ink: #ECE5D8; --quiet: #A39A8C; --rule: #3A352E; --accent: #CF7A70; --paper: #1B1916; } }
html { background: var(--paper); } body { margin: 0; padding: 24px 16px 64px; }
${css}</style></head>
<body>${doc}</body></html>`;
  const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${name} ${year}.html` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  S.notice = `Saved “${name} ${year}.html” to your downloads: one page, readable offline, with its typeface inside.`;
  render();
}

function viewLibrary() {
  const ls = letters();
  const years = L.commonplace(books(), S.byBook);
  const finished = books().filter(b => b.status === "read").length;
  return html`
    <div class="dateline sc"><span>${plural(S.books.size, "volume")}</span><span>The Library</span></div>
    <h1>The Library</h1>
    <p><a class="button quietbtn" href="#/year">The printed year</a> <span class="quiet small">a reading year set as a small book, to print, save as PDF, or keep as one page</span></p>
    <section><h2 class="sc small">Wall label</h2>${wallLabelBlock()}</section>
    <section id="letters"><h2 class="sc small">Shelf letters</h2>
      <p class="quiet small">Written each week from what you logged: no AI, nothing sent anywhere.</p>
      ${ls.slice(0, 2).map(letterBlock)}
      ${ls.length > 2 ? html`<details class="older"><summary>Earlier letters (${ls.length - 2})</summary>${ls.slice(2).map(letterBlock)}</details>` : ""}</section>
    <section><h2 class="sc small">Connections</h2>
      <p>${(() => { const n = allLinks().length; return n ? html`${plural(n, "connection")} between your books. <a href="#/map">The map</a>` : html`Link books that answer, build on or read well with each other, from any book's page, and they gather on <a href="#/map">the map</a>.`; })()}</p></section>
    <section><h2 class="sc small">Commonplace book</h2>
      ${years.length ? years.map(([y, items]) => html`<h3 class="sc small">${y}</h3><ul class="commonplace">${items.map(it => html`<li>
        <blockquote>${it.text}</blockquote><p class="small">— <a href="#/book/${it.id}"><i>${it.title}</i></a>${it.author ? `, ${it.author}` : ""}${it.kind === "note" ? `${it.page ? `, p. ${it.page}` : ""} · ${shortDate(it.at)}` : ""}</p></li>`)}</ul>`)
        : html`<p class="quiet">Your own lines (a book's annotation, once you've written it yourself) and your notes in the margin gather here, by year.</p>`}</section>
    <section><h2 class="sc small">Colophons</h2>
      <p>${finished ? html`Each finished or set-aside book carries its colophon on its page. ${raw(books().filter(b => b.status === "read" || b.status === "abandoned").sort((a, b) => ((L.colophon(b, evs(b.id), derived().p).finished || "") > (L.colophon(a, evs(a.id), derived().p).finished || "") ? 1 : -1)).slice(0, 8).map(b => `<a href="#/book/${esc(b.id)}"><i>${esc(effective(b).title)}</i></a>`).join(" · "))}` : "Finish a book and its colophon appears on its page."}</p></section>`;
}

// --- Connections -------------------------------------------------------------------------------

const allLinks = () => LK.linksOf(S.events, new Set(S.books.keys()));

function connectionsBlock(b) {
  const mine = LK.linksFor(allLinks(), b.id);
  const sugg = LK.suggestedLinks(books(), allLinks(), H.keyOf).filter(x => x.from === b.id || x.to === b.id);
  const P = S.linkPanel && S.linkPanel.id === b.id ? S.linkPanel : null;
  return html`<h2 class="sc small">Connections</h2>
    ${mine.length ? html`<ul class="sugg links">${mine.map(x => html`<li><span class="kind k-${x.link.kind}"></span>${x.phrase.replace(/^./, c => c.toUpperCase())} <a href="#/book/${x.other}">${ital(x.other)}</a>${x.link.note ? html` <span class="quiet small">${x.link.note}</span>` : ""}
      <button class="link small" data-act="link-del" data-ev="${x.link.id}">Remove</button></li>`)}</ul>` : ""}
    ${sugg.map(x => { const other = x.from === b.id ? x.to : x.from; return html`<p class="notice quiet small">Suggested${x.source === "ai" ? " by the reading-youth pass" : " from your reading order"}: ${x.from === b.id ? html`this builds on ${ital(other)}` : html`${ital(other)} builds on this`}.
      <button class="link" data-act="link-accept" data-from="${x.from}" data-to="${x.to}">Connect</button> · <button class="link" data-act="link-ignore" data-from="${x.from}" data-to="${x.to}">Ignore</button></p>`; })}
    ${P ? linkPanel(b, P) : html`<p><button class="link" data-act="link-open" data-id="${b.id}">Connect to another book…</button>${allLinks().length ? html` · <a href="#/map">The map</a>` : ""}</p>`}`;
}

function linkPanel(b, P) {
  const q = (P.q || "").trim().toLowerCase();
  const hits = q ? books().filter(x => x.id !== b.id && `${effective(x).title} ${effective(x).author}`.toLowerCase().includes(q)).slice(0, 20) : [];
  return html`<div class="movemenu pick linkpanel">
    <p class="linkrow"><span><i>${shortTitle(effective(b).title)}</i></span>
      <select id="link-kind" data-change="link-kind">${LK.KIND_ORDER.map(k => html`<option value="${k}" ${k === P.kind ? raw("selected") : ""}>${LK.KINDS[k].out}</option>`)}</select></p>
    <label class="vh" for="link-q">Find the other book</label>
    <input id="link-q" type="search" value="${P.q || ""}" placeholder="Find the other book" autocomplete="off">
    <label class="vh" for="link-note">A note or source (optional)</label>
    <input id="link-note" value="${P.note || ""}" placeholder="A note or source (optional), e.g. Baldwin's essay on Malcolm X" maxlength="200" autocomplete="off">
    ${hits.length ? html`<ol>${hits.map(x => html`<li><button data-act="link-pick" data-id="${b.id}" data-other="${x.id}"><i>${effective(x).title}</i> <span class="quiet">${effective(x).author} · ${STATUS_LABEL[x.status].toLowerCase()}</span></button></li>`)}</ol>` : q ? html`<p class="quiet small">No book matches.</p>` : ""}
    <button class="link" data-act="link-close">Cancel</button>
  </div>`;
}

async function addLink(from, to, kind, note = "") {
  const t = now();
  S.notice = `Connected: ${effective(S.books.get(from)).title} ${LK.KINDS[kind].out} ${effective(S.books.get(to)).title}.`;
  return commit({ events: [{ id: eventId(), bookId: from, other: to, type: "link", kind, note: note.trim(), at: t, source: "app" }] });
}

const KIND_COLOUR = k => `var(--k-${k})`;

function viewMap() {
  const links = allLinks();
  const sugg = S.mapSuggest ? LK.suggestedLinks(books(), links, H.keyOf) : [];
  const ids = [...new Set([...links, ...sugg].flatMap(l => [l.from, l.to]))];
  const W = 800;
  const packed = LK.packedLayout(ids, [...links, ...sugg], { width: W });
  const pos = packed.pos, Hh = Math.max(120, Math.round(packed.height + 24));
  const P = id => pos.get(id);
  const edge = (l, dashed) => {
    const a = P(l.from), b = P(l.to), dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const x2 = b.x - (dx / d) * 9, y2 = b.y - (dy / d) * 9;
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="${dashed ? "edge sugg" : `edge k-${l.kind}`}"${!dashed && LK.KINDS[l.kind].directed ? ` marker-end="url(#m-${l.kind})"` : ""}><title>${esc(effective(S.books.get(l.from)).title)} ${esc(LK.KINDS[l.kind].out)} ${esc(effective(S.books.get(l.to)).title)}${l.note ? " — " + esc(l.note) : ""}</title></line>`;
  };
  const node = id => {
    const b = S.books.get(id), p = P(id), right = p.x < W - 150;
    const cls = b.status === "read" ? "read" : b.status === "reading" ? "reading" : "waiting";
    return `<a href="#/book/${esc(id)}" class="node ${cls}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5.5"/><text x="${(p.x + (right ? 9 : -9)).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="${right ? "start" : "end"}">${esc(shortTitle(effective(b).title))}</text></a>`;
  };
  const markers = LK.KIND_ORDER.filter(k => LK.KINDS[k].directed).map(k => `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="k-${k}"/></marker>`).join("");
  const nSugg = LK.suggestedLinks(books(), links, H.keyOf).length;
  return html`
    <div class="dateline sc"><span>${plural(links.length, "connection")}</span><a href="#/library">The Library</a></div>
    <h1>Connections</h1>
    <p class="quiet">How your books relate, only as you've said. Link books from any book's page; ${raw('<i>builds on</i>, <i>answers</i> and <i>influenced by</i>')} point from the later book to the earlier.</p>
    <p class="small"><label><input type="checkbox" data-change="map-suggest" ${S.mapSuggest ? raw("checked") : ""}> Show suggestions</label> <span class="quiet">(${plural(nSugg, "read-after pair")}, dotted; connect or ignore them on each book's page or below)</span></p>
    ${ids.length ? html`<figure class="map"><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${`A map of ${ids.length} books and their connections`}"><defs>${raw(markers)}</defs>
        ${raw(sugg.map(l => edge(l, true)).join("") + links.map(l => edge(l, false)).join("") + ids.map(node).join(""))}</svg>
      <figcaption class="legend small">${LK.KIND_ORDER.map(k => html`<span><span class="kind k-${k}"></span>${LK.KINDS[k].label}</span>`)}
        <span><span class="dot reading"></span>in hand</span><span><span class="dot read"></span>read</span><span><span class="dot waiting"></span>waiting</span></figcaption></figure>`
      : html`<p class="notice quiet">No connections yet. Open any book and choose <i>Connect to another book…</i>${nSugg ? html`, or tick <i>Show suggestions</i> to see the ${nSugg} read-after pairs` : ""}.</p>`}
    ${S.mapSuggest && sugg.length ? html`<h2 class="sc small">Suggestions <span class="quiet">${sugg.length}</span></h2><ul class="suggest-list">${sugg.slice(0, 80).map(x => html`<li>
        <span class="pair"><a href="#/book/${x.from}"><i>${shortTitle(titleOf(x.from))}</i></a> <span class="quiet">builds on</span> <a href="#/book/${x.to}"><i>${shortTitle(titleOf(x.to))}</i></a>${x.source === "yours" ? html` <span class="quiet small">(your reading order)</span>` : ""}</span>
        <span class="acts"><button class="link" data-act="link-accept" data-from="${x.from}" data-to="${x.to}">Connect</button> · <button class="link" data-act="link-ignore" data-from="${x.from}" data-to="${x.to}">Ignore</button></span></li>`)}</ul>
      <p class="quiet small">Unmarked ones come from the reading-youth pass.</p>` : ""}
    <p class="quiet small">Links are yours: the app never makes them up. Suggestions come only from read-after orders, yours or the reading-youth pass's, and only become links when you connect them.</p>`;
}

const STATUS_LABEL = { want: "Waiting", reading: "In hand", paused: "Paused", read: "Read", abandoned: "Set aside" };

function describe(e) {
  if (e.type === "progress" && e.source === "edition") return `Edition changed: p. ${e.prevPage} → ${e.page}`;
  if (e.type === "progress" && e.source === "place") return `Place set: p. ${e.prevPage} → ${e.page}`;
  if (e.type === "progress") return e.prevPage === 0 && e.source !== "app" ? `p. ${e.page}` : `p. ${e.prevPage} → ${e.page}`;
  if (e.type === "status") {
    if (e.from == null) return "Added to the list";
    if (e.to === "reading") return e.from === "paused" ? "Resumed" : e.from === "read" ? "Begun again" : "Begun";
    return { want: "Returned to the list", paused: "Paused", read: "Finished", abandoned: "Set aside" }[e.to];
  }
  if (e.type === "link") return html`Connected: ${LK.KINDS[e.kind]?.out || e.kind} ${S.books.has(e.other) ? ital(e.other) : "a book no longer here"}${e.note ? ` (${e.note})` : ""}`;
  if (e.type === "session") return `Timed: ${L.duration(e.minutes)}, p. ${e.fromPage} → ${e.toPage}${e.capped ? " (timer left running)" : ""}`;
  if (e.type === "note") return `“${e.text}”${e.page ? ` (p. ${e.page})` : ""}`;
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
        <dt>Edition</dt><dd>${[e.edition, e.publisher].filter(Boolean).join(", ") || "—"}${b.mine?.grEdition && !b.mine.grEdition.coverOnly ? raw(' <span class="quiet">(your choice)</span>') : ""}<br>${editionPanel(b)}</dd>
        <dt>Pages</dt><dd>${e.pages ?? "unknown"}${"pages" in m ? raw(' <span class="quiet">(your count)</span>') : ""}</dd>
        <dt>Progress</dt><dd>${page ? `page ${page}` : "not begun"}${e.pages && page ? ` · ${Math.round((page / e.pages) * 100)}%` : ""}</dd>
        <dt>Difficulty</dt><dd>${diffText(b)}</dd>
        <dt>Reading-youth</dt><dd>${youthText(b)}${O.youthOf(b).note && O.youthOf(b).source === "ai" ? raw(`<br><span class="quiet small">${esc(O.youthOf(b).note)}</span>`) : ""}</dd>
        <dt>Pace</dt><dd>${paceText(b)}</dd>
        ${(b.status === "reading" || b.status === "want") && finishWords(id) ? html`<dt>${b.status === "want" ? "Expected" : "Finishes"}</dt><dd>${b.status === "want" && startWords(id) ? `begins ${startWords(id).phrase}; ` : ""}${finishWords(id).plain ? finishWords(id).phrase : `finishes ${finishWords(id).phrase}`}</dd>` : ""}
        <dt>Added</dt><dd>${shortDate(d.added) || "—"}</dd>
        ${d.started ? html`<dt>Begun</dt><dd>${shortDate(d.started)}</dd>` : ""}
        ${d.finished ? html`<dt>Finished</dt><dd>${shortDate(d.finished)}</dd>` : ""}
        ${b.refs?.goodreadsBookId ? html`<dt>Goodreads</dt><dd>${s.shelf ? `${G.SHELF_NAME[s.shelf] || s.shelf} · ` : s.source?.startsWith("goodreads") ? "on none of your three shelves · " : ""}<a href="${G.bookUrl(b)}" target="_blank" rel="noopener">open on Goodreads</a>
          ${grItem(b) ? html`<br><span class="small">${grWords(b, grItem(b))} <button class="link" data-act="gr-done" data-id="${id}">Done</button></span>` : ""}</dd>` : ""}
      </dl>
      <p class="actions">${actions.map(([to, label]) => html`<button data-act="status" data-id="${id}" data-to="${to}">${label}</button>`)}</p>
      ${["want", "reading", "paused"].includes(b.status) ? html`<form class="inline placeform" data-form="place" data-id="${id}">
        <label>Where you are <input name="page" type="number" min="0" ${e.pages ? raw(`max="${e.pages}"`) : ""} inputmode="numeric" value="${page || ""}" placeholder="page"></label>
        <button>Set my place</button>
        <span class="quiet small">For pages read before, or elsewhere: it moves your place without counting as today's reading.</span></form>` : ""}
      ${whyBlock(b)}
      ${b.flags?.goneFromGoodreads ? html`<p class="notice quiet">This book is no longer on your Goodreads Want to Read or Currently Reading shelves (noticed ${shortDate(b.flags.goneFromGoodreads)}). It stays here until you decide.
        <button class="link" data-act="clear-flag" data-id="${id}">Keep it</button></p>` : ""}

      ${b.status === "reading" ? shareBlock(b) : ""}
      ${S.listNote && S.menu === null && route()[0] === "book" ? html`<p class="notice">${S.listNote} <button class="link" data-act="note-ok">OK</button></p>` : ""}
      ${afterBlock(b)}
      ${connectionsBlock(b)}
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

      ${["read", "abandoned"].includes(b.status) ? colophonBlock(b) : ""}
      <h2 class="sc small">History</h2>
      ${S.noteFor === id ? noteForm(b, page) : html`<p><button class="link" data-act="note-open" data-id="${id}">Note in the margin${page ? ` at p. ${page}` : ""}</button></p>`}
      <ol class="history">${[...list].reverse().map(x => html`<li class="${x.type === "note" ? "note" : ""}"><span class="d">${x.approx ? shortDate(x.at) : relativeDay(x.at)}</span><span>${describe(x)}${x.approx ? raw(' <span class="quiet">(from Goodreads)</span>') : ""}${x.type === "note" ? html` <button class="link small" data-act="note-del" data-id="${id}" data-ev="${x.id}">Remove</button>` : ""}</span></li>`)}</ol>

      <p class="danger">${S.confirm === `delete:${id}`
        ? html`Remove <i>${e.title}</i> and its history from this library? This can't be undone, except from a backup.
           <button data-act="delete" data-id="${id}">Remove it</button> <button class="link" data-act="cancel">Keep it</button>`
        : html`<button class="link" data-act="ask-delete" data-id="${id}">Remove from the library…</button>`}</p>
    </article>`;
}

// --- Changing edition (or just the cover) -------------------------------------------------

/** Where your place goes when the page count changes: the same share of the book for another edition of it,
 *  the same page for a different book (e.g. "Part One"), never past the end. */
function mapPage(cur, oldPages, newPages, sameWork) {
  if (!cur || !oldPages || !newPages || oldPages === newPages) return null;
  const to = sameWork ? Math.round((cur / oldPages) * newPages) : Math.min(cur, newPages);
  return to === cur ? null : to;
}

async function useEdition(b, coverOnly) {
  const ed = S.edPanel?.ed; if (!ed) return;
  const t = now(), e = effective(b), cur = currentPage(evs(b.id));
  const grEdition = { id: ed.id, title: ed.title, pages: ed.pages || null, binding: ed.binding || null, publisher: ed.publisher || null, isbn13: ed.isbn13 || null, coverUrl: ed.coverUrl || null, workId: ed.workId || null, coverOnly };
  const events = [];
  let note = "";
  if (!coverOnly && !("pages" in (b.mine || {}))) {
    const sameWork = !ed.workId || !b.refs?.goodreadsWorkId || ed.workId === b.refs.goodreadsWorkId;
    const to = mapPage(cur, e.pages, ed.pages, sameWork);
    if (to != null) { events.push({ id: eventId(), bookId: b.id, at: t, type: "progress", page: to, prevPage: cur, source: "edition" }); note = ` Your place moved from p. ${cur} to p. ${to}.`; }
  }
  S.edPanel = null;
  S.notice = coverOnly ? "The cover is changed." : `Now the ${[ed.binding, ed.publisher].filter(Boolean).join(", ") || "chosen"} edition${ed.pages ? `, ${ed.pages} pages` : ""}.${note}${b.refs?.goodreadsBookId && b.refs.goodreadsBookId !== ed.id ? " For Goodreads lists the switch to make there." : ""}`;
  await commit({ books: [patchBook(b, { mine: { ...b.mine, grEdition } }, t)], events });
}

function editionPanel(b) {
  const P = S.edPanel;
  if (!P || P.id !== b.id) return html`<button class="link" data-act="ed-open" data-id="${b.id}">Change edition or cover…</button>${b.mine?.grEdition ? html` · <button class="link" data-act="ed-clear" data-id="${b.id}">Back to the Goodreads edition</button>` : ""}`;
  if (P.step === "preview") {
    const ed = P.ed;
    return html`<div class="edpanel">
      ${ed.coverUrl ? html`<img src="${ed.coverUrl}" alt="" referrerpolicy="no-referrer">` : ""}
      <p><i>${ed.title || "Untitled"}</i>${ed.author ? html`, ${ed.author}` : ""}<br><span class="quiet small">${[ed.binding, ed.publisher, ed.pages ? `${ed.pages} pages` : null, ed.language].filter(Boolean).join(" · ")}</span></p>
      <p><button data-act="ed-use" data-id="${b.id}" data-mode="edition">Use this edition</button> <button class="quietbtn" data-act="ed-use" data-id="${b.id}" data-mode="cover">Just its cover</button> <button class="link" data-act="ed-close">Cancel</button></p>
      <p class="quiet small">The edition brings its cover, pages and publisher; your place is kept${currentPage(evs(b.id)) ? ", moved to the same point in the book" : ""}. Your own corrections still win.</p></div>`;
  }
  if (P.step === "nohelper") return html`<p class="notice">Looking up an edition needs the Mac helper running (it reads Goodreads for you). Open the app on your Mac and try again. <button class="link" data-act="ed-close">OK</button></p>`;
  return html`<form class="inline edform" data-form="edition-look" data-id="${b.id}">
    <label class="vh" for="ed-q">Goodreads link or number</label>
    <input id="ed-q" name="q" placeholder="Goodreads link, e.g. …/book/show/975465" autocomplete="off" ${P.step === "looking" ? raw("disabled") : ""}>
    <button ${P.step === "looking" ? raw("disabled") : ""}>${P.step === "looking" ? "Looking…" : "Look it up"}</button> <button type="button" class="link" data-act="ed-close">Cancel</button></form>`;
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
  const mine = CB.bookPace(b, S.byBook, p);
  const measured = mine ? `<br><span class="small">Timed: about ${mine.mpp.toFixed(1)} min a page over ${plural(mine.n, "session")} <span class="quiet">(the model says ${min.toFixed(1)})</span></span>` : "";
  return raw(`about ${q(pp)} pages for 10 tokens <span class="quiet small">(≈ ${q(min)} min a page)</span>${measured}`);
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
      <p class="quiet small">Want to Read and Currently Reading become your list; Read becomes history. Other shelves are left out. Re-importing later is safe: books are matched, your edits are kept, and nothing is deleted.</p>
      <h2 class="sc small">Or the bookmark</h2>
      <p>Quicker, and it keeps your shelf order. Drag this to your bookmarks bar:
        ${S.bmHref ? html`<a class="button quietbtn bm" href="${S.bmHref}" data-bm="1">Tsundoku Tracker: read my shelves</a>` : html`<span class="quiet">(loading…)</span>`}</p>
      <ol class="steps">
        <li>On goodreads.com, signed in, click the bookmark. It reads your three shelves in that tab, a page a second.</li>
        <li>Choose <i>Send to Tsundoku Tracker</i>: this page opens with what the import will do. Nothing changes until you say.</li>
      </ol>
      <p class="quiet small">If the browser blocks that, choose <i>Copy</i> instead and <button class="link" data-act="paste-open">paste it here</button>. The bookmark only talks to Goodreads and to this app.</p>
      ${S.paste ? html`<form data-form="paste" class="stack"><label class="vh" for="paste">What the bookmark copied</label>
        <textarea id="paste" name="json" rows="4" placeholder="Paste what the bookmark copied"></textarea>
        <p><button>See what it would do</button> <button type="button" class="link" data-act="paste-close">Cancel</button></p></form>` : ""}`;
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
      <dt>Moved shelf there</dt><dd>${p.adopt?.length ? `${p.adopt.length}, followed here: ${p.adopt.map(m => `${effective(S.books.get(m.id)).title} → ${STATUS_LABEL[m.to].toLowerCase()}`).join("; ")}` : "none"}</dd>
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

/** The reading timer: off unless you turn it on; what your sessions say only once they can say something. */
function paceBlock() {
  const p = derived().p, c = CB.calibrate(books(), S.byBook, p), on = !!S.settings.showTimer;
  const undo = S.prevModel ? html` <button class="link" data-act="undo-pace">Put back the previous pace</button>` : "";
  const toggle = html`<label class="small"><input type="checkbox" data-change="show-timer" ${on ? raw("checked") : ""}> Show a reading timer on the Desk</label>
    <span class="quiet small">Optional. Timing a session now and then lets the app measure your own pace. Never using it changes nothing.</span>`;
  if (!c) return html`<div class="pace">${toggle}${undo ? html`<p>${undo}</p>` : ""}</div>`;
  if (!c.ready) return html`<div class="pace">${toggle}<p class="quiet small">${plural(c.n, "timed session")} so far: too few to say anything about your pace yet.${undo}</p></div>`;
  const same = Math.abs(c.v1 - p.v1) < 10 && Math.abs(c.v10 - p.v10) < 5;
  const sure = { fair: "a fair reading", good: "a good reading" }[c.sure];
  return html`<div class="pace">${toggle}<div class="notice quiet"><p><b>Your measured pace</b>, from ${plural(c.n, "timed session")} (about ${L.duration(c.minutes)}): about <b>${c.v1}</b> words a minute on easy prose and <b>${c.v10}</b> on dense text: ${sure}.</p>
    <p>${same ? "That's what the model uses now." : html`<button data-act="use-pace">Use these</button> <span class="small">(now ${p.v1} and ${p.v10}). Daily pages and finish dates follow; nothing else changes.</span>`}${undo}</p></div></div>`;
}

function viewSettings() {
  const counts = `${plural(S.books.size, "book")}, ${plural(S.events.length, "history entry", "history entries")}`;
  const auto = S.auto;
  return html`
    <div class="dateline sc"><span>${counts}</span><span>Settings</span></div>
    <h1>Settings</h1>

    <section id="sync"><h2 class="sc small">Sync between devices</h2>${syncBlock()}</section>

    <section id="backup"><h2 class="sc small">Keeping your library safe</h2>
      <p>Your library lives in this browser. Nothing is sent anywhere.</p>
      ${backup.autoBackupSupported() ? html`
        <p><b>Backup file.</b> ${auto.handle
          ? html`Saved automatically after every change${auto.lastWrite ? `, last ${relativeDay(auto.lastWrite)}` : ""}.
              ${auto.state !== "granted" ? html` <button data-act="auto-reconnect">Reconnect</button>` : ""}
              <button class="link" data-act="auto-disconnect">Stop</button>`
          : html`Choose a file in Dropbox or iCloud Drive and Tsundoku Tracker keeps it up to date. The phone reads the same file.
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

    <section id="effort"><h2 class="sc small">Daily effort</h2>
      <form data-form="tokens" class="inline">
        <label>Tokens a day <input name="tokens" type="number" min="1" max="100" value="${S.settings.dailyTokens}" inputmode="numeric"></label>
        <button>Save</button></form>
      <p class="quiet small">${S.settings.dailyTokens} tokens ≈ ${S.settings.dailyTokens * S.settings.minutesPerToken} minutes of focused reading.</p>
      <p class="small">Ahead or behind is counted ${S.settings.ledgerFrom ? html`from ${shortDate(S.settings.ledgerFrom)}` : "from your first entry"}, over at most the last 28 days. <button class="link" data-act="ledger-reset">Count afresh from today</button></p>
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
      ${paceBlock()}
    </section>

    <section><h2 class="sc small">The Mac helper</h2>${helperBlock()}</section>

    <section><h2 class="sc small">Library</h2>
      <p><a href="#/import">Import from Goodreads</a> · <a href="#/add">Add a book by hand</a> · <a href="#/about">How it works</a>${S.settings.gettingStarted?.dismissed ? html` · <button class="link" data-act="gs-show">Show the getting-started list again</button>` : ""}</p>
      <p class="quiet small">Tsundoku Tracker ${APP_VERSION} · data version ${SCHEMA_VERSION}</p>
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
  if (S.error) { root.innerHTML = html`<main class="page"><h1>Tsundoku Tracker couldn't open</h1><p>${S.error}</p></main>`; return; }
  if (!S.ready) return;
  const [name, arg] = route();
  const view = { desk: viewDesk, list: viewList, order: viewOrder, book: () => viewBook(arg), add: viewAdd, import: viewImport, settings: viewSettings, goodreads: viewGoodreads, library: viewLibrary, year: () => viewYear(arg), about: viewAbout, map: viewMap }[name] || viewDesk;
  const active = { desk: "desk", list: "list", order: "list", book: "list", add: "list", import: "settings", settings: "settings", goodreads: "desk", library: "library", year: "library", about: "settings", map: "library" }[name] || "desk";
  const focus = document.activeElement?.id;
  document.documentElement.dataset.view = name in { desk: 1, list: 1, book: 1, order: 1, library: 1, year: 1, settings: 1, goodreads: 1, import: 1, add: 1, about: 1, map: 1 } ? name : "desk";
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
  if (name === "library") markLetterSeen();
}

// --- Actions ------------------------------------------------------------------------

async function act(name, d) {
  const t = now();
  const b = d.id ? S.books.get(d.id) : null;
  switch (name) {
    case "dismiss": S.notice = null; return render();
    case "year-print": window.print(); return;
    case "install": {
      if (!installEvent) return;
      const e = installEvent; installEvent = null;
      await e.prompt();
      const choice = await e.userChoice.catch(() => null);
      if (choice && choice.outcome === "dismissed") S.installDismissed = true;
      return render();
    }
    case "install-later": S.installDismissed = true; return render();
    case "sync-start": return goToGoogle(false);
    case "sync-tap":
    case "sync-now": {
      if (tokenGood()) return syncNow();
      // a tap may show Google's account choice if renewing quietly didn't work a moment ago
      const failedAt = (await store.getMeta("gdriveSilentFailedAt")) || 0;
      return goToGoogle(Date.now() - failedAt > 600e3 && S.sync.state !== "choose");
    }
    case "sync-stop": {
      await store.setMeta("gdrive", null);
      S.sync = { ...S.sync, rec: null, state: "off", last: null, error: null };
      S.notice = "This device no longer syncs. The library stays here, and the copy in Google Drive stays there.";
      return render();
    }
    case "ledger-reset": {
      const d0 = new Date(); d0.setHours(0, 0, 0, 0);
      S.notice = "Counting afresh from today: you're on course. Your history is untouched.";
      return commit({ settings: { ...S.settings, ledgerFrom: d0.toISOString(), updatedAt: t } });
    }
    case "ed-open": S.edPanel = { id: d.id, step: "ask" }; render(); document.getElementById("ed-q")?.focus(); return;
    case "ed-close": S.edPanel = null; return render();
    case "ed-use": return useEdition(b, d.mode === "cover");
    case "ed-clear": {
      const mine = { ...b.mine }; delete mine.grEdition;
      S.notice = "Back to the Goodreads edition.";
      return commit({ books: [patchBook(b, { mine }, t)] });
    }
    case "timer-start": {
      S.timer = { bookId: d.id, start: t, startPage: currentPage(evs(d.id)) };
      await store.setMeta("timer", S.timer);
      return render();
    }
    case "timer-stop": {
      if (!S.timer) return;
      S.stopping = { ...S.timer, end: t };
      S.timer = null; await store.setMeta("timer", null);
      render(); document.querySelector(".stopform input")?.focus(); return;
    }
    case "timer-discard": S.stopping = null; S.notice = "Session discarded."; return render();
    case "use-pace": {
      const c = CB.calibrate(books(), S.byBook, derived().p);
      if (!c) return;
      S.prevModel = { ...S.settings.model };
      S.notice = `Now using your measured pace: about ${c.v1} words a minute on easy prose, ${c.v10} on dense. Finish dates and daily pages follow.`;
      return commit({ settings: { ...S.settings, model: { ...S.settings.model, v1: c.v1, v10: c.v10 }, updatedAt: t } });
    }
    case "undo-pace": {
      if (!S.prevModel) return;
      const m = S.prevModel; S.prevModel = null;
      S.notice = "The previous pace is back.";
      return commit({ settings: { ...S.settings, model: m, updatedAt: t } });
    }
    case "sort-custom": S.listSort = "custom"; await store.setMeta("listSort", "custom"); return render();
    case "link-open": S.linkPanel = { id: d.id, q: "", kind: "together", note: "" }; render(); document.getElementById("link-q")?.focus(); return;
    case "link-close": S.linkPanel = null; return render();
    case "link-pick": { const P = S.linkPanel; S.linkPanel = null; return addLink(d.id, d.other, P?.kind || "together", P?.note || ""); }
    case "link-del": S.notice = "Connection removed."; return commit({ removeEvents: [d.ev] });
    case "link-accept": return addLink(d.from, d.to, "builds");
    case "link-ignore": { const a = S.books.get(d.from); return commit({ books: [patchBook(a, { linksDeclined: [...new Set([...(a.linksDeclined || []), d.to])] }, t)] }); }
    case "row-more": S.openRow = S.openRow === d.id ? null : d.id; return render();
    case "gs-installed": return commit({ settings: gsDone("installed") || S.settings });
    case "gs-show": return commit({ settings: { ...S.settings, gettingStarted: { ...(S.settings.gettingStarted || {}), show: true, dismissed: false }, updatedAt: t } });
    case "gs-hide": return commit({ settings: { ...S.settings, gettingStarted: { ...(S.settings.gettingStarted || {}), dismissed: true }, updatedAt: t } });
    case "year-download": return downloadYear(+d.year);
    case "note-open": S.noteFor = d.id; render(); document.getElementById(`note-${d.id}`)?.focus(); return;
    case "note-close": S.noteFor = null; return render();
    case "note-del": return commit({ removeEvents: [d.ev] });
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
      await commit({ books: patches.map(p => patchBook(S.books.get(p.id), { queueKey: p.queueKey }, t)), settings: orderedSettings() });
      location.hash = "#/list";
      return;
    }
    case "undo-order": {
      const put = (S.undoOrder || []).filter(([id]) => S.books.has(id)).map(([id, queueKey]) => patchBook(S.books.get(id), { queueKey }, t));
      S.undoOrder = null;
      S.notice = "Your order is back as it was.";
      return commit({ books: put });
    }
    case "gr-done": {
      const x = grItem(b);
      if (!x) return render();
      return commit({ books: [patchBook(b, { flags: { ...b.flags, grDone: G.doneMark(b, x) } }, t)] });
    }
    case "paste-open": S.paste = true; render(); document.getElementById("paste")?.focus(); return;
    case "paste-close": S.paste = false; return render();
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
      const list = unscored().map(scoreRecord);
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
      if (S.plan.incoming && S.plan.version !== S.version) {
        // The library changed while the plan was open (the helper brought books in, say): plan again, keep your answers.
        const choices = new Map(S.plan.asks.map(a => [a.incoming.goodreadsBookId, a.choice]));
        S.plan = makePlan(S.plan.incoming, S.plan.source);
        S.plan.asks.forEach(a => { a.choice = choices.get(a.incoming.goodreadsBookId); });
        S.notice = "Your library changed while this was open, so here is the import worked out again. Nothing has changed yet.";
        return render();
      }
      const p = S.plan;
      const extra = p.asks.filter(a => a.choice && a.choice !== "skip").map(a => resolveAsk(a, a.choice, books(), { now: t }));
      const creates = [...p.creates, ...extra.flatMap(x => x.creates)];
      const updates = [...p.updates, ...extra.flatMap(x => x.updates)];
      await store.snapshot("before a Goodreads import", archive());
      S.plan = null;
      await applyPlan({ ...p, creates, updates }, { snapshotOver: -1 });
      const placed = await placeByYouth();
      S.notice = `Imported: ${plural(creates.length, "new book")}, ${plural(updates.length, "update")}${p.adopt?.length ? `, ${plural(p.adopt.length, "shelf move")} followed` : ""}${placed.length ? `; ${placed.length} placed by reading-youth` : ""}.`;
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
    case "timer-save": {
      const st = S.stopping; if (!st) return;
      const pages = effective(b).pages;
      const to = Math.max(st.startPage, Math.min(Math.round(+f.get("page") || 0), pages || Infinity));
      const len = CB.sessionLength(st.start, st.end);
      const cur = currentPage(evs(b.id));
      const events = [{ id: eventId(), bookId: b.id, at: st.end, type: "session", start: st.start, minutes: len.minutes, fromPage: st.startPage, toPage: to, capped: len.capped, source: "app" }];
      let patch = null;
      if (to > cur) {
        const r = logPage(b, evs(b.id), to, st.end);
        if (r) { events.push(...r.events); patch = r.patch; }
      }
      S.stopping = null;
      const n = to - st.startPage;
      S.notice = n > 0 ? `Timed: ${n} ${n === 1 ? "page" : "pages"} in ${L.duration(len.minutes)}${len.capped ? "" : ` (about ${(len.minutes / n).toFixed(1)} min a page)`}.` : "Session saved; no pages, so nothing to learn from it.";
      return commit({ events, books: patch ? [patchBook(b, patch, t)] : [] });
    }
    case "place": {
      const v = f.get("page"), cur = currentPage(evs(b.id)), pages = effective(b).pages;
      if (v === "" || isNaN(+v)) return;
      const to = Math.max(0, Math.min(Math.round(+v), pages || Infinity));
      if (to === cur) return;
      const events = [{ id: eventId(), bookId: b.id, at: t, type: "progress", page: to, prevPage: cur, source: "place" }];
      const patch = b.status === "want" && to > 0 ? { status: "reading" } : null;
      if (patch) events.push({ id: eventId(), bookId: b.id, at: t, type: "status", from: b.status, to: "reading", source: "app" });
      S.notice = `Your place in ${effective(b).title}: p. ${to}${pages ? ` of ${pages}` : ""}. Not counted as today's reading.`;
      return commit({ events, books: patch ? [patchBook(b, patch, t)] : [] });
    }
    case "edition-look": {
      const gid = G.bookIdFrom(f.get("q"));
      if (!gid) { S.notice = "Paste a Goodreads book link (…/book/show/975465…) or its number."; return render(); }
      if (!S.helper.connected) { S.edPanel = { id: b.id, step: "nohelper", gid }; return render(); }
      S.edPanel = { id: b.id, step: "looking", gid }; render();
      try { S.edPanel = { id: b.id, step: "preview", ed: await H.edition(gid) }; }
      catch (e) { S.edPanel = { id: b.id, step: "ask" }; S.notice = `Couldn't look it up: ${e.message}`; }
      return render();
    }
    case "reader": {
      const name = (f.get("reader") || "").trim().slice(0, 60);
      S.notice = name ? `The title page now reads “The Reading Year of ${name}”.` : "The title page has no name.";
      return commit({ settings: { ...S.settings, readerName: name || null, updatedAt: t } });
    }
    case "note": {
      const text = (f.get("text") || "").trim();
      S.noteFor = null;
      if (!text) return render();
      const page = currentPage(evs(b.id));
      S.notice = `Noted in the margin of ${effective(b).title}${page ? ` at p. ${page}` : ""}.`;
      return commit({ events: [{ id: eventId(), bookId: b.id, at: t, type: "note", text, page: page || null, source: "app" }] });
    }
    case "paste": {
      try { takeBookmarklet(JSON.parse(f.get("json") || "")); S.paste = false; }
      catch (e) { S.notice = e instanceof SyntaxError ? "That isn't what the bookmark copies." : e.message; }
      return render();
    }
    case "autoscore": {
      const cap = Math.min(5, Math.max(0.05, +f.get("cap") || 0.25));
      await commit({ settings: { ...S.settings, autoScore: { ...(S.settings.autoScore || {}), on: f.get("on") === "on", monthCap: cap }, updatedAt: t } });
      S.notice = f.get("on") === "on" ? `New books will be scored as they arrive, up to $${cap.toFixed(2)} a month.` : "New books won't be scored by themselves.";
      if (f.get("on") === "on") await autoScore().catch(() => {});
      return render();
    }
    case "annotation": return commit({ books: [patchBook(b, { mine: { ...b.mine, annotation: (f.get("annotation") || "").trim() } }, t)] });
    case "details": {
      const mine = { ...b.mine };
      for (const k of ["title", "author", "edition"]) { const v = (f.get(k) || "").trim(); if (v) mine[k] = v; else delete mine[k]; }
      for (const k of ["pages", "year"]) { const v = f.get(k); if (v && !isNaN(+v)) mine[k] = +v; else delete mine[k]; }
      { const v = f.get("difficulty"); if (v && !isNaN(+v)) mine.difficulty = Math.min(10, Math.max(1, +v)); else delete mine.difficulty; }
      { const v = f.get("youth"); if (v !== null && v !== "" && !isNaN(+v)) mine.youth = Math.round(Math.min(100, Math.max(0, +v))); else delete mine.youth; }
      S.notice = "Saved.";
      const youthChanged = O.youthOf(b).youth !== O.youthOf({ ...b, mine }).youth;
      await commit({ books: [patchBook(b, { mine }, t)] });
      if (youthChanged && b.status === "want") {
        const before = waiting().findIndex(x => x.id === b.id);
        const [placed] = await placeByYouth([b.id]);
        if (placed) S.notice = placed[1] === before ? `Saved. At youth ${O.youthOf(S.books.get(b.id)).youth} it stays at no. ${before + 1}.` : `Saved, and moved from no. ${before + 1} to no. ${placed[1] + 1}, among books of a similar reading-youth.`;
        render();
      }
      return;
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
      S.notice = `Saved: ${n} tokens a day, about ${n * S.settings.minutesPerToken} minutes.`;
      return commit({ settings: { ...(gsDone("effort") || S.settings), dailyTokens: n, updatedAt: t }, events: n !== S.settings.dailyTokens ? [{ id: `e_goal_${Date.now()}`, at: t, type: "goal", dailyTokens: n, source: "app" }] : [] });
    }
  }
}

async function change(el) {
  const kind = el.dataset.change;
  if (kind === "ask") { S.plan.asks[+el.dataset.i].choice = el.value; return; }
  if (kind === "autoscore") return; // saved with its form
  if (kind === "year") { location.hash = `#/year/${el.value}`; return; }
  if (kind === "link-kind" && S.linkPanel) { S.linkPanel.kind = el.value; return; }
  if (kind === "map-suggest") { S.mapSuggest = el.checked; return render(); }
  if (kind === "show-timer") return commit({ settings: { ...S.settings, showTimer: el.checked, updatedAt: now() } });
  if (kind === "list-sort") { S.listSort = el.value; await store.setMeta("listSort", S.listSort); return render(); }
  const file = el.files?.[0];
  if (!file) return;
  try {
    if (kind === "csv") {
      const objs = csvObjects(await file.text());
      if (!isGoodreadsExport(objs)) throw new Error("That doesn't look like a Goodreads library export.");
      S.plan = makePlan(goodreadsRows(objs), "goodreads-csv");
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
  if (e.target.id === "link-q" && S.linkPanel) { S.linkPanel.q = e.target.value; render(); }
  if (e.target.id === "link-note" && S.linkPanel) S.linkPanel.note = e.target.value;
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
  if (S.ready && S.auto.state === "granted") guard(refreshAutoFile());
  if (S.ready && S.helper.connected) guard(pullFromHelper());
});

export const APP_VERSION = "1.6.1";

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  // When a new version takes over, reload once so you see it straight away.
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register("./sw.js").then(r => r.update()).catch(() => {});
}

window.__antilibrary = S; // for debugging and browser tests
boot();
