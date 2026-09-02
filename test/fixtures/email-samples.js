// The data each email send site passes to its template.
//
// Shared between test/email-templates.test.js (which renders every one and asserts on the
// result) and tools/preview-emails.js (which renders the same thing for a human to look
// at), so the preview cannot drift from what the tests actually check. If a caller changes
// what it supplies, this is the one place to update.

const fixture = {
  homeTeamName: 'Hyde A', awayTeamName: 'Mellor B',
  divisionName: 'Division 1', playedOn: 'Tue 2 Sep 2026',
};

module.exports = {
  'scorecard-received': {
    ...fixture, homeScore: 6, awayScore: 3, scoreLabel: 'games',
    enteredBy: 'captain@example.com',
    confirmUrl: 'https://tameside-badminton.co.uk/populated-scorecard-beta/2164',
    photoUrl: 'https://tameside-badminton.co.uk/scorecard-photo/2164',
  },
  'scorecard-photo-added': {
    ...fixture, homeScore: 6, awayScore: 3, scoreLabel: 'games',
    confirmUrl: 'https://tameside-badminton.co.uk/populated-scorecard-beta/2164',
    photoUrl: 'https://tameside-badminton.co.uk/scorecard-photo/2164',
  },
  'fixture-reminder': {
    ...fixture, enterUrl: 'https://tameside-badminton.co.uk/email-scorecard',
  },
  'website-updated': {
    ...fixture, homeScore: 6, awayScore: 3,
    resultUrl: 'https://tameside-badminton.co.uk/fixtures',
    imageUrl: 'https://tameside-badminton.co.uk/static/images/generated/Hyde-AMellor-B.png',
    matchStats: [
      { name: 'Andrew Capewell', teamName: 'Hyde A', gamesWon: 3, avgPtsFor: 20.6667, avgPtsAgainst: 14.25 },
      { name: 'Alice Cooper', teamName: 'Hyde A', gamesWon: 2, avgPtsFor: 18.5, avgPtsAgainst: 16 },
      { name: 'Neil Cooper', teamName: 'Mellor B', gamesWon: 1, avgPtsFor: 15.75, avgPtsAgainst: 19.5 },
    ],
  },
  'signup-received': {
    userEmail: 'newcaptain@outlook.com',
    approveUrl: 'https://tameside-badminton.co.uk/approve-user/auth0%7Cabc123',
  },
  'access-approved': {
    enterUrl: 'https://tameside-badminton.co.uk/email-scorecard',
    whyReceiving: 'You are receiving this because you asked for results-entry access on the league website.',
  },
  'contact-us': {
    senderEmail: 'someone@example.com', senderName: 'someone@example.com',
    messageHtml: 'Hello,<br />Is there space for a new team next season? We are based in Hyde '
      + 'and could field a mixed side.<br /><br />Thanks',
    whyReceiving: 'You are receiving this because you are listed as a contact for your club or the league.',
  },
  'league-notice': {
    subject: 'Handbooks are ready to collect', preview: 'Handbooks are ready to collect',
    messageHtml: 'The 2026/27 handbooks have arrived.<br /><br />Captains can collect them '
      + 'at the AGM on 18 September, or ask your club secretary to bring them along.',
    whyReceiving: 'You are receiving this because you are a registered player or club contact in the league.',
  },
};
