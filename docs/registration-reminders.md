# Chasing clubs for their registration forms

Every club has to register its players with the league before its first fixture of the
season. This is the machinery for chasing that: a daily digest to the results secretary,
and a worklist that sends a club its pre-filled form in one click.

- **`GET /admin/registration-reminders`** — the worklist (superadmin).
- **`GET /tasks/registration-digest?t=<token>`** — the daily digest, for Cloud Scheduler.
- **`GET /forms/team-registration/:club/docx`** — the pre-filled Word form (`secured`).

## Why the status is keyed by season

`club_registration` has one row per `(season, club)`, and rows are created lazily —
nothing pre-populates the table. Absence means "nothing received, nothing chased".

That is the whole design, and it is what makes the annual reset free: **a new season
simply has no rows.** There is nothing to clear in July, no cron to remember, and last
season's record is still there to look back at. A `received` boolean on `club` would have
needed exactly the annual wipe nobody would remember to run.

> `club.registrations` already exists as a boolean on the `club` table, carries five stale
> `true`s from some earlier attempt at this, and is read by nothing in either league's
> codebase. Leave it alone — it is not this feature's state, and pressing it into service
> would reintroduce the reset problem.

## Setting up the daily digest

The endpoint is **not** `secured`: Cloud Scheduler cannot log in through Auth0. It carries
a shared secret in the query string and **404s** — not 401s — without one, so an
unconfigured or probed endpoint gives nothing away. Same shape as `POST /webhooks/mailjet`.

1. Pick a secret and set it on the service:

```bash
gcloud run services update tameside-site \
  --region=europe-west2 \
  --update-env-vars=REGISTRATION_DIGEST_TOKEN="$(openssl rand -hex 24)"
```

2. Point a scheduler job at it. 07:00 Europe/London, every day:

```bash
gcloud scheduler jobs create http registration-digest \
  --location=europe-west2 \
  --schedule="0 7 * * *" \
  --time-zone="Europe/London" \
  --uri="https://tameside-badminton.co.uk/tasks/registration-digest?t=<the same token>" \
  --http-method=GET
```

Use the custom domain, not the `run.app` hostname — the digest's own links come from
`SITE_URL` either way, but keeping one address in play is what stops a `run.app` URL being
copied out of a job definition later. See **Absolute URLs** in `CLAUDE.md`.

3. Check it:

```bash
curl -s "https://tameside-badminton.co.uk/tasks/registration-digest?t=<token>" | jq
```

It answers with what it decided, e.g.
`{"sent":true,"season":"20262027","dueSoon":8,"chased":0,"outstanding":12,"received":0,"total":12}`.

### Nothing is sent on a quiet day

If nothing is due within three days and nothing outstanding has already been chased, **no
email goes out** — ten months of "nothing to do" is how a daily report becomes a filter
rule. The trade is that a quiet day looks the same as a broken scheduler from the inbox,
which is why the run still answers with `{"sent":false,"reason":…}` for anyone who curls
it, and why Cloud Scheduler's own job history is worth a look if it has been silent a
suspiciously long time.

## Environment variables

| Variable | Effect |
|---|---|
| `REGISTRATION_DIGEST_TOKEN` | The shared secret. **Unset means the route 404s**, i.e. the digest is inert. |
| `REGISTRATION_DIGEST_TO` | Who the digest goes to. Defaults to the results mailbox. |

## What a chase actually sends

The club's **club secretary and match secretary**. 10 of the league's 14 officers hold
both flags, so the role label is built from both — a plain `CASE WHEN "clubSecretary"
THEN … ELSE …` would label that person "club secretary" and silently drop the other half.
Recipients are separately de-duplicated by address, for the case of two player rows
sharing one. The results mailbox is Bcc'd, so there is a record of what a club was sent.

Attached is the club's registration form as a `.docx`, **built from the live roster at send
time** by `utils/registrationDocx.js`. The point of the attachment is that it shows the
club what the league currently believes, so a cached copy would defeat it.

The chase is recorded **only after Mailjet accepts the message**. Ticking first would leave
a club looking chased when nothing reached it — worse than looking un-chased, because the
digest would then stop reporting it as due.

`chase_count` increments rather than being set, so "chased three times and still nothing"
is visible on the worklist.

## The form is a format contract

`utils/registrationDocx.js` writes the document; `utils/registrationDoc.js` reads one back
when a club returns it, and `/admin/team-registrations` diffs it. So the table shape here
is what the import screen parses:

- the **letter column is the data model** — `A`/`B`/`C` means nominated for that team, `R`
  means reserve;
- **row order within a team block IS the rank order** — there is no rank column;
- a reserve's team comes from the **block heading**, nowhere else.

Verified against production 2026-09-05: a freshly generated `.docx` for Hyde, Mellor and
G.H.A.P parses with **zero warnings**, and the attachment lifted out of a real (intercepted)
chase email for Hyde re-parses to 43 entries — 21 nominated across A/B/C and 22 reserves —
also with zero warnings.

> The `.docx` and the PDF encode reserves **differently** — the PDF puts the player's
> current team letter in that column and reserve-ness comes from which table the row is in.
> See **Team Registration Forms** in `CLAUDE.md`.

## The document is no longer written to disk

It used to be built as a side effect of rendering `/manage-players/club-:club` and written
to `static/docs/<name>.docx` with `fs.writeFileSync`. Three consequences:

- the page's Download link **404'd unless that page had already been served on that
  container** — Cloud Run runs up to four, and scales to zero;
- the file was named after the first **team** (`GHAP`) while the club is `G.H.A.P`, so for
  two clubs the link and the file disagreed;
- generated files kept turning up as untracked changes in git.

It is generated on demand now, and the seven committed `static/docs/*.docx` files are dead
weight left in place only because nothing else has been checked for links to them.
