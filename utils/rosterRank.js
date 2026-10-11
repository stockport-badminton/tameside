// What player.rank means, in one place.
//
//   1..n   nominated, numbered within (team, gender)
//   >= 99  reserve. The roster editor numbers reserves 99, 100, 101… so their order can be
//          saved; older rows all hold exactly 99, which is still a reserve.
//   NULL   unranked (a new player not yet placed) — treated as nominated, as it always was.
//
// Test `isReserve`, never `rank == 99`: the editor writes 100+, and a reader comparing to 99
// would quietly promote every reserve after the first. Pure, so the registration diff and the
// document builders can use it without touching the database.

const RESERVE_BASE = 99;

// rank arrives from postgres.js as a string ("99") as often as a number.
function isReserve(rank) {
  if (rank === null || rank === undefined || rank === '') return false;
  const n = Number(rank);
  return Number.isFinite(n) && n >= RESERVE_BASE;
}

module.exports = { RESERVE_BASE, isReserve };
