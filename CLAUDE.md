# Chytai: how to work here

Chytai is a Ukrainian reading platform: the site https://chytai.org.ua (`web/`, Fly app `chytai-web`) and the reader
https://app.chytai.org.ua (`server/` + `src/`, Fly app `chytai`). `app/` is the iOS WebView shell, `mac/` the Mac app (Swift
over WKWebView, `mac/build.sh`; branch pushes get a `mac-beta` pre-release, see `mac/README.md`). The owner is Max; he writes Ukrainian, and every word a reader sees is Ukrainian, short, one plain clause.
The repo is public: never commit secrets, keys or `data/`.

Keep this file up to date (Max, 2026-11-09): when you add a way of working, a tool, an endpoint or a rule that the
next thread should know, change this file in the same commit. Short recipes, not history.

## Ship

- Push straight to `main`, no pull requests. `web.yml` deploys `web/**` to chytai-web, `deploy.yml` the reader's own
  files (its `paths`: what the root Dockerfile copies) to the reader. Each has its own dependencies: web/package.json
  (site) and the root package.json (reader); a package goes only into the app that uses it. Only `server/agent.js` and
  `server/aimeter.js` are shared (both deploy). A new file the reader's image needs goes into the Dockerfile and those `paths`. Both run a smoke test first (`scripts/smoke-test.sh`, `scripts/smoke-reader.sh`); the site also runs
  `scripts/perf-check.sh` after the deploy and goes back to the previous image when a main page got slow.
- A new page or admin tab goes into the smoke test's lists.
- Don't deploy during the Friday digest (09:30 Kyiv). Batch small fixes.

## Prove it works before you push

1. `scripts/fetch-test-db.sh`: a scrubbed copy of last night's production DB into `data/web/` (e-mails are
   `<id>@test.invalid`, the owner is `owner@test.invalid`).
2. The site and the reader have their own dependencies (Max 2026-11-17): `npm ci --prefix web` for the site
   (web/package.json), `npm ci` at the root for the reader. Then `CHYTAI_ROLE=web PORT=8090 node web/server.js`. Covers in screenshots need `vipsthumbnail` (as in
   web/Dockerfile): `apt-get install -y libvips-tools`, else /t/ thumbs fail (srv log «thumbs: … vipsthumbnail») and
   pages show coloured blocks; wait for images (`networkidle`) before a screenshot. Sign in at `/login` with any test address: the code
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
  >8 pages without our cookies in 10 min (`admin.js crawler()`); clean a past flood once with `dropCrawler(key, where)`; a robot that runs our script
  also left `page_views`: take each row's view off by it (`dropRobot1122`).
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
  script answers (a robot that runs no script made 5–15× the real guests on 12–16.11). A browser with
  `navigator.webdriver` sends no `/api/speed` and its `/api/seen` is dropped, and so is a guest whose time zone is
  Asia/Shanghai with an English browser (`robotBeacon` in server.js: the robot of 22.11, ~80 one-page «guests» an
  hour, year-old Chrome, a new address each page; a new robot's mark goes there too); `GET /agent/guests` = the last 400 guests' first beacons grouped
  (user agent, time zone, language, screen, address's first two numbers), in memory only. Playwright locally:
  `addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => false }))` to be counted. Readers' views stay
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
  `firstDays` (accounts of 60 days: opened a book, 10 min in week one, two days). «Перші дні», «Де
  кидають книжки», «Що натискають»; a new control gets a Ukrainian name in `UI_NAMES` (server/admin.js).
  «Функції» (Max 2026-11-19: «що у нас і як користуються»): every reader feature as one row (`FEATURES` in
  server/admin.js: tap names for `use`, and `seen` where the reader is shown it first), readers 7 / 30 days, taps,
  Max's own apart (`uiMax`, kept out of `ui`). Hand counts beside the taps: `intro-shown` / `intro-read` /
  `intro-gone`, `gloss-book` (a book opened with underlines on; `gloss-nohl` = a device with no CSS Highlight, iOS before 17.2, no underlines), `toc-go`, `search-run` / `search-go` (once an
  opening), `psearch` / `psearch-pick` (the panel), `look-<setting>` and `look-gloss-<level>`. A new feature gets a
  row in `FEATURES`, and a hand count when no tap shows it.
- The reader's own stats are in the reader (Max 2026-11-20, «щоб воно не відправляло на сайт»): «Адмінка» in the
  panel, Max only (`settings.owner`; app.chytai.org.ua/admin or /?admin opens it). `GET /api/admin` (owner session) =
  `collectStats()` with titles from the reader's own libraries and the day's cost of one word; `POST /api/admin/off`
  switches an account off. «Читачі» shows the device last used (`accounts[id].dev`, deviceOf, from `/api/reading`). Drawn by `src/renderer/admin-view.js` (home.js page `admin`), plain text, no links to the
  site. The site's /admin/reader is gone (Max 2026-11-20; it redirects here); its Огляд keeps the reader's four tiles
  (`/api/site-admin`), linked to the reader's «Адмінка».
- /admin «Performance» (`healthBlock` in web/admin.js): one bullet per check, red with a link when it needs a look. Keep
  it so (Max, 2026-11-12, after it was folded into one sentence: «мені не подобається»); trim a row, don't merge rows.
- Pages the phone unloaded (iOS kills the WebView's page for memory, mostly in the background): the page keeps a note
  of itself in localStorage (`chytai:life`, web-bridge.js `life`), the next load reports it to the reader's
  `/api/page-gone`. The book on screen has its own note (`chytai:onscreen`), kept until the reader goes to the home
  screen: any load within 12 h reopens it at its saved place, even after pages that died before the book opened
  (Max 2026-11-17); three deaths in a row with it = home screen. Rows in the reader's `state.stats.days[day].gone` (30 days);
  the reader's «Адмінка» «Вивантаження» and a line in the technical report from 3 on screen a day (not on Огляд, Max 2026-11-13). To see
  memory on a phone width locally: Playwright WebKit, RSS of `WPEWebProcess`; kill it (`pkill -9 -x WPEWebProcess`)
  to fake an unload. epub.js keeps every chapter it loaded until the book closes: load one yourself → `unload()` it
  after (renderer.js `addTocPages`; a chapter's view unloads it when destroyed). Count kept ones:
  `book.spine.spineItems.filter((s) => s.document).length`; Chromium heap snapshot (CDP) shows who holds what.
- AI spend (`web/aiusage.js`, `server/aimeter.js`): every Claude call in both apps is counted by patching the SDK once
  per process (no caller can skip it; feature = the calling file). Site table `ai_usage` (day, app, feature, model,
  tokens, searches, cost); the reader keeps `state.stats.days[day].ai`, the site copies it hourly. Telegram once a day
  when the day passes $25 (Max) or a feature costs >2× its 7-day median and >$3; «AI за добу» in the technical report.
  A new feature file gets a Ukrainian name in `LABELS`; new models go into `PRICES`. The Console
  (platform.claude.com/cost, no admin key here) also sees what our code doesn't call.
- Prompt caching (Max 2026-11-19: watch it ourselves, not wait for Anthropic's mail). Every call puts its fixed text
  first (system prompt, then whatever repeats across calls) and `cache_control` after it; dates, a reader's data,
  book text and pictures go after the breakpoint. Below 512 tokens (all our 5.x models) nothing caches, marker or
  not. Check a new call on `ai_usage.cache_read`. The tech report's «Кеш промптів» line (`aiusage.cacheLine`, only on a day a feature broke) gives
  the day's share read from the cache, the week against the week before, and who sends most uncached; a feature
  that usually reads ≥30% from the cache and today under half of that sends one Telegram line (`cacheBroken`). The
  total alone moves with the mix: on 2026-11-19 Anthropic's «−31%» was the overview loop gone (cached) and new
  features sending book text and pictures (never cached), no prompt broke.
- A job registered with `{ run: true }` (`bg.register`) starts a fresh web process after every run (log «main: the jobs
  changed X; the site reloads», ~10 s of CPU). Data a page reads itself on a timer (`linkFor`'s 10-minute map: sluhay,
  bookflow) takes `run: false`; on 2026-11-18 those two reloaded the site 2–3 times an hour for nothing.
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

The deploy log (Max, 2026-11-16, to see whether the pause shrinks): web.yml's `scripts/deploy-probe.sh` asks
/robots.txt every second through each deploy and posts the longest pause, probes with no answer and Fly's undelivered
requests (`fly_edge_error_count`) to `/agent/deploys`; main.js keeps its stop time in `main-stop.json` and logs
stop → first page after a restart. Table `deploys` (180 days), /admin/speed «Деплої», `GET /agent/deploys?days=`.
Before it, Fly's Prometheus keeps ~2 weeks of `fly_edge_error_count` (zero outside deploys).

Deploys without a restart (Max, 2026-11-16, a week's trial; `web/release.js`): web.yml first uploads the site's files
of the commit to the volume (`scripts/hot-deploy.sh`: `flyctl ssh sftp put`, then `node /app/web/hotdeploy.js <sha>`
over ssh). main.js starts a fresh web process on them, opens /, /robots.txt, a search, /calendar, /lists, /updates on a
private port, and only then moves the site to it; the old process finishes, the jobs restart. Rules:
- An image deploy (with the pause) still happens when web/package*.json, web/main.js, web/release.js, web/hotdeploy.js,
  web/Dockerfile or web/fly.toml changed, or ssh fails (result `full`). Pages that don't open: `failed`, the old code
  stays, the run fails: fix it like any broken push.
- A machine restart starts on the release (`releases/current.json`, tied to its image); a release that dies at start
  is dropped (`dropped.json`) and the image's code runs. `/agent/health` → `commit`, `imageCommit`, `release`.
- Rollback = the same switch to the commit before (web.yml's check, rollout-watch's `hot:<sha>`); by hand:
  `flyctl ssh console -a chytai-web -C "node /app/web/hotdeploy.js <sha>"` (a release on the volume or the image's).
- Schema changes must stay additive: old and new code share the database for a few seconds.
- Locally: `GIT_SHA=<any> node web/main.js`, put a `git archive` tgz in `data/web/releases/incoming/<sha>.tgz`, run
  `node web/hotdeploy.js <sha>`. Off: repo variable `HOT_DEPLOY=off`.

An image deploy takes the one-machine site down while Fly swaps the image (~12 s, then ~10 s to read the catalog);
the image is built with GitHub's layer cache so Fly pulls only the changed code layer. «Сайт лежить»
right after a push: first the deploy job's log («Waiting for machine … to reach a good state») and the machine's
events (GraphQL `machines{nodes{events{kind timestamp}}}`); on 2026-11-16 Fly took 2 min 40 s there, no code at fault.

## Morning error review (scheduled task «Розбір помилок Chytai», ~07:00 Kyiv daily)

A fresh session each morning (Max, 2026-11-11: «розбирати їх», not Telegram per error). Its note completes the day's
technical report (below), so post it only after your fixes are pushed:

1. `curl -s https://chytai.org.ua/agent/triage -H "$H"` → `at` of the last review; the errors since then:
   `/agent/health?since=<at>` and `/agent/sql` on `errors` (stack, url, how often, first seen).
   `at` null: look at the last 24 h. Check `git log` first: an error from before yesterday's deploy may be fixed
   already (compare its last time with the Actions run's end); then it is only a line in the note. In SQL, strings take
   single quotes (send the query from a file: `-d @q.json`). Backups showing `today: false` early in the morning are
   normal: GitHub starts the 00:17 schedule 5–7 hours late.
   Max's bug reports from the Telegram bot (`bugs` in that answer = open ones): `curl -s https://chytai.org.ua/agent/bugs
   -H "$H"` (text, voice transcripts, forwards; screenshots at each part's `file`, fetch them with the same header and
   look; a screen recording: `ffmpeg -i v.mp4 -vf fps=2 f%02d.jpg`, then look at the frames). Fix each like an error; then `POST /agent/bugs/<id> {"status":"done","note":"…"}` (`skip` = not a bug, `later`
   = left for Max); done / skip answer Max in Telegram under his message, so the note is one plain Ukrainian clause.
   A bug or a clear fix: fix it now. An idea that needs talking over, or one with several ways to build it (Max
   2026-11-20): build nothing; `later`, and ask the coordinator for its own thread, where the proposals (variants,
   screenshots) wait for Max's answer.
   A reader bug on Android that a desktop Chromium won't show: measure without forcing styles (a `getComputedStyle`
   each frame hides a transition bug); count `transitionrun` events instead.
2. Each kind: noise (an extension, a network drop, a bot) → widen the filter (`CLIENT_NOISE` in server/index.js) only
   if it repeats; real → reproduce on the test DB / a local reader, fix, prove, push to main like any small fix (not
   during the Friday digest). Big, risky or a product question → leave it for Max, one plain line why.
3. One short Ukrainian line for the technical report, even when there was nothing, at most 200 characters (a longer
   one is refused with 400: write it again shorter). Counts and outcomes only, how you fixed it goes into the commit;
   only what Max must do gets a few words:
   `curl -s https://chytai.org.ua/agent/triage -H "$H" -H 'content-type: application/json' -d '{"text":"нових 3: виправлено 2, вам 1: …; з бота: №4 виправлено, №6 вам: …"}'`.
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

## The Telegram bot and its two reports (`web/telegram.js`, `web/dailyreport.js`)

- The bot (`web/telegram.js`) writes to Max's chat and to the accounts he allowed (Max 2026-11-16, his Android): a
  stranger's /start asks him with «Дозволити» / «Ні» (one a day), `telegram:extra` keeps them, /who in his chat lists
  them with «Забрати», /off in theirs stops it. `telegram.send(text)` goes to all; buttons only to Max, only he presses
  them. The reader gets the list from the site (`/api/site-admin/telegram` `chats`).
- Bug reports (Max 2026-11-18, `web/bugbox.js`): anything but a command that Max's chat or an allowed one writes to
  the bot (text, screenshot, file, voice, forward, a reply to an alert) is a report in table `bug_reports`; each
  message its own unless it comes within 30 s of the last (Max 2026-11-22, `JOIN_SEC`), or is the rest of an album,
  words within 3 min after a screenshot with none, or a reply to the bot's «Записав №N» (joins №N). The bot answers «Записав №N»; a voice is transcribed by our Telegram
  account's Premium (`tgFeed.transcribe` in the jobs process: sent to its Saved Messages, `messages.transcribeAudio`
  plus its `updateTranscribedAudio` updates, the longest text wins: asking again alone cut the words mid-sentence; deleted) and the bot answers with what it heard (the Claude API takes no audio). /bugs lists the open ones. The
  morning review works them (above). Files in `DATA_DIR/web/bugs/<id>/`: gone 14 days after a report is closed, 60
  after it came; rows 180 days. Try locally: `TELEGRAM_BOT_TOKEN=test TELEGRAM_API=http://localhost:<fake> TELEGRAM_CHAT_ID=111`
  and POST updates to `telegram.hookPath()`.
- 08:00 Kyiv: readers only (sign-ups, visits, shelves, the reader's minutes and explanations). Nothing technical in it
  (Max, 2026-11-12).
- Technical, once a day, when both nightly backups (site, reader) have reported today and the morning review posted
  today's note; at 10:00 Kyiv at the latest (`DEADLINE_HOUR`), and then a missing copy is a failed one («не вдався», Max 2026-11-12):
  headed «Технічний звіт за …» (Max 2026-11-17): backups, yesterday's errors and failed jobs, the site's downtime from the
  deploy log (`deploys.line`: probes' pauses + restarts no probe saw), the review's note, pages the phones unloaded, search health (arrivals
  from Google and Search Console impressions against the 14-day median, «різко менше/більше» at half or double), disk and memory of both
  machines (moved here from /admin, Max 2026-11-12; the reader's comes with its `/api/site-admin/day`). Meta
  `techreport:lastRun`.
  It fits one phone screen (Max 2026-11-20, «вже не вміщається в один скріншот»): a line only when something is off.
  Always: header, backups, errors (the new kinds by name only when the review didn't come), «Розбір помилок», «AI за
  добу» (total and the biggest feature; three over $25). Only when off: downtime (30 s+, a restart without a deploy or
  Fly's undelivered requests), pages unloaded on screen (3+), disk and memory (near a limit), Google («різко»), the
  prompt cache (a feature broke), Telegram channels (counts). A new line follows the same rule. Try either on the test DB: `require("./web/dailyreport").buildTech({ db, day, ownerId, site,
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
  (`club.lively`); none = no block. «Події» right after Для вас: three lines (Max 2026-11-23) of the next 14
  days (`homeEvents` in server.js: own shelf's authors, then author/festival/lecture before clubs; `calHome` reuses
  `calLine`). The test DB may have no upcoming events: copy some rows of `cal_events` from `/agent/sql` locally.
- Search with no book that has every word (`searchAll` `near`, 2026-11-15): «Може, ви шукали:» authors, publishers and books with most of the
  words, a one-letter typo counting («після вільного шляху» → «Пісня відкритого шляху»); under them the outside lookup still
  comes (`/api/search/outside?after=1`: «Немає на Chytai, можна додати», or the link / by-hand form), since that is how a
  missing book gets added (Max 2026-11-22, «my struggle»). It offers only Ukrainian or English books (Google's edition
  language, Open Library's work languages; Max 2026-11-23, bot №43: a German «Call the Midwife» became a book).
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

- Max's design A + D from a design canvas (2026-11-15): «Мої автори» (authors on one's shelf), «Події» on the
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
- Every event has its own page (Max 2026-11-15, design canvas EzYcx7zJcqfYf5Bi6XgDrX): `/calendar/<short slug>-<key>`
  (`calendar.eventPath`: the name in quotes or the title without words every event has, ≤4 words / 32 letters; key = 8 hex
  of the id's sha1, the key alone finds it, so a corrected title or an older long address redirects; `calendar.byKey`), `.ics` after
  it = that event alone. `eventPage` in pages.js, the route in server.js (books with «Хочу прочитати», a tour's stops,
  4 more events: same book/author, then same kind and city). Every title, row cover, the clubs shelf (one meeting),
  the book page's «Подія:», the author's «Події» and `/calendar/go/<id>` (letters) lead there. The organizer's button
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
- «Стежити за подіями автора» (Max 2026-11-16, design B of canvas T9FRf5g4DdjqqhvjUsnKM1; authors only, never a book:
  «стежити за книжкою це тупо»): a /calendar search with no events shows `calWatch` (pages.js): the authors the site
  search finds, or the author of the book it finds (`watchCandidates` in server.js on `searchAll`, so a typo works
  through `near`/`nearAuthors`), photo, a few covers, the button (`watchBtn`), then the next author meetings; no kind
  chips and no «Підписатися» there. Table `cal_watch` (reader, kind `author`, ref = slug; 30 a reader), `POST /calendar/watch`, a guest by `GET /do/calendar-watch?kind&ref&back`. The letter
  «Подія: …» (`calendarWatchMail`, hourly job `calendar-watch`, 10–21 Kyiv, all new events in one letter, `mailLog.room`,
  kind `calwatch`; `cal_watch_sent` marks; «Не стежити» = `/calendar/unwatch/<reader>/<digest token>`, all off). The
  author page's «Події» block: upcoming, past as one line (`calendar.pastForAuthor`), «Стежити за подіями»; no events
  ever = no block.
- «Хочу піти» on an event's page (Max 2026-11-16, in place of «Додати в календар»): `POST /calendar/<id>/going`
  (table `cal_going`, a guest signs in and lands back marked by `GET /do/calendar-going?id=`); once pressed the page
  shows «✓ Іду», the calendar links and «Нагадаємо листом за день»; others' count under it. A letter the day before
  (`calendarReminders` in server.js, hourly job `calendar-remind`, from 10:00 Kyiv, one letter a reader, `reminded`
  marks it; «Не нагадувати» = `/calendar/remind-off/<reader>/<digest token>`, meta `calremind:off:<id>`, back on with
  a button on the event page). /admin/events «Хочуть піти» lists the counts.
- In a phone's calendar (a line at the page's foot): `/calendar.ics` is the list as an iCalendar feed with the same
  `?kind=` / `?city=` / `?q=`; «Мої автори» by `?mine=<reader>.<key>` (`calKey`, HMAC with the reader secret; a
  calendar app has no cookie). Links: webcal:// (Apple), Google Calendar's `?cid=`, and the plain address.
- Only the next half a year (Max 2026-11-21): `upcoming()` stops at `AHEAD_DAYS` (183); an event's own page still opens. Today's event with an hour leaves `upcoming()` two hours after it starts (Max 2026-11-22, №42).
- Only Ukraine and online (Max 2026-11-15): the collectors' Haiku answers `abroad` and those are dropped;
  `calendar.abroad(city)` (list `ABROAD`) hides a foreign city at upsert and at start, and /calendar/add refuses it.
- Book presentations (Max 2026-11-20, «спам презентацій»: 80 of ~300, libraries' local books and one author's
  30-city tour): `calendar.presentation(e)` (title says «презентація», not a festival) keeps them out of /calendar's
  overview and list, the homepage, subscriptions, the .ics and an event page's «Ще події»; they stay in a search, under
  «Мої автори», by one's own authors, on author and book pages, in author-watch letters, and in their own list
  `/calendar?pres=1` (a line under the list). Still collected (the author pages need them).
  The ones worth it for readers anywhere come back (Max 2026-11-22, variant C, «зустріч з Артуром Дронем»):
  `cal_events.wide` (NULL = not rated = hidden, 1 = shown, 0 = not), Haiku rates upcoming unrated ones 25 to a call
  each tg run (`tgFeed.rateWide`, prompt `WIDE`: known authors and publishers, translations, big bookshops and venues
  yes; a library's local author, amateur poetry, one district's history, religious, self-help, romance no). Max
  flips a whole tour on /admin/events «Презентації» (`POST /admin/events/wide`, `wide_by = 'max'`, Haiku never
  overwrites it); his last 40 choices go into the prompt as examples (meta `calendar:wide-max`).
  `calendar.isPresentation(e)` = any presentation, `presentation(e)` = one still hidden. A presentation tour is one
  row by its first book (`tours`), whoever posted its stops (Дронь: two channels, 30 stops).
- Places (Max 2026-11-23, variant A of canvas KSNVhHFPtyPEwJmvveTAde): `calendar.venue(e)` turns the free-text `place`
  into a key, name + the street's first 5 letters («сенс|хреща»: «Сенс на Хрещатику» = «книгарня «Сенс» (вулиця
  Хрещатик, 34)»); `venues(events)` → places with 2+ events by city and `keyOf` (an event with no street joins its
  name's one street, never for a chain: `CHAINS`). The row's place is a link (`placeOf` in server.js, a minute's cache)
  to `/calendar?city=…&place=<key>`: the chip «Назва, вулиця ✕» in place of the search, presentations shown, and
  `place` in subscriptions (`subKey`), `calPick` and the .ics. No place chips row (Max chose A: few places have 5+ events).
- Events by day (Max 2026-11-23, to see December and January): table `cal_days` (day, held, added, ahead, kinds),
  `calendar.countDays()` hourly in the jobs process (job `calendar-days`) rewrites today and yesterday, fills missing
  days once from what is kept; /admin/events «По тижнях» (`eventDaysBlock` in pages.js), «По днях» under it.
- Duplicates: `findSimilar` reads ’ ʼ ' as one apostrophe (cities are kept with ’) and takes `time`: same day, city and
  hour plus one word of the «» title in common = one event. The ones that came in before were hidden once at start
  (`dedupe`, meta `calendar:dedupe` lists them).
- Table `cal_events` (id `{source}:{key}`, starts/ends `YYYY-MM-DD` Kyiv, time `HH:MM`, city as shown, «Онлайн»
  for online; books/authors JSON found by name, no AI: `linkText`, a name's two words side by side, «Олександрою … книгарні» ≠ Олександр Книга; never a Russian edition, `findBook`). Gone 30 days after it ends (`cleanup`); one with an author or book linked stays a year (`KEEP_LINKED_DAYS`, for the author page's past events).
- Sources: `web/seed/calendar.json` (kept in step at every start: festivals by a thread or Max; an entry with `fix`
  = a collected event's id corrects only the fields it names: place, sub, time, city, starts, ends; `"hide": true` hides
  one that is not about books, Max's bug report №31); readers via
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
  them on his computer with `npm ci --prefix web && node web/scripts/tg-login.js`, a QR code the phone scans; `--code` = by a code): it joins channels in the seed's order (Max's own first; the account has Premium) as fast as Telegram lets it: a job every 10 min (`tg-join`, `joinMore`) joins until FLOOD_WAIT, whose end goes into meta `tg:flood` (`/agent/tg` → `flood`), mutes each (Max uses that number himself, 2026-11-15), and reads what is new; channels joined by hand on the account (`last.own`) are read and muted too, add them to the seed to keep them. A
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
- Events from those posts: an event word and a date not past, or a day without a date in a post of the last week
  («цієї суботи», «у четвер», «завтра»: `SOON_WORDS`, Max 2026-11-16), or an event word and a picture in a post of the
  last week (`maybeEvent`, ~1 post in 10). A post's pictures go to Haiku too (Max 2026-11-17: a poster had a tour's 22
  dates and the book): `tg_posts.photo`, `pictures()` reads at most 2 from the post's public embed page
  (`t.me/<channel>/<id>?embed=1`), nothing kept; a tour on a poster = one event a stop. The letter groups a tour's
  stops into one item (`calendar.tours`) → Haiku 5.5 answers the
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
  the rest 25 to a call, within the same daily cap; «other» isn't asked again (meta `tg:other`). «author» only when the
  book's author takes part (Max 2026-11-18: «якщо автора немає на зустрічі то це книжковий клуб»): a presentation or
  discussion without the author (a translated or late author's book) is «club»; a Ukrainian author's presentation stays
  «author» unless the text shows the author is absent (`KIND_HELP` and SYSTEM).
  The events already in were sorted again (`recheckAuthors`, meta `tg:author-recheck` = 2, changes in
  `tg:author-recheck-log`; the first pass moved Ukrainian authors' presentations to clubs, the second put them back).

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
- podii.io (Max 2026-11-16) was read daily until 2026-11-20 (Max: «можна вимикати», 1 event in 3 days against YouScan's
  34): collector taken out, its events (source `podii`) stay. `findSimilar` leaves out words every meeting has
  (`EVENT_WORDS`: клуб, читацький, обговорення…): two clubs on one day are not one event.
- YouScan (Max's trial 2026-11-17; `web/youscan.js`, source `ys`): a topic's webhook (topic Settings → Integrations →
  Webhook, sent by its Rules; the API is a paid add-on, not used) posts mentions to `POST /api/youscan/<key>`; the
  address with its key: `curl -s https://chytai.org.ua/agent/youscan -H "$H"` (`hook`, plus what came in, `by` state,
  topics, the last 10). Kept 30 days (table `ys_mentions`, 3,000 a day). Every 15 min the jobs process skips non-Ukrainian
  ones and channels the tg collector reads, sends those `maybeEvent` passes with the post's picture to `tgFeed.extract`
  (300 calls a day, Max 2026-11-18) with the links in its text; the link is the post's one sign-up form, else the post. Dry run (spends ≤20 calls, Max's OK): `GET /agent/youscan?dry=1` (ask again);
  run now: `POST {"run":true}`. Topic «Книжкові події» (app.youscan.io/themes/544216: 26 quoted phrases, Ukrainian, ~200 a
  day) with rule «Усе на Chytai» (future mentions → the webhook), set up 2026-11-17 in Max's Chrome at his request.
  Sources by keyword: Threads, Telegram, YouTube, TikTok, X, news, some Facebook; Instagram/Facebook pages only as
  channels added one by one (the trial has no social account page). Title and text come with `<b>` round matched
  words (`plain`). Haiku leaves out reports of a meeting that already took place (SYSTEM in tgfeed.js).
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
  Never genre romance (Max 2026-11-17, «Це якийсь ромком? Давай таке не додавати»): Haiku marks each named book
  `romance`, and an event whose words are about romance (`ROMANCE_EVENT`) marks its quoted titles; such a book is linked
  when the catalog has it, never added.
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
  server/index.js; Max 2026-11-17 kept it: «словник класно працював»), kept in the library's folder (`accounts/<id>/glossary/`, gone with the book or the account). The
  same work as a free-shelf book (title + surname) takes that book's list at no cost (`{ same }`); else a build, at most
  60 calls a book, 10 books a day, 3 a reader. The page asks `/api/glossary` for every own EPUB it opens (a list made
  after the page loaded shows too). See them: `GET /agent/glossary/uploads`; make one past the caps (a classic by
  someone else, only with Max's OK): `POST /agent/glossary/uploads {"acct":"<id>","book":"<file>"}`.
- «Словничок 2» (Max 2026-11-17, for everyone, no flag): Opus reads the text (`PROMPT_V2`), gives each
  word a level (1 = the sentence is unclear without it, 2 = a hint helps) and its dictionary form; `sweep()` then has
  Haiku add the book's other forms of each word (the old list's misses were mostly forms). Kept apart in
  `DATA_DIR/glossary-v2/<book>.json` (`forms: {form: [meaning, level, word]}`); `/api/glossary` gives it, with
  `levels` and `words`, to everyone (guests too) for a book that has one; others keep the first list. «Аа» → «Менше» (level 1) / «Більше» / «Ні» (`gloss` = on / more
  / off); «Більше не показувати» (was «Знаю це слово»; often a phrase) on the card keeps the word in `glossKnown` (account, 3000 at most) and every form of it goes.
  One selected word (renderer.js `wordCard`, signed-in readers): its meaning on the selection's card, from the book's list, else
  `POST /api/word` (server/word.js, Sonnet low effort, ~1 s; one word = one meaning in a book, Max 2026-11-17: the first answer is kept by book + word for every reader and every sentence, `DATA_DIR/word-kept.json`, 5,000 at most). Proactive hints for
  ordinary books (who/what, notes) were tried and Max said no (2026-11-17: «трошки нахабно»). Make one book's (Max's
  OK; «Чорна рада» ≈ $6–7): `POST /agent/glossary {"book":"…","v2":true}`; status under `v2` in `GET /agent/glossary`. Homographs (Max 2026-11-17: «знай», «стіл» explained in a sense the book doesn't use): after a build `homographs()` has Sonnet list words with a common sense, finds up to 6 of the book's sentences for each, spread over the book, and drops a form whose meaning is wrong in a third of them or more (2+ sentences, never over a quarter of the list; Max 2026-11-17, «махнув рукою» ≠ «вирушив»); by hand `{"book":…,"v2":true,"homographs":true}` (`"dry":true` = only show, ~$0.3 a novel). Then `plain()` (Max 2026-11-17: паливода → «гульвіса, шибайголова»): Sonnet rewrites an explanation that uses words as hard as the word itself (`PLAIN`), once for every form sharing it; by hand `{"book":…,"v2":true,"plain":true}` (`dry` too). All prompts ask for everyday words. One-word answers (word.js, wordahead.js) go through `tidy()`: first line, no English notes after a Ukrainian meaning; a capitalised word gets the `NAME` prompt (only what the sentence shows, never a guessed kinship). Each Opus answer is kept in `<book>.json.parts/` as it comes, so a restart
  (any thread's deploy) loses nothing: 30 s after start `resume()` goes on with the kept answers paid for already.
  Words ahead (2026-11-17, prepared meanings for the passages around the reader, then underlined) were taken out the
  same day (Max: «одна штука замість двох»; they underlined «ліки», «демони» and saved ~1 s on one selected word in
  five for 3× the cost): don't bring them back. Improve «Словничок» instead. The reader's «Адмінка» «Одне слово» = selected
  words, how many were in the book's list (`word-list`), and the cost.
- Every book (Max 2026-11-18, «Level up your reading»; not only old words): an EPUB with no list gets a «Словничок 2»
  list by parts once the reader presses «Підготувати словничок» in the book's menu (`POST /api/glossary/start {book,
  pct}`; Max: not by itself). `ahead` / `lazyPart` in glossary.js, `glossLazy` in server/index.js. Then the page sends
  where the reader is (`POST /api/glossary/at`, gloss.js `at`, every 2%; a book with no list answers `none` and the page
  stops asking): the part there and the next 2 (15,000 characters each, ~$0.25 on Opus) are made if missing, then
  sweep, homographs and plain on the new forms only (`only`). Model chosen at the start and kept (`model` in the
  list): a reader's first 3 own books Opus (`LAZY_OPUS_BOOKS`, `state.glossOpus[acct]`), then Sonnet; Max always Opus
  (Max 2026-11-18); a free-shelf book Opus, one list for all, not counted. A school classic takes PROMPT_V2, any
  other book PROMPT_ANY (terms, allusions, foreign phrases, realia, idioms; meanings in Ukrainian whatever the book's
  language; Max 2026-11-22: no coarse words whose sense is plain, no place names, never «тут:»). Kept with `lazy`, `of`, `done`, `covered`: own books in `accounts/<id>/glossary/v2/`, the free shelf in
  `glossary-v2/`. Not for publishers' books or a book with a list already. Caps: $20 a day for all (`LAZY_DAY_USD`,
  Telegram once), $5 a reader (`LAZY_ACCOUNT_USD`, Max none); stats day `glossLazy`. The book menu shows it after
  «Про книжку» (`glossLine` in home.js, `GET /api/glossary/status`: covered, words, names, building), not «Аа».
  `app.chytai.org.ua/?new` shows the empty shelf's start screen over one's own books (Max, to look at it).
- «Про книжку» that helps to read (Max 2026-11-18, `server/bookguide.js`, `GET /api/guide?book&title&author`, home.js
  `showGuide`): «Про книжку» and «Чому варто читати» (`BEFORE`, `BEFORE_V`, Opus once a book, for any EPUB; made when
  the book opens, renderer.js after `bookOpened`, or «Про книжку» does; a v1 answer is made again then). No site
  description, no «Як читати» (Max 2026-11-20: condescending), no level or pages; the link «Сторінка книжки на Chytai ↗»
  (or «Додати на Chytai ↗») is back at the foot of the dialog and the panel's block (Max 2026-11-22). A paper
  book gets the same from its title, author and the site's description (`guide.paper`, kept by title + author as
  `p<hash>`, made when its panel opens; a book the model doesn't know is kept as `none`), in the dialog and in the
  panel's inline «Про книжку» (home.js `aboutBlock` / `loadGuide`); the description shows only for a PDF or when the guide can't be made. Kept by the text's hash (`DATA_DIR/guide/<key>.json`, same file = one guide for all), unused
  180 days → gone. EPUBs only, no publishers' books. Caps $5 a day for all (`GUIDE_DAY_USD`, Telegram once), $1 a reader
  (guests together), Max none; stats day `guide`. Opens from the home book menu, the title in the book's top bar
  (`act-title-about`) and the panel's «Про книжку». No «Перевірте себе», no change to «Зміст» (Max).
  The recap of a started book («Де ви зупинилися / Що було досі / Хто тут хто») was taken out on 2026-11-19 (Max: it
  retold what he read the day before; «Хто тут хто» = the names card): don't bring it back, nor a recap guessed by
  days away, nor «що ви могли пропустити» (Max: condescending).
- Paper books (Max 2026-11-22, bot №14 C and the cover's card): a tap on «стор. N» under the title opens «На якій ви
  сторінці?» (paper.js `pageSheet`): a number (a lower one too) or a photo (`/api/paper/scan?kind=pagenum&learn=<book>`:
  the number at once, then the page goes into what the reader has read, `learnPage`). «Додати паперову книжку» → the
  cover's card (`showCard`): «Про книжку» / «Чому варто читати» by `GET /api/guide?paper=1&title&author` (the same kept
  answer the book gets once added), then «Додати»; «Не та книжка» = the catalog's other matches. Not now (Max): several
  photos in one question (№9), choosing in a bookshop (№15).
- «Перед главою» (Max 2026-11-19, flag `chapter-intro`, `GET /api/guide/intro?book&href&snip&pct`, renderer.js
  `introCheck`): up to 3 notes for the chapter the reader is in, like an annotated edition's (history, customs,
  references, earlier threads; `INTRO`): never what happens, no hints that something matters, never «ви» (Max:
  «самопомічник», not «ти міг пропустити»). A small card at the page's foot when a book opens and on a chapter's first
  page; a tap opens the notes, × hides; once a chapter a device (`chytai:intro-seen`), gone after 3 page turns. A
  chapter = a spine file (`epubParts` `hrefs`), cut into 24,000-character pieces; Opus once a piece for every reader of
  the same file (~$0.04–0.09), same caps as above. Leaving a book (`auto=1`) makes the saved place's notes and, near a
  chapter's end, the next one's. Try a prompt: `.tmp/recap-try/try2.js` on Max's Mac (key from .env).
- A wrong or needless meaning Max reports in a free-shelf book (bug reports): `free/glossary-fixes.json`, per book
  `drop` (a dictionary word with all its forms, or one form) and `set` (form → [meaning, level, word]; give every
  form of the word the same meaning), laid over the kept list by `/api/glossary` (`glossFixed`); the file on the
  volume stays as made. Forms of one word often carry different wordings (334 of 364 in «Чорна рада»).
- Names (Max 2026-11-17: the card made up who «Васюта» was): `buildNames` (glossary.js, `NAMES`) has Opus read a
  free-shelf book whole once (Чорна рада $0.93, 2.5 min) and describe its people and places, kept in
  `DATA_DIR/glossary-names/<book>.json` (`names: {form: [about, full name]}`), sent by `/api/glossary` as `names`.
  Never underlined: only the one-word card reads them, for a capitalised selection (gloss.js `lookup`, ui `word-name`).
  Forms that mean two people, and words written small more often than capitalised, stay out (`parseNames`). Made when
  someone first opens a book (Max 2026-11-17, anyone, guests too; `namesOnOpen` in server/index.js from `/api/book`): a
  free-shelf book once for all, a reader's own EPUB in `accounts/<id>/glossary/names/`; 10 books a day, 2 a reader, 2 at
  once, a failed one not again until a restart, Telegram once when the day's cap is hit; no PDFs, no publishers' books.
  By hand: `POST /agent/glossary {"book":…,"names":true}`; status under `names` in `GET /agent/glossary`. A reader's own
  EPUB again (Max's OK): `POST /agent/glossary {"acct":"<id>","book":"<file>","names":true}`, status `GET ?acct=<id>`.
  A card says only who or what it is to the story, ≤8 words (Max 2026-11-22, variant C of bug report №29: «Біллі —
  головний герой», not a biography); never how someone's story ends, even when the book tells it early; a publisher's
  note on the author before the text gives no cards. A name never gets an underline: `/api/glossary` drops a v2 form
  that is in the book's names (Max 2026-11-22). Trial of prompts on two books: `scripts/gloss-try/` (on branch
  claude/project-thread-slufc6; run on Max's Mac).
  word.js asks NAME only for a capital mid-sentence (`midName`): «Кармазини!» at a sentence's start is a word.
  Trial prompts and answers: project files `chytai-gloss-try/run/` (`ahead.js`: Sonnet vs Haiku, one word 1.1–1.8 s).
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

## BookFlow in «Де взяти» (`web/bookflow.js`)

- BookFlow (bookflow.com.ua) lends readers' books for one price per book (Max 2026-11-17). Vlad made a public export,
  no key: `https://api.bookflow.com.ua/api/books/export/` (`prices.one_time`, `subscription_month`; per book `isbn`,
  `title`, `authors`, `url`, `available`). The jobs process reads it hourly, matches by ISBN, else by title head and
  the same author (`match`), and keeps only meta `bookflow:links` (book id -> [url, free], ~130 KB, rewritten).
- The book page's row «Напрокат» (pages.js `where`, last, above the libraries): «є вільна» / «зараз усі в читачів»,
  «89 ₴ за книжку». Clicks: taps `where` / `out:bookflow.com.ua`. Run now: /admin/jobs, job `bookflow`.

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
  A pick names one edition; `authorStart` widens it to the original and its translations (`p.ids`), so hiding or
  re-pairing an edition doesn't drop the book from the block.

## A reader's months and «Схожий смак» (Max 2026-11-24, canvas AU9dirwZUmhH8iYbCmkPjM)

- `entries.read_on` (`readOn`, `YYYY-MM-DD`): Goodreads' «Date Read» on import, today (Kyiv) when a book is newly marked
  read in the current year (`setEntry`); `writeEntry` drops it when it doesn't fall in the entry's `year`. Old rows got
  `updated`'s day once (db.js), exact for Goodreads imports, near for books marked on the site.
- `/@<nick>/stats` (`statsPage` in pages.js, after Max's maxua.com/books): year tabs, 12 month columns (only when 80%+
  of the year has a month, else just covers), each month's covers, the year's numbers and genres, then «За всі роки»,
  «Жанри» (`genreRows`), «Оцінки» (`ratingCols`, halves), and last «Жанри по роках» (Max: all years, so at the very
  bottom; `genreStream`: an SVG streamgraph by genre family, `FAMILIES` / `--g-<key>` colours in style.css, no script). Linked from the shelf («статистика»). Open
  to guests, noindex. Russian editions have no genres by rule: they fall in «Без жанру».
- Shelf quick picks (`.shelf-picks`, app.js `filters.pick`): «4,5+», «Українською», the reader's 3 biggest families;
  rows carry `data-fam` and `data-uk`.
- /community «Схожий смак» (`similarReaders` in server.js): up to 3 readers with the most read books in common (a work
  and its translations count as one; 3+, the viewer needs 5+ read; not those they follow), covers of books both rated
  4+. At the top on a phone, in the side column on a computer. ~0.2 s on the test DB; precompute it if readers grow.

## Standing rules (Max)

- No reviews in Russian (Max 2026-11-23): others see a reader's note through `store.publicNote` / `publicEntry`
  (Russian paragraphs out; a Russian note keeps only its Ukrainian or English ones); the writer sees it whole on their
  own shelf. A new place that shows someone's note to others goes through it.
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
- Reader «Пояснити» / «Запитати» model (Max, 2026-11-17): «Модель для пояснень» in the reader's settings, only the
  owner sees it, his choice is every reader's (`state.shared.model`). `claude-opus-5-5-fast` = Opus 5.5 in fast mode
  (src/ai.js `speed: "fast"`, 2× price, normal speed on a 429), counted as its own model in costs; fast for Max only,
  other readers get plain Opus 5.5 (the explain route drops `-fast` for them). «Переклад» stays
  on `translateModel` (Sonnet). Compare models on real requests: kept cards are `items` kind `chats` on the reader's
  /agent/sql; the container has no key, so run the script on Max's Mac (Desktop Commander, nvm node 22, key from
  ~/Projects/chytai/.env, `.tmp/model-bench`). 2026-11-17, 12 requests, first word / whole: Opus low 4.5 / 9.8 s,
  Opus fast 1.1 / 3.3 s, Sonnet 0.8 / 5.5 s; Haiku got facts wrong.
- Reader: an explanation put away (its card closed) is a two-line block under the paragraph its passage ends in; a
  tap opens the whole text there and closes it (Max 2026-11-17, like the old articles' inline block; the dotted
  underline before it took every tap on the passage, so «Словничок» words and a selection for a note did nothing).
  Nothing is drawn over the passage. The block is CSS only (`askBlocks` / `askTap` / `askCss` in renderer.js: the
  paragraph's `data-ask` + `::after`): never insert nodes into the book's DOM, every CFI (places, notes, explanations)
  would shift; epub.js `ignoreClass` is too buggy for that. After a layout change call `redrawMarks()`.
- Reader: a book whose own table of contents has one entry («Start», «Початок») gets one from its headings (`ownToc` in
  renderer.js, Max 2026-11-22, variant A of bug report №28): the top level of h1–h3 in each spine file; a number →
  «Розділ N», «***» → «Частина N», capitals → sentence case; short files with only a number and a link (translator's
  notes) → one «Примітки». It replaces `book.navigation.toc`, so the running head and «стор.» follow. `stripScripts`
  keeps `<base>`: epub.js sets it, and every link between files (footnotes) resolves by it (№28).
- Reader: words with a stress mark (U+0301, the free shelf's classics) get soft hyphens (`shyStressed` in renderer.js,
  Max 2026-11-20: a hole in a justified line), since browsers don't hyphenate them; where = the device's own
  hyphenation of the bare word (`breaksOf`). The patched `ePub.CFI` `pathTo` / `toRange` leave those soft hyphens out,
  so CFIs stay as before; text taken from the page drops U+00AD (context.js `clean`, gloss.js `key`). Words of a
  Ukrainian book typed with a Latin look-alike («прозрiнь», «кóпнувши») or an NFD «й» get them too (`plainWord`, Max
  2026-11-24, bot №46: Android's hyphenation gives up on them), only in a chapter with no soft hyphen of its own,
  which then carries `data-shy-odd` on <html> for `shyAt`.
- Reader: how the text looks (theme, font, sizes, spacing, margins, column, page turns) is kept per device
  (`LOOK_KEYS` in `src/renderer/web-bridge.js`); the account's copy only starts a new device. A new look setting
  goes into that list.
- Reader: a reader's own cover (`PUT /api/cover`, the page cuts it to 900 px JPEG; `DELETE` = the file's again) is set in
  «Назва, автор, обкладинка». No letter to Max for it (Max, 2026-11-15).
  «Знайти обкладинку» in the book menu (Max 2026-11-22, variant A; own books only, and only when the book's cover
  picture fails, bug report №30): `GET /api/cover/find?title&author`
  asks the site's `/api/reader-covers` (catalog work + editions, book.ua, Open Library, Google Books; same author;
  12; a day's cache) for signed `/t/` copies (`thumb` 240, `full` 480 px); a tap = `POST /api/cover/pick {path, url}`,
  the reader server fetches only `${WEB_URL}/t/…`. Dialog `#cover-dialog` (home.js `showCovers`), taps `cover-pick`,
  `cover-file`, `cover-reset`.
- Reader «Додати книжку» (Max 2026-11-22, variant C): the empty shelf's buttons (`r-add-two` in `addStartHtml`), one line,
  «Як це працює»; no drop box (a file dropped on the page is added). «Де ще шукаємо»: a store whose purchases download as files gets a row named by the store
  with «як додати» steps (`shopRow` in src/renderer/home.js: Yakaboo, Book.ua). No store has an API; we never sign
  in to a reader's store account.
  The app is about one's own books and explanations (Max 2026-11-17, before the store release): «Вільна полиця» is
  one row there (opens the shelf under the list), no «Каталог Chytai» row, no «Клуб Chytai» link in the panel; the
  catalog search for paper books and «Про книжку» stay.
- Android's system font size (Max 2026-11-22, bug №24, variant A): the shell sets `textZoom={100}` (the WebView grew
  only the letters: icons, covers and sheets stayed, text overflowed) and injects `app/zoom.js`, which rewrites the
  page's viewport meta to `width = screen / fontScale` with that scale (0.85–1.5): the whole page zooms, as in Chrome
  on Android (411 px at ×1.3 = 316 px; `window.__chytaiZoom`). A page in the app needs a viewport meta. So the reader
  must hold at 274 px: `@media (max-width: 340px)` at the end of style.css, the phone panel `min(318px, 100vw − 56px)`.
  Try: Playwright `isMobile` + `addInitScript(zoomScript(1.5))` (top frame); the old text-only zoom is emulated by
  `html { text-size-adjust: 130% }` in every frame.
- App shell (app/App.js): `menuItems={[]}` hides the system Copy / Paste bar over selections (the reader has its own
  toolbar); on Android it comes back while a text field has the focus (`FIELD_REPORTER`), else nothing could be pasted
  (a reader's sign-in code, 2026-11-17). No overscroll stretch: `overScrollMode="never"` there and
  `overscroll-behavior: none` on the page and the book's scroller. Android's back (also the edge swipe that opens the panel, bug №20; it reaches the page first as our own edge swipe, which a `touchcancel` undoes, №25) asks the page's `window.__chytaiBack()` (home.js):
  it closes what is open, from a book opens the panel over one's books; `false` = the app goes to the background.
  An App.js change reaches iPhones over the air and Android by a new APK.
- Reader's purpose (Max 2026-11-18): «Level up your reading», reading books that feel too hard. Not in the reader's UI
  any more: minutes («Цей тиждень»: «хвилини не про це»), printing a book, «Дати почитати» links, OPDS in settings
  (the server keeps `/api/opds` and `/api/shares` for links already made). An empty shelf shows `startHtml()` (home.js); its «Як це працює» opens
  page `how` (`howHtml`, one phone screen about paper books, photo `src/renderer/how-paper.jpg`).
  The old hidden screens (Пошук, Клуб, Бібліотека with folders and filters, all notes, «Хочу прочитати», the tab bar, the
  API key field) were taken out of the page on 2026-11-18; library-view.js keeps only the list, adding books
  (`Library.add`) and «Назва, автор, обкладинка». Their server routes (`/api/wish`, `/api/club`, `/api/notes/all`) stay.
- Reader «Статистика» (Max 2026-11-19; not «Мій шлях», «пафосно»): panel item (`r-pnav-journey`, page `journey` in
  home.js `journeyHtml`), `GET /api/journey` (explanations from `days[d].users`, per book from `store.items.tally`,
  finished from `u.finished`, minutes from `days[d].readBooks[acct]` since 2026-11-04). No streaks or goals.
  A month = every book read in it (a minute in `readBooks`, a note or explanation, finished), «N книг · M прочитано»
  (Max: «читав не означає прочитано»; no ticks on covers), covers the last opened first. Top: «N книг з <first day>», tiles прочитано / пояснень /
  нотаток / хвилин читання (Max 2026-11-20 by the bot, in place of «слів зі словничка»; no «читаю»); «N хв» beside
  the explanations in each month and book.
- Reader «Scratchpad» (Max 2026-11-23, variant A of canvas 5vFceFdJnh3oNewFR6TgT4): an inbox for reading, as in GTD.
  Off the panel since 2026-11-24 (Max: «приберемо поки», «Хочу прочитати» in its place); the page, its routes and
  readers' entries stay, so it can come back by its panel button. A panel page under «Статистика» (`r-pnav-scratch`, page `scratch`,
  `src/renderer/scratch.js`, count of new ones beside it): a field with the mic and a photo (shrunk to 1200 px), then
  «Нові» and «Розібрані». Each entry is read by Opus once (`server/scratch.js`, `SYSTEM`, json_schema, effort low): kind
  (topic / era / author / book / unclear), title, a few sentences of background, 3–5 books (first = where to start; a
  Ukrainian title only when such an edition exists; no Russian), guesses when unclear; then `catalogFind` (the site's
  `/api/reader-find`) gives each book its page and cover by title and surname a letter apart. «Уточнити» (a card like the top form) / a guess =
  `POST /api/scratch/:id/ask`, asked again with the words. No «Готово» / «Не цікаво» under an entry (Max 2026-11-23, bot №45). «Додати» = a paper book (`/api/paper`), a tap = the cover's
  card (`Paper.card`). Kept in `accounts/<id>/scratch.json` (500, sorted ones dropped first) and
  `accounts/<id>/scratch/<entry>.jpg` (100 photos); private, no letter to Max. Caps: 40 a reader a day, 400 for all
  (Telegram once), Max none; stats day `scratch`. An entry left `wait` by a deploy is asked again when the page lists it.
  Locally without a key: a fake SDK (`node -r mock.js`) and WEB_URL to a proxy that passes only GET /api/reader-find.
- Reader «Хочу прочитати» (Max 2026-11-24, in Scratchpad's place; panel after «Мої книжки», `r-pnav-want`, page `want`,
  `src/renderer/want.js`): the books on the reader's «Хочу прочитати» shelf on the site, each with where to get it.
  `GET /api/want` (signed in; 60 s cache, `?again`) → the site's `POST /api/reader-want {id, key}` (`readerKeyOk`):
  per book `mine` (own file, `readerFileFor`), `free` (free shelf, `freeFileFor`), `online` (openLinks, public-domain
  sources of `freeBooks`, Слухай), `get` (per format the 2 cheapest in stock, no adapted), `rent` (BookFlow). A shelf of
  covers (Max's design B, canvas C4zbe7sBdsPD1z41gChjEj): «Можна читати зараз» / «Купити або взяти» / «Поки ніде»
  (folded), under a cover «Читати» (opens it) or the lowest price; a tap = `Paper.card(b, {top, foot, noAdd})` with
  «Читати», «Де взяти» and the book's page. The other language too (Max 2026-11-24: «іноді я свідомо хочу читати в
  оригіналі»): `abroad` (the book page's Amazon, Google Books, Gutenberg, Open Library links) and `other`, up to 3
  `twins` (original / Ukrainian translation, never Russian) with their own `get`, `rent`, `abroad`; a translation
  with no original in the catalog gets an Amazon search by `origTitle` + `origAuthor`. The tile's price may be the
  other version's («від 299 ₴, укр.»).
- Reader «Прочитано» at a book's end (Max 2026-11-20, bot report №7): the last page (`bookEnd` in renderer.js: epub.js
  `atEnd` or 100% on pages, the last chapter's bottom in scroll mode; a PDF's last page) marks the book finished in the
  reader only (`POST /api/library/finished` with `auto`; a book finished before is left alone) and asks the site with
  `peek` (`/api/reader-read`: href, title, author, status, rating, note; nothing changes). When the catalog has the book,
  a small card like «Перед главою» (`#done-card`); a tap on it or a turn past the last page (`doneNext`, wrapped into
  `rendition.next`) opens a whole screen (`#done`: cover, the site's stars, a few words). The home menu's «Позначити
  прочитаною» opens the same screen (`window.showDone`, Max 2026-11-20) and no longer marks the site by itself. Only «Опублікувати» changes the
  site (Max: «поки форму не заповнив, на сайті ми нічого не помічаємо»): `POST /api/library/review` → `/api/reader-read`
  with `rating` / `note` = «Прочитано» with them, the same entry as /me/book's form, public. New words from a reader (not
  Max) mail + Telegram Max. Guests get nothing. «Функції»: `done-shown`, `done-open`, `act-done-send`.
- Reader's new version (Max 2026-11-20, «щоб не перезапускати навмання»): sw.js installs it after a deploy and it still
  takes over by itself when the page is hidden; while it waits (`body.update-ready`), Мої книжки shows a filled «● Є нова
  версія» button in place of the phone header's «+» and at the top of the computer's panel (`.r-upd`, Max's variant A,
  like Chrome: seen at once, never at a page's bottom or only in settings); a tap reloads on the new version. The
  settings keep «Версія від … · Оновити» (`#set-update`: asks the server, waits for the install, reloads). Both on `window.chytaiUpdate` in web-bridge.js (`ready`, `apply`, `check`, `version`); sw.js answers
  the message «version» with its hash and `BUILT` (the first start of that hash, `DATA_DIR/sw-versions.json`, so a
  restart serves the same sw.js). Which version a device runs: the page posts `/api/sw-state` 20 s after a load (and sw.js when an install fails); the reader's Fly log has «sw: owner iphone-app now=<hash> [waiting=… | FAILED …]». Try locally: change a file in src/renderer, restart the reader, `reg.update()`.
- Reader: the app's own UI can't be selected (`body` has `user-select: none`, end of `src/renderer/style.css`). Text a
  reader may copy (a new note, answer or field) goes into the list of selectable classes there.
