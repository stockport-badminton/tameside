// Every outgoing email renders, and the MJML -> EJS build output is current.
//
// The templates are generated: emails/*.mjml is the source, `npm run build:email` writes
// views/emails/*.ejs, and the compiled output is committed so production needs no mjml
// (the Dockerfile runs `npm ci --omit=dev`). Two things can go wrong quietly and both are
// checked here.
//
//  1. A TEMPLATE THAT THROWS AT RENDER TIME. An email is only rendered when the thing it
//     reports actually happens -- a result entered, a signup approved -- so a missing
//     variable surfaces as a failed request in the middle of someone's evening rather
//     than at deploy time. Rendering each one with the data its caller passes is the
//     cheapest way to keep that honest.
//
//  2. STALE COMPILED OUTPUT. Editing the .mjml and forgetting to rebuild leaves the old
//     .ejs in place, so the email that goes out is not the one in the source you just
//     reviewed. `--check` compares them.
//
// Renders are also scanned for the literal string "undefined", which is what EJS puts in
// the output for a variable the caller forgot -- it does not throw, it just posts
// "Entered by undefined" to a captain.

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EMAIL_DIR = path.join(__dirname, '..', 'views', 'emails');
const SRC_DIR = path.join(__dirname, '..', 'emails');

// The sample data lives in a fixture module shared with tools/preview-emails.js, so the
// preview a human signs off cannot drift from what these tests assert on.
const CASES = require('./fixtures/email-samples');

const render = (name, data) => new Promise((resolve, reject) =>
  ejs.renderFile(path.join(EMAIL_DIR, name + '.ejs'), data, (err, html) => err ? reject(err) : resolve(html)));

describe('every MJML-built email renders', () => {
  for (const [name, data] of Object.entries(CASES)) {
    it(`${name} renders with its caller's data`, async () => {
      const html = await render(name, data);
      assert.ok(html.length > 5000, `${name} produced only ${html.length} bytes`);
      assert.ok(html.includes('</html>'), `${name} is not a complete document`);
      // EJS left in the output means a tag the template engine never reached.
      assert.strictEqual((html.match(/<%/g) || []).length, 0, `${name} has unrendered EJS`);
      // The classic silent failure: a caller forgot a variable.
      assert.ok(!/undefined/.test(html), `${name} rendered the string "undefined"`);
    });
  }
});

describe('email essentials', () => {
  it('every email carries a preheader, so clients do not scrape the logo alt text', async () => {
    for (const [name, data] of Object.entries(CASES)) {
      const html = await render(name, data);
      // MJML emits the preview text in a hidden div at the top of the body.
      assert.match(html, /mj-preview|display:none;font-size:1px/i, name);
    }
  });

  it('the logo has alt text, because Outlook blocks images by default', async () => {
    const html = await render('scorecard-received', CASES['scorecard-received']);
    assert.match(html, /alt="Tameside Badminton League"/);
  });

  it('every email says why it was received and how to reply', async () => {
    // This is the anti-junk footer. A transactional email that cannot be identified is
    // one someone marks as spam -- and a spam complaint in Mailjet suppresses that
    // address permanently, with no bounce to diagnose.
    for (const [name, data] of Object.entries(CASES)) {
      const html = await render(name, data);
      assert.match(html, /receiving this because/i, name);
      assert.match(html, /mailto:tameside\.badders\.results@gmail\.com/, name);
    }
  });

  it('uses no webfonts, which Outlook ignores anyway', async () => {
    for (const name of Object.keys(CASES)) {
      const html = await render(name, CASES[name]);
      assert.ok(!/@font-face|fonts\.googleapis\.com/.test(html), name);
    }
  });

  it('stays well under the 102KB size at which Gmail clips a message', async () => {
    for (const [name, data] of Object.entries(CASES)) {
      const html = await render(name, data);
      assert.ok(html.length < 102 * 1024, `${name} is ${html.length} bytes`);
    }
  });

  it('renders no third-party hosts — the old templates hotlinked SendGrid\'s CDN', async () => {
    for (const [name, data] of Object.entries(CASES)) {
      const html = await render(name, data);
      const hosts = [...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)]
        .map(m => m[1].toLowerCase())
        .filter(h => !h.endsWith('tameside-badminton.co.uk')
          && !h.endsWith('w3.org') && !h.endsWith('schemas.microsoft.com')
          && !h.endsWith('example.com'));
      assert.deepStrictEqual([...new Set(hosts)], [], `${name} references ${hosts.join(', ')}`);
    }
  });
});

describe('optional blocks are genuinely optional', () => {
  // MJML discards an EJS conditional written between two components, which makes the
  // guarded content render unconditionally. mj-raw is the fix and this is the proof.
  it('omits the photo link when there is no photo', async () => {
    const html = await render('scorecard-received',
      { ...CASES['scorecard-received'], photoUrl: null });
    assert.ok(!html.includes('View the scorecard photo'));
  });

  it('omits the score panel for a reminder, which has no result yet', async () => {
    const html = await render('fixture-reminder', CASES['fixture-reminder']);
    assert.ok(!/&ndash;|–/.test(html.split('How everyone played')[0].replace(/&mdash;|—/g, '')),
      'a reminder must not show a score line');
  });

  it('omits the stats table and image when there are none', async () => {
    const html = await render('website-updated',
      { ...CASES['website-updated'], matchStats: [], imageUrl: null });
    assert.ok(!html.includes('How everyone played'));
    assert.ok(!html.includes('/static/images/generated/'));
  });
});

describe('the committed output matches the MJML source', () => {
  it('is not stale — run `npm run build:email` if this fails', () => {
    // Editing the .mjml without rebuilding means the email that goes out is not the one
    // in the source that was reviewed.
    const out = execFileSync(process.execPath,
      [path.join(__dirname, '..', 'tools', 'build-emails.js'), '--check'],
      { encoding: 'utf8' });
    assert.ok(!/STALE/.test(out), out);
  });

  it('has a compiled template for every non-partial source file', () => {
    const sources = fs.readdirSync(SRC_DIR)
      .filter(f => f.endsWith('.mjml') && !f.startsWith('_'))
      .map(f => f.replace(/\.mjml$/, ''));
    for (const name of sources) {
      assert.ok(fs.existsSync(path.join(EMAIL_DIR, name + '.ejs')), `missing views/emails/${name}.ejs`);
    }
    // And every case above corresponds to a real template.
    assert.deepStrictEqual(sources.sort(), Object.keys(CASES).sort());
  });
});
