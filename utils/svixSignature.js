// Verifying a Resend webhook, which Resend signs the Svix way.
//
// Svix signs `${svix-id}.${svix-timestamp}.${raw body}` with HMAC-SHA256, keyed by the
// base64 part of the `whsec_…` secret, and sends `svix-signature: v1,<base64> [v1,<base64>…]`
// (several while a secret is being rotated). About twenty lines, so no `svix` or `resend`
// dependency: this repo calls APIs with fetch, not SDKs.
//
// The signature covers the BYTES Resend sent, so this needs the raw body. app.js mounts
// express.raw on /webhooks/resend ahead of the global JSON parser for that reason; a body
// that was parsed and re-serialised would not verify.

const crypto = require('crypto');

// Svix's own tolerance. A captured request replayed later is refused.
const TOLERANCE_SECONDS = 5 * 60;

function header(headers, name) {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * @param {string} secret   `whsec_…`
 * @param {object} headers  request headers (lower-case keys, as Node gives them)
 * @param {Buffer|string} body  the raw body
 * @param {number} [nowSeconds]
 * @returns {boolean}
 */
function verify(secret, headers, body, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || !headers || body == null) return false;
  const id = header(headers, 'svix-id');
  const timestamp = header(headers, 'svix-timestamp');
  const signatures = header(headers, 'svix-signature');
  if (!id || !timestamp || !signatures) return false;

  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  if (!key.length) return false;
  const expected = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    .digest();

  return String(signatures).split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

// For tests: what Svix would send for this body.
function sign(secret, id, timestamp, body) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${sig}` };
}

module.exports = { verify, sign, TOLERANCE_SECONDS };
