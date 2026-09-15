// URL paths for the social images, built in one place.
//
// These are the URLs Meta fetches. Two properties matter and neither is decoration.
//
// **Every segment is percent-encoded.** Almost every team name in this league contains a
// space — "Hyde A", "Alderley Park B" — and so does every division name ("Division 1").
// A raw space is not a legal URL character. Interpolated raw into the Graph API, Facebook
// answers `Missing or invalid image file (324, OAuthException)` and sends you looking for
// a bug in the endpoint, which is fine the whole time. `models/fixture.js` built these by
// string interpolation, twice, with no encoding at all.
//
// **Every URL ends `.jpg`.** Instagram inspects the bytes rather than the extension, so an
// extensionless URL is accepted and the suffix looks pointless — but then nothing upstream
// can tell a JPEG URL from a PNG one, and `utils/metaPublisher.js`'s format guard has to
// choose between crying wolf and being useless. A self-describing URL is what lets that
// guard stay strict. Instagram accepts JPEG and nothing else, and a PNG URL is the fault
// that stopped the Stockport league's weekly carousel working for its entire existence.
//
// The routes strip the extension before use, so a link filed before it existed still
// resolves.

function stripImageExt(value) {
  return String(value == null ? '' : value).replace(/\.jpe?g$/i, '');
}

function encodeSegments(parts) {
  return parts.map(p => encodeURIComponent(String(p == null ? '' : p))).join('/');
}

// /resultImage/:homeTeam/:awayTeam/:homeScore/:awayScore/:division.jpg
function resultImagePath(result) {
  return '/resultImage/' + encodeSegments([
    result.homeTeam, result.awayTeam,
    result.homeScore, result.awayScore,
    result.division,
  ]) + '.jpg';
}

// /league-table-image/:division.jpg
function leagueTableImagePath(divisionName) {
  return '/league-table-image/' + encodeSegments([divisionName]) + '.jpg';
}

module.exports = { resultImagePath, leagueTableImagePath, stripImageExt };
