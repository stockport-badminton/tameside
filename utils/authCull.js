// Which Tameside logins the monthly cull warns, waits on, or lists for deletion. Pure.
//
// The Auth0 tenant is shared with the Stockport league site, so each site culls its own
// accounts and the split has to leave none in both and none in neither (agreed 5 Nov 2026):
//
//   Tameside: accounts linked to a Tameside player (player_auth_account), plus unlinked
//             accounts that signed up on our site (app_metadata.league = 'tameside').
//   Stockport: accounts linked to a Stockport player, plus unlinked accounts not tagged
//             'tameside', minus anything in our player_auth_account.
//
// `league` records where someone signed up, not whose they are: 15 accounts tagged
// 'stockport' are linked to Tameside players, and Google signups carry no tag at all (the
// pre-user-registration Action does not run for social logins). So the link decides, and
// the tag only covers the unlinked.
//
// Last-login is tenant-wide, so a login used on either site is not inactive here.

const INACTIVE_DAYS = 365;
const GRACE_DAYS = 30;
const DAY = 864e5;

const time = v => (v ? Date.parse(v) : 0);

// The latest sign of life: a login, the keep link, or the signup itself for an account
// never used.
function lastActive(user, notice) {
  return Math.max(time(user.last_login) || time(user.created_at), time(notice && notice.kept_at));
}

/**
 * @param {object[]} users      Auth0 accounts (user_id, email, last_login, created_at, app_metadata)
 * @param {Map} linked          user_id -> player row, from player_auth_account
 * @param {Map} notices         user_id -> auth_account_notice row
 * @param {number} now
 * @returns {{ notify, waiting, due }} each a list of { user, player, reason, ... }
 *
 * notify:  inactive, and not warned since they were last active. Send the warning.
 * waiting: warned, no sign of life since, inside the month's grace.
 * due:     warned a month ago with no answer; or one that cannot be warned (never approved,
 *          so it never could log in, or no address to write to). For a human to delete.
 */
function classify(users, linked, notices, now = Date.now()) {
  const out = { notify: [], waiting: [], due: [] };
  for (const user of users) {
    const md = user.app_metadata || {};
    const player = linked.get(user.user_id) || null;
    if (!player && md.league !== 'tameside') continue;

    const notice = notices.get(user.user_id) || null;
    const active = lastActive(user, notice);
    if (now - active <= INACTIVE_DAYS * DAY) continue;

    const entry = { user, player, lastActive: new Date(active).toISOString().slice(0, 10) };
    if (md.betaAccess !== true) { out.due.push({ ...entry, reason: 'never approved' }); continue; }
    if (!user.email) { out.due.push({ ...entry, reason: 'no address to warn' }); continue; }

    const warned = time(notice && notice.notified_at);
    // A warning older than their last activity belongs to an earlier year's cycle.
    if (!warned || warned < active) { out.notify.push(entry); continue; }
    const expires = warned + GRACE_DAYS * DAY;
    const notified = new Date(warned).toISOString().slice(0, 10);
    if (now < expires) out.waiting.push({ ...entry, notified, expires: new Date(expires).toISOString().slice(0, 10) });
    else out.due.push({ ...entry, notified, reason: 'no answer to the warning' });
  }
  return out;
}

module.exports = { classify, INACTIVE_DAYS, GRACE_DAYS };
