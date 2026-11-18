// Small text helpers for the interface.
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...values) {
  return raw(strings.reduce((out, s, i) => {
    const v = values[i - 1];
    const text = v == null || v === false ? "" : Array.isArray(v) ? v.map(x => (x && x.__raw ? x.__raw : esc(x))).join("") : v.__raw ?? esc(v);
    return out + text + s;
  }));
}
/** Markup that is already safe; prints as itself. */
export const raw = s => ({ __raw: String(s), toString() { return this.__raw; } });
export const join = parts => raw(parts.map(p => (p && p.__raw ? p.__raw : esc(p))).join(""));

const long = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const short = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export const longDate = d => long.format(new Date(d)).replace(",", "");
export const shortDate = d => (d ? short.format(new Date(d)) : "");
export const timeOf = d => time.format(new Date(d));

export function relativeDay(at, now = new Date()) {
  const a = new Date(at), b = new Date(now);
  const day = x => Math.floor((new Date(x.getFullYear(), x.getMonth(), x.getDate())) / 864e5);
  const diff = day(b) - day(a);
  if (diff === 0) return `today at ${timeOf(a)}`;
  if (diff === 1) return `yesterday at ${timeOf(a)}`;
  return shortDate(a);
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export const words = n => (n >= 0 && n < WORDS.length ? WORDS[n] : String(n));
export const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
