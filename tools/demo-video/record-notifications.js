// Records the "how to turn on notifications" walkthrough of /notifications, phone cut (9:16).
// See README.md. Ported from Stockport (league-site tools/demo-video/record-notifications.js,
// 4d6cf0d), which records against a seeded local database; we have none, so this runs a local
// server ANONYMOUSLY against the production database and writes nothing to it:
//
//   node tools/demo-video/record-notifications.js            # DEMO_TEAM='Hyde A' by default
//
// Real: the homepage, the menu, /notifications with the real clubs and teams (public already:
// no player is named anywhere on these pages), and the notification wording, built by
// utils/push/notifications.js from that team's real next fixture and latest result. Stubbed,
// because a headless browser has no push service and draws no browser UI: the subscription
// (PushManager and /api/push/*, answered in the browser, so nothing reaches the server), the
// "Allow notifications?" prompt and the notifications arriving (overlay.js `prompt`/`notify`).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { chromium, devices } = require('playwright');

const D = __dirname;
const ROOT = path.join(D, '../..');
const PORT = Number(process.env.DEMO_PORT || 8196);
const BASE = `http://127.0.0.1:${PORT}`;
const TEAM_NAME = process.env.DEMO_TEAM || 'Hyde A';
const OUT = `${D}/generated/notifications`;
const PUBLISHED = path.join(ROOT, 'static/video/notifications-mobile');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.dirname(PUBLISHED), { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The team, and the three example notifications, from the database: what a follower of that
// team would actually be sent, in the words the real sender uses.
async function demoData() {
  const { sql } = require('../../utils/db_connect');
  const Push = require('../../models/push');
  const { reminderNotification, resultNotification } = require('../../utils/push/notifications');
  try {
    const [team] = await sql`SELECT team.id::int AS id, club.name AS club FROM team JOIN club ON club.id = team.club WHERE team.name = ${TEAM_NAME}`;
    if (!team) throw new Error(`No team called ${TEAM_NAME}`);
    const [next] = await sql`
      SELECT id FROM fixture WHERE status = 'outstanding' AND date >= now()::date
         AND ${team.id} IN ("homeTeam", "awayTeam") ORDER BY date LIMIT 1`;
    // Its latest WIN: the video is selling the feature to that team's followers.
    const [last] = await sql`
      SELECT id FROM fixture WHERE status = 'complete'
         AND (("homeTeam" = ${team.id} AND "homeScore" > "awayScore") OR ("awayTeam" = ${team.id} AND "awayScore" > "homeScore"))
       ORDER BY date DESC LIMIT 1`;
    if (!next || !last) throw new Error(`${TEAM_NAME} needs an upcoming fixture and a result`);
    const upcoming = await Push.resultFor(next.id);
    const played = await Push.resultFor(last.id);
    return {
      team,
      tomorrow: reminderNotification(upcoming, 'tomorrow'),
      tonight: reminderNotification(upcoming, 'tonight'),
      result: resultNotification(played),
    };
  } finally {
    await sql.end();
  }
}

// An anonymous local server: no DEV_MODE (so no mock superadmin, and no Admin menu in the
// shot), the service worker on, and no VAPID private key, so it could not send even if asked.
async function startServer() {
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'development', SW_ENABLE: 'true', VAPID_PRIVATE_KEY: '' };
  delete env.DEV_MODE;
  const srv = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/notifications`)).ok) return srv; } catch (e) { /* not up yet */ }
    await sleep(500);
  }
  srv.kill();
  throw new Error('local server did not start');
}

(async () => {
  const data = await demoData();
  console.log(`team ${TEAM_NAME} (${data.team.id}):`, data.tomorrow.title, '|', data.result.title);
  const srv = await startServer();
  try {
    await record(data);
  } finally {
    srv.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });

async function record({ team, tomorrow, tonight, result }) {
  const viewport = { width: 360, height: 640 };
  const scale = 3;
  const browser = await chromium.launch({ channel: 'chromium', args: [`--force-device-scale-factor=${scale}`] });
  const { viewport: _v, deviceScaleFactor: _d, ...phone } = devices['Pixel 7'];
  const ctx = await browser.newContext({ ...phone, viewport, deviceScaleFactor: scale, bypassCSP: true, permissions: ['notifications'] });
  // No push service in headless Chromium: hand the page a subscription that looks real. Its
  // own script, first, so nothing else in an init script can stop it being installed.
  await ctx.addInitScript(() => {
    if (window.PushManager) {
      let sub = null;
      const fake = { endpoint: 'https://fcm.googleapis.com/fcm/send/demo-video',
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'demo', auth: 'demo' } }; },
        unsubscribe: async () => { sub = null; return true; } };
      PushManager.prototype.getSubscription = async () => sub;
      PushManager.prototype.subscribe = async () => (sub = fake);
    }
  });
  await ctx.addInitScript({ path: `${D}/overlay.js` });
  await ctx.addInitScript(() => {
    window.__dmPhone = true;
    window.__dmApp = 'Tameside Badminton League';
    window.__dmCardBg = 'linear-gradient(135deg,#1e3c72 0%,#2a5298 100%)';  // the results-header navy
    const s = document.documentElement.style;
    s.setProperty('--cap-size', '19px');
    s.setProperty('--cap-bottom', '13%');
    s.setProperty('--card-h', '36px');
    s.setProperty('--card-p', '18px');
    s.setProperty('--card-k', '14px');
  });
  // Belt and braces: nothing from this browser reaches the server's push API. (The page is
  // also given a fake subscription, so these are the only calls it would make.)
  await ctx.route('**/api/push/subscription', r => r.fulfill({ json: { ok: true, subscribed: false } }));
  await ctx.route('**/api/push/subscribe', r => r.fulfill({ json: { ok: true, teams: [team.id], types: ['results', 'reminders'] } }));
  const page = await ctx.newPage();

  const FR = `${OUT}/frames`; fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR);
  const cdp = await ctx.newCDPSession(page);
  const frames = []; let capturing = false;
  cdp.on('Page.screencastFrame', f => {
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    if (!capturing) return;
    const file = `${FR}/${String(frames.length).padStart(6, '0')}.jpg`;
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
  });
  const W = viewport.width * scale, H = viewport.height * scale;
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H });

  const demo = (fn, ...args) => page.evaluate(([fn, args]) => window.__demo[fn](...args), [fn, args]);
  const caption = html => demo('caption', html);
  const spot = sel => demo('spot', sel || null);
  const visible = sel => page.locator(sel).locator('visible=true').first();
  async function pointAt(locator) {
    await locator.scrollIntoViewIfNeeded();
    const b = await locator.boundingBox();
    await demo('pointer', b.x + b.width / 2, b.y + b.height / 2);
    await sleep(750);
  }
  async function press(locator, pause = 250) {
    await pointAt(locator);
    await demo('tapRing');
    await sleep(pause);
    await locator.click();
  }

  // ── Title, and the iPhone step that has to come first ─────────────────────
  await page.goto(`${BASE}/`);
  // Let the service worker install before anything else: no worker, no push.
  await page.evaluate(() => navigator.serviceWorker && navigator.serviceWorker.ready);
  await demo('pointer', -80, -80);
  await demo('card', 'Tameside Badminton League', 'Notifications on your phone',
    'Your team’s results as they’re published, and a reminder before every match.');
  await sleep(700);
  capturing = true;
  await sleep(4200);
  await demo('card', 'On an iPhone or iPad?', 'Add the site to your Home Screen first',
    'In Safari tap <b>Share</b> → <b>Add to Home Screen</b>, then open the site from its new icon.<br><br>On Android, carry straight on in Chrome.');
  await sleep(6500);
  await demo('card', 'x', null);
  await sleep(800);

  // ── Getting there ─────────────────────────────────────────────────────────
  await caption('Open the menu: <b>Fixtures &amp; Results → Notifications</b>');
  await press(page.locator('.navbar-toggler'));
  await sleep(700);
  await press(visible('a.nav-link:has-text("Fixtures & Results")'));
  await sleep(500);
  await press(visible('.dropdown-menu a:has-text("Notifications")'));
  await page.waitForURL('**/notifications');
  await page.locator('[data-state="ready"]').waitFor({ state: 'visible' }).catch(async () => {
    const shown = await page.locator('#push-panel [data-state]:not([hidden])').getAttribute('data-state');
    throw new Error(`/notifications shows "${shown}", not the picker`);
  });
  await caption(null);
  await sleep(900);

  // ── Teams ─────────────────────────────────────────────────────────────────
  await caption('Find your club…');
  const club = visible(`summary:has-text("${team.club}")`);
  await pointAt(club);
  await sleep(500);
  await press(club);
  await sleep(700);
  await caption('…and tick your team<small>Tick as many teams as you like</small>');
  await press(visible(`label[for="team-${team.id}"]`));
  await sleep(2400);

  // ── Types ─────────────────────────────────────────────────────────────────
  const types = visible('fieldset:has(input[name="push-type"])');
  await types.scrollIntoViewIfNeeded();
  await sleep(400);
  await spot('fieldset:has(input[name="push-type"])');
  await caption('Results, match reminders, or both<small>Reminders come at 6pm the evening before and 5pm on the day</small>');
  await sleep(4200);
  await spot();

  // ── Turning on ────────────────────────────────────────────────────────────
  const on = visible('[data-action="subscribe"]');
  await caption('Then press <b>Turn on notifications</b>');
  await pointAt(on);
  await sleep(500);
  await demo('tapRing');
  await sleep(400);
  await caption(null);
  await demo('prompt', 'tameside-badminton.co.uk');
  await sleep(900);
  await caption('Your phone asks first — tap <b>Allow</b>');
  await sleep(1800);
  await pointAt(page.locator('#dm-prompt .allow'));
  await demo('tapRing');
  await sleep(500);
  await demo('prompt', null);
  await caption(null);
  await on.click();
  await page.locator('[data-role="status"]:has-text("Notifications are on")').waitFor({ timeout: 8000 }).catch(async () => {
    throw new Error('Turning on failed; the page says: ' + await page.locator('[data-role="status"]').textContent());
  });
  await sleep(500);
  await spot('[data-role="status"]');
  await caption('That’s it — <b>notifications are on</b> for this phone');
  await sleep(3400);
  await spot('#push-panel [data-state="ready"] .btn');
  await caption('Come back any time to change teams (<b>Save settings</b>) or to stop them (<b>Turn off</b>)');
  await sleep(4400);
  await spot();
  await caption(null);
  await demo('pointer', -80, -80);
  await sleep(600);

  // ── What arrives ──────────────────────────────────────────────────────────
  await caption('The evening before a match…');
  await demo('notify', tomorrow.title, tomorrow.body);
  await sleep(3800);
  await caption('…on the day…');
  await demo('notify', tonight.title, tonight.body);
  await sleep(3600);
  await caption('…and the result, as soon as it’s on the website');
  await demo('notify', result.title, result.body);
  await sleep(3800);
  await caption('Tap one to open the match page');
  await sleep(2800);
  await demo('notify', null);
  await caption(null);
  await sleep(500);

  await demo('card', 'That’s it', 'Pick teams, turn on, Allow',
    'Notifications are per device — do it on each phone you use.');
  await sleep(5000);

  capturing = false;
  const end = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await browser.close();

  // ── Encode: the same constant-frame-rate build as Stockport's record.js ─────
  const gaps = frames.slice(1).map((f, i) => ({ gap: f.t - frames[i].t, at: frames[i].t - frames[0].t }));
  const worst = gaps.reduce((a, b) => (b.gap > a.gap ? b : a), { gap: 0, at: 0 });
  if (worst.gap > 1.5) throw new Error(`Capture stalled for ${worst.gap.toFixed(1)}s at ${worst.at.toFixed(1)}s — record it again`);
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.min(end, f.t + 6);
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`);
  fs.writeFileSync(`${OUT}/frames.ffconcat`, lines.join('\n') + '\n');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-safe', '0', '-f', 'concat', '-i', `${OUT}/frames.ffconcat`,
    '-vf', `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', `${OUT}/take.mp4`]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${OUT}/take.mp4`, '-c:v', 'libx264', '-preset', 'veryslow',
    '-crf', '26', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', '-an', `${PUBLISHED}.mp4`]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2', '-i', `${OUT}/take.mp4`, '-frames:v', '1', '-q:v', '4', `${PUBLISHED}.jpg`]);
  console.log(`${PUBLISHED}.mp4 (${frames.length} frames, ${(frames[frames.length - 1].t - frames[0].t).toFixed(1)}s)`);
}
