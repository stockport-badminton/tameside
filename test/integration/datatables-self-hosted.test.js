// DataTables is self-hosted, deferred, and brings no jQuery of its own.
//
// It came from cdn.datatables.net: a render-blocking stylesheet in the head on a host
// nothing else on the page used, then the bundle and two plug-ins as synchronous scripts,
// two of them over protocol-relative URLs. On /results/All in Lighthouse mobile, 18 Oct
// 2026, those four cost ~2.3s of the 3.2s render-blocking estimate. The bundle also
// carried jQuery 3.3.1, loaded on top of footer.ejs's copy. Ported from Stockport's
// HARD-45 (league-site 218692e), minus the jQuery: theirs never had it.
//
// The partials are rendered for real rather than grepped, because what matters is the
// URL assetUrl() produces — and a path that does not resolve comes back with a
// fallback version, not a content hash, which is exactly the failure to catch.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const request = require('supertest');

const { app } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'views');

function render(file, data) {
  return ejs.renderFile(path.join(VIEWS, file), Object.assign({}, app.locals, data || {}));
}

function tags(html) {
  const out = [];
  const re = /<(script|link)\b([^>]*?)(?:src|href)\s*=\s*"([^"]+)"([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ tag: m[1].toLowerCase(), url: m[3], attrs: m[2] + m[4] });
  }
  return out;
}

const PARTIALS = [
  ['datatables-css.ejs', {}],
  ['datatables.ejs', {}],
  ['datatables-stats.ejs', { dtColumnSearch: true }],
];

for (const [file, data] of PARTIALS) {
  test(`${file}: every file is same-origin, content-hashed, deferred and served`, async () => {
    const found = tags(await render(file, data));
    assert.ok(found.length > 0, 'asks for something, or the scan is broken');

    for (const { tag, url, attrs } of found) {
      assert.match(url, /^\/static\/vendor\/datatables\/[^?]+\?v=[0-9a-f]{12}$/, url);
      if (tag === 'script') assert.match(attrs, /\bdefer\b/, `${url} must not block parsing`);

      const res = await request(app).get(url);
      assert.strictEqual(res.status, 200, url);
    }
  });
}

test('the plug-ins come after the bundle they register on', async () => {
  // `defer` runs scripts in document order. date-euro and page.jumpToData() touch
  // jQuery.fn.dataTable at the top level, so before the bundle they throw.
  const urls = tags(await render('datatables.ejs')).map((t) => t.url.split('?')[0]);
  assert.deepStrictEqual(urls, [
    '/static/vendor/datatables/datatables.min.js',
    '/static/vendor/datatables/date-euro.js',
    '/static/vendor/datatables/page.jumpToData.js',
  ]);
});

test('the bundle carries no jQuery of its own', () => {
  // A second jQuery replaces window.jQuery with an instance the page's other code
  // never registered anything on. footer.ejs provides the one copy.
  const bundle = fs.readFileSync(path.join(ROOT, 'static/vendor/datatables/datatables.min.js'), 'utf8');
  assert.doesNotMatch(bundle.slice(0, 1000), /jQuery \d/, 'header lists jQuery as an included library');
  assert.doesNotMatch(bundle, /jQuery JavaScript Library/);
});

test('every view that loads DataTables does so after footer.ejs', () => {
  // The deferred bundle needs window.jQuery, which only footer.ejs defines, and the
  // inline initialisers call $(document).ready at parse time.
  const users = fs.readdirSync(VIEWS).filter((f) => f.endsWith('.ejs') && !f.endsWith('-old.ejs'));
  let checked = 0;
  for (const f of users) {
    const src = fs.readFileSync(path.join(VIEWS, f), 'utf8');
    const dt = src.search(/include\('datatables(-stats)?\.ejs'/);
    if (dt === -1 || f.startsWith('datatables')) continue;
    const footer = src.indexOf("include('footer.ejs')");
    assert.ok(footer !== -1 && footer < dt, `${f} includes DataTables before footer.ejs`);
    checked++;
  }
  assert.ok(checked >= 8, `expected the eight DataTables views, found ${checked}`);
});

test('no template loads anything from cdn.datatables.net', () => {
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ejs')) continue;
      // Comments may name the host to say why it is gone; a tag may not.
      for (const t of tags(fs.readFileSync(full, 'utf8'))) {
        if (t.url.includes('cdn.datatables.net')) offenders.push(path.relative(VIEWS, full));
      }
    }
  })(VIEWS);
  assert.deepStrictEqual(offenders, []);
});
