// Inline SVG icons (utils/icons.js), which replaced the Font Awesome webfont. Ported from
// Stockport's __tests__/unit/icons.test.js (league-site HARD-44).
//
// Font Awesome's CSS and fonts are gone from style.css, so an `fa-` class that creeps back
// renders as NOTHING — no error, just a gap. This file is what notices.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { icon } = require('../utils/icons');

const ROOT = path.join(__dirname, '..');

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e)) && !entry.name.endsWith('-old.ejs')) out.push(full);
  }
  return out;
}

const VIEWS = walk(path.join(ROOT, 'views'), ['.ejs']);
const SCRIPTS = walk(path.join(ROOT, 'static', 'js'), ['.js']);

// A Font Awesome class in markup or in a JS-built string: `fa-trophy`, `fas`, `fa-solid`.
const FA_CLASS = /class\s*=\s*\\?["'][^"']*\b(fa|fas|far|fab|fa-[a-z0-9-]+)\b/;

describe('no Font Awesome class is left', () => {
  it('in any view or script', () => {
    const offenders = [];
    for (const file of [...VIEWS, ...SCRIPTS]) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (FA_CLASS.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepStrictEqual(offenders, []);
  });

  it('the guard still recognises the spellings that were in use', () => {
    for (const line of [
      '<i class="fas fa-trophy"></i>',
      '<i class="fa fa-pencil" aria-hidden="true"></i>',
      '<i class="far fa-clock"></i>',
      "text: '<i class=\"fas fa-download\"></i> CSV'",
      '<i class="fa-solid fa-map-location-dot"></i>',
    ]) assert.match(line, FA_CLASS);
    assert.doesNotMatch('<svg class="icon icon-trophy">', FA_CLASS);
  });

  it('neither the stylesheet source nor the header brings Font Awesome back', () => {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'bootstrap', 'style.scss'), 'utf8'), /@import[^;]*fontawesome/);
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'views', 'header.ejs'), 'utf8'), /fontawesome|font-awesome/i);
  });
});

describe('every icon a template asks for exists', () => {
  const used = [];
  for (const file of VIEWS) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/icon\(\s*'([a-z0-9-]+)'(?:\s*,\s*\{([^}]*)\})?/g)) {
      const variant = /variant:\s*'([a-z]+)'/.exec(m[2] || '');
      used.push([m[1], variant ? variant[1] : undefined]);
    }
  }

  it('the templates use plenty of icons (the scan is not silently empty)', () => {
    assert.ok(new Set(used.map((u) => u[0])).size > 50);
  });

  it('each one resolves to an SVG', () => {
    for (const [name, variant] of used) {
      assert.match(icon(name, { variant }), /^<svg class="icon icon-[a-z0-9-]+[^"]*" viewBox="[\d. ]+".*<path d="/, name);
    }
  });
});

describe('icon()', () => {
  it('is decorative by default', () => {
    assert.ok(icon('trophy').includes('aria-hidden="true"'));
    assert.ok(!icon('trophy').includes('role="img"'));
  });

  it('a label makes it an image with a name', () => {
    const svg = icon('phone', { label: 'Call "Jo" <x>' });
    assert.ok(svg.includes('role="img"'));
    assert.ok(svg.includes('aria-label="Call &quot;Jo&quot; &lt;x>"'));
    assert.ok(!svg.includes('aria-hidden'));
  });

  it('extra classes and style are added', () => {
    assert.ok(icon('bars', { class: 'icon-float' }).includes('class="icon icon-bars icon-float"'));
    assert.ok(icon('bars', { style: 'font-size:2em' }).includes('style="font-size:2em"'));
  });

  it('the regular variant is a different drawing from the solid one', () => {
    assert.notStrictEqual(icon('clock', { variant: 'regular' }), icon('clock'));
    assert.throws(() => icon('trophy', { variant: 'nope' }), /bad variant/);
  });

  it('the shuttlecock is the brand mark, drawn in strokes', () => {
    const svg = icon('shuttlecock');
    assert.ok(svg.includes('class="icon icon-shuttlecock icon-stroke"'));
    const nav = fs.readFileSync(path.join(ROOT, 'views', 'nav.ejs'), 'utf8');
    for (const d of svg.matchAll(/ d="([^"]+)"/g)) assert.ok(nav.includes(d[1]), `nav.ejs has drifted from ${d[1]}`);
  });

  // It is dropped into single-quoted JS strings (DataTables button labels, the clubs modal
  // label), so a single quote or a newline in the output would break the page.
  it('output is safe inside a single-quoted JS string', () => {
    for (const name of ['eye', 'magnifying-glass', 'circle-check', 'envelope', 'phone', 'shuttlecock']) {
      assert.doesNotMatch(icon(name, { class: 'x y' }), /['\n\r\\]/, name);
    }
  });

  it('carries no licence comment per use — attribution is once, in the footer', () => {
    assert.ok(!icon('trophy').includes('<!--'));
    assert.match(fs.readFileSync(path.join(ROOT, 'views', 'footer.ejs'), 'utf8'), /Font Awesome Free.*CC BY 4\.0/);
  });

  it('an unknown name throws rather than rendering nothing', () => {
    assert.throws(() => icon('times'), /no Font Awesome icon called "times"/);
    assert.throws(() => icon('../../package'), /bad icon name/);
  });
});
