// Filing a scorecard commits the draft BEFORE the results-secretary email goes out, so a
// Mailjet failure must not look like a failed submission. It used to render the 500 page,
// and a captain who filed again left a duplicate draft (Stockport f402d52, same bug).
// No DB: createScorecard is stubbed through the model seam.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const mailer = require('../../utils/mailer');

afterEach(() => { clearModels(); mock.restoreAll(); delete process.env.DEV_MODE; });

function validBody() {
  const body = {
    division: '8', date: '2026-08-01', homeTeam: '55', awayTeam: '56',
    homeMan1: '11', homeMan2: '12', homeMan3: '13', homeMan4: '14', homeLady1: '15', homeLady2: '16',
    awayMan1: '21', awayMan2: '22', awayMan3: '23', awayMan4: '24', awayLady1: '25', awayLady2: '26',
    FirstMixedhomeMan1: '11', SecondMixedhomeMan2: '12', ThirdMixedhomeMan3: '13', FourthMixedhomeMan4: '14',
    FirstMixedawayMan1: '21', SecondMixedawayMan2: '22', ThirdMixedawayMan3: '23', FourthMixedawayMan4: '24',
    FirstMixedhomeLady1: '15', SecondMixedhomeLady2: '16', ThirdMixedhomeLady1: '15', FourthMixedhomeLady2: '16',
    FirstMixedawayLady1: '25', SecondMixedawayLady2: '26', ThirdMixedawayLady1: '25', FourthMixedawayLady2: '26',
  };
  for (let g = 1; g <= 18; g++) { body[`Game${g}homeScore`] = '21'; body[`Game${g}awayScore`] = '15'; }
  return body;
}

describe('POST /email-scorecard when the notification email fails', () => {
  it('still thanks the captain, says not to resend, and saves exactly once', async () => {
    process.env.DEV_MODE = 'true';
    let creates = 0;
    setModel('Fixture', 'createScorecard', (obj, done) => { creates++; done(null, [{ id: 9999 }]); });
    setModel('Team', 'getById', (id, done) => done(null, [{ id, name: 'Team ' + id }]));
    mock.method(mailer.client, 'post', () => ({ request: () => Promise.reject(new Error('Mailjet is down')) }));

    const res = await request(app).post('/email-scorecard').type('form').send(validBody());
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    assert.match(res.text, /no need to send it again/);
    assert.strictEqual(creates, 1);
  });

  it('says the secretary was emailed when it worked', async () => {
    process.env.DEV_MODE = 'true';
    setModel('Fixture', 'createScorecard', (obj, done) => done(null, [{ id: 9999 }]));
    setModel('Team', 'getById', (id, done) => done(null, [{ id, name: 'Team ' + id }]));
    mock.method(mailer.client, 'post', () => ({ request: () => Promise.resolve({ body: {} }) }));

    const res = await request(app).post('/email-scorecard').type('form').send(validBody());
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Results Secretary has been emailed/);
  });
});
