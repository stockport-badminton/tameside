#!/usr/bin/env node
//
// Apply a file from migrations/ to the database.
//
//   node tools/run-migration.js player-auth-roles.sql            # dry run: prints the SQL
//   node tools/run-migration.js player-auth-roles.sql --commit   # actually applies it
//   node tools/run-migration.js --list
//
// There was no runner before this, so the seven files in migrations/ were applied by
// hand through the Supabase SQL editor. That's fine until the sequencing matters — and
// with player-auth-roles.sql it does: deploy before applying it and every login fails
// the role lookup, so every admin silently loses access.
//
// Dry run by default, and it prints what it is about to send. Migrations in this repo
// are written additive and idempotent (ADD COLUMN IF NOT EXISTS, guarded constraints),
// so re-running one is safe — but that is a property of the files, not of this script,
// so read the SQL it echoes.
//
// Sent via the SIMPLE query protocol in one go, deliberately NOT split on semicolons.
// Splitting is the obvious approach and it is wrong here: player-auth-roles.sql
// contains a `DO $$ ... $$` block whose body has its own semicolons, and cutting it up
// produces syntax errors. (The Stockport league site's runner splits, which is why it
// could never have applied this file.)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sql } = require('../utils/db_connect');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const LIST = args.includes('--list');
const name = args.find(a => !a.startsWith('--'));

function list() {
  console.log('migrations/:');
  fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .forEach(f => console.log('  ' + f));
}

(async () => {
  if (LIST || !name) {
    list();
    if (!name) {
      console.log('\nusage: node tools/run-migration.js <file.sql> [--commit]');
    }
    process.exit(0);
  }

  // Resolve inside migrations/ and refuse anything that escapes it.
  const file = path.resolve(MIGRATIONS_DIR, name);
  if (!file.startsWith(MIGRATIONS_DIR + path.sep)) {
    console.error('refusing a path outside migrations/:', name);
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error('no such migration:', name);
    console.error();
    list();
    process.exit(1);
  }

  const text = fs.readFileSync(file, 'utf8');
  console.log('--- ' + path.basename(file) + ' ---');
  console.log(text.trimEnd());
  console.log('--- end ---');
  console.log();

  if (!COMMIT) {
    console.log('Dry run. Nothing was sent. Re-run with --commit to apply.');
    process.exit(0);
  }

  const [{ db, host }] = await sql`SELECT current_database() AS db, inet_server_addr()::text AS host`;
  console.log(`Applying to ${db} (${host || 'pooled'})…`);

  await sql.unsafe(text).simple();
  console.log('Applied.');

  // Say what the table looks like now rather than just claiming success — the whole
  // point of running this is that the next deploy depends on these columns existing.
  const cols = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'player' AND table_schema = 'public'
    ORDER BY ordinal_position`;
  console.log('\nplayer columns now:');
  cols.forEach(c => console.log(
    `  ${c.column_name.padEnd(22)} ${c.data_type.padEnd(28)} ` +
    `${c.is_nullable === 'YES' ? 'null' : 'NOT NULL'}${c.column_default ? '  default ' + c.column_default : ''}`
  ));

  process.exit(0);
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
