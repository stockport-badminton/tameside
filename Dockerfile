# Single stage on purpose: nothing in this project is compiled at image-build time.
# sharp ships prebuilt binaries (@img/sharp-linux-x64 is pinned in package-lock.json)
# and jimp is pure JS, so there is no gyp/build-essential/python3 step to isolate —
# a builder stage would only add two slow `COPY --from` passes over node_modules.
#
# No font packages either: the only text rendering is jimp's bitmap `.fnt` files in
# fonts/ (see controllers/social_controller.js), which need no fontconfig or freetype.
# sharp is used purely for pixel ops in utils/scorecardVision.js — no SVG text.
FROM node:22-slim

# Enables Express view caching, and hard-disables the DEV_MODE auth bypass in
# middleware/devMode.js regardless of how the service env is configured.
ENV NODE_ENV=production

# ffmpeg, for the weekly results video (utils/socialVideo.js) and nothing else.
#
# **This is the only system package in the image, and it is the largest thing in it** —
# ffmpeg and its codec dependencies are a substantial fraction of the image (not measured
# here; Docker was not available when this was written, so check `docker images` after the
# first build if it matters). It buys the one thing that genuinely cannot be done in JS:
# encoding h264. Everything else about the video is Jimp, which is why there is no
# ImageMagick here even though the Stockport site's equivalent needs both — it builds
# every frame with `convert`, where this crossfades in one `xfade` pass.
#
# Own layer, above `COPY package*.json`, so it is cached and a source-only deploy never
# pays for it. Keep it above the npm layer for that reason — moving it below would make
# every dependency change reinstall it.
#
# `--no-install-recommends` matters: without it apt pulls in x11, alsa and a documentation
# tree that nothing on a headless server will ever open.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Dependencies in their own layer, ahead of the source, so `npm ci` is reused from
# cache on every build that didn't touch package.json / package-lock.json.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Compile bootstrap/style.scss -> static/css/style.css. The generated file is not in
# git (and is excluded from the build context by .dockerignore), so the SCSS source is
# the single source of truth and every image gets a deterministic, current build of it.
# Takes ~2s. If this fails the build fails loudly, which beats shipping an image whose
# CSS silently differs from its source.
RUN npm run build:css

EXPOSE 8080

CMD ["node", "server.js"]
