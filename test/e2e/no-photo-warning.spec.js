// Submitting without a scorecard photo takes two presses (views/email-scorecard.ejs,
// noPhotoGuard). The photo is optional, and said so only when an upload failed, so a captain
// who typed the card in filed it without one and without noticing (row 2320, 5 Nov 2026).
// The scorecard POST is answered here, so nothing reaches the server.
const { test, expect } = require('@playwright/test');
const { fillEventStepsAndReachStep13, clickContinue } = require('./helpers');

const BUCKET = 'https://badmintontemp.s3.eu-west-1.amazonaws.com';
const JPEG = { name: 'card.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };

async function catchSubmit(page) {
  const submitted = [];
  await page.route('**/email-scorecard', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    submitted.push(new URLSearchParams(route.request().postData()).get('scoresheet-url'));
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>filed</p>' });
  });
  return submitted;
}

test('with no photo, the summary warns, and the first Submit only arms the button', async ({ page }) => {
  const submitted = await catchSubmit(page);
  const modal = await fillEventStepsAndReachStep13(page);
  await clickContinue(modal, '13');

  const warning = modal.locator('#no-photo-warning');
  await expect(warning).toBeVisible();
  await expect(modal.locator('#signup')).toHaveText('Submit');

  await modal.locator('#signup').click();
  await expect(modal.locator('#signup')).toHaveText('Submit without a photo');
  await page.waitForTimeout(300);
  expect(submitted).toEqual([]);

  await modal.locator('#signup').click();
  await expect(page.locator('body')).toContainText('filed');
  expect(submitted).toEqual(['']);
});

test('"Add the photo" goes back to the upload, and with a photo there is no warning', async ({ page }) => {
  const submitted = await catchSubmit(page);
  await page.route('**/sign-s3?**', (route) => {
    const name = new URL(route.request().url()).searchParams.get('file-name');
    route.fulfill({ json: { signedUrl: `${BUCKET}/${encodeURIComponent(name)}?X-Amz-Signature=x` } });
  });
  await page.route(`${BUCKET}/**`, (route) => route.fulfill({ status: 200 }));

  const modal = await fillEventStepsAndReachStep13(page);
  await clickContinue(modal, '13');
  await modal.locator('#signup').click();   // arms
  await modal.locator('#no-photo-add').click();
  await expect(modal.locator('#scoresheet-spreadsheet')).toBeVisible();

  await modal.locator('#scoresheet-spreadsheet').setInputFiles(JPEG);
  await expect(modal.locator('#scoresheet-url')).toHaveValue(/^https:\/\/badmintontemp/);
  await clickContinue(modal, '13');
  await expect(modal.locator('#no-photo-warning')).toBeHidden();
  await expect(modal.locator('#signup')).toHaveText('Submit');

  await modal.locator('#signup').click();
  await expect(page.locator('body')).toContainText('filed');
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatch(/^https:\/\/badmintontemp\.s3\.eu-west-1\.amazonaws\.com\/tameside-/);
});
