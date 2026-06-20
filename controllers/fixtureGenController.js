const { generateFixtureCalendar, getSeasonDates, computeStats, getLewisShieldQFWindow, getLewisEarlyWindows } = require('../utils/fixtureScheduler');
const fixtureGenModel = require('../models/fixtureGenModel');

function buildRenderContext(req, seasonCalendar, divisions, seasonDates, stats, lewisConstraints = {}, meta = {}) {
  // Flatten fixtures per division for the client-side spreadsheet builder
  function flattenDiv(divName) {
    return seasonCalendar.flatMap(dateRow =>
      (dateRow.fixtures || [])
        .filter(f => f.division === divName)
        .map(f => ({
          date:     dateRow.dbDate,
          homeTeam: f.homeTeam.name,
          awayTeam: f.awayTeam.name,
          lewisR1:  f.lewisR1 || false,
          lewisR2:  f.lewisR2 || false,
          lewisQF:  f.lewisQF || false,
        }))
    );
  }

  // Build teams-by-id map per division for the spreadsheet builder
  function teamsMap(div) {
    return div.teams.reduce((acc, t) => { acc[t.id] = t; return acc; }, {});
  }

  const divData = divisions.map(div => ({
    name: div.name,
    fixtures: JSON.stringify(flattenDiv(div.name)),
    teams:    JSON.stringify(teamsMap(div)),
  }));

  // Actual latest date in the calendar — may exceed seasonEnd if extensions were needed
  const latestCalendarDate = seasonCalendar.reduce(
    (max, row) => (row.dateObj > max ? row.dateObj : max),
    seasonDates.seasonEnd
  );

  return {
    static_path:     '/static',
    title:           'Fixture Generator',
    pageDescription: `Tameside ${seasonDates.season} fixture generator`,
    canonical:       `https://${req.get('host')}/fixture-gen`,
    fixturesOutput:  seasonCalendar,
    divData,
    stats,
    qfPermutations:  lewisConstraints.qfPermutations || [],
    teamNamesById:   divisions.reduce((map, div) => {
      (div.teams || []).forEach(t => { map[t.id] = t.name; });
      return map;
    }, {}),
    seasonDates: (() => {
      const lewisQF    = getLewisShieldQFWindow(seasonDates.seasonEnd, seasonDates.easterDate);
      const lewisEarly = getLewisEarlyWindows(seasonDates.xmasDate);
      return {
        season:       seasonDates.season,
        seasonYear:   seasonDates.seasonYear,
        start:        seasonDates.seasonStart.toISOString().split('T')[0],
        end:          seasonDates.seasonEnd.toISOString().split('T')[0],
        calendarEnd:  latestCalendarDate.toISOString().split('T')[0],
        xmas:         seasonDates.xmasDate.toISOString().split('T')[0],
        easter:       seasonDates.easterDate.toISOString().split('T')[0],
        lewisR1Start: lewisEarly.ls1Start.toISOString().split('T')[0],
        lewisR1End:   lewisEarly.ls1End.toISOString().split('T')[0],
        lewisR2Start: lewisEarly.ls2Start.toISOString().split('T')[0],
        lewisR2End:   lewisEarly.ls2End.toISOString().split('T')[0],
        lewisQFStart: lewisQF.start.toISOString().split('T')[0],
        lewisQFEnd:   lewisQF.end.toISOString().split('T')[0],
      };
    })(),
    ...meta,
  };
}

// Build a flat season calendar from draft DB rows (bypasses scheduler)
function calendarFromDraftRows(draftRows, divisions, lewisConstraints = {}) {
  const dateMap = new Map();
  for (const row of draftRows) {
    const key = row.date.toISOString().split('T')[0];
    if (!dateMap.has(key)) {
      dateMap.set(key, { dateObj: row.date, fixtures: [] });
    }
    // Reconstruct team objects from DB row + divisions lookup
    const div = divisions.find(d => d.id === row.divisionId) || { name: row.divisionName };
    const homeTeam = div.teams
      ? div.teams.find(t => t.id === row.homeTeamId) || { id: row.homeTeamId, name: row.homeTeamName, club: row.homeClubName }
      : { id: row.homeTeamId, name: row.homeTeamName, club: row.homeClubName };
    const awayTeam = div.teams
      ? div.teams.find(t => t.id === row.awayTeamId) || { id: row.awayTeamId, name: row.awayTeamName, club: row.awayClubName }
      : { id: row.awayTeamId, name: row.awayTeamName, club: row.awayClubName };

    dateMap.get(key).fixtures.push({
      homeTeam,
      awayTeam,
      division:   row.divisionName,
      divisionId: row.divisionId,
      lewisR1: false,
      lewisR2: false,
      lewisQF: false,
    });
  }

  const calendar = Array.from(dateMap.values())
    .map(({ dateObj, fixtures }) => ({
      dateObj,
      date:      [String(dateObj.getDate()).padStart(2,'0'), String(dateObj.getMonth()+1).padStart(2,'0'), dateObj.getFullYear()].join('/'),
      shortDate: `${dateObj.getDate()}/${dateObj.getMonth()+1}/${dateObj.getFullYear()}`,
      dbDate:    dateObj.toISOString().split('T')[0],
      fixtures,
    }))
    .sort((a, b) => a.dateObj - b.dateObj);

  // Re-tag lewis fixtures from constraints (needed since DB draft doesn't store the tag)
  const _r1 = lewisConstraints.r1Pairs || [];
  const _r2 = lewisConstraints.r2Pairs || [];
  const _qf = lewisConstraints.qfPairs || [];
  if (_r1.length || _r2.length || _qf.length) {
    for (const row of calendar) {
      for (const fix of row.fixtures) {
        const hid = Number(fix.homeTeam.id), aid = Number(fix.awayTeam.id);
        if      (_r1.some(c => Number(c.homeTeamId) === hid && Number(c.awayTeamId) === aid)) fix.lewisR1 = true;
        else if (_r2.some(c => Number(c.homeTeamId) === hid && Number(c.awayTeamId) === aid)) fix.lewisR2 = true;
        else if (_qf.some(c => Number(c.homeTeamId) === hid && Number(c.awayTeamId) === aid)) fix.lewisQF = true;
      }
    }
  }

  return calendar;
}

// GET /fixture-gen
// Shows draft fixtures if they exist for the season; generates + saves if not.
exports.renderFixtures = function (req, res) {
  const seasonDates = getSeasonDates();

  fixtureGenModel.getTeamsForScheduler(function (err, divisions) {
    if (err) return res.status(500).render('500-error', { static_path: '/static', title: '500', pageDescription: '500', error: err });

    fixtureGenModel.getLewisConstraints(seasonDates.season, function (err, lewisConstraints) {
      if (err) {
        console.error('Failed to load Lewis constraints (continuing without):', err);
        lewisConstraints = { r1Pairs: [], r2Pairs: [], qfPairs: [], qfPermutations: [] };
      }

      fixtureGenModel.getDraftFixtures(seasonDates.season, function (err, draftRows) {
        if (err) return res.status(500).render('500-error', { static_path: '/static', title: '500', pageDescription: '500', error: err });

        if (draftRows.length > 0) {
          // Existing draft — recompute stats from the saved calendar
          const calendar = calendarFromDraftRows(draftRows, divisions, lewisConstraints);
          const stats = computeStats(calendar);
          stats.extensions = null; // not stored — only known at generation time
          stats.unplaced   = null;
          const generatedAt = draftRows[0].generatedAt;
          return res.render('fixtures-gen', buildRenderContext(req, calendar, divisions, seasonDates, stats, lewisConstraints, {
            isDraft: true,
            generatedAt,
            flash: req.query.published ? 'Fixtures published to live schedule.' : null,
          }));
        }

        // No draft — generate fresh and save
        const { calendar, stats } = generateFixtureCalendar(
          divisions,
          seasonDates.seasonStart,
          seasonDates.seasonEnd,
          seasonDates.xmasDate,
          seasonDates.easterDate,
          seasonDates.interClubDate,
          lewisConstraints
        );

        fixtureGenModel.saveDraftFixtures(calendar, seasonDates.season, function (err) {
          if (err) console.error('Failed to save draft fixtures:', err);
          res.render('fixtures-gen', buildRenderContext(req, calendar, divisions, seasonDates, stats, lewisConstraints, {
            isDraft: false,
            generatedAt: new Date(),
            flash: null,
          }));
        });
      });
    });
  });
};

// POST /fixture-gen/regenerate
// Clears the draft for the current season and regenerates from scratch.
exports.regenerateFixtures = function (req, res) {
  const seasonDates = getSeasonDates();

  fixtureGenModel.getTeamsForScheduler(function (err, divisions) {
    if (err) return res.status(500).send('Error loading teams');

    fixtureGenModel.getLewisConstraints(seasonDates.season, function (err, lewisConstraints) {
      if (err) {
        console.error('Failed to load Lewis constraints (continuing without):', err);
        lewisConstraints = { r1Pairs: [], r2Pairs: [], qfPairs: [], qfPermutations: [] };
      }

      const { calendar } = generateFixtureCalendar(
        divisions,
        seasonDates.seasonStart,
        seasonDates.seasonEnd,
        seasonDates.xmasDate,
        seasonDates.easterDate,
        seasonDates.interClubDate,
        lewisConstraints
      );

      fixtureGenModel.saveDraftFixtures(calendar, seasonDates.season, function (err) {
        if (err) {
          console.error('Failed to save regenerated fixtures:', err);
          return res.status(500).send('Error saving fixtures');
        }
        res.redirect('/fixture-gen');
      });
    });
  });
};

// POST /fixture-gen/publish
// Copies the current draft to the live fixture table.
exports.publishFixtures = function (req, res) {
  const seasonDates = getSeasonDates();

  fixtureGenModel.publishDraftFixtures(seasonDates.season, function (err, count) {
    if (err) {
      console.error('Publish failed:', err);
      return res.status(500).send('Publish failed: ' + err.message);
    }
    console.log(`Published ${count} fixtures for season ${seasonDates.season}`);
    res.redirect('/fixture-gen?published=1');
  });
};
