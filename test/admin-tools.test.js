// utils/adminTools.js is the /admin hub, and since the Admin dropdown was cut to a shortlist
// it is the ONLY place most superadmin tools are linked from. A tool whose href has no route
// would be a dead link; a tool dropped from the list would be unreachable from the UI.
const { it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { app } = require('./helpers/app');
const { GROUPS, NAV_SHORTLIST, shortlist } = require('../utils/adminTools');

const tools = GROUPS.flatMap(g => g.tools);

// Ask Express's own router, so parameterised routes (club-:club?) match as they really do.
function hasGetRoute(href) {
  const urlPath = decodeURI(href.split('?')[0]);
  return app._router.stack.some(layer =>
    layer.route && layer.route.methods.get && layer.match(urlPath));
}

it('every tool links to a real GET route (or a real static file)', () => {
  const dead = tools.filter(t => t.staticFile
    ? !fs.existsSync(path.join(__dirname, '..', decodeURI(t.href)))
    : !hasGetRoute(t.href));
  assert.deepStrictEqual(dead.map(t => t.href), []);
});

it('lists each tool once', () => {
  const hrefs = tools.map(t => t.href);
  assert.strictEqual(new Set(hrefs).size, hrefs.length);
});

it('the hub itself has a route', () => assert.ok(hasGetRoute('/admin')));

it('the shortlist is built from tools that exist', () => {
  assert.ok(NAV_SHORTLIST.length >= 3 && NAV_SHORTLIST.length <= 6, 'a SHORT list');
  shortlist().forEach((t, i) => assert.ok(t && t.label, `NAV_SHORTLIST[${i}] is not in GROUPS`));
});

// Every superadmin link the dropdown carried before the shortlist (2026-10-02), so cutting
// the menu cannot quietly drop one.
const FORMER_MENU = [
  '/manage-players/club-Aerospace', '/static/docs/Team Registration.pdf',
  '/forms/team-registration/Aerospace/prefilled', '/admin/team-registrations',
  '/admin/registration-reminders', '/admin/missed-three', '/fixture-players', '/played-up-counts',
  '/player-stats', '/pair-stats', '/players/eloBackfillAdmin', '/admin/homepage-content',
  '/admin/site-settings', '/admin/clubs', '/admin/teams', '/admin/lewis', '/admin/scorecard-ocr',
  '/admin/distribution', '/admin/spam', '/admin/link-auth-accounts', '/admin/social/weekly-tables',
  '/admin/social/weekly-fixtures', '/admin/social/weekly-video',
];
it('nothing the old menu linked to was dropped', () => {
  const hrefs = new Set(tools.map(t => t.href));
  assert.deepStrictEqual(FORMER_MENU.filter(h => !hrefs.has(h)), []);
});
