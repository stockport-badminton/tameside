// LOCAL_DATABASE_URL (BL-06) points a development process at the local copy. It must never
// move production: the deployed image sets NODE_ENV=production, and there the override is
// ignored whatever else is set. Each case runs in a child process because db_connect reads
// the environment once, at require time. Requiring it opens no connection.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LOCAL = 'postgresql://tbl:tbl@127.0.0.1:5434/tbl';

function targetWith(env) {
  const out = execFileSync(process.execPath, ['-e',
    "const d = require('./utils/db_connect'); process.stdout.write(JSON.stringify({ target: d.DB_TARGET, local: d.IS_LOCAL }))",
  ], { cwd: ROOT, env: { PATH: process.env.PATH, PGPASSWORD: 'placeholder', ...env } });
  return JSON.parse(String(out));
}

test('unset, every environment talks to production as before', () => {
  for (const NODE_ENV of ['production', 'development', 'test']) {
    const t = targetWith({ NODE_ENV });
    assert.strictEqual(t.local, false, NODE_ENV);
    assert.match(t.target, /^aws-0-eu-west-2\.pooler\.supabase\.com:6543\/postgres \(production\)$/);
  }
});

test('a development process honours LOCAL_DATABASE_URL', () => {
  const t = targetWith({ NODE_ENV: 'development', LOCAL_DATABASE_URL: LOCAL });
  assert.deepStrictEqual(t, { target: '127.0.0.1:5434/tbl (local)', local: true });
});

test('production ignores LOCAL_DATABASE_URL', () => {
  const t = targetWith({ NODE_ENV: 'production', LOCAL_DATABASE_URL: LOCAL });
  assert.strictEqual(t.local, false);
  assert.match(t.target, /\(production\)$/);
});

test('the target carries no credentials', () => {
  const t = targetWith({ NODE_ENV: 'development', LOCAL_DATABASE_URL: LOCAL });
  assert.ok(!t.target.includes('tbl:tbl'), t.target);
  assert.ok(!targetWith({ NODE_ENV: 'production' }).target.includes('placeholder'));
});
