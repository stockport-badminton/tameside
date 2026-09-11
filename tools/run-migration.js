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

  // ATOMIC, and the transaction is opened HERE rather than in the .sql file.
  //
  // postgres.js refuses BEGIN/COMMIT inside sql.unsafe() on a pooled connection —
  // `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1` — and it is right
  // to: the pool is free to hand the next statement to a different connection, which
  // would leave a BEGIN open on one and run the rest outside any transaction at all.
  //
  // So migration FILES must not contain their own BEGIN/COMMIT. sql.begin() reserves
  // one connection for the whole file, which is what makes a multi-statement migration
  // all-or-nothing; before this the text was sent bare, so a file that failed half way
  // through left the database between two states with nothing to say so.
  await sql.begin(async (tx) => {
    await tx.unsafe(text).simple();
  });
  console.log('Applied.');

  // Say what the tables look like now rather than just claiming success — the whole
  // point of running this is that the next deploy depends on the change being there.
  //
  // Derived from the file rather than hardcoded. This used to always print the `player`
  // columns, because that is the table player-auth-roles.sql changes and this runner was
  // written to apply it. For any other migration that is noise at best, and at worst
  // reads as confirmation of something the file never touched.

  // Comments are stripped first, because this file's own header talks about ALTER TABLE
  // and clone-season.sql's explains `CREATE TABLE AS` — both would otherwise be scraped
  // as table names. The optional `schema.` prefix is skipped rather than captured, and
  // the captured name must be a real identifier, which keeps clone-season.sql's
  // `format('create table public.%I ...')` out as well: those names only exist at
  // runtime and there is nothing static to report on.
  //
  // A heuristic, not a parser — which is why the existence check below, rather than the
  // regex, is what actually guards the queries.
  const sqlOnly = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const named = [...new Set(
    [...sqlOnly.matchAll(/(?:ALTER|CREATE)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)]
      .map(m => m[1].toLowerCase())
  )];

  // Only report on tables that actually exist. A name this regex got wrong would
  // otherwise throw on ::regclass BELOW A SUCCESSFUL COMMIT, and the catch at the
  // bottom of this file would print FAILED for a migration that had in fact applied —
  // the worst possible thing for this script to be wrong about.
  const present = named.length
    ? (await sql`SELECT table_name FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_name IN ${sql(named)}`)
        .map(r => r.table_name)
    : [];

  if (present.length === 0) {
    console.log('\nNo table definitions changed by this migration (data-only).');
  }

  for (const table of present) {
    const cols = await sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = ${table} AND table_schema = 'public'
      ORDER BY ordinal_position`;
    console.log(`\n${table} columns now:`);
    cols.forEach(c => console.log(
      `  ${c.column_name.padEnd(22)} ${c.data_type.padEnd(28)} ` +
      `${c.is_nullable === 'YES' ? 'null' : 'NOT NULL'}${c.column_default ? '  default ' + c.column_default : ''}`
    ));

    // Constraints too: a migration can change a table without adding a column, and a
    // foreign key that silently failed to appear is exactly the sort of thing this
    // report exists to catch.
    const cons = await sql`
      SELECT conname, pg_get_constraintdef(oid) AS def, convalidated
      FROM pg_constraint
      WHERE conrelid = ${table}::regclass
      ORDER BY conname`;
    if (cons.length) {
      console.log(`${table} constraints:`);
      cons.forEach(c => console.log(
        `  ${c.conname.padEnd(28)} ${c.def}${c.convalidated ? '' : '  [NOT VALIDATED]'}`
      ));
    }
  }

  process.exit(0);
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
