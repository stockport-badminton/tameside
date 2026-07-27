// Filters on the stats/results pages are expressed as URL path segments rather
// than a query string, e.g.
//
//   /player-stats/Division-1/20242025/status-complete/gender-Male/club-Hyde
//   /admin/results/All/team-Hyde%20A
//
// The controllers each parse that themselves (splitting on '/' and then '-').
// Nothing used to read it back the other way, which is why views/filters.ejs
// rendered its selects at their defaults on every load: the page couldn't show
// what was filtered, and applying a second filter read those defaults back and
// silently dropped the first.
//
// This module is the reader. It parses the active filters out of req.path and
// exposes them - plus the option lists, which used to be hardcoded and had gone
// two seasons stale - to every view as res.locals.filterBar. Doing it as
// middleware means no controller has to pass any of it down.
//
// pathFor() re-emits the same grammar in the same key order the old client-side
// builder used, so the URLs produced here are the ones the controllers already
// know how to parse.

const { sql } = require('../utils/db_connect');
const seasonModel = require('../models/season');

// Segments written as `<key>-<value>`. Anything else is positional: a bare
// 8-digit season, or a division name.
const PREFIXED = ['gender', 'gameType', 'club', 'team', 'status'];

// Emission order, preserved from the original builder in views/filtersJs.ejs.
// The controllers reduce segments into an object so order doesn't actually
// matter to them, but keeping it means existing links and bookmarks stay
// byte-identical.
const ORDER = ['division', 'season', 'status', 'gender', 'gameType', 'club', 'team'];

let _divisions = [];
let _seasons = [];
let _currentSeasonLabel = '';

function seasonLabel(name) {
  return /^\d{8}$/.test(name) ? name.slice(0, 4) + '-' + name.slice(4) : name;
}

// Load the option lists once at boot, the same way season.init() does. Must run
// after season.init(), since the current season decides which season is offered
// on top of the archived ones.
exports.init = async function () {
  try {
    const rows = await sql`SELECT id, name FROM division ORDER BY rank`;
    _divisions = rows.map(function (r) {
      return { id: String(r.id), name: r.name, value: r.name.replace(/\s+/g, '-') };
    });
  } catch (err) {
    console.error('filterState.init: divisions lookup failed:', err.message);
  }

  try {
    const current = seasonModel.current();
    // Only seasons we can actually serve: the current one (which reads the live
    // tables) plus any with an archived team<season> snapshot. Offering a season
    // without either would 500 the page it links to.
    const rows = await sql`
      SELECT s.name FROM season s
      WHERE s.name = ${current}
         OR EXISTS (
              SELECT 1 FROM information_schema.tables t
              WHERE t.table_name = 'team' || s.name
            )
      ORDER BY s."startDate" DESC`;
    // The current season is the empty-value option in the select rather than an
    // entry here, so picking it produces a clean URL with no season segment. It
    // used to appear both ways, and the explicit form 500'd /pair-stats (that
    // model treats any named season as an archived snapshot).
    _currentSeasonLabel = seasonLabel(current);
    _seasons = rows
      .filter(function (r) { return r.name !== current; })
      .map(function (r) {
        return { value: r.name, label: seasonLabel(r.name) };
      });
  } catch (err) {
    console.error('filterState.init: seasons lookup failed:', err.message);
  }

  return { divisions: _divisions.length, seasons: _seasons.length };
};

// 'division-8' (id form, what the controllers convert to internally) and
// 'Division 1' (space form) both normalise to the 'Division-1' the selects use.
function normaliseDivision(seg) {
  const byId = /^division-(\d+)$/i.exec(seg);
  if (byId) {
    const match = _divisions.find(function (d) { return d.id === byId[1]; });
    if (match) return match.value;
  }
  return seg.replace(/\s+/g, '-');
}

function parsePath(pathname) {
  const parts = pathname.split('/').filter(Boolean).map(function (p) {
    try { return decodeURIComponent(p); } catch (err) { return p; }
  });

  // /admin/results/... keeps the page name in the second segment.
  const pageIdx = parts[0] === 'admin' ? 1 : 0;
  const base = '/' + parts.slice(0, pageIdx + 1).join('/');
  const active = {};

  parts.slice(pageIdx + 1).forEach(function (seg) {
    const dash = seg.indexOf('-');
    const key = dash > 0 ? seg.slice(0, dash) : '';

    if (PREFIXED.indexOf(key) !== -1) { active[key] = seg.slice(dash + 1); return; }
    if (key === 'season') { active.season = seg.slice(dash + 1); return; }
    if (/^20\d{6}$/.test(seg)) { active.season = seg; return; }
    if (/^all$/i.test(seg)) { return; }   // the "no division" marker on /results
    if (/^(premier|division[\s-]?\d+)$/i.test(seg)) {
      active.division = normaliseDivision(seg);
    }
  });

  return { base, active };
}

function chipLabel(key, value) {
  if (key === 'division') return value.replace(/-/g, ' ');
  if (key === 'season') return seasonLabel(value);
  if (key === 'gameType') return value + ' games';
  if (key === 'status') return value.charAt(0).toUpperCase() + value.slice(1);
  return value;   // gender / club / team read fine as-is
}

const CHIP_TITLES = {
  division: 'division', season: 'season', status: 'status',
  gender: 'gender', gameType: 'game type', club: 'club', team: 'team'
};

exports.middleware = function filterState(req, res, next) {
  const parsed = parsePath(req.path);
  const base = parsed.base;
  const active = parsed.active;

  // Build a path from the active filters, with `overrides` applied on top; an
  // empty-string override drops that filter.
  function pathFor(overrides) {
    const state = Object.assign({}, active, overrides || {});
    let out = base;
    ORDER.forEach(function (key) {
      const value = state[key];
      if (!value) return;
      const encoded = encodeURIComponent(value);
      out += key === 'division' || key === 'season' ? '/' + encoded : '/' + key + '-' + encoded;
    });
    // /results and /results-grid expect an explicit 'All' where a division would
    // otherwise sit. Same special case the old client-side builder had.
    if (!state.division && base.indexOf('/results') > -1) {
      out = base + '/All' + out.slice(base.length);
    }
    return out;
  }

  res.locals.filterBar = {
    base: base,
    active: active,
    divisions: _divisions,
    seasons: _seasons,
    currentSeasonLabel: _currentSeasonLabel,
    pathFor: pathFor,
    clearUrl: pathFor({
      division: '', season: '', status: '', gender: '', gameType: '', club: '', team: ''
    }),
    // One chip per applied filter, each linking to the same page without it.
    chips: ORDER.filter(function (key) { return active[key]; }).map(function (key) {
      const drop = {};
      drop[key] = '';
      return {
        key: key,
        label: chipLabel(key, active[key]),
        title: 'Remove ' + CHIP_TITLES[key] + ' filter',
        removeUrl: pathFor(drop)
      };
    })
  };

  next();
};
