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
// other site or to Auth0 itself: `betaAccess` gates login via an Auth0 Action,
// `messeradmin` and `team` are Stockport's, and `league` is explained below.
const OUR_KEYS = ['role', 'club', 'stats'];

// `league` ('stockport' | 'tameside', set on 51 of 203 accounts) is NOT an
// authorization signal and is deliberately not consulted here.
//
// It was an attempt to record which league's site someone signed up on, in the hope of
// differentiating their experience later. It never got used for that, it was never
// applied consistently, and it says nothing about who administers what — a person can
// sign up on one site and run a team in the other.
//
// It was briefly treated as a league discriminator during this migration, which held
// back 8 genuine Tameside admins whose accounts happened to carry `league=stockport`.
// Now that both sites take access from their own database, the club claim is the only
// thing worth asking. Left in the tenant as the historical tracking data it is.

// Does this account carry any site-wide authorization for us to migrate?
function isRoleHolder(appMetadata) {
  const m = appMetadata || {};
  return !!(m.role || m.club || m.stats);
}

// Which league does this account's authorization belong to?
//
// One signal: does the club it claims to administer exist in this league? An admin
// claim over a club we have never heard of cannot mean anything here, and a claim over
// one we do have is ours to honour. `club === 'All'` is the superadmin sentinel and is
// not a club name.
//
// This is deliberately the *only* test. See the note on `league` above for the signal
// that was tried alongside it and removed.
function classifyLeague(appMetadata, ourClubNames) {
  const m = appMetadata || {};
  const club = m.club || null;
  const clubNotHere = !!(club && club !== 'All' && !ourClubNames.has(club));
  return {
    club,
    clubNotHere,
    otherLeague: clubNotHere,
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
