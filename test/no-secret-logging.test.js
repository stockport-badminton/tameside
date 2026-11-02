const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// stdout is Cloud Logging, readable by anyone with log access to the project and kept for
// 30 days. Until Nov 2026 it held a presigned S3 PUT url on every upload (access key id
// plus a live write signature) and the whole Auth0 profile — email, identities, role
// claims — on every login and on every results page a logged-in user opened. Each was a
// one-line debug log, which is exactly the kind of thing that comes back by copy-paste,
// so this is a source assertion like test/site-url.test.js rather than a route test.
const ROOTS = ['app.js', 'controllers', 'models', 'utils', 'middleware'];

function walk(rel, out) {
  const abs = path.join(__dirname, '..', rel);
  if (!fs.existsSync(abs)) return out;
  if (fs.statSync(abs).isDirectory()) {
    for (const entry of fs.readdirSync(abs)) walk(path.join(rel, entry), out);
  } else if (/\.js$/.test(rel)) {
    out.push(rel);
  }
  return out;
}

// A console call whose arguments include one of these, bare or as a property root.
const LOGGED = /console\.(log|info|warn|error|debug)\([^)]*\b(signedUrl|url|req\.user|user|profile|extraParams|accessToken|refreshToken)\b\s*[,)]/;

describe('no secrets or profiles in the logs', () => {
  it('logs no presigned url, Auth0 profile or token', () => {
    const offenders = [];
    for (const rel of ROOTS.flatMap((r) => walk(r, []))) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (LOGGED.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepStrictEqual(offenders, [],
      'log the S3 key or the user id, never the signed url or the profile:\n' + offenders.join('\n'));
  });
});
