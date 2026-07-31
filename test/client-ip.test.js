// Unit coverage for utils/clientIp.
//
// This is the address the blocklist and the submission log are keyed on, and getting it
// wrong is not a theoretical problem: the Stockport site had a hardcoded IP blocklist that
// never blocked anything, because it compared a Google frontend address against a list of
// spammers. Behind Firebase Hosting → Cloud Run there are two proxies in front of the app.
//
// req.ip is preferred when Express provides it (with `trust proxy` on in production it is
// already the leftmost X-Forwarded-For entry), and the header is read directly only as a
// fallback — which is the path exercised here, since `trust proxy` is off outside production.
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { clientIp, forwardedChain } = require('../utils/clientIp');

describe('clientIp', () => {
  it('prefers req.ip when Express has resolved one', () => {
    // In production `trust proxy` is set, so req.ip is already the visitor.
    assert.strictEqual(
      clientIp({ ip: '203.0.113.7', headers: { 'x-forwarded-for': '198.51.100.1' } }),
      '203.0.113.7'
    );
  });

  it('falls back to the leftmost X-Forwarded-For entry', () => {
    // Cloud Run documents the header as `client, proxy...`, so the visitor is leftmost.
    assert.strictEqual(
      clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 130.211.0.1, 35.191.0.2' } }),
      '203.0.113.7'
    );
  });

  it('trims whitespace around a header entry', () => {
    assert.strictEqual(
      clientIp({ headers: { 'x-forwarded-for': '  203.0.113.7  , 130.211.0.1' } }),
      '203.0.113.7'
    );
  });

  it('falls back to the socket address when there is no header', () => {
    assert.strictEqual(
      clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.5' } }),
      '10.0.0.5'
    );
  });

  it('normalises IPv4-mapped IPv6 so a plain IPv4 blocklist entry matches', () => {
    // Express reports IPv4 over IPv6 like this; storing the mapped form would mean an
    // admin typing 1.2.3.4 into /admin/spam never matched.
    assert.strictEqual(clientIp({ ip: '::ffff:1.2.3.4' }), '1.2.3.4');
    assert.strictEqual(
      clientIp({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }),
      '127.0.0.1'
    );
  });

  it('returns an empty string rather than throwing on junk input', () => {
    // isBlockedIpSync treats '' as "not blocked", so an unresolvable address must not
    // become a match, and must certainly not throw on every request.
    assert.strictEqual(clientIp(null), '');
    assert.strictEqual(clientIp(undefined), '');
    assert.strictEqual(clientIp({}), '');
    assert.strictEqual(clientIp({ headers: {} }), '');
    assert.strictEqual(clientIp({ headers: {}, socket: {} }), '');
  });
});

describe('forwardedChain', () => {
  it('returns the raw header for the log', () => {
    // Kept alongside the resolved address because the resolved one is client-settable.
    assert.strictEqual(
      forwardedChain({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } }),
      '1.1.1.1, 2.2.2.2'
    );
  });

  it('returns an empty string when absent', () => {
    assert.strictEqual(forwardedChain({ headers: {} }), '');
    assert.strictEqual(forwardedChain(null), '');
  });
});
