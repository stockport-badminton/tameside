/**
 * Scheduler test harness — run with: node test-scheduler.js
 * Loads real team + lewis data, generates a fixture calendar,
 * and prints gap-distribution stats without touching the DB draft.
 */
require('dotenv').config();
const fixtureGenModel = require('./models/fixtureGenModel');
const { generateFixtureCalendar, getSeasonDates, getLewisEarlyWindows } = require('./utils/fixtureScheduler');

const seasonDates = getSeasonDates();

fixtureGenModel.getTeamsForScheduler(function (err, divisions) {
  if (err) { console.error('Failed to load teams:', err); process.exit(1); }

  fixtureGenModel.getLewisConstraints(seasonDates.season, function (err, lewisConstraints) {
    if (err) {
      console.warn('Lewis constraints failed (continuing without):', err.message);
      lewisConstraints = { r1Pairs: [], r2Pairs: [], qfPairs: [] };
    }

    console.log(`\nSeason ${seasonDates.season}  |  ${divisions.length} divisions  |  ${divisions.reduce((s,d)=>s+d.teams.length,0)} teams total`);
    console.log('Generating...\n');

    const { calendar, stats } = generateFixtureCalendar(
      divisions,
      seasonDates.seasonStart,
      seasonDates.seasonEnd,
      seasonDates.xmasDate,
      seasonDates.easterDate,
      seasonDates.interClubDate,
      lewisConstraints
    );

    // ── Per-team gap analysis (regular + Lewis R1/R2 only — QF perms excluded) ─
    const teamDates = new Map();   // teamName → sorted array of Date objects

    for (const row of calendar) {
      for (const fix of row.fixtures || []) {
        if (fix.lewisQF) continue; // QF perms are contingency fixtures, excluded from gap stats
        for (const name of [fix.homeTeam.name, fix.awayTeam.name]) {
          if (!teamDates.has(name)) teamDates.set(name, []);
          teamDates.get(name).push(row.dateObj);
        }
      }
    }

    const allGaps = [];
    const teamRows = [];

    for (const [name, dates] of teamDates) {
      dates.sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < dates.length; i++) {
        gaps.push(Math.round((dates[i] - dates[i - 1]) / 86400000));
      }
      if (gaps.length === 0) continue;
      allGaps.push(...gaps);
      const min = Math.min(...gaps);
      const avg = (gaps.reduce((s, g) => s + g, 0) / gaps.length).toFixed(1);
      const max = Math.max(...gaps);
      teamRows.push({ name, min, avg: parseFloat(avg), max, games: dates.length, gaps });
    }

    teamRows.sort((a, b) => a.min - b.min);

    console.log('── Per-team gap stats (sorted by min gap) ──────────────────');
    console.log('Team                          Games  Min   Avg   Max');
    for (const r of teamRows) {
      const flag = r.min < 6 ? ' ⚠' : r.min < 8 ? ' ·' : '';
      console.log(
        r.name.padEnd(30) +
        String(r.games).padStart(4) + '  ' +
        String(r.min).padStart(4) + '  ' +
        String(r.avg.toFixed(1)).padStart(5) + '  ' +
        String(r.max).padStart(4) +
        flag
      );
    }

    // ── Gap histogram ────────────────────────────────────────────────────────
    const buckets = {};
    for (const g of allGaps) {
      const b = g <= 6 ? `${g}d` : g <= 13 ? '7-13d' : g <= 20 ? '14-20d' : '21+d';
      buckets[b] = (buckets[b] || 0) + 1;
    }
    const order = ['1d','2d','3d','4d','5d','6d','7-13d','14-20d','21+d'];
    console.log('\n── Gap histogram (all teams) ────────────────────────────────');
    for (const b of order) {
      if (!buckets[b]) continue;
      const bar = '█'.repeat(Math.round(buckets[b] / 2));
      console.log(`${b.padEnd(7)} ${String(buckets[b]).padStart(4)}  ${bar}`);
    }

    // ── Wrong home night check (QF perms excluded — they intentionally skip this) ─
    const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const wrongNight = [];
    for (const row of calendar) {
      for (const fix of row.fixtures || []) {
        if (fix.lewisQF) continue;
        const actual = DAY_NAMES[row.dateObj.getDay()];
        if (actual !== fix.homeTeam.homeNight) {
          wrongNight.push(`${fix.homeTeam.name} (wants ${fix.homeTeam.homeNight}) placed on ${actual} ${row.dbDate}`);
        }
      }
    }
    if (wrongNight.length > 0) {
      console.log('\n── Wrong home night violations ──────────────────────────────');
      wrongNight.forEach(s => console.log(' ⚠ ' + s));
    }

    // ── Concurrent home matches per club ─────────────────────────────────────
    const concurrentHome = [];    // regular fixture violations
    const concurrentHomeQF = [];  // QF perm nights (expected — they're contingency)
    for (const row of calendar) {
      const homeByClub = new Map();
      for (const fix of row.fixtures || []) {
        const club = fix.homeTeam.club;
        if (!homeByClub.has(club)) homeByClub.set(club, []);
        homeByClub.get(club).push({ name: fix.homeTeam.name, isQF: !!fix.lewisQF });
      }
      for (const [club, entries] of homeByClub) {
        if (entries.length > 1) {
          const hasQF = entries.some(e => e.isQF);
          const msg = `${row.dbDate}: ${club} — ${entries.map(e => e.name + (e.isQF ? ' (QF)' : '')).join(' & ')} both home`;
          if (hasQF) concurrentHomeQF.push(msg);
          else concurrentHome.push(msg);
        }
      }
    }
    if (concurrentHome.length > 0) {
      console.log('\n── Concurrent home matches (same club, non-QF) ──────────────');
      concurrentHome.forEach(s => console.log(' ⚠ ' + s));
    }
    if (concurrentHomeQF.length > 0) {
      console.log(`\n── QF perm concurrent home (expected — ${concurrentHomeQF.length} nights) ──────────`);
      concurrentHomeQF.forEach(s => console.log(' · ' + s));
    }

    // ── Overall stats ────────────────────────────────────────────────────────
    const overallMin = Math.min(...allGaps);
    const overallAvg = (allGaps.reduce((s, g) => s + g, 0) / allGaps.length).toFixed(1);
    const tooClose = allGaps.filter(g => g < 6).length;

    const qfPlaced = calendar.reduce((sum, row) => sum + (row.fixtures || []).filter(f => f.lewisQF).length, 0);

    // ── LS window utilisation ─────────────────────────────────────────────────
    // Show how many non-Saturday dates in each Lewis window are completely empty
    // (no fixture of any kind). These are slots that could absorb displaced regulars
    // if we allowed regular fixtures into the windows on days with no Lewis match.
    const { ls1Start, ls1End, ls2Start, ls2End } = getLewisEarlyWindows(seasonDates.xmasDate);
    const calendarDateSet = new Set(calendar.map(row => row.dbDate));
    function windowStats(wStart, wEnd, label) {
      let total = 0, used = 0;
      const d = new Date(wStart);
      while (d <= wEnd) {
        if (d.getDay() !== 6) { // exclude Saturdays
          total++;
          const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
          if (calendarDateSet.has(key)) used++;
        }
        d.setDate(d.getDate() + 1);
      }
      const unused = total - used;
      console.log(`  ${label.padEnd(6)} ${wStart.toISOString().split('T')[0]} → ${wEnd.toISOString().split('T')[0]}  total=${total}  used=${used}  unused=${unused}`);
      return unused;
    }
    console.log('\n── LS window utilisation (unused = potential slots for regulars) ──');
    const unusedLS1 = windowStats(ls1Start, ls1End, 'LS1');
    const unusedLS2 = windowStats(ls2Start, ls2End, 'LS2');
    console.log(`  Combined unused capacity: ${unusedLS1 + unusedLS2} date-slots`);

    console.log('\n── Summary ──────────────────────────────────────────────────');
    console.log(`Fixtures scheduled : ${stats.totalFixtures}`);
    console.log(`Unplaced           : ${stats.unplaced}`);
    console.log(`QF perms placed    : ${qfPlaced} (target: 20)`);
    console.log(`Extensions         : ${stats.extensions}`);
    console.log(`Overall min gap    : ${overallMin}d`);
    console.log(`Overall avg gap    : ${overallAvg}d`);
    console.log(`Gaps < 6 days      : ${tooClose} (target: 0)`);
    console.log(`Wrong home nights  : ${wrongNight.length} (target: 0)`);
    console.log(`Concurrent home    : ${concurrentHome.length} (target: 0)`);
    console.log(`Consecutive nights : ${stats.consecutiveNights.map(c=>`${c.club}:${c.count}`).join(', ') || 'none'}`);
    console.log('');

    process.exit(0);
  });
});
