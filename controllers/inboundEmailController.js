// POST /webhooks/resend: mail to a league list address, forwarded to the list.
// GET /admin/inbound-email: what arrived and what happened to it.
//
// docs/backlog/done/BL-04-inbound-email-resend.md is the design. In one line: a Namecheap
// catch-all forwards every address with no forward of its own to Resend, which calls this;
// we read the message back, recover which league address it was for, resolve that to a
// list, check the sender, and send it on through Mailjet. Resend RECEIVES ONLY.
//
// Things that matter more than they look:
//
//   - NOTHING UNRECOGNISED IS RELAYED, not even to the results mailbox. The catch-all
//     receives every dictionary-attack guess at the domain, and relaying spam from our own
//     sending domain would spend the Mailjet reputation this design exists to protect.
//     Refusals are logged (inbound_email) and stay in Resend's dashboard for 30 days.
//   - Unlike Stockport's, posting needs a KNOWN sender whose From is AUTHENTICATED. Theirs
//     lets anyone who knows `division1@` mail a whole division.
//   - The work is done BEFORE answering. Cloud Run throttles the CPU once the response is
//     sent, so a post-response send is not reliably run.
//   - A failure answers 500 so Resend retries, and per-recipient claims stop the retry from
//     sending twice to anyone the failed attempt reached.

const Sentry = require('@sentry/node');
const svix = require('../utils/svixSignature');
const mailer = require('../utils/mailer');
const List = require('../utils/listAddress');
const InboundEmail = require('../models/inboundEmail');
const Player = require('../models/players');
const PlayerRequests = require('./playerRequestController');
const RearrangementRequests = require('./rearrangementRequestController');
const { isSuperAdmin } = require('../utils/authz');
// A module, called through, so tests can stub it (as scorecardVision is).
const resendInbound = require('../utils/resendInbound');

// Where an unsubscribe request lands. A person reads it and decides: membership is computed
// from role flags, so "unsubscribing" a club secretary means they stop getting league
// business. Hence the mailto form and not one-click (Stockport's reasoning, in
// league-site contactusController.distribution_list).
const UNSUBSCRIBE_MAILBOX = 'results@tameside-badminton.co.uk';

const getEmails = (search) => new Promise((resolve, reject) =>
  Player.getEmails(search, (err, rows) => (err ? reject(err) : resolve(rows || []))));

// The results mailbox, tagged with the list, so every forward leaves a record a Gmail
// filter can sort.
const recordAddress = (label) => mailer.RESULTS_MAILBOX.replace('@', `+${label}@`);

const authSummary = (auth) => {
  const a = auth || {};
  return `spf=${a.spf || '?'} dkim=${a.dkim || '?'} dmarc=${a.dmarc || '?'}`;
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A notice above the original body, in both parts.
function withNotice(notice, html, text) {
  const t = text && String(text).trim() ? String(text) : mailer.htmlToText(html);
  const block = `<div style="border:1px solid #ccc;padding:8px;margin-bottom:12px;font-family:sans-serif;font-size:13px">${escapeHtml(notice).replace(/\n/g, '<br>')}</div>`;
  let h = html ? String(html) : mailer.textToHtml(t);
  h = /<body[^>]*>/i.test(h) ? h.replace(/<body[^>]*>/i, m => m + block) : block + h;
  return { html: h, text: `${notice}\n\n${t}` };
}

// Queue addresses, by local part. Each returns `{ outcome, detail? }`.
const QUEUES = {
  [PlayerRequests.LOCAL]: (email) => PlayerRequests.queueFromEmail(email),
  [RearrangementRequests.LOCAL]: (email) => RearrangementRequests.queueFromEmail(email),
};

/**
 * Everything after the signature and the claim. Returns the fields to record, `outcome`
 * among them. Throws only for something that should be retried.
 */
async function handle(emailId) {
  const email = await resendInbound.getEmail(emailId);
  const headers = email.headers || {};
  const fromHeader = List.headerValues(headers, 'from')[0];
  const sender = List.extractAddress(email.from) || List.extractAddress(fromHeader);
  const subject = email.subject || List.headerValues(headers, 'subject')[0] || '(no subject)';
  const out = {
    messageId: email.message_id || null,
    sender,
    subject,
    auth: authSummary(email.authentication),
  };

  if (List.isLoop(email, process.env.RESEND_INBOUND_DOMAIN)) return { ...out, outcome: 'loop' };

  const target = List.leagueAddress(email);
  if (!target) return { ...out, outcome: 'no-league-address' };
  out.leagueAddress = target.address;

  // A queue, not a list: the email is stored for a superadmin page instead of forwarded.
  // Same sender gate as a list. A refusal is listed on the queue's page, never relayed.
  const queue = QUEUES[String(target.local).toLowerCase()];
  if (queue) {
    out.list = target.local.toLowerCase();
    if (!List.isGenuineSender(email.authentication)) return { ...out, outcome: 'unauthenticated' };
    if (!await InboundEmail.isKnownSender(sender)) return { ...out, outcome: 'unknown-sender' };
    return { ...out, ...await queue(email) };
  }

  const vocab = List.buildVocabulary(await InboundEmail.vocabulary());
  const list = List.parseLocalPart(target.local, vocab);
  // Not a list. Also what every spammer's guess looks like.
  if (!list) return { ...out, outcome: 'not-a-list' };
  out.list = list.label;

  if (!List.isGenuineSender(email.authentication)) return { ...out, outcome: 'unauthenticated' };
  if (!await InboundEmail.isKnownSender(sender)) return { ...out, outcome: 'unknown-sender' };

  const search = { inDivision: true };
  if (list.role) search.role = list.role;
  if (list.division) search.division = list.division;
  if (list.club) search.club = list.club;
  const recipients = [...new Set((await getEmails(search)).map(e => String(e).trim().toLowerCase()))]
    .filter(e => e.includes('@'));
  if (!recipients.length) return { ...out, outcome: 'empty-list', recipients: 0 };

  // Attachments, up to Mailjet's limit; the rest are named in a notice instead.
  let files = [];
  let skipped = [];
  if (Array.isArray(email.attachments) && email.attachments.length) {
    const listed = await resendInbound.listAttachments(emailId);
    ({ files, skipped } = await resendInbound.downloadAttachments(listed, mailer.MAX_ATTACHMENT_BYTES));
  }

  const notices = [];
  const test = List.isTestSubject(subject);
  if (test) {
    notices.push(`Test: "test" is in the subject, so this went only to the results mailbox. `
      + `Without it, ${list.label}@ would have reached these ${recipients.length}:\n${recipients.join(', ')}`);
  }
  if (skipped.length) {
    notices.push(`Too large to forward: ${skipped.join(', ')}. Ask the sender for ${skipped.length > 1 ? 'them' : 'it'}.`);
  }
  let { html, text } = { html: email.html, text: email.text };
  if (notices.length) ({ html, text } = withNotice(notices.join('\n\n'), html, text));

  const replyTo = (Array.isArray(email.reply_to) && email.reply_to[0]) || fromHeader || sender;
  const message = {
    fromName: List.extractName(fromHeader) || sender,
    subject,
    html,
    text,
    to: recordAddress(list.label),
    replyTo: { Email: List.extractAddress(replyTo) || sender },
    headers: {
      'X-Original-From': sender,
      // Not List-Id: Mailjet reserves it and refuses the whole send ("Header cannot be
      // customized using the Headers collection", send-0011), with no property to set it
      // instead. Found on the first live forward, 7 Nov 2026. Our own header carries the
      // list, and is what the loop guard looks for.
      [List.LIST_HEADER]: list.label,
      'List-Unsubscribe': `<mailto:${UNSUBSCRIBE_MAILBOX}?subject=${encodeURIComponent('unsubscribe ' + list.label)}>`,
    },
    attachments: files,
    customId: `List:${list.label}`,
  };

  if (test) {
    await mailer.forward(message);
    return { ...out, outcome: 'test', recipients: recipients.length };
  }

  // Each league address on a message is its own Resend email, so a person on two of the
  // lists would get it twice without this. Keyed by Message-ID, not email_id.
  const messageKey = email.message_id || `resend:${emailId}`;
  const claimed = await InboundEmail.claimRecipients(messageKey, emailId, recipients);
  if (!claimed.length) return { ...out, outcome: 'already-sent', recipients: 0 };
  try {
    await mailer.forward({ ...message, bcc: claimed });
  } catch (err) {
    await InboundEmail.releaseRecipients(messageKey, claimed);
    throw err;
  }
  return {
    ...out,
    outcome: 'forwarded',
    recipients: claimed.length,
    detail: skipped.length ? `attachments left out: ${skipped.join(', ')}` : undefined,
  };
}

exports.receive = async function (req, res) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  // Unset means not in use. A bad signature looks the same, so a scanner learns nothing,
  // like /webhooks/mailjet.
  if (!secret || !Buffer.isBuffer(req.body) || !svix.verify(secret, req.headers, req.body)) {
    return res.status(404).end();
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'not JSON' });
  }
  if (!event || event.type !== 'email.received') return res.json({ ok: true, ignored: event && event.type });
  const emailId = event.data && event.data.email_id;
  if (!emailId) return res.status(400).json({ error: 'no email_id' });

  try {
    if (!await InboundEmail.claim(emailId)) return res.json({ ok: true, duplicate: true });
  } catch (err) {
    console.error('[inbound] claim failed', emailId, err && err.message);
    Sentry.captureException(err, { tags: { step: 'inbound email claim' } });
    return res.status(500).json({ error: 'try again' });
  }

  let result;
  try {
    result = await handle(emailId);
    await InboundEmail.record(emailId, result);
  } catch (err) {
    console.error('[inbound] failed', emailId, err && err.message);
    Sentry.captureException(err, { tags: { step: 'inbound email' } });
    await InboundEmail.record(emailId, { outcome: 'failed', detail: err && err.message })
      .catch(e => console.error('[inbound] could not record the failure', e && e.message));
    return res.status(500).json({ error: 'try again' });
  }

  console.log(`[inbound] ${result.outcome} ${result.leagueAddress || '-'} from ${result.sender || '-'}`
    + ` (${result.auth}) recipients=${result.recipients == null ? '-' : result.recipients}`);
  await InboundEmail.purge().catch(e => console.error('[inbound] purge failed', e && e.message));
  res.json({ ok: true, outcome: result.outcome });
};

// Outcomes a superadmin may need to act on: a real captain refused, or mail to a list
// that resolved to nobody.
const ATTENTION = new Set(['unknown-sender', 'unauthenticated', 'empty-list', 'failed']);

exports.adminList = async function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const [rows, days] = await Promise.all([InboundEmail.recent(200), InboundEmail.dailyCounts(14)]);
    res.render('admin/inbound-email', {
      static_path: '/static',
      title: 'Inbound list email',
      pageDescription: 'Mail received for the league list addresses, and what happened to it.',
      rows,
      days,
      attention: ATTENTION,
      logDays: InboundEmail.LOG_DAYS,
    });
  } catch (err) {
    next(err);
  }
};

exports._handleForTesting = handle;
