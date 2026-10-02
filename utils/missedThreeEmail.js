// The notice sent to a club when one of its nominated players has missed three consecutive
// matches (/admin/missed-three). Built once, and the preview, the preview's rendered email
// and the send all use the same object — so what the results secretary checks is what goes.
//
// Everything comes from the server: the row from MissedThree.getPlayers, the recipients from
// MissedThree.getOfficers. Nothing from the request, because the send is a POST and a POST
// body is whatever the caller chose to write. (Ported from Stockport's utils/missedThreeEmail.)
const ejs = require('ejs');
const mailer = require('./mailer');

// Tameside's rule 18 — the same rule as Stockport's 19(b), numbered differently. One place,
// so a renumbering changes it once.
const RULE = '18';

const clean = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');

function pronouns(gender) {
  return gender === 'Female' ? { pronoun: 'she', possessive: 'her' } : { pronoun: 'he', possessive: 'his' };
}

// The sender's first name for the sign-off — or nothing, when all the session knows is an
// email address (passport-auth0's displayName is the address for a password login).
function signOffName(displayName) {
  const name = clean(displayName);
  if (!name || name.includes('@')) return '';
  return name.split(' ')[0];
}

// row: one MissedThree.getPlayers row. officers: that club's MissedThree.getOfficers rows.
// Returns mailer.send's arguments plus `recipients`, for the preview to list.
function buildMissedThreeNotice(row, officers, senderDisplayName) {
  const firstName = clean(row.firstName);
  const playerName = clean(`${row.firstName || ''} ${row.familyName || ''}`);
  const teamName = clean(row.teamName);
  const nextTeamName = clean(row.nextTeamName);
  const clubName = clean((officers[0] && officers[0].clubName) || '');
  const { pronoun, possessive } = pronouns(row.gender);
  const senderName = signOffName(senderDisplayName);

  const recipients = officers.filter(o => clean(o.email))
    .map(o => ({ name: clean(o.name), email: clean(o.email), role: o.role }));
  const subject = `${playerName}, ${teamName}`;
  const text = [
    'Hi,',
    '',
    `Noticed that ${firstName} has missed 3 consecutive games for the ${teamName} team now.`,
    '',
    `In order to remain a nominated player ${pronoun} should play the next match, ` +
      `or a member of the ${nextTeamName} team needs to be nominated in ${possessive} place ` +
      `to remain in line with rule ${RULE}.`,
    '',
    'Thanks',
    ...(senderName ? ['', senderName] : []),
  ].join('\n');

  return {
    template: 'missed-three',
    to: recipients.map(r => r.email),
    // Copied to, and replies go to, the mailbox the results secretary reads.
    bcc: true,
    replyTo: mailer.RESULTS_MAILBOX,
    subject,
    text,
    customId: 'MissedThree',
    data: {
      playerName, firstName, teamName, nextTeamName, pronoun, possessive, rule: RULE, senderName,
      // The footer prints this raw (it carries entities), so the club name is escaped here.
      whyReceiving: 'You are receiving this because you are listed as a club or match secretary for '
        + ejs.escapeXML(clubName || 'your club') + ' in the league&rsquo;s records.',
    },
    recipients,
  };
}

module.exports = { buildMissedThreeNotice, RULE };
