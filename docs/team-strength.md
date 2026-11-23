# Team strength

A points-based doubles rating for every player, refitted every night, at
`/admin/team-strength` (superadmin). It was ported from Stockport (league-site `e9ea24b`,
`d5d0149`, `db9bc17`) as backlog row 7, reworked for a Tameside side of four men and two
ladies, and backtested on our own results before anything relies on it.

Row 8 (23 Nov 2026) added, on the same page: **this week's predictions** (including any
fixture past its date with no result), **projected tables**, **team order checks**, and
**/admin/team-strength/compare**, which sets out the results behind a flag so you can make
the case to a club. The run also stores a nameless `public` block (a forecast per remaining
fixture and a profile per team) for the event pages (rows 3 and 4) to read through
`TeamStrength.forecastFor`. It must never hold a name or a player id, and tests check that.

## How it works

- `utils/teamStrength.js`: the model (pure). Each rally of a game is won by the home pair
  with probability `sigmoid(s_h1 + s_h2 - s_a1 - s_a2 + home [+ mixed offsets])`, fitted
  over every game at once, with each game weighted by its age. A player with few games
  starts at the average of the division they were registered in **that season** (from the
  `player/team/division<season>` archives, not from today's team).
- `RUBBERS` is our card: Open A (M1+M2 v M1+M2), Open B (M3+M4 v M3+M4), Open C and D (one
  side's top pair against the other's bottom pair), Ladies, and Mixed A-D (M1/L1, M2/L2,
  M3/L1, M4/L2). A rubber picks per side because Open C and D cross the order.
- Left out of the fit: Lewis Shield fixtures, any game with player 0 ("No Player"), a
  repeated player, a 21-0 walkover, and the older entry of a re-entered scorecard.
- `models/teamStrength.js` reads the games and stores a run in `strength_run`
  (`migrations/strength-run.sql`), keeping the last 14. The payload is written with
  `sql.json`.
- `POST /admin/team-strength/run` runs it: Cloud Scheduler with `?t=<STRENGTH_RUN_TOKEN>`,
  or the page's button. It takes about 1s on 5,900 games.

### What is different from Stockport's, beyond the card

- **Order checks compare card tiers, not every pair**: men {1,2} {3,4} {5+}, ladies {1,2}
  {3+} (`ORDER_TIERS`). Men 1 and 2 play the same level games (Open A, and C or D), so
  swapping them only changes who partners whom in the mixed. Flagging every pair, as
  Stockport's 3+3 card needs, produced 61 order flags on 23 Nov 2026, about half of them
  within a pair; this way there are 47. The red "played at" mark follows the same rule.
- "The third nominated player" in the reserve checks is the **last one who plays**: man 4
  or lady 2. A team "hasn't set its nominations" past 8 men or 4 ladies (twice a side, as
  Stockport's 6 is twice 3).
- **The places up and down** come from the `promotion_places` site setting (row 6).
- **`formSd` scales with the season left** (`formSdFor`): 0.15 at the start, 0.1 from
  about January, as the backtest measured.
- Lewis Shield ties are neither predicted nor projected.

## The backtest

`node tools/strength-backtest.js` (read-only, about 15s; `--tune` adds the settings search,
about 5 minutes). Every Monday it refits to the games before that date and predicts the
week, as the nightly run would have. It compares against the ELO each game row stored going
in (`homePlayer1Start`…), i.e. what the ELO actually believed at the time.

**Our game rows start in September 2024**, against Stockport's 2018, so there is far less
history to learn from. Settings were chosen on **2025/26** and the numbers that count are
on **2026/27 to date**, which the choice never saw. Stockport's 75.3% came from no committed
tool, and its test season overlapped its tuning season, so it is not quoted here as ours.

Measured 23 Nov 2026, with the settings in `SETTINGS`:

| | 2024/25 from Jan | 2025/26 (tune) | 2026/27 (test) |
|---|---|---|---|
| Games | 1,151 | 2,473 | 828 |
| Winners called: model | 74.6% | 78.9% | 79.0% |
| Winners called: ELO | 72.9% | 75.4% | 76.4% |
| Log loss: model | 0.537 | 0.446 | 0.473 |
| Log loss: ELO rescaled on 2025/26 | 0.530 | 0.491 | 0.507 |
| Where they disagree: model right / ELO right | 131 / 111 | 266 / 180 | 74 / 53 |
| "Home always wins" | 50.4% | 55.7% | 53.6% |

- **The model is better than the ELO, and clearly so on probabilities.** On winners called
  the margin is 2.6 points on the test season; the disagreements split 74/53 (z = 1.9), so
  that one season on its own is suggestive rather than conclusive. On 2025/26 the same
  comparison is 266/180 (z = 4.1). Log loss is better in every period, even against an ELO
  rescaled to its best fit, which is what row 8's probabilities depend on.
- **2024/25 is weak for both**: by January there were at most four months of games.

Fixtures, predicted three ways (result called = home win / draw / away win):

| | 2025/26 | 2026/27 |
|---|---|---|
| Model, the players who actually played | 85.6% | 91.5% |
| Model, each team's usual players at the time | 80.6% | 80.9% |
| ELO, the players who actually played | 78.8% | 82.6% |

The gap between the first two rows is not knowing who will turn up, as Stockport found
(`d5d0149`). A prediction made in advance has to use the second row. Made in advance, the
model does about as well as the ELO does when it is given the real lineup.

### Settings

- **Kept as Stockport's** (`halfLifeDays` 365, `tau` 0.3, `mixedSd` 0.15). The search
  preferred a 180-day half-life and no mixed offset on 2025/26 (log loss 0.446 → 0.441),
  but those settings did **worse** on 2026/27 (79.0% → 77.5%, log loss 0.473 → 0.475). That
  gain was noise, and parity with Stockport is worth more than noise.
- **`fixtureSd` 0.2 is confirmed on our data.** It gives the best exact-score likelihood on
  2025/26 from usual lineups, and its squared z-scores average 0.97 there and 0.91 on
  2026/27 (1 is calibrated). Without it a fixture's score varies four times more than the
  model says.
- **`formSd` (for row 8's season projection) needs about 0.15 from September and 0.1 from
  January.** Measured on 2025/26's 18 teams, so it is rough: squared z-scores of final games
  won average 0.95 at 0.15 from the first fixture, and 0.84 at 0.1 from 1 January. Row 8
  scales it by the share of fixtures left (`formSdFor`).

Re-run the backtest after changing anything in `utils/teamStrength.js`, and update this
table.

## Scheduling it

Apply `migrations/strength-run.sql` first (`node tools/run-migration.js
migrations/strength-run.sql --commit`); without the table every run fails. Then:

```bash
gcloud run services update tameside-site --region=europe-west2 \
  --update-env-vars=STRENGTH_RUN_TOKEN=<a long random token>

gcloud scheduler jobs create http tbl-team-strength \
  --location=europe-west2 \
  --schedule="30 3 * * *" \
  --time-zone="Europe/London" \
  --uri="https://tameside-badminton.co.uk/admin/team-strength/run?t=<the same token>" \
  --http-method=POST
```

| Variable | Effect |
|---|---|
| `STRENGTH_RUN_TOKEN` | The scheduler's shared secret. **Unset means the run 404s** for anyone but a superadmin. |
