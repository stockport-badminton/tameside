// Unit tests for the Lewis Shield bracket topology in models/teams.js
// (Team.lewisAdvanceTarget). Pure function — no DB. Run with: npm test
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test-placeholder';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const Team = require('../models/teams');

const adv = Team.lewisAdvanceTarget;

// Current-season shape: 2 prelims, j-values "1,9" (the values seen in prod).
const P = 2;
const J = [1, 9];

describe('Team.lewisAdvanceTarget', () => {
  describe('preliminary round (j-value mapping)', () => {
    // floor(j/2)+P+1; even j -> home slot, odd j -> away slot.
    it('prelim drawPos 1 (j=1) -> R1 drawPos 3, away side', () => {
      assert.deepStrictEqual(adv(1, P, J), { targetDrawPos: 3, side: 'away' });
    });
    it('prelim drawPos 2 (j=9) -> R1 drawPos 7, away side', () => {
      assert.deepStrictEqual(adv(2, P, J), { targetDrawPos: 7, side: 'away' });
    });
    it('even j maps to the home slot', () => {
      // single prelim, j=0 -> floor(0/2)+1+1 = 2, even -> home
      assert.deepStrictEqual(adv(1, 1, [0]), { targetDrawPos: 2, side: 'home' });
    });
    it('returns null when a prelim has no j-value', () => {
      // prelimCount 2 but only one j-value -> the drawPos-2 prelim has no mapping
      assert.strictEqual(adv(2, 2, [1]), null);
    });
  });

  describe('round 1 -> quarter-finals (P=2, R1 = drawPos 3..10, QF = 11..14)', () => {
    const cases = [
      [3, 11, 'home'], [4, 11, 'away'],
      [5, 12, 'home'], [6, 12, 'away'],
      [7, 13, 'home'], [8, 13, 'away'],
      [9, 14, 'home'], [10, 14, 'away'],
    ];
    for (const [from, to, side] of cases) {
      it(`R1 drawPos ${from} -> QF drawPos ${to} (${side})`, () => {
        assert.deepStrictEqual(adv(from, P, J), { targetDrawPos: to, side });
      });
    }
  });

  describe('quarter-finals -> semi-finals (QF 11..14, SF 15..16)', () => {
    it('QF drawPos 11 -> SF 15 home', () => assert.deepStrictEqual(adv(11, P, J), { targetDrawPos: 15, side: 'home' }));
    it('QF drawPos 12 -> SF 15 away', () => assert.deepStrictEqual(adv(12, P, J), { targetDrawPos: 15, side: 'away' }));
    it('QF drawPos 13 -> SF 16 home', () => assert.deepStrictEqual(adv(13, P, J), { targetDrawPos: 16, side: 'home' }));
    it('QF drawPos 14 -> SF 16 away', () => assert.deepStrictEqual(adv(14, P, J), { targetDrawPos: 16, side: 'away' }));
  });

  describe('semi-finals -> final (SF 15..16, Final 17)', () => {
    it('SF drawPos 15 -> Final 17 home', () => assert.deepStrictEqual(adv(15, P, J), { targetDrawPos: 17, side: 'home' }));
    it('SF drawPos 16 -> Final 17 away', () => assert.deepStrictEqual(adv(16, P, J), { targetDrawPos: 17, side: 'away' }));
  });

  describe('terminal / off-bracket', () => {
    it('the final (drawPos 17) has no parent — winner is champion', () => {
      assert.strictEqual(adv(17, P, J), null);
    });
    it('an off-bracket slot (drawPos 18, e.g. 3rd place) returns null', () => {
      assert.strictEqual(adv(18, P, J), null);
    });
  });

  describe('robustness', () => {
    it('coerces a string drawPos', () => {
      assert.deepStrictEqual(adv('3', P, J), { targetDrawPos: 11, side: 'home' });
    });
    it('works with no prelims (P=0): R1 = drawPos 1..8, QF starts at 9', () => {
      assert.deepStrictEqual(adv(1, 0, []), { targetDrawPos: 9, side: 'home' });
      assert.deepStrictEqual(adv(8, 0, []), { targetDrawPos: 12, side: 'away' });
      assert.strictEqual(adv(15, 0, []), null); // Final at drawPos 15 when P=0
    });
    it('defaults missing prelimCount/jValues to a no-prelim bracket', () => {
      assert.deepStrictEqual(adv(1), { targetDrawPos: 9, side: 'home' });
    });
  });

  describe('full-bracket propagation (P=2, j=[1,9])', () => {
    // Walking a winner from every first-playable match must land in a valid
    // next slot, and following the chain must terminate at the final (17).
    it('every non-final match advances toward drawPos 17 and terminates', () => {
      for (let start = 1; start <= 16; start++) {
        let dp = start, hops = 0;
        while (true) {
          const t = adv(dp, P, J);
          if (t === null) break;
          assert.ok(t.targetDrawPos > 0 && (t.side === 'home' || t.side === 'away'), `bad target from ${dp}`);
          dp = t.targetDrawPos;
          assert.ok(++hops < 10, `chain from ${start} did not terminate`);
        }
        assert.strictEqual(dp, 17, `chain from drawPos ${start} should end at the final (17), got ${dp}`);
      }
    });
  });
});
