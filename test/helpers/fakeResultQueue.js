// An in-memory social_result_post, installed through helpers/app's setModel seam.
//
// It keeps the real model's rules that the job depends on, so a test against it means
// something: enqueue ignores a (fixture, target) already present, claim takes `pending` rows
// oldest first and counts the attempt, and every finishing write only closes a row that is
// `posting`. The SQL itself is not exercised here; there is no local database.

function installFakeResultQueue(setModel, { results = {} } = {}) {
  const rows = [];
  let nextId = 1;

  setModel('SocialResultPost', 'enqueue', async (fixtureId, targets) => {
    const added = [];
    for (const target of targets) {
      if (rows.some(r => r.fixtureId === fixtureId && r.target === target)) continue;
      const row = { id: nextId++, fixtureId, target, state: 'pending', attempts: 0,
        queuedAt: new Date(), mediaId: null, lastError: null };
      rows.push(row);
      added.push({ id: row.id, target });
    }
    return added;
  });
  setModel('SocialResultPost', 'claim', async (limit, exclude = []) => {
    const taken = rows.filter(r => r.state === 'pending' && !exclude.includes(r.id)).sort((a, b) => a.id - b.id).slice(0, limit);
    for (const r of taken) { r.state = 'posting'; r.attempts++; }
    return taken.map(r => ({ id: r.id, fixtureId: r.fixtureId, target: r.target,
      attempts: r.attempts, queuedAt: r.queuedAt }));
  });
  setModel('SocialResultPost', 'resultFor', async (fixtureId) => results[fixtureId] || null);

  const finish = (state) => async (id, value) => {
    const r = rows.find(x => x.id === id && x.state === 'posting');
    if (!r) return 0;
    r.state = state;
    if (state === 'posted') { r.mediaId = value; r.lastError = null; } else r.lastError = value;
    return 1;
  };
  setModel('SocialResultPost', 'markPosted', finish('posted'));
  setModel('SocialResultPost', 'markFailed', finish('failed'));
  setModel('SocialResultPost', 'markSkipped', finish('skipped'));
  setModel('SocialResultPost', 'release', finish('pending'));
  setModel('SocialResultPost', 'needingAttention', async () => []);

  return rows;
}

module.exports = { installFakeResultQueue };
