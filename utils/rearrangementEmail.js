// Reading a fixture-rearrangement email: which fixture it is about, and where it is going.
//
// The emails are written by captains and secretaries, not forms — "Disley V Cheadle Hulme A
// / Original date - Tuesday 10th Nov 2026 / New date - Tuesday 13th April 2027", or a reply
// chain where three dates were offered and the agreed one is in the latest reply. They are
// forwarded to rearrangements@ by the results secretary, who only forwards the ones that are
// settled, so the reading has to be good on a settled email and need not judge whether the
// clubs really agreed.
//
// What was learned from the first five real ones (Oct–Nov 2026):
//  - **Team letters are unreliable; the date and the clubs are not.** "our match against
//    Racketeers B on 9th November" was Racketeers A. On every sample the date plus the
//    clubs named pointed at exactly one fixture.
//  - **Email metadata is full of dates** ("Sent: 13 October 2026 14:54", "On 13 Oct 2026, at
//    09:22, Richard wrote:"). Those lines are skipped, or every thread proposes its own
//    send dates.
//  - **The newest reply is at the top**, so the first date read that is not the fixture's
//    own is the one most recently agreed.
//
// Pure: no database, no network. The caller passes the clubs and teams it knows about, and
// `propose()` takes the fixtures the caller found from this reading.
//
// Ported verbatim from Stockport (league-site 679e460), so their fixes apply here. Their
// first five real emails included Tameside clubs (Disley, Alderley Park, College Green,
// Mellor, GHAP, Syddal Park): several clubs play in both leagues.

const { originalSender } = require('./registrationEmail')

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

// Lines that are about the email, not the fixture. Subject: is not among them — a forwarded
// subject ("9th Nov - Racketeers A v Syddal") is often the best statement of the fixture.
const METADATA_LINE = /^\s*(from|to|cc|bcc|date|sent|reply-to)\s*:/i
// "On Tue, 13 Oct 2026 at 13:36, Tom <tom@…> wrote:" and Apple Mail's "On 13 Oct 2026, at
// 09:22, …". Sometimes wrapped, so a line that starts "On" and carries a clock time counts.
const REPLY_LINE = /^\s*on\b.*(\bwrote:?\s*$|\b\d{1,2}:\d{2}\b)/i

// Weekday names are optional and, when given, checked: "Tuesday 10th Nov" on a Monday is a
// typo in one of the two, and the page says so rather than guessing which.
const DAY_WORD = '(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s+(?:the\\s+)?)?'
const MONTH_WORD = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
// 10th Nov 2026 · 9th November · Tuesday, 10th November · 13th of April '27
const DAY_MONTH = new RegExp('\\b' + DAY_WORD + '(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+' + MONTH_WORD +
  '(?:,?\\s+(\\d{4}|\\u0027?\\d{2}(?!\\d|:)))?', 'gi')
// November 10th · Nov 10, 2026. A suffix or a year is required: "May 5" alone is too often
// not a date, and "may" is a verb.
const MONTH_DAY = new RegExp('\\b' + DAY_WORD + MONTH_WORD + '\\s+(\\d{1,2})(?:(?:st|nd|rd|th)(?:,?\\s+(\\d{4}))?|,?\\s+(\\d{4}))\\b', 'gi')
// 25/11/2026 · 10/02/27 · 4.11.26 — day first, as everyone here writes it.
const NUMERIC = new RegExp('\\b' + DAY_WORD + '(\\d{1,2})[/.\\-](\\d{1,2})[/.\\-](\\d{4}|\\d{2})\\b', 'gi')

// What the words just before a date say it is. Checked over the text between the previous
// date on the line (or the line start) and this one, so "from 9th Nov to 3rd Feb" gives each
// its own role.
const ORIGINAL_BEFORE = /\b(original(?:ly)?|old|current(?:ly)?|scheduled|existing|was due|due on|from)\b[^0-9]{0,25}$/i
const NEW_BEFORE = /\b(new|now|instead|revised|moved?(?: it)? to|change(?:d)?(?: it)? to|rearranged?(?: it)? (?:to|for)|re-arranged?(?: it)? (?:to|for)|play(?:ed)?(?: it)? on|to)\b[^0-9]{0,25}$/i

// "We haven't agreed on a new date yet", "new date TBC". The fixture is then marked
// 'rearranging' and keeps its date until a second email gives one.
const NO_DATE_YET = /\b(?:no|haven.?t|have not|not yet|yet to)\b[^.\n]{0,30}\b(?:agreed|confirmed|got|set|found|decided|arranged)\b[^.\n]{0,20}\bdate|\b(?:new )?date (?:is )?(?:tbc|tba|to be (?:confirmed|arranged|agreed|decided))\b|\bdate\s*[:\-–]\s*(?:tbc|tba)\b/i
// "we are unable to re-arrange". Only a warning — the secretary forwards settled emails, but
// a thread that ends in a refusal is exactly the one to look at twice.
const REFUSAL = /\b(?:unable|not able|can.?t|cannot|won.?t be able|not in a position)\b[^.\n]{0,30}\b(?:re-?arrange|re-?schedule|move|change)/i

function pad(n) {
  return String(n).padStart(2, '0')
}

function ymd(y, m, d) {
  return y + '-' + pad(m) + '-' + pad(d)
}

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

// The weekday of a calendar date, 0 = Sunday. UTC throughout so no timezone moves the day.
function weekday(dateYmd) {
  const [y, m, d] = dateYmd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

// A season runs August to July. A date written without a year belongs to the season the
// email arrived in: "9th Nov" in October is this November, "13th April" is next April.
function seasonYear(month, receivedYmd) {
  const [ry, rm] = receivedYmd.split('-').map(Number)
  const startYear = rm >= 8 ? ry : ry - 1
  return month >= 8 ? startYear : startYear + 1
}

function fullYear(text, month, receivedYmd) {
  if (!text) return seasonYear(month, receivedYmd)
  const digits = text.replace(/\D/g, '')
  return digits.length === 2 ? 2000 + Number(digits) : Number(digits)
}

// The lines worth reading for dates and clubs: the subject first, then the body without its
// metadata lines, quoting marks and email addresses (an address like alderleyparkbc@… is
// not someone naming a club).
function contentLines(text, subject) {
  const lines = [String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '')]
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s>]+/, '')
    if (METADATA_LINE.test(line) || REPLY_LINE.test(line)) continue
    lines.push(line
      .replace(/^subject\s*:\s*/i, '')
      .replace(/<?(?:mailto:)?[^\s<>@]+@[^\s<>@]+>?/g, ' '))
  }
  return lines
}

// Every date in the text, in reading order, with what the words before it say it is.
function datesIn(lines, receivedYmd) {
  const found = []
  lines.forEach((line, lineIndex) => {
    const hits = []
    const take = (re, toParts) => {
      re.lastIndex = 0
      let m
      while ((m = re.exec(line))) {
        if (hits.some(h => m.index < h.end && m.index + m[0].length > h.start)) continue
        const parts = toParts(m)
        if (!parts) continue
        hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0].trim(), ...parts })
      }
    }
    const monthOf = w => MONTHS.indexOf(w.slice(0, 3).toLowerCase()) + 1
    take(DAY_MONTH, m => ({ day: m[1], d: Number(m[2]), mo: monthOf(m[3]), y: m[4] }))
    take(MONTH_DAY, m => ({ day: m[1], d: Number(m[3]), mo: monthOf(m[2]), y: m[4] || m[5] }))
    take(NUMERIC, m => ({ day: m[1], d: Number(m[2]), mo: Number(m[3]), y: m[4] }))
    hits.sort((a, b) => a.start - b.start)

    let previousEnd = 0
    for (const h of hits) {
      const year = fullYear(h.y, h.mo, receivedYmd)
      const before = line.slice(previousEnd, h.start)
      previousEnd = h.end
      if (!validDate(year, h.mo, h.d)) continue
      const date = ymd(year, h.mo, h.d)
      const role = ORIGINAL_BEFORE.test(before) ? 'original' : NEW_BEFORE.test(before) ? 'new' : null
      const stated = h.day ? DAYS.indexOf(h.day.slice(0, 3).toLowerCase()) : -1
      found.push({
        ymd: date, raw: h.raw, role, line: lineIndex,
        dayMismatch: stated >= 0 && stated !== weekday(date),
      })
    }
  })
  return found
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A club or team name as a pattern that survives how people write it: case, punctuation
// ("G.H.A.P" / "GHAP"), spacing ("Parrs Wood" / "Parrswood") and a plural ("Racketeer" /
// "Racketeers").
function namePattern(name) {
  const words = String(name).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean)
  if (!words.length) return null
  return words.map(escapeRe).join('\\s*') + 's?'
}

// Which clubs and teams the email names. A club is also found by its first word when that is
// distinctive enough to be meant ("Syddal" for Syddal Park, "Alderley"), and by its initials
// with BC ("APBC").
function namesIn(lines, clubs, teams) {
  const text = ' ' + lines.join('\n').toLowerCase().replace(/[^a-z0-9\s]/g, '') + ' '
  const has = pattern => pattern && new RegExp('(^|[^a-z0-9])' + pattern + '(?![a-z0-9])').test(text)
  const clubIds = []
  for (const c of clubs) {
    const words = String(c.name).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean)
    const aliases = [namePattern(c.name)]
    if (words.length > 1 && words[0].length >= 6) aliases.push(escapeRe(words[0]))
    if (words.length > 1) aliases.push(words.map(w => w[0]).join('') + 'bc')
    if (aliases.some(has)) clubIds.push(c.id)
  }
  const teamIds = teams.filter(t => has(namePattern(t.name))).map(t => t.id)
  return { clubIds, teamIds }
}

// Who wrote it. A contact-form relay names the writer in its footer ("From
// roger@… . Replying to this email goes back to them."), which beats the From of a relay
// that is ours.
function writerOf(text, headerFrom) {
  const relay = String(text || '').match(/^\s*From\s+([^\s<>@]+@[^\s<>@]+?)\.?\s+Replying to this email/im)
  if (relay) return relay[1]
  return originalSender(text, headerFrom)
}

/**
 * The first reading of one email, stored with it in rearrangement_request.reading.
 * @param {{ text?: string, subject?: string, headerFrom?: string, receivedYmd: string,
 *   clubs?: { id: number, name: string }[], teams?: { id: number, name: string }[] }} email
 */
function readRearrangementEmail({ text, subject, headerFrom, receivedYmd, clubs = [], teams = [] }) {
  const lines = contentLines(text, subject)
  const body = lines.join('\n')
  const { clubIds, teamIds } = namesIn(lines, clubs, teams)
  return {
    originalFrom: writerOf(text, headerFrom),
    dates: datesIn(lines, receivedYmd),
    clubIds,
    teamIds,
    noDateYet: NO_DATE_YET.test(body),
    refused: REFUSAL.test(body),
  }
}

const ACTIONABLE = ['outstanding', 'rearranging']

/**
 * Which fixture and new date the reading points at, given the fixtures the caller found for
 * it. Scores each candidate on the clubs and teams named and the dates mentioned; proposes
 * one only when it is clearly ahead, because a wrong preselection is easier to miss than an
 * empty one.
 * @param {{ dates: { ymd: string, role: string | null }[], clubIds: number[], teamIds: number[], noDateYet: boolean }} reading
 * @param {{ id: number, date: string, status: string | null, homeTeamId: number, awayTeamId: number,
 *   homeClubId: number, awayClubId: number }[]} fixtures
 * @param {number[]} [extraClubIds] clubs known some other way — the sender's own
 */
function propose(reading, fixtures, extraClubIds = []) {
  const clubs = new Set([...reading.clubIds, ...extraClubIds])
  const teams = new Set(reading.teamIds)
  const mentioned = new Set(reading.dates.map(d => d.ymd))
  const labelledOriginal = new Set(reading.dates.filter(d => d.role === 'original').map(d => d.ymd))

  const scored = fixtures.map(f => {
    let score = 0
    // Distinct clubs and teams: a club derby (Racketeers B v Racketeers A) names one club,
    // not two, or it outscores the fixture the email is actually about.
    for (const c of new Set([f.homeClubId, f.awayClubId])) if (clubs.has(c)) score += 2
    for (const t of new Set([f.homeTeamId, f.awayTeamId])) if (teams.has(t)) score += 1
    if (mentioned.has(f.date)) score += 2
    if (labelledOriginal.has(f.date)) score += 1
    // A fixture already waiting for its new date is what a "date confirmed" email is about.
    if (f.status === 'rearranging') score += 1
    if (!ACTIONABLE.includes(f.status || 'outstanding')) score -= 3
    // The replacement of a fixture this email already moved. Proposing it would offer to
    // move the match a second time — what a re-forwarded email would otherwise do.
    if (fixtures.some(o => o.id < f.id && o.status === 'rearranged'
        && o.homeTeamId === f.homeTeamId && o.awayTeamId === f.awayTeamId && mentioned.has(o.date))) score -= 3
    return { fixture: f, score }
  }).sort((a, b) => b.score - a.score)

  const best = scored[0]
  const clear = best && best.score >= 4 && (!scored[1] || best.score > scored[1].score)
    && ACTIONABLE.includes(best.fixture.status || 'outstanding')
  const fixture = clear ? best.fixture : null

  // A date labelled new wins. Otherwise, once the fixture is known, the first date that is
  // not its own — the newest reply's. Without a fixture an unlabelled date is as likely to
  // be the original as the new one, so nothing is guessed.
  let newDate = null
  if (!reading.noDateYet) {
    const labelled = reading.dates.find(d => d.role === 'new' && (!fixture || d.ymd !== fixture.date))
    const first = fixture && reading.dates.find(d => d.role !== 'original' && d.ymd !== fixture.date)
    newDate = labelled ? labelled.ymd : first ? first.ymd : null
  }

  return { fixtureId: fixture ? fixture.id : null, newDate, ranked: scored.map(s => s.fixture.id) }
}

module.exports = { readRearrangementEmail, propose, weekday, seasonYear }
