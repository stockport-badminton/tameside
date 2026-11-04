// First match wins, so a route registered after a broader pattern can silently never run.
// Ported from Stockport (league-site __tests__/integration/route-shadowing.test.js).
//
// It found two here on its first run (4 Nov 2026), both deleted:
//   - GET /players/club-:club?/team-:team?/gender-:gender? (`secured`) was hidden by a PUBLIC
//     route with the same pattern, whose handler built SQL by string concatenation through
//     a `db` that no longer existed, so every request hung until the platform timeout.
//   - GET /admin/results/:division/:season was always answered by GET /admin/results/*,
//     the same handler. Stockport had the same pair.
//
// For every route this builds URLs its own pattern accepts and checks the route is the
// first to answer them. A deliberate exception goes in KNOWN with its reason.

const { test } = require('node:test');
const assert = require('node:assert');

const { app } = require('../helpers/app');
const { shadowedRoutes } = require('../helpers/routeTable');

const KNOWN = {};

test('lets every route answer its own URLs', () => {
  const found = shadowedRoutes(app).filter(s => !KNOWN[s.route]);
  assert.deepStrictEqual(found.map(s => `${s.route}: ${s.url} goes to ${s.answeredBy}`), []);
});

test('still has every known exception, so a fixed one is removed from the list', () => {
  const shadowed = new Set(shadowedRoutes(app).map(s => s.route));
  assert.deepStrictEqual(Object.keys(KNOWN).filter(k => !shadowed.has(k)), []);
});
