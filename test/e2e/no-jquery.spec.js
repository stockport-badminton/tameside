// The wizard must work when code.jquery.com never loads.
//
// 6 Oct 2026: a captain's "Read & prefill" read the card fine and then failed with
// "$ is not defined", and the division/team dropdowns were dead too. Something on
// their side blocked the CDN — the same person uses the Stockport site daily, and
// that one serves jQuery from its own origin. This page now uses no jQuery, so every
// spec here aborts the CDN request to prove it.
const { test, expect } = require('@playwright/test');
const { fillEventStepsAndReachStep13, clickContinue, expectVisible } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await page.route('**://code.jquery.com/**', (route) => route.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.pageErrors = errors;
});

test.afterEach(async ({ page }) => {
  expect(page.pageErrors).toEqual([]);
});

test('the whole wizard runs to the summary without jQuery', async ({ page }) => {
  const modal = await fillEventStepsAndReachStep13(page);
  await clickContinue(modal, '13');
  await expectVisible(modal.locator('.modal-body.step-14'));

  // 18 games at 21-15 to home.
  await expect(modal.locator('#homeScore')).toHaveValue('18');
  await expect(modal.locator('#awayScore')).toHaveValue('0');
  await expect(modal.locator('#finalScore')).toContainText('Games:18-0');

  // Step summaries are built from the previous step's selects as you go.
  await expect(modal.locator('#FirstMensSummary')).toContainText('21-15');
  // Step 4 rebuilt the per-event selects from the step-2 picks.
  const man1 = await modal.locator('#homeMan1').inputValue();
  await expect(modal.locator('#FirstMenshomeMan1')).toHaveValue(man1);
});

test('Read & prefill fills the form without jQuery', async ({ page }) => {
  // The upload and the Vision read are mocked; what is under test is the page
  // filling itself in from the answer, which is where "$ is not defined" was thrown.
  await page.route('**/sign-s3?**', (route) => route.fulfill({
    json: { signedUrl: 'https://badmintontemp.s3.eu-west-1.amazonaws.com/tameside-ocr-x.jpg?X-Amz-Signature=x' },
  }));
  await page.route('https://badmintontemp.s3.eu-west-1.amazonaws.com/**', (route) => route.fulfill({ status: 200 }));
  const games = {};
  for (let g = 1; g <= 18; g++) { games[`Game${g}homeScore`] = 21; games[`Game${g}awayScore`] = 12; }
  await page.route('**/scorecard-ocr/analyse', (route) => route.fulfill({
    json: {
      ok: true,
      divisionId: 8,
      teams: { home: { id: 55, name: 'Hyde A' }, away: { id: 56, name: 'Hyde B' } },
      result: { home: 18, away: 0 },
      games,
      date: '2026-09-30',
      slots: { home: { men: [], ladies: [] }, away: { men: [], ladies: [] } },
      warnings: [],
    },
  }));

  await page.goto('/email-scorecard');
  await page.getByRole('link', { name: 'Enter Result' }).click();
  const modal = page.locator('#signupModal');
  await expectVisible(modal);

  await modal.locator('#ocr-file').setInputFiles({ name: 'card.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff]) });
  await modal.locator('#ocr-go').click();

  await expect(modal.locator('#ocr-status')).toContainText('✓ Read Hyde A v Hyde B');
  await expect(modal.locator('#division')).toHaveValue('8');
  await expect(modal.locator('#homeTeam')).toHaveValue('55');
  await expect(modal.locator('#awayTeam')).toHaveValue('56');
  await expect(modal.locator('#Game1homeScore')).toHaveValue('21');
  await expect(modal.locator('#date')).toHaveValue('2026-09-30');
  // Picking the teams cascaded into the player selects.
  await modal.locator('#homeMan1 option[value]:not([value=""])').first().waitFor({ state: 'attached' });
});
