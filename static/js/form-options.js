// The <option> lists behind the scorecard pages' cascading dropdowns
// (division -> teams -> eligible players), built with DOM calls.
//
// This replaces client-side EJS. static/formOption.ejs and static/playerFormOptions.ejs
// were fetched over the network and rendered in the browser with ejs.render, and EJS
// compiles a template with `new Function`, which is exactly what CSP's 'unsafe-eval'
// gates. They were the only thing on the site that needed it, so this is what lets
// CSP_ENFORCE=true leave the wizard working (utils/securityHeaders.js). Ported from
// Stockport (league-site 9e6f2df, static/beta/js/form-options.js), same API.
//
// **The output is OURS, not Stockport's**, i.e. exactly what the two templates rendered:
//
//  1. The placeholder is `value="" disabled selected`. Stockport's has NO value, which is
//     the opposite of our rule: an option without a value reads back its label, and
//     script reading select.value then sends "Choose..." as an id (TAMESIDE-NODE-4; see
//     CLAUDE.md, Scorecard Validation). test/scorecard-no-player.test.js pins it.
//  2. "No Player Home Team" and "No Player Away Team" both carry value 0, the "nobody"
//     sentinel, and come AFTER the players, where they have always been. (Stockport moved
//     them to the top; that is a change captains would see mid-season, not part of this.)
//  3. Text is set with textContent, never innerHTML, so a name cannot become markup.
//     The EJS version was safe because <%= %> escapes; this is safe by construction.
//
// Nodes are built fresh per select. One HTML string can go into several selects; one
// DOM node cannot (appending it again moves it), hence fill*, not build*.

(function (global) {
  'use strict';

  function option(value, text) {
    var o = document.createElement('option');
    o.value = String(value);
    o.textContent = text;
    return o;
  }

  function placeholder() {
    var o = option('', 'Choose...');
    o.disabled = true;
    o.selected = true;
    return o;
  }

  // A selector string, an element, or anything array-like of elements (a NodeList, an
  // array, a jQuery object), so a call can fill several selects at once.
  function eachTarget(targets, fn) {
    if (!targets) return;
    if (typeof targets === 'string') targets = document.querySelectorAll(targets);
    var list = targets.length !== undefined ? targets : [targets];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].nodeType === 1) fn(list[i]);
    }
  }

  function fill(targets, build) {
    eachTarget(targets, function (select) {
      var frag = document.createDocumentFragment();
      frag.appendChild(placeholder());
      build(frag);
      while (select.firstChild) select.removeChild(select.firstChild);
      select.appendChild(frag);
    });
  }

  // Stored as two columns, joined with one space. Trimmed so a stray space in either
  // column cannot render as a double one.
  function playerName(row) {
    return [row.first_name, row.family_name]
      .map(function (p) { return String(p == null ? '' : p).trim(); })
      .filter(function (p) { return p; })
      .join(' ');
  }

  global.FormOptions = {
    // Division -> teams. Replaces static/formOption.ejs.
    fillTeams: function (targets, rows) {
      fill(targets, function (frag) {
        (rows || []).forEach(function (r) { frag.appendChild(option(r.id, r.name)); });
      });
    },

    // Team + gender -> eligible players. Replaces static/playerFormOptions.ejs.
    fillPlayers: function (targets, rows) {
      fill(targets, function (frag) {
        (rows || []).forEach(function (r) { frag.appendChild(option(r.id, playerName(r))); });
        frag.appendChild(option(0, 'No Player Home Team'));
        frag.appendChild(option(0, 'No Player Away Team'));
      });
    },
  };
})(window);
