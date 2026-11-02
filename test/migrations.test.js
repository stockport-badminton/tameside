// The contract between migrations/*.sql and tools/run-migration.js.
//
// The runner sends each file WHOLE, over the simple query protocol, deliberately not
// split on semicolons (player-auth-roles.sql and consolidate-club-contacts.sql both
// contain `DO $$ ... $$` blocks whose bodies have their own semicolons, and splitting
// mangles them). The transaction around that is opened by the RUNNER, with sql.begin().
//
// So a migration file must not write its own BEGIN/COMMIT. It isn't a style preference —
// it fails outright, and only at the moment someone runs it with --commit:
//
//   FAILED: UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1
//
// postgres.js refuses transaction control on a pooled connection, correctly: the pool is
// free to hand the next statement to a different connection, which would leave a BEGIN
// open on one and run the rest of the migration outside any transaction at all.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const RUNNER = fs.readFileSync(path.join(__dirname, '..', 'tools', 'run-migration.js'), 'utf8');
const FILES = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));

// Comments first: several of these files discuss BEGIN/COMMIT in prose, including the
// one explaining why they must not appear.
function statements(file) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

describe('migrations/*.sql', () => {
  it('has migrations to check', () => {
    assert.ok(FILES.length > 0);
  });

  for (const file of FILES) {
    it(file + ' contains no transaction control', () => {
      // Statement-level only. PL/pgSQL's own `BEGIN` inside a `DO $$ ... $$` block is
      // never followed by a semicolon, so it does not match and is not the problem.
      const offending = statements(file).match(/^[ \t]*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)[ \t]*;/mi);
      assert.strictEqual(offending, null,
        file + ' has a bare ' + (offending && offending[1]) +
        '; — the runner owns the transaction (sql.begin), and postgres.js rejects ' +
        'transaction control on a pooled connection with UNSAFE_TRANSACTION');
    });
  }
});

describe('tools/run-migration.js', () => {
  it('applies the file inside sql.begin, so a multi-statement migration is atomic', () => {
    assert.match(RUNNER, /transaction = fn => sql\.begin\(fn\)/,
      'the apply step must run inside sql.begin()');
    assert.match(RUNNER, /return transaction\(async \(tx\) => \{\s*\n\s*if \(text !== null\) await tx\.unsafe\(text\)\.simple\(\);/);
  });

  it('still sends the file whole rather than splitting on semicolons', () => {
    // Splitting is the obvious approach and it is wrong here — it cuts `DO $$ ... $$`
    // blocks in half. The Stockport league site's runner splits, which is why it could
    // never have applied player-auth-roles.sql.
    assert.doesNotMatch(RUNNER, /text\.split\(['"`];/);
    assert.match(RUNNER, /tx\.unsafe\(text\)/);
  });

  it('reports only on tables that exist', () => {
    // The post-apply report runs BELOW a successful commit, so a table name the regex
    // got wrong must not throw — the catch at the bottom of the runner would then print
    // FAILED for a migration that had in fact applied.
    assert.match(RUNNER, /information_schema\.tables[\s\S]{0,200}table_name IN \$\{sql\(named\)\}/);
  });
});

// The ledger (schema_migrations; Stockport's HARD-32). Nothing used to record which files
// had run: when it was backfilled on 2 Nov 2026, validate-club-contact-fks.sql turned out
// never to have been applied. These drive the runner's decisions against a fake ledger;
// the SQL itself was rehearsed against production inside a rolled-back transaction.
const crypto = require('crypto');
const {
  applyMigration, plan, ledgerDb, fileHash, Refusal, LEDGER_MIGRATION, REPEATABLE,
} = require('../tools/run-migration');

const SQL = Buffer.from('CREATE TABLE IF NOT EXISTS a (id int);\n');
const HASH = crypto.createHash('sha256').update(SQL).digest('hex');
const quiet = { log: () => {} };

function fakeDb({ ledger = true, row = null, fail = null } = {}) {
  const runs = [];
  return {
    runs,
    ledgerExists: async () => ledger,
    recorded: async () => row,
    allRecorded: async () => (row ? [row] : []),
    run: async (text, meta) => {
      if (fail) throw new Error(fail);
      runs.push({ text, ...meta });
    },
  };
}
const recordedRow = (sha256, how = 'applied') => ({ sha256, how, recorded_at: new Date() });

describe('run-migration.js records what it applies', () => {
  it('runs a file it has no record of, and records it with the hash of its bytes', async () => {
    const db = fakeDb();
    assert.strictEqual(await applyMigration(db, 'x.sql', SQL, quiet), 'apply');
    assert.deepStrictEqual(db.runs, [{ text: SQL.toString(), file: 'x.sql', hash: HASH, how: 'applied', replace: false }]);
  });

  it('treats a second application of the same file as a recorded no-op', async () => {
    const db = fakeDb({ row: recordedRow(HASH) });
    assert.strictEqual(await applyMigration(db, 'x.sql', SQL, quiet), 'already');
    assert.deepStrictEqual(db.runs, []);
  });

  // CHAR(64) pads; a hash compared without trimming would refuse every recorded file.
  it('compares the recorded hash without its padding', async () => {
    const db = fakeDb({ row: recordedRow(HASH + ' ', 'backfilled') });
    assert.strictEqual((await plan(db, 'x.sql', SQL)).action, 'already');
  });

  it('refuses a file edited since it was recorded, and runs none of it', async () => {
    const db = fakeDb({ row: recordedRow('f'.repeat(64)) });
    await assert.rejects(applyMigration(db, 'x.sql', SQL, quiet),
      e => e instanceof Refusal && /changed since it was recorded/.test(e.message));
    assert.deepStrictEqual(db.runs, []);
  });

  it('re-runs a REPEATABLE file whose hash changed, updating its row rather than adding one', async () => {
    const db = fakeDb({ row: recordedRow('f'.repeat(64)) });
    assert.strictEqual(await applyMigration(db, 'clone-season.sql', SQL, quiet), 'reapply');
    assert.strictEqual(db.runs[0].replace, true);
    assert.strictEqual(db.runs[0].how, 'applied');
  });

  it('refuses every file but the ledger migration on a database with no ledger', async () => {
    await assert.rejects(plan(fakeDb({ ledger: false }), 'player-auth-roles.sql', SQL),
      new RegExp(`Apply ${LEDGER_MIGRATION} first`));
    const db = fakeDb({ ledger: false });
    assert.strictEqual(await applyMigration(db, LEDGER_MIGRATION, SQL, quiet), 'apply');
    assert.strictEqual(db.runs.length, 1);
  });

  it('--record-only records a backfill and runs nothing', async () => {
    const db = fakeDb();
    assert.strictEqual(await applyMigration(db, 'x.sql', SQL, { ...quiet, recordOnly: true }), 'record');
    assert.deepStrictEqual(db.runs, [{ text: null, file: 'x.sql', hash: HASH, how: 'backfilled', replace: false }]);
  });

  it('--record-only never overwrites a record, even of a repeatable file', async () => {
    const db = fakeDb({ row: recordedRow('f'.repeat(64)) });
    await assert.rejects(plan(db, 'clone-season.sql', SQL, { recordOnly: true }), Refusal);
  });

  it('a failed run reports the failure and records nothing', async () => {
    const db = fakeDb({ fail: 'column "id" does not exist' });
    await assert.rejects(applyMigration(db, 'x.sql', SQL, quiet), /does not exist/);
  });
});

describe('ledgerDb', () => {
  // A postgres.js stand-in: tagged templates log their text; unsafe(...).simple() logs the file.
  function fakeSql() {
    const log = [];
    const tag = (strings) => { log.push(strings.join('?').replace(/\s+/g, ' ').trim()); return Promise.resolve([]); };
    tag.unsafe = (text) => ({ simple: async () => { log.push('FILE ' + text); } });
    return { tag, log };
  }

  it('runs the file and writes its row in ONE transaction, file first', async () => {
    const { tag, log } = fakeSql();
    let transactions = 0;
    const db = ledgerDb(tag, { transaction: async fn => { transactions++; log.push('BEGIN'); await fn(tag); log.push('COMMIT'); } });
    await db.run('CREATE TABLE a ();', { file: 'x.sql', hash: HASH, how: 'applied', replace: false });
    assert.strictEqual(transactions, 1);
    assert.deepStrictEqual(log.map(l => l.split(' ').slice(0, 3).join(' ')),
      ['BEGIN', 'FILE CREATE TABLE', 'INSERT INTO schema_migrations', 'COMMIT']);
  });

  it('a repeatable re-run UPDATEs its row; a backfill sends no file', async () => {
    const { tag, log } = fakeSql();
    const db = ledgerDb(tag, { transaction: fn => fn(tag) });
    await db.run('x', { file: 'clone-season.sql', hash: HASH, how: 'applied', replace: true });
    await db.run(null, { file: 'y.sql', hash: HASH, how: 'backfilled', replace: false });
    assert.match(log[1], /^UPDATE schema_migrations/);
    assert.match(log[2], /^INSERT INTO schema_migrations/);
    assert.strictEqual(log.filter(l => l.startsWith('FILE')).length, 1);
  });
});

describe('the ledger migration and the repeatable list', () => {
  it('the ledger migration exists under the name the runner bootstraps from', () => {
    const text = statements(LEDGER_MIGRATION);
    assert.match(text, /CREATE TABLE IF NOT EXISTS schema_migrations/);
    for (const how of ['applied', 'replayed', 'backfilled']) assert.ok(text.includes(`'${how}'`), how);
  });

  // A repeatable file is re-run whenever it changes, so it must be safe to re-run: every
  // statement in it a CREATE OR REPLACE.
  for (const file of REPEATABLE) {
    it(file + ' is a CREATE OR REPLACE definition, safe to re-run', () => {
      const text = statements(file);
      const topLevel = text.split(/\$fn\$[\s\S]*?\$fn\$/).join(' ');
      assert.match(topLevel, /create\s+or\s+replace\s+function/i);
      assert.doesNotMatch(topLevel, /\b(insert|update|delete|alter|drop)\b/i);
    });
  }

  it('hashes bytes, as shasum does', () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x0d, 0x0a]);
    assert.strictEqual(fileHash(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
  });

  it('accepts the migrations/ prefix that docs/ uses', () => {
    assert.match(RUNNER, /name\.replace\(\/\^migrations\\\/\/, ''\)/);
  });
});
