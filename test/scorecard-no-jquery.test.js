// The captain's scorecard wizard must not need jQuery. footer.ejs loads it from
// code.jquery.com only, and on 6 Oct 2026 a captain whose browser couldn't reach
// that CDN had a dead division/team cascade and "$ is not defined" from the OCR
// prefill. test/e2e/no-jquery.spec.js proves the page works with the CDN blocked;
// this catches a `$(` pasted back in from an older handler without a browser.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('email-scorecard.ejs uses no jQuery', () => {
  const src = fs.readFileSync(path.join(__dirname, '../views/email-scorecard.ejs'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const hits = code.match(/\$\(|\$\.\w|\bjQuery\b/g) || [];
  assert.deepStrictEqual(hits, [], 'jQuery usage found in views/email-scorecard.ejs');
});
