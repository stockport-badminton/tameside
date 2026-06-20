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

// Generate all valid fixture dates for the season (no Saturdays; Sundays allowed for Sunday home teams)
function generateValidDates(seasonStart, seasonEnd) {
  const dates = [];
  const cur = new Date(seasonStart);
  while (cur <= seasonEnd) {
    if (cur.getDay() !== 6) dates.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// The Lewis Shield quarter-final window — two weeks just after Easter (or before, if season ends close)
function getLewisShieldQFWindow(seasonEnd, easterDate) {
  const ee = new Date(easterDate);
  ee.setDate(easterDate.getDate() + 7);
  const es = new Date(easterDate);
  es.setDate(easterDate.getDate() - 7);
  const start = ((seasonEnd - ee) / 86400000 < 14)
    ? new Date(+es - 14 * 86400000)
    : new Date(ee);
  const end = new Date(start);
  end.setDate(start.getDate() + 14);
  return { start, end };
}

// Lewis early windows: LS1 (R1 prelims) right after Xmas break; LS2 (R2 bracket) three weeks later.
// Mirrors the original view logic that was in fixtures-gen.ejs.
function getLewisEarlyWindows(xmasDate) {
  const xmasStart = new Date(xmasDate);
  xmasStart.setDate(xmasDate.getDate() - xmasDate.getDay()); // Sunday before Xmas
  const xmasEnd = new Date(xmasStart);
  xmasEnd.setDate(xmasStart.getDate() + 14); // 2-week Xmas break

  const ls1Start = new Date(xmasEnd);
  const ls1End = new Date(ls1Start);
  ls1End.setDate(ls1Start.getDate() + 21); // LS1 = 3 weeks (R1 prelims)

  const ls2Start = new Date(ls1End);
  ls2Start.setDate(ls1End.getDate() + 21); // LS2 starts 3 weeks after LS1 ends
  const ls2End = new Date(ls2Start);
  ls2End.setDate(ls2Start.getDate() + 14); // LS2 = 2 weeks (R2 Round 1 bracket)

  return { ls1Start, ls1End, ls2Start, ls2End };
}

// lewisWindows = { r1Start, r1End, r2Start, r2End, qfStart, qfEnd }
function getBreakFlags(d, xmasDate, easterDate, lewisWindows = {}) {
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
    xmas:    d >= xmasStart && d <= xmasEnd,
    easter:  d > easterStart && d < easterEnd,
    lewisR1: lewisWindows.r1Start ? (d >= lewisWindows.r1Start && d <= lewisWindows.r1End) : false,
    lewisR2: lewisWindows.r2Start ? (d >= lewisWindows.r2Start && d <= lewisWindows.r2End) : false,
    lewisQF: lewisWindows.qfStart ? (d >= lewisWindows.qfStart && d <= lewisWindows.qfEnd) : false,
  };
}

function isBlockedDate(d, xmasDate, easterDate, lewisWindows = {}) {
  const flags = getBreakFlags(d, xmasDate, easterDate, lewisWindows);
  return flags.xmas || flags.easter || flags.lewisR1 || flags.lewisR2 || flags.lewisQF;
}

function canPlaceFixture(fixture, date, calendar, teamAllDates, clubLastPlayed, pass, clubConsecutiveNights, seasonExtensions) {
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

  // Two home teams from the same club on the same night → always a venue conflict
  if (existing.some(f => f.homeTeam.club === fixture.homeTeam.club)) return false;

  // Any other same-club involvement on the same night — only allowed if the home teams
  // are index 1 + 3 (club with 3 teams, one home + one away at a different venue)
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

  // Minimum gap between a team's games, checked against ALL previously placed dates.
  // Using only "last placed" was wrong: out-of-order placement let close gaps slip through.
  const minDays = Math.max(5, 7 - Math.floor(pass / 10));
  const homeDates = teamAllDates.get(fixture.homeTeam.name) || [];
  const awayDates = teamAllDates.get(fixture.awayTeam.name) || [];
  if (homeDates.some(d => getDaysBetween(d, date) < minDays)) return false;
  if (awayDates.some(d => getDaysBetween(d, date) < minDays)) return false;

  // Hard block: fixture must always be played on the home team's designated night
  if (DAY_NAMES[date.getDay()] !== fixture.homeTeam.homeNight) return false;

  return true;
}

function calculateDateScore(fixture, date, calendar, teamAllDates, clubLastPlayed, allFixtures, totalFixtures, clubConsecutiveNights, pass) {
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

  // Gap scoring: use nearest placed date for each team (min gap in either direction).
  // Peaks at idealGap; asymmetric — below ideal penalised harder.
  const idealGap = 14;
  const homeDates = teamAllDates.get(fixture.homeTeam.name) || [];
  const awayDates = teamAllDates.get(fixture.awayTeam.name) || [];
  if (homeDates.length > 0) {
    const gap = Math.min(...homeDates.map(d => getDaysBetween(d, date)));
    const diff = Math.abs(gap - idealGap);
    score += Math.max(0, 5 - diff / (gap < idealGap ? 3 : 14));
  } else {
    score += 3;
  }
  if (awayDates.length > 0) {
    const gap = Math.min(...awayDates.map(d => getDaysBetween(d, date)));
    const diff = Math.abs(gap - idealGap);
    score += Math.max(0, 5 - diff / (gap < idealGap ? 3 : 14));
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

function generateFixtureCalendar(divisions, seasonStart, seasonEnd, xmasDate, easterDate, interClubDate, lewisConstraints = { r1Pairs: [], r2Pairs: [], qfPairs: [] }) {
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

  // Tag R1 (prelim), R2 (bracket round 1), and QF fixtures into their respective lewis windows
  const _r1Pairs  = lewisConstraints.r1Pairs  || [];
  const _r2Pairs  = lewisConstraints.r2Pairs  || [];
  const _qfPairs  = lewisConstraints.qfPairs  || [];

  if (_r1Pairs.length > 0 || _r2Pairs.length > 0 || _qfPairs.length > 0) {
    const tagged = { r1: 0, r2: 0, qf: 0 };
    for (const fixture of allFixtures) {
      // Use Number() coercion to guard against postgres integer vs JS type mismatches
      const hid = Number(fixture.homeTeam.id), aid = Number(fixture.awayTeam.id);
      if (_r1Pairs.some(c => Number(c.homeTeamId) === hid && Number(c.awayTeamId) === aid)) {
        fixture.lewisR1 = true; tagged.r1++;
      } else if (_r2Pairs.some(c => Number(c.homeTeamId) === hid && Number(c.awayTeamId) === aid)) {
        fixture.lewisR2 = true; tagged.r2++;
      } else if (_qfPairs.some(c => Number(c.homeTeamId) === hid && Number(c.awayTeamId) === aid)) {
        fixture.lewisQF = true; tagged.qf++;
      }
    }
    console.log(`[scheduler] tagged: R1=${tagged.r1} (from ${_r1Pairs.length} pairs), R2=${tagged.r2} (from ${_r2Pairs.length} pairs), QF=${tagged.qf} (from ${_qfPairs.length} pairs)`);
    for (const [label, pairs] of [['R1', _r1Pairs], ['R2', _r2Pairs], ['QF', _qfPairs]]) {
      const unmatched = pairs.filter(c => !allFixtures.some(f => Number(f.homeTeam.id) === Number(c.homeTeamId) && Number(f.awayTeam.id) === Number(c.awayTeamId)));
      if (unmatched.length > 0) console.warn(`[scheduler] unmatched ${label} pairs:`, JSON.stringify(unmatched));
    }
  }

  const lewisQF    = getLewisShieldQFWindow(seasonEnd, easterDate);
  const lewisEarly = getLewisEarlyWindows(xmasDate);
  const lewisWindows = {
    r1Start: lewisEarly.ls1Start, r1End: lewisEarly.ls1End,
    r2Start: lewisEarly.ls2Start, r2End: lewisEarly.ls2End,
    qfStart: lewisQF.start,       qfEnd: lewisQF.end,
  };

  // Sort fixtures: most-constrained home teams first to avoid deadlocks.
  // Constraint level = available home nights / number of same-club teams sharing that night.
  // Shuffle first so ties get variety across runs, then stable-sort by constraint.
  for (let i = allFixtures.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allFixtures[i], allFixtures[j]] = [allFixtures[j], allFixtures[i]];
  }
  const homeNightSlots = new Map();  // homeNight → available non-blocked dates in season
  for (const dayName of DAY_NAMES) {
    const dayIndex = DAY_NAMES.indexOf(dayName);
    let count = 0;
    const cur = new Date(seasonStart);
    while (cur <= seasonEnd) {
      if (cur.getDay() === dayIndex && !isBlockedDate(cur, xmasDate, easterDate, lewisWindows)) count++;
      cur.setDate(cur.getDate() + 1);
    }
    homeNightSlots.set(dayName, count);
  }
  const clubNightTeamCount = new Map();  // "club|night" → number of teams
  for (const div of divisions) {
    for (const team of div.teams) {
      const key = `${team.club}|${team.homeNight}`;
      clubNightTeamCount.set(key, (clubNightTeamCount.get(key) || 0) + 1);
    }
  }
  const effectiveSlots = (fixture) => {
    const slots = homeNightSlots.get(fixture.homeTeam.homeNight) || 30;
    const rivals = clubNightTeamCount.get(`${fixture.homeTeam.club}|${fixture.homeTeam.homeNight}`) || 1;
    return slots / rivals;
  };
  // Lewis fixtures first (handled by dedicated passes), then regular by constraint level
  allFixtures.sort((a, b) => {
    const aLewis = (a.lewisR1 || a.lewisR2 || a.lewisQF) ? 0 : 1;
    const bLewis = (b.lewisR1 || b.lewisR2 || b.lewisQF) ? 0 : 1;
    if (aLewis !== bLewis) return aLewis - bLewis;
    return effectiveSlots(a) - effectiveSlots(b);
  });
  console.log(`[scheduler] lewis windows: R1=${lewisWindows.r1Start.toISOString().split('T')[0]}→${lewisWindows.r1End.toISOString().split('T')[0]}, R2=${lewisWindows.r2Start.toISOString().split('T')[0]}→${lewisWindows.r2End.toISOString().split('T')[0]}, QF=${lewisWindows.qfStart.toISOString().split('T')[0]}→${lewisWindows.qfEnd.toISOString().split('T')[0]}`);

  // Regular fixture pool: only block Xmas and Easter. Lewis windows are NOT excluded here
  // because Phase 1 places all Lewis fixtures first — Phase 2 (regular) can use leftover
  // Lewis-window dates for non-involved teams; constraints (team conflict, consecutive nights)
  // will naturally prevent regular fixtures clashing with already-placed Lewis matches.
  let validDates = generateValidDates(seasonStart, seasonEnd)
    .filter(d => {
      const flags = getBreakFlags(d, xmasDate, easterDate, lewisWindows);
      return !flags.xmas && !flags.easter;
    });

  // LS1+LS2 combined into one early pool; R1 is placed first via pre-pass,
  // then R2 is constrained to dates after the latest R1 placement.
  const lewisEarlyDates = [
    ...generateValidDates(lewisEarly.ls1Start, lewisEarly.ls1End),
    ...generateValidDates(lewisEarly.ls2Start, lewisEarly.ls2End),
  ];
  const lewisQFDates = generateValidDates(lewisQF.start, lewisQF.end);

  const calendar = new Map();
  const teamAllDates = new Map();  // teamName → all placed Date objects (for gap checking)
  const clubLastPlayed = new Map();
  const clubConsecutiveNights = new Map();

  // R1 pre-pass: lock in prelim fixture dates before the main loop runs,
  // so R2 candidates are guaranteed to start after the latest R1 date.
  let prePass = 0;
  while (allFixtures.some(f => f.lewisR1 && !f.placed) && prePass < 15) {
    for (const fixture of allFixtures) {
      if (!fixture.lewisR1 || fixture.placed) continue;
      const scored = lewisEarlyDates
        .filter(d => canPlaceFixture(fixture, d, calendar, teamAllDates, clubLastPlayed, prePass, clubConsecutiveNights, 0))
        .map(d => ({ date: d, score: calculateDateScore(fixture, d, calendar, teamAllDates, clubLastPlayed, allFixtures, allFixtures.length, clubConsecutiveNights, prePass) }))
        .sort((a, b) => b.score - a.score);
      if (scored.length === 0) continue;
      const chosen = scored[0].date;
      const key = formatDateKey(chosen);
      if (!calendar.has(key)) calendar.set(key, []);
      calendar.get(key).push(fixture);
      fixture.placed = true;
      fixture.placedDate = chosen;
      if (!teamAllDates.has(fixture.homeTeam.name)) teamAllDates.set(fixture.homeTeam.name, []);
      teamAllDates.get(fixture.homeTeam.name).push(chosen);
      if (!teamAllDates.has(fixture.awayTeam.name)) teamAllDates.set(fixture.awayTeam.name, []);
      teamAllDates.get(fixture.awayTeam.name).push(chosen);
      clubLastPlayed.set(fixture.homeTeam.club, chosen);
      clubLastPlayed.set(fixture.awayTeam.club, chosen);
    }
    prePass++;

  }

  const r1Placed = allFixtures.filter(f => f.lewisR1 && f.placed);
  const latestR1Ms = r1Placed.length > 0 ? Math.max(...r1Placed.map(f => f.placedDate.getTime())) : 0;
  const lewisR2Dates = lewisEarlyDates.filter(d => d.getTime() > latestR1Ms);
  console.log(`[scheduler] R1 pre-pass: ${r1Placed.length} placed; R2 window: ${lewisR2Dates[0]?.toISOString().split('T')[0]} → ${lewisR2Dates[lewisR2Dates.length - 1]?.toISOString().split('T')[0]}`);

  const MAX_PASSES = 50;

  // ── Phase 1: Lewis R2 + QF fixtures only ────────────────────────────────
  // Regular fixtures never compete for these slots; Lewis gets first pick.
  // R1 was already placed in the pre-pass above.
  let lewisPass = 0;
  while (lewisPass < MAX_PASSES) {
    let placedThisPass = 0;

    for (const fixture of allFixtures) {
      if (fixture.placed) continue;
      if (!fixture.lewisR1 && !fixture.lewisR2 && !fixture.lewisQF) continue;

      let candidates;
      if (fixture.lewisR1) {
        candidates = lewisEarlyDates; // pre-pass already handled these; fallback only
      } else if (fixture.lewisR2) {
        candidates = lewisR2Dates;
      } else {
        // QF: must happen after ALL R2 fixtures are placed
        const r2Fixtures = allFixtures.filter(f => f.lewisR2);
        if (!r2Fixtures.every(f => f.placed)) continue;
        const latestR2Ms = Math.max(...r2Fixtures.map(f => f.placedDate.getTime()));
        const postR2Early = lewisEarlyDates.filter(d => d.getTime() > latestR2Ms);
        const postR2Valid = validDates.filter(d => d.getTime() > latestR2Ms);
        const seen = new Set();
        candidates = [...postR2Early, ...postR2Valid, ...lewisQFDates]
          .filter(d => { const k = d.getTime(); return seen.has(k) ? false : (seen.add(k), true); })
          .sort((a, b) => a - b);
      }

      const scored = candidates
        .filter(d => canPlaceFixture(fixture, d, calendar, teamAllDates, clubLastPlayed, lewisPass, clubConsecutiveNights, 0))
        .map(d => ({
          date: d,
          score: calculateDateScore(fixture, d, calendar, teamAllDates, clubLastPlayed, allFixtures, allFixtures.length, clubConsecutiveNights, lewisPass)
        }))
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) continue;

      const chosen = scored[0].date;
      const key = formatDateKey(chosen);
      if (!calendar.has(key)) calendar.set(key, []);
      calendar.get(key).push(fixture);
      fixture.placed = true;
      fixture.placedDate = chosen;
      if (!teamAllDates.has(fixture.homeTeam.name)) teamAllDates.set(fixture.homeTeam.name, []);
      teamAllDates.get(fixture.homeTeam.name).push(chosen);
      if (!teamAllDates.has(fixture.awayTeam.name)) teamAllDates.set(fixture.awayTeam.name, []);
      teamAllDates.get(fixture.awayTeam.name).push(chosen);
      clubLastPlayed.set(fixture.homeTeam.club, chosen);
      clubLastPlayed.set(fixture.awayTeam.club, chosen);
      placedThisPass++;
    }

    const lewisRemaining = allFixtures.filter(f => (f.lewisR1 || f.lewisR2 || f.lewisQF) && !f.placed).length;
    if (lewisRemaining === 0 || placedThisPass === 0) break;
    lewisPass++;
  }

  const unplacedLewisQF = allFixtures.filter(f => f.lewisQF && !f.placed);
  if (unplacedLewisQF.length > 0) {
    console.warn(`⚠️  ${unplacedLewisQF.length} Lewis QF permutations could not be placed — all slots taken by R2/regular fixtures`);
    unplacedLewisQF.forEach(f => console.warn(`   unplaced QF: ${f.homeTeam.name} v ${f.awayTeam.name}`));
  }

  // ── Phase 2: Regular fixtures only ──────────────────────────────────────
  // teamAllDates already contains all Lewis fixture dates, so gap and venue
  // constraints naturally account for the pre-scheduled Lewis slots.
  let currentEnd = new Date(seasonEnd);
  let seasonExtensions = 0;
  const MAX_EXTENSIONS = 10;
  let pass = 0;

  while (pass < MAX_PASSES) {
    let placedThisPass = 0;

    for (const fixture of allFixtures) {
      if (fixture.placed) continue;
      if (fixture.lewisR1 || fixture.lewisR2 || fixture.lewisQF) continue;

      const effectiveEnd = fixture.isSameClub
        ? (interClubDate < currentEnd ? interClubDate : currentEnd)
        : currentEnd;
      const candidates = validDates.filter(d => d >= seasonStart && d <= effectiveEnd);

      const scored = candidates
        .filter(d => canPlaceFixture(fixture, d, calendar, teamAllDates, clubLastPlayed, pass, clubConsecutiveNights, seasonExtensions))
        .map(d => ({
          date: d,
          score: calculateDateScore(fixture, d, calendar, teamAllDates, clubLastPlayed, allFixtures, allFixtures.length, clubConsecutiveNights, pass)
        }))
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) continue;

      const chosen = scored[0].date;
      const key = formatDateKey(chosen);
      if (!calendar.has(key)) calendar.set(key, []);
      calendar.get(key).push(fixture);
      fixture.placed = true;
      fixture.placedDate = chosen;
      if (!teamAllDates.has(fixture.homeTeam.name)) teamAllDates.set(fixture.homeTeam.name, []);
      teamAllDates.get(fixture.homeTeam.name).push(chosen);
      if (!teamAllDates.has(fixture.awayTeam.name)) teamAllDates.set(fixture.awayTeam.name, []);
      teamAllDates.get(fixture.awayTeam.name).push(chosen);
      clubLastPlayed.set(fixture.homeTeam.club, chosen);
      clubLastPlayed.set(fixture.awayTeam.club, chosen);
      placedThisPass++;
    }

    const regularRemaining = allFixtures.filter(f => !f.placed && !f.lewisR1 && !f.lewisR2 && !f.lewisQF).length;
    if (regularRemaining === 0) break;

    if (placedThisPass === 0 && pass > 20 && regularRemaining > 0 && seasonExtensions < MAX_EXTENSIONS) {
      seasonExtensions++;
      currentEnd = addDays(currentEnd, 7);
      const newDates = generateValidDates(addDays(currentEnd, -7), currentEnd)
        .filter(d => !isBlockedDate(d, xmasDate, easterDate, lewisWindows));
      validDates = [...validDates, ...newDates];
      console.log(`🔄 Extended season by ${seasonExtensions} week(s) — ${regularRemaining} regular fixtures unplaced`);
    }

    pass++;
  }

  const unplaced = allFixtures.filter(f => !f.placed);
  const unplacedR1 = unplaced.filter(f => f.lewisR1);
  const unplacedR2 = unplaced.filter(f => f.lewisR2);
  const unplacedQF = unplaced.filter(f => f.lewisQF);
  const unplacedRegular = unplaced.filter(f => !f.lewisR1 && !f.lewisR2 && !f.lewisQF);
  if (unplacedR1.length > 0) console.warn(`⚠️  ${unplacedR1.length} Lewis R1 fixtures could not be placed in the R1 window`);
  if (unplacedR2.length > 0) console.warn(`⚠️  ${unplacedR2.length} Lewis R2 fixtures could not be placed in the R2 window`);
  if (unplacedQF.length > 0) console.warn(`⚠️  ${unplacedQF.length} Lewis QF fixtures could not be placed in the QF window`);
  if (unplacedRegular.length > 0) console.warn(`⚠️  ${unplacedRegular.length} regular fixtures could not be placed after ${pass} passes`);

  // Build output calendar
  const dateMap = new Map();
  for (const fixture of allFixtures) {
    if (!fixture.placed) continue;
    const key = formatDateKey(fixture.placedDate);
    if (!dateMap.has(key)) dateMap.set(key, { dateObj: fixture.placedDate, fixtures: [] });
    dateMap.get(key).fixtures.push(fixture);
  }

  const seasonCalendar = Array.from(dateMap.values()).map(({ dateObj, fixtures }) => {
    const flags = getBreakFlags(dateObj, xmasDate, easterDate, lewisWindows);
    return {
      dateObj,
      date: formatDateDDMMYYYY(dateObj),
      shortDate: formatShortDate(dateObj),
      dbDate: formatDateKey(dateObj),
      ...flags,
      fixtures: fixtures.map(fix => ({
        homeTeam:  fix.homeTeam,
        awayTeam:  fix.awayTeam,
        division:  fix.division,
        divisionId: fix.divisionId,
        lewisR1:   fix.lewisR1 || false,
        lewisR2:   fix.lewisR2 || false,
        lewisQF:   fix.lewisQF || false,
      })),
    };
  });

  seasonCalendar.sort((a, b) => new Date(a.dateObj) - new Date(b.dateObj));

  const stats = computeStats(seasonCalendar);
  stats.extensions = seasonExtensions;
  stats.unplaced   = unplaced.length;
  return { calendar: seasonCalendar, stats };
}

// Derive schedule quality stats from any completed calendar array
function computeStats(seasonCalendar) {
  const totalFixtures = seasonCalendar.reduce((sum, row) => sum + (row.fixtures || []).length, 0);
  const datesUsed = seasonCalendar.length;

  // Build dbDate → Set<clubName>
  const dateClubs = new Map();
  for (const row of seasonCalendar) {
    const clubs = new Set();
    for (const f of row.fixtures || []) {
      if (f.homeTeam && f.homeTeam.club) clubs.add(f.homeTeam.club);
      if (f.awayTeam && f.awayTeam.club) clubs.add(f.awayTeam.club);
    }
    dateClubs.set(row.dbDate, clubs);
  }

  // Count consecutive nights per club
  const consecutiveCount = new Map();
  for (const [dateStr, clubs] of dateClubs) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d));
    prev.setUTCDate(prev.getUTCDate() - 1);
    const prevKey = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
    const prevClubs = dateClubs.get(prevKey);
    if (!prevClubs) continue;
    for (const club of clubs) {
      if (prevClubs.has(club)) {
        consecutiveCount.set(club, (consecutiveCount.get(club) || 0) + 1);
      }
    }
  }

  const consecutiveNights = Array.from(consecutiveCount.entries())
    .map(([club, count]) => ({ club, count }))
    .sort((a, b) => b.count - a.count);

  return { totalFixtures, datesUsed, consecutiveNights };
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

module.exports = { generateFixtureCalendar, getSeasonDates, getEasterDate, computeStats, getLewisShieldQFWindow, getLewisEarlyWindows };
