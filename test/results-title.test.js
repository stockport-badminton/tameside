// The results page title is built from names. It used to concatenate the raw filter
// values, so /results/Division-2/20252026 was titled "Fixtures & Results: 20252026 9"
// (the division's id) and /results/All ended in a bare colon.
const { test } = require('node:test');
const assert = require('node:assert');

require('./helpers/app'); // test env before the controller loads
const { _resultsTitle: title } = require('../controllers/fixtureController');

test('names the division, never its id', () => {
  assert.strictEqual(title({ division: 'Division 1' }), 'Fixtures & Results: Division 1');
});

test('no filter is a plain title with no trailing colon', () => {
  assert.strictEqual(title({ division: 'All' }), 'Fixtures & Results');
  assert.strictEqual(title({}), 'Fixtures & Results');
});

test('a season reads as 2025/26', () => {
  assert.strictEqual(title({ division: 'Division 2', season: '20252026' }), 'Fixtures & Results: Division 2, 2025/26');
});

test('a team says more than its club, and is decoded', () => {
  assert.strictEqual(title({ division: 'Division 1', club: 'Hyde', team: 'Hyde%20B' }), 'Fixtures & Results: Hyde B, Division 1');
  assert.strictEqual(title({ division: 'All', club: 'Hyde' }), 'Fixtures & Results: Hyde');
});
