#!/usr/bin/env node
//
// Set the Tameside client's own Classic login page, so it stops showing the other
// league's logo.
//
// Why this works with no plan upgrade and no tenant change: the tenant already serves
// CLASSIC Universal Login (proved by fetching /authorize for three clients — all load
// lock/11.11), and the shared page HTML lives on the "All Applications" pseudo-client
// with Stockport's logo URL hardcoded into `theme.logo`. `custom_login_page` is a
// PER-CLIENT field, and the Tameside client already has custom_login_page_on: true with
// an empty page — so it falls back to that shared one. Filling it in overrides only for
// this client. Stockport is untouched.
//
// Applies, verifies by rendering the real login page, and ROLLS BACK automatically if
// verification fails — this is the front door, so it must not be left broken.
//
//   node tools/auth0-login-page.js                 # dry run, diffs repo vs live
//   node tools/auth0-login-page.js --commit        # deploy auth0/tameside-login-page.html
//   node tools/auth0-login-page.js --revert        # blank it; falls back to the shared page
//
// The page itself is tracked at auth0/tameside-login-page.html — see auth0/README.md.
// Auth0 is the only place this HTML runs, so the repo copy is the source of truth and
// this script is how it gets there.
require('dotenv').config();
const fs = require('fs');

const DOMAIN = process.env.AUTH0_DOMAIN;
const CLIENT = process.env.AUTH0_CLIENTID;          // the Tameside application
const REDIRECT = 'https://tameside-badminton.co.uk/callback';
const path = require('path');
const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const REVERT = args.includes('--revert');
const DEFAULT_PAGE = path.join(__dirname, '..', 'auth0', 'tameside-login-page.html');
const file = args.find(a => !a.startsWith('--')) || DEFAULT_PAGE;

async function token() {
  const r = await fetch(`https://${DOMAIN}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT, client_secret: process.env.AUTH0_CLIENT_SECRET,
      audience: `https://${DOMAIN}/api/v2/`, grant_type: 'client_credentials' })
  });
  const b = await r.json();
  if (!b.access_token) throw new Error('token: ' + JSON.stringify(b).slice(0, 200));
  return b.access_token;
}

async function patch(t, body) {
  const r = await fetch(`https://${DOMAIN}/api/v2/clients/${CLIENT}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (r.status >= 400) throw new Error(`PATCH ${r.status}: ${txt.slice(0, 300)}`);
  return r.status;
}

// Render the genuine login page the way a browser would, following redirects with a
// cookie jar (Auth0 needs the state cookie or it answers "couldn't find your session").
async function renderLoginPage() {
  const url = `https://${DOMAIN}/authorize?client_id=${CLIENT}&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=openid%20email%20profile` +
    `&state=verify${Date.now()}&nonce=n${Date.now()}`;
  let res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
  const cookies = [];
  for (let hop = 0; hop < 6; hop++) {
    const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    setC.forEach(c => cookies.push(c.split(';')[0]));
    const loc = res.headers.get('location');
    if (!loc) break;
    const next = new URL(loc, `https://${DOMAIN}`).toString();
    res = await fetch(next, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0', Cookie: cookies.join('; ') }
    });
  }
  return { status: res.status, html: await res.text() };
}

function verify(html, status) {
  const checks = [
    ['HTTP 200',                       status === 200],
    ['Lock widget loads',              /lock\/11[^"]*lock\.min\.js/.test(html)],
    ['Auth0 injected the config',      /window\.atob\('[A-Za-z0-9+/=]{40,}'\)/.test(html) && !html.includes('@@config@@')],
    ['Tameside logo referenced',       html.includes('tameside-badminton.co.uk/static/images/Logo.png')],
    ['Stockport logo gone',            !html.includes('stockport-badminton.co.uk/static/beta/images/SDBLLogo.png')],
    ['not an Auth0 error page',        !/Oops|something went wrong/i.test(html)],
  ];
  checks.forEach(([label, ok]) => console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label}`));
  return checks.every(([, ok]) => ok);
}

(async () => {
  const t = await token();

  if (REVERT) {
    await patch(t, { custom_login_page: '' });
    console.log('Reverted: custom_login_page blanked; this client falls back to the shared page.');
    const { status, html } = await renderLoginPage();
    console.log(`  rendered check: HTTP ${status}, Lock present: ${/lock\/11/.test(html)}`);
    process.exit(0);
  }

  const page = fs.readFileSync(file, 'utf8');
  if (!page.includes('@@config@@')) {
    console.error('refusing: the page has no @@config@@ placeholder, so Auth0 cannot inject config');
    process.exit(1);
  }
  console.log(`page: ${path.relative(process.cwd(), file)} (${page.length} chars), @@config@@ present`);

  // Tracking the file is only useful if drift is visible, so always say whether the
  // live client already matches.
  const cur = await fetch(`https://${DOMAIN}/api/v2/clients/${CLIENT}`, {
    headers: { Authorization: 'Bearer ' + t }
  }).then(r => r.json());
  const live = (cur.custom_login_page || '');
  const same = live.trim() === page.trim();
  console.log(`live client: ${live ? live.length + ' chars' : 'EMPTY (using the shared page)'}` +
              ` — ${same ? 'matches the repo copy' : 'DIFFERS from the repo copy'}`);

  if (!COMMIT) {
    console.log('Dry run. Re-run with --commit to apply.');
    process.exit(0);
  }

  console.log('\napplying to client', CLIENT, '…');
  await patch(t, { custom_login_page: page, custom_login_page_on: true });

  console.log('verifying against the real login page…');
  const { status, html } = await renderLoginPage();
  if (verify(html, status)) {
    console.log('\nVERIFIED — Tameside now serves its own login page. Stockport untouched.');
    process.exit(0);
  }
  console.log('\nverification FAILED — rolling back so login is never left broken…');
  await patch(t, { custom_login_page: '' });
  const again = await renderLoginPage();
  console.log(`  rolled back. HTTP ${again.status}, Lock present: ${/lock\/11/.test(again.html)}`);
  process.exit(1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
