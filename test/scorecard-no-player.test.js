// Recording a side that turned up short — and the 500 loop it used to cause.
//
// A captain entered a result on 3 Sep 2026 where the away team was missing a lady, which
// is the case the "No Player Away Team" option (value 0) exists for. Cloud Logging shows
// three consecutive `POST /email-scorecard` 500s at 19:02:07, :15 and :25, each
// `PostgresError: invalid input syntax for type bigint: "Choose Lady 2"`.
//
// Three separate bugs in a row, and each one made the next reachable:
//
//   A. `noDuplicatePlayerValidator` did `if (value == 0) return false`, so choosing
//      "No Player" FAILED validation — with the message "can't use the same player more
//      than once", which does not hint at the real problem. The documented workflow could
//      not succeed on this form at all.
//
//   B. That rejection re-renders the form. On the error render the first option was
//      `<option>Choose Lady 2</option>` — no `value`, not `disabled`, so submittable —
//      and views/partials/scorecard-player-options.ejs marked a row selected only where
//      `row[ordinalKey] == 1`, which nothing satisfies when the previous choice was 0.
//      So the captain's choice was silently dropped and the select fell back to the
//      placeholder, whose LABEL then got posted as the player id.
//
//   C. The error branch feeds those values into getEligiblePlayersP -> a bigint column.
//      So the page whose entire job is to display the validation message crashed on the
//      bad value instead, and every retry did the same. Unrecoverable.
//
// C predates the rest: the identical crash hit revision 00235 on 19 Aug 2026 with the
// values "lmdkqrfp" and "gkuhrrew" — a scanner posting junk, not a captain.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const { body, validationResult } = require('express-validator');

const PARTIAL = path.join(__dirname, '..', 'views', 'partials', 'scorecard-player-options.ejs');
const CONTROLLER = path.join(__dirname, '..', 'controllers', 'fixtureController.js');

// The validator as the controller builds it, so the behaviour under test is the real rule.
function noDuplicatePlayerValidator(field, group, label) {
  return body(field, 'Please choose a player.')
    .isInt()
    .custom((value, { req }) => {
      if (value == 0) return true;
      return !group.some((other) => other !== field && value == req.body[other]);
    })
    .withMessage(`${label}: can't use the same player more than once`);
}

const LADIES = ['awayLady1', 'awayLady2'];
async function validate(bodyObj) {
  const req = { body: bodyObj };
  for (const v of LADIES.map(f => noDuplicatePlayerValidator(f, LADIES, f))) await v.run(req);
  return validationResult(req).array().map(e => e.msg);
}

describe('A: "No Player" is a legitimate choice', () => {
  it('accepts one empty slot', async () => {
    assert.deepStrictEqual(await validate({ awayLady1: '2262', awayLady2: '0' }), []);
  });

  it('accepts BOTH slots empty — a side can be two players short', async () => {
    assert.deepStrictEqual(await validate({ awayLady1: '0', awayLady2: '0' }), []);
  });

  it('still rejects the same real player twice', async () => {
    const errs = await validate({ awayLady1: '2262', awayLady2: '2262' });
    assert.ok(errs.length, 'a genuine duplicate must still fail');
    assert.ok(errs.every(m => /same player more than once/.test(m)), errs.join(' | '));
  });

  it('still rejects a non-numeric value', async () => {
    const errs = await validate({ awayLady1: 'Choose Lady 2', awayLady2: '2262' });
    assert.deepStrictEqual(errs, ['Please choose a player.']);
  });

  it('the controller really returns true for 0, not false', () => {
    // Pins the one-character change that unblocks the workflow.
    const src = fs.readFileSync(CONTROLLER, 'utf8');
    assert.match(src, /if \(value == 0\) return true;/);
    assert.ok(!/if \(value == 0\) return false;/.test(src),
      'reverting this makes "No Player" impossible to submit again');
  });
});

describe('B: the error re-render keeps the choice and cannot post a label', () => {
  const rows = [
    { id: 2262, first_name: 'Kay', family_name: 'Wilkinson', first: 1, second: 0 },
    { id: 2301, first_name: 'Lauren', family_name: 'Jackson', first: 0, second: 1 },
  ];
  const render = (locals) => ejs.render(
    fs.readFileSync(PARTIAL, 'utf8'),
    Object.assign({ rows, ordinalKey: 'first' }, locals),
    { filename: PARTIAL });

  it('re-selects "No Player" when that is what was posted', () => {
    // The heart of it: nothing in `rows` has id 0, so the old partial selected nothing and
    // the browser fell back to the placeholder.
    const html = render({ selectedValue: '0' });
    assert.match(html, /<option value="0" selected>/);
    assert.ok(!/value="2262" selected/.test(html), 'must not silently pick a real player');
  });

  it('re-selects a real player when that is what was posted', () => {
    const html = render({ selectedValue: '2301' });
    assert.match(html, /value="2301" selected/);
    assert.ok(!/value="2262" selected/.test(html));
  });

  it('marks exactly one option selected in every case', () => {
    for (const locals of [{}, { selectedValue: '0' }, { selectedValue: '2301' }, { selectedValue: null }]) {
      const n = (render(locals).match(/ selected/g) || []).length;
      assert.strictEqual(n, 1, JSON.stringify(locals) + ' selected ' + n);
    }
  });

  it('still offers "No Player" at all', () => {
    assert.match(render({}), /value="0"[^>]*>No Player Away Team/);
  });

  it('no placeholder on the form is submittable', () => {
    // `<option>Choose Lady 2</option>` with no value posts its own LABEL as the value.
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'email-scorecard.ejs'), 'utf8');
    const bare = view.match(/<option>Choose [^<]*<\/option>/g) || [];
    assert.deepStrictEqual(bare, [],
      'these post their label as the field value: ' + bare.join(', '));
  });

  it('every player select passes the posted value through to the partial', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'email-scorecard.ejs'), 'utf8');
    const includes = view.match(/include\('partials\/scorecard-player-options'[^)]*\)/g) || [];
    assert.strictEqual(includes.length, 12, 'expected 12 player selects, found ' + includes.length);
    for (const inc of includes) {
      assert.match(inc, /selectedValue: data\['[A-Za-z0-9]+'\]/, inc);
    }
  });
});

describe('D: an uploaded photo survives a validation error', () => {
  // The captain on 3 Sep uploaded his photo at 19:01:58, nine seconds before the first
  // 500. The object reached S3 fine — `tameside-20262027-Disley A-Hyde C.jpeg`, 2.8MB —
  // but the hidden scoresheet-url field carried no `value`, so the error re-render dropped
  // it and any resubmission would have saved an empty string, orphaning the upload.
  const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'email-scorecard.ejs'), 'utf8');

  it('the hidden scoresheet-url field is repopulated from the submitted data', () => {
    const field = view.match(/<input type="hidden" name="scoresheet-url"[\s\S]{0,220}?\/>/);
    assert.ok(field, 'the hidden scoresheet-url input is gone');
    assert.match(field[0], /value="/, 'without value= the upload is lost on every error render');
    assert.match(field[0], /data\['scoresheet-url'\]/);
  });

  it('guards on locals, because `data` only exists on the error render', () => {
    const field = view.match(/<input type="hidden" name="scoresheet-url"[\s\S]{0,220}?\/>/)[0];
    assert.match(field, /typeof data !== 'undefined'/);
  });
});

describe('E: nothing offers a photo that is not there', () => {
  // Row 2176 had an empty scoresheet-url, and the email linked to
  // /scorecard-photo/2176 anyway — which correctly 404s, so the captain got a dead link.
  const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'fixtureController.js'), 'utf8');

  it('the email builds a photo url only when the stored value resolves to a key', () => {
    // Uses the SAME authority as the route, so the two cannot disagree.
    assert.match(controller, /photoKeyFromStored\(scorecardObj\["scoresheet-url"\]\)\s*\n?\s*\? absoluteUrl\("\/scorecard-photo\/"/);
  });

  it('the thank-you page gets a null id when there is no photo, so it shows no broken image', () => {
    assert.match(controller, /scorecardId: emailContext\.photoUrl \? rows\[0\]\.id : null/);
  });

  it('the template already treats the photo block as optional', () => {
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'emails', 'scorecard-received.mjml'), 'utf8');
    assert.match(tpl, /<mj-raw><% if \(photoUrl\) \{ %><\/mj-raw>/);
  });
});

describe('C: the error page must never crash on the value it is reporting', () => {
  // The page's whole job is to say what was wrong. Feeding the offending value into a
  // bigint column instead produced a 500, so the message was never seen and every retry
  // failed the same way.
  const coerce = (value) => {
    const asInt = parseInt(value, 10);
    return Number.isInteger(asInt) ? asInt : 0;
  };

  it('coerces anything non-numeric to the empty-slot sentinel', () => {
    for (const bad of ['Choose Lady 2', 'lmdkqrfp', 'gkuhrrew', '', undefined, null, 'NaN', {}]) {
      assert.strictEqual(coerce(bad), 0, JSON.stringify(bad));
    }
  });

  it('leaves real ids alone, including 0', () => {
    assert.strictEqual(coerce('2262'), 2262);
    assert.strictEqual(coerce(2262), 2262);
    assert.strictEqual(coerce('0'), 0);
  });

  it('the controller coerces rather than only defaulting the missing ones', () => {
    const src = fs.readFileSync(CONTROLLER, 'utf8');
    assert.match(src, /const asInt = parseInt\(data\[field\], 10\);/);
    assert.match(src, /Number\.isInteger\(asInt\) \? asInt : 0/);
    assert.ok(!/if \(data\[field\] === undefined\) data\[field\] = 0;/.test(src),
      'the undefined-only guard let non-numeric values through to a bigint column');
  });
});
