// The library pages (Stage 7). Pure functions over the books and the event log:
//   colophon    — the record of one reading, set like a book's colophon
//   wallLabel   — a museum label for the waiting list: how much, how heavy, how long
//   shelfLetter — a weekly letter written from facts only (no AI), with some variation
//   commonplace — your own lines and margin notes, by year
import { effective, currentPage, bookDates, localDayKey } from "./domain.js";
import { difficultyOf, tokensPerPage } from "./model.js";

const DAY = 864e5;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ONES = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0–99 in words, larger numbers as digits. */
export function inWords(n) {
  n = Math.round(n);
  if (n < 0 || n > 99) return n.toLocaleString("en-GB");
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
}

/** A span of reading time, the way a person would say it. */
export function duration(minutes) {
  const m = Math.max(0, minutes);
  if (m < 7.5) return "a few minutes";
  if (m < 52.5) return `${inWords(Math.round(m / 5) * 5)} minutes`;
  const h = Math.round(m / 30) / 2;                       // nearest half hour
  if (h === 1) return "an hour";
  if (h === 1.5) return "an hour and a half";
  const whole = Math.floor(h);
  return `${inWords(whole)}${h % 1 ? " and a half" : ""} hours`;
}

const weekday = at => WEEKDAYS[new Date(at).getDay()];
const dayMonth = at => { const d = new Date(at); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const fullDate = at => { const d = new Date(at); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const daysBetween = (a, b) => Math.round((new Date(localDayKey(b)) - new Date(localDayKey(a))) / DAY);

/** Monday 00:00 (local) of the week holding `at`. */
export function weekStart(at) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

// --- Colophon -------------------------------------------------------------------------

/**
 * The facts of the latest reading of a book: when, how many sittings, how long,
 * the longest sitting. Progress entered in this app only; Goodreads dates are approximate.
 */
export function colophon(book, bookEvents, p) {
  const e = effective(book), d = bookDates(bookEvents);
  const D = difficultyOf(book, p).D, tpp = tokensPerPage(D, p);
  const since = d.started || null;
  const progress = bookEvents.filter(x => x.type === "progress" && x.source === "app" && (!since || x.at >= since));
  const byDay = new Map();
  for (const x of progress) byDay.set(localDayKey(x.at), (byDay.get(localDayKey(x.at)) || 0) + (x.page - x.prevPage));
  let longest = null;
  for (const [day, pages] of byDay) if (pages > 0 && (!longest || pages > longest.pages)) longest = { day, pages };
  const pagesHere = [...byDay.values()].reduce((a, b) => a + Math.max(0, b), 0);
  const tokens = pagesHere * tpp;
  const approx = bookEvents.some(x => x.type === "status" && x.approx && (x.to === "read" || x.to === "abandoned"));
  const ended = book.status === "abandoned" ? [...bookEvents].reverse().find(x => x.type === "status" && x.to === "abandoned")?.at || null : d.finished;
  return {
    title: e.title, author: e.author, edition: e.edition, publisher: book.synced?.publisher || null, pages: e.pages,
    status: book.status, started: d.started, finished: ended, page: currentPage(bookEvents),
    days: d.started && ended ? daysBetween(d.started, ended) + 1 : null,
    sittings: [...byDay.values()].filter(x => x > 0).length, pagesHere, tokens, minutes: tokens * p.tau, D,
    longest: longest && { ...longest, at: new Date(longest.day + "T12:00:00").toISOString() }, approx,
  };
}

/** The colophon as sentences. `ital` sets a title, `esc` makes text safe. */
export function colophonText(c, { ital = t => t, esc = t => t } = {}) {
  const out = [];
  const set = [c.edition, c.publisher].filter(Boolean).map(esc).join(", ");
  if (set) out.push(`Read in the ${set} edition${c.pages ? `, ${c.pages.toLocaleString("en-GB")} pages` : ""}.`);
  else if (c.pages) out.push(`${c.pages.toLocaleString("en-GB")} pages.`);
  if (c.status === "abandoned") {
    const at = c.page && c.pages ? `at page ${c.page} of ${c.pages} (${Math.round((c.page / c.pages) * 100)}%)` : c.page ? `at page ${c.page}` : "before a page was logged";
    out.push(`Set aside${c.finished ? ` on ${fullDate(c.finished)}` : ""} ${at}${c.sittings ? `, after ${inWords(c.sittings)} ${c.sittings === 1 ? "sitting" : "sittings"}` : ""}. It keeps its place in the record.`);
    return out;
  }
  if (c.approx && !c.sittings) {
    out.push(c.finished ? `Finished ${fullDate(c.finished)}, as recorded on Goodreads.` : "Finished before this record began.");
    return out;
  }
  const span = c.started && c.finished
    ? c.days === 1 ? `Begun and finished on ${fullDate(c.finished)}` : `Begun ${fullDate(c.started)} and finished ${fullDate(c.finished)}: ${inWords(c.days)} days`
    : c.finished ? `Finished ${fullDate(c.finished)}` : "";
  const effort = c.sittings ? `in ${inWords(c.sittings)} ${c.sittings === 1 ? "sitting" : "sittings"}, about ${duration(c.minutes)} of reading (${Math.round(c.tokens)} tokens) at difficulty ${Math.round(c.D * 10) / 10}` : "";
  if (span || effort) out.push(`${[span, effort].filter(Boolean).join(", ")}.`);
  if (c.longest && c.sittings > 1) out.push(`The longest sitting: ${c.longest.pages} pages, on ${weekday(c.longest.at)} ${dayMonth(c.longest.at)}.`);
  return out;
}

// --- Wall label ------------------------------------------------------------------------

export const WEIGHTS = [["light", 0, 3.5], ["middling", 3.5, 6.5], ["heavy", 6.5, 11]];

/** How much, how heavy and how long: for a stretch of the waiting list. */
export function measure(books, p) {
  let pages = 0, tokens = 0, unknown = 0;
  const Ds = [], weights = { light: 0, middling: 0, heavy: 0 }, hist = Array(10).fill(0);
  for (const b of books) {
    const D = difficultyOf(b, p).D, n = effective(b).pages;
    Ds.push(D);
    hist[Math.min(9, Math.max(0, Math.round(D) - 1))]++;
    weights[WEIGHTS.find(([, lo, hi]) => D >= lo && D < hi)[0]]++;
    if (n) { pages += n; tokens += n * tokensPerPage(D, p); } else unknown++;
  }
  const sorted = Ds.slice().sort((a, b) => a - b);
  const median = sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : null;
  const mean = Ds.length ? Ds.reduce((a, b) => a + b, 0) / Ds.length : null;
  return { count: books.length, pages, tokens, hours: (tokens * p.tau) / 60, unknown, median, mean, weights, hist };
}

/** The waiting list's label: the whole, its three stretches, and how Next compares. */
export function wallLabel(waiting, bands, p) {
  const next = waiting.slice(0, bands.next), soon = waiting.slice(bands.next, bands.next + bands.soon), stacks = waiting.slice(bands.next + bands.soon);
  const all = measure(waiting, p);
  const parts = { next: measure(next, p), soon: measure(soon, p), stacks: measure(stacks, p) };
  let compare = null;
  if (next.length && all.count > next.length) {
    const gap = parts.next.mean - all.mean;
    const n = next.length === 1 ? "The next book is" : `The next ${inWords(next.length)} are`;
    compare = gap > 0.7 ? `${n} heavier than the list as a whole (difficulty ${fmt(parts.next.mean)} against ${fmt(all.mean)}).`
      : gap < -0.7 ? `${n} lighter than the list as a whole (difficulty ${fmt(parts.next.mean)} against ${fmt(all.mean)}).`
      : `${n} about as heavy as the list as a whole.`;
  }
  return { all, parts, compare };
}
const fmt = x => (Math.round(x * 10) / 10).toFixed(1);

// --- Shelf letter -------------------------------------------------------------------------

/** What happened in the week starting `start` (a Monday). */
export function weekFacts({ books, byBook, p, start }) {
  const from = new Date(start).toISOString(), to = new Date(+new Date(start) + 7 * DAY).toISOString();
  const inWeek = e => e.at >= from && e.at < to;
  const reading = [], finished = [], begun = [], aside = [], notes = [];
  let pages = 0, tokens = 0;
  const days = new Set();
  for (const b of books) {
    const list = byBook.get(b.id) || [];
    const tpp = tokensPerPage(difficultyOf(b, p).D, p);
    const prog = list.filter(e => e.type === "progress" && e.source === "app" && inWeek(e) && e.page > e.prevPage);
    if (prog.length) {
      const bookDays = new Set(prog.map(e => localDayKey(e.at)));
      const n = prog.reduce((a, e) => a + e.page - e.prevPage, 0);
      bookDays.forEach(d => days.add(d));
      reading.push({ id: b.id, title: effective(b).title, pages: n, tokens: n * tpp, minutes: n * tpp * p.tau, days: bookDays.size, hours: prog.map(e => new Date(e.at).getHours()), lastDay: prog.at(-1).at });
      pages += n; tokens += n * tpp;
    }
    for (const e of list.filter(e => e.type === "status" && inWeek(e) && !e.approx)) {
      const item = { id: b.id, title: effective(b).title, at: e.at };
      if (e.to === "read") finished.push(item);
      if (e.to === "reading" && (e.from === "want" || e.from === "read")) begun.push(item);
      if (e.to === "abandoned") aside.push({ ...item, page: currentPage(list.filter(x => x.at <= e.at)) });
    }
    for (const e of list.filter(e => e.type === "note" && inWeek(e))) notes.push({ id: b.id, title: effective(b).title, text: e.text, page: e.page, at: e.at });
  }
  reading.sort((a, b) => b.tokens - a.tokens);
  return { start: from, reading, finished, begun, aside, notes, pages, tokens, minutes: tokens * p.tau, days: days.size };
}

const partOfDay = hours => {
  const c = { morning: 0, afternoon: 0, evening: 0 };
  for (const h of hours) c[h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : "evening"]++;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
};

/** "most evenings", "on three mornings", "on Tuesday" … */
function often(r) {
  const part = partOfDay(r.hours);
  if (r.days >= 7) return `every ${part}`;
  if (r.days >= 5) return `most ${part}s`;
  if (r.days >= 2) return `on ${inWords(r.days)} ${part}s`;
  return `on ${weekday(r.lastDay)} ${part}`;
}

/** Month phrase for a date: "mid-December", "the end of January 2027". */
export function monthPhrase(date, now) {
  const d = new Date(date), m = MONTHS[d.getMonth()] + (d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : "");
  return d.getDate() <= 10 ? `early ${m}` : d.getDate() <= 20 ? `mid-${m}` : `the end of ${m}`;
}

const pick = (seed, options) => options[seed % options.length];
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/**
 * The letter itself: a few sentences from the week's facts. `outlook` (only for the
 * latest week) adds where the books in hand are heading and what waits next:
 *   { inHand: [{ title, finishAt, page }], next: title|null, now }
 */
export function shelfLetter(f, { outlook = null, ital = t => t, esc = t => t } = {}) {
  const seed = hash(f.start);
  const I = t => ital(esc(t));
  const out = [];
  const perDay = r => duration(r.minutes / Math.max(1, r.days));   // minutes on an average reading day
  const gave = f.reading.slice(0, 2).map((r, k) => `${k ? "" : "about "}${perDay(r)} ${often(r)} to ${I(r.title)}`);
  const fin = f.finished.map(x => `${I(x.title)} on ${weekday(x.at)}`);
  const finText = fin.length ? `finished ${fin.slice(0, -1).join(", ")}${fin.length > 1 ? " and " : ""}${fin.at(-1)}` : "";
  if (gave.length) {
    const body = gave.join(", and ");
    out.push(pick(seed, [
      `This week you gave ${body}${finText ? `, and ${finText}` : ""}.`,
      `You gave ${body} this week${finText ? `, and ${finText}` : ""}.`,
      `The week went to reading: ${body}${finText ? `. You ${finText}` : ""}.`,
    ]));
  } else if (finText) {
    out.push(`This week you ${finText}.`);
  } else {
    out.push(pick(seed, ["A quiet week on the shelves: no pages logged.", "No pages were logged this week; the books kept their places.", "A week away from the page."]));
  }
  for (const x of f.begun) out.push(pick(seed + 1, [`You opened ${I(x.title)} on ${weekday(x.at)}.`, `${I(x.title)} was begun on ${weekday(x.at)}.`]));
  for (const x of f.aside) out.push(`${I(x.title)} was set aside on ${weekday(x.at)}${x.page ? `, at page ${x.page}` : ""}; it keeps its place in the record.`);
  if (f.notes.length) {
    const n = f.notes[0];
    const text = n.text.length > 140 ? n.text.slice(0, 137).trimEnd() + "…" : n.text;
    out.push(`In the margin of ${I(n.title)}${n.page ? `, at page ${n.page},` : ""} you wrote: “${esc(text)}”${f.notes.length > 1 ? ` (and ${inWords(f.notes.length - 1)} more ${f.notes.length === 2 ? "note" : "notes"})` : ""}.`);
  }
  if (outlook) {
    const lead = outlook.inHand.find(b => b.finishAt) || null;
    const bits = [];
    if (lead) {
      const days = (new Date(lead.finishAt) - new Date(outlook.now)) / DAY;
      bits.push(days <= 6 ? `at the present rate ${I(lead.title)} should be finished by ${weekday(lead.finishAt)}`
        : `at the present rate ${I(lead.title)} will see you to ${monthPhrase(lead.finishAt, outlook.now)}`);
    } else if (!gave.length && outlook.inHand[0]) {
      bits.push(`${I(outlook.inHand[0].title)} waits${outlook.inHand[0].page ? ` at page ${outlook.inHand[0].page}` : ""}`);
    }
    if (outlook.next) bits.push(`${I(outlook.next)} waits next on the desk`);
    if (bits.length) out.push(bits.join("; ").replace(/^./, c => c.toUpperCase()) + ".");
  }
  return out;
}

/** The weeks that have something to say, newest first, from `first` to `now`. */
export function letterWeeks(events, now) {
  const weeks = new Set();
  for (const e of events) if (e.source === "app" && (e.type === "progress" || e.type === "status" || e.type === "note")) weeks.add(+weekStart(e.at));
  weeks.add(+weekStart(now));
  return [...weeks].sort((a, b) => b - a).map(t => new Date(t));
}

// --- Commonplace book -------------------------------------------------------------------------

/** Your own lines (annotations you wrote) and margin notes, grouped by year, oldest first within it. */
export function commonplace(books, byBook) {
  const items = [];
  for (const b of books) {
    const e = effective(b), list = byBook.get(b.id) || [];
    if (e.annotationIsMine && e.annotation) {
      const d = bookDates(list);
      items.push({ kind: "line", id: b.id, title: e.title, author: e.author, text: e.annotation, at: d.finished || b.updatedAt || b.createdAt });
    }
    for (const n of list.filter(x => x.type === "note")) items.push({ kind: "note", id: b.id, title: e.title, author: e.author, text: n.text, page: n.page, at: n.at, eventId: n.id });
  }
  items.sort((a, b) => (a.at < b.at ? -1 : 1));
  const years = new Map();
  for (const it of items) {
    const y = new Date(it.at).getFullYear();
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(it);
  }
  return [...years.entries()].sort((a, b) => b[0] - a[0]);
}
