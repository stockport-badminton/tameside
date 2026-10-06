# Missing scorecards email

Every morning the results secretary gets one email listing the fixtures that were played
**six days ago** and still have no result and no submitted scorecard. Ported from
Stockport's `GET /fixture/outstanding` (league-site `getLateScorecards`).

- Route: `GET /tasks/missing-scorecards?t=<MISSING_SCORECARDS_TOKEN>`. A superadmin session
  works too, so you can open the URL in a browser to fire it by hand.
- Code: `controllers/missingScorecardsController.js`, `Fixture.getCardsDueToday`,
  `emails/missing-scorecards.mjml`.

## What counts as missing

A fixture dated exactly `DAYS_AGO` (6) days ago on the London calendar, with
`homeScore` NULL, a status other than rearranged/rearranging/conceded/void/complete, and
**no draft in `scorecardstore`**. Stockport doesn't check for a draft. Tameside does,
because a submitted card has already produced a "scorecard received" email.

Each run covers **one day**, so each match is reported once, not every morning until its
card arrives. As a result, **a day the job doesn't run is never caught up**. That
behaviour is unchanged from Stockport.

Nothing missing means no email. The run still answers `{ "sent": false, ... }`.

## Setup

1. Set the token (and optionally the recipients) without touching other variables:

```bash
gcloud run services update tameside-site --region=europe-west2 \
  --update-env-vars=MISSING_SCORECARDS_TOKEN=<random>
# optional, comma-separated; defaults to the results mailbox
#  --update-env-vars=^@^MISSING_SCORECARDS_TO=a@example.com,b@example.com
```

2. Create the scheduler job, which runs at 09:00 Europe/London every day, the same as
   Stockport's:

```bash
gcloud scheduler jobs create http missing-scorecards \
  --location=europe-west2 \
  --schedule="0 9 * * *" \
  --time-zone="Europe/London" \
  --uri="https://tameside-badminton.co.uk/tasks/missing-scorecards?t=<the same token>" \
  --http-method=GET
```

3. Check it with `gcloud scheduler jobs run missing-scorecards --location=europe-west2`.
   The response body says whether anything was sent.

| Variable | Effect |
|---|---|
| `MISSING_SCORECARDS_TOKEN` | The shared secret. **Unset means the route 404s**, i.e. inert. |
| `MISSING_SCORECARDS_TO` | Comma-separated recipients. Defaults to the results mailbox. |
