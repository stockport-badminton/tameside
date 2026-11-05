// /admin/link-auth-accounts — which player is each login?
//
// Built in Aug 2026 as the one-time worklist for moving site roles out of Auth0 onto
// the player table, and widened in Nov 2026 to every account that can log in. Two
// reasons, both from the shared Auth0 tenant (Stockport's site uses it too):
//
//   - members now see their own club's stats, so a login needs a player, not just a role;
//   - Stockport approving someone lets them log in HERE as well, and nothing on our side
//     said which logins were ours. Measured 5 Nov 2026: 83 of 135 accounts able to log
//     in had no player row here, 46 of them Stockport's.
//
// A superadmin makes every link. Not self-service, by decision: anyone could pick "Dave
// Lee from Hyde", and a login address often says nothing about who someone is.
//
// Linking never writes a role. Roles are granted on the player edit form and the approve
// page; this screen only says who a login is. (Until Nov 2026 it copied the role from the
// account's Auth0 claims, which were frozen at the August cutover.)
const Auth = require('../models/auth');
const Player = require('../models/players');
const Club = require('../models/club');
const authz = require('../utils/authz');
const { classifyLeague } = require('../utils/authMigration');
const { matchName } = require('../utils/nameMatch');

const promisify = fn => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)));

const getAllClubsP = promisify(Club.getAll);

// No login in two years: a captain who skipped a season is still inside it. These are
// listed apart, as candidates for deleting from Auth0, rather than as work to do.
const STALE_DAYS = 730;
const NO_CLUB = 'No Club';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const lower = e => (e || '').toLowerCase();

// The name Auth0 holds for an account, or null. A password signup's `name` is its email
// address, which is most of the tenant: 63 of the 83 unlinked accounts had no usable name.
function displayName(u) {
  const parts = [u.given_name, u.family_name].filter(Boolean).join(' ').trim();
  if (parts.split(/\s+/).length >= 2) return parts;
  if (u.name && !u.name.includes('@') && u.name.trim().split(/\s+/).length >= 2) return u.name.trim();
  return null;
}

function isStale(u, now) {
  const last = u.last_login || (u.logins_count ? null : u.created_at);
  return !last || (now - Date.parse(last)) > STALE_DAYS * 864e5;
}

// Players whose name matches the account's, best first. Hints only, for a human to
// confirm. A player at No Club is labelled: the October seed clean-up parked ~200
// Stockport rows there, so a Stockport account matching one is usually a namesake.
function nameHints(name, players) {
  if (!name) return [];
  return players
    .map(p => ({ p, m: matchName(name, `${p.first_name} ${p.family_name}`) }))
    .filter(x => x.m && x.m.kind !== 'contains')
    .sort((a, b) => a.m.score - b.m.score)
    .slice(0, 3)
    .map(({ p, m }) => ({
      id: p.id,
      name: `${p.first_name} ${p.family_name}`,
      club: p.clubName || null,
      team: p.teamName || null,
      exact: m.kind === 'exact',
      parked: !p.clubName || p.clubName === NO_CLUB,
    }));
}

const asLinked = (p, via) => p ? {
  id: p.id,
  name: `${p.first_name} ${p.family_name}`,
  club: p.clubName || null,
  role: p.role || null,
  via,
} : null;

// Every account that can log in, sorted into what needs doing. Six queries in all,
// however big the tenant: per-account lookups once made this page take 12 seconds.
async function buildWorklist({ refresh = false, now = Date.now() } = {}) {
  const [users, clubs, accountIndex, emailIndex, contactIndex, players] = await Promise.all([
    Auth.listUsers({ refresh }),
    getAllClubsP(),
    Player.getAuthAccountIndex(),
    Player.getAuthEmailIndex(),
    Player.getContactEmailIndex(),
    Player.getNameIndex(),
  ]);

  const byAccount = new Map(accountIndex.map(r => [r.userId, r]));
  // An address recorded against two different players is ambiguous, and is not a link.
  const byEmail = new Map();
  const ambiguous = new Set();
  for (const r of emailIndex) {
    const prev = byEmail.get(r.email);
    if (prev && prev.id !== r.id) ambiguous.add(r.email);
    else byEmail.set(r.email, r);
  }
  for (const e of ambiguous) byEmail.delete(e);
  const byContact = new Map();
  for (const p of contactIndex) {
    if (p.playerEmail && !byContact.has(p.playerEmail)) byContact.set(p.playerEmail, p);
  }
  const ourClubs = new Set(clubs.map(c => c.name));

  const out = { linked: [], emailOnly: [], needsPlayer: [], otherLeague: [], stale: [], notApproved: 0, staleNotApproved: 0 };

  for (const u of users) {
    const md = u.app_metadata || {};
    if (md.betaAccess !== true) {
      out.notApproved++;
      if (isStale(u, now)) out.staleNotApproved++;
      continue;
    }
    const name = displayName(u);
    const entry = {
      userId: u.user_id,
      email: u.email,
      name,
      logins: u.logins_count || 0,
      lastLogin: u.last_login ? String(u.last_login).slice(0, 10) : null,
      claimClub: md.club || null,
      signedUpOn: md.league || null,
    };

    const account = byAccount.get(u.user_id);
    if (account) { entry.linked = asLinked(account, 'account'); out.linked.push(entry); continue; }
    const byAddr = byEmail.get(lower(u.email));
    if (byAddr) { entry.linked = asLinked(byAddr, 'email'); out.emailOnly.push(entry); continue; }

    const contact = byContact.get(lower(u.email));
    // The login address is this player's registered contact address: a strong hint, still
    // confirmed by a click, because shared family addresses happen.
    entry.contactMatch = contact ? {
      id: contact.id,
      name: `${contact.first_name} ${contact.family_name}`,
      club: contact.clubName,
      team: contact.teamName,
    } : null;
    entry.hints = nameHints(name, players).filter(h => !entry.contactMatch || h.id !== entry.contactMatch.id);

    if (isStale(u, now)) out.stale.push(entry);
    else if (classifyLeague(md, ourClubs).otherLeague || md.league === 'stockport') out.otherLeague.push(entry);
    else out.needsPlayer.push(entry);
  }

  const byRecent = (a, b) => String(b.lastLogin || '').localeCompare(String(a.lastLogin || ''));
  out.needsPlayer.sort(byRecent);
  out.otherLeague.sort(byRecent);
  out.canLogIn = out.linked.length + out.emailOnly.length + out.needsPlayer.length + out.otherLeague.length + out.stale.length;
  return out;
}

exports.list = async function(req, res, next) {
  if (!authz.isSuperAdmin(req)) return next(httpError(403, 'Forbidden'));
  try {
    const data = await buildWorklist({ refresh: req.query.refresh === '1' });
    res.render('admin/link-auth-accounts', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'Link Logins to Players',
      pageDescription: 'Which player each login belongs to',
      data,
      staleYears: STALE_DAYS / 365,
      flash: req.query.done ? String(req.query.done).slice(0, 200) : null,
    });
  } catch (err) {
    next(err);
  }
};

// The account comes from the tenant by id, never from the form: the form says which
// account and which player, and nothing else it says is used.
async function accountFromTenant(userId) {
  if (!userId) throw httpError(400, 'No account given');
  const users = await Auth.listUsers();
  const user = users.find(u => u.user_id === userId);
  if (!user) throw httpError(404, 'No Auth0 account with that id');
  return user;
}

function back(res, message) {
  res.redirect('/admin/link-auth-accounts?done=' + encodeURIComponent(message) + '#worklist');
}

exports.link = async function(req, res, next) {
  if (!authz.isSuperAdmin(req)) return next(httpError(403, 'Forbidden'));
  try {
    const playerId = parseInt(req.body.playerId, 10);
    if (!playerId) return next(httpError(400, 'Pick a player to link this login to'));
    const user = await accountFromTenant(req.body.userId);
    try {
      await Player.linkAuthAccount(playerId, { userId: user.user_id, email: user.email });
    } catch (err) {
      if (err.code === '23503') return next(httpError(400, 'No player #' + playerId));
      throw err;
    }
    back(res, `Linked ${user.email} to player #${playerId}.`);
  } catch (err) {
    next(err);
  }
};

exports.unlink = async function(req, res, next) {
  if (!authz.isSuperAdmin(req)) return next(httpError(403, 'Forbidden'));
  try {
    const user = await accountFromTenant(req.body.userId);
    await Player.unlinkAuthAccount(user.user_id, user.email);
    back(res, `Unlinked ${user.email}. It takes effect at their next login.`);
  } catch (err) {
    next(err);
  }
};

// Copy every address link a superadmin already made (approve page, the August backfill,
// this screen) across to an account-id link. Recomputed here rather than taken from the
// form, so it can only ever record what the worklist itself shows as linked by address.
exports.recordEmailLinks = async function(req, res, next) {
  if (!authz.isSuperAdmin(req)) return next(httpError(403, 'Forbidden'));
  try {
    const data = await buildWorklist({ refresh: true });
    for (const e of data.emailOnly) {
      await Player.linkAuthAccount(e.linked.id, { userId: e.userId });
    }
    back(res, `Recorded ${data.emailOnly.length} account ${data.emailOnly.length === 1 ? 'link' : 'links'}.`);
  } catch (err) {
    next(err);
  }
};

exports._buildWorklistForTesting = buildWorklist;
exports.STALE_DAYS = STALE_DAYS;
