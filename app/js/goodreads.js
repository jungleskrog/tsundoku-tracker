// The Goodreads round trip (Stage 6). Pure functions: no storage, no DOM.
//   in:  shelves arrive through the Mac helper, the bookmarklet or the CSV export
//   out: Goodreads has no way in for apps, so changes go back by hand: the app lists
//        what to change there, with a link to each book, and the next read of the
//        shelves confirms it (or "Done" hides it until the book changes again)
export const GR = "https://www.goodreads.com";
export const SHELF_NAME = { "to-read": "Want to Read", "currently-reading": "Currently Reading", read: "Read" };
const TARGET = { want: "to-read", reading: "currently-reading", read: "read" };

export const bookUrl = b => `${GR}/book/show/${encodeURIComponent(b.refs.goodreadsBookId)}`;
export const searchUrl = (title, author) => `${GR}/search?q=${encodeURIComponent([title, author].filter(Boolean).join(" "))}`;

/** Is this book's Goodreads shelf something the app knows (it came from Goodreads)? */
const fromGoodreads = b => !!(b.refs?.goodreadsBookId && b.synced && String(b.synced.source || "").startsWith("goodreads"));

/**
 * What to change on Goodreads so it matches the app. One item per book:
 *   { id, kind: "shelf" | "off" | "missing", from, to }
 * "shelf": put it on `to`; "off": take it off `from` (set aside here); "missing": not on Goodreads.
 * Paused books are fine on either Want to Read or Currently Reading. A book whose
 * shelf vanished on Goodreads is flagged elsewhere, not listed here.
 */
export function changesForGoodreads(books) {
  const out = [];
  for (const b of books) {
    if (b.flags?.goneFromGoodreads) continue;
    let item = null;
    if (fromGoodreads(b)) {
      const from = b.synced.shelf ?? null;
      if (TARGET[b.status] && TARGET[b.status] !== from) item = { id: b.id, kind: "shelf", from, to: TARGET[b.status] };
      if (b.status === "abandoned" && (from === "to-read" || from === "currently-reading")) item = { id: b.id, kind: "off", from, to: null };
      if (b.status === "paused" && from === "read") item = { id: b.id, kind: "shelf", from, to: "currently-reading" };
    } else if (!b.refs?.goodreadsBookId && b.status !== "abandoned") {
      item = { id: b.id, kind: "missing", from: null, to: TARGET[b.status] || "currently-reading" };
    }
    if (item && !isDone(b, item)) out.push(item);
  }
  return out;
}

/** "Done" on an item hides it while the book's status and known shelf stay as they were. */
export const doneMark = (b, item) => ({ status: b.status, from: item.from });
const isDone = (b, item) => b.flags?.grDone && b.flags.grDone.status === b.status && (b.flags.grDone.from ?? null) === item.from;

/** The bookmarklet's payload -> the incoming shape planImport expects. */
export function fromBookmarklet(payload) {
  if (!payload || payload.format !== "antilibrary-goodreads-sync" || !Array.isArray(payload.books)) {
    throw new Error("That isn't what the Antilibrary bookmarklet copies.");
  }
  return payload.books.filter(b => b && b.book_id && b.shelf).map(b => {
    const inc = {
      goodreadsBookId: String(b.book_id), workId: b.work_id || null, title: b.title || "", author: b.author || "",
      isbn13: b.isbn13 || null, pages: b.pages || null, year: b.year_original || null,
      shelf: b.shelf, dateAdded: b.date_added || null, dateStarted: b.date_started || null, dateRead: b.date_read || null,
      position: b.position ?? null, coverUrl: b.cover_url || null,
    };
    if (b.format) inc.binding = b.format;   // the shelf page doesn't always show these: keep what's known
    if (b.rating) inc.rating = b.rating;
    return inc;
  });
}
