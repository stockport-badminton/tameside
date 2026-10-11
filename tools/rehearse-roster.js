#!/usr/bin/env node
// Runs every roster write against PRODUCTION inside one transaction, checks the ranks after
// each step, and ROLLS BACK. Nothing is ever committed: the transaction always ends by
// throwing. There is no local database to test models/roster.js against, so this is how
// its SQL is exercised (same approach as tools/rotate-db-encode.js --rehearse).
//
//   node tools/rehearse-roster.js [teamId]      # default: the first team with 2+ nominated
//                                               #          and 1+ reserve men
//
// Prints each step and the resulting (team, gender) ranks, and exits non-zero if any list
// is left non-contiguous (nominated must be 1..n, reserves 99..99+m-1).

require('dotenv').config();
const { sql } = require('../utils/db_connect');
const Roster = require('../models/roster');
const { isReserve, RESERVE_BASE } = require('../utils/rosterRank');

const ROLLBACK = new Error('rehearsal: rolling back');
const problems = [];

async function list(tx, teamId, gender) {
  return tx`SELECT id::int AS id, rank, first_name || ' ' || family_name AS name FROM player
            WHERE team = ${teamId} AND gender = ${gender} AND id <> 0 ORDER BY rank NULLS LAST, id`;
}

function check(label, rows, { informational = false } = {}) {
  const nom = rows.filter((r) => !isReserve(r.rank)).map((r) => (r.rank === null ? null : Number(r.rank)));
  const res = rows.filter((r) => isReserve(r.rank)).map((r) => Number(r.rank));
  const okNom = nom.every((r, i) => r === i + 1);
  const okRes = res.every((r, i) => r === RESERVE_BASE + i);
  console.log(`  ${label}: nominated [${nom.join(',')}] reserves [${res.join(',')}]${okNom && okRes ? '' : '   <-- NOT CONTIGUOUS'}`);
  if ((!okNom || !okRes) && !informational) problems.push(label);
}

(async () => {
  const W = Roster._writesIn;
  try {
    await sql.begin(async (tx) => {
      let teamId = Number(process.argv[2]);
      if (!teamId) {
        const [t] = await tx`
          SELECT team::int AS id FROM player WHERE gender = 'Male' AND id <> 0 AND team <> ${Roster.NO_TEAM_ID}
          GROUP BY team HAVING count(*) FILTER (WHERE rank < 99) >= 2 AND count(*) FILTER (WHERE rank >= 99) >= 1
          ORDER BY team LIMIT 1`;
        teamId = t.id;
      }
      const team = await Roster.getTeamOwner(teamId, tx);
      const [other] = await tx`SELECT id::int AS id FROM team WHERE club = ${team.clubId} AND id <> ${teamId}
                               AND id <> ${Roster.NO_TEAM_ID} ORDER BY rank NULLS LAST LIMIT 1`;
      console.log(`Rehearsing on ${team.name} (#${teamId}) at ${team.clubName}; second team #${other && other.id}`);

      const before = await list(tx, teamId, 'Male');
      // Legacy rows hold every reserve at exactly 99, so "before" is usually not contiguous.
      check('before (informational)', before, { informational: true });
      const nom = before.filter((r) => !isReserve(r.rank)).map((r) => r.id);
      const res = before.filter((r) => isReserve(r.rank)).map((r) => r.id);

      console.log('1. saveTeamOrder: swap the top two, promote the first reserve to the bottom of nominated');
      const wantNom = [nom[1], nom[0], ...nom.slice(2), res[0]];
      const updated = await W.saveTeamOrderIn(tx, teamId, [
        { gender: 'Male', section: 'nominated', playerIds: wantNom },
        { gender: 'Male', section: 'reserve', playerIds: res.slice(1) },
      ]);
      console.log(`  updated ${updated.length} rows`);
      const after1 = await list(tx, teamId, 'Male');
      check('after save', after1);
      const gotNom = after1.filter((r) => !isReserve(r.rank)).map((r) => r.id);
      if (JSON.stringify(gotNom) !== JSON.stringify(wantNom)) problems.push('save order: ' + JSON.stringify(gotNom));
      if (!gotNom.includes(res[0])) problems.push('promoted reserve did not stick (the Stockport 06824a0 bug)');

      console.log('2. saveTeamOrder again with the same payload writes nothing');
      const again = await W.saveTeamOrderIn(tx, teamId, [
        { gender: 'Male', section: 'nominated', playerIds: wantNom },
        { gender: 'Male', section: 'reserve', playerIds: res.slice(1) },
      ]);
      if (again.length) problems.push(`idempotent save wrote ${again.length} rows`);

      if (other) {
        console.log(`3. movePlayer: the new no. 1 to team #${other.id} as a reserve`);
        const moved = await W.movePlayerIn(tx, wantNom[0], other.id, 'reserve');
        console.log('  ', JSON.stringify(moved));
        check('source after move', await list(tx, teamId, 'Male'));
        check('destination after move', await list(tx, other.id, 'Male'));
      }

      console.log('4. releasePlayer: the current no. 1');
      const cur = (await list(tx, teamId, 'Male')).filter((r) => !isReserve(r.rank));
      const released = await W.releasePlayerIn(tx, cur[0].id);
      console.log('  ', JSON.stringify(released));
      check('after release', await list(tx, teamId, 'Male'));
      const [parked] = await tx`SELECT club::int, team::int, rank FROM player WHERE id = ${cur[0].id}`;
      if (parked.club !== Roster.NO_CLUB_ID || parked.team !== Roster.NO_TEAM_ID) problems.push('release did not park');

      console.log('5. createPlayer: a new reserve, then a new nominated');
      const c1 = await W.createPlayerIn(tx, { firstName: 'Rehearsal', familyName: 'Reserve', gender: 'Male', teamId, section: 'reserve' });
      const c2 = await W.createPlayerIn(tx, { firstName: 'Rehearsal', familyName: 'Nominated', gender: 'Male', teamId, section: 'nominated' });
      console.log('  ', JSON.stringify(c1), JSON.stringify(c2));
      check('after create', await list(tx, teamId, 'Male'));

      console.log('6. candidates search reads');
      const cand = await Roster.splitCandidates(await tx`SELECT player.id::int AS "playerId",
        TRIM(first_name || ' ' || family_name) AS name, gender, club.name AS "clubName", player.club::int AS "clubId"
        FROM player LEFT JOIN club ON club.id = player.club WHERE player.id <> 0`, 'Rehearsal Reserve', team.clubName);
      console.log(`   ownClub ${cand.ownClub.length}, unattached ${cand.unattached.length}, otherClubs ${cand.otherClubs.length}`);

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) { console.error('FAILED:', e); process.exitCode = 1; }
  }
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM player WHERE first_name = 'Rehearsal'`;
  console.log(n === 0 ? 'Rolled back: nothing was written.' : `!! ${n} rehearsal rows found — the rollback did not happen`);
  if (n !== 0) process.exitCode = 1;
  if (problems.length) { console.log('PROBLEMS:\n - ' + problems.join('\n - ')); process.exitCode = 1; }
  else if (!process.exitCode) console.log('All steps left every list contiguous.');
  await sql.end();
})();
