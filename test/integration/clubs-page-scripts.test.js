// Every inline script on /info/clubs must actually parse as JavaScript.
//
// ── Why this test exists ─────────────────────────────────────────────────────
//
// **The browser finds the end of a `<script>` element before any JavaScript is parsed.**
// So a literal `</script>` anywhere inside the block — in a string, in a comment, it makes
// no difference — ends it there. Everything after becomes page content, and the function
// the block was defining is never defined.
//
// That happened while rewriting this very page, in the comment explaining the hazard: a
// note saying "an address containing `</script>` would close this block early" closed the
// block early. The symptom was `initMap is not a function` from the Google Maps callback,
// and nothing on the server side was wrong at all — the template rendered fine, the
// response was a 200, and every existing test passed.
//
// Nothing else in the suite looks at rendered JavaScript, which is why a whole page's
// scripts could break without a single failure.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(() => clearModels());

// One club, one team, one venue — enough to render the page. The shapes match what
// `club_controller.club_list_detail` reads.
const CLUB_ROWS = [{
  clubId: 1, name: 'G.H.A.P', clubvenue: 'Old Trafford Sports Barn',
  clubgmap: 'https://maps.app.goo.gl/x', clubaddress: 'Carver Street, Manchester',
  matchNightText: 'A: Tuesday, B: Monday 7.30pm 2 courts', clubNightText: 'Wednesday 6pm',
  clubWebsite: 'https://ghap.example', teamname: 'GHAP A',
  teammatchvenue: 'Manchester Communication Academy', teamgmap: 'https://maps.app.goo.gl/y',
  teamaddress: 'Silchester Drive, Manchester', matchDay: 'Tuesday',
}];

function venueRows() {
  return [{
    venueName: 'Old Trafford Sports Barn', Lat: 53.46, Lng: -2.29,
    address: 'Carver Street, Manchester', gMapUrl: 'https://maps.app.goo.gl/x',
    // Per TEAM, from team.venue + team.matchDay — not the club-level matchNightText,
    // which is a hand-written summary the card has never printed.
    matchTeams: [{ club: 'G.H.A.P', website: 'https://ghap.example', team: 'GHAP A', matchDay: 'Tue 7.30pm' }],
    clubNights: [{ club: 'G.H.A.P', website: 'https://ghap.example', clubNightText: 'Wednesday 6pm' }],
  }];
}

function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    // JSON-LD blocks are data, not JavaScript. The page carries one per club.
    if (/ld\+json/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

describe('GET /info/clubs inline scripts', () => {
  function render(venues) {
    setModel('Club', 'clubDetail', done => done(null, CLUB_ROWS));
    setModel('Venue', 'getVenueClubs', done => done(null, venues));
    return request(app).get('/info/clubs').expect(200);
  }

  it('all parse as JavaScript', async () => {
    const res = await render(venueRows());
    const scripts = inlineScripts(res.text);
    assert.ok(scripts.length >= 1, 'no inline scripts found — has the page changed shape?');
    for (const [i, body] of scripts.entries()) {
      assert.doesNotThrow(() => new Function(body),
        `inline script #${i + 1} does not parse:\n${body.slice(0, 200)}`);
    }
  });

  // The map callback is a global the Google Maps script names in its URL. If the block
  // defining it is cut short, the page still returns 200 and the map silently never loads.
  it('still define initMap', async () => {
    const res = await render(venueRows());
    assert.ok(inlineScripts(res.text).some(s => /function\s+initMap\s*\(/.test(s)),
      'initMap is not defined in any inline script');
  });

  // **The reason `jsonForScript` exists.** A venue address is free text typed by an admin.
  // With a plain `JSON.stringify` this exact value ends the script block and the rest of
  // the page's JavaScript is parsed as markup.
  it('survive a venue address that contains a closing script tag', async () => {
    const hostile = 'Carver Street </' + 'script><img src=x onerror=alert(1)>';
    const venues = venueRows();
    venues[0].address = hostile;

    const res = await render(venues);
    assert.ok(!res.text.includes('<img src=x onerror=alert(1)>'),
      'the hostile markup reached the page intact');
    for (const [i, body] of inlineScripts(res.text).entries()) {
      assert.doesNotThrow(() => new Function(body), `inline script #${i + 1} broke`);
    }
    assert.ok(inlineScripts(res.text).some(s => /function\s+initMap\s*\(/.test(s)));
  });

  // The data has to survive the escaping intact, or the fix would be trading one bug for
  // another.
  it('embed the venue data so it still parses back', async () => {
    const res = await render(venueRows());
    const data = inlineScripts(res.text).join('\n').match(/var data = (\[[\s\S]*?\]);/);
    assert.ok(data, 'the venue data is not in the page');
    const parsed = JSON.parse(data[1]);
    assert.strictEqual(parsed[0].venueName, 'Old Trafford Sports Barn');
    assert.strictEqual(parsed[0].matchTeams[0].team, 'GHAP A');
    assert.strictEqual(parsed[0].clubNights[0].clubNightText, 'Wednesday 6pm');
  });
});
