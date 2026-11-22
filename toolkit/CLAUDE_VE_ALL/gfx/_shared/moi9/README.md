# Moi Phone portrait kit (moi9)

Design kit for Moi Phone YouTube Shorts graphics (9:16, layout 1080x1920, rendered at 2x with `--resolution portrait-4k`).
It is the portrait sibling of `_shared/moi/` (landscape); do not edit that folder, and do not copy its fonts.
The reference graphic is `Moi Phone/7064 How to Set up Apple Pay in India - Apple Pay Now in India/CLAUDE_VE/gfx_src/ref_title/index.html`; copy its structure.
The keyword pop-up template is `CLAUDE_VE_ALL/gfx/templates/moi_hit9/index.html`.

## Look

- Ink `#0d1117` background, paper `#f5f1e8` text, green `#3be37a` accent, amber `#ffb547` second accent, muted `#a7b0ba` for secondary text.
- `--red` `#ff6b6b` exists only for "no / not yet" marks (the `cross` and `upi-off` icons).
- Mukta 600-800 for Devanagari and Latin, big and bold.
- All of these are CSS variables in `mp9.css` (`var(--green)` etc.) and JS constants in `MP9.C` (`MP9.C.green` etc.).

## Safe zones (YouTube Shorts UI)

- The bottom ~22% (y > 1500) is covered by the title, channel name and progress bar.
- The right edge in the lower half (x > 930, y > 1000) is covered by the like / comment / share column.
- The top strip (y < 160) carries the search and menu icons.
- Keep key text inside x 70-1010, y 160-1450, and left of x 930 below y 1000.
- Decoration (background, ring, glow, dots, the bleed of a phone or card) may go anywhere.
- A camera push grows edge content; with `MP9.push(..., 1, 1.035)` author text a little inside the safe box.

## File skeleton

Each graphic folder needs the `shared` symlink (from inside `<CHANNEL>/<VIDEO>/CLAUDE_VE/gfx_src/<name>/`: `ln -sfn ../../../../../CLAUDE_VE_ALL/gfx/_shared shared`, five levels).

```html
<!doctype html>
<html lang="hi" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <script src="shared/js/gsap.min.js"></script>
    <script src="shared/moi9/mp9.js"></script>
    <link rel="stylesheet" href="shared/moi9/mp9.css" />
    <style>/* per-graphic layout */</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="4" data-width="1080" data-height="1920">
      <div id="cam" class="m9-cam"> ...static markup... <div id="stage"></div></div>
    </div>
    <script>
      const D = 4;
      const tl = gsap.timeline({ paused: true });
      MP9.ready().then(function () {
        MP9.bg(tl, document.getElementById("root"), D, { seed: 3 });
        // build JS elements, then tweens
        MP9.push(tl, document.getElementById("cam"), D, 1, 1.035);
        window.__timelines["main"] = tl;
      });
    </script>
  </body>
</html>
```

`data-duration` on the root must equal `D`; full-screen graphics are opaque because `MP9.bg` paints the ink background.
Overlays on the host shot (pop-ups) skip `MP9.bg` and stay transparent.

## Helpers (global `MP9`)

### MP9.ready()

`MP9.ready().then(build)` loads Mukta 400/600/700/800 explicitly and then waits for `document.fonts.ready`.
Use it instead of `document.fonts.ready`, which can resolve before a weight that is only used by JS-built text has loaded, so `fit` would measure the fallback font.

### MP9.bg(tl, host, dur, opts)

Inserts the portrait ink background as the first child of `host` and animates it for `dur` seconds: a drifting green glow, a big ring outline with a green arc sweeping round it, and slow-rising dots that never leave the frame.
Options: `{ seed: 7, ring: true, ringX: 860, ringY: 1480, ringR: 560, glowX: 540, glowY: 820, dots: 14, arcSpeed: 60 }` (arc speed in degrees per second).
Vary `seed` and the ring position per graphic so consecutive cards do not look identical, for example `MP9.bg(tl, root, D, { seed: 11, ringX: 180, ringY: 1500 })`.
Pass the `#root` (not the camera wrapper) as `host` so the background does not take part in the push-in.

### MP9.push(tl, el, dur, from, to)

A linear scale push on a camera wrapper (`class="m9-cam"`) over the whole duration, default 1 to 1.04.
Example: `MP9.push(tl, document.getElementById("cam"), D, 1, 1.035)`.

### MP9.fit(el, maxW, maxH, minPx)

Shrinks `el`'s font-size in 2 px steps until `scrollWidth <= maxW` (and `scrollHeight <= maxH` when given), never below `minPx` (default 40); returns the final size.
It measures `scrollWidth`, so use it on `inline-block` / `inline-flex` elements, or on a block exactly `maxW` wide (a `.m9-title` block inside a fixed-width box works).
Example: `MP9.fit(document.getElementById("t1"), 940, null, 110)`.

### MP9.shrinkWrap(el)

After text wraps (for example `text-wrap: balance` with a `max-width`), the box keeps the full max-width and leaves empty space beside the lines.
`MP9.shrinkWrap(el)` sets the width to the widest rendered line (measured with a Range), so a pill or panel hugs its text.
Call it after `fit` and before any tween runs.

### MP9.words(el)

Splits `el`'s text into `inline-block` word spans and returns them, for word-by-word entrances.
Example: `tl.fromTo(MP9.words(t), { y: 60, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.07, duration: 0.4, ease: "power4.out" }, 0.1)`.
Do not use it on text that contains highlight spans (it flattens them); write the word spans in the HTML instead, as `ref_title` does.

### MP9.rich(el, text, cls)

Fills `el` from a string in which `*word*` marks green words (spans with class `m9-hl`, or `cls`), without `innerHTML`; returns the highlighted spans.
Example: `MP9.rich(txt, "सिर्फ़ *Axis Bank* cards")`.

### MP9.count(tl, el, from, to, at, dur, opts)

Counts a number up inside `el` between `at` and `at + dur`; options `{ commas: true (en-IN grouping), decimals: 0, prefix: "", suffix: "" }`.
Example: `MP9.count(tl, num, 0, 50000, 0.3, 0.8, { prefix: "₹" })` (show prices only when the host says them).

### MP9.phone(host, opts)

Appends a drawn modern iPhone front to `host`: titanium gradient frame, black bezel, Dynamic Island, side button on the right edge, action and volume buttons on the left.
Options: `{ width: 460, left, top | cx, cy, screenBg, id }`; height is `2.05 x width`; default screen is a dark ink gradient so the island stays visible.
Returns `{ el, screen, island, w, h }`; `screen` is a flex column (centred) with `overflow: hidden`; fill it with divs, kit icons, a mini `MP9.card`, or an `<img>` (fills and covers).
Content inside the screen should start about `0.2 x width` from the top so it clears the island.
Animate `el` (it has no CSS transform), for example `tl.fromTo(ph.el, { y: 320, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.15)`.

```js
const ph = MP9.phone(stage, { width: 400, cx: 380, top: 630, id: "phone" });
const hint = document.createElement("div"); hint.textContent = "Hold Near Reader";
ph.screen.appendChild(MP9.icon("contactless", 110));
ph.screen.appendChild(hint);
```

### MP9.card(host, opts)

Appends a drawn generic credit card to `host`: rounded, gradient, gold chip, contactless mark, label top-left, `•••• 5035` bottom-left, kind text bottom-right; no real logos.
Options: `{ width: 520, left, top | cx, cy, label: "Axis Bank", digits: "5035", kind: "CREDIT" ("" hides it), colors: ["#9b1d55", "#4d0b2c"], id }`; height is `width / 1.586`.
Returns `{ el, sheen, w, h }`; sweep `sheen` with `x` from `-0.5 * w` to `1.6 * w` for a glint.
Example: `const cd = MP9.card(stage, { width: 440, cx: 730, cy: 1250 }); tl.fromTo(cd.sheen, { x: -0.5 * cd.w }, { x: 1.6 * cd.w, duration: 0.8 }, 1.1)`.
If a card slides in from off-canvas, set `cd.el.setAttribute("data-layout-allow-overflow", "")` or `check` reports `panel_out_of_canvas`.

### MP9.icon(name, size, opts)

Returns an inline SVG line icon on a 64x64 grid (append it yourself); options `{ color: paper, accent: green, stroke: 4 }`.
Names: `contactless` (NFC waves), `faceid`, `check`, `cross` (red), `plus`, `wallet`, `lock`, `shield`, `watch`, `upi-off` ("UPI" badge with a red strike), `pos` (card machine), `settings` (gear).
Position it with CSS on the returned element (`svg.id = "x"` plus a rule, or `svg.style.position = "absolute"`), and animate the svg itself.
Example: `const big = MP9.icon("faceid", 220); big.id = "face"; stage.appendChild(big);`.

### MP9.waves(tl, iconOrEls, at, end, opts)

Pulses the four arcs of a `contactless` icon (class `m9-wave`) outward, inner to outer, from `at` until `end`, with finite explicit tweens (no `repeat: -1`).
Options `{ period: 0.9, low: 0.25, high: 1 }`; also accepts any array or NodeList of elements.
Example: `MP9.waves(tl, big, 0.9, D)`.

### MP9.rng(seed)

A seeded mulberry32 generator (`const r = MP9.rng(5); r()` gives 0-1); never use `Math.random`.

## CSS classes (`mp9.css`)

- `.m9-title`: 800 weight, 112 px default, line-height 1.25 with padding so matras and the reph never clip.
- `.m9-sub`: 600 weight, 52 px, muted; `.m9-label`: 700 weight, 40 px, muted.
- `.m9-num`: 800 weight, lining numerals, for big numbers.
- `.m9-hl` green text, `.m9-amber`, `.m9-red`.
- `.m9-chip`: filled dark pill with a green outline (keyword chips, labels on cards); add `.multi` for a two-line chip (radius 44 px instead of a full pill).
- `.m9-pill`: outlined green pill for small tags; `.m9-panel`: dark rounded panel with shadow (lists, steps).
- `.m9-cam`: full-frame camera wrapper for `MP9.push`; `.m9-wordmark`: optional centred letter-spaced wordmark at y 178.

## Pop-up template (moi_hit9)

Transparent, 6 s, one variable `text` (2-5 words, `*word*` marks green).
The host's face sits at about y 460-1190, x 300-780, so the chip lives in the chest zone, centred, y 1230-1450.
One line from 84 px down to 64 px; longer text breaks into two balanced lines from 72 px down to 56 px, shrink-wrapped; maximum chip width 940 px.
It pops in within 0.32 s and drifts gently (y -14, scale 1.03) to the last frame, with no exit.
A 940 px chip reaches x 1010, inside the Shorts action column below y 1000; keep pop-up text short so the chip stays narrower.

## Gotchas hit while building the kit

- `check` flags `text_occluded` when a card or panel covers text inside the phone screen, including late in a drift; keep drifts moving away from screen text.
- A box with `max-width` and wrapped text keeps the full max-width; use `MP9.shrinkWrap`.
- `document.fonts.ready` alone is not enough before `fit`; use `MP9.ready()`.
- Black on black hides the Dynamic Island; the default phone screen is a dark ink gradient for that reason, keep a non-black screen background.
- Never put a CSS `transform` on an element GSAP animates (lint `gsap_css_transform_conflict`); centre with flex or `left/top`, and use `cx/cy` in `phone` and `card`.
- A second tween on the same property of the same element needs `immediateRender: false`, or it overwrites the entrance's start state.
- Keep rotations of travelling elements within 20 degrees, or `check` warns `rotation_pivot_drift`.
- `snapshot` writes to a new folder under `.hyperframes/artifacts/snapshots/` (or `-o <dir>`); there is no flag to set variables, so test long pop-up text in a scratch copy with a changed default.
- Contrast passes for paper, green and muted text on ink and on the card gradient.

## Gotchas found by the 7064 graphics agents

- `MP9.fit` on a block title: the block must be exactly `maxW` wide (or narrower); a 940 px block fitted to 900 always shrinks to `minPx`.
- `MP9.rich` output placed directly inside a `display: flex` box loses the space before a highlighted word; wrap it in an inline span first.
- `check` reports `text_occluded` for `MP9.card` text tucked behind other art; put `data-layout-allow-occlusion` (and `data-layout-allow-overlap`) on the card's inner divs, not on the card or its container.
- Never rotate a "+" badge: at 45 degrees it reads as a cross.
