// utils/fixturePreview.js: the words on a public event page. Ported from Stockport's
// __tests__/unit/fixture-preview.test.js, for our 8/2/8 split of games and the Lewis Shield.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const P = require('../utils/fixturePreview');
const { longDate } = require('../utils/ukDate');

const fixture = over => ({ id: 7388, date: new Date('2026-09-01T23:00:00Z'), homeTeam: 'Hyde B', awayTeam: 'Mellor A',
  homeTeamId: 11, awayTeamId: 22, divisionName: 'Division 2', status: 'outstanding', homeScore: null, awayScore: null,
  lewisRound: null, ...over });
const played = (id, home, away, hs, as, date) => ({ id, date, homeTeam: home, awayTeam: away, homeScore: hs, awayScore: as,
  homeName: `T${home}`, awayName: `T${away}` });
const forecast = fc => ({ ran_at: '2026-08-31', home: null, away: null,
  fixture: { pHome: 0.5, pDraw: 0.1, pAway: 0.4, expected: 9.4, likely: { home: 10, away: 8 }, edges: { mens: 4, ladies: 1, mixed: 4 }, ...fc } });
const text = preview => preview.sections.flatMap(s => s.paragraphs).join(' ');
const pick = (salt, options) => options[0];

describe('formSentence', () => {
  it('says nothing before a team has played', () => {
    assert.strictEqual(P.formSentence('Hyde B', [], pick), null);
  });

  it('says a winless run in English, not "taking no of their last two"', () => {
    const form = P.teamForm(22, [played(1, 22, 33, 3, 15), played(2, 33, 22, 17, 1)]);
    const s = P.formSentence('Mellor A', form, pick);
    assert.strictEqual(s, 'Mellor A have not won in their last two, and will be looking to change that.');
  });

  it('notices a winning streak', () => {
    const form = P.teamForm(11, [played(3, 11, 33, 12, 6), played(2, 33, 11, 8, 10), played(1, 11, 33, 13, 5)]);
    assert.match(P.formSentence('Hyde B', form, pick), /three straight wins|three wins in a row/);
  });

  it('reads each result from the team\'s own side, home or away', () => {
    const form = P.teamForm(11, [played(2, 33, 11, 12, 6), played(1, 11, 33, 12, 6)]);
    assert.deepStrictEqual(form.map(r => r.result), ['L', 'W']);
    assert.deepStrictEqual([form[0].home, form[0].won, form[0].lost, form[0].opponent], [false, 6, 12, 'T33']);
  });
});

describe('squadSentence', () => {
  const profile = over => ({ teams: 9, men: 5, ladies: 5, overall: 5, fixtures: 3, settled: 0.9, last: 6, projection: null, ...over });

  it('names the strongest squad, and where its strength lies', () => {
    assert.match(P.squadSentence('Hyde B', profile({ overall: 1, men: 1, ladies: 6 }), pick),
      /^On paper Hyde B have the strongest squad in the division, with their strength in the men’s games\./);
  });

  it('says how settled the line-up has been, and nothing about it before a match', () => {
    assert.match(P.squadSentence('Hyde B', profile({ settled: 0.4, last: 3 }), pick), /rotated their squad more than most/);
    assert.doesNotMatch(P.squadSentence('Hyde B', profile({ fixtures: 0, settled: null, last: null }), pick), /line-up|rotated|six/);
  });
});

describe('battleSentence (8 men\'s, 2 ladies\', 8 mixed)', () => {
  const f = fixture();
  it('judges each type against its own number of games', () => {
    // 5.5 of 8 men's is the home side's; 0.6 of 2 ladies' is the away side's; 4 of 8 mixed is even.
    assert.strictEqual(P.battleSentence(f, { edges: { mens: 5.5, ladies: 0.6, mixed: 4 } }),
      'Hyde B should have the edge in the men’s doubles, while Mellor A look stronger in the ladies’ doubles. The mixed looks evenly matched.');
  });

  it('would have misread a Tameside fixture with Stockport\'s six-a-type thresholds', () => {
    // 4 of 8 men's is level, though 4 >= 3.6 called it the home side's.
    assert.match(P.battleSentence(f, { edges: { mens: 4, ladies: 1, mixed: 4 } }), /evenly matched across/);
  });
});

describe('buildPreview', () => {
  it('previews an upcoming fixture: the favourite, the likely score, where the games are won', () => {
    const p = P.buildPreview({ fixture: fixture(), forecast: forecast({ pHome: 0.7, pAway: 0.2, likely: { home: 11, away: 7 },
      edges: { mens: 5.5, ladies: 0.6, mixed: 4 } }) });
    assert.strictEqual(p.state, 'upcoming');
    assert.deepStrictEqual(p.sections.map(s => s.heading), ['Match preview', 'Prediction']);
    const t = text(p);
    assert.match(t, /Hyde B host Mellor A in Division 2 on Wednesday 2 September 2026\./);
    assert.match(t, /11–7 Hyde B win/);
    assert.strictEqual(p.summary, 'Hyde B vs Mellor A, Division 2 badminton, Wednesday 2 September 2026. Preview and prediction: Hyde B 70% favourites.');
  });

  it('dates the fixture by its UK day, not the server\'s (a BST midnight is 23:00 UTC the day before)', () => {
    assert.strictEqual(longDate(new Date('2026-09-01T23:00:00Z')), 'Wednesday 2 September 2026');
    assert.strictEqual(longDate(new Date('2027-01-05T00:00:00Z')), 'Tuesday 5 January 2027');
  });

  it('says the generic season projection once for both teams', () => {
    const prof = expected => ({ teams: 9, men: 5, ladies: 5, overall: 5, fixtures: 3, settled: 0.9, last: 6,
      projection: { teams: 9, expected, pWinner: 0, pUp: 0, pDown: 0 } });
    const p = P.buildPreview({ fixture: fixture(), forecast: { ...forecast(), home: prof(8.6), away: prof(4.8) } });
    assert.match(text(p), /have Hyde B finishing around 9th and Mellor A around 5th\./);
    assert.strictEqual((text(p).match(/Our simulations/g) || []).length, 1);
  });

  it('calls a close one too close to call', () => {
    const p = P.buildPreview({ fixture: fixture(), forecast: forecast({ pHome: 0.45, pAway: 0.42, pDraw: 0.13, likely: { home: 9, away: 9 } }) });
    assert.match(text(p), /too close to call|very little between the sides/);
    assert.match(text(p), /9–9 draw/);
  });

  it('reports a result, game types included, and drops the forecast', () => {
    const games = [
      ...Array(8).fill({ gameType: 'ThirdMens', homeScore: 21, awayScore: 15 }),
      ...Array(2).fill({ gameType: 'FirstLadies', homeScore: 15, awayScore: 21 }),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ gameType: 'FirstMixed', homeScore: i < 4 ? 21 : 18, awayScore: i < 4 ? 19 : 21 })),
    ];
    const p = P.buildPreview({ fixture: fixture({ status: 'complete', homeScore: 12, awayScore: 6 }), forecast: forecast(),
      context: { form: [], meetings: [], games } });
    assert.strictEqual(p.state, 'result');
    assert.strictEqual(p.forecast, null);
    assert.match(text(p), /Hyde B beat Mellor A 12–6 in Division 2/);
    assert.match(text(p), /Hyde B took the men’s doubles 8–0, Mellor A took the ladies’ doubles 2–0 and the mixed were shared 4–4\./);
  });

  it('gives a void or rearranged fixture no prediction', () => {
    for (const status of ['void', 'rearranged', 'rearranging']) {
      const p = P.buildPreview({ fixture: fixture({ status }), forecast: forecast() });
      assert.strictEqual(p.forecast, null);
      assert.ok(!p.sections.map(s => s.heading).includes('Prediction'));
    }
  });

  it('describes a Lewis Shield tie as a cup tie: no table places, no forecast', () => {
    const standings = [{ id: 22, gamesWon: 20, gamesLost: 16, played: 2 }, { id: 11, gamesWon: 10, gamesLost: 8, played: 1 }];
    const p = P.buildPreview({ fixture: fixture({ lewisRound: 2 }), forecast: forecast(), standings });
    assert.match(text(p), /Hyde B host Mellor A in the Lewis Shield/);
    assert.strictEqual(p.forecast, null);
    assert.strictEqual(p.home.position, null);
    assert.doesNotMatch(text(p), /Division 2/);
    const done = P.buildPreview({ fixture: fixture({ lewisRound: 2, status: 'complete', homeScore: 10, awayScore: 8 }) });
    assert.match(text(done), /in the Lewis Shield/);
  });

  it('reads previous meetings from this fixture\'s side, whichever way round they were played', () => {
    const p = P.buildPreview({ fixture: fixture(), context: { form: [], games: [],
      meetings: [played(2, 22, 11, 7, 11, new Date('2026-03-02T00:00:00Z')), played(1, 11, 22, 12, 6, new Date('2025-10-01T00:00:00Z'))] } });
    assert.match(text(p), /Hyde B won the last meeting 11–7 on 2 Mar 2026/);
    assert.match(text(p), /Hyde B lead 2–0/);
    assert.deepStrictEqual([p.meetings[0].home, p.meetings[0].away, p.meetings[0].venue], [11, 7, 'away']);
  });

  it('quotes the table places only before the match', () => {
    const standings = [{ id: 22, gamesWon: 20, gamesLost: 16, played: 2 }, { id: 11, gamesWon: 10, gamesLost: 8, played: 1 }];
    const before = P.buildPreview({ fixture: fixture(), standings });
    assert.deepStrictEqual([before.home.position.place, before.home.position.label, before.home.position.of], [2, '2nd', 2]);
    assert.match(text(before), /Hyde B are 2nd of 2 with 10 games won from one match/);
    const after = P.buildPreview({ fixture: fixture({ status: 'complete', homeScore: 10, awayScore: 8 }), standings });
    assert.strictEqual(after.home.position, null);
  });

  it('words a fixture the same way on every visit, and different fixtures differently', () => {
    const fc = forecast({ pHome: 0.7, pAway: 0.2 });
    assert.strictEqual(text(P.buildPreview({ fixture: fixture(), forecast: fc })), text(P.buildPreview({ fixture: fixture(), forecast: fc })));
    const verdicts = new Set([...Array(30).keys()].map(i =>
      P.buildPreview({ fixture: fixture({ id: 1000 + i }), forecast: fc }).sections.find(s => s.heading === 'Prediction').paragraphs[0]));
    assert.ok(verdicts.size > 1);
  });
});

describe('ordinal', () => {
  for (const [n, s] of [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [13, '13th'], [21, '21st'], [22, '22nd']]) {
    it(`${n} is ${s}`, () => assert.strictEqual(P.ordinal(n), s));
  }
});
