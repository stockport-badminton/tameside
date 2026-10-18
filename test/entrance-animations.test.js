// Entrance animations must not hide content.
//
// `.hero` used to fade in from opacity 0 over a second, and every card type slid up from
// opacity 0. Chrome does not count an invisible element as painted, so Largest Contentful
// Paint waited for the fade: on /tables/All the hero <h1> (the LCP element, per PostHog's
// web-vitals attribution) reached the screen ~860ms after first paint on mobile, 18 Oct
// 2026. A transform-only entrance keeps the motion and delays neither LCP nor CLS.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'static', 'css', 'modern-styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function keyframes(name) {
  const start = css.indexOf(`@keyframes ${name}`);
  assert.notStrictEqual(start, -1, `@keyframes ${name} should exist`);
  // Keyframe blocks nest one level: find the brace that closes the outer one.
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unterminated @keyframes ${name}`);
}

for (const name of ['fadeIn', 'slideUp']) {
  test(`@keyframes ${name} never animates opacity`, () => {
    assert.doesNotMatch(keyframes(name), /opacity/,
      `${name} is an entrance animation on above-the-fold content; animating opacity holds back LCP`);
  });
}

test('every element with an entrance animation is switched off for reduced motion', () => {
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
  assert.ok(reduced, 'expected a prefers-reduced-motion block');

  // Selector of every rule that runs fadeIn or slideUp.
  const animated = [];
  const ruleRe = /([^{}]+)\{[^{}]*animation:\s*(?:fadeIn|slideUp)\b[^{}]*\}/g;
  let m;
  while ((m = ruleRe.exec(css))) animated.push(...m[1].split(',').map((s) => s.trim()));
  assert.ok(animated.length > 0);

  for (const selector of animated) {
    assert.ok(reduced[1].includes(selector), `${selector} is animated but not in the reduced-motion block`);
  }
});
