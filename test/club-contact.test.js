// The club contact query (models/club.js getContactDetailsById) and the view it feeds.
//
// This query was five INNER joins with no guarantee of matching one row each, so it
// returned the cartesian product of every candidate for every role. Disley has one
// team and rendered FOUR captain cards; five of thirteen clubs were affected.
//
// Source assertions rather than DB round trips, for the reason CLAUDE.md gives: the
// DB-backed tests are flaky under connection pressure, and the properties worth
// protecting here are structural. The behaviour against real data is covered by
// test/integration/club-contact.test.js with mocked models.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MODEL = fs.readFileSync(path.join(__dirname, '..', 'models', 'club.js'), 'utf8');
const VIEW = fs.readFileSync(path.join(__dirname, '..', 'views', 'club-contact.ejs'), 'utf8');

// Just the one function, so an assertion below can't be satisfied by some other query
// in the same file.
const QUERY = (() => {
  const start = MODEL.indexOf('exports.getContactDetailsById');
  assert.notStrictEqual(start, -1, 'getContactDetailsById has been renamed or removed');
  const end = MODEL.indexOf('exports.getById', start);
  return MODEL.slice(start, end === -1 ? undefined : end);
})();

describe('getContactDetailsById — one row per team', () => {
  // The fix. Each role resolves through its own LATERAL subquery with LIMIT 1, so the
  // number of rows is the number of teams no matter how many candidates a role has.
  // Without LIMIT 1 the OR conditions multiply again and the duplicate cards return.
  it('resolves each of the three roles in a LATERAL with LIMIT 1', () => {
    const laterals = QUERY.match(/LEFT JOIN LATERAL \(/g) || [];
    assert.strictEqual(laterals.length, 3,
      'expected one LATERAL each for matchSec, clubSec and teamCaptain');
    const limits = QUERY.match(/\n\s*LIMIT 1\n/g) || [];
    assert.strictEqual(limits.length, 3, 'every role LATERAL must be capped at one row');
  });

  it('joins the player table only inside those LATERALs', () => {
    // A bare `JOIN player` anywhere in this query is the old shape coming back: it is
    // what multiplied the rows, because a club can have several flagged candidates.
    assert.doesNotMatch(QUERY, /\bJOIN player\b(?![\s\S]{0,40}LATERAL)/,
      'player must not be joined directly — it multiplies rows');
  });

  it('names all three roles', () => {
    for (const alias of ['"matchSec"', '"clubSec"', '"teamCaptain"']) {
      assert.ok(QUERY.includes('LIMIT 1\n    ) ' + alias + ' ON true'),
        alias + ' must be the alias of one capped LATERAL');
    }
  });
});

describe('getContactDetailsById — 0 is a player id meaning nobody', () => {
  // The "No Player" sentinel, the same one documented for scorecards in CLAUDE.md.
  // club."clubSec" was 0 for Mellor and No Club, and comparing against it directly
  // made Mellor's page show a Club Secretary called "No Player" together with that
  // row's decrypted phone number and email address — on a page whose own banner
  // calls itself confidential.
  it('excludes player 0 from every role', () => {
    const guards = QUERY.match(/p\."id" <> 0/g) || [];
    assert.strictEqual(guards.length, 3,
      'each role LATERAL must exclude player 0; found ' + guards.length + ' guards');
  });
});

describe('getContactDetailsById — a missing field must not take the page down', () => {
  // Every join used to be INNER while club_controller turned zero rows into a 500, so
  // a club with no venue or no recorded captain lost its whole page. No club hit it
  // only because 0 accidentally satisfied Mellor's club-secretary join.
  it('left-joins the venues', () => {
    assert.match(QUERY, /LEFT JOIN venue ON/);
    assert.match(QUERY, /LEFT JOIN venue "matchVenue" ON/);
    assert.doesNotMatch(QUERY, /\n\s+JOIN venue\b/, 'venue joins must be LEFT');
  });

  it('keeps the team join inner', () => {
    // Deliberately not LEFT: the page is a list of teams, and a club with no teams has
    // nothing to show, which the controller answers as a 404.
    assert.match(QUERY, /JOIN team ON team\."club" = club\."id"/);
  });

  it('returns null rather than " " for an unfilled role', () => {
    // CONCAT ignores NULLs, so CONCAT(NULL,' ',NULL) is a single space — truthy enough
    // to pass every `if (officer)` test in the view and render a blank name with empty
    // mailto: and tel: links. The name is guarded on the joined row instead.
    const cases = QUERY.match(/CASE WHEN "(matchSec|clubSec|teamCaptain)"\."id" IS NOT NULL/g) || [];
    assert.strictEqual(cases.length, 3, 'all three names must be null when the role is unfilled');
  });
});

describe('getContactDetailsById — error handling', () => {
  it('uses try/catch, not the .catch(err => done(err)) idiom', () => {
    // That idiom calls done(err) and then falls through to done(null, result) with
    // result undefined, so the controller renders on top of a 500 already in flight —
    // and being outside the request chain, the resulting throw kills the process. See
    // the same fix applied to the withRetry functions in CLAUDE.md.
    assert.doesNotMatch(QUERY, /\.catch\(err =>/, 'the fall-through idiom is back');
    assert.match(QUERY, /\} catch \(err\) \{ done\(err\); \}/);
  });
});

describe('views/club-contact.ejs', () => {
  it('escapes everything officerCard interpolates', () => {
    // officerCard returns markup as a string, so it has to be emitted with the raw
    // output tag, which does not escape. Names, phones and emails come straight from
    // the player table.
    const helper = VIEW.slice(VIEW.indexOf('function officerCard'), VIEW.indexOf('%>', VIEW.indexOf('function officerCard')));
    assert.ok(helper, 'officerCard has been removed');
    const interpolated = helper.match(/' \+ (\w+)/g) || [];
    assert.ok(interpolated.length > 0, 'expected officerCard to interpolate values');
    for (const frag of interpolated) {
      assert.match(frag, /' \+ esc/, 'unescaped interpolation in officerCard: ' + frag);
    }
  });

  it('routes all four officer slots through the one helper', () => {
    // Three roles on the page (club secretary, match secretary, captain). Hand-rolled
    // cards are how the null handling drifts between them.
    const calls = VIEW.match(/officerCard\('/g) || [];
    assert.strictEqual(calls.length, 3);
    assert.doesNotMatch(VIEW, /href="mailto:<%=/, 'a hand-rolled contact link is back');
    assert.doesNotMatch(VIEW, /href="tel:<%=/, 'a hand-rolled contact link is back');
  });
});
