// Reading a player-registration email: who it came from, and whom it asks to register.
//
// The emails are written by people, not forms — "Could you register Mary Whitle (F) for
// Dome B please", a pasted list, a table out of a spreadsheet — and they arrive
// FORWARDED, so the person who wrote them is inside the body rather than in the From
// header. This is a best effort at a first reading, and it is allowed to be wrong in
// both directions: every candidate is shown beside the email on /admin/player-requests,
// editable, with a Skip, and nothing is written until a person presses a button. What it
// must not do is miss the obvious list — that is the copying-and-pasting it replaces.
//
// Pure: no database, no network. The caller passes the team names it knows about.
//
// Ported verbatim from Stockport (league-site 90cb07f), so their fixes apply here. The
// apostrophes in its regexes are written \u0027 / \u2019, not typed: a scanner of theirs
// is not regex-aware.

const HEADER_LINE = /^\s*(from|to|cc|bcc|date|sent|subject|reply-to)\s*:/i
// Gmail, Outlook and Apple Mail respectively.
const FORWARD_MARKERS = [
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^begin forwarded message:?$/i,
]
const REPLY_MARKER = /^on .+wrote:$/i
const SIGNATURE_MARKER = /^--\s*$/
// "Thanks," / "Kind regards" / "Cheers Bob" on a line of its own: what follows is the
// writer's own name, which is not a registration. Stopping here is what lets a player
// who writes in about THEMSELVES still be read — excluding the sender's name instead
// would drop exactly that person.
const SIGNOFF = /^(?:many |kind |best |warm(?:est)? |with )?(?:thanks|thank you|thankyou|ta|regards|cheers|wishes|best|rgds)(?: (?:again|very much|so much|all))?[,.!]*(?:\s+[A-Z][a-z]+)?\s*$/i
// A name inside a sentence, after the words people use to introduce one. The trigger is
// case-insensitive ("My name is") and the name after it is not — capitals are the only
// evidence that "Sarah Connor" is a name and "and I play" is not.
const INTRODUCED = /\b(?:my name is|my name's|name is|i am|i'm|register|registering|add|adding|sign up|signing up|called|named)\s+/gi
const NAME_AFTER = /^[A-Z][A-Za-z\u0027\u2019-]+(?:\s+(?:(?:van|von|der|den|de|da|di|du|del|la|le|st)\s+)*[A-Z][A-Za-z\u0027\u2019-]+){1,2}/
const KEY_VALUE = /^(gender|sex|team)\s*[:\-–]\s*(.+)$/i

// Words that make a line not a name, however capitalised. Greetings, sign-offs, and the
// vocabulary the request itself is written in.
const NOT_NAME_WORDS = new Set((
  'hi hello hey dear thanks thank regards kind best cheers many please pls could can would ' +
  'you we i me my our us the a an and or for to from of on in at is are be this that these ' +
  'with as by it sent subject date forwarded message original wrote get outlook iphone android ' +
  'mobile register registered registering registration registrations player players new add ' +
  'following below attached join joining team teams club clubs league badminton secretary ' +
  'captain match division premier reserve reserves nominated season mens ladies men women ' +
  'male female mixed level doubles singles email phone tel mob number yes no also just know ' +
  'let need needs want like look looking forward sorry morning afternoon evening all everyone ' +
  'best wishes warm ta love x xx xxx monday tuesday wednesday thursday friday saturday sunday ' +
  'january february march april may june july august september october november december'
).split(' '))
// Minus the ones that are also first names, which is the point of listing them apart.
for (const w of ['may', 'june', 'august', 'april', 'will', 'mark']) NOT_NAME_WORDS.delete(w)

// Lower-case particles allowed inside a surname: "van der Berg", "de Souza".
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'da', 'di', 'du', 'del', 'la', 'le', 'st', 'bin', 'al'])

const GENDER_WORDS = {
  male: 'Male', man: 'Male', men: 'Male', mens: 'Male', gent: 'Male', gents: 'Male', m: 'Male',
  female: 'Female', woman: 'Female', women: 'Female', womens: 'Female', lady: 'Female',
  ladies: 'Female', f: 'Female',
}

function genderIn(line) {
  // Whole words only, so the "m" in "Tom" or the "f" in "Fox" is not a gender. A bare
  // M or F is only believed when it stands apart: "(F)", ", M", "- F", or a table cell.
  const found = new Set()
  const words = line.toLowerCase().replace(/[\u0027\u2019]/g, '').split(/[^a-z]+/).filter(Boolean)
  for (const w of words) {
    if (w.length > 1 && GENDER_WORDS[w]) found.add(GENDER_WORDS[w])
  }
  const bare = line.match(/(?:^|[\s,;|(\t\-–])([MFmf])(?=$|[\s,;|)\t.])/g) || []
  for (const b of bare) found.add(GENDER_WORDS[b.trim().replace(/^[,;|(\-–]/, '').toLowerCase()])
  // Both named means the line is about both ("men's and ladies' teams"), so neither.
  return found.size === 1 ? [...found][0] : null
}

function looksLikeWord(w) {
  return /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ\u0027\u2019-]*$/.test(w)
}

function titleCase(w) {
  return w.toLowerCase().replace(/(^|[-\u0027\u2019])([a-zà-öø-ÿ])/g, (m, sep, c) => sep + c.toUpperCase())
}

// Two to four words, first and last capitalised, nothing from NOT_NAME_WORDS. A gender
// written on the end ("Mary Whitle F", "Tom Long Male") is taken off first — it is the
// line's detail, not the surname.
function asName(segment) {
  let words = segment.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean)
  const isGender = w => Object.prototype.hasOwnProperty.call(GENDER_WORDS, w.toLowerCase().replace(/[\u0027\u2019]s?$/, ''))
  while (words.length && isGender(words[words.length - 1])) words.pop()
  while (words.length && isGender(words[0])) words.shift()
  if (words.length < 2 || words.length > 4) return null
  if (!words.every(looksLikeWord)) return null
  if (words.some(w => NOT_NAME_WORDS.has(w.toLowerCase().replace(/[\u0027\u2019]s$/, '')))) return null
  // A surname of one letter is a team ("Dome B") or an initial, not a family name.
  if (words[words.length - 1].replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '').length < 2) return null
  // Capitals are how a spreadsheet writes a surname ("Mary WHITLE"); store them as a
  // name is written. Mc/Mac and similar are left for the page to correct.
  words = words.map(w => (w.length > 1 && w === w.toUpperCase()) ? titleCase(w) : w)
  const isCap = w => w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase()
  if (!isCap(words[0]) || !isCap(words[words.length - 1])) return null
  if (!words.every((w, i) => isCap(w) || (i > 0 && PARTICLES.has(w.toLowerCase())))) return null
  return { first: words[0], family: words.slice(1).join(' ') }
}

// A line's parts, split on the separators people use between a name and its details.
function segments(line) {
  return line.split(/\t|\s{3,}|\s*[,;|()[\]:]\s*|\s+[-–—]\s+|\s+\/\s+/).map(s => s.trim()).filter(Boolean)
}

function stripLine(raw) {
  return raw
    .replace(/^[\s>]+/, '')                    // quoting
    .replace(/^(?:[-*•·▪◦]|\d{1,2}[.)])\s*/, '') // bullets and numbering
    .replace(/^(?:name|player|player name)\s*[:\-–]\s*/i, '')
    .trim()
}

// Who wrote the email, from the first From: line of a forwarded block, else the header.
function originalSender(text, headerFrom) {
  const lines = String(text || '').split(/\r?\n/)
  let inForward = false
  for (const raw of lines) {
    const line = raw.replace(/^[\s>]+/, '').trim()
    if (FORWARD_MARKERS.some(re => re.test(line))) { inForward = true; continue }
    if (inForward) {
      const m = line.match(/^from\s*:\s*(.+)$/i)
      if (m) return m[1].replace(/\*/g, '').trim()
    }
  }
  return headerFrom || null
}

// The part a person wrote: after the forwarding header block if there is one, and
// before any signature or quoted earlier thread.
function writtenPart(text) {
  const lines = String(text || '').split(/\r?\n/)
  let start = 0
  const marker = lines.findIndex(l => FORWARD_MARKERS.some(re => re.test(l.replace(/^[\s>]+/, '').trim())))
  if (marker >= 0) {
    start = marker + 1
    // Skip the From:/Date:/Subject:/To: block that follows the marker.
    while (start < lines.length && (HEADER_LINE.test(lines[start].replace(/^[\s>]+/, '')) || !lines[start].trim())) start++
  }
  const out = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].replace(/^[\s>]+/, '').trim()
    if (SIGNATURE_MARKER.test(lines[i]) || REPLY_MARKER.test(line) || SIGNOFF.test(line)) break
    if (FORWARD_MARKERS.some(re => re.test(line))) break
    out.push(lines[i])
  }
  return out
}

// Find a team this line names. Longest first so "Dome B" is not read as "Dome".
function teamIn(line, teamNames) {
  const lower = ' ' + line.toLowerCase().replace(/\s+/g, ' ') + ' '
  for (const name of teamNames) {
    const n = name.toLowerCase().trim()
    if (!n) continue
    const i = lower.indexOf(n)
    if (i < 0) continue
    const before = lower[i - 1]
    const after = lower[i + n.length]
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after || ' ')) return name
  }
  return null
}

// { originalFrom, candidates: [{ first, family, gender, team, raw }], teams }
//
// `teams` is every team name the email mentions anywhere, for the page to offer as a
// default when a line names none — "please register these for Dome B:" then a list.
function parseRegistrationEmail({ text, headerFrom, teamNames = [] }) {
  const byLength = teamNames.slice().sort((a, b) => b.length - a.length)
  const from = originalSender(text, headerFrom)
  const lines = writtenPart(text)

  const candidates = []
  const seen = new Set()
  const teams = []
  const add = (name, line, team) => {
    const key = (name.first + ' ' + name.family).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ first: name.first, family: name.family, gender: genderIn(line), team: team, raw: line })
  }

  for (const raw of lines) {
    const line = stripLine(raw)
    if (!line || HEADER_LINE.test(line)) continue
    const team = teamIn(line, byLength)
    if (team && !teams.includes(team)) teams.push(team)

    // "Gender: Female" / "Team: Dome B" under a "Name: ..." line belongs to that name.
    const kv = line.match(KEY_VALUE)
    if (kv) {
      const last = candidates[candidates.length - 1]
      if (last && /gender|sex/i.test(kv[1]) && !last.gender) last.gender = genderIn(kv[2])
      if (last && /team/i.test(kv[1]) && !last.team && team) last.team = team
      continue
    }

    // In a sentence, only a name somebody introduced counts: "My name is Sarah Connor
    // and I play for Shell A". Any capitalised pair would take "Hi Neil" too.
    if (line.length > 60) {
      for (const m of line.matchAll(INTRODUCED)) {
        const after = line.slice(m.index + m[0].length).match(NAME_AFTER)
        const name = after && asName(after[0])
        if (name) add(name, line, team)
      }
      continue
    }

    let name = null
    for (const seg of segments(line)) {
      // Take the team off the front or back of a segment: "Dome B Mary Whitle".
      const cleaned = team ? seg.replace(new RegExp(team.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ').trim() : seg
      name = asName(cleaned)
      if (name) break
    }
    if (name) add(name, line, team)
  }

  // "Please register these for Dome B:" and then a list — one team named in the whole
  // email is that list's team. Two or more and the page asks.
  if (teams.length === 1) {
    for (const c of candidates) if (!c.team) c.team = teams[0]
  }
  return { originalFrom: from, candidates, teams }
}

module.exports = { parseRegistrationEmail, originalSender, writtenPart, genderIn, asName }
