// The homepage must not call Cloudinary.
//
// fixture_get_summary used to await the Cloudinary Admin API on every request — uncached,
// no timeout — for a gallery homepage.ejs never rendered. It added ~100ms to the
// homepage's TTFB and tied the page's availability to Cloudinary's. Stockport's copy of the
// same call reached 19.4s during a Cloudinary outage (league-site HARD-43). A regression
// here is invisible except as a slower page, hence a source assertion.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('fixture_get_summary makes no Cloudinary API call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'fixtureController.js'), 'utf8');
  const start = src.indexOf('exports.fixture_get_summary');
  assert.notStrictEqual(start, -1);
  const next = src.indexOf('\nexports.', start + 1);
  const body = src.slice(start, next === -1 ? src.length : next).replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(body, /cloudinary/i);
  assert.doesNotMatch(body, /\bfetch\(/);
});
