// Publishing a result (POST /scorecard-beta → full_fixture_post) sends the push
// notifications for it, waits for them before rendering (Cloud Run throttles the CPU once a
// response is sent), says on the confirmation page what happened, and is never failed by
// them. Every model the handler touches is stubbed; nothing reaches the DB, Mailjet or Meta.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const mailer = require('../../utils/mailer');
const push = require('../../utils/push');
const Game = require('../../models/game');
const eloChain = require('../../utils/eloChain');

afterEach(() => { clearModels(); mock.restoreAll(); delete process.env.DEV_MODE; delete process.env.DEV_ROLE; });

function validBody() {
  const body = {
    division: '8', date: '2026-11-25', homeTeam: '55', awayTeam: '56', homeScore: '18', awayScore: '0',
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

function stubPublish() {
  process.env.DEV_MODE = 'true';
  process.env.DEV_ROLE = 'superadmin';
  mock.method(console, 'log', () => {});
  setModel('Fixture', 'getOutstandingFixtureId', (q, done) => done(null, [{ id: 304, lewis_round: null, rank: 1, name: 'Division 1' }]));
  setModel('Player', 'getPrevRating', async () => ({ rating: 1500, date: '2026-11-01' }));
  setModel('Fixture', 'updateById', (obj, id, done) => done(null, {}));
  mock.method(Game, 'createBatch', (obj, done) => done(null, {}));
  mock.method(Game, 'calculateRating', () => ({ updateObj: {} }));
  mock.method(eloChain, 'rerateFrom', async () => {});
  setModel('Player', 'refreshRatings', async () => {});
  setModel('Fixture', 'getFixtureDetailsById', (id, done) => done(null, [{ homeTeam: 'Hyde B', awayTeam: 'Shell A', homeScore: 18, awayScore: 0 }]));
  setModel('Fixture', 'sendResultZap', (z, done) => done(null, { sent: false }));
  setModel('Player', 'getNominatedPlayers', (team, done) => done(null, []));
  setModel('Fixture', 'getMatchPlayerOrderDetails', (q, done) => done(null, []));
  setModel('Player', 'getMatchStats', (id, done) => done(null, []));
  setModel('Division', 'getAllByLeague', (league, done) => done(null, []));
  mock.method(mailer.client, 'post', () => ({ request: () => Promise.resolve({ body: {} }) }));
}

describe('publishing a result sends its push notifications', () => {
  it('notifies the fixture\'s followers and says how many devices were reached', async () => {
    stubPublish();
    const notify = mock.method(push, 'notifyResult', async () => ({ subscribers: 3, sent: 3, failed: 0, removed: 0 }));
    const res = await request(app).post('/scorecard-beta').type('form').send(validBody());
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    assert.deepStrictEqual(notify.mock.calls.map(c => c.arguments), [[304]]);
    assert.match(res.text, /data-role="push-note">Push notification sent to 3 of 3 devices\.</);
  });

  it('a push failure never fails the publish, and the page says so', async () => {
    stubPublish();
    mock.method(console, 'error', () => {});
    mock.method(push, 'notifyResult', async () => { throw new Error('push service down'); });
    const res = await request(app).post('/scorecard-beta').type('form').send(validBody());
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    assert.match(res.text, /Push notifications could not be sent/);
  });
});
