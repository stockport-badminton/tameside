// Unit coverage for utils/spamChecks — the honeypot and the signed timing floor.
//
// These two checks reject silently (see middleware/spamGate.js), so a false positive eats
// a real person's message with no visible error. That makes their edge cases worth pinning
// down precisely: in particular that an ABSENT or unreadable stamp is treated as "no
// opinion" rather than as spam.
const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  HONEYPOT_FIELD, honeypotTripped, formStamp, timingProblem, MIN_SECONDS,
} = require('../utils/spamChecks');

describe('honeypot', () => {
  it('is not called anything resembling "honeypot"', () => {
    // A bot matching on field names should want to fill it.
    assert.strictEqual(HONEYPOT_FIELD, 'contactUrl');
    assert.doesNotMatch(HONEYPOT_FIELD, /honey|trap|spam|bot/i);
  });

  it('trips only when the field arrives with content', () => {
    assert.strictEqual(honeypotTripped({ [HONEYPOT_FIELD]: 'http://spam.example' }), true);
    assert.strictEqual(honeypotTripped({ [HONEYPOT_FIELD]: 'x' }), true);
  });

  it('does not trip on empty, whitespace-only, absent or non-string values', () => {
    // Whitespace matters: a browser or proxy can leave an empty field as " ".
    assert.strictEqual(honeypotTripped({ [HONEYPOT_FIELD]: '' }), false);
    assert.strictEqual(honeypotTripped({ [HONEYPOT_FIELD]: '   ' }), false);
    assert.strictEqual(honeypotTripped({}), false);
    assert.strictEqual(honeypotTripped(undefined), false);
    assert.strictEqual(honeypotTripped({ [HONEYPOT_FIELD]: null }), false);
  });
});

describe('timing floor', () => {
  it('accepts a stamp older than the floor', () => {
    const now = 1_700_000_000_000;
    const stamp = formStamp(now);
    assert.strictEqual(timingProblem({ formTs: stamp }, now + (MIN_SECONDS + 1) * 1000), null);
  });

  it('rejects a submission faster than a human could type', () => {
    const now = 1_700_000_000_000;
    const stamp = formStamp(now);
    assert.strictEqual(timingProblem({ formTs: stamp }, now + 500), 'too-fast');
  });

  it('treats a missing or unreadable stamp as no opinion, not as spam', () => {
    // Caches, autofill, and any form rendered before this field existed would all be
    // caught otherwise — and the cost of a false positive is a silently dropped message.
    const now = 1_700_000_000_000;
    for (const body of [
      {},
      undefined,
      { formTs: '' },
      { formTs: 'nonsense' },          // no separator
      { formTs: 'abc.def' },           // non-numeric timestamp
      { formTs: '.' },
      { formTs: 12345 },               // not a string
    ]) {
      assert.strictEqual(timingProblem(body, now), null, `should be null for ${JSON.stringify(body)}`);
    }
  });

  it('rejects a stamp whose signature has been edited', () => {
    const now = 1_700_000_000_000;
    const stamp = formStamp(now);
    const [ts, mac] = stamp.split('.');
    // Same length, different content — a browser never does this.
    const tampered = ts + '.' + (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);
    assert.strictEqual(
      timingProblem({ formTs: tampered }, now + 10_000), 'bad-stamp'
    );
  });

  it('ignores a signature of the wrong length rather than throwing', () => {
    // timingSafeEqual throws on differing lengths, so the length is checked first. A
    // truncated value is treated as unreadable ("no opinion"), not as tampering.
    const now = 1_700_000_000_000;
    const [ts] = formStamp(now).split('.');
    assert.doesNotThrow(() => timingProblem({ formTs: ts + '.short' }, now + 10_000));
    assert.strictEqual(timingProblem({ formTs: ts + '.short' }, now + 10_000), null);
  });

  it('rejects a stamp from the future', () => {
    const now = 1_700_000_000_000;
    const stamp = formStamp(now + 60_000);
    assert.strictEqual(timingProblem({ formTs: stamp }, now), 'bad-stamp');
  });

  it('allows a stale tab — only the floor is enforced', () => {
    // Someone opens the form, goes to find a postcode, comes back 20 minutes later.
    const now = 1_700_000_000_000;
    const stamp = formStamp(now);
    assert.strictEqual(timingProblem({ formTs: stamp }, now + 20 * 60 * 1000), null);
    assert.strictEqual(timingProblem({ formTs: stamp }, now + 7 * 24 * 3600 * 1000), null);
  });

  it('re-signs a different timestamp to a different signature', () => {
    // Guards against the signature being over something constant, which would let any
    // timestamp be paired with any signature.
    const a = formStamp(1_700_000_000_000).split('.')[1];
    const b = formStamp(1_700_000_001_000).split('.')[1];
    assert.notStrictEqual(a, b);
  });
});
