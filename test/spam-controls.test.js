// Unit coverage for the blocklist matching in models/spamControls.
//
// The phrase/word split is the whole reason these are separate kinds: the list this
// replaced was one flat array matched with indexOf, so short entries matched inside
// ordinary words. "ass" matched "class", and the spam half had "Christ" and "God", which
// match Christine, Christopher, Goddard and Godfrey — real names of real people who then
// couldn't use the contact form.
//
// Uses the _setCacheForTests seam, so no DB.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const Spam = require('../models/spamControls');

beforeEach(() => {
  Spam._setCacheForTests({
    ip: ['1.2.3.4'],
    email: ['Spammer@Example.COM'],
    phrase: ['http://', 'brokerage', 'mail.ru'],
    word: ['SEO', 'ass'],
  });
});

describe('matchBlockedText — phrase kind matches substrings', () => {
  it('matches a phrase anywhere in the message', async () => {
    const hit = await Spam.matchBlockedText('Please visit http://spam.example today');
    assert.deepStrictEqual(hit, { kind: 'phrase', value: 'http://' });
  });

  it('is case-insensitive', async () => {
    const hit = await Spam.matchBlockedText('We offer BROKERAGE services');
    assert.strictEqual(hit.kind, 'phrase');
    assert.strictEqual(hit.value, 'brokerage');
  });

  it('returns null for an ordinary message', async () => {
    assert.strictEqual(
      await Spam.matchBlockedText('Hello, can I join the league next season?'), null
    );
  });

  it('returns null for empty or missing input', async () => {
    assert.strictEqual(await Spam.matchBlockedText(''), null);
    assert.strictEqual(await Spam.matchBlockedText(null), null);
    assert.strictEqual(await Spam.matchBlockedText(undefined), null);
  });
});

describe('matchBlockedText — word kind matches whole words only', () => {
  it('matches the word standing alone', async () => {
    const hit = await Spam.matchBlockedText('we can do SEO for your site');
    assert.deepStrictEqual(hit, { kind: 'word', value: 'seo' });
  });

  it('does NOT match inside a longer word', async () => {
    // This is the bug the two kinds exist to prevent.
    assert.strictEqual(await Spam.matchBlockedText('Our class is on Tuesday'), null,
      '"ass" must not match inside "class"');
    assert.strictEqual(await Spam.matchBlockedText('Please pass the shuttle'), null,
      '"ass" must not match inside "pass"');
    assert.strictEqual(await Spam.matchBlockedText('Seonaid is playing'), null,
      '"SEO" must not match inside a name');
  });

  it('escapes regex metacharacters in a stored term', async () => {
    // An admin can type anything into /admin/spam; a term like "c++" or "a.b" must not
    // become an unintended pattern or throw.
    Spam._setCacheForTests({ word: ['c++', 'a.b'] });
    assert.doesNotThrow(() => Spam.matchBlockedText('hello'));
    assert.strictEqual(await Spam.matchBlockedText('axb'), null, '"a.b" must not match "axb"');
    const hit = await Spam.matchBlockedText('I write a.b code');
    assert.strictEqual(hit && hit.value, 'a.b');
  });
});

describe('isBlockedEmail', () => {
  it('matches case-insensitively and ignores surrounding whitespace', async () => {
    assert.strictEqual(await Spam.isBlockedEmail('spammer@example.com'), true);
    assert.strictEqual(await Spam.isBlockedEmail('SPAMMER@EXAMPLE.COM'), true);
    assert.strictEqual(await Spam.isBlockedEmail('  spammer@example.com  '), true);
  });

  it('is exact, not a substring test', async () => {
    // The old implementation used indexOf on the submitted value, so a blocklist entry
    // could match a longer legitimate address.
    assert.strictEqual(await Spam.isBlockedEmail('notspammer@example.com.uk'), false);
    assert.strictEqual(await Spam.isBlockedEmail('real@example.com'), false);
  });

  it('returns false for empty input', async () => {
    assert.strictEqual(await Spam.isBlockedEmail(''), false);
    assert.strictEqual(await Spam.isBlockedEmail(null), false);
  });
});

describe('isBlockedIpSync', () => {
  it('reads the warmed cache without awaiting', () => {
    // app.js calls this on every request and cannot afford a DB round trip.
    assert.strictEqual(Spam.isBlockedIpSync('1.2.3.4'), true);
    assert.strictEqual(Spam.isBlockedIpSync('4.3.2.1'), false);
    assert.strictEqual(Spam.isBlockedIpSync(''), false);
    assert.strictEqual(Spam.isBlockedIpSync(undefined), false);
  });
});
