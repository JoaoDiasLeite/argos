# Argos the dog: art brief and image-generation prompts

The companion's pet (see `COMPANION_PLAN.md` §2) needs eight poses. This file holds the
prompts to produce them with an image-generation AI, and what to do with the output so it
fits the app.

**Direction (João, 2026-11-02):** a cartoon, chibi-style dog in Argos's colours, orange
and white. Big head, small round body, short legs, big shiny eyes. Cute is the point.

## Read this first: what format the app needs

- **The app animates the pet itself.** The blink, the ear flop, the tail wag and the
  breathing are CSS transforms on parts of an SVG. So the deliverable is **one static SVG
  per pose**, not GIFs.
- **Do not use GIF.** GIF transparency is 1-bit, so the edges look jagged over the
  transparent pet window and the desktop wallpaper. If you want a raster animation for a
  preview, export animated WebP or APNG instead.
- **Generate a character sheet first, then the poses.** Image AIs drift between
  generations. Lock the design on one sheet, then reuse it as the reference image for each
  pose.
- **Getting the SVG:**
  1. Best: a tool with native vector output, such as Recraft (Vector illustration mode,
     with the character sheet saved as a style).
  2. Otherwise: generate PNG on a transparent or flat background, then vectorise with
     vectorizer.ai, Illustrator Image Trace or Inkscape Trace Bitmap, with 5 to 6 colours.
- **Parts for animation:** after vectorising, split each pose in Figma or Inkscape into
  named groups: `body`, `head`, `ear-left`, `ear-right`, `eyes`, `eyelids`, `tail`,
  `collar-tag`. Image AIs do not produce clean layers on their own.
- **Colours:** snap the fills to the palette below after vectorising, so the app can
  recolour the pet from theme tokens later.

| Role | Hex | Token in the app |
|---|---|---|
| Orange fur (head top, back, ears, tail) | `#DF7A52` | `--pet-fur` (Argos accent) |
| Darker orange (ear insides, shading patches) | `#C2603B` | `--pet-fur-shade` |
| White fur (muzzle, chest, belly, paws, tail tip) | `#FFFFFF` | `--pet-white` |
| Outline, eyes, nose | `#2A2622` | `--pet-line` |
| Cheek blush, tongue | `#F4A08A` | `--pet-blush` |
| Collar | `#2A2622` with a gold tag `#D9A83C` | `--pet-collar` |

## Prompt 1: character sheet (run first)

```
Character design sheet of an original cute mascot: "Argos", a chibi cartoon puppy.
Chibi proportions: a big round head about as large as the body, a small round body,
short stubby legs, small round paws, a fluffy curled tail.
Fur colours: bright orange (#DF7A52) on the head, back, ears and tail, white (#FFFFFF)
on the muzzle, chest, belly, paws and the tip of the tail, like a two-tone shiba or corgi
pattern. Big soft floppy ears, orange outside and darker orange (#C2603B) inside.
Big round shiny dark eyes with one white highlight each, small pink blush on the cheeks
(#F4A08A), a tiny dark nose, a small happy mouth.
A dark collar with a small round gold tag (#D9A83C).
Clean cartoon vector style: smooth thick dark outline (#2A2622), flat colours with at most
one soft shade, rounded shapes everywhere, sticker-like, app-mascot quality.
Show the same puppy in a turnaround: sitting (front), sitting (three-quarter, facing
right), standing (side), plus a close-up of the face with three expressions (happy,
curious, sleepy). Consistent proportions and markings across all views.
Pure white background, no scenery, no text, no watermark.
```

**Negative prompt** (when the tool has one):

```
paperclip, Clippy, realistic, realistic fur, photo, 3D render, heavy shading, gradients,
texture, scary, angry, long thin legs, adult dog proportions, text, letters, watermark,
busy background, several different dogs
```

## Prompt 2: one pose at a time

Attach the chosen character-sheet image as the reference or style. Then use this base and
swap in one pose line from the table:

```
The same chibi puppy "Argos" as in the reference image, identical design, markings,
colours and outline. Orange and white fur, big head, short legs, big shiny eyes.
Clean cartoon vector style, thick dark outline, flat colours. Single character, centred,
full body visible with some margin, three-quarter view facing right.
Pure white background (or transparent), no text.
Pose: <POSE>
```

| State in the app | `<POSE>` |
|---|---|
| `idle` | sitting, looking at the viewer, ears relaxed, tail curled beside it, small smile |
| `dozing` | curled up asleep in a round ball, eyes closed (curved lines), a tiny "z" bubble, tail wrapped around the body |
| `listening` | sitting, both ears perked up, head slightly lifted, eyes wide and sparkling, attentive |
| `thinking` | sitting, head tilted to one side, one ear up and one flopped down, a paw raised to the chin, curious |
| `talking` | sitting, mouth open as if speaking, one paw slightly raised, friendly |
| `alert` | standing on all four legs, ears up, tail high, mouth open in a little bark, an exclamation mark above the head |
| `happy` | sitting, eyes closed in happy upturned curves, big open smile with tongue, tail mid-wag with motion lines |
| `shh` | lying flat, chin on its front paws, eyes closed, a small crescent moon on the collar tag |

## Prompt 3 (optional): animation frames for preview

Only for a WebP or APNG preview. In the app, the animation comes from CSS.

```
Sprite sheet, 4 frames in one horizontal row, equal spacing, of the same chibi puppy
"Argos" from the reference image, identical design and colours. Clean cartoon vector
style, thick outline, flat colours, white background, no text. Animation: <ANIMATION>,
small differences between frames only, the body stays in the same place.
```

`<ANIMATION>` examples: `tail wagging left to right while sitting`, `slow sleepy breathing
while curled up`, `ears perking up from relaxed to alert`, `blinking`.

## Checklist before the art goes in the app

- [ ] All eight poses share one canvas size (square, e.g. 512×512) and the same baseline
      for the paws, so swapping poses does not make the pet jump.
- [ ] Fills snapped to the palette above.
- [ ] Parts grouped and named for animation.
- [ ] Each SVG under ~12 kB after SVGO.
- [ ] Reads clearly at 72–96 px tall over both a light and a dark wallpaper: the white
      fur needs the dark outline to stand out on a light wallpaper.
