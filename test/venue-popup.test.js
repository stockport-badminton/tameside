// The /info/clubs map popups.
//
// ── The bug, and the wrong fix that came first ───────────────────────────────
//
// Reported as: G.H.A.P "have two venues but both show A&B information so you could easily
// get confused".
//
// The popup was built from `club.matchNightText` — a hand-written summary reading
// "A: Tuesday, B: Monday 7.30pm 2 courts" — and `club.matchVenue`, a single venue id.
// Neither can describe a club whose teams play in different places on different nights,
// which is exactly what G.H.A.P does: **GHAP A at Old Trafford Sports Barn on a Tuesday,
// GHAP B at Manchester Communication Academy on a Monday.**
//
// The first attempt kept those columns and split them by role — club night at one pin,
// match night at the other. That still showed the A&B string, and it made things worse by
// hiding a true fact: GHAP A really does play at Old Trafford, and that pin stopped saying
// so. **`views/club.ejs` never printed `matchNightText` on the card at all**; the card's
// Match Details panel has always come from `team.matchDay`. The map was the only reader.
//
// So the data is per team now, and these tests are written against the real rows.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const VenuePopup = require('../static/js/venue-popup');
const jsonForScript = require('../utils/jsonForScript');

// Production, 22 Sep 2026.
const OLD_TRAFFORD = {
  venueName: 'Old Trafford Sports Barn',
  address: 'Seymour Park, Carver Street, Manchester, M16 9PQ',
  gMapUrl: 'https://maps.app.goo.gl/x',
  matchTeams: [{ club: 'G.H.A.P', website: 'https://ghap.example', team: 'GHAP A', matchDay: 'Tue 7.30pm prompt finish by 9.30pm. 2 courts.' }],
  clubNights: [{ club: 'G.H.A.P', website: 'https://ghap.example', clubNightText: 'Wednesday 6pm' }],
};
const MCA = {
  venueName: 'Manchester Communication Academy',
  address: 'Silchester Drive, Harpurhey, Manchester M40 8NT',
  gMapUrl: 'https://maps.app.goo.gl/y',
  matchTeams: [{ club: 'G.H.A.P', website: 'https://ghap.example', team: 'GHAP B', matchDay: 'Mon, 8:00pm prompt finish by 10:00pm. 2 courts' }],
  clubNights: null,
};

describe('a club whose teams play at different venues', () => {
  // **The reported symptom.** The A&B summary must not appear anywhere: it is not the
  // data, it is somebody's note about the data.
  it('never prints the club-level A&B summary', () => {
    for (const venue of [OLD_TRAFFORD, MCA]) {
      const html = VenuePopup.popupHtml(venue);
      assert.ok(!html.includes('A: Tuesday, B: Monday'),
        `the matchNightText summary leaked into ${venue.venueName}`);
    }
  });

  // **What the first fix broke.** GHAP A genuinely plays at Old Trafford. A pin that only
  // mentions the club night is not merely tidier, it is missing a fixture's worth of
  // information.
  it('says which team plays at each venue, and when', () => {
    const ot = VenuePopup.popupHtml(OLD_TRAFFORD);
    assert.ok(ot.includes('GHAP A'), ot);
    assert.ok(ot.includes('Tue 7.30pm'), ot);
    assert.ok(!ot.includes('GHAP B'), 'the other venue\'s team appeared');

    const mca = VenuePopup.popupHtml(MCA);
    assert.ok(mca.includes('GHAP B') && mca.includes('Mon, 8:00pm'), mca);
    assert.ok(!mca.includes('GHAP A'), 'the other venue\'s team appeared');
  });

  it('shows the club night only where the club night actually is', () => {
    assert.ok(VenuePopup.popupHtml(OLD_TRAFFORD).includes('Wednesday 6pm'));
    assert.ok(!VenuePopup.popupHtml(MCA).includes('Club night'),
      'Manchester Communication Academy has no club night and must not claim one');
  });
});

describe('grouping', () => {
  // Hyde runs three teams out of Astley on the same night. Printing that sentence three
  // times is noise; the card view deduplicates for the same reason.
  it('collapses teams that share a night onto one line', () => {
    const html = VenuePopup.popupHtml({
      venueName: 'Astley Sports College',
      matchTeams: ['Hyde A', 'Hyde B', 'Hyde C'].map(team => ({
        club: 'Hyde', team, matchDay: 'Wed, 8pm prompt start on 2 courts.',
      })),
      clubNights: [{ club: 'Hyde', clubNightText: 'Wednesday 8pm' }],
    });
    assert.ok(html.includes('Hyde A, Hyde B, Hyde C'), html);
    assert.strictEqual(html.split('Wed, 8pm prompt').length - 1, 1, 'the night was repeated');
  });

  // ...but only when the night is the same. Manchester Edgeley's two teams play on
  // different nights at one venue, and collapsing those would be the original bug again.
  it('keeps teams on separate lines when their nights differ', () => {
    const html = VenuePopup.popupHtml({
      venueName: 'Avondale Life Leisure',
      matchTeams: [
        { club: 'Manchester Edgeley', team: 'Manchester Edgeley A', matchDay: 'Wed 8pm prompt, 2 courts.' },
        { club: 'Manchester Edgeley', team: 'Manchester Edgeley B', matchDay: 'Mon 8pm prompt, 2 courts.' },
      ],
    });
    assert.ok(html.includes('Wed 8pm') && html.includes('Mon 8pm'), html);
    assert.ok(!html.includes('Manchester Edgeley A, Manchester Edgeley B'), html);
  });

  // One pin, several clubs, each with its own block — and the venue address once.
  it('gives each club its own block and prints the address once', () => {
    const html = VenuePopup.popupHtml({
      venueName: 'Cheadle Hulme Recreation Centre',
      address: 'Woods Ln, Cheadle Hulme',
      gMapUrl: 'https://maps.app.goo.gl/z',
      matchTeams: [
        { club: 'Aerospace', team: 'Aerospace A', matchDay: 'Tue 7pm' },
        { club: 'Shell', team: 'Shell A', matchDay: 'Wed 8pm' },
      ],
      clubNights: [
        { club: 'Aerospace', clubNightText: 'Tuesday 8pm' },
        { club: 'Shell', clubNightText: 'Wednesday 8pm' },
      ],
    });
    assert.strictEqual(html.split('Woods Ln').length - 1, 1);
    assert.ok(html.includes('Aerospace') && html.includes('Shell'));
  });

  // A club appearing in both lists must be one block, not two.
  it('merges a club that both plays and trains at the venue', () => {
    const clubs = VenuePopup.byClub(OLD_TRAFFORD);
    assert.strictEqual(clubs.length, 1);
    assert.strictEqual(clubs[0].nights.length, 1);
    assert.strictEqual(clubs[0].clubNightText, 'Wednesday 6pm');
  });

  // One team in this database has no matchDay recorded.
  it('says so rather than printing a dangling label', () => {
    const html = VenuePopup.popupHtml({
      venueName: 'V', matchTeams: [{ club: 'C', team: 'C A', matchDay: null }],
    });
    assert.ok(html.includes('match night not recorded'), html);
  });
});

describe('escaping, which the SQL version had none of', () => {
  // The old popup was assembled with Postgres `concat`, so every one of these went into
  // the markup raw. An address in this database already carries an apostrophe.
  it('escapes a club name that would otherwise break the markup', () => {
    const html = VenuePopup.popupHtml({
      venueName: 'V',
      matchTeams: [{ club: '<img src=x onerror=alert(1)>', team: 'T', matchDay: 'Mon' }],
    });
    assert.ok(!html.includes('<img'), html);
    assert.ok(html.includes('&lt;img'), html);
  });

  it('escapes a match night description', () => {
    const html = VenuePopup.popupHtml({
      venueName: 'V',
      matchTeams: [{ club: 'C', team: 'T', matchDay: 'Mon "8pm" & <late>' }],
    });
    assert.ok(html.includes('&quot;8pm&quot;') && html.includes('&amp;') && html.includes('&lt;late&gt;'), html);
  });

  // A `"` in a website used to break straight out of its href attribute.
  it('cannot break out of an href', () => {
    const html = VenuePopup.link('https://x.test/"><script>alert(1)</scr' + 'ipt>', 'C');
    assert.ok(!html.includes('"><script'), html);
    assert.ok(html.includes('&quot;'), html);
  });

  // `javascript:` in an admin-entered field would otherwise be one click from running on
  // our own origin.
  it('refuses any scheme but http and https', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'JaVaScRiPt:alert(1)', '//evil.test', '']) {
      assert.strictEqual(VenuePopup.safeUrl(bad), null, bad);
    }
    assert.strictEqual(VenuePopup.safeUrl('https://x.test/a'), 'https://x.test/a');
    assert.strictEqual(VenuePopup.safeUrl(' http://x.test '), 'http://x.test');
  });

  // One club has no website stored. That used to render href="", a link to the same page.
  it('renders a club with no website as plain text', () => {
    assert.strictEqual(VenuePopup.link(null, 'No Site FC'), 'No Site FC');
  });
});

describe('embedding the venue data in the page', () => {
  // The browser finds the end of a <script> element before any JS is parsed, so a string
  // containing a closing script tag ends the block early and the rest is parsed as markup.
  it('cannot close the script block', () => {
    const out = jsonForScript({ address: 'x</scr' + 'ipt><img src=x onerror=alert(1)>' });
    assert.ok(!out.includes('</scr' + 'ipt>'), out);
    assert.ok(out.includes('\\u003c'), out);
  });

  it('still parses back to exactly the same value', () => {
    const value = { a: '</scr' + 'ipt>', b: 'x y', c: '&<>', d: [1, null, 'ok'] };
    assert.deepStrictEqual(JSON.parse(jsonForScript(value)), value);
  });

  // `var x = ;` is a syntax error that takes the whole page's script with it.
  it('emits null rather than nothing for an undefined value', () => {
    assert.strictEqual(jsonForScript(undefined), 'null');
  });

  // U+2028/U+2029 are legal in JSON but were JavaScript line terminators before ES2019.
  it('escapes the line separators', () => {
    assert.ok(!jsonForScript({ a: ' ' }).includes(' '));
  });
});
