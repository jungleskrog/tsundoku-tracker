# Antilibrary

A personal reading catalogue: an ordered list of books, effort tokens ↔ difficulty ↔ pages, and a lasting record of what you read. Static web app (installable), your data in your browser, an optional helper on your Mac for Goodreads.

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
    helper/         Mac helper (Stage 4): Goodreads through Chrome's login
    bookmarklet/    fallback Goodreads sync for other users
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
