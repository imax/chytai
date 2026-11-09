# Chytai: how to work here

Chytai is a Ukrainian reading platform: the site https://chytai.org.ua (`web/`, Fly app `chytai-web`) and the reader
https://app.chytai.org.ua (`server/` + `src/`, Fly app `chytai`). `app/` is the iOS WebView shell, `mac/` the Electron
app. The owner is Max; he writes Ukrainian, and every word a reader sees is Ukrainian, short, one plain clause.
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

## Feature flags (`web/flags.js`)

Something visible and new goes live behind a flag set to `owner` (Max only) or `test` (Max and the test accounts),
so Max sees it on the real site. He switches it to everyone on `/admin/jobs` (block «Прапорці»), with no deploy.

- Add the flag to `KNOWN` in `web/flags.js` with a few Ukrainian words, and check it with `flags.on("name", req.user)`.
- A thread may set `off` / `owner` / `test`:
  `curl -s https://chytai.org.ua/agent/flags -H "$H" -H 'content-type: application/json' -d '{"name":"x","who":"owner"}'`.
  `all` is only Max's.
- When a flag has been on for everyone for a while, take it out of the code.

## Standing rules (Max)

- Never mass-regenerate AI content without Max's OK (daily auto cap 150). A new AI pass: trial of 200 on `/admin/*-trial` first.
- A new kind of thing readers write (a list, a comment, a hand-added book) notifies Max (e-mail and Telegram, with the reader's `/@username`).
- First-party analytics only, no third-party trackers. Log what helps product decisions.
- Every cache or stored file cleans itself up; disk never grows without bound.
- Think about performance and scale for every change; say when something is not optimal.
- Reuse existing designs and components; don't invent a new UI per page.
- A product decision goes into `docs/decisions.md`; a reader-facing feature gets a one-line entry in `web/updates.md` («Що нового»).
- Test on production only under a test account, never Max's. No mail to test domains.
