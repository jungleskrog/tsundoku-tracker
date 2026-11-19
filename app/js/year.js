// The printed year (Stage 8): a reading year set as a small book. Pure: the data, and
// the whole document as HTML, used on screen, by the print stylesheet (PDF) and in the
// single-page export alike.
//   yearData  — what happened in a year, from the books and the event log
//   yearHtml  — the document: title page, contents, the year in figures, the books,
//               set aside, the commonplace book, the letters, a colophon
import { effective, localDayKey } from "./domain.js";
import { difficultyOf, tokensPerPage } from "./model.js";
import { colophon, colophonText, weekFacts, shelfLetter, weekStart, inWords, duration } from "./library.js";
import { esc } from "./format.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dm = at => { const d = new Date(at); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const yearOfAt = at => new Date(at).getFullYear();

/** Years that have something in them (a finish, a set-aside, or reading logged), newest first. */
export function readingYears(events, now = new Date()) {
  const ys = new Set([now.getFullYear()]);
  for (const e of events) {
    if ((e.type === "status" && (e.to === "read" || e.to === "abandoned")) || (e.source === "app" && (e.type === "progress" || e.type === "note"))) ys.add(yearOfAt(e.at));
  }
  return [...ys].sort((a, b) => b - a);
}

export function yearData({ books, byBook, p, year, now = new Date() }) {
  const inYear = at => yearOfAt(at) === year;
  const finished = [], aside = [], notesBy = new Map();
  let begun = 0, loggedPages = 0, loggedTokens = 0;
  const days = new Set();
  for (const b of books) {
    const list = byBook.get(b.id) || [];
    const tpp = tokensPerPage(difficultyOf(b, p).D, p);
    for (const e of list) {
      if (!inYear(e.at)) continue;
      if (e.type === "status" && e.to === "read") finished.push({ book: b, at: e.at, approx: !!e.approx });
      if (e.type === "status" && e.to === "abandoned" && b.status === "abandoned") aside.push({ book: b, at: e.at });
      if (e.type === "status" && e.to === "reading" && (e.from === "want" || e.from === "read")) begun++;
      if (e.type === "progress" && e.source === "app" && e.page > e.prevPage) { loggedPages += e.page - e.prevPage; loggedTokens += (e.page - e.prevPage) * tpp; days.add(localDayKey(e.at)); }
      if (e.type === "note") { if (!notesBy.has(b.id)) notesBy.set(b.id, []); notesBy.get(b.id).push(e); }
    }
  }
  finished.sort((a, b) => (a.at < b.at ? -1 : 1));
  aside.sort((a, b) => (a.at < b.at ? -1 : 1));
  for (const a of aside) a.colophon = colophon(a.book, byBook.get(a.book.id) || [], p);
  for (const f of finished) { f.e = effective(f.book); f.D = difficultyOf(f.book, p).D; f.colophon = colophon(f.book, byBook.get(f.book.id) || [], p); }
  const months = Array(12).fill(0);
  for (const f of finished) months[new Date(f.at).getMonth()]++;
  const withPages = finished.filter(f => f.e.pages);
  const pages = withPages.reduce((a, f) => a + f.e.pages, 0);
  const authors = new Map();
  for (const f of finished) if (f.e.author) authors.set(f.e.author, (authors.get(f.e.author) || 0) + 1);
  const topAuthor = [...authors.entries()].sort((a, b) => b[1] - a[1])[0];
  const longest = withPages.slice().sort((a, b) => b.e.pages - a.e.pages)[0] || null;
  const heaviest = finished.filter(f => f.book.score || f.book.mine?.difficulty != null).sort((a, b) => b.D - a.D)[0] || null;
  // the commonplace book for the year: your own lines for books finished in it, and its margin notes
  const lines = [];
  for (const f of finished) if (f.e.annotationIsMine && f.e.annotation) lines.push({ kind: "line", title: f.e.title, author: f.e.author, text: f.e.annotation, at: f.at });
  for (const [id, ns] of notesBy) { const e = effective(books.find(b => b.id === id)); for (const n of ns) lines.push({ kind: "note", title: e.title, author: e.author, text: n.text, page: n.page, at: n.at }); }
  lines.sort((a, b) => (a.at < b.at ? -1 : 1));
  // the year's letters: weeks (starting in the year) that have something to say
  const letters = [];
  const weeks = new Set();
  for (const b of books) for (const e of byBook.get(b.id) || []) if (e.source === "app" && inYear(e.at) && ["progress", "status", "note"].includes(e.type)) weeks.add(+weekStart(e.at));
  for (const t of [...weeks].sort((a, b) => a - b)) {
    const f = weekFacts({ books, byBook, p, start: new Date(t) });
    if (f.reading.length || f.finished.length || f.begun.length || f.aside.length || f.notes.length) letters.push({ start: new Date(t).toISOString(), facts: f });
  }
  const current = year === now.getFullYear();
  return {
    year, current, finished, aside, begun, pages, unknownPages: finished.length - withPages.length,
    loggedPages, loggedMinutes: loggedTokens * p.tau, loggedDays: days.size, months,
    authors: authors.size, topAuthor: topAuthor && topAuthor[1] > 1 ? { name: topAuthor[0], n: topAuthor[1] } : null,
    longest, heaviest, notesBy, lines, letters,
    inHand: current ? books.filter(b => b.status === "reading").length : null,
    waiting: current ? books.filter(b => b.status === "want").length : null,
  };
}

/** The year in a few sentences. */
export function yearSummary(y) {
  const n = y.finished.length;
  if (!n && !y.aside.length && !y.loggedPages) return [`Nothing was finished or logged in ${y.year}${y.current ? " yet" : ""}.`];
  const out = [];
  const so = y.current ? " so far" : "";
  out.push(`In ${y.year}${so} you finished ${n === 1 ? "one book" : `${inWords(n)} books`}${y.pages ? `, ${y.pages.toLocaleString("en-GB")} pages` : ""}${y.authors > 1 ? ` by ${inWords(y.authors)} authors` : ""}${y.aside.length ? `, and set ${y.aside.length === 1 ? "one" : inWords(y.aside.length)} aside` : ""}.`);
  const bits = [];
  if (y.longest && n > 1) bits.push(`The longest was <i>${esc(y.longest.e.title)}</i> (${y.longest.e.pages.toLocaleString("en-GB")} pages)`);
  if (y.heaviest && n > 1) bits.push(`${bits.length ? "the heaviest," : "The heaviest was"} <i>${esc(y.heaviest.e.title)}</i> (difficulty ${(Math.round(y.heaviest.D * 10) / 10).toFixed(1)})`);
  if (bits.length) out.push(bits.join("; ") + ".");
  if (y.topAuthor) out.push(`You read ${inWords(y.topAuthor.n)} books by ${esc(y.topAuthor.name)}.`);
  if (y.loggedPages) out.push(`Here you logged ${y.loggedPages.toLocaleString("en-GB")} pages on ${inWords(y.loggedDays)} ${y.loggedDays === 1 ? "day" : "days"}, about ${duration(y.loggedMinutes)} of reading.`);
  if (y.current) out.push(`At the time of printing, ${y.inHand === 1 ? "one book is" : `${inWords(y.inHand)} books are`} in hand and ${y.waiting.toLocaleString("en-GB")} wait on the list.`);
  return out;
}

/**
 * The whole document. opts: { reader, made (ISO), links (book links on screen), font }.
 * Every value from the library is escaped; only this module's own markup is raw.
 */
export function yearHtml(y, { reader = "", made = new Date().toISOString(), links = true } = {}) {
  const I = t => `<i>${esc(t)}</i>`;
  const title = f => (links ? `<a href="#/book/${esc(f.book.id)}">${I(f.e.title)}</a>` : I(f.e.title));
  const peak = Math.max(1, ...y.months);
  const sections = [];
  sections.push(`<section class="y-title">
    <p class="sc">Tsundoku Tracker</p>
    <h1>${reader ? `The Reading Year of ${esc(reader)}` : "A Reading Year"}</h1>
    <p class="y-num">${y.year}</p>
    <p class="y-sub">${y.finished.length === 1 ? "One book" : `${y.finished.length ? inWords(y.finished.length).replace(/^./, c => c.toUpperCase()) : "No"} books`} finished${y.current ? ", so far" : ""}</p>
  </section>`);
  const has = { aside: y.aside.length > 0, lines: y.lines.length > 0, letters: y.letters.length > 0 };
  sections.push(`<section class="y-contents"><h2 class="sc">Contents</h2><ol>
    <li>The year in figures</li><li>The books${y.finished.length ? `, nos. 1–${y.finished.length}` : ""}</li>
    ${has.aside ? "<li>Set aside</li>" : ""}${has.lines ? "<li>Commonplace book</li>" : ""}${has.letters ? "<li>Shelf letters</li>" : ""}<li>Colophon</li></ol></section>`);
  sections.push(`<section class="y-figures"><h2 class="sc">The year in figures</h2>
    ${yearSummary(y).map(s => `<p>${s}</p>`).join("")}
    <dl class="tomb">
      <dt>Finished</dt><dd>${y.finished.length}</dd>
      <dt>Pages</dt><dd>${y.pages.toLocaleString("en-GB")}${y.unknownPages ? ` (and ${y.unknownPages} without a count)` : ""}</dd>
      <dt>Begun</dt><dd>${y.begun}</dd>
      <dt>Set aside</dt><dd>${y.aside.length}</dd>
      ${y.loggedPages ? `<dt>Logged here</dt><dd>${y.loggedPages.toLocaleString("en-GB")} pages, about ${duration(y.loggedMinutes)}</dd>` : ""}
    </dl>
    <div class="y-months" role="img" aria-label="Books finished each month: ${y.months.map((n, i) => `${MONTHS[i]} ${n}`).join(", ")}">
      ${y.months.map((n, i) => `<span><i style="height:${((n / peak) * 100).toFixed(0)}%"></i><b>${MONTHS[i][0]}</b>${n ? `<em>${n}</em>` : ""}</span>`).join("")}
    </div></section>`);
  sections.push(`<section class="y-books"><h2 class="sc">The books</h2>
    ${y.finished.length ? y.finished.map((f, k) => {
      const quote = f.e.annotation ? `<blockquote>${esc(f.e.annotation)}${f.e.annotationIsMine ? "" : `<span class="y-src">most-liked quote on Goodreads</span>`}</blockquote>` : "";
      const notes = (y.notesBy.get(f.book.id) || []).map(n => `<li>${n.page ? `<span class="y-p">p. ${n.page}</span> ` : ""}${esc(n.text)}</li>`).join("");
      return `<article class="y-book">
        <p class="y-no sc">No. ${k + 1}</p>
        <h3>${title(f)}</h3>
        <p class="y-by sc">${esc(f.e.author)}${f.e.year ? ` · ${esc(f.e.year)}` : ""}</p>
        ${quote}
        ${colophonText(f.colophon, { ital: t => `<i>${t}</i>`, esc }).map(l => `<p>${l}</p>`).join("")}
        ${notes ? `<ul class="y-notes">${notes}</ul>` : ""}
      </article>`;
    }).join("") : `<p>None finished${y.current ? " yet" : ""}.</p>`}</section>`);
  if (has.aside) {
    sections.push(`<section class="y-aside"><h2 class="sc">Set aside</h2>
      <p class="y-intro">Books begun and put down. They belong to the year as much as the others.</p>
      ${y.aside.map(a => { const e = effective(a.book); const said = colophonText(a.colophon, { esc }).find(l => l.startsWith("Set aside")) || `Set aside ${dm(a.at)}.`;
        return `<p>${links ? `<a href="#/book/${esc(a.book.id)}">${I(e.title)}</a>` : I(e.title)}${e.author ? `, ${esc(e.author)}` : ""}. ${said.replace(" It keeps its place in the record.", "")}</p>`; }).join("")}</section>`);
  }
  if (has.lines) {
    sections.push(`<section class="y-commonplace"><h2 class="sc">Commonplace book</h2>
      ${y.lines.map(l => `<blockquote>${esc(l.text)}<span class="y-src">${I(l.title)}${l.author ? `, ${esc(l.author)}` : ""}${l.kind === "note" ? `${l.page ? `, p. ${l.page}` : ""} · ${dm(l.at)}` : ""}</span></blockquote>`).join("")}</section>`);
  }
  if (has.letters) {
    sections.push(`<section class="y-letters"><h2 class="sc">Shelf letters</h2>
      ${y.letters.map(l => `<article class="y-letter"><p class="sc y-week">The week of ${dm(l.start)}</p>${shelfLetter(l.facts, { ital: t => `<i>${t}</i>`, esc }).map(s => `<p>${s}</p>`).join("")}</article>`).join("")}</section>`);
  }
  const madeOn = new Date(made);
  sections.push(`<section class="y-colophon"><h2 class="sc">Colophon</h2>
    <p>${reader ? `Kept by ${esc(reader)}. ` : ""}Made with Tsundoku Tracker on ${madeOn.getDate()} ${MONTHS[madeOn.getMonth()]} ${madeOn.getFullYear()}, from the reader's own log.</p>
    <p>Dates marked as from Goodreads are as Goodreads recorded them; times and hours count only what was logged in the app. Difficulty is reading effort, not merit.</p>
    <p>Set in Source Serif 4, designed by Frank Grießhammer for Adobe, under the SIL Open Font License.</p></section>`);
  return `<div class="year">${sections.join("\n")}</div>`;
}
