// utils/listAddress.js: which list an inbound email was for, and whether to believe who
// sent it. See docs/backlog/done/BL-04-inbound-email-resend.md.
const { describe, it } = require('node:test');
const assert = require('node:assert');

const List = require('../utils/listAddress');
const svix = require('../utils/svixSignature');
const forwarded = require('./fixtures/inbound/resend-bcc-forwarded.json');

// Today's divisions and clubs, as InboundEmail.vocabulary() reads them.
const VOCAB = List.buildVocabulary({
  divisions: [{ id: 8, name: 'Division 1' }, { id: 9, name: 'Division 2' }],
  clubs: [
    { id: 42, name: 'Aerospace' }, { id: 64, name: 'Alderley Park' }, { id: 61, name: 'College Green' },
    { id: 51, name: 'Disley' }, { id: 53, name: 'G.H.A.P' }, { id: 47, name: 'Hyde' },
    { id: 41, name: 'Manchester Edgeley' }, { id: 55, name: 'Manor' }, { id: 43, name: 'Medlock' },
    { id: 39, name: 'Mellor' }, { id: 40, name: 'Shell' }, { id: 65, name: 'Syddal Park' },
  ],
});
const parse = local => List.parseLocalPart(local, VOCAB);

describe('parseLocalPart', () => {
  it('reads each single-part form', () => {
    assert.deepStrictEqual(parse('division1'), { label: 'division1', division: 8 });
    assert.deepStrictEqual(parse('hyde'), { label: 'hyde', club: 47 });
    assert.deepStrictEqual(parse('ghap'), { label: 'ghap', club: 53 });
    assert.deepStrictEqual(parse('manchesteredgeley'), { label: 'manchesteredgeley', club: 41 });
    assert.deepStrictEqual(parse('teamcaptains'), { label: 'teamcaptains', role: 'team Captain' });
    assert.deepStrictEqual(parse('clubsecretaries'), { label: 'clubsecretaries', role: 'club Sec' });
    assert.deepStrictEqual(parse('matchsecretaries'), { label: 'matchsecretaries', role: 'match Sec' });
    assert.deepStrictEqual(parse('treasurers'), { label: 'treasurers', role: 'treasurer' });
    assert.deepStrictEqual(parse('leaguecomms'), { label: 'leaguecomms', role: 'otherComms' });
  });

  it('reads combined forms, case-insensitively', () => {
    assert.deepStrictEqual(parse('hydeteamCaptains'), { label: 'hydeteamcaptains', club: 47, role: 'team Captain' });
    assert.deepStrictEqual(parse('Division1TeamCaptains'), { label: 'division1teamcaptains', division: 8, role: 'team Captain' });
    assert.deepStrictEqual(parse('teamcaptainsdivision2'), { label: 'teamcaptainsdivision2', division: 9, role: 'team Captain' });
    assert.deepStrictEqual(parse('mellordivision1matchsecretaries'), { label: 'mellordivision1matchsecretaries', division: 8, club: 39, role: 'match Sec' });
  });

  it('must consume the whole local part: near misses match nothing', () => {
    for (const local of ['hydex', 'xhyde', 'hydetest', 'domestic', 'division3', 'division', 'division12',
      'teamcaptain', 'hydehyde', 'teamcaptainsteamcaptains', 'results', 'registrations', 'info', 'dmarc', '']) {
      assert.strictEqual(parse(local), null, local);
    }
  });

  it('refuses punctuation and plus-tags rather than normalising them away', () => {
    assert.strictEqual(parse('g.h.a.p'), null);
    assert.strictEqual(parse('hyde+x'), null);
    assert.strictEqual(parse('hyde-teamcaptains'), null);
  });

  it('No Club is not a list (the vocabulary is built without it)', () => {
    assert.strictEqual(parse('noclub'), null);
  });

  it('a word that means two things matches nothing', () => {
    const v = List.buildVocabulary({ divisions: [], clubs: [{ id: 1, name: 'Shell' }, { id: 2, name: 'S.H.E.L.L' }] });
    assert.strictEqual(List.parseLocalPart('shell', v), null);
  });
});

describe('leagueAddress (the Gate 0 forwarded message)', () => {
  it('reads the address Namecheap recorded for a Bcc\'d list', () => {
    assert.deepStrictEqual(List.leagueAddress(forwarded), {
      address: 'hydeteamcaptains@tameside-badminton.co.uk', local: 'hydeteamcaptains',
    });
  });

  it('takes the TOPMOST X-Original-To: a forged one lower down is ignored', () => {
    const forged = {
      ...forwarded,
      headers: { ...forwarded.headers, 'x-original-to': JSON.stringify(['<hyde@tameside-badminton.co.uk>', '<division1@tameside-badminton.co.uk>']) },
      received_for: [...forwarded.received_for, 'hyde@tameside-badminton.co.uk', 'division1@tameside-badminton.co.uk'],
    };
    assert.strictEqual(List.leagueAddress(forged).address, 'hyde@tameside-badminton.co.uk');
  });

  it('needs the address in received_for as well', () => {
    const lone = { ...forwarded, received_for: ['inbound@example.resend.app'] };
    assert.strictEqual(List.leagueAddress(lone), null);
  });

  it('only ever our domain', () => {
    const other = { ...forwarded, headers: { ...forwarded.headers, 'x-original-to': '<hyde@example.com>' }, received_for: ['hyde@example.com'] };
    assert.strictEqual(List.leagueAddress(other), null);
  });

  it('no X-Original-To, no address', () => {
    const { ['x-original-to']: _, ...headers } = forwarded.headers;
    assert.strictEqual(List.leagueAddress({ ...forwarded, headers }), null);
  });
});

describe('isGenuineSender', () => {
  it('passes a DMARC pass (Gmail, forwarded, measured at Gate 0)', () => {
    assert.strictEqual(List.isGenuineSender(forwarded.authentication), true);
  });
  it('refuses SPF pass alone: after the forward SPF is checked against Namecheap', () => {
    assert.strictEqual(List.isGenuineSender({ spf: 'pass', dkim: 'fail', dmarc: 'fail' }), false);
    assert.strictEqual(List.isGenuineSender({ spf: 'pass', dkim: 'none', dmarc: 'none' }), false);
  });
  it('refuses a DKIM pass when DMARC fails: signed by somebody else\'s domain', () => {
    assert.strictEqual(List.isGenuineSender({ spf: 'pass', dkim: 'pass', dmarc: 'fail' }), false);
  });
  it('accepts a DKIM pass from a domain with no DMARC policy', () => {
    assert.strictEqual(List.isGenuineSender({ spf: 'fail', dkim: 'pass', dmarc: 'none' }), true);
  });
  it('refuses nothing-at-all', () => {
    assert.strictEqual(List.isGenuineSender(undefined), false);
  });
});

describe('loop guard and test subject', () => {
  it('drops our own forward coming back round', () => {
    const ours = { ...forwarded, headers: { ...forwarded.headers, 'x-tameside-list': 'hyde' } };
    assert.strictEqual(List.isLoop(ours, 'example.resend.app'), true);
    assert.strictEqual(List.isLoop(forwarded, 'example.resend.app'), false);
    assert.strictEqual(List.isLoop({ ...forwarded, from: 'x@example.resend.app' }, 'example.resend.app'), true);
  });
  it('"test" as a word, not inside one', () => {
    assert.strictEqual(List.isTestSubject('test: new list'), true);
    assert.strictEqual(List.isTestSubject('Fixture TEST'), true);
    assert.strictEqual(List.isTestSubject('The latest results'), false);
    assert.strictEqual(List.isTestSubject('Contest rules'), false);
  });
});

describe('extractAddress / extractName', () => {
  it('reads the From header shapes', () => {
    assert.strictEqual(List.extractAddress('"Test Captain" <Captain@Example.com>'), 'captain@example.com');
    assert.strictEqual(List.extractAddress('captain@example.com'), 'captain@example.com');
    assert.strictEqual(List.extractName('"Test Captain" <captain@example.com>'), 'Test Captain');
    assert.strictEqual(List.extractName('captain@example.com'), null);
  });
});

describe('svix signature', () => {
  const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-32-bytes-long').toString('base64');
  const body = Buffer.from('{"type":"email.received","data":{"email_id":"e1"}}');
  const now = 1794057528;

  it('verifies what Svix would send', () => {
    assert.strictEqual(svix.verify(SECRET, svix.sign(SECRET, 'msg_1', now, body), body, now), true);
  });
  it('refuses a changed body, a wrong secret, a missing header', () => {
    const h = svix.sign(SECRET, 'msg_1', now, body);
    assert.strictEqual(svix.verify(SECRET, h, Buffer.from(body.toString() + ' '), now), false);
    assert.strictEqual(svix.verify('whsec_' + Buffer.from('another-key').toString('base64'), h, body, now), false);
    const { ['svix-signature']: _, ...noSig } = h;
    assert.strictEqual(svix.verify(SECRET, noSig, body, now), false);
  });
  it('refuses a stale or future timestamp', () => {
    const h = svix.sign(SECRET, 'msg_1', now - svix.TOLERANCE_SECONDS - 1, body);
    assert.strictEqual(svix.verify(SECRET, h, body, now), false);
    const f = svix.sign(SECRET, 'msg_1', now + svix.TOLERANCE_SECONDS + 1, body);
    assert.strictEqual(svix.verify(SECRET, f, body, now), false);
  });
  it('accepts any one of several signatures (a secret being rotated)', () => {
    const h = svix.sign(SECRET, 'msg_1', now, body);
    h['svix-signature'] = 'v1,AAAA ' + h['svix-signature'];
    assert.strictEqual(svix.verify(SECRET, h, body, now), true);
  });
});
