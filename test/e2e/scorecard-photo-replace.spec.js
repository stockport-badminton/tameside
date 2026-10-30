// The superadmin "Replace photo" panel on the confirmation page.
//
// Reads a real draft (row 2176) from production like every other spec here; every write
// — the presign, the PUT, the conversion and the save — is answered by page.route, so
// nothing reaches S3 or the database.
const { test, expect } = require('@playwright/test');

const BUCKET = 'https://badmintontemp.s3.eu-west-1.amazonaws.com';
const ID = 2176;

async function mockWrites(page) {
  const signed = [];
  const saved = [];
  await page.route('**/sign-s3?**', (route) => {
    const name = new URL(route.request().url()).searchParams.get('file-name');
    signed.push(name);
    route.fulfill({ json: { signedUrl: `${BUCKET}/${encodeURIComponent(name)}?X-Amz-Signature=x` } });
  });
  await page.route(`${BUCKET}/**`, (route) => route.fulfill({ status: 200 }));
  await page.route('**/scorecard-document/convert', (route) => route.fulfill({ json: { ok: true, converted: false } }));
  await page.route(`**/add-scorecard-photo/${ID}`, (route) => {
    saved.push(route.request().postDataJSON());
    route.fulfill({ json: { ok: true } });
  });
  return { signed, saved };
}

// A 1x1 png.
const PNG = {
  name: 'card.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
};

test('choosing a file previews it, and nothing is saved until "Use this file"', async ({ page }) => {
  const { signed, saved } = await mockWrites(page);
  await page.goto(`/populated-scorecard-beta/${ID}`);
  const panel = page.locator('#scorecard-photo-panel');
  await expect(panel).toBeVisible();

  await panel.locator('#replace-photo-file').setInputFiles(PNG);
  await expect(panel.locator('#replace-photo-img')).toBeVisible();
  await expect(panel.locator('#replace-photo-name')).toHaveText('card.png');
  await expect(panel.locator('#replace-photo-save')).toBeEnabled();
  expect(saved).toEqual([]);

  // Its own key, so the photo being replaced is never overwritten in the bucket.
  expect(signed).toHaveLength(1);
  expect(signed[0]).toMatch(new RegExp(`^tameside-scorecard-${ID}-\\d+\\.png$`));

  await Promise.all([page.waitForEvent('load'), panel.locator('#replace-photo-save').click()]);
  expect(saved).toEqual([{ imgURL: `${BUCKET}/${encodeURIComponent(signed[0])}` }]);
});

test('a refused save says why and can be retried', async ({ page }) => {
  await mockWrites(page);
  await page.unroute(`**/add-scorecard-photo/${ID}`);
  await page.route(`**/add-scorecard-photo/${ID}`, (route) =>
    route.fulfill({ status: 400, json: { ok: false, error: 'That is not an uploaded scorecard photo.' } }));
  await page.goto(`/populated-scorecard-beta/${ID}`);
  const panel = page.locator('#scorecard-photo-panel');
  await panel.locator('#replace-photo-file').setInputFiles(PNG);
  await panel.locator('#replace-photo-save').click();
  await expect(panel.locator('#replace-photo-status')).toContainText('not an uploaded scorecard photo');
  await expect(panel.locator('#replace-photo-save')).toBeEnabled();
});
