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
  } else {
    check((await text()).includes("Nothing piled up yet"), "first run shows the welcome");
    check(await evaluate("!!document.querySelector('.gs') && document.querySelector('.gs').innerText.includes('0 of 4')"), "a new library gets the getting-started list");
  }
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
  check(await evaluate("[...document.querySelectorAll('.entry .prog')].some(p => /finishes|pages unknown|Add a page count/.test(p.textContent))"), "each book in hand says when it finishes");
  check((await text()).includes("The record begins with your first entry"), "the day's standing waits for the first entry");
  check(await evaluate("!!document.querySelector('.today .meter') && document.querySelectorAll('.figs > div').length === 4"), "the Desk opens on today's tokens and four figures");
  const plannedToday = () => evaluate("(() => { const m = document.querySelector('.entry .todaycol'); return m ? parseInt(m.dataset.planned, 10) : 0; })()");
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
  check(/On course|ahead|behind/.test(await text()), "the day's standing speaks after the first entry");
  check(/\b7 of \d+ pp/.test(await evaluate(`document.querySelector('.entry[data-id="${firstId}"] .todaycol').textContent`)), "today's pages shown against the plan");
  check(parseFloat(await evaluate("document.querySelector('.today .n').textContent")) > 0, "today's tokens count up as you log");
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
  if (!HELPER) check((await text()).includes("provisional"), "an unscored book says its difficulty is provisional");
  await evaluate("(() => { const f = document.querySelector('[data-form=details]'); f.difficulty.value = '3'; f.requestSubmit(); })()"); await sleep(200);
  check((await text()).includes("3 (your figure)"), "your difficulty overrides");
  check(/about 3[0-9] pages for 10 tokens/.test(await text()), "difficulty 3 gives about 34 pages for 10 tokens");
  await shot("4-record");
  await go(`${BASE}/#/import`); await until("!!document.querySelector('input[data-change=csv]')");
  await chooseFile("input[data-change=csv]", CSV);
  await until("document.body.innerText.includes('What this import will do')");
  const again = await evaluate("({ c: window.__antilibrary.plan.creates.length, u: window.__antilibrary.plan.updates.length })");
  check(again.c === 0 && (HELPER || again.u === 0), "re-importing the same file changes nothing");
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
    await until("[...window.__antilibrary.books.values()].filter(b => b.score).length >= 150", 20000);
    check(true, `difficulty scores arrive from the helper (${await evaluate("[...window.__antilibrary.books.values()].filter(b => b.score).length")} books)`);
    const why = await evaluate("([...window.__antilibrary.books.values()].find(b => b.score && b.score.components) || {}).id");
    await go(`${BASE}/#/book/${why}`); await until("!!document.querySelector('details.why')");
    await evaluate("document.querySelector('details.why').open = true"); await shot("11-why");
    check((await text()).includes("Vocabulary"), "a scored book explains its difficulty");
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
    await go(`${BASE}/#/order`); await until("document.body.innerText.includes('Suggested reading orders')");
    const sug = await evaluate("document.querySelectorAll('[data-act=sugg-yes]').length");
    check((await text()).includes("By reading-youth") && sug > 0, `the youth preview works on the real library (${sug} suggested reading orders)`);
    await shot("15-youth-preview-real");
  }

  // Stage 5: ordering the waiting list
  if (!HELPER) {
    const ids = () => evaluate("[...document.querySelectorAll('li.row')].map(r => r.dataset.id)");
    const S5 = "window.__antilibrary";
    await evaluate(`${S5}.query = ''`);
    await go(`${BASE}/#/list`); await until("!!document.querySelector('li.row')");
    check((await text()).includes("Next") && (await text()).includes("The stacks"), "the waiting list shows its bands");
    let o = await ids();
    check(o.length >= 3, `waiting books: ${o.length}`);
    // Move to… → To the top
    await click(`li.row[data-id="${o.at(-1)}"] [data-act=menu]`);
    await until("!!document.querySelector('.movemenu')");
    await click(".movemenu [data-go=top]"); await sleep(300);
    check((await ids())[0] === o.at(-1), "Move to… › To the top");
    // keyboard: Alt+Down moves one place
    o = await ids();
    await evaluate(`(() => { const li = document.getElementById('row-${o[0]}'); li.focus(); li.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })); })()`); await sleep(300);
    check((await ids())[1] === o[0], "Alt+Down moves a book one place");
    check(await evaluate(`document.activeElement && document.activeElement.id === 'row-${o[0]}'`), "the moved book keeps the focus");
    // band size
    while (await evaluate(`(${S5}.settings.bands || { next: 5 }).next > 1`)) { await click('[data-act=band][data-k=next][data-d="-1"]'); await sleep(150); }
    check(await evaluate("document.querySelectorAll('section[data-band=next] li.row').length") === 1, "Next can hold fewer books");
    // read after: the first book reads after the second, so it drops below it
    o = await ids();
    await click(`li.row[data-id="${o[0]}"] [data-act=menu]`); await until("!!document.querySelector('.movemenu')");
    await click('.movemenu [data-mode=req]'); await until("!!document.getElementById('pick-q')");
    await click(`.movemenu [data-other="${o[1]}"]`); await sleep(300);
    let n = await ids();
    check(n.indexOf(o[0]) === n.indexOf(o[1]) + 1, "‘read after’ moves the book to just after the other");
    check((await text()).includes("after"), "the row says what it reads after");
    // a loop is refused
    await click(`li.row[data-id="${o[1]}"] [data-act=menu]`); await until("!!document.querySelector('.movemenu')");
    await click('.movemenu [data-mode=req]'); await until("!!document.getElementById('pick-q')");
    await click(`.movemenu [data-other="${o[0]}"]`); await sleep(300);
    check((await text()).includes("round in a circle"), "a reading-order loop is refused");
    // can't go above the book it reads after
    await click(`li.row[data-id="${o[0]}"] [data-act=menu]`); await until("!!document.querySelector('.movemenu')");
    await click(".movemenu [data-go=top]"); await sleep(300);
    n = await ids();
    check(n.indexOf(o[0]) === n.indexOf(o[1]) + 1 && (await text()).includes("Placed just after"), "a book stops just after the one it reads after");
    // youth: give the waiting books scores in reverse order, plus a suggestion
    await evaluate(`(() => { const w = [...${S5}.books.values()].filter(b => b.status === 'want'); const keyOf = b => 'gr:' + b.refs.goodreadsBookId;
      w.forEach((b, i) => { b.score = { ...(b.score || {}), youth: 90 - i * 10, youth_reason: 'test note ' + i, youth_after: [] }; });
      const x = w.find(b => !(b.prereqs || []).length && !w.some(o => (o.prereqs || []).includes(b.id))), y = w.find(b => (b.prereqs || []).length === 0 && b !== x); if (x && y) x.score.youth_after = [keyOf(y)]; ${S5}.version++; })()`);
    await go(`${BASE}/#/order`); await until("document.body.innerText.includes('reading-youth order')");
    await shot("12-youth-preview");
    check((await text()).includes("By reading-youth"), "the youth preview compares the two orders");
    const before = await evaluate(`[...${S5}.books.values()].filter(b => b.status === 'want').map(b => [b.id, b.queueKey])`);
    await click("[data-act=youth-accept]"); await until("location.hash === '#/list'"); await until("!!document.querySelector('li.row')");
    const ys = await evaluate(`[...document.querySelectorAll('li.row')].map(r => ${S5}.books.get(r.dataset.id))`);
    const youths = await evaluate(`[...document.querySelectorAll('li.row')].map(r => { const b = ${S5}.books.get(r.dataset.id); return [b.id, b.score.youth, b.prereqs || []]; })`);
    const pos = new Map(youths.map(([id], i) => [id, i]));
    check(youths.every(([id, , pre]) => pre.every(x => !pos.has(x) || pos.get(x) < pos.get(id))), "the youth order keeps every book after the ones it reads after");
    const free = youths.filter(([, , pre]) => !pre.length).map(([, y]) => y);
    check(free.every((y, i) => i === 0 || y >= free[i - 1]), "the youth order runs from young to late");
    check((await text()).includes("Put back the order before"), "the previous order can be put back");
    await click("[data-act=undo-order]"); await sleep(300);
    const back = await evaluate(`[...${S5}.books.values()].filter(b => b.status === 'want').map(b => [b.id, b.queueKey])`);
    check(JSON.stringify(back.sort()) === JSON.stringify(before.sort()), "putting back restores the exact order");
    // suggestions
    await go(`${BASE}/#/order`); await until("document.body.innerText.includes('Suggested reading orders')");
    const hasSugg = await evaluate("!!document.querySelector('[data-act=sugg-yes]')");
    if (hasSugg) {
      const [sid, sother] = await evaluate("(() => { const b = document.querySelector('[data-act=sugg-yes]'); return [b.dataset.id, b.dataset.other]; })()");
      await click("[data-act=sugg-yes]"); await sleep(300);
      check(await evaluate(`(${S5}.books.get('${sid}').prereqs || []).includes('${sother}')`), "accepting a suggestion sets the reading order");
    } else check(false, "a suggestion is offered");
    // your own youth figure
    await go(`${BASE}/#/book/${o[1]}`); await until("!!document.querySelector('.record')");
    check((await text()).includes("Reading-youth"), "a book shows its reading-youth");
    await evaluate("document.querySelector('details.edit').open = true");
    await evaluate("(() => { const f = document.querySelector('form[data-form=details]'); f.youth.value = '99'; f.requestSubmit(); })()"); await sleep(300);
    check((await evaluate(`${S5}.books.get('${o[1]}').mine.youth`)) === 99 && (await text()).includes("(your figure)"), "your youth figure overrides the AI's");
    // survives a reload
    await go(`${BASE}/#/list`); await until("!!document.querySelector('li.row')");
    const keep = await ids();
    await send("Page.reload"); await sleep(600); await until("!!document.querySelector('li.row')");
    check(JSON.stringify(await ids()) === JSON.stringify(keep), "the order survives a reload");
    await shot("13-list-bands");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(300);
    await click(`li.row [data-act=menu]`); await sleep(200);
    check(!(await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")), "the banded list fits a phone, menu open");
    await shot("14-list-phone");
    await send("Emulation.clearDeviceMetricsOverride");
  }

  // Stage 6: quotes beside books, youth placing, For Goodreads, the bookmark
  if (!HELPER) {
    const A = "window.__antilibrary";
    const wids = () => evaluate("[...document.querySelectorAll('li.row')].map(r => r.dataset.id)");
    // the book's line on the desk and the list
    await evaluate(`(() => { for (const b of ${A}.books.values()) if (b.status === 'want' || b.status === 'reading') b.synced = { ...(b.synced || {}), quote: 'A line for ' + b.id }; ${A}.version++; })()`);
    await go(`${BASE}/#/list`); await go(`${BASE}/#/`); await until("!!document.querySelector('.figs')");
    let borrowed = null;
    if (!(await evaluate("!!document.querySelector('[data-act=row-more]')"))) {   // nothing in hand: Up next offers to begin; hold one in hand for a moment (in memory only)
      check(await evaluate("!!document.querySelector('.next [data-act=status][data-to=reading]')"), "with nothing in hand, Up next offers to begin the first");
      borrowed = await evaluate(`(() => { const b = [...${A}.books.values()].find(b => b.status === 'want'); b.status = 'reading'; ${A}.version++; return b.id; })()`);
      await go(`${BASE}/#/list`); await go(`${BASE}/#/`); await until("!!document.querySelector('[data-act=row-more]')");
    }
    await click("[data-act=row-more]"); await until("!!document.querySelector('.moreinfo .q')");
    check(await evaluate("document.querySelector('.moreinfo .q').textContent.startsWith('“A line for')"), "a book's quote is one tap away on the desk");
    await click("[data-act=row-more]"); await sleep(150);
    if (borrowed) await evaluate(`(() => { ${A}.books.get('${borrowed}').status = 'want'; ${A}.version++; })()`);
    await go(`${BASE}/#/list`); await until("!!document.querySelector('li.row')");
    check(await evaluate("[...document.querySelectorAll('li.row .q')].length") > 0, "the list shows the quote under each waiting book");
    // a youth figure moves the book among its neighbours
    await evaluate(`(() => { const w = [...${A}.books.values()].filter(b => b.status === 'want').sort((a, b) => a.queueKey < b.queueKey ? -1 : 1);
      w.forEach((b, i) => { b.score = { ...(b.score || {}), youth: 10 + i * 10, youth_any_time: false }; b.mine = { ...b.mine }; delete b.mine.youth; b.prereqs = []; }); ${A}.version++; })()`);
    await go(`${BASE}/#/`); await go(`${BASE}/#/list`); await until("!!document.querySelector('li.row')");
    let w = await wids();
    const mover = w.at(-1);
    await go(`${BASE}/#/book/${mover}`); await until("!!document.querySelector('form[data-form=details]')");
    await evaluate("(() => { document.querySelector('details.edit').open = true; const f = document.querySelector('form[data-form=details]'); f.youth.value = '15'; f.requestSubmit(); })()"); await sleep(500);
    check((await text()).includes("moved from no."), "changing the youth figure says where the book moved");
    await go(`${BASE}/#/list`); await until("!!document.querySelector('li.row')");
    w = await wids();
    check(w.indexOf(mover) === 1, `the book now sits among books of a similar youth (no. ${w.indexOf(mover) + 1})`);
    // For Goodreads: begin a waiting book here, and it's listed to change there
    const begun = w[2];
    await go(`${BASE}/#/book/${begun}`); await until("!!document.querySelector('[data-act=status][data-to=reading]')");
    await click("[data-act=status][data-to=reading]"); await sleep(300);
    check((await text()).includes("Put it on Currently Reading"), "the book page says what to change on Goodreads");
    await go(`${BASE}/#/`); await until("!!document.querySelector('a[href=\"#/goodreads\"]')");
    check(true, "the desk links to the changes to make on Goodreads");
    await go(`${BASE}/#/goodreads`); await until("document.body.innerText.includes('For Goodreads')");
    await shot("15-for-goodreads");
    const title = await evaluate(`${A}.books.get('${begun}').synced.title`);
    check((await text()).includes(title) && await evaluate(`!!document.querySelector('a[href^="https://www.goodreads.com/book/show/"]')`), "For Goodreads lists the book, with a link to it");
    await click(`[data-act=gr-done][data-id="${begun}"]`); await sleep(300);
    check(!(await evaluate(`!!document.querySelector('[data-act=gr-done][data-id="${begun}"]')`)), "Done takes it off the list");
    // the bookmark: built from the app's own address, and it parses
    await go(`${BASE}/#/import`); await until("!!document.querySelector('a.bm')");
    const href = await evaluate("document.querySelector('a.bm').getAttribute('href')");
    const code = decodeURIComponent(href.slice("javascript:".length));
    let compiles = true; try { new Function(code); } catch (e) { compiles = e.message; }
    check(href.startsWith("javascript:") && compiles === true && code.includes(`"${BASE}/"`) && !code.includes("__APP__"), `the bookmark is ready to drag (${Math.round(href.length / 1024)} KB, ${compiles === true ? "parses" : compiles})`);
    // pasting what it copies: a shelf moved there is followed here, a new book is flagged to find its place
    const moved = w.find(id => id !== begun && id !== mover);
    const payload = await evaluate(`(() => { const books = [...${A}.books.values()].filter(b => b.refs && b.refs.goodreadsBookId && b.synced && b.synced.shelf)
      .map(b => ({ book_id: b.refs.goodreadsBookId, title: b.synced.title, author: b.synced.author, shelf: b.id === '${moved}' ? 'read' : b.synced.shelf, date_read: b.id === '${moved}' ? '2026-11-15' : null }));
      books.push({ book_id: '999000111', title: 'A New Book', author: 'New Author', shelf: 'to-read', pages: 180 });
      return JSON.stringify({ format: 'antilibrary-goodreads-sync', version: 1, synced_at: new Date().toISOString(), books }); })()`);
    await click("[data-act=paste-open]"); await until("!!document.getElementById('paste')");
    await evaluate(`(() => { const f = document.querySelector('form[data-form=paste]'); f.json.value = ${JSON.stringify(payload)}; f.requestSubmit(); })()`);
    await until("document.body.innerText.includes('What this import will do')");
    const t6 = await text();
    check(/Moved shelf there\s*1, followed here/.test(t6) && /New books\s*1/.test(t6), "the pasted shelves show one shelf move and one new book before anything changes");
    // the library changes while the plan is open: it's worked out again before anything is applied
    await go(`${BASE}/#/`); await until("!!document.querySelector('[data-act=add][data-n=\"1\"]')");
    await click('[data-act=add][data-n="1"]'); await sleep(300);
    await go(`${BASE}/#/import`); await until("!!document.querySelector('[data-act=apply-import]')");
    await click("[data-act=apply-import]"); await sleep(300);
    check((await text()).includes("worked out again") && await evaluate("location.hash") === "#/import", "a plan made before the library changed is made again first");
    await click("[data-act=apply-import]"); await until("location.hash === '#/'");
    check(await evaluate(`${A}.books.get('${moved}').status`) === "read", "a book read on Goodreads is marked read here");
    const nb = await evaluate(`(() => { const b = [...${A}.books.values()].find(b => b.refs && b.refs.goodreadsBookId === '999000111'); return b && { flag: !!(b.flags && b.flags.placeByYouth), status: b.status }; })()`);
    check(nb && nb.status === "want" && nb.flag, "the new book waits to find its place by reading-youth");
  }

  // Stage 7: the name, the Library, colophons, margin notes
  {
    const A = "window.__antilibrary";
    await go(`${BASE}/#/`); await until("!!document.querySelector('.brand')");
    check(await evaluate("document.title === 'Tsundoku Tracker' && document.querySelector('.brand').textContent === 'Tsundoku Tracker'"), "the app is called Tsundoku Tracker");
    if (!HELPER) {
      // a margin note from the desk
      await click("[data-act=row-more]"); await until("!!document.querySelector('.moreinfo')");
      const inHand = await evaluate("document.querySelector('[data-act=note-open]') && document.querySelector('[data-act=note-open]').dataset.id");
      check(!!inHand, "a book's 'more' on the desk offers a note in the margin");
      await click("[data-act=note-open]"); await until("!!document.querySelector('form[data-form=note]')");
      await evaluate("(() => { const f = document.querySelector('form[data-form=note]'); f.text.value = 'the chess game in the saloon'; f.requestSubmit(); })()"); await sleep(300);
      check(await evaluate(`${A}.events.some(e => e.type === 'note' && e.text === 'the chess game in the saloon' && e.bookId === '${inHand}')`), "the note is kept in the history");
      await go(`${BASE}/#/book/${inHand}`); await until("!!document.querySelector('.history li.note')");
      check((await text()).includes("“the chess game in the saloon”"), "the book's history shows the note");
    }
    await go(`${BASE}/#/library`); await until("!!document.querySelector('.wall-label')");
    const lib = await text();
    check(/The waiting list/i.test(lib) && /Extent/.test(lib) && /Weight/.test(lib) && /Horizon/.test(lib), "the wall label gives extent, weight and horizon");
    check(await evaluate("document.querySelectorAll('.stretches tbody tr').length") === 3 && await evaluate("document.querySelectorAll('.hist span').length") === 10, "the label breaks the list into Next, Soon and the stacks, with a difficulty histogram");
    check(await evaluate("!!document.querySelector('.letter')") && /This week, so far/.test(lib), "this week's shelf letter is written");
    if (!HELPER) {
      check(/you wrote: “the chess game in the saloon”/.test(lib), "the letter quotes the week's margin note");
      check(/the chess game in the saloon/.test(await evaluate("document.querySelector('.commonplace') ? document.querySelector('.commonplace').innerText : ''")), "the commonplace book gathers the note");
      const readId = await evaluate(`([...${A}.books.values()].find(b => b.status === 'read' && (${A}.byBook.get(b.id) || []).some(e => e.type === 'progress' && e.source === 'app')) || {}).id`);
      await go(`${BASE}/#/book/${readId}`); await until("!!document.querySelector('.colophon-page')");
      check(/Begun|Finished/.test(await evaluate("document.querySelector('.colophon-page').innerText")), "a finished book carries its colophon");
    } else {
      const readId = await evaluate(`([...${A}.books.values()].find(b => b.status === 'read') || {}).id`);
      await go(`${BASE}/#/book/${readId}`); await until("!!document.querySelector('.colophon-page')");
      check(/goodreads|finished/i.test(await evaluate("document.querySelector('.colophon-page').innerText")), "a finished book carries its colophon (real library)");
    }
    await shot("16-colophon");
    await go(`${BASE}/#/library`); await until("!!document.querySelector('.wall-label')");
    await shot("17-library");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(300);
    check(!(await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")), "the Library fits a phone");
    await shot("18-library-phone");
    await send("Emulation.clearDeviceMetricsOverride");
  }

  // Stage 8: the printed year
  {
    await go(`${BASE}/#/library`); await until("!!document.querySelector('a[href=\"#/year\"]')");
    await click('a[href="#/year"]'); await until("!!document.querySelector('.year .y-title')");
    const yt = await text();
    check(/A Reading Year/.test(yt) && /The year in figures/.test(yt) && /Colophon/.test(yt), "the printed year has a title page, figures and a colophon");
    const nBooks = await evaluate("document.querySelectorAll('.y-book').length");
    check(nBooks > 0 && /No\. 1/.test(yt), `the year's finished books are numbered (${nBooks})`);
    await evaluate("(() => { const f = document.querySelector('form[data-form=reader]'); f.reader.value = 'A Reader'; f.requestSubmit(); })()"); await sleep(300);
    check((await text()).includes("The Reading Year of A Reader"), "the reader's name goes on the title page");
    const pdf = await send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
    const bytes = Buffer.from(pdf.result.data, "base64");
    const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    check(pages >= 4, `printing sets it as a small book (${pages} A5 pages)`);
    const mb = bytes.toString("latin1").match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)/);
    check(mb && Math.abs(+mb[1] - 419.5) < 3 && Math.abs(+mb[2] - 595.3) < 3, `the pages are A5 (${mb ? mb[1] + " × " + mb[2] : "?"} pt)`);
    if (SHOTS) writeFileSync(join(SHOTS, "19-printed-year.pdf"), bytes);
    // the single-page download
    const dl = mkdtempSync(join(tmpdir(), "tsundoku-dl-"));
    await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dl });
    await click("[data-act=year-download]");
    await until("document.body.innerText.includes('to your downloads')", 10000);
    await sleep(800);
    const { readdirSync, readFileSync } = await import("node:fs");
    const files = readdirSync(dl).filter(f => f.endsWith(".html"));
    const page = files.length ? readFileSync(join(dl, files[0]), "utf8") : "";
    check(files.length === 1 && page.includes("data:font/woff2;base64,") && page.includes("The Reading Year of A Reader") && !page.includes("#/book/") && !/<script/i.test(page),
      `the download is one self-contained page (${files[0] || "none"}, ${Math.round(page.length / 1024)} KB)`);
    if (SHOTS && page) writeFileSync(join(SHOTS, "20-year.html"), page);
    rmSync(dl, { recursive: true, force: true });
    await shot("21-year-screen");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(300);
    check(!(await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")), "the printed year reads on a phone");
    await send("Emulation.clearDeviceMetricsOverride");
    await evaluate("(() => { const f = document.querySelector('form[data-form=reader]'); f.reader.value = ''; f.requestSubmit(); })()"); await sleep(200);
  }

  // Stage 9: getting started, how it works
  if (!HELPER) {
    await go(`${BASE}/#/`); await until("!!document.querySelector('.gs')");
    let gs = await evaluate("document.querySelector('.gs').innerText");
    check(/Bring in your books\s*done/.test(gs) && /Put the list in order\s*done/.test(gs), "steps tick themselves as you go (books in, list ordered)");
    // the earlier run already saved tokens in Settings, which counts; otherwise choose them here
    if (await evaluate("!!document.querySelector('.gs form[data-form=tokens]')")) {
      await evaluate("(() => { const f = document.querySelector('.gs form[data-form=tokens]'); f.tokens.value = '12'; f.requestSubmit(); })()"); await sleep(300);
    }
    gs = await evaluate("document.querySelector('.gs').innerText");
    check(/Choose your daily effort\s*done/.test(gs), "choosing a daily effort ticks its step");
    await click("[data-act=gs-installed]"); await sleep(300);
    await click("[data-act=export]").catch(() => null);
    await evaluate("window.__antilibrary.settings.lastExportAt = window.__antilibrary.settings.lastExportAt || new Date().toISOString(); window.__antilibrary.version++");
    await go(`${BASE}/#/list`); await go(`${BASE}/#/`); await until("!!document.querySelector('.gs')");
    check((await text()).includes("All set."), "with every step done it says so");
    await click("[data-act=gs-hide]"); await sleep(300);
    check(!(await evaluate("!!document.querySelector('.gs')")), "the list can be hidden");
    await go(`${BASE}/#/settings`); await until("!!document.querySelector('[data-act=gs-show]')");
    check(true, "and shown again from Settings");
    await go(`${BASE}/#/about`); await until("document.body.innerText.includes('How it works')");
    const ab = await text();
    check(/Tokens, difficulty, pages/.test(ab) && /The Mac helper/.test(ab) && /Your data/.test(ab), "How it works explains the model, the helper and your data");
    await shot("22-about");
  }

  // Stage 10: sync settings, the phone's tab bar
  {
    await go(`${BASE}/#/settings`); await until("!!document.getElementById('sync')");
    const sy = await evaluate("document.getElementById('sync').innerText");
    check(/Sync between devices/.test(sy) && (/isn.t set up for this copy/.test(sy) || /Connect Google Drive/.test(sy)), "Settings offers sync between devices");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(300);
    await go(`${BASE}/#/`); await until("!!document.querySelector('.figs')");
    const bar = await evaluate("(() => { const t = document.querySelector('.masthead .tabs'); const r = t.getBoundingClientRect(); return { pos: getComputedStyle(t).position, bottom: Math.round(r.bottom), h: window.innerHeight }; })()");
    check(bar.pos === "fixed" && Math.abs(bar.bottom - bar.h) <= 2, "on a phone the tabs sit at the foot of the screen");
    check(!(await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")), "the dashboard fits a phone");
    await send("Emulation.clearDeviceMetricsOverride");
  }

  // 1.2: count afresh; change edition (looked up through the helper)
  {
    const A = "window.__antilibrary";
    await go(`${BASE}/#/settings`); await until("!!document.querySelector('[data-act=ledger-reset]')");
    await click("[data-act=ledger-reset]"); await sleep(300);
    check(await evaluate(`!!${A}.settings.ledgerFrom`) && (await text()).includes("Counting afresh"), "ahead or behind can be counted afresh from today");
    if (HELPER) {
      const wid = await evaluate(`([...${A}.books.values()].find(b => /Wretched of the Earth/.test((b.synced || {}).title || "")) || {}).id`);
      if (wid) {
        await go(`${BASE}/#/book/${wid}`); await until("!!document.querySelector('[data-act=ed-open]')");
        await click("[data-act=ed-open]"); await until("!!document.getElementById('ed-q')");
        await evaluate("(() => { const f = document.querySelector('form[data-form=edition-look]'); f.q.value = 'https://www.goodreads.com/book/show/66933'; f.requestSubmit(); })()");
        await until("!!document.querySelector('[data-act=ed-use][data-mode=edition]')", 30000);
        check(/pages/.test(await evaluate("document.querySelector('.edpanel').innerText")), "pasting a Goodreads link looks the edition up");
        await click("[data-act=ed-use][data-mode=edition]"); await sleep(400);
        const b = await evaluate(`${A}.books.get('${wid}').mine.grEdition`);
        check(b && b.id === "66933" && (await text()).includes("(your choice)"), "the chosen edition is used (cover, pages, publisher)");
        await evaluate(`(() => { const b = ${A}.books.get('${wid}'); b.flags = { ...b.flags, goneFromGoodreads: null }; ${A}.version++; })()`); // an earlier test import flagged it
        await go(`${BASE}/#/goodreads`); await until("document.querySelector('h1') && document.querySelector('h1').textContent === 'For Goodreads'");
        const gtxt = await text();
        check(gtxt.includes("Switch to the edition you chose"), "For Goodreads lists the edition switch to make there");
        await go(`${BASE}/#/book/${wid}`); await until("!!document.querySelector('[data-act=ed-clear]')");
        await click("[data-act=ed-clear]"); await sleep(300);
        check(!(await evaluate(`!!${A}.books.get('${wid}').mine.grEdition`)), "and you can go back to the Goodreads edition");
      }
    }
  }

  // 1.2.1: set your place without counting it; the Desk's two columns
  if (!HELPER) {
    const A = "window.__antilibrary";
    const rid = await evaluate(`([...${A}.books.values()].find(b => b.status === 'reading' || b.status === 'want') || {}).id`);
    await go(`${BASE}/#/book/${rid}`); await until("!!document.querySelector('form[data-form=place]')");
    const tokensBefore = await evaluate(`(${A}.events.filter(e => e.type === 'progress' && e.source === 'app').length)`);
    await evaluate("(() => { const f = document.querySelector('form[data-form=place]'); f.page.value = '40'; f.requestSubmit(); })()"); await sleep(300);
    const cur = await evaluate(`(() => { let p = 0; for (const e of ${A}.byBook.get('${rid}') || []) if (e.type === 'progress') p = e.page; return p; })()`);
    check(cur === 40 && (await evaluate(`(${A}.events.filter(e => e.type === 'progress' && e.source === 'app').length)`)) === tokensBefore, "setting your place moves it without counting as reading");
    await go(`${BASE}/#/`); await until("!!document.querySelector('.figs')");
    const cols = await evaluate("(() => { const li = document.querySelector('ul.hand li.entry'); if (!li) return null; const a = li.querySelector('.who').getBoundingClientRect(), b = li.querySelector('.btns').getBoundingClientRect(); return { side: b.left > a.right, w: Math.round(document.querySelector('main').getBoundingClientRect().width) }; })()");
    check(!cols || (cols.side && cols.w >= 700), `the Desk is wide, with book and controls side by side (${cols ? cols.w + "px" : "nothing in hand"})`);
    const pt = await evaluate(`document.querySelector('.entry[data-id="${rid}"] .todaycol') ? document.querySelector('.entry[data-id="${rid}"] .todaycol').textContent : ''`);
    check(!/^\s*40\b/.test(pt), "and today's pages don't include it");
  }

  // 1.4: timed sessions teach your pace
  if (!HELPER) {
    const A = "window.__antilibrary";
    await go(`${BASE}/#/`); await until("!!document.querySelector('.figs')");
    check(!(await evaluate("!!document.querySelector('[data-act=timer-start]')")), "the reading timer is off unless you turn it on");
    await go(`${BASE}/#/settings`); await until("!!document.querySelector('[data-change=show-timer]')");
    await evaluate("(() => { const c = document.querySelector('[data-change=show-timer]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()"); await sleep(300);
    await go(`${BASE}/#/list`); await go(`${BASE}/#/`); await until("!!document.querySelector('.figs')");
    let tid = await evaluate("(document.querySelector('[data-act=timer-start]') || {}).dataset?.id || null");
    if (!tid) { // nothing in hand: hold one for the check (in memory)
      tid = await evaluate(`(() => { const b = [...${A}.books.values()].find(b => b.status === 'want'); b.status = 'reading'; ${A}.version++; return b.id; })()`);
      await go(`${BASE}/#/list`); await go(`${BASE}/#/`); await until("!!document.querySelector('[data-act=timer-start]')");
      tid = await evaluate("document.querySelector('[data-act=timer-start]').dataset.id");
    }
    await evaluate(`(() => { const b = ${A}.books.get('${tid}'); b.score = { ...(b.score || {}), C: 4, words: 90000 }; b.mine = { ...b.mine, pages: 300 }; delete b.mine.difficulty; ${A}.version++; })()`);
    await click(`[data-act=timer-start][data-id="${tid}"]`); await until("!!document.querySelector('.clock')");
    check(true, "▶ time it starts a running clock on the book");
    await evaluate(`${A}.timer.start = new Date(Date.now() - 30 * 60000).toISOString()`); // as if begun half an hour ago
    await click(`[data-act=timer-stop][data-id="${tid}"]`); await until("!!document.querySelector('form.stopform')");
    const startPage = await evaluate(`${A}.stopping.startPage`);
    await evaluate(`(() => { const f = document.querySelector('form.stopform'); f.page.value = String(${startPage} + 20); f.requestSubmit(); })()`); await sleep(400);
    const sess = await evaluate(`${A}.events.filter(e => e.type === 'session' && e.bookId === '${tid}').pop()`);
    check(sess && sess.minutes === 30 && sess.toPage - sess.fromPage === 20, `a stopped session keeps its time and pages (${sess && sess.minutes} min, ${sess && sess.toPage - sess.fromPage} pp)`);
    check((await text()).includes("Timed: 20 pages in thirty minutes"), "and says the pace back");
    const pageNow = await evaluate(`(() => { let p = 0; for (const e of ${A}.byBook.get('${tid}') || []) if (e.type === 'progress') p = e.page; return p; })()`);
    check(pageNow === startPage + 20, "the session's pages are logged as reading");
    await go(`${BASE}/#/settings`); await until("!!document.querySelector('.pace')");
    check(/too few to say anything/.test(await evaluate("document.querySelector('.pace').innerText")) && !(await evaluate("!!document.querySelector('[data-act=use-pace]')")), "one session is too few: nothing is offered");
    await go(`${BASE}/#/book/${tid}`); await until("!!document.querySelector('.record')");
    check(/Timed: about [\d.]+ min a page over 1 session/.test(await text()), "the book shows your timed minutes a page beside the model's");
  }

  // 1.5: ordering The List
  if (!HELPER) {
    const A = "window.__antilibrary";
    await go(`${BASE}/#/list`); await until("!!document.querySelector('[data-change=list-sort]')");
    check(await evaluate("document.querySelector('[data-change=list-sort]').value") === "custom", "The List opens in your own order");
    const keys = await evaluate(`[...${A}.books.values()].filter(b => b.status === 'want').map(b => b.id + b.queueKey).sort().join()`);
    await evaluate("(() => { const s = document.querySelector('[data-change=list-sort]'); s.value = 'title'; s.dispatchEvent(new Event('change', { bubbles: true })); })()"); await sleep(300);
    const titles = await evaluate("[...document.querySelectorAll('.waitingblock ol.shelf li a i')].map(i => i.textContent.toLowerCase().replace(/^(the|a|an) /, ''))");
    check(titles.length > 1 && titles.every((t, i) => i === 0 || t >= titles[i - 1]), "ordering by title sorts the waiting books");
    check((await text()).includes("Your own order is kept") && !(await evaluate("!!document.querySelector('li.row [data-act=menu]')")), "another order is a view: no moving, and it says so");
    check(await evaluate(`[...${A}.books.values()].filter(b => b.status === 'want').map(b => b.id + b.queueKey).sort().join()`) === keys, "your own order is untouched");
    await click("[data-act=sort-custom]"); await sleep(300);
    check(await evaluate("!!document.querySelector('li.row [data-act=menu]')"), "back in your order, books can be moved again");
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
