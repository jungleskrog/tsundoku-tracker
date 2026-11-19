// Antilibrary — the "Antilibrary: read my shelves" bookmarklet.
// Runs on goodreads.com in your own signed-in tab: reads Want to Read, Currently
// Reading and Read with ordinary same-site page requests, a second apart, then hands
// the list to your Antilibrary tab (or copies it, to paste on the Import page).
// It stores nothing and sends nothing anywhere but your own app.
// The app fills in __APP__ (its own address) when it makes the bookmark.
// Lines starting with // are dropped from the bookmark.
(async () => {
  const APP = "__APP__", APP_ORIGIN = new URL(APP).origin;
  const SHELVES = ["currently-reading", "to-read", "read"];
  if (!/(^|\.)goodreads\.com$/.test(location.hostname)) { alert("Open goodreads.com first, then click the bookmark."); return; }
  document.getElementById("antilibrary-bm")?.remove();
  const box = document.createElement("div");
  box.id = "antilibrary-bm";
  box.style.cssText = "position:fixed;z-index:2147483647;top:16px;right:16px;max-width:320px;background:#fbf8f2;color:#1d1b18;border:1px solid #7A1F1F;padding:14px 16px;font:15px/1.4 Georgia,serif;box-shadow:0 2px 10px rgba(0,0,0,.2)";
  const say = (msg, buttons = []) => {
    box.innerHTML = "";
    const p = document.createElement("p"); p.style.margin = "0 0 8px"; p.textContent = msg; box.append(p);
    for (const [label, fn] of buttons) {
      const b = document.createElement("button"); b.textContent = label;
      b.style.cssText = "margin:4px 8px 0 0;font:inherit;padding:3px 10px;border:1px solid #7A1F1F;background:#fff;color:#7A1F1F;cursor:pointer";
      b.onclick = fn; box.append(b);
    }
  };
  document.body.append(box);
  say("Antilibrary: reading your shelves…");
  const me = (document.querySelector('a[href*="/review/list/"]')?.getAttribute("href") || "").match(/\/review\/list\/(\d+)/)?.[1]
    || (document.querySelector('a[href*="/user/show/"]')?.getAttribute("href") || "").match(/\/user\/show\/(\d+)/)?.[1];
  if (!me) { say("Sign in to Goodreads first, then click the bookmark again.", [["Close", () => box.remove()]]); return; }
  const val = (row, name) => {
    const td = row.querySelector(`td.field.${name} .value`);
    return td ? td.textContent.replace(/\[edit\]/g, "").replace(/\s+/g, " ").trim() || null : null;
  };
  const num = s => { const m = (s || "").match(/\d[\d,]*/); return m ? +m[0].replace(/,/g, "") : null; };
  const year = s => { const m = (s || "").match(/-?\d+/g); return m ? +m[m.length - 1] : null; };
  const date = s => { if (!s || /not set|unknown/.test(s)) return null; const d = new Date(s + " UTC"); return isNaN(d) ? s : d.toISOString().slice(0, /\d{1,2},/.test(s) ? 10 : 7); };
  const books = [];
  try {
    for (const shelf of SHELVES) {
      for (let page = 1; page < 50; page++) {
        say(`Antilibrary: reading ${shelf.replace(/-/g, " ")}… (${books.length} books so far)`);
        const res = await fetch(`/review/list/${me}?shelf=${shelf}&per_page=100&page=${page}&sort=date_added&order=a`, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`Goodreads answered ${res.status}`);
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
  } catch (e) {
    say(`Antilibrary couldn't read the shelves: ${e.message}`, [["Close", () => box.remove()]]);
    return;
  }
  const payload = { format: "antilibrary-goodreads-sync", version: 1, user_id: me, synced_at: new Date().toISOString(), books };
  const count = SHELVES.map(s => `${books.filter(b => b.shelf === s).length} ${s.replace(/-/g, " ")}`).join(", ");
  let tries = 0, timer = null, win = null;
  const onMsg = e => {
    if (e.origin !== APP_ORIGIN || !e.data || e.data.type !== "antilibrary-received") return;
    clearInterval(timer); window.removeEventListener("message", onMsg);
    say(`Sent to Antilibrary: ${count}. Look there to see what changes before anything does.`, [["Close", () => box.remove()]]);
  };
  const send = () => {
    window.addEventListener("message", onMsg);
    win = window.open(APP + "#/import", "antilibrary");
    if (!win) { say("The browser blocked the new tab. Copy instead, and paste on Antilibrary's Import page.", [["Copy", copy], ["Close", () => box.remove()]]); return; }
    say("Sending…");
    clearInterval(timer); tries = 0;
    timer = setInterval(() => {
      if (++tries > 40) { clearInterval(timer); say("Antilibrary didn't answer. Copy instead, and paste on its Import page.", [["Copy", copy], ["Close", () => box.remove()]]); return; }
      try { win.postMessage(payload, APP_ORIGIN); } catch (_) {}
    }, 500);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(payload)); say(`Copied: ${count}. Paste it on Antilibrary's Import page.`, [["Close", () => box.remove()]]); }
    catch (_) { say("The browser wouldn't copy. Try Send instead.", [["Send to Antilibrary", send], ["Close", () => box.remove()]]); }
  };
  say(`Read ${count}.`, [["Send to Antilibrary", send], ["Copy", copy], ["Close", () => box.remove()]]);
})();
