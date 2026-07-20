// Feature: live score validation blocks "Continue" on an event-review step
// (4-12) until both games have a legal badminton result, mirroring
// utils/scorecardValidation.js's isValidGameScore.
const { test, expect } = require('@playwright/test');
const { openWizardToStep4 } = require('./helpers');

test('an invalid game score blocks Continue and shows an inline error', async ({ page }) => {
  const modal = await openWizardToStep4(page);

  await expect(modal.locator('.modal-body.step-4')).toBeVisible();

  // Game 1: no winner (neither side reaches 21) — invalid.
  await modal.locator('#Game1homeScore').fill('15');
  await modal.locator('#Game1awayScore').fill('10');
  // Game 2: a legal result, so only game 1 should block progress.
  await modal.locator('#Game2homeScore').fill('21');
  await modal.locator('#Game2awayScore').fill('15');

  await modal.locator('.modal-footer button.step-4:has-text("Continue")').click();

  // Still on step 4 — the invalid score blocked navigation.
  await expect(modal.locator('.modal-body.step-4')).toBeVisible();
  await expect(modal.locator('.modal-body.step-5')).toBeHidden();
  await expect(modal.locator('#Game1homeScore')).toHaveClass(/is-invalid/);
  await expect(modal.locator('#Game1awayScore')).toHaveClass(/is-invalid/);
  await expect(modal.locator('.form-group.step-4.col-6 >> text=Enter a valid game score')).toBeVisible();

  // Fix the score to a legal result and try again — should now advance.
  await modal.locator('#Game1homeScore').fill('21');
  await modal.locator('#Game1awayScore').fill('15');
  await modal.locator('.modal-footer button.step-4:has-text("Continue")').click();

  await expect(modal.locator('.modal-body.step-5')).toBeVisible();
  await expect(modal.locator('.modal-body.step-4')).toBeHidden();
});

test('Back never gets blocked by score validation', async ({ page }) => {
  const modal = await openWizardToStep4(page);
  // Leave step 4's scores blank/invalid on purpose.
  await modal.locator('.modal-footer button.step-4:has-text("Back")').click();
  await expect(modal.locator('.modal-body.step-3')).toBeVisible();
});
