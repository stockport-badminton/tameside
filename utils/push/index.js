// Web push notifications: results as they are published, match reminders at 17:00 and 18:00.
// docs/push.md has the design. Every send is claimed in `push_send` first, so it goes at most
// once whoever asks for it again. Ported from Stockport (league-site 1a5f9d2).

const Push = require('../../models/push');
const send = require('./send');
const { REMINDER_KINDS, reminderDate, resultNotification, reminderNotification } = require('./notifications');

/**
 * Announce a just-published result to the followers of both teams. Called from the publish
 * request (fixtureController.full_fixture_post). Returns what happened, for the page.
 * @param {number} fixtureId
 */
async function notifyResult(fixtureId) {
  // Before the claim: claiming with no key would mark the result sent when nothing was.
  if (!send.configured()) return { skipped: 'no VAPID key' };
  const fixture = await Push.resultFor(fixtureId);
  const notification = fixture && resultNotification(fixture);
  if (!notification) return { skipped: 'no result' };

  const key = `result-${fixtureId}`;
  if (!(await Push.claimSend(key))) return { skipped: 'already sent' };
  const summary = await send.sendNotifications([notification]);
  await Push.recordSummary(key, summary);
  console.log('[push] result', JSON.stringify({ fixtureId, ...summary }));
  return summary;
}

/**
 * Reminders for every fixture still to be played on the day `when` names.
 * @param {'tonight' | 'tomorrow'} when
 * @param {{ now?: Date, date?: string, dry?: boolean }} [opts]
 *   date: the UK day to remind about, instead of the one `when` and `now` give (superadmin)
 *   dry: build and report, send nothing, claim nothing
 */
async function runReminders(when, opts = {}) {
  if (!REMINDER_KINDS.includes(when)) throw new Error('when must be one of ' + REMINDER_KINDS.join(', '));
  const date = opts.date || reminderDate(when, opts.now || new Date());
  const fixtures = await Push.remindersFor(date);
  const notifications = fixtures.map(f => reminderNotification(f, when));
  const titles = notifications.map(n => n.title);
  const report = { when, date, fixtures: fixtures.length, titles };

  if (opts.dry) return { ...report, dry: true };
  if (!notifications.length) return { ...report, note: 'no fixtures' };
  if (!send.configured()) return { ...report, skipped: 'no VAPID key' };

  const key = `reminders-${date}-${when}`;
  if (!(await Push.claimSend(key))) return { ...report, skipped: `${key} already sent` };
  const summary = await send.sendNotifications(notifications);
  await Push.recordSummary(key, summary);
  console.log('[push] reminders', JSON.stringify({ when, date, ...summary }));
  return { ...report, ...summary };
}

/**
 * A test notification from /admin/push: to one device (its subscription id), or to all.
 * @param {{ subscriptionId?: string, title?: string }} opts
 */
async function sendTest(opts) {
  if (!send.configured()) return { skipped: 'no VAPID key' };
  const key = `test-${Date.now()}`;
  await Push.claimSend(key);
  const summary = await send.sendNotifications([{
    title: opts.title || 'Test notification',
    body: 'Notifications from the Tameside league are working on this device.',
    url: '/notifications',
    tag: key,
  }], opts.subscriptionId ? { only: [opts.subscriptionId] } : {});
  await Push.recordSummary(key, { ...summary, to: opts.subscriptionId ? 'one device' : 'everyone' });
  return summary;
}

/** One line for the publish confirmation page. `pushed` is null when the step threw. */
function pushNote(pushed) {
  if (!pushed) return 'Push notifications could not be sent (the error is logged).';
  if (pushed.skipped === 'no VAPID key') return 'Push notifications are not configured on this server.';
  if (pushed.skipped === 'already sent') return 'Push notifications for this result were already sent.';
  if (pushed.skipped) return 'No push notifications sent: ' + pushed.skipped + '.';
  if (!pushed.subscribers) return 'Nobody follows these teams for push notifications yet.';
  return 'Push notification sent to ' + pushed.sent + ' of ' + pushed.subscribers + ' device' +
    (pushed.subscribers === 1 ? '' : 's') + (pushed.failed ? ' (' + pushed.failed + ' failed)' : '') + '.';
}

module.exports = { notifyResult, runReminders, sendTest, pushNote, configured: () => send.configured() };
