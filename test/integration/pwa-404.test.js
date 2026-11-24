// The 404 page must not register the service worker (Stockport 7ce4dca, Nov 2026): a crawler
// opens each dead link in a fresh browser, and every one installed the worker and precached
// the shell pages again. Nor may it tear the worker down, as the dev branch of pwa-head does:
// a returning visitor who mistypes a URL keeps their offline copy.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app } = require('../helpers/app');

describe('service worker on the 404 page', () => {
  let saved;
  before(() => { saved = app.locals.serviceWorkerEnabled; app.locals.serviceWorkerEnabled = true; });
  after(() => { app.locals.serviceWorkerEnabled = saved; });

  it('a 404 neither registers nor unregisters it', async () => {
    const res = await request(app).get('/no-such-page-at-all');
    assert.strictEqual(res.status, 404);
    assert.doesNotMatch(res.text, /serviceWorker\.register/);
    assert.doesNotMatch(res.text, /unregister\(\)/);
    assert.match(res.text, /rel="manifest"/, 'the rest of pwa-head still renders');
  });

  it('an ordinary page still registers it', async () => {
    const res = await request(app).get('/privacy-policy');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /serviceWorker\.register\('\/sw\.js'/);
  });
});
