// A pdf upload shows the captain what they attached.
//
// An <img> cannot draw a pdf, so a document upload used to show no preview at all, and in
// Oct 2026 a captain filed the card from a PREVIOUS match without being able to tell. The
// server now hands back a shrunk copy of the photo it pulled out of the document, and the
// box always names the file. S3, the conversion and the read are all mocked here; what is
// under test is the page putting the answer on screen and recording the right url.
const { test, expect } = require('@playwright/test');
const { fillEventStepsAndReachStep13, expectVisible } = require('./helpers');

const BUCKET = 'https://badmintontemp.s3.eu-west-1.amazonaws.com';
// A 1x1 png: anything an <img> can actually draw.
const PREVIEW = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF = { name: 'Hyde v Shell.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') };

async function mockUpload(page, convertAnswer) {
  await page.route('**/sign-s3?**', (route) => {
    const name = new URL(route.request().url()).searchParams.get('file-name');
    route.fulfill({ json: { signedUrl: `${BUCKET}/${encodeURIComponent(name)}?X-Amz-Signature=x` } });
  });
  await page.route(`${BUCKET}/**`, (route) => route.fulfill({ status: 200 }));
  const converted = [];
  await page.route('**/scorecard-document/convert', (route) => {
    const { key } = route.request().postDataJSON();
    converted.push(key);
    route.fulfill({ json: convertAnswer(key) });
  });
  return converted;
}

const convertsTo = (key) => {
  const photoKey = key.replace(/\.[^.]*$/, '-photo.jpg');
  return { ok: true, converted: true, key: photoKey, url: `${BUCKET}/${encodeURIComponent(photoKey)}`, preview: PREVIEW };
};

async function openWizard(page) {
  await page.goto('/email-scorecard');
  await page.getByRole('link', { name: 'Enter Result' }).click();
  const modal = page.locator('#signupModal');
  await expectVisible(modal);
  return modal;
}

test('Read & prefill with a pdf previews the extracted photo, even when the read fails', async ({ page }) => {
  const converted = await mockUpload(page, convertsTo);
  const analysed = [];
  await page.route('**/scorecard-ocr/analyse', (route) => {
    analysed.push(route.request().postDataJSON().key);
    route.fulfill({ status: 422, json: { ok: false, error: 'The card could not be read' } });
  });

  const modal = await openWizard(page);
  await modal.locator('#ocr-file').setInputFiles(PDF);
  await modal.locator('#ocr-go').click();
  await expect(modal.locator('#ocr-status')).toContainText('could not be read');

  expect(converted).toHaveLength(1);
  // The card is read from the extracted photo, not the pdf...
  expect(analysed).toEqual([converted[0].replace('.pdf', '-photo.jpg')]);
  // ...and the row records the photo even though the read failed.
  await expect(page.locator('#scoresheet-url')).toHaveValue(/-photo\.jpg$/);
  await expect(page.locator('#scoresheet-img')).toHaveAttribute('src', PREVIEW);
  await expect(page.locator('#scoresheet-doc-attached')).toContainText('Hyde v Shell.pdf');
});

test('a pdf the photo cannot be pulled out of, with no pdf viewer, still names the file', async ({ page }) => {
  await mockUpload(page, () => ({ ok: true, converted: false, reason: 'That file could not be read as a scorecard photo.' }));
  let analysed = false;
  await page.route('**/scorecard-ocr/analyse', (route) => { analysed = true; route.fulfill({ json: { ok: false } }); });

  const modal = await openWizard(page);
  await modal.locator('#ocr-file').setInputFiles(PDF);
  await modal.locator('#ocr-go').click();
  await expect(modal.locator('#ocr-status')).toContainText('could not be read as a scorecard photo');

  expect(analysed).toBe(false);
  await expect(page.locator('#scoresheet-url')).toHaveValue(/\.pdf$/);
  await expect(page.locator('#scoresheet-img')).toBeHidden();
  // Playwright's Chromium has no pdf viewer (pdfViewerEnabled is false), like Android Chrome.
  await expect(page.locator('#scoresheet-pdf')).toBeHidden();
  await expect(page.locator('#scoresheet-doc-attached')).toContainText('Hyde v Shell.pdf');
});

// The real case: the Oct 2026 card was a photocopier "compact PDF" the extractor declines
// (utils/documentImage.js, the MRC note). A browser with a pdf viewer shows the local file.
// Playwright's Chromium has no viewer, so this fakes the flag and checks the wiring; it
// was checked by eye in real Chrome with the actual card.
test('a pdf the photo cannot be pulled out of goes to the browser pdf viewer when there is one', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true }));
  await mockUpload(page, () => ({ ok: true, converted: false, reason: 'That file could not be read as a scorecard photo.' }));
  await page.route('**/scorecard-ocr/analyse', (route) => route.fulfill({ json: { ok: false } }));

  const modal = await openWizard(page);
  await modal.locator('#ocr-file').setInputFiles(PDF);
  await modal.locator('#ocr-go').click();
  await expect(modal.locator('#ocr-status')).toContainText('could not be read as a scorecard photo');

  await expect(page.locator('#scoresheet-pdf')).toHaveAttribute('src', /^blob:.*#toolbar=0/);
  await expect(page.locator('#scoresheet-img')).toBeHidden();
});

test('the step-13 upload box previews a pdf too', async ({ page }) => {
  await mockUpload(page, convertsTo);
  page.on('dialog', (d) => d.accept());

  const modal = await fillEventStepsAndReachStep13(page);
  await modal.locator('#scoresheet-spreadsheet').setInputFiles(PDF);

  await expect(modal.locator('#scoresheet-img')).toHaveAttribute('src', PREVIEW);
  await expect(modal.locator('#scoresheet-doc-attached')).toContainText('Hyde v Shell.pdf');
  await expect(modal.locator('#scoresheet-url')).toHaveValue(/-photo\.jpg$/);
});
