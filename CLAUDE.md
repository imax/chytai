# Chytai: how to work here

Chytai is a Ukrainian reading platform: the site https://chytai.org.ua (`web/`, Fly app `chytai-web`) and the reader
https://app.chytai.org.ua (`server/` + `src/`, Fly app `chytai`). `app/` is the iOS WebView shell, `mac/` the Mac app (Swift
over WKWebView, `mac/build.sh`; branch pushes get a `mac-beta` pre-release, see `mac/README.md`). The owner is Max; he writes Ukrainian, and every word a reader sees is Ukrainian, short, one plain clause.
The repo is public: never commit secrets, keys or `data/`.

Keep this file up to date (Max, 2026-11-09): when you add a way of working, a tool, an endpoint or a rule that the
next thread should know, change this file in the same commit. Short recipes, not history.

## Ship

- Push straight to `main`, no pull requests. `web.yml` deploys `web/**` to chytai-web, `deploy.yml` the rest to the
  reader. Both run a smoke test first (`scripts/smoke-test.sh`, `scripts/smoke-reader.sh`); the site also runs
  `scripts/perf-check.sh` after the deploy and goes back to the previous image when a main page got slow.
- A new page or admin tab goes into the smoke test's lists.
- Don't deploy during the Friday digest (09:30 Kyiv). Batch small fixes.

## Prove it works before you push

1. `scripts/fetch-test-db.sh`: a scrubbed copy of last night's production DB into `data/web/` (e-mails are
   `<id>@test.invalid`, the owner is `owner@test.invalid`).
2. `npm ci`, then `CHYTAI_ROLE=web PORT=8090 node web/server.js`. Sign in at `/login` with any test address: the code
   is printed in the server log (no mail goes out locally).
3. Go through the change itself, as a guest and as a reader: curl or Playwright (Chromium is preinstalled), phone
   (390 px) and desktop widths. Time anything that could be slow on this real-sized data.
   For an iPhone-only reader bug add WebKit (closest to iOS, not the same):
   `PLAYWRIGHT_BROWSERS_PATH=<scratch> npx -y playwright@1.63.0 install webkit && npx -y playwright@1.63.0 install-deps webkit`,
   then `webkit.launch()` with that `PLAYWRIGHT_BROWSERS_PATH`. The reader alone: `READER_SECRET=x DATA_DIR=<dir>
   ANTHROPIC_API_KEY=dummy node server/index.js`, a book in `<dir>/accounts/<16 hex>/books/`, cookie
   `reader_acct=<id>.<base64url HMAC-SHA256("acct:<id>", READER_SECRET)>`, open `/?open=<file>`.
4. `scripts/smoke-test.sh` (site), `scripts/smoke-reader.sh` (reader).
5. Show Max what you checked: screenshots, the numbers, what you could not check.

## See production (read only)

Every thread's container has `FLY_API_TOKEN`. The same token opens these endpoints (`server/agent.js`); send it as is:

```sh
H="Authorization: $FLY_API_TOKEN"
curl -s https://chytai.org.ua/agent/health -H "$H"                          # errors (24 h), speed and stalls today, jobs, mail, disk, flags
curl -s "https://chytai.org.ua/agent/health?since=2026-11-09T10:00Z" -H "$H"  # errors since a deploy
curl -s "https://chytai.org.ua/agent/health?reader=1" -H "$H"               # plus whether the reader answers the site
curl -s https://chytai.org.ua/agent/sql -H "$H" -H 'content-type: application/json' -d '{"q":"select count(*) from readers"}'
curl -s https://app.chytai.org.ua/agent/health -H "$H"                     # the reader's machine
curl -s https://app.chytai.org.ua/agent/sql -H "$H" -H 'content-type: application/json' -d '{"q":"select coll, count(*) from docs group by 1"}'
```

- SQL is SELECT / WITH / EXPLAIN only, on a read-only connection in a worker: 5 s, 500 rows, one at a time, 300 a day
  per app. E-mails and secret-looking values come back masked. Never print the token.
- Robots: table `bots` (day, name, n, pages, ms, turned) per user agent; human pages in `views`. A crawler posing as a
  browser shows as a flood of «Напряму» rows in `arrivals`, one landing each. Stats skip a guest address that opens
  >8 pages without our cookies in 10 min (`admin.js crawler()`); clean a past flood once with `dropCrawler(key, where)`.
- Errors live in the site's `errors` table (30 days): site 500s and crashes (`site`, `jobs`), the reader's server
  (`reader`), and script errors from readers' browsers in the reader app (`reader`, message starts «[браузер]»,
  extension noise dropped; `src/renderer/web-bridge.js` → `/api/client-error`). Each new one goes to Max's Telegram
  once an hour. Script errors on the site's own pages are only counted (`events`, `name = 'js'`, /admin/speed).
- Fly itself, same token: `https://api.fly.io/graphql` (machines, releases),
  `https://api.fly.io/prometheus/personal/api/v1/query_range` (`fly_app_http_responses_count` by status,
  `fly_instance_cpu`, memory), `https://api.fly.io/api/v1/apps/chytai-web/logs` (only the last ~100 lines).
- Never write to the production database, from here or any other way, without Max's OK in the thread.

## After a push: watch the rollout

Both deploy workflows have a `watch` job (`scripts/rollout-watch.sh`): 15 minutes after a deploy it looks for errors
that were not seen in the week before; one seen twice sends a line to Max's Telegram and the
run fails. It does not roll back by default (Max: threads pushing and a watch reverting could chase each other, and an
error need not come from the deploy): the thread that pushed looks, then fixes or reverts its own commit. For a risky
change put `[rollback-on-errors]` in the commit message: then the watch sends the previous image back itself.

Beyond that, when the Actions run is green, check `/agent/health?since=<deploy time>` yourself, and for a risky change
schedule a wake-up in about an hour and look again. Outages are fixed or reverted without asking.

## Backups (`backup.yml`, `web/backups.js`)

- Nightly 03:30 Kyiv: both apps' `/data` without the big parts, encrypted with age, 90-day artifacts; the site's
  job also makes the `test-db` release. The site's own covers (`web/covers`, no `t/` cache) go apart on Sunday
  (`chytai-web-covers`, 35 days; `test-db` asset `chytai-web-covers.tar.gz.age`, fetched once by `fetch-test-db.sh`).
  A new big folder on a volume: leave it out of the nightly copy, or give it its own weekly copy. Each job restores its copy on trial (`scripts/backup-restore-check.sh`: decrypt with the repo
  secret `CHYTAI_BACKUP_KEY`, compare, start the app on it) and reports to `POST /agent/backup`.
- A failure goes to Max's Telegram at once; no good copy by 12:00 Kyiv, one line that day. See it in
  `/agent/health` → `backups`, on /admin «Performance», in the morning report.
- A change to the workflow or these scripts runs it once on push. The MCP token cannot start or rerun it (403):
  ask Max for «Run workflow» on Actions → Backup.

## Feature flags (`web/flags.js`)

By default a change ships to everyone, with no flag (Max, 2026-11-11: a small project, flags are friction for him).
A flag only when Max asks for one, or when the change could break what readers use now. Then it goes live set to
`owner` (Max only) or `test` (Max and the test accounts), and Max switches it to everyone on `/admin/jobs` (block
«Прапорці»), with no deploy.

- Add the flag to `KNOWN` in `web/flags.js` with a few Ukrainian words, and check it with `flags.on("name", req.user)`.
- A thread may set `off` / `owner` / `test`:
  `curl -s https://chytai.org.ua/agent/flags -H "$H" -H 'content-type: application/json' -d '{"name":"x","who":"owner"}'`.
  `all` is only Max's.
- The reader has the same flags: its server asks the site (`POST /api/reader-flags`, a minute's cache per account) and
  puts the names that are on into `settings.flags`; the page checks `settings.flags?.includes("name")`.
- When a flag is on for everyone, soon take it out of the code and out of `KNOWN`: its stored row goes at
  the next start. Only a flag in `KNOWN` can be set.

## Editorial lists («Добірка Chytai»)

- Add an entry to `web/seed/editorial.json` (`key`, `title`, `note`, `books` as `{id, why}`; `"draft": true`). The web
  process makes it once under Max's account (`/@maxua/list/<slug>`); a draft only Max sees, he presses «Опублікувати».
  A book may carry `section` / `sectionNote`: a heading over it and the books after it. To rework a made list, add a new
  key with `"replaces": "<old title>"` (same title keeps the URL; the old list is removed). To add books to a list that
  is already out (saves and comments stay), a new key with `"append": "<title>"` and only the new `books`.
- Find work ids on the test DB with `store.search()` / `store.resolve()`; a book the catalog lacks goes in as
  `{title, author, page}` (a store page) and is added from it. Prefer Ukrainian editions, no Russian authors.
- Check it locally signed in as `owner@test.invalid`, screenshot, show Max.

## Readers' uploads become catalog books (`web/readerbooks.js`)

- A file just uploaded to the reader (tellSite → `/api/reader-library`, with `lang`, `fromName`, `added`) that the
  catalog lacks becomes a book (`source: "reader"`) when its metadata is clean, it is uk/en, not Russian, and Google
  Books or Open Library confirm title + author. Behind the flag `reader-books`; caps 20/reader, 200/day.
- Dry run over all files in readers' lists: `curl -s https://chytai.org.ua/agent/reader-books -H "$H"` (starts it;
  ask again for the answer, `?again=1` to rerun). The real backfill is `POST /admin/reader-books` (owner) or
  `POST /agent/reader-books` with `{"run":true}` (thread), only with Max's OK in the thread. Done once on 2026-11-11.

## «Що почитати далі?» (`web/ask.js`, /ask)

- A field on /ask (flag `ask`; guests too once on), Claude names 15 books, `Ask.match()` keeps the catalog's (store.findWork,
  then search by title start + same author), Ukrainian edition, series start, one per author/series, up to 8.
  Each answer at /ask/<id>, open to anyone; same text again = kept answer. Unopened 180 days → deleted.
  The answer page shows a plain «Автор, «Назва»» list (copyable); /ask lists `asker.recent()` by `topic` (Claude names it in
  the same call; older rows get one from Haiku at start, `asker.topics()`).
- Try the prompt on production's catalog without keeping anything (30 a day):
  `curl -s https://chytai.org.ua/agent/ask -H "$H" -H 'content-type: application/json' -d '{"text":"…","model":"claude-sonnet-5-5"}'`.
- Locally without a key: preload a fake `@anthropic-ai/sdk` (`node -r mock.js web/server.js`, ANTHROPIC_API_KEY=dummy).

## Translation pairs

- A Ukrainian book and its original are paired in `web/seed/matches.json`: `translations` (`[original, uk]`, slugs or
  ids) always stand, even next to another Ukrainian translation; `different` pairs are never linked. Check with
  `store.linkTranslations()` and `store.pairLog` (kept / dropped with tier) on the test DB.
- A series the data gets wrong goes in `matches.json` `series`: `{name, uk, books: [ids or slugs in order]}`; it wins
  over Wikidata and Goodreads (`store.linkCycles`). Two editions of one book: `merges` `[keep, dup]`.

## AI passes over the catalog (`web/catalogpasses.js` on `web/aipass.js`)

- A new pass is a def in `catalogpasses.js` (`model` may be `claude-sonnet-5-5` for text readers see). Trial first:
  `curl -s https://chytai.org.ua/agent/ai-trial -H "$H" -H 'content-type: application/json' -d '{"key":"<key>"}'`
  starts 200 (only with Max's OK in the thread), `GET /agent/ai-trial?key=<key>` gives the answers as text. Max looks
  at `/admin/ai/<key>`; the whole catalog is his button there, or `{"key":"<key>","all":true}` from a thread once he
  said so in it (answers in table `ai_answer`, then `def.apply`; a live pass reruns every 6 h for new candidates).
- «З чого почати» on author pages is the pass `author-start` (flag `author-start`); `server.js authorStart()` reads it.

## Standing rules (Max)

- Never mass-regenerate AI content without Max's OK (daily auto cap 150). A new AI pass: trial of 200 on `/admin/*-trial` first.
- A new kind of thing readers write (a list, a comment, a hand-added book) notifies Max (e-mail and Telegram, with the reader's `/@username`).
- First-party analytics only, no third-party trackers. Log what helps product decisions.
- Every cache or stored file cleans itself up; disk never grows without bound.
- Think about performance and scale for every change; say when something is not optimal.
- Reuse existing designs and components; don't invent a new UI per page.
- A product decision goes into `docs/decisions.md`; a reader-facing feature gets a one-line entry in `web/updates.md` («Що нового»).
- Test on production only under a test account, never Max's. No mail to test domains.
- «Статті» (web articles and essays) were taken out on 2026-11-10 and went to Max's blog («не ліпляться вони в
  Читай»): don't bring them back, on the site or in the reader. Their tables were dropped (store.dropArticles); the export is in project files `chytai-articles-export/`.
- Reader: how the text looks (theme, font, sizes, spacing, margins, column, page turns) is kept per device
  (`LOOK_KEYS` in `src/renderer/web-bridge.js`); the account's copy only starts a new device. A new look setting
  goes into that list.
- Reader: the app's own UI can't be selected (`body` has `user-select: none`, end of `src/renderer/style.css`). Text a
  reader may copy (a new note, answer or field) goes into the list of selectable classes there.
