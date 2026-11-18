// Antilibrary — "Sync from Goodreads" bookmarklet (Stage 1 proof).
// Runs on goodreads.com in the user's own signed-in tab. Reads the three
// shelves with same-origin requests, builds JSON, and copies it to the
// clipboard for the app to paste. Stores nothing, sends nothing elsewhere.
(async () => {
  const SHELVES = ["currently-reading", "to-read", "read"];
  const me = (document.querySelector('a[href*="/review/list/"]')?.getAttribute("href") || "").match(/\/review\/list\/(\d+)/)?.[1]
    || (document.querySelector('a[href*="/user/show/"]')?.getAttribute("href") || "").match(/\/user\/show\/(\d+)/)?.[1];
  if (!me) { return { error: "Sign in to Goodreads first, then click again." }; }
  const val = (row, name) => {
    const td = row.querySelector(`td.field.${name} .value`);
    return td ? td.textContent.replace(/\[edit\]/g, "").replace(/\s+/g, " ").trim() || null : null;
  };
  const num = s => { const m = (s || "").match(/\d[\d,]*/); return m ? +m[0].replace(/,/g, "") : null; };
  const year = s => { const m = (s || "").match(/-?\d+/g); return m ? +m[m.length - 1] : null; };
  const date = s => { if (!s || /not set|unknown/.test(s)) return null; const d = new Date(s + " UTC"); return isNaN(d) ? s : d.toISOString().slice(0, /\d{1,2},/.test(s) ? 10 : 7); };
  const books = [];
  for (const shelf of SHELVES) {
    for (let page = 1; page < 50; page++) {
      const res = await fetch(`/review/list/${me}?shelf=${shelf}&per_page=100&page=${page}&sort=date_added&order=a`, { credentials: "same-origin" });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const rows = [...doc.querySelectorAll("tr.bookalike.review")];
      for (const row of rows) {
        const link = row.querySelector("td.field.title a[href*='/book/show/']");
        if (!link) continue;
        let author = val(row, "author") || "";
        if ((author.match(/,/g) || []).length === 1) { const [l, f] = author.split(",").map(s => s.trim()); author = `${f} ${l}`.trim(); }
        const img = row.querySelector("td.field.cover img")?.getAttribute("src") || "";
        books.push({
          book_id: link.getAttribute("href").match(/\/book\/show\/(\d+)/)[1],
          title: link.getAttribute("title") || link.textContent.trim(),
          author, shelf,
          work_id: (row.querySelector("td.field.format a[href*='/work/editions/']")?.getAttribute("href") || "").match(/(\d+)/)?.[1] || null,
          isbn13: val(row, "isbn13"),
          pages: num(val(row, "num_pages")),
          year_original: year(val(row, "date_pub")),
          cover_url: /nophoto/.test(img) ? null : img.replace(/\._S[XY]\d+_/, ""),
          date_added: date(val(row, "date_added")),
          date_started: date(val(row, "date_started")),
          date_read: date(val(row, "date_read")),
          position: num(row.querySelector("td.field.position input")?.value),
        });
      }
      if (rows.length < 100) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  const payload = { format: "antilibrary-goodreads-sync", version: 1, user_id: me, synced_at: new Date().toISOString(), books };
  return payload;
})();
