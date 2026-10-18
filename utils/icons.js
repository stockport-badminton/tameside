'use strict';

// Inline SVG icons, replacing the Font Awesome webfont. Ported from Stockport's
// utils/icons.js (league-site HARD-44, 89fb03d), Oct 2026.
//
// The site used ~60 icons and paid for all ~2,000: Font Awesome's CSS compiled into
// style.css, then fa-solid-900.woff2 (157 KB) on every page — the nav carries a solid icon
// — and fa-regular-400.woff2 wherever an outline icon appeared. The same package ships each
// icon as an SVG file, so `icon('trophy')` reads that file once and inlines the path: a few
// hundred bytes per icon, no font, no stylesheet, nothing to build.
//
// Inline rather than a sprite file: no extra request, and the result can go inside the JS
// strings that build DataTables buttons. Names are Font Awesome 6's file names (`xmark`,
// not the v4 alias `times`). An unknown name THROWS, at render, so a typo is a 500 in the
// test that renders the page rather than a blank space nobody notices.
//
// Two additions over Stockport's, both because Tameside's markup needed them:
//   - `variant: 'regular'` for the outline style (`far fa-clock`); without it the solid
//     icon of the same name would be drawn, which is a different-looking icon.
//   - CUSTOM icons, for the one Font Awesome Free lacks: `fa-shuttle-badminton` is Pro
//     only, so those two places rendered nothing at all. They now get the site's own
//     shuttlecock, the brand mark in nav.ejs.
//
// Icons: Font Awesome Free by @fontawesome — https://fontawesome.com/license/free
// (Icons: CC BY 4.0). Attribution is also carried once in views/footer.ejs.

const fs = require('fs');
const path = require('path');

const SVG_DIR = path.join(__dirname, '..', 'node_modules', '@fortawesome', 'fontawesome-free', 'svgs');
const STYLES = ['solid', 'brands', 'regular'];

// Drawn with strokes rather than fills, so they carry the `icon-stroke` class (CSS turns
// the fill off and the stroke on) and their own stroke attributes.
const CUSTOM = {
  // The brand mark from views/nav.ejs, so the two cannot look like different shuttlecocks.
  shuttlecock: {
    viewBox: '0 0 24 24',
    attrs: 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"',
    class: 'icon-stroke',
    body: '<path d="M4 3h16l-5 12H9z"/><path d="M9.5 3l1.5 12M14.5 3l-1.5 12M4 3l5 12M20 3l-5 12" opacity=".6"/>'
      + '<path d="M8.5 15h7v1.5a3.5 3.5 0 0 1-7 0z" fill="currentColor"/>',
  },
};

const cache = new Map();

function load(name, variant) {
  const key = name + '/' + (variant || '');
  if (cache.has(key)) return cache.get(key);
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`icon(): bad icon name "${name}"`);
  if (!variant && CUSTOM[name]) return CUSTOM[name];
  if (variant && !STYLES.includes(variant)) throw new Error(`icon(): bad variant "${variant}"`);
  for (const style of variant ? [variant] : STYLES) {
    let svg;
    try { svg = fs.readFileSync(path.join(SVG_DIR, style, name + '.svg'), 'utf8'); } catch (e) { continue; }
    const viewBox = /viewBox="([^"]+)"/.exec(svg)[1];
    const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<!--[\s\S]*?-->/g, '');
    const parsed = { viewBox, body };
    cache.set(key, parsed);
    return parsed;
  }
  throw new Error(`icon(): no Font Awesome icon called "${name}"${variant ? ` in ${variant}` : ''}`);
}

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// icon('trophy')                         decorative: aria-hidden
// icon('clock', { variant: 'regular' })  the outline style
// icon('phone', { label: 'Call' })       meaningful on its own: role="img" + aria-label
// icon('map-location-dot', { class: 'map-placeholder-icon' })
// icon('up-right-from-square', { style: 'font-size:0.65rem' })
//
// Output uses double quotes only and no newlines, so it can sit inside a single-quoted JS
// string.
function icon(name, opts) {
  opts = opts || {};
  const def = load(name, opts.variant);
  const cls = 'icon icon-' + name + (def.class ? ' ' + def.class : '') + (opts.class ? ' ' + opts.class : '');
  const a11y = opts.label
    ? `role="img" aria-label="${escapeAttr(opts.label)}"`
    : 'aria-hidden="true" focusable="false"';
  const style = opts.style ? ` style="${escapeAttr(opts.style)}"` : '';
  const attrs = def.attrs ? ' ' + def.attrs : '';
  return `<svg class="${escapeAttr(cls)}" viewBox="${def.viewBox}"${attrs}${style} ${a11y}>${def.body.replace(/\s*\n\s*/g, '')}</svg>`;
}

module.exports = { icon };
