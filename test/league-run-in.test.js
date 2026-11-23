// utils/leagueRunIn.js: the places going up and down, and when each is certain. Ported from
// Stockport's __tests__/unit/league-run-in.test.js, plus the count as a parameter.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runIn } = require('../utils/leagueRunIn');

// One division's rows, best first, from [name, gamesWon, remaining] triples.
const division = (id, rank, teams) => teams.map(([name, gamesWon, remaining]) => ({
  division: id, divisionName: `Division ${rank}`, divisionRank: rank, id: name, name,
  played: 10, remaining, gamesWon, gamesLost: 0,
}));

const zones = d => d.teams.map(t => t.zone);
const pick = (divisions, name) => divisions.flatMap(d => d.teams).find(t => t.name === name);

const MIDDLE = division(2, 2, [['A', 100, 2], ['B', 90, 2], ['C', 80, 2], ['D', 70, 2], ['E', 60, 2], ['F', 50, 2]]);
const TOP = division(1, 1, [['P1', 100, 0], ['P2', 90, 0], ['P3', 80, 0], ['P4', 70, 0]]);
const BOTTOM = division(3, 3, [['L1', 100, 0], ['L2', 90, 0], ['L3', 80, 0], ['L4', 70, 0]]);

describe('zones', () => {
  it('marks the winner, the second team, and the bottom two (default two)', () => {
    const [, middle] = runIn([...TOP, ...MIDDLE, ...BOTTOM]);
    assert.deepStrictEqual(zones(middle), ['winner', 'up', null, null, 'down', 'down']);
  });

  it('promotes nobody from the top division and relegates nobody from the bottom one', () => {
    const [top, , bottom] = runIn([...TOP, ...MIDDLE, ...BOTTOM]);
    assert.deepStrictEqual(zones(top), ['winner', null, 'down', 'down']);
    assert.deepStrictEqual(zones(bottom), ['winner', 'up', null, null]);
  });

  it('takes the number going up and down as a parameter: one', () => {
    const [top, middle, bottom] = runIn([...TOP, ...MIDDLE, ...BOTTOM], 1);
    assert.deepStrictEqual(zones(middle), ['winner', null, null, null, null, 'down']);
    assert.deepStrictEqual(zones(top), ['winner', null, null, 'down']);
    assert.deepStrictEqual(zones(bottom), ['winner', null, null, null]);
  });

  it('none: only the winners are marked, and nothing is certain to move', () => {
    const all = runIn([...TOP, ...MIDDLE, ...BOTTOM], 0);
    for (const d of all) assert.deepStrictEqual(zones(d).slice(1).filter(Boolean), []);
    for (const t of all.flatMap(d => d.teams)) assert.deepStrictEqual([t.certain.up, t.certain.down], [false, false]);
  });

  it('keeps the order it was given, numbering from 1', () => {
    const [d] = runIn(MIDDLE);
    assert.deepStrictEqual(d.teams.map(t => [t.position, t.name]),
      [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D'], [5, 'E'], [6, 'F']]);
  });
});

describe('certainty', () => {
  it('is not certain while another team can still catch up', () => {
    const all = runIn([...TOP, ...MIDDLE, ...BOTTOM]);
    assert.deepStrictEqual(pick(all, 'A').certain, { winner: false, up: false, down: false });
    assert.strictEqual(pick(all, 'F').certain.down, false);
  });

  it('is certain once nobody can reach the same total', () => {
    const all = runIn([...TOP, ...division(2, 2, [['A', 200, 1], ['B', 150, 1], ['C', 100, 1], ['D', 40, 1], ['E', 30, 1]]), ...BOTTOM]);
    assert.strictEqual(pick(all, 'A').certain.winner, true);
    assert.strictEqual(pick(all, 'A').certain.up, true);
    assert.strictEqual(pick(all, 'B').certain.winner, false);
    assert.strictEqual(pick(all, 'B').certain.up, true);
    assert.strictEqual(pick(all, 'D').certain.down, true);
    assert.strictEqual(pick(all, 'E').certain.down, true);
    assert.strictEqual(pick(all, 'C').certain.down, false);
  });

  it('calls a tie not certain', () => {
    const [d] = runIn([...division(2, 2, [['A', 100, 0], ['B', 100, 0], ['C', 50, 0]]), ...TOP, ...BOTTOM]);
    assert.strictEqual(d.teams[0].certain.winner, false);
  });

  it('never calls a top-division team promoted, or a bottom-division team relegated', () => {
    const [top, , bottom] = runIn([...TOP, ...MIDDLE, ...BOTTOM]);
    assert.ok(top.teams.every(t => t.certain.up === false));
    assert.ok(bottom.teams.every(t => t.certain.down === false));
    assert.strictEqual(top.teams[0].certain.winner, true);
    assert.strictEqual(bottom.teams[0].certain.winner, true);
  });
});

it('copes with no results at all', () => {
  assert.deepStrictEqual(runIn([]), []);
});
