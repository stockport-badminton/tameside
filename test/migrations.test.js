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
    assert.match(RUNNER, /await sql\.begin\(async \(tx\) => \{\s*\n\s*await tx\.unsafe\(text\)\.simple\(\);/,
      'the apply step must run inside sql.begin()');
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
