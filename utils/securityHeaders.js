// Security response headers (backlog #3). Ported from Stockport's HARD-12
// (league-site utils/securityHeaders.js), minus the resource allowlist.
//
// Stockport ships two CSP headers: an enforced baseline with no resource allowlist, and
// the full allowlist, which ran report-only for a fortnight before being enforced. This
// is the first half only. The baseline cannot blank a page, because none of its
// directives names a source of scripts, styles or images. The allowlist is the half that
// can break the scorecard wizard while captains are filing results. It needs its own
// report-only period and a /csp-report collector, so it is a separate job.
//
// app.js wires this up. This file holds the reasons, so read it before changing anything.

// ---------------------------------------------------------------------------
// The enforced CSP baseline
// ---------------------------------------------------------------------------
function enforcedDirectives() {
  return {
    // Clickjacking: today the site can be framed by anyone. Our only frames are our own:
    // the missed-three email preview (same-origin) and the PDF previews on the scorecard
    // pages, which are blob: documents and carry no header of ours. helmet sends
    // X-Frame-Options: SAMEORIGIN alongside, for browsers that predate frame-ancestors.
    'frame-ancestors': ["'self'"],

    // No template has a <base> tag. An injected one would silently re-point every
    // relative URL on the page, /scripts/... included.
    'base-uri': ["'self'"],

    // No <object>, <embed> or <applet> anywhere in views/.
    'object-src': ["'none'"],

    // Every <form action> in views/ is same-origin. **The Auth0 domain is here as well,
    // and Stockport's copy does not have it.** Chrome checks form-action on every
    // redirect a submission follows, not just the first request. A POST to a `secured`
    // route with an expired session goes to /login and then to Auth0, so without it an
    // admin who left a form open overnight would submit into a blocked-page error
    // instead of the login.
    'form-action': ["'self'", `https://${process.env.AUTH0_DOMAIN}`],

    // helmet refuses a policy with no default-src unless told so explicitly. Here that
    // absence is the whole point: with a default-src, every CDN resource the site loads
    // would be blocked for real visitors from the moment this deploys.
    'default-src': require('helmet').contentSecurityPolicy.dangerouslyDisableDefaultSrc,
  };
}

// ---------------------------------------------------------------------------
// HSTS
// ---------------------------------------------------------------------------
//
// Firebase Hosting already sends `max-age=31556926` on tameside-badminton.co.uk. This
// covers the run.app hostname as well, and stops the header depending on the proxy.
//
// No `includeSubDomains`: it commits every subdomain to HTTPS for a year, and a browser
// that has seen it keeps honouring it whatever we serve afterwards. Nobody has checked
// what runs on the subdomains. No `preload` either: that is a submission to a browser
// vendor's list, and slow to reverse.
const HSTS_MAX_AGE = 31536000; // one year

function strictTransportSecurity() {
  return { maxAge: HSTS_MAX_AGE, includeSubDomains: false, preload: false };
}

module.exports = { enforcedDirectives, strictTransportSecurity, HSTS_MAX_AGE };
