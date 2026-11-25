# The walkthrough video

`static/video/notifications-mobile.{mp4,jpg}`: "how to turn on notifications", phone cut only
(1080×1920, about a minute). Opened by any `[data-notifications-video]` link through
`views/notifications-video.ejs`: the banner on the fixtures & results pages
(`views/notifications-banner.ejs`) and `/notifications`.

Ported from Stockport's kit (league-site `tools/demo-video/`, `4d6cf0d`). `overlay.js` is
theirs, with the title-card colour and the notification's app name made settable.
Stockport's other recorder, "how to enter a result", is not ported: it needs a seeded
database with fictional players, and we have no local database yet (backlog BL-06).

```sh
node tools/demo-video/record-notifications.js      # DEMO_TEAM='Hyde A', DEMO_PORT=8196
```

It starts its own local server, records, encodes with ffmpeg and writes the published files
straight into `static/video/`. About a minute and a half. **Watch the result before
committing it.** Working files go to `tools/demo-video/generated/` (gitignored).

## What is real and what is not

- **Real:** the homepage, the menu, `/notifications` with the real clubs and teams, and the
  three notifications' wording. That wording is built by `utils/push/notifications.js` from
  the team's real next fixture and its latest win. Team names are public already, and these
  pages name no player.
- **Stubbed:** headless Chromium has no push service, so `PushManager.subscribe` returns a
  fake subscription and `/api/push/*` is answered in the browser. The "Allow notifications?"
  prompt and the arriving notifications are drawn by `overlay.js` (`prompt`, `notify`),
  because a headless browser draws no browser or phone UI. iPhone's "Add to Home Screen" step
  is a title card for the same reason.

## It reads production, and writes nothing

There is no local database (BL-06), so the server reads the production one, as the e2e suite
does. The recorder makes that safe in three ways:

- **No `DEV_MODE`:** the server runs anonymously. That also keeps the superadmin's Admin menu
  out of the shot.
- **`VAPID_PRIVATE_KEY` blanked:** the server cannot send a notification, even if asked.
- **`/api/push/*` is routed in the browser**, so no subscription reaches the server.

The only requests that reach the server are page and asset GETs, plus the service worker's
precache of public pages.

## Traps

- **The service worker must install, or the page says "doesn't support notifications".**
  Locally that needs `SW_ENABLE=true`, which the recorder sets, and it waits for
  `navigator.serviceWorker.ready` before starting. Stockport's version needed a stand-in for a
  precached file their local server 404s; ours precaches nothing that is missing locally.
- **The title-card colour is `window.__dmCardBg`, not a CSS variable.** A variable set on
  `<html>` never reached the card. The first two takes came out Stockport purple.
- **Playwright's `recordVideo` is CSS-pixel resolution**, and so is Chrome's screencast,
  whatever `deviceScaleFactor` says. Only `--force-device-scale-factor` at launch, with
  `channel: 'chromium'` (new headless), gives sharp frames. So the recorder captures the
  screencast itself and builds a constant-frame-rate video with ffmpeg.
- **The service worker leaves Range requests alone** (`views/sw.ejs`), so the video streams
  from the network rather than through the cache-first `/static` handler. `cache.put` refuses
  a 206, and Safari's player is unreliable through a worker.

Re-record when `/notifications` or the menu changes enough that the video lies, or when the
reminder times change (they are in a caption).
