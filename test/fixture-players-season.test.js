// Past-season lineups read each player's rank and team from that season (Stockport HARD-48).
//
// getMatchPlayerOrderDetails used to take rank and team from the live player table and
// INNER JOIN the team onto team<season>, so a past season was judged by where everyone
// plays now and a fixture vanished when any player's current team was not in that
// season's archive. Measured on production 2 Nov 2026: 2024/25 showed 239 of 308 lineups,
// and 239 of those had a rank or team note that was never true that season. The current
// season's output was identical before and after.
//
// There is no local database, so this pins the query's shape; the before/after comparison
// against production is recorded above.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'models', 'fixture.js'), 'utf8');
const start = src.indexOf('exports.getMatchPlayerOrderDetails');
const fn = src.slice(start, src.indexOf('ORDER BY "teamName"', start));
const SLOTS = ['Man1', 'Man2', 'Man3', 'Man4', 'Lady1', 'Lady2'];

describe('getMatchPlayerOrderDetails reads the season it is asked about', () => {
  it('chooses player<season> for a snapshot season, and live player otherwise', () => {
    assert.match(fn, /const seasonPlayers = sql\(seasonName \? 'player' \+ seasonName : 'player'\)/);
  });

  for (const side of ['home', 'away']) {
    for (const slot of SLOTS) {
      it(`${side} ${slot}: rank and team from the season archive, live only as a fallback`, () => {
        const a = `"${side}${slot}"`, sa = `"${side}${slot}Season"`;
        assert.ok(fn.includes(`LEFT JOIN \${seasonPlayers} ${sa} ON ${sa}.id = ${a}.id`), 'season join');
        assert.ok(fn.includes(`CASE WHEN ${sa}.id IS NULL THEN ${a}.rank ELSE ${sa}.rank END AS "${slot}Rank"`), 'rank');
        assert.ok(fn.includes(`CASE WHEN ${sa}.id IS NULL THEN ${a}.team ELSE ${sa}.team END AS "${slot}TeamId"`), 'team');
      });
    }
  }

  it("a player's team missing from team<season> no longer drops the fixture", () => {
    for (const slot of SLOTS) {
      assert.ok(fn.includes(`left join \${sql("team" + seasonName)}  "${slot}Team" on`), `${slot}Team is a LEFT join`);
    }
  });

  it('the views say "no team" rather than "null" for that player', () => {
    for (const view of ['fixture-players.ejs', 'recentPlayerHistory.ejs']) {
      const v = fs.readFileSync(path.join(__dirname, '..', 'views', view), 'utf8');
      assert.doesNotMatch(v, /"<br \/>" \+ row\['\w+TeamName'\]/, view);
    }
  });
});
