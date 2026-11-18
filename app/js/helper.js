// Talking to the optional Mac helper (http://127.0.0.1:8749). Everything here
// fails quietly: without the helper the app works exactly as before.
const BASE = "http://127.0.0.1:8749";

async function call(path, { method = "GET", body, timeout = 5000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, {
      method,
      signal: ctl.signal,
      headers: { "X-Antilibrary": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `helper answered ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const status = () => call("/status", { timeout: 2500 });
export const shelves = () => call("/shelves", { timeout: 15000 });
export const catalogue = () => call("/catalogue", { timeout: 15000 });
export const sync = () => call("/sync", { method: "POST", body: {} });
export const enrich = ids => call("/enrich", { method: "POST", body: { ids } });
export const estimate = books => call("/estimate", { method: "POST", body: { books } });
export const score = (books, maxUsd) => call("/score", { method: "POST", body: { books, max_usd: maxUsd } });

/** Catalogue key for a book: its Goodreads id, else its own id in this library. */
export const keyOf = b => (b.refs?.goodreadsBookId ? `gr:${b.refs.goodreadsBookId}` : `b:${b.id}`);

/** Helper shelf records -> the incoming shape planImport expects. */
export const incomingFromShelves = s => (s.books || []).map(b => ({ ...b }));
