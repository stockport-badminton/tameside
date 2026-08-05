const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Requiring db_connect does not open a connection — postgres.js connects lazily on the
// first query — so this file is safe to run alongside the rest of the suite.
const { POOL_MAX, IDLE_TIMEOUT } = require('../utils/db_connect');
const spamControls = require('../models/spamControls');

const cloudbuild = fs.readFileSync(
  path.join(__dirname, '..', 'cloudbuild.yaml'),
  'utf8'
);

test('db pool ceilings', async (t) => {
  await t.test('idle_timeout stays above the blocklist refresh interval', () => {
    const refreshSeconds = spamControls.CACHE_TTL_MS / 1000;
    assert.ok(
      IDLE_TIMEOUT > refreshSeconds,
      `idle_timeout (${IDLE_TIMEOUT}s) must exceed the blocklist refresh interval ` +
      `(${refreshSeconds}s). Below it, the refresh timer's connection is closed ` +
      `between ticks and every tick opens a new one — 1,800 opens/day when this ` +
      `regressed on 2026-08-05.`
    );
  });

  await t.test('pool max x max-instances stays within the 60-backend ceiling', () => {
    const match = cloudbuild.match(/_MAX_INSTANCES:\s*'(\d+)'/);
    assert.ok(match, 'cloudbuild.yaml must declare _MAX_INSTANCES');

    const maxInstances = Number(match[1]);
    const worstCase = POOL_MAX * maxInstances;
    assert.ok(
      worstCase <= 60,
      `pool max (${POOL_MAX}) x max-instances (${maxInstances}) = ${worstCase} ` +
      `clients, above the 60 backends Postgres allows. Raising either without the ` +
      `other is how Stockport hit EMAXCONNSESSION (Sentry NODE-V, 28 July).`
    );
  });

  await t.test('cloudbuild actually passes the declared cap to Cloud Run', () => {
    assert.match(
      cloudbuild,
      /--max-instances=/,
      'the Deploy step must pass --max-instances, or the cap lives only in console ' +
      'state and is not reviewable in git'
    );
  });
});
