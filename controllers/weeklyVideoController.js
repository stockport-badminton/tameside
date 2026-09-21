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
//
// ── The generate job also prepares the Instagram container ───────────────────
//
// Measured on the first real run, 21 Sep 2026: this post took **45.2s of the 60s budget**
// for the smallest video the system can make — two slides, 5.4 seconds — and the same
// video's transcode had taken 27.4s an hour earlier. Meta's queue swings by ~18s on
// identical input, and the busiest results week here is nine fixtures.
//
// So the transcode wait moved into the 17:50 job, where nothing is racing a deadline, and
// this handler publishes a container that is already `FINISHED`. **The failure it avoids
// is a quiet one**: over the poll ceiling this answers 207 with Facebook posted and
// Instagram missing, and 207 is a 2xx, so Cloud Scheduler records the run as a success.
//
// Falling back to the inline path when no container is available is deliberate — it is
// what this did before, so the worst case is unchanged rather than made worse.

const video = require('../utils/socialVideo');
const { storedVideoAge, readContainerRecord } = require('./socialVideoController');
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

function videoUrl() {
  return absoluteUrl(socialVideoPath(POST_ASPECT));
}

// Captions live in `utils/socialVideo.js` now, not here.
//
// **The Instagram caption is fixed when the CONTAINER is created, not when it is
// published** — `media_publish` takes only `creation_id`. The container is prepared by
// the 17:50 generate job and published by this one at 18:00, so both halves need the same
// caption, and keeping it in either controller would have made one require the other.
const captions = video.captions;

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

    // The container the generate job prepared, if it is still usable.
    //
    // `videoLastModified` is derived from the freshness check above rather than fetched
    // again — one HeadObject answers both questions. It is what catches a video
    // regenerated after its container was prepared, where the container would still
    // resolve, still look fresh, and publish the previous render.
    const record = await readContainerRecord(POST_ASPECT, {
      videoLastModified: Date.now() - freshness.ageMs,
    });
    if (!record.ok) {
      // Not an error. Instagram falls back to doing the whole thing inline, which is what
      // it did before the split — slower, and at risk of the request timeout, but a slow
      // post beats no post. Logged because a fallback every week means the generate job's
      // preparation step is quietly failing.
      console.log('[weekly video] no prepared container, posting Instagram inline:', record.reason);
    }

    const text = captions(req.query.week || (req.body && req.body.week));
    const out = await meta.publishVideoEverywhere(configured, {
      videoUrl: url, message: text.facebook, caption: text.instagram,
      preparedContainerId: record.ok ? record.containerId : null,
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
      preparedContainer: record.ok ? record.containerId : null,
      containerFallbackReason: record.ok ? undefined : record.reason,
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
    const record = freshness.ok
      ? await readContainerRecord(POST_ASPECT, { videoLastModified: Date.now() - freshness.ageMs })
      : { ok: false, reason: 'No usable video, so no container was checked.' };
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
      container: record,
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
