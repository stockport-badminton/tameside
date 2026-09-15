// The weekly league-tables post, from here rather than from a Make.com scenario.
//
// Both division tables go to the league's Facebook page as one album, and to the Instagram
// account as one carousel.
//
// ── Two things that are new, not ported ──────────────────────────────────────
//
// **Tameside's league tables have never been on Instagram.** The Make scenario posts them
// to the Facebook page only — the Instagram carousel alongside it carries the *Stockport*
// league's image URLs, not ours. So this gives Tameside a post it has never had rather than
// reproducing one.
//
// **It now has its own Instagram account**, `tameside.badminton` (15 Sep 2026). The handover
// this was ported from treats "Meta refused a second account, so the two leagues share
// `stockport.badders.results`" as a hard constraint, and that premise is gone. Leaving
// `META_IG_USER_ID` unset is still the one-variable way to post to Facebook only.
//
// **The double-post risk is on FACEBOOK, and it is still real.** Make's route 3 posts
// Tameside's tables to the same Tameside Page this does, and it is *schedule*-triggered —
// it fires every Saturday whatever either site does. So the cutover still has to be atomic:
// disable the Make scenario and unpause the scheduler job on the same day, never spanning a
// Saturday. Until then the job stays PAUSED. Instagram is no longer part of that risk, since
// Make posts to the Stockport account and this posts to Tameside's own.
//
// ── Tournament posters are not ported ────────────────────────────────────────
//
// The Stockport controller can add them to the post. Its five posters are Stockport's own
// content, down to the venue address, and Tameside has neither the posters nor the
// background art for them. Reproducing the capability here would be building a feature
// nobody has asked for against content that does not exist.

const { absoluteUrl, canonicalFor } = require('../utils/siteUrl');
const { leagueTableImagePath } = require('../utils/socialPaths');
const meta = require('../utils/metaPublisher');
const Club = require('../models/club');
const { isSuperAdmin } = require('../utils/authz');

// The order the tables read in the post: top division first. Two here; the Stockport league
// has four. Matched to the division NAME by the image route.
const DIVISIONS = ['Division 1', 'Division 2'];

const SITE = 'https://tameside-badminton.co.uk';
const HASHTAGS = '#badmintonresults #tameside #badminton #tbl #bulutangkis';

/**
 * Captions.
 *
 * Instagram turns a bare `@handle` in a caption into a real mention, so the clubs we hold
 * handles for are named there.
 *
 * **Facebook's caption names no clubs at all, and that is deliberate.** A page mention needs
 * the Pages API; the `@Club Name` text a Make scenario carries does nothing whatsoever, and
 * the Stockport one has been posting a literal `@Shell Badminton Club` into its message for
 * years without anyone noticing. Omitting them is honest; faking them is not.
 */
async function captions() {
  const clubs = await Club.getInstagramHandles();
  const mentions = clubs.map(c => '@' + c.handle).join(' ');

  return {
    facebook: `League tables for this week. ${SITE}\n\n${HASHTAGS}`,
    // `.filter(Boolean)` matters: no club has a handle stored yet, and an empty mentions
    // line would otherwise post as a blank paragraph in the middle of the caption.
    instagram: [`This week's league tables. ${SITE}`, mentions, HASHTAGS]
      .filter(Boolean).join('\n\n'),
    mentioned: clubs.map(c => c.name),
  };
}

/** The images, in division order. Absolute, https, and ending `.jpg` — all three required. */
function imageUrls() {
  return DIVISIONS.map(d => absoluteUrl(leagueTableImagePath(d)));
}

/**
 * POST /admin/social/weekly-tables — publish it.
 *
 * `?dry=1` asks Meta whether it would accept the images and posts nothing. Worth running
 * before a season's first real post: a scheduled job nobody is watching is exactly where a
 * silent refusal hides, which is how the Stockport carousel managed never to work at all.
 */
exports.run = async function (req, res, next) {
  try {
    const dry = req.query.dry === '1' || (req.body && req.body.dry === '1');
    const urls = imageUrls();
    const configured = meta.configuredTargets();

    // **No targets is a failure, not a quiet success.** `SOCIAL_POST_DIRECT` and the
    // credentials live in different places — the service config and `.env`, which is
    // gitignored and never deployed — so setting one without the other is the easy mistake.
    // On the Stockport side it produced a service that took the direct path, found nothing
    // to post to, posted nowhere, and reported `ok: true`, because an empty target list
    // produces neither a post nor a failure.
    //
    // There is deliberately no fallback to Make.com here. A fallback hides the
    // misconfiguration until it bites somewhere less convenient.
    if (!configured.length) {
      return res.status(500).json({
        ok: false,
        error: 'No Meta credentials configured, so this would have posted nowhere. Set ' +
               'META_TAMESIDE_PAGE_ID and META_TAMESIDE_PAGE_TOKEN on the service (and ' +
               'META_IG_USER_ID if Instagram is wanted).',
      });
    }

    if (dry) {
      const ig = meta.targets().instagram;
      if (!ig) {
        return res.json({
          ok: true, dry: true, images: urls,
          note: 'META_IG_USER_ID is unset, so there is no Instagram target to validate ' +
                'against. The format check that matters is Instagram\'s.',
        });
      }
      const check = await meta.validateImages(ig.id, ig.token, urls);
      return res.json({ ok: check.ok, dry: true, images: urls, refused: check.refused });
    }

    const text = await captions();
    const out = await meta.publishEverywhere(configured, {
      imageUrls: urls,
      message: text.facebook,
      caption: text.instagram,
    });

    for (const f of out.failed) console.error(`weekly tables -> ${f.target} failed:`, f.error.message);
    if (out.posted.length) console.log('weekly tables posted to', out.posted.map(p => p.target).join(', '));

    // 207 when some targets took it and some did not. Reporting only success would make a
    // half failure indistinguishable from a whole one — and a scheduler retrying a 500 it
    // should not have seen would double-post the half that worked.
    return res.status(out.ok ? 200 : (out.posted.length ? 207 : 502)).json({
      ok: out.ok,
      images: urls,
      mentioned: text.mentioned,
      posted: out.posted,
      failed: out.failed.map(f => ({ target: f.target, error: f.error.message })),
      caller: req.socialCaller,
    });
  } catch (err) {
    next(err);
  }
};

/** GET /admin/social/weekly-tables — what would be posted, sending nothing. */
exports.preview = async function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const text = await captions();
    const t = meta.targets();
    res.render('admin/weekly-tables-preview', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'Weekly tables post',
      pageTitle: 'Weekly tables post',
      pageDescription: 'What the weekly league tables post will contain',
      canonical: canonicalFor(req),
      images: imageUrls(),
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
exports.DIVISIONS = DIVISIONS;
