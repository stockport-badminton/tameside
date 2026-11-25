# Push notifications

Results and match reminders, pushed to phones and computers that opted in at
`/notifications`. Ported 24 Nov 2026 from Stockport (league-site `1a5f9d2`, their
`docs/claude/push.md`), which ported it from the Hyde club site. The code is kept close to
theirs on purpose, so their fixes apply here; the differences are listed below.

## What gets sent

| Kind | When | Who | Built by |
|---|---|---|---|
| Result | when a result is published (`POST /scorecard-beta`) | followers of either team | `resultNotification` |
| "Tomorrow" reminder | 18:00 UK, the evening before | followers of either team | `reminderNotification` |
| "Tonight" reminder | 17:00 UK, on the day | followers of either team | `reminderNotification` |

A reminder covers fixtures with `status = 'outstanding'` on that UK date, so rearranged,
rearranging and conceded fixtures send nothing. The body is the home team's `starttime`, its
venue and the division, leaving out whatever is null. The tap opens the event page
(`eventPath`). A conceded fixture (`/admin/fixture/:id/concede`) sends no result.

**Lewis Shield ties are included, and say "Lewis Shield"** instead of the home team's
division. Each Lewis fixture row is a real match on its date (confirmed 24 Nov 2026), and none
duplicates a league row for the same teams and day, so a tie gets one reminder.

## Pieces

- `migrations/push.sql`: `push_subscription` (one row per browser, id = sha256 of the
  endpoint, `teams INTEGER[]` of at least one, `types TEXT[]` with empty = both) and
  `push_send` (the ledger).
- `models/push.js`: the SQL. Every function takes an optional trailing transaction.
- `utils/push/`: `subscription.js` (validation, verbatim), `send.js` (fan-out with
  `web-push`; 404/410 deletes the row), `notifications.js` (the wording, the UK date),
  `index.js` (`notifyResult`, `runReminders`, `sendTest`, `pushNote`).
- `controllers/pushController.js`, routes in `app.js`: `/notifications`,
  `/api/push/subscribe` (POST, DELETE), `/api/push/subscription` (POST lookup),
  `/admin/push/reminders` (cron), `/admin/push` + `/admin/push/test` (superadmin).
- `views/notifications.ejs` + `static/js/push-panel.js` (verbatim): the opt-in page. It reads
  what this browser is subscribed to from the server, not from localStorage.
- `views/sw.ejs`: the `push` and `notificationclick` handlers. `rootfiles/badge-96.png` is the
  monochrome status-bar badge (a bell, Stockport's file).
- `views/notifications-banner.ejs`: the offer at the top of the fixtures & results pages
  (`/results/…`, not the grid). Hidden on a device already subscribed, and once dismissed
  (localStorage).
- `views/notifications-video.ejs` + `static/video/notifications-mobile.{mp4,jpg}`: the
  one-minute walkthrough, opened by any `[data-notifications-video]` link. Our own recording
  of this site; re-record with `tools/demo-video/record-notifications.js` (its README).
- Linked from the Fixtures & Results menu and the manifest's shortcuts.

## Rules

- **Every send is claimed in `push_send` before it is made** (`INSERT … ON CONFLICT DO
  NOTHING`). Keys are `result-<fixtureId>`, `reminders-<UK date>-<tonight|tomorrow>` and
  `test-<ms>`. A republished or corrected result notifies nobody a second time, and a
  scheduler retry or overlapping run sends no duplicate reminders. To send one again, delete
  its row.
- **No `VAPID_PRIVATE_KEY` means nothing is sent.** That is the kill switch, and it is what
  every test and local run has. `notifyResult` checks it *before* claiming, so a result
  published while the key is missing is not marked sent.
- **Results are sent inside the publish request and awaited before the page renders**, in
  parallel with the "website updated" email. Cloud Run throttles the CPU once the response is
  sent, so fire-and-forget is unreliable; a fan-out takes about a second. It is not queued
  like the Meta posts, which take tens of seconds. **It never fails the publish**: an error is
  logged and sent to Sentry, and the confirmation page says so (`pushNote`).
- **Topics are team ids.** A fixture has both, so a club derby needs no special case. The
  picker offers teams in a division (`followableTeams`, 18 in Nov 2026); a subscription to a
  team that later leaves the league stays and receives nothing.
- **Subscription API abuse**: endpoints must be on a known push service (so we can't be made
  to POST anywhere), teams are checked against `followableTeams`, and a cross-site
  `Sec-Fetch-Site` or foreign `Origin` is refused (compared with `SITE_URL`, never the Host
  header). No `spamGate`: there is no free text.
- **Replacing the VAPID key pair orphans every subscription.** Each browser subscribed with the
  old public key, and the push services will refuse sends signed with the new one.

## Different from Stockport

- **No rate limit on `/api/push/*`.** Stockport has `pushLimiter` (60 per 15 minutes); this
  site has no rate limiting at all (CLAUDE.md, Spam and abuse controls). The worst case is
  junk rows with real-looking push-service endpoints, which the first send deletes (404/410).
- **The scheduler presents `?t=`**, like our other jobs (`requireCronCaller` has no header
  option), and a refusal is a 404, not their 403.
- **Lewis Shield ties are reminded about**; Stockport leaves out Messer, which has no dates.
- **The walkthrough video is recorded from production data**, anonymously and writing nothing
  (their `4d6cf0d` records from a seeded local database we don't have), with Hyde A and its
  real fixtures. Theirs links "every club page has a bell"; ours doesn't say that, since we
  have no bells. The service worker leaves Range requests alone so the video isn't served
  through its cache.
- Bootstrap 5 markup; no club-page bell links (our `/info/clubs` rows carry no team ids).

## Production setup

1. `npx web-push generate-vapid-keys`; set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` on
   Cloud Run, plus `PUSH_CRON_TOKEN`, with `--update-env-vars` (never `--set-env-vars`).
2. `node tools/run-migration.js push.sql --commit`, before deploying. Without the tables the
   page still renders (it reads only `team`), but every subscribe, lookup and `/admin/push`
   fails, and a publish logs a push error (the result itself is unaffected).
3. Two Cloud Scheduler jobs, `Europe/London`, POST, no retries, to the **Cloud Run URL**
   (Firebase gives up at 60s and rewrites Host; the scheduler needs neither):
   - `tbl-push-tonight`, `0 17 * * *`, `/admin/push/reminders?when=tonight&t=<PUSH_CRON_TOKEN>`
   - `tbl-push-tomorrow`, `0 18 * * *`, `/admin/push/reminders?when=tomorrow&t=<PUSH_CRON_TOKEN>`

   `gcloud` needs `--account=tameside.badders.results@gmail.com` (or config
   `tameside-badminton`). `gcloud scheduler jobs create http` creates the job ENABLED.

## Testing

- `test/push.test.js` (validation, wording, fan-out, at-most-once),
  `test/integration/push.test.js` (routes and gates), `test/integration/publish-push.test.js`
  (the publish path sends, waits, and survives a failure).
- **`node tools/rehearse-push.js [YYYY-MM-DD]`** applies the migration and runs every model
  query against production in a transaction that always rolls back, printing the reminders a
  day would send. Run it after touching `models/push.js`.
- By hand: `/admin/push` → "To this browser" after turning notifications on at
  `/notifications`. As superadmin, `POST /admin/push/reminders?when=tomorrow&date=YYYY-MM-DD&dry=1`
  lists what a run would send and sends nothing. The scheduler's token cannot use `date` or `dry`.
- Push needs a secure context and the service worker: production, or `localhost` with
  `SW_ENABLE=true` (the worker is off locally by default) and the VAPID keys in `.env`.
  **On iPhone and iPad it works only from the Home Screen app (iOS 16.4+)**; the page says so.
