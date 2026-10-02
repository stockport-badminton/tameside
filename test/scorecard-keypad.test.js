// Score inputs must open the digit pad on a phone. `type="number"` alone gives iOS the
// full keyboard in its numbers layout; `inputmode="numeric"` gives the pad. Captains file
// from the club hall on a phone. (Stockport HARD-34.)
const { it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const VIEWS = ['email-scorecard.ejs', 'populated-scorecard.ejs', 'index-scorecard.ejs', 'admin/lewis-results.ejs'];

for (const v of VIEWS) {
  it(`${v}: every number input asks for the numeric keypad`, () => {
    const src = fs.readFileSync(path.join(__dirname, '../views', v), 'utf8');
    const inputs = src.match(/<input\b[^>]*type="number"[^>]*>/g) || [];
    assert.ok(inputs.length > 0, 'expected score inputs in ' + v);
    const missing = inputs.filter(i => !/inputmode="numeric"/.test(i));
    assert.deepStrictEqual(missing, []);
  });
}
