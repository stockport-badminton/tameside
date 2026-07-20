// Shared setup for e2e specs that need to reach the event-review steps (4-12)
// with real, AJAX-populated team/player data. Division 8 (Division 1) / teams
// 55 (Hyde A) vs 56 (Hyde B) are real dev-DB rows also used by the
// integration test suite (test/integration/email-scorecard.test.js) — reads
// only, no writes happen in these specs.
async function openWizardToStep4(page, { simulateOcrUploadUrl } = {}) {
  await page.goto('/email-scorecard');
  await page.getByRole('link', { name: 'Enter Result' }).click();
  const modal = page.locator('#signupModal');
  await expectVisible(modal);

  // Mirrors what the OCR panel's own success handler does at step 1, without
  // driving a real photo upload / Vision analysis in these specs.
  if (simulateOcrUploadUrl) {
    await page.evaluate((url) => { document.querySelector('#scoresheet-url').value = url; }, simulateOcrUploadUrl);
  }

  await modal.locator('#division').selectOption('8');
  await modal.locator('#homeTeam').selectOption('55');
  await modal.locator('#awayTeam').selectOption('56');

  // The player selects populate over AJAX after each team pick. <option>
  // elements aren't considered "visible" by Playwright even once populated,
  // so wait for them to be attached instead.
  await modal.locator('#homeMan1 option[value]:not([value=""])').first().waitFor({ state: 'attached' });
  await modal.locator('#awayMan1 option[value]:not([value=""])').first().waitFor({ state: 'attached' });

  // #homeMan1 etc. live on step 2 (hidden while step 1 is showing) — must
  // advance to step 2 before they're interactable.
  await clickContinue(modal, '1');

  await modal.locator('#homeMan1').selectOption({ index: 1 });
  await modal.locator('#homeMan2').selectOption({ index: 2 });
  await modal.locator('#homeMan3').selectOption({ index: 3 });
  await modal.locator('#homeMan4').selectOption({ index: 4 });
  await modal.locator('#homeLady1').selectOption({ index: 1 });
  await modal.locator('#homeLady2').selectOption({ index: 2 });

  await clickContinue(modal, '2');

  await modal.locator('#awayMan1').selectOption({ index: 1 });
  await modal.locator('#awayMan2').selectOption({ index: 2 });
  await modal.locator('#awayMan3').selectOption({ index: 3 });
  await modal.locator('#awayMan4').selectOption({ index: 4 });
  await modal.locator('#awayLady1').selectOption({ index: 1 });
  await modal.locator('#awayLady2').selectOption({ index: 2 });

  await clickContinue(modal, '3');

  return modal;
}

async function clickContinue(modal, currentStep) {
  await modal.locator(`.modal-footer button.step-${currentStep}:has-text("Continue")`).click();
}

async function expectVisible(locator) {
  await locator.waitFor({ state: 'visible' });
}

// Steps 4-12 each cover 2 consecutive games (step 4 -> games 1&2, ... step 12
// -> games 17&18). goToStep's own summary-building code reads the PREVIOUS
// step's mirrored player selects, which are only populated by the step-4
// special case, so these steps must be walked through in order — there's no
// safe way to jump straight to a later step.
async function fillEventStepsAndReachStep13(page, opts) {
  const modal = await openWizardToStep4(page, opts);
  for (let step = 4; step <= 12; step++) {
    const gameA = (step - 4) * 2 + 1;
    const gameB = gameA + 1;
    await modal.locator(`#Game${gameA}homeScore`).fill('21');
    await modal.locator(`#Game${gameA}awayScore`).fill('15');
    await modal.locator(`#Game${gameB}homeScore`).fill('21');
    await modal.locator(`#Game${gameB}awayScore`).fill('15');
    await clickContinue(modal, String(step));
  }
  await expectVisible(modal.locator('.modal-body.step-13'));
  return modal;
}

module.exports = { openWizardToStep4, fillEventStepsAndReachStep13, clickContinue, expectVisible };
