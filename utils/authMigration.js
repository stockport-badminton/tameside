// Classifying Auth0 tenant accounts during the move of authorization onto the player
// table (migrations/player-auth-roles.sql).
//
// Pure functions, and committed rather than left in scripts/ (which is gitignored),
// because the rule below is the part worth keeping: it is shared by the one-off audit
// script and by the /admin/link-auth-accounts screen, and it encodes a finding that
// took a tenant dump to notice.
//
// The problem it solves: the Auth0 tenant is SHARED with the Stockport league site —
// same AUTH0_DOMAIN, two applications — so app_metadata is one record set read by both
// leagues. Deciding which role-holders are ours needs care.

// app_metadata keys this site reads. Everything else in the tenant belongs to the
// other site or to Auth0 itself (`betaAccess` gates login via an Auth0 Action;
// `messeradmin` and `team` are Stockport's; `league` is below).
const OUR_KEYS = ['role', 'club', 'stats'];

// Does this account carry any site-wide authorization for us to migrate?
function isRoleHolder(appMetadata) {
  const m = appMetadata || {};
  return !!(m.role || m.club || m.stats);
}

// Which league does this account belong to?
//
// Two independent signals, because measured against the live tenant neither is
// sufficient on its own:
//
//   club claim   naming a club this league has never heard of is conclusive, but it
//                misses anyone whose other-league club shares a name with one of ours
//                (College Green, Alderley Park and Disley all exist in both).
//   league key   authoritative when set, but it was set on only 51 of 203 accounts.
//
// Cross-referencing the two found 8 accounts saying league=stockport whose club also
// exists here. The club-name test alone would have granted all 8 Tameside admin.
//
// `ambiguous` marks exactly that overlap. Those are deliberately NOT auto-migrated and
// NOT silently dropped either — someone can legitimately hold a role in both leagues
// and `league` records only one, so it is a decision for a person.
function classifyLeague(appMetadata, ourClubNames) {
  const m = appMetadata || {};
  const club = m.club || null;
  const clubNotHere = !!(club && club !== 'All' && !ourClubNames.has(club));
  const saysOtherLeague = m.league === 'stockport';
  return {
    club,
    clubNotHere,
    saysOtherLeague,
    otherLeague: clubNotHere || saysOtherLeague,
    ambiguous: saysOtherLeague && !clubNotHere,
  };
}

// What this account's claims say its access should be, in the shape setAuthRole wants.
function targetFromClaims(appMetadata) {
  const m = appMetadata || {};
  return {
    role: m.role || null,
    statsAccess: !!m.stats,
  };
}

module.exports = { OUR_KEYS, isRoleHolder, classifyLeague, targetFromClaims };
