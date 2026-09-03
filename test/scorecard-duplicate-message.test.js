// Telling a captain WHICH player they have picked twice, and where.
//
// The old message was "can't use the same player more than once", identical for every
// field in the group. On a form with twelve player selects that says something is wrong
// without saying what or where. It now reads
// "Away Man 2: Dave Lee is already down as Away Man 1".
//
// HOW, WITHOUT A QUERY. The validator runs before anything has been fetched, so it cannot
// know the player's name; it writes the message with the placeholder "that player" and
// names the slots. The error render then substitutes the name from the roster rows it
// fetches anyway for the selects (namePlayersInErrors). Zero extra database work.
//
// WHY NOT LOOK THE NAME UP IN THE VALIDATOR. That was the first attempt and it was worse
// in two ways. It makes the validator ASYNC, and express-validator judges an async
// validator on whether its promise REJECTS — so `return false` becomes a SILENT PASS, the
// trap the spam blocklists already fell into (test/integration/spam-gate.test.js). And it
// means validation opening a database connection on every duplicate, including under test,
// where the credentials are deliberately placeholders and repeated auth failures trip
// Supavisor's circuit breaker for everything sharing the pooler.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { validationResult } = require('express-validator');

require('./helpers/app');
const fixtureController = require('../controllers/fixtureController');

const namePlayersInErrors = fixtureController._namePlayersInErrorsForTesting;
const PLACEHOLDER = fixtureController._duplicateNamePlaceholderForTesting();

// A complete, valid submission. Individual tests break one thing.
function validBody(overrides = {}) {
  const body = {
    division: '8', date: '2026-09-03', homeTeam: '55', awayTeam: '56',
    homeMan1: '101', homeMan2: '102', homeMan3: '103', homeMan4: '104',
    homeLady1: '201', homeLady2: '202',
    awayMan1: '301', awayMan2: '302', awayMan3: '303', awayMan4: '304',
    awayLady1: '401', awayLady2: '402',
    FirstMixedhomeMan1: '101', SecondMixedhomeMan2: '102',
    ThirdMixedhomeMan3: '103', FourthMixedhomeMan4: '104',
    FirstMixedawayMan1: '301', SecondMixedawayMan2: '302',
    ThirdMixedawayMan3: '303', FourthMixedawayMan4: '304',
    FirstMixedhomeLady1: '201', SecondMixedhomeLady2: '202',
    ThirdMixedhomeLady1: '201', FourthMixedhomeLady2: '202',
    FirstMixedawayLady1: '401', SecondMixedawayLady2: '402',
    ThirdMixedawayLady1: '401', FourthMixedawayLady2: '402',
  };
  for (let g = 1; g <= 18; g++) { body[`Game${g}homeScore`] = '21'; body[`Game${g}awayScore`] = '15'; }
  return Object.assign(body, overrides);
}

// Runs the real exported validator chain. No models are touched, which is the point.
async function validate(body) {
  const req = { body };
  for (const chain of fixtureController.validateScorecard) await chain.run(req);
  return validationResult(req).array();
}
const msgs = (errors) => errors.map((e) => e.msg);

describe('the validator names both slots, with no database access', () => {
  it('reports each side of a duplicated man', async () => {
    const errs = msgs(await validate(validBody({ awayMan2: '301' }))); // same as awayMan1
    assert.ok(errs.includes(`Away Man 1: ${PLACEHOLDER} is already down as Away Man 2`), errs.join(' | '));
    assert.ok(errs.includes(`Away Man 2: ${PLACEHOLDER} is already down as Away Man 1`), errs.join(' | '));
  });

  it('reports ladies too', async () => {
    const errs = msgs(await validate(validBody({ homeLady2: '201' })));
    assert.ok(errs.some((m) => /^Home Lady 2: .* is already down as Home Lady 1$/.test(m)), errs.join(' | '));
  });

  it('uses the mixed-event labels for the mixed man fields', async () => {
    const errs = msgs(await validate(validBody({ SecondMixedawayMan2: '301' })));
    assert.ok(errs.some((m) => /^Second Mixed Away Man: .* is already down as First Mixed Away Man$/.test(m)),
      errs.join(' | '));
  });

  it('reads as correct English even before a name is substituted', async () => {
    // The placeholder ships to the user unchanged whenever a name cannot be resolved, so
    // it must be a real phrase and not a token like {player}.
    const errs = msgs(await validate(validBody({ awayMan2: '301' })));
    assert.ok(errs.every((m) => !/[{}]/.test(m)), errs.join(' | '));
    assert.strictEqual(PLACEHOLDER, 'that player');
  });
});

describe('what must still hold', () => {
  it('a valid submission produces no errors at all', async () => {
    assert.deepStrictEqual(msgs(await validate(validBody())), []);
  });

  it('"No Player" (0) is accepted, in one slot or several', async () => {
    assert.deepStrictEqual(msgs(await validate(validBody({ awayLady2: '0' }))), []);
    assert.deepStrictEqual(msgs(await validate(validBody({ awayLady1: '0', awayLady2: '0' }))), []);
    assert.deepStrictEqual(
      msgs(await validate(validBody({ awayMan3: '0', awayMan4: '0', awayLady1: '0', awayLady2: '0' }))), []);
  });

  it('a non-numeric value is still caught first', async () => {
    const errs = msgs(await validate(validBody({ awayLady2: 'Choose Lady 2' })));
    assert.ok(errs.includes('Please choose a player.'), errs.join(' | '));
  });

  it('a mixed lady may legitimately appear in more than one mixed event', async () => {
    // FirstMixedhomeLady1 and ThirdMixedhomeLady1 are the same person by design.
    const errs = msgs(await validate(validBody()));
    assert.ok(!errs.some((m) => /Mixed.*Lady/.test(m)), errs.join(' | '));
  });
});

describe('namePlayersInErrors substitutes from rows already in hand', () => {
  const HOME_MEN = [
    { id: 101, first_name: 'Alice', family_name: 'A' },
    { id: 102, first_name: 'Bob', family_name: 'B' },
  ];
  const err = (path, value, msg) => ({ type: 'field', path, value, msg, location: 'body' });

  it('replaces the placeholder with the player it resolves from the id', () => {
    const out = namePlayersInErrors(
      [err('homeMan2', '101', `Home Man 2: ${PLACEHOLDER} is already down as Home Man 1`)],
      [HOME_MEN]);
    assert.strictEqual(out[0].msg, 'Home Man 2: Alice A is already down as Home Man 1');
  });

  it('leaves the message alone when the id is in none of the rows', () => {
    const original = `Home Man 2: ${PLACEHOLDER} is already down as Home Man 1`;
    const out = namePlayersInErrors([err('homeMan2', '999999', original)], [HOME_MEN]);
    assert.strictEqual(out[0].msg, original);
  });

  it('does not touch errors that carry no placeholder', () => {
    const out = namePlayersInErrors([err('Game1homeScore', '99', 'must be between 0 and 30')], [HOME_MEN]);
    assert.strictEqual(out[0].msg, 'must be between 0 and 30');
  });

  it('copes with missing, empty and ragged row sets', () => {
    const original = `Home Man 2: ${PLACEHOLDER} is already down as Home Man 1`;
    for (const sets of [[], [null], [undefined], [[]], [[{}]], [[{ id: null }]]]) {
      const out = namePlayersInErrors([err('homeMan2', '101', original)], sets);
      assert.strictEqual(out[0].msg, original, JSON.stringify(sets));
    }
  });

  it('tidies the doubled whitespace the padded name columns produce', () => {
    // A raw read gives "Alice  Cooper" from the padded columns.
    const out = namePlayersInErrors(
      [err('homeMan1', '7', `Home Man 1: ${PLACEHOLDER} is already down as Home Man 2`)],
      [[{ id: 7, first_name: 'Alice ', family_name: ' Cooper' }]]);
    assert.strictEqual(out[0].msg, 'Home Man 1: Alice Cooper is already down as Home Man 2');
  });

  it('does not mutate the errors it is given', () => {
    const input = [err('homeMan2', '101', `Home Man 2: ${PLACEHOLDER} is already down as Home Man 1`)];
    const before = input[0].msg;
    namePlayersInErrors(input, [HOME_MEN]);
    assert.strictEqual(input[0].msg, before, 'express-validator errors should not be edited in place');
  });
});

describe('the async-validator trap is avoided rather than documented', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'fixtureController.js'), 'utf8');
  const fn = src.slice(src.indexOf('function noDuplicatePlayerValidator'),
    src.indexOf('// The phrase the validator leaves'));

  it('the duplicate validator is synchronous', () => {
    // Going async would make `return false` a silent pass, and would open a database
    // connection during validation — including under test, where that trips Supavisor.
    assert.ok(!/\.custom\(async/.test(fn), 'the duplicate check must not be async');
    assert.ok(!/await/.test(fn), fn);
  });

  it('rejects by throwing, so the message can be per-field', () => {
    assert.match(fn, /throw new Error\(/);
    assert.ok(!/return !group\.some/.test(fn));
  });

  it('has no .withMessage() after the .custom(), which would overwrite the thrown text', () => {
    const afterCustom = fn.slice(fn.indexOf('.custom('));
    assert.ok(!/\.withMessage\(/.test(afterCustom));
  });

  it('still lets 0 through before the clash search', () => {
    assert.match(fn, /if \(value == 0\) return true;/);
  });

  it('the naming step touches no model', () => {
    const naming = src.slice(src.indexOf('function namePlayersInErrors'),
      src.indexOf('const MEN_FIELDS'));
    assert.ok(!/Player\.|sql`|await /.test(naming), 'naming must work from rows passed in');
  });
});
