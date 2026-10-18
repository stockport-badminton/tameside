'use strict';

// Versioned asset URLs and the cache policy that goes with them. Ported from Stockport's
// utils/assets.js (league-site HARD-42, bb1c1b3 + 3c0c3f3), Oct 2026.
//
// tameside-badminton.co.uk is not served straight from Cloud Run: it resolves to Firebase
// Hosting, which proxies to this service and puts its CDN in front. That CDN honours our
// Cache-Control, a Cloud Run deploy does not clear it, and Firebase Hosting has no purge
// API at all. So the only safe long cache is one on a URL that changes when the file does.
//
// Before this, every /static and /scripts response carried a flat 30-day max-age. Fine
// for the few URLs that carried a hash, and wrong for every one that did not: main.js,
// the Bootstrap bundle it imports, and any image or script a view names by hand would sit
// stale at the CDN for up to a month after a deploy changed it.
//
// Now, per request:
//   ?v=<hash of the file this instance holds>  -> a year, immutable
//   ?v=<anything else>                         -> no-cache (see cacheControlFor)
//   no ?v=                                     -> an hour
//   runtime-generated images                   -> max-age=0
//
// Views call assetUrl('/static/...') (app.locals.assetUrl) and never build a versioned URL
// by hand. A path this module cannot resolve comes back unchanged, so a mistake lands on
// the hour-long cache rather than a year-long stale one.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// What /scripts serves. It used to be the whole of node_modules, which published every
// installed package's files; these are the only ones a page asks for.
//   bootstrap/dist  static/js/main.js imports the bundle on every page
//   ejs             client-side templates on the scorecard and player-form pages
//   jquery/dist     footer.ejs, on the pages that opt in with useJQuery
const VENDOR_DIRS = [
  'bootstrap/dist',
  'ejs',
  'jquery/dist'
];

const YEAR = 'public, max-age=31536000, immutable';
const HOUR = 'public, max-age=3600';
const NONE = 'public, max-age=0';

// Written at runtime by the social routes (and sw.js treats /static/generated/ the same
// way), so a held copy is a wrong copy.
const UNCACHED_PREFIXES = ['/static/images/generated/', '/static/generated/'];

// URL path -> absolute file, or null if it is not something the static mounts serve.
function resolve(urlPath) {
  let base, inner;
  if (urlPath.startsWith('/static/')) {
    base = path.join(ROOT, 'static');
    inner = urlPath.slice('/static/'.length);
  } else if (urlPath.startsWith('/scripts/')) {
    const rest = urlPath.slice('/scripts/'.length);
    const dir = VENDOR_DIRS.find((d) => rest.startsWith(d + '/'));
    if (!dir) return null;
    base = path.join(ROOT, 'node_modules', dir);
    inner = rest.slice(dir.length + 1);
  } else {
    return null;
  }
  let abs;
  try { abs = path.join(base, decodeURIComponent(inner)); } catch (e) { return null; }
  // path.join normalises `..`, so anything that climbed out of its own mount is not ours.
  if (!abs.startsWith(base + path.sep)) return null;
  return abs;
}

// Keyed on mtime and size so an edit during local development produces a new URL rather
// than an old URL holding new bytes. One stat per call is cheap against a page render.
const hashes = new Map();

function hashFor(urlPath) {
  const file = resolve(urlPath);
  if (!file) return null;
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return null; }
  if (!stat.isFile()) return null;
  const cached = hashes.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  hashes.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}

function assetUrl(urlPath) {
  const hash = hashFor(urlPath);
  if (!hash) {
    // Say so rather than failing silently; the page still renders, on the short cache.
    console.warn('assetUrl: could not hash', urlPath);
    return urlPath;
  }
  return urlPath + '?v=' + hash;
}

// The Cache-Control for a request to the static mounts.
//
// Immutable only when the version in the URL is the hash of the file THIS instance holds.
// During a deploy two revisions serve side by side for a few seconds, so a page from the
// new one can send its `?v=<new>` request to the old one. Without the comparison the old
// bytes would be stored at the CDN and in browsers under the new URL for a year.
function cacheControlFor(urlPath, version) {
  if (UNCACHED_PREFIXES.some((p) => urlPath.startsWith(p))) return NONE;
  if (version !== undefined) {
    return version === hashFor(urlPath) ? YEAR : 'no-cache';
  }
  return HOUR;
}

function isServedFile(urlPath) {
  const file = resolve(urlPath);
  if (!file) return false;
  try { return fs.statSync(file).isFile(); } catch (e) { return false; }
}

function cacheHeaders(req, res, next) {
  // Mounted at /static and /scripts, so req.path has the mount stripped off.
  const urlPath = req.baseUrl + req.path;
  // Only a file a static mount will actually serve. Anything else falls through to the
  // site's 404 page, which sets its own `private, no-store` — an hour's public max-age on
  // a missing URL would pin that 404 at the CDN past the deploy that adds the file
  // (Stockport saw exactly that, as an x-cache HIT, minutes after shipping this).
  if (!isServedFile(urlPath)) return next();
  const v = typeof req.query.v === 'string' ? req.query.v : undefined;
  res.set('Cache-Control', cacheControlFor(urlPath, v));
  next();
}

module.exports = { assetUrl, hashFor, resolve, cacheControlFor, cacheHeaders, VENDOR_DIRS };
