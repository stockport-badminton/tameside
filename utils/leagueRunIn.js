// The league run-in: each division's table with the places going up and down marked, and
// whether each of those places is already certain (/admin/league-run-in, superadmin only).
// Ported from Stockport (league-site 097de0a).
//
// How many go up and down is NOT fixed here: Stockport's is two, ours varies by season and
// is the site setting `promotion_places` (League.movingPlaces, default 2). The top division
// has nobody to promote, the bottom one nobody to relegate, and the top team of every
// division is marked apart as its winner. A tie on games won is not resolved; a place is
// called certain only when no other team can reach the same total.
//
// "Can reach" assumes a team wins every game it has left, 18 a fixture. It ignores that two
// teams who still meet cannot both win that match, so it can say "not yet certain" for a
// team that is in fact safe, never the other way round.

const GAMES_PER_FIXTURE = 18;
const DEFAULT_MOVING = 2;

/**
 * @param {Array<{ division: number, divisionName: string, divisionRank: number, id: number,
 *   name: string, played: number, remaining: number, gamesWon: number, gamesLost: number }>} rows
 *   one season's standings, ordered by division and then by place (League.getRunIn)
 * @param {number} [moving] how many go up from, and down to, each pair of divisions
 */
function runIn(rows, moving = DEFAULT_MOVING) {
  const divisions = new Map();
  for (const row of rows) {
    if (!divisions.has(row.division)) {
      divisions.set(row.division, { id: row.division, name: row.divisionName, rank: row.divisionRank, teams: [] });
    }
    divisions.get(row.division).teams.push({ ...row, max: row.gamesWon + GAMES_PER_FIXTURE * row.remaining });
  }
  const list = [...divisions.values()];
  const topRank = Math.min(...list.map(d => d.rank));
  const bottomRank = Math.max(...list.map(d => d.rank));

  for (const d of list) {
    const n = d.teams.length;
    d.promotes = moving > 0 && d.rank !== topRank;
    d.relegates = moving > 0 && d.rank !== bottomRank;
    d.teams.forEach((t, i) => {
      const others = d.teams.filter(o => o !== t);
      // How many others could still finish level with or above this team, and level
      // with or below it.
      const canCatch = others.filter(o => o.max >= t.gamesWon).length;
      const canFallTo = others.filter(o => o.gamesWon <= t.max).length;

      t.position = i + 1;
      t.zone = i === 0 ? 'winner'
        : i < moving && d.promotes ? 'up'
        : i >= n - moving && d.relegates && i >= moving ? 'down'
        : null;
      t.certain = {
        winner: canCatch === 0,
        up: d.promotes && canCatch < moving,
        down: d.relegates && canFallTo < moving,
      };
    });
  }
  return list;
}

module.exports = { runIn, GAMES_PER_FIXTURE, DEFAULT_MOVING };
