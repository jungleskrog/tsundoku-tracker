// Fractional ordering keys: a book can move between two others by changing
// only its own key. Keys are base-62 strings compared as plain strings and
// never end in "0" (so there is always room between two keys).
const D = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function midpoint(a, b) {
  // a < b; a may be "", b may be null (meaning "the end")
  if (b !== null && a >= b) throw new Error(`keys out of order: ${a} >= ${b}`);
  if (b !== null) {
    let n = 0;
    while ((a[n] || "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? D.indexOf(a[0]) : 0;
  const db = b !== null ? D.indexOf(b[0]) : D.length;
  if (db - da > 1) return D[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return D[da] + midpoint(a.slice(1), null);
}

/** A key strictly between a and b (either may be null for start/end). */
export function keyBetween(a, b) {
  return midpoint(a || "", b || null);
}

/** n keys in order, all strictly between a and b, kept short by bisecting. */
export function keysBetween(a, b, n) {
  if (n <= 0) return [];
  const mid = keyBetween(a, b);
  const left = Math.floor((n - 1) / 2);
  return [...keysBetween(a, mid, left), mid, ...keysBetween(mid, b, n - 1 - left)];
}

export const compareKeys = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
