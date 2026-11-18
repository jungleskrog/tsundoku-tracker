// CSV reading (RFC 4180) and the Goodreads library export.

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, quoted = false;
  text = text.replace(/^﻿/, "");
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== "");
}

export function csvObjects(text) {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const GOODREADS_COLUMNS = ["Book Id", "Title", "Author", "Exclusive Shelf", "Number of Pages"];

export function isGoodreadsExport(objects) {
  return objects.length > 0 && GOODREADS_COLUMNS.every(c => c in objects[0]);
}

// Goodreads wraps ISBNs as ="9780…"
const unwrap = v => (v || "").replace(/^="?|"$/g, "").trim() || null;
const intOrNull = v => (/^-?\d+$/.test((v || "").trim()) ? parseInt(v, 10) : null);
const gdate = v => {
  const m = (v || "").match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/** Goodreads export rows -> incoming book facts (the "synced" layer). */
export function goodreadsRows(objects) {
  return objects.map(r => {
    const shelf = r["Exclusive Shelf"];
    const pos = (r["Bookshelves with positions"] || "").match(new RegExp(`(?:^|, )${shelf} \\(#(\\d+)\\)`));
    const pages = intOrNull(r["Number of Pages"]);
    return {
      goodreadsBookId: r["Book Id"],
      title: r["Title"],
      author: r["Author"],
      isbn13: unwrap(r["ISBN13"]),
      pages: pages && pages > 0 ? pages : null,
      year: intOrNull(r["Original Publication Year"]) ?? intOrNull(r["Year Published"]),
      publisher: r["Publisher"] || null,
      binding: r["Binding"] || null,
      shelf,
      dateAdded: gdate(r["Date Added"]),
      dateRead: gdate(r["Date Read"]),
      rating: intOrNull(r["My Rating"]) || null,
      position: pos ? parseInt(pos[1], 10) : null,
    };
  });
}
