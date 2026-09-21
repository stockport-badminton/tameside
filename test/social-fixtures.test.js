// The weekly fixtures post — the cards, the captions, and the empty week.
//
// This post is new rather than ported: Make.com never posted fixtures on either league's
// account, so there is no scenario to stay bug-compatible with. What it does inherit is
// every trap the tables and results posts have already been caught by, which is what most
// of these assertions are about.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const paths = require('../utils/socialPaths');
const social = require('../controllers/social_controller');
const Club = require('../models/club');

const ENV_KEYS = ['META_TAMESIDE_PAGE_ID', 'META_TAMESIDE_PAGE_TOKEN', 'META_IG_USER_ID', 'SITE_URL'];
let saved;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const WEEK = [
  { dayLabel: 'Mon 21 Sep', homeTeam: 'GHAP B', awayTeam: 'Syddal Park A', homeClub: 'G.H.A.P', awayClub: 'Syddal Park', divisionName: 'Division 1' },
  { dayLabel: 'Tue 22 Sep', homeTeam: 'Manor A', awayTeam: 'Medlock A', homeClub: 'Manor', awayClub: 'Medlock', divisionName: 'Division 2' },
  { dayLabel: 'Wed 23 Sep', homeTeam: 'Hyde B', awayTeam: 'College Green A', homeClub: 'Hyde', awayClub: 'College Green', divisionName: 'Division 1' },
  { dayLabel: 'Wed 23 Sep', homeTeam: 'Shell A', awayTeam: 'Manchester Edgeley B', homeClub: 'Shell', awayClub: 'Manchester Edgeley', divisionName: 'Division 1' },
];

describe('the fixtures image URL', () => {
  // Both division names in this league contain a space. Interpolated raw, Facebook answers
  // `Missing or invalid image file (324, OAuthException)` for a route that is fine the
  // whole time — and sends you hunting a bug in the endpoint.
  it('percent-encodes the division and ends .jpg', () => {
    assert.strictEqual(paths.fixturesImagePath('Division 1'), '/fixtures-image/Division%201.jpg');
    assert.ok(!/ /.test(paths.fixturesImagePath('Division 1')));
  });

  // A division name containing a slash would otherwise open a new path segment and match
  // a different route, or nothing.
  it('encodes a slash rather than letting it open a path segment', () => {
    assert.ok(paths.fixturesImagePath('Division 1/2').includes('%2F'));
  });
});

describe('choosing which cards to post', () => {
  const weekly = require('../controllers/weeklyFixturesController');

  it('reads top division first, whatever order the rows arrive in', () => {
    const shuffled = [WEEK[1], WEEK[0]];
    assert.deepStrictEqual(weekly.divisionsWithFixtures(shuffled), ['Division 1', 'Division 2']);
  });

  // Driven by the DIVISIONS list rather than by whatever `divisionName` values come back,
  // so a friendly, a Lewis Shield tie or a division renamed mid-season cannot silently add
  // a third card. Instagram refuses a carousel over ten rather than truncating it, so a
  // runaway list would fail the whole post.
  it('ignores a division name it does not know', () => {
    const rows = WEEK.concat([{ divisionName: 'Lewis Shield', homeTeam: 'x', awayTeam: 'y' }]);
    assert.deepStrictEqual(weekly.divisionsWithFixtures(rows), ['Division 1', 'Division 2']);
  });

  // The league plays September to April. A job that fires all year would spend the summer
  // publishing cards reading "Fixtures this week" with nothing under the heading.
  it('produces no images at all for a week with no fixtures', () => {
    assert.deepStrictEqual(weekly.imageUrls([]), []);
    assert.deepStrictEqual(weekly.divisionsWithFixtures([]), []);
  });

  it('leaves out a division that is not playing this week', () => {
    const onlyDivOne = WEEK.filter(r => r.divisionName === 'Division 1');
    assert.deepStrictEqual(weekly.divisionsWithFixtures(onlyDivOne), ['Division 1']);
  });

  // `imageUrls` must be absolute — Meta fetches from Meta's servers — while the preview's
  // `<img src>` must not be, or the page shows PRODUCTION's rendering whatever server you
  // are looking at, and a change to the renderer appears to do nothing locally.
  it('gives the post absolute URLs and the preview same-origin paths', () => {
    process.env.SITE_URL = 'https://tameside-badminton.co.uk';
    assert.deepStrictEqual(weekly.imageUrls(WEEK), [
      'https://tameside-badminton.co.uk/fixtures-image/Division%201.jpg',
      'https://tameside-badminton.co.uk/fixtures-image/Division%202.jpg',
    ]);
    assert.deepStrictEqual(weekly.imagePaths(WEEK), [
      '/fixtures-image/Division%201.jpg',
      '/fixtures-image/Division%202.jpg',
    ]);
  });
});

describe('the captions', () => {
  const weekly = require('../controllers/weeklyFixturesController');
  const realHandles = Club.getInstagramHandles;
  afterEach(() => { Club.getInstagramHandles = realHandles; });

  // **The clubs mentioned are the ones actually playing**, which is the difference from
  // the tables post. A mention is a notification, and notifying a club about a week it is
  // not playing in is how an account gets muted.
  it('mentions only the clubs playing this week', async () => {
    Club.getInstagramHandles = async () => ([
      { name: 'Hyde', handle: 'hydebadminton' },
      { name: 'Mellor', handle: 'mellorbadminton' },   // not playing
    ]);
    const text = await weekly.captions(WEEK);
    assert.ok(text.instagram.includes('@hydebadminton'), text.instagram);
    assert.ok(!text.instagram.includes('@mellorbadminton'), text.instagram);
    assert.deepStrictEqual(text.mentioned, ['Hyde']);
  });

  // No Tameside club has a handle stored yet. Without the filter, the caption posts a
  // blank paragraph in the middle of itself.
  it('has no blank line when no club has a handle', async () => {
    Club.getInstagramHandles = async () => [];
    const text = await weekly.captions(WEEK);
    assert.ok(!/\n\n\n/.test(text.instagram), JSON.stringify(text.instagram));
    assert.deepStrictEqual(text.mentioned, []);
  });

  // A page mention is not @-syntax at all: it is display-name text plus a separate tag
  // record, and it needs the Pages API. The `@Club Name` text Make carried for years did
  // nothing whatsoever, so omitting them is honest and faking them is not.
  it('names no clubs on Facebook', async () => {
    Club.getInstagramHandles = async () => ([{ name: 'Hyde', handle: 'hydebadminton' }]);
    const text = await weekly.captions(WEEK);
    assert.ok(!text.facebook.includes('@hyde'), text.facebook);
    assert.match(text.facebook, /4 matches this week/);
  });

  it('says "match" for one and "matches" for more', async () => {
    Club.getInstagramHandles = async () => [];
    assert.match((await weekly.captions([WEEK[0]])).facebook, /1 match this week/);
    assert.match((await weekly.captions(WEEK)).facebook, /4 matches this week/);
  });
});

describe('what the card prints', () => {
  // A heading whenever the night changes, so the list reads as a diary rather than a
  // table. Exported and asserted here rather than by comparing rendered pixels.
  it('groups matches under one heading per night', () => {
    const lines = social.fixtureCardLines(WEEK.filter(r => r.divisionName === 'Division 1'));
    assert.deepStrictEqual(lines.map(l => l.kind),
      ['date', 'fixture', 'date', 'fixture', 'fixture']);
    assert.strictEqual(lines[0].text, 'Mon 21 Sep');
    assert.match(lines[1].text, /GHAP B\s+v\s+Syddal Park A/);
  });

  // **"Fixtures this week" means nothing to someone who finds the post later**, or who
  // does not follow the league. The card has to stand on its own.
  it('prints a date range that stands on its own', () => {
    assert.strictEqual(social.fixtureDateRange(WEEK), '21 - 23 Sep');
    assert.strictEqual(social.fixtureDateRange([WEEK[0]]), '21 Sep');
    assert.strictEqual(social.fixtureDateRange([]), '');
  });

  it('spells a range spanning two months in full', () => {
    const rows = [{ dayLabel: 'Mon 28 Sep' }, { dayLabel: 'Sun 4 Oct' }];
    assert.strictEqual(social.fixtureDateRange(rows), '28 Sep - 4 Oct');
  });

  // The range is parsed out of the SQL-formatted label, never recomputed from
  // `fixture.date`. That column is a timestamp at local midnight, so a JS Date built from
  // it names the PREVIOUS day under BST — the heading would disagree with the rows under
  // it. Proven by a real row: 2026-09-20T23:00:00Z is "Mon 21 Sep".
  it('takes the day from the SQL label and not from the timestamp', () => {
    const row = { dayLabel: 'Mon 21 Sep', date: new Date('2026-09-20T23:00:00.000Z') };
    assert.strictEqual(social.fixtureDateRange([row]), '21 Sep');
    assert.notStrictEqual(String(row.date.getUTCDate()), '21');
  });
});

describe('the drawing', () => {
  // Jimp, not sharp-with-an-SVG-overlay. This image ships no fontconfig and no system
  // font on purpose, so Stockport's drawing code renders every label blank in production
  // and nowhere else. A test asserting bytes come back is what catches a port of it.
  it('renders a real JPEG at the posted aspect', async () => {
    const buf = await social.buildFixturesCard('Division 1', WEEK.filter(r => r.divisionName === 'Division 1'), 'jpeg');
    assert.ok(buf.length > 10000, `suspiciously small: ${buf.length} bytes`);
    assert.strictEqual(buf[0], 0xff);
    assert.strictEqual(buf[1], 0xd8);   // JPEG SOI

    const Jimp = require('jimp');
    const img = await Jimp.read(buf);
    assert.strictEqual(img.bitmap.width, 1080);
    assert.strictEqual(img.bitmap.height, 1350);
  });

  // A division whose name has no artwork should produce a duller card, not a 500 on a
  // route Meta is fetching.
  it('falls back to the plain background for an unknown division', async () => {
    const buf = await social.buildFixturesCard('Division 7', [WEEK[0]], 'jpeg');
    assert.ok(buf.length > 10000);
  });

  // Jimp cannot scale a bitmap font, so a long list has to change LAYOUT rather than
  // shrink. Six fixtures on six separate nights is beyond what the stacked form fits, and
  // the card must still be legible rather than overlapping.
  it('still fits the worst week this league can produce', async () => {
    const nights = ['Mon 21 Sep', 'Tue 22 Sep', 'Wed 23 Sep', 'Thu 24 Sep', 'Fri 25 Sep', 'Sat 26 Sep'];
    const rows = nights.map(dayLabel => ({
      dayLabel, homeTeam: 'Manchester Edgeley A', awayTeam: 'Manchester Edgeley B', divisionName: 'Division 1',
    }));
    const buf = await social.buildFixturesCard('Division 1', rows, 'jpeg');
    const img = await require('jimp').read(buf);
    assert.strictEqual(img.bitmap.height, 1350);
  });
});

describe('the panel sizes itself to its contents', () => {
  const Jimp = require('jimp');
  const nights = ['Mon 21 Sep', 'Tue 22 Sep', 'Wed 23 Sep', 'Thu 24 Sep', 'Fri 25 Sep', 'Sat 26 Sep'];
  const rowsFor = n => nights.slice(0, n).map(dayLabel => ({
    dayLabel, homeTeam: 'Manchester Edgeley A', awayTeam: 'Manchester Edgeley B',
  }));

  // Find the top of the dark panel by scanning down the left gutter for the first row
  // darker than the artwork above it. Reading the pixels rather than the constants,
  // because a test that restates the layout arithmetic passes against the bug just as
  // happily — the same reason `tableRowValues` is exported.
  // The BIGGEST drop, not the first one over a threshold. A threshold finds whatever edge
  // the artwork happens to contain above the panel — the first version of this returned
  // 351 for both a one-fixture and a five-fixture card, which read as "the panel never
  // collapses" when the real edges were 705 and 351. The panel is the strongest step down
  // the column by some margin, so taking the maximum needs no magic number.
  async function panelTop(buf) {
    const img = await Jimp.read(buf);
    const x = 60;   // inside the panel's left edge (PANEL_X 40), clear of the text
    let best = { drop: 0, y: null }, prev = null;
    for (let y = 200; y < 1300; y++) {
      const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
      const lum = r + g + b;
      if (prev !== null && prev - lum > best.drop) best = { drop: prev - lum, y };
      prev = lum;
    }
    return best.y;
  }

  // **The fault this replaced.** The panel was a fixed 880px box with the list centred
  // inside it, so a one-fixture week — 20% of them — put two lines of copy in the middle
  // of a large empty rectangle and read as a rendering fault rather than a quiet week.
  it('leaves more artwork showing for a short week than a long one', async () => {
    const short = await panelTop(await social.buildFixturesCard('Division 1', rowsFor(1), 'jpeg'));
    const long = await panelTop(await social.buildFixturesCard('Division 1', rowsFor(5), 'jpeg'));
    assert.ok(short !== null && long !== null, `panel edge not found: ${short}, ${long}`);
    assert.ok(short > long + 100,
      `a 1-fixture panel should start well below a 5-fixture one, got ${short} vs ${long}`);
  });

  // Bottom-anchored, so the card's proportions stay consistent whatever the week holds.
  it('keeps the panel bottom in the same place at every length', async () => {
    const heights = [];
    for (const n of [1, 3, 5]) {
      const img = await Jimp.read(await social.buildFixturesCard('Division 1', rowsFor(n), 'jpeg'));
      // The last row that is still panel-dark, scanning up from the very bottom margin.
      let bottom = null;
      for (let y = 1349; y > 300; y--) {
        const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(60, y));
        if (r + g + b < 240) { bottom = y; break; }
      }
      heights.push(bottom);
    }
    const spread = Math.max(...heights) - Math.min(...heights);
    assert.ok(spread <= 2, `panel bottom moved by ${spread}px across lengths: ${heights}`);
  });

  // White text on a dark panel, not the reverse. A light panel has to be near-opaque to be
  // legible, and at that point the division artwork underneath may as well not be there —
  // which defeats the only reason for using it.
  it('draws a dark panel that still lets the artwork through', async () => {
    const img = await Jimp.read(await social.buildFixturesCard('Division 1', rowsFor(3), 'jpeg'));
    const plain = await Jimp.read('./static/images/bg/social-Division-1.png');
    // y=1200, not 1250. The footer text baseline sits at ~1230-1265, so the first version
    // of this sampled straight through white lettering and failed on "panel pixel is not
    // dark" — a fault in the probe, not the picture.
    const Y = 1200;
    let sameAsBackground = 0;
    for (let x = 50; x < 1030; x += 40) {
      const a = Jimp.intToRGBA(img.getPixelColor(x, Y));
      const b = Jimp.intToRGBA(plain.getPixelColor(x, Y));
      assert.ok(a.r + a.g + a.b < 330, `panel pixel at ${x} is not dark`);
      if (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 12) sameAsBackground++;
    }
    // Translucent, not opaque: the panel must differ from the raw artwork everywhere.
    assert.strictEqual(sameAsBackground, 0);
    // ...but the artwork must still modulate it, so the panel is not one flat colour.
    const strip = [];
    for (let x = 50; x < 1030; x += 40) {
      const c = Jimp.intToRGBA(img.getPixelColor(x, Y));
      strip.push(c.r + c.g + c.b);
    }
    assert.ok(Math.max(...strip) - Math.min(...strip) > 10,
      'the panel is flat, so the artwork is not showing through at all');
  });
});
