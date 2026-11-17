# BL-05: OCR for the v2 scorecard

Raised 16 Nov 2026. Ours alone: Stockport's card is a different layout and their reader
(`recogniseCard`) was never ported.

## Why

A new paper scorecard has been proposed and sent to the team captains for review on
16 Nov 2026: [`BL-05-assets/scorecard-v2.pdf`](BL-05-assets/scorecard-v2.pdf). On the
current card each player is written three times, once in each event's names column. On v2
the captain writes each side once, as four mixed pairs (man and lady, strongest first),
and writes A or B in a box beside each Open player (the man in each pair) for his Open pair.
Every event's players follow from that. The results grid has one row per game and takes scores only.

If the league adopts it, **both cards will be in use for a while**: old stock, captains
printing their own, clubs that don't hear. So the OCR has to read both, and it must
never read a v2 card with v1's logic.

**Do nothing until the committee has decided.** If the layout changes in review, edit
`BL-05-assets/build-v2.py` and `v2.css`, then regenerate. Run
`python3 build-v2.py && node render.js "$PWD/scorecard-print-v2.html" out.pdf out.png`
from that folder. Rendering uses the repo's Playwright Chromium.

## What happens today if a v2 card is uploaded

It fails cleanly. `uprightScore` and `extractScorecard` both need the printed word
`Events`, and v2 prints `Event`. So orientation finds nothing and the anchors throw
`notOurCard`. v2 prints `Captains'`, which matches `PRINTED_WORDS`, so the captain sees the
`not-a-card` message rather than `hand-drawn`. The read stops there. It is never misread,
and no wrong data reaches the form.

**Keep it that way.** v1 detection rests on the plural `Events`. If the committee renames
v2's column to "Events", v1 extraction would run on a v2 photo, misread the scores and
put names in the wrong events, all without an error. Any change to the printed labels has to
be checked against v1's anchors.

## Two changes to the card worth making before it is printed

These cost nothing now and a lot later. Raise them with the committee alongside its
review.

1. **A printed version mark**, e.g. `Scorecard v2 · 2027` in the footer. That is a single
   unambiguous token for the layout classifier, and it survives future label tweaks.
2. **The Open pair is a write-in box, not circled letters. This change has been made**
   (v2.1, 16 Nov 2026, after v2 went to the captains). With circles, or tick boxes, Vision
   returns both printed letters as text and nothing says which one was marked. Telling
   them apart would mean measuring ink in the photo with sharp. That is new territory for a
   pipeline that is pure over the Vision response today, and light ticks would be marginal.
   A written letter is text. The constraint (exactly two A and two B per side) corrects a
   misread; expect `A`→`4`/`R` and `B`→`8`/`13`. A/B cannot be inferred instead: the A
   pair need not be pairs 1 and 2, and in the worked example the away A pair is pairs 1
   and 3. **If the committee asks for circles back, this is the reason not to.**

## Design

### 1. Classify the layout first

`extractScorecard(resp)` becomes a dispatcher. After orientation, it decides
`layout: 'v1' | 'v2'` from printed anchors, then calls `extractV1` (today's code,
untouched) or `extractV2`.

- v2 markers: the version mark if printed; otherwise `TEAM SHEET` / `HOME TEAM` /
  `AWAY TEAM`, `Event` (singular), `Totals`, `Match Scorecard`.
- v1 markers: `Events`, `Players`, `RESULT`, `Register`, `Played at`. v2 has no `Played at`
  line (dropped 17 Nov 2026: the venue is entered nowhere).
- **Never classify on the event labels.** v2 prints `Open A v A` etc. (renamed from "Men"
  on 17 Nov 2026 after captain feedback), and older v1 cards print `Open A`–`D` too —
  `extractScorecard`'s row-anchor regex already accepts `Open`. They tell the layouts
  nothing.
- **Orientation must learn v2's header labels.** `uprightScore` keys on
  Events/Points/Games. Give it a per-layout label set and take the best score across both.
  Otherwise every rotated v2 photo fails.
- Neither layout found: the existing `notOurCard` path. Add v2's printed words (`Totals`,
  `Captains'`, `Team`) to `PRINTED_WORDS` (v2 does not print `Played`), or a cropped v2 card will be reported as
  `hand-drawn`.
- Log `layout` on the `[ocr] read ok` / `read failed` lines, so adoption and per-layout
  success rates can be counted from the logs.

### 2. v2 scores: 18 rows, one game each

The right half of the grid is 18 ruled rows between the `Points` header and `Totals`. Each
row holds one game, with H and A in separate boxes.

- `alignScoreLines` (one vertical offset per card, fitted over the whole column) carries
  over and is simpler here. The nine event labels each span two rows, so the pitch comes
  from label to label ÷ 2, or from `Points` header to `Totals` ÷ 18.
- Vision will still sometimes fuse `21` `17` into `2117` despite the box line, so keep
  `splitScores` and its rule-based disambiguation.
- Games won and the total stay **derived, never read**, as now.
- Row order is the same as v1's events (Open A v A, Ladies, Open B v B, Mixed 1–4, Open A v B,
  Open B v A), so `GAME_MAP` and Game1..Game18 are unchanged.

### 3. v2 names: 16 cells, gender known

The left half is two blocks, `HOME TEAM` then `AWAY TEAM`. Each block has four pairs of
two rows, with the man on the `O` (Open) row and the lady on the `L` row. These rows line up with
the score rows (both sides are 18 rows tall), so the same pitch places them.

This should be **more accurate than v1**, which reads a two-person blob per event and
has to split it:

- One person per cell, so match a single player, not a pair.
- The gender is printed on the row, so restrict candidates to it. A v1 Mixed blob has to
  work out which name is which.
- Each lady is written twice. Treat the two reads as votes, and enforce exactly two
  distinct ladies per side, each in two pairs. If both reads of one lady disagree, keep the
  stronger. If a side reads three different ladies, warn and leave the weakest blank.
- Four distinct men per side. A duplicate is a misread: blank the weaker one.
  `SLOT_MIN_SCORE` (blank beats wrong) applies.

### 4. Mapping onto the entry form

The form already models this card. It holds four men and two ladies per side, plus
per-event mixed selects. `mixedPicks` exists because 247 of 570 sides in the Oct 2026
corpus did not use the default pairing.

- **Men's slots come from A/B, not from the pair number.** In the form (`SLOT_EVENTS`),
  men 1 and 2 are the A pair and men 3 and 4 the B pair. So slot the two men marked A as
  1 and 2, in pair order, and the B men as 3 and 4. Home and away differ for Open A v B and
  B v A exactly as `SLOT_EVENTS` already encodes. Don't re-derive it.
- **Mixed pairs come straight from the team sheet**: Mixed *n* = pair *n*'s man and lady.
  Hand those back as `mixed` picks for every event, not just where a pick clears
  `MIXED_MIN`/`MIXED_MARGIN`. On v2 they are read, not guessed.
- **Ladies 1 and 2**: the lady in pair 1 is Lady 1, and the other is Lady 2.
- So `matchScorecard` for v2 skips the event-voting slot assignment (`bestOrder`) and
  returns `slots` and `mixed` directly, in the same shape as now. The wizard
  (`goToStep(4)`) then needs no change.
- If A/B can't be read for a side (see the card changes above), leave that side's men
  unslotted in pair order and say so in the warning. Guessing A as pairs 1 and 2 records
  four events with the wrong players and no visible error.

### 5. Header fields

v2's header is two boxed rows: `Date … Division …` and `Home … v Away …`. The
labels sit inline, so each value is "the tokens to the right of label X, up to the next
label" on that line. That is simpler than v1's "seed on the `v`" heuristic. The team pair
still goes through `matchFixturePair` and the date through `cardDateNear`, unchanged.

## Testing

- **There are no real v2 cards until the card is adopted.** Before building, fill in at
  least six by hand: different pens, writers and lighting, one rotated 90°, one photographed
  as the two-up sheet, one with a lowercase or scrawled A/B. Run each through Vision once and
  commit the responses as `test/fixtures/vision-v2-*.json`. That costs a few API calls,
  then everything is offline, as with the v1 fixtures. **Use invented names**: a filled
  card carries twelve real players' names (same rule as the document fixtures).
- Unit tests: the classifier on every existing v1 fixture still says v1, and **no v1
  extraction result changes**. Diff the full output before and after; the dispatcher must be
  a pure refactor for v1. Also the v2 fixtures, the A/B decode with its two-and-two
  constraint, the lady votes, and a v2 photo reaching neither extractor (cropped) giving
  `not-a-card`.
- Accuracy harness (`scripts/ocr-accuracy/`, gitignored): add `layout` to its output and
  report the two separately. v1 numbers must not move. Re-run once real v2 cards accrue
  in the bucket; the photos are already kept under their keys.

## Not in scope

- Changing the entry form or the data model. Nothing about Game1..Game18 changes.
- Retiring v1 extraction. It stays until uploads show no v1 cards for a full season.
- Stockport's card.
