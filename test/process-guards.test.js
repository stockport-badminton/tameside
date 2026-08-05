const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const GUARDS = path.join(__dirname, '..', 'utils', 'processGuards.js');

// Run the scenario in a real child process. An unhandled rejection's effect *is* the
// process exit code, so it cannot be observed from inside the test process — and
// registering a listener here would contaminate the rest of the suite.
//
// spawnSync rather than execFileSync: the guard logs to stderr, and execFileSync only
// returns stdout on success, so the log line was invisible in the passing case.
//
// stdout and stderr are kept apart on purpose. `node -e` puts the whole script on one
// line, and on a fatal error Node echoes that source line into stderr — which contains
// the literal word SURVIVED. Matching the marker against combined output therefore
// reports survival for a process that actually died. The marker is only meaningful on
// stdout, where console.log puts it.
function runChild(body) {
  const r = spawnSync(process.execPath, ['-e', body], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const reject = `
  (async () => { throw new Error('simulated DB failure'); })();
  setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 400);
`;

test('process guards', async (t) => {
  await t.test('an unhandled rejection kills an unguarded process', () => {
    // Establishes that the risk is real, so the next assertion means something.
    const r = runChild(reject);
    assert.notStrictEqual(r.code, 0, 'baseline: Node should exit non-zero');
    assert.ok(!r.stdout.includes('SURVIVED'), 'baseline: should not reach the timeout');
  });

  await t.test('installing the guard keeps the process alive, with no Sentry present', () => {
    // The configuration that was actually broken: no DSN, so Sentry registers no
    // listener of its own and the guard is the only thing standing.
    const r = runChild(`require(${JSON.stringify(GUARDS)}).install();` + reject);
    assert.strictEqual(r.code, 0, `expected a clean exit, got ${r.code}\n${r.stderr}`);
    assert.ok(r.stdout.includes('SURVIVED'), 'the timeout should still run');
    assert.match(r.stderr, /\[unhandledRejection\]/, 'the fault must still be logged, not swallowed');
    assert.match(r.stderr, /simulated DB failure/, 'the log must name the underlying error');
  });

  await t.test('uncaughtException is deliberately left fatal', () => {
    // Documents the intentional asymmetry: undefined state should not be resumed.
    const r = runChild(
      `require(${JSON.stringify(GUARDS)}).install();` +
      `setImmediate(() => { throw new Error('sync boom'); });` +
      `setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 400);`
    );
    assert.notStrictEqual(r.code, 0, 'an uncaught exception should still exit non-zero');
    assert.ok(!r.stdout.includes('SURVIVED'), 'it must not be resumed');
  });
});
