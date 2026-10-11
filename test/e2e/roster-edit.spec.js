// Browser coverage for the team-management editor (ported from Stockport's
// e2e/roster-edit.spec.js, Oct 2026).
//
// The page this replaced bound only dragstart/dragover/drop, so nothing on it worked on
// a touchscreen; its Move Up / Move Down items were never wired. Both are JavaScript-only
// failures the node:test suite cannot reach.
//
// **The dev server here talks to the PRODUCTION database** (there is no local one), so
// "these tests don't write" is enforced, not assumed: readOnly() aborts every mutating
// request the browser makes and assertNoWrites() fails the test if one was attempted. The
// tests that exercise a write (Save, create) answer it inside the browser with
// page.route, so it never reaches the server. Stockport's suite runs against a local
// Docker database and can afford to be less strict; this one can't.

const { test, expect } = require('@playwright/test');
const { readOnly } = require('./helpers/read-only');

// Any club with enough players to reorder. Resolved once from the picker rather
// than hardcoded, so the suite doesn't depend on one club's roster staying put.
async function openBiggestClubEditor(page) {
  await page.goto('/manage-players');
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible();

  const target = await rows.evaluateAll(function (trs) {
    let best = null;
    for (const tr of trs) {
      const link = tr.querySelector('a[href^="/manage-players/club-"]');
      const players = parseInt(tr.children[2] && tr.children[2].textContent, 10) || 0;
      if (!link) continue;
      if (!best || players > best.players) {
        best = { href: link.getAttribute('href'), players: players };
      }
    }
    return best;
  });

  expect(target, 'no club with players found on the picker').not.toBeNull();
  await page.goto(target.href + '/edit');
  await expect(page.locator('.roster-card').first()).toBeVisible();
}

// The first list on the page holding at least `n` players.
function listWithAtLeast(page, n) {
  return page.locator('.roster-list').filter({ has: page.locator('.roster-row') }).filter({
    has: page.locator(`.roster-row:nth-child(${n})`)
  }).first();
}

async function namesIn(list) {
  return list.locator('.roster-row .player-name').allTextContents();
}

async function ranksIn(list) {
  return list.locator('.roster-row .rank').allTextContents();
}

// A nominated list with at least two players whose team also has reserves of the
// same gender — the pairing the drop-target bug needed, since the row was flung
// into whichever list came next in the array.
async function nominatedWithReserves(page) {
  const key = await page.locator('.roster-list').evaluateAll(function (lists) {
    for (const l of lists) {
      if (l.dataset.section !== 'nominated') continue;
      if (l.querySelectorAll('.roster-row').length < 2) continue;
      const reserve = document.querySelector('.roster-list[data-team="' + l.dataset.team +
        '"][data-gender="' + l.dataset.gender + '"][data-section="reserve"]');
      if (reserve && reserve.querySelectorAll('.roster-row').length) {
        return { team: l.dataset.team, gender: l.dataset.gender };
      }
    }
    return null;
  });
  expect(key, 'no team with both nominated players and reserves of one gender').not.toBeNull();

  const base = `.roster-list[data-team="${key.team}"][data-gender="${key.gender}"]`;
  return {
    nominated: page.locator(`${base}[data-section="nominated"]`),
    reserve: page.locator(`${base}[data-section="reserve"]`)
  };
}

// Puts a row a fixed distance below the top of the window, so a test's coordinates
// stay valid: measure something near an edge and the drag's own edge-scrolling
// moves the page out from under it.
async function parkNearTop(locator, offset = 140) {
  await locator.evaluate(function (el, y) {
    // Instant: Bootstrap 5's `scroll-behavior: smooth` would still be scrolling when the
    // test measured, and every coordinate after that would be stale.
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    window.scrollBy({ top: el.getBoundingClientRect().top - y, behavior: 'instant' });
  }, offset);
}

test.describe('roster editor', () => {
  test('renders one card per team with numbered lists', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    const cards = page.locator('.roster-card');
    expect(await cards.count()).toBeGreaterThan(0);

    // Four lists per card: nominated and reserve, men and ladies. Ranks are per
    // (team, gender), so a team's number 1 man and number 1 lady both show as 1.
    const firstCard = cards.first();
    await expect(firstCard.locator('.roster-list')).toHaveCount(4);

    // The rank is on screen at all — the old page held it only in a data attribute.
    const list = listWithAtLeast(page, 2);
    expect(await ranksIn(list)).toEqual(expect.arrayContaining(['1', '2']));

    guard.assertNoWrites();
  });

  test('the save bar is hidden until something moves', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);
    await expect(page.locator('#roster-savebar')).toBeHidden();
    guard.assertNoWrites();
  });

  // The headline fix. Pointer events cover mouse, touch and pen from one path;
  // Playwright's mouse drives them the same way a real pointer does.
  test('dragging a handle reorders the list and renumbers it', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    const list = listWithAtLeast(page, 2);
    const before = await namesIn(list);

    const firstHandle = list.locator('.roster-row').first().locator('.drag-handle');
    const secondRow = list.locator('.roster-row').nth(1);

    const from = await firstHandle.boundingBox();
    const to = await secondRow.boundingBox();

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Two moves: the first starts the drag, the second carries the row past the
    // midpoint of the row below it.
    await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2 + 4, { steps: 8 });
    await page.mouse.up();

    const after = await namesIn(list);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);

    // Renumbered in place, so the top of the list is still 1.
    const ranks = await ranksIn(list);
    expect(ranks[0]).toBe('1');
    expect(ranks[1]).toBe('2');

    // And it is only a pending change until Save.
    await expect(page.locator('#roster-savebar')).toBeVisible();
    await expect(page.locator('#roster-savebar-msg')).toContainText('moved');

    guard.assertNoWrites();
  });

  // Move Up / Move Down were the only non-drag path on the old page and they had
  // no handlers at all, which is why there was no keyboard or touch fallback.
  test('the arrow keys reorder from a focused handle', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    const list = listWithAtLeast(page, 2);
    const before = await namesIn(list);

    await list.locator('.roster-row').first().locator('.drag-handle').focus();
    await page.keyboard.press('ArrowDown');

    const after = await namesIn(list);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);

    // Focus follows the row so the key can be pressed again.
    await page.keyboard.press('ArrowUp');
    expect(await namesIn(list)).toEqual(before);

    // Back where it started, so there is nothing to save.
    await expect(page.locator('#roster-savebar')).toBeHidden();

    guard.assertNoWrites();
  });

  test('the row menu opens and its move items work', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    const list = listWithAtLeast(page, 2);
    const before = await namesIn(list);

    await list.locator('.roster-row').first().locator('.row-menu-btn').click();
    const menu = page.locator('.roster-menu');
    await expect(menu).toBeVisible();

    // Every item is wired, including the two that never were.
    await expect(menu.getByRole('button', { name: 'Move up' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Move down' })).toBeVisible();
    await expect(menu.getByRole('button', { name: /Make reserve|Make nominated/ })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Move to another team…' })).toBeVisible();

    // Move up is disabled at the top of a nominated list rather than silently
    // doing nothing.
    await expect(menu.getByRole('button', { name: 'Move up' })).toBeDisabled();

    await menu.getByRole('button', { name: 'Move down' }).click();
    const after = await namesIn(list);
    expect(after[0]).toBe(before[1]);

    guard.assertNoWrites();
  });

  // `.roster-card` carried `overflow: hidden`, so the menu was cut off at the card's
  // edge for every player in the bottom half of a team — and a rank-8 man is exactly
  // who you open it for.
  test('the row menu of a player at the foot of a card is not clipped', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    // The last player in the first populated card: below them is only the Add
    // button and the card's own bottom edge. The last card on the page would do as
    // well, but it can't be scrolled away from the foot of the window, and a row
    // there flips its menu upwards for a different reason.
    const row = page.locator('.roster-card')
      .filter({ has: page.locator('.roster-row') }).first()
      .locator('.roster-row').last();
    await parkNearTop(row);
    await row.locator('.row-menu-btn').click();

    const menu = page.locator('.roster-menu');
    await expect(menu).toBeVisible();

    // Asserted against the ancestors rather than the pixels. A clipped element still
    // reports its full getBoundingClientRect — it just isn't painted — and whether
    // any given row's menu happens to spill past its card depends on which gender
    // column is taller, which is a property of the club's roster, not of the page.
    // "Nothing between the menu and the body clips" is the actual invariant.
    const clipper = await menu.evaluate(function (el) {
      for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        var style = getComputedStyle(p);
        if (style.overflowY !== 'visible' || style.overflowX !== 'visible') {
          return p.className || p.tagName;
        }
      }
      return null;
    });
    expect(clipper, 'an ancestor clips the row menu').toBeNull();

    // And it really is painted where it says it is.
    const painted = await menu.evaluate(function (el) {
      const box = el.getBoundingClientRect();
      const at = document.elementFromPoint(box.left + box.width / 2, box.bottom - 4);
      return !!(at && el.contains(at));
    });
    expect(painted, 'the bottom of the row menu is covered').toBe(true);

    guard.assertNoWrites();
  });

  test('the row menu opens upwards when the row is near the bottom of the window', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    // A short window, so "near the bottom" doesn't depend on how tall this club's
    // roster happens to be.
    await page.setViewportSize({ width: 1280, height: 420 });
    const row = page.locator('.roster-row').first();
    await row.evaluate(function (el) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      window.scrollBy({ top: el.getBoundingClientRect().top - (window.innerHeight - 60), behavior: 'instant' });
    });
    await row.locator('.row-menu-btn').click({ force: true });

    const menu = page.locator('.roster-menu');
    await expect(menu).toHaveClass(/drop-up/);
    const box = await menu.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);

    guard.assertNoWrites();
  });

  // The old drop-target search took the first list that would accept an insert,
  // scanning nominated before reserve — and a pointer *above* a list still tests as
  // "before its first row". So dragging the last nominated player upwards, into the
  // gap between the row above's midpoint and its bottom edge, matched nothing in the
  // nominated list, fell through to the reserve list, and dropped them at the top of
  // the reserves.
  test('dragging the last nominated player upwards does not drop them into the reserves',
    async ({ page, baseURL }) => {
      const guard = await readOnly(page, baseURL);
      await openBiggestClubEditor(page);

      const { nominated, reserve } = await nominatedWithReserves(page);
      const names = await namesIn(nominated);
      const reserves = await namesIn(reserve);

      const last = nominated.locator('.roster-row').last();
      const above = nominated.locator('.roster-row').nth(names.length - 2);
      await parkNearTop(last, 200);

      const from = await last.locator('.drag-handle').boundingBox();
      const aboveBox = await above.boundingBox();
      const x = from.x + from.width / 2;

      await page.mouse.move(x, from.y + from.height / 2);
      await page.mouse.down();

      // Into the dead zone: past the row above, but not yet halfway up it.
      await page.mouse.move(x, aboveBox.y + aboveBox.height * 0.75, { steps: 6 });
      expect(await namesIn(reserve)).toEqual(reserves);
      expect(await namesIn(nominated)).toEqual(names);

      // Carry on past its midpoint and the swap happens, as it should.
      await page.mouse.move(x, aboveBox.y + aboveBox.height * 0.25, { steps: 6 });
      await page.mouse.up();

      const after = await namesIn(nominated);
      expect(after[names.length - 2]).toBe(names[names.length - 1]);
      expect(after[names.length - 1]).toBe(names[names.length - 2]);
      expect(await namesIn(reserve)).toEqual(reserves);

      guard.assertNoWrites();
    });

  // The row is positioned from the pointer's offset within it, re-derived after every
  // DOM move. The old code reset the transform to zero and re-baselined the pointer
  // instead, so the row snapped into its new slot rather than staying under the
  // finger — which reads as the drag catching on things.
  test('the dragged row stays under the pointer across a swap', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    const list = listWithAtLeast(page, 3);
    const first = list.locator('.roster-row').first();
    const third = list.locator('.roster-row').nth(2);
    await parkNearTop(first, 200);

    const from = await first.locator('.drag-handle').boundingBox();
    const thirdBox = await third.boundingBox();
    const x = from.x + from.width / 2;
    // Grabbed near the top of the handle, not its centre. That is the whole point:
    // the old code re-baselined the pointer on every swap, which only happens to be
    // a no-op when the row is held exactly at its own middle.
    const grabY = from.y + 4;

    await page.mouse.move(x, grabY);
    await page.mouse.down();
    const offset = grabY - (await first.boundingBox()).y;

    // Two swaps' worth of travel, stopping a third of the way into the last row so
    // the row is mid-gesture rather than settled on a boundary.
    const at = thirdBox.y + thirdBox.height * 0.7;
    await page.mouse.move(x, at, { steps: 12 });

    const grabbed = await page.locator('.roster-row.grabbed').boundingBox();
    expect(Math.abs(at - grabbed.y - offset)).toBeLessThanOrEqual(2);

    await page.mouse.up();
    guard.assertNoWrites();
  });

  // Holding a dragged row at the foot of the window scrolls the page, and the row comes
  // with it. On this site that needs scrollBy({behavior: 'instant'}): Bootstrap 5's
  // `scroll-behavior: smooth` left pageYOffset unmoved when the editor read it back, so
  // the row was left behind while the page slid away.
  test('dragging to the bottom edge scrolls the page and the row follows', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await page.setViewportSize({ width: 1280, height: 600 });
    await openBiggestClubEditor(page);
    const first = page.locator('.roster-list').filter({ has: page.locator('.roster-row') }).first()
      .locator('.roster-row').first();
    await parkNearTop(first, 200);
    const from = await first.locator('.drag-handle').boundingBox();
    const x = from.x + from.width / 2;
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    const scrolledBefore = await page.evaluate(() => window.pageYOffset);
    await page.mouse.move(x, 590, { steps: 10 });
    await page.waitForTimeout(600);
    const scrolledAfter = await page.evaluate(() => window.pageYOffset);
    expect(scrolledAfter, 'the page did not scroll during the drag').toBeGreaterThan(scrolledBefore + 50);
    const grabbed = await page.locator('.roster-row.grabbed').boundingBox();
    // Still under the pointer (allowing for where in the handle it was grabbed).
    expect(Math.abs(grabbed.y + grabbed.height / 2 - 590)).toBeLessThan(grabbed.height);
    await page.mouse.up();
    guard.assertNoWrites();
  });

  test('Discard puts everything back', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    const list = listWithAtLeast(page, 2);
    const before = await namesIn(list);

    await list.locator('.roster-row').first().locator('.drag-handle').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#roster-savebar')).toBeVisible();

    await page.locator('#roster-discard').click();
    expect(await namesIn(list)).toEqual(before);
    await expect(page.locator('#roster-savebar')).toBeHidden();

    guard.assertNoWrites();
  });

  // Three labelled outcomes instead of one Add button that chose between them by
  // reading a property it had set on an <option> element.
  test('the add dialog separates creating, adopting and transferring', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    await page.locator('.roster-add-btn').first().click();
    const modal = page.locator('#rosterAddModal');
    await expect(modal).toBeVisible();

    // Creating is always available, and clearly its own action.
    await expect(modal.locator('#rosterCreateBtn')).toBeVisible();

    // A surname common enough to match somewhere in the league. The search is a
    // GET, so it is allowed through the guard.
    await modal.locator('#rosterAddSearch').fill('an');
    await modal.locator('#rosterAddSearchBtn').click();

    const results = modal.locator('#rosterAddResults');
    // Two groups always; a third, "Already registered at this club", only when the
    // club itself has a match — which a common fragment usually will.
    await expect(results).toContainText('Registered to no club');
    await expect(results).toContainText('Already at another club');
    expect(await results.locator('.result-group').count()).toBeGreaterThanOrEqual(2);

    guard.assertNoWrites();
  });

  // Typing a name straight into "create" used to go through without anything
  // comparing it to the table. The server now answers 409 with its closest matches;
  // this pins what the page does with that answer. The POST is fulfilled here, in
  // the browser, so nothing reaches the server and the test stays read-only.
  test('creating someone who may already exist asks first', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    const bodies = [];
    await page.route('**/api/roster/club-*/players', async route => {
      const body = route.request().postDataJSON();
      bodies.push(body);
      if (!body.confirmNew) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'This player may already be registered.',
            possibleDuplicates: [{ playerId: 999999, name: 'Marry Whitle', gender: body.gender, clubName: 'Elsewhere', teamName: 'Elsewhere A', where: 'otherClubs', match: 'close' }]
          })
        });
      } else {
        // Stop here: the confirmed create is the write, and this test only needs to
        // see that it was asked for.
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'stopped by test' }) });
      }
    });

    await page.locator('.roster-add-btn').first().click();
    const modal = page.locator('#rosterAddModal');
    await expect(modal).toBeVisible();
    await modal.locator('#rosterNewFirst').fill('Mary');
    await modal.locator('#rosterNewFamily').fill('Whitle');
    await modal.locator('#rosterCreateBtn').click();

    const results = modal.locator('#rosterAddResults');
    await expect(results).toContainText('Mary Whitle may already be registered');
    await expect(results).toContainText('Marry Whitle');
    await expect(results.getByRole('button', { name: 'Transfer here' })).toBeVisible();

    await results.getByRole('button', { name: /create Mary Whitle as a new player/ }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[0].confirmNew).toBe(false);
    expect(bodies[1].confirmNew).toBe(true);

    guard.assertNoWrites();
  });

  // Save posts the intended order per team; the server renumbers. Answered here, in the
  // browser, so nothing is written.
  test('Save posts each changed team\'s lists, including a promoted reserve', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    const posted = [];
    await page.route('**/api/teams/*/order', async (route) => {
      posted.push({ url: route.request().url(), body: route.request().postDataJSON() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, updated: 1, ranks: [] }) });
    });
    await openBiggestClubEditor(page);

    const { nominated, reserve } = await nominatedWithReserves(page);
    const promoted = (await namesIn(reserve))[0];
    const row = reserve.locator('.roster-row').first();
    const playerId = await row.getAttribute('data-player-id');
    await row.locator('.row-menu-btn').click();
    await page.locator('.roster-menu').getByRole('button', { name: 'Make nominated' }).click();
    expect(await namesIn(nominated)).toContain(promoted);

    await page.locator('#roster-save').click();
    await expect.poll(() => posted.length).toBe(1);
    const { body } = posted[0];
    const team = await nominated.getAttribute('data-team');
    const gender = await nominated.getAttribute('data-gender');
    expect(posted[0].url).toContain('/api/teams/' + team + '/order');
    const nom = body.sections.find((s) => s.gender === gender && s.section === 'nominated');
    const res = body.sections.find((s) => s.gender === gender && s.section === 'reserve');
    // Membership travels in the payload: that is what makes a promotion savable (the
    // Stockport 06824a0 bug was the server reading it from the stored rank instead).
    expect(nom.playerIds).toContain(Number(playerId));
    expect(res.playerIds).not.toContain(Number(playerId));
    await expect(page.locator('#roster-savebar')).toBeHidden();
    guard.assertNoWrites();
  });

  test('a refused save says so and reloads to the saved state', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await page.route('**/api/teams/*/order', (route) => route.fulfill({
      status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Forbidden' }) }));
    await openBiggestClubEditor(page);
    const list = listWithAtLeast(page, 2);
    await list.locator('.roster-row').first().locator('.drag-handle').focus();
    await page.keyboard.press('ArrowDown');
    const reloaded = page.waitForEvent('load');
    await page.locator('#roster-save').click();
    await expect(page.locator('#roster-toast')).toContainText('Forbidden');
    await reloaded;
    guard.assertNoWrites();
  });

  test('the move dialog offers the club other teams', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    const list = listWithAtLeast(page, 1);
    await list.locator('.roster-row').first().locator('.row-menu-btn').click();
    await page.locator('.roster-menu').getByRole('button', { name: 'Move to another team…' }).click();

    const modal = page.locator('#rosterMoveModal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#rosterMoveTeam')).toBeVisible();
    await expect(modal.locator('#rosterMoveSection')).toBeVisible();

    // Defaults to a team other than the one the player is already in.
    const card = list.locator('xpath=ancestor::div[contains(@class,"roster-card")]');
    const currentTeam = await card.getAttribute('data-team-id');
    expect(await modal.locator('#rosterMoveTeam').inputValue()).not.toBe(currentTeam);

    await modal.getByRole('button', { name: 'Cancel' }).click();
    guard.assertNoWrites();
  });
});

test.describe('roster editor on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  // The layout finding: `<div class="container row">` with a bare `.col` per team
  // put every team in one non-wrapping row, so five teams got about 60px each. The
  // cards are now a grid that reflows to one column.
  test('team cards stack instead of sharing one row', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    const cards = page.locator('.roster-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(1);

    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();

    // Stacked: the second card starts below the first, not beside it.
    expect(second.y).toBeGreaterThan(first.y + first.height - 2);
    // And each is close to the full width rather than a sliver.
    expect(first.width).toBeGreaterThan(300);

    guard.assertNoWrites();
  });

  test('the page does not scroll sideways', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);
    const overflow = await page.evaluate(function () {
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
    guard.assertNoWrites();
  });

  // The whole point. On the old page this gesture did nothing at all, because
  // mobile browsers don't synthesise dragstart/drop from touch.
  test('a touch drag reorders the list', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await openBiggestClubEditor(page);

    const list = listWithAtLeast(page, 2);
    const before = await namesIn(list);

    const handle = list.locator('.roster-row').first().locator('.drag-handle');
    const secondRow = list.locator('.roster-row').nth(1);
    const from = await handle.boundingBox();
    const to = await secondRow.boundingBox();

    // Real touch pointer events, not a synthesised mouse drag.
    await page.locator('body').evaluate(function () { window.scrollTo({ top: 0, behavior: 'instant' }); });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.x + from.width / 2, y: from.y + from.height / 2 }]
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + from.width / 2, y: to.y + to.height / 2 + 4 }]
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    const after = await namesIn(list);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);

    guard.assertNoWrites();
  });
});

test.describe('read-only roster view', () => {
  test('is read-only and carries the contact details', async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await page.goto('/manage-players');
    const link = page.locator('a[href^="/manage-players/club-"]').first();
    const href = await link.getAttribute('href');
    await page.goto(href);

    await expect(page.locator('.roster-card').first()).toBeVisible();
    // Nothing editable.
    await expect(page.locator('.drag-handle')).toHaveCount(0);
    await expect(page.locator('.row-menu-btn')).toHaveCount(0);
    await expect(page.locator('#roster-savebar')).toHaveCount(0);
    // But the things a captain actually needs.
    await expect(page.locator('.roster-summary')).toBeVisible();
    await expect(page.locator('.roster-contact').first()).toBeVisible();
    await expect(page.locator('.roster-row .rank').first()).toBeVisible();

    guard.assertNoWrites();
  });
});
