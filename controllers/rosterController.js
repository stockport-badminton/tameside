// Team management: a club's read-only roster, the results secretary's editor, and the
// intent endpoints the editor writes through.
//
// Ported from Stockport (league-site controllers/rosterController.js). It replaces
// playerController.manage_player_list_clubs_teams + views/team-admin.ejs, which rendered one
// template for both audiences behind a `superadmin` flag and wrote through
// POST /player/batch-update.
//
// **Access is narrower than Stockport's, deliberately (decided 11 Oct 2026):**
//   - a club admin can VIEW their own club's roster, contact details included;
//   - every change — reorder, move, remove, add, create, transfer — is superadmin only.
// The write routes carry requireSuperAdmin in app.js, so nothing here re-checks club scope
// for a write. With no club-admin writes there are no transfer *requests* either, so
// Stockport's transfer email isn't ported: a superadmin's transfer is simply applied.

const Roster = require('../models/roster');
const authz = require('../utils/authz');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
const badRequest = (message) => httpError(400, message);

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

// Groups a flat roster into the cards both views render. Seeded from the team list, so a
// team with nobody registered still shows (and is somewhere a player can be put).
function groupByTeam(rows, teams) {
  const byId = new Map();
  for (const t of teams) {
    byId.set(Number(t.id), {
      id: Number(t.id),
      name: t.name,
      teamRank: t.teamRank,
      divisionName: t.divisionName || null,
      nominated: { Male: [], Female: [] },
      reserve: { Male: [], Female: [] },
      counts: { nominated: 0, reserve: 0, noContact: 0 },
    });
  }
  for (const row of rows) {
    const team = byId.get(Number(row.teamId));
    if (!team) continue;
    // Only Male/Female reach here: the one 'Other' row is player 0, which the model excludes.
    const gender = row.gender === 'Female' ? 'Female' : 'Male';
    const section = Roster.isReserve(row.rank) ? 'reserve' : 'nominated';
    const flag = (v) => v === 1 || v === true || v === '1';
    const player = {
      playerId: row.playerId,
      name: row.name,
      gender,
      rank: row.rank,
      teamCaptain: flag(row.teamCaptain),
      clubSecretary: flag(row.clubSecretary),
      matchSecretary: flag(row.matchSecrertary),
      tel: row.tel || null,
      email: row.email || null,
      rating: row.rating,
    };
    team[section][gender].push(player);
    team.counts[section]++;
    if (!player.tel && !player.email) team.counts.noContact++;
  }
  // Display position within its list, so reserves read R1, R2… whatever their stored
  // number (99, 100…), and the view never counts rows.
  for (const team of byId.values()) {
    for (const section of ['nominated', 'reserve']) {
      for (const gender of ['Male', 'Female']) {
        team[section][gender].forEach((p, i) => { p.position = i + 1; });
      }
    }
  }
  return Array.from(byId.values());
}

function summarise(teamCards) {
  const players = teamCards.flatMap((t) => ['nominated', 'reserve']
    .flatMap((s) => ['Male', 'Female'].flatMap((g) => t[s][g])));
  return {
    players: players.length,
    teams: teamCards.length,
    nominated: teamCards.reduce((n, t) => n + t.counts.nominated, 0),
    reserves: teamCards.reduce((n, t) => n + t.counts.reserve, 0),
    noContact: players.filter((p) => !p.tel && !p.email).length,
  };
}

// The club named in the URL, if the viewer may see it. 'All' is a superadmin's claim, not
// a club name, so it is refused here like any other unknown club.
async function loadClub(req) {
  const clubName = req.params.club;
  if (!clubName || clubName === 'All') throw httpError(404, 'No such club');
  if (!authz.hasClubAccess(req, clubName)) throw httpError(403, "You can only see your own club's players");
  const [rows, teams] = await Promise.all([Roster.getClubRoster(clubName), Roster.getClubTeams(clubName)]);
  if (!teams.length) throw httpError(404, 'No such club');
  const teamCards = groupByTeam(rows, teams);
  return { clubName, teams, teamCards, summary: summarise(teamCards) };
}

const viewBase = (extra) => Object.assign({
  static_path: '/static',
  theme: process.env.THEME || 'flatly',
  useRosterCss: true,
}, extra);

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

// GET /manage-players — a superadmin picks a club; a club admin goes straight to theirs.
exports.club_picker = async function (req, res, next) {
  try {
    if (!authz.isSuperAdmin(req)) {
      const own = authz.isAdmin(req) && authz.userClub(req);
      if (own && own !== 'All') return res.redirect('/manage-players/club-' + encodeURIComponent(own));
      return next(httpError(403, "You aren't attached to a club, so there's no roster to show"));
    }
    res.render('roster-clubs', viewBase({
      title: 'Team Management',
      pageDescription: 'Pick a club to see or manage its registered players',
      clubs: await Roster.getClubSummaries(),
    }));
  } catch (err) {
    next(err);
  }
};

// GET /manage-players/club-:club — the read-only roster, with contact details.
exports.club_roster = async function (req, res, next) {
  try {
    const data = await loadClub(req);
    res.render('roster', viewBase({
      title: data.clubName + ' — Registered Players',
      pageDescription: 'Registered players and nominated order for ' + data.clubName,
      clubName: data.clubName,
      teamCards: data.teamCards,
      summary: data.summary,
      canEdit: authz.isSuperAdmin(req),
    }));
  } catch (err) {
    next(err);
  }
};

// GET /manage-players/club-:club/edit — the editor (requireSuperAdmin on the route).
exports.club_roster_edit = async function (req, res, next) {
  try {
    const data = await loadClub(req);
    res.render('roster-edit', viewBase({
      title: 'Manage ' + data.clubName,
      pageDescription: 'Manage registered players for ' + data.clubName,
      clubName: data.clubName,
      teamCards: data.teamCards,
      summary: data.summary,
      // The club switcher: every real club with a team (No Club is already excluded).
      clubs: (await Roster.getClubSummaries()).filter((c) => c.teams > 0).map((c) => c.name),
      // Every team at the club, including empty ones: the destinations for "Move to…".
      moveTargets: data.teams.map((t) => ({ id: Number(t.id), name: t.name })),
    }));
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------------
// Intent endpoints — all superadmin only (requireSuperAdmin on the route)
// ---------------------------------------------------------------------------

// Strict: parseInt would take '1; DROP TABLE player' and hand back 1. Bound as a parameter
// either way, so never an injection — but quietly acting on player 1 because the payload
// was junk is its own kind of wrong. Refuse it.
function parseId(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    const n = parseInt(value.trim(), 10);
    if (Number.isSafeInteger(n) && n >= 1) return n;
  }
  throw badRequest(label + ' must be a positive integer');
}

const parseGender = (g) => (g === 'Female' ? 'Female' : g === 'Male' ? 'Male' : null);
const parseSection = (s) => (s === 'reserve' ? 'reserve' : s === 'nominated' ? 'nominated' : null);

// The { sections: [...] } body of a save: a gender, a section and an ordered id list each.
// No table names, no columns.
function parseSections(body) {
  if (!body || !Array.isArray(body.sections)) throw badRequest('sections must be an array');
  if (body.sections.length > 8) throw badRequest('too many sections');
  return body.sections.map((s) => {
    const gender = parseGender(s && s.gender);
    const section = parseSection(s && s.section);
    if (!gender) throw badRequest('gender must be Male or Female');
    if (!section) throw badRequest('section must be nominated or reserve');
    const ids = Array.isArray(s.playerIds) ? s.playerIds : [];
    if (ids.length > 200) throw badRequest('too many players in one section');
    return { gender, section, playerIds: ids.map((id) => parseId(id, 'playerIds')) };
  });
}

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) { next(err); }
};

// POST /api/teams/:id/order — save one team card's four lists.
exports.api_team_order = wrap(async (req, res) => {
  const teamId = parseId(req.params.id, 'team id');
  const sections = parseSections(req.body);
  if (!(await Roster.getTeamOwner(teamId))) throw httpError(404, 'No such team');
  const updated = await Roster.saveTeamOrder(teamId, sections);
  res.json({ ok: true, teamId, updated: updated.length, ranks: updated });
});

// POST /api/players/:id/move — another team and/or section. Across clubs this is a
// transfer; for a superadmin that is simply applied.
exports.api_player_move = wrap(async (req, res) => {
  const playerId = parseId(req.params.id, 'player id');
  const teamId = parseId(req.body && req.body.teamId, 'teamId');
  const section = parseSection(req.body && req.body.section);
  if (!section) throw badRequest('section must be nominated or reserve');
  const moved = await Roster.movePlayer(playerId, teamId, section);
  res.json({ ok: true, moved, team: moved.teamName });
});

// POST /api/players/:id/release — out of the team, still registered (No Club / No Team).
exports.api_player_release = wrap(async (req, res) => {
  const playerId = parseId(req.params.id, 'player id');
  res.json({ ok: true, released: await Roster.releasePlayer(playerId) });
});

// GET /api/roster/club-:club/candidates?term= — the add dialog's search, split into the
// three outcomes the UI offers as separate actions: own club, no club, another club.
exports.api_candidates = wrap(async (req, res) => {
  const clubName = req.params.club;
  const term = String(req.query.term || '').trim();
  if (term.length < 2) return res.json({ term, unattached: [], otherClubs: [], ownClub: [] });
  const found = await Roster.findCandidates(term, clubName);
  res.json({ term, unattached: found.unattached, otherClubs: found.otherClubs, ownClub: found.ownClub });
});

// The destination team must belong to the club in the URL: the editor is for one club, and
// a payload naming another club's team is a stale or hand-made request.
async function teamAtClub(teamId, clubName) {
  const dest = await Roster.getTeamOwner(teamId);
  if (!dest) throw httpError(404, 'No such team');
  if (dest.clubName !== clubName) throw badRequest(`${dest.name} is not a ${clubName} team`);
  return dest;
}

// POST /api/roster/club-:club/players — create a new player straight into a team.
exports.api_player_create = wrap(async (req, res) => {
  const body = req.body || {};
  const firstName = String(body.firstName || '').trim();
  const familyName = String(body.familyName || '').trim();
  const gender = parseGender(body.gender);
  const section = body.section === 'nominated' ? 'nominated' : 'reserve';
  const teamId = parseId(body.teamId, 'teamId');
  if (!firstName) throw badRequest('First name is required');
  if (!familyName) throw badRequest('Family name is required');
  if (firstName.length > 60 || familyName.length > 60) throw badRequest('Name is too long');
  if (!gender) throw badRequest('gender must be Male or Female');
  const dest = await teamAtClub(teamId, req.params.club);

  // Refuse, once, to create someone who looks already registered — a duplicate splits a
  // player's history and Elo. Two people really can share a name, so the client shows the
  // matches and resends with confirmNew to go ahead.
  if (body.confirmNew !== true) {
    const found = await Roster.findCandidates(firstName + ' ' + familyName, dest.clubName);
    const tag = (where) => (p) => Object.assign({ where }, p);
    const possible = [].concat(
      found.ownClub.map(tag('ownClub')),
      found.unattached.map(tag('unattached')),
      found.otherClubs.map(tag('otherClubs')),
    ).filter((p) => p.gender === gender && (p.match === 'exact' || p.match === 'close'));
    if (possible.length) {
      return res.status(409).json({ ok: false, error: 'This player may already be registered.',
        possibleDuplicates: possible.slice(0, 8) });
    }
  }

  const placed = await Roster.createPlayer({ firstName, familyName, gender, teamId: dest.id, section });
  res.json({ ok: true, created: { playerId: placed.playerId, name: placed.name, gender }, placed });
});

// POST /api/roster/club-:club/attach — add a player who is at no club.
exports.api_player_attach = wrap(async (req, res) => {
  const playerId = parseId(req.body && req.body.playerId, 'playerId');
  const teamId = parseId(req.body && req.body.teamId, 'teamId');
  const section = req.body.section === 'nominated' ? 'nominated' : 'reserve';
  const dest = await teamAtClub(teamId, req.params.club);
  const player = await Roster.getPlayerOwner(playerId);
  if (!player) throw httpError(404, 'No such player');
  // A player at a real club is a transfer, and the dialog offers that as its own action.
  if (player.clubId && player.clubId !== Roster.NO_CLUB_ID) {
    throw badRequest(`${player.name} is registered to ${player.clubName}. Use Transfer instead.`);
  }
  const placed = await Roster.addToTeam(playerId, dest.id, section);
  res.json({ ok: true, attached: { playerId, name: player.name }, placed });
});

// POST /api/roster/club-:club/transfer — bring a player over from another club. Applied
// directly: only a superadmin can reach this, and they are the person who approves
// transfers. Lands as a reserve, like Stockport's.
exports.api_transfer = wrap(async (req, res) => {
  const playerId = parseId(req.body && req.body.playerId, 'playerId');
  const teamId = parseId(req.body && req.body.teamId, 'teamId');
  const dest = await teamAtClub(teamId, req.params.club);
  const player = await Roster.getPlayerOwner(playerId);
  if (!player) throw httpError(404, 'No such player');
  const moved = await Roster.movePlayer(playerId, dest.id, 'reserve');
  res.json({ ok: true, applied: true, moved,
    message: `${player.name} transferred from ${player.clubName || 'no club'} to ${dest.name}` });
});

exports._groupByTeamForTesting = groupByTeam;
