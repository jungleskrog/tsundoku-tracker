"""Read-only Goodreads access for the Antilibrary helper.

Uses the session Chrome already has (no password stored), fetches the user's
own shelf pages, book pages and quote pages, politely and slowly.
Stage 1 spike: parsing only, no storage.
"""
from __future__ import annotations

import html
import json
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, asdict

BASE = "https://www.goodreads.com"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
PAUSE = 1.5  # seconds between requests


class GoodreadsError(Exception):
    pass


class SignedOut(GoodreadsError):
    pass


class Throttled(GoodreadsError):
    """Goodreads' firewall asked for a browser challenge: back off for hours."""


def chrome_cookie_header(browser: str = "chrome") -> str:
    from yt_dlp.cookies import extract_cookies_from_browser
    jar = extract_cookies_from_browser(browser)
    parts = [f"{c.name}={c.value}" for c in jar if c.domain.lstrip(".").endswith("goodreads.com")]
    if not parts:
        raise SignedOut("Chrome has no Goodreads login. Sign in to goodreads.com in Chrome, then try again.")
    return "; ".join(parts)


class Session:
    def __init__(self, cookie: str | None = None, pause: float = PAUSE):
        self.cookie = cookie
        self.pause = pause
        self._last = 0.0
        self.requests = 0

    def get(self, path: str) -> str:
        wait = self._last + self.pause - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        headers = {"User-Agent": UA}
        if self.cookie:
            headers["Cookie"] = self.cookie
        req = urllib.request.Request(urllib.parse.urljoin(BASE, path), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                final = r.geturl()
                if r.status == 202 or r.headers.get("x-amzn-waf-action"):
                    raise Throttled("Goodreads is asking for a browser check; pausing for a few hours.")
                body = r.read().decode("utf-8", "replace")
        finally:
            self._last = time.monotonic()
            self.requests += 1
        if "/user/sign_in" in final:
            raise SignedOut("Goodreads asked to sign in. Open goodreads.com in Chrome and sign in.")
        return body


# --- Shelves -----------------------------------------------------------------

@dataclass
class ShelfBook:
    book_id: str
    title: str
    author: str
    shelf: str
    work_id: str | None = None
    isbn: str | None = None
    isbn13: str | None = None
    asin: str | None = None
    pages: int | None = None
    year_original: int | None = None
    edition_date: str | None = None
    format: str | None = None
    cover_url: str | None = None
    date_added: str | None = None
    date_started: str | None = None
    date_read: str | None = None
    rating: int | None = None
    position: int | None = None
    shelves: list[str] = field(default_factory=list)


_ROW = re.compile(r'<tr id="review_\d+" class="bookalike review">(.*?)</tr>', re.S)
_FIELD = re.compile(r'<td class="field (\w+)"[^>]*>(.*?)</td>', re.S)


def _text(fragment: str) -> str:
    t = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html.unescape(t)).strip()


def _value(fragment: str, label: str) -> str | None:
    """Text of a field with its column label and '[edit]' links removed."""
    t = _text(fragment)
    if t.lower().startswith(label):
        t = t[len(label):].strip()
    t = t.replace("[edit]", "").strip()
    return t or None


def _int(s: str | None) -> int | None:
    m = re.search(r"\d[\d,]*", s or "")
    return int(m.group(0).replace(",", "")) if m else None


def _year(s: str | None) -> int | None:
    """Last number in 'Jan 20, 1605' / '1605' / '-800'; None for 'unknown'."""
    m = re.findall(r"-?\d+", s or "")
    return int(m[-1]) if m else None


def _date(s: str | None) -> str | None:
    """'Nov 13, 2026' / 'Nov 2026' / '2026' -> ISO-ish; 'not set' -> None."""
    if not s or "not set" in s:
        return None
    s = s.split(" (")[0].strip()
    for fmt in ("%b %d, %Y", "%b %Y", "%Y"):
        try:
            d = time.strptime(s, fmt)
            return {"%b %d, %Y": f"{d.tm_year:04d}-{d.tm_mon:02d}-{d.tm_mday:02d}",
                    "%b %Y": f"{d.tm_year:04d}-{d.tm_mon:02d}",
                    "%Y": f"{d.tm_year:04d}"}[fmt]
        except ValueError:
            continue
    return s


def _full_cover(url: str | None) -> str | None:
    if not url or "nophoto" in url:
        return None
    return re.sub(r"\._S[XY]\d+_", "", url)


def parse_shelf_page(page: str, shelf: str) -> list[ShelfBook]:
    books = []
    for row in _ROW.findall(page):
        f = {name: frag for name, frag in _FIELD.findall(row)}
        link = re.search(r'href="/book/show/(\d+)', f.get("title", ""))
        if not link:
            continue
        cover = re.search(r'<img[^>]+src="([^"]+)"', f.get("cover", ""))
        work = re.search(r'/work/editions/(\d+)', f.get("format", ""))
        author = _value(f.get("author", ""), "author") or ""
        if "," in author and author.count(",") == 1:  # "Bukowski, Charles" -> "Charles Bukowski"
            last, first = [p.strip() for p in author.split(",")]
            author = f"{first} {last}".strip()
        title_a = re.search(r'<a[^>]*title="([^"]+)"', f.get("title", ""))
        stars = re.search(r'staticStars[^"]*"\s+title="([^"]+)"', f.get("rating", ""))
        rated = {"did not like it": 1, "it was ok": 2, "liked it": 3, "really liked it": 4, "it was amazing": 5}
        shelves = re.findall(r'shelf=([\w-]+)', f.get("shelves", ""))
        books.append(ShelfBook(
            book_id=link.group(1),
            title=html.unescape(title_a.group(1)) if title_a else (_value(f.get("title", ""), "title") or ""),
            author=author,
            shelf=shelf,
            work_id=work.group(1) if work else None,
            isbn=_value(f.get("isbn", ""), "isbn"),
            isbn13=_value(f.get("isbn13", ""), "isbn13"),
            asin=_value(f.get("asin", ""), "asin"),
            pages=_int(_value(f.get("num_pages", ""), "num pages")),
            year_original=_year(_value(f.get("date_pub", ""), "date pub")),
            edition_date=_date(_value(f.get("date_pub_edition", ""), "date pub edition")),
            format=_value(f.get("format", ""), "format"),
            cover_url=_full_cover(cover.group(1) if cover else None),
            date_added=_date(_value(f.get("date_added", ""), "date added")),
            date_started=_date(_value(f.get("date_started", ""), "date started")),
            date_read=_date(_value(f.get("date_read", ""), "date read")),
            rating=rated.get(stars.group(1)) if stars else None,
            position=_int((re.search(r'name="positions\[\d+\]" value="(\d+)"', f.get("position", "")) or [None, None])[1]),
            shelves=sorted(set(shelves)),
        ))
    return books


def read_shelf(session: Session, user_id: str, shelf: str, per_page: int = 100) -> list[ShelfBook]:
    out: list[ShelfBook] = []
    page = 1
    while True:
        body = session.get(f"/review/list/{user_id}?shelf={shelf}&per_page={per_page}&page={page}&sort=date_added&order=a")
        got = parse_shelf_page(body, shelf)
        new = [b for b in got if b.book_id not in {x.book_id for x in out}]
        out.extend(new)
        if len(got) < per_page or not new:
            return out
        page += 1


# --- Book pages and quotes ---------------------------------------------------

def book_details(session: Session, book_id: str) -> dict:
    body = session.get(f"/book/show/{book_id}")
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', body, re.S)
    if not m:
        raise GoodreadsError(f"book {book_id}: page layout not recognised")
    state = json.loads(m.group(1))["props"]["pageProps"]["apolloState"]
    book = next((v for k, v in state.items() if k.startswith("Book:") and str(v.get("legacyId")) == str(book_id)), None)
    if not book:
        raise GoodreadsError(f"book {book_id}: not found in page data")
    work = state.get((book.get("work") or {}).get("__ref", ""), {})
    det, wdet = book.get("details") or {}, work.get("details") or {}
    author_ref = ((book.get("primaryContributorEdge") or {}).get("node") or {}).get("__ref", "")
    author = (state.get(author_ref) or {}).get("name")
    pub = wdet.get("publicationTime")
    return {
        "book_id": str(book_id),
        "title": book.get("title"),
        "author": author,
        "work_id": str(work.get("legacyId")) if work.get("legacyId") else None,
        "pages": det.get("numPages"),
        "format": det.get("format"),
        "isbn13": det.get("isbn13"),
        "publisher": det.get("publisher"),
        "language": (det.get("language") or {}).get("name"),
        "cover_url": book.get("imageUrl"),
        "year_original": time.gmtime(pub / 1000).tm_year if isinstance(pub, (int, float)) else None,
    }


def top_quote(session: Session, work_id: str, max_chars: int = 280) -> dict | None:
    """Most-liked quote for a work that fits on one annotation line, or None.

    Quote pages list quotes by popularity (30 a page); we take the first page.
    """
    body = session.get(f"/work/quotes/{work_id}")
    best = None
    for block in re.split(r"<div class=['\"]quoteDetails['\"]>", body)[1:]:
        raw = re.search(r'<div class="quoteText">(.*?)&#8213;', block, re.S)
        likes = re.search(r'>([\d,]+) likes<', block)
        if not raw:
            continue
        text = _text(raw.group(1)).strip().strip("\u201c\u201d\"").strip()
        n = _int(likes.group(1)) if likes else 0
        if text and len(text) <= max_chars and (best is None or n > best["likes"]):
            best = {"text": text, "likes": n}
    return best


def as_dict(b: ShelfBook) -> dict:
    return asdict(b)
