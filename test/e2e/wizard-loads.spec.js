// Smoke test: the fresh-entry wizard opens and step 1 renders with the OCR
// panel and a real division list (confirms the DEV_MODE Auth0 bypass keeps
// this page renderable, and that the modal-open + step-1 markup survived
// the fresh/error-form merge).
const { test, expect } = require('@playwright/test');

test('opens the wizard and shows step 1 with the OCR panel', async ({ page }) => {
  await page.goto('/email-scorecard');
  await expect(page.getByRole('link', { name: 'Enter Result' })).toBeVisible();

  await page.getByRole('link', { name: 'Enter Result' }).click();
  const modal = page.locator('#signupModal');
  await expect(modal).toBeVisible();

  await expect(modal.locator('#ocr-panel')).toBeVisible();
  await expect(modal.locator('.modal-body.step-1')).toBeVisible();
  await expect(modal.locator('#division option').first()).toBeAttached();

  // Non-current steps must stay hidden until navigated to.
  await expect(modal.locator('.modal-body.step-4')).toBeHidden();
});
