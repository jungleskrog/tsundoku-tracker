# Tsundoku Tracker

*Tsundoku* (積ん読): letting books pile up unread. A personal reading catalogue: an ordered list of books, effort tokens ↔ difficulty ↔ pages, and a lasting record of what you read. Static web app (installable), your data in your browser, an optional helper on your Mac for Goodreads.

*Work in progress — built in stages. Full README arrives in Stage 9.*

## Run it locally

    npm run serve          # http://localhost:8731/

No build step and no dependencies: plain ES modules in `app/`.

## Tests

    npm test               # domain logic (Node's test runner)
    npm run test:browser   # storage + the app end to end, in headless Chrome

`npm run test:browser -- --csv <your Goodreads export> --shots <dir>` runs the same checks against a real export and saves screenshots. Your data never goes in the repo.

## Layout

    app/            the web app (served as is by GitHub Pages)
      js/domain.js  rules: books, events, import planning, merging backups
      js/store.js   IndexedDB
      js/backup.js  backup files (auto-saved file in Chrome)
      js/order.js   the waiting list: bands, moves, read-after, reading-youth
      js/library.js    colophons, the wall label, shelf letters, the commonplace book
      js/goodreads.js  the round trip: what to change on Goodreads, the bookmark's data
      bookmarklet.js   "Antilibrary: read my shelves" (Import page makes the bookmark)
    helper/         Mac helper (Stage 4): Goodreads through Chrome's login
    tests/          tests and a made-up Goodreads export

Font: Source Serif 4 (SIL Open Font License, `app/fonts/OFL.txt`).

## The Mac helper (optional)

A small background service that reads your Goodreads shelves through Chrome's existing login, fetches each book's most-liked quote (a few an hour, to stay gentle), and scores difficulty with the Claude API when you ask in Settings (after a cost estimate). It listens only on 127.0.0.1:8749 and answers only the Antilibrary app.

    cd helper && ./install.sh        # login item + the `antilibrary-helper` command
    antilibrary-helper status | restart | logs

Needs [uv](https://docs.astral.sh/uv/), Chrome signed in to Goodreads, and (for scores) `export ANTHROPIC_API_KEY=…` in `~/.zshrc`. Data lives in `~/Library/Application Support/Antilibrary`. Other users' own app addresses can be allowed with `ANTILIBRARY_ORIGINS`.

### Reading-youth

Besides difficulty, each book gets a reading-youth figure: when in a reading life it is going to be good to read. It is scored for the whole library in one comparative pass, so the books are judged against each other (`helper/youth.py`, Claude Opus 5.5, about $0.25 for 180 books). The pass writes a candidate file for review; nothing changes until you apply it:

    cd helper
    uv run youth.py                  # shows the most it can cost
    uv run youth.py --yes            # writes youth-v5-candidate.json in the data folder
    uv run youth.py --apply "$HOME/Library/Application Support/Antilibrary/youth-v5-candidate.json"

In the app, The List › Compare with the reading-youth order shows the two orders side by side before anything moves, along with suggested reading orders (one book answering another). Your own youth figure on a book's page always wins.

## Goodreads, both ways

**In.** Three routes bring your shelves in; each shows what will change before anything does, and re-importing is always safe.
- The Mac helper reads them every six hours, and whenever you open the app if they're more than three hours old.
- The bookmark (Import page › drag *Antilibrary: read my shelves* to the bookmarks bar): click it on goodreads.com and choose *Send to Antilibrary*. It reads your three shelves in your own tab, a page a second, and hands them to the app; *Copy* and paste is the fallback.
- The CSV export.

A book that moved shelf on Goodreads moves here too, if you hadn't changed it here since (and a book read there is always marked read). New waiting books land at the end, then take their place by reading-youth once they're scored: score them in Settings, or turn on *Score new books as they arrive* (Haiku, about a tenth of a cent a book, with a monthly limit).

**Out.** Goodreads has no way in for apps, so The Desk links to *For Goodreads*: each book whose shelf there doesn't match the app, with what to change and a link to it. The next read of your shelves confirms it; *Done* hides one meanwhile. On Goodreads a book sits on only one of Want to Read, Currently Reading and Read (and any exclusive shelf of your own), and moving a book off Read removes its read date there.

## The Library

- **Wall label.** A museum label for the waiting list: how many pages and hours it holds, how heavy it is (a difficulty histogram and the light / middling / heavy split), how long it runs at your present pace, and whether Next is heavier or lighter than the rest.
- **Shelf letters.** Each week a short letter written from what you logged (no AI): what you gave your time to, what you finished, began or set aside, a note from the margin, and where the books in hand are heading. The Desk mentions last week's until you've read it.
- **Colophon.** A finished or set-aside book carries one on its page: edition, dates, sittings, hours, the longest sitting. Books read before the app say what Goodreads recorded.
- **Marginalia.** *Note in the margin* on the Desk or a book's page keeps a one-line note at the page you've reached. Notes show in the book's history, the week's letter and the commonplace book.
- **Commonplace book.** Your own lines (an annotation you've written yourself) and margin notes, by year. Goodreads quotes aren't yours, so they stay out.

The app was called Antilibrary until version 0.7. Its storage, backup files and helper still use that name inside, so nothing needed moving.
