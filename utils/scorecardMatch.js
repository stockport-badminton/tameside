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
//
// The form records every event from the 12 slots, by a fixed pattern (below), so a
// player in the right match but the wrong slot is recorded in the wrong events. The old
// assignment took Man 1/2 from Open A, Man 3/4 from Open B and the ladies from Ladies, then
// back-filled — so one misread in those three events moved a player for the whole card.
// Now every event votes: the side's 4 men and 2 ladies are the players read most often
// (then most strongly), and they are ordered to reproduce as many of the card's event
// pairings as the form can. Measured Oct 2026 over 273 cards: players recorded wrong per
// event 2093 -> 1551.
//
// SLOT_MIN_SCORE is the weakest name read that may fill a slot at all. A blank slot is a
// captain picking a name; a wrong one is a name they have to notice first, and often
// don't. 0.45 -> 0.55 measured: wrong 1551 -> 1044 for right 5820 -> 5670, i.e. about
// 3.4 wrong fills removed for every right one lost. (MATCH_THRESHOLD only sets the
// `confident` flag; changing it changes nothing that is filled in.)
const SLOT_MIN_SCORE = 0.55;

// Which events each slot plays in — the entry form's defaults (views/email-scorecard.ejs,
// the step list). Note home and away differ for Open C / Open D.
const SLOT_EVENTS = {
  home: {
    men: [['Open A', 'Mixed A', 'Open C'], ['Open A', 'Mixed B', 'Open C'], ['Open B', 'Mixed C', 'Open D'], ['Open B', 'Mixed D', 'Open D']],
    ladies: [['Ladies', 'Mixed A', 'Mixed C'], ['Ladies', 'Mixed B', 'Mixed D']],
  },
  away: {
    men: [['Open A', 'Mixed A', 'Open D'], ['Open A', 'Mixed B', 'Open D'], ['Open B', 'Mixed C', 'Open C'], ['Open B', 'Mixed D', 'Open C']],
    ladies: [['Ladies', 'Mixed A', 'Mixed C'], ['Ladies', 'Mixed B', 'Mixed D']],
  },
};

const permutations = (arr) => (arr.length <= 1
  ? [arr]
  : arr.flatMap((x, i) => permutations(arr.slice(0, i).concat(arr.slice(i + 1))).map((rest) => [x].concat(rest))));

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
    // scoreIn[event][playerId]: how strongly that player was read in that event.
    const scoreIn = {};
    const seen = {};
    for (const e of events) {
      scoreIn[e.event] = {};
      for (const c of e[side].pair) {
        if (!c || c.score < SLOT_MIN_SCORE) continue;
        scoreIn[e.event][c.id] = Math.max(scoreIn[e.event][c.id] || 0, c.score);
        const a = seen[c.id] = seen[c.id] || { c, n: 0, sum: 0 };
        a.n++; a.sum += c.score;
        if (c.score > a.c.score) a.c = c;
      }
    }
    const pick = (gender, count) => {
      const chosen = Object.values(seen).filter((a) => a.c.gender === gender)
        .sort((x, y) => y.n - x.n || y.sum - x.sum).slice(0, count).map((a) => a.c);
      while (chosen.length < count) chosen.push(null);
      return chosen;
    };
    // How much of what was read this order reproduces. 4! x 2! orders — trivially cheap.
    const fit = (order, slotEvents) => order.reduce((sum, c, i) =>
      sum + (c ? slotEvents[i].reduce((t, ev) => t + ((scoreIn[ev] && scoreIn[ev][c.id]) || 0), 0) : 0), 0);
    const bestOrder = (list, slotEvents) => {
      let best = list;
      let bestFit = fit(list, slotEvents);
      for (const perm of permutations(list)) {
        const f = fit(perm, slotEvents);
        if (f > bestFit + 1e-9) { best = perm; bestFit = f; }
      }
      return best;
    };
    return {
      men: bestOrder(pick('Male', 4), SLOT_EVENTS[side].men),
      ladies: bestOrder(pick('Female', 2), SLOT_EVENTS[side].ladies),
    };
  };

  const slots = { home: slotsFor('home'), away: slotsFor('away') };
  return {
    events: events.map((e) => ({ event: e.event, spec: e.spec, home: e.home.pair, away: e.away.pair })),
    slots,
    mixed: mixedPicks(extraction, slots, { home: homeRoster, away: awayRoster }),
  };
}

// Who actually played each Mixed event, where the card says otherwise than the form's
// default pairing (Man1+Lady1, Man2+Lady2, Man3+Lady1, Man4+Lady2). Only 323 of 570 sides
// in the Oct 2026 corpus used that pairing, so even perfect slots recorded 8% of
// event-players wrong.
//
// Each Mixed event's names are re-read against ONLY that side's six slot players — the
// per-event dropdowns offer nothing else — and a pick is made only when one candidate
// clearly wins (score >= 0.4 and 0.1 ahead of the next); otherwise null, and the wizard
// leaves the form's default. Measured on top of the slot changes: event-players wrong
// 1044 -> 867, right 5670 -> 5902.
const MIXED_MIN = 0.4;
const MIXED_MARGIN = 0.1;

function mixedPicks(extraction, slots, rosters) {
  const out = {};
  for (const e of extraction.events) {
    if (eventSpec(e.event) !== 'mixed') continue;
    out[e.event] = {};
    for (const side of ['home', 'away']) {
      const ids = new Set(slots[side].men.concat(slots[side].ladies).filter(Boolean).map((c) => String(c.id)));
      const pool = (rosters[side] || []).filter((p) => ids.has(String(p.id)));
      const tk = tokenise(e[side].playersRaw);
      const ranked = pool.map((p) => ({ id: p.id, gender: p.gender, score: scoreCandidate(p, tk) }))
        .sort((a, b) => b.score - a.score);
      const choose = (gender) => {
        const [first, second] = ranked.filter((c) => c.gender === gender);
        return first && first.score >= MIXED_MIN && (!second || first.score - second.score >= MIXED_MARGIN) ? first.id : null;
      };
      out[e.event][side] = { man: choose('Male'), lady: choose('Female') };
    }
  }
  return out;
}

// Resolve a handwritten team name from the card header ("Mella A", "MEBC A")
// to a DB team row. Tries full-string similarity, containment, word overlap
// ("EDGELEY A" shares a word with Manchester Edgeley A) and an initials
// heuristic ("MEBC A", "CG B"). Returns { id, name, division, score } or null
// when nothing is close enough — null is SAFER than a wrong team, because the
// wizard's rematch flow handles it (0.6: heuristic hits score 0.85+, and the
// old 0.55 floor let junk like "AYOEA" land on a real team by accident).
const TEAM_MATCH_THRESHOLD = 0.6;

function matchTeamName(raw, teams) {
  const [best, second] = teamScores(raw, teams);
  if (!best || best.score < TEAM_MATCH_THRESHOLD) return null;
  // Two teams of the same club within a whisker: the header named the club and not the
  // team ("AEROSPACE", "College Green"), and the letter rule below had nothing to go on.
  // Picking one is a coin toss between siblings, and a wrong sibling is worse than asking
  // — 7 of the 21 confidently wrong teams in the Oct 2026 corpus were exactly this.
  const sameClub = second && best.team.club != null && String(second.team.club) === String(best.team.club);
  if (sameClub && best.score - second.score < SIBLING_TIE) return null;
  return { id: best.team.id, name: best.team.name, division: best.team.division, score: +best.score.toFixed(3) };
}
const SIBLING_TIE = 0.05;

// The (home, away) fixture that best explains BOTH header readings, among the fixtures
// this card could be for — outstanding, and due within the week (the caller supplies
// them). Two team names read together are far more telling than either alone: "MEBC A"
// and "HYDE" are each ambiguous, but only one outstanding fixture fits both.
//
// Stockport's rule (league-site 2a6c9b4): each side read must match its team reasonably
// AND be no clearly worse than the best team on its own; a side that resembles no team at
// all is treated as unread; with one side unread, accept only when that side's team has a
// single candidate fixture. Measured Oct 2026 over 273 cards: both teams right 63% -> 79%,
// and against the rosters of the time 69% -> 86% with any-wrong 4.4% -> 1.8%.
//
// candidates: [{ id, date, home: teamRow, away: teamRow }]. Returns one of them, or null.
const FIXTURE_FLOOR = 0.5;
const FIXTURE_MARGIN = 0.05;

function matchFixturePair(homeRaw, awayRaw, candidates, teams) {
  if (!candidates || !candidates.length) return null;
  const against = (raw, team) => { const r = teamScores(raw, [team])[0]; return r ? r.score : 0; };
  const alone = (raw) => { const r = teamScores(raw, teams)[0]; return r ? r.score : 0; };
  let h = normalise(homeRaw) ? homeRaw : '';
  let a = normalise(awayRaw) ? awayRaw : '';
  const soloH = h ? alone(h) : 0;
  const soloA = a ? alone(a) : 0;
  if (soloH < FIXTURE_FLOOR) h = '';
  if (soloA < FIXTURE_FLOOR) a = '';
  if (!h && !a) return null;

  let best = null;
  let bestScore = -1;
  for (const f of candidates) {
    const score = (h ? against(h, f.home) : 0) + (a ? against(a, f.away) : 0);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  const fits = (raw, team, solo) => !raw
    || (against(raw, team) >= FIXTURE_FLOOR && against(raw, team) >= solo - FIXTURE_MARGIN);
  if (!fits(h, best.home, soloH) || !fits(a, best.away, soloA)) return null;
  if (!(h && a)) {
    const side = h ? 'home' : 'away';
    if (candidates.filter((f) => String(f[side].id) === String(best[side].id)).length > 1) return null;
  }
  return best;
}

// Every team scored against a handwritten name, best first.
function teamScores(raw, teams) {
  const n = normalise(raw);
  if (!n) return [];
  const all = [];
  const rawWords = String(raw).trim().split(/\s+/).map(normalise).filter(Boolean);
  for (const t of teams || []) {
    const tn = normalise(t.name);
    if (!tn) continue;
    const teamWords = String(t.name).trim().split(/\s+/).map(normalise).filter(Boolean);
    let score = sim(n, tn);
    if (tn.includes(n) || n.includes(tn)) score = Math.max(score, 0.9 * Math.min(n.length, tn.length) / Math.max(n.length, tn.length) + 0.1);
    // Word subset: every word of the DB name appears in the raw text — covers
    // renames like "Hyde High B" (old key/card) -> "Hyde B" (current team).
    if (teamWords.length && teamWords.every((w) => rawWords.includes(w))) score = Math.max(score, 0.92);
    // Shared distinctive word: the header often carries just one word of the
    // club name ("EDGELEY A" for Manchester Edgeley A) — a 4+ letter word in
    // common is a strong signal, and the suffix rule below arbitrates between
    // sibling teams of the same club.
    if (teamWords.some((w) => w.length >= 4 && rawWords.includes(w))) score = Math.max(score, 0.85);
    // Initials of the DB name ("MEBC A" ~ Manchester Edgeley..., "CG A" ~
    // College Green A). Also try initials of just the club words + the team
    // letter kept whole ("CG" + "A"), the common shorthand.
    const initials = normalise(teamWords.map((w) => w[0]).join(''));
    if (initials.length >= 3) score = Math.max(score, 0.95 * sim(n, initials));
    if (teamWords.length >= 2) {
      const last = teamWords[teamWords.length - 1];
      const clubInitials = teamWords.slice(0, -1).map((w) => w[0]).join('') + last;
      if (clubInitials.length >= 2) score = Math.max(score, 0.95 * sim(n, clubInitials));
    }
    // The team letter is the strongest single signal: when both the raw text
    // and the DB name end in a single letter, a mismatch ("CGBC A" vs
    // "College Green B") is almost certainly the wrong team. And when the
    // team's suffix word doesn't appear in the raw text AT ALL (Vision
    // mangled it away — "AYOEA" for "HYDE A"), confidence drops: a wrong
    // sibling team is worse than a null, which triggers the rematch flow.
    const rawLast = rawWords[rawWords.length - 1];
    const teamLast = teamWords[teamWords.length - 1];
    if (rawLast && teamLast && rawLast.length === 1 && teamLast.length === 1) {
      score = rawLast === teamLast ? score + 0.03 : score * 0.4;
    } else if (teamLast && teamLast.length <= 2 && !rawWords.includes(teamLast)) {
      score *= 0.85;
    }
    // Tiny full-similarity tie-break so equal heuristic scores ("Syde Park
    // Park" hits the shared word 'park' for two different clubs) resolve to
    // the closer overall name.
    score += 0.04 * sim(n, tn);
    all.push({ team: t, score });
  }
  return all.sort((x, y) => y.score - x.score);
}

module.exports = { matchFixturePair, teamScores, matchScorecard, matchPair, matchTeamName, scoreCandidate, tokenise, normalise, MATCH_THRESHOLD };
