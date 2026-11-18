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
