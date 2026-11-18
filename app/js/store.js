// IndexedDB storage. Thin: every write is one transaction; logic lives in domain.js.
const DB_NAME = "antilibrary";
const DB_VERSION = 1;
export const STORES = ["books", "events", "tombstones", "settings", "meta", "snapshots"];

let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export function open(name = DB_NAME) {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(name, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
      if (!db.objectStoreNames.contains("events")) db.createObjectStore("events", { keyPath: "id" }).createIndex("bookId", "bookId");
      if (!db.objectStoreNames.contains("tombstones")) db.createObjectStore("tombstones", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("Antilibrary is open in another window that is using an older version. Close it and reload."));
  });
  return dbPromise;
}

export function closeForTests() { dbPromise = null; }

async function all(store) {
  const db = await open();
  return req(db.transaction(store).objectStore(store).getAll());
}

export async function loadAll() {
  const [books, events, tombstones, settingsList] = await Promise.all(["books", "events", "tombstones", "settings"].map(all));
  return { books, events, tombstones, settings: settingsList.find(s => s.id === "settings") || null };
}

/**
 * One atomic write. changes = { put: { books: [...], events: [...] }, del: { events: [ids] } }
 */
export async function write({ put = {}, del = {} }) {
  const stores = [...new Set([...Object.keys(put), ...Object.keys(del)])];
  if (!stores.length) return;
  const db = await open();
  const tx = db.transaction(stores, "readwrite");
  const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("write aborted")); });
  try {
    for (const [s, recs] of Object.entries(put)) for (const r of recs) tx.objectStore(s).put(r);
    for (const [s, ids] of Object.entries(del)) for (const id of ids) tx.objectStore(s).delete(id);
  } catch (e) {
    tx.abort(); // all or nothing: a bad record must not leave half a change behind
    await done.catch(() => {});
    throw e;
  }
  await done;
}


/** Replace the whole library (restore). */
export async function replaceAll({ books, events, tombstones = [], settings }) {
  const db = await open();
  const tx = db.transaction(["books", "events", "tombstones", "settings"], "readwrite");
  for (const s of ["books", "events", "tombstones"]) tx.objectStore(s).clear();
  for (const b of books) tx.objectStore("books").put(b);
  for (const e of events) tx.objectStore("events").put(e);
  for (const t of tombstones) tx.objectStore("tombstones").put(t);
  if (settings) tx.objectStore("settings").put(settings);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

export async function getMeta(key) {
  const db = await open();
  const r = await req(db.transaction("meta").objectStore("meta").get(key));
  return r ? r.value : undefined;
}

export async function setMeta(key, value) {
  const db = await open();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put({ key, value });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

const KEEP_SNAPSHOTS = 10;

/** Keep a full copy before anything risky (import, restore, migration). */
export async function snapshot(reason, archive) {
  const db = await open();
  const at = new Date().toISOString();
  const id = `${at}~${Math.random().toString(36).slice(2, 8)}`;
  const tx = db.transaction("snapshots", "readwrite");
  const store = tx.objectStore("snapshots");
  store.put({ id, at, reason, archive });
  const keys = await req(store.getAllKeys());
  for (const k of keys.sort().slice(0, Math.max(0, keys.length - KEEP_SNAPSHOTS))) store.delete(k);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  return id;
}

export async function listSnapshots() {
  const list = await all("snapshots");
  return list.map(s => ({ id: s.id, at: s.at || s.id, reason: s.reason, books: s.archive.books.length, events: s.archive.events.length })).sort((a, b) => (a.id < b.id ? 1 : -1));
}

export async function getSnapshot(id) {
  const db = await open();
  return req(db.transaction("snapshots").objectStore("snapshots").get(id));
}

export async function persist() {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
