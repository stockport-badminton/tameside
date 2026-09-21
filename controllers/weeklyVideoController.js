// The weekly results video post — the third of the scheduled social posts.
//
// It borrows the shape of `weeklyTablesController` and `weeklyFixturesController`
// deliberately: same `configuredTargets()`, same per-target reporting, same gate, same
// `?dry=1`, same 200/207/502. The differences are all about video.
//
// ── Why this one is two scheduler jobs and the other two are one ─────────────
//
// The tables and fixtures cards are drawn per request by a route Meta fetches directly. A
// video cannot be: encoding takes seconds and Meta will not hold a fetch open that long,
// so it is built ahead of time into S3 and served from `GET /social-video/:aspect`.
//
// Stockport left "generate, then post, or fold generation into the post?" explicitly
// undecided. **Here it is decided, and by a constraint they do not have.** This service
// runs a 60-second Cloud Run request timeout — lowered from 600 after the 2026-09-17
// pooler stall, where a wedged instance held every request it had for ten minutes. One
// request cannot both encode the video and then wait on Meta's transcode of it, and being
// cut off by the platform mid-publish is the one failure that could double-post on a
// retry. So: two jobs, a few minutes apart.
//
// **What makes that safe is `videoFreshness`, not the wall clock.** Two coupled jobs are
// fragile on their own; a post that refuses anything older than two days is not.

const video = require('../utils/socialVideo');
const { storedVideoAge } = require('./socialVideoController');
const meta = require('../utils/metaPublisher');
const { absoluteUrl, canonicalFor } = require('../utils/siteUrl');
const { socialVideoPath } = require('../utils/socialPaths');
const Fixture = require('../models/fixture');
const { isSuperAdmin } = require('../utils/authz');

// How old the stored video may be and still be "this week's results".
//
// **The handler posts whatever is in the bucket, and the bucket keeps the last render for
// ever.** Without this, a generation that did not happen — the endpoint refused, the
// encode crashed, the scheduler misfired — means last week's results are published as
// this week's, under a caption saying so. That is worse than posting nothing.
//
// Two days rather than seven: the post runs weekly, so anything older than a couple of
// days means the generation step did not run this cycle.
const MAX_VIDEO_AGE_MS = 2 * 24 * 60 * 60 * 1000;

// The aspect posted. An enum key, never a path fragment.
const POST_ASPECT = Object.keys(video.VIDEO_SIZES)[0];

const SITE = 'https://tameside-badminton.co.uk';
const HASHTAGS = '#badmintonresults #tameside #badminton #tbl #bulutangkis';

function videoUrl() {
  return absoluteUrl(socialVideoPath(POST_ASPECT));
}

/**
 * Captions.
 *
 * **No @-mentions on either, and that is the opposite call from the tables post.** A
 * results video names every club that played, and mentioning all of them reads as spam
 * rather than courtesy — where the tables post's mentions are most of its point. Facebook
 * page mentions are not `@`-syntax at all and need the Pages API; see
 * `docs/social-posting.md` before adding any.
 */
function captions(weekLabel) {
  const week = weekLabel ? ` — ${weekLabel}` : '';
  const line = `This week's results${week}. Full tables at ${SITE}`;
  return {
    facebook: `${line}\n\n${HASHTAGS}`,
    instagram: `${line}\n\n${HASHTAGS}`,
  };
}

/**
 * Is the stored video recent enough to be this week's?
 *
 * **Read from S3 rather than trusted.** The generate step and the post step are separate
 * calls and nothing else would notice if the first had not happened.
 */
async function videoFreshness(now = Date.now()) {
  const ageMs = await storedVideoAge(POST_ASPECT, now);
  if (ageMs === null) {
    return { ok: false, ageMs: null, reason: 'No video has been generated yet.' };
  }
  if (ageMs > MAX_VIDEO_AGE_MS) {
    return {
      ok: false, ageMs,
      reason: `The stored video is ${Math.round(ageMs / 86400000)} days old, so it is not ` +
              `this week's results.`,
    };
  }
  return { ok: true, ageMs };
}

/**
 * POST /admin/social/weekly-video — publish it.
 *
 * `?dry=1` asks Meta to fetch and transcode the video and publishes nothing; the container
 * expires on its own in 24 hours. The stale check runs first even for a dry run —
 * validating last week's video would report "ok" for something that must not go out.
 */
exports.run = async function (req, res, next) {
  try {
    const dry = req.query.dry === '1' || (req.body && req.body.dry === '1');
    const url = videoUrl();
    const configured = meta.configuredTargets();

    // Same rule as the other two posts: a switch whose halves live in different places
    // must fail loudly when only one is set. Posting nowhere is not a quiet success.
    if (!configured.length) {
      return res.status(500).json({
        ok: false,
        error: 'No Meta credentials configured, so this would have posted nowhere. Set ' +
               'META_TAMESIDE_PAGE_ID and META_TAMESIDE_PAGE_TOKEN on the service (and ' +
               'META_IG_USER_ID if Instagram is wanted).',
      });
    }

    // Refuse a stale video rather than publish last week's results as this week's. A
    // missing one is refused too: better a loud 409 than Meta fetching a 404 and the job
    // recording a cheerful failure.
    const freshness = await videoFreshness();
    if (!freshness.ok) {
      return res.status(409).json({
        ok: false, video: url, aspect: POST_ASPECT,
        error: freshness.reason +
               ' Generate it first: GET /api/social/generate-weekly-video.',
        posted: [], failed: [],
      });
    }

    if (dry) {
      const ig = meta.targets().instagram;
      if (!ig) {
        return res.json({
          ok: true, dry: true, video: url, aspect: POST_ASPECT,
          note: 'META_IG_USER_ID is unset, so there is no Instagram target to validate ' +
                'against. A Facebook page video is only checkable by posting one.',
        });
      }
      const check = await meta.validateVideo(ig.id, ig.token, url);
      return res.json({ ok: check.ok, dry: true, video: url, aspect: POST_ASPECT, refused: check.refused });
    }

    const text = captions(req.query.week || (req.body && req.body.week));
    const out = await meta.publishVideoEverywhere(configured, {
      videoUrl: url, message: text.facebook, caption: text.instagram,
    });

    for (const f of out.failed) console.error(`weekly video -> ${f.target} failed:`, f.error.message);
    if (out.posted.length) console.log('weekly video posted to', out.posted.map(p => p.target).join(', '));

    // 207 when some targets took it and some did not. Reporting only success would make a
    // half failure indistinguishable from a whole one.
    return res.status(out.ok ? 200 : (out.posted.length ? 207 : 502)).json({
      ok: out.ok,
      video: url,
      aspect: POST_ASPECT,
      videoAgeSeconds: Math.round(freshness.ageMs / 1000),
      posted: out.posted,
      failed: out.failed.map(f => ({ target: f.target, error: f.error.message })),
      caller: req.socialCaller,
    });
  } catch (err) {
    next(err);
  }
};

/** GET /admin/social/weekly-video — what would be posted, sending nothing. */
exports.preview = async function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const freshness = await videoFreshness();
    const results = await Fixture.getWeekResults();
    const t = meta.targets();
    res.render('admin/weekly-video-preview', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'Weekly video post',
      pageTitle: 'Weekly video post',
      pageDescription: 'What the weekly results video post will contain',
      canonical: canonicalFor(req),
      // Same-origin for the <video> element, so the page shows THIS server's file. The
      // absolute URL below it is what Meta will fetch. The tables preview gets this wrong
      // and renders production's images whatever server it is running on.
      videoPath: socialVideoPath(POST_ASPECT),
      videoUrl: videoUrl(),
      aspect: POST_ASPECT,
      freshness,
      maxAgeDays: Math.round(MAX_VIDEO_AGE_MS / 86400000),
      results,
      captions: captions(),
      facebookConfigured: Boolean(t.page),
      instagramConfigured: Boolean(t.instagram),
    });
  } catch (err) {
    next(err);
  }
};

exports.videoFreshness = videoFreshness;
exports.captions = captions;
exports.videoUrl = videoUrl;
exports.MAX_VIDEO_AGE_MS = MAX_VIDEO_AGE_MS;
exports.POST_ASPECT = POST_ASPECT;
