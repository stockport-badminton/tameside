// Building the weekly results video, and serving it back.
//
// Two routes, deliberately far apart in what they are allowed to do:
//
//   GET /api/social/generate-weekly-video   gated, renders and uploads
//   GET /social-video/:aspect               public, streams what is in the bucket
//
// The encoding itself is `utils/socialVideo.js`; this file is the S3 and HTTP layer.
//
// ── Why the video is stored, when every other social image is not ────────────
//
// The tables, fixtures and result cards are drawn per request by a route Meta fetches
// directly, because writing them to a container's disk is writing them to one instance's
// tmpfs — the reason none of those images could ever be fetched back. A video cannot work
// that way: it takes seconds to encode, far longer than Meta will hold a fetch open, and
// re-encoding it on every fetch would mean re-encoding it on every retry. So it is built
// ahead of time into S3, and `GET /social-video/:aspect` streams it.
//
// ── The object is private, and must stay private ─────────────────────────────
//
// `uploadVideo` sets no ACL. That is the same rule as the scorecard photos: the bucket is
// shared with the Stockport league site, and `/sign-s3` setting `ACL: public-read` on
// every upload is what made every scorecard in it world-readable. Stockport is sweeping
// those ACLs, so an object relying on one would break the day they get to it.
//
// This route is what replaces the public URL. **Do not "fix" a 403 by making the object
// public** — that is the whole point of the route existing.

const { GetObjectCommand, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const s3util = require('../utils/s3');
const meta = require('../utils/metaPublisher');
const video = require('../utils/socialVideo');
const Fixture = require('../models/fixture');
const { absoluteUrl } = require('../utils/siteUrl');
const { socialVideoPath } = require('../utils/socialPaths');

const { VIDEO_KEYS, VIDEO_SIZES } = video;

// How recent a stored video has to be for a generate request to reuse it rather than
// re-encode. Short: this exists so that a retry, a double-click on the admin button or a
// scheduler firing twice does not pay for the encode again, not as a cache.
const REUSE_WINDOW_MS = 10 * 60 * 1000;

// Cache-Control on the two paths. The hit is `public` — there is nothing private here, it
// is about to be posted publicly — and short, because it is regenerated weekly.
//
// The miss is `no-store`, and that is not tidiness. **Firebase Hosting applies its own
// `max-age=600` to any response that sets no Cache-Control, 404s included, and Meta
// retries.** A transient 404 — a deploy in flight, a video not generated yet — would
// otherwise be cached and the retry would never see the fix. The window outlives the
// fault. Same reasoning as `utils/render404.js` and the social images.
const VIDEO_HIT_CACHE = 'public, max-age=300';
const VIDEO_MISS_CACHE = 'no-store';

// One encode at a time per process. See the note on `singleFlight` — this is deliberately
// NOT Stockport's S3 lock file, which recognised a stale lock without deleting it and so
// answered "generation in progress by another instance" for 115 days after one
// interrupted run.
const runExclusively = video.singleFlight();

// ── The prepared Instagram container ─────────────────────────────────────────
//
// **Why the container is created here and published an hour later.**
//
// Measured 21 Sep 2026 on the first real run: posting a 5.4-second, two-slide video took
// **45.2 seconds of a 60-second Cloud Run request budget**, and the same video's transcode
// had taken 27.4s an hour earlier — Meta's queue swings by ~18s on identical input. The
// busiest results week in this database is nine fixtures, several times longer. That is
// not a margin, and the failure it was heading for is a quiet one: over 45s the post
// answers **207** with Facebook posted and Instagram missing, and a 207 is a 2xx, so
// Cloud Scheduler records the run as a success.
//
// A Reels container stays publishable for 24 hours, so the wait is paid by the generate
// job and the post is reduced to one fast call. Exactly the same split, for the same
// reason, as generate-vs-post itself.
const CONTAINER_KEYS = Object.fromEntries(
  Object.keys(VIDEO_KEYS).map(a => [a, VIDEO_KEYS[a].replace(/\.mp4$/, '.container.json')]));

// Containers expire at 24 hours. Twelve is the refusal point, so a post can never publish
// something within sight of expiry and get an error that reads like a code fault.
const CONTAINER_MAX_AGE_MS = 12 * 60 * 60 * 1000;

async function writeContainerRecord(aspect, record) {
  await s3util.s3Client().send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: CONTAINER_KEYS[aspect],
    Body: Buffer.from(JSON.stringify(record)),
    ContentType: 'application/json',
  }));
}

/**
 * The stored container, or a reason it cannot be used.
 *
 * **The container must be at least as new as the video**, which is the check that matters
 * and is not obvious. Meta fetches `video_url` when the container is created, so the
 * container holds a *snapshot* of whatever the URL served at that moment. Regenerate the
 * video without re-preparing and the record still resolves, still looks fresh, and
 * publishes last render's content under this week's caption — the same class of silent
 * wrongness `videoFreshness` exists to prevent, one level down.
 */
async function readContainerRecord(aspect, { videoLastModified = null, now = Date.now() } = {}) {
  let body;
  try {
    const obj = await s3util.s3Client().send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME, Key: CONTAINER_KEYS[aspect],
    }));
    body = JSON.parse(await obj.Body.transformToString());
  } catch (err) {
    return { ok: false, reason: 'No Instagram container has been prepared.' };
  }

  const createdAt = Date.parse(body && body.createdAt);
  if (!body || !body.containerId || Number.isNaN(createdAt)) {
    return { ok: false, reason: 'The stored container record is unreadable.' };
  }

  const ageMs = now - createdAt;
  if (ageMs > CONTAINER_MAX_AGE_MS) {
    return { ok: false, ageMs, reason: `The prepared container is ${Math.round(ageMs / 3600000)}h old and close to expiring.` };
  }
  if (videoLastModified && createdAt < videoLastModified) {
    return {
      ok: false, ageMs,
      reason: 'The video was regenerated after the container was prepared, so the ' +
              'container holds the previous render.',
    };
  }
  return { ok: true, ageMs, containerId: body.containerId, caption: body.caption };
}

exports.readContainerRecord = readContainerRecord;
exports.CONTAINER_KEYS = CONTAINER_KEYS;
exports.CONTAINER_MAX_AGE_MS = CONTAINER_MAX_AGE_MS;

/** The card each result becomes. One slide per fixture, in the order they were played. */
function slidesFor(results) {
  return results.map(r => ({
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    division: r.divisionName,
  }));
}

exports.slidesFor = slidesFor;

/** When the stored video was last written, or null if there is not one. */
async function storedVideoAge(aspect, now = Date.now()) {
  try {
    const head = await s3util.s3Client().send(new HeadObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME, Key: VIDEO_KEYS[aspect],
    }));
    return now - head.LastModified.getTime();
  } catch (err) {
    return null;
  }
}

exports.storedVideoAge = storedVideoAge;

async function uploadVideo(aspect, buffer) {
  await s3util.s3Client().send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: VIDEO_KEYS[aspect],
    Body: buffer,
    ContentType: 'video/mp4',
    // No ACL, on purpose. See the note at the top of this file.
  }));
}

/**
 * GET /api/social/generate-weekly-video — render the week's results and store the mp4.
 *
 * Gated by `requireCronCaller`, like every other scheduled endpoint here. Ungated it lets
 * anyone on the internet start an ffmpeg encode on Cloud Run, repeatedly; Stockport's S3
 * lock blunted that by accident and is not an authorization control.
 *
 * **This has to finish inside 60 seconds** — the service's request timeout, lowered from
 * 600 after the 2026-09-17 pooler stall. Measured 21 Sep 2026: five slides render and
 * encode in 3.8s locally. The headroom is large, but it is the reason the post is a
 * separate call rather than this one doing both.
 */
exports.generate = async function (req, res, next) {
  try {
    const aspect = req.query.aspect || Object.keys(VIDEO_SIZES)[0];
    if (!Object.prototype.hasOwnProperty.call(VIDEO_SIZES, aspect)) {
      return res.status(400).json({ error: `aspect must be one of ${Object.keys(VIDEO_SIZES).join(', ')}` });
    }

    const url = absoluteUrl(socialVideoPath(aspect));
    const force = req.query.force === '1';

    const age = await storedVideoAge(aspect);
    if (!force && age !== null && age < REUSE_WINDOW_MS) {
      return res.json({
        ok: true, reused: true, aspect, video: url,
        ageSeconds: Math.round(age / 1000),
        note: `A video generated ${Math.round(age / 1000)}s ago is being reused. ` +
              'Pass ?force=1 to re-encode anyway.',
      });
    }

    const results = await Fixture.getWeekResults();

    // **No results is a 404 and nothing is written.** It must not overwrite last week's
    // video with an empty one, and it must not leave a stale one looking fresh — the post
    // handler's freshness check reads `LastModified`, so touching the object here on a
    // quiet week would tell it a lie.
    if (!results.length) {
      return res.status(404).set('Cache-Control', VIDEO_MISS_CACHE).json({
        ok: false, aspect,
        error: 'No results in the last seven days, so there is nothing to put in a video.',
      });
    }

    const started = Date.now();
    const out = await runExclusively(() => video.renderVideo(slidesFor(results), { aspect }));
    await uploadVideo(aspect, out.buffer);
    const took = Date.now() - started;

    console.log(`[social-video] ${out.slides} slides, ${out.seconds}s, ${out.buffer.length} bytes, took ${took}ms`);

    // Pay Meta's transcode here rather than in the post. See the note above CONTAINER_KEYS.
    //
    // **A failure here does not fail the generate.** The video is uploaded and Facebook can
    // still post it; the post handler falls back to preparing a container inline, which is
    // simply what it used to do. Failing the whole run would turn a slow Instagram post
    // into no post at all.
    const ig = meta.targets().instagram;
    let container = null;
    if (ig) {
      const prepStarted = Date.now();
      try {
        const caption = video.captions().instagram;
        // `wait: false` — see prepareInstagramReel. Waiting for the transcode here would
        // put render (~24s for a busy week) and transcode (27-45s) in one request, which
        // is ~69s against a 60s ceiling. The post job checks the status before publishing.
        const { containerId } = await meta.prepareInstagramReel(ig.id, ig.token, {
          videoUrl: url, caption, wait: false,
        });
        await writeContainerRecord(aspect, {
          containerId, caption, aspect, createdAt: new Date().toISOString(),
        });
        container = { containerId, tookMs: Date.now() - prepStarted };
        console.log(`[social-video] instagram container ${containerId} ready in ${container.tookMs}ms`);
      } catch (err) {
        container = { error: err.message };
        console.error('[social-video] could not prepare the Instagram container:', err.message);
      }
    }

    res.json({
      ok: true, aspect, video: url,
      results: results.length,
      slides: out.slides,
      seconds: out.seconds,
      bytes: out.buffer.length,
      tookMs: took,
      container,
      caller: req.socialCaller,
    });
  } catch (err) {
    // ffmpeg missing, or an encode that failed, is a 500 with the reason in the body —
    // this endpoint is driven by a scheduler and by a person with curl, and both need to
    // be told what went wrong rather than being handed the generic error page.
    console.error('[social-video] generation failed:', err.message);
    next(err);
  }
};

/**
 * GET /social-video/:aspect — stream the stored video.
 *
 * **Unauthenticated on purpose**, like the league-table and fixtures images and for the
 * same reason: Meta fetches it from Meta's own servers, so anything gated here could never
 * be posted. It shows nothing that is not already on the results page.
 *
 * **`aspect` is looked up in `VIDEO_KEYS` and never used to build a key.** Nothing a
 * caller sends reaches S3 — this bucket holds another league's scorecards, and a route
 * that streams any object anyone can name has moved the problem rather than solved it.
 * The same rule as `/scorecard-photo/:id`, where ownership is an allowlist on the
 * `tameside-` prefix rather than a denylist.
 */
exports.serve = async function (req, res, next) {
  try {
    const key = Object.prototype.hasOwnProperty.call(VIDEO_KEYS, req.params.aspect)
      ? VIDEO_KEYS[req.params.aspect]
      : null;

    if (!key) {
      return res.status(404).set('Cache-Control', VIDEO_MISS_CACHE).type('text/plain')
        .send('No such aspect. Known: ' + Object.keys(VIDEO_KEYS).join(', '));
    }

    let obj;
    try {
      obj = await s3util.s3Client().send(new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME, Key: key,
      }));
    } catch (err) {
      // Not generated yet is a 404, not a 500 and not a Sentry event — and it must not be
      // cached, or the retry after the generation runs will hit Firebase's copy of it.
      return res.status(404).set('Cache-Control', VIDEO_MISS_CACHE).type('text/plain')
        .send('That video has not been generated yet');
    }

    res.set('Content-Type', 'video/mp4');
    // The type is ours, from the key, never echoed from what S3 reports. Legacy objects in
    // this bucket were uploaded through an unauthenticated `/sign-s3` that stored the
    // caller's content type, so one can claim `text/html` — and reflecting that serves
    // attacker-chosen HTML from our own origin, same-origin with the `__session` cookie.
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', VIDEO_HIT_CACHE);
    // Meta fetches this with a range request while transcoding; without this it cannot.
    res.set('Accept-Ranges', 'bytes');
    if (obj.ContentLength) res.set('Content-Length', String(obj.ContentLength));

    // The stream needs its own 'error' listener. Without one, a failure part-way through
    // the transfer is an unhandled 'error' on an EventEmitter and takes the whole instance
    // down. Headers are already sent by then, so all that is left is to stop talking.
    obj.Body.on('error', () => res.destroy());
    obj.Body.pipe(res);
  } catch (err) {
    next(err);
  }
};

exports.VIDEO_KEYS = VIDEO_KEYS;
exports.VIDEO_SIZES = VIDEO_SIZES;
exports.REUSE_WINDOW_MS = REUSE_WINDOW_MS;
