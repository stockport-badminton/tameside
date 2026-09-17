// The liveness endpoint Cloud Run calls. See utils/dbHealth.js for the failure it
// exists to catch — a pool connection that stops answering without closing, which
// wedges the whole instance for the ~10-15 minutes TCP takes to notice.
//
// The probe query is stubbed through dbHealth's test seam, so this opens no
// connection: a test that authenticates against the real pooler with the placeholder
// PGPASSWORD is how the suite used to trip Supavisor's circuit breaker.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app } = require('../helpers/app');
const dbHealth = require('../../utils/dbHealth');

afterEach(() => dbHealth._setProbeQueryForTests(null));

describe('GET /healthz', () => {
  it('answers 200 when the pool answers', async () => {
    dbHealth._setProbeQueryForTests(async () => [{ ok: 1 }]);
    const res = await request(app).get('/healthz');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  it('answers 503 when the pool goes silent', async () => {
    dbHealth._setProbeQueryForTests(() => new Promise(() => {}));
    process.env.DB_HEALTH_TIMEOUT_MS = '100';
    const res = await request(app).get('/healthz');
    delete process.env.DB_HEALTH_TIMEOUT_MS;
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.reason, 'db-timeout');
  });

  // A cached 200 would keep a dead instance receiving traffic for the life of the
  // cache entry, which is the exact failure the probe is meant to end.
  it('is never cacheable', async () => {
    dbHealth._setProbeQueryForTests(async () => [{ ok: 1 }]);
    const res = await request(app).get('/healthz');
    assert.match(res.headers['cache-control'] || '', /no-store/);
  });

  // Registered ahead of the blocklist check and the session so a wedged instance can
  // still answer it, and so an anonymous probe never allocates a session row.
  it('sets no session cookie', async () => {
    dbHealth._setProbeQueryForTests(async () => [{ ok: 1 }]);
    const res = await request(app).get('/healthz');
    assert.ok(!(res.headers['set-cookie'] || []).some((c) => c.startsWith('__session')));
  });
});
