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

WORKDIR /usr/src/app

# Dependencies in their own layer, ahead of the source, so `npm ci` is reused from
# cache on every build that didn't touch package.json / package-lock.json.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
