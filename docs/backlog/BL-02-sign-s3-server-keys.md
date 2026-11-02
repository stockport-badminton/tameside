# BL-02: `/sign-s3` lets the client choose the key

**Size:** about an hour · **Parked:** 30 Oct 2026 ("leave it on the list")

## Why

`/sign-s3` refuses any key that doesn't start with `tameside-` (a17cbe2). But the client
still chooses the key, so any logged-in member can presign a PUT over one of **our**
existing photos. The keys are guessable: `tameside-<season>-<home>-<away>.<ext>`, plus
`-photo.jpg` for an extracted or converted image. The row doesn't change and nobody is
emailed, so it would go unnoticed. Low likelihood, because it needs an approved login and
intent, but real.

## How

- The server appends a random suffix and returns `{ signedUrl, key }`.
- The wizard and the photo-replace panel already derive the URL from `signedUrl`. Only the
  **OCR box** builds its own `key`, and it must read the returned one instead.
- Add `IfNoneMatch: '*'` to the presigned PUT as a backstop against overwriting.
- Find out whether the bucket has versioning. Stockport owns it, so ask. That decides
  whether an overwrite would be recoverable.
- Keep the `tameside-` prefix. It is the ownership test in `utils/scorecardPhoto.js`.

## Done when

- A presign for an existing key is refused, or cannot collide.
- `test/integration/scorecard-photo*.test.js` cover it, and the e2e upload paths still pass.
