// Turning a week of result cards into an mp4.
//
// Ported in spirit from the Stockport league site's `socialVideoController`, and
// deliberately not line by line — two of its three moving parts do not survive the
// crossing, and the third had already cost that site a 115-day outage.
//
// ── What does not port, and why ──────────────────────────────────────────────
//
// **The slides are drawn with Jimp, because everything on this site is.** Stockport draws
// them with sharp and an SVG overlay, which needs fontconfig and a system font; this image
// has neither, on purpose (CLAUDE.md, *Social Image Generation*). Copying that code across
// renders every label blank in production and nowhere else. So the slides here come from
// `social_controller.buildResultCard` — the same function that draws the card posted after
// a single result, which means the video and the individual posts cannot drift apart.
//
// **No ImageMagick.** Stockport builds the video by writing every frame to disk: 25 frames
// a second, one `convert` invocation per transition frame, ~36 seconds of encode for a
// handful of slides. ffmpeg's `xfade` filter does the same crossfade in one pass, so the
// only external binary this needs is ffmpeg — and `letterbox()` below does the fit-and-pad
// in Jimp, which is where the two `convert` geometry bugs in their `letterboxArgs` lived
// (`-resize WxH` vs `W:H`, and `-extent` written before the `-gravity`/`-background` it
// depends on).
//
// **No S3 lock file.** Theirs recognised a stale lock without deleting it, and the atomic
// create that followed used `IfNoneMatch: '*'` — so one interrupted encode wedged the
// feature permanently and reported it as a concurrent run that did not exist. It answered
// 202 for 115 days. The concurrency this guards against is two Cloud Run instances
// encoding at once, which costs CPU and nothing else: both write the same key and the
// content is identical. `singleFlight` below covers the real case (one instance asked
// twice) in-process, where there is no object to go stale.
//
// ── The one hard constraint that is ours alone ───────────────────────────────
//
// **This service's Cloud Run request timeout is 60 seconds** (`_REQUEST_TIMEOUT` in
// cloudbuild.yaml, lowered from 600 after the 2026-09-17 pooler stall). Stockport runs the
// default. So generation has to fit inside a minute, and it cannot be folded into the post
// handler — the post's own Meta transcode poll would not fit alongside it. That is why the
// scheduler runs two jobs here, and why `videoFreshness` in weeklyVideoController is the
// thing that makes the split safe.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const Jimp = require('jimp');

const execFileAsync = promisify(execFile);

// The frame size, and the only geometry this file knows about.
//
// **4:5, because the source cards are 1080x1350 and that is 4:5.** Every pixel is content
// and there is no letterboxing at all. Stockport shipped 16:9 and 1:1 for four months
// before anyone could fetch the output, then measured (20 Sep 2026) that Instagram Reels
// accepts 0.8 comfortably and dropped 16:9 as "a landscape frame around portrait content,
// most of its width black bars". Their 1:1 survives only because it predates the question;
// nothing posts it. Tameside starts from the answer and renders the one aspect it posts.
//
// It stays a map rather than two constants so that adding one is a line, and so that the
// read route can look an `aspect` up here instead of building an S3 key from a request.
const VIDEO_SIZES = { '4-5': { width: 1080, height: 1350 } };

const S3_PREFIX = 'tameside-social-videos';

// **The `tameside-` prefix is the ownership test**, not decoration. This bucket is shared
// with the Stockport league site, which owns it and holds its own scorecards at the root;
// `utils/scorecardPhoto.js` decides what is ours by that prefix and nothing else. An object
// written without it is indistinguishable from theirs.
const VIDEO_KEYS = Object.fromEntries(
  Object.keys(VIDEO_SIZES).map(a => [a, `${S3_PREFIX}/weekly-video-${a.replace('-', '_')}.mp4`]));

const DEFAULT_SLIDE_SECONDS = 3;
const DEFAULT_TRANSITION_SECONDS = 0.6;
const FRAMERATE = 25;

/**
 * Fit a card inside the frame and pad the remainder — a letterbox, never a squash.
 *
 * A no-op for a card that is already the frame size, which is every card today. It is here
 * for the case that is not hypothetical: `xfade` requires every input to have identical
 * dimensions, so one division's artwork being replaced at a different size would otherwise
 * fail the encode rather than produce a slightly odd slide.
 *
 * Exported because the arithmetic is the part worth testing, and testing it through a real
 * encode needs ffmpeg present.
 */
function letterboxGeometry(srcW, srcH, frameW, frameH) {
  const scale = Math.min(frameW / srcW, frameH / srcH);
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  return {
    width, height,
    left: Math.round((frameW - width) / 2),
    top: Math.round((frameH - height) / 2),
  };
}

async function letterbox(buffer, frameW, frameH) {
  const image = await Jimp.read(buffer);
  if (image.bitmap.width === frameW && image.bitmap.height === frameH) return buffer;

  const g = letterboxGeometry(image.bitmap.width, image.bitmap.height, frameW, frameH);
  const frame = new Jimp(frameW, frameH, 0x000000ff);
  frame.composite(image.resize(g.width, g.height), g.left, g.top);
  return frame.quality(90).getBufferAsync(Jimp.MIME_JPEG);
}

/**
 * The ffmpeg arguments for a crossfaded slideshow.
 *
 * Each slide is a still looped for `slide` seconds, and `xfade` overlaps consecutive pairs
 * by `transition` seconds. The offsets accumulate: the k-th transition starts at
 * `k * (slide - transition)`, because every crossfade consumes `transition` seconds of the
 * running total rather than adding to it. Getting that wrong does not fail — it produces a
 * video that freezes on one slide and skips another, which is only visible by watching it.
 *
 * Total length is therefore `n * slide - (n - 1) * transition`. **Stockport's is
 * `n * slide + (n - 1) * transition`**, because their frame-by-frame builder inserts
 * transition frames between the slides instead of overlapping them. Neither is wrong; they
 * are different transitions, and the reported duration has to match whichever is built.
 *
 * Pure and exported so the filter graph is asserted without ffmpeg installed — the same
 * reason Stockport extracted `letterboxArgs`, after two geometry bugs in one command hid
 * each other for four months.
 */
function encodeArgs(slidePaths, outputPath, { slide = DEFAULT_SLIDE_SECONDS, transition = DEFAULT_TRANSITION_SECONDS, framerate = FRAMERATE } = {}) {
  const inputs = [];
  for (const p of slidePaths) inputs.push('-loop', '1', '-t', String(slide), '-i', p);

  const steps = [];
  let last = '[0:v]';
  for (let i = 1; i < slidePaths.length; i++) {
    const offset = (i * (slide - transition)).toFixed(3);
    const label = `[x${i}]`;
    steps.push(`${last}[${i}:v]xfade=transition=fade:duration=${transition}:offset=${offset}${label}`);
    last = label;
  }

  // **The range conversion is the last filter, and it is not cosmetic.** A JPEG decodes as
  // FULL-range YUV, so `-pix_fmt yuv420p` alone produces a stream tagged `yuvj420p`:
  // 4:2:0 as asked, but full range. Measured here on 21 Sep 2026 before this line existed.
  // Players that honour the tag are fine and players that ignore it render the video
  // washed out, which is the sort of fault that only shows up on somebody else's phone
  // after the post is public. Limited range is what every social platform expects.
  steps.push(`${last}scale=in_range=full:out_range=tv,format=yuv420p[v]`);

  // Always a filter graph, even for one slide. A single-result week is ordinary in April,
  // and `xfade` with nothing to fade to is an error — so the chain above simply has no
  // xfade in it, and the one code path stays the one that has been exercised.
  const args = ['-y', ...inputs, '-filter_complex', steps.join(';'), '-map', '[v]'];

  args.push(
    '-r', String(framerate),
    '-c:v', 'libx264',
    '-preset', 'veryfast',   // the encode has to fit inside a 60s Cloud Run request
    '-crf', '23',
    // **4:2:0 is not optional.** libx264 defaults to 4:4:4 for a JPEG source, which Meta's
    // transcoder and half the world's players will not decode. It is the single most
    // common reason a locally-perfect mp4 is refused on upload. Belt and braces with the
    // `format` filter above, which is what actually does the conversion.
    '-pix_fmt', 'yuv420p',
    // `+faststart` moves the moov atom to the front. Meta fetches these by URL and starts
    // reading immediately; with the index at the end it has to pull the whole file first.
    '-movflags', '+faststart',
    outputPath);

  return args;
}

function totalDuration(slideCount, slide = DEFAULT_SLIDE_SECONDS, transition = DEFAULT_TRANSITION_SECONDS) {
  if (slideCount <= 0) return 0;
  return slideCount * slide - (slideCount - 1) * transition;
}

/**
 * Render slides and encode them, returning the mp4 as a Buffer.
 *
 * **Temp files go in `os.tmpdir()`, never under `static/`.** Stockport writes its frames
 * and its output into the served tree, which on Cloud Run is a tmpfs belonging to one
 * instance — the same mistake that made every generated social image unfetchable. Nothing
 * here is ever read back over HTTP: the bytes go to S3 and the directory is removed.
 *
 * `cards` is a list of `{ homeTeam, awayTeam, homeScore, awayScore, division }`.
 */
async function renderVideo(cards, { aspect = '4-5', slide = DEFAULT_SLIDE_SECONDS, transition = DEFAULT_TRANSITION_SECONDS, buildCard } = {}) {
  const size = VIDEO_SIZES[aspect];
  if (!size) throw new Error(`Unknown aspect ${aspect}. Known: ${Object.keys(VIDEO_SIZES).join(', ')}`);
  if (!cards.length) throw new Error('No results to put in the video');

  // Required here rather than at the top of the file only so that `buildCard` can be
  // injected without loading the drawing code at all — which is what lets the encode be
  // tested against a stub. There is no cycle to break.
  const draw = buildCard || require('../controllers/social_controller').buildResultCard;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbl-video-'));
  try {
    const slidePaths = [];
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      let card;
      try {
        card = await draw(c, 'jpeg');
      } catch (err) {
        // **Loud, and never a skipped slide.** `buildResultCard` reads
        // `static/images/bg/social-<division>.png` and throws if there isn't one, so a
        // fixture whose home team has no division (the query LEFT JOINs it) asks for
        // `social-null.png` and fails with a bare ENOENT naming a file nobody recognises.
        // Dropping that result instead would publish a results video quietly missing a
        // result, which is the class of silent wrongness this feature has already produced
        // twice on the other site.
        throw new Error(
          `Could not draw the card for ${c.homeTeam} v ${c.awayTeam} ` +
          `(division ${c.division}): ${err.message}`);
      }
      const framed = await letterbox(card, size.width, size.height);
      const p = path.join(dir, `slide-${String(i).padStart(3, '0')}.jpg`);
      await fs.writeFile(p, framed);
      slidePaths.push(p);
    }

    const outputPath = path.join(dir, 'weekly.mp4');
    await execFileAsync('ffmpeg', encodeArgs(slidePaths, outputPath, { slide, transition }),
      { maxBuffer: 8 * 1024 * 1024 });

    return {
      buffer: await fs.readFile(outputPath),
      slides: slidePaths.length,
      seconds: totalDuration(slidePaths.length, slide, transition),
      aspect,
    };
  } finally {
    // `force` so a failed encode that left no output still cleans up, and so cleanup can
    // never mask the real error by throwing on top of it.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run `fn` once at a time, per process.
 *
 * A second caller arriving mid-encode gets the first one's promise rather than starting
 * its own. That is the whole of the concurrency control here, and it is deliberately
 * narrower than Stockport's S3 lock: this cannot leave anything behind, cannot go stale,
 * and cannot wedge the feature. Two *instances* encoding simultaneously is still possible
 * and still harmless — they write identical bytes to the same key.
 */
function singleFlight() {
  let inFlight = null;
  return function (fn) {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(fn).finally(() => { inFlight = null; });
    return inFlight;
  };
}

const SITE = 'https://tameside-badminton.co.uk';
const HASHTAGS = '#badmintonresults #tameside #badminton #tbl #bulutangkis';

/**
 * The captions for the weekly results post.
 *
 * **This lives here rather than in weeklyVideoController because the Instagram caption is
 * fixed when the CONTAINER is created, not when it is published** — `media_publish` takes
 * only `creation_id`. Since the container is now prepared by the generate job at 17:50
 * and published by the post job at 18:00, both halves need the same caption, and putting
 * it in either controller would have made one require the other.
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
  return { facebook: `${line}\n\n${HASHTAGS}`, instagram: `${line}\n\n${HASHTAGS}` };
}

module.exports = {
  VIDEO_SIZES, VIDEO_KEYS, S3_PREFIX,
  DEFAULT_SLIDE_SECONDS, DEFAULT_TRANSITION_SECONDS, FRAMERATE,
  letterboxGeometry, letterbox, encodeArgs, totalDuration, renderVideo, singleFlight,
  captions,
};
