# Posting to Facebook and Instagram directly

Ported from the Stockport league site, 15 Sep 2026. Their handover note —
`~/league-site/docs/handover/tameside-social-posting.md` — records the measurements this is
built on, and the fuller record is in that repo's `CLAUDE.md` under *Posting to Meta
directly: what was measured*.

Everything here was measured against the live Graph API, not read from documentation —
**including one of the handover's own conclusions, which did not reproduce.** See §2.

---

## The three things to know before touching any of it

### 1. Tameside has its OWN Instagram account now — the handover's premise is gone

The handover states as a hard constraint that Meta refused a second Instagram account, so
both leagues must post to `stockport.badders.results` (`17841409056774880`). **That stopped
being true on 15 Sep 2026**, when `tameside.badminton` (`17841424897459443`) was created and
linked to the Tameside Page in Business Manager.

Verified the same day: the **existing** `META_TAMESIDE_PAGE_TOKEN` reaches the new account
with no re-minting — it resolves the username, reads `content_publishing_limit`, and creates
media containers against it.

| Page | Instagram account |
|---|---|
| Tameside Badminton League (`413441425183665`) | `tameside.badminton` — `17841424897459443` |
| Stockport & District (`101950371354925`) | `stockport.badders.results` — `17841409056774880` |

**What that changes, and what it does not:**

- **Results become a clean switch.** Make's Instagram module is unfiltered and has been
  posting Tameside results to the *Stockport-branded* account. Setting
  `SOCIAL_POST_DIRECT=true` stops our webhook, so that route stops firing, and our results go
  to Tameside's own account instead. No double-post, and it fixes the branding oddity.
- **The atomic cutover is still required — but for FACEBOOK, not Instagram.** Make's route 3
  posts Tameside's tables to the same Tameside *Page* this does, and it is schedule-triggered,
  so it fires every Saturday whatever either site does. Two live posters means two posts.
  Instagram is no longer part of that risk: Make posts to the Stockport account, we post to
  Tameside's.
- Tameside's tables have still never been on Instagram, so the weekly post remains a new
  thing rather than a reproduction — but it is now on Tameside's own account, which was the
  open question and is now answered.

**Leaving `META_IG_USER_ID` unset is still the supported, one-variable way to stay on
Facebook only.**

### 2. Meta fetches the URL itself, later — and the format claim needs correcting

Meta fetches `image_url` **from its own servers, minutes later**, so the URL must be public,
unauthenticated and still serving when it gets round to it. Anything behind `secured`, and
anything written to a container's local disk, cannot work.

`GET /league-table-image/:division.jpg` and `GET /resultImage/…jpg` render per request and
return bytes. Do not try to make the file writing under `static/images/generated/` reliable
— that is a container's own disk, it belongs to one instance and does not outlive it.

#### The JPEG-only claim did not reproduce

The Stockport handover gives **two** causes for its weekly Instagram carousel never working:
the images 404'd, and they were PNG where "Instagram accepts JPEG and nothing else".

Re-measured against v21.0 with Tameside's own token, 15 Sep 2026:

| Container created | Result |
|---|---|
| PNG child (`is_carousel_item`) | accepted, `status_code: FINISHED` |
| PNG **carousel parent** over two PNG children | accepted, `FINISHED` |
| **WebP** child, as a control | accepted, `FINISHED` |

`FINISHED` is Meta's own "Media has been uploaded and it is ready to be published".

So the second cause is not established, and — more usefully — **`validateImages()` cannot
have proved it, because that function IS the container step and it does not discriminate on
format at all.** The first cause is measured, independent and entirely sufficient: those
URLs 404'd.

This is the handover's own rule turned back on it: *a negative observation needs its other
causes ruled out; a positive one does not.* "Instagram refused these" is the negative, and
the 404 was never ruled out as its cause. "Meta accepted a PNG" is the positive.

**What follows practically:**

- The `.jpg` rule in `assertPublishableImage` stays. It enforces Meta's *documentation*,
  locally and for free, and `media_publish` is the one step that cannot be tested without
  publishing something. It is no longer described as the proven cause of anything.
- **A dry run's `ok: true` means "Meta could fetch these", not "Instagram will publish
  these".** It catches the faults that actually recur — a 404, a private URL, an unreachable
  host — and it is worth running for those. Treating it as a format check would make it
  another rejection that looks like an acceptance.
- Worth sending back to Stockport. Their `validateImages` carries the same belief.

### 3. A switch whose halves live in two places must fail loudly

`SOCIAL_POST_DIRECT` goes in the Cloud Run service config; the credentials live in `.env`,
which is gitignored and never deployed. Setting the flag without copying the credentials
across produced, on the Stockport side, a service that took the direct path, found no
targets, **posted nowhere, and reported success** — an empty target list produces neither a
post nor a failure.

Both entry points throw instead. **There is deliberately no fallback to Make.com**: a
fallback hides the misconfiguration until it bites somewhere less convenient.

---

## Credentials

| Thing | Value |
|---|---|
| Facebook page | `413441425183665` — *Tameside Badminton League* |
| Page token | `META_TAMESIDE_PAGE_TOKEN`, already minted; copy it from Stockport's `.env` |
| Instagram | `17841424897459443` — `tameside.badminton`, Tameside's own (see above) |
| Meta app | *Badminton Results App*, live. Nothing further needed from Meta |

**One token covers both targets.** Measured 15 Sep 2026: `META_TAMESIDE_PAGE_TOKEN` resolves
the Tameside Page *and* the shared Instagram account, and its scopes include
`instagram_content_publish`. The Stockport copy pairs Instagram with its own page token;
copying that split here would leave Instagram unconfigured whenever `META_PAGE_TOKEN`
happened to be absent.

**A Page access token does not expire.** `debug_token` reports `type: PAGE`,
`expires_at: 0`. It dies only if the granting account changes its Facebook password or loses
its role on the Page — and then everything fails at once and needs a person with a browser.
Meta reports that as code `190`, and `describeFailure` says so in English rather than
surfacing `OAuthException`, which sends you hunting a code bug that is not there.

### Environment variables

```
META_TAMESIDE_PAGE_ID        # 413441425183665
META_TAMESIDE_PAGE_TOKEN     # the Page token
META_IG_USER_ID              # 17841424897459443 (tameside.badminton) — UNSET means Facebook only
SOCIAL_POST_DIRECT           # 'true' posts results from here instead of via Make.com
SOCIAL_WEEKLY_TABLES_TOKEN   # shared secret for the weekly scheduler job; unset = inert.
                             # Set on the service 15 Sep 2026; it also lives in the
                             # scheduler job's URI, so rotating it means updating both.
META_GRAPH_VERSION           # optional, defaults to v21.0
META_GRAPH_ORIGIN            # test seam only — never set this in production
```

Set them on the **service**, not just in `.env`. **Verify by comparing hashes, not by eye**
— a malformed `gcloud --update-env-vars` delimiter can set one variable of seven and report
success. That happened on the Stockport side.

---

## The order to do it in

> **All six steps were completed on 15 Sep 2026 and Make.com is fully retired.** Every
> scenario in the `My Lab` account is now inactive, including `League Tables` (`2235321`) and
> `Post Results to Socials` (`732549`). Both leagues' weekly jobs are ENABLED and first fire
> Sat 19 Sep — Tameside 12:00, Stockport 13:00 (Europe/London). The sequence is kept below
> because it records why things are wired this way, and because the Make account can now be
> downgraded: its free tier allows two active scenarios and nothing is active at all.

The agreed plan was to **leave both Make scenarios alone until Tameside was across too**, so
that retiring them was a disable rather than surgery. Each step is safe to stop after.

1. **Serve table images on demand, as JPEG.** Done — `GET /league-table-image/:division`.
   Worth having on its own merits, and everything downstream needs it. Nothing in Make
   changes: Tameside's tables go to Facebook as *bytes*.
2. **Wire the credentials** into the service config.
3. **Dry run against Meta.** `POST /admin/social/weekly-tables?dry=1`, or the button on
   `/admin/social/weekly-tables`. It creates unpublished Instagram containers to ask Meta
   whether it would accept each image, then abandons them; they expire in 24 hours and
   nothing is ever visible. This is where a wrong URL or a stray PNG shows up harmlessly.
   **It needs the images to be live in production**, so it comes after a deploy, not before.
4. **Results: `SOCIAL_POST_DIRECT=true`.** This switches to direct *and* stops the webhook —
   they are the same change. No Make edit needed (see above).
5. **Weekly tables: create the scheduler job, then pause it in the same breath.**

   **`gcloud scheduler jobs create http` has no `--pause` flag.** An earlier draft of this
   document said it did; the job is created **ENABLED** and starts counting down to its next
   fire immediately. There is no way to create it paused, so the create and the pause are two
   commands and the gap between them is a live job. Run them together and check the state
   before walking away — done here 15 Sep 2026, and the job had already scheduled itself for
   the following Saturday.

   ```bash
   gcloud scheduler jobs create http tbl-weekly-tables-post \
     --location=europe-west2 --project=avid-compound-429108-g9 \
     --schedule="0 12 * * 6" \
     --time-zone="Europe/London" \
     --uri="https://tameside-badminton.co.uk/admin/social/weekly-tables?t=<the token>" \
     --http-method=POST

   gcloud scheduler jobs pause tbl-weekly-tables-post \
     --location=europe-west2 --project=avid-compound-429108-g9

   # and confirm — never assume
   gcloud scheduler jobs list --location=europe-west2 \
     --project=avid-compound-429108-g9 --format="table(name.basename(),schedule,state)"
   ```

   Use the custom domain, not the `run.app` hostname — see **Absolute URLs** in `CLAUDE.md`.
   Make's route 3 is still posting Tameside's tables to the same Facebook Page, so an
   *enabled* job means two posts on a Saturday. Stockport's `sbl-weekly-tables-post` has been
   paused since 15 Sep for the same reason on its side.
6. **The one cutover that has to be atomic.** When both leagues are ready: **disable the
   Make scenario and unpause both scheduler jobs on the same day.** Either order within that
   day is fine; spanning a Saturday is not.

   **Done 15 Sep 2026**, and worth recording how close it came to going wrong. The ask was
   phrased as "unpause the scheduler for the weekend", and at that moment `League Tables` was
   still ACTIVE at Sat 13:00 against Tameside's job at Sat 12:00 — one command away from two
   posts on the same Facebook page an hour apart. **Check the scenario's `isActive` over the
   API before unpausing anything.** Do not infer it from everything else being ready, and do
   not infer it from someone saying it is about to be done:

   ```bash
   curl -s -H "Authorization: Token $MAKE_KEY" \
     "https://eu1.make.com/api/v2/scenarios?teamId=213422" \
     | python3 -c "import sys,json;[print(s['id'],s['isActive'],s['name']) for s in json.load(sys.stdin)['scenarios']]"
   ```

   **And unpausing Stockport's job is not optional.** The scenario is shared, so disabling it
   ends Stockport's tables posting too. A request that sounds like one unpause is actually
   two, and skipping the second means that league silently posts nothing — the kind of
   failure nobody notices until they go looking for a post that never came.

---

## Things that will not be in any brief

- **Firebase Hosting caches a response with no `Cache-Control` for ten minutes, 404s
  included.** Meta fetches these URLs and retries, so a transient 404 during a deploy gets
  cached and the retry never sees the fix. The miss path sets `no-store`.
- **Do not debug this with `curl -d "url=…"`.** A form-encoded body is decoded by Meta, so
  a `%20` in the URL arrives as a **raw space** — and Facebook then answers exactly the
  `324 / 2069019 Missing or invalid image file` this document warns about, for a URL that is
  perfectly fine. Cost an hour on 15 Sep 2026 and very nearly got read as a broken deploy.
  The application code is unaffected: `graph()` builds its body with `URLSearchParams`,
  which encodes the value properly (`%20` → `%2520`).
  - **And the two platforms disagree about it.** Instagram *accepted* the same
    raw-space URL and reported the container `FINISHED`; only Facebook refused. So a
    hand-rolled check can pass Instagram and fail Facebook for a reason that has nothing to
    do with either. Test through `utils/metaPublisher.js`, not through curl.
- **Hardcoded Instagram handles rot.** Make's caption mentioned `@manor_badminton_club`
  where the club's stored handle was `manorbadmintonclubwilmslow`, and named a club with no
  handle at all. A wrong `@handle` mentions a stranger or nothing, and nobody ever notices.
  The caption is built from the database, `Club.getInstagramHandles()`.
  **As of Sep 2026 no Tameside club has a handle stored**, so the caption carries no
  mentions. That is a gap in the data, and the fix is to fill in the `club.instagram`
  column, not to hardcode anything.
- **Facebook page mentions do not work as plain text.** The `@Shell Badminton Club` in
  Make's message has been posting literal @-names for years. Page mentions need the Pages
  API. Instagram mentions from a bare `@handle` **do** work.
- **Check what the images actually say once the URL works.** The Avg. column of every
  Tameside table read `NaN` for every team with no result yet — `(0 / 0).toFixed(1)`. Four
  of the nine Division 1 teams were in that state on 15 Sep 2026. Nobody had seen it because
  the URL serving the picture answered 404 from anywhere but the container that drew it.
  **A broken link was hiding a broken picture.** Stockport's read `0 null null` for its own
  reasons. Look at the image, not just the status code.
- **`pointsFor` / `pointsAgainst` are GAMES won and lost, not league points.** Both leagues
  rank on games, all 18 of a fixture counting. A team with 6 played showing 60 and 48 is
  correct; the column names are what mislead.
- **Two hashtag spellings are live** and neither was changed here: the result *card* draws
  `#tbl`, the result *message* posts `#tdbl`. Someone who knows which the league answers to
  should pick one.
- **The drawing is Jimp, and must stay Jimp.** Stockport draws the same pictures with sharp
  and an SVG overlay, which needs fontconfig and a system font — neither is in this image,
  deliberately. See *Social Image Generation* in `CLAUDE.md`. Porting its drawing code across
  renders every label blank in production and nowhere else.

---

# The other two weekly posts: fixtures, and the results video

Added 21 Sep 2026, ported from the Stockport league site's `weeklyFixturesController`,
`weeklyVideoController` and `socialVideoController`. There are now **three** scheduled
social posts, and they share one shape — `configuredTargets()`, `?dry=1`, per-target
reporting, `requireCronCaller`, 200/207/502 — so everything in the sections above applies
to all three.

| Post | Route | When | Content |
|---|---|---|---|
| Tables | `POST /admin/social/weekly-tables` | Sat 12:00 | 2 division tables, album + carousel |
| Fixtures | `POST /admin/social/weekly-fixtures` | Sun 18:00 (proposed) | 1 card per division playing |
| Results video | `POST /admin/social/weekly-video` | Sat 12:30 (proposed) | mp4 slideshow of the week's results |

## What is genuinely new here versus Tameside's tables post

- **Neither post replaces anything.** Make.com never posted fixtures on either league's
  account, and its video route was never live. So unlike the tables cutover there is no
  scenario to disable, no atomic-day constraint, and no double-post risk.
- **The fixtures post can legitimately have nothing to say**, and then it must not post.
  The league plays September to April. A job firing all year would spend the summer
  publishing cards reading "Fixtures this week" with nothing under the heading. An empty
  week answers **200 with `skipped` set and `posted` empty** — a 200 because nothing went
  wrong and a scheduler retrying a 4xx every Sunday for four months is noise, and `skipped`
  because it must never be readable as "the post went out".
- **The video post mentions nobody, deliberately** — the opposite call from the tables
  post. A results video names every club that played; mentioning all of them reads as spam
  rather than courtesy. The fixtures post mentions **only the clubs playing that week**, for
  the same reason: a mention is a notification, and notifying a club about a week it is not
  playing in is how an account gets muted.

## The video is two scheduler jobs, and that is forced

```
GET  /api/social/generate-weekly-video   renders the mp4 and puts it in S3
POST /admin/social/weekly-video          hands Meta the URL
```

Stockport left "two jobs, or fold generation into the post?" explicitly undecided (their
HARD-21, *Still to do: orchestration*). **Here it is decided by a constraint they do not
have: this service's Cloud Run request timeout is 60 seconds**, lowered from 600 after the
2026-09-17 pooler stall, where a wedged instance held every request it had for ten minutes.
One request cannot both encode the video and then wait on Meta's transcode of it, and being
cut off by the platform *mid-publish* is the one failure mode that could double-post on a
retry.

**What makes the split safe is the staleness guard, not the wall clock.** The post reads
the stored object's `LastModified` and refuses anything older than two days with a **409**
naming the step that was missed. Without it, a generation that did not happen — the
endpoint refused, the encode crashed, the scheduler misfired — means last week's results go
out under a caption saying they are this week's. That is worse than posting nothing, and it
is the class of silent wrongness this feature produced twice on the other site. The dry run
is refused too: validating a stale video against Meta reports `ok` for something that must
not go out.

So the jobs want ordering, not precision: generate at 12:25, post at 12:30. If the first
fails, the second answers 409 loudly instead of posting the wrong thing.

### The schedule, as actually set (21 Sep 2026)

| Job | Cron (Europe/London) |
|---|---|
| `tbl-weekly-tables-post` | `0 12 * * 6` — Sat 12:00 |
| `tbl-weekly-fixtures-post` | `0 18 * * 0` — Sun 18:00, the week ahead |
| `tbl-weekly-video-generate` | `50 17 * * 1` — Mon 17:50 |
| `tbl-weekly-video-post` | `0 18 * * 1` — Mon 18:00, the week just gone |

### Creating the jobs, and three ways it lies to you

`gcloud scheduler jobs create http` **has no `--pause` flag** — the job is created ENABLED
and counting down, so create and pause are two commands with a live job in between. That is
recorded above for the tables job and is just as true here.

**A create can fail with `LOCATION_POLICY_VIOLATED` and succeed on an identical retry.**
Seen twice on 21 Sep 2026, for two different jobs, with no change between attempts. It
appears to be transient, which means a create must never be *assumed* to have worked.

**Do not pipe the create through `grep`.** Doing exactly that to tidy the output swallowed
the error above, so two jobs silently did not exist while the command looked clean — the
same shape as the `secured` endpoint that 404s for a year while the scheduler records
success. **Verify by listing the jobs afterwards**, not by the create's own output.

**The `SCHEDULE_TIME` column in that listing is UTC**, even though `TIME_ZONE` beside it
says `Europe/London`. A job set for 17:50 London prints `16:50` under BST. The cron is
authoritative; the column is not wrong, it is just not answering the question it looks
like it is answering.

```bash
P="--location=europe-west2 --project=avid-compound-429108-g9"

gcloud scheduler jobs create http tbl-weekly-video-generate $P \
  --schedule="50 17 * * 1" --time-zone="Europe/London" --http-method=GET \
  --uri="https://tameside-badminton.co.uk/api/social/generate-weekly-video?t=<SOCIAL_WEEKLY_VIDEO_TOKEN>"

gcloud scheduler jobs create http tbl-weekly-video-post $P \
  --schedule="0 18 * * 1" --time-zone="Europe/London" --http-method=POST \
  --uri="https://tameside-badminton.co.uk/admin/social/weekly-video?t=<SOCIAL_WEEKLY_VIDEO_TOKEN>"

gcloud scheduler jobs create http tbl-weekly-fixtures-post $P \
  --schedule="0 18 * * 0" --time-zone="Europe/London" --http-method=POST \
  --uri="https://tameside-badminton.co.uk/admin/social/weekly-fixtures?t=<SOCIAL_WEEKLY_FIXTURES_TOKEN>"

# and confirm — never assume, and never read this off the create's own output
gcloud scheduler jobs list $P --format="table(name.basename(),schedule,state)"
```

Use the custom domain, not the `run.app` hostname — see **Absolute URLs** in `CLAUDE.md`.

### New environment variables

```
SOCIAL_WEEKLY_FIXTURES_TOKEN   # shared secret for the fixtures job; unset = route 404s, i.e. inert
SOCIAL_WEEKLY_VIDEO_TOKEN      # shared secret for BOTH video routes; unset = both inert
```

Separate tokens per post rather than one `SOCIAL_CRON_TOKEN` (which is what Stockport uses),
so a post can be turned off by removing one variable without taking the other two with it.

## ffmpeg is now in the image

`utils/socialVideo.js` shells out to `ffmpeg`, and the Dockerfile installs it. It is the
only system package in the image and the largest thing in it.

**There is no ImageMagick, and adding it would be a regression.** Stockport builds the video
by writing every frame to disk — 25 frames a second, one `convert` per transition frame,
~36s of encode. This does the same crossfade in one `xfade` pass, and does the fit-and-pad
in Jimp. Measured 21 Sep 2026: five slides render and encode in **3.8s** locally, well
inside the 60s budget.

Three things in the encode that fail quietly if changed:

- **The crossfade offsets accumulate at `slide - transition`**, because a crossfade consumes
  that much of the running total rather than adding to it. Get it wrong and the video does
  not fail — it freezes on one slide and skips another, visible only by watching it. Note
  Stockport's total is `n*slide + (n-1)*transition` and this one's is
  `n*slide - (n-1)*transition`: different transitions, and the reported duration has to
  match whichever is built.
- **A JPEG decodes as full-range YUV**, so `-pix_fmt yuv420p` alone produces a stream tagged
  `yuvj420p` — 4:2:0 as asked, but full range, which renders washed out in any player that
  ignores the tag. Measured here before the `scale=in_range=full:out_range=tv` filter
  existed. The filter is what does the conversion; the `-pix_fmt` flag is belt and braces.
- **`+faststart`.** Meta fetches the file by URL and starts reading immediately; with the
  index at the end it has to pull the whole thing first.

## The video object is private, and the read route is why

`GET /social-video/:aspect` streams it from S3 through our own domain. **The object sets no
ACL and must not get one.** That is the whole of Stockport's HARD-21: their generate
endpoint returned a `https://<bucket>.s3.…` URL that answered 403 to everyone, including
Meta, for four months. The route is the third instance of this pattern here, after
`/scorecard-photo/:id`.

- **`aspect` is looked up in a fixed map and never used to build a key.** This bucket is
  shared with the Stockport league and holds its scorecards at the root; a route that
  streams any object a caller can name would serve another league's private documents out of
  our origin. `test/integration/social-video.test.js` asserts **the key that reached S3**,
  not merely that a traversal 404s — a handler that interpolated the parameter would 404 in
  a test too, because the mocked bucket holds nothing. That exact test passed against the
  vulnerable version on the Stockport side.
- **The object key carries the `tameside-` prefix**, because that prefix *is* the ownership
  test in `utils/scorecardPhoto.js`.
- **The content type comes from the route, never from what S3 reports.** Legacy objects in
  this bucket were uploaded through an unauthenticated `/sign-s3` that stored the caller's
  content type, so one can claim `text/html`.

## No S3 lock file, on purpose

Stockport guards concurrent generation with a lock object. Theirs **recognised a stale lock
without deleting it**, and the atomic create that followed used `IfNoneMatch: '*'` — so one
interrupted encode wedged the feature permanently and reported it as a concurrent run that
did not exist. It answered `202` for **115 days**.

The concurrency actually at risk here is two Cloud Run instances encoding at once, which
costs CPU and nothing else: both write the same key and the bytes are identical. So this
uses an in-process `singleFlight` instead — it cannot leave anything behind, cannot go
stale, and cannot wedge anything. A generate call also reuses a video written in the last
ten minutes rather than re-encoding, so a retry or a double-clicked admin button is free.

## Things to check the first time each one runs

- **Look at the pictures, not the status codes.** The Avg. column read `NaN` on every table
  for weeks because a broken link was hiding a broken picture. Both preview pages
  (`/admin/social/weekly-fixtures`, `/admin/social/weekly-video`) render from **this**
  server rather than production, precisely so that what you are looking at is what this
  build produces.
- **A dry run's `ok: true` means "Meta could fetch and transcode this", not "this is a good
  post".** Same caveat as `validateImages`.
- **Meta's transcode is slower than the handover suggests, and it is what sizes the poll
  ceiling.** Measured 21 Sep 2026 on the first real dry run: a **5.4-second** video took
  **27.6s** to reach `FINISHED`. The Stockport handover describes a ~13s video getting
  there "within a few seconds", and `VIDEO_TIMEOUT_MS` was 40s on the strength of that —
  two thirds of it spent by a video a quarter the length. It is 45s now, which is what
  fits inside the 60s Cloud Run request timeout given Facebook goes first and is not
  polled. If a nine-fixture week ever does time out, the symptom is a **207** with
  Facebook posted and Instagram failed, not a lost post.
- **The fixtures card changes layout rather than font size** when a division has a lot of
  matches — Jimp cannot scale a bitmap font, and in white `fonts/` has only 30 and 60.
  Measured against the real database 21 Sep 2026: every one of the 18 team names fits on
  its own line at 60 (widest 636px of 940 usable), but 23% of pairings overflow at 60 on
  one line. Hence three layouts, most to least generous, and the card takes the first that
  fits in both height and width. 86% of division-weeks have 1-3 fixtures and get the
  stacked form.
- **The panel is dark at 0.80 with white centred text, and sized to its contents.** A light
  panel has to be near-opaque to be legible, at which point the artwork under it may as
  well not be there. A fixed-height panel makes a quiet week look like a rendering fault.
