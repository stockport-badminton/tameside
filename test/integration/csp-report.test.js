// POST /csp-report (controllers/cspReportController.js), through the real router.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app } = require('../helpers/app');

let lines;
let realWarn;
beforeEach(() => {
  lines = [];
  realWarn = console.warn;
  console.warn = (s) => { lines.push(s); };
});
afterEach(() => { console.warn = realWarn; });

const logged = () => lines.map((l) => JSON.parse(l));

const legacy = (over = {}) => ({
  'csp-report': {
    'document-uri': 'https://tameside-badminton.co.uk/email-scorecard',
    'effective-directive': 'connect-src',
    'blocked-uri': 'https://badmintontemp.s3.eu-west-1.amazonaws.com/x',
    'source-file': 'https://tameside-badminton.co.uk/email-scorecard',
    disposition: 'report',
    ...over,
  },
});

describe('POST /csp-report', () => {
  test('report-uri format: 204 and one structured line', async () => {
    const res = await request(app).post('/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify(legacy()));
    assert.strictEqual(res.status, 204);
    const [entry] = logged();
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(entry.severity, 'WARNING');
    assert.match(entry.message, /^csp-report: connect-src https:\/\/badmintontemp/);
    assert.strictEqual(entry.csp.page, 'https://tameside-badminton.co.uk/email-scorecard');
    assert.strictEqual(entry.csp.disposition, 'report');
  });

  test('Reporting API format: only csp-violation entries are logged', async () => {
    const body = [
      { type: 'csp-violation', url: 'https://tameside-badminton.co.uk/event/1/x',
        body: { effectiveDirective: 'connect-src', blockedURL: 'https://places.googleapis.com/v1',
                documentURL: 'https://tameside-badminton.co.uk/event/1/x', disposition: 'report' } },
      { type: 'deprecation', url: 'https://tameside-badminton.co.uk/', body: { id: 'x' } },
    ];
    const res = await request(app).post('/csp-report')
      .set('Content-Type', 'application/reports+json')
      .send(JSON.stringify(body));
    assert.strictEqual(res.status, 204);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(logged()[0].csp.blocked, 'https://places.googleapis.com/v1');
  });

  test('browser-extension noise is dropped', async () => {
    for (const blocked of ['chrome-extension://abc/x.js', 'moz-extension://abc', 'webkit-masked-url://hidden/']) {
      await request(app).post('/csp-report').set('Content-Type', 'application/csp-report')
        .send(JSON.stringify(legacy({ 'blocked-uri': blocked })));
    }
    assert.strictEqual(lines.length, 0);
  });

  // The report is attacker-controllable text bound for a log.
  test('control characters cannot forge a log line, and fields are capped', async () => {
    await request(app).post('/csp-report').set('Content-Type', 'application/csp-report')
      .send(JSON.stringify(legacy({ 'blocked-uri': 'https://x.test/\n{"severity":"ERROR"}' + 'a'.repeat(1000) })));
    assert.strictEqual(lines.length, 1);
    assert.ok(!lines[0].includes('\n'));
    assert.ok(!logged()[0].csp.blocked.includes('\n'));
    assert.ok(logged()[0].csp.blocked.length <= 300);
  });

  test('a batch logs at most MAX_PER_REQUEST lines', async () => {
    const one = { type: 'csp-violation', url: 'u', body: { effectiveDirective: 'img-src', blockedURL: 'https://a.test' } };
    await request(app).post('/csp-report').set('Content-Type', 'application/reports+json')
      .send(JSON.stringify(Array(50).fill(one)));
    assert.strictEqual(lines.length, require('../../controllers/cspReportController').MAX_PER_REQUEST);
  });

  test('junk is a 204 and logs nothing', async () => {
    const res = await request(app).post('/csp-report').set('Content-Type', 'application/json')
      .send(JSON.stringify({ hello: 'world' }));
    assert.strictEqual(res.status, 204);
    assert.strictEqual(lines.length, 0);
  });
});
