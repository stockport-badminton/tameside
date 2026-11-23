// The case for swapping two players in a club's order (/admin/team-strength/compare): what
// the results say, beyond the rating, that a club or its players can check for themselves.
// Pure functions; teamStrengthController loads the games. Ported from Stockport (2cc3b7b)
// almost verbatim, so their fixes apply: our own games carry league OURS ('tameside'), and
// with no other league's games here the "other" sections simply never appear.
//
// The rating says who is stronger. The rating alone persuades nobody, so this lays out the
// raw results, most like-for-like first:
//
//   nights       the nights both played for the same team: the same opposition, the same hall
//   partners     the partners both have played with: the same help on their side of the net
//   headToHead   the games they played against each other
//   opponents    the players both have played against, opponent by opponent
//   seasons      each player's whole record, season by season: different opposition, so the
//                weakest evidence (the higher of the two in an order meets the stronger pairs)
//   other        their records in any other league fed to the rating (none here yet)
//
// Each section says which player it favours, on share of points (steadier than games won),
// and only with enough games on both sides. Every section is reported either way: a case
// that leaves out what argues against it does not survive the first reply.
// Level doubles only, as the order checks are; a game the two played together says nothing
// about which is better, so it is left out of every comparison.

const OURS = 'tameside'
const MIN_GAMES = 4
// Points share apart before a section takes a side: 2 points in 100 is roughly what 100
// rating points between two partners is worth, so anything smaller is noise.
const MARGIN = 0.02

/**
 * @typedef {{ league: string, fixture: number | null, date: string, season: string | null, mixed: boolean,
 *   home: { name: string | null, division: string | null, players: Array<number | string> },
 *   away: { name: string | null, division: string | null, players: Array<number | string> },
 *   hs: number, as: number }} CaseGame
 * @typedef {{ won: number, played: number, for: number, against: number }} Rec
 * @typedef {{ id: number, name: string }} Who
 * @typedef {'a' | 'b' | 'even' | 'thin'} Favours
 */

/** @returns {Rec} */
const rec = () => ({ won: 0, played: 0, for: 0, against: 0 })
/** @param {Rec} r */
const share = r => (r.for + r.against ? r.for / (r.for + r.against) : 0.5)
const pct = (/** @type {number} */ x) => `${Math.round(100 * x)}%`

// One player's side of a game: their partner, the two across the net, and the score.
/** @param {CaseGame} g @param {number | string} id */
function sideOf(g, id) {
  const home = g.home.players.includes(id)
  if (!home && !g.away.players.includes(id)) return null
  const us = home ? g.home : g.away, them = home ? g.away : g.home
  return { team: us.name, division: us.division, opponentTeam: them.name,
    partner: us.players.find(p => p !== id), opponents: them.players,
    for: home ? g.hs : g.as, against: home ? g.as : g.hs }
}

/** @param {Rec} r @param {{ for: number, against: number }} s */
function add(r, s) {
  r.played++; r.for += s.for; r.against += s.against
  if (s.for > s.against) r.won++
  return r
}

// Which way a comparison of two records points.
/** @param {number} sa @param {number} sb @param {boolean} enough @returns {Favours} */
function favours(sa, sb, enough) {
  if (!enough) return 'thin'
  if (sa - sb >= MARGIN) return 'a'
  if (sb - sa >= MARGIN) return 'b'
  return 'even'
}

// Shares averaged over groups (partners, opponents), each weighted by the fewer games either
// player had with it: forty games with one partner should not drown out four with another.
/** @param {Array<{ a: Rec, b: Rec }>} groups */
function weighted(groups) {
  let w = 0, sa = 0, sb = 0
  for (const g of groups) {
    const k = Math.min(g.a.played, g.b.played)
    w += k; sa += k * share(g.a); sb += k * share(g.b)
  }
  return { weight: w, a: w ? sa / w : 0.5, b: w ? sb / w : 0.5 }
}

const games = (/** @type {Rec} */ r) => `won ${r.won} of ${r.played} game${r.played === 1 ? '' : 's'} (${pct(share(r))} of points)`

/**
 * @param {Who} a @param {Who} b
 * @param {CaseGame[]} all both players' games, any league, oldest first
 * @param {(id: number | string) => string} nameOf
 */
function build(a, b, all, nameOf) {
  const level = all.filter(g => !g.mixed)
  const ours = level.filter(g => g.league === OURS)
  // Games with one of the two and not the other.
  const solo = ours.filter(g => {
    const ps = [...g.home.players, ...g.away.players]
    return ps.includes(a.id) !== ps.includes(b.id)
  })

  // Nights both played for the same team: the team each turned out for, fixture by fixture.
  /** @type {Map<number, { a?: string | null, b?: string | null }>} */ const teamOn = new Map()
  for (const g of ours) {
    const on = teamOn.get(/** @type {number} */ (g.fixture)) || {}
    const sa = sideOf(g, a.id), sb = sideOf(g, b.id)
    if (sa) on.a = sa.team
    if (sb) on.b = sb.team
    teamOn.set(/** @type {number} */ (g.fixture), on)
  }
  /** @type {Map<number, { fixture: number, date: string, team: string | null, opponent: string | null, a: Rec, b: Rec }>} */
  const byNight = new Map()
  const nightTotal = { a: rec(), b: rec() }
  for (const g of solo) {
    const on = /** @type {{ a?: string | null, b?: string | null }} */ (teamOn.get(/** @type {number} */ (g.fixture)))
    if (on.a === undefined || on.a !== on.b) continue
    const sa = sideOf(g, a.id), s = /** @type {NonNullable<typeof sa>} */ (sa || sideOf(g, b.id))
    const k = sa ? 'a' : 'b'
    if (!byNight.has(/** @type {number} */ (g.fixture))) byNight.set(/** @type {number} */ (g.fixture),
      { fixture: /** @type {number} */ (g.fixture), date: g.date, team: s.team, opponent: s.opponentTeam, a: rec(), b: rec() })
    add(/** @type {any} */ (byNight.get(/** @type {number} */ (g.fixture)))[k], s)
    add(nightTotal[k], s)
  }
  const nights = [...byNight.values()]

  // Shared partners and shared opponents.
  /** @type {Map<number | string, { a: Rec, b: Rec }>} */ const partner = new Map()
  /** @type {Map<number | string, { a: Rec, b: Rec }>} */ const opponent = new Map()
  const get = (/** @type {Map<number | string, { a: Rec, b: Rec }>} */ m, /** @type {number | string} */ k) => {
    if (!m.has(k)) m.set(k, { a: rec(), b: rec() })
    return /** @type {{ a: Rec, b: Rec }} */ (m.get(k))
  }
  for (const g of solo) {
    const sa = sideOf(g, a.id), sb = sideOf(g, b.id)
    const [k, s] = sa ? /** @type {const} */ (['a', sa]) : /** @type {const} */ (['b', /** @type {NonNullable<typeof sb>} */ (sb)])
    if (s.partner != null) add(get(partner, s.partner)[k], s)
    for (const o of s.opponents) if (o !== a.id && o !== b.id) add(get(opponent, o)[k], s)
  }
  const shared = (/** @type {Map<number | string, { a: Rec, b: Rec }>} */ m) => [...m]
    .filter(([, r]) => r.a.played && r.b.played)
    .map(([id, r]) => ({ id, name: nameOf(id), ...r }))
    .sort((x, y) => Math.min(y.a.played, y.b.played) - Math.min(x.a.played, x.b.played))
  const partners = shared(partner), opponents = shared(opponent)
  const partnerSum = weighted(partners), opponentSum = weighted(opponents)

  // Head to head, from a's side.
  const h2h = ours.filter(g => sideOf(g, a.id) && sideOf(g, b.id) && g.home.players.includes(a.id) !== g.home.players.includes(b.id))
  const h2hRec = h2h.reduce((r, g) => add(r, /** @type {NonNullable<ReturnType<typeof sideOf>>} */ (sideOf(g, a.id))), rec())

  // Whole records, season by season, and in the other leagues.
  /** @param {CaseGame[]} list @param {number} id */
  const recordOf = (list, id) => list.reduce((r, g) => { const s = sideOf(g, id); return s ? add(r, s) : r }, rec())
  const seasonNames = [...new Set(ours.map(g => /** @type {string} */ (g.season)))]
  const seasons = seasonNames.map(season => {
    const these = ours.filter(g => g.season === season)
    return { season, a: recordOf(these, a.id), b: recordOf(these, b.id) }
  }).reverse()
  const overall = { a: recordOf(ours, a.id), b: recordOf(ours, b.id) }
  const leagues = [...new Set(level.map(g => g.league))].filter(l => l !== OURS).map(league => {
    const these = level.filter(g => g.league === league)
    return { league, a: recordOf(these, a.id), b: recordOf(these, b.id) }
  }).filter(l => l.a.played || l.b.played)
  const mixed = { a: recordOf(all.filter(g => g.mixed && g.league === OURS), a.id),
    b: recordOf(all.filter(g => g.mixed && g.league === OURS), b.id) }

  const enough = (/** @type {Rec} */ x, /** @type {Rec} */ y) => x.played >= MIN_GAMES && y.played >= MIN_GAMES
  /** @type {Array<{ key: string, title: string, favours: Favours, text: string }>} */
  const findings = []
  const nightTeams = [...new Set(nights.map(n => n.team))].join(' and ')
  findings.push({ key: 'nights', title: 'Same nights, same team',
    favours: favours(share(nightTotal.a), share(nightTotal.b), enough(nightTotal.a, nightTotal.b)),
    text: nights.length
      ? `On the ${nights.length} night${nights.length === 1 ? '' : 's'} both played for ${nightTeams}, ${a.name} ${games(nightTotal.a)} and ${b.name} ${games(nightTotal.b)}, against the same opposition.`
      : `${a.name} and ${b.name} have not played for the same team on the same night.` })
  const top = partners.slice(0, 3).map(p => `with ${p.name}, ${a.name} won ${p.a.won} of ${p.a.played} and ${b.name} ${p.b.won} of ${p.b.played}`)
  findings.push({ key: 'partners', title: 'Same partners',
    favours: favours(partnerSum.a, partnerSum.b, partnerSum.weight >= MIN_GAMES),
    text: partners.length
      ? `With the ${partners.length} partner${partners.length === 1 ? '' : 's'} both have played alongside, ${a.name} won ${pct(partnerSum.a)} of points and ${b.name} ${pct(partnerSum.b)} (partner by partner): ${top.join('; ')}.`
      : 'They have no partner in common.' })
  findings.push({ key: 'headToHead', title: 'Head to head',
    favours: favours(share(h2hRec), 1 - share(h2hRec), h2hRec.played >= MIN_GAMES),
    text: h2hRec.played
      ? `Across the net from each other, ${a.name} ${games(h2hRec)}.`
      : 'They have not played against each other.' })
  findings.push({ key: 'opponents', title: 'Same opponents',
    favours: favours(opponentSum.a, opponentSum.b, opponentSum.weight >= MIN_GAMES),
    text: opponents.length
      ? `Against the ${opponents.length} player${opponents.length === 1 ? '' : 's'} both have faced, ${a.name} won ${pct(opponentSum.a)} of points and ${b.name} ${pct(opponentSum.b)} (opponent by opponent).`
      : 'They have no opponent in common.' })
  findings.push({ key: 'overall', title: 'Whole record',
    favours: favours(share(overall.a), share(overall.b), enough(overall.a, overall.b)),
    text: `Overall, ${a.name} ${games(overall.a)} and ${b.name} ${games(overall.b)}, against whoever they met: the player higher in an order meets stronger pairs.` })
  for (const l of leagues) {
    const label = l.league === 'stockport' ? 'Stockport' : l.league === 'mcrbl' ? 'Manchester' : l.league
    findings.push({ key: `other:${l.league}`, title: `${label} league`,
      favours: favours(share(l.a), share(l.b), enough(l.a, l.b)),
      text: `In the ${label} league, ${l.a.played ? `${a.name} ${games(l.a)}` : `${a.name} has no games`} and ${l.b.played ? `${b.name} ${games(l.b)}` : `${b.name} has none`}.` })
  }

  const h2hGames = h2h.map(g => {
    const s = /** @type {NonNullable<ReturnType<typeof sideOf>>} */ (sideOf(g, a.id))
    return { fixture: g.fixture, date: g.date, pair: [a.name, nameOf(/** @type {number} */ (s.partner))],
      against: s.opponents.map(nameOf), score: `${s.for}–${s.against}` }
  }).reverse()

  return { a, b, nights: nights.reverse(), nightTotal, partners, partnerSum, headToHead: { games: h2hGames, rec: h2hRec },
    opponents, opponentSum, seasons, overall, leagues, mixed, findings }
}

// The case as plain text, to paste into an email: what supports it, then what doesn't.
/**
 * @param {ReturnType<typeof build>} c
 * @param {{ window: string, rating?: { a: number | null, b: number | null, p: number | null } }} opts
 */
function caseText(c, { window, rating }) {
  const lines = [`${c.a.name} above ${c.b.name}: the results (${window}, level doubles)`, '']
  if (rating && rating.a != null && rating.b != null && rating.p != null) {
    lines.push(`Ratings: ${c.a.name} ${rating.a}, ${c.b.name} ${rating.b}; ${pct(rating.p)} likely ${c.a.name} is the stronger player.`, '')
  }
  const bullet = (/** @type {{ text: string }} */ f) => `- ${f.text}`
  const pro = c.findings.filter(f => f.favours === 'a'), con = c.findings.filter(f => f.favours === 'b')
  const even = c.findings.filter(f => f.favours === 'even'), thin = c.findings.filter(f => f.favours === 'thin')
  if (pro.length) lines.push('For:', ...pro.map(bullet), '')
  if (con.length) lines.push('Against:', ...con.map(bullet), '')
  if (even.length) lines.push('Level:', ...even.map(bullet), '')
  if (thin.length) lines.push(`Too few games to say: ${thin.map(f => f.title.toLowerCase()).join(', ')}.`)
  return lines.join('\n').trim()
}

module.exports = { build, caseText, sideOf, share, OURS, MIN_GAMES, MARGIN }
