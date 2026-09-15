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
 * **`META_IG_USER_ID` names an account the two leagues SHARE.** Meta refused a second
 * Instagram account when Tameside's was set up, so both sites post to
 * `stockport.badders.results`. Leaving it unset is therefore a supported configuration and
 * the one-variable way to keep Tameside off Instagram entirely.
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

/** The `targets()` map as the list `publishEverywhere` takes, named for a log line. */
function configuredTargets() {
  const t = targets();
  return [
    t.page && { ...t.page, name: 'Tameside page', kind: 'page' },
    t.instagram && { ...t.instagram, name: 'Instagram', kind: 'instagram' },
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
async function publishEverywhere(targetList, { imageUrls, message, caption }) {
  const posted = [];
  const failed = [];

  for (const t of (targetList || []).filter(Boolean)) {
    try {
      if (t.kind === 'page') {
        const r = await publishPageAlbum(t.id, t.token, { imageUrls, message });
        posted.push({ target: t.name, kind: t.kind, id: r.postId });
      } else if (t.kind === 'instagram') {
        const urls = [].concat(imageUrls || []);
        const r = urls.length > 1
          ? await publishInstagramCarousel(t.id, t.token, { imageUrls: urls, caption: caption ?? message })
          : await publishInstagramPhoto(t.id, t.token, { imageUrl: urls[0], caption: caption ?? message });
        posted.push({ target: t.name, kind: t.kind, id: r.mediaId });
      } else {
        failed.push({ target: t.name, error: new MetaError(`Unknown target kind ${t.kind}`, { step: 'validate' }) });
      }
    } catch (err) {
      failed.push({ target: t.name, error: err });
    }
  }

  return { posted, failed, ok: failed.length === 0 };
}

module.exports = {
  MetaError,
  assertPublishableImage, ratioOk,
  uploadPagePhoto, publishPageAlbum,
  publishInstagramPhoto, publishInstagramCarousel,
  createContainer, publishContainer,
  validateImages, publishingQuota, publishEverywhere,
  targets, configuredTargets,
  IG_MAX_CAROUSEL, IG_MIN_RATIO, IG_MAX_RATIO,
};
