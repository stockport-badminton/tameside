// The words on a public event page (/event/:id): a match preview before the result is in,
// a short report after. Pure: the controller gathers the inputs, this writes the copy.
//
// Ported from Stockport (6801d52) as backlog row 4, reworked for our card: a fixture is 8
// men's, 2 ladies' and 8 mixed games (theirs is six of each), dates are formatted by hand
// in UK time (utils/ukDate.js), and a Lewis Shield tie is described as a cup tie, with no
// table places and no forecast (the rating does not model the handicap).
//
// Two rules hold everywhere in here:
//
// - **No player is ever named.** The page is public and indexable, and the people in these
//   teams are volunteers playing an amateur league. The forecast it reads
//   (TeamStrength.forecastFor) carries no names by construction; the copy talks about "their
//   usual line-up", "the men's doubles" and "current form", never about a person.
// - **Every claim comes from a number passed in.** Nothing is said for colour that the data
//   does not support, and a section with nothing to go on is left out rather than padded.
//
// Phrasing varies between fixtures (chosen from the fixture id, so a page reads the same on
// every visit) because a hundred pages saying exactly the same sentence about different teams
// reads as boilerplate to a person and to a search engine alike.

/**
 * @typedef {{ id: number, date: Date | string, homeTeam: number, awayTeam: number,
 *   homeScore: number, awayScore: number, homeName?: string, awayName?: string }} Played
 * @typedef {{ gameType: string | null, homeScore: number, awayScore: number }} Game
 * @typedef {{ pHome: number, pDraw: number, pAway: number, expected: number,
 *   likely: { home: number, away: number }, edges: { mens: number, ladies: number, mixed: number } }} Forecast
 * @typedef {{ teams: number, men: number, ladies: number, overall: number, fixtures: number,
 *   settled: number | null, last: number | null,
 *   projection: { teams: number, expected: number, pWinner: number, pUp: number, pDown: number } | null }} Profile
 * @typedef {{ id: number, gamesWon: number, gamesLost: number, played: number }} Standing
 * @typedef {{ id: number, date: Date | string, homeTeam: string, awayTeam: string,
 *   homeTeamId: number, awayTeamId: number, divisionName?: string | null, status?: string | null,
 *   homeScore?: number | null, awayScore?: number | null }} Fixture
 */

// A small deterministic hash, so `pick` chooses the same phrasing for a fixture every time.
/** @param {string} s */
function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** @param {number} seed @returns {<T>(salt: string, options: T[]) => T} */
const picker = seed => (salt, options) => options[hash(`${seed}:${salt}`) % options.length]

// A side is four men and two ladies: six, as Stockport's three and three is.
const SIDE_SIZE = 6

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const word = (/** @type {number} */ n) => WORDS[n] ?? String(n)
const cap = (/** @type {string} */ s) => s.charAt(0).toUpperCase() + s.slice(1)

/** @param {number} n */
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

const { longDate, shortDate } = require('./ukDate')
const { CATEGORY_GAMES } = require('./teamStrength')

/** @param {number} p 0..1 */
const pct = p => `${Math.round(100 * p)}%`

// "Division 2" reads as it is; "Premier" needs to be "the Premier division".
/** @param {string | null | undefined} name */
const divisionPhrase = name => (!name ? null : /division/i.test(name) ? name : `the ${name} division`)

// ---------------------------------------------------------------------------
// Form

/**
 * One team's results before this fixture, newest first, from its own point of view.
 * @param {number} teamId @param {Played[]} form
 */
function teamForm(teamId, form) {
  return form.filter(f => f.homeTeam === teamId || f.awayTeam === teamId).map(f => {
    const home = f.homeTeam === teamId
    const won = home ? f.homeScore : f.awayScore, lost = home ? f.awayScore : f.homeScore
    return {
      id: f.id, date: f.date, home, won, lost,
      opponent: (home ? f.awayName : f.homeName) || null,
      result: /** @type {'W' | 'D' | 'L'} */ (won > lost ? 'W' : won < lost ? 'L' : 'D'),
    }
  })
}

/** @typedef {ReturnType<typeof teamForm>} Form */

// A sentence about a team's run, or null before it has played. `name` starts the sentence.
/** @param {string} name @param {Form} form @param {ReturnType<typeof picker>} pick */
function formSentence(name, form, pick) {
  if (!form.length) return null
  const recent = form.slice(0, 5)
  const wins = recent.filter(r => r.result === 'W').length
  const losses = recent.filter(r => r.result === 'L').length
  let streak = 1
  while (streak < form.length && form[streak].result === form[0].result) streak++
  const avg = form.reduce((a, r) => a + r.won, 0) / form.length
  const avgText = `averaging ${avg.toFixed(1)} games a match`

  if (form.length === 1) {
    const r = form[0]
    const how = r.result === 'W' ? `won their opening match ${r.won}–${r.lost}`
      : r.result === 'L' ? `lost their opening match ${r.won}–${r.lost}` : `drew their opening match ${r.won}–${r.lost}`
    return `${name} ${how}.`
  }
  if (form[0].result === 'W' && streak >= 3) {
    return pick('streakW', [
      `${name} arrive on a run of ${word(streak)} straight wins, ${avgText} so far this season.`,
      `${name} are in good form, with ${word(streak)} wins in a row and ${avgText}.`,
    ])
  }
  if (form[0].result === 'L' && streak >= 3) {
    return pick('streakL', [
      `${name} will be looking to turn things round after ${word(streak)} defeats in a row.`,
      `It has been a tough spell for ${name}, with ${word(streak)} straight defeats, though they are still ${avgText}.`,
    ])
  }
  if (!losses) {
    return pick('unbeaten', [
      `${name} are unbeaten in their last ${word(recent.length)}, ${avgText}.`,
      `${name} have yet to lose in their last ${word(recent.length)} matches.`,
    ])
  }
  const record = `${word(wins)} of their last ${word(recent.length)}`
  if (!wins) {
    const draws = recent.length - losses
    return `${name} have not won in their last ${word(recent.length)}${draws ? `, drawing ${word(draws)}` : ''}, and will be looking to change that.`
  }
  if (wins > losses) return pick('good', [`${name} have won ${record}, ${avgText}.`, `${cap(record)} have gone the way of ${name}, who are ${avgText}.`])
  if (wins < losses) return pick('poor', [`${name} have won ${record}, ${avgText}.`, `${name} have found wins harder to come by, taking ${record}.`])
  return `${name} have had a mixed run, winning ${record} and ${avgText}.`
}

// ---------------------------------------------------------------------------
// The squad

/** @param {string} name @param {Profile | null | undefined} p @param {ReturnType<typeof picker>} pick */
function squadSentence(name, p, pick) {
  if (!p || !p.teams) return null
  const parts = []
  const third = Math.max(1, Math.round(p.teams / 3))
  if (p.overall === 1) parts.push(pick('top', [`on paper ${name} have the strongest squad in the division`, `${name} look the strongest squad in the division on paper`]))
  else if (p.overall <= third) parts.push(`${name} have one of the stronger squads in the division`)
  else if (p.overall > p.teams - third) parts.push(`on paper ${name} are one of the lighter squads in the division`)
  else parts.push(`${name} sit mid-pack on squad strength`)

  const gap = p.men - p.ladies
  if (gap <= -Math.max(2, third)) parts.push('with their strength in the men’s games')
  else if (gap >= Math.max(2, third)) parts.push('with their strength in the ladies’ games')

  let sentence = cap(parts.join(', ')) + '.'
  if (p.fixtures > 0 && p.settled != null) {
    if (p.settled >= 0.8) sentence += ' ' + pick('settled', ['They have fielded a settled side, with their usual line-up turning out in most matches.', 'Their regular line-up has been a fixture this season.'])
    else if (p.settled >= 0.6) sentence += ' They have mostly stuck with their usual six, with the odd change.'
    else sentence += ' They have rotated their squad more than most, so the line-up on the night is harder to call.'
    if (p.last === SIDE_SIZE && p.settled < 0.8) sentence += ' They fielded their usual line-up last time out.'
  }
  return sentence
}

// ---------------------------------------------------------------------------
// The forecast

/** @param {Fixture} f @param {Forecast} fc @param {ReturnType<typeof picker>} pick */
function verdictSentence(f, fc, pick) {
  const fav = fc.pHome >= fc.pAway ? f.homeTeam : f.awayTeam
  const other = fav === f.homeTeam ? f.awayTeam : f.homeTeam
  const p = Math.max(fc.pHome, fc.pAway)
  const score = fav === f.homeTeam ? `${fc.likely.home}–${fc.likely.away}` : `${fc.likely.away}–${fc.likely.home}`
  const likely = fc.likely.home === fc.likely.away ? `${fc.likely.home}–${fc.likely.away} draw` : `${score} ${fav} win`
  if (Math.abs(fc.pHome - fc.pAway) < 0.1) {
    return pick('close', [
      `This one looks too close to call: our model gives ${f.homeTeam} ${pct(fc.pHome)} and ${f.awayTeam} ${pct(fc.pAway)}, with a ${pct(fc.pDraw)} chance of a draw. The most likely single score is a ${likely}.`,
      `There is very little between the sides. Based on current form and their usual line-ups, it is ${pct(fc.pHome)} to ${pct(fc.pAway)}, and a draw is a real possibility at ${pct(fc.pDraw)}. The most likely score is a ${likely}.`,
    ])
  }
  const strength = p >= 0.8 ? 'clear favourites' : p >= 0.62 ? 'favourites' : 'slight favourites'
  return pick('fav', [
    `Based on current form and both teams playing their usual line-up, ${fav} are ${strength}, winning ${pct(p)} of the time in our model. The most likely result is a ${likely}.`,
    `${fav} go in as ${strength} (${pct(p)} to ${other}’s ${pct(Math.min(fc.pHome, fc.pAway))}, with ${pct(fc.pDraw)} for a draw), and the likeliest scoreline is a ${likely}.`,
    `Our model, which rates every player on their results and assumes each side fields its regular six, makes ${fav} ${strength} at ${pct(p)}. Expect something like a ${likely}.`,
  ])
}

// Where the games should be won and lost: 8 men's, 2 ladies' and 8 mixed (CATEGORY_GAMES).
// An edge is 60% of a category's games (Stockport's 3.6 of 6).
/** @param {Fixture} f @param {Forecast} fc */
function battleSentence(f, fc) {
  /** @param {'mens' | 'ladies' | 'mixed'} k */
  const side = k => {
    const share = fc.edges[k] / CATEGORY_GAMES[k]
    return share >= 0.6 ? 'home' : share <= 0.4 ? 'away' : 'even'
  }
  const label = { mens: 'men’s doubles', ladies: 'ladies’ doubles', mixed: 'mixed' }
  /** @type {Record<string, string[]>} */ const by = { home: [], away: [], even: [] }
  for (const k of /** @type {const} */ (['mens', 'ladies', 'mixed'])) by[side(k)].push(label[k])
  const list = (/** @type {string[]} */ xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0])
  if (by.even.length === 3) return 'Game by game it looks evenly matched across the men’s, ladies’ and mixed doubles.'
  const parts = []
  if (by.home.length) parts.push(`${f.homeTeam} should have the edge in the ${list(by.home)}`)
  if (by.away.length) parts.push(`${f.awayTeam} ${by.home.length ? 'look stronger' : 'should have the edge'} in the ${list(by.away)}`)
  let s = cap(parts.join(', while ')) + '.'
  if (by.even.length) s += ` The ${list(by.even)} ${by.even.length > 1 ? 'look' : 'looks'} evenly matched.`
  return s
}

/** @param {string} name @param {Profile | null | undefined} p */
function seasonSentence(name, p) {
  const pr = p && p.projection
  if (!pr || pr.teams < 3) return null
  if (pr.pWinner >= 0.35) return `${name} are in the hunt for the title, finishing top in ${pct(pr.pWinner)} of our simulations of the rest of the season.`
  if (pr.pUp >= 0.5) return `${name} are on course for promotion, going up in ${pct(pr.pUp)} of our simulations of the rest of the season.`
  if (pr.pDown >= 0.5) return `${name} will be after every game they can get to climb away from the bottom two.`
  return `Our simulations of the rest of the season have ${name} finishing around ${ordinal(Math.round(pr.expected))}.`
}

// ---------------------------------------------------------------------------
// The report

/** @param {Game[]} games */
function byCategory(games) {
  /** @type {Record<string, { home: number, away: number }>} */ const out = {}
  for (const g of games) {
    if (!g.gameType) continue
    const k = /Mens$/.test(g.gameType) ? 'mens' : /Ladies$/.test(g.gameType) ? 'ladies' : /Mixed$/.test(g.gameType) ? 'mixed' : null
    if (!k) continue
    const c = out[k] || { home: 0, away: 0 }
    if (g.homeScore > g.awayScore) c.home++
    else if (g.awayScore > g.homeScore) c.away++
    out[k] = c
  }
  return out
}

/** @param {Fixture} f @param {Game[]} games @param {ReturnType<typeof picker>} pick */
function reportParagraphs(f, games, pick) {
  const h = Number(f.homeScore), a = Number(f.awayScore)
  const div = f.lewisRound != null ? ' in the Lewis Shield' : f.divisionName ? ` in ${divisionPhrase(f.divisionName)}` : ''
  const winner = h > a ? f.homeTeam : f.awayTeam, loser = h > a ? f.awayTeam : f.homeTeam
  const hi = Math.max(h, a), lo = Math.min(h, a)
  let first
  if (h === a) first = `${f.homeTeam} and ${f.awayTeam} shared the spoils${div}, drawing ${h}–${a} on ${longDate(f.date)}.`
  else if (lo === 0) first = `${winner} won every game against ${loser}${div}, an ${hi}–0 whitewash on ${longDate(f.date)}.`
  else if (hi - lo >= 8) first = pick('big', [`${winner} beat ${loser} comfortably${div}, winning ${hi}–${lo} on ${longDate(f.date)}.`, `A convincing ${hi}–${lo} win for ${winner} over ${loser}${div} on ${longDate(f.date)}.`])
  else if (hi - lo <= 2) first = pick('tight', [`${winner} edged a close one against ${loser}${div}, winning ${hi}–${lo} on ${longDate(f.date)}.`, `Only ${hi - lo === 2 ? 'one game' : 'a game'} in it in the end: ${winner} beat ${loser} ${hi}–${lo}${div} on ${longDate(f.date)}.`])
  else first = `${winner} beat ${loser} ${hi}–${lo}${div} on ${longDate(f.date)}.`
  const out = [first]

  const cats = byCategory(games)
  const label = { mens: 'men’s doubles', ladies: 'ladies’ doubles', mixed: 'mixed' }
  const lines = /** @type {const} */ (['mens', 'ladies', 'mixed']).filter(k => cats[k]).map(k => {
    const c = cats[k]
    if (c.home === c.away) return `the ${label[k]} were shared ${c.home}–${c.away}`
    return `${c.home > c.away ? f.homeTeam : f.awayTeam} took the ${label[k]} ${Math.max(c.home, c.away)}–${Math.min(c.home, c.away)}`
  })
  if (lines.length) out.push(cap(lines.length > 1 ? `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}` : lines[0]) + '.')
  return out
}

// ---------------------------------------------------------------------------
// Meetings

/** @param {Fixture} f @param {Played[]} meetings */
function meetingsSentence(f, meetings) {
  if (!meetings.length) return null
  const m = meetings[0]
  const homeWon = m.homeTeam === f.homeTeamId ? m.homeScore : m.awayScore
  const awayWon = m.homeTeam === f.homeTeamId ? m.awayScore : m.homeScore
  const when = shortDate(m.date)
  const last = homeWon === awayWon ? `the last meeting, on ${when}, finished level at ${homeWon}–${awayWon}`
    : `${homeWon > awayWon ? f.homeTeam : f.awayTeam} won the last meeting ${Math.max(homeWon, awayWon)}–${Math.min(homeWon, awayWon)} on ${when}`
  if (meetings.length === 1) return cap(last) + '.'
  let h = 0, a = 0
  for (const x of meetings) {
    const hw = x.homeTeam === f.homeTeamId ? x.homeScore : x.awayScore, aw = x.homeTeam === f.homeTeamId ? x.awayScore : x.homeScore
    if (hw > aw) h++; else if (aw > hw) a++
  }
  const record = h === a ? `honours are even at ${h} wins each` : `${h > a ? f.homeTeam : f.awayTeam} lead ${Math.max(h, a)}–${Math.min(h, a)}`
  return `${cap(last)}. Across their last ${word(meetings.length)} meetings, ${record}${meetings.length - h - a ? ` with ${word(meetings.length - h - a)} drawn` : ''}.`
}

// ---------------------------------------------------------------------------

/**
 * Everything the page writes about a fixture.
 * @param {{ fixture: Fixture, forecast?: { fixture: Forecast | null, home: Profile | null, away: Profile | null, ran_at?: Date | string } | null,
 *   context?: { form: Played[], meetings: Played[], games: Game[] } | null, standings?: Standing[] | null }} input
 */
function buildPreview({ fixture: f, forecast = null, context = null, standings = null }) {
  const pick = picker(f.id)
  const form = context?.form || [], meetings = context?.meetings || [], games = context?.games || []
  const status = String(f.status || '').toLowerCase()
  const played = f.homeScore != null && f.awayScore != null
  const cup = f.lewisRound != null
  const state = played ? 'result' : status === 'void' ? 'void' : /^rearrang/.test(status) ? 'rearranged' : 'upcoming'

  /** @param {number} id */
  const position = id => {
    if (!standings || !standings.length) return null
    const i = standings.findIndex(s => s.id === id)
    if (i < 0) return null
    return { place: i + 1, label: ordinal(i + 1), of: standings.length, played: standings[i].played, won: standings[i].gamesWon, lost: standings[i].gamesLost }
  }
  const tablePlace = id => (state === 'upcoming' && !cup ? position(id) : null)
  const home = { name: f.homeTeam, form: teamForm(f.homeTeamId, form), position: tablePlace(f.homeTeamId), profile: forecast?.home || null }
  const away = { name: f.awayTeam, form: teamForm(f.awayTeamId, form), position: tablePlace(f.awayTeamId), profile: forecast?.away || null }

  // A Lewis Shield tie is between divisions: its competition, not the home side's division.
  const div = cup ? 'Lewis Shield ' : f.divisionName ? `${f.divisionName} ` : ''
  const inDiv = cup ? 'the Lewis Shield' : divisionPhrase(f.divisionName)
  /** @type {{ heading: string, paragraphs: string[] }[]} */ const sections = []
  const fc = state === 'upcoming' && !cup ? forecast?.fixture || null : null

  if (state === 'result') {
    sections.push({ heading: 'Match report', paragraphs: reportParagraphs(f, games, pick) })
  } else if (state === 'upcoming') {
    const intro = [`${f.homeTeam} host ${f.awayTeam}${inDiv ? ` in ${inDiv}` : ''} on ${longDate(f.date)}.`]
    const pos = (/** @type {typeof home} */ t) => t.position && t.position.played
      ? `${t.name} are ${ordinal(t.position.place)} of ${t.position.of} with ${t.position.won} games won from ${word(t.position.played)} match${t.position.played === 1 ? '' : 'es'}`
      : null
    const tables = [pos(home), pos(away)].filter(Boolean)
    if (tables.length === 2) intro.push(`Going in, ${tables[0]}, while ${tables[1]}.`)
    else if (tables.length === 1) intro.push(`Going in, ${tables[0]}.`)
    sections.push({ heading: 'Match preview', paragraphs: intro })
  }

  if (fc) {
    const paras = [verdictSentence(f, fc, pick), battleSentence(f, fc)]
    let season = [seasonSentence(f.homeTeam, home.profile), seasonSentence(f.awayTeam, away.profile)].filter(Boolean)
    // Two of the generic sentence read as a repeat: say it once, for both teams.
    const AROUND = /^Our simulations of the rest of the season have (.+) finishing around (\S+)\.$/
    const both = season.length === 2 && season.map(x => x.match(AROUND))
    if (both && both[0] && both[1]) {
      season = [`Our simulations of the rest of the season have ${both[0][1]} finishing around ${both[0][2]} and ${both[1][1]} around ${both[1][2]}.`]
    }
    if (season.length) paras.push(season.join(' '))
    sections.push({ heading: 'Prediction', paragraphs: paras })
  }

  // Form and squads, before the match only: after it they describe the wrong moment.
  // One paragraph per team.
  if (state === 'upcoming') {
    const team = (/** @type {typeof home} */ t) => [formSentence(t.name, t.form, pick), squadSentence(t.name, t.profile, pick)].filter(Boolean).join(' ')
    const lines = [team(home), team(away)].filter(Boolean)
    if (lines.length) sections.push({ heading: 'Form and line-ups', paragraphs: lines })
  } else if (state === 'result') {
    const going = [formSentence(f.homeTeam, home.form, pick), formSentence(f.awayTeam, away.form, pick)].filter(Boolean)
    if (going.length) sections.push({ heading: 'Going into the match', paragraphs: /** @type {string[]} */ (going) })
  }

  const h2h = meetingsSentence(f, meetings)
  if (h2h) sections.push({ heading: 'Head to head', paragraphs: [h2h] })

  // One sentence for the meta description and the JSON-LD: what a searcher needs first.
  let summary
  if (state === 'result') summary = sections[0].paragraphs[0]
  else if (state === 'void') summary = `${f.homeTeam} vs ${f.awayTeam}, ${div}badminton fixture (void).`
  else if (state === 'rearranged') summary = `${f.homeTeam} vs ${f.awayTeam}, ${div}badminton fixture, being rearranged from ${longDate(f.date)}.`
  else if (fc) {
    const fav = fc.pHome >= fc.pAway ? f.homeTeam : f.awayTeam
    const close = Math.abs(fc.pHome - fc.pAway) < 0.1
    summary = `${f.homeTeam} vs ${f.awayTeam}, ${div}badminton, ${longDate(f.date)}. ` +
      (close ? 'Preview and prediction: too close to call.' : `Preview and prediction: ${fav} ${pct(Math.max(fc.pHome, fc.pAway))} favourites.`)
  } else summary = `${f.homeTeam} vs ${f.awayTeam}, ${div}badminton, ${longDate(f.date)}: venue, form and head to head.`

  return {
    state, summary, sections, home, away,
    forecast: fc,
    forecastAt: fc && forecast?.ran_at ? forecast.ran_at : null,
    meetings: meetings.map(m => ({
      id: m.id, date: m.date, homeName: m.homeName, awayName: m.awayName,
      // From this fixture's home side's point of view, whichever way round it was played.
      home: m.homeTeam === f.homeTeamId ? m.homeScore : m.awayScore,
      away: m.homeTeam === f.homeTeamId ? m.awayScore : m.homeScore,
      venue: m.homeTeam === f.homeTeamId ? 'home' : 'away',
    })),
  }
}

module.exports = { buildPreview, teamForm, formSentence, squadSentence, verdictSentence, battleSentence, meetingsSentence, ordinal, SIDE_SIZE }
