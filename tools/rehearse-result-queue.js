#!/usr/bin/env node
// Runs every query in models/socialResultPost.js against PRODUCTION inside one transaction,
// including creating the table from migrations/social-result-post.sql, and ROLLS BACK.
// Nothing is ever committed: the transaction always ends by throwing. There is no local
// database, so this is how the queue's SQL is exercised (same approach as
// tools/rehearse-roster.js). Run it after changing either file.
//
//   node tools/rehearse-result-queue.js
//
// Exits non-zero if any step does not behave as the job relies on.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dbConnect = require('../utils/db_connect');

const ROLLBACK = new Error('rehearsal: rolling back');
const problems = [];
const expect = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

(async () => {
  try {
    await dbConnect.sql.begin(async (tx) => {
      // The model reads `sql` from utils/db_connect at require time, so point it at this
      // transaction before loading it.
      const realSql = dbConnect.sql;
      dbConnect.sql = tx;
      delete require.cache[require.resolve('../models/socialResultPost')];
      const Q = require('../models/socialResultPost');
      dbConnect.sql = realSql;

      await tx.unsafe(fs.readFileSync(path.join(__dirname, '../migrations/social-result-post.sql'), 'utf8')).simple();
      const [a, b] = await tx`SELECT id::int AS id FROM fixture WHERE "homeScore" IS NOT NULL ORDER BY date DESC LIMIT 2`;
      console.log(`Rehearsing on fixtures #${a.id} and #${b.id}`);

      console.log('1. enqueue');
      const first = await Q.enqueue(a.id, ['page', 'instagram', 'page-story', 'instagram-story']);
      expect('four rows added', first.length === 4, first.map(r => r.target).join(','));
      const again = await Q.enqueue(a.id, ['page', 'instagram']);
      expect('a republish adds nothing', again.length === 0);
      await Q.enqueue(b.id, ['page']);

      console.log('2. claim');
      const [c1] = await Q.claim(1);
      expect('oldest first, attempt counted', c1.fixtureId == a.id && c1.target === 'page' && c1.attempts === 1,
        JSON.stringify(c1));
      const [c2] = await Q.claim(1, [c1.id]);
      expect('the next one', c2 && c2.target === 'instagram');

      console.log('3. finish');
      expect('markPosted closes a posting row', (await Q.markPosted(c1.id, 'media-1')) === 1);
      expect('...and only once', (await Q.markPosted(c1.id, 'media-1')) === 0);
      expect('release puts it back', (await Q.release(c2.id, 'not ready')) === 1);
      const [c3] = await Q.claim(1, [c1.id, c2.id]);
      expect('exclude skips a row this run already tried', c3 && c3.id !== c2.id && c3.target === 'page-story',
        c3 && c3.target);
      expect('markFailed', (await Q.markFailed(c3.id, 'refused')) === 1);
      const [c4] = await Q.claim(1, [c1.id, c2.id, c3.id]);
      expect('markSkipped', (await Q.markSkipped(c4.id, 'stale')) === 1);

      const rows = await tx`SELECT target, state, attempts, media_id, last_error, posted_at IS NOT NULL AS posted
                              FROM social_result_post WHERE fixture_id = ${a.id} ORDER BY id`;
      console.table(rows);
      expect('posted row has media id and time', rows[0].state === 'posted' && rows[0].media_id === 'media-1' && rows[0].posted);
      expect('released row is pending with its error', rows[1].state === 'pending' && rows[1].last_error === 'not ready');

      console.log('4. resultFor');
      const r = await Q.resultFor(a.id);
      expect('reads teams, score and division', r && r.homeTeam && r.awayTeam && r.homeScore != null && r.division,
        r && `${r.homeTeam} ${r.homeScore}-${r.awayScore} ${r.awayTeam} (${r.division})`);
      expect('an unknown fixture is null', (await Q.resultFor(-1)) === null);

      console.log('5. needingAttention');
      await tx`UPDATE social_result_post SET claimed_at = now() - INTERVAL '20 minutes', state = 'posting'
                WHERE fixture_id = ${b.id}`;
      await tx`UPDATE social_result_post SET queued_at = now() - INTERVAL '13 hours'
                WHERE fixture_id = ${a.id} AND target = 'instagram'`;
      const attention = await Q.needingAttention();
      console.table(attention.map(x => ({ fixture: x.fixtureId, target: x.target, state: x.state, problem: x.problem })));
      const kinds = attention.map(x => `${x.fixtureId}/${x.target}`).sort();
      expect('failed, stuck and never-attempted rows; not posted or skipped',
        JSON.stringify(kinds) === JSON.stringify([`${a.id}/instagram`, `${a.id}/page-story`, `${b.id}/page`].sort()),
        kinds.join(' '));

      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) { console.error(err); process.exit(1); }
  }
  console.log(problems.length ? `\n${problems.length} problem(s): ${problems.join('; ')}` : '\nAll good. Rolled back.');
  process.exit(problems.length ? 1 : 0);
})();
