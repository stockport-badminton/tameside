// Badminton game-score rules (one game; scores are 0..30):
//   - the winner must reach at least 21
//   - the winning margin must be >= 2, EXCEPT at the 30 cap (30-29 is valid)
// Pure and numeric-safe (accepts numbers or numeric strings) so they can be
// unit-tested and reused by the express-validator chain in fixtureController.

// At least one side reached 21 (i.e. a valid winner exists).
function hasWinner(home, away) {
  return Number(home) >= 21 || Number(away) >= 21;
}

// Winning margin is >= 2, or a side hit the 30 cap (30-29 allowed).
function hasValidMargin(home, away) {
  home = Number(home);
  away = Number(away);
  return Math.abs(home - away) >= 2 || home === 30 || away === 30;
}

// Full single-game validity: both scores in 0..30, a winner, and a legal margin.
function isValidGameScore(home, away) {
  home = Number(home);
  away = Number(away);
  const inRange = (n) => Number.isInteger(n) && n >= 0 && n <= 30;
  return inRange(home) && inRange(away) && hasWinner(home, away) && hasValidMargin(home, away);
}

module.exports = { hasWinner, hasValidMargin, isValidGameScore };
