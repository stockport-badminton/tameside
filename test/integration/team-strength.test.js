// /admin/team-strength and its nightly run. Models are stubbed: what is asserted is the gate,
// that a refused run never reaches the model, and that a run stores what it built.
const { describe, it, afterEach, mock } = require('node:test')
const assert = require('node:assert')
const request = require('supertest')

const { app, clearModels } = require('../helpers/app')
const TeamStrength = require('../../models/teamStrength')
const League = require('../../models/league')

afterEach(() => { clearModels(); mock.restoreAll() })

function withEnv(vars, fn) {
  return async () => {
    const saved = {}
    for (const k of Object.keys(vars)) saved[k] = process.env[k]
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    try { await fn() } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  }
}
const asRole = (role, fn) => withEnv({ DEV_MODE: role ? 'true' : undefined, DEV_ROLE: role }, fn)
const TOKEN = 'the-real-token'

const day = d => new Date(d)
function stubModels() {
  const g = (id, fixture, date, [h1, h2, a1, a2], hs, as, gameType = 'FirstMens') => ({
    id, fixture, gameType, homePlayer1: h1, homePlayer2: h2, awayPlayer1: a1, awayPlayer2: a2, homeScore: hs, awayScore: as,
    date: day(date), homeTeam: 1, awayTeam: 2, season: '20242025', // the helper's current season
  })
  mock.method(TeamStrength, 'games', async () => [
    g(1, 10, '2026-10-01', [11, 12, 21, 22], 21, 15),
    g(2, 10, '2026-10-01', [11, 12, 21, 22], 21, 17),
    g(3, 10, '2026-10-01', [13, 14, 23, 24], 18, 21, 'SecondMens'),
    g(4, 10, '2026-10-01', [15, 16, 25, 0], 21, 0, 'FirstLadies'), // player 0: not counted
  ])
  mock.method(TeamStrength, 'registrations', async () => [11, 12, 13, 14, 21, 22, 23, 24].map(id => ({ season: '20262027', id, gender: 'Male', divRank: 1 }))
    .concat([15, 16, 25].map(id => ({ season: '20262027', id, gender: 'Female', divRank: 1 }))))
  mock.method(TeamStrength, 'squads', async () => ({
    teams: [
      { id: 1, name: 'Hyde A', clubId: 1, clubName: 'Hyde', divisionId: 8, divisionName: 'Division 1', divisionRank: 1 },
      { id: 2, name: 'Mellor A', clubId: 2, clubName: 'Mellor', divisionId: 8, divisionName: 'Division 1', divisionRank: 1 },
    ],
    players: [
      ...[11, 12, 13, 14].map((id, i) => ({ id, first_name: 'Home', family_name: `Man${i + 1}`, gender: 'Male', team: 1, club: 1, rank: i + 1 })),
      { id: 15, first_name: 'Home', family_name: 'Lady1', gender: 'Female', team: 1, club: 1, rank: 1 },
      { id: 16, first_name: 'Home', family_name: 'Lady2', gender: 'Female', team: 1, club: 1, rank: 99 },
      ...[21, 22, 23, 24].map((id, i) => ({ id, first_name: 'Away', family_name: `Man${i + 1}`, gender: 'Male', team: 2, club: 2, rank: i + 1 })),
      { id: 25, first_name: 'Away', family_name: 'Lady1', gender: 'Female', team: 2, club: 2, rank: 1 },
    ],
  }))
  mock.method(TeamStrength, 'remainingFixtures', async () => [
    { id: 30, homeTeam: 2, awayTeam: 1, date: day('2026-11-25'), dayLabel: 'Wed 25 Nov', thisWeek: true, overdue: false },
    { id: 31, homeTeam: 1, awayTeam: 2, date: day('2027-02-10'), dayLabel: 'Wed 10 Feb', thisWeek: false, overdue: false },
  ])
  mock.method(TeamStrength, 'pairGames', async () => [])
  mock.method(League, 'getRunIn', async () => [
    { division: 8, divisionName: 'Division 1', divisionRank: 1, id: 1, name: 'Hyde A', divRank: 1, played: 1, remaining: 2, gamesWon: 11, gamesLost: 7 },
    { division: 8, divisionName: 'Division 1', divisionRank: 1, id: 2, name: 'Mellor A', divRank: 1, played: 1, remaining: 2, gamesWon: 7, gamesLost: 11 },
  ])
  mock.method(League, 'movingPlaces', async () => 2)
  const saved = []
  mock.method(TeamStrength, 'save', async run => { saved.push(run); return 7 })
  mock.method(TeamStrength, 'latest', async () => (saved.length
    ? { id: 7, ran_at: new Date('2026-11-23T02:00:00Z'), season: '20262027', caller: saved[0].caller, games: saved[0].games, took_ms: 120, payload: JSON.parse(JSON.stringify(saved[0].payload)) }
    : null))
  return saved
}

describe('gating', () => {
  it('GET: login, then superadmin only', async () => {
    stubModels()
    await asRole(undefined, async () => assert.strictEqual((await request(app).get('/admin/team-strength')).status, 302))()
    for (const role of ['none', 'admin']) {
      await asRole(role, async () => assert.strictEqual((await request(app).get('/admin/team-strength')).status, 403, role))()
    }
  })

  it('the run 404s without the token, and never reaches the model', withEnv({ STRENGTH_RUN_TOKEN: TOKEN, DEV_MODE: undefined }, async () => {
    const saved = stubModels()
    for (const url of ['/admin/team-strength/run', '/admin/team-strength/run?t=guess']) {
      assert.strictEqual((await request(app).post(url)).status, 404, url)
    }
    assert.strictEqual(TeamStrength.games.mock.callCount(), 0)
    assert.strictEqual(saved.length, 0)
  }))

  it('an UNSET token closes the run rather than opening it', withEnv({ STRENGTH_RUN_TOKEN: undefined, DEV_MODE: undefined }, async () => {
    const saved = stubModels()
    assert.strictEqual((await request(app).post('/admin/team-strength/run?t=')).status, 404)
    assert.strictEqual(saved.length, 0)
  }))

  it('a club admin cannot run it', asRole('admin', async () => {
    const saved = stubModels()
    assert.strictEqual((await request(app).post('/admin/team-strength/run')).status, 404)
    assert.strictEqual(saved.length, 0)
  }))
})

describe('the run', () => {
  it('the scheduler\'s run stores one row and answers JSON', withEnv({ STRENGTH_RUN_TOKEN: TOKEN, DEV_MODE: undefined }, async () => {
    const saved = stubModels()
    const res = await request(app).post(`/admin/team-strength/run?t=${TOKEN}`)
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual({ ok: res.body.ok, runId: res.body.runId, games: res.body.games, week: res.body.week }, { ok: true, runId: 7, games: 3, week: 1 })
    assert.strictEqual(saved.length, 1)
    assert.strictEqual(saved[0].caller, 'scheduler')
    const hyde = saved[0].payload.teams.find(t => t.name === 'Hyde A')
    assert.deepStrictEqual(hyde.usual.men.slice().sort(), [11, 12, 13, 14])
    assert.strictEqual(hyde.usual.ladies.length, 2)
    // Player 0's game was not fitted: the away lady has no rating.
    const mellor = saved[0].payload.teams.find(t => t.name === 'Mellor A')
    assert.strictEqual(mellor.ladies[0].r, null)
    // The week, the projection and the public block.
    const p = saved[0].payload
    assert.deepStrictEqual(p.week.map(f => [f.id, f.home, f.away]), [[30, 'Mellor A', 'Hyde A']])
    assert.strictEqual(p.week[0].rubbers.length, 9)
    assert.strictEqual(p.projection[0].teams.length, 2)
    assert.deepStrictEqual(Object.keys(p.public.fixtures).sort(), ['30', '31'])
    assert.deepStrictEqual(Object.keys(p.public.teams).sort(), ['1', '2'])
  }))

  it('the public block names nobody and carries no player id', withEnv({ STRENGTH_RUN_TOKEN: TOKEN, DEV_MODE: undefined }, async () => {
    const saved = stubModels()
    await request(app).post(`/admin/team-strength/run?t=${TOKEN}`)
    const block = JSON.stringify(saved[0].payload.public)
    assert.doesNotMatch(block, /(Home|Away) (Man|Lady)/)
    for (const id of [11, 12, 13, 14, 15, 16, 21, 22, 23, 24, 25]) assert.doesNotMatch(block, new RegExp(`[^\\d.]${id}[^\\d.]`))
  }))

  it('a card position comes from the side the player was on (Open C: home 1+2, away 3+4)', withEnv({ STRENGTH_RUN_TOKEN: TOKEN, DEV_MODE: undefined }, async () => {
    const saved = stubModels()
    await request(app).post(`/admin/team-strength/run?t=${TOKEN}`)
    const men = saved[0].payload.teams.find(t => t.name === 'Mellor A').men
    // Away 21/22 played Open A (1, 2); away 23/24 played Open B (3, 4).
    assert.deepStrictEqual(men.map(p => [p.id, p.pos]), [[21, 1], [22, 2], [23, 3], [24, 4]])
  }))

  it('a superadmin\'s run redirects to the page, which shows it', asRole('superadmin', async () => {
    stubModels()
    const res = await request(app).post('/admin/team-strength/run')
    assert.strictEqual(res.status, 303)
    assert.strictEqual(res.headers.location, '/admin/team-strength')
    const page = await request(app).get('/admin/team-strength')
    assert.strictEqual(page.status, 200)
    assert.match(page.text, /Home Man1/)
    assert.match(page.text, /This week \(1\)/)
    assert.match(page.text, /data-division="Division 1"/)
    assert.match(page.text, /Open C/)
    assert.match(page.text, /23 Nov 2026, 02:00/)
    assert.doesNotMatch(page.text, /undefined|NaN/)
  }))

  it('the page before any run says so', asRole('superadmin', async () => {
    stubModels()
    const page = await request(app).get('/admin/team-strength')
    assert.strictEqual(page.status, 200)
    assert.match(page.text, /No run yet/)
  }))
})

describe('make the case', () => {
  it('superadmin only', async () => {
    stubModels()
    await asRole(undefined, async () => assert.strictEqual((await request(app).get('/admin/team-strength/compare?a=11&b=12')).status, 302))()
    for (const role of ['none', 'admin']) {
      await asRole(role, async () => assert.strictEqual((await request(app).get('/admin/team-strength/compare?a=11&b=12')).status, 403, role))()
    }
    assert.strictEqual(TeamStrength.pairGames.mock.callCount(), 0)
  })

  it('refuses a man against a lady, and reads no games', asRole('superadmin', async () => {
    stubModels()
    const res = await request(app).get('/admin/team-strength/compare?a=11&b=15')
    assert.strictEqual(res.status, 200)
    assert.match(res.text, /two men or two ladies/)
    assert.strictEqual(TeamStrength.pairGames.mock.callCount(), 0)
  }))

  it('lays out the results for two men, for and against', asRole('superadmin', async () => {
    stubModels()
    const g = (id, fixture, h, a, hs, as) => ({ id, fixture, gameType: 'FirstMens', homePlayer1: h[0], homePlayer2: h[1], awayPlayer1: a[0], awayPlayer2: a[1],
      homeScore: hs, awayScore: as, date: day('2026-10-01'), season: '20242025', homeTeamName: 'Hyde A', awayTeamName: 'Mellor A' })
    TeamStrength.pairGames.mock.mockImplementation(async () => [
      g(1, 10, [11, 13], [21, 22], 21, 10), g(2, 10, [12, 14], [21, 22], 15, 21),
      g(3, 11, [11, 0], [21, 22], 21, 0), // player 0: left out
    ])
    const res = await request(app).get('/admin/team-strength/compare?a=11&b=12')
    assert.strictEqual(res.status, 200)
    assert.match(res.text, /Home Man1 above Home Man2/)
    assert.match(res.text, /data-finding="nights"/)
    assert.doesNotMatch(res.text, /#0\b|undefined|NaN/)
  }))
})
