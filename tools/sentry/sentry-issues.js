#!/usr/bin/env node
/**
 * Sentry issue triage helper (read-only) for the Tameside league site.
 *
 * Reads issues from Sentry's REST API so we can pick off low-hanging fruit.
 * The site reports server-side errors via instrument.js (Sentry.init) and the
 * central 500 handler in app.js.
 *
 * Setup (once):
 *   1. Create a Sentry auth token with read scopes:
 *        event:read, project:read, org:read, member:read
 *   2. Add it to .env (gitignored):  SENTRY_AUTH_TOKEN=...
 *
 * Usage:
 *   node -r dotenv/config tools/sentry/sentry-issues.js dotenv_config_path=.env
 *      -> lists top unresolved issues by frequency (last 14 days)
 *
 *   node -r dotenv/config tools/sentry/sentry-issues.js <issueId|shortId> dotenv_config_path=.env
 *      -> prints the latest event for one issue (exception + stack frames)
 *
 * Env (optional overrides):
 *   SENTRY_API_BASE   default https://de.sentry.io/api/0  (EU region — matches the DSN)
 *   SENTRY_ORG        org slug (auto-discovered from the token if omitted)
 *   SENTRY_PROJECT    project slug/id to scope to (defaults to all projects the token sees)
 *   SENTRY_STATS_PERIOD  default 14d
 *   SENTRY_QUERY      default "is:unresolved"
 */

const TOKEN = process.env.SENTRY_AUTH_TOKEN;
const API_BASE = (process.env.SENTRY_API_BASE || 'https://de.sentry.io/api/0').replace(/\/$/, '');
const STATS_PERIOD = process.env.SENTRY_STATS_PERIOD || '14d';
const QUERY = process.env.SENTRY_QUERY || 'is:unresolved';

if (!TOKEN) {
  console.error('Missing SENTRY_AUTH_TOKEN. Add a read-only token to .env, then re-run.');
  process.exit(1);
}

async function api(path) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}\n${body.slice(0, 400)}`);
  }
  return res.json();
}

async function resolveOrgSlug() {
  if (process.env.SENTRY_ORG) return process.env.SENTRY_ORG;
  const orgs = await api('/organizations/');
  if (!orgs.length) throw new Error('Token can see no organizations — check its scopes.');
  return orgs[0].slug;
}

function fmt(n) {
  return String(n).padStart(6);
}

async function listIssues() {
  const org = await resolveOrgSlug();
  const projQ = process.env.SENTRY_PROJECT ? `&project=${encodeURIComponent(process.env.SENTRY_PROJECT)}` : '';
  const issues = await api(
    `/organizations/${org}/issues/?query=${encodeURIComponent(QUERY)}&sort=freq&statsPeriod=${STATS_PERIOD}&limit=25${projQ}`
  );
  console.log(`\nSentry — org "${org}" — ${QUERY} — last ${STATS_PERIOD} — sorted by frequency\n`);
  if (!issues.length) {
    console.log('  No matching issues. 🎉');
    return;
  }
  console.log('  count  users  level     shortId        title / culprit');
  console.log('  ' + '-'.repeat(90));
  for (const i of issues) {
    const line = `  ${fmt(i.count)} ${fmt(i.userCount)}  ${(i.level || '').padEnd(8)}  ${(i.shortId || '').padEnd(13)}  ${i.title}`;
    console.log(line);
    if (i.culprit) console.log(`  ${' '.repeat(38)}${i.culprit}`);
  }
  console.log(`\n  Detail:  node -r dotenv/config tools/sentry/sentry-issues.js <shortId> dotenv_config_path=.env\n`);
}

async function showIssue(idOrShort) {
  const org = await resolveOrgSlug();
  // shortId (e.g. JAVASCRIPT-1A) resolves to a numeric issue id via /shortids/
  let issueId = idOrShort;
  if (/[^0-9]/.test(idOrShort)) {
    const resolved = await api(`/organizations/${org}/shortids/${encodeURIComponent(idOrShort)}/`);
    const grp = resolved.group || resolved;
    if (!grp || !grp.id) throw new Error(`No issue matching "${idOrShort}"`);
    issueId = grp.id;
  }
  const issue = await api(`/organizations/${org}/issues/${issueId}/`);
  console.log(`\n${issue.shortId}  ${issue.title}`);
  console.log(`culprit: ${issue.culprit || '(none)'}`);
  console.log(`events: ${issue.count}   users: ${issue.userCount}   level: ${issue.level}`);
  console.log(`first seen: ${issue.firstSeen}   last seen: ${issue.lastSeen}`);
  console.log(`permalink: ${issue.permalink}`);

  const event = await api(`/organizations/${org}/issues/${issueId}/events/latest/`);
  const exc = (event.entries || []).find((e) => e.type === 'exception');
  const req = (event.entries || []).find((e) => e.type === 'request');
  if (req && req.data && req.data.url) console.log(`\nURL: ${req.data.url}`);
  if (event.tags) {
    const browser = event.tags.find((t) => t.key === 'browser');
    const release = event.tags.find((t) => t.key === 'release');
    if (browser) console.log(`browser: ${browser.value}`);
    if (release) console.log(`release: ${release.value}`);
  }
  if (exc) {
    for (const v of exc.data.values || []) {
      console.log(`\n${v.type}: ${v.value}`);
      const frames = (v.stacktrace && v.stacktrace.frames) || [];
      // show the most relevant (in-app) frames last, as Sentry does
      for (const f of frames.slice(-12)) {
        const loc = `${f.filename || f.module || '?'}:${f.lineNo || '?'}:${f.colNo || ''}`;
        console.log(`    at ${f.function || '<anon>'} (${loc})${f.inApp ? '  [in-app]' : ''}`);
        if (f.context && f.context.length) {
          const cur = f.context.find((c) => c[0] === f.lineNo);
          if (cur) console.log(`        > ${String(cur[1]).trim().slice(0, 160)}`);
        }
      }
    }
  } else {
    console.log('\n(no exception entry — likely a console/message event)');
    console.log('message:', event.message || event.title);
  }
  console.log('');
}

(async () => {
  try {
    const arg = process.argv.slice(2).find((a) => !a.startsWith('dotenv_config'));
    if (arg) await showIssue(arg);
    else await listIssues();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
