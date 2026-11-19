"""Antilibrary's Mac helper: a small local service for the web app.

  - reads your Goodreads shelves through Chrome's existing login (daily, or on request)
  - fetches covers, page counts, years and the most-liked quote for each book
  - scores difficulty and reading-youth with the Claude API, only when the app asks
    (after you've seen a cost estimate)

Listens on 127.0.0.1 only. Answers only the Antilibrary app's own pages (by
origin, and a custom header that other sites can't send without permission).
Everything it keeps stays in ~/Library/Application Support/Antilibrary.
"""
from __future__ import annotations

import calendar
import hashlib
import json
import os
import queue
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import goodreads as gr
import scoring

VERSION = "1.0.0"
PORT = int(os.environ.get("ANTILIBRARY_PORT", "8749"))
ORIGINS = set(os.environ.get("ANTILIBRARY_ORIGINS", "https://jungleskrog.github.io,http://localhost:8731,http://127.0.0.1:8731").split(","))
DATA = Path(os.environ.get("ANTILIBRARY_DATA", Path.home() / "Library/Application Support/Antilibrary"))
SYNC_EVERY = 6 * 3600
SHELVES = ["currently-reading", "to-read", "read"]

DATA.mkdir(parents=True, exist_ok=True)
LOCK = threading.RLock()


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def load(name, default):
    p = DATA / name
    try:
        return json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(name, value):
    p = DATA / name
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1))
    tmp.replace(p)  # atomic


def book_key(b: dict) -> str:
    if b.get("goodreadsBookId") or b.get("book_id"):
        return f"gr:{b.get('goodreadsBookId') or b.get('book_id')}"
    h = hashlib.sha1(f"{b.get('title', '').lower()}|{b.get('author', '').lower()}".encode()).hexdigest()[:12]
    return f"t:{h}"


# --- State ---------------------------------------------------------------------------

state = {
    "job": None,          # {"kind", "done", "total", "started"}
    "last_error": None,
    "signed_in": None,
}
catalogue = load("catalogue.json", {"entries": {}})
shelves = load("shelves.json", None)
settings = load("settings.json", {})
usage = load("usage.json", [])
jobs: "queue.Queue[tuple]" = queue.Queue()


def entry(key):
    return catalogue["entries"].setdefault(key, {})


def session():
    return gr.Session(gr.chrome_cookie_header())


def user_id(s: gr.Session) -> str:
    if settings.get("goodreads_user_id"):
        return settings["goodreads_user_id"]
    body = s.get("/")
    m = re.search(r'/review/list/(\d+)', body) or re.search(r'/user/show/(\d+)', body)
    if not m:
        raise gr.SignedOut("Couldn't find your Goodreads account. Sign in to goodreads.com in Chrome.")
    settings["goodreads_user_id"] = m.group(1)
    save("settings.json", settings)
    return m.group(1)


# --- Jobs ------------------------------------------------------------------------------

def do_sync():
    global shelves
    s = session()
    uid = user_id(s)
    books = []
    for i, shelf in enumerate(SHELVES):
        state["job"].update(done=i, total=len(SHELVES))
        for b in gr.read_shelf(s, uid, shelf):
            books.append({
                "goodreadsBookId": b.book_id, "workId": b.work_id, "title": b.title, "author": b.author,
                "isbn13": b.isbn13, "pages": b.pages, "year": b.year_original, "binding": b.format,
                "shelf": shelf, "dateAdded": b.date_added, "dateStarted": b.date_started, "dateRead": b.date_read,
                "rating": b.rating, "position": b.position, "coverUrl": b.cover_url,
            })
    with LOCK:
        shelves = {"synced_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "user_id": uid, "books": books}
        save("shelves.json", shelves)
        for b in books:  # shelf data already carries covers and work ids
            e = entry(book_key(b))
            e.setdefault("details", {}).update({k: b[k] for k in ("workId", "coverUrl") if b.get(k)})
        save("catalogue.json", catalogue)
    state["signed_in"] = True
    log(f"synced {len(books)} books")
    # quotes for anything new (free: no AI), a few at a time
    if quote_backlog():
        jobs.put(("enrich", quote_backlog()))


QUOTE_PAUSE = 6          # seconds between quote pages
QUOTES_PER_DAY = 60      # a gentle daily cap; the rest follow on later days
BACKOFF = 6 * 3600       # after a firewall challenge


def quotes_today():
    day = time.strftime("%Y-%m-%d")
    return sum(1 for e in catalogue["entries"].values() if time.strftime("%Y-%m-%d", time.localtime(e.get("quote_checked_at", 0))) == day)


def quote_backlog():
    """Books with a work id whose quote hasn't been looked for yet."""
    return [k for k, e in catalogue["entries"].items() if k.startswith("gr:") and e.get("details", {}).get("workId") and "quote_checked_at" not in e]


def do_enrich(keys):
    """Most-liked quote per book (covers, pages and years already come with the shelves)."""
    if state.get("paused_until", 0) > time.time():
        return
    s = gr.Session(gr.chrome_cookie_header(), pause=QUOTE_PAUSE)
    room = max(0, QUOTES_PER_DAY - quotes_today())
    keys = keys[:room]
    for i, key in enumerate(keys):
        state["job"].update(done=i, total=len(keys))
        work = catalogue["entries"].get(key, {}).get("details", {}).get("workId")
        if not work:
            continue
        try:
            q = gr.top_quote(s, work)
        except gr.Throttled as ex:
            state["paused_until"] = time.time() + BACKOFF
            log(f"quotes paused: {ex}")
            break
        except Exception as ex:
            log(f"quote {key}: {ex}")
            continue
        with LOCK:
            e = entry(key)
            e["quote"] = q
            e["quote_checked_at"] = time.time()
            e.pop("details_error", None)
            if i % 10 == 9:
                save("catalogue.json", catalogue)
    with LOCK:
        save("catalogue.json", catalogue)
    log(f"quotes: looked at {len(keys)}, {len(quote_backlog())} still to do")


def do_score(books, max_usd):
    client = scoring.anthropic.Anthropic()
    run_usage = []
    for i, b in enumerate(books):
        state["job"].update(done=i, total=len(books), spent=scoring.cost(run_usage))
        if scoring.cost(run_usage) > max_usd:
            raise RuntimeError(f"stopped at the agreed limit of ${max_usd:.2f} after {i} books")
        try:
            sc = scoring.score_book(client, b, run_usage)
            with LOCK:
                e = entry(b["key"])
                e["score"] = sc
                e.pop("score_error", None)
        except scoring.ScoreProblem as ex:
            with LOCK:
                entry(b["key"])["score_error"] = str(ex)
        if i % 10 == 9:
            with LOCK:
                save("catalogue.json", catalogue)
    with LOCK:
        usage.extend(run_usage)
        save("usage.json", usage)
        save("catalogue.json", catalogue)
    log(f"scored {len(books)} books for ${scoring.cost(run_usage):.4f}")


def worker():
    while True:
        kind, *args = jobs.get()
        state["job"] = {"kind": kind, "done": 0, "total": 0, "started": time.time()}
        try:
            {"sync": do_sync, "enrich": do_enrich, "score": do_score}[kind](*args)
            state["last_error"] = None
        except gr.Throttled as ex:
            state["paused_until"] = time.time() + BACKOFF
            state["last_error"] = str(ex)
            log("throttled:", ex)
        except gr.SignedOut as ex:
            state["signed_in"] = False
            state["last_error"] = str(ex)
            log("signed out:", ex)
        except Exception as ex:
            state["last_error"] = f"{kind}: {ex}"
            log(traceback.format_exc())
        finally:
            state["job"] = None


def scheduler():
    time.sleep(5)
    while True:
        last = shelves and shelves.get("synced_at")
        due = not last or time.time() - calendar.timegm(time.strptime(last, "%Y-%m-%dT%H:%M:%SZ")) > SYNC_EVERY
        idle = state["job"] is None and jobs.empty()
        if due and idle and state.get("paused_until", 0) < time.time():
            jobs.put(("sync",))
        elif idle and quote_backlog() and quotes_today() < QUOTES_PER_DAY and state.get("paused_until", 0) < time.time():
            jobs.put(("enrich", quote_backlog()))
        time.sleep(3600)


# --- HTTP ---------------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = f"AntilibraryHelper/{VERSION}"

    def log_message(self, fmt, *a):
        pass

    def allowed(self):
        return self.headers.get("Origin") in ORIGINS

    def cors(self):
        o = self.headers.get("Origin")
        if o in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")

    def reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        if not self.allowed():
            self.send_response(403); self.end_headers(); return
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Antilibrary")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def guard(self):
        if not self.allowed() or self.headers.get("X-Antilibrary") != "1":
            self.reply(403, {"error": "This helper only answers the Antilibrary app."})
            return False
        return True

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        if not self.guard():
            return
        path = self.path.split("?")[0]
        if path == "/status":
            return self.reply(200, {
                "version": VERSION, "job": state["job"], "queued": jobs.qsize(), "last_error": state["last_error"],
                "signed_in": state["signed_in"], "goodreads_user_id": settings.get("goodreads_user_id"),
                "synced_at": shelves and shelves.get("synced_at"), "scoring_ready": bool(os.environ.get("ANTHROPIC_API_KEY")),
                "model": scoring.MODEL, "spent_usd": round(scoring.cost(usage), 4),
                "quotes": {"found": sum(1 for e in catalogue["entries"].values() if e.get("quote")),
                           "to_do": len(quote_backlog()), "per_day": QUOTES_PER_DAY,
                           "paused_until": state.get("paused_until") if state.get("paused_until", 0) > time.time() else None},
            })
        if path == "/shelves":
            return self.reply(200, shelves or {"synced_at": None, "books": []})
        if path == "/catalogue":
            with LOCK:
                return self.reply(200, catalogue)
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if not self.guard():
            return
        path = self.path.split("?")[0]
        b = self.body()
        if path == "/sync":
            jobs.put(("sync",))
            return self.reply(202, {"queued": True})
        if path == "/enrich":
            keys = quote_backlog()
            if keys:
                jobs.put(("enrich", keys))
            return self.reply(202, {"queued": len(keys)})
        if path == "/estimate":
            return self.reply(200, scoring.estimate(len(b.get("books", [])), usage))
        if path == "/score":
            books = [x for x in b.get("books", []) if x.get("key") and x.get("title")]
            max_usd = float(b.get("max_usd", 0))
            if not os.environ.get("ANTHROPIC_API_KEY"):
                return self.reply(400, {"error": "No ANTHROPIC_API_KEY for the helper (see the README)."})
            if not books or max_usd <= 0:
                return self.reply(400, {"error": "Nothing to score, or no spending limit agreed."})
            jobs.put(("score", books, max_usd))
            return self.reply(202, {"queued": len(books)})
        self.reply(404, {"error": "not found"})


def main():
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=scheduler, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"Antilibrary helper {VERSION} on http://127.0.0.1:{PORT} (data in {DATA})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
