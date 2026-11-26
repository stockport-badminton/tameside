// `for (row of result)` with no const/let/var assigns a GLOBAL `row` (these files are not
// strict mode), and it outlives the request. EJS resolves a name a template is not given
// in its locals against the globals, so a template guarded by `typeof row !== 'undefined'`
// or `typeof filter !== 'undefined'` then believes it was handed one.
//
// Stockport's /player/create answered 500 on an instance after anyone had loaded
// /info/clubs, for exactly this reason (league-site 7a336ba, Nov 2026). Our controllers
// leaked the same names: `row` from club_controller, `filter` (which five templates test
// with typeof) and `division` from fixtureController and the models.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['controllers', 'utils', 'models', 'middleware', 'routes', 'tools'];

function sources(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sources(full, out);
    } else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// `for (name of|in` straight after the parenthesis: a declared loop variable has
// const/let/var in between, so only the undeclared form matches.
const UNDECLARED_LOOP = /\bfor\s*\(\s*([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g;
// Per line, skipping lines that are comments. Stripping /* … */ from the whole file is
// wrong here: a string such as 'image/*' opens a "comment" that swallows real code, and
// that is how a first version of this test missed fixtureController's loops entirely.
// A block comment is followed only when it opens at the start of a line, which is how
// every commented-out block in this codebase is written (models/players.js has one
// holding a `for (y in …)`).
function codeLines(src) {
  const out = [];
  let inBlock = false;
  src.split('\n').forEach((line, i) => {
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      return;
    }
    if (/^\s*\/\*/.test(line)) {
      if (!line.includes('*/')) inBlock = true;
      return;
    }
    if (/^\s*(\/\/|\*)/.test(line)) return;
    out.push([i + 1, line]);
  });
  return out;
}

test('server code declares its loop variables', () => {
  const files = [
    ...DIRS.flatMap((d) => sources(path.join(ROOT, d))),
    path.join(ROOT, 'app.js'),
    path.join(ROOT, 'server.js'),
  ];
  const offences = [];
  for (const file of files) {
    for (const [n, line] of codeLines(fs.readFileSync(file, 'utf8'))) {
      for (const m of line.matchAll(UNDECLARED_LOOP)) {
        offences.push(`${path.relative(ROOT, file)}:${n}: for (${m[1]} …`);
      }
    }
  }
  assert.deepStrictEqual(offences, []);
});

test('the pattern recognises the undeclared form and only that', () => {
  const hits = (s) => [...s.matchAll(UNDECLARED_LOOP)].length;
  assert.strictEqual(hits('for (row of result) {}'), 1);
  assert.strictEqual(hits('for(k in obj){}'), 1);
  assert.strictEqual(hits('for (const row of result) {}'), 0);
  assert.strictEqual(hits('for (let i = 0; i < n; i++) {}'), 0);
  assert.strictEqual(hits('for (var k in obj) {}'), 0);
});

test('commented-out code is skipped, live code after it is not', () => {
  const lines = codeLines('/* old\nfor (y in a) {}\n*/\nfor (z of b) {}\n// for (w of c)').map(([, l]) => l);
  assert.deepStrictEqual(lines, ['for (z of b) {}']);
});
