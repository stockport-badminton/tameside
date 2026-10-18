// Inter and Poppins are self-hosted, declared inline, and preloaded (views/webfonts.ejs).
//
// They were a render-blocking stylesheet on fonts.googleapis.com, which then fetched the
// files from fonts.gstatic.com — two extra hosts before any text could paint. Lighthouse
// mobile put ~850ms of first paint on it, 18 Oct 2026.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const { assetUrl } = require('../utils/assets');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');

function renderFonts() {
  return ejs.renderFile(path.join(VIEWS, 'webfonts.ejs'), { assetUrl });
}

test('no view loads anything from Google Fonts', () => {
  const offenders = fs.readdirSync(VIEWS)
    .filter((f) => f.endsWith('.ejs') && !f.endsWith('-old.ejs'))
    .filter((f) => /<link[^>]+fonts\.(googleapis|gstatic)\.com/.test(fs.readFileSync(path.join(VIEWS, f), 'utf8')));
  assert.deepStrictEqual(offenders, []);
});

test('the header includes the self-hosted faces', () => {
  assert.match(fs.readFileSync(path.join(VIEWS, 'header.ejs'), 'utf8'), /include\('webfonts\.ejs'\)/);
});

test('every font URL is a content-hashed file that exists', async () => {
  const html = await renderFonts();
  const urls = [...html.matchAll(/(?:url\(|href=")(\/static\/fonts\/[^)"]+)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 6, 'the scan found the faces');
  for (const url of urls) {
    // assetUrl() returns a path it cannot hash unchanged, so an unversioned URL here
    // means the file is missing.
    assert.match(url, /\.woff2\?v=[0-9a-f]{12}$/, url);
    assert.ok(fs.existsSync(path.join(ROOT, url.split('?')[0])), url);
  }
});

test('the weights match what Google declared, so nothing renders differently', async () => {
  // Inter is one variable file, but a "400 700" range would turn the stylesheet's
  // font-weight: 500 into true medium where it has always matched the 400 face.
  const html = await renderFonts();
  const faces = [...html.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1]);
  const weights = (family) => faces
    .filter((f) => f.includes(`font-family: '${family}'`))
    .map((f) => f.match(/font-weight: ([^;]+);/)[1]);
  assert.deepStrictEqual([...new Set(weights('Inter'))].sort(), ['400', '600', '700']);
  assert.deepStrictEqual([...new Set(weights('Poppins'))].sort(), ['600', '700']);
  for (const f of faces) assert.match(f, /font-display: swap;/);
});

test('the heading and body fonts are preloaded, with crossorigin or the preload is wasted', async () => {
  const html = await renderFonts();
  const preloads = [...html.matchAll(/<link rel="preload"[^>]*>/g)].map((m) => m[0]);
  assert.strictEqual(preloads.length, 2);
  for (const p of preloads) {
    assert.match(p, /as="font"/);
    assert.match(p, /\bcrossorigin\b/);
  }
  assert.ok(preloads.some((p) => p.includes('poppins-700-latin.woff2')));
  assert.ok(preloads.some((p) => p.includes('inter-latin.woff2')));
});

test('the OFL licences travel with the files', () => {
  for (const f of ['INTER-OFL.txt', 'POPPINS-OFL.txt']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'static', 'fonts', f)), f);
  }
});
