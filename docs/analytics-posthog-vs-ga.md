# PostHog beside Google Analytics: can GA go?

Started 10 Oct 2026. Ported from Stockport (league-site `f131627`, `9d5a002`), where the
same trial started the same day.

## Why

Google Analytics sets cookies, and this site has no consent banner. PostHog in
`cookieless_mode: 'always'` stores nothing in the browser, so it needs no consent. If
PostHog tells us what GA tells us, GA can go and no banner has to be built.

## What is running

| | Google Analytics (`G-01JJPR11B6`) | PostHog (EU, project shared with Stockport) |
|---|---|---|
| Where | every page, every environment (dev included) | every page, production only, served-by-us only |
| Who | everyone | everyone **except superadmins** |
| Storage | `baddersCookie` cookies, 28 days | none |
| Uniques | across 28 days (the cookie) | **per day**: the hash salt is discarded daily |
| Logged-in id | `user_id` + `crm_id` | `account_id` property (no `identify()` in cookieless mode) |
| Homepage `section_view` | yes | yes, the same event via `tblTrack` |
| Session recordings | no | `/email-scorecard`, `/populated-scorecard*`, logged in |
| Wizard events | no | `scorecard_ocr_started/_result`, `scorecard_photo_attached`, `scorecard_step`, `scorecard_submit_clicked` |
| JS errors on `/email-scorecard` | `window.onerror` → a gtag event | no; Sentry already has these |

## Comparing them fairly

- **Filter PostHog on `league = tameside-badminton.co.uk`.** The project is Stockport's
  too (same `POSTHOG_KEY`), so unfiltered numbers are both sites added together.
- **Compare pageviews and daily uniques, never weekly or monthly uniques.** PostHog
  counts a returning visitor again each day by design. GA's weekly uniques will look
  far smaller, and the gap is a definition, not missing data.
- **Exclude `/admin/*`** from both. PostHog never loads for a superadmin and GA always
  does, so admin pages are GA-only traffic.
- Expect both to under-count by about the same amount. Common ad blockers block both, and
  PostHog also drops automated browsers.

## Decision criteria

Run until at least **mid-November 2026**: four or more fixture weeks, so midweek
match-night traffic is in both. GA is safe to remove if, over that period:

1. Weekly PostHog pageviews come to roughly 80% or more of GA's, excluding `/admin`, and
   the trend is the same shape week to week.
2. The top 20 pages rank about the same in both.
3. Referrers and sources are usable in PostHog, so we can still see how people arrive
   (Google search, Facebook, Instagram, direct).
4. `section_view` counts per section are in about the same proportion in both.

Nothing else we use depends on GA. **Search Console works without it** and reports
organic search queries itself.

## Removing GA, if it passes

- `views/header.ejs`: the gtag loader, the `dataLayer`/`gtag` stub and both
  `gtag('config', …)` blocks. Keep `window.tblTrack`.
- `views/homepage.ejs`: the `gtag('event', 'section_view', …)` line, **and the
  `typeof gtag !== 'function'` guard**. Left in place, that guard switches off the
  PostHog half too.
- `views/email-scorecard.ejs`: the `window.onerror` → gtag handler.
- `views/privacy.ejs`: the Google Analytics bullet, its processor entry and its
  retention period.

### GA is not the only thing setting cookies

Removing GA is necessary for "no banner" but not sufficient:

- **`/rules` embeds a Google Maps iframe** (`google.com/maps/embed`, Astley Sports
  Village). Google sets its own cookies in that frame on every visit to the rules page.
  Replace it with a link or a static map image, as Stockport did with its Facebook page
  plugin (league-site `b8b8e60`).
- `/club/:id` loads the Maps JavaScript API, and the contact form loads reCAPTCHA. Both
  are usually treated as necessary for the page to work (a map someone asked for, and
  spam protection). Check them anyway when it comes to it.
- `__session` and Auth0's own cookies are strictly necessary and need no consent.
