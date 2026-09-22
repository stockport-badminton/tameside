# ffmpeg is roughly half the container image

**Status:** open, raised 22 Sep 2026. Not started. Low urgency, no user impact today.

## The measurement

First local `docker build` of this image (`--platform linux/amd64`, matching production).
Layer sizes, largest first:

| Layer | Size |
|---|---|
| `apt-get install ffmpeg fontconfig` | **463MB** |
| `npm ci --omit=dev` | 221MB |
| `COPY . .` | 26.6MB |
| `COPY fonts/vendor/` (Poppins + Inter) | 1.16MB |
| `fc-cache -f` + the font assertion | 25kB |
| **Total** | **940MB** |

So ffmpeg and its dependencies are about **half the image**, for a feature that runs
**twice a week** — the Monday 17:50 generate job, and a manual regenerate from the admin
page. The vendored fonts, by contrast, are about a thousandth of it.

The Dockerfile comment added when ffmpeg went in said the size was "not measured here;
Docker was not available when this was written". It is measured now, and it is bigger than
that comment implies.

## Why it matters, and how much

It is a **cold-start cost**, not a running cost. Cloud Run pulls the image when it starts a
new instance, and this service runs `minScale 0` — so it scales to zero and pays that pull
on the next visitor after a quiet period. `_MAX_INSTANCES` is 4, so it can be paid four
times over a busy spell.

**It has not been shown to be a problem.** Nobody has reported a slow first page load, and
Cloud Run streams and caches layers, so the effect is not the full 463MB on every start.
Measure before optimising: compare cold-start latency on `/health` before and after any
change, rather than assuming the megabytes translate into seconds.

## What to look at

`ffmpeg` from Debian pulls the entire codec set — every decoder, encoder, muxer and filter,
plus x11, alsa and sdl2 client libraries that a headless server will never open. This
encode needs a very small slice of that: the image demuxer, `libx264`, the `xfade` and
`scale`/`format` filters, and the mp4 muxer.

Options, roughly in order of effort:

1. **`ffmpeg` → a smaller Debian package.** Check whether `libavcodec-extra` is being pulled
   and whether a narrower set (`libavformat`/`libavcodec` + the `ffmpeg` binary only)
   installs materially less. Cheapest thing to try, and might be most of the win.
2. **Copy a static ffmpeg binary in from a builder stage.** A single ~80MB static build in
   place of 463MB of packages. It makes the Dockerfile multi-stage, which
   `CLAUDE.md` currently says is deliberately avoided — that note was written when nothing
   was compiled at image-build time, and this would be the first genuine reason to revisit
   it.
3. **Drop ffmpeg from the web image entirely** and run the weekly encode as a Cloud Run
   *job* with its own image. Cleanest separation — the service that serves pages stops
   carrying a video encoder — but it is a new deployable and a new thing to schedule, which
   is a lot of machinery for two runs a week.

## Do not

- **Do not remove ffmpeg without replacing the encode.** h264 is the one thing in this
  pipeline that genuinely cannot be done in JS; see `utils/socialVideo.js`.
- **Do not reintroduce ImageMagick while trimming.** The slides are drawn with sharp and
  padded in JS on purpose — see `docs/plans/sharp-text-rendering.md`.
- **Do not drop `fontconfig` from that apt line.** It is named explicitly *because* ffmpeg
  happens to pull it in, and the social images resolve their fonts through it. A missing
  font does not error — it renders legible text in the wrong typeface.
