// The model (architecture note §7–§9): tokens <-> difficulty <-> pages,
// learned shares, the day-by-day forecast, the 28-day ledger, and phrasing
// that is only as precise as the estimate. Pure functions; no storage, no DOM.
import { effective, currentPage, localDayKey, byQueue } from "./domain.js";

const DAY = 864e5;

// --- Tokens, difficulty, pages ------------------------------------------------------

export function params(settings) {
  const m = settings.model || {};
  return { tau: settings.minutesPerToken || 4, v1: m.v1 || 300, v10: m.v10 || 75, emin: m.emin || 0.75, emax: m.emax || 6 };
}

/** Reading speed (words a minute) for content difficulty C (1–10). */
export const speed = (C, p) => p.v1 * Math.pow(p.v10 / p.v1, (C - 1) / 9);

/** Nominal minutes a page for page difficulty D. */
export const minutesPerPage = (D, p) => p.emin * Math.pow(p.emax / p.emin, (D - 1) / 9);

/** Page difficulty from the AI's word estimate and content score, and your page count. */
export function pageDifficulty({ words, pages, C }, p) {
  const E = words / pages / speed(C, p);
  const D = 1 + (9 * Math.log(E / p.emin)) / Math.log(p.emax / p.emin);
  return Math.min(10, Math.max(1, D));
}

export const tokensPerPage = (D, p) => minutesPerPage(D, p) / p.tau;
export const pagesPerToken = (D, p) => p.tau / minutesPerPage(D, p);

/** A book's difficulty and where it came from: yours, the AI's, or a provisional 5. */
export function difficultyOf(book, p) {
  if (book.mine && book.mine.difficulty != null) return { D: +book.mine.difficulty, source: "yours" };
  const s = book.score;
  if (s && s.words && s.C != null) {
    const { pages } = effective(book);
    if (pages) return { D: pageDifficulty({ words: s.words, pages, C: s.C }, p), source: "ai", score: s };
  }
  if (s && s.D != null) return { D: s.D, source: "ai", score: s };
  return { D: 5, source: "provisional" };
}

// --- History: tokens earned ---------------------------------------------------------

/** Tokens earned by each in-app progress entry, at the book's current difficulty. */
export function earnings(books, byBook, p) {
  const out = [];
  for (const b of books) {
    const list = byBook.get(b.id);
    if (!list) continue;
    const tpp = tokensPerPage(difficultyOf(b, p).D, p);
    for (const e of list) {
      if (e.type === "progress" && e.source === "app") out.push({ bookId: b.id, at: e.at, day: localDayKey(e.at), tokens: (e.page - e.prevPage) * tpp, pages: e.page - e.prevPage });
    }
  }
  return out;
}

const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

/**
 * Learned shares of the daily budget among books in hand (§8):
 * tokens earned over the last 14 days, halving in weight every 7 days,
 * every book at least 10% of an even share; even shares before 14 days of history.
 */
export function learnedShares(bookIds, earned, now, { windowDays = 14, halfLife = 7, floor = 0.1, firstUse = null } = {}) {
  const n = bookIds.length;
  const shares = new Map();
  if (!n) return shares;
  const even = () => { for (const id of bookIds) shares.set(id, 1 / n); return shares; };
  if (!firstUse || dayDiff(firstUse, now) < windowDays) return even();
  const w = new Map(bookIds.map(id => [id, 0]));
  for (const e of earned) {
    if (!w.has(e.bookId)) continue;
    const age = dayDiff(e.at, now);
    if (age < 0 || age >= windowDays) continue;
    w.set(e.bookId, w.get(e.bookId) + Math.max(0, e.tokens) * Math.pow(0.5, age / halfLife));
  }
  const total = [...w.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return even();
  const min = floor / n;
  const raw = bookIds.map(id => [id, Math.max(min, w.get(id) / total)]);
  const sum = raw.reduce((a, [, v]) => a + v, 0);
  for (const [id, v] of raw) shares.set(id, v / sum);
  return shares;
}

// --- The forecast ---------------------------------------------------------------------

/**
 * Pour each day's tokens into the books in hand until everything is placed.
 * Returns per book: { finish (days from start of today, fractional), start, todayTokens, share }.
 */
export function forecast({ books, byBook, settings, now, earnedToday = 0, earnedTodayBy = null, shares: givenShares = null, earned = [], firstUse = null }) {
  const p = params(settings);
  const goal = settings.dailyTokens || 0;
  const mask = settings.readingDays || [1, 1, 1, 1, 1, 1, 1];
  const result = new Map();
  const rem = new Map(), tpp = new Map();
  const doneIds = new Set(books.filter(b => b.status === "read").map(b => b.id));

  for (const b of books) {
    const { pages } = effective(b);
    const cur = currentPage(byBook.get(b.id));
    const D = difficultyOf(b, p).D;
    tpp.set(b.id, tokensPerPage(D, p));
    if (b.status === "read" || b.status === "abandoned") continue;
    if (!pages) { result.set(b.id, { unknown: true }); continue; }
    rem.set(b.id, Math.max(0, pages - cur) * tpp.get(b.id));
  }

  let active = books.filter(b => b.status === "reading" && rem.has(b.id)).map(b => b.id);
  const queue = books.filter(b => b.status === "want" && rem.has(b.id)).sort(byQueue).map(b => b.id);
  const prereqs = new Map(books.map(b => [b.id, b.prereqs || []]));
  const pins = new Map(books.filter(b => b.sharePin != null && b.status === "reading").map(b => [b.id, b.sharePin]));
  const concurrency = settings.concurrency === "auto" || !settings.concurrency
    ? Math.max(1, books.filter(b => b.status === "reading").length) : +settings.concurrency;

  let shares = givenShares ? new Map(givenShares) : learnedShares(active.filter(id => !pins.has(id)), earned, now, { firstUse });
  for (const id of active) result.set(id, { start: null, share: shares.get(id) ?? 0, todayTokens: 0, pinned: pins.has(id) });

  const finished = id => doneIds.has(id);
  const eligible = id => prereqs.get(id).every(finished);
  const startNext = day => {
    while (active.length < concurrency) {
      const i = queue.findIndex(eligible);
      if (i < 0) return;
      const id = queue.splice(i, 1)[0];
      const n = active.filter(x => !pins.has(x)).length + 1;
      for (const [k, v] of shares) shares.set(k, v * (1 - 1 / n));
      shares.set(id, 1 / n);
      active.push(id);
      result.set(id, { start: day, share: 1 / n, todayTokens: 0, pinned: false });
    }
  };
  const finish = (id, at) => {
    active = active.filter(x => x !== id);
    doneIds.add(id);
    result.get(id).finish = at;
    const s = shares.get(id) || 0;
    shares.delete(id);
    const left = 1 - s;
    if (left > 0) for (const [k, v] of shares) shares.set(k, v / left);
  };
  // books already at their last page finish now
  for (const id of [...active]) if (rem.get(id) <= 1e-9) finish(id, 0);
  startNext(0);

  const today = startOfDay(now);
  const HORIZON = 7300;
  for (let d = 0; d < HORIZON && (active.length || queue.some(eligible)); d++) {
    if (!active.length) startNext(d);
    if (!active.length) break;
    const weekday = (addDays(today, d).getDay() + 6) % 7; // Monday = 0
    const full = goal * (mask[weekday] ? 1 : 0);
    let budget = d === 0 ? Math.max(0, full - earnedToday) : full;
    const dayBudget = budget || 1;
    let spent = 0;
    let pinLeft = new Map([...pins].filter(([id]) => active.includes(id)));
    if (d === 0 && earnedTodayBy) {
      // Today: each book's share of the whole day, minus what you've already read of it.
      // Reading beyond a book's share comes out of the others; a book that's met its share is done for today.
      const pinTotal = active.reduce((a, id) => a + (pins.get(id) || 0), 0);
      const unpinned = active.filter(id => !pins.has(id));
      const shareSum = unpinned.reduce((a, id) => a + (shares.get(id) || 0), 0) || 1;
      const target = new Map(active.map(id => [id, pins.has(id) ? pins.get(id) : Math.max(0, full - pinTotal) * ((shares.get(id) || 0) / shareSum)]));
      const left = new Map(active.map(id => [id, Math.max(0, target.get(id) - (earnedTodayBy.get(id) || 0))]));
      const leftSum = [...left.values()].reduce((a, b) => a + b, 0);
      const scale = leftSum > 0 ? Math.min(1, budget / leftSum) : 0;
      pinLeft = new Map([...left].map(([id, v]) => [id, v * scale]));
      budget = [...pinLeft.values()].reduce((a, b) => a + b, 0);
    }
    let guard = 0;
    while (budget > 1e-9 && active.length && guard++ < 1000) {
      // this round's allocation: pins first, the rest by share
      const alloc = new Map();
      let pinned = 0;
      for (const [id, t] of pinLeft) if (active.includes(id)) { const a = Math.min(t, budget - pinned); if (a > 0) { alloc.set(id, a); pinned += a; } }
      const free = budget - pinned;
      const unpinned = active.filter(id => !pins.has(id) && !(d === 0 && earnedTodayBy && pinLeft.has(id)));
      const shareSum = unpinned.reduce((a, id) => a + (shares.get(id) || 0), 0);
      for (const id of unpinned) alloc.set(id, free * ((shares.get(id) || 0) / (shareSum || 1)));
      const total = [...alloc.values()].reduce((a, b) => a + b, 0);
      if (total <= 1e-9) break;
      // first book to finish within this round
      let t = 1, first = null;
      for (const [id, a] of alloc) if (a > 0 && rem.get(id) / a < t) { t = rem.get(id) / a; first = id; }
      for (const [id, a] of alloc) {
        rem.set(id, rem.get(id) - a * t);
        if (d === 0) result.get(id).todayTokens += a * t;
        if (pinLeft.has(id)) pinLeft.set(id, pinLeft.get(id) - a * t);
      }
      spent += total * t;
      budget -= total * t;
      if (first) {
        finish(first, d + Math.min(1, spent / dayBudget));
        for (const id of [...active]) if (rem.get(id) <= 1e-9) finish(id, d + Math.min(1, spent / dayBudget));
        startNext(d);
      } else break;
    }
  }
  for (const [id, r] of result) if (!r.unknown && r.finish == null && rem.has(id)) r.beyond = true;
  for (const [id, r] of result) r.tpp = tpp.get(id);
  return result;
}

// --- Uncertainty and time of day --------------------------------------------------

const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * q; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };

/** How much faster/slower than average your weeks run: [lo, hi] multipliers. */
export function paceSpread(earned, now, firstUse) {
  const days = firstUse ? Math.min(56, dayDiff(firstUse, now)) : 0;
  if (days < 14) return { lo: 0.7, hi: 1.3, measured: false };
  const perDay = new Array(days).fill(0);
  for (const e of earned) { const age = dayDiff(e.at, now) - 1; if (age >= 0 && age < days) perDay[age] += e.tokens; }
  const rolling = [];
  for (let i = 0; i + 7 <= days; i++) rolling.push(perDay.slice(i, i + 7).reduce((a, b) => a + b, 0) / 7);
  const mean = rolling.reduce((a, b) => a + b, 0) / rolling.length;
  if (mean <= 0) return { lo: 0.7, hi: 1.3, measured: false };
  return { lo: Math.min(0.95, Math.max(0.3, pct(rolling, 0.1) / mean)), hi: Math.max(1.05, Math.min(2.5, pct(rolling, 0.9) / mean)), measured: true };
}

const BANDS = [["morning", 5, 12], ["afternoon", 12, 17], ["evening", 17, 23], ["night", 23, 29]];

/** The part of the day you usually read in, if there is a clear one. */
export function readingBand(earned, now) {
  const recent = earned.filter(e => dayDiff(e.at, now) < 56);
  if (recent.length < 10) return null;
  const count = new Map();
  for (const e of recent) {
    const h = new Date(e.at).getHours();
    const band = BANDS.find(([, a, b]) => (h >= a && h < b) || (h + 24 >= a && h + 24 < b));
    count.set(band[0], (count.get(band[0]) || 0) + 1);
  }
  const [best, n] = [...count].sort((a, b) => b[1] - a[1])[0];
  return n / recent.length >= 0.6 ? best : null;
}

// --- Phrasing ------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORD = ["first", "second", "third", "fourth", "last"];

function season(date) {
  const m = date.getMonth(), y = date.getFullYear();
  if (m >= 2 && m <= 4) return `spring ${y}`;
  if (m >= 5 && m <= 7) return `summer ${y}`;
  if (m >= 8 && m <= 10) return `autumn ${y}`;
  return m === 11 ? `winter ${y}–${String(y + 1).slice(2)}` : `winter ${y - 1}–${String(y).slice(2)}`;
}

/**
 * Words for "when", sized to the uncertainty. center/early/late are days from
 * the start of today (fractional). Returns { phrase, short }.
 */
export function phraseWhen(center, early, late, now, band = null) {
  const today = startOfDay(now);
  const on = d => addDays(today, Math.floor(d));
  const c = on(center), e = on(early), l = on(late);
  const dayName = (dt, i) => (i === 0 ? "today" : i === 1 ? "tomorrow" : i < 7 ? `on ${WEEKDAYS[dt.getDay()]}` : `on ${WEEKDAYS[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()]}`);
  const yearOf = dt => (dt.getFullYear() !== today.getFullYear() ? ` ${dt.getFullYear()}` : "");
  const span = late - early;
  const ie = Math.floor(early), il = Math.floor(late), ic = Math.floor(center);

  if (ie === il) {
    const base = dayName(c, ic);
    if (band && span < 1) {
      if (ic === 0) return { phrase: band === "night" ? "tonight" : `this ${band}`, short: band === "night" ? "tonight" : `this ${band}` };
      if (ic === 1) return { phrase: `tomorrow ${band === "night" ? "night" : band}`, short: `tomorrow ${band}` };
      return { phrase: `${base} ${band}`, short: `${base.replace(/^on /, "")} ${band}` };
    }
    return { phrase: base, short: base.replace(/^on /, "") };
  }
  if (il < 7 && il - ie <= 2) {
    const a = dayName(e, ie).replace(/^on /, ""), b = dayName(l, il).replace(/^on /, "");
    return { phrase: ie >= 2 ? `on ${a} or ${b}` : `${a} or ${b}`, short: `${a} or ${b}` };
  }
  if (span <= 21) {
    if (ic < 7 - ((today.getDay() + 6) % 7)) return { phrase: "this week", short: "this week" };
    const wk = ORD[Math.min(4, Math.ceil(c.getDate() / 7) - 1)];
    return { phrase: `in the ${wk} week of ${MONTHS[c.getMonth()]}${yearOf(c)}`, short: `${wk} week of ${MONTHS[c.getMonth()].slice(0, 3)}${yearOf(c)}` };
  }
  if (span <= 60) {
    const part = c.getDate() <= 10 ? "early" : c.getDate() <= 20 ? "mid" : "late";
    return { phrase: `in ${part} ${MONTHS[c.getMonth()]}${yearOf(c)}`, short: `${part} ${MONTHS[c.getMonth()].slice(0, 3)}${yearOf(c)}` };
  }
  if (center < 730) return { phrase: `in ${season(c)}`, short: season(c) };
  return { phrase: `in ${c.getFullYear()}`, short: String(c.getFullYear()) };
}

/** Apply the pace spread to a forecast day count and phrase it. */
export function when(days, spread, now, band) {
  if (days == null) return null;
  return phraseWhen(days, days / spread.hi, days / spread.lo, now, band);
}

// --- The ledger ---------------------------------------------------------------------

/** Goal in force on a given local day, from goal events (else the current setting). */
function goalOn(dayKey, goals, fallback) {
  let g = null;
  for (const e of goals) if (localDayKey(e.at) <= dayKey) g = e.dailyTokens;
  return g ?? fallback;
}

/**
 * Tokens earned minus tokens planned over the last 28 days (§9). Today counts
 * what you've read but plans nothing until it's over, so it never starts behind.
 */
export function ledger({ earned, events, settings, now, firstUse, windowDays = 28 }) {
  if (!firstUse) return null;
  const goals = events.filter(e => e.type === "goal").sort((a, b) => (a.at < b.at ? -1 : 1));
  const mask = settings.readingDays || [1, 1, 1, 1, 1, 1, 1];
  const today = startOfDay(now);
  const from = Math.min(windowDays - 1, dayDiff(firstUse, now));
  let planned = 0;
  for (let i = from; i >= 1; i--) {
    const d = addDays(today, -i);
    const key = localDayKey(d);
    planned += goalOn(key, goals, settings.dailyTokens) * (mask[(d.getDay() + 6) % 7] ? 1 : 0);
  }
  const startKey = localDayKey(addDays(today, -from));
  const todayKey = localDayKey(today);
  let got = 0, todayTokens = 0;
  for (const e of earned) {
    if (e.day >= startKey && e.day <= todayKey) got += e.tokens;
    if (e.day === todayKey) todayTokens += e.tokens;
  }
  return { earned: got, planned, balance: got - planned, todayTokens, days: from + 1 };
}

/** First day the app was used: earliest in-app progress or goal entry. */
export function firstUseOf(events) {
  let first = null;
  for (const e of events) if (e.source === "app" && (e.type === "progress" || e.type === "goal") && (!first || e.at < first)) first = e.at;
  return first;
}

/** "A little ahead: 6 tokens, about 9 pages of Ulysses." */
export function ledgerWords(l, goal, refTitle, refTpp) {
  if (!l) return null;
  const b = l.balance, mag = Math.abs(b);
  const pages = refTpp ? Math.round(mag / refTpp) : null;
  const eq = pages && refTitle ? `, about ${pages} ${pages === 1 ? "page" : "pages"} of ${refTitle}` : "";
  if (mag < 0.5 * goal) return { tone: "even", text: "On course." };
  const days = Math.round(mag / goal);
  const size = mag < 2 * goal ? "A little" : `About ${days} days' reading`;
  const dir = b > 0 ? "ahead" : "behind";
  const tokens = `${Math.round(mag)} ${Math.round(mag) === 1 ? "token" : "tokens"}`;
  return { tone: dir, text: mag < 2 * goal ? `${size} ${dir}: ${tokens}${eq}.` : `${size} ${dir}: ${tokens}${eq}.` };
}
