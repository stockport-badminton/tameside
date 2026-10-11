// Reserves are rank >= 99, not rank == 99.
//
// The roster editor (ported from Stockport) numbers reserves 99, 100, 101… so that their
// order can be saved; until now every reserve was written as exactly 99, and every reader
// tested `== 99`. A reader left on `== 99` would quietly turn the second reserve onwards into
// a nominated player — on the registration form, the PDF, the missed-three list and the
// registration import's diff. These pin each reader with a reserve at 100.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { isReserve, RESERVE_BASE } = require('../utils/rosterRank');
const { teamBlocks } = require('../utils/registrationDocx');
const { diffRegistration } = require('../utils/registrationDiff');

describe('isReserve', () => {
  it('99 and above, as numbers or strings', () => {
    for (const r of [99, '99', 100, '101', 250]) assert.strictEqual(isReserve(r), true, String(r));
  });
  it('nominated, unranked and junk are not reserves', () => {
    for (const r of [1, '4', 98, null, undefined, '', 'abc']) assert.strictEqual(isReserve(r), false, String(r));
  });
  it('the base is 99', () => assert.strictEqual(RESERVE_BASE, 99));
});

describe('every reader treats a reserve at 100 as a reserve', () => {
  const rows = [
    { teamName: 'Hyde A', teamId: 1, gender: 'Male', rank: 1, name: 'Nom' },
    { teamName: 'Hyde A', teamId: 1, gender: 'Male', rank: 99, name: 'Res1' },
    { teamName: 'Hyde A', teamId: 1, gender: 'Male', rank: '100', name: 'Res2' },
  ];

  it('the registration .docx and the team blocks', () => {
    const [team] = teamBlocks(rows).teams;
    assert.deepStrictEqual(team.nominated.men.map(r => r.name), ['Nom']);
    assert.deepStrictEqual(team.reserves.men.map(r => r.name), ['Res1', 'Res2']);
  });

  it('the pre-filled PDF', () => {
    require('./helpers/app');
    const organise = require('../controllers/documentsController')._organiseRosterForTesting;
    const { teamMen, resMen } = organise(rows);
    assert.deepStrictEqual(Object.values(teamMen).flat().map(r => r.name), ['Nom']);
    assert.deepStrictEqual(resMen.map(r => r.name), ['Res1', 'Res2']);
  });

  it('missed-three excludes every reserve, not only rank 99', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'models', 'missedThree.js'), 'utf8');
    assert.match(src, /p\.rank IS NULL OR p\.rank < \$\{RESERVE_RANK\}/);
    assert.doesNotMatch(src, /p\.rank <> \$\{RESERVE_RANK\}/);
  });

  it('the registration import: a reserve at 100, still listed as a reserve, is unchanged', () => {
    const club = { id: 47, name: 'Hyde' };
    const teams = [{ id: 1, name: 'Hyde A', club: 47 }];
    const roster = [{ id: 14, first_name: 'Jamie', family_name: 'Saint', gender: 'Male', team: 1,
      teamName: 'Hyde A', rank: 100, club: 47 }];
    const doc = { club: 'Hyde', source: 'docx', warnings: [],
      entries: [{ name: 'Jamie Saint', gender: 'Male', teamLetter: 'A', reserve: true, block: 'A', row: 0 }] };
    const r = diffRegistration(doc, { club, teams, roster, otherPlayers: [] });
    const c = r.changes.find(x => x.name === 'Jamie Saint');
    assert.strictEqual(c.kind, 'unchanged', JSON.stringify(c));
  });

  it('no reader compares rank to 99 directly any more', () => {
    for (const f of ['utils/registrationDocx.js', 'controllers/documentsController.js',
      'utils/registrationDiff.js', 'models/missedThree.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.doesNotMatch(src, /rank\)?\s*[!=]==?\s*99\b/, f);
    }
  });
});
