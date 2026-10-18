// Posting to the league's Facebook Page and Instagram account, directly.
//
// This replaces what a Make.com scenario has been doing. Ported from the Stockport league
// site (`~/league-site/utils/metaPublisher.js`), whose behaviour was measured against the
// real Graph API rather than read from documentation — and where the two disagreed, the
// documentation lost. Re-verified against Tameside's own credentials 15 Sep 2026.
//
// ── Four things that are not obvious, and each costs a post if got wrong ──────
//
// 1. **Meta DOCUMENTS Instagram as JPEG-only, and the container step does not enforce it.**
//    The handover this was ported from states the format as the proven cause of the
//    Stockport weekly carousel never working. Re-measured here against v21.0 on
//    15 Sep 2026, and that half does not hold up: a PNG child container, a PNG carousel
//    parent, and a WebP child container were all accepted and all reached
//    `status_code: FINISHED` — "ready to be published".
//
//    So `assertPublishableImage`'s JPEG rule is enforcement of a DOCUMENTED constraint,
//    not of a measured one. It is kept because serving JPEG costs nothing and Meta is
//    entitled to enforce its own documentation at `media_publish` — the one step that
//    cannot be tested without publishing something. It should not be described as the
//    reason that carousel failed. **The measured reason is sufficient on its own: those
//    image URLs 404'd**, because they named files on a container's local disk.
//
//    That is the handover's own rule applied back to it — *a negative observation needs
//    its other causes ruled out; a positive one does not*. "Instagram refused these" is
//    the negative, and the 404 was never ruled out as its cause. "Meta accepted a PNG" is
//    the positive, and stands on its own.
//
// 2. **Meta fetches `image_url` itself, from its own servers, later.** So the URL must be
//    public, unauthenticated and still serving when Meta gets round to it. Anything behind
//    `secured`, and anything written to a container's local disk, cannot work. That is why
//    `/league-table-image/:division` and `/resultImage/...` render on demand.
//
// 3. **Both platforms have a "not yet visible" step, and it is free.** Instagram creates a
//    container (`POST /media`) that shows nowhere until `media_publish`; Facebook uploads
//    with `published=false` and the photo shows nowhere until a feed post attaches it. Both
//    expire on their own in 24 hours. Use them to find out whether Meta will accept an
//    image before anybody can see the answer — `validateImages()` does exactly that.
//
// 4. **A Page access token does not expire.** Measured for Tameside's own token on
//    15 Sep 2026: `debug_token` reports `type: PAGE`, `expires_at: 0`. It dies only if the
//    granting account changes its Facebook password or loses its role on the Page, and when
//    it does, everything here fails at once and needs a person with a browser. Meta reports
//    that as code `190`, and `describeFailure` names the case specifically — surfacing a
//    bare `OAuthException` sends you hunting a code bug that is not there.
//
// ── Two deliberate differences from the Stockport copy ───────────────────────
//
// - **`fetch`, not axios.** This repo has no axios and needs none: Node 22 has fetch built
//   in. Keeping the dependency list short matters more than keeping the two files
//   character-identical.
// - **One token covers both targets.** Stockport pairs its Instagram target with its own
//   page token. Measured here: `META_TAMESIDE_PAGE_TOKEN` reaches both the Tameside Page
//   and the shared Instagram account, and carries `instagram_content_publish`. So Tameside
//   needs one credential, not a split pair.
//
// ── What this file will not do ───────────────────────────────────────────────
//
// **It does not decide whether to post, and it does not swallow failures.** It publishes or
// it reports. The caller is responsible for making sure a social post can never fail the
// write it is reporting — a captain's result is saved before any of this runs.

// `META_GRAPH_ORIGIN` exists so a test can point the publisher at a local stub and assert
// what it does with a partial failure, which is the behaviour that matters most here and
// the one that cannot be exercised against the real API without publishing something.
// Read per call rather than captured at require time, so a test can set it after loading.
const graphOrigin = () => process.env.META_GRAPH_ORIGIN || 'https://graph.facebook.com';
const VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

// Instagram's rules, from Meta's own documentation and confirmed by what it refused.
const JPEG_PATH = /\.jpe?g($|\?)/i;
const IG_MIN_RATIO = 0.8;    // 4:5 portrait
const IG_MAX_RATIO = 1.91;   // landscape
const IG_MAX_CAROUSEL = 10;

const TIMEOUT_MS = 60000;

class MetaError extends Error {
  constructor(message, { status, code, subcode, fbtrace, step } = {}) {
    super(message);
    this.name = 'MetaError';
    Object.assign(this, { status, code, subcode, fbtrace, step });
  }
}

// Meta's errors are JSON in the body, not the HTTP status, and the useful sentence is
// sometimes `error_user_msg` and sometimes `message`. Flattening them here means every
// caller gets one shape, and means a token that has been revoked says so in English.
function describeFailure({ body, status, cause }, step) {
  const e = (body && body.error) || {};
  const detail = e.error_user_msg || e.message || (cause && cause.message) || 'unknown error';

  // 190 is "access token problem", and for a Page token that never expires it means a
  // person did something: changed their password, or lost their role on the Page. No amount
  // of retrying fixes it.
  const revoked = Number(e.code) === 190;
  const message = revoked
    ? `Meta rejected the access token during ${step}. A Page token does not expire on a ` +
      `clock, so this means the granting account changed its password or lost its role on ` +
      `the Page — it needs re-minting by hand. (${detail})`
    : `Meta refused ${step}: ${detail}`;

  return new MetaError(message, {
    status, code: e.code, subcode: e.error_subcode, fbtrace: e.fbtrace_id, step,
  });
}

async function graph(path, params, { method = 'POST', step } = {}) {
  const base = `${graphOrigin()}/${VERSION}/${path.replace(/^\//, '')}`;
  const body = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]));

  let res;
  try {
    res = method === 'GET'
      ? await fetch(`${base}?${body.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      : await fetch(base, {
          method: 'POST',
          body: body.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
  } catch (cause) {
    // A transport failure carries no Meta error body at all, so it has to be described
    // separately or the caller gets "unknown error" for a DNS blip.
    throw describeFailure({ cause }, step || path);
  }

  // `fetch` does not throw on a 4xx, which is the whole reason this branch is explicit.
  const data = await res.json().catch(() => null);
  if (!res.ok) throw describeFailure({ body: data, status: res.status }, step || path);
  return data;
}

/**
 * Refuse an image Instagram will refuse, before Meta does and before anyone sees it.
 *
 * Checked here rather than at the call site because every caller would otherwise have to
 * remember, and the one that forgot is the reason this file exists.
 */
function assertPublishableImage(url, { forInstagram = false } = {}) {
  if (!/^https:\/\//i.test(String(url || ''))) {
    throw new MetaError(
      `Image URL must be absolute https, got ${url || '(empty)'} — Meta fetches it from ` +
      `its own servers, so a relative or local URL can never resolve.`, { step: 'validate' });
  }
  if (forInstagram && !JPEG_PATH.test(url)) {
    throw new MetaError(
      `Meta documents Instagram publishing as JPEG-only and this URL is not one: ${url}. ` +
      `Serve JPEG rather than renaming the file — the extension is how everything upstream ` +
      `tells the two apart, but Meta reads the bytes.`, { step: 'validate' });
  }
}

/** Instagram's aspect-ratio window, for a caller that knows its dimensions. */
function ratioOk(width, height) {
  if (!width || !height) return true;      // unknown is not a failure
  const r = width / height;
  return r >= IG_MIN_RATIO && r <= IG_MAX_RATIO;
}

// ── Facebook Pages ───────────────────────────────────────────────────────────

/**
 * Upload a photo WITHOUT publishing it. Returns the photo id.
 *
 * This is the half that makes an album possible and the half that makes testing safe:
 * nothing is on the page until `publishPageAlbum` attaches it.
 */
async function uploadPagePhoto(pageId, token, imageUrl) {
  assertPublishableImage(imageUrl);
  const r = await graph(`${pageId}/photos`, {
    url: imageUrl, published: 'false', access_token: token,
  }, { step: 'a photo upload' });
  return r.id;
}

/**
 * One post carrying one or more photos.
 *
 * Facebook has no single call for this: each photo is uploaded unpublished, then one feed
 * post attaches them by id. A single photo goes the same way rather than through `/photos`
 * with `published=true`, so there is one code path and one thing to test.
 */
async function publishPageAlbum(pageId, token, { imageUrls, message }) {
  const urls = [].concat(imageUrls || []);
  if (!urls.length) throw new MetaError('No images to post', { step: 'validate' });

  const ids = [];
  for (const url of urls) ids.push(await uploadPagePhoto(pageId, token, url));

  const params = { message: message || '', access_token: token };
  ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });

  const r = await graph(`${pageId}/feed`, params, { step: 'the page post' });
  return { postId: r.id, photoIds: ids };
}

// ── Instagram ────────────────────────────────────────────────────────────────


/**
 * Photos as Facebook Page stories, one frame each, in the order given. Ported from Stockport
 * (league-site b79b221).
 *
 * A story is single-media, so four tables are four frames rather than one album. Same two
 * steps as the album: upload unpublished, then `POST /{page-id}/photo_stories` names the
 * photo — which is the step that publishes.
 *
 * Uploads run in parallel and the publishes in order: each upload is Meta fetching a card we
 * render on demand, and sequential fetches would eat the 60s request budget the weekly tables
 * post already spends most of. Publishing in order keeps the frames in division order.
 *
 * Fresh uploads, not the album's photo ids: once a feed post has attached a photo it is
 * published, and whether `photo_stories` takes one in that state is unmeasured.
 */
async function publishPageStories(pageId, token, { imageUrls }) {
  const urls = [].concat(imageUrls || []);
  if (!urls.length) throw new MetaError('No images to post as a story', { step: 'validate' });

  const photoIds = await Promise.all(urls.map((url) => uploadPagePhoto(pageId, token, url)));
  const postIds = [];
  for (const photoId of photoIds) {
    const r = await graph(`${pageId}/photo_stories`, { photo_id: photoId, access_token: token },
      { step: 'the page story' });
    postIds.push(r.post_id || r.id);
  }
  return { postIds, photoIds };
}

/**
 * Create a media container. Nothing is visible until it is published, and an unpublished
 * container expires by itself in 24 hours — so this is the free way to ask Meta whether it
 * will accept an image.
 */
async function createContainer(igUserId, token, params) {
  const r = await graph(`${igUserId}/media`, { ...params, access_token: token },
    { step: 'an Instagram media container' });
  return r.id;
}

async function publishContainer(igUserId, token, creationId) {
  const r = await graph(`${igUserId}/media_publish`, { creation_id: creationId, access_token: token },
    { step: 'the Instagram publish' });
  return r.id;
}

/** One image. Two calls: container, then publish. */
async function publishInstagramPhoto(igUserId, token, { imageUrl, caption }) {
  assertPublishableImage(imageUrl, { forInstagram: true });
  const creationId = await createContainer(igUserId, token, {
    image_url: imageUrl, caption: caption || '',
  });
  return { mediaId: await publishContainer(igUserId, token, creationId), creationId };
}

/**
 * One image as an Instagram Story: the same container flow, with `media_type=STORIES`.
 * Ported from Stockport (league-site ed74712), whose container dry-run on their Page token
 * needed no new permission or use case.
 *
 * No caption, because a story does not show one — everything it says is in the pixels,
 * which is why it has its own card layout (social_controller's STORY). A published story
 * reads back as `media_type` IMAGE; only `media_product_type` says STORY, which matters to
 * anything that de-duplicates against our own history.
 */
async function publishInstagramStory(igUserId, token, { imageUrl }) {
  assertPublishableImage(imageUrl, { forInstagram: true });
  const creationId = await createContainer(igUserId, token, {
    media_type: 'STORIES', image_url: imageUrl,
  });
  return { mediaId: await publishContainer(igUserId, token, creationId), creationId };
}

/**
 * Up to ten images as one carousel, which counts as ONE post against the publishing quota.
 *
 * Each child is its own container with `is_carousel_item`, then a parent container names
 * them, then the parent is published.
 */
async function publishInstagramCarousel(igUserId, token, { imageUrls, caption }) {
  const urls = [].concat(imageUrls || []);
  if (!urls.length) throw new MetaError('No images to post', { step: 'validate' });
  if (urls.length > IG_MAX_CAROUSEL) {
    throw new MetaError(
      `Instagram carousels take at most ${IG_MAX_CAROUSEL} images, got ${urls.length}. ` +
      `Meta refuses the parent container rather than truncating, so decide here which ones ` +
      `to drop.`, { step: 'validate' });
  }
  urls.forEach(u => assertPublishableImage(u, { forInstagram: true }));

  const children = [];
  for (const url of urls) {
    children.push(await createContainer(igUserId, token, {
      image_url: url, is_carousel_item: 'true',
    }));
  }
  const parent = await createContainer(igUserId, token, {
    media_type: 'CAROUSEL', children: children.join(','), caption: caption || '',
  });
  return { mediaId: await publishContainer(igUserId, token, parent), childIds: children };
}

/**
 * Ask Meta whether it would accept these images, without publishing anything.
 *
 * Returns `{ok, refused: [{url, reason}]}`. Containers created here are simply abandoned
 * and expire in 24 hours. Worth running before a scheduled post that nobody is watching —
 * which is exactly where a silent refusal hides.
 *
 * **What it does and does not prove.** It catches the faults that actually recur: a URL
 * that 404s, one that is not public, one behind `secured`, a host that cannot be reached
 * from Meta's servers. It does **not** check the image format — measured 15 Sep 2026, the
 * container step accepted PNG and WebP alike and reported both FINISHED. The local
 * `assertPublishableImage` call below is the only format check in this function, and it
 * only reads the URL.
 *
 * So `ok: true` means "Meta could fetch these", not "Instagram will publish these". Saying
 * otherwise would make this another rejection that looks like an acceptance, which is the
 * shape this codebase keeps getting caught by.
 */
async function validateImages(igUserId, token, imageUrls) {
  const refused = [];
  for (const url of [].concat(imageUrls || [])) {
    try {
      assertPublishableImage(url, { forInstagram: true });
      await createContainer(igUserId, token, { image_url: url, is_carousel_item: 'true' });
    } catch (err) {
      refused.push({ url, reason: err.message });
    }
  }
  return { ok: refused.length === 0, refused };
}

// ── Video ────────────────────────────────────────────────────────────────────
//
// **Video is not photo-with-a-different-field**, and that is why these are separate
// functions rather than a flag on the ones above. A photo container is usable the moment
// it is created; a video container is not — Meta fetches the file, transcodes it, and only
// then is it publishable. Publishing early fails with a container-not-ready error, so the
// status has to be polled.
//
// Measured on the Stockport side 20 Sep 2026: a ~13s 1080-wide mp4 reaches FINISHED within
// a few seconds, and Instagram Reels accepts 16:9, 1:1 and 4:5 alike, with a silent audio
// track. Their three stated worries — that Reels demands 9:16, that a missing audio track
// is a problem, and that bars-inside-bars would be refused — were all wrong.
//
// **What Meta accepts and what looks good are different questions, and only the first is
// answerable from an API.** `FINISHED` means it will publish, not that it reads well.

// The poll is tuned to THIS service's 60-second Cloud Run request timeout, which is the
// one place Tameside's constraints differ from Stockport's (they run the 600s default).
// Their 180s would be cut off mid-publish by the platform, which is the one failure that
// could double-post on a retry.
//
// **45s, raised from 40s on the first real measurement.** The Stockport handover says a
// ~13s 1080-wide mp4 reaches FINISHED "within a few seconds", and 40s was set from that.
// Measured here 21 Sep 2026 against Tameside's own account: a **5.4-second** video took
// **27.6s** end to end to reach FINISHED — a third of the way to the old ceiling for a
// video a quarter the length. Meta's transcode queue is evidently variable, and a
// nine-fixture week is several times longer than this one.
//
// 45s is what fits: `configuredTargets()` puts the **Facebook page first and Instagram
// second**, and the Facebook video is a single unpolled call, so the budget is roughly
// 60s minus a few seconds of Facebook and overhead. That ordering is also why a transcode
// timeout is survivable — Facebook has already posted, `publishVideoEverywhere` collects
// per-target outcomes, and the route answers 207 rather than losing the half that worked.
const VIDEO_POLL_MS = 2500;
const VIDEO_TIMEOUT_MS = 45000;

// How long the POST will wait on a container an earlier job already created. Short,
// because ten minutes have already passed: if it is not ready by now, another 45 seconds
// inside a request that has a Facebook post riding on it will not help.
const PREPARED_READY_TIMEOUT_MS = 20000;

/**
 * The video URL rule, which is weaker than the image one and deliberately so.
 *
 * Absolute https and nothing else. There is no `.mp4` requirement to match
 * `assertPublishableImage`'s `.jpg`: that exists because Instagram documents JPEG-only for
 * photos and a self-describing URL lets the guard stay strict. Meta documents no such
 * thing for a fetched video, so a rule about the extension would be invented rather than
 * enforced — and `socialVideoPath()` produces an extensionless URL by design.
 */
function assertPublishableVideo(url) {
  if (!/^https:\/\//i.test(String(url || ''))) {
    throw new MetaError(
      `Video URL must be absolute https, got ${url || '(empty)'} — Meta fetches it from ` +
      `its own servers, so a relative or local URL can never resolve.`, { step: 'validate' });
  }
}

/**
 * Wait for a video container to finish transcoding.
 *
 * Returns the container id, or throws with what Meta said. An `ERROR` status carries a
 * `status` string that is the only description of what was wrong with the file, so it is
 * passed through rather than flattened to "failed".
 */
async function waitForContainer(containerId, token, { pollMs = VIDEO_POLL_MS, timeoutMs = VIDEO_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'IN_PROGRESS';
  let first = true;

  while (Date.now() < deadline) {
    // **Check before sleeping.** The original slept first, which cost a full poll interval
    // even for a container that finished transcoding ten minutes ago — and that is now the
    // normal case, because the container is created by an earlier job. A ready container
    // should cost one fast call.
    if (!first) await new Promise(r => setTimeout(r, pollMs));
    first = false;
    const r = await graph(containerId, { fields: 'status_code,status', access_token: token },
      { method: 'GET', step: 'checking a video container' });
    last = r.status_code;
    if (last === 'FINISHED') return containerId;
    if (last === 'ERROR') {
      throw new MetaError(`Meta could not process the video: ${r.status || 'no detail given'}`,
        { step: 'transcoding a video' });
    }
  }
  throw new MetaError(
    `Meta was still transcoding the video after ${Math.round(timeoutMs / 1000)}s (last status ${last}). ` +
    `Nothing was published.`, { step: 'transcoding a video' });
}

/**
 * Create a Reels container and wait for Meta to finish transcoding it, WITHOUT publishing.
 *
 * This is the expensive half of posting a video, and separating it is the whole point:
 * measured 21 Sep 2026 on the first real run, a post of a 5.4-second video took **45.2s
 * of a 60s Cloud Run request budget**, and the same video's transcode had taken 27.4s an
 * hour earlier. Meta's queue swings by ~18s on identical input, so the length of the video
 * is not even the main variable.
 *
 * A container stays publishable for **24 hours**, so the wait can be paid in an earlier
 * scheduled job and the actual post reduced to one fast call. Same trick as splitting
 * generate from post.
 *
 * **The caption is fixed here, not at publish time.** `media_publish` takes only
 * `creation_id` — there is nowhere to put a caption later. That is why `captions()` had to
 * move somewhere both halves can reach.
 */
async function prepareInstagramReel(igUserId, token, { videoUrl, caption, wait = true } = {}) {
  assertPublishableVideo(videoUrl);
  const containerId = await createContainer(igUserId, token, {
    media_type: 'REELS', video_url: videoUrl, caption: caption || '',
  });
  // **`wait: false` is what the generate job uses, and it is not an optimisation — it is
  // the difference between fitting in the request budget and not.** Rendering nine slides
  // is ~24s and the transcode is 27-45s; waiting for both in one request is ~69s against a
  // 60s ceiling. Creating the container is one fast call, and the ten minutes before the
  // post job runs is fifteen to twenty times longer than any transcode measured here. The
  // post checks the status before publishing, so nothing is published unverified.
  if (wait) await waitForContainer(containerId, token);
  return { containerId };
}

/**
 * Instagram, in one call. Video on Instagram is REELS — the old feed VIDEO type is gone.
 *
 * Kept as the fallback path for when no container was prepared, so a failure in the
 * preparation step costs Instagram a slow post rather than no post at all.
 */
async function publishInstagramReel(igUserId, token, { videoUrl, caption }) {
  const { containerId } = await prepareInstagramReel(igUserId, token, { videoUrl, caption });
  return { mediaId: await publishContainer(igUserId, token, containerId), containerId };
}

/**
 * Facebook. `file_url` is fetched by Meta, like an image — but unlike the photo path there
 * is no album step, so one call posts it.
 */
async function publishPageVideo(pageId, token, { videoUrl, description }) {
  assertPublishableVideo(videoUrl);
  const r = await graph(`${pageId}/videos`, {
    file_url: videoUrl, description: description || '', access_token: token,
  }, { step: 'a Facebook page video' });
  return { postId: r.id };
}

// The video story's upload step: Meta fetching our file, inside the weekly-video post's
// request. Well under the platform's 60s, so a slow fetch fails this target alone (a 207 with
// the feed posts intact) rather than the whole request being cut off mid-publish.
const VIDEO_STORY_UPLOAD_TIMEOUT_MS = 25000;

/**
 * A video as a Facebook Page story. Unlike `/videos` there is no `file_url` on the story
 * endpoint itself: `start` hands back an upload URL on rupload.facebook.com, that URL is given
 * our `file_url` to fetch, and `finish` publishes. Ported from Stockport (b79b221), with
 * `fetch` for their axios — this repo has neither and needs neither — and that fetch, like
 * every other here, checks the status itself because fetch does not throw on a 4xx.
 */
async function publishPageVideoStory(pageId, token, { videoUrl }) {
  assertPublishableVideo(videoUrl);
  const start = await graph(`${pageId}/video_stories`, { upload_phase: 'start', access_token: token },
    { step: 'starting a page video story' });

  let res;
  try {
    res = await fetch(start.upload_url, {
      method: 'POST',
      headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
      signal: AbortSignal.timeout(VIDEO_STORY_UPLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    throw describeFailure({ cause }, 'uploading a page video story');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw describeFailure({ body, status: res.status }, 'uploading a page video story');
  }

  const r = await graph(`${pageId}/video_stories`, {
    upload_phase: 'finish', video_id: start.video_id, access_token: token,
  }, { step: 'publishing a page video story' });
  return { postId: r.post_id || r.id || start.video_id };
}

/**
 * The dry run: ask Meta to fetch and transcode, and publish nothing.
 *
 * A container expires on its own in 24 hours, so this costs nothing and leaves nothing
 * behind. Same caveat as `validateImages`: **`ok: true` means "Meta could fetch and
 * transcode this", not "this is a good video"** — it catches a 404, a private URL, a host
 * Meta cannot reach, and a file it cannot decode.
 */
async function validateVideo(igUserId, token, videoUrl) {
  try {
    assertPublishableVideo(videoUrl);
    const containerId = await createContainer(igUserId, token, {
      media_type: 'REELS', video_url: videoUrl, caption: '',
    });
    await waitForContainer(containerId, token);
    return { ok: true, refused: [] };
  } catch (err) {
    return { ok: false, refused: [{ url: videoUrl, reason: err.message }] };
  }
}

/**
 * Same contract as publishEverywhere — per-target outcomes, never a bare throw.
 *
 * `preparedContainerId`, when given, is a Reels container that an earlier job already had
 * Meta fetch and transcode, so Instagram costs one fast call instead of a poll. Without
 * one it falls back to doing the whole thing inline, which is what it did before and is
 * strictly better than skipping Instagram.
 *
 * **Facebook is first in `configuredTargets()` and that ordering is load-bearing.** It is
 * a single unpolled call, so even in the fallback case a slow transcode degrades to a 207
 * with Facebook posted rather than losing everything to the request timeout.
 */
async function publishVideoEverywhere(targetList, { videoUrl, message, caption, preparedContainerId } = {}) {
  const posted = [];
  const failed = [];

  for (const t of (targetList || []).filter(Boolean)) {
    // Timed per target, as in publishEverywhere: this runs under the same 60s request cut.
    const started = Date.now();
    const before = failed.length;
    try {
      if (t.kind === 'page') {
        const r = await publishPageVideo(t.id, t.token, { videoUrl, description: message });
        posted.push({ target: t.name, kind: t.kind, id: r.postId });
      } else if (t.kind === 'page-story') {
        const r = await publishPageVideoStory(t.id, t.token, { videoUrl });
        posted.push({ target: t.name, kind: t.kind, id: r.postId });
      } else if (t.kind === 'instagram') {
        let mediaId;
        if (preparedContainerId) {
          // Confirm FINISHED before publishing. Normally one fast call, because the
          // container was created minutes ago — but publishing a container that is still
          // transcoding fails with a not-ready error, and this turns that into a short
          // wait instead. The budget is small on purpose: if it is not ready after ten
          // minutes, waiting another 45s in the request will not save it.
          await waitForContainer(preparedContainerId, t.token, { timeoutMs: PREPARED_READY_TIMEOUT_MS });
          mediaId = await publishContainer(t.id, t.token, preparedContainerId);
        } else {
          mediaId = (await publishInstagramReel(t.id, t.token, { videoUrl, caption: caption ?? message })).mediaId;
        }
        posted.push({
          target: t.name, kind: t.kind, id: mediaId,
          prepared: Boolean(preparedContainerId),
        });
      } else {
        failed.push({ target: t.name, error: new MetaError(`Unknown target kind ${t.kind}`, { step: 'validate' }) });
      }
    } catch (err) {
      failed.push({ target: t.name, error: err });
    }
    console.log(`[timing] meta: ${t.name} ${Date.now() - started}ms ${failed.length > before ? 'failed' : 'ok'}`);
  }

  return { posted, failed, ok: failed.length === 0 };
}

/** How much of Instagram's 100-posts-per-rolling-24-hours is spent. A carousel counts as 1. */
async function publishingQuota(igUserId, token) {
  const r = await graph(`${igUserId}/content_publishing_limit`,
    { fields: 'config,quota_usage', access_token: token },
    { method: 'GET', step: 'the publishing quota' });
  const d = (r.data && r.data[0]) || {};
  return { used: Number(d.quota_usage) || 0, total: Number((d.config || {}).quota_total) || 100 };
}

// ── The league's own accounts ────────────────────────────────────────────────

/**
 * Targets from the environment, or null when the credential is absent.
 *
 * Null rather than a throw, and rather than a default: an unset token must mean "this
 * league does not post" and not "post somewhere else". Same reasoning as the scheduler
 * tokens elsewhere in this repo — absence closes the path rather than opening it.
 *
 * **Both entries use the same token.** Measured 15 Sep 2026: `META_TAMESIDE_PAGE_TOKEN`
 * resolves the Tameside Page and the Instagram account, and its scopes include
 * `instagram_content_publish`.
 *
 * **`META_IG_USER_ID` is Tameside's OWN account as of 15 Sep 2026** — `tameside.badminton`
 * (`17841424897459443`), linked to the Tameside Page in Business Manager. The handover this
 * was ported from states as a hard constraint that Meta refused a second Instagram account
 * and that both leagues must share `stockport.badders.results`; that is no longer true, and
 * it was the premise under most of the cutover sequencing. The existing Page token reaches
 * the new account with no re-minting — verified the same day.
 *
 * Leaving it unset is still supported, and is the one-variable way to post to Facebook only.
 */
function targets() {
  const token = process.env.META_TAMESIDE_PAGE_TOKEN;
  const pageId = process.env.META_TAMESIDE_PAGE_ID;
  const igId = process.env.META_IG_USER_ID;
  return {
    page: pageId && token ? { id: pageId, token } : null,
    instagram: igId && token ? { id: igId, token } : null,
  };
}

/**
 * The Tameside Page's story target, or null unless SOCIAL_POST_FB_STORY is 'true' and the
 * Page is configured. Every Facebook post — the result, the weekly tables, fixtures and
 * video — also goes out as a Page story when it is set, because all four read their targets
 * from configuredTargets() below. Ported from Stockport (b79b221).
 *
 * Off unless set: nothing has been published through `photo_stories` / `video_stories` on
 * either site yet, so the first post after switching it on is the measurement.
 */
function pageStoryTarget(t = targets()) {
  if (process.env.SOCIAL_POST_FB_STORY !== 'true' || !t.page) return null;
  return { ...t.page, name: 'Tameside page story', kind: 'page-story' };
}

/**
 * The `targets()` map as the list `publishEverywhere` takes, named for a log line.
 *
 * **The order is load-bearing**: the feed posts first, the story LAST. The posts run in this
 * order inside one request with a 60s ceiling, so anything slow should be the thing whose
 * loss matters least — a 207 with the feed posted, never a feed post lost to a story.
 */
function configuredTargets() {
  const t = targets();
  return [
    t.page && { ...t.page, name: 'Tameside page', kind: 'page' },
    t.instagram && { ...t.instagram, name: 'Instagram', kind: 'instagram' },
    pageStoryTarget(t),
  ].filter(Boolean);
}

/**
 * Post the same thing to several places, and let each succeed or fail on its own.
 *
 * Returns `{posted, failed, ok}` and does NOT throw. Two reasons, and the first is the one
 * that matters:
 *
 * - **A post that lands on Facebook and not Instagram has still landed on Facebook.**
 *   Throwing on the first failure would either lose that, or — worse — make a retry
 *   double-post to the platform that already worked.
 * - **And then say which of the two happened.** Reporting only success makes a half failure
 *   indistinguishable from a whole one.
 *
 * A null entry is skipped rather than being an error: that is how an unset credential means
 * "this league does not post there" instead of "crash".
 */
async function publishEverywhere(targetList, { imageUrls, message, caption, storyImageUrl }) {
  const posted = [];
  const failed = [];

  for (const t of (targetList || []).filter(Boolean)) {
    // Targets run in sequence, so each one's time adds to the caller's — and a published
    // result waits on all of them inside the request (Stockport's HARD-47 measured 16-51s
    // against Firebase's 60s cut). Logged rather than returned so no caller's contract
    // changes. Grep Cloud Logging for `[timing]`.
    const started = Date.now();
    const before = failed.length;
    try {
      if (t.kind === 'page') {
        const r = await publishPageAlbum(t.id, t.token, { imageUrls, message });
        posted.push({ target: t.name, kind: t.kind, id: r.postId });
      } else if (t.kind === 'page-story') {
        // The result's 9:16 story card when there is one; otherwise every image, one frame
        // each (the weekly tables and fixtures cards, in division order).
        const r = await publishPageStories(t.id, t.token, { imageUrls: storyImageUrl || imageUrls });
        posted.push({ target: t.name, kind: t.kind, id: r.postIds.join(',') });
      } else if (t.kind === 'instagram') {
        const urls = [].concat(imageUrls || []);
        const r = urls.length > 1
          ? await publishInstagramCarousel(t.id, t.token, { imageUrls: urls, caption: caption ?? message })
          : await publishInstagramPhoto(t.id, t.token, { imageUrl: urls[0], caption: caption ?? message });
        posted.push({ target: t.name, kind: t.kind, id: r.mediaId });
      } else if (t.kind === 'instagram-story') {
        // Its own target, so a story that fails beside a feed post that worked is reported
        // as exactly that, rather than folded into "Instagram: ok".
        if (!storyImageUrl) throw new MetaError('No story image supplied for the story target', { step: 'validate' });
        const r = await publishInstagramStory(t.id, t.token, { imageUrl: storyImageUrl });
        posted.push({ target: t.name, kind: t.kind, id: r.mediaId });
      } else {
        failed.push({ target: t.name, error: new MetaError(`Unknown target kind ${t.kind}`, { step: 'validate' }) });
      }
    } catch (err) {
      failed.push({ target: t.name, error: err });
    }
    console.log(`[timing] meta: ${t.name} ${Date.now() - started}ms ${failed.length > before ? 'failed' : 'ok'}`);
  }

  return { posted, failed, ok: failed.length === 0 };
}

module.exports = {
  MetaError,
  assertPublishableImage, assertPublishableVideo, ratioOk,
  uploadPagePhoto, publishPageAlbum, publishPageStories, publishPageVideoStory,
  publishInstagramPhoto, publishInstagramCarousel, publishInstagramStory,
  publishInstagramReel, prepareInstagramReel, publishPageVideo, waitForContainer,
  createContainer, publishContainer,
  validateImages, validateVideo, publishingQuota,
  publishEverywhere, publishVideoEverywhere,
  targets, configuredTargets, pageStoryTarget,
  IG_MAX_CAROUSEL, IG_MIN_RATIO, IG_MAX_RATIO,
  VIDEO_POLL_MS, VIDEO_TIMEOUT_MS, PREPARED_READY_TIMEOUT_MS,
};
