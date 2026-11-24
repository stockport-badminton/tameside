// POST /csp-report: where the browser sends CSP violations (utils/securityHeaders.js).
// Ported from Stockport's app.js handler (HARD-12).
//
// One line per violation to Cloud Logging, as structured JSON, so it can be counted:
//   jsonPayload.message =~ "csp-report:"   (or grep the text for `csp-report:`)
// Deliberately not Sentry: extension noise would spend the shared free tier in days.
//
// Public and unauthenticated by nature: the browser posts it with no cookie of ours that
// matters. This site has no rate limiter (CLAUDE.md, Spam and abuse controls), so the
// bounds are the 32kb body cap in app.js and MAX_PER_REQUEST below.

// The report is written by the visitor's browser, about a URL an attacker may have
// chosen, and ends up in a log. A control character in it could forge a log line.
function logSafe(value) {
  if (typeof value !== 'string') return '-';
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
}

// Extension-injected scripts violate any policy on any site and are not ours to fix.
// Left in, they are most of the volume and the reason a report-only period gets abandoned
// as noise. webkit-masked-url: is what Safari substitutes for one rather than naming it.
const IGNORED_SCHEMES = /^(?:(?:chrome|moz|safari|safari-web|ms-browser)-extension|webkit-masked-url|about):/i;

const MAX_PER_REQUEST = 20;

// Two wire formats are in the field at once: report-uri posts { "csp-report": {...} },
// the Reporting API (report-to) posts an array of { type, url, body }.
function parseReports(body) {
  if (Array.isArray(body)) {
    return body
      .filter((r) => r && r.type === 'csp-violation' && r.body)
      .map((r) => ({
        directive: r.body.effectiveDirective || r.body.violatedDirective,
        blocked: r.body.blockedURL,
        page: r.body.documentURL || r.url,
        source: r.body.sourceFile,
        disposition: r.body.disposition,
      }));
  }
  const r = body && body['csp-report'];
  if (!r || typeof r !== 'object') return [];
  return [{
    directive: r['effective-directive'] || r['violated-directive'],
    blocked: r['blocked-uri'],
    page: r['document-uri'],
    source: r['source-file'],
    disposition: r.disposition,
  }];
}

function receive(req, res) {
  // Answer first and unconditionally. There is nothing for the browser to do with the
  // answer, and an endpoint that can 4xx is a probe.
  res.status(204).end();

  parseReports(req.body)
    .filter((r) => !(typeof r.blocked === 'string' && IGNORED_SCHEMES.test(r.blocked)))
    .slice(0, MAX_PER_REQUEST)
    .forEach((r) => {
      const csp = {
        directive: logSafe(r.directive),
        blocked: logSafe(r.blocked),
        page: logSafe(r.page),
        source: logSafe(r.source),
        disposition: logSafe(r.disposition),
      };
      // A single-line JSON object on stdout becomes a structured jsonPayload in Cloud
      // Logging. console.warn, not console.error: nothing here is a server fault.
      console.warn(JSON.stringify({
        severity: 'WARNING',
        message: `csp-report: ${csp.directive} ${csp.blocked}`,
        csp,
      }));
    });
}

module.exports = { receive, parseReports, logSafe, IGNORED_SCHEMES, MAX_PER_REQUEST };
