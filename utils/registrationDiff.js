// Cross-referencing a club's returned registration form against what the database
// currently says, and turning the difference into a reviewable list of changes.
//
// Pure: no database, no HTTP. Everything it needs is passed in, so it can be tested
// against real documents without a connection — the same shape as
// utils/scorecardExtraction.js and utils/scorecardMatch.js.
//
// WHAT THE FORM ENCODES, AND HOW IT MAPS ONTO THE DATABASE
//
// The form gives each player a name, a gender column, and a letter. The letter is either
// a team letter ('A', 'B', …) or 'R' for reserve. The database stores the same facts as
// `player.team` (a team id) and `player.rank` (99 for a reserve, otherwise the player's
// position in that team-and-gender's order). So:
//
//   nominated:  team = the team whose name ends in that letter
//               rank = the player's position among nominated players of the same gender
//                      in the same team, IN DOCUMENT ORDER. The row order IS the order —
//                      that is what "changes in order" means on this form.
//   reserve:    rank = 99, and team = the team block the player is listed UNDER, because
//               a reserve still belongs to a team in the database. The .docx writes 'R'
//               in the letter column and so does not name the team; the block heading is
//               the only place that information exists.
//
// WHY MATCHING IS THE HARD PART
//
// A form gives a display name typed by a captain, and that has to become a player id.
// Three facts about the real data shape this:
//
//   - 8 display names in the player table are not unique, and at least one collision is
//     live: "Ryan Rigby" appears twice and is on a returned form. So a name can match two
//     real people, and the answer has to be "ask", never "pick the first".
//   - 486 of 1,138 players sit at the placeholder club "No Club" and 196 have no club row
//     at all, against 456 actually registered. A name that is not in the club's current
//     roster is therefore MORE likely to be a dormant existing player than a new one, so
//     the search has to cover everyone before concluding "new".
//   - A name that resolves to a player at a *different* club is a transfer, and those are
//     never applied automatically: a fuzzy match against 1,138 people is exactly where a
//     typo could move somebody between clubs.
//
// Every change comes out with a `kind`, and the caller decides which kinds may be ticked.

const { scoreCandidate, tokenise, normalise } = require('./scorecardMatch');

// A reserve's rank. Matches documentsController's own test (`Number(r.rank) !== 99`).
const RESERVE_RANK = 99;

// Fuzzy threshold for a *typed* name, deliberately much higher than
// scorecardMatch.MATCH_THRESHOLD (0.55), which is tuned for handwriting read by OCR.
// A captain typing into Word makes spelling slips ("Holcome"/"Holcombe"), not the
// character-level noise a camera produces, so anything below this is not a near-miss
// worth auto-proposing — it is a different person.
const TYPED_MATCH_THRESHOLD = 0.82;

// Two names are "the same" if their letters match once case, accents, spacing and
// punctuation are removed. This is the cheap pass that resolves the overwhelming
// majority, because most of the form was generated from these very rows.
const nameKey = (first, family) => normalise(first) + '|' + normalise(family);
const displayKey = (name) => {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return normalise(name) + '|';
  // Everything after the first token is the family name — "Sandeep Modaboyina",
  // "Billu Chaudhury", and the double-barrelled ones all behave.
  return normalise(parts[0]) + '|' + normalise(parts.slice(1).join(''));
};

const playerLabel = (p) =>
  `${String(p.first_name || '').trim()} ${String(p.family_name || '').trim()}`.replace(/\s+/g, ' ').trim();

// Team name -> its distinguishing letter, the same rule the form generator uses.
const teamLetter = (name) => String(name || '').trim().slice(-1).toUpperCase();

/**
 * Resolve one form entry to a player, searching a preferred pool first.
 * Returns { player, score, exact, candidates } — candidates is populated only when the
 * answer is ambiguous, so the caller can offer a choice instead of a guess.
 */
function resolveEntry(entry, pools) {
  const key = displayKey(entry.name);
  const tokens = tokenise(entry.name);

  for (const pool of pools) {
    // Gender is a hard filter, not a score component: the form states it by column, the
    // database stores it, and a man cannot fill a ladies slot. It also halves the search.
    const eligible = pool.players.filter(p => p.gender === entry.gender);

    const exact = eligible.filter(p => nameKey(p.first_name, p.family_name) === key);
    if (exact.length === 1) return { player: exact[0], score: 1, exact: true, pool: pool.name };
    if (exact.length > 1) {
      // The live "Ryan Rigby" case. Two real people, identical names, same gender.
      return { player: null, score: 1, exact: true, pool: pool.name, candidates: exact };
    }

    const scored = eligible
      .map(p => ({ player: p, score: scoreCandidate(p, tokens) }))
      .filter(x => x.score >= TYPED_MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) continue;
    // A clear winner needs daylight over the runner-up; otherwise it is a choice, not a
    // match. Without this, two siblings in the same club silently become one of them.
    if (scored.length === 1 || scored[0].score - scored[1].score >= 0.06) {
      return { player: scored[0].player, score: scored[0].score, exact: false, pool: pool.name };
    }
    return {
      player: null, score: scored[0].score, exact: false, pool: pool.name,
      candidates: scored.slice(0, 5).map(x => x.player),
    };
  }
  return { player: null, score: 0, exact: false, candidates: [] };
}

/**
 * Build the reviewable change list.
 *
 * @param parsed  output of utils/registrationDoc
 * @param ctx.club        { id, name }
 * @param ctx.teams       [{ id, name }]              the club's teams
 * @param ctx.roster      [{ id, first_name, family_name, gender, team, teamName, rank }]
 * @param ctx.otherPlayers[{ id, first_name, family_name, gender, club, clubName, team, teamName }]
 *                        everyone NOT in this club — dormant players and other clubs'
 *                        players both, because a name absent from the roster is more often
 *                        a dormant player than a new one.
 */
function diffRegistration(parsed, ctx) {
  const changes = [];
  const warnings = [...(parsed.warnings || [])];

  const teamsByLetter = new Map();
  for (const t of ctx.teams || []) teamsByLetter.set(teamLetter(t.name), t);

  // The club named in the document versus the club being imported. A club sending the
  // wrong file is a normal accident and silently applying it would be the worst outcome
  // of the whole feature, so it is a warning on the review page rather than a hard stop —
  // the reviewer can see both names and decide.
  if (parsed.club && ctx.club && normalise(parsed.club) !== normalise(ctx.club.name)) {
    warnings.push(
      `The document says it is for "${parsed.club}" but you are importing it for "${ctx.club.name}".`);
  }

  const pools = [
    { name: 'club', players: ctx.roster || [] },
    { name: 'other', players: ctx.otherPlayers || [] },
  ];

  // Target rank per nominated entry: position within (team letter, gender), 1-based, in
  // document order. Computed up front so the change for each player can state its rank.
  const seatCounter = new Map();
  const withTargets = (parsed.entries || []).map((entry, entryIndex) => {
    const letter = entry.reserve ? (entry.block || entry.teamLetter) : entry.teamLetter;
    let rank;
    if (entry.reserve) {
      rank = RESERVE_RANK;
    } else {
      const k = `${letter}|${entry.gender}`;
      rank = (seatCounter.get(k) || 0) + 1;
      seatCounter.set(k, rank);
    }
    return { entry, entryIndex, letter, rank, team: letter ? teamsByLetter.get(letter) : undefined };
  });

  const matchedPlayerIds = new Set();
  // Candidates of an AMBIGUOUS entry. These must be held back from the removal sweep
  // below: the form does name this player, we just cannot tell which row is them. The
  // live case is Hyde, which holds two "Richard Jakeman" rows and two "Dave Lee" rows —
  // the same people entered twice, one row dormant. Without this, both rows of each pair
  // fall through to `remove`, and ticking them would park the real player at "No Club"
  // on the strength of a duplicate nobody has noticed yet.
  const claimedByAmbiguous = new Set();

  for (const { entry, entryIndex, letter, rank, team } of withTargets) {
    const resolved = resolveEntry(entry, pools);
    const base = {
      // Stable identifier for this change, so the review page can send back "apply these"
      // without sending back WHAT to apply. The apply route re-derives every change from
      // the stored document and the current database and then looks the key up — the
      // client never gets to say which team or rank a player should end up with. See
      // controllers/teamRegistrationController.js.
      key: 'e' + entryIndex,
      name: entry.name,
      gender: entry.gender,
      docLetter: entry.teamLetter,
      docReserve: entry.reserve,
      targetLetter: letter || null,
      targetRank: rank,
      targetTeamId: team ? team.id : null,
      targetTeamName: team ? team.name : null,
    };

    if (resolved.candidates && resolved.candidates.length) {
      resolved.candidates.forEach(p => claimedByAmbiguous.add(Number(p.id)));
      changes.push({ ...base, kind: 'ambiguous', player: null,
        candidates: resolved.candidates.map(p => ({
          id: Number(p.id), name: playerLabel(p),
          clubName: p.clubName || (ctx.club && ctx.club.name),
          teamName: p.teamName || null,
          rank: p.rank == null ? null : Number(p.rank),
        })),
        detail: `"${entry.name}" matches ${resolved.candidates.length} players — pick one.` });
      continue;
    }

    if (!resolved.player) {
      changes.push({ ...base, kind: 'new', player: null,
        detail: `"${entry.name}" is not in the database — would be added to ${base.targetTeamName || 'this club'}.` });
      continue;
    }

    const p = resolved.player;
    matchedPlayerIds.add(Number(p.id));
    const player = {
      id: Number(p.id), name: playerLabel(p), gender: p.gender,
      clubName: p.clubName || (ctx.club && ctx.club.name),
      teamId: p.team == null ? null : Number(p.team),
      teamName: p.teamName || null,
      rank: p.rank == null ? null : Number(p.rank),
    };
    const matchNote = resolved.exact ? null : `matched by name similarity (${resolved.score.toFixed(2)})`;

    // A team letter the club does not have. Applying this would need a new team, which is
    // a league-structure decision (/admin/teams), not a registration one.
    if (!team) {
      changes.push({ ...base, kind: 'no-such-team', player, matchNote,
        detail: `${player.name} is down for team "${letter || '?'}", which ${ctx.club ? ctx.club.name : 'this club'} does not have.` });
      continue;
    }

    // From another club: a transfer. Never applied automatically — see the header.
    if (resolved.pool === 'other' && p.club != null && p.clubName && p.clubName !== 'No Club') {
      changes.push({ ...base, kind: 'transfer', player, matchNote,
        detail: `${player.name} is currently registered to ${player.clubName}. Transfers are not applied from this screen.` });
      continue;
    }

    // A dormant player: in the database but parked at "No Club" or with no club at all.
    if (resolved.pool === 'other') {
      changes.push({ ...base, kind: 'reactivate', player, matchNote,
        detail: `${player.name} is an existing player with no current club — would join ${base.targetTeamName} as ${rank === RESERVE_RANK ? 'a reserve' : 'no. ' + rank}.` });
      continue;
    }

    // In the club already: what, if anything, moved?
    const teamChanged = player.teamId !== Number(team.id);
    const rankChanged = player.rank !== rank;
    const wasReserve = player.rank === RESERVE_RANK;
    const isReserve = rank === RESERVE_RANK;

    if (!teamChanged && !rankChanged) {
      changes.push({ ...base, kind: 'unchanged', player, matchNote, detail: null });
      continue;
    }
    if (teamChanged) {
      changes.push({ ...base, kind: 'team', player, matchNote,
        detail: `${player.name}: ${player.teamName || 'no team'} → ${team.name}` +
          (isReserve ? ' (reserve)' : `, no. ${rank}`) });
      continue;
    }
    if (wasReserve !== isReserve) {
      changes.push({ ...base, kind: 'reserve', player, matchNote,
        detail: isReserve
          ? `${player.name}: nominated no. ${player.rank} → reserve`
          : `${player.name}: reserve → nominated no. ${rank}` });
      continue;
    }
    changes.push({ ...base, kind: 'order', player, matchNote,
      detail: `${player.name}: no. ${player.rank} → no. ${rank} in ${team.name}` });
  }

  // Anyone on the books for this club who is not on the form. Surfaced as its own kind
  // rather than folded in with the rest: a club omitting a page is a normal accident, and
  // "we removed 30 players because a page was missing" is the failure mode to avoid — so
  // these are never pre-ticked in the review, and the count is shown prominently.
  //
  // "Remove" does NOT delete anybody. It parks the row at the placeholder club/team
  // ("No Club" / "No Team", rank 99), which is exactly what the existing team-admin
  // remove button already does and is fully reversible. That is also why 486 of the
  // 1,138 players in the table sit at "No Club": it is the league's archive, not a bin.
  for (const p of ctx.roster || []) {
    if (matchedPlayerIds.has(Number(p.id))) continue;
    if (claimedByAmbiguous.has(Number(p.id))) continue;
    changes.push({
      key: 'r' + Number(p.id),
      name: playerLabel(p), gender: p.gender,
      docLetter: null, docReserve: null,
      targetLetter: null, targetRank: null, targetTeamId: null, targetTeamName: null,
      kind: 'remove',
      player: {
        id: Number(p.id), name: playerLabel(p), gender: p.gender,
        clubName: ctx.club && ctx.club.name,
        teamId: p.team == null ? null : Number(p.team),
        teamName: p.teamName || null,
        rank: p.rank == null ? null : Number(p.rank),
      },
      matchNote: null,
      detail: `${playerLabel(p)} (${p.teamName || 'no team'}${Number(p.rank) === RESERVE_RANK ? ', reserve' : ', no. ' + p.rank}) is not on the form.`,
    });
  }

  const counts = {};
  for (const c of changes) counts[c.kind] = (counts[c.kind] || 0) + 1;

  return { club: parsed.club, source: parsed.source, changes, counts, warnings };
}

// Which kinds represent an actual write, and which are informational or need a human
// decision first. The apply route uses this rather than restating it, so a new kind
// cannot become silently applicable.
const APPLICABLE_KINDS = new Set(['order', 'team', 'reserve', 'reactivate', 'new', 'remove']);
const BLOCKED_KINDS = new Set(['unchanged', 'transfer', 'ambiguous', 'no-such-team']);

module.exports = {
  diffRegistration,
  resolveEntry,
  APPLICABLE_KINDS,
  BLOCKED_KINDS,
  RESERVE_RANK,
  TYPED_MATCH_THRESHOLD,
  teamLetter,
  displayKey,
};
