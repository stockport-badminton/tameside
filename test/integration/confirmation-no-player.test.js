// The confirmation form must show "No Player" where the record says nobody played.
//
// A stored player id of 0 is the "No Player" sentinel. Nothing in
// views/populated-scorecard.ejs marked either No Player option `selected`, so a stored 0
// matched no option at all — and with nothing selected a single-select displays the first
// NON-DISABLED option, which is a real player.
//
// So for row 2176, where the away side was a lady short and six fields are stored as 0,
// the confirmation form displayed Claire DeWeever, Sophie Yates, Catherine Tann and Kay
// Wilkinson. Confirming it would have recorded four women as playing events the scorecard
// photo shows dashed out. That is worse than a crash: it silently invents results.
//
// Two things made it hard to spot. The main selects DO carry a placeholder, but it is
// `disabled`, so the browser skips it rather than showing it — the field looks legitimately
// filled in. And the mixed selects have no placeholder at all.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('./../helpers/app');

afterEach(() => clearModels());

const HOME_LADIES = [
  { id: 646, first_name: 'Catherine', family_name: 'Tann' },
  { id: 900, first_name: 'Claire', family_name: 'DeWeever' },
];
const AWAY_LADIES = [
  { id: 2167, first_name: 'Kay', family_name: 'Wilkinson' },
  { id: 2391, first_name: 'Sophie', family_name: 'Yates' },
];
const HOME_MEN = [
  { id: 250, first_name: 'Jon', family_name: 'Paul' },
  { id: 251, first_name: 'Paul', family_name: 'Capewell' },
];
const AWAY_MEN = [
  { id: 2459, first_name: 'Sachin', family_name: 'Thomas' },
  { id: 2253, first_name: 'David', family_name: 'Bate' },
];

// The shape of row 2176: a side short of a lady, so the lady-2 slots and the mixed events
// that would have used her are all 0.
function storedRow(overrides = {}) {
  const row = {
    id: 2176, division: 8, homeTeam: 55, awayTeam: 56, date: '2026-09-02',
    homeMan1: 250, homeMan2: 0, homeMan3: 0, homeMan4: 251,
    homeLady1: 646, homeLady2: 0,
    awayMan1: 2459, awayMan2: 0, awayMan3: 0, awayMan4: 2253,
    awayLady1: 2167, awayLady2: 0,
    FirstMixedhomeMan1: 250, FirstMixedhomeLady1: 646,
    FirstMixedawayMan1: 2459, FirstMixedawayLady1: 2167,
    SecondMixedhomeMan2: 250, SecondMixedhomeLady2: 0,
    SecondMixedawayMan2: 2253, SecondMixedawayLady2: 0,
    ThirdMixedhomeMan3: 251, ThirdMixedhomeLady1: 646,
    ThirdMixedawayMan3: 2253, ThirdMixedawayLady1: 2167,
    FourthMixedhomeMan4: 251, FourthMixedhomeLady2: 0,
    FourthMixedawayMan4: 2253, FourthMixedawayLady2: 0,
    'scoresheet-url': '',
  };
  for (let g = 1; g <= 18; g++) { row[`Game${g}homeScore`] = 21; row[`Game${g}awayScore`] = 15; }
  return Object.assign(row, overrides);
}

function mockConfirmationModels(row) {
  setModel('Fixture', 'getScorecardById', (id, cb) => cb(null, [row]));
  setModel('Division', 'getAllAndSelectedById', (leagueId, selectedId, cb) =>
    cb(null, [{ id: 8, name: 'Division 1', selected: 1 }]));
  setModel('Team', 'getAllAndSelectedById', (teamId, divisionId, cb) =>
    cb(null, [{ id: Number(teamId) || 55, name: 'Disley A', selected: 1 }]));
  // Mirrors the real query, which computes the ordinal flags from the ids it is passed:
  //   case when player.id = ${second} then 1 else 0 end as second
  // A mock with hardcoded flags looks fine until a test changes which player is in a slot,
  // and then it disagrees with production in the direction that hides bugs.
  // NB third/fourth come AFTER the callback in this model's signature.
  setModel('Player', 'getEligiblePlayersAndSelectedById',
    (first, second, teamId, gender, cb, third = 0, fourth = 0) => {
      const isHome = String(teamId) === '55';
      const roster = gender === 'Male' ? (isHome ? HOME_MEN : AWAY_MEN)
                                       : (isHome ? HOME_LADIES : AWAY_LADIES);
      cb(null, roster.map((p) => ({
        id: p.id, first_name: p.first_name, family_name: p.family_name,
        first: String(p.id) === String(first) ? 1 : 0,
        second: String(p.id) === String(second) ? 1 : 0,
        third: String(p.id) === String(third) ? 1 : 0,
        fourth: String(p.id) === String(fourth) ? 1 : 0,
      })));
    });
}

// What the browser will actually display: the selected option, or failing that the first
// option that is not disabled. Getting this wrong is what hid the bug — the disabled
// placeholder made the field look filled in.
function displayedOption(html, field) {
  const select = new RegExp(`<select[^>]*name="${field}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  if (!select) return { display: null, selectedCount: 0 };
  const options = [...select[1].matchAll(/<option([^>]*)>([^<]*)<\/option>/g)]
    .map((m) => ({ attrs: m[1], label: m[2].trim() }));
  const selected = options.filter((o) => /\bselected\b/.test(o.attrs));
  const enabled = options.filter((o) => !/\bdisabled\b/.test(o.attrs));
  return {
    display: selected.length ? selected[0].label : (enabled.length ? enabled[0].label : null),
    selectedCount: selected.length,
  };
}

const ZERO_FIELDS = [
  ['homeLady2', 'No Player Home Team'],
  ['awayLady2', 'No Player Away Team'],
  ['SecondMixedhomeLady2', 'No Player Home Team'],
  ['FourthMixedhomeLady2', 'No Player Home Team'],
  ['SecondMixedawayLady2', 'No Player Away Team'],
  ['FourthMixedawayLady2', 'No Player Away Team'],
];

describe('GET /populated-scorecard-beta/:id — a side that turned up short', () => {
  it('shows "No Player" for every slot stored as 0', async () => {
    process.env.DEV_MODE = 'true';
    try {
      mockConfirmationModels(storedRow());
      const res = await request(app).get('/populated-scorecard-beta/2176');
      assert.strictEqual(res.status, 200);
      for (const [field, expected] of ZERO_FIELDS) {
        const { display } = displayedOption(res.text, field);
        assert.strictEqual(display, expected, `${field} displayed ${display}`);
      }
    } finally { delete process.env.DEV_MODE; }
  });

  it('picks the side that matches the field, not just the first No Player option', async () => {
    // Both options carry value 0, so this is cosmetic — but "No Player Home Team" in an
    // away dropdown reads like the form has misunderstood the record.
    process.env.DEV_MODE = 'true';
    try {
      mockConfirmationModels(storedRow());
      const res = await request(app).get('/populated-scorecard-beta/2176');
      assert.strictEqual(displayedOption(res.text, 'awayLady2').display, 'No Player Away Team');
      assert.strictEqual(displayedOption(res.text, 'homeLady2').display, 'No Player Home Team');
    } finally { delete process.env.DEV_MODE; }
  });

  it('never displays a real player for a slot stored as 0', async () => {
    // The actual harm: confirming the form would have recorded them as having played.
    process.env.DEV_MODE = 'true';
    try {
      mockConfirmationModels(storedRow());
      const res = await request(app).get('/populated-scorecard-beta/2176');
      const impostors = ['Claire DeWeever', 'Sophie Yates'];
      for (const [field] of ZERO_FIELDS) {
        const { display } = displayedOption(res.text, field);
        assert.ok(!impostors.includes(display), `${field} displayed ${display}`);
        assert.match(display, /^No Player/, `${field} displayed ${display}`);
      }
    } finally { delete process.env.DEV_MODE; }
  });

  it('leaves slots that DO name a player exactly as they were', async () => {
    process.env.DEV_MODE = 'true';
    try {
      mockConfirmationModels(storedRow());
      const res = await request(app).get('/populated-scorecard-beta/2176');
      for (const [field, expected] of [
        ['homeLady1', 'Catherine Tann'], ['awayLady1', 'Kay Wilkinson'],
        ['homeMan1', 'Jon Paul'], ['awayMan4', 'David Bate'],
        ['FirstMixedhomeLady1', 'Catherine Tann'], ['ThirdMixedawayLady1', 'Kay Wilkinson'],
      ]) {
        assert.strictEqual(displayedOption(res.text, field).display, expected, field);
      }
    } finally { delete process.env.DEV_MODE; }
  });

  it('selects exactly one option per player select', async () => {
    process.env.DEV_MODE = 'true';
    try {
      mockConfirmationModels(storedRow());
      const res = await request(app).get('/populated-scorecard-beta/2176');
      for (const field of ZERO_FIELDS.map((f) => f[0]).concat(
        ['homeLady1', 'awayLady1', 'homeMan1', 'awayMan4', 'FirstMixedhomeLady1'])) {
        assert.strictEqual(displayedOption(res.text, field).selectedCount, 1,
          `${field} had ${displayedOption(res.text, field).selectedCount} selected`);
      }
    } finally { delete process.env.DEV_MODE; }
  });

  it('still shows a real player when nobody is missing', async () => {
    // Guards the other direction: the fix must not make No Player sticky.
    process.env.DEV_MODE = 'true';
    try {
      mockConfirmationModels(storedRow({ homeLady2: 900, awayLady2: 2391 }));
      const res = await request(app).get('/populated-scorecard-beta/2176');
      assert.strictEqual(displayedOption(res.text, 'homeLady2').display, 'Claire DeWeever');
      assert.strictEqual(displayedOption(res.text, 'awayLady2').display, 'Sophie Yates');
    } finally { delete process.env.DEV_MODE; }
  });
});
