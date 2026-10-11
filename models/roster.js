// Roster reads and writes for the team-management pages.
//
// Ported from Stockport (league-site models/roster.js, current as of Oct 2026 — including
// 06824a0 "let a reserve actually be promoted" and b5a99744 "kill the roster N+1"). It
// replaces POST /player/batch-update, which took a table, a column list and rows from the
// request and wrote them. These functions take intent instead ("this team's nominated men
// are, in order, these ids") and derive the SQL themselves.
//
// Differences from Stockport, each deliberate:
//   - postgres.js tagged templates and sql.begin, not pg + `?` + db.withTransaction.
//   - No `team.withdrawn` filters: Tameside has no withdrawn-team concept.
//   - Contact columns decrypt with DB_ENCODE (theirs is DB_PI_KEY).
//   - No `junior` column here.
//   - Player 0 ("No Player", parked at No Club / No Team) is excluded everywhere, as in
//     every other player query in this repo.
//   - Every write resolves the player and team INSIDE its transaction, and a placement
//     always renumbers the destination list, so a NULL-ranked player can't leave two
//     players holding the same rank. Theirs read MAX(rank), which ignores NULLs.
//   - createPlayer places the new player in the same transaction as the INSERT. Theirs
//     created, then placed in a second transaction, so a failure between the two left a
//     player on a team with no rank.
//
// ## The rank convention (utils/rosterRank.js)
//
//   rank 1..N   nominated, in strength order, per team *and gender*
//   rank >= 99  reserve, in order (99 is the first reserve, 100 the second, ...)
//   NULL        unranked: a player not yet placed. Treated as nominated, listed last.
//
// Ranks are per (team, gender) because a fixture picks the men and the ladies
// independently — a team's number 1 man and number 1 lady both hold rank 1.
//
// ## Rank planning is pure
//
// planSection / planGender decide which rows get which rank from plain arrays, and
// applyRanks writes the result in one statement. The planning is where the bugs were
// (Stockport's promoted-reserve bug was a planning bug), and there is no local database to
// test SQL against, so the planning is what the unit tests exercise.

const { sql } = require('../utils/db_connect');
const { rankByName } = require('../utils/nameMatch');
const { RESERVE_BASE, isReserve } = require('../utils/rosterRank');
const { NO_CLUB_ID } = require('./clubRegistration');

// The holding pen for a player with no club: club 63 is 'No Club', team 52 'No Team'
// (both confirmed by name against production, 11 Oct 2026). Remove parks a player there
// rather than deleting the row, so their match history and Elo survive and any club can
// pick them up next season.
const NO_TEAM_ID = 52;

// Nominated before reserve, always: a save settles the two together, and the nominated
// list gets first claim on a player named in both.
const SECTIONS = ['nominated', 'reserve'];

// One display name everywhere, so a name matches between the roster, the search results
// and a toast. Collapses the runs of whitespace a few stored names carry.
const fullName = () => sql`REGEXP_REPLACE(TRIM(CONCAT(player.first_name, ' ', player.family_name)), '\\s+', ' ', 'g')`;

function notFound(what) {
  const err = new Error(`No such ${what}`);
  err.status = 404;
  return err;
}

const sectionOf = (rank) => (isReserve(rank) ? 'reserve' : 'nominated');

// ---------------------------------------------------------------------------
// Pure rank planning
// ---------------------------------------------------------------------------

// `current` is [{id, rank}] for one (team, gender), ordered rank NULLS LAST, id.
// Returns [{id, rank}] for the rows whose rank must change — an unchanged row is never
// written, so `updated` stays an honest count.
function ranksFor(order, current) {
  const byId = new Map(current.map((r) => [Number(r.id), r]));
  const updated = [];
  for (const section of SECTIONS) {
    const base = section === 'reserve' ? RESERVE_BASE : 1;
    (order[section] || []).forEach((id, i) => {
      const rank = base + i;
      const existing = byId.get(id);
      if (existing && existing.rank !== null && Number(existing.rank) === rank) return;
      updated.push({ id, rank });
    });
  }
  return updated;
}

// Renumbers ONE section to `orderedIds`, taking section membership from the stored ranks.
// It cannot move anyone between nominated and reserve — it exists to close the gap a
// departing player leaves (and to give a placed player and any NULL-ranked ones a proper
// number). A save that changes who is nominated goes through planGender.
//
// Ids not already in this section are ignored, so a stale page can't drag a player in.
// Anyone in the section the caller didn't mention keeps their relative order at the bottom.
function planSection(current, section, orderedIds = []) {
  const inSection = current.filter((r) => sectionOf(r.rank) === section);
  const allowed = new Set(inSection.map((r) => Number(r.id)));
  const seen = new Set();
  const order = [];
  for (const id of orderedIds) {
    const n = Number(id);
    if (allowed.has(n) && !seen.has(n)) { seen.add(n); order.push(n); }
  }
  for (const r of inSection) {
    const n = Number(r.id);
    if (!seen.has(n)) { seen.add(n); order.push(n); }
  }
  return ranksFor({ [section]: order }, inSection);
}

// Renumbers both sections of one (team, gender) from the order the caller asked for.
// `wanted` is { nominated: [...ids], reserve: [...ids] }; either may be absent.
//
// Section membership comes from the PAYLOAD, not from the rank each player holds. Deriving
// it from the rank is the Stockport bug this was ported after: a promoted reserve was
// dropped from the nominated list for not already being nominated, re-appended to the
// reserves as an unmentioned member, and the save wrote nothing and reported success.
function planGender(current, wanted = {}) {
  const ids = new Set(current.map((r) => Number(r.id)));
  const claimed = new Set();
  const order = { nominated: [], reserve: [] };
  for (const section of SECTIONS) {
    for (const id of wanted[section] || []) {
      const n = Number(id);
      // Only players already in this team and gender. Cross-team moves go through
      // movePlayer, so a stale page can't relocate anyone by posting an order.
      if (ids.has(n) && !claimed.has(n)) { claimed.add(n); order[section].push(n); }
    }
  }
  // Anyone the payload didn't mention keeps the section their rank puts them in, at the
  // bottom of it — a stale payload shouldn't orphan a player or silently reclassify them.
  for (const r of current) {
    const n = Number(r.id);
    if (claimed.has(n)) continue;
    claimed.add(n);
    order[sectionOf(r.rank)].push(n);
  }
  return ranksFor(order, current);
}

// The rank a player placed at the end of a section gets: one past the highest there.
// A reserve list that is empty (or holds only legacy 99s) starts at / continues from 99.
function appendRank(current, section) {
  const ranks = current
    .filter((r) => r.rank !== null && r.rank !== undefined && sectionOf(r.rank) === section)
    .map((r) => Number(r.rank));
  const max = ranks.length ? Math.max(...ranks) : 0;
  return section === 'reserve' ? Math.max(max + 1, RESERVE_BASE) : max + 1;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Every registration at a club, with team, division and decrypted contact details for the
// read-only roster. pgp_sym_decrypt throws on a NULL key, so a missing DB_ENCODE fails the
// page loudly rather than showing everyone as "no contact on file".
exports.getClubRoster = async function (clubName) {
  const key = process.env.DB_ENCODE;
  return sql`
    SELECT player.id::int AS "playerId",
           player.first_name AS "firstName",
           player.family_name AS "familyName",
           ${fullName()} AS name,
           player.gender,
           player.rank,
           player."teamCaptain",
           player."clubSecretary",
           player."matchSecrertary",
           player.treasurer,
           player.date_of_registration AS "registered",
           player.rating,
           team.id::int AS "teamId",
           team.name AS "teamName",
           team.rank AS "teamRank",
           division.name AS "divisionName",
           club.id::int AS "clubId",
           club.name AS "clubName",
           CASE WHEN player."playerTel" IS NULL THEN NULL
                ELSE pgp_sym_decrypt(player."playerTel", ${key})::text END AS tel,
           CASE WHEN player."playerEmail" IS NULL THEN NULL
                ELSE pgp_sym_decrypt(player."playerEmail", ${key})::text END AS email
    FROM player
    JOIN team ON team.id = player.team
    JOIN club ON club.id = team.club
    LEFT JOIN division ON division.id = team.division
    WHERE club.name = ${clubName} AND player.id <> 0
    ORDER BY team.rank NULLS LAST, team.name, player.gender,
             player.rank NULLS LAST, player.family_name`;
};

// Teams at a club in its own pecking order — the cards on the page and the destinations
// for "Move to…". Separate from the roster read so a team with no players yet still shows.
exports.getClubTeams = async function (clubName) {
  return sql`
    SELECT team.id::int AS id, team.name, team.rank AS "teamRank",
           division.name AS "divisionName"
    FROM team
    JOIN club ON club.id = team.club
    LEFT JOIN division ON division.id = team.division
    WHERE club.name = ${clubName} AND team.id <> ${NO_TEAM_ID}
    ORDER BY team.rank NULLS LAST, team.name`;
};

// Every club with its team and player counts — the superadmin's entry point. The nav used
// to link straight to /manage-players/club-Aerospace: one club standing in for a picker.
// Counts come from separate subqueries: counting both in one GROUP BY multiplies them.
exports.getClubSummaries = async function () {
  const rows = await sql`
    SELECT club.id::int AS id, club.name,
           (SELECT COUNT(*) FROM team WHERE team.club = club.id)::int AS teams,
           (SELECT COUNT(*) FROM player JOIN team t2 ON t2.id = player.team
             WHERE t2.club = club.id AND player.id <> 0)::int AS players
    FROM club
    WHERE club.id <> ${NO_CLUB_ID}
    ORDER BY club.name`;
  return rows.map((r) => ({ id: r.id, name: r.name, teams: r.teams, players: r.players }));
};

// The club a team belongs to. `q` is a transaction when called from a write.
exports.getTeamOwner = async function (teamId, q = sql) {
  const [row] = await q`
    SELECT team.id::int AS id, team.name, team.club::int AS "clubId", club.name AS "clubName"
    FROM team JOIN club ON club.id = team.club
    WHERE team.id = ${teamId}`;
  return row || null;
};

// Which club and team a player currently sits in. clubId falls back to player.club when
// the player has no team, so a scope check never skips them for lacking one (Stockport's
// `if (player.clubName)` let a teamless player through unchecked).
exports.getPlayerOwner = async function (playerId, q = sql) {
  const [row] = await q`
    SELECT player.id::int AS id, ${fullName()} AS name, player.gender, player.rank,
           player.team::int AS "teamId", team.name AS "teamName",
           COALESCE(team.club, player.club)::int AS "clubId", club.name AS "clubName"
    FROM player
    LEFT JOIN team ON team.id = player.team
    LEFT JOIN club ON club.id = COALESCE(team.club, player.club)
    WHERE player.id = ${playerId} AND player.id <> 0`;
  return row || null;
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function genderRows(q, teamId, gender) {
  return q`
    SELECT id::int AS id, rank FROM player
    WHERE team = ${teamId} AND gender = ${gender} AND id <> 0
    ORDER BY rank NULLS LAST, id`;
}

// Writes a settled list of ranks in ONE statement. It was a query per player inside the
// transaction on the Stockport side, which Sentry flagged as an N+1 (their NODE-13): a
// squad is 8-12 players, so a reorder held a transaction open across 8-12 round trips.
// `unnest` binds the ids and ranks as two arrays, so no SQL is built from a length. The
// team and gender stay in the WHERE, so a planning bug can't write into another list.
async function applyRanks(q, teamId, gender, updated) {
  if (!updated.length) return;
  await q`
    UPDATE player AS p SET rank = u.rank
    FROM unnest(${updated.map((u) => Number(u.id))}::int[], ${updated.map((u) => Number(u.rank))}::int[]) AS u(id, rank)
    WHERE p.id = u.id AND p.team = ${teamId} AND p.gender = ${gender}`;
}

async function renumberSection(q, teamId, gender, section, orderedIds = []) {
  const updated = planSection(await genderRows(q, teamId, gender), section, orderedIds);
  await applyRanks(q, teamId, gender, updated);
  return updated;
}

// Saves a whole team card in one transaction. `sections` is
// [{ gender: 'Male', section: 'nominated', playerIds: [...] }, ...]; they are regrouped by
// gender because "who is nominated" is one decision about one list of people.
// All-or-nothing: a partial apply is what left teams ranked 1, 2, 4, 6 before.
async function saveTeamOrderIn(tx, teamId, sections) {
  const byGender = new Map();
  for (const s of sections) {
    if (!byGender.has(s.gender)) byGender.set(s.gender, {});
    byGender.get(s.gender)[s.section] = s.playerIds || [];
  }
  const updated = [];
  for (const [gender, wanted] of byGender) {
    const plan = planGender(await genderRows(tx, teamId, gender), wanted);
    await applyRanks(tx, teamId, gender, plan);
    updated.push(...plan);
  }
  return updated;
}

// Puts a player at the end of a team's section, re-homing their club to the team's, and
// renumbers both the list they left and the one they joined. Inside a transaction.
async function place(tx, player, team, section) {
  const dest = await genderRows(tx, team.id, player.gender);
  const rank = appendRank(dest.filter((r) => r.id !== player.id), section);
  await tx`UPDATE player SET team = ${team.id}, club = ${team.clubId}, rank = ${rank}
           WHERE id = ${player.id}`;
  if (player.teamId && player.teamId !== NO_TEAM_ID) {
    await renumberSection(tx, player.teamId, player.gender, sectionOf(player.rank));
  }
  // Always, even for an append: it gives any NULL-ranked players in the list a real number
  // after the newcomer instead of leaving two players able to claim the same one.
  await renumberSection(tx, team.id, player.gender, section);
  const [after] = await tx`SELECT rank FROM player WHERE id = ${player.id}`;
  return Number(after.rank);
}

// Moves a player to another team and/or section. For a superadmin this is also how a
// transfer between clubs is applied: the player takes the destination team's club.
async function movePlayerIn(tx, playerId, destTeamId, destSection) {
  const player = await exports.getPlayerOwner(playerId, tx);
  if (!player) throw notFound('player');
  const team = await exports.getTeamOwner(destTeamId, tx);
  if (!team) throw notFound('team');
  const rank = await place(tx, player, team, destSection);
  return { playerId: player.id, name: player.name, teamId: team.id, rank,
    fromClub: player.clubName, toClub: team.clubName };
}

// Takes a player out of their team without deleting them: parked at No Club / No Team so
// match history and Elo survive and any club can pick them up next season.
async function releasePlayerIn(tx, playerId) {
  const player = await exports.getPlayerOwner(playerId, tx);
  if (!player) throw notFound('player');
  await tx`UPDATE player SET club = ${NO_CLUB_ID}, team = ${NO_TEAM_ID}, rank = ${RESERVE_BASE}
           WHERE id = ${player.id}`;
  if (player.teamId && player.teamId !== NO_TEAM_ID) {
    await renumberSection(tx, player.teamId, player.gender, sectionOf(player.rank));
  }
  return { playerId: player.id, name: player.name, from: player.teamName };
}

// Creates a player AND places them, in one transaction. models/players.js:create issues a
// bare INSERT with no RETURNING, so it can't give back the id this needs.
async function createPlayerIn(tx, { firstName, familyName, gender, teamId, section }) {
  const team = await exports.getTeamOwner(teamId, tx);
  if (!team) throw notFound('team');
  const [row] = await tx`
    INSERT INTO player (first_name, family_name, gender, club, team, date_of_registration)
    VALUES (${firstName}, ${familyName}, ${gender}, ${team.clubId}, ${team.id}, ${new Date()})
    RETURNING id::int AS id`;
  const player = { id: row.id, gender, rank: null, teamId: null, name: `${firstName} ${familyName}` };
  const rank = await place(tx, player, team, section);
  return { playerId: row.id, name: player.name, teamId: team.id, rank };
}

// Each write is one transaction. The `...In` forms take a transaction from the caller, which
// is how tools/rehearse-roster.js runs every write against production and rolls it back.
const inTransaction = (fn) => (...args) => sql.begin((tx) => fn(tx, ...args));
exports.saveTeamOrder = inTransaction(saveTeamOrderIn);
exports.movePlayer = inTransaction(movePlayerIn);
// Adding an existing player (at no club, or at another club) is a move onto the team.
exports.addToTeam = exports.movePlayer;
exports.releasePlayer = inTransaction(releasePlayerIn);
exports.createPlayer = inTransaction(createPlayerIn);
exports._writesIn = { saveTeamOrderIn, movePlayerIn, releasePlayerIn, createPlayerIn };

// Everyone who could be the person being searched for, split the way the add flow offers
// them: at no club (add directly), at another club (a transfer), or already at this one (so
// nobody creates them a second time). utils/nameMatch.js is order-, typo- and
// nickname-tolerant; the table is ~1,200 rows, read once and ranked in JavaScript.
exports.allForMatching = async function () {
  return sql`
    SELECT player.id::int AS "playerId", ${fullName()} AS name, player.gender,
           club.name AS "clubName", player.club::int AS "clubId", team.name AS "teamName"
    FROM player
    LEFT JOIN club ON club.id = player.club
    LEFT JOIN team ON team.id = player.team
    WHERE player.id <> 0
    ORDER BY TRIM(player.family_name), TRIM(player.first_name)`;
};

exports.splitCandidates = function (rows, term, clubName) {
  const ranked = rankByName(rows, term, (r) => r.name);
  const isUnattached = (r) => r.clubId === null || Number(r.clubId) === NO_CLUB_ID;
  const isOwn = (r) => !isUnattached(r) && !!clubName && r.clubName === clubName;
  return {
    unattached: ranked.filter(isUnattached).slice(0, 20),
    otherClubs: ranked.filter((r) => !isUnattached(r) && !isOwn(r)).slice(0, 20),
    ownClub: ranked.filter(isOwn).slice(0, 20),
  };
};

exports.findCandidates = async function (term, clubName) {
  return exports.splitCandidates(await exports.allForMatching(), term, clubName);
};

exports.NO_CLUB_ID = NO_CLUB_ID;
exports.NO_TEAM_ID = NO_TEAM_ID;
exports.RESERVE_BASE = RESERVE_BASE;
exports.isReserve = isReserve;
exports.planSection = planSection;
exports.planGender = planGender;
exports.appendRank = appendRank;
