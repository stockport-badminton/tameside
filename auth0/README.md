# Auth0 configuration that lives outside this repo

The login page in this directory **runs inside Auth0, not on this server**. Nothing in
the deploy pipeline touches it, and there is no other copy of it — so this directory is
the source of truth and `tools/auth0-login-page.js` is how it gets there.

That pattern is why it's tracked: the previous version of this page existed only in the
Auth0 dashboard, with another league's logo hardcoded into it, and nothing in either
codebase recorded that it existed.

## The setup, and why it's odd

The Auth0 tenant (`stockport-badminton.eu.auth0.com`) is **shared with the Stockport
league site** (`~/league-site`) — one tenant, several applications. Consequences:

- Most branding is tenant-level, so it cannot differ per league.
- The tenant serves **Classic** Universal Login (Lock 11), not New. `GET /api/v2/prompts`
  reports `universal_login_experience: "new"`, which is misleading — fetching
  `/authorize` for three different clients returns Lock 11.11 every time. Trust the
  rendered page, not the setting.
- Classic's login-page HTML is stored **per application** in the client's
  `custom_login_page` field, with `custom_login_page_on` as the switch. The tenant-wide
  page lives on an `All Applications` pseudo-client, and any client with an empty page
  falls back to it.

So `custom_login_page` on the Tameside client is the one place per-application branding
is possible **for free** — no custom domain, no plan upgrade, and no tenant-level change
that would affect Stockport.

(Universal Login *page templates*, the mechanism Auth0 documents for this, answer
`402 Payment Required` on the current plan and also require a custom domain. Not needed.)

## What this page changes

It is the tenant-wide page with three edits and nothing else, so behaviour is identical:

| | |
|---|---|
| `<title>` | `Tameside Badminton League` (was `Sign In with Auth0`) |
| `theme.logo` | the Tameside logo (was Stockport's, hardcoded) |
| `languageDictionary` | heading forced to `Tameside Badminton League` rather than inherited from the shared tenant dictionary |

`@@config@@` **must** survive any edit — Auth0 substitutes the client/session config
through that placeholder, and the page cannot work without it. The deploy script refuses
to upload a page that has lost it.

## Deploying and reverting

```bash
node tools/auth0-login-page.js            # dry run; reports whether live has drifted
node tools/auth0-login-page.js --commit   # upload, then verify against the real page
node tools/auth0-login-page.js --revert   # blank it -> falls back to the shared page
```

`--commit` renders the genuine login page afterwards and checks Lock loads, the config
was injected, the right logo is referenced and it isn't an Auth0 error page. **If any
check fails it rolls back before reporting** — this is the front door, so it must never
be left broken.

## Verifying by hand

```bash
# the real user journey; the cookie jar matters, or Auth0 answers
# "couldn't find your session" and you'll think it's broken
curl -sL -c /tmp/j -b /tmp/j -A "Mozilla/5.0" https://tameside-badminton.co.uk/login \
  | grep -E "<title>|logo:"
```

Expect `Tameside Badminton League` and the tameside-badminton.co.uk logo. Swap in
Stockport's client id and you should still see `Sign In with Auth0` — if Stockport's
branding has changed, something tenant-level was touched by mistake.

## Do not

- **Change tenant-level settings casually** — `friendly_name`, `support_email`,
  `branding.*` and the `All Applications` page are all shared with Stockport. The tenant
  `friendly_name` is still `Stockport Badminton League` and its `support_email` is
  Stockport's, so a Tameside user hitting certain Auth0 error pages is still shown
  Stockport's identity. Fixing that properly means changing it for both leagues.
- **Remove `app_metadata.betaAccess`** — a separate Auth0 Action gates login on it.
- Assume `app_type` matters for the flow. The Tameside client is typed `non_interactive`
  yet does interactive login; `grant_types` is what governs it, and it already includes
  `authorization_code`. The type is a dashboard label (and probably why the branding
  fields were hard to find in the UI).
