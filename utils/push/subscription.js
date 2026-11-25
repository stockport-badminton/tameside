// Checking what a browser sends to POST /api/push/subscribe. Verbatim from Stockport (league-site
// 1a5f9d2), which ported it from the Hyde club site
// (lib/push/subscription.js), with teams as league team ids instead of "league|team" strings.

const { createHash } = require('node:crypto');

// Only endpoints on real browser push services, so the store cannot be used to make our
// sender POST to an arbitrary URL.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,                  // Chrome, Edge (Android), Samsung
  /^android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,                 // Safari / iOS
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)notify\.windows\.com$/,             // Edge (Windows)
];

const B64URL = /^[A-Za-z0-9_-]+=*$/;

/** The kinds a subscriber can choose. */
const NOTIFICATION_TYPES = /** @type {const} */ (['results', 'reminders']);

/** @param {string} endpoint */
function subscriptionId(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}

/**
 * A clean { endpoint, keys } or a throw whose message is safe to show the browser.
 * @param {any} sub
 */
function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object') throw new Error('missing subscription');
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 1024) throw new Error('invalid endpoint');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('invalid endpoint'); }
  if (url.protocol !== 'https:') throw new Error('invalid endpoint');
  if (!PUSH_HOSTS.some(re => re.test(url.hostname))) throw new Error('unsupported push service');
  const { p256dh, auth } = keys || {};
  for (const k of [p256dh, auth]) {
    if (typeof k !== 'string' || k.length > 200 || !B64URL.test(k)) throw new Error('invalid keys');
  }
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * Known types only, once each. Empty means all types.
 * @param {any} types
 * @returns {string[]}
 */
function validateTypes(types) {
  if (types == null) return [];
  if (!Array.isArray(types)) throw new Error('invalid types');
  return [...new Set(types.filter(t => /** @type {readonly string[]} */ (NOTIFICATION_TYPES).includes(t)))];
}

/**
 * Team ids that are in `allowed`, once each. At least one is required: following every team
 * in the league is not an option the page offers, and would be a lot of notifications.
 * @param {any} teams
 * @param {Iterable<number>} allowed
 * @returns {number[]}
 */
function validateTeams(teams, allowed) {
  if (!Array.isArray(teams)) throw new Error('invalid teams');
  const ok = new Set(allowed);
  const ids = [...new Set(teams.map(t => Number(t)).filter(t => Number.isInteger(t) && ok.has(t)))];
  if (!ids.length) throw new Error('pick at least one team');
  return ids;
}

module.exports = { NOTIFICATION_TYPES, subscriptionId, validateSubscription, validateTypes, validateTeams };
