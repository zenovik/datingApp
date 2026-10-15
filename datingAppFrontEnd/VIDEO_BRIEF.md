# Hero scroll-scrub video

The landing page hero (`landing.component.html`) is wired up to play a
scroll-scrubbed clip - as the user scrolls past the hero section, the video
scrubs forward frame-by-frame instead of auto-playing (see
`ScrollScrubVideoDirective`). **Nothing is broken without it** - until this
file exists, the `<video>` fails to load and hides itself, falling back to
the existing static `landingBanner.png` background exactly as it looks
today.

## What to drop in, and where

**Path:** `datingAppFrontEnd/src/assets/videos/hero-phone-to-life.mp4`
**Concept:** "Phone screen → real life" (matches the hero copy - "Real
matches, real conversations, real safety")

### 10-second shot brief

1. **0:00–0:03** - Extreme close-up on a smartphone screen showing a
   dating-app match animation (a card swipe / "It's a Match!" moment). Camera
   is locked-off or on a very slow, smooth push.
2. **0:03–0:07** - Camera pulls back and slightly up, as if moving *through*
   the phone screen (parallax zoom-through) - the phone lowers out of frame
   as the shot widens.
3. **0:07–0:10** - Reveal lands on the person's face breaking into a genuine
   smile, then widens a touch further to a warm, sunlit café/street setting -
   ending on a settled, static-ish frame (this last frame is what's visible
   at rest before/after the scroll range, so it should look good as a
   "poster" frame on its own).

### Technical spec (matters for smooth scrubbing, not just looks)

- **Format:** MP4, H.264, no audio track needed (video is always muted).
- **Resolution:** 1280×960 or similar (the hero display area is roughly
  square-ish on the right side of the hero, `object-fit: contain`) - no
  need for anything larger, this isn't shown full-bleed.
- **Frame rate:** 30fps minimum (more keyframes = smoother scrubbing).
- **Keyframe interval:** encode with a *short* keyframe interval (e.g.
  every 5-10 frames, `-g 30` at 30fps is too sparse - try `-g 10`) -
  scrubbing seeks constantly, and sparse keyframes make that seek janky/laggy.
  Example with ffmpeg:
  `ffmpeg -i source.mov -c:v libx264 -g 10 -crf 22 -an -movflags +faststart hero-phone-to-life.mp4`
- **File size:** keep it under ~4-5MB - it's not streamed progressively in
  a scrub-friendly way, `preload="auto"` pulls the whole thing up front.
- **Camera:** locked-off tripod or a single smooth, predictable move (the
  push-back described above). No shake, no handheld - scrubbing exaggerates
  any camera jitter.

### Where to get the clip

- **Stock footage** (Pexels/Storyblocks/Artgrid): search "phone dating app
  notification smile" or shoot the phone-screen half yourself (screen-record
  your own app!) and combine with a stock "person smiling then café scene"
  clip in any video editor.
- **AI video generation** (Runway, Pika, Kling, Sora): paste the shot brief
  above directly as the prompt, generate in 2-3 second segments per beat and
  stitch them, or generate the whole 10s in one prompt if the tool supports it.
- **Your own app's UI**: the first 3 seconds can be a literal screen
  recording of LoveFox's own match screen - cheapest option and most
  on-brand, since it's not stock footage of a fake app.

Once the file lands here as `hero-phone-to-life.mp4`, it works immediately -
no code changes needed.

## If a future clip stutters ("atak rahi hai") on scroll

The clip that shipped first only had **one keyframe for the whole 10
seconds**, which is extremely common from stock/AI video tools (they
optimize for playback, not scrubbing). Every scroll-driven seek then has to
decode from frame 0 forward to reach the target frame - that's what a
stutter/lag while scrubbing almost always is. Re-encode with a short
keyframe interval before dropping a new clip in:

```
ffmpeg -i source.mp4 -c:v libx264 -preset slow -crf 20 \
  -g 6 -keyint_min 6 -sc_threshold 0 \
  -pix_fmt yuv420p -an -movflags +faststart \
  hero-phone-to-life.mp4
```

`-g 6` at 24fps = a keyframe every 0.25s (40 keyframes across 10s instead
of 1) - check with `ffprobe -select_streams v:0 -show_entries
frame=key_frame -of csv=p=0 file.mp4 | grep -c '^1'` if scrubbing ever
feels off again. Also note the hero is now a **pinned scroll section**
(`.hero-scrub-track`/`.hero-scrub-stage`, ~2.5 viewport-heights tall) so
the clip gets a long, deliberate scroll runway instead of finishing within
the old ~650px hero - that's what actually fixed it feeling "stuck"/jumpy,
the keyframe re-encode is what makes each individual seek smooth once it's
scrubbing at all.
