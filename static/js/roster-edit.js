/* Team management editor — reordering, moves, and the add/transfer flow.
 *
 * Used by views/roster-edit.ejs (superadmin only). Ported from Stockport's
 * static/beta/js/roster-edit.js, current as of Oct 2026 (including 499a87a's listUnder /
 * reanchor drag fixes). Kept close to theirs on purpose so later fixes there apply here.
 * Differences:
 *   - Bootstrap 5: modals open through bootstrap.Modal, not jQuery's modal plugin. This file
 *     doesn't use jQuery at all, so a code.jquery.com outage (see 97deca11) can't break it.
 *   - A transfer from another club is applied, not requested: only a superadmin reaches this
 *     page, and they are who approves transfers. So the button says "Transfer here".
 *   - A 401 is a JSON answer here (securedApi in app.js), so the expired-session message
 *     below is actually reachable; on the Stockport side fetch follows a redirect instead.
 *   - Two drag fixes found in the port: drag moves are heard on the window rather than the
 *     handle (see onHandleDown) — a bug Stockport's copy has too — and auto-scroll scrolls
 *     with behavior 'instant' (see autoScroll), which only Bootstrap 5's smooth scrolling needs.
 *
 * What this replaces, and why it's built this way:
 *
 * - The old page bound only dragstart/dragover/drop. Mobile browsers don't
 *   synthesise those from touch, so on a phone there was no way to reorder anyone
 *   at all, and no fallback: Move Up / Move Down were in the menu but their
 *   handlers were bound by position (`button:nth-child(1)` and `(2)`), so items 3
 *   and 4 never got a listener. Pointer events cover mouse, touch and pen from one
 *   code path, and the arrow keys work on a focused handle.
 *
 * - Each drop wrote straight to the database, one fetch per gesture, with the DOM
 *   already moved and the error path only calling console.error — so a failed save
 *   looked exactly like a successful one. Here the DOM is the working copy, the
 *   Save bar shows what's pending, and a failed save re-renders from the server's
 *   answer rather than leaving the screen lying.
 *
 * - Team and section were re-derived by walking up four parentElements and reading
 *   positional indices (`children[0].attributes[1].nodeValue`). Every list carries
 *   data-team / data-gender / data-section instead.
 */
(function () {
  'use strict';

  var root = document.getElementById('roster-editor');
  if (!root) return;

  var CLUB_URL = root.dataset.clubUrl;
  var saveBar = document.getElementById('roster-savebar');
  var saveMsg = document.getElementById('roster-savebar-msg');
  var toastEl = document.getElementById('roster-toast');

  // The server's state, so Discard can restore it and the Save bar can count what
  // actually differs rather than counting gestures.
  var baseline = new Map();
  // Which section a row started in, so a row dragged out and back reads as clean.
  var pending = { moveRow: null, addContext: null, lastSearch: [] };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function lists() {
    return Array.prototype.slice.call(root.querySelectorAll('.roster-list'));
  }

  function rowsIn(list) {
    return Array.prototype.slice.call(list.children).filter(function (el) {
      return el.classList.contains('roster-row');
    });
  }

  function listKey(list) {
    return list.dataset.team + ':' + list.dataset.gender + ':' + list.dataset.section;
  }

  function snapshot() {
    var state = new Map();
    lists().forEach(function (list) {
      state.set(listKey(list), rowsIn(list).map(function (r) { return r.dataset.playerId; }));
    });
    return state;
  }

  function captureBaseline() {
    baseline = snapshot();
  }

  function modal(id) {
    return window.bootstrap.Modal.getOrCreateInstance(document.getElementById(id));
  }

  function toast(message, kind, action) {
    toastEl.textContent = '';
    toastEl.className = 'roster-toast show' + (kind === 'error' ? ' error' : '');
    toastEl.appendChild(document.createTextNode(message));
    if (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', function () {
        hideToast();
        action.onClick();
      });
      toastEl.appendChild(btn);
    }
    clearTimeout(toastEl._timer);
    // An error, or anything with an action on it, stays up long enough to read and
    // act on. The old page used alert() for all of this.
    toastEl._timer = setTimeout(hideToast, action ? 12000 : kind === 'error' ? 8000 : 3200);
  }

  function hideToast() {
    toastEl.className = 'roster-toast';
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  // Rank labels and the changed-since-load markers. Positions are recomputed from
  // the DOM every time rather than tracked incrementally, which is what let the old
  // code drift out of step with what the server held.
  function refresh() {
    var changedTeams = new Set();

    lists().forEach(function (list) {
      var isReserve = list.dataset.section === 'reserve';
      var rows = rowsIn(list);
      var before = baseline.get(listKey(list)) || [];

      rows.forEach(function (row, i) {
        row.querySelector('.rank').textContent = isReserve ? 'R' + (i + 1) : String(i + 1);
        row.classList.toggle('is-reserve', isReserve);
        var moved = before[i] !== row.dataset.playerId;
        row.classList.toggle('moved', moved);
        if (moved) changedTeams.add(list.dataset.team);
      });

      // A list emptied by a drag still needs to be a drop target.
      list.classList.toggle('is-empty-target', rows.length === 0);

      var label = list.previousElementSibling;
      if (label && label.classList.contains('roster-section-label')) {
        var counter = label.lastElementChild;
        if (counter) counter.textContent = String(rows.length);
      }
    });

    // Card headline counts.
    root.querySelectorAll('.roster-card').forEach(function (card) {
      var nominated = 0;
      var reserve = 0;
      card.querySelectorAll('.roster-list').forEach(function (list) {
        var n = rowsIn(list).length;
        if (list.dataset.section === 'reserve') reserve += n; else nominated += n;
      });
      var el = card.querySelector('.team-count');
      if (el) {
        el.textContent = nominated + ' nominated' + (reserve ? ' · ' + reserve + ' reserve' : '');
      }
    });

    updateSaveBar(changedTeams);
    return changedTeams;
  }

  function changedTeamIds() {
    var changed = new Set();
    lists().forEach(function (list) {
      var now = rowsIn(list).map(function (r) { return r.dataset.playerId; });
      var before = baseline.get(listKey(list)) || [];
      if (now.length !== before.length || now.some(function (id, i) { return id !== before[i]; })) {
        changed.add(list.dataset.team);
      }
    });
    return changed;
  }

  function updateSaveBar(changedTeams) {
    var teams = changedTeams || changedTeamIds();
    if (!teams.size) {
      saveBar.hidden = true;
      return;
    }
    var movedRows = root.querySelectorAll('.roster-row.moved').length;
    saveMsg.textContent = movedRows + (movedRows === 1 ? ' player moved' : ' players moved') +
      ' in ' + teams.size + (teams.size === 1 ? ' team' : ' teams');
    saveBar.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Reordering: pointer (mouse, touch, pen)
  // ---------------------------------------------------------------------------

  var drag = null;
  var EDGE = 56; // px from a window edge at which a drag starts scrolling the page

  function onHandleDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    var row = e.currentTarget.closest('.roster-row');
    if (!row) return;

    // Stops the page scrolling under the finger. Paired with touch-action: none on
    // the handle in roster.css — one without the other doesn't work on iOS.
    e.preventDefault();
    closeMenu();

    var handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    var rect = row.getBoundingClientRect();
    drag = {
      row: row,
      handle: handle,
      pointerId: e.pointerId,
      from: row.parentElement,
      clientY: e.clientY,
      // Where in the row the pointer landed, and where the row's in-flow top sits
      // in *document* coordinates. Working in document space rather than from a
      // running delta means the row stays put under the finger when the list
      // reflows around it or the page scrolls mid-drag.
      grabOffset: e.clientY - rect.top,
      baseTop: rect.top + window.pageYOffset,
      pageY: e.pageY,
      raf: 0
    };
    row.classList.add('grabbed');
    // Only the lists this row may legally be dropped into: same team, same gender.
    // Cross-team and cross-gender moves go through the move dialog, because the
    // destination is usually off-screen and ranks are numbered per gender.
    drag.targets = lists().filter(function (list) {
      return list.dataset.team === drag.from.dataset.team &&
             list.dataset.gender === drag.from.dataset.gender;
    });
    drag.targets.forEach(function (l) { l.classList.add('drop-active'); });

    // On the window, not the handle. Pointer capture is released the moment the row is
    // moved in the DOM (every swap does that), after which the handle only hears the
    // pointer while it happens to be over it. Mostly it is, because the row follows the
    // finger — until something covers it: at the foot of the window the Save bar appears
    // under the pointer, the moves stop arriving, and the drag freezes (and a release
    // over the bar never ended it). Found porting this from Stockport, whose copy
    // listens on the handle and has the same fault.
    window.addEventListener('pointermove', onHandleMove, { passive: false });
    window.addEventListener('pointerup', onHandleUp);
    window.addEventListener('pointercancel', onHandleUp);
    drag.raf = window.requestAnimationFrame(autoScroll);
  }

  function onHandleMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    drag.clientY = e.clientY;
    drag.pageY = e.pageY;
    follow();
    placeRow();
  }

  // Puts the row where the pointer is holding it.
  function follow() {
    drag.row.style.transform =
      'translateY(' + (drag.pageY - drag.grabOffset - drag.baseTop) + 'px)';
  }

  // Which of this team's two lists the pointer is over.
  //
  // The old code walked the targets in order and took the first that would accept an
  // insert — but a pointer *above* a list also tests as "before its first row", so
  // nominated always won: dragging a reserve up anywhere flung them to the top of
  // the nominated list, and there was only a 26px band below the last nominated row
  // in which a drop still counted as nominated at all. A few pixels past that and
  // the row jumped into the reserves. Pick the list the pointer is actually in, and
  // when it's outside both, leave the row alone rather than snapping it to an end.
  function listUnder(clientY) {
    var best = null;
    var bestDistance = Infinity;
    drag.targets.forEach(function (list) {
      var box = list.getBoundingClientRect();
      var distance = clientY < box.top ? box.top - clientY
        : clientY > box.bottom ? clientY - box.bottom
        : 0;
      if (distance < bestDistance) { bestDistance = distance; best = list; }
    });
    return bestDistance > 60 ? null : best;
  }

  function placeRow() {
    var list = listUnder(drag.clientY);
    if (!list) return;

    var row = drag.row;
    // Probe with the dragged row's own centre, not the raw pointer. The pointer can
    // be anywhere within the row depending on where the handle was grabbed, so
    // comparing it against neighbours' midpoints meant the row swapped a
    // half-row-height before or after it looked like it should.
    var rect = row.getBoundingClientRect();
    var centre = rect.top + rect.height / 2;

    var others = rowsIn(list).filter(function (r) { return r !== row; });
    var before = null;
    for (var i = 0; i < others.length; i++) {
      var r = others[i].getBoundingClientRect();
      if (centre < r.top + r.height / 2) { before = others[i]; break; }
    }

    if (before) {
      if (row.parentElement !== list || row.nextElementSibling !== before) {
        list.insertBefore(row, before);
        reanchor();
      }
    } else if (row.parentElement !== list || row !== list.lastElementChild) {
      list.appendChild(row);
      reanchor();
    }
  }

  // The row has just moved in the DOM, so its in-flow position has changed. Measure
  // the new one and re-derive the offset from it. The old code reset the transform to
  // zero and re-baselined the finger instead, which snapped the row into its new slot
  // out from under the pointer — and since the pointer was then sitting near the
  // midpoint it had just crossed, the next few pixels of movement often swapped it
  // straight back. That oscillation is the sticking.
  function reanchor() {
    drag.row.style.transform = '';
    drag.baseTop = drag.row.getBoundingClientRect().top + window.pageYOffset;
    follow();
    refresh();
  }

  // touch-action: none on the handle means the finger doing the dragging can't also
  // scroll the page, so without this a destination below the fold is unreachable on a
  // phone. Runs off rAF rather than pointermove because the pointer can sit still at
  // the edge.
  function autoScroll() {
    if (!drag) return;
    var y = drag.clientY;
    var speed = y < EDGE ? (y - EDGE) / 6
      : y > window.innerHeight - EDGE ? (y - (window.innerHeight - EDGE)) / 6
      : 0;
    if (speed) {
      var was = window.pageYOffset;
      // 'instant', not the default: Bootstrap 5 sets `scroll-behavior: smooth` on :root
      // (Stockport's Bootstrap 4 doesn't), and a smooth scroll hasn't moved pageYOffset
      // when it is read on the next line — so the dragged row stopped following the page.
      window.scrollBy({ top: speed, behavior: 'instant' });
      if (window.pageYOffset !== was) {
        // The page moved under a stationary pointer: same clientY, new pageY.
        drag.pageY = drag.clientY + window.pageYOffset;
        follow();
        placeRow();
      }
    }
    drag.raf = window.requestAnimationFrame(autoScroll);
  }

  function onHandleUp(e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    window.cancelAnimationFrame(drag.raf);
    window.removeEventListener('pointermove', onHandleMove);
    window.removeEventListener('pointerup', onHandleUp);
    window.removeEventListener('pointercancel', onHandleUp);
    drag.targets.forEach(function (l) { l.classList.remove('drop-active'); });
    drag.row.style.transform = '';
    drag.row.classList.remove('grabbed');
    drag = null;
    refresh();
  }

  // ---------------------------------------------------------------------------
  // Reordering: keyboard and menu
  // ---------------------------------------------------------------------------

  // Moves a row one place, crossing the nominated/reserve boundary within the same
  // team and gender when it runs off either end — the same reach the drag has.
  function step(row, direction) {
    var list = row.parentElement;
    if (direction < 0) {
      if (row.previousElementSibling) {
        list.insertBefore(row, row.previousElementSibling);
      } else if (list.dataset.section === 'reserve') {
        var nominated = siblingList(list, 'nominated');
        if (nominated) nominated.appendChild(row);
      } else {
        return false;
      }
    } else {
      if (row.nextElementSibling) {
        list.insertBefore(row.nextElementSibling, row);
      } else if (list.dataset.section === 'nominated') {
        var reserve = siblingList(list, 'reserve');
        if (reserve) reserve.insertBefore(row, reserve.firstChild);
      } else {
        return false;
      }
    }
    refresh();
    return true;
  }

  function siblingList(list, section) {
    return root.querySelector('.roster-list[data-team="' + list.dataset.team +
      '"][data-gender="' + list.dataset.gender + '"][data-section="' + section + '"]');
  }

  function onHandleKey(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    var handle = e.currentTarget;
    var row = handle.closest('.roster-row');
    if (step(row, e.key === 'ArrowUp' ? -1 : 1)) {
      // The row moved in the DOM, which blurs its button; put focus back so the
      // key can be pressed again.
      row.querySelector('.drag-handle').focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Row menu
  // ---------------------------------------------------------------------------

  var openMenuEl = null;

  function closeMenu() {
    if (!openMenuEl) return;
    var row = openMenuEl.parentElement;
    var btn = row.querySelector('.row-menu-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    row.classList.remove('has-menu');
    openMenuEl.remove();
    openMenuEl = null;
  }

  function openMenu(row, button) {
    closeMenu();
    var list = row.parentElement;
    var name = row.dataset.playerName;
    var isReserve = list.dataset.section === 'reserve';

    var menu = document.createElement('div');
    menu.className = 'roster-menu';

    function item(label, onClick, opts) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (opts && opts.danger) b.className = 'danger';
      if (opts && opts.disabled) b.disabled = true;
      else b.addEventListener('click', function () { closeMenu(); onClick(); });
      menu.appendChild(b);
    }

    var rows = rowsIn(list);
    var index = rows.indexOf(row);
    item('Move up', function () { step(row, -1); },
      { disabled: index === 0 && !isReserve });
    item('Move down', function () { step(row, 1); },
      { disabled: index === rows.length - 1 && isReserve });
    item(isReserve ? 'Make nominated' : 'Make reserve', function () {
      var target = siblingList(list, isReserve ? 'nominated' : 'reserve');
      if (!target) return;
      if (isReserve) target.appendChild(row); else target.insertBefore(row, target.firstChild);
      refresh();
    });
    item('Move to another team…', function () { openMoveDialog(row); });
    menu.appendChild(document.createElement('hr'));
    item('Edit details', function () {
      window.open('/player/' + row.dataset.playerId + '/update', '_blank', 'noopener');
    });
    item('Remove from team', function () { confirmRelease(row, name); }, { danger: true });

    row.classList.add('has-menu');
    row.appendChild(menu);
    button.setAttribute('aria-expanded', 'true');
    openMenuEl = menu;

    // Hangs below the row by default, above it when there isn't room. Measured
    // after appending, because the menu has no height until it's in the document.
    var box = row.getBoundingClientRect();
    var below = window.innerHeight - box.bottom;
    if (below < menu.offsetHeight + 12 && box.top > below) menu.classList.add('drop-up');

    // preventScroll: the placement above was decided from where the row is now, and
    // focus() would otherwise scroll it somewhere else immediately afterwards.
    menu.querySelector('button:not(:disabled)').focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(readJson);
  }

  // A failed request has to fail loudly — the old code's
  // `.then(r => { r.json() })` had no return, so `data` was always undefined and
  // "Success:" logged whatever happened.
  function readJson(response) {
    return response.text().then(function (text) {
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
      if (!response.ok) {
        var message = (data && (data.error || data.message)) ||
          (response.status === 403 ? 'You don\'t have permission to change that.' :
           response.status === 401 ? 'Your session has expired — reload and sign in again.' :
           'Save failed (' + response.status + ').');
        var err = new Error(message);
        err.status = response.status;
        err.data = data;
        throw err;
      }
      return data;
    });
  }

  function save() {
    var teams = changedTeamIds();
    if (!teams.size) return;

    var saveBtn = document.getElementById('roster-save');
    saveBtn.disabled = true;
    saveMsg.textContent = 'Saving…';

    var requests = Array.from(teams).map(function (teamId) {
      var sections = lists()
        .filter(function (l) { return l.dataset.team === teamId; })
        .map(function (l) {
          return {
            gender: l.dataset.gender,
            section: l.dataset.section,
            playerIds: rowsIn(l).map(function (r) { return parseInt(r.dataset.playerId, 10); })
          };
        });
      return postJson('/api/teams/' + teamId + '/order', { sections: sections });
    });

    Promise.all(requests).then(function () {
      captureBaseline();
      refresh();
      toast(teams.size === 1 ? 'Order saved.' : 'Order saved for ' + teams.size + ' teams.');
    }).catch(function (err) {
      // Some of the requests may have landed. Reloading is the only honest way to
      // show what the database actually holds now.
      toast(err.message + ' Reloading to show the saved state.', 'error');
      setTimeout(function () { window.location.reload(); }, 2500);
    }).finally(function () {
      saveBtn.disabled = false;
      updateSaveBar();
    });
  }

  function discard() {
    // Put every row back in the list and order the server last told us about.
    var byId = new Map();
    root.querySelectorAll('.roster-row').forEach(function (row) {
      byId.set(row.dataset.playerId, row);
    });
    lists().forEach(function (list) {
      (baseline.get(listKey(list)) || []).forEach(function (id) {
        var row = byId.get(id);
        if (row) list.appendChild(row);
      });
    });
    refresh();
    toast('Changes discarded.');
  }

  function confirmRelease(row, name) {
    if (!window.confirm('Remove ' + name + ' from this team?\n\n' +
        'They stay registered with their match history, and can be added to another team later.')) {
      return;
    }
    postJson('/api/players/' + row.dataset.playerId + '/release').then(function () {
      var list = row.parentElement;
      row.remove();
      // Applied server-side straight away, so the baseline moves with it — this
      // isn't a pending change to be saved.
      baseline.set(listKey(list), rowsIn(list).map(function (r) { return r.dataset.playerId; }));
      refresh();
      toast(name + ' removed from the team.');
    }).catch(function (err) {
      toast(err.message, 'error');
    });
  }

  // ---------------------------------------------------------------------------
  // Move dialog
  // ---------------------------------------------------------------------------

  function openMoveDialog(row) {
    pending.moveRow = row;
    document.getElementById('rosterMoveWho').textContent =
      row.dataset.playerName + ' is currently in ' +
      row.closest('.roster-card').dataset.teamName + '.';
    // Default to somewhere other than where they already are.
    var select = document.getElementById('rosterMoveTeam');
    var current = row.parentElement.dataset.team;
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value !== current) { select.selectedIndex = i; break; }
    }
    modal('rosterMoveModal').show();
  }

  function doMove() {
    var row = pending.moveRow;
    if (!row) return;
    var teamId = document.getElementById('rosterMoveTeam').value;
    var section = document.getElementById('rosterMoveSection').value;
    var name = row.dataset.playerName;

    // An unsaved reorder in either team would be clobbered by the server's
    // renumbering, so bank it first.
    if (!saveBar.hidden) {
      toast('Save your pending changes before moving someone between teams.', 'error');
      return;
    }

    postJson('/api/players/' + row.dataset.playerId + '/move',
      { teamId: parseInt(teamId, 10), section: section }
    ).then(function (data) {
      modal('rosterMoveModal').hide();
      // The destination team's ranks are now the server's business; reload so both
      // cards show what it decided rather than a guess.
      toast(name + ' moved to ' + (data.team || 'the new team') + '.');
      setTimeout(function () { window.location.reload(); }, 900);
    }).catch(function (err) {
      toast(err.message, 'error');
    });
  }

  // ---------------------------------------------------------------------------
  // Add / transfer
  // ---------------------------------------------------------------------------

  function openAddDialog(button) {
    pending.addContext = {
      teamId: button.dataset.team,
      teamName: button.dataset.teamName,
      gender: button.dataset.gender
    };
    document.getElementById('rosterAddTarget').textContent =
      'Adding to ' + pending.addContext.teamName + ' as a reserve ' +
      (pending.addContext.gender === 'Male' ? 'man' : 'lady') + '.';
    document.getElementById('rosterAddSearch').value = '';
    document.getElementById('rosterNewFirst').value = '';
    document.getElementById('rosterNewFamily').value = '';
    document.getElementById('rosterAddResults').textContent = '';
    modal('rosterAddModal').show();
    setTimeout(function () { document.getElementById('rosterAddSearch').focus(); }, 300);
  }

  function searchCandidates() {
    var term = document.getElementById('rosterAddSearch').value.trim();
    var out = document.getElementById('rosterAddResults');
    if (term.length < 2) {
      out.textContent = '';
      out.appendChild(msgEl('Type at least two letters to search.'));
      return;
    }
    out.textContent = '';
    out.appendChild(msgEl('Searching…'));

    fetch('/api/roster/club-' + CLUB_URL + '/candidates?term=' + encodeURIComponent(term), {
      credentials: 'same-origin'
    }).then(readJson).then(function (data) {
      renderCandidates(data);
    }).catch(function (err) {
      out.textContent = '';
      out.appendChild(msgEl(err.message));
    });
  }

  function msgEl(text) {
    var p = document.createElement('p');
    p.className = 'empty';
    p.textContent = text;
    return p;
  }

  // Three groups, three labelled actions. The old modal put all of these in one
  // <select> and decided which branch to take by reading `selectedPlayer.class` — a
  // property it had set on the option object, which never became a class attribute.
  function renderCandidates(data) {
    var out = document.getElementById('rosterAddResults');
    out.textContent = '';
    var gender = pending.addContext.gender;

    var unattached = (data.unattached || []).filter(function (p) { return p.gender === gender; });
    var others = (data.otherClubs || []).filter(function (p) { return p.gender === gender; });
    var own = (data.ownClub || []).filter(function (p) { return p.gender === gender; });

    // Shown first and only when there is something, because the likeliest reason for
    // searching for someone already at the club is not having noticed they are.
    if (own.length) {
      out.appendChild(group('Already registered at this club', own, null, ''));
    }

    out.appendChild(group('Registered to no club — add them directly', unattached,
      function (p) { return { label: 'Add', className: 'btn-success', onClick: function () { attach(p); } }; },
      'Nobody unattached matches that name.'));

    out.appendChild(group('Already at another club — transfer them here', others,
      function (p) { return { label: 'Transfer here', className: 'btn-outline-warning', onClick: function () { requestTransfer(p); } }; },
      'Nobody at another club matches that name.'));

    if (!unattached.length && !others.length && !own.length) {
      var hint = document.createElement('p');
      hint.className = 'text-muted small mb-0';
      hint.textContent = 'No existing player matches. Create a new one below.';
      out.appendChild(hint);
    }
  }

  function group(title, people, actionFor, emptyText) {
    var wrap = document.createElement('div');
    wrap.className = 'result-group';
    var h = document.createElement('h6');
    h.textContent = title;
    wrap.appendChild(h);

    if (!people.length) {
      wrap.appendChild(msgEl(emptyText));
      return wrap;
    }

    people.forEach(function (person) {
      var rowEl = document.createElement('div');
      rowEl.className = 'candidate';

      var who = document.createElement('div');
      who.className = 'who';
      who.appendChild(document.createTextNode(person.name));
      var sub = document.createElement('small');
      sub.textContent = [person.clubName, person.teamName].filter(Boolean).join(' · ') || 'No club';
      who.appendChild(sub);
      rowEl.appendChild(who);

      var action = actionFor ? actionFor(person) : null;
      if (!action) {
        wrap.appendChild(rowEl);
        return;
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm ' + action.className;
      btn.textContent = action.label;
      btn.addEventListener('click', function () {
        btn.disabled = true;
        action.onClick();
      });
      rowEl.appendChild(btn);
      wrap.appendChild(rowEl);
    });
    return wrap;
  }

  function attach(person) {
    postJson('/api/roster/club-' + CLUB_URL + '/attach', {
      playerId: person.playerId,
      teamId: parseInt(pending.addContext.teamId, 10),
      section: 'reserve'
    }).then(function () {
      modal('rosterAddModal').hide();
      toast(person.name + ' added to ' + pending.addContext.teamName + '.');
      setTimeout(function () { window.location.reload(); }, 800);
    }).catch(function (err) {
      toast(err.message, 'error');
    });
  }

  function requestTransfer(person) {
    postJson('/api/roster/club-' + CLUB_URL + '/transfer', {
      playerId: person.playerId,
      teamId: parseInt(pending.addContext.teamId, 10)
    }).then(function (data) {
      modal('rosterAddModal').hide();
      toast(data.message);
      if (data.applied) setTimeout(function () { window.location.reload(); }, 900);
    }).catch(function (err) {
      toast(err.message, 'error');
    });
  }

  // confirmNew is sent only from the "create anyway" button below: the server
  // answers 409 with its closest matches the first time, because typing a name
  // straight into this form never compared it with anyone already registered.
  function createPlayer(confirmNew) {
    var first = document.getElementById('rosterNewFirst').value.trim();
    var family = document.getElementById('rosterNewFamily').value.trim();
    if (!first || !family) {
      toast('Both a first name and a family name are needed.', 'error');
      return;
    }
    var btn = document.getElementById('rosterCreateBtn');
    btn.disabled = true;

    postJson('/api/roster/club-' + CLUB_URL + '/players', {
      firstName: first,
      familyName: family,
      gender: pending.addContext.gender,
      teamId: parseInt(pending.addContext.teamId, 10),
      section: 'reserve',
      confirmNew: confirmNew === true
    }).then(function () {
      modal('rosterAddModal').hide();
      toast(first + ' ' + family + ' created and added as a reserve.');
      setTimeout(function () { window.location.reload(); }, 800);
    }).catch(function (err) {
      if (err.status === 409 && err.data && err.data.possibleDuplicates) {
        showPossibleDuplicates(first + ' ' + family, err.data.possibleDuplicates);
        return;
      }
      toast(err.message, 'error');
    }).finally(function () {
      btn.disabled = false;
    });
  }

  // The matches the server found, offered with the same actions as a search result,
  // plus a way to say "no, this really is someone new".
  function showPossibleDuplicates(name, people) {
    var out = document.getElementById('rosterAddResults');
    out.textContent = '';
    var lead = document.createElement('p');
    lead.className = 'mb-2';
    lead.textContent = name + ' may already be registered. Is it one of these?';
    out.appendChild(lead);

    out.appendChild(group('Possible matches', people, function (p) {
      if (p.where === 'ownClub') return null;
      if (p.where === 'unattached') {
        return { label: 'Add', className: 'btn-success', onClick: function () { attach(p); } };
      }
      return { label: 'Transfer here', className: 'btn-outline-warning', onClick: function () { requestTransfer(p); } };
    }, ''));

    var anyway = document.createElement('button');
    anyway.type = 'button';
    anyway.className = 'btn btn-sm btn-outline-secondary mt-2';
    anyway.textContent = 'None of these — create ' + name + ' as a new player';
    anyway.addEventListener('click', function () {
      anyway.disabled = true;
      createPlayer(true);
    });
    out.appendChild(anyway);
    out.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  root.querySelectorAll('.drag-handle').forEach(function (handle) {
    handle.addEventListener('pointerdown', onHandleDown);
    handle.addEventListener('keydown', onHandleKey);
  });

  root.addEventListener('click', function (e) {
    var menuBtn = e.target.closest('.row-menu-btn');
    if (menuBtn) {
      e.stopPropagation();
      var row = menuBtn.closest('.roster-row');
      if (openMenuEl && openMenuEl.parentElement === row) closeMenu();
      else openMenu(row, menuBtn);
      return;
    }
    var addBtn = e.target.closest('.roster-add-btn');
    if (addBtn) openAddDialog(addBtn);
  });

  document.addEventListener('click', function (e) {
    if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });

  document.getElementById('roster-save').addEventListener('click', save);
  document.getElementById('roster-discard').addEventListener('click', discard);
  document.getElementById('rosterMoveConfirm').addEventListener('click', doMove);
  document.getElementById('rosterAddSearchBtn').addEventListener('click', searchCandidates);
  document.getElementById('rosterCreateBtn').addEventListener('click', createPlayer);
  document.getElementById('rosterAddSearch').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); searchCandidates(); }
  });

  var clubSwitch = document.getElementById('club-switch');
  if (clubSwitch) {
    clubSwitch.addEventListener('change', function () {
      if (!saveBar.hidden &&
          !window.confirm('You have unsaved changes. Leave without saving?')) {
        clubSwitch.value = root.dataset.clubUrl;
        return;
      }
      window.location.href = '/manage-players/club-' + clubSwitch.value + '/edit';
    });
  }

  // Closing the tab mid-edit is the one case the Save bar can't warn about on its
  // own, and every drag used to be an immediate live write.
  window.addEventListener('beforeunload', function (e) {
    if (!saveBar.hidden) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  captureBaseline();
  refresh();
})();
