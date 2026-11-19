# Tsundoku Tracker

*Tsundoku* (積ん読): buying books and letting them pile up unread. Tsundoku Tracker keeps the pile in order. It holds one list of the books you mean to read, how much effort each takes, and a quiet record of what you've read.

It is a web app you can install. Your library stays in your own browser, nothing is sent to a server, and there are no accounts, streaks or badges. An optional helper on a Mac keeps it in step with Goodreads.

**Open it:** <https://jungleskrog.github.io/tsundoku-tracker/>

Everyone who opens that address gets their own empty library, kept in their own browser. Nobody else can see it, including whoever hosts the page.

## Contents

- [Getting started](#getting-started)
- [How it works](#how-it-works)
- [Your data and backups](#your-data-and-backups)
- [Goodreads, both ways](#goodreads-both-ways)
- [The Mac helper (optional)](#the-mac-helper-optional)
- [Reading-youth](#reading-youth)
- [The Library](#the-library)
- [The printed year](#the-printed-year)
- [Hosting your own copy](#hosting-your-own-copy)
- [Development](#development)
- [Privacy](#privacy)

## Getting started

When you open the app the first time, the Desk shows a short *Getting started* list. Each step ticks itself off once you've done it.

1. **Bring in your books.** You can import from Goodreads (*My Books › Import and export › Export library*, then choose the file on the Import page), use the bookmark described below, or add books by hand. Want to Read and Currently Reading become your list, and Read becomes your history. Before anything changes, you see exactly what the import will do.
2. **Choose your daily effort,** in tokens. One token is about four minutes of focused reading.
3. **Keep a backup** (see below).
4. **Put the list in order** with *Move to…*, by dragging, or with the keys.
5. **Install it.**
   - On a Mac in Chrome: *⋮ › Cast, save and share › Install page as app*. It then appears in Launchpad.
   - On an iPhone in Safari: *Share › Add to Home Screen*.
   - On Android: *⋮ › Install app*.

   Once installed, it works offline.

*Settings › How it works* explains everything in plain words.

## How it works

- **The list.** There is one ordered list. *Next*, *Soon* and *The stacks* are stretches of it, and you choose how many books each holds.
  - Move a book with *Move to…*, by dragging (on a phone, drag the ⠿ handle), or with the keys:
    - <kbd>↑</kbd> and <kbd>↓</kbd> choose a book;
    - <kbd>Alt</kbd>+arrows move it one place;
    - <kbd>T</kbd> moves it to the top, and <kbd>N</kbd>, <kbd>S</kbd> and <kbd>B</kbd> to Next, Soon or The stacks;
    - <kbd>M</kbd> opens *Move to…*.
  - A book can be set to *read after* another. It then stays below that book.
- **Tokens, difficulty, pages.** Each book has a difficulty from 1 to 10. This measures reading effort, not merit: how slowly a page goes. A page costs tokens according to its difficulty, so you set *tokens a day* and the app works out how many pages that means for each book in hand, and when each one will finish. You can change the constants in *Settings › The model*.
- **More than one book at once.** Each book's share of your day is learned from what you've actually read over the last fortnight. If you fall behind, the app says so in words; nothing is shown in red.
- **Logging.** Use *+1*, *+2* or *+5* pages, or type the page you've reached. Every entry is kept with its time. The history, colophons, weekly letters and printed year are all built from these entries.

## Your data and backups

Everything lives in your browser (IndexedDB) on that device.

- **Sync between devices (Dropbox).** In *Settings › Sync between devices*, sign in to Dropbox on each device: your phone, your Mac, anywhere.
  - The library is kept as one file in *Dropbox › Apps › Tsundoku Tracker*.
  - Each device brings in the others' changes when the app opens, after every change, and every few minutes. Every entry is merged, so nothing is lost if two devices change at once.
  - On an iPhone home-screen app, sign-in uses a code you paste, because iOS can't send the sign-in back to the app.

- **Backup file (Chrome).** In *Settings › Keeping your library safe*, choose a file in Dropbox or iCloud Drive. Every change is then saved to it. Open the same file on another device to carry the library across: *Load from a copy… › Merge it in* keeps everything from both.
- **Other browsers.** Use *Save a copy now* from time to time.
- **Earlier copies.** The app keeps its own copies before any big change (an import, a reordering or a restore), and you can restore them from Settings.

## Goodreads, both ways

**In.** There are three routes. Each shows what will change before anything does, and importing again is always safe: books are matched, your own edits are kept, and nothing is deleted.

- **The export file:** *My Books › Import and export › Export library* on goodreads.com.
- **The bookmark:**
  1. On the Import page, drag *Tsundoku Tracker: read my shelves* to your bookmarks bar.
  2. On goodreads.com, signed in, click it.
  3. It reads your three shelves in your own tab, about a page a second, then choose *Send to Tsundoku Tracker*.

  The bookmark talks only to Goodreads and to this app. If the browser blocks the new tab, use *Copy* and paste on the Import page instead.
- **The Mac helper:** it reads your shelves by itself every six hours (see below).

If a book moved shelf on Goodreads, it moves in the app too, as long as you haven't changed it in the app since. A book marked read on Goodreads is always marked read in the app. New books join the end of the list and then move into place by reading-youth once they've been scored.

**Out.** Goodreads gives apps no way to change your shelves, so the Desk links to *For Goodreads*. This lists each book whose Goodreads shelf doesn't match the app, says what to change, and links to the book. The next read of your shelves confirms each change. On Goodreads a book can sit on only one of Want to Read, Currently Reading and Read, and moving a book off Read removes its read date there.

## The Mac helper (optional)

The helper is a small program on your own Mac. It:

- reads your Goodreads shelves through Chrome's existing sign-in, so it never stores a password;
- fetches covers and each book's most-liked quote, a few an hour to stay gentle;
- if you add your own Claude API key, scores each book's difficulty and reading-youth.

It listens only on `127.0.0.1:8749` and answers only this app.

**You need** a Mac, [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`), Chrome signed in to goodreads.com and, for scores, a Claude API key.

    git clone https://github.com/jungleskrog/tsundoku-tracker.git
    cd tsundoku-tracker/helper && ./install.sh     # starts at login; adds the antilibrary-helper command
    antilibrary-helper status                 # also: start | stop | restart | logs

For scores, add `export ANTHROPIC_API_KEY=…` to `~/.zshrc`, then run `antilibrary-helper restart`. The key stays on your Mac.

When the helper is running, *Settings › The Mac helper* shows that it's connected.

**What scoring costs.** Settings shows an estimate before anything runs, and every run stops at a limit you agree to.
- Difficulty is scored per book with Claude Haiku 5.5, at about a tenth of a cent a book, so a whole library of 180 books costs about ten cents.
- *Score new books as they arrive* is off until you turn it on, and it has a monthly limit.

The helper's data folder is `~/Library/Application Support/Antilibrary` and its log is `~/Library/Logs/Antilibrary`. To uninstall, run `antilibrary-helper stop`, then delete `~/Library/LaunchAgents/com.antilibrary.helper.plist`, `~/.local/bin/antilibrary-helper` and those two folders.

## Reading-youth

Each scored book also gets a figure from 0 to 100 for when in a reading life it's good to read. Early books are ways in that give energy and appetite; later books ask more of the reader and pay back what came before. It is a suggestion:

- *The List › Compare with the reading-youth order* shows your order beside the youth order before anything moves.
- *Accept* applies it, and *Put back the order before* undoes it.
- Your own figure on a book's page always wins, and it moves the book among books of a similar figure.

**Tell it your taste.** Put a sentence or two in `reading-taste.txt` in the helper's data folder, saying in your own words what you think belongs early and what belongs later. Both scoring prompts quote it, and it never leaves your Mac except as part of the prompt.

**Scoring the whole library together.** For the best order, score all the books in one pass, so they're judged against each other. This uses Claude Opus 5.5 and costs about $0.25–0.50 for 180 books:

    cd helper
    uv run youth.py                 # lists the books and the most it can cost; spends nothing
    uv run youth.py --yes           # writes youth-v5-candidate.json in the data folder
    uv run youth.py --apply "$HOME/Library/Application Support/Antilibrary/youth-v5-candidate.json"

Nothing changes until you apply the candidate file.

## The Library

- **Wall label:** a museum-style label for the list. It shows how many pages and hours the list holds, how heavy it is (with a difficulty histogram), how long it runs at your present pace, and whether Next is heavier than the rest.
- **Shelf letters:** a short letter each week, written from what you logged, with no AI. It says what you gave your time to, what you finished, began or set aside, includes a note from the margin, and says where the books in hand are heading.
- **Colophon:** each finished or set-aside book carries one on its page, giving the edition, dates, sittings, hours and the longest sitting.
- **Marginalia:** *Note in the margin* keeps a one-line note at the page you've reached.
- **Commonplace book:** your own lines and margin notes, gathered by year.

## The printed year

*The Library › The printed year* sets a year of reading as a small book. It has a title page (with your name if you add one), the year in figures, every finished book with its line, colophon and notes, the books set aside, the commonplace book, the year's letters and a colophon.

- **Print or save as PDF:** prints on numbered A5 pages. Choose *Save as PDF* in the print dialog, and turn off headers and footers.
- **Download as one page:** saves a single HTML file of about 340 KB with the typeface built in. It works offline in any browser.

## Hosting your own copy

The app is plain files in `app/`, with no build step.

1. Fork the repository.
2. In *Settings › Pages*, set the source to *GitHub Actions*.

The included workflow (`.github/workflows/pages.yml`) runs the tests and publishes `app/`. Your copy is then at `https://<you>.github.io/<repo>/`.

If you use the helper with your own copy, tell the helper about your copy's address. Add this to `helper/service.sh`, then run `antilibrary-helper restart`:

    export ANTILIBRARY_ORIGINS="https://<you>.github.io,http://localhost:8731"

### Dropbox sync for your copy

Sync needs a Dropbox app registered once by whoever hosts the copy. Everyone then signs in with their own Dropbox. The app key isn't a secret: sign-in uses PKCE, so there is nothing secret in the code.

1. At <https://www.dropbox.com/developers/apps>, choose *Create app › Scoped access › App folder* and give it a name.
2. *Permissions*: tick `files.content.write` and `files.content.read`, then *Submit*.
3. *Settings › OAuth 2 › Redirect URIs*: add your copy's address (for example `https://<you>.github.io/<repo>/`) and `http://localhost:8731/`. Leave *Allow public clients* on.
4. Put the *App key* in `app/js/config.js`.

## Development

    npm run serve                  # http://localhost:8731/
    npm test                       # the rules: ordering, the model, Goodreads, the library, the year
    npm run test:browser           # the app end to end in headless Chrome (a fresh, empty profile)
    npm run test:browser -- --helper --shots <dir>   # against your real library through the helper
    cd helper && uv run pytest     # the helper

You need Node 22 or later and Chrome. There are no dependencies to install for the app.

    app/                the web app (served as is)
      js/main.js        state, views and actions
      js/domain.js      books, the event log, import planning, merging backups
      js/model.js       tokens ↔ difficulty ↔ pages, learned shares, the forecast
      js/order.js       the list: bands, moves, read-after, reading-youth
      js/goodreads.js   the round trip: what to change on Goodreads, the bookmark's data
      js/library.js     colophons, the wall label, shelf letters, the commonplace book
      js/year.js        the printed year
      js/dropbox.js     sync: Dropbox sign-in (PKCE), the library file, merge and retry
      js/config.js      this copy's Dropbox app key
      js/store.js       IndexedDB;  js/backup.js  backup files
      bookmarklet.js    the Goodreads bookmark (the Import page builds it)
      css/              app.css, year.css (screen, print, export), fonts.css
    helper/             the Mac helper: server.py, goodreads.py, scoring.py, youth.py
    tests/              unit tests and a made-up Goodreads export
    tools/              the local server and the browser tests

The app was called Antilibrary until version 0.7 (and lived at /antilibrary/ until 1.2). Its storage, backup format and helper still use that name internally, so existing libraries keep working.

The code is under the MIT License (`LICENSE`). The typeface is Source Serif 4, under the SIL Open Font License (`app/fonts/OFL.txt`).

## Privacy

- **Without the helper,** the app fetches only its own files and book covers. It also looks for the helper on your own Mac (`127.0.0.1`), which never leaves your computer.
- **With the helper,** your Mac talks to Goodreads (your own shelves and public quote pages) and, only when you agree to scoring, to the Claude API (titles, authors, years and page counts, plus your `reading-taste.txt`).
- Your library, your notes and your Claude API key never go anywhere else.
