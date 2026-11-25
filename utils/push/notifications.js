// What a notification says. Pure: a fixture row from models/push.js in, a payload out.
// Ported from Stockport (league-site 1a5f9d2). Ours alone: a Lewis Shield tie is labelled
// "Lewis Shield", not with the home team's league division.

const { eventPath } = require('../siteUrl');

const TZ = 'Europe/London';
const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_KINDS = ['tonight', 'tomorrow'];

/** The UK calendar date of an instant, YYYY-MM-DD. @param {Date} d */
const ukDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

/**
 * The UK date a reminder run is about. +24h lands on the next UK date across a clock change
 * as long as `now` is not within an hour of midnight; the runs are at 17:00 and 18:00.
 * @param {'tonight' | 'tomorrow'} when @param {Date} now
 */
function reminderDate(when, now) {
  return ukDate(when === 'tomorrow' ? new Date(now.getTime() + DAY_MS) : now);
}

/** '19:30' → '7:30pm', '20:00' → '8pm'; anything else as it came, trimmed. */
function startTimeText(t) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec((t || '').trim());
  if (!m) return (t || '').trim();
  const h = Number(m[1]);
  if (h > 23) return t;
  const hour = h % 12 || 12;
  return `${hour}${m[2] === '00' ? '' : ':' + m[2]}${h < 12 ? 'am' : 'pm'}`;
}

const teamsOf = f => [Number(f.homeTeamId), Number(f.awayTeamId)];

/** "Lewis Shield" for a cup tie, otherwise the division. */
const competitionOf = f => (f.lewisRound != null ? 'Lewis Shield' : f.divisionName);

/** A published result, or null when the fixture has no result to announce. */
function resultNotification(f) {
  if (f.status !== 'complete' || f.homeScore == null || f.awayScore == null) return null;
  const competition = competitionOf(f);
  return {
    type: 'results',
    teams: teamsOf(f),
    title: `${f.homeTeam} ${f.homeScore}–${f.awayScore} ${f.awayTeam}`,
    body: competition ? `Result · ${competition}` : 'Result',
    url: eventPath(f),
    tag: `result-${f.id}`,
  };
}

/** @param {'tonight' | 'tomorrow'} when */
function reminderNotification(f, when) {
  const body = [startTimeText(f.startTime), f.venueName, competitionOf(f)].filter(Boolean).join(' · ');
  return {
    type: 'reminders',
    teams: teamsOf(f),
    title: `${when === 'tomorrow' ? 'Tomorrow' : 'Tonight'}: ${f.homeTeam} v ${f.awayTeam}`,
    body,
    url: eventPath(f),
    // One tag per kind: a notification with the same tag replaces the earlier one without
    // alerting, so tonight's would arrive silently over tomorrow's.
    tag: `reminder-${when}-${f.id}`,
  };
}

module.exports = { REMINDER_KINDS, ukDate, reminderDate, startTimeText, resultNotification, reminderNotification };
