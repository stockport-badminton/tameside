# BL-01: Bootstrap 4 leftovers

**Size:** small · **Risk:** low (markup only), but it touches many views

## Why

The site is on Bootstrap 5, but the views still carry BS4 markup. None of it errors. It
just renders slightly wrong, or does nothing:

- **135 `<select class="form-control">`** across 8 views. In BS5 a select wants
  `form-select`. `form-control` on a select loses the dropdown arrow and gets the wrong
  padding. Count with `grep -ro '<select[^>]*form-control' views | wc -l`.
- **230 `form-group` / `form-row` classes.** BS5 has no CSS for either, so they are inert.
  The vertical spacing they used to give comes from nowhere now. Replace them with `mb-3` /
  `row g-3`, or drop them where the spacing doesn't matter.
- **Two dead `data-toggle="modal"`** in `views/index-scorecard.ejs` (lines 28 and 36). BS5
  reads `data-bs-toggle`, so the "Fix Errors" and "Enter Result" buttons open nothing. The view is still
  rendered, from two places in `controllers/fixtureController.js`.
- **The DataTables build** under `static/vendor/datatables/` is the bs4 styling integration
  (`views/datatables-controls.ejs` works around its layout). Swap it for the bs5 build.

## How

- Do the `data-toggle` pair first. It is the only item that is actually broken.
- Do the selects with a scripted replace, then look at each changed page. **The scorecard
  wizard's selects are built client-side** from `static/playerFormOptions.ejs` and
  `static/js/`, so grep there too, not just `views/`.
- Browse as superadmin, as `DEV_ROLE=admin DEV_CLUB=Hyde` and logged out. The admin branch
  is where most of the forms are.

## Done when

- The greps above return zero, or the leftovers are listed with a reason.
- `npm test` and `npm run test:e2e` pass (the wizard spec drives these selects).

## Outcome (23 Nov 2026)

All four greps are zero. What it turned up beyond the brief:

- **`form-row` was a live layout bug, not just dead markup.** The wizards' score boxes are
  `col-6` inside a `form-row`, and with no flex parent each one stacked at half width, so
  a game's home and away boxes read as a column of four. Now `row g-2`: one row per event.
- **`form-group` was a JS hook** in the three scorecard views (`.form-group.step-N`
  selects a step's fields) and on the reminder modal. Those are now `sc-field` and
  `#reminderEmailField`, so the spacing class (`mb-3`) isn't load-bearing.
- **"Enter Result" on `index-scorecard` can never show**: the success render passes no
  `result`. Only "Fix Errors" (the `POST /scorecard-beta` error page) was ever reachable.
- **DataTables is 1.13.11 (bs5), not 2.x.** `datatables-controls.ejs`'s `dom` and the
  `.dataTables_*` rules are 1.x names. The bs5 stylesheet sets
  `table.dataTable > tbody > tr { background-color: transparent }`, which blanked the
  status row colours on `/results` until the `.status-*` rules were spelled out against it.
- `form-select`'s arrow padding widened the filter bar past its line, so `.filter-fields`
  is `flex: 1 1 0` now. That also fixed Apply wrapping on the stats pages, which predated
  this.
- Also: `jumbotron` (inert, dropped), `no-gutters` → `g-0`, `font-weight-bold` →
  `fw-bold`, `text-left` → `text-start`.

Checked by before/after screenshots at desktop and phone width (wizard step 4, `/results`,
`/player-stats`, `/contact-us`). `npm test` 1578/1578, `npm run test:e2e` 65/65.
