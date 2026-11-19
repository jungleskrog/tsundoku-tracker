// Google Drive as the sync store (1.3). No server and no Google library: the app goes to
// Google's sign-in page and comes back with an access token in the address (the OAuth
// "token" flow Google offers browser apps). The token lasts about an hour; when it has run
// out, opening the app does the round trip again by itself (prompt=none, nothing to tap if
// you're still signed in to Google). The library is one file in Drive's hidden app space
// (appDataFolder), which only this app can see.
import { Conflict, SignedOut } from "./sync.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
export const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
export const NAME = "library.json";

let http = (...a) => fetch(...a);
export const setFetch = f => { http = f; };

const randomState = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");

/** The sign-in address. silent: no screens at all (fails with interaction_required if Google needs you). */
export function signInUrl(clientId, redirect, { silent = false, hint = null } = {}) {
  const state = randomState();
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "token", scope: SCOPE, include_granted_scopes: "true", state });
  if (silent) q.set("prompt", "none");
  if (hint) q.set("login_hint", hint);
  return { url: `${AUTH}?${q}`, state };
}

/** What Google put in the address on the way back, or null if it isn't a sign-in return. */
export function parseReturn(hash) {
  const h = String(hash || "").replace(/^#/, "");
  if (!/(^|&)(access_token|error)=/.test(h)) return null;
  const q = new URLSearchParams(h);
  if (q.get("error")) return { error: q.get("error"), state: q.get("state") };
  return { access: q.get("access_token"), expiresAt: Date.now() + (+q.get("expires_in") || 3600) * 1000 - 60e3, state: q.get("state") };
}

async function call(url, access, opts = {}) {
  const res = await http(url, { ...opts, headers: { Authorization: `Bearer ${access}`, ...(opts.headers || {}) } });
  if (res.status === 401) throw new SignedOut("Google asked to sign in again.");
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `Google Drive answered ${res.status}`); }
  return res;
}

/** The library file in the app space: { id, version } or null. */
async function find(access) {
  const q = new URLSearchParams({ spaces: "appDataFolder", q: `name = '${NAME}' and trashed = false`, fields: "files(id,version,modifiedTime)", orderBy: "modifiedTime desc", pageSize: "5" });
  const { files } = await (await call(`${API}?${q}`, access)).json();
  return files && files[0] ? { id: files[0].id, version: String(files[0].version) } : null;
}

/**
 * A store for syncOnce. Drive has no "write only if unchanged", so before writing it checks
 * the file's version is still the one it read (a clash in between starts the round again).
 */
export function driveStore(access, hint = {}) {
  let fileId = hint.fileId || null;
  return {
    get fileId() { return fileId; },
    async download() {
      const f = await find(access);
      if (!f) { fileId = null; return null; }
      fileId = f.id;
      const archive = await (await call(`${API}/${f.id}?alt=media`, access)).json();
      return { archive, rev: f.version };
    },
    async upload(archive, rev) {
      const body = JSON.stringify(archive);
      if (!fileId) {
        if (rev) throw new Conflict("The library file went missing.");
        if (await find(access)) throw new Conflict("Another device made the library file first.");
        const boundary = "tsundoku" + randomState();
        const meta = JSON.stringify({ name: NAME, parents: ["appDataFolder"], mimeType: "application/json" });
        const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
        const made = await (await call(`${UPLOAD}?uploadType=multipart&fields=id,version`, access, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart })).json();
        fileId = made.id;
        return { rev: String(made.version) };
      }
      const now = await (await call(`${API}/${fileId}?fields=version`, access)).json();
      if (rev && String(now.version) !== String(rev)) throw new Conflict("The library file changed on another device.");
      const done = await (await call(`${UPLOAD}/${fileId}?uploadType=media&fields=version`, access, { method: "PATCH", headers: { "Content-Type": "application/json" }, body })).json();
      return { rev: String(done.version) };
    },
  };
}

/** The Google account's address (for renewing silently with the right account when several are signed in). */
export async function whoAmI(access) {
  try { const r = await call(`https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)`, access); return (await r.json()).user?.emailAddress || null; }
  catch { return null; }
}
