// POST /webhooks/mailjet — Mailjet's event callbacks.
//
// WHY THIS EXISTS. A captain's address stopped receiving league email and there was
// nothing to look at. Mailjet's REST API is no help after the fact: the message-level log
// only goes back a few weeks, its `Status` filter is silently ignored (asking for
// `?Status=blocked` returns recently *delivered* messages), and `DeliveredCount` on a
// contact reads 0 for everybody including addresses you can watch receive mail. The only
// reliable signal was a per-contact lookup showing `IsSpamComplaining: true` — which says
// what happened but not what the receiving server said, and only if you already suspect
// the address.
//
// So: capture the events as they happen. A `blocked` or `bounce` event carries the
// receiving server's own text in `error_related_to` / `error` / `comment`, which is the
// difference between "Outlook is blocking us" and a diagnosis.
//
// WHAT MATTERS MOST HERE IS `spam`. A single junk click permanently suppresses that
// address in Mailjet — no bounce, no rejection, nothing in the logs, mail simply stops.
// This is the only way to find out on the day rather than months later.
//
// AUTHENTICATION. Mailjet does not sign event callbacks, so the URL carries a shared
// secret: configure it as `https://tameside-badminton.co.uk/webhooks/mailjet?t=<token>`
// and set MAILJET_WEBHOOK_TOKEN to the same value. Without the token the route 404s
// rather than 401s, so a scanner learns nothing about what lives here.
//
// It always answers 200 on a payload it accepted. Mailjet retries a non-2xx, and there is
// nothing to gain from making it retry a message we have already written down.

const EVENTS_OF_CONCERN = new Set(['bounce', 'blocked', 'spam', 'unsub']);

// Mailjet posts either one event object or an array of them, depending on whether
// grouping is enabled on the callback.
function asEvents(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') return [body];
  return [];
}

// The receiving server's own words, wherever Mailjet put them this time. The field names
// differ by event type and have changed over the years, so this reads all of them rather
// than betting on one.
function reasonFrom(event) {
  const parts = [
    event.error_related_to && `related_to=${event.error_related_to}`,
    event.error && `error=${event.error}`,
    event.error_code && `code=${event.error_code}`,
    event.comment && `comment=${event.comment}`,
    event.blocked_reason && `blocked=${event.blocked_reason}`,
    event.hard_bounce === true && 'hard_bounce',
    event.hard_bounce === false && 'soft_bounce',
    event.source && `source=${event.source}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : 'no reason given';
}

exports.receive = function (req, res) {
  const expected = process.env.MAILJET_WEBHOOK_TOKEN;
  // No token configured means the endpoint is not in use; behave as if it does not exist.
  if (!expected) return res.status(404).end();
  if (req.query.t !== expected) return res.status(404).end();

  const events = asEvents(req.body);
  if (!events.length) return res.status(400).json({ error: 'expected an event payload' });

  for (const event of events) {
    const type = String(event.event || 'unknown');
    const email = String(event.email || 'unknown');
    const customId = event.CustomID || event.custom_id || '';
    const line = `[mailjet] ${type} ${email}`
      + (customId ? ` (${customId})` : '')
      + ` :: ${reasonFrom(event)}`;

    // console.error for the events that mean somebody has stopped receiving mail, so they
    // stand out in the Cloud Run logs; console.log for the routine ones (open, click,
    // sent) in case grouping is ever turned on for those too.
    if (EVENTS_OF_CONCERN.has(type)) console.error(line);
    else console.log(line);
  }

  res.json({ ok: true, received: events.length });
};

exports._reasonFromForTesting = reasonFrom;
exports._asEventsForTesting = asEvents;
