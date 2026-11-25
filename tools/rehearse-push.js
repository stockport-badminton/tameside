#!/usr/bin/env node
// Applies migrations/push.sql and runs every models/push.js query against PRODUCTION inside
// one transaction, then ROLLS BACK. Nothing is ever committed: the transaction always ends by
// throwing. There is no local database, so this is how the push SQL is exercised (the same
// approach as tools/rehearse-roster.js). Sends nothing: web-push is never called.
//
//   node tools/rehearse-push.js [YYYY-MM-DD]   # the day to read reminders for; default: the
//                                              # next day with an outstanding fixture
//
// Safe before or after the migration is applied: the file is idempotent.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sql } = require('../utils/db_connect');
const Push = require('../models/push');
const { reminderNotification, resultNotification } = require('../utils/push/notifications');

const ROLLBACK = new Error('rehearsal: rolling back');
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) problems.push(label);
};

(async () => {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(fs.readFileSync(path.join(__dirname, '..', 'migrations', 'push.sql'), 'utf8'));
      check('migration applies', true);

      const teams = await Push.followableTeams(tx);
      check('followableTeams', teams.length > 0, `${teams.length} teams, e.g. ${teams[0] && teams[0].name} (${teams[0] && teams[0].clubName})`);
      const [a, b] = teams;

      const sub = (n, t, types = []) => ({ id: 'rehearse-' + n, endpoint: `https://fcm.googleapis.com/fcm/send/rehearse-${n}`, p256dh: 'p', auth: 'a', teams: t, types });
      await Push.upsertSubscription(sub(1, [a.id]), tx);
      await Push.upsertSubscription(sub(2, [a.id, b.id], ['reminders']), tx);
      await Push.upsertSubscription(sub(3, [b.id], ['results']), tx);
      await Push.upsertSubscription(sub(1, [a.id, b.id], ['results']), tx); // update, not a second row
      const saved = await Push.getSubscription('rehearse-1', tx);
      check('upsert updates in place', saved && saved.teams.length === 2 && saved.types[0] === 'results', JSON.stringify(saved));

      const ids = rows => rows.map(r => r.id).filter(id => id.startsWith('rehearse-')).sort().join(',');
      check('subscribersFor team A, results', ids(await Push.subscribersFor({ teams: [a.id], type: 'results' }, tx)) === 'rehearse-1');
      check('subscribersFor team B, reminders', ids(await Push.subscribersFor({ teams: [b.id], type: 'reminders' }, tx)) === 'rehearse-2');
      check('subscribersFor team B, results', ids(await Push.subscribersFor({ teams: [b.id], type: 'results' }, tx)) === 'rehearse-1,rehearse-3');
      check('subscribersFor everyone', ids(await Push.subscribersFor({}, tx)) === 'rehearse-1,rehearse-2,rehearse-3');

      const counts = await Push.teamCounts(tx);
      check('teamCounts', counts.subscriptions >= 3 && counts.teams.some(t => t.id === b.id && t.subscribers >= 3), JSON.stringify(counts.teams.slice(0, 3)));

      check('claimSend first time', await Push.claimSend('rehearse-key', tx) === true);
      check('claimSend second time', await Push.claimSend('rehearse-key', tx) === false);
      await Push.recordSummary('rehearse-key', { sent: 2, subscribers: 3 }, tx);
      const [rec] = (await Push.recentSends(50, tx)).filter(r => r.key === 'rehearse-key');
      check('recordSummary stores a jsonb object', rec && rec.summary && rec.summary.sent === 2, JSON.stringify(rec && rec.summary));
      const [{ kind }] = await tx`SELECT jsonb_typeof(summary) AS kind FROM push_send WHERE key = 'rehearse-key'`;
      check('summary is an object, not a jsonb string', kind === 'object', kind);

      await Push.markSent(['rehearse-1'], tx);
      check('removeSubscriptions', await Push.removeSubscriptions(['rehearse-2', 'rehearse-nope'], tx) === 1);

      let day = process.argv[2];
      if (!day) {
        const [next] = await tx`SELECT to_char(min(date), 'YYYY-MM-DD') AS d FROM fixture WHERE status = 'outstanding' AND date >= now()::date`;
        day = next.d;
      }
      const due = await Push.remindersFor(day, tx);
      check('remindersFor', due.length > 0, `${day}: ${due.length} fixture(s)`);
      for (const f of due) {
        const n = reminderNotification(f, 'tomorrow');
        console.log(`       ${n.title} | ${n.body} | ${n.url}`);
      }

      const [done] = await tx`SELECT id FROM fixture WHERE status = 'complete' ORDER BY date DESC LIMIT 1`;
      const played = await Push.resultFor(done.id, tx);
      const r = played && resultNotification(played);
      check('resultFor + resultNotification', !!r, r ? `${r.title} | ${r.body} | ${r.url}` : '');

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) { console.error('FAILED:', e); process.exitCode = 1; }
  } finally {
    if (problems.length) { console.error(`\n${problems.length} check(s) failed`); process.exitCode = 1; }
    else if (!process.exitCode) console.log('\nall checks passed; rolled back');
    await sql.end();
  }
})();
