// /admin/link-auth-accounts — the one-time worklist for moving site-wide authorization
// out of Auth0 app_metadata and onto the player table.
//
// Why a screen rather than the CSV the backfill script eats: about two thirds of
// role-holders cannot be matched automatically, because a person's Auth0 login address
// is usually not the contact address on their player row (measured: 29 of 93 match).
// Each of those needs a human to say which player an account belongs to, and doing that
// in a spreadsheet means 64 blind id lookups with no validation until the backfill runs.
// Here each one is a search-and-click, and authEmail — the link the login lookup
// depends on — is recorded from a known-good source every time.
//
// Superadmin only. Every write goes through Player.setAuthRole, the same function the
// player edit form and the approval flow use.
const Auth = require('../models/auth');
const Player = require('../models/players');
const Club = require('../models/club');
const authz = require('../utils/authz');
const { isRoleHolder, classifyLeague, targetFromClaims } = require('../utils/authMigration');

const promisify = fn => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)));

const getAllClubsP = promisify(Club.getAll);

function forbidden() {
  const err = new Error('Forbidden');
  err.status = 403;
  return err;
}

// Build the worklist: every tenant account carrying authorization that is ours to
// migrate, annotated with what the DB currently says and what we'd propose.
async function buildWorklist({ refresh = false } = {}) {
  const [users, clubs, alreadyRoled] = await Promise.all([
    Auth.listUsers({ refresh }),
    getAllClubsP(),
    Player.getAllWithSiteRole(),
  ]);

  const ourClubNames = new Set(clubs.map(c => c.name));
  const holders = users.filter(u => isRoleHolder(u.app_metadata));

  const ours = [];
  const otherLeague = [];
  const ambiguous = [];

  for (const u of holders) {
    const league = classifyLeague(u.app_metadata, ourClubNames);
    const entry = {
      userId: u.user_id,
      email: u.email,
      logins: u.logins_count || 0,
      lastLogin: u.last_login ? String(u.last_login).slice(0, 10) : null,
      league: (u.app_metadata || {}).league || null,
      claimClub: league.club,
      target: targetFromClaims(u.app_metadata),
    };

    if (league.ambiguous) { ambiguous.push(entry); continue; }
    if (league.otherLeague) { otherLeague.push(entry); continue; }
    ours.push(entry);
  }

  // Resolve each of ours against the DB. Sequential rather than Promise.all: every one
  // of these decrypts an email column to compare it, and the pool is capped at 5
  // (utils/db_connect.js) — firing 93 at once just queues them behind each other while
  // holding every connection the rest of the site needs.
  for (const entry of ours) {
    const live = await Player.getAuthRoleByEmail(entry.email);
    entry.linked = live ? {
      id: live.id,
      name: `${live.first_name} ${live.family_name}`,
      club: live.clubName,
      role: live.role,
      statsAccess: live.statsAccess == 1,
    } : null;
    // Only worth proposing when nothing is linked yet.
    if (!entry.linked) {
      const guess = await Player.getByPlayerEmail(entry.email);
      entry.proposed = guess ? {
        id: guess.id,
        name: `${guess.first_name} ${guess.family_name}`,
        club: guess.clubName,
        team: guess.teamName,
        // A proposal whose club matches the claim is much more likely to be right.
        clubMatchesClaim: !!entry.claimClub && guess.clubName === entry.claimClub,
      } : null;
    }
  }

  const pending = ours.filter(e => !e.linked);
  return {
    ours,
    pending,
    linkedCount: ours.length - pending.length,
    proposedCount: pending.filter(e => e.proposed).length,
    otherLeague,
    ambiguous,
    alreadyRoled,
    // A role on a player nobody's Auth0 account resolves to. Worth surfacing: it means
    // either a hand-granted role (fine) or a link that has drifted (not fine).
    orphanRoles: alreadyRoled.filter(p => !ours.some(e => e.linked && e.linked.id === p.id)),
  };
}

exports.list = async function(req, res, next) {
  if (!authz.isSuperAdmin(req)) return next(forbidden());
  try {
    const data = await buildWorklist({ refresh: req.query.refresh === '1' });
    res.render('admin/link-auth-accounts', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'Link Auth0 Accounts',
      pageDescription: 'Move site-wide roles from Auth0 onto the player table',
      data,
      flash: req.query.linked
        ? `Linked ${req.query.linked}${req.query.as ? ' as ' + req.query.as : ''}.`
        : null,
    });
  } catch (err) {
    next(err);
  }
};

exports.link = async function(req, res, next) {
  if (!authz.isSuperAdmin(req)) return next(forbidden());
  try {
    const playerId = parseInt(req.body.playerId, 10);
    const email = (req.body.email || '').trim();
    if (!playerId || !email) {
      const err = new Error('Both a player and an account email are required');
      err.status = 400;
      return next(err);
    }

    // The role written is the one the *tenant* claims, re-read server-side rather than
    // taken from the form — the form is a worklist, not the authority on anyone's
    // access. This also means a tampered POST cannot invent a superadmin.
    const users = await Auth.listUsers();
    const user = users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
    if (!user) {
      const err = new Error('No Auth0 account with that email');
      err.status = 404;
      return next(err);
    }

    const clubs = await getAllClubsP();
    const league = classifyLeague(user.app_metadata, new Set(clubs.map(c => c.name)));
    if (league.otherLeague) {
      // Includes the ambiguous ones. Reaching this means the form was submitted for an
      // account the worklist does not offer, so refuse rather than quietly widening the
      // rule the whole migration rests on.
      const err = new Error(
        'That account belongs to the other league (' +
        (league.saysOtherLeague ? 'league=stockport' : 'club "' + league.club + '" is not a Tameside club') +
        '). Grant the role on the player edit form if it is genuinely needed here.'
      );
      err.status = 400;
      return next(err);
    }

    const target = targetFromClaims(user.app_metadata);
    await Player.setAuthRole(playerId, {
      role: target.role,
      statsAccess: target.statsAccess,
      // The point of the whole exercise: record the address this identity logs in with,
      // which is what getAuthRoleByEmail will match on from now on.
      authEmail: user.email,
    });

    res.redirect('/admin/link-auth-accounts?linked=' +
      encodeURIComponent(user.email) + '&as=' + encodeURIComponent(target.role || 'no role'));
  } catch (err) {
    next(err);
  }
};

exports._buildWorklistForTesting = buildWorklist;
