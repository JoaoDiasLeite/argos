# Argos the dog: art brief and image-generation prompts

The companion's pet (see `COMPANION_PLAN.md` §2) needs a small set of animated states.
This file holds the prompts to produce them with an image-generation AI, and what to do
with the output so it fits the app.

**Direction (João, 2026-11-02, second pass):** **pixel art**, chibi, in the spirit of the
Codex desktop pets (a big head on a tiny body, a handful of colours, readable at 64 px).
The dog is a **Portuguese Podengo** (podengo português), simplified and a little fictional:

- **big semi-folded ears**: they stand up from a wide base and fold forward about halfway,
  the tips dropping towards the eyes (like a young podengo or a jack russell). Not pointed
  and erect, not long and hanging like a beagle's. They are the main feature of the
  silhouette;
- a **wiry, scruffy coat**, shown with only a few jagged pixels at the cheeks, chin
  ("beard") and chest, not drawn hair by hair;
- a **sickle tail** that curls up over the back;
- a slim, pointed muzzle with a small dark nose;
- **coat colours like a scruffy podengo mix:** warm orange on the head, ears, back and
  tail; **cream** on the muzzle, the chin beard, the chest and the paw tips; a small
  messy **tuft of hair on top of the head** and a hint of shaggy eyebrows;
- few details: a cartoon, not a breed portrait.

Do not imitate an existing mascot (e.g. Datadog's dog, or the Codex pets themselves). Take
the style from them, not the character.

## Read this first: what format the app needs

- **Pixel art means a sprite sheet, not an SVG.** Each state is a short row of frames in
  one PNG. The app plays them with CSS `steps()` and scales them up with
  `image-rendering: pixelated`, so the pixels stay sharp at any size.
- **Grid:** each frame **96×96 px** (size test 2026-11-02: at 48 px the outline and the
  eyes turn to mush, 64 px is borderline, 96 px keeps the face), the dog sitting on the
  same bottom line in every frame and state, transparent background.
- **GIF is acceptable here** for previews, because pixel art has no soft edges to lose. In
  the app, use the PNG sheet: it's smaller and lets the app choose the speed.
- **No anti-aliasing, no blur, no gradients.** Every pixel is one of the palette's colours.
- **Generate the character first, then the animations.** Lock one idle sprite you like
  and give it as the reference for every other state.

### Tools

1. **PixelLab** (pixellab.ai) or **Retro Diffusion**: pixel-art generators that keep a
   character consistent and can animate it from a reference. This is the best fit.
2. **ChatGPT image generation**: good at following this brief in one conversation. The
   output is pseudo-pixel (soft edges, uneven grid), so it needs a cleanup pass.
3. **Cleanup and animation by hand:** **Aseprite** (paid, the standard) or **Piskel**
   (free, in the browser). Import the generated image, snap it to the 96×96 grid and the
   palette below, then fix or draw the in-between frames. Plan on this step whatever tool
   generates the first image.

### Palette (keep to these)

| Role | Hex |
|---|---|
| Outline | `#2A1A14` |
| Orange, shadow | `#B4532F` |
| Orange, base (the Argos accent) | `#DF7A52` |
| Orange, light | `#F0A070` |
| Cream (muzzle, beard, chest, paw tips) | `#F7E6D0` |
| Eyes, nose | `#1A1210` |
| Eye highlight | `#FFFFFF` |
| Ear inside, blush, tongue | `#F4A08A` |
| Collar tag (optional) | `#D9A83C` |

## Prompt 1: the character (run first)

```
Pixel art character, 96x96 sprite, chibi style: "Argos", a cute cartoon Portuguese
Podengo puppy. Big head on a tiny body, short legs. Very large semi-folded ears: they
rise from a wide base and fold forward halfway, the triangular tips flopping down towards
the eyes, pink inside. Slim pointed muzzle, small dark
nose, big round dark eyes with one white highlight pixel, small pink blush.
Wiry scruffy coat suggested by a few jagged pixels on the cheeks, chin beard and chest,
a small messy tuft of hair on top of the head and shaggy eyebrows.
A curled sickle tail over the back.
Warm orange fur on the head, ears, back and tail (#DF7A52 base, #B4532F shadow, #F0A070
highlight); cream muzzle, chin beard, chest and paw tips (#F7E6D0); dark brown outline
(#2A1A14).
Sitting, three-quarter view facing right, friendly and alert.
Clean pixel art, hard edges, no anti-aliasing, limited palette of 9 colours,
transparent background, centered, no text, no shadow on the ground.
```

**Negative prompt** (when the tool has one):

```
realistic, photo, 3D, smooth shading, gradients, anti-aliasing, blur, pointed erect ears,
long hanging ears, beagle, corgi, shiba, long body, detailed fur strands, text, watermark, background,
Datadog logo, existing mascot
```

Make 4 to 8 variations and pick the one whose **ears and tail** read best at the small
size. That one is the reference for everything below.

## Prompt 2: animation sheets, one per state

Give the chosen sprite as the reference, then:

```
Pixel art sprite sheet of the same character "Argos" from the reference, identical
design, palette and proportions. <FRAMES> frames of 96x96 in one horizontal row,
transparent background, hard edges, no anti-aliasing. The dog stays in the same spot and
sits on the same bottom line in every frame. Animation: <ANIMATION>
```

| State | `<FRAMES>` | `<ANIMATION>` |
|---|---|---|
| `idle` | 4 | sitting, slow breathing (body rises 1 px), one blink on frame 3, tail curled |
| `dozing` | 4 | curled up in a ball asleep, eyes closed, breathing, small "z" pixels rising |
| `listening` | 4 | sitting, the folded ear tips lift up and twitch, head lifts slightly, eyes wide |
| `thinking` | 4 | sitting, head tilts to one side, one ear folds a little, eyes look up |
| `talking` | 4 | sitting, mouth opens and closes, one front paw lifts |
| `alert` | 4 | standing, ears raised with the tips still folded, tail high, a small bark (mouth open), a "!" above the head on frames 2–3 |
| `happy` | 6 | small hop with the tail wagging fast, eyes closed in a smile, tongue out |
| `shh` | 2 | lying down, chin on its paws, eyes closed, a tiny crescent moon above, nearly still |

## Prompt 3: the phase 2 sheets (plan §13.4)

Same Prompt 2, same reference. **Use a frame of the sheets already in the app as the
reference** (`src/renderer/src/companion/sprites/idle.png`, first frame), not the 1024²
stills: the sheets are what the dog looks like at 96 px now, and the new ones must sit
beside them without a visible change of hand. Every sheet is drawn **facing right**; the
app mirrors it for the left, so never draw a left-facing version.

**Ask for a flat key colour behind him, not transparency.** The chat generators hand back a
checkerboard baked into a JPEG, which the cutter has to guess the dog out of (a near-white
muzzle looks like the checkerboard's white). A solid green (`#00FF00`) nothing on the dog
comes near is keyed out cleanly: add `on a flat solid bright green background (#00FF00),
no checkerboard, no transparency` to every prompt below.

| State | File | `<FRAMES>` | `<ANIMATION>` | Until it exists |
|---|---|---|---|---|
| `running` | `run.png` | 6 | running to the right at full tilt, a four-beat gallop: front legs reach, back legs push, one frame with all four paws off the ground, ears streaming back, tail straight out, mouth open and happy | `walk.png` at 12 fps |
| `leaning` | `lean.png` | 1 | sitting with its back against a wall on the LEFT edge of the frame, body turned three-quarters to the right, one hind leg stretched out, relaxed, eyes half closed; the wall itself is not drawn | `idle.png` |
| `perched` | `perch.png` | 2 | sitting on a narrow ledge at the very bottom of the frame with both front paws over the edge and the hind legs tucked, looking down then straight ahead; the ledge itself is not drawn | `idle.png` |
| `looking` | `look.png` | 2 | sitting, head turned to the right towards something off-frame, ears up; frame 2 leans the head a little further with the eyes wide | mirrored `idle` |
| `stretching` | `stretch.png` | 3 | the morning stretch: a play bow with the front legs out flat and the rump up, tail high, then a yawn with the mouth wide open, then back to sitting | `wag.png` |
| `sleeping` | `sleep.png` | 2 | lying flat on its side asleep, legs out, eyes closed, slow breathing (the chest rises 1 px), the tail curled round | `doze.png` |
| `scratching` | `scratch.png` | 4 | sitting, one hind leg up scratching behind the folded ear, the ear flapping with it, eyes squeezed shut | `wag.png` |

**All seven were drawn on 2026-11-05** (Gemini, from the idle frame as reference, over a
green key) and cut with the script below: `run.png` (five of the six frames; one came
smeared), `lean.png`, `perch.png`, `look.png`, `stretch.png` (frames 1–3 for the stretch,
frame 2 held for the yawn), `sleep1.png` and `sleep2.png` (two ways of lying, one picked
each night) and `scratch.png`. Frame rates the app plays them at: run 10, look 2, stretch
1, sleep 1, scratch 8 fps; lean and perch are held frames.

**From the generator to the app:** `python scripts/companion-sheet.py <image> <sheet.png>
<frames>` cuts the dog out of the baked-in checkerboard (a JPEG is fine), splits the frames
by the gaps between them, scales them to the walk dog's 94 px, puts the paws on the walk
sheet's bottom line and writes the PNG with hard alpha, plus a `.preview.png` at 3× to
look at. A spoiled frame (a motion-blur band, as the first run sheet had) is left out with
`--keep 1,3,4,5,6` and the frame count in `Pet.tsx` follows.

## Checklist before the art goes in the app

- [ ] Every frame is 96×96, with the dog on the same bottom line,
      so switching states does not make it jump.
- [ ] Only palette colours, no semi-transparent pixels except fully transparent.
- [ ] One PNG per state, frames left to right, no gaps (or note the gap size).
- [ ] Reads clearly at 1× (96 px) and 2× (192 px) over a light and a dark wallpaper; the
      dark outline must go all the way round.
- [ ] The ears still read as big folded ears at 1× (96 px): the fold must be visible.
