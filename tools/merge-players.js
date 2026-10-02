#!/usr/bin/env node
// Merge duplicate player records. Dry by default.
//
//   node tools/merge-players.js --propose   # write scripts/player-merges.md, a checklist
//   node tools/merge-players.js             # dry run: what each TICKED line would change
//   node tools/merge-players.js --rehearse  # every merge for real, in ONE transaction, rolled back
//   node tools/merge-players.js --apply     # each ticked merge in its own transaction
//
// Why: utils/nameMatch.js found 36 pairs on 2 Oct 2026 — almost all a returning player whose
// old record was parked at No Club, recreated because the old add-player search only matched
// the first letter. POST /manage-players/create now asks first; this cleans up what exists.
//
// The checklist lives in scripts/ (gitignored: it is a list of names). A line is
//   - [x] KEEP <- DROP | ...description... | name: First Family
// and only ticked lines are merged. `name:` is the name the kept record ends up with.
//
// WHICH ID SURVIVES: the OLDER one. The player<season> archives are copies of the whole
// player table, so an old id has a row in every archive since 2023/24 and a new id is
// missing from seasons before it was created — keeping the new id would leave those
// seasons' history pages joining to nothing.
//
// WHICH REGISTRATION SURVIVES: the CURRENT one. If the dropped record is on a real team
// (not No Club / No Team), its team, club and rank move onto the kept id.
//
// What a merge does, in one transaction:
//  1. refuses if both ids appear in the same fixture (merging would field one person twice);
//  2. updates the kept row: registration as above, contact details and login-email column
//     from whichever has them (the dropped one's if both — it is the newer), role/statsAccess
//     and officer flags the stronger of the two, earliest registration date, chosen name;
//  3. re-points every reference: fixture's 12 slots, game's 4 players, scorecardstore's 28
//     slots, team.captain, club.clubSec/matchSec, player_auth_email.player;
//  4. archives: where the dropped id has a season row on a real team and the kept row does
//     not, that season's team/club/rank move to the kept row; the dropped row is removed;
//  5. deletes the dropped player, then checks nothing anywhere still references it — if
//     anything does, the whole merge rolls back.
//
// Elo is NOT recalculated here: each person has two rating histories until it is. Run the
// full recalc per season afterwards (GET /players/eloFullRecalc?season=..., superadmin).
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { sql } = require('../utils/db_connect');
const { matchName } = require('../utils/nameMatch');

const MODE = ['--propose', '--rehearse', '--apply'].find(f => process.argv.includes(f)) || '--dry';
const PLAN = path.join(__dirname, '..', 'scripts', 'player-merges.md');
const NO_CLUB = 63;
const ROLLBACK = Symbol('rehearsal rollback');

const FIXTURE_SLOTS = ['homeMan1', 'homeMan2', 'homeMan3', 'homeMan4', 'homeLady1', 'homeLady2',
  'awayMan1', 'awayMan2', 'awayMan3', 'awayMan4', 'awayLady1', 'awayLady2'];
const GAME_SLOTS = ['homePlayer1', 'homePlayer2', 'awayPlayer1', 'awayPlayer2'];
const MIXED = ['FirstMixedhomeMan1', 'FirstMixedhomeLady1', 'FirstMixedawayMan1', 'FirstMixedawayLady1',
  'SecondMixedhomeMan2', 'SecondMixedhomeLady2', 'SecondMixedawayMan2', 'SecondMixedawayLady2',
  'ThirdMixedhomeMan3', 'ThirdMixedhomeLady1', 'ThirdMixedawayMan3', 'ThirdMixedawayLady1',
  'FourthMixedhomeMan4', 'FourthMixedhomeLady2', 'FourthMixedawayMan4', 'FourthMixedawayLady2'];
const DRAFT_SLOTS = [...FIXTURE_SLOTS, ...MIXED];
const ROLE_RANK = { superadmin: 2, admin: 1 };

const fullName = p => `${String(p.first_name || '').trim()} ${String(p.family_name || '').trim()}`.trim();
const onRealTeam = p => p.team != null && p.club != null && Number(p.club) !== NO_CLUB && p.teamName && p.teamName !== 'No Team';

async function archiveTables(db) {
  return (await db`SELECT table_name FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name ~ '^player20[0-9]{6}$' ORDER BY 1`).map(r => r.table_name);
}

async function getPlayer(db, id, lock) {
  const rows = lock
    ? await db`SELECT p.*, t.name AS "teamName", c.name AS "clubName" FROM player p
                 LEFT JOIN team t ON t.id = p.team LEFT JOIN club c ON c.id = p.club
                WHERE p.id = ${id} FOR UPDATE OF p`
    : await db`SELECT p.*, t.name AS "teamName", c.name AS "clubName" FROM player p
                 LEFT JOIN team t ON t.id = p.team LEFT JOIN club c ON c.id = p.club WHERE p.id = ${id}`;
  return rows[0];
}

// Everything that points at `id`, by place. The merge requires this to be all zero for the
// dropped id before it commits.
async function references(db, id, archives) {
  const n = async (q) => (await q)[0].n;
  const out = {
    fixture: await n(db`SELECT count(*)::int n FROM fixture WHERE ${id} IN (${sql(FIXTURE_SLOTS)})`),
    game: await n(db`SELECT count(*)::int n FROM game WHERE ${id} IN (${sql(GAME_SLOTS)})`),
    draft: await n(db`SELECT count(*)::int n FROM scorecardstore WHERE ${id} IN (${sql(DRAFT_SLOTS)})`),
    captain: await n(db`SELECT count(*)::int n FROM team WHERE captain = ${id}`),
    officer: await n(db`SELECT count(*)::int n FROM club WHERE "clubSec" = ${id} OR "matchSec" = ${id}`),
    login: await n(db`SELECT count(*)::int n FROM player_auth_email WHERE player = ${id}`),
    archive: 0,
  };
  for (const t of archives) out.archive += await n(db`SELECT count(*)::int n FROM ${sql(t)} WHERE id = ${id}`);
  return out;
}

async function mergeOne(db, keepId, dropId, nameOverride, archives) {
  const k = await getPlayer(db, keepId, true);
  const d = await getPlayer(db, dropId, true);
  if (!k || !d) throw new Error(`#${keepId} or #${dropId} does not exist`);
  if (keepId === dropId || keepId === 0 || dropId === 0) throw new Error('bad pair');
  if (k.gender !== d.gender) throw new Error(`#${keepId} and #${dropId} differ in gender`);

  const together = (await db`SELECT count(*)::int n FROM fixture
                              WHERE ${keepId} IN (${sql(FIXTURE_SLOTS)}) AND ${dropId} IN (${sql(FIXTURE_SLOTS)})`)[0].n;
  if (together) throw new Error(`#${keepId} and #${dropId} both appear in ${together} fixture(s) — not the same person`);

  const reg = onRealTeam(d) ? d : k;
  const name = nameOverride || fullName(reg);
  const [first, ...rest] = name.split(/\s+/);
  const role = (ROLE_RANK[d.role] || 0) > (ROLE_RANK[k.role] || 0) ? d.role : k.role;
  const pick = (col) => (d[col] != null ? d[col] : k[col]);
  const max = (col) => Math.max(Number(k[col]) || 0, Number(d[col]) || 0);
  const earliest = [k.date_of_registration, d.date_of_registration].filter(Boolean).sort((a, b) => a - b)[0] || null;

  await db`UPDATE player SET
      first_name = ${first}, family_name = ${rest.join(' ')},
      team = ${reg.team}, club = ${reg.club}, rank = ${reg.rank},
      "playerEmail" = ${pick('playerEmail')}, "playerTel" = ${pick('playerTel')}, "authEmail" = ${pick('authEmail')},
      role = ${role || null}, "statsAccess" = ${max('statsAccess')},
      "teamCaptain" = ${max('teamCaptain')}, "clubSecretary" = ${max('clubSecretary')},
      "matchSecrertary" = ${max('matchSecrertary')}, treasurer = ${max('treasurer')}, "otherComms" = ${max('otherComms')},
      date_of_registration = ${earliest}
    WHERE id = ${keepId}`;

  for (const col of FIXTURE_SLOTS) await db`UPDATE fixture SET ${sql(col)} = ${keepId} WHERE ${sql(col)} = ${dropId}`;
  for (const col of GAME_SLOTS) await db`UPDATE game SET ${sql(col)} = ${keepId} WHERE ${sql(col)} = ${dropId}`;
  for (const col of DRAFT_SLOTS) await db`UPDATE scorecardstore SET ${sql(col)} = ${keepId} WHERE ${sql(col)} = ${dropId}`;
  await db`UPDATE team SET captain = ${keepId} WHERE captain = ${dropId}`;
  await db`UPDATE club SET "clubSec" = ${keepId} WHERE "clubSec" = ${dropId}`;
  await db`UPDATE club SET "matchSec" = ${keepId} WHERE "matchSec" = ${dropId}`;
  await db`UPDATE player_auth_email SET player = ${keepId} WHERE player = ${dropId}`;

  const seasons = [];
  for (const t of archives) {
    const [ka] = await db`SELECT id, team, club FROM ${sql(t)} WHERE id = ${keepId}`;
    const [da] = await db`SELECT id, team, club, rank FROM ${sql(t)} WHERE id = ${dropId}`;
    if (!da) continue;
    if (!ka) {
      await db`UPDATE ${sql(t)} SET id = ${keepId} WHERE id = ${dropId}`;
      seasons.push(t.slice(6) + ' (row moved)');
      continue;
    }
    const dReal = da.team != null && da.club != null && Number(da.club) !== NO_CLUB;
    const kReal = ka.team != null && ka.club != null && Number(ka.club) !== NO_CLUB;
    if (dReal && !kReal) {
      await db`UPDATE ${sql(t)} SET team = ${da.team}, club = ${da.club}, rank = ${da.rank} WHERE id = ${keepId}`;
      seasons.push(t.slice(6) + ' (team taken)');
    }
    await db`DELETE FROM ${sql(t)} WHERE id = ${dropId}`;
  }

  await db`DELETE FROM player WHERE id = ${dropId}`;
  const left = await references(db, dropId, archives);
  const stray = Object.entries(left).filter(([, v]) => v);
  if (stray.length) throw new Error(`#${dropId} is still referenced: ${stray.map(([k2, v]) => `${k2} ${v}`).join(', ')}`);
  return { name, registration: reg === d ? `${d.teamName} (from #${dropId})` : `${k.teamName || k.clubName || 'none'} (kept)`, seasons };
}

async function propose() {
  const players = await sql`
    SELECT p.id::int id, p.first_name, p.family_name, p.gender, p.date_of_registration, p.team, p.club, p.rank,
           t.name "teamName", c.name "clubName"
      FROM player p LEFT JOIN team t ON t.id = p.team LEFT JOIN club c ON c.id = p.club WHERE p.id <> 0`;
  const lines = [];
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
    const a = players[i], b = players[j];
    if (a.gender !== b.gender) continue;
    const m = matchName(fullName(a), fullName(b));
    if (!m || !(m.kind === 'exact' || (m.kind === 'close' && matchName(fullName(b), fullName(a))))) continue;
    const [k, d] = a.id < b.id ? [a, b] : [b, a];
    const reg = onRealTeam(d) ? d : k;
    const where = p => `${p.clubName || 'no club'}${p.teamName ? ' / ' + p.teamName : ''}`;
    lines.push(`- [x] ${k.id} <- ${d.id} | ${fullName(k)} (${where(k)}) <- ${fullName(d)} (${where(d)}) | ${m.kind} | name: ${fullName(reg)}`);
  }
  const doc = `# Duplicate players to merge

Generated ${new Date().toISOString().slice(0, 10)} by \`node tools/merge-players.js --propose\`.

**Untick any line that is NOT the same person.** Only ticked lines are merged.

Each line is \`KEEP <- DROP\`: the older id is kept (it has a row in every season archive),
and the current registration — the record on a real team — moves onto it. Edit \`name:\` to
change the name the merged record ends up with.

${lines.join('\n')}
`;
  fs.mkdirSync(path.dirname(PLAN), { recursive: true });
  fs.writeFileSync(PLAN, doc);
  console.log(`${lines.length} pairs written to ${path.relative(process.cwd(), PLAN)}`);
}

function readPlan() {
  const text = fs.readFileSync(PLAN, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[([xX ])\]\s+(\d+)\s*<-\s*(\d+)\b(.*)$/);
    if (!m || m[1] === ' ') continue;
    const name = (m[4].match(/\|\s*name:\s*(.+?)\s*$/) || [])[1];
    out.push({ keep: Number(m[2]), drop: Number(m[3]), name });
  }
  return out;
}

async function main() {
  console.log(`target : ${new URL(process.env.DATABASE_URL).host}\nmode   : ${MODE}\n`);
  if (MODE === '--propose') return propose();

  const plan = readPlan();
  const drops = plan.map(p => p.drop);
  const dupDrop = drops.find((d, i) => drops.indexOf(d) !== i);
  if (dupDrop) throw new Error(`#${dupDrop} is dropped twice in the plan`);
  const chained = plan.find(p => drops.includes(p.keep));
  if (chained) throw new Error(`#${chained.keep} is both kept and dropped — merge those in two passes`);
  console.log(`${plan.length} ticked merge(s)\n`);
  const archives = await archiveTables(sql);

  if (MODE === '--dry') {
    for (const p of plan) {
      const k = await getPlayer(sql, p.keep), d = await getPlayer(sql, p.drop);
      if (!k || !d) { console.log(`  ✗ #${p.keep} <- #${p.drop}: missing`); continue; }
      const r = await references(sql, p.drop, archives);
      const moves = Object.entries(r).filter(([, v]) => v).map(([a, v]) => `${a} ${v}`).join(', ') || 'nothing';
      console.log(`  #${p.keep} ${fullName(k)} <- #${p.drop} ${fullName(d)} → "${p.name || '(current reg name)'}" | moves: ${moves}`);
    }
    console.log('\ndry run — nothing written. --rehearse runs them all and rolls back.');
    return;
  }

  if (MODE === '--rehearse') {
    try {
      await sql.begin(async tx => {
        for (const p of plan) {
          const r = await mergeOne(tx, p.keep, p.drop, p.name, archives);
          console.log(`  ✓ #${p.keep} <- #${p.drop} "${r.name}" | registration: ${r.registration}${r.seasons.length ? ' | archives: ' + r.seasons.join(', ') : ''}`);
        }
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
      console.log('\nrehearsal complete — ROLLED BACK, nothing written.');
    }
    return;
  }

  let done = 0;
  for (const p of plan) {
    try {
      const r = await sql.begin(tx => mergeOne(tx, p.keep, p.drop, p.name, archives));
      done++;
      console.log(`  ✓ #${p.keep} <- #${p.drop} "${r.name}" | registration: ${r.registration}${r.seasons.length ? ' | archives: ' + r.seasons.join(', ') : ''}`);
    } catch (err) {
      console.log(`  ✗ #${p.keep} <- #${p.drop}: ${err.message} — rolled back, left as it was`);
    }
  }
  console.log(`\n${done} of ${plan.length} merged. Now recalculate Elo for each affected season.`);
}

main()
  .catch(err => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => sql.end());
