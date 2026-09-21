// Source assertions over the stylesheets.
//
// Same tactic as the repo-wide grep in `test/site-url.test.js`: the property is about what
// the SOURCE says, and asserting it there costs nothing and needs no browser. `npm test`
// has no DOM, and `static/css/style.css` is generated at image build and gitignored, so
// the SCSS is the only thing that is always present to check.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHEETS = ['bootstrap/style.scss', 'static/css/modern-styles.css'];

// Classes that Bootstrap puts on a shared component used all over the site. A rule with
// one of these as its WHOLE selector applies everywhere, which is the thing that makes a
// stray declaration expensive.
const SHARED = ['alert', 'card', 'badge', 'btn', 'modal', 'table', 'row', 'container',
  'form-control', 'nav-link', 'dropdown-menu'];

describe('no unscoped height on a shared Bootstrap component', () => {
  // **This is a real bug that survived the entire life of the repo**, from the first
  // commit until 21 Sep 2026: `.alert { height: 100% }`, unscoped, in bootstrap/style.scss.
  //
  // Why it hid for so long: `height: 100%` on a child of an auto-height parent computes to
  // `auto` and does nothing. But `views/nav.ejs` opens `<div class="starter-template row">`
  // — a `.row` is display:flex, so every page's `col-*` is a flex item stretched to the
  // full content height, which is a DEFINITE height for `100%` to resolve against. So an
  // alert that happened to be a direct child of the column became as tall as the page.
  //
  // Measured before removal: a **1730px** alert on /admin/social/weekly-fixtures and
  // **1039px** on /admin/social/weekly-tables, pushing everything useful off the screen.
  // Afterwards, 83px and 109px, and every page with no alerts was byte-identical.
  //
  // A percentage or viewport height is what makes it dangerous — it depends on an ancestor
  // the rule cannot see. A fixed `height: 40px` on a shared component would be odd but at
  // least predictable, so it is not what this guards.
  for (const sheet of SHEETS) {
    it(`${sheet} sets no percentage or viewport height on a shared component`, () => {
      const src = fs.readFileSync(path.join(ROOT, sheet), 'utf8');
      const offenders = [];

      for (const name of SHARED) {
        // The selector on its own — `.alert {` — not `.alert .thing {`, not
        // `.something .alert {`, and not `.alert-danger`, all of which are scoped enough
        // to be somebody's deliberate choice.
        const re = new RegExp(`(^|[\\n};])\\s*\\.${name}\\s*\\{([^}]*)\\}`, 'g');
        let m;
        while ((m = re.exec(src)) !== null) {
          const body = m[2];
          const height = body.match(/(^|[;{\s])height\s*:\s*([^;]+)/);
          if (height && /%|vh|vmin|vmax/.test(height[2])) {
            offenders.push(`.${name} { height: ${height[2].trim()} }`);
          }
        }
      }

      assert.deepStrictEqual(offenders, [],
        `Unscoped relative height on a shared component in ${sheet}. This is how every ` +
        `alert on the site became 1730px tall. Scope it to the page that wants it.`);
    });
  }

  // The rule is gone rather than commented out or overridden, and the comment left in its
  // place explains why — so this asserts the removal, not merely that something later
  // cancels it.
  it('has not had the alert rule quietly reinstated', () => {
    const scss = fs.readFileSync(path.join(ROOT, 'bootstrap/style.scss'), 'utf8');
    const live = scss
      .replace(/\/\*[\s\S]*?\*\//g, '')   // strip block comments, where the history lives
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\.alert\s*\{[^}]*height/.test(live),
      '`.alert { height: ... }` is back in bootstrap/style.scss');
  });
});
