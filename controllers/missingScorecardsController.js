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
const SocialResultPost = require('../models/socialResultPost');
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
 * Result posts that did not reach Facebook or Instagram (models/socialResultPost.js). They
 * ride on this email rather than getting one of their own: it already goes to the results
 * secretary every morning, and a second daily email is how both become a filter rule.
 *
 * Fails soft. A broken queue read must not cost the missing-scorecards half, which is the
 * one with a deadline; it is logged and the section left out.
 */
async function socialPostsNeedingAttention() {
  try {
    const rows = await SocialResultPost.needingAttention();
    return rows.map(r => ({
      match: r.homeTeam && r.awayTeam ? `${r.homeTeam} v ${r.awayTeam}` : `fixture ${r.fixtureId}`,
      target: r.target,
      problem: r.problem,
    }));
  } catch (err) {
    console.error(`[missing-scorecards] could not read the result-post queue: ${err.message}`);
    return [];
  }
}

/**
 * Build and send the email. Returns what it did; a day with nothing missing is a
 * successful run that sends nothing.
 */
exports.sendMissingScorecards = async function () {
  const rows = await Fixture.getCardsDueToday(DAYS_AGO);
  const fixtures = rows.map(r => ({ date: r.dateLabel, homeTeam: r.homeTeam, awayTeam: r.awayTeam }));
  const socialPosts = await socialPostsNeedingAttention();

  // Nothing outstanding is not worth an email. Stockport's original 500'd here — the daily
  // job failed precisely on the days when everything was in order.
  if (!fixtures.length && !socialPosts.length) {
    return { sent: false, reason: 'no missing scorecards', fixtures: 0, socialPosts: 0 };
  }

  const n = fixtures.length;
  const p = socialPosts.length;
  const to = recipients();
  const subject = [
    n && `${n} missing scorecard${n === 1 ? '' : 's'}`,
    p && `${p} result post${p === 1 ? '' : 's'} to check`,
  ].filter(Boolean).join(', ');
  const text = [
    ...(n ? [
      `${n} fixture${n === 1 ? '' : 's'} played ${DAYS_AGO} days ago with no scorecard entered:`,
      '',
      ...fixtures.map(f => `  ${f.date}: ${f.homeTeam} v ${f.awayTeam}`),
    ] : []),
    ...(n && p ? [''] : []),
    ...(p ? [
      `${p} result post${p === 1 ? '' : 's'} did not reach Facebook or Instagram. Check before re-queueing: one the run did not finish may be live.`,
      '',
      ...socialPosts.map(s => `  ${s.match} (${s.target}): ${s.problem}`),
    ] : []),
  ].join('\n');

  await mailer.send({
    template: 'missing-scorecards',
    to: to.length ? to : mailer.RESULTS_MAILBOX,
    replyTo: mailer.RESULTS_MAILBOX,
    subject,
    text,
    data: {
      fixtures,
      socialPosts,
      daysAgo: DAYS_AGO,
      whyReceiving: 'You are receiving this because you are the league&rsquo;s results '
        + 'secretary and a scorecard or a result post needs attention.',
    },
    customId: 'MissingScorecards',
  });

  return { sent: true, fixtures: n, socialPosts: p };
};
