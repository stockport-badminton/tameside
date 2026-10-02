#!/usr/bin/env node
// Rotate DB_ENCODE, the pgp key for player contact details. Dry by default.
//
// Why: Tameside's key was the same value as Stockport's original DB_PI_KEY, which was
// written into Stockport's Cloud Logging and rotated there on 14 Sep 2026 (league-site
// HARD-31). Ported from their scripts/hard31-rotate-pi-key.js, which is worth reading.
//
//   NEW_DB_ENCODE="$(cat newkey)" node tools/rotate-db-encode.js              # counts only
//   NEW_DB_ENCODE="$(cat newkey)" node tools/rotate-db-encode.js --rehearse   # everything, then ROLLBACK
//   NEW_DB_ENCODE="$(cat newkey)" node tools/rotate-db-encode.js --apply      # everything, COMMIT
//   NEW_DB_ENCODE="$(cat newkey)" node tools/rotate-db-encode.js --verify     # after cutover, per row
//
// The old key is DB_ENCODE from .env. Neither key is ever taken from argv (visible in `ps`),
// printed, or interpolated into SQL — both are bound.
//
// - **In the database, never extract-and-rewrite.** One UPDATE per column re-encrypts with
//   the plaintext never leaving Postgres.
// - **--rehearse runs the real statements on production and rolls back.** Tameside has no
//   local database to rehearse against, and Stockport's rehearsal is what found two bugs in
//   their own verification.
// - **A wrong key RAISES `Wrong key or corrupt data`; it does not return NULL.** So a count
//   of decryptable rows either equals the total or throws, and the "old key no longer
//   decrypts" check expects a throw — inside a SAVEPOINT here, because an error inside a
//   transaction otherwise aborts it (which is how Stockport's first run rolled back at the
//   final step).
// - **The season archives are CLEARED, not re-encrypted** (decided 2026-10-02). Nothing reads
//   contact details from an archive; they are copies clone_season() happened to take.
// - **The cutover window.** Between --apply committing and Cloud Run serving the new key,
//   the app holds the OLD key against NEW ciphertext, and anything it saves in that window
//   is old-key ciphertext. --verify finds those rows and --fix-stray re-encrypts them.
require('dotenv').config({ quiet: true });
const { sql } = require('../utils/db_connect');

const MODE = ['--rehearse', '--apply', '--verify', '--fix-stray'].find(f => process.argv.includes(f)) || '--dry';
const OLD = process.env.DB_ENCODE;
const NEW = process.env.NEW_DB_ENCODE;

const LIVE = [
  { table: 'player', key: 'id', column: 'playerEmail' },
  { table: 'player', key: 'id', column: 'playerTel' },
  { table: 'player', key: 'id', column: 'authEmail' },
  { table: 'player_auth_email', key: 'id', column: 'email' },
];
const ARCHIVE_COLUMNS = ['playerEmail', 'playerTel', 'authEmail'];
const ROLLBACK = Symbol('rehearsal rollback');

async function decryptCount(db, { table, column }, key) {
  const [{ n }] = await db`
    SELECT count(*)::int AS n FROM ${sql(table)}
     WHERE ${sql(column)} IS NOT NULL AND pgp_sym_decrypt(${sql(column)}, ${key}) IS NOT NULL`;
  return n;
}

async function storedCount(db, { table, column }) {
  const [{ n }] = await db`SELECT count(*)::int AS n FROM ${sql(table)} WHERE ${sql(column)} IS NOT NULL`;
  return n;
}

async function archiveColumns(db) {
  return db`
    SELECT table_name AS table, column_name AS column FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name ~ '^player20[0-9]{6}$'
       AND column_name = ANY(${ARCHIVE_COLUMNS})
     ORDER BY 1, 2`;
}

// Rows whose value does NOT decrypt under `key`, one query per row (a few hundred) so a
// raise identifies the row rather than failing the whole count.
async function strays(key) {
  const found = [];
  for (const c of LIVE) {
    const rows = await sql`SELECT ${sql(c.key)} AS id FROM ${sql(c.table)} WHERE ${sql(c.column)} IS NOT NULL`;
    for (const { id } of rows) {
      try {
        await sql`SELECT pgp_sym_decrypt(${sql(c.column)}, ${key}) FROM ${sql(c.table)} WHERE ${sql(c.key)} = ${id}`;
      } catch (err) {
        found.push({ ...c, id });
      }
    }
  }
  return found;
}

async function main() {
  if (!OLD || !NEW) throw new Error('DB_ENCODE (old, from .env) and NEW_DB_ENCODE must both be set.');
  if (OLD === NEW) throw new Error('DB_ENCODE and NEW_DB_ENCODE are the same — nothing to rotate.');
  if (NEW.length < 24) throw new Error('NEW_DB_ENCODE is suspiciously short.');

  console.log(`target : ${new URL(process.env.DATABASE_URL).host}`);
  console.log(`mode   : ${MODE}\n`);

  if (MODE === '--verify' || MODE === '--fix-stray') {
    const bad = await strays(NEW);
    console.log(bad.length === 0
      ? '✓ every live value decrypts under the new key'
      : `✗ ${bad.length} value(s) do not decrypt under the new key: ` + bad.map(b => `${b.table}.${b.column}#${b.id}`).join(', '));
    if (bad.length && MODE === '--fix-stray') {
      // Written in the cutover window by an instance still holding the old key.
      for (const b of bad) {
        await sql`UPDATE ${sql(b.table)} SET ${sql(b.column)} = pgp_sym_encrypt(pgp_sym_decrypt(${sql(b.column)}, ${OLD}), ${NEW})
                   WHERE ${sql(b.key)} = ${b.id}`;
        console.log(`  re-encrypted ${b.table}.${b.column}#${b.id}`);
      }
      const after = await strays(NEW);
      console.log(after.length === 0 ? '✓ now clean' : `✗ still ${after.length} — investigate`);
    }
    return;
  }

  // Before: every stored value must decrypt under the old key, or rotating bakes in a mess.
  const before = {};
  for (const c of LIVE) {
    const stored = await storedCount(sql, c);
    let ok;
    try { ok = await decryptCount(sql, c, OLD); } catch (err) {
      throw new Error(`${c.table}.${c.column}: a value does not decrypt under the old key (${err.message}). Stopping.`);
    }
    before[`${c.table}.${c.column}`] = stored;
    console.log(`  ${c.table}.${c.column}: ${stored} stored, all decrypt under the old key`);
  }
  const archives = await archiveColumns(sql);
  let archived = 0;
  for (const a of archives) archived += await storedCount(sql, a);
  console.log(`  archives: ${archived} value(s) across ${new Set(archives.map(a => a.table)).size} tables to CLEAR`);

  if (MODE === '--dry') {
    console.log('\ndry run — nothing written. --rehearse runs it all and rolls back.');
    return;
  }

  try {
    await sql.begin(async tx => {
      // Nothing else writes these tables for the seconds this takes.
      await tx`LOCK TABLE player, player_auth_email IN SHARE ROW EXCLUSIVE MODE`;

      for (const c of LIVE) {
        await tx`UPDATE ${sql(c.table)}
                    SET ${sql(c.column)} = pgp_sym_encrypt(pgp_sym_decrypt(${sql(c.column)}, ${OLD}), ${NEW})
                  WHERE ${sql(c.column)} IS NOT NULL`;
      }
      for (const a of archives) {
        await tx`UPDATE ${sql(a.table)} SET ${sql(a.column)} = NULL WHERE ${sql(a.column)} IS NOT NULL`;
      }

      for (const c of LIVE) {
        const k = `${c.table}.${c.column}`;
        const got = await decryptCount(tx, c, NEW);
        if (got !== before[k]) throw new Error(`${k}: ${got} decrypt under the new key, expected ${before[k]}`);
        console.log(`  ✓ ${k}: ${got} re-encrypted and verified under the new key`);
        // The old key must now RAISE. In a savepoint, so the expected error does not abort
        // the transaction around it.
        let oldStillReads = false;
        try {
          await tx.savepoint(async sp => { if (await decryptCount(sp, c, OLD) > 0) oldStillReads = true; });
        } catch (err) { /* the success case */ }
        if (oldStillReads) throw new Error(`${k}: the OLD key still decrypts it`);
        console.log(`  ✓ ${k}: the old key no longer decrypts it`);
      }
      for (const a of archives) {
        if (await storedCount(tx, a) !== 0) throw new Error(`${a.table}.${a.column} not cleared`);
      }
      console.log(`  ✓ archives cleared`);

      if (MODE === '--rehearse') throw ROLLBACK;
    });
  } catch (err) {
    if (err === ROLLBACK) {
      console.log('\nrehearsal complete — ROLLED BACK, nothing written.');
      return;
    }
    throw err;
  }
  console.log('\nCOMMITTED. Now update DB_ENCODE on Cloud Run (--update-env-vars, never --set-env-vars),');
  console.log('update .env, then run --verify.');
}

main()
  .catch(err => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => sql.end());
