// Submit waits for a photo that is still uploading (Stockport 7ce8017).
//
// Submitting navigates, navigating kills the upload's fetch, and scoresheet-url is only
// filled once the upload finishes, so a captain who pressed Submit mid-upload used to file
// the scorecard with no photo. guardSubmit (static/js/scorecard-upload.js) holds the form
// until the upload settles. S3 is mocked, its PUT held until the test releases it, and the
// scorecard POST is answered here, so nothing reaches the server or the bucket.
const { test, expect } = require('@playwright/test');
const { fillEventStepsAndReachStep13, clickContinue } = require('./helpers');

const BUCKET = 'https://badmintontemp.s3.eu-west-1.amazonaws.com';
const JPEG = { name: 'card.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };

async function holdUpload(page, { status = 200 } = {}) {
  await page.route('**/sign-s3?**', (route) => {
    const name = new URL(route.request().url()).searchParams.get('file-name');
    route.fulfill({ json: { signedUrl: `${BUCKET}/${encodeURIComponent(name)}?X-Amz-Signature=x` } });
  });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  await page.route(`${BUCKET}/**`, async (route) => { await released; route.fulfill({ status }); });
  const submitted = [];
  await page.route('**/email-scorecard', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    submitted.push(new URLSearchParams(route.request().postData()).get('scoresheet-url'));
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>filed</p>' });
  });
  return { release, submitted };
}

async function attachAndSubmit(page) {
  const modal = await fillEventStepsAndReachStep13(page);
  await modal.locator('#scoresheet-spreadsheet').setInputFiles(JPEG);
  await clickContinue(modal, '13');
  await modal.locator('#signup').click();
  return modal;
}

test('Submit during an upload waits for it, then files the scorecard with the photo', async ({ page }) => {
  const { release, submitted } = await holdUpload(page);
  const modal = await attachAndSubmit(page);

  await expect(modal.locator('#signup')).toHaveText('Uploading photo…');
  await expect(modal.locator('#signup')).toBeDisabled();
  await page.waitForTimeout(500);
  expect(submitted).toEqual([]);

  release();
  await expect(page.locator('body')).toContainText('filed');
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatch(/^https:\/\/badmintontemp\.s3\.eu-west-1\.amazonaws\.com\/tameside-/);
});

test('a failed upload sends nothing, says so, and a second press files without the photo', async ({ page }) => {
  const { release, submitted } = await holdUpload(page, { status: 500 });
  const modal = await attachAndSubmit(page);
  release();

  await expect(modal.locator('.upload-wait-note')).toContainText('The photo did not upload');
  await expect(modal.locator('#signup')).toBeEnabled();
  expect(submitted).toEqual([]);

  await modal.locator('#signup').click();
  await expect(page.locator('body')).toContainText('filed');
  expect(submitted).toEqual(['']);
});
