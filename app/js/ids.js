// ULIDs: 26-char, time-sortable, made locally. Used for every record id.
const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRand = [];

function randomDigits(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b % 32);
}

export function ulid(time = Date.now()) {
  let rand;
  if (time === lastTime) {
    // same millisecond: increment so ids stay strictly ordered
    rand = lastRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) { rand[i]++; break; }
      rand[i] = 0;
    }
  } else {
    rand = randomDigits(16);
  }
  lastTime = time;
  lastRand = rand;
  let t = "";
  let x = time;
  for (let i = 0; i < 10; i++) { t = ENC[x % 32] + t; x = Math.floor(x / 32); }
  return t + rand.map(d => ENC[d]).join("");
}

export const bookId = () => "b_" + ulid();
export const eventId = () => "e_" + ulid();
