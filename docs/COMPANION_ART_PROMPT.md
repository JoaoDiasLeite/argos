# Argos the dog: art brief and image-generation prompts

The companion's pet (see `COMPANION_PLAN.md` §2) needs a small set of animated states.
This file holds the prompts to produce them with an image-generation AI, and what to do
with the output so it fits the app.

**Direction (João, 2026-11-02, second pass):** **pixel art**, chibi, in the spirit of the
Codex desktop pets (a big head on a tiny body, a handful of colours, readable at 64 px).
The dog is a **Portuguese Podengo** (podengo português), simplified and a little fictional:

- **big upright triangular ears**, wide at the base: the main feature of the silhouette;
- a **wiry, scruffy coat**, shown with only a few jagged pixels at the cheeks, chin
  ("beard") and chest, not drawn hair by hair;
- a **sickle tail** that curls up over the back;
- a slim, pointed muzzle with a small dark nose;
- **all warm orange**, optionally with a cream chest and paw tips;
- few details: a cartoon, not a breed portrait.

Do not imitate an existing mascot (e.g. Datadog's dog, or the Codex pets themselves). Take
the style from them, not the character.

## Read this first: what format the app needs

- **Pixel art means a sprite sheet, not an SVG.** Each state is a short row of frames in
  one PNG. The app plays them with CSS `steps()` and scales them up with
  `image-rendering: pixelated`, so the pixels stay sharp at any size.
- **Grid:** each frame **48×48 px** (32×32 if the tool struggles), the dog sitting on the
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
   (free, in the browser). Import the generated image, snap it to the 48×48 grid and the
   palette below, then fix or draw the in-between frames. Plan on this step whatever tool
   generates the first image.

### Palette (keep to these)

| Role | Hex |
|---|---|
| Outline | `#2A1A14` |
| Orange, shadow | `#B4532F` |
| Orange, base (the Argos accent) | `#DF7A52` |
| Orange, light | `#F0A070` |
| Cream (chest, beard, paw tips; optional) | `#F7E6D0` |
| Eyes, nose | `#1A1210` |
| Eye highlight | `#FFFFFF` |
| Ear inside, blush, tongue | `#F4A08A` |
| Collar tag (optional) | `#D9A83C` |

## Prompt 1: the character (run first)

```
Pixel art character, 48x48 sprite, chibi style: "Argos", a cute cartoon Portuguese
Podengo puppy. Big head on a tiny body, short legs. Very large upright triangular ears,
wide at the base and pointed at the tips, pink inside. Slim pointed muzzle, small dark
nose, big round dark eyes with one white highlight pixel, small pink blush.
Wiry scruffy coat suggested by a few jagged pixels on the cheeks, chin beard and chest.
A curled sickle tail over the back.
All warm orange fur (#DF7A52 base, #B4532F shadow, #F0A070 highlight), cream chest and
paw tips (#F7E6D0), dark brown outline (#2A1A14).
Sitting, three-quarter view facing right, friendly and alert.
Clean pixel art, hard edges, no anti-aliasing, limited palette of 9 colours,
transparent background, centered, no text, no shadow on the ground.
```

**Negative prompt** (when the tool has one):

```
realistic, photo, 3D, smooth shading, gradients, anti-aliasing, blur, floppy ears,
beagle, corgi, shiba, long body, detailed fur strands, text, watermark, background,
Datadog logo, existing mascot
```

Make 4 to 8 variations and pick the one whose **ears and tail** read best at the small
size. That one is the reference for everything below.

## Prompt 2: animation sheets, one per state

Give the chosen sprite as the reference, then:

```
Pixel art sprite sheet of the same character "Argos" from the reference, identical
design, palette and proportions. <FRAMES> frames of 48x48 in one horizontal row,
transparent background, hard edges, no anti-aliasing. The dog stays in the same spot and
sits on the same bottom line in every frame. Animation: <ANIMATION>
```

| State | `<FRAMES>` | `<ANIMATION>` |
|---|---|---|
| `idle` | 4 | sitting, slow breathing (body rises 1 px), one blink on frame 3, tail curled |
| `dozing` | 4 | curled up in a ball asleep, eyes closed, breathing, small "z" pixels rising |
| `listening` | 4 | sitting, big ears perk up and twitch, head lifts slightly, eyes wide |
| `thinking` | 4 | sitting, head tilts to one side, one ear folds a little, eyes look up |
| `talking` | 4 | sitting, mouth opens and closes, one front paw lifts |
| `alert` | 4 | standing, ears straight up, tail high, a small bark (mouth open), a "!" above the head on frames 2–3 |
| `happy` | 6 | small hop with the tail wagging fast, eyes closed in a smile, tongue out |
| `shh` | 2 | lying down, chin on its paws, eyes closed, a tiny crescent moon above, nearly still |

## Checklist before the art goes in the app

- [ ] Every frame is 48×48 (or every frame 32×32), with the dog on the same bottom line,
      so switching states does not make it jump.
- [ ] Only palette colours, no semi-transparent pixels except fully transparent.
- [ ] One PNG per state, frames left to right, no gaps (or note the gap size).
- [ ] Reads clearly at 3× (144 px) and 2× (96 px) over a light and a dark wallpaper; the
      dark outline must go all the way round.
- [ ] The ears are still obviously podengo ears at 1× (48 px).
