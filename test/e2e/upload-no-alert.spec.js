// A successful step-13 upload raises no dialog.
//
// uploadFile used to alert "Uploaded successfuly to <presigned URL>" on every upload: a
// live upload credential shown to the captain, and a dialog they had to dismiss. S3 is
// mocked; nothing reaches the bucket.
const { test, expect } = require('@playwright/test');
const { fillEventStepsAndReachStep13 } = require('./helpers');

const BUCKET = 'https://badmintontemp.s3.eu-west-1.amazonaws.com';

test('a successful step-13 upload shows the photo and no dialog', async ({ page }) => {
  await page.route('**/sign-s3?**', (route) => {
    const name = new URL(route.request().url()).searchParams.get('file-name');
    route.fulfill({ json: { signedUrl: `${BUCKET}/${encodeURIComponent(name)}?X-Amz-Signature=secret` } });
  });
  await page.route(`${BUCKET}/**`, (route) => route.fulfill({ status: 200 }));
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });

  const modal = await fillEventStepsAndReachStep13(page);
  await modal.locator('#scoresheet-spreadsheet').setInputFiles({
    name: 'card.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  await expect(modal.locator('#scoresheet-url')).toHaveValue(/^https:\/\/badmintontemp\.s3\.eu-west-1\.amazonaws\.com\/tameside-/);
  expect(dialogs).toEqual([]);
});
