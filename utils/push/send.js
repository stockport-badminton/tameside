// Fan-out: deliver one or more notifications to the subscriptions that want them, and delete
// the ones the push service says are gone. Ported from Stockport (league-site 1a5f9d2).
//
// `webpush` and `Push` are called through their modules, never destructured, so a test stub
// on the module object intercepts them (the same rule as utils/scorecardVision, CLAUDE.md).

const webpush = require('web-push');
const Push = require('../../models/push');
const { siteUrl } = require('../siteUrl');

const CONCURRENCY = 25;

/** False with no private key: the kill switch, and what every test and local run has. */
function configured() {
  return !!(process.env.VAPID_PRIVATE_KEY && process.env.VAPID_PUBLIC_KEY);
}

/**
 * @param {{ title: string, body: string, url: string, tag?: string,
 *   type?: 'results' | 'reminders', teams?: number[] }[]} notifications
 * @param {{ only?: string[] }} [opts]  only: subscription ids to send to (a test to one device)
 */
async function sendNotifications(notifications, opts = {}) {
  const summary = { notifications: notifications.length, subscribers: 0, sent: 0, failed: 0, removed: 0 };
  if (!configured()) return { ...summary, skipped: 'no VAPID key' };

  const options = {
    vapidDetails: {
      subject: siteUrl(),
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    },
    TTL: 24 * 60 * 60, // dropped if the device is offline for over a day
    urgency: 'normal',
  };

  const jobs = [];
  const reached = new Set();
  for (const n of notifications) {
    let subs = await Push.subscribersFor({ teams: n.teams, type: n.type });
    if (opts.only) subs = subs.filter(s => opts.only.includes(s.id));
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url || '/', tag: n.tag });
    for (const s of subs) { jobs.push({ s, payload }); reached.add(s.id); }
  }
  summary.subscribers = reached.size;

  const dead = new Set();
  const ok = new Set();
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async ({ s, payload }) => {
      if (dead.has(s.id)) return;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options);
        summary.sent++;
        ok.add(s.id);
      } catch (err) {
        // 404/410: the browser unsubscribed, or the subscription expired.
        if (err.statusCode === 404 || err.statusCode === 410) dead.add(s.id);
        else {
          summary.failed++;
          console.warn('[push] send failed', JSON.stringify({ statusCode: err.statusCode, body: err.body, message: err.statusCode ? undefined : err.message }));
        }
      }
    }));
  }

  summary.removed = await Push.removeSubscriptions([...dead]);
  await Push.markSent([...ok]);
  return summary;
}

module.exports = { configured, sendNotifications, CONCURRENCY };
