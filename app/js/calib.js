// Pace calibration (1.4). Timed reading sessions teach the model your own speeds.
// The model reads at v1 words a minute on the lightest prose (content difficulty 1) and
// v10 on the densest (10), log-linear between:  log v(C) = (1 − t)·log v1 + t·log v10, t = (C − 1)/9.
// Each session gives one observed speed at its book's C, so the two speeds are a small
// least-squares fit, held toward your current settings until there's enough evidence.
// Pure functions: no storage, no DOM.
import { effective } from "./domain.js";
import { WPP_RANGE, minutesPerPage, difficultyOf } from "./model.js";

export const MAX_MINUTES = 180;        // a timer left running longer than this is treated as forgotten
export const MIN_SESSIONS = 3;         // before the app suggests new speeds

/** All timed sessions: events of type "session" { minutes, fromPage, toPage, capped }. */
export function sessionsOf(books, byBook) {
  const out = [];
  for (const b of books) for (const e of byBook.get(b.id) || []) {
    if (e.type === "session" && e.minutes > 0) out.push({ ...e, pages: Math.max(0, (e.toPage || 0) - (e.fromPage || 0)) });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

/** What one session says: the speed (words a minute) at its book's content difficulty, or null if it can't say. */
export function observed(book, s) {
  const sc = book.score, pages = effective(book).pages;
  if (!sc || !sc.words || sc.C == null || !pages || s.capped || s.pages < 2 || s.minutes < 5) return null;
  const wpp = Math.min(WPP_RANGE[1], Math.max(WPP_RANGE[0], sc.words / pages));
  return { C: sc.C, wpp, v: (wpp * s.pages) / s.minutes, weight: Math.min(s.minutes, 90) / 30 };
}

/**
 * Your speeds from your sessions. Ridge least squares on (log v1, log v10), with your
 * current settings as the prior (worth `prior` half-hour sessions at each end).
 * Returns null without any usable session.
 */
export function calibrate(books, byBook, p, { prior = 2 } = {}) {
  const byId = new Map(books.map(b => [b.id, b]));
  const obs = sessionsOf(books, byBook).map(s => { const b = byId.get(s.bookId); return b && observed(b, s); }).filter(Boolean);
  if (!obs.length) return null;
  const x0 = [Math.log(p.v1), Math.log(p.v10)];
  // normal equations for y = (1−t)·x1 + t·x2, plus prior·(x − x0)²
  let a11 = prior, a12 = 0, a22 = prior, b1 = prior * x0[0], b2 = prior * x0[1], minutes = 0;
  for (const o of obs) {
    const t = (o.C - 1) / 9, w = o.weight, y = Math.log(o.v);
    a11 += w * (1 - t) * (1 - t); a12 += w * (1 - t) * t; a22 += w * t * t;
    b1 += w * (1 - t) * y; b2 += w * t * y;
    minutes += o.weight * 30;
  }
  const det = a11 * a22 - a12 * a12;
  let v1 = Math.exp((b1 * a22 - a12 * b2) / det), v10 = Math.exp((a11 * b2 - a12 * b1) / det);
  v1 = Math.round(Math.min(800, Math.max(100, v1)));
  v10 = Math.round(Math.min(Math.min(400, v1 - 10), Math.max(20, v10)));
  const Cs = obs.map(o => o.C);
  const spread = Math.max(...Cs) - Math.min(...Cs);
  const sure = obs.length >= 8 && spread >= 3 ? "good" : obs.length >= MIN_SESSIONS ? "fair" : "rough";
  return { v1, v10, n: obs.length, minutes: Math.round(minutes), spread, sure, ready: obs.length >= MIN_SESSIONS };
}

/** Your measured minutes a page in one book, beside the model's. */
export function bookPace(book, byBook, p) {
  const ss = sessionsOf([book], byBook).filter(s => !s.capped && s.pages > 0);
  if (!ss.length) return null;
  const minutes = ss.reduce((a, s) => a + s.minutes, 0), pages = ss.reduce((a, s) => a + s.pages, 0);
  return { mpp: minutes / pages, n: ss.length, minutes, pages, model: minutesPerPage(difficultyOf(book, p).D, p) };
}

/** Minutes between two instants, and whether that's longer than a session plausibly lasts. */
export function sessionLength(startIso, endIso) {
  const m = (new Date(endIso) - new Date(startIso)) / 60000;
  return { minutes: Math.max(0, Math.round(Math.min(m, MAX_MINUTES))), capped: m > MAX_MINUTES };
}
