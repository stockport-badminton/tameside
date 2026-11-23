// Lewis Shield handicaps (controllers/lewisHandicapController.js): only the Lewis secretary
// or a superadmin sets them, and a tie's officers see one only once it is released (21:30
// on the night, decided by the model's `released`). Asserts what reached the model and what
// reached the page, not only the status: an unreleased figure must not be in the HTML at all.
const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert')
const request = require('supertest')

const { app, setModel, clearModels } = require('../helpers/app')

afterEach(() => clearModels())

function asUser(env, fn) {
  return async () => {
    const keys = ['DEV_MODE', 'DEV_ROLE', 'DEV_CLUB', 'DEV_PLAYER']
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
    for (const k of keys) delete process.env[k]
    Object.assign(process.env, env)
    try { await fn() } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    }
  }
}

const STRANGER = {}
const UNLINKED = { DEV_MODE: 'true', DEV_ROLE: 'none' }
const MEMBER = { DEV_MODE: 'true', DEV_ROLE: 'none', DEV_CLUB: 'Hyde', DEV_PLAYER: '41' }
const SECRETARY = { DEV_MODE: 'true', DEV_ROLE: 'none', DEV_CLUB: 'Hyde', DEV_PLAYER: '77' }
const SUPERADMIN = { DEV_MODE: 'true', DEV_ROLE: 'superadmin' }

const tie = (over = {}) => ({
  id: 6032, ymd: '2027-01-07', dayLabel: 'Thu 7 Jan 2027', status: 'outstanding', round: 2,
  home: { id: 12, name: 'College Green A', club: 'College Green', captain: 41 },
  away: { id: 30, name: 'Shell A', club: 'Shell', captain: 50 },
  homeScore: null, awayScore: null, revealAt: new Date(), released: false, handicap: null, ...over,
})

function stub({ secretary = 77, ties = [tie()] } = {}) {
  const writes = []
  setModel('LewisHandicap', 'secretaryId', async () => secretary)
  setModel('LewisHandicap', 'playerName', async () => 'Lew Secretary')
  setModel('LewisHandicap', 'all', async () => ties)
  setModel('LewisHandicap', 'byId', async id => ties.find(t => t.id === id) || null)
  setModel('LewisHandicap', 'set', async (...args) => { writes.push(['set', ...args]) })
  setModel('LewisHandicap', 'clear', async (...args) => { writes.push(['clear', ...args]) })
  setModel('TeamStrength', 'latest', async () => null)
  return writes
}

describe('the secretary pages', () => {
  for (const path of ['/lewis-shield/handicaps', '/lewis-shield/handicaps/6032/squads', '/lewis-shield/handicap']) {
    it(`a stranger is sent to log in from ${path}`, asUser(STRANGER, async () => {
      stub()
      const res = await request(app).get(path)
      assert.strictEqual(res.status, 302)
      assert.match(res.headers.location, /\/login/)
    }))
  }

  for (const [who, env] of [['an unlinked login', UNLINKED], ['a member who is not the secretary', MEMBER]]) {
    it(`${who} cannot see the list or the calculator`, asUser(env, async () => {
      stub()
      assert.strictEqual((await request(app).get('/lewis-shield/handicaps')).status, 403)
      assert.strictEqual((await request(app).get('/lewis-shield/handicaps/6032/squads')).status, 403)
    }))

    it(`${who} cannot set a handicap, and nothing is written`, asUser(env, async () => {
      const writes = stub()
      const res = await request(app).post('/lewis-shield/handicaps/6032').type('form').send({ to: 'away', points: '50' })
      assert.strictEqual(res.status, 403)
      assert.deepStrictEqual(writes, [])
    }))
  }

  it('with no secretary set, a member is still refused', asUser(MEMBER, async () => {
    stub({ secretary: null })
    assert.strictEqual((await request(app).get('/lewis-shield/handicaps')).status, 403)
  }))

  for (const [who, env] of [['the Lewis secretary', SECRETARY], ['a superadmin', SUPERADMIN]]) {
    it(`${who} sees every tie`, asUser(env, async () => {
      stub()
      const res = await request(app).get('/lewis-shield/handicaps')
      assert.strictEqual(res.status, 200)
      assert.match(res.text, /College Green A/)
      assert.match(res.headers['cache-control'], /no-store/)
    }))
  }

  it('the secretary sets points to the named side, by team id', asUser(SECRETARY, async () => {
    const writes = stub()
    const res = await request(app).post('/lewis-shield/handicaps/6032').type('form').send({ to: 'away', points: '70' })
    assert.strictEqual(res.status, 303)
    assert.deepStrictEqual(writes, [['set', 6032, 30, 70, 'dev@local.test']])
  }))

  it('scratch and clear', asUser(SECRETARY, async () => {
    const writes = stub()
    await request(app).post('/lewis-shield/handicaps/6032').type('form').send({ to: 'scratch', points: '40' })
    await request(app).post('/lewis-shield/handicaps/6032').type('form').send({ to: 'home', points: '0' })
    await request(app).post('/lewis-shield/handicaps/6032').type('form').send({ to: 'clear' })
    assert.deepStrictEqual(writes, [['set', 6032, null, 0, 'dev@local.test'], ['set', 6032, null, 0, 'dev@local.test'], ['clear', 6032]])
  }))

  for (const body of [{ to: 'away', points: '-5' }, { to: 'away', points: '12.5' }, { to: 'away', points: '401' }, { to: 'neither', points: '5' }]) {
    it(`refuses ${JSON.stringify(body)}`, asUser(SECRETARY, async () => {
      const writes = stub()
      const res = await request(app).post('/lewis-shield/handicaps/6032').type('form').send(body)
      assert.strictEqual(res.status, 400)
      assert.deepStrictEqual(writes, [])
    }))
  }

  it('a tie not in this season is a 404', asUser(SECRETARY, async () => {
    const writes = stub()
    const res = await request(app).post('/lewis-shield/handicaps/999').type('form').send({ to: 'away', points: '5' })
    assert.strictEqual(res.status, 404)
    assert.deepStrictEqual(writes, [])
  }))
})

describe("a captain's view", () => {
  const released = tie({ id: 1, released: true, handicap: { points: 137, toTeam: 30, to: 'away' } })
  const tonight = tie({ id: 2, home: { ...tie().home, name: 'Hyde B' }, released: false, handicap: { points: 263, toTeam: 12, to: 'home' } })
  const unset = tie({ id: 3, home: { ...tie().home, name: 'Mellor A' }, released: true, handicap: null })

  it('shows a released handicap, and not one before its time', asUser(MEMBER, async () => {
    stub()
    let askedFor = null
    setModel('LewisHandicap', 'forOfficer', async id => { askedFor = id; return [released, tonight, unset] })
    const res = await request(app).get('/lewis-shield/handicap')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(askedFor, 41)
    assert.match(res.text, /Shell A<\/strong> receive <strong>137<\/strong> points/)
    assert.doesNotMatch(res.text, /263/)
    assert.match(res.text, /Available from 21:30 on Thu 7 Jan 2027/)
    assert.match(res.text, /No handicap has been set/)
    assert.match(res.headers['cache-control'], /no-store/)
  }))

  it('an unlinked login is told why it sees nothing, and nothing is looked up', asUser(UNLINKED, async () => {
    stub()
    let asked = false
    setModel('LewisHandicap', 'forOfficer', async () => { asked = true; return [released] })
    const res = await request(app).get('/lewis-shield/handicap')
    // An unlinked login stops at the member gate (views/not-linked.ejs).
    assert.strictEqual(res.status, 403)
    assert.strictEqual(asked, false)
  }))

  it('is not taken for a season by /lewis-shield/:season', asUser(MEMBER, async () => {
    stub()
    setModel('LewisHandicap', 'forOfficer', async () => [])
    const res = await request(app).get('/lewis-shield/handicap')
    assert.strictEqual(res.status, 200)
    assert.match(res.text, /aren't down as a captain/)
  }))
})
