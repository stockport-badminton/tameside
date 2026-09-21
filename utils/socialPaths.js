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

// /fixtures-image/:division.jpg — one division's coming week.
//
// Same shape and the same two reasons as leagueTableImagePath above: both division names
// in this league contain a space, and the `.jpg` is what lets metaPublisher's format guard
// stay strict rather than having to guess from an extensionless URL.
function fixturesImagePath(divisionName) {
  return '/fixtures-image/' + encodeSegments([divisionName]) + '.jpg';
}

// /social-video/:aspect — the weekly results video, read back through our own domain.
//
// **No `.jpg` here, and the guard is a different one.** `assertPublishableVideo` only
// requires absolute https: Meta's video containers take an mp4 by fetch and there is no
// format rule to encode in the path.
//
// The object in S3 is private and stays that way — nothing grants public read, so a
// `https://<bucket>.s3.…` URL answers 403 to everyone including Meta. That was the whole
// of Stockport's HARD-21. `aspect` is an enum the route resolves against a fixed map;
// nothing a caller sends ever reaches an S3 `Key`. It is built here, like every other URL
// handed to a third party, so the route and the caller cannot disagree about it.
function socialVideoPath(aspect) {
  return '/social-video/' + encodeSegments([aspect]);
}

module.exports = {
  resultImagePath, leagueTableImagePath, fixturesImagePath, socialVideoPath, stripImageExt,
};
