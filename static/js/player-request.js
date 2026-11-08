// /admin/player-requests/:id — work through the people one registration email names.
// Ported from Stockport's static/beta/js/player-request.js, Bootstrap 5 classes here.
//
// Each person is a card: the reading of the email (editable), the players on file who
// might be them, and three ways out — register one of those players to the chosen team,
// create someone new there, or skip. The writes go through the same roster API the roster
// editor uses; this page then records which button was pressed, so the request shows what
// is left to do.
//
// Everything shown here came out of somebody's email, so it is written with textContent
// and never innerHTML.
(function () {
  'use strict';

  var dataEl = document.getElementById('request-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var root = document.getElementById('request-people');
  var teamsById = {};
  data.teams.forEach(function (t) { teamsById[t.id] = t; });

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function readJson(response) {
    return response.text().then(function (text) {
      var body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
      if (!response.ok) {
        var err = new Error((body && (body.error || body.message)) ||
          (response.status === 401 ? 'Your session has expired — reload and sign in again.' :
           'Request failed (' + response.status + ').'));
        err.status = response.status;
        err.data = body;
        throw err;
      }
      return body;
    });
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(readJson);
  }

  function rosterUrl(team, action) {
    return '/api/roster/club-' + encodeURIComponent(team.clubName) + '/' + action;
  }

  // The team the email named, if it named one we know, by name.
  function teamIdFor(name) {
    if (!name) return '';
    var lower = String(name).toLowerCase();
    for (var i = 0; i < data.teams.length; i++) {
      if (data.teams[i].name.toLowerCase() === lower) return String(data.teams[i].id);
    }
    return '';
  }

  function teamSelect(selectedId) {
    var select = el('select', 'form-select form-select-sm');
    select.appendChild(el('option', null, 'Choose a team…')).value = '';
    var groups = {};
    data.teams.forEach(function (t) {
      if (!groups[t.clubName]) {
        groups[t.clubName] = document.createElement('optgroup');
        groups[t.clubName].label = t.clubName;
        select.appendChild(groups[t.clubName]);
      }
      var o = el('option', null, t.name);
      o.value = String(t.id);
      if (String(t.id) === String(selectedId)) o.selected = true;
      groups[t.clubName].appendChild(o);
    });
    return select;
  }

  function genderSelect(value) {
    var select = el('select', 'form-select form-select-sm');
    [['', 'Gender…'], ['Female', 'Female'], ['Male', 'Male']].forEach(function (pair) {
      var o = el('option', null, pair[1]);
      o.value = pair[0];
      if (pair[0] === (value || '')) o.selected = true;
      select.appendChild(o);
    });
    return select;
  }

  var OUTCOME_TEXT = {
    created: 'Created as a new player',
    attached: 'Registered (was at no club)',
    transferred: 'Registered (transferred from another club)',
    skipped: 'Skipped'
  };

  function render() {
    root.textContent = '';
    if (!data.candidates.length) {
      root.appendChild(el('p', 'text-muted',
        'No names could be read out of this email. Add them below, or dismiss it if it is not a registration.'));
      return;
    }
    data.candidates.forEach(function (c, i) { root.appendChild(card(c, i)); });
  }

  function card(c, index) {
    var wrap = el('div', 'card mb-3' + (c.outcome ? ' border-success' : ''));
    var body = el('div', 'card-body py-2');
    wrap.appendChild(body);

    if (c.raw) body.appendChild(el('p', 'small text-muted mb-2', '“' + c.raw + '”'));

    if (c.outcome) {
      var done = el('div', 'd-flex align-items-center justify-content-between');
      var what = el('div');
      what.appendChild(el('strong', null, c.first + ' ' + c.family));
      what.appendChild(document.createTextNode(' — ' + OUTCOME_TEXT[c.outcome] +
        (c.team ? ', ' + c.team : '')));
      done.appendChild(what);
      var reopen = el('button', 'btn btn-sm btn-link', 'Reopen');
      reopen.type = 'button';
      reopen.title = 'Only reopens this line of the request. It does not undo the change to the player.';
      reopen.addEventListener('click', function () {
        record(index, Object.assign({}, c, { outcome: null, playerId: null }))
          .catch(function (err) { alert(err.message); });
      });
      done.appendChild(reopen);
      body.appendChild(done);
      return wrap;
    }

    var row = el('div', 'row g-2');
    var first = el('input', 'form-control form-control-sm');
    first.value = c.first; first.maxLength = 60; first.setAttribute('aria-label', 'First name');
    var family = el('input', 'form-control form-control-sm');
    family.value = c.family; family.maxLength = 60; family.setAttribute('aria-label', 'Family name');
    var gender = genderSelect(c.gender);
    gender.setAttribute('aria-label', 'Gender');
    var team = teamSelect(teamIdFor(c.team));
    team.setAttribute('aria-label', 'Team');
    [[first, 'col-sm-3'], [family, 'col-sm-3'], [gender, 'col-sm-2'], [team, 'col-sm-4']].forEach(function (pair) {
      var col = el('div', pair[1] + ' mb-2');
      col.appendChild(pair[0]);
      row.appendChild(col);
    });
    body.appendChild(row);

    var message = el('div', 'small mb-2');
    var matchesEl = el('div', 'mb-2');
    body.appendChild(matchesEl);
    body.appendChild(message);

    function current() {
      var t = teamsById[team.value];
      return {
        first: first.value.trim(),
        family: family.value.trim(),
        gender: gender.value || null,
        team: t ? t.name : null,
        raw: c.raw
      };
    }
    function chosenTeam() {
      var t = teamsById[team.value];
      if (!t) { say('Choose the team to register them to first.', true); team.focus(); }
      return t || null;
    }
    function say(text, isError) {
      message.textContent = text;
      message.className = 'small mb-2 ' + (isError ? 'text-danger' : 'text-muted');
    }

    function showMatches(matches) {
      matchesEl.textContent = '';
      if (!matches.length) {
        matchesEl.appendChild(el('p', 'small mb-0', 'Nobody on file looks like this person.'));
        return;
      }
      matchesEl.appendChild(el('p', 'small mb-1 fw-bold', 'Already on file?'));
      matches.forEach(function (m) {
        var line = el('div', 'd-flex align-items-center justify-content-between border-top py-1');
        var who = el('div');
        who.appendChild(el('span', null, m.name));
        var where = [m.clubName || 'No club', m.teamName].filter(Boolean).join(' · ');
        who.appendChild(el('small', 'text-muted ms-2', where + ' · ' + m.gender +
          (m.match === 'close' ? ' · similar name' : '')));
        line.appendChild(who);
        var btn = el('button', 'btn btn-sm btn-outline-success', 'Register this player');
        btn.type = 'button';
        btn.addEventListener('click', function () { registerExisting(m, btn); });
        line.appendChild(btn);
        matchesEl.appendChild(line);
      });
    }
    showMatches(c.matches || []);

    // An existing player: as superadmin the transfer endpoint moves them straight into
    // the chosen team, from no club or from another one, and re-homes their club.
    function registerExisting(m, btn) {
      var t = chosenTeam();
      if (!t) return;
      btn.disabled = true;
      postJson(rosterUrl(t, 'transfer'), { playerId: m.playerId, teamId: t.id })
        .then(function () {
          return record(index, Object.assign(current(), {
            first: m.name.split(' ')[0],
            family: m.name.split(' ').slice(1).join(' '),
            gender: m.gender,
            outcome: m.where === 'unattached' ? 'attached' : 'transferred',
            playerId: m.playerId
          }));
        })
        .catch(function (err) { say(err.message, true); btn.disabled = !!err.recorded; });
    }

    var actions = el('div', 'd-flex flex-wrap');
    var create = el('button', 'btn btn-sm btn-success me-2 mb-1', 'Create as a new player');
    create.type = 'button';
    create.addEventListener('click', function () {
      var t = chosenTeam();
      var now = current();
      if (!t) return;
      if (!now.first || !now.family) return say('Both a first name and a family name are needed.', true);
      if (!now.gender) { gender.focus(); return say('Choose a gender first.', true); }
      create.disabled = true;
      // confirmNew: the possible matches are on the card, right above this button.
      postJson(rosterUrl(t, 'players'), {
        firstName: now.first, familyName: now.family, gender: now.gender,
        teamId: t.id, section: 'reserve', confirmNew: true
      }).then(function (res) {
        return record(index, Object.assign(now, { outcome: 'created', playerId: res.created.playerId }));
      }).catch(function (err) { say(err.message, true); create.disabled = !!err.recorded; });
    });
    actions.appendChild(create);

    var recheck = el('button', 'btn btn-sm btn-outline-secondary me-2 mb-1', 'Check again');
    recheck.type = 'button';
    recheck.title = 'Match the name as edited above';
    recheck.addEventListener('click', function () {
      var now = current();
      var q = (now.first + ' ' + now.family).trim();
      say('Checking…');
      fetch('/admin/player-requests/match?q=' + encodeURIComponent(q) +
            '&gender=' + encodeURIComponent(now.gender || ''), { credentials: 'same-origin' })
        .then(readJson)
        .then(function (res) { say(''); showMatches(res.matches); })
        .catch(function (err) { say(err.message, true); });
    });
    actions.appendChild(recheck);

    var skip = el('button', 'btn btn-sm btn-link mb-1', 'Skip — not a registration');
    skip.type = 'button';
    skip.addEventListener('click', function () {
      record(index, Object.assign(current(), { outcome: 'skipped', playerId: null }))
        .catch(function (err) { say(err.message, true); });
    });
    actions.appendChild(skip);
    body.appendChild(actions);

    return wrap;
  }

  // Record the outcome, then redraw from what the server stored. If this fails after a
  // roster write succeeded, the player HAS been registered — so say that, rather than
  // leaving a line that invites doing it twice.
  function record(index, candidate) {
    return postJson('/admin/player-requests/' + data.id + '/candidates/' + index, candidate)
      .then(function (res) {
        data.candidates = res.candidates.map(function (c, i) {
          return Object.assign({}, c, { matches: (data.candidates[i] && data.candidates[i].matches) || [] });
        });
        render();
      })
      .catch(function (err) {
        if (candidate.outcome && candidate.outcome !== 'skipped') {
          var e = new Error('Done on the roster, but this page could not record it (' + err.message +
            '). Reload before doing anything else with this person.');
          // Keeps the button disabled: pressing it again would create them twice.
          e.recorded = true;
          throw e;
        }
        throw err;
      });
  }

  document.getElementById('request-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var first = document.getElementById('addFirst');
    var family = document.getElementById('addFamily');
    if (!first.value.trim() || !family.value.trim()) return;
    postJson('/admin/player-requests/' + data.id + '/candidates', {
      first: first.value, family: family.value
    }).then(function (res) {
      first.value = '';
      family.value = '';
      var q = res.candidates[res.index].first + ' ' + res.candidates[res.index].family;
      return fetch('/admin/player-requests/match?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
        .then(readJson)
        .then(function (m) {
          data.candidates = res.candidates.map(function (c, i) {
            var old = data.candidates[i];
            return Object.assign({}, c, { matches: i === res.index ? m.matches : (old && old.matches) || [] });
          });
          render();
        });
    }).catch(function (err) { alert(err.message); });
  });

  render();
})();
