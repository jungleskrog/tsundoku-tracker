// Backups: download/upload files, and (Chrome desktop) one auto-saved file,
// e.g. in Dropbox or iCloud Drive, shared with the phone.
import { getMeta, setMeta } from "./store.js";

export const autoBackupSupported = () => typeof window !== "undefined" && "showSaveFilePicker" in window;

export function fileName(now = new Date()) {
  const d = now.toISOString().slice(0, 10);
  return `antilibrary-${d}.json`;
}

export function download(archive, name = fileName()) {
  const blob = new Blob([JSON.stringify(archive, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function readJsonFile(file) {
  const text = await file.text();
  try { return JSON.parse(text); } catch { throw new Error("That file isn't valid JSON."); }
}

// --- Auto-backup file ------------------------------------------------------------

export async function autoHandle() {
  return (await getMeta("autoBackupHandle")) || null;
}

/** Ask the user where to keep the auto-saved file. Needs a click. */
export async function connectAuto() {
  const handle = await window.showSaveFilePicker({
    suggestedName: "antilibrary-backup.json",
    types: [{ description: "Antilibrary backup", accept: { "application/json": [".json"] } }],
  });
  await setMeta("autoBackupHandle", handle);
  return handle;
}

export async function disconnectAuto() {
  await setMeta("autoBackupHandle", null);
}

/** "granted" | "prompt" | "denied" | null (no file chosen). */
export async function autoPermission(handle, ask = false) {
  if (!handle) return null;
  const opts = { mode: "readwrite" };
  let p = await handle.queryPermission(opts);
  if (p === "prompt" && ask) p = await handle.requestPermission(opts);
  return p;
}

export async function writeAuto(handle, archive) {
  const w = await handle.createWritable();
  await w.write(JSON.stringify(archive));
  await w.close();
}

/** The archive currently in the auto-backup file, or null if it's empty/new. */
export async function readAuto(handle) {
  const file = await handle.getFile();
  if (!file.size) return null;
  try { return JSON.parse(await file.text()); } catch { return null; }
}
