// Fuzzy-match the raw player-name text extracted from a scorecard photo
// against a team's eligible roster (the DB-augmentation step: recognition
// becomes "pick from ~15 known names", not open handwriting OCR).
//
// Pure — no DB, no I/O — so it's unit-testable. Rosters are arrays of
// { id, first_name, family_name, gender } (gender 'Male'/'Female'/'Other').
//
// Event gender rules: Ladies = two Female; Mixed = one Male + one Female;
// Open = any two (unconstrained).

const { distance } = require('fastest-levenshtein');

const normalise = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');

function sim(a, b) {
  if (!a || !b) return 0;
  const d = distance(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

// Blob tokens + joins of consecutive tokens (Vision splits "Lucas-Bond" into
// "was bond"-style fragments; joining recovers "wasbond" ~ "lucasbond").
function tokenise(blob) {
  const toks = String(blob || '').split(/\s+/).map(normalise).filter(Boolean);
  const joins = [];
  for (let i = 0; i < toks.length - 1; i++) joins.push(toks[i] + toks[i + 1]);
  return { toks, joins };
}

// 0..1 score for one roster player against the raw pair text.
function scoreCandidate(player, { toks, joins }) {
  const fam = normalise(player.family_name);
  const first = normalise(player.first_name);
  const all = toks.concat(joins);
  const famScore = Math.max(0, ...all.map((t) => sim(fam, t)));
  const firstScore = Math.max(0, ...toks.map((t) => sim(first, t)));
  // Handwritten cards mostly use "K. Eeles" style — an initial match counts.
  const initialScore = first && toks.some((t) => t === first[0]) ? 0.75 : 0;
  return 0.7 * famScore + 0.3 * Math.max(firstScore, initialScore);
}

const MATCH_THRESHOLD = 0.55;

const displayName = (p) => `${String(p.first_name || '').trim()} ${String(p.family_name || '').trim()}`.replace(/\s+/g, ' ').trim();

const asMatch = (entry) =>
  entry
    ? { id: entry.player.id, name: displayName(entry.player), gender: entry.player.gender, score: +entry.score.toFixed(3), confident: entry.score >= MATCH_THRESHOLD }
    : null;

// Match one event-side's raw text to (up to) two roster players.
// spec: 'ladies' | 'mixed' | 'open'.
function matchPair(blob, roster, spec) {
  const tk = tokenise(blob);
  const ranked = (roster || [])
    .map((player) => ({ player, score: scoreCandidate(player, tk) }))
    .sort((a, b) => b.score - a.score);

  const top = (pred, exclude) => ranked.find((e) => pred(e.player) && !exclude.includes(e)) || null;
  const isF = (p) => p.gender === 'Female';
  const isM = (p) => p.gender === 'Male';

  let pair;
  if (spec === 'ladies') {
    const a = top(isF, []);
    pair = [a, top(isF, [a])];
  } else if (spec === 'mixed') {
    pair = [top(isM, []), top(isF, [])];
  } else {
    const a = top(() => true, []);
    pair = [a, top(() => true, [a])];
  }
  return { pair: pair.map(asMatch), ranked };
}

const eventSpec = (eventName) =>
  /^Ladies/i.test(eventName) ? 'ladies' : /^Mixed/i.test(eventName) ? 'mixed' : 'open';

// Full-card matching: per-event pairs plus the entry form's slot assignment.
// Slot convention (matches the entry form): Open A pair -> Man 1/2, Open B
// pair -> Man 3/4, Ladies pair -> Lady 1/2 — with gaps back-filled from the
// other events' matched pairs (Open C/D re-use the same four men; Mixed re-use
// the men and ladies), deduped by player id.
const SLOT_MIN_SCORE = 0.45;

function matchScorecard(extraction, homeRoster, awayRoster) {
  const events = extraction.events.map((e) => {
    const spec = eventSpec(e.event);
    return {
      event: e.event,
      spec,
      home: matchPair(e.home.playersRaw, homeRoster, spec),
      away: matchPair(e.away.playersRaw, awayRoster, spec),
    };
  });

  const slotsFor = (side) => {
    const pairOf = (n) => {
      const e = events.find((ev) => ev.event === n);
      return e ? e[side].pair.filter(Boolean) : [];
    };
    const used = new Set();
    const take = (slots, count, candidates) => {
      for (const c of candidates) {
        if (slots.length >= count) break;
        if (!c || c.score < SLOT_MIN_SCORE || used.has(c.id)) continue;
        used.add(c.id);
        slots.push(c);
      }
    };
    const genderFrom = (names, gender) =>
      names.flatMap(pairOf).filter((c) => c.gender === gender).sort((a, b) => b.score - a.score);

    // Primary assignment straight from the pairs, in form order.
    const men = [];
    take(men, 2, pairOf('Open A').filter((c) => c.gender === 'Male'));
    take(men, 4, pairOf('Open B').filter((c) => c.gender === 'Male'));
    // Back-fill any gaps from the remaining events' male picks, best first.
    take(men, 4, genderFrom(['Open C', 'Open D', 'Mixed A', 'Mixed B', 'Mixed C', 'Mixed D'], 'Male'));
    while (men.length < 4) men.push(null);

    const ladies = [];
    take(ladies, 2, pairOf('Ladies').filter((c) => c.gender === 'Female'));
    take(ladies, 2, genderFrom(['Mixed A', 'Mixed B', 'Mixed C', 'Mixed D'], 'Female'));
    while (ladies.length < 2) ladies.push(null);

    return { men, ladies };
  };

  return {
    events: events.map((e) => ({ event: e.event, spec: e.spec, home: e.home.pair, away: e.away.pair })),
    slots: { home: slotsFor('home'), away: slotsFor('away') },
  };
}

// Resolve a handwritten team name from the card header ("Mella A", "MEBC A")
// to a DB team row. Tries full-string similarity, containment, and an
// initials heuristic ("MEBC A" ~ initials of "Manchester Edgeley A" + suffix).
// Returns { id, name, division, score } or null when nothing is close enough.
const TEAM_MATCH_THRESHOLD = 0.55;

function matchTeamName(raw, teams) {
  const n = normalise(raw);
  if (!n) return null;
  let best = null;
  for (const t of teams || []) {
    const tn = normalise(t.name);
    if (!tn) continue;
    let score = sim(n, tn);
    if (tn.includes(n) || n.includes(tn)) score = Math.max(score, 0.9 * Math.min(n.length, tn.length) / Math.max(n.length, tn.length) + 0.1);
    const initials = normalise(String(t.name).trim().split(/\s+/).map((w) => w[0]).join(''));
    if (initials.length >= 3) score = Math.max(score, 0.95 * sim(n, initials));
    if (!best || score > best.score) best = { team: t, score };
  }
  return best && best.score >= TEAM_MATCH_THRESHOLD
    ? { id: best.team.id, name: best.team.name, division: best.team.division, score: +best.score.toFixed(3) }
    : null;
}

module.exports = { matchScorecard, matchPair, matchTeamName, scoreCandidate, tokenise, normalise, MATCH_THRESHOLD };
