// Fuzzy matching for "is this person already registered?".
//
// Every player search used to be `name ILIKE '%term%'`, so it found a person only if
// what you typed was a literal slice of what was stored. "Mary Whitle" could not find
// the "Marry Whitle" who is actually on file, and a search that finds nobody is
// followed by "Create a new one below" — which is how the database came to hold
// Wahab Siddiqi *and* Wahab Siddiqui, Amie Tsang *and* Aimee Tsang, and eight exact
// duplicates besides (measured 28 Sep 2026 with a levenshtein self-join on player).
//
// The rules, each of which exists for a name that was hard to find:
//
//   - substring still wins. Anything the old search found is found here, ranked first,
//     so a partial "ary Whi" typed mid-thought still works.
//   - word order is free: "Whitle Mary" finds her, as does "Whitle" alone.
//   - each typed word must match a DIFFERENT word of the name, by prefix ("Mar"),
//     by a small edit distance scaled to its length, or by a known nickname.
//   - the allowance is per word, not per name. A flat distance over the whole name is
//     what makes "Tom Long" match "Tom Tang" (2 edits) — a short word gets no slack.
//   - accents, apostrophes and hyphens are ignored: "O'Brien" = "OBrien",
//     "Chandar-Anandan" = "Chandar Anandan", "Zoë" = "Zoe".
//
// Ported from Stockport (league-site 90cb07f). Tameside had the same two holes: the
// team-admin "add player" search (/players/matching) only looked at names starting with
// the same LETTER as the query, then allowed 10 edits over the whole name — so a typo in
// the first letter found nobody, and a short name found strangers — and nothing checked
// for an existing player before creating one.
//
// Scored in JavaScript rather than SQL because the whole player table is ~1,200 rows
// and a rule this shaped (distinct-token assignment) is miserable in SQL — and because
// it can then be unit-tested without a database, which the suite does not have.

const { distance } = require('fastest-levenshtein')

// Common English diminutives, both directions. Deliberately short: a nickname match is
// a suggestion shown to a human, never an automatic merge, but a list that maps "Al" to
// five names would bury the real candidates under noise.
const NICKNAME_GROUPS = [
  ['andrew', 'andy', 'drew'],
  ['anthony', 'tony'],
  ['alexander', 'alexandra', 'alex', 'alexa', 'sandy'],
  ['benjamin', 'ben', 'benji'],
  ['catherine', 'katherine', 'kathryn', 'cathy', 'kathy', 'kate', 'katie', 'kat', 'cat'],
  ['christopher', 'chris'],
  ['christine', 'christina', 'chris', 'chrissy', 'tina'],
  ['daniel', 'dan', 'danny'],
  ['david', 'dave', 'davey'],
  ['deborah', 'debra', 'debbie', 'deb'],
  ['edward', 'ed', 'eddie', 'ted'],
  ['elizabeth', 'liz', 'lizzie', 'beth', 'betty', 'eliza', 'libby'],
  ['gregory', 'greg'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['jennifer', 'jenny', 'jen', 'jenn'],
  ['jonathan', 'jon', 'john', 'johnny'],
  ['joseph', 'joe', 'joey'],
  ['kenneth', 'ken', 'kenny'],
  ['margaret', 'maggie', 'meg', 'peggy'],
  ['matthew', 'matt'],
  ['michael', 'mike', 'mick', 'micky', 'mikey'],
  ['nicholas', 'nick', 'nicky'],
  ['nicola', 'nicole', 'nikki', 'nicky'],
  ['patrick', 'pat', 'paddy'],
  ['patricia', 'pat', 'patty', 'tricia'],
  ['peter', 'pete'],
  ['philip', 'phillip', 'phil'],
  ['rebecca', 'becky', 'becca'],
  ['richard', 'rich', 'richie', 'rick', 'dick'],
  ['robert', 'rob', 'robbie', 'bob', 'bobby', 'bert'],
  ['samuel', 'samantha', 'sam', 'sammy'],
  ['stephen', 'steven', 'steve', 'stevie'],
  ['susan', 'suzanne', 'sue', 'susie', 'suzy'],
  ['thomas', 'tom', 'tommy'],
  ['timothy', 'tim', 'timmy'],
  ['victoria', 'vicky', 'vicki', 'tori'],
  ['william', 'will', 'bill', 'billy', 'liam'],
]

const NICKNAMES = new Map()
for (const group of NICKNAME_GROUPS) {
  for (const name of group) {
    if (!NICKNAMES.has(name)) NICKNAMES.set(name, new Set())
    for (const other of group) if (other !== name) NICKNAMES.get(name).add(other)
  }
}

// Apostrophes in regexes here are written \u0027 / \u2019 / \u0060, not typed:
// Stockport's mail-send scanner is string-aware but not regex-aware, and a bare quote
// inside a regex literal throws it out of sync. Kept so the two copies stay identical.
function normalise(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[\u0027\u2019\u0060.]/g, '')    // O'Brien -> obrien, St. -> st
    .replace(/[^a-z0-9]+/g, ' ') // hyphens and anything else separate words
    .trim()
}

function tokens(s) {
  const n = normalise(s)
  return n ? n.split(' ') : []
}

// Edits tolerated in one word of this length. Three letters or fewer must be exact
// (or a prefix, or a nickname): one edit turns "Tom" into "Tim" and "Sam" into "Pam".
// Up to six letters get one edit, seven or more get two. Tuned against the live table
// (28 Sep 2026): across all ~1,200 players these rules pair up six names, every one of
// which looks like the same person entered twice. Allowing two edits from five letters
// pairs 27, most of them different people — "Ryan" ~ "Brian", "Rob Wilson" ~ "Rob
// Timson" — and it is exactly the loosening that would let "Amie" find "Aimee". Not
// worth it: a list of plausible strangers hides the one real match.
function allowance(len) {
  if (len <= 3) return 0
  if (len <= 6) return 1
  return 2
}

// Cost of matching typed word q against stored word c, or Infinity if it does not.
function tokenCost(q, c) {
  if (q === c) return 0
  if (c.startsWith(q)) return 0.2           // still typing
  const nick = NICKNAMES.get(q)
  if (nick && nick.has(c)) return 0.5
  const allowed = Math.min(allowance(q.length), allowance(c.length))
  if (allowed === 0) return Infinity
  const d = distance(q, c)
  return d <= allowed ? d : Infinity
}

// Best assignment of typed words to distinct stored words. Names have two to four
// words, so trying every assignment is cheaper than being clever.
function bestAssignment(qs, cs, used, i) {
  if (i === qs.length) return 0
  let best = Infinity
  for (let j = 0; j < cs.length; j++) {
    if (used[j]) continue
    const cost = tokenCost(qs[i], cs[j])
    if (cost === Infinity) continue
    used[j] = true
    const rest = bestAssignment(qs, cs, used, i + 1)
    used[j] = false
    if (cost + rest < best) best = cost + rest
  }
  return best
}

// How well `query` matches `name`: null for no match, otherwise
//   { score, kind } — lower score is better, kind is 'exact' | 'contains' | 'close'.
function matchName(query, name) {
  const nq = normalise(query)
  const nc = normalise(name)
  if (!nq || !nc) return null
  if (nq === nc) return { score: 0, kind: 'exact' }
  const at = nc.indexOf(nq)
  // At a word boundary ranks above mid-word: "Jo" means John before Ellis-Jones.
  if (at === 0 || nc[at - 1] === ' ') return { score: 0.1, kind: 'contains' }
  if (at > 0) return { score: 0.15, kind: 'contains' }

  const qs = nq.split(' ')
  const cs = nc.split(' ')
  let cost = qs.length <= cs.length ? bestAssignment(qs, cs, new Array(cs.length).fill(false), 0) : Infinity

  // Words split differently: "McDonald" vs "Mc Donald", "Anne Marie" vs "Annemarie".
  // Only when the word COUNTS differ — with equal counts the per-word rule has already
  // decided, and joining would hand "Tom Long" the whole name's slack to match "Tom Tang".
  if (cost === Infinity && qs.length !== cs.length) {
    const jq = qs.join('')
    const jc = cs.join('')
    const d = distance(jq, jc)
    if (d <= allowance(Math.min(jq.length, jc.length))) cost = d + 0.5
  }
  if (cost === Infinity) return null
  // 1 is added so every close match ranks below every substring match.
  return { score: 1 + cost, kind: 'close' }
}

// Filter and rank `rows` by how well `nameOf(row)` matches `query`. Stable for ties,
// so a caller's own ORDER BY (surname, say) survives among equally good matches.
function rankByName(rows, query, nameOf, limit) {
  const scored = []
  rows.forEach((row, i) => {
    const m = matchName(query, nameOf(row))
    if (m) scored.push({ row, m, i })
  })
  scored.sort((a, b) => a.m.score - b.m.score || a.i - b.i)
  const out = scored.map(s => Object.assign({}, s.row, { match: s.m.kind }))
  return limit ? out.slice(0, limit) : out
}

module.exports = { normalise, tokens, matchName, rankByName, NICKNAMES }
