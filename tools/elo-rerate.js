#!/usr/bin/env node
//
// Re-rate ELO forward from one fixture — utils/eloChain.rerateFrom from the command line.
//
//   node tools/elo-rerate.js 6070                 # dry run: what a late result would change
//   node tools/elo-rerate.js 6070 --every         # dry run of re-rating EVERY fixture from
//                                                 # there to now (a backfill of the rest of
//                                                 # the season, lifetime games counts kept)
//   node tools/elo-rerate.js 6070 --every --commit
//   node tools/elo-rerate.js --first --every      # from the season's first league fixture
//
//   node tools/elo-rerate.js --rehearse           # re-rate the whole season, then check a
//                                                 # chain from every fixture finds nothing
//                                                 # left to change; always rolls back
//
// Dry run by default; it computes everything inside a transaction and writes nothing.
// --every lifts the 40-fixture cap. --detail lists, per fixture re-rated, how many of its
// games would change.
//
// --rehearse is the check that the chain's two sources of a player's state agree: what it
// carries in memory along a walk, and what getRatingStateBefore reads back from the games.
// After the season is re-rated, a walk from ANY fixture must find nothing to change. There
// is no local database, so it runs against production inside one transaction and throws
// to roll back, like tools/rehearse-roster.js.
require('dotenv').config();
const Fixture = require('../models/fixture');
const seasonModel = require('../models/season');
const eloChain = require('../utils/eloChain');
const { sql } = require('../utils/db_connect');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const EVERY = args.includes('--every');
const DETAIL = args.includes('--detail');
const FIRST = args.includes('--first');
const REHEARSE = args.includes('--rehearse');
const ROLLBACK = new Error('rehearsal: rolled back');
const id = args.find(a => /^\d+$/.test(a));

async function firstFixtureId() {
  const rows = await new Promise((resolve, reject) =>
    Fixture.getFixtureDetails({ status: 'complete' }, (err, r) => err ? reject(err) : resolve(r || [])));
  const first = rows.find(f => f.lewis_round == null);
  return first && first.id;
}

async function rehearse() {
  const fixtures = (await new Promise((resolve, reject) =>
    Fixture.getFixtureDetails({ status: 'complete' }, (err, r) => err ? reject(err) : resolve(r || []))))
    .filter(f => f.lewis_round == null);
  let report;
  try {
    await sql.begin(async tx => {
      const all = await eloChain.rerateFrom(fixtures[0].id, { tx, everyFixture: true, maxFixtures: 100000 });
      console.log('re-rated the season inside the transaction:', all);
      const leftovers = [];
      for (const f of fixtures) {
        const r = await eloChain.rerateFrom(f.id, { tx, dryRun: true });
        if (r.games > 0) leftovers.push({ id: f.id, games: r.games });
      }
      report = { fixturesChecked: fixtures.length, leftovers };
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  console.log(report);
  console.log(report.leftovers.length === 0
    ? 'PASS: every chain agrees with the re-rated season. Rolled back; nothing written.'
    : 'FAIL: the chain and the re-rated season disagree. Rolled back; nothing written.');
}

(async () => {
  await seasonModel.init();
  if (REHEARSE) { await rehearse(); await sql.end(); process.exit(0); }
  const from = FIRST ? await firstFixtureId() : id;
  if (!from) {
    console.error('usage: node tools/elo-rerate.js <fixtureId>|--first [--every] [--detail] [--commit]');
    process.exit(2);
  }
  const opts = { dryRun: !COMMIT, everyFixture: EVERY, maxFixtures: EVERY ? 100000 : undefined };
  console.log(`${COMMIT ? 'COMMIT' : 'dry run'}: re-rate from fixture ${from}${EVERY ? ', every fixture' : ''} (season ${seasonModel.current()})`);
  const t0 = Date.now();
  const r = await eloChain.rerateFrom(from, opts);
  const { perFixture, ...summary } = r;
  console.log({ ...summary, ms: Date.now() - t0 });
  if (DETAIL && perFixture) {
    for (const f of perFixture) console.log(`  ${f.id}  ${new Date(f.date).toISOString().slice(0, 10)}  ${f.gamesChanged} games`);
  }
  await sql.end();
  process.exit(0);
})().catch(async e => { console.error(e.message); await sql.end(); process.exit(1); });
