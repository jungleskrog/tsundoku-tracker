// Headless Chrome tests over the DevTools protocol: storage layer + an end-to-end run of the app.
// Usage: npm run test:browser [-- --csv <goodreads export>] [-- --shots <dir>]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CSV = opt("--csv") || join(ROOT, "tests/fixtures/goodreads-sample.csv");
const SHOTS = opt("--shots");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HELPER = args.includes("--helper");
const PORT = HELPER ? 8731 : 8732, DEBUG = 9333, BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = await serve(PORT);
const profile = mkdtempSync(join(tmpdir(), "antilibrary-test-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`,
  "--window-size=1100,1400", "--no-first-run", "about:blank"], { stdio: "ignore" });

let ws, seq = 0;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
      const page = list.find(t => t.type === "page");
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch {}
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
}
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "evaluate failed");
  return r.result?.result?.value;
}
async function until(expr, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await evaluate(expr).catch(() => false)) return true; await sleep(100); }
  throw new Error(`timed out waiting for: ${expr}`);
}
async function go(url) { await send("Page.navigate", { url }); await sleep(300); }
const click = sel => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error("no ${sel.replace(/"/g, "'")}"); el.click(); return true; })()`);
const text = () => evaluate("document.querySelector('main').innerText");
async function shot(name) {
  if (!SHOTS) return;
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(r.result.data, "base64"));
}
async function chooseFile(sel, path) {
  const doc = await send("DOM.getDocument", {});
  const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: sel });
  await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [path] });
}

const results = [];
const check = (cond, name) => results.push(`${cond ? "ok  " : "FAIL"} ${name}`);

try {
  await connect();
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");

  // 1. Storage layer
  await go(`${BASE}/tests/store.html`);
  await until("document.title === 'done'");
  for (const line of (await evaluate("document.getElementById('results').textContent")).split("\n")) check(line.startsWith("ok"), `store: ${line.replace(/^(ok|FAIL) /, "")}`);
  await evaluate("new Promise(r => { const q = indexedDB.deleteDatabase('antilibrary'); q.onsuccess = q.onerror = q.onblocked = r; })");

  // 2. The app, end to end
  await go(`${BASE}/`);
  await until("window.__antilibrary && window.__antilibrary.ready");
  if (HELPER) {
    await until("window.__antilibrary.books.size > 0", 20000);
    check(true, `with the helper, the library arrives by itself (${await evaluate("window.__antilibrary.books.size")} books)`);
  } else check((await text()).includes("An empty antilibrary"), "first run shows the welcome");
  await shot("1-welcome");
  await go(`${BASE}/#/import`);
  await until("!!document.querySelector('input[data-change=csv]')");
  await chooseFile("input[data-change=csv]", CSV);
  await until("document.body.innerText.includes('What this import will do')");
  await shot("2-import-plan");
  const plan = await evaluate("({ creates: window.__antilibrary.plan.creates.length, asks: window.__antilibrary.plan.asks.length })");
  check(HELPER ? plan.asks === 0 : plan.creates > 0, `import plan: ${plan.creates} new books, ${plan.asks} questions`);
  await click("[data-act=apply-import]");
  await until("window.__antilibrary.books.size > 0 && location.hash === '#/'");
  const reading = await evaluate("[...window.__antilibrary.books.values()].filter(b => b.status === 'reading').length");
  check(reading > 0, `desk after import: ${reading} in hand`);
  await shot("3-desk");

  // the model on the desk
  check((await text()).includes("At your current pace, finishes"), "each book in hand has a finish phrase");
  check((await text()).includes("The ledger begins with your first entry"), "ledger waits for the first entry");
  const plannedToday = () => evaluate("(() => { const m = document.querySelector('.entry .where b'); return m ? parseInt(m.textContent, 10) : 0; })()");
  const before10 = await plannedToday();
  await go(`${BASE}/#/settings`); await until("!!document.querySelector('[data-form=tokens]')");
  await evaluate("(() => { const f = document.querySelector('[data-form=tokens]'); f.tokens.value = '20'; f.requestSubmit(); })()"); await sleep(200);
  await go(`${BASE}/#/`); await until("!!document.querySelector('.entry')");
  const after20 = await plannedToday();
  check(after20 >= before10 * 2 - 1 && after20 > before10, `doubling the tokens doubles today's pages (${before10} → ${after20})`);
  await go(`${BASE}/#/settings`); await until("!!document.querySelector('[data-form=tokens]')");
  await evaluate("(() => { const f = document.querySelector('[data-form=tokens]'); f.tokens.value = '10'; f.requestSubmit(); })()"); await sleep(200);
  await go(`${BASE}/#/`); await until("!!document.querySelector('.entry')");

  // log, undo, set page, finish
  const firstId = await evaluate("document.querySelector('.entry [data-act=add]').dataset.id");
  const page = () => evaluate(`(() => { const S = window.__antilibrary; const ev = S.byBook.get('${firstId}') || []; let p = 0; for (const e of ev) if (e.type === 'progress') p = e.page; return p; })()`);
  const p0 = await page();
  await click(`.entry [data-act=add][data-id='${firstId}'][data-n='5']`); await sleep(150);
  await click(`.entry [data-act=add][data-id='${firstId}'][data-n='2']`); await sleep(150);
  check((await page()) === p0 + 7, "+5 then +2 adds seven pages");
  check(/On course|ahead|behind/.test(await text()), "the ledger speaks after the first entry");
  check(/\b7 of \d+ pages today/.test(await text()), "today's pages shown against the plan");
  await click(`[data-act=undo][data-id='${firstId}']`); await sleep(150);
  check((await page()) === p0 + 5, "undo removes only the last entry");
  const total = await evaluate(`(() => { const b = window.__antilibrary.books.get('${firstId}'); return (b.mine && b.mine.pages) || (b.synced && b.synced.pages) || 0; })()`);
  await evaluate(`(() => { const i = document.getElementById('p-${firstId}'); i.value = '${total}'; i.form.requestSubmit(); })()`); await sleep(200);
  check((await page()) === total, "typing the last page sets it");
  await click(`[data-act=status][data-id='${firstId}'][data-to=read]`); await sleep(200);
  check((await evaluate(`window.__antilibrary.books.get('${firstId}').status`)) === "read", "mark as finished");

  // persistence across reload
  const before = await evaluate("({ b: window.__antilibrary.books.size, e: window.__antilibrary.events.length })");
  await go(`${BASE}/`); await until("window.__antilibrary && window.__antilibrary.ready");
  const after = await evaluate("({ b: window.__antilibrary.books.size, e: window.__antilibrary.events.length })");
  check(before.b === after.b && before.e === after.e, `survives a reload (${after.b} books, ${after.e} entries)`);

  // record view, annotation is mine and survives re-import
  await go(`${BASE}/#/book/${firstId}`); await until("!!document.querySelector('.record')");
  await evaluate("(() => { const i = document.getElementById('annot'); i.value = 'My own line.'; i.form.requestSubmit(); })()"); await sleep(200);
  check((await text()).includes("provisional"), "an unscored book says its difficulty is provisional");
  await evaluate("(() => { const f = document.querySelector('[data-form=details]'); f.difficulty.value = '3'; f.requestSubmit(); })()"); await sleep(200);
  check((await text()).includes("3 (your figure)"), "your difficulty overrides");
  check(/about 3[0-9] pages for 10 tokens/.test(await text()), "difficulty 3 gives about 34 pages for 10 tokens");
  await shot("4-record");
  await go(`${BASE}/#/import`); await until("!!document.querySelector('input[data-change=csv]')");
  await chooseFile("input[data-change=csv]", CSV);
  await until("document.body.innerText.includes('What this import will do')");
  const again = await evaluate("({ c: window.__antilibrary.plan.creates.length, u: window.__antilibrary.plan.updates.length })");
  check(again.c === 0 && again.u === 0, "re-importing the same file changes nothing");
  await click("[data-act=apply-import]"); await sleep(300);
  check((await evaluate(`window.__antilibrary.books.get('${firstId}').mine.annotation`)) === "My own line.", "your annotation survives a re-import");

  await go(`${BASE}/#/list`); await until("!!document.querySelector('ol.shelf')"); await shot("5-list");
  await evaluate("(() => { const q = document.getElementById('q'); q.value = 'zzzz-no-match'; q.dispatchEvent(new Event('input', { bubbles: true })); })()"); await sleep(100);
  check((await text()).includes("None match"), "search filters the list");
  await go(`${BASE}/#/settings`); await until("!!document.getElementById('snapshots')"); await sleep(300);
  check((await text()).includes("before a Goodreads import"), "a copy was kept before each import");
  await shot("6-settings");

  // with the Mac helper running (only when asked: npm run test:browser -- --helper)
  if (HELPER) {
    await go(`${BASE}/#/settings`);
    await until("document.body.innerText.includes('The Mac helper')");
    await until("document.body.innerText.includes('Connected')", 15000);
    check(true, "the app finds the helper");
    await until("[...window.__antilibrary.books.values()].some(b => b.synced && b.synced.coverUrl)", 20000);
    const covers = await evaluate("[...window.__antilibrary.books.values()].filter(b => b.synced && b.synced.coverUrl).length");
    check(covers > 0, `covers arrive from the helper (${covers} books)`);
    const quotes = await evaluate("[...window.__antilibrary.books.values()].filter(b => b.synced && b.synced.quote).length");
    check(true, `quotes so far: ${quotes}`);
    const withQuote = await evaluate("([...window.__antilibrary.books.values()].find(b => b.synced && b.synced.quote && !('annotation' in (b.mine || {}))) || {}).id || null");
    if (withQuote) {
      await go(`${BASE}/#/book/${withQuote}`); await until("!!document.querySelector('.record')");
      check(!!(await evaluate("document.querySelector('.epigraph') && document.querySelector('.epigraph').textContent.length > 3")), "a Goodreads quote becomes the default annotation");
    }
    await go(`${BASE}/#/`); await until("!!document.querySelector('.entry')"); await sleep(800);
    await shot("9-desk-helper");
    await go(`${BASE}/#/settings`); await until("document.body.innerText.includes('Difficulty scores')"); await shot("10-settings-helper");
  }

  // phone width
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await go(`${BASE}/`); await until("window.__antilibrary && window.__antilibrary.ready");
  const overflow = await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1");
  check(!overflow, "no sideways scrolling at phone width");
  await shot("7-phone");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(200);
  const bg = await evaluate("getComputedStyle(document.body).backgroundColor");
  check(bg === "rgb(27, 25, 22)", "dark mode follows the system");
  await shot("8-phone-dark");
  const sw = await evaluate("navigator.serviceWorker.getRegistration().then(r => !!r)");
  check(sw, "offline cache (service worker) registered");
} catch (e) {
  results.push(`FAIL ${e.message}`);
  try { results.push("     at " + await evaluate("location.href + ' | ' + (document.querySelector('main') || document.body).innerText.slice(0, 300).replace(/\\n/g, ' / ')")); } catch {}
} finally {
  console.log(results.join("\n"));
  const failed = results.filter(r => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  ws?.close(); chrome.kill(); server.close();
  await sleep(500); try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
