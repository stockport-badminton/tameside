// `[timing]` lines for each step a request waits on after its write has succeeded.
//
// Publishing a result waits, inside the request, on every Meta target in turn (up to
// four: Page, Instagram feed, Instagram story, Page story) and then the results email —
// against Firebase Hosting's 60s cut. Stockport measured 16-51s for the same flow
// (league-site HARD-47, e3ffe09), and the request log can only give the total. These lines
// say where the time goes. Grep Cloud Logging for `[timing]`.

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// The Mailjet client throws at require time without keys; nothing here reaches it.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
for (const [k, v] of Object.entries({
  MAILJET_KEY: 'test-key', MAILJET_SECRET: 'test-secret', DB_ENCODE: 'test-encode',
  PGPASSWORD: 'test-placeholder',
})) if (!process.env[k]) process.env[k] = v;

const meta = require('../utils/metaPublisher');
const mailer = require('../utils/mailer');
const Fixture = require('../models/fixture');

const TIMING = /^\[timing\] (\S+): (.+) (\d+)ms (ok|failed)$/;

function captureLogs() {
  const lines = [];
  mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  return lines;
}

function timings(lines) {
  return lines.map((l) => l.match(TIMING)).filter(Boolean)
    .map(([, stage, label, , outcome]) => `${stage}: ${label} ${outcome}`);
}

const ENV_KEYS = ['META_TAMESIDE_PAGE_ID', 'META_TAMESIDE_PAGE_TOKEN', 'META_IG_USER_ID',
  'META_GRAPH_ORIGIN', 'SOCIAL_POST_DIRECT', 'SOCIAL_POST_STORY', 'SOCIAL_POST_FB_STORY'];
let saved;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  mock.restoreAll();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('Meta targets', () => {
  // Facebook accepts, Instagram refuses: one line each, with the right outcome.
  let server;
  before(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/media')) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'refused', code: 1 } }));
      }
      res.end(JSON.stringify({ id: 'fake-id' }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  });
  after(() => server.close());

  it('logs one line per target, ok or failed', async () => {
    process.env.META_GRAPH_ORIGIN = `http://127.0.0.1:${server.address().port}`;
    const lines = captureLogs();
    await meta.publishEverywhere(
      [{ name: 'Tameside page', kind: 'page', id: '1', token: 't' },
       { name: 'Instagram', kind: 'instagram', id: '2', token: 't' }],
      { imageUrls: ['https://tameside-badminton.co.uk/x.jpg'], message: 'm' });

    assert.deepStrictEqual(timings(lines), ['meta: Tameside page ok', 'meta: Instagram failed']);
  });
});

describe('the result announcement', () => {
  it('logs its total, including when it fails', async () => {
    // Direct posting with no credentials throws before any network call — the
    // misconfiguration sendResultZap must report rather than swallow.
    process.env.SOCIAL_POST_DIRECT = 'true';
    const lines = captureLogs();
    const result = await new Promise((resolve) => Fixture.sendResultZap(
      { homeTeam: 'Hyde A', awayTeam: 'Shell A', homeScore: 13, awayScore: 5, division: 'Division 1' },
      (err, r) => resolve(r)));

    assert.strictEqual(result.sent, false);
    assert.deepStrictEqual(timings(lines), ['publish: result-announcement failed']);
  });

  it('logs nothing when there was nothing to announce', async () => {
    const lines = captureLogs();
    await new Promise((resolve) => Fixture.sendResultZap({}, resolve));
    assert.deepStrictEqual(timings(lines), []);
  });
});

describe('email', () => {
  it('logs the Mailjet call by template', async () => {
    mock.method(mailer.client, 'post', () => ({ request: () => Promise.resolve({ body: {} }) }));
    const lines = captureLogs();
    await mailer.send({ template: 'website-updated', subject: 's', text: 't', to: 'a@example.com',
      data: { homeTeamName: 'Hyde A', awayTeamName: 'Shell A', homeScore: 13, awayScore: 5,
        divisionName: 'Division 1', matchStats: [], imageUrl: 'https://x/y.jpg', resultUrl: 'https://x' } });
    assert.deepStrictEqual(timings(lines), ['mail: website-updated ok']);
  });

  it('still logs, as failed, when Mailjet refuses — and still throws', async () => {
    mock.method(mailer.client, 'post', () => ({ request: () => Promise.reject(new Error('mailjet down')) }));
    const lines = captureLogs();
    await assert.rejects(mailer.send({ template: 'website-updated', subject: 's', text: 't', to: 'a@example.com',
      data: { homeTeamName: 'Hyde A', awayTeamName: 'Shell A', homeScore: 13, awayScore: 5,
        divisionName: 'Division 1', matchStats: [], imageUrl: 'https://x/y.jpg', resultUrl: 'https://x' } }),
      /mailjet down/);
    assert.deepStrictEqual(timings(lines), ['mail: website-updated failed']);
  });
});
