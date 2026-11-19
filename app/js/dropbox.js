// Sync through the reader's own Dropbox (Stage 10). No server: the app signs in with
// Dropbox's OAuth "PKCE" flow (no secret in the code), keeps one file in its own app
// folder (Apps/<app name>/library.json), and merges it with the library on each device.
//   signInUrl / finishSignIn / refreshToken — OAuth
//   download / upload                       — the library file, with Dropbox's revision for safe writes
//   syncOnce                                — download, merge, write back only if needed; retries on a clash
const AUTH = "https://www.dropbox.com/oauth2/authorize";
const TOKEN = "https://api.dropboxapi.com/oauth2/token";
const CONTENT = "https://content.dropboxapi.com/2/files";
export const FILE = "/library.json";

let http = (...a) => fetch(...a);
/** Tests swap in a fake Dropbox. */
export const setFetch = f => { http = f; };

export class Conflict extends Error {}
export class SignedOut extends Error {}

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

/**
 * Start signing in. With a redirect, Dropbox sends the reader back with ?code=…;
 * without one (an iPhone home-screen app can't be returned to), Dropbox shows a code to paste.
 * Returns { url, pending } — keep `pending` until the code comes back.
 */
export async function signInUrl(appKey, redirect = null) {
  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = randomString(12);
  const q = new URLSearchParams({ client_id: appKey, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", token_access_type: "offline" });
  if (redirect) { q.set("redirect_uri", redirect); q.set("state", state); }
  return { url: `${AUTH}?${q}`, pending: { verifier, state, redirect, appKey, at: Date.now() } };
}

async function tokenCall(body) {
  const res = await http(TOKEN, { method: "POST", body: new URLSearchParams(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) throw new SignedOut(data.error_description || "Dropbox didn't accept the sign-in.");
    throw new Error(data.error_description || `Dropbox answered ${res.status}`);
  }
  return data;
}

/** Swap the code for tokens. Returns the record to keep: { appKey, refresh, access, expiresAt, accountId }. */
export async function finishSignIn(pending, code) {
  const body = { code: code.trim(), grant_type: "authorization_code", client_id: pending.appKey, code_verifier: pending.verifier };
  if (pending.redirect) body.redirect_uri = pending.redirect;
  const t = await tokenCall(body);
  return { appKey: pending.appKey, refresh: t.refresh_token, access: t.access_token, expiresAt: Date.now() + (t.expires_in || 14400) * 1000 - 60e3, accountId: t.account_id || null, rev: null };
}

/** A fresh access token when the old one is near its end. Returns the updated record. */
export async function freshToken(rec) {
  if (rec.access && rec.expiresAt > Date.now()) return rec;
  const t = await tokenCall({ grant_type: "refresh_token", refresh_token: rec.refresh, client_id: rec.appKey });
  return { ...rec, access: t.access_token, expiresAt: Date.now() + (t.expires_in || 14400) * 1000 - 60e3 };
}

/** The library file and its revision, or null if there isn't one yet. */
export async function download(access) {
  const res = await http(`${CONTENT}/download`, { method: "POST", headers: { Authorization: `Bearer ${access}`, "Dropbox-API-Arg": JSON.stringify({ path: FILE }) } });
  if (res.status === 409) {
    const err = await res.json().catch(() => ({}));
    if (JSON.stringify(err).includes("not_found")) return null;
    throw new Error("Dropbox couldn't read the library file.");
  }
  if (res.status === 401) throw new SignedOut("Dropbox asked to sign in again.");
  if (!res.ok) throw new Error(`Dropbox answered ${res.status}`);
  const meta = JSON.parse(res.headers.get("Dropbox-API-Result") || "{}");
  return { archive: JSON.parse(await res.text()), rev: meta.rev || null };
}

/** Write the library file. With `rev`, only if nobody wrote it since (else Conflict). */
export async function upload(access, archive, rev) {
  const arg = { path: FILE, mode: rev ? { ".tag": "update", update: rev } : { ".tag": "add" }, autorename: false, mute: true };
  const res = await http(`${CONTENT}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Dropbox-API-Arg": asciiJson(arg), "Content-Type": "application/octet-stream" },
    body: JSON.stringify(archive),
  });
  if (res.status === 409) throw new Conflict("The library file changed on another device.");
  if (res.status === 401) throw new SignedOut("Dropbox asked to sign in again.");
  if (!res.ok) throw new Error(`Dropbox answered ${res.status}`);
  const meta = await res.json();
  return { rev: meta.rev };
}
// Dropbox-API-Arg must be ASCII: escape anything else.
const asciiJson = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** What the content of an archive is, ignoring when it was written. */
export const contentOf = a => JSON.stringify([a.books, a.events, a.tombstones || [], a.settings || null].map(x => (Array.isArray(x) ? [...x].sort((p, q) => (p.id < q.id ? -1 : 1)) : x)));

/**
 * One round: read Dropbox's copy, merge it into the local library, and write back
 * only if Dropbox's copy lacks something. A clash (another device wrote meanwhile)
 * starts the round again, up to three times.
 *   local()            — the current local archive
 *   merge(a, b)        — mergeArchives
 *   accept(m)          — store the merged library locally (only called if it changed)
 *   prepare(remote)    — check/upgrade Dropbox's copy (throws if it isn't a library)
 * Returns { pulled, pushed, rev }.
 */
export async function syncOnce({ access, local, merge, accept, prepare = x => x, stamp = () => new Date().toISOString() }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = await download(access);
    const mine = local();
    let merged = mine, pulled = false;
    if (remote) {
      merged = merge(mine, prepare(remote.archive));
      if (contentOf(merged) !== contentOf(mine)) { await accept(merged); pulled = true; }
    }
    if (remote && contentOf(merged) === contentOf(remote.archive)) return { pulled, pushed: false, rev: remote.rev };
    try {
      const out = { format: mine.format, schemaVersion: mine.schemaVersion, exportedAt: stamp(), books: merged.books, events: merged.events, tombstones: merged.tombstones || [], settings: merged.settings };
      const { rev } = await upload(access, out, remote ? remote.rev : null);
      return { pulled, pushed: true, rev };
    } catch (e) {
      if (!(e instanceof Conflict) || attempt === 2) throw e;
    }
  }
}
