const { sql } = require('../utils/db_connect');

// Single source of truth for "which season is current". Historically each model
// inlined its own `new Date().getMonth()` math to build the season string, which
// drifted out of sync (some files rolled over on 1 July, players.js on 1 Aug).
// This resolves the season whose startDate has most recently passed, straight
// from the season table, and caches it for the process lifetime (Cloud Run
// refreshes on each instance restart). Call init() once at boot.

// Fallback derivation, used only until init() runs or if the DB lookup fails.
// Matches the majority convention (rolls over ~1 July). offset 0 = current,
// 1 = previous.
function dateBasedSeason(offset) {
  const year = new Date().getFullYear();
  const startYear = (new Date().getMonth() < 6 ? year - 1 : year) - offset;
  return `${startYear}${startYear + 1}`;
}

let _current = null;
let _previous = null;

exports.init = async function () {
  try {
    const rows = await sql`
      SELECT name FROM season
      WHERE "startDate" <= now()
      ORDER BY "startDate" DESC
      LIMIT 2`;
    if (rows && rows.length) {
      _current = rows[0].name;
      _previous = rows[1] ? rows[1].name : dateBasedSeason(1);
    }
  } catch (err) {
    console.error('season.init failed; using date-based fallback:', err.message);
  }
  return { current: exports.current(), previous: exports.previous() };
};

exports.current = function () { return _current || dateBasedSeason(0); };
exports.previous = function () { return _previous || dateBasedSeason(1); };

// Seasons that have an archived data snapshot (a team<season> table), newest
// first — used to build the History nav / archive. Seasons in the season table
// without a snapshot (e.g. older seasons, or the current season which uses the
// live `team` table) are excluded, since /tables and /results would 500 on a
// missing team<season> table.
exports.getAll = async function () {
  const rows = await sql`
    SELECT s.name, s."startDate", s."endDate",
      EXISTS (
        SELECT 1 FROM information_schema.tables t
        WHERE t.table_name = 'lewis' || s.name
      ) AS "hasLewis"
    FROM season s
    WHERE EXISTS (
      SELECT 1 FROM information_schema.tables t
      WHERE t.table_name = 'team' || s.name
    )
    ORDER BY s."startDate" DESC`;
  return rows;
};
