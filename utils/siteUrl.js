// The site's own public address, for anything that has to be an ABSOLUTE url —
// links in emails, `rel=canonical`, the Auth0 logout returnTo, webhook payloads.
//
// NEVER build one of those from `req.headers.host` / `req.get('host')`.
//
// tameside-badminton.co.uk resolves to Firebase Hosting, which proxies to Cloud Run —
// and it REWRITES the Host header to the Cloud Run hostname on the way through. Verified
// by experiment: a request sent to `https://tameside-badminton.co.uk/hostprobe-…` was
// recorded by Cloud Run as `https://tameside-site-p6gfjwl72q-nw.a.run.app/hostprobe-…`.
// So in production `req.headers.host` is *always* `…a.run.app` and never the domain the
// visitor actually typed. There is no way to recover it from the request.
//
// WHAT THAT BROKE. The scorecard email built its links from req.headers.host, so the
// results secretary got `https://tameside-site-…a.run.app/populated-scorecard-beta/2164`
// and `…/scorecard-photo/2164`. Clicking one lands the browser on the run.app origin,
// and then:
//
//   1. `secured` stores `returnTo` and sets the `__session` cookie — for *.a.run.app.
//   2. /login sends you to Auth0, whose callback is configured (correctly) as
//      https://tameside-badminton.co.uk/callback.
//   3. Auth0 returns the browser to the .co.uk origin, which is a DIFFERENT COOKIE JAR.
//      The run.app session cookie is not sent, so passport finds no OAuth state and
//      `returnTo` is gone.
//   4. The callback's `|| '/'` fallback fires: you are logged in, on the homepage,
//      having asked for a scorecard.
//
// That is the "drops me on the homepage, or forces a login which then drops me on the
// homepage" report, and no session store can fix it — the two origins cannot share a
// cookie. The fix is to never emit a run.app link in the first place.
//
// The `.replace('.com', '.co.uk')` chains dotted around the canonical-url code were
// earlier attempts at patching the same thing, and they never worked on a run.app host
// because there is no `.com` in it to replace.

// Deliberately NOT derived from the request. `SITE_URL` lets it move without a code
// change (a staging host, or a domain change) and the default is the live domain, so
// forgetting to set it cannot produce a run.app link.
const DEFAULT_SITE_URL = 'https://tameside-badminton.co.uk';

function siteUrl() {
  const configured = String(process.env.SITE_URL || '').trim();
  if (!configured) return DEFAULT_SITE_URL;
  // Tolerate a trailing slash or a bare hostname in the env var.
  const withScheme = /^https?:\/\//i.test(configured) ? configured : 'https://' + configured;
  return withScheme.replace(/\/+$/, '');
}

// siteUrl() + path. Accepts a path with or without its leading slash, and refuses to
// build anything from an absolute url handed in by mistake.
function absoluteUrl(pathname) {
  const p = String(pathname == null ? '' : pathname);
  if (/^https?:\/\//i.test(p)) return p;
  return siteUrl() + (p.startsWith('/') ? p : '/' + p);
}

// For `rel=canonical`. Uses req.originalUrl for the PATH only — the host comes from the
// configuration, which is the whole point.
function canonicalFor(req) {
  return absoluteUrl((req && req.originalUrl) || '/');
}

module.exports = { siteUrl, absoluteUrl, canonicalFor, DEFAULT_SITE_URL };
