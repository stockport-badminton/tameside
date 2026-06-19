/**
 * Tameside fixture scheduler.
 *
 * Takes a divisions array (from the DB) and season date constants,
 * returns a sorted calendar of placed fixtures.
 *
 * Each team object must have: { id, name, homeNight, club, teamindex, divisionId }
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function getDaysBetween(a, b) {
  return Math.abs((b - a) / 86400000);
}

function formatDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatShortDate(d) {
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function formatOtherDate(d) {
  return `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;
}

function formatDateDDMMYYYY(d) {
  return [
    String(d.getDate()).padStart(2, '0'),
    String(d.getMonth() + 1).padStart(2, '0'),
    d.getFullYear()
  ].join('/');
}

function isWeekend(d) {
  return d.getDay() === 0 || d.getDay() === 6;
}

// Generate all valid fixture dates for the season (no weekends, within bounds)
function generateValidDates(seasonStart, seasonEnd) {
  const dates = [];
  const cur = new Date(seasonStart);
  while (cur <= seasonEnd) {
    if (!isWeekend(cur)) dates.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function getBreakFlags(d, xmasDate, easterDate) {
  // Xmas: the Sunday before Xmas Day through 14 days
  const xmasStart = new Date(xmasDate);
  xmasStart.setDate(xmasDate.getDate() - xmasDate.getDay());
  const xmasEnd = new Date(xmasStart);
  xmasEnd.setDate(xmasStart.getDate() + 14);

  // Easter: -4 to +2 days around Easter Sunday
  const easterStart = new Date(easterDate);
  easterStart.setDate(easterDate.getDate() - 4);
  const easterEnd = new Date(easterDate);
  easterEnd.setDate(easterDate.getDate() + 2);

  return {
    xmas: d >= xmasStart && d <= xmasEnd,
    easter: d > easterStart && d < easterEnd,
  };
}

function isBlockedDate(d, xmasDate, easterDate) {
  const flags = getBreakFlags(d, xmasDate, easterDate);
  return flags.xmas || flags.easter;
}

function canPlaceFixture(fixture, date, calendar, teamLastPlayed, clubLastPlayed, pass, clubConsecutiveNights, seasonExtensions) {
  const key = formatDateKey(date);
  const existing = calendar.get(key) || [];

  // No team plays twice on the same night
  const teamConflict = existing.some(f =>
    f.homeTeam.name === fixture.homeTeam.name ||
    f.awayTeam.name === fixture.homeTeam.name ||
    f.homeTeam.name === fixture.awayTeam.name ||
    f.awayTeam.name === fixture.awayTeam.name
  );
  if (teamConflict) return false;

  // Two teams from same club on same night — only allowed if they're index 1 + 3
  const sameClubConflict = existing.some(f => {
    const clubs = new Set([f.homeTeam.club, f.awayTeam.club]);
    const newClubs = [fixture.homeTeam.club, fixture.awayTeam.club];
    return newClubs.some(c => clubs.has(c)) && !(
      (f.homeTeam.teamindex === 1 && fixture.homeTeam.teamindex === 3) ||
      (f.homeTeam.teamindex === 3 && fixture.homeTeam.teamindex === 1) ||
      (f.awayTeam.teamindex === 1 && fixture.awayTeam.teamindex === 3) ||
      (f.awayTeam.teamindex === 3 && fixture.awayTeam.teamindex === 1)
    );
  });
  if (sameClubConflict) return false;

  // Per-team consecutive nights (waived after 3 season extensions)
  if (seasonExtensions < 3) {
    const teamPlaysOn = (checkDate) => {
      const checkFixtures = calendar.get(formatDateKey(checkDate)) || [];
      return checkFixtures.some(f =>
        f.homeTeam.name === fixture.homeTeam.name ||
        f.awayTeam.name === fixture.homeTeam.name ||
        f.homeTeam.name === fixture.awayTeam.name ||
        f.awayTeam.name === fixture.awayTeam.name
      );
    };
    if (teamPlaysOn(addDays(date, -1)) || teamPlaysOn(addDays(date, 1))) return false;
  }

  // Club-level consecutive nights (waived after 5 season extensions)
  if (seasonExtensions < 5) {
    const clubPlaysOn = (checkDate) => {
      const checkFixtures = calendar.get(formatDateKey(checkDate)) || [];
      return checkFixtures.some(f =>
        f.homeTeam.club === fixture.homeTeam.club ||
        f.awayTeam.club === fixture.homeTeam.club ||
        f.homeTeam.club === fixture.awayTeam.club ||
        f.awayTeam.club === fixture.awayTeam.club
      );
    };
    if (clubPlaysOn(addDays(date, -1)) || clubPlaysOn(addDays(date, 1))) return false;
  }

  // Minimum gap between a team's games (relaxes 1 day every 5 passes)
  const minDays = Math.max(1, 7 - Math.floor(pass / 5));
  const homeLast = teamLastPlayed.get(fixture.homeTeam.name);
  const awayLast = teamLastPlayed.get(fixture.awayTeam.name);
  if (homeLast && getDaysBetween(homeLast, date) < minDays) return false;
  if (awayLast && getDaysBetween(awayLast, date) < minDays) return false;

  // Home night preference (hard block on early passes, softens later)
  if (pass < 10) {
    if (DAY_NAMES[date.getDay()] !== fixture.homeTeam.homeNight) return false;
  }

  return true;
}

function calculateDateScore(fixture, date, calendar, teamLastPlayed, clubLastPlayed, allFixtures, totalFixtures, clubConsecutiveNights, pass) {
  let score = 0;

  // Fewer fixtures on this date = higher score
  const existing = calendar.get(formatDateKey(date)) || [];
  score += Math.max(0, 3 - existing.length);

  // Anti-cramming: penalise being ahead of schedule before xmas
  const placed = allFixtures.filter(f => f.placed).length;
  const expectedByNow = totalFixtures / 2;
  if (date < new Date(date.getFullYear(), 11, 1) && placed > expectedByNow * 1.2) {
    score -= 2;
  }

  // Bell-curve gap scoring peaking at 14 days — avoids empty early weeks
  const idealGap = 14;
  const homeLast = teamLastPlayed.get(fixture.homeTeam.name);
  const awayLast = teamLastPlayed.get(fixture.awayTeam.name);
  if (homeLast) {
    score += Math.max(0, 5 - Math.abs(getDaysBetween(homeLast, date) - idealGap) / 7);
  } else {
    score += 3;
  }
  if (awayLast) {
    score += Math.max(0, 5 - Math.abs(getDaysBetween(awayLast, date) - idealGap) / 7);
  } else {
    score += 3;
  }

  // Club spacing preference
  const homeClubLast = clubLastPlayed.get(fixture.homeTeam.club);
  const awayClubLast = clubLastPlayed.get(fixture.awayTeam.club);
  if (homeClubLast) score += Math.min(getDaysBetween(homeClubLast, date) / 7, 2);
  if (awayClubLast) score += Math.min(getDaysBetween(awayClubLast, date) / 7, 2);

  // Consecutive nights fairness penalty (after pass 10)
  if (pass > 10) {
    const before = calendar.get(formatDateKey(addDays(date, -1))) || [];
    const after = calendar.get(formatDateKey(addDays(date, 1))) || [];
    const homeClub = fixture.homeTeam.club;
    const awayClub = fixture.awayTeam.club;
    if ([...before, ...after].some(f => f.homeTeam.club === homeClub || f.awayTeam.club === homeClub)) score -= 1;
    if ([...before, ...after].some(f => f.homeTeam.club === awayClub || f.awayTeam.club === awayClub)) score -= 1;
  }

  return score;
}

function generateFixtureCalendar(divisions, seasonStart, seasonEnd, xmasDate, easterDate, interClubDate) {
  const allFixtures = [];

  // Build all home/away pairs within each division
  for (const div of divisions) {
    const teams = div.teams;
    for (let i = 0; i < teams.length; i++) {
      for (let j = 0; j < teams.length; j++) {
        if (i === j) continue;
        const isSameClub = teams[i].club === teams[j].club;
        allFixtures.push({
          homeTeam: teams[i],
          awayTeam: teams[j],
          division: div.name,
          divisionId: div.id,
          isSameClub,
          placed: false,
          placedDate: null,
        });
      }
    }
  }

  // Shuffle to avoid systematic bias
  for (let i = allFixtures.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allFixtures[i], allFixtures[j]] = [allFixtures[j], allFixtures[i]];
  }

  let validDates = generateValidDates(seasonStart, seasonEnd)
    .filter(d => !isBlockedDate(d, xmasDate, easterDate));

  const calendar = new Map();
  const teamLastPlayed = new Map();
  const clubLastPlayed = new Map();
  const clubConsecutiveNights = new Map();

  let currentEnd = new Date(seasonEnd);
  let seasonExtensions = 0;
  const MAX_EXTENSIONS = 10;
  const MAX_PASSES = 50;

  let pass = 0;
  let prevPlaced = -1;

  while (pass < MAX_PASSES) {
    let placedThisPass = 0;

    for (const fixture of allFixtures) {
      if (fixture.placed) continue;

      // Same-club fixtures must be scheduled before interClubDate
      const effectiveEnd = fixture.isSameClub
        ? (interClubDate < currentEnd ? interClubDate : currentEnd)
        : currentEnd;

      const candidates = validDates.filter(d => d >= seasonStart && d <= effectiveEnd);

      const scored = candidates
        .filter(d => canPlaceFixture(fixture, d, calendar, teamLastPlayed, clubLastPlayed, pass, clubConsecutiveNights, seasonExtensions))
        .map(d => ({
          date: d,
          score: calculateDateScore(fixture, d, calendar, teamLastPlayed, clubLastPlayed, allFixtures, allFixtures.length, clubConsecutiveNights, pass)
        }))
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) continue;

      const chosen = scored[0].date;
      const key = formatDateKey(chosen);
      if (!calendar.has(key)) calendar.set(key, []);
      calendar.get(key).push(fixture);
      fixture.placed = true;
      fixture.placedDate = chosen;
      teamLastPlayed.set(fixture.homeTeam.name, chosen);
      teamLastPlayed.set(fixture.awayTeam.name, chosen);
      clubLastPlayed.set(fixture.homeTeam.club, chosen);
      clubLastPlayed.set(fixture.awayTeam.club, chosen);
      placedThisPass++;
    }

    const remaining = allFixtures.filter(f => !f.placed).length;
    if (remaining === 0) break;

    if (placedThisPass === 0 && pass > 20 && seasonExtensions < MAX_EXTENSIONS) {
      seasonExtensions++;
      currentEnd = addDays(currentEnd, 7);
      const newDates = generateValidDates(addDays(currentEnd, -7), currentEnd)
        .filter(d => !isBlockedDate(d, xmasDate, easterDate));
      validDates = [...validDates, ...newDates];
      console.log(`🔄 Extended season by ${seasonExtensions} week(s) — ${remaining} fixtures unplaced`);
    }

    pass++;
  }

  const unplaced = allFixtures.filter(f => !f.placed);
  if (unplaced.length > 0) {
    console.warn(`⚠️  ${unplaced.length} fixtures could not be placed after ${pass} passes`);
  }

  // Build output calendar
  const dateMap = new Map();
  for (const fixture of allFixtures) {
    if (!fixture.placed) continue;
    const key = formatDateKey(fixture.placedDate);
    if (!dateMap.has(key)) dateMap.set(key, { dateObj: fixture.placedDate, fixtures: [] });
    dateMap.get(key).fixtures.push(fixture);
  }

  const seasonCalendar = Array.from(dateMap.values()).map(({ dateObj, fixtures }) => {
    const flags = getBreakFlags(dateObj, xmasDate, easterDate);
    return {
      dateObj,
      date: formatDateDDMMYYYY(dateObj),
      shortDate: formatShortDate(dateObj),
      dbDate: formatDateKey(dateObj),
      ...flags,
      fixtures: fixtures.map(fix => ({
        homeTeam: fix.homeTeam,
        awayTeam: fix.awayTeam,
        division: fix.division,
        divisionId: fix.divisionId,
      })),
    };
  });

  seasonCalendar.sort((a, b) => new Date(a.dateObj) - new Date(b.dateObj));
  return seasonCalendar;
}

// Butcher's algorithm for Easter Sunday
function getEasterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

// Calculate season constants from the current date
function getSeasonDates() {
  const now = new Date();
  // June or later → upcoming season (this Sept → next May)
  // Before June → current season (last Sept → this May)
  const seasonYear = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    seasonYear,
    season: `${seasonYear}${seasonYear + 1}`,
    seasonStart: new Date(seasonYear, 8, 1),         // 1 Sept
    seasonEnd: new Date(seasonYear + 1, 4, 1),        // 1 May
    xmasDate: new Date(seasonYear, 11, 25),            // 25 Dec
    easterDate: getEasterDate(seasonYear + 1),         // Easter of end year
    interClubDate: new Date(seasonYear, 10, 30),       // 30 Nov — same-club deadline
  };
}

module.exports = { generateFixtureCalendar, getSeasonDates, getEasterDate };
