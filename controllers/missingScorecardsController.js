// The daily "missing scorecards" email to the results secretary.
//
// Ported from Stockport's getLateScorecards (league-site controllers/fixtureController.js,
// gated in their 1dd78f2). Cloud Scheduler calls GET /tasks/missing-scorecards?t=<token>
// each morning; see docs/missing-scorecards.md.
//
// Differences from Stockport, each deliberate:
// - Gate is `?t=` + 404 via requireCronCaller, like this repo's other scheduler endpoints,
//   not their X-Late-Scorecard-Token header + 403.
// - Recipients come from MISSING_SCORECARDS_TO, not a hardcoded list.
// - No month-based "out of season" check. The query is a one-day slice of actual fixtures,
//   so in summer it is simply empty — and inlined month math is what models/season.js
//   exists to stop.

const Fixture = require('../models/fixture');
const mailer = require('../utils/mailer');

// Report a match this many days after it was played. Same as Stockport.
const DAYS_AGO = 6;

const recipients = () => (process.env.MISSING_SCORECARDS_TO || '')
  .split(',').map(s => s.trim()).filter(Boolean);

exports.DAYS_AGO = DAYS_AGO;

exports.run = async function (req, res, next) {
  try {
    res.json(await exports.sendMissingScorecards());
  } catch (err) { next(err); }
};

/**
 * Build and send the email. Returns what it did; a day with nothing missing is a
 * successful run that sends nothing.
 */
exports.sendMissingScorecards = async function () {
  const rows = await Fixture.getCardsDueToday(DAYS_AGO);
  const fixtures = rows.map(r => ({ date: r.dateLabel, homeTeam: r.homeTeam, awayTeam: r.awayTeam }));

  // Nothing outstanding is not worth an email. Stockport's original 500'd here — the daily
  // job failed precisely on the days when everything was in order.
  if (!fixtures.length) return { sent: false, reason: 'no missing scorecards', fixtures: 0 };

  const n = fixtures.length;
  const to = recipients();
  await mailer.send({
    template: 'missing-scorecards',
    to: to.length ? to : mailer.RESULTS_MAILBOX,
    replyTo: mailer.RESULTS_MAILBOX,
    subject: `${n} missing scorecard${n === 1 ? '' : 's'}`,
    text: [
      `${n} fixture${n === 1 ? '' : 's'} played ${DAYS_AGO} days ago with no scorecard entered:`,
      '',
      ...fixtures.map(f => `  ${f.date}: ${f.homeTeam} v ${f.awayTeam}`),
    ].join('\n'),
    data: {
      fixtures,
      daysAgo: DAYS_AGO,
      whyReceiving: 'You are receiving this because you are the league&rsquo;s results '
        + 'secretary and a scorecard is overdue.',
    },
    customId: 'MissingScorecards',
  });

  return { sent: true, fixtures: n };
};
