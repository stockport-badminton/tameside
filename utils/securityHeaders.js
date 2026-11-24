// Security response headers. Ported from Stockport's HARD-12 (league-site
// utils/securityHeaders.js): the helmet headers and enforced baseline landed 4 Nov 2026,
// the resource allowlist 24 Nov 2026 (backlog row 2).
//
// app.js wires this up. This file holds the reasons, so read it before changing anything.
//
// ---------------------------------------------------------------------------
// Two CSP headers, deliberately
// ---------------------------------------------------------------------------
//
// A CSP can break a page it never touched, and it fails silently: an empty dropdown, a
// map that never draws, nothing in the server log. So the directives are split by whether
// getting them wrong can blank a page:
//
//   ENFORCED  no resource allowlist at all. None of these directives names a source of
//             scripts, styles or images, so they cannot stop a page loading something
//             it legitimately loads.
//
//   OBSERVED  the full allowlist, sent as Content-Security-Policy-Report-Only.
//             Violations are posted to /csp-report and logged; nothing is blocked.
//
// CSP_ENFORCE=true merges OBSERVED into the enforced header and drops the report-only
// one. Reporting stays on the enforced header, because once it enforces a report is the
// only way a blocked resource shows up at all. Unset it to roll back: one redeploy.
//
// ---------------------------------------------------------------------------
// Before setting CSP_ENFORCE=true
// ---------------------------------------------------------------------------
//
// All four, or the flip is a guess. They are also the checklist for any later change to
// the allowlist once it enforces, since a wrong entry then blocks rather than reports.
//
// 1. Reports are arriving. grep Cloud Logging for `csp-report:`. A quiet week with no
//    collector is no evidence.
// 2. A full week including a Tuesday and a Wednesday, the league nights, when captains
//    use the scorecard wizard for real. AND at least one real photo upload with no
//    connect-src report naming the bucket: the browser PUTs the photo straight to S3,
//    which Playwright cannot exercise (its suite is read-only by design).
// 3. Someone has visited the pages real traffic will not reach on its own. Routes, not
//    view names (Stockport's list named templates and sent someone hunting for pages that
//    don't exist). A page with no reports may be clean or unvisited; check the request
//    log for hits AFTER the last policy change before reading anything into silence.
//
//      /admin/homepage-content/<id>    Quill, and its redirect to jsDelivr (style-src)
//      /fixture-gen                    write-excel-file from jsDelivr (the Excel export)
//      /elo-chart, /playerStats/<id>/… Chart.js from jsDelivr
//      /event/<id>/…, map opened       Google Maps + Places (the map loads on tap)
//      /club/<id>, map + contact form  Google Maps, reCAPTCHA
//      /contact-us                     reCAPTCHA
//      /admin/social/weekly-video      the <video> preview
//      /email-scorecard with a PDF     the blob: PDF preview iframe, the data: preview
//
// 4. `CSP_ENFORCE=true npm run test:e2e` passes (playwright.config.js passes the variable
//    through to the server it starts).
//
//    Met 24 Nov 2026: 65 passed, zero violations. It was 53/12 before client-side EJS
//    went: the scorecard pages built their <option> lists with ejs.render IN THE
//    BROWSER, which compiles with `new Function` and needs 'unsafe-eval', so every
//    wizard spec timed out on an empty team dropdown. static/js/form-options.js builds
//    them with DOM calls instead (as Stockport's 9e6f2df did), and /scripts no longer
//    serves ejs. 'unsafe-eval' was never the fix and must not be added: alongside
//    'unsafe-inline' it would leave script-src constraining only where scripts load from.
//
// What enforcing would and would not buy: it stops a script loading from a host not on
// the list. It does NOT stop an injected inline script, because 'unsafe-inline' has to
// stay while views/ carries ~86 inline on*= handlers. Removing those is a separate job
// (Stockport's HARD-15). This policy is defence in depth, not an XSS fix.

// ---------------------------------------------------------------------------
// Enforced now
// ---------------------------------------------------------------------------
function baseline() {
  return {
    // Clickjacking: today the site can be framed by anyone. Our only frames are our own:
    // the missed-three email preview (same-origin) and the PDF previews on the scorecard
    // pages, which are blob: documents and carry no header of ours. helmet sends
    // X-Frame-Options: SAMEORIGIN alongside, for browsers that predate frame-ancestors.
    // (frame-ancestors is ignored in a report-only header, so it has to live here.)
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
  };
}

// ---------------------------------------------------------------------------
// Observed (report-only): the resource allowlist
// ---------------------------------------------------------------------------
//
// Every entry is here because a named template loads it. Keep the comment with the host:
// it is the only thing that stops an entry being deleted, or duplicated, later.
// Bootstrap, jQuery, DataTables, the fonts and the icons are all self-hosted ('self').
function allowlist() {
  return {
    'default-src': ["'self'"],

    'script-src': [
      "'self'",
      // Not a shortcut: ~86 inline on*= handlers across 12 views and inline <script>
      // blocks in ~26 (the Sentry and PostHog loaders, the scorecard wizard, the Maps
      // bootstrap). A nonce does not help: with a nonce present the browser IGNORES
      // 'unsafe-inline', which kills every attribute handler, and a handler cannot carry
      // a nonce. Removing them is Stockport's HARD-15, a separate job.
      "'unsafe-inline'",
      // NOT 'unsafe-eval'. See check 4 above.

      'https://js-de.sentry-cdn.com',    // header.ejs: the browser Sentry loader
      'https://browser.sentry-cdn.com',  // what that loader fetches, and every
                                         // Sentry.lazyLoadIntegration call
      'https://eu-assets.i.posthog.com', // header.ejs: PostHog's array.js and the session
                                         // recorder it lazy-loads. Injected at runtime, so
                                         // there is no <script src> to grep for.
      'https://cdn.jsdelivr.net',        // elo-chart.ejs, player-game-stats.ejs (Chart.js
                                         // and its date adapter); fixtures-gen.ejs
                                         // (write-excel-file); and where cdn.quilljs.com
                                         // redirects (below)
      'https://cdn.quilljs.com',         // admin/homepage-content-form.ejs: Quill
      'https://www.google.com',          // contact-us-form.ejs, club.ejs: reCAPTCHA
      'https://www.gstatic.com',         // what reCAPTCHA loads next
      'https://maps.googleapis.com',     // club.ejs directly; viewEventDetails.ejs through
                                         // the inline importLibrary bootstrap
      'https://maps.gstatic.com',        // what the Maps API loads next
    ],

    'style-src': [
      "'self'",
      // style="" attributes and <style> blocks throughout (webfonts.ejs's @font-face
      // among them). Same reasoning as script-src.
      "'unsafe-inline'",
      'https://cdn.quilljs.com',      // admin/homepage-content-form.ejs: quill.snow.css
      // **cdn.quilljs.com 301s to cdn.jsdelivr.net, and CSP checks every hop of a
      // redirect.** The browser reports the PRE-redirect URL (it will not leak the chain),
      // so a missing jsdelivr here shows up as a violation naming cdn.quilljs.com, a host
      // that is right there in the list. Found by Stockport, 3 Sep 2026.
      'https://cdn.jsdelivr.net',
      // Not linked by any template: the Maps JS API injects a Roboto stylesheet at
      // runtime. Our own fonts are self-hosted (webfonts.ejs).
      'https://fonts.googleapis.com',
    ],

    'font-src': [
      "'self'",                    // Inter and Poppins, static/fonts/
      'data:',                     // DataTables and Quill inline small faces
      'https://fonts.gstatic.com', // the Roboto files the Maps stylesheet then wants
    ],

    'img-src': [
      "'self'",
      'data:',  // the document-scorecard preview (/scorecard-document/convert answers a
                // data: url) and inline SVG backgrounds
      'blob:',  // URL.createObjectURL previews of a photo before upload
                // (email-scorecard.ejs, static/js/scorecard-photo-replace.js)
      // Deliberately open, the one directive that is: homepage_content.image_url is any
      // URL an admin pastes, the event pages use Cloudinary, Maps draws tiles from several
      // Google hosts, Auth0 hands back avatars. Images are the lowest-value vector here.
      'https:',
    ],

    'connect-src': [
      "'self'",
      'https://*.ingest.de.sentry.io',     // the DSN in header.ejs
      'https://browser.sentry-cdn.com',
      'https://eu.i.posthog.com',          // PostHog events and session recordings
      'https://eu-assets.i.posthog.com',   // and its remote config
      'https://maps.googleapis.com',
      'https://places.googleapis.com',     // the Places lookup on /event/ pages; a
                                           // different host from maps.googleapis.com
      'https://www.google.com',            // reCAPTCHA fetches too, and connect-src is a
                                           // separate list from script-src and frame-src
      // **The scorecard photo is PUT straight from the browser to the presigned URL**
      // (email-scorecard.ejs, static/js/scorecard-upload.js). Block this and photo upload
      // fails on the page captains use. Derived from S3_BUCKET_NAME so it follows the
      // bucket; both host spellings because the SDK and the archive use both
      // (utils/scorecardPhoto.js).
      ...bucketHosts(),
    ],

    'frame-src': [
      "'self'",  // admin/missed-three-notice.ejs: the email preview
      // **Ours, not Stockport's.** The PDF previews (email-scorecard.ejs #scoresheet-pdf,
      // populated-scorecard.ejs #replace-photo-pdf) point an <iframe> at
      // URL.createObjectURL(file), i.e. a blob: URL. Without it the captain sees an empty
      // frame and cannot tell which card they attached.
      'blob:',
      // reCAPTCHA creates its iframes at runtime; no <iframe> in any template.
      'https://www.google.com',
      'https://recaptcha.google.com',
    ],

    'worker-src': ["'self'"],   // /sw.js, registered by pwa-head.ejs
    'manifest-src': ["'self'"], // /manifest.json
    'media-src': ["'self'"],    // admin/weekly-video-preview.ejs: /social-video/:aspect
  };
}

function bucketHosts() {
  const bucket = String(process.env.S3_BUCKET_NAME || '').trim();
  if (!bucket) return [];
  return [
    `https://${bucket}.s3.eu-west-1.amazonaws.com`,
    `https://${bucket}.s3-eu-west-1.amazonaws.com`,
  ];
}

// ---------------------------------------------------------------------------
// Where reports go
// ---------------------------------------------------------------------------
//
// Our own /csp-report (controllers/cspReportController.js), which writes one greppable
// line per violation to Cloud Logging. Not Sentry: browser extensions inject scripts into
// pages constantly, each one a violation, and the free tier is shared with Stockport.
//
// CSP_REPORT_URI overrides it; CSP_REPORT_URI='' emits no reporting directives at all.
const REPORT_PATH = '/csp-report';
const REPORT_GROUP = 'csp-endpoint';

function reportUri() {
  const v = process.env.CSP_REPORT_URI;
  return v === undefined ? REPORT_PATH : v;
}

function isEnforcing() {
  return process.env.CSP_ENFORCE === 'true';
}

// report-uri is deprecated but is the only one Firefox and Safari implement; report-to
// (with the Reporting-Endpoints header) is the only one current Chrome honours. Both, or
// half the visitors report nothing.
function reportingDirectives() {
  const uri = reportUri();
  if (!uri) return {};
  return { 'report-uri': [uri], 'report-to': [REPORT_GROUP] };
}

function reportingEndpointsHeader() {
  const uri = reportUri();
  return uri ? `${REPORT_GROUP}="${uri}"` : null;
}

// The baseline carries no reporting while the allowlist is report-only: a violation of
// frame-ancestors or form-action is an attack in progress rather than something to tune,
// and doubling every report is noise. When enforcing, the two merge and reporting comes
// with them.
function enforcedDirectives() {
  if (isEnforcing()) return { ...baseline(), ...allowlist(), ...reportingDirectives() };
  return {
    ...baseline(),
    // helmet refuses a policy with no default-src unless told so explicitly. Here that
    // absence is the whole point: with one, every CDN resource the site loads would be
    // blocked for real visitors.
    'default-src': require('helmet').contentSecurityPolicy.dangerouslyDisableDefaultSrc,
  };
}

function observedDirectives() {
  return isEnforcing() ? null : { ...allowlist(), ...reportingDirectives() };
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

module.exports = {
  baseline,
  allowlist,
  REPORT_PATH,
  REPORT_GROUP,
  reportUri,
  isEnforcing,
  enforcedDirectives,
  observedDirectives,
  reportingEndpointsHeader,
  strictTransportSecurity,
  HSTS_MAX_AGE,
};
