const Spam = require('../models/spamControls');
const { honeypotTripped, timingProblem, HONEYPOT_FIELD } = require('../utils/spamChecks');
const { clientIp, forwardedChain } = require('../utils/clientIp');

// Runs the cheap checks on a public form post, logs the outcome, and answers a bland
// success to anything it rejects.
//
// The bland success is deliberate. Telling a bot "blocked: honeypot" teaches whoever wrote
// it exactly which field to leave alone next time, and a distinguishable error is how a
// spammer tunes their payload. From the outside a rejected submission is indistinguishable
// from an accepted one, so there is nothing to iterate against.
//
// The trade-off: a real person caught by one of these gets a page saying their message was
// sent when it wasn't. That is why the checks are only the ones with negligible
// false-positive rates — an unfilled hidden field and a three-second floor — and why every
// rejection is logged with its reason, so a pattern of real people being caught is visible
// on /admin/spam rather than invisible.
//
// Any new public form must include views/spam-fields.ejs inside its <form> and carry this
// middleware on its POST route, or these two checks simply don't run for it.
function spamGate(options = {}) {
  const label = options.endpoint;

  return async function (req, res, next) {
    const endpoint = label || req.originalUrl.split('?')[0];
    const ip = clientIp(req);
    const base = {
      endpoint,
      ip,
      forwardedFor: forwardedChain(req),
      userAgent: req.get('user-agent') || '',
      email: req.body && (req.body.contactEmail || req.body.email || ''),
      excerpt: req.body && (req.body.contactQuery || req.body.message || ''),
    };

    let reason = null;
    if (honeypotTripped(req.body)) {
      reason = 'honeypot';
    } else {
      reason = timingProblem(req.body);
    }
    // The IP list is enforced sitewide in app.js, but check it here too so a blocked
    // address shows up in the log against the form it was aiming at rather than as a bare
    // 403 nobody sees.
    if (!reason && await Spam.isBlockedIp(ip)) {
      reason = 'blocked-ip';
    }

    if (!reason) {
      // Stash for the handler to log its own verdict once validation has run — the gate
      // can't know yet whether the captcha or the blocklists will reject it.
      req._spamLogBase = base;
      return next();
    }

    Spam.logSubmission({ ...base, verdict: 'rejected', reason });
    console.log(`spamGate rejected ${endpoint} from ${ip}: ${reason}`);
    return respondBland(req, res);
  };
}

// Mirrors what a successful submission looks like closely enough to be uninformative —
// the same view and the same message contactusController renders on a real send.
function respondBland(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(200).json({ ok: true });
  }
  if (req.xhr || (req.get('accept') || '').includes('application/json')) {
    return res.status(200).send('Message Sent');
  }
  return res.status(200).render('contact-us-form-delivered', {
    static_path: '/static',
    title: 'Contact Us - Success',
    pageDescription: 'Success - we\'ve sent an email to your chosen contact for you',
    message: 'Success - we\'ve sent your email to your chosen contact',
  });
}

// Called by handlers once validation has finished, so the log records the real verdict
// rather than only what the gate saw.
function logOutcome(req, { verdict, reason }) {
  const base = req._spamLogBase;
  if (!base) return;
  Spam.logSubmission({ ...base, verdict, reason: reason || null });
}

module.exports = spamGate;
module.exports.logOutcome = logOutcome;
module.exports.HONEYPOT_FIELD = HONEYPOT_FIELD;
