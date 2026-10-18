// jQuery loads only on the pages that use it, self-hosted (views/footer.ejs, useJQuery).
//
// It was a parser-blocking script from code.jquery.com on every page; on the homepage,
// which uses none of it, Lighthouse mobile put ~1.2s of first paint on it (18 Oct 2026).
// The failure this guards against is the quiet one: a page that calls $ without opting in
// renders fine on the server and throws `$ is not defined` in the browser, which nothing
// server-side would ever notice.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const { assetUrl } = require('../utils/assets');

const VIEWS = path.join(__dirname, '..', 'views');

// Calls, not mentions: several views explain in comments why they do NOT use jQuery.
const USES_JQUERY = /\$\(|\bjQuery[.(]|\$\.[a-zA-Z]+\(/;

function stripComments(src) {
  return src
    .replace(/<%\s*\/\*[\s\S]*?\*\/\s*%>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// Comments are stripped up front: several views quote the include or name jQuery in a
// comment explaining why they do not need it.
function views() {
  return fs.readdirSync(VIEWS)
    .filter((f) => f.endsWith('.ejs') && !f.endsWith('-old.ejs'))
    .map((f) => ({ file: f, src: stripComments(fs.readFileSync(path.join(VIEWS, f), 'utf8')) }));
}

const all = views();
const jqueryPartials = all
  .filter((v) => !/include\('footer\.ejs'/.test(v.src) && USES_JQUERY.test(v.src))
  .map((v) => v.file);

test('the scan finds the partials that use jQuery, or it is broken', () => {
  for (const f of ['datatables.ejs', 'datatables-stats.ejs']) {
    assert.ok(jqueryPartials.includes(f), `${f} should be detected as using jQuery`);
  }
});

test('every page that uses jQuery, directly or through a partial, opts in', () => {
  const missing = [];
  for (const { file, src } of all) {
    if (!/include\('footer\.ejs'/.test(src)) continue;
    const direct = USES_JQUERY.test(src);
    const viaPartial = jqueryPartials.some((p) => src.includes(`include('${p}'`));
    if ((direct || viaPartial) && !/include\('footer\.ejs', \{ useJQuery: true \}\)/.test(src)) {
      missing.push(file);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test('pages that do not use it do not load it', () => {
  const needless = [];
  for (const { file, src } of all) {
    if (!/include\('footer\.ejs', \{ useJQuery: true \}\)/.test(src)) continue;
    const direct = USES_JQUERY.test(src);
    const viaPartial = jqueryPartials.some((p) => src.includes(`include('${p}'`));
    if (!direct && !viaPartial) needless.push(file);
  }
  assert.deepStrictEqual(needless, []);
});

test('the footer loads it self-hosted, and only when asked', async () => {
  const render = (data) => ejs.renderFile(path.join(VIEWS, 'footer.ejs'), { assetUrl, ...data });

  const without = await render({});
  assert.doesNotMatch(without, /jquery/i);

  const withIt = await render({ useJQuery: true });
  assert.match(withIt, /<script src="\/scripts\/jquery\/dist\/jquery\.min\.js\?v=[0-9a-f]{12}"><\/script>/);
  assert.doesNotMatch(withIt, /code\.jquery\.com/);
});

test('the homepage, tables and clubs pages are among those without it', () => {
  // The busiest pages, and the reason for doing this at all.
  for (const f of ['homepage.ejs', 'tables.ejs', 'club.ejs']) {
    const v = all.find((x) => x.file === f);
    if (!v) continue;
    assert.doesNotMatch(v.src, /useJQuery/, f);  // comments already stripped
  }
});
