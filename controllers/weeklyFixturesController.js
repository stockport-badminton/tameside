// The weekly fixtures post — what the league is playing in the coming week.
//
// One card per division goes to the league's Facebook page as an album and to its
// Instagram account as a carousel. It is the forward-looking twin of the Saturday tables
// post in `weeklyTablesController`, and it deliberately borrows that file's shape: same
// `configuredTargets()`, same per-target reporting, same gate, same `?dry=1`, same
// 200/207/502.
//
// **This is a new post, not a ported one.** Make.com never did it on either side — its
// League Tables scenario looked backwards only — so there is no scenario to keep
// bug-compatible with, and no double-post risk on the cutover. Tameside has never had a
// fixtures post on either platform.
//
// ── The one thing this post does that the tables post does not ───────────────
//
// **Its content can legitimately be empty, and then it must not post.** The league plays
// from September to April; a job that fires all year would spend the summer publishing two
// cards reading "Fixtures this week" with nothing under the heading, and Christmas doing
// the same. So the division list is built from the fixtures that exist, and a week with
// none is a no-op that says so.
//
// That is also why the divisions are chosen rather than fixed. The tables post always has
// two tables because a division always has a table; a division can easily have no fixtures
// in a week when the other one does — it happens in the very first week of this season.

const { absoluteUrl, canonicalFor } = require('../utils/siteUrl');
const { fixturesImagePath } = require('../utils/socialPaths');
const meta = require('../utils/metaPublisher');
const Club = require('../models/club');
const Fixture = require('../models/fixture');
const { isSuperAdmin } = require('../utils/authz');
const { DIVISIONS } = require('./weeklyTablesController');

const SITE = 'https://tameside-badminton.co.uk';
const HASHTAGS = '#badminton #tameside #tbl #fixtures #bulutangkis';

/**
 * The divisions that have at least one fixture in the window, in table order.
 *
 * Driven by `DIVISIONS` rather than by whatever `divisionName` values come back, so the
 * cards read top division first and an unexpected name — a friendly, a Lewis Shield tie, a
 * division renamed mid-season — cannot silently add a third card. Instagram's carousel
 * limit is 10; a runaway list would fail the whole post rather than merely look odd.
 */
function divisionsWithFixtures(rows) {
  const present = new Set(rows.map(r => String(r.divisionName || '').trim()));
  return DIVISIONS.filter(d => present.has(d));
}

/** The images, in division order. Absolute, https, and ending `.jpg` — all three required. */
function imageUrls(rows) {
  return divisionsWithFixtures(rows).map(d => absoluteUrl(fixturesImagePath(d)));
}

/**
 * The same cards as same-origin paths, for the preview page to display.
 *
 * `imageUrls` is absolute because Meta fetches those from Meta's own servers, and that is
 * not negotiable. But an absolute URL in the preview's `<img src>` means the page always
 * shows **production's** rendering of the card, whatever server you are looking at — so a
 * change to the renderer appears to do nothing locally, and a route that is not deployed
 * yet shows no image while the page cheerfully reports how many there are. The weekly
 * tables preview has that bug; do not copy it here.
 *
 * The absolute URL is still shown as text, because "what will actually be posted" is the
 * information the preview exists to give.
 */
function imagePaths(rows) {
  return divisionsWithFixtures(rows).map(d => fixturesImagePath(d));
}

/**
 * Captions.
 *
 * **The clubs mentioned are the ones actually playing**, not every club with a handle.
 * That is the difference from the tables post, where both tables name every club anyway —
 * here a mention is a notification, and notifying a club about a week it is not playing in
 * is how an account gets muted.
 *
 * Facebook's caption names no clubs at all. A page mention is not `@`-syntax: it is
 * display-name text plus a separate tag record, and it needs the Pages API. The
 * `@Club Name` text Make carried for years did nothing whatsoever. Omitting them is honest;
 * faking them is not.
 */
async function captions(rows) {
  const playing = new Set();
  for (const r of rows) {
    if (r.homeClub) playing.add(String(r.homeClub).trim());
    if (r.awayClub) playing.add(String(r.awayClub).trim());
  }

  const clubs = (await Club.getInstagramHandles()).filter(c => playing.has(String(c.name).trim()));
  const mentions = clubs.map(c => '@' + c.handle).join(' ');
  const count = rows.length;
  const headline = `${count} ${count === 1 ? 'match' : 'matches'} this week.`;

  return {
    facebook: `${headline} Full fixture list and venues at ${SITE}\n\n${HASHTAGS}`,
    // `.filter(Boolean)` matters: no Tameside club has a handle stored yet, and an empty
    // mentions line would post as a blank paragraph in the middle of the caption.
    instagram: [`${headline} Full fixture list and venues at ${SITE}`, mentions, HASHTAGS]
      .filter(Boolean).join('\n\n'),
    mentioned: clubs.map(c => c.name),
  };
}

/**
 * POST /admin/social/weekly-fixtures — publish it.
 *
 * `?dry=1` asks Meta whether it would accept the images and posts nothing. Worth running
 * before a season's first real post: a scheduled job nobody watches is exactly where a
 * silent refusal hides, which is how the Stockport carousel managed never to work at all.
 */
exports.run = async function (req, res, next) {
  try {
    const dry = req.query.dry === '1' || (req.body && req.body.dry === '1');
    const rows = await Fixture.getUpcomingWeek();
    const urls = imageUrls(rows);
    const configured = meta.configuredTargets();

    // Same rule as the tables post: a switch whose halves live in different places — the
    // service config and a gitignored `.env` — must fail loudly when only one is set.
    // Posting nowhere is not a quiet success, and there is deliberately no fallback.
    if (!configured.length) {
      return res.status(500).json({
        ok: false,
        error: 'No Meta credentials configured, so this would have posted nowhere. Set ' +
               'META_TAMESIDE_PAGE_ID and META_TAMESIDE_PAGE_TOKEN on the service (and ' +
               'META_IG_USER_ID if Instagram is wanted).',
      });
    }

    // Nothing to announce. A 200, because nothing went wrong and a scheduler retrying a 4xx
    // every Sunday through the summer would be noise — but with `skipped` set and `posted`
    // empty, so it can never be read as "the post went out".
    if (!urls.length) {
      return res.json({
        ok: true, skipped: 'no fixtures in the coming week', fixtures: 0,
        posted: [], failed: [], caller: req.socialCaller,
      });
    }

    if (dry) {
      const ig = meta.targets().instagram;
      if (!ig) {
        return res.json({
          ok: true, dry: true, images: urls, fixtures: rows.length,
          note: 'META_IG_USER_ID is unset, so there is no Instagram target to validate ' +
                'against. The format check that matters is Instagram\'s.',
        });
      }
      const check = await meta.validateImages(ig.id, ig.token, urls);
      return res.json({ ok: check.ok, dry: true, images: urls, fixtures: rows.length, refused: check.refused });
    }

    const text = await captions(rows);
    const out = await meta.publishEverywhere(configured, {
      imageUrls: urls,
      message: text.facebook,
      caption: text.instagram,
    });

    for (const f of out.failed) console.error(`weekly fixtures -> ${f.target} failed:`, f.error.message);
    if (out.posted.length) console.log('weekly fixtures posted to', out.posted.map(p => p.target).join(', '));

    // 207 when some targets took it and some did not. Reporting only success would make a
    // half failure indistinguishable from a whole one — and a scheduler retrying a 500 it
    // should not have seen would double-post the half that worked.
    return res.status(out.ok ? 200 : (out.posted.length ? 207 : 502)).json({
      ok: out.ok,
      images: urls,
      fixtures: rows.length,
      divisions: divisionsWithFixtures(rows),
      mentioned: text.mentioned,
      posted: out.posted,
      failed: out.failed.map(f => ({ target: f.target, error: f.error.message })),
      caller: req.socialCaller,
    });
  } catch (err) {
    next(err);
  }
};

/** GET /admin/social/weekly-fixtures — what would be posted, sending nothing. */
exports.preview = async function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const rows = await Fixture.getUpcomingWeek();
    const text = await captions(rows);
    const t = meta.targets();
    res.render('admin/weekly-fixtures-preview', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'Weekly fixtures post',
      pageTitle: 'Weekly fixtures post',
      pageDescription: 'What the weekly fixtures post will contain',
      canonical: canonicalFor(req),
      images: imageUrls(rows),
      imagePaths: imagePaths(rows),
      divisions: divisionsWithFixtures(rows),
      fixtureCount: rows.length,
      captions: text,
      facebookConfigured: Boolean(t.page),
      instagramConfigured: Boolean(t.instagram),
    });
  } catch (err) {
    next(err);
  }
};

exports.captions = captions;
exports.imageUrls = imageUrls;
exports.imagePaths = imagePaths;
exports.divisionsWithFixtures = divisionsWithFixtures;
