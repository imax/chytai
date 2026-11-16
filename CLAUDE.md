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
  extension noise dropped; `src/renderer/web-bridge.js` → `/api/client-error`; the browser's frames come as `frames`,
  kept whole). None goes to Telegram one by one (Max, 2026-11-11: he can't act on a single error); the technical
  report counts yesterday's and names the new kinds. All of them, grouped, on /admin/speed#errors (`errors.month()`); Огляд
  shows only the day's count with a link, no list. The morning error review (below) fixes them.
  Script errors on the site's own pages are only counted (`events`, `name = 'js'`, /admin/speed).
- Product analytics (Max 2026-11-16: «аналітика по продукту», anonymous is fine, first-party only). A guest's page is
  counted only when the page itself says it opened (app.js → `POST /api/seen`, `admin.opened`): views, section views,
  arrivals, guest steps and the sign-in page's events wait in memory (`admin.later`, 2 min) and are dropped if no
  script answers (a robot that runs no script made 5–15× the real guests on 12–16.11). Readers' views stay
  server-side. Table `page_views` (visit = random number in the `chytai_here` cookie, 30 min; order `n`, path, source
  of the visit, seconds on screen, % scrolled, phone; readers carry their id, guests ''), 30 days. Shown on
  /admin/traffic «Куди йдуть гості» (`admin.paths`) and /admin/activity?guests=1 (`admin.guestVisits`). Searches:
  `search_log.clicks`/`pos` (a result opened and its place, app.js live search → `/api/searched` with `pick`), on
  /admin/catalog «Знайшли, але нічого не відкрили» from 2026-11-17. A page with no app.js (404) can't confirm, so
  its events stay immediate. Playwright: beacons sent while a page unloads are lost in headless Chromium; the page
  also reports on a link's click.
  The reader (Max 2026-11-16): taps on its own controls by id / `data-action` (`sel-…`) / `data-act` (`act-…`) /
  `data-tab` / `data-open` (reading-time.js `count`, page turns left out; by hand `ReadingTime.count("gloss")`) go with
  `/api/reading` as `ui` → `state.stats.days[day].ui` and `uiWho` (accounts, «guest»; 90 days). `collectStats()` adds
  `ui` (30 days), `stops` (books opened in 90 days by `u.progress` pct: finished, reading, left and where) and
  `firstDays` (accounts of 60 days: opened a book, 10 min in week one, two days). /admin/reader «Перші дні», «Де
  кидають книжки», «Що натискають»; a new control gets a Ukrainian name in `UI_NAMES` (web/admin.js).
- /admin «Performance» (`healthBlock` in web/admin.js): one bullet per check, red with a link when it needs a look. Keep
  it so (Max, 2026-11-12, after it was folded into one sentence: «мені не подобається»); trim a row, don't merge rows.
- Pages the phone unloaded (iOS kills the WebView's page for memory, mostly in the background): the page keeps a note
  of itself in localStorage (`chytai:life`, web-bridge.js `life`), the next load reports it to the reader's
  `/api/page-gone` and reopens the book that was on screen. Rows in the reader's `state.stats.days[day].gone` (30 days);
  /admin/reader «Вивантаження» and a line in the technical report (not on Огляд, Max 2026-11-13). To see
  memory on a phone width locally: Playwright WebKit, RSS of `WPEWebProcess`; kill it (`pkill -9 -x WPEWebProcess`)
  to fake an unload.
- AI spend (`web/aiusage.js`, `server/aimeter.js`): every Claude call in both apps is counted by patching the SDK once
  per process (no caller can skip it; feature = the calling file). Site table `ai_usage` (day, app, feature, model,
  tokens, searches, cost); the reader keeps `state.stats.days[day].ai`, the site copies it hourly. Telegram once a day
  when the day passes $25 (Max) or a feature costs >2× its 7-day median and >$3; «AI за добу» in the technical report.
  A new feature file gets a Ukrainian name in `LABELS`; new models go into `PRICES`. The Console
  (platform.claude.com/cost, no admin key here) also sees what our code doesn't call.
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

## Morning error review (scheduled task «Розбір помилок Chytai», ~07:00 Kyiv daily)

A fresh session each morning (Max, 2026-11-11: «розбирати їх», not Telegram per error). Its note completes the day's
technical report (below), so post it only after your fixes are pushed:

1. `curl -s https://chytai.org.ua/agent/triage -H "$H"` → `at` of the last review; the errors since then:
   `/agent/health?since=<at>` and `/agent/sql` on `errors` (stack, url, how often, first seen).
   `at` null: look at the last 24 h. Check `git log` first: an error from before yesterday's deploy may be fixed
   already (compare its last time with the Actions run's end); then it is only a line in the note. In SQL, strings take
   single quotes (send the query from a file: `-d @q.json`). Backups showing `today: false` early in the morning are
   normal: GitHub starts the 00:17 schedule 5–7 hours late.
2. Each kind: noise (an extension, a network drop, a bot) → widen the filter (`CLIENT_NOISE` in server/index.js) only
   if it repeats; real → reproduce on the test DB / a local reader, fix, prove, push to main like any small fix (not
   during the Friday digest). Big, risky or a product question → leave it for Max, one plain line why.
3. One short Ukrainian line for the technical report, even when there was nothing:
   `curl -s https://chytai.org.ua/agent/triage -H "$H" -H 'content-type: application/json' -d '{"text":"нових 3: виправлено 2 (…), вам глянути 1: …"}'`.
   The report prints it as «Розбір помилок: …» (only a note of this Kyiv day; none = «сьогодні не запускався»).
4. Then watch your deploy as usual (`rollout-watch`), and keep this section current.

## Backups (`backup.yml`, `web/backups.js`)

- Nightly, set for 00:17 Kyiv (GitHub starts it 5–7 h late): both apps' `/data` without the big parts, encrypted with age, 90-day artifacts; the site's
  job also makes the `test-db` release. The site's own covers (`web/covers`, no `t/` cache) go apart on Sunday
  (`chytai-web-covers`, 35 days; `test-db` asset `chytai-web-covers.tar.gz.age`, fetched once by `fetch-test-db.sh`).
  A new big folder on a volume: leave it out of the nightly copy, or give it its own weekly copy. Each job restores its copy on trial (`scripts/backup-restore-check.sh`: decrypt with the repo
  secret `CHYTAI_BACKUP_KEY`, compare, start the app on it) and reports to `POST /agent/backup`.
- A failure goes to Max's Telegram at once. See it in `/agent/health` → `backups`, on /admin «Performance», in the
  technical report.
- Runners get age from its GitHub release (`scripts/install-age.sh`; Ubuntu's mirror failed the deploy twice on
  2026-11-11). Without age the site's smoke test runs on an empty database.
- A change to the workflow or these scripts runs it once on push. The MCP token cannot start or rerun it (403):
  ask Max for «Run workflow» on Actions → Backup.

## Two Telegram reports (`web/dailyreport.js`, jobs process)

- 08:00 Kyiv: readers only (sign-ups, visits, shelves, the reader's minutes and explanations). Nothing technical in it
  (Max, 2026-11-12).
- Technical, once a day, when both nightly backups (site, reader) have reported today and the morning review posted
  today's note; at 10:00 Kyiv at the latest (`DEADLINE_HOUR`), and then a missing copy is a failed one («не вдався», Max 2026-11-12):
  backups, yesterday's errors and failed jobs, the review's note, pages the phones unloaded, search health (arrivals
  from Google and Search Console impressions against the 14-day median, «різко менше/більше» at half or double), disk and memory of both
  machines (moved here from /admin, Max 2026-11-12; the reader's comes with its `/api/site-admin/day`). Meta
  `techreport:lastRun`. Try either on the test DB: `require("./web/dailyreport").buildTech({ db, day, ownerId, site,
  reader })` with a fake `reader`.

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
  is already out (saves and comments stay), a new key with `"append": "<title>"` and only the new `books`. A draft goes out when Max says so in the thread: a new key with `"publish": "<title>"`.
- Find work ids on the test DB with `store.search()` / `store.resolve()`; a book the catalog lacks goes in as
  `{title, author, page}` (a store page) and is added from it. Prefer Ukrainian editions, no Russian authors.
- Check it locally signed in as `owner@test.invalid`, screenshot, show Max.

## Readers' uploads become catalog books (`web/readerbooks.js`)

- A file just uploaded to the reader (tellSite → `/api/reader-library`, with `lang`, `fromName`, `added`) that the
  catalog lacks becomes a book (`source: "reader"`) when its metadata is clean, it is uk/en, not Russian, and Google
  Books or Open Library confirm title + author. Behind the flag `reader-books`; caps 20/reader, 200/day.
- An upload whose metadata has no author or a title that is only the file's name gets both from its first pages
  (`titleFromPages` in server/index.js, one Haiku call, kept in `bookMeta` like a reader's correction, `fromPages`).
- Every book a reader adds to the reader (uploaded <48 h ago, not a gift, not Max's own) sends Max one letter +
  Telegram per sync: «Книжка в Читалці: …», the reader's /@username, title — author and the book's page here (from
  the catalog, «нова на Chytai», or «у каталозі немає»). `tellUploads` in web/server.js, after readerBooks' lookup.
- Dry run over all files in readers' lists: `curl -s https://chytai.org.ua/agent/reader-books -H "$H"` (starts it;
  ask again for the answer, `?again=1` to rerun). The real backfill is `POST /admin/reader-books` (owner) or
  `POST /agent/reader-books` with `{"run":true}` (thread), only with Max's OK in the thread. Done once on 2026-11-11.

## «Що почитати далі?» (`web/ask.js`, /ask)

- A field on /ask (flag `ask`; guests too once on), Claude names 15 books, `Ask.match()` keeps the catalog's (store.findWork,
  then search by title start + same author), Ukrainian edition, series start, one per author/series.
  Claude also says `fit`: how many of its books truly fit (3–10). `Ask.get()` names the top `fit`: the catalog's as cards
  (at least 3 from further down when we have them), the rest as grey text in the plain list («Інших книжок … поки немає»).
  Each answer at /ask/<id>, open to anyone; same text again = kept answer. Unopened 180 days → deleted.
  Max (owner only) deletes one with «Видалити» on its page (`POST /ask/<id>/delete`, `Ask.remove`).
  A restart (deploy) cuts answers off mid-call: at start `asker.resume()` reruns the last 10 minutes' `wait` / `fail`.
  The answer page shows a plain «Автор, «Назва»» list (copyable); /ask lists `asker.recent()` by `topic` (Claude names it in
  the same call; older rows get one from Opus at start, `asker.topics()`).
- Books an answer names that the catalog lacks become books (`Ask.fill`, after each answer, source `ask`, 50 a day,
  meta `askbooks:count`): a Ukrainian edition by book.ua's GraphQL search (`catalogs.bookuaSearch`), then by Google
  Books / Open Library (readerbooks `confirm`); else the original, only when it is English (Claude's `lang`; Calvino's
  Italian came in as English, 2026-11-13); found ones move from the grey lines to the cards, Max hears
  of them. No Ukrainian edition found → the grey line shows the original title (`ukFound: false`). Over kept answers:
  `GET /agent/ask-books` (dry, ask again for the result), `POST {"run":true}` only with Max's OK in the thread.
- Try the prompt on production's catalog without keeping anything (30 a day):
  `curl -s https://chytai.org.ua/agent/ask -H "$H" -H 'content-type: application/json' -d '{"text":"…","model":"claude-sonnet-5-5"}'`.
- Locally without a key: preload a fake `@anthropic-ai/sdk` (`node -r mock.js web/server.js`, ANTHROPIC_API_KEY=dummy).
- The homepage (2026-11-15, Max: «давай повернемо як було», then variant A on a design canvas): the search is plain again
  (h1 «Я шукаю»), and under the chips, on the unfiltered page, a block «Запитай Chytai» (`askBlock` in pages.js): a field
  that posts to /ask, and two answers others got with covers (`homeAsks` in server.js: of the 12 newest, at random).
  Fewer cover rows (Max, variant A of a second canvas, by the block taps): the unfiltered page has picks, Для вас,
  Добірки, Дочитують, Обговорюють, then Читалка (with «Безкоштовна класика →» to /publishers/chytai-free); «Українські
  автори», «Хочуть прочитати», «Безкоштовно» only under a chip. Taps per block: `taps` table, `page = '/'`.
  «Обговорюють зараз» is one line a topic (`clubRow(t, { tight: true })`), only topics active in the last 14 days
  (`club.lively`); none = no block. «Події» right after Для вас: four lines of the next 14
  days (`homeEvents` in server.js: own shelf's authors, then author/festival/lecture before clubs; `calHome` reuses
  `calLine`). The test DB may have no upcoming events: copy some rows of `cal_events` from `/agent/sql` locally.
- Search with no book that has every word (`searchAll` `near`, 2026-11-15): «Може, ви шукали:» authors, publishers and books with most of the
  words, a one-letter typo counting («після вільного шляху» → «Пісня відкритого шляху»); then no outside lookup.
- Off since 2026-11-15, code kept: the homepage box (and /search) takes a request too (flag `smart-search`, `web/intent.js`, no model): cue words
  (`CUES`) and no book has every word → «Порадити книжки» first, Enter presses it (POST /ask); many words and no book
  → only a line. Variant B (Max chose it on a design canvas): «Порадити книжки ↵» takes the place of «Enter ↵» in the
  field (`body.asking`), the line under it offers «Шукати як назву» (`plain=1`). The box is a growing textarea; app.js
  sends `home=1` to `/api/search`. While it is empty, examples fade in and lift away
  every 4 s, a whole phrase (`.ex-line` over the field, app.js; Max chose design F): a tap on one, or →, makes it the
  query. `buildExamples()` in server.js, in the background every 10 min (~1 s, never on a request): of every 10, 4
  requests (short ones from /ask, same text = kept answer at once; then `ASK_EXAMPLES`), 4 books, 1 author, 1 genre or
  series (Max's mix, `EXAMPLE_SLOTS`), things anyone could type: `social.startPool` (≥2 readers) first, then searches
  made twice+ shown as what they found (`foundAs`), not the typed fragment. Fits a 360 px phone (`EXAMPLE_MAX`).
- While Claude answers (20–30 s), the waiting page shows one line that changes every 4.5 s (`ASK_STEPS` in pages.js, like
  the book page's overview), then the whole answer (Max 2026-11-13: not the books one by one). A missed request or a
  search taken for one: add or drop a cue, try with `node -e 'console.log(require("./web/intent").intent("…"))'`.

## «Мої фаворити» (`web/lists.js`, `syncFav`)

- A reader with 3+ books rated 5 sees «Зібрати «Мої фаворити»?» in «Мої списки» on their own shelf. «Зібрати» makes
  a draft list of them (from 5; «Назва й опис» → «Додавати самі»: 5 / 4,5 і вище / не додавати, `lists.fav_min`), one per series, no Russian, no kids' shelf; `store.entryHooks` keeps it in step after every
  shelf change. Hand-removed books stay out (`list_skips`); a book with a line or section stays when its rating falls.
  Look: Max's B+E from a design canvas (cover fan on the offer; on the list «усі книжки тут на 5 ★» instead of readers'
  stars, and the author's shelf note under a book without its own line). Readers' publishing it mails Max like any list. Try: `lists.favBooks(id)`, `lists.syncFav(id)` on the test DB.

## Threads posts asking for a book (`web/threadsfind.js`, /admin/threads)

- Max looks at fresh Ukrainian Threads posts that ask for a book and answers some himself (Max, 2026-11-12: no
  auto-replies, nothing posted from here, no AI). The jobs process searches `QUERIES` every 4 h, keeps what
  `wanted()` passes (Ukrainian letters, a book word, a request), 30 days. «Спитати в /ask» opens `/ask?text=…`.
- Source = Fly secret `THREADS_TOKEN` (Meta's keyword search; other people's posts only after App Review). None =
  the job only prunes, the page says so. SocialFetch was taken out of the code on 2026-11-15 (out of credits; Max
  searches from his own account): don't bring it back.
- `meta threads:last` has `per` (posts each query returned: drop a phrase that brings nothing). Try the filter: `node -e 'console.log(require("./web/threadsfind").wanted("Порадьте книжку?"))'`.

## «Книжкові події», /calendar (`web/calendar.js`)

- Max's design A + D from a design canvas (2026-11-15): «Мої автори» (authors on one's shelf), «Наживо» on the
  author's page, one «Подія:» line on the book's page. No block on one's own shelf (Max). An event links to the
  organizer's page; we sell no tickets, and the pages don't say so (Max 2026-11-15). Every row has one shape (Max 2026-11-15, the list zigzagged): a cover or a day
  tile (`calLeft`), a green «Чт 19, 18:30» (`calWhen`), the title, kind · where; no day or time columns.
- At ~120 events (clubs 4 in 5) the list by days was a dump (Max): design B «За типом» from a second canvas
  (UwNH4YbYAYe9trVsSrwRGi). Kind chips with counts (`?kind=`, also in /calendar.ics), the city as one menu, a search.
  No kind, words or «Мої автори» = an overview (`calOverview` in pages.js): author meetings as cards, festivals with
  their days, clubs as a shelf of the books they discuss (one cover a book; it opens `?kind=club&q=<book>`), lectures,
  children's and unsorted as five lines each. Otherwise (and `?all=1`) the list (`calList`): one line an event (day,
  time, title, kind · where, a small cover), the rest behind «докладніше»; today and two weeks open, later months
  folded when the list is long.
- Every event has its own page (Max 2026-11-15, design canvas EzYcx7zJcqfYf5Bi6XgDrX): `/calendar/<title slug>-<key>`
  (`calendar.eventPath`, key = 8 hex of the id's sha1, so a corrected title redirects; `calendar.byKey`), `.ics` after
  it = that event alone. `eventPage` in pages.js, the route in server.js (books with «Хочу прочитати», a tour's stops,
  4 more events: same book/author, then same kind and city). Every title, row cover, the clubs shelf (one meeting),
  the book page's «Подія:», the author's «Наживо» and `/calendar/go/<id>` (letters) lead there. The organizer's button
  is named by its link (`calendar.linkKind`: form / social / site / ye). Never a link to a Telegram post, on a page or
  in the .ics (Max 2026-11-15: it tells we read channels): `calendar.sourceUrl` gives Max's own link first
  (`cal_events.link`, set on /admin/events, tab «Події»: «Нові за 3 дні» (`calendar.recent`, all sources, hidden too, by Kyiv day), events without a page, «лише афіша «Є»», sources;
  `calendar.setLink` gives it to every event of the same post; no collector writes it), then an event at «Є» its city's
  afisha (`YE_CITY`, book-ye.com.ua/calendar/<city>/), the rest «Канал у Telegram»: the channel, never the post
  (`tgChannel`; Max: «хай шукають»). Є's site is behind Cloudflare's human
  check (our server, the container and Max's Chrome alike), and web search doesn't know a new event's page yet.
- Max's feedback (2026-11-15): an event by an author on one's shelf names that reader's own books by them
  (`shelfBooksFor`); one event in several cities or days (same title without its city, same link or post) is one row
  with a line per stop (`calendar.tours`), but under a city chip each stop is its own row; `?q=` searches title, words,
  place, authors' names and books; «Звідки події» only on the whole list.
- «Підписатися» by e-mail (Max 2026-11-15, like a publisher's): the button keeps the page's choice (kind, city,
  «Мої автори», words; `calendar.subKey`) in table `cal_subs` (10 a reader; `POST /calendar/subscribe`; a guest signs in
  and lands back already subscribed by `GET /do/calendar-subscribe?<choice>`, no /welcome) and switches the Friday letter on. No letter of its own (no extra mail): the digest's «Книжкові події»
  section (`calForLetter` in server.js) has what the subscriptions pick (`calPick`, the same filter as the page and
  the .ics) starting within 9 days, plus later ones added since the last letter, 3 rows (Max: «не більше трьох»), a tour one row. Links go
  through `/calendar/go/<id>` (letters link only to our domain); «Відписатися від подій» =
  `/calendar/unsubscribe/<reader>/<digest token>`; /settings/mail lists them. Try: `/digest/preview` as the owner.
- «Хочу піти» on an event's page (Max 2026-11-16, in place of «Додати в календар»): `POST /calendar/<id>/going`
  (table `cal_going`, a guest signs in and lands back marked by `GET /do/calendar-going?id=`); once pressed the page
  shows «✓ Іду», the calendar links and «Нагадаємо листом за день»; others' count under it. A letter the day before
  (`calendarReminders` in server.js, hourly job `calendar-remind`, from 10:00 Kyiv, one letter a reader, `reminded`
  marks it; «Не нагадувати» = `/calendar/remind-off/<reader>/<digest token>`, meta `calremind:off:<id>`, back on with
  a button on the event page). /admin/events «Хочуть піти» lists the counts.
- In a phone's calendar (a line at the page's foot): `/calendar.ics` is the list as an iCalendar feed with the same
  `?kind=` / `?city=` / `?q=`; «Мої автори» by `?mine=<reader>.<key>` (`calKey`, HMAC with the reader secret; a
  calendar app has no cookie). Links: webcal:// (Apple), Google Calendar's `?cid=`, and the plain address.
- Only Ukraine and online (Max 2026-11-15): the collectors' Haiku answers `abroad` and those are dropped;
  `calendar.abroad(city)` (list `ABROAD`) hides a foreign city at upsert and at start, and /calendar/add refuses it.
- Table `cal_events` (id `{source}:{key}`, starts/ends `YYYY-MM-DD` Kyiv, time `HH:MM`, city as shown, «Онлайн»
  for online; books/authors JSON found by name, no AI: `linkText`, a name's two words side by side, «Олександрою … книгарні» ≠ Олександр Книга; never a Russian edition, `findBook`). Gone 30 days after it ends (`cleanup`).
- Sources: `web/seed/calendar.json` (kept in step at every start: festivals by a thread or Max); readers via
  /calendar/add (signed in: shown at once, 5 a day, mails + Telegram Max; Max or the reader hides one with «сховати»;
  guests too (Max 2026-11-16): hidden with `review = 1` until Max presses «Показати» on /admin/events («Від гостей»,
  «Прибрати» deletes), `by = guest:<hash of the address>`, 3 a day, an optional e-mail in `contact` (only that block
  and Max's note show it), a field `site` only robots fill; «Заповнити з посилання» = `POST /api/calendar/peek`,
  public addresses only, 10 a day for a guest); collectors call `calendar.upsert({ source, key, …,
  hidden: true })` and `findSimilar()` against duplicates (the Telegram thread uses source `tg`).
- Книгарня «Є» (`yeRun`, source `ye`): reads book-ye.com.ua/calendar/ daily in the jobs process, only once meta
  `calendar:ye` is `on`. Dry run: `curl -s https://chytai.org.ua/agent/calendar-ye -H "$H"` (ask again for the
  answer, `?again=1` reruns); switch: `POST /agent/calendar-ye {"on":true}`, only with Max's OK in the thread.
  Off: Є answers 403 to Fly's server too (dry run 2026-11-15), and the container is refused as well. We don't dress up
  as a browser; Є's events come through its Telegram channel (`knyharnia_ye`, the `tg` collector) or by asking Є.
- Telegram channels (`web/tgfeed.js`, source `tg`; Max 2026-11-15 chose our own account over scraping): the jobs process
  reads the channels in `web/seed/tgchannels.json` every hour and keeps their posts 90 days (table `tg_posts`, for more
  than events later). Through our own Telegram account (Fly secrets `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`; Max makes
  them on his computer with `node scripts/tg-login.js`, a QR code the phone scans; `--code` = by a code): it joins channels in the seed's order (Max's own first; the account has Premium) as fast as Telegram lets it: a job every 10 min (`tg-join`, `joinMore`) joins until FLOOD_WAIT, whose end goes into meta `tg:flood` (`/agent/tg` → `flood`), mutes each (Max uses that number himself, 2026-11-15), and reads what is new; channels joined by hand on the account (`last.own`) are read and muted too, add them to the seed to keep them. A
  channel's @name by its title: `curl -s "https://chytai.org.ua/agent/tg-find?q=<words>" -H "$H"` (the account's search). No
  session, or Telegram refuses it: the public pages `t.me/s/<channel>`. A bot can't do this (it sees a channel only
  when the channel's admin adds it). Status: `curl -s https://chytai.org.ua/agent/tg -H "$H"`; run now:
  `POST /agent/tg {"run":true}`. A new channel: a line in the seed file (`group: "club"` = read every 3 h from its page,
  `city` = the club's city for Haiku, `account: true` = no public page, waits for the account; a channel the account
  can't join is skipped for a week, meta `tg:nojoin`). Book clubs: 72 channels from the MEGOGO BOOKS club hub (Max
  2026-11-15, list in project files `chytai-calendar/megogo-clubs-telegram.tsv`).
- Channels only, never groups (Max 2026-11-15: «в групи не додавайся… тільки канали»): `joinSome` resolves a name first
  and doesn't join a group; a seed name the account is in as a group is left (`dropGroups`, each run), its posts
  deleted, and it goes into meta `tg:group` (`/agent/tg` → `groups`), out of the list; a join request to a group is
  withdrawn once (`tg:groups-checked`). Groups not in the seed (Max's own chats) are never touched.
- A channel left by hand is never joined again (Max 2026-11-15): meta `tg:joined` = every channel the account was in;
  one it no longer is in goes into `tg:left` with `hand: true` (not read any more; the tech report names it). Back:
  `POST /agent/tg {"keep":"<name>"}`.
- Pruning (Max 2026-11-15: don't spend tokens on spam; the posts also feed «Знайти цікаве для читачів»), `prune()` each
  tg run over 30 days: 10+ Haiku calls and no event → `tg:quiet` (posts still kept, Haiku not asked, a month); a seed
  channel, not a club, with no event, 20+ posts and under 15% book words (`BOOKISH`) → `tg:left` (the account leaves it, no more reads).
  Never: `"keep": true` in the seed (Max's own), hand-joined ones. Undo: `POST /agent/tg {"keep":"<name>"}`. The
  technical report names the day's ones («Telegram: …», `tgLine`).
- New channels (Max 2026-11-16: «чи ми робимо діскавері нових книжкових каналів?», then «Сам, до 10 на день»):
  `tgFeed.discover()` asks Telegram's «Similar Channels» (`channels.getChannelRecommendations`) for every channel the
  account is in and keeps those 2+ of ours point to (top 80), then reads each one's last posts: Ukrainian, 30%+ about
  books, a post in 30 days, a channel, not left or a group. Weekly (job `tg-discover`, daily: a search when the last is
  7+ days old, meta `tg:discover-run`); those that pass wait in meta `tg:found`, `promote()` gives 10 a Kyiv day
  `added` and they join `live()`: joined, muted, read and pruned like the seed's; a hand-left one is never rejoined.
  The tech report names the day's («нові канали зі «Схожих»»). Dry list: `curl -s https://chytai.org.ua/agent/tg-discover
  -H "$H"` (ask again; `?again=1`); search now: `POST /agent/tg-discover {"run":true}`.
- Leads (Max: «звертай увагу, звідки воно… щоб можна підписатись на нього напряму»): `/agent/tg` → `leads`: the sites
  event posts link to (forms, social networks and payments left out) and t.me channels they link to that we don't read.
  A site with many: read it directly (like `yeRun`) or add its channel.
- Events from those posts: an event word and a date not past (`maybeEvent`, ~1 post in 15) → Haiku 5.5 answers the
  events as fields (300 calls a day at most, Max 2026-11-15), `findSimilar` drops the same event from another channel (same day and city, and an author, half the title's words or the same «» book in another case), `upsert` with
  the post's event link (`eventUrl`: its one sign-up form first, then Haiku's pick, then one post of another channel)
  or the post itself (a payment or call link, `NOT_A_PAGE`, gives the post), shown at once (Max hides a bad one with «сховати»). On since 2026-11-15
  (Max's OK after a trial: 25 calls, $0.005, 20 events); switch: meta `tg:events`, `POST /agent/tg-events {"on":false}`.
  Dry run over the last 30 days (≤200 calls, only with Max's OK): `GET /agent/tg-events` (ask again, `?again=1`).

- Cancelled or moved (Max 2026-11-15: «якщо напишуть що скасовується івент треба їх ловити»): a post with
  `CANCEL_WORDS` and an event word goes to Haiku even without a date; Haiku answers `cancelled` / `was` (the old day)
  per event, `findSimilar` on that day finds ours, `calendar.cancel` hides it (`cal_events.cancelled` = JSON
  {how, post, at}); a moved one comes back as a new event on the new day. /admin/events «Скасовані й перенесені»
  lists them with the post and «Повернути» (`uncancel`). Chytomo and Eventmate drop cancelled ones (`extract`).
- Kinds (Max 2026-11-15 chose 5 chips): `cal_events.kind` is one of `calendar.KINDS` (club, author, lecture, festival,
  kids; '' = not known). The collectors' Haiku answers it with each event; `tgFeed.classify()` (every tg run) sorts
  the rest 25 to a call, within the same daily cap; «other» isn't asked again (meta `tg:other`).

- Chytomo (chytomo.com/kalendar/, Max 2026-11-15): `calendar.chytomoRun` once a day in the jobs process, its cards
  «зустрічі та враження» and «освітні» only, each new article (meta `chytomo:seen`) through the Telegram collector's
  Haiku (`tgFeed.extract`, ≤10 a day), source `chytomo`, `findSimilar` against the same event elsewhere. Its link is
  the article's one sign-up form (`articleForm`), else the article, shown as «Анонс на Читомо» (`linkKind` `news`),
  never as the organizer's site (Max 2026-11-16, «ПалімФест»). Dry run:
  `curl -s https://chytai.org.ua/agent/calendar-chytomo -H "$H"` (ask again; `?again=1`); run now: `POST {"run":true}`.
- Eventmate (eventmate.app, Max 2026-11-15: more sources): `calendar.eventmateRun` once a day in the jobs process, its
  event sitemaps' Ukrainian pages with a bookish name (`EM_BOOKISH`) not seen yet (meta `eventmate:seen`, half a year),
  the date from the page, upcoming ones through `tgFeed.extract` (≤20 a run), source `eventmate`, the event's page as
  its link. Dry run: `curl -s https://chytai.org.ua/agent/calendar-eventmate -H "$H"` (ask again); run: `POST {"run":true}`.
- podii.io (Max 2026-11-16, an afisha of Lviv and Ivano-Frankivsk; robots allow): `calendar.podiiRun` once a day in the
  jobs process, its «Літературні заходи» page (`/category/literaturni-zakhody`; a city's own category page shows other
  kinds), each event page read once (meta `podii:seen`) for its schema.org Event: no AI, source `podii`, kind by words
  (`podiiKind`), its page as the link; a Telegram twin gets that page. Dry run: `curl -s
  https://chytai.org.ua/agent/calendar-podii -H "$H"` (ask again); run: `POST {"run":true}`. `findSimilar` leaves out
  words every meeting has (`EVENT_WORDS`: клуб, читацький, обговорення…): two clubs on one day are not one event.
- Organizers' calendars (Max 2026-11-15): /admin/events «Календарі організаторів» takes a Google Calendar link of
  any shape or an .ics (`calendar.icsAddress`), reads it at once (one that fails isn't kept) and every 6 h
  (`calendar-feeds` job, `feedsRun`): table `cal_feeds`, the next 120 days in as source `ics` (`parseIcs`, no AI;
  the feed's kind and city win), a meeting gone from the calendar goes here too; «Прибрати» takes its events off.
  A repeating event gives only its first meeting. Closed sites: letters to «Є» and Readeat asking to let our robot
  through are in project files `chytai-calendar/letters-closed-sites.md` (Max sends them).
  Looked at and not usable (2026-11-15): Karabas, concert.ua, readeat.com, Goethe (403 to robots), Є (Cloudflare),
  cityofliterature.lviv.ua (a casino now), ui.org.ua and dou.ua (no book events); publishers and shops come as channels.
- Books an event names that the catalog lacks (Max 2026-11-15): Haiku answers each event's `books` (`named`), and a
  title in quotes («», "", “”; `quotes()`) goes too when the words before it call it a book («книги», «роман», «за
  книгою»; not right after «клуб», «книгарня»: `NOT_BOOK`) or the text names one author we know; with no author we know,
  only book.ua's Ukrainian edition of that very title is taken (Max 2026-11-16, «Північ, якої не існує»). `findBook`:
  the catalog's exact title, else the search's best book a letter or two apart by the author named («Адді Ларю» →
  «Лярю»), or the same title with none; missing ones wait in `cal_events.want`.
  `calendar.fillBooks` every hour: book.ua's Ukrainian edition, else Google Books / Open Library, source `calendar`,
  30 a day (meta `calbooks:count`), never Russian; Max hears of them (mail + Telegram). One not found stays in `want`
  with `tried` and is asked again the next day, until the event is over (a fresh translation reaches book.ua later). Dry run:
  `curl -s https://chytai.org.ua/agent/calendar-books -H "$H"`.

## «Словничок» in the reader's classics (`server/glossary.js`, `src/renderer/gloss.js`)

- A free-shelf book (`free/shelf.json`) gets once a list of old, dialect and historical words with a few words of
  meaning (Sonnet, ~28 calls a novel; `DATA_DIR/glossary/<book>.json`). The page underlines them with a CSS Custom
  Highlight (no DOM change: positions and notes stay) and a tap or click shows the meaning; «Аа» → «Словничок»
  turns it off (`gloss`, per device). For everyone, guests too (Max 2026-11-16; the flag `glossary` is gone). A book
  shows it as soon as its JSON exists, so a new book's list goes live when it is made.
- Make one book's (only with Max's OK in the thread, one book at a time): `curl -s https://app.chytai.org.ua/agent/glossary
  -H "$H" -H 'content-type: application/json' -d '{"book":"kulish-chorna-rada.epub"}'`; `GET` the same address
  for what is made (forms, cost) and what runs; `{"book":…,"tidy":true}` reruns only `clean()` (names, common words,
  meanings that repeat the word) on the kept list, no model; `{"book":…,"strict":true}` sends only word + meaning to
  Sonnet (`STRICT`, 300 a call) to drop what a teenager knows (Max 2026-11-16: «їх», «зблизька», «сказать би»); a new
  book's build runs both. A word is underlined the first time in a chapter only.
  «Чорна рада»: 28 calls $0.54 (2026-11-15), strict $0.11 (2026-11-16), 1,191 words. Locally without a key: a JSON in `<DATA_DIR>/glossary/`.
  Max said «по всім словник» for the school list's books (2026-11-16): every Ukrainian classic on the shelf that is in
  «Шкільна програма» has one (14 books $4.9; a novel $0.4–1.2, a short story $0.03).
- Readers' uploads (Max 2026-11-16, a school's abridged PDF): an uploaded Ukrainian EPUB by a school classic's author
  (`CLASSICS` in glossary.js, `classic(authors)`) gets one by itself after `titleFromPages` (`glossUpload` in
  server/index.js), kept in the library's folder (`accounts/<id>/glossary/`, gone with the book or the account). The
  same work as a free-shelf book (title + surname) takes that book's list at no cost (`{ same }`); else a build, at most
  60 calls a book, 10 books a day, 3 a reader. The page asks `/api/glossary` for every own EPUB it opens (a list made
  after the page loaded shows too). See them: `GET /agent/glossary/uploads`; make one past the caps (a classic by
  someone else, only with Max's OK): `POST /agent/glossary/uploads {"acct":"<id>","book":"<file>"}`.
- New free-shelf classics from Wikisource: `scripts/wsbook.py` (recipe at its top). Many school works exist there only
  in 19th-century spelling (Кайдашева сім'я 1879, Квітка, Шевченко's 1840) or not at all (Старицький, «Сто тисяч»,
  Кобилянська's «Земля»); the 1876 Prague «Кобзарь» reads fine. A «Версії роботи» page is no text: free-shelf.py now
  skips an EPUB with under 5,000 characters («Хіба ревуть воли» came in as one line and was taken off).
- What Wikisource lacks, in modern spelling: OpenBook (sites.google.com/view/openbook2, Max's find 2026-11-16). A work's
  page embeds Google Drive files: `https://drive.google.com/uc?export=download&id=<id>`, the EPUB is the first id that
  is a zip. Same `wsbook.py` with `files` (its OPS/chapter-N.xhtml in order); a play in one file takes `split`. Leave out
  their notes and «Пояснення слів» chapters and their own covers («Відкрита книга» design); `source` in shelf.json =
  the work's page. «Сватання на Гончарівці» has Kvitka's Russian stage directions: Max chose to translate them (his lines
  stay), `tr` = `scripts/wsbook-tr/<name>.json` {source: translation}, applied per paragraph, a note on the title page.

## Search ranking (`store.search`, `searchAll` in web/server.js)

- A book's score: exact title 1000 (its part before «.»/«:» with readers 800), every word whole 500 (as typed,
  another form in the title by `store.forms`: «кава» → кави/каву/каві, only for a word the index has, never the bare
  stem; a Latin name that sounds the same, `store.latinSame`: «кінг» → king), +60 the words as typed, +15 a title that
  starts with them or an author they name, readers `30·log2(1+n)`, +20 a Ukrainian title, −300 a bundle, −i/2 the
  index's order. «Може, ви шукали» weighs a word by how few books have it (`store.docCount`). A Latin word only a letter off (`latinAlts`, 5+ letters) or a
  word's start finds a book but doesn't make it whole. Hits carry `whole`.
- Authors, publishers and lists: `nameFit(nq)` = 2 whole, 1 start/form/sound-alike. Their block goes under the books
  (`under`, pages.js `searchResults`) when the books have the words whole and the block has no fit 2 (Max 2026-11-16,
  «кава»). Wikidata's known works (`findKnown`) are put where their score would place them, not always first.
- Compare a change on the test DB: two servers (old checkout on another port) and a list of queries; keep
  кава, кінг, мурак, франко, війна, море, дюна, сапієнс, кафка, 1984 among them. Also the test DB's real ones:
  `search_log` (every query), and `reader_log` searches followed within 3 min by a `/book/` or `/author/` view
  (what the reader wanted): that page's place in the old and new results.

## «Книжковий ринок України», /market (`web/market.js`, `marketPage` in pages.js)

- Open numbers only, typed in by hand (Max 2026-11-16): Книжкова палата's yearly PDF (ukrbook.net/statistika_.html),
  УІК's «Показники книжкової галузі» (ubi.org.ua/uk/activity/doslidzhennya) and its quarterly єКнига results (a public
  Google Sheet of every title bought: `/export?format=xlsx` on the sheet linked from the report's PDF), Мінкульт /
  Gradus reading survey. Nobody publishes sales per title for the whole market. Charts are CSS bars and columns
  (`mkBars`, `mkCols`), no script. The top books find our pages by ISBN (`store.findWork`, an hour's cache), else
  they link to search. A new report: change the numbers and `UPDATED`, check the text under each chart still holds.
  Copies of the sources: project files `chytai-book-market/`.

## Translation pairs

- A Ukrainian book and its original are paired in `web/seed/matches.json`: `translations` (`[original, uk]`, slugs or
  ids) always stand, even next to another Ukrainian translation; `different` pairs are never linked. Check with
  `store.linkTranslations()` and `store.pairLog` (kept / dropped with tier) on the test DB.
- A series the data gets wrong goes in `matches.json` `series`: `{name, uk, books: [ids or slugs in order]}`; it wins
  over Wikidata and Goodreads (`store.linkCycles`). Two editions of one book: `merges` `[keep, dup]`.
- A shop's Ukrainian book whose original no catalog has: `matches.json` `originals` `{title, author, of, published}`;
  the jobs process makes it once as a book (`store.seedOriginals`, meta `originals:seeded`) and pairs the two.

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
  Before adding one, read that day's entries: related ones become one entry of one or two sentences with a link
  (Max, 2026-11-15: five «Книжкові події» lines → one).
- Test on production only under a test account, never Max's. No mail to test domains.
- «Статті» (web articles and essays) were taken out on 2026-11-10 and went to Max's blog («не ліпляться вони в
  Читай»): don't bring them back, on the site or in the reader. Their tables were dropped (store.dropArticles); the export is in project files `chytai-articles-export/`.
- Reader: how the text looks (theme, font, sizes, spacing, margins, column, page turns) is kept per device
  (`LOOK_KEYS` in `src/renderer/web-bridge.js`); the account's copy only starts a new device. A new look setting
  goes into that list.
- Reader: a reader's own cover (`PUT /api/cover`, the page cuts it to 900 px JPEG; `DELETE` = the file's again) is set in
  «Назва, автор, обкладинка». No letter to Max for it (Max, 2026-11-15).
- Reader «Додати книжку» → «Де ще шукаємо»: a store whose purchases download as files gets a row named by the store
  with «як додати» steps (`shopRow` in src/renderer/home.js: Yakaboo, Book.ua). No store has an API; we never sign
  in to a reader's store account.
- Reader: the app's own UI can't be selected (`body` has `user-select: none`, end of `src/renderer/style.css`). Text a
  reader may copy (a new note, answer or field) goes into the list of selectable classes there.
