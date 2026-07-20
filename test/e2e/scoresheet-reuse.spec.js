// Feature: if a scorecard photo was already uploaded via the step-1 OCR
// panel, step 13 shouldn't ask for it again. The OCR panel's own upload
// flow (S3 presign + Vision analysis) is out of scope here — this isolates
// step 13's own toggle logic by setting #scoresheet-url the way the OCR
// panel's success handler does (rather than driving a real photo upload),
// then reaching step 13 through the real wizard flow.
const { test, expect } = require('@playwright/test');
const { fillEventStepsAndReachStep13 } = require('./helpers');

test('step 13 offers to reuse an already-uploaded photo instead of asking again', async ({ page }) => {
  const modal = await fillEventStepsAndReachStep13(page, {
    simulateOcrUploadUrl: 'https://badmintontemp.s3.eu-west-1.amazonaws.com/tameside-ocr-test.jpg',
  });

  await expect(modal.locator('#scoresheet-already-uploaded-msg')).toBeVisible();
  await expect(modal.locator('#scoresheet-spreadsheet')).toBeHidden();

  // "upload a different photo instead" clears it and reveals the file input.
  await modal.locator('#replace-scoresheet-link').click();
  await expect(modal.locator('#scoresheet-already-uploaded-msg')).toBeHidden();
  await expect(modal.locator('#scoresheet-spreadsheet')).toBeVisible();
  await expect(modal.locator('#scoresheet-url')).toHaveValue('');
});

test('step 13 asks normally when no photo was uploaded yet', async ({ page }) => {
  const modal = await fillEventStepsAndReachStep13(page);

  await expect(modal.locator('#scoresheet-already-uploaded-msg')).toBeHidden();
  await expect(modal.locator('#scoresheet-spreadsheet')).toBeVisible();
});
