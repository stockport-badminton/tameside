// utils/registrationDocx buckets a club's rows into nominated/reserve x men/ladies. It used
// jsonpath, with the team name interpolated INTO a filter expression that jsonpath then
// evaluates — so "St Mary's A" broke it. Plain array code now; these pin the behaviour.
const { it } = require('node:test');
const assert = require('node:assert');
const { teamBlocks } = require('../utils/registrationDocx');

const rows = [
  { teamName: "St Mary's A", teamId: 1, gender: 'Male', rank: 1, name: 'M1' },
  { teamName: "St Mary's A", teamId: 1, gender: 'Female', rank: '2', name: 'L1' },
  { teamName: "St Mary's A", teamId: 1, gender: 'Male', rank: '99', name: 'RM' },
  { teamName: 'Hyde B', teamId: 2, gender: 'Female', rank: 99, name: 'RL' },
];

it('buckets by team, reserve (rank 99, number or string) and gender — apostrophes included', () => {
  const [stMarys, hyde] = teamBlocks(rows).teams;
  const names = list => list.map(r => r.name);
  assert.strictEqual(stMarys.name, "St Mary's A");
  assert.strictEqual(stMarys.id, 1);
  assert.deepStrictEqual(names(stMarys.nominated.men), ['M1']);
  assert.deepStrictEqual(names(stMarys.nominated.ladies), ['L1']);
  assert.deepStrictEqual(names(stMarys.reserves.men), ['RM']);
  assert.deepStrictEqual(names(stMarys.reserves.ladies), []);
  assert.deepStrictEqual(names(hyde.reserves.ladies), ['RL']);
  assert.deepStrictEqual(names(hyde.nominated.men), []);
});
