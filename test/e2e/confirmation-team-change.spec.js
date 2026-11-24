// Changing a team on the confirmation page (/populated-scorecard-beta/:id) refills every
// roster select for that side, through static/js/form-options.js.
//
// It used to refill men 1-3 and a lady 3 that doesn't exist, so man 4 kept the OLD team's
// player; stepping forward then copied him into Second/Fourth Men's and Fourth Mixed.
// Reads row 2176 like scorecard-photo-replace.spec.js. The only requests are reads
// (GET /eligiblePlayers), guarded by read-only.js.
const { test, expect } = require('@playwright/test');
const { readOnly } = require('./helpers/read-only');

const ID = 2176;

for (const side of ['home', 'away']) {
  test(`a new ${side} team refills men 1-4 and ladies 1-2`, async ({ page, baseURL }) => {
    const guard = await readOnly(page, baseURL);
    await page.goto(`/populated-scorecard-beta/${ID}`);

    const before = await page.evaluate((s) => document.getElementById(s + 'Man4').value, side);

    // Any other real team in the list. The selects sit in a closed modal, so this sets the
    // value and fires the change the page listens for, rather than clicking.
    const changed = await page.evaluate((s) => {
      const team = document.getElementById(s + 'Team');
      const other = [...team.options].find((o) => o.value && o.value !== team.value);
      if (!other) return null;
      team.value = other.value;
      team.dispatchEvent(new Event('change', { bubbles: true }));
      return other.value;
    }, side);
    expect(changed, 'a second team to switch to').toBeTruthy();

    const ids = ['Man1', 'Man2', 'Man3', 'Man4', 'Lady1', 'Lady2'].map((r) => side + r);
    // Refilled: the placeholder is selected again in every one.
    for (const id of ids) {
      await expect(page.locator('#' + id)).toHaveValue('', { timeout: 10_000 });
    }
    const lists = await page.evaluate((list) => list.map((id) =>
      [...document.getElementById(id).options].map((o) => o.value)), ids);
    expect(lists[3], 'man 4 has the same list as man 1').toEqual(lists[0]);
    expect(lists[5], 'lady 2 has the same list as lady 1').toEqual(lists[4]);
    if (before && before !== '0') expect(lists[3]).not.toContain(before);

    await guard.assertNoWrites();
  });
}
