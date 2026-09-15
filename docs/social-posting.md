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
SOCIAL_WEEKLY_TABLES_TOKEN   # shared secret for the weekly scheduler job; unset = inert
META_GRAPH_VERSION           # optional, defaults to v21.0
META_GRAPH_ORIGIN            # test seam only — never set this in production
```

Set them on the **service**, not just in `.env`. **Verify by comparing hashes, not by eye**
— a malformed `gcloud --update-env-vars` delimiter can set one variable of seven and report
success. That happened on the Stockport side.

---

## The order to do it in

The agreed plan is to **leave both Make scenarios alone until Tameside is across too**, so
that retiring them is a disable rather than surgery. Each step is safe to stop after.

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
5. **Weekly tables: create the scheduler job PAUSED.**

   ```bash
   gcloud scheduler jobs create http tbl-weekly-tables-post \
     --location=europe-west2 \
     --schedule="0 12 * * 6" \
     --time-zone="Europe/London" \
     --uri="https://tameside-badminton.co.uk/admin/social/weekly-tables?t=<the token>" \
     --http-method=POST \
     --pause
   ```

   Use the custom domain, not the `run.app` hostname — see **Absolute URLs** in `CLAUDE.md`.
   Make's route 3 is still posting Tameside's tables to the same Facebook Page, so an
   *enabled* job means two posts on a Saturday. Stockport's `sbl-weekly-tables-post` has been
   paused since 15 Sep for the same reason on its side.
6. **The one cutover that has to be atomic.** When both leagues are ready: **disable the
   Make scenario and unpause both scheduler jobs on the same day.** Either order within that
   day is fine; spanning a Saturday is not.

---

## Things that will not be in any brief

- **Firebase Hosting caches a response with no `Cache-Control` for ten minutes, 404s
  included.** Meta fetches these URLs and retries, so a transient 404 during a deploy gets
  cached and the retry never sees the fix. The miss path sets `no-store`.
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
