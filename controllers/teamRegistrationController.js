// Importing a club's returned team-registration form.
//
// The league sends each club a pre-filled registration form (the .docx from
// playerController, or the PDF AcroForm from documentsController), the club edits it and
// sends it back, and comparing it against the management UI by eye is slow and easy to
// get wrong. This screen does the comparison and applies the accepted changes in one go.
//
// Three routes, and the split between them is the whole security design:
//
//   GET  /admin/team-registrations          pick a club, choose a file
//   POST /admin/team-registrations/review   parse + diff, render the change list
//   POST /admin/team-registrations/apply    write the ticked changes
//
// THE CLIENT NEVER SAYS WHAT A CHANGE MEANS. The review page posts back a list of change
// KEYS (and, for an ambiguous name, which candidate the reviewer picked). The apply route
// re-parses the stored document, re-reads the database, re-runs the diff, and looks each
// key up in its own freshly computed result. So a tampered payload can only ever select
// from changes the server itself proposed — it cannot invent a team, a rank, or a club.
// That is also why apply re-reads rather than trusting a hidden field: it means the write
// reflects the database as it is now, not as it was when the page was rendered.
//
// The parsed document lives in the session between review and apply. It is a few KB of
// names and letters, it belongs to one reviewer, and it avoids both a temporary table and
// a round trip through S3 for a file that is only interesting for the next 30 seconds.

const Player = require('../models/players');
const Club = require('../models/club');
const Team = require('../models/teams');
const authz = require('../utils/authz');
const { parseRegistrationDocument } = require('../utils/registrationDoc');
const {
  diffRegistration, APPLICABLE_KINDS, RESERVE_RANK,
} = require('../utils/registrationDiff');

const promisify = (fn) => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result))));

const getAllClubsP = promisify(Club.getAll);
const getAllTeamsP = promisify(Team.getAll);
const createPlayerP = (first, family, team, club, gender) =>
  new Promise((resolve, reject) => Player.create(first, family, team, club, gender,
    (err, r) => (err ? reject(err) : resolve(r))));
const updateBulkP = promisify(Player.updateBulk);

// The placeholder club/team a removed player is parked at, matching what the existing
// team-admin remove button writes. Nothing is ever deleted by this screen: "No Club" is
// the league's archive — 486 of 1,138 players live there — and parking is reversible
// where a delete would not be.
const NO_CLUB_NAME = 'No Club';
const NO_TEAM_NAME = 'No Team';

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const renderOpts = (title, extra) => Object.assign({
  static_path: '/static',
  theme: process.env.THEME || 'flatly',
  title,
  pageDescription: title,
}, extra);

// A superadmin may import for any club; a club admin only for their own. Same rule as the
// team-admin screen this sits beside, and the write path (POST /player/batch-update and
// the apply route below) enforces it independently rather than trusting this check.
function assertClubAccess(req, clubName) {
  if (authz.isSuperAdmin(req)) return null;
  if (authz.isAdmin(req) && authz.hasClubAccess(req, clubName)) return null;
  return forbidden("You don't have access to import registrations for that club.");
}

// Everything the diff needs about the current state of the world.
async function loadDiffContext(club) {
  const allTeams = await getAllTeamsP();
  const teams = (allTeams || []).filter(t => Number(t.club) === Number(club.id));
  const roster = await Player.searchRosterForClub(club.id);
  const otherPlayers = await Player.searchRosterOutsideClub(club.id);
  return { club, teams, roster, otherPlayers };
}

/* ------------------------------------------------------------------ *
 * GET /admin/team-registrations — pick a club and a file
 * ------------------------------------------------------------------ */
exports.index = async function (req, res, next) {
  try {
    if (!authz.isSuperAdmin(req) && !authz.isAdmin(req)) {
      return next(forbidden("You don't have access to registration imports."));
    }
    const clubs = (await getAllClubsP() || [])
      .filter(c => c.name !== NO_CLUB_NAME)
      .filter(c => authz.isSuperAdmin(req) || authz.hasClubAccess(req, c.name))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.render('admin/team-registration-import', renderOpts('Import Team Registrations', {
      clubs, review: null, error: null,
    }));
  } catch (err) { next(err); }
};

/* ------------------------------------------------------------------ *
 * POST /admin/team-registrations/review — parse + diff, show the changes
 *
 * The uploaded file arrives as the raw request body (express.raw in app.js) rather than
 * as multipart: this repo has no multipart parser and does not need one for a single
 * file, and the browser can post a File object directly as a body.
 * ------------------------------------------------------------------ */
exports.review = async function (req, res, next) {
  try {
    const clubId = Number(req.query.club);
    if (!Number.isInteger(clubId)) return next(badRequest('Choose a club first.'));

    const clubs = await getAllClubsP() || [];
    const club = clubs.find(c => Number(c.id) === clubId);
    if (!club) return next(badRequest('No club with that id.'));

    const denied = assertClubAccess(req, club.name);
    if (denied) return next(denied);

    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return next(badRequest('No file was uploaded.'));
    }

    // Throws a 400-shaped error for an unreadable file, which the central handler renders
    // without a Sentry event — a club sending a scan is expected, not exceptional.
    const parsed = await parseRegistrationDocument(req.body, req.query.filename);

    const ctx = await loadDiffContext(club);
    const result = diffRegistration(parsed, ctx);

    // Keep only what apply needs to re-derive: the entries and the club the document
    // claims. Not the file, and not the computed changes.
    req.session.registrationImport = {
      clubId: Number(club.id),
      filename: String(req.query.filename || '').slice(0, 200),
      parsed: { club: parsed.club, source: parsed.source, entries: parsed.entries, warnings: parsed.warnings },
      at: Date.now(),
    };

    res.render('admin/team-registration-review', renderOpts(`Registrations — ${club.name}`, {
      club, result,
      filename: req.session.registrationImport.filename,
      // Named _list because the view builds a lookup object called `applicable` from it.
      applicable_list: [...APPLICABLE_KINDS],
    }));
  } catch (err) { next(err); }
};

/* ------------------------------------------------------------------ *
 * POST /admin/team-registrations/apply — write the ticked changes
 * ------------------------------------------------------------------ */
exports.apply = async function (req, res, next) {
  try {
    const stored = req.session.registrationImport;
    if (!stored || !stored.parsed) {
      return next(badRequest('That review has expired — upload the form again.'));
    }

    const clubs = await getAllClubsP() || [];
    const club = clubs.find(c => Number(c.id) === Number(stored.clubId));
    if (!club) return next(badRequest('That club no longer exists.'));

    const denied = assertClubAccess(req, club.name);
    if (denied) return next(denied);

    const selections = Array.isArray(req.body && req.body.selections) ? req.body.selections : null;
    if (!selections) return next(badRequest('Nothing was selected.'));
    if (selections.length > 500) return next(badRequest('Too many changes in one submission.'));

    // Re-derive from the stored document against the CURRENT database. This is the step
    // that makes the client's payload safe: whatever it asks for, the meaning of each key
    // comes from here.
    const ctx = await loadDiffContext(club);
    const result = diffRegistration(stored.parsed, ctx);
    const byKey = new Map(result.changes.map(c => [c.key, c]));

    const noClub = clubs.find(c => c.name === NO_CLUB_NAME);
    const allTeams = await getAllTeamsP() || [];
    const noTeam = allTeams.find(t => t.name === NO_TEAM_NAME);

    const applied = [];
    const skipped = [];
    const updates = [];   // rows for updateBulk: [id, team, rank, club]
    const inserts = [];   // { first, family, team, club, gender, label }

    for (const sel of selections) {
      const key = sel && typeof sel.key === 'string' ? sel.key : null;
      const change = key ? byKey.get(key) : null;
      if (!change) { skipped.push({ key, reason: 'no longer in the change list' }); continue; }

      if (!APPLICABLE_KINDS.has(change.kind)) {
        // Covers transfer / ambiguous / no-such-team / unchanged. A transfer ticked by a
        // tampered payload lands here rather than moving somebody between clubs.
        skipped.push({ key, label: change.name, reason: `"${change.kind}" changes are not applied from this screen` });
        continue;
      }

      if (change.kind === 'remove') {
        if (!noClub || !noTeam) { skipped.push({ key, label: change.name, reason: 'no "No Club" placeholder to park them at' }); continue; }
        updates.push([Number(change.player.id), Number(noTeam.id), RESERVE_RANK, Number(noClub.id)]);
        applied.push({ label: change.name, what: `parked at ${NO_CLUB_NAME}` });
        continue;
      }

      if (change.kind === 'new') {
        if (!change.targetTeamId) { skipped.push({ key, label: change.name, reason: 'no team to add them to' }); continue; }
        const parts = String(change.name).trim().split(/\s+/);
        if (parts.length < 2) { skipped.push({ key, label: change.name, reason: 'need a first and last name' }); continue; }
        inserts.push({
          first: parts[0], family: parts.slice(1).join(' '),
          team: Number(change.targetTeamId), club: Number(club.id), gender: change.gender,
          rank: Number(change.targetRank),
          label: change.name,
        });
        continue;
      }

      // order / team / reserve / reactivate are all the same write: put this existing
      // player on this team at this rank, in this club.
      if (!change.player || !change.targetTeamId) {
        skipped.push({ key, label: change.name, reason: 'no target team' }); continue;
      }
      updates.push([
        Number(change.player.id), Number(change.targetTeamId),
        Number(change.targetRank), Number(club.id),
      ]);
      applied.push({
        label: change.name,
        what: change.kind === 'reactivate'
          ? `joined ${change.targetTeamName}`
          : `${change.targetTeamName}${Number(change.targetRank) === RESERVE_RANK ? ', reserve' : ', no. ' + change.targetRank}`,
      });
    }

    // Updates go through the same gated bulk path the team-admin screen uses, so there is
    // one place that knows how to write these four columns.
    if (updates.length) {
      await updateBulkP({ tablename: 'player', fields: ['id', 'team', 'rank', 'club'], data: updates });
    }

    // Inserts are one at a time: Player.create takes a single row, and a new registration
    // is rare enough that a batch insert would be more code than it saves. A new player is
    // created on the team, then ranked by the same bulk path if they are nominated.
    const insertRanked = [];
    for (const ins of inserts) {
      try {
        const created = await createPlayerP(ins.first, ins.family, ins.team, ins.club, ins.gender);
        const newId = created && created[0] && created[0].id;
        applied.push({ label: ins.label, what: `added to ${ins.first ? '' : ''}team ${ins.team}` });
        if (newId && ins.rank !== RESERVE_RANK) insertRanked.push([Number(newId), ins.team, ins.rank, ins.club]);
      } catch (e) {
        skipped.push({ label: ins.label, reason: 'could not be created: ' + e.message });
      }
    }
    if (insertRanked.length) {
      await updateBulkP({ tablename: 'player', fields: ['id', 'team', 'rank', 'club'], data: insertRanked });
    }

    res.render('admin/team-registration-applied', renderOpts(`Registrations applied — ${club.name}`, {
      club, applied, skipped,
    }));
  } catch (err) { next(err); }
};
