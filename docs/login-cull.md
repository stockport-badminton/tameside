# The monthly login cull

Logins nobody uses are attack surface and noise. On 5 Nov 2026, 81 Auth0 accounts unused
for two or more years were deleted by hand. This keeps it from piling up again.

1. **Monthly, `GET /tasks/login-cull`** (Cloud Scheduler) emails every Tameside login that
   has not been used for a year, and sends the results mailbox a summary. It deletes
   nothing.
2. **The person keeps the login** by logging in to either site (last-login is shared
   across the tenant), or with the link in the email. `GET /keep-login/:token` only shows
   a button, because mail scanners prefetch links; the POST keeps it for a year.
3. **A month after the email**, with no sign of life, the login is listed under *Login
   cull* on `/admin/link-auth-accounts`. A superadmin presses Delete. That deletes the
   account from Auth0 and removes its link to a player here (its account row and that
   address in `player_auth_email`). Results are untouched. "keep" next to a row keeps it
   for a year without emailing anyone.

Nothing is deleted automatically, by decision (5 Nov 2026): a club admin could otherwise
disappear mid-season with nobody having looked. The delete only touches accounts that were
on the page **and** are still due when it runs, so a login used in the meantime is left
alone.

## Whose accounts

The tenant is shared with Stockport's site, so each site culls its own and the split
leaves none in both and none in neither (`utils/authCull.js`):

| Site | Culls |
|---|---|
| Tameside | accounts linked to a Tameside player (`player_auth_account`), plus unlinked accounts with `app_metadata.league = 'tameside'` |
| Stockport | accounts linked to a Stockport player, plus unlinked accounts not tagged `tameside`, **minus anything in our `player_auth_account`** |

`league` is where someone signed up, not whose they are. Measured 5 Nov 2026: 15 accounts
tagged `stockport` are linked to Tameside players (people in both leagues), and Google
signups carry no tag at all, because a pre-user-registration Action does not run for social
logins. So the link decides, and the tag only covers the unlinked.

An account linked on both sides is idle only if it is idle on both, and then both sites
may email it. Whichever deletes first wins; the other side's link becomes a dead row.

Never-approved accounts (no `betaAccess`) and accounts with no email address are listed
straight away without an email: the first could never log in, the second cannot be written
to.

## Setup

1. Apply `migrations/auth-account-notice.sql` **before deploying**. Without the table the
   cull section of the link page shows an error, and the rest of the page still works.

```bash
node tools/run-migration.js migrations/auth-account-notice.sql --commit
```

2. Set the token:

```bash
gcloud run services update tameside-site --region=europe-west2 \
  --update-env-vars=LOGIN_CULL_TOKEN=<random>
```

3. Create the scheduler job: 10:00 Europe/London on the 1st of each month.

```bash
gcloud scheduler jobs create http login-cull \
  --location=europe-west2 \
  --schedule="0 10 1 * *" \
  --time-zone="Europe/London" \
  --uri="https://tameside-badminton.co.uk/tasks/login-cull?t=<the same token>" \
  --http-method=GET
```

4. Check it with `gcloud scheduler jobs run login-cull --location=europe-west2`. The
   response body says how many were warned, failed, deferred, waiting and due.

| Variable | Effect |
|---|---|
| `LOGIN_CULL_TOKEN` | The shared secret. **Unset means the route 404s**, i.e. inert. |

## Details

- **At most 40 emails a run**, to stay inside the 60s request ceiling; the rest go next
  month (`deferred` in the response).
- **A warning is recorded only after Mailjet accepts it.** Otherwise someone never told
  would be listed for deletion a month later.
- **The keep token is stored hashed**, one per email. A new email replaces it, and using
  it spends it.
- **A quiet month sends the results mailbox nothing.**
- The Auth0 app already had `delete:users` (checked 5 Nov 2026). `Auth.deleteUser` waits
  and retries on a 429, and treats a 404 as already gone.
- Grep Cloud Logging for `[login-cull]`.
