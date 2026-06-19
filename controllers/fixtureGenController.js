const { generateFixtureCalendar, getSeasonDates } = require('../utils/fixtureScheduler');
const fixtureGenModel = require('../models/fixtureGenModel');

function buildRenderContext(req, seasonCalendar, divisions, seasonDates, meta = {}) {
  // Flatten fixtures per division for the client-side spreadsheet builder
  function flattenDiv(divName) {
    return seasonCalendar.flatMap(dateRow =>
      (dateRow.fixtures || [])
        .filter(f => f.division === divName)
        .map(f => ({
          date: `${dateRow.dateObj.getMonth() + 1}-${dateRow.dateObj.getDate()}-${dateRow.dateObj.getFullYear()}`,
          homeTeam: f.homeTeam.name,
          awayTeam: f.awayTeam.name,
        }))
    );
  }

  // Build teams-by-name map per division for the spreadsheet builder
  function teamsMap(div) {
    return div.teams.reduce((acc, t) => { acc[t.id] = t; return acc; }, {});
  }

  const divData = divisions.map(div => ({
    name: div.name,
    fixtures: JSON.stringify(flattenDiv(div.name)),
    teams:    JSON.stringify(teamsMap(div)),
  }));

  return {
    static_path:     '/static',
    pageTitle:       'Fixture Generator',
    pageDescription: `Tameside ${seasonDates.season} fixture generator`,
    canonical:       `https://${req.get('host')}/fixture-gen`,
    fixturesOutput:  seasonCalendar,
    divData:         divData,
    seasonDates:     {
      season:     seasonDates.season,
      seasonYear: seasonDates.seasonYear,
      start:      seasonDates.seasonStart.toISOString().split('T')[0],
      end:        seasonDates.seasonEnd.toISOString().split('T')[0],
      xmas:       seasonDates.xmasDate.toISOString().split('T')[0],
      easter:     seasonDates.easterDate.toISOString().split('T')[0],
    },
    ...meta,
  };
}

// Build a flat season calendar from draft DB rows (bypasses scheduler)
function calendarFromDraftRows(draftRows, divisions) {
  const dateMap = new Map();
  for (const row of draftRows) {
    const key = row.date.toISOString().split('T')[0];
    if (!dateMap.has(key)) {
      dateMap.set(key, { dateObj: row.date, fixtures: [] });
    }
    // Reconstruct team objects from DB row + divisions lookup
    const div = divisions.find(d => d.id === row.divisionId) || { name: row.divisionName };
    const homeTeam = div.teams
      ? div.teams.find(t => t.id === row.homeTeamId) || { id: row.homeTeamId, name: row.homeTeamName }
      : { id: row.homeTeamId, name: row.homeTeamName };
    const awayTeam = div.teams
      ? div.teams.find(t => t.id === row.awayTeamId) || { id: row.awayTeamId, name: row.awayTeamName }
      : { id: row.awayTeamId, name: row.awayTeamName };

    dateMap.get(key).fixtures.push({
      homeTeam,
      awayTeam,
      division:   row.divisionName,
      divisionId: row.divisionId,
    });
  }

  return Array.from(dateMap.values())
    .map(({ dateObj, fixtures }) => ({
      dateObj,
      date:      [String(dateObj.getDate()).padStart(2,'0'), String(dateObj.getMonth()+1).padStart(2,'0'), dateObj.getFullYear()].join('/'),
      shortDate: `${dateObj.getDate()}/${dateObj.getMonth()+1}/${dateObj.getFullYear()}`,
      dbDate:    dateObj.toISOString().split('T')[0],
      fixtures,
    }))
    .sort((a, b) => a.dateObj - b.dateObj);
}

// GET /fixture-gen
// Shows draft fixtures if they exist for the season; generates + saves if not.
exports.renderFixtures = function (req, res) {
  const seasonDates = getSeasonDates();

  fixtureGenModel.getTeamsForScheduler(function (err, divisions) {
    if (err) return res.status(500).render('500-error', { static_path: '/static', pageTitle: '500', pageDescription: '500', error: err });

    fixtureGenModel.getDraftFixtures(seasonDates.season, function (err, draftRows) {
      if (err) return res.status(500).render('500-error', { static_path: '/static', pageTitle: '500', pageDescription: '500', error: err });

      if (draftRows.length > 0) {
        // Existing draft — display without regenerating
        const calendar = calendarFromDraftRows(draftRows, divisions);
        const generatedAt = draftRows[0].generatedAt;
        return res.render('fixtures-gen', buildRenderContext(req, calendar, divisions, seasonDates, {
          isDraft: true,
          generatedAt,
          flash: req.query.published ? 'Fixtures published to live schedule.' : null,
        }));
      }

      // No draft — generate fresh and save
      const calendar = generateFixtureCalendar(
        divisions,
        seasonDates.seasonStart,
        seasonDates.seasonEnd,
        seasonDates.xmasDate,
        seasonDates.easterDate,
        seasonDates.interClubDate
      );

      fixtureGenModel.saveDraftFixtures(calendar, seasonDates.season, function (err) {
        if (err) console.error('Failed to save draft fixtures:', err);
        res.render('fixtures-gen', buildRenderContext(req, calendar, divisions, seasonDates, {
          isDraft: false,
          generatedAt: new Date(),
          flash: null,
        }));
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

    const calendar = generateFixtureCalendar(
      divisions,
      seasonDates.seasonStart,
      seasonDates.seasonEnd,
      seasonDates.xmasDate,
      seasonDates.easterDate,
      seasonDates.interClubDate
    );

    fixtureGenModel.saveDraftFixtures(calendar, seasonDates.season, function (err) {
      if (err) {
        console.error('Failed to save regenerated fixtures:', err);
        return res.status(500).send('Error saving fixtures');
      }
      res.redirect('/fixture-gen');
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
