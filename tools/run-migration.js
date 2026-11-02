#!/usr/bin/env node
//
// Apply a file from migrations/ to the database, and record that it did.
//
//   node tools/run-migration.js player-auth-roles.sql            # dry run: prints the SQL
//   node tools/run-migration.js player-auth-roles.sql --commit   # applies it, and records it
//   node tools/run-migration.js player-auth-roles.sql --record-only --commit
//                                                                # records it WITHOUT running
//                                                                # it, for a file the schema
//                                                                # shows is already applied
//   node tools/run-migration.js --status                         # every file against the record
//   node tools/run-migration.js --list
//
// There was no runner before this, so the seven files in migrations/ were applied by
// hand through the Supabase SQL editor. That's fine until the sequencing matters — and
// with player-auth-roles.sql it does: deploy before applying it and every login fails
// the role lookup, so every admin silently loses access.
//
// Dry run by default, and it prints what it is about to send, and what the ledger says.
//
// Sent via the SIMPLE query protocol in one go, deliberately NOT split on semicolons.
// Splitting is the obvious approach and it is wrong here: player-auth-roles.sql
// contains a `DO $$ ... $$` block whose body has its own semicolons, and cutting it up
// produces syntax errors. (The Stockport league site's runner used to split; theirs now
// has a real statement scanner, utils/sqlScan.js.)
//
// THE LEDGER (schema_migrations, migrations/schema-migrations.sql; Stockport's HARD-32).
// Nothing used to record which files had run, so "has this been applied to production?"
// was answered by remembering — and when the table was backfilled on 2 Nov 2026,
// validate-club-contact-fks.sql turned out never to have been. Every file is now recorded
// with a sha256 of its bytes:
//   - recorded, same hash   a no-op that says when and how it was recorded
//   - recorded, other hash  REFUSED: the database has the old version. Write a new
//                           migration for the difference. (Except REPEATABLE, below.)
//   - no ledger at all      every file refused but the one that creates it
//
// The record is written in the SAME transaction as the file. Stockport's runner can't do
// that — it tolerates "already exists" per statement, which aborts a transaction — so a
// failed run there leaves no row by ordering. Here it is atomic: a row means it applied.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
// The file that creates the ledger. The only one a database without a ledger will accept.
const LEDGER_MIGRATION = 'schema-migrations.sql';
// Files that define something with CREATE OR REPLACE and are meant to be edited and
// re-applied, so a changed hash re-runs them and updates the row rather than refusing.
// clone-season.sql installs clone_season(), which has been edited since it first ran
// (it nulls archived contact columns now). A new file per edit would copy the whole
// function each time, and the old file would then describe a function that no longer exists.
const REPEATABLE = new Set(['clone-season.sql']);

class Refusal extends Error {}

// Of the bytes, not a decoded string, so it is the same digest `shasum -a 256` prints.
function fileHash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// The ledger's queries, on a postgres.js `sql`. `transaction` is how the file and its row
// get one transaction: sql.begin for real, a savepoint when rehearsing inside one.
function ledgerDb(sql, { transaction = fn => sql.begin(fn) } = {}) {
  return {
    async ledgerExists() {
      const [r] = await sql`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`;
      return r.present === true;
    },
    async recorded(file) {
      const [r] = await sql`SELECT sha256, how, recorded_at FROM schema_migrations WHERE filename = ${file}`;
      return r || null;
    },
    async allRecorded() {
      return sql`SELECT filename, sha256, how, recorded_at FROM schema_migrations`;
    },
    // Runs the file (unless text is null) and writes its row, all or nothing.
    run(text, { file, hash, how, replace }) {
      return transaction(async (tx) => {
        if (text !== null) await tx.unsafe(text).simple();
        if (replace) {
          await tx`UPDATE schema_migrations SET sha256 = ${hash}, how = ${how}, recorded_at = now()
                    WHERE filename = ${file}`;
        } else {
          await tx`INSERT INTO schema_migrations (filename, sha256, how) VALUES (${file}, ${hash}, ${how})`;
        }
      });
    },
  };
}

// What --commit would do with this file, without doing it.
// One of: 'apply', 'reapply' (REPEATABLE, changed), 'record', 'already'. Throws a Refusal.
async function plan(db, file, bytes, { recordOnly = false } = {}) {
  const hash = fileHash(bytes);
  if (!(await db.ledgerExists())) {
    if (file === LEDGER_MIGRATION) return { action: recordOnly ? 'record' : 'apply', hash };
    throw new Refusal(
      `this database has no schema_migrations table, so nothing would record that ` +
      `${file} ran. Apply ${LEDGER_MIGRATION} first.`
    );
  }
  const row = await db.recorded(file);
  // CHAR(64) pads; compared untrimmed, every recorded file would read as edited.
  if (row && row.sha256.trim() === hash) return { action: 'already', hash, row };
  if (row && !REPEATABLE.has(file)) {
    throw new Refusal(
      `${file} has changed since it was recorded (${row.how}): recorded ${row.sha256.trim().slice(0, 12)}…, ` +
      `file now ${hash.slice(0, 12)}…. The database has the old version. Write a new ` +
      `migration for the difference rather than editing one that has run.`
    );
  }
  if (row && recordOnly) {
    throw new Refusal(`${file} is already recorded with another hash; --record-only does not overwrite a record`);
  }
  if (row) return { action: 'reapply', hash, row };
  return { action: recordOnly ? 'record' : 'apply', hash };
}

// Carries out a plan. Returns the action taken.
async function applyMigration(db, file, bytes, { recordOnly = false, log = console.log } = {}) {
  const p = await plan(db, file, bytes, { recordOnly });
  const meta = { file, hash: p.hash };
  if (p.action === 'already') {
    log(`· ${file} is already recorded (${p.row.how} ${new Date(p.row.recorded_at).toISOString()}); nothing to do`);
  } else if (p.action === 'record') {
    // A backfill is only as good as the evidence the schema already has the file in it.
    // The caller has to have looked; this just writes down that they did.
    await db.run(null, { ...meta, how: 'backfilled', replace: false });
    log(`✓ ${file} recorded as backfilled, not run`);
  } else {
    await db.run(bytes.toString('utf8'), { ...meta, how: 'applied', replace: p.action === 'reapply' });
    log(`✓ ${file} ${p.action === 'reapply' ? 're-applied (repeatable, changed)' : 'applied'}, and recorded`);
  }
  return p.action;
}

// Every file in migrations/, against what this database has recorded.
async function status(db, dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const hasLedger = await db.ledgerExists();
  const rows = new Map(hasLedger ? (await db.allRecorded()).map(r => [r.filename, r]) : []);
  return {
    hasLedger,
    files: files.map(file => {
      const row = rows.get(file);
      if (!row) return { file, state: 'NOT RECORDED' };
      const same = row.sha256.trim() === fileHash(fs.readFileSync(path.join(dir, file)));
      return { file, state: same ? row.how : `${row.how}, FILE CHANGED SINCE`, at: row.recorded_at };
    }),
    // Recorded here but no longer in the repo — renamed or deleted after it ran.
    unknown: [...rows.keys()].filter(f => !files.includes(f)).sort(),
  };
}

function list() {
  console.log('migrations/:');
  fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .forEach(f => console.log('  ' + f));
}

async function main(args) {
  const COMMIT = args.includes('--commit');
  const RECORD_ONLY = args.includes('--record-only');
  const name = args.find(a => !a.startsWith('--'));

  if (args.includes('--list') || (!name && !args.includes('--status'))) {
    list();
    if (!name) {
      console.log('\nusage: node tools/run-migration.js <file.sql> [--record-only] [--commit] | --status');
    }
    return;
  }

  const { sql } = require('../utils/db_connect');
  const db = ledgerDb(sql);

  if (args.includes('--status')) {
    const s = await status(db);
    if (!s.hasLedger) console.log(`no schema_migrations table: apply ${LEDGER_MIGRATION} first`);
    for (const f of s.files) {
      console.log(`  ${f.file.padEnd(36)} ${f.state}${f.at ? '  ' + new Date(f.at).toISOString().slice(0, 16) : ''}`);
    }
    for (const f of s.unknown) console.log(`  ${f.padEnd(36)} recorded, but no such file`);
    return;
  }

  // Resolve inside migrations/ and refuse anything that escapes it. A leading
  // `migrations/` is accepted, because that is how docs/ spells these paths.
  const file = path.resolve(MIGRATIONS_DIR, name.replace(/^migrations\//, ''));
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
  // The ledger is keyed by bare filename, so `migrations/x.sql` and `x.sql` are one file.
  const base = path.basename(file);
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');

  if (!RECORD_ONLY) {
    console.log('--- ' + base + ' ---');
    console.log(text.trimEnd());
    console.log('--- end ---');
    console.log();
  }

  const [{ db: dbName, host }] = await sql`SELECT current_database() AS db, inet_server_addr()::text AS host`;
  const p = await plan(db, base, bytes, { recordOnly: RECORD_ONLY });
  const WOULD = {
    apply: 'not recorded: --commit would run it and record it',
    reapply: `recorded with another hash; repeatable, so --commit would re-run it and update the record`,
    record: 'not recorded: --commit would record it as backfilled WITHOUT running it',
    already: 'already recorded',
  };

  if (!COMMIT || p.action === 'already') {
    if (p.action === 'already') {
      console.log(`${base} is already recorded in ${dbName} (${p.row.how} ${new Date(p.row.recorded_at).toISOString()}). Nothing to do.`);
    } else {
      console.log(`Ledger (${dbName}): ${WOULD[p.action]}.`);
      console.log('Dry run. Nothing was sent. Re-run with --commit to apply.');
    }
    return;
  }

  console.log(`${RECORD_ONLY ? 'Recording in' : 'Applying to'} ${dbName} (${host || 'pooled'})…`);

  // ATOMIC, and the transaction is opened HERE (ledgerDb.run) rather than in the file.
  //
  // postgres.js refuses BEGIN/COMMIT inside sql.unsafe() on a pooled connection —
  // `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1` — and it is right
  // to: the pool is free to hand the next statement to a different connection, which
  // would leave a BEGIN open on one and run the rest outside any transaction at all.
  //
  // So migration FILES must not contain their own BEGIN/COMMIT. sql.begin() reserves
  // one connection for the whole file and its ledger row, which is what makes a
  // multi-statement migration all-or-nothing and its record true.
  const action = await applyMigration(db, base, bytes, { recordOnly: RECORD_ONLY });
  if (action === 'record') return;

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
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err instanceof Refusal ? 'REFUSED: ' + err.message : 'FAILED: ' + err.message);
      process.exit(1);
    });
}

module.exports = { applyMigration, plan, status, ledgerDb, fileHash, Refusal, LEDGER_MIGRATION, REPEATABLE };
