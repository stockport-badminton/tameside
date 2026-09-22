// The content of a pin's popup on the /info/clubs venue map.
//
// ── What a pin has to say, and the red herring that made it hard ─────────────
//
// Two different things happen at a venue and they come from two different tables:
//
//   matchTeams  one entry per TEAM that plays there, from `team.venue` + `team.matchDay`
//   clubNights  one entry per CLUB that trains there, from `club.venue` + `clubNightText`
//
// **`club.matchNightText` and `club.matchVenue` looked like the answer and were not.** A
// hand-written summary and a single venue id cannot describe a club whose teams play in
// different places on different nights — and G.H.A.P does exactly that: GHAP **A** at Old
// Trafford Sports Barn on a Tuesday, GHAP **B** at Manchester Communication Academy on a
// Monday. Its `matchNightText` read *"A: Tuesday, B: Monday 7.30pm 2 courts"*, which was
// shown in full on both pins, and that is what a visitor reported as confusing.
// `views/club.ejs` never printed it on the card at all — the card's "Match Details" panel
// has always been built from `team.matchDay`.
//
// `matchNightText` has since been dropped from the database: this map was its only reader,
// and it had drifted out of date (Disley's said Tuesday while its team plays Wednesday).
//
// The first attempt at this fix kept using the club columns and merely split them by role,
// which moved the wrong information around instead of dropping it. It also hid a true fact:
// GHAP A really does play at Old Trafford, and that pin had stopped saying so.
//
// ── And why the markup is built here ─────────────────────────────────────────
//
// It used to be assembled in Postgres with `concat` and handed over as ready-made HTML,
// unescaped. These are free-text fields an admin types: one `"` in a club's website broke
// out of its `href`, one `<` anywhere broke the markup, and a venue address in this
// database already carries an apostrophe ("NOT Mulberry's"). Building it here means it goes
// through `esc()`, and means the logic can be tested — `test/venue-popup.test.js` loads
// this file directly.

(function (root, factory) {
  var api = factory();
  // Browser and Node, because the page loads it as a plain script and the test requires it.
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VenuePopup = api;
}(typeof window !== 'undefined' ? window : null, function () {

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Only http(s) may reach an `href`.
   *
   * These are admin-entered fields, and `javascript:` in one of them would otherwise be a
   * click away from running as script on our own origin. Anything else — a relative path,
   * a bare domain, an empty string — is dropped rather than guessed at, and the caller
   * renders plain text instead. One club currently has no website stored, which used to
   * produce `href=""` and a link back to the same page.
   */
  function safeUrl(value) {
    var url = String(value == null ? '' : value).trim();
    return /^https?:\/\//i.test(url) ? url : null;
  }

  function link(url, text) {
    var href = safeUrl(url);
    return href
      ? '<a href="' + esc(href) + '" rel="noopener" target="_blank">' + esc(text) + '</a>'
      : esc(text);
  }

  /**
   * Fold a venue's two lists into one entry per club, in first-seen order.
   *
   * A club can appear in either list or both — G.H.A.P is in both at Old Trafford (A plays
   * there AND the club night is there) and in only `matchTeams` at Manchester Communication
   * Academy. Exported because the grouping is the part worth asserting directly.
   */
  function byClub(venue) {
    var order = [];
    var clubs = {};

    function entry(name, website) {
      if (!clubs[name]) {
        clubs[name] = { name: name, website: website, nights: [], clubNightText: null };
        order.push(name);
      }
      // The website comes from whichever list mentioned the club first; they are the same
      // column, so a later null must not blank it.
      if (!clubs[name].website && website) clubs[name].website = website;
      return clubs[name];
    }

    (venue.matchTeams || []).forEach(function (t) {
      var club = entry(t.club, t.website);
      // **Teams sharing a night are collapsed onto one line.** Hyde runs three teams at
      // Astley Sports College, all "Wed, 8pm prompt start on 2 courts." — printing that
      // sentence three times is noise, and the card view deduplicates for the same reason.
      var day = t.matchDay || '';
      var existing = null;
      for (var i = 0; i < club.nights.length; i++) {
        if (club.nights[i].matchDay === day) { existing = club.nights[i]; break; }
      }
      if (existing) existing.teams.push(t.team);
      else club.nights.push({ matchDay: day, teams: [t.team] });
    });

    (venue.clubNights || []).forEach(function (c) {
      entry(c.club, c.website).clubNightText = c.clubNightText || null;
    });

    return order.map(function (name) { return clubs[name]; });
  }

  function clubBlock(club) {
    var lines = [];

    club.nights.forEach(function (night) {
      var who = night.teams.join(', ');
      // One team whose name is just the club plus a letter still reads fine; a team with no
      // matchDay recorded (one currently has none) prints the team name and stops rather
      // than a dangling dash.
      lines.push('<strong>' + esc(who) + ':</strong> ' +
        (night.matchDay ? esc(night.matchDay) : 'match night not recorded'));
    });

    if (club.clubNightText) {
      lines.push('<strong>Club night:</strong> ' + esc(club.clubNightText));
    }

    // Neither list would have produced the club otherwise, but never render a bare name.
    if (!lines.length) lines.push('Based here.');

    return '<p class="mb-2"><strong>' + link(club.website, club.name) + '</strong><br>' +
           lines.join('<br>') + '</p>';
  }

  function popupHtml(venue) {
    var clubs = byClub(venue).map(clubBlock).join('');
    // The address belongs to the venue, so it is printed once at the end rather than
    // repeated under every club the way the SQL version did.
    var address = venue.address
      ? '<p class="mb-0 small">' + link(venue.gMapUrl, venue.address) + '</p>'
      : '';
    return '<div class="map-popup">' +
           '<h2 class="h6 mb-2">' + esc(venue.venueName) + '</h2>' +
           clubs + address +
           '</div>';
  }

  return {
    esc: esc, safeUrl: safeUrl, link: link,
    byClub: byClub, clubBlock: clubBlock, popupHtml: popupHtml,
  };
}));
