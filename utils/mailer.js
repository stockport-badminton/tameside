// Sending an email, in one place.
//
// Before this, nine emails were built at nine call sites across three files: seven as
// inline HTML string literals, one from a Mailjet-hosted template (TemplateID 6134550,
// i.e. outside version control), and two from SendGrid-exported EJS. Three of those files
// each created their own Mailjet client. Adding an email meant copying whichever block
// looked closest.
//
// Now: `send({ template, data, to, subject, text })`. The template is one of
// views/emails/*.ejs, compiled from emails/*.mjml by `npm run build:email`.
//
// WHAT THIS DELIBERATELY OWNS
//
//   - The From address. It was `results@` in eight places and `website@` in one, for no
//     reason anybody recorded. Both are on the verified domain, so both authenticate;
//     one of them is just harder to recognise in an inbox.
//   - A TextPart on every message. Some senders had none. A message with no plain-text
//     alternative scores worse with spam filters and renders as an empty body in a
//     text-only client.
//   - The `whyReceiving` line the footer prints. It is per-email because the audiences
//     differ — a captain, a club secretary hearing from a stranger, a player on the
//     mailing list — and a transactional email nobody can place is one somebody marks as
//     junk. That is not hypothetical here: a spam complaint in Mailjet suppresses that
//     address permanently and leaves no bounce behind to diagnose.
//
// The Mailjet client is exported as `client` so the controllers can keep re-exporting it
// as `_mailjetClientForTesting`, which is the seam the existing integration tests stub to
// make sure they never send a real email.

const path = require('path');
const ejs = require('ejs');
const mailjet = require('node-mailjet').apiConnect(process.env.MAILJET_KEY, process.env.MAILJET_SECRET);

const TEMPLATE_DIR = path.join(__dirname, '..', 'views', 'emails');

// Every league email comes from here. `results@` rather than `website@`: it is the
// address people already recognise, and it is the one the ReplyTo generally points at.
const FROM = { Email: 'results@tameside-badminton.co.uk', Name: 'Tameside Badminton League' };

// The results mailbox, which is copied on anything a captain does so there is a record.
const RESULTS_MAILBOX = 'tameside.badders.results@gmail.com';

// Turn a block of operator- or public-typed text into the HTML the templates expect.
// Escaped first, then newlines become <br /> — the templates print it with <%- %>, so
// escaping here is what stops a contact-form submission injecting markup into an email
// sent to a club secretary.
function textToHtml(text) {
  return ejs.escapeXML(String(text == null ? '' : text)).replace(/\r?\n/g, '<br />');
}

function renderTemplate(name, data) {
  return new Promise((resolve, reject) => {
    ejs.renderFile(path.join(TEMPLATE_DIR, name + '.ejs'), data || {},
      (err, html) => (err ? reject(err) : resolve(html)));
  });
}

const asRecipients = (value) => (Array.isArray(value) ? value : [value])
  .filter(Boolean)
  .map(v => (typeof v === 'string' ? { Email: v } : v));

/**
 * Render a template and send it.
 *
 * @param {string} template  name of a views/emails/*.ejs (no extension)
 * @param {object} data      template variables; `whyReceiving` reaches the footer
 * @param {string} subject
 * @param {string} text      the plain-text alternative — required, see above
 * @param {string|object|Array} to
 * @param {string|object|Array} [bcc]   omit for no Bcc; pass `true` for the results mailbox
 * @param {string|object} [replyTo]
 * @param {string} [customId]           shows up in Mailjet's message log
 */
async function send({ template, data, subject, text, to, bcc, replyTo, customId }) {
  if (!template) throw new Error('send() needs a template');
  if (!subject) throw new Error(`send(${template}) needs a subject`);
  if (!text) throw new Error(`send(${template}) needs a plain-text alternative`);
  const recipients = asRecipients(to);
  if (!recipients.length) throw new Error(`send(${template}) has no recipients`);

  const html = await renderTemplate(template, data);

  const message = {
    From: FROM,
    To: recipients,
    Subject: subject,
    TextPart: text,
    HTMLPart: html,
  };
  if (replyTo) message.ReplyTo = asRecipients(replyTo)[0];
  const bccList = bcc === true ? asRecipients(RESULTS_MAILBOX) : asRecipients(bcc);
  if (bccList.length) message.Bcc = bccList;
  if (customId) message.CustomID = customId;

  return mailjet.post('send', { version: 'v3.1' }).request({ Messages: [message] });
}

module.exports = {
  send,
  renderTemplate,
  textToHtml,
  client: mailjet,
  FROM,
  RESULTS_MAILBOX,
};
