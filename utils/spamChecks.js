const crypto = require('crypto');

// Two checks that cost a legitimate visitor nothing and catch naive bots outright.
//
// They earn their place because they don't depend on recognising anything: a blocklist
// only stops senders and phrases we've already seen, and the captcha only stops whoever
// doesn't solve it. These stop anything that fills in every field it finds, or submits
// faster than a human could type — which is most low-effort form spam.
//
// Ported from the Stockport league site. See middleware/spamGate.js for how a failure is
// reported, and views/spam-fields.ejs for the markup half.

// --- honeypot ---
//
// A field that is present in the HTML, hidden from people, and expected to stay empty. It
// isn't named "honeypot"; it's named as something a bot's field-matching would want to
// fill. Anything that arrives with a value in it was not filled in by a person looking at
// the page.
const HONEYPOT_FIELD = 'contactUrl';

function honeypotTripped(body) {
  const value = body && body[HONEYPOT_FIELD];
  return typeof value === 'string' && value.trim() !== '';
}

// --- timing ---
//
// The form carries a signed timestamp of when it was rendered. Submitting within a couple
// of seconds means nothing read the page first.
//
// Signed rather than plain, so the value can't just be rewritten to something older — and
// the signature is over the timestamp alone, so this needs no session state and works
// across Cloud Run instances. SESSION_SECRET is reused as the key since it already exists
// wherever the app runs.
//
// NOTE for Tameside: app.js falls back to a hardcoded string when SESSION_SECRET is unset.
// With a known key a determined attacker could forge a stamp, which downgrades this check
// to "catches bots that don't bother" — still most of them. Setting SESSION_SECRET in the
// deployed environment restores its full value.
const MIN_SECONDS = 3;

// Rendered-then-submitted much later is a stale tab rather than an attack, so it's allowed:
// rejecting it would punish someone who opened the form, went to find a postcode, and came
// back. Only the floor is enforced.
function formStamp(now = Date.now()) {
  const ts = String(now);
  return ts + '.' + sign(ts);
}

function sign(ts) {
  const key = process.env.SESSION_SECRET || 'ThisisMySecret';
  return crypto.createHmac('sha256', key).update(ts).digest('base64url').slice(0, 22);
}

// Returns null when fine, or a reason string.
//
// A missing or unparseable stamp is *not* treated as spam. Caches, autofill tools and
// anyone who submits a form we rendered before this field existed would all be caught by
// that, and the cost of a false positive here is a real person's message silently
// vanishing. Absent means "no opinion".
function timingProblem(body, now = Date.now()) {
  const raw = body && body.formTs;
  if (typeof raw !== 'string' || !raw.includes('.')) return null;

  const [ts, mac] = raw.split('.');
  if (!/^\d+$/.test(ts)) return null;
  // Constant-time compare, and only after the length matches — timingSafeEqual throws on
  // differing lengths.
  const expected = sign(ts);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    // A present-but-wrong signature means someone edited the field. That is not something
    // a browser does.
    return 'bad-stamp';
  }

  const elapsedSeconds = (now - Number(ts)) / 1000;
  // Negative elapsed time means a stamp from the future — also hand-edited.
  if (elapsedSeconds < 0) return 'bad-stamp';
  if (elapsedSeconds < MIN_SECONDS) return 'too-fast';
  return null;
}

module.exports = {
  HONEYPOT_FIELD,
  honeypotTripped,
  formStamp,
  timingProblem,
  MIN_SECONDS,
};
