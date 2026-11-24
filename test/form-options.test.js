// static/js/form-options.js: the scorecard pages' <option> lists, built with DOM calls.
// It replaced static/formOption.ejs and static/playerFormOptions.ejs, rendered with EJS in
// the browser, which needs CSP 'unsafe-eval'. This pins that the output is what those
// templates produced, run in a vm against a minimal fake DOM (no jsdom here). The real
// browser behaviour is covered by the e2e wizard specs.

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'static', 'js', 'form-options.js'), 'utf8');

function fakeDom(ids) {
  function node(tag) {
    return {
      nodeType: tag === '#fragment' ? 11 : 1, tagName: tag, children: [],
      value: '', textContent: '', disabled: false, selected: false,
      get firstChild() { return this.children[0] || null; },
      removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; },
      appendChild(c) {
        if (c.nodeType === 11) { this.children.push(...c.children); c.children = []; } else this.children.push(c);
        return c;
      },
    };
  }
  const els = Object.fromEntries(ids.map((id) => [id, Object.assign(node('select'), { id })]));
  // The stale option a previous division left behind; it must go.
  for (const el of Object.values(els)) el.children.push(Object.assign(node('option'), { value: '99', textContent: 'stale' }));
  const document = {
    createElement: node,
    createDocumentFragment: () => node('#fragment'),
    querySelectorAll: (sel) => sel.split(',').map((s) => els[s.trim().replace(/^#/, '')]).filter(Boolean),
  };
  const window = {};
  vm.runInNewContext(SRC, { window, document });
  return { FormOptions: window.FormOptions, els };
}

const shape = (sel) => sel.children.map((o) => ({ value: o.value, text: o.textContent, disabled: o.disabled, selected: o.selected }));

describe('FormOptions.fillTeams', () => {
  test('placeholder, then one option per team, in every target', () => {
    const { FormOptions, els } = fakeDom(['homeTeam', 'awayTeam']);
    FormOptions.fillTeams('#homeTeam, #awayTeam', [{ id: 7, name: 'Hyde A' }, { id: 9, name: 'Disley B' }]);
    for (const id of ['homeTeam', 'awayTeam']) {
      assert.deepStrictEqual(shape(els[id]), [
        { value: '', text: 'Choose...', disabled: true, selected: true },
        { value: '7', text: 'Hyde A', disabled: false, selected: false },
        { value: '9', text: 'Disley B', disabled: false, selected: false },
      ]);
    }
    assert.notStrictEqual(els.homeTeam.children[1], els.awayTeam.children[1], 'fresh nodes per select');
  });

  test('an array of elements works as well as a selector', () => {
    const { FormOptions, els } = fakeDom(['homeTeam']);
    FormOptions.fillTeams([els.homeTeam, null], []);
    assert.deepStrictEqual(shape(els.homeTeam).map((o) => o.text), ['Choose...']);
  });
});

describe('FormOptions.fillPlayers', () => {
  test('placeholder, players, then the two "No Player" options at 0, as the template had them', () => {
    const { FormOptions, els } = fakeDom(['homeMan1']);
    FormOptions.fillPlayers('#homeMan1', [{ id: 12, first_name: 'Dave ', family_name: ' Lee' }]);
    assert.deepStrictEqual(shape(els.homeMan1), [
      { value: '', text: 'Choose...', disabled: true, selected: true },
      { value: '12', text: 'Dave Lee', disabled: false, selected: false },
      { value: '0', text: 'No Player Home Team', disabled: false, selected: false },
      { value: '0', text: 'No Player Away Team', disabled: false, selected: false },
    ]);
  });

  // The placeholder carries value="" (CLAUDE.md, Scorecard Validation), unlike
  // Stockport's, which has none and so reads back its label as the value.
  test('the placeholder value is the empty string, never its label', () => {
    const { FormOptions, els } = fakeDom(['homeLady1']);
    FormOptions.fillPlayers('#homeLady1', []);
    assert.strictEqual(els.homeLady1.children[0].value, '');
  });

  test('a name is text, never markup', () => {
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(SRC.replace(/\/\/.*$/gm, '')));
  });
});

// A team change must refill every roster select the page has. The confirmation page
// refilled men 1-3 and a nonexistent lady 3, so man 4 kept the OLD team's player, and the
// step script then copied him into Second/Fourth Men's and Fourth Mixed (found 24 Nov 2026).
describe('a team change refills exactly the roster selects on the page', () => {
  const ROSTER = ['Man1', 'Man2', 'Man3', 'Man4', 'Lady1', 'Lady2'];
  for (const view of ['index-scorecard', 'populated-scorecard']) {
    test(view, () => {
      const src = fs.readFileSync(path.join(ROOT, 'views', view + '.ejs'), 'utf8');
      const filled = [...src.matchAll(/FormOptions\.fillPlayers\('([^']+)'/g)]
        .flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/^#/, '')));
      const onPage = [...src.matchAll(/<select[^>]*\bid="((?:home|away)(?:Man|Lady)\d)"/g)].map((m) => m[1]);
      const expected = ['home', 'away'].flatMap((side) => ROSTER.map((r) => side + r));
      assert.deepStrictEqual([...onPage].sort(), [...expected].sort(), 'the roster selects on the page');
      assert.deepStrictEqual([...filled].sort(), [...expected].sort());
    });
  }

  test('email-scorecard', () => {
    const src = fs.readFileSync(path.join(ROOT, 'views', 'email-scorecard.ejs'), 'utf8');
    assert.ok(src.includes("selects([side + 'Man1', side + 'Man2', side + 'Man3', side + 'Man4'])"));
    assert.ok(src.includes("selects([side + 'Lady1', side + 'Lady2'])"));
  });
});

// The reason this file exists: client-side EJS compiles templates with new Function,
// which needs CSP 'unsafe-eval' (utils/securityHeaders.js).
test('no page templates in the browser any more', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); continue; }
      if (!/\.(ejs|js)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/\/scripts\/ejs\/|\bejs\.render\(|\bejs\.compile\(/.test(src)) hits.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'views'));
  walk(path.join(ROOT, 'static'));
  assert.deepStrictEqual(hits, []);
});
