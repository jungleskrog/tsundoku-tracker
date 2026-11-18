# Stage 1 — Proof of data in (18 Nov 2026)

Counts only; no personal titles in the repo.

| Route | Result |
| --- | --- |
| Helper (Chrome login) — shelves | 180/180 books from 3 shelves in 4 requests, 17 s. Agrees with the CSV export on every id, shelf, page count and ISBN-13. |
| Helper — extra over CSV | covers (179/180, full size, CORS `*`), work ids (180/180), start dates (13), Goodreads shelf positions |
| Helper — book page | pages, format, ISBN-13, publisher, language, cover, first-publication year: 7/7 sample |
| Helper — quotes | most-liked quote ≤280 chars: 5/7 sample (2 books have none) |
| CSV export | 23 columns; pages 177/180, original year 170/180 (edition year fills the rest), dates read 14/14. No covers, work ids or start dates. ISBNs wrapped as `="…"`. |
| Bookmarklet (parsing) | Same 180 books, 0 field differences vs. helper (headless Chrome against saved pages). Not yet run in a live signed-in tab. |
| Open Library | 15/15 sample ISBNs found, 14 with pages, 13 with covers. 34/180 books have no ISBN-13. |

Fixes found: first-publication year must take the last number ("Jan 20, 1605"); quote markup uses single-quoted classes.
