# Argos the dog: art brief and image-generation prompts

The companion's pet (see `COMPANION_PLAN.md` §2) needs eight poses. This file holds the
prompts to produce them with an image-generation AI, and what to do with the output so it
fits the app.

## Read this first: what format the app needs

- **The app animates the pet itself.** The blink, the ear twitch, the tail wag and the
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
     vectorizer.ai, Illustrator Image Trace or Inkscape Trace Bitmap, with 3 to 4 colours.
- **Parts for animation:** after vectorising, split each pose in Figma or Inkscape into
  named groups: `body`, `head`, `ear-left`, `ear-right`, `eyelid`, `tail`, `collar-tag`.
  Image AIs do not produce clean layers on their own.
- **Colours:** replace the fills with the four colours below after vectorising, so the app
  can recolour the pet from theme tokens later.

| Role | Hex | Token in the app |
|---|---|---|
| Fur | `#E9DCC8` | `--pet-fill` |
| Fur shade (ears, haunch) | `#C9B79C` | `--pet-shade` |
| Outline, eyes, nose | `#3B332B` | `--pet-line` |
| Collar and tag | `#DF7A52` | `--accent` |

## Prompt 1: character sheet (run first)

```
Character design sheet of an original mascot: "Argos", a loyal medium-sized hound dog,
inspired by Odysseus' faithful dog from Greek myth. Flat vector illustration, minimal and
geometric, like a modern app icon set. Uniform 2px dark-brown outline (#3B332B) with round
line caps and joins, flat fills only: warm cream fur (#E9DCC8), slightly darker tan for
the floppy ears and the haunch (#C9B79C). A thin terracotta-orange collar (#DF7A52) with a
small round tag. Small round dark eyes, a simple rounded snout with a dark nose, no
eyebrows, no mouth line unless talking. Friendly and calm, not cartoonishly cute, no big
anime eyes. Side three-quarter view facing right.
Show the same dog in a turnaround: sitting (side), sitting (three-quarter), standing
(side), plus a close-up of the head. Consistent proportions across all views.
Pure white background, no shadows, no gradients, no texture, no text, no watermark.
```

**Negative prompt** (when the tool has one):

```
paperclip, Clippy, realistic fur, gradients, 3D render, shading, drop shadow, texture,
photo, text, letters, watermark, busy background, multiple dogs of different designs,
anime eyes, chibi
```

## Prompt 2: one pose at a time

Attach the chosen character-sheet image as the reference or style. Then use this base and
swap in one pose line from the table:

```
The same dog "Argos" as in the reference image, identical design, colours, line weight
and proportions. Flat vector illustration, 2px dark-brown outline, flat fills, no
gradients, no shadows. Single character, centred, full body visible with some margin,
facing right in three-quarter view. Pure white background (or transparent), no text.
Pose: <POSE>
```

| State in the app | `<POSE>` |
|---|---|
| `idle` | sitting upright, head level, ears relaxed and floppy, tail resting on the ground, eyes open, calm |
| `dozing` | curled up asleep in a round ball, chin resting on front paws, eyes closed (curved lines), tail wrapped around the body |
| `listening` | sitting upright, both ears raised and alert, head slightly lifted, eyes wide open, attentive |
| `thinking` | sitting, head tilted about 15 degrees to the side, one ear up and one down, curious expression |
| `talking` | sitting, mouth slightly open as if speaking, head turned a little towards the viewer |
| `alert` | standing on all four legs, ears up and forward, tail raised, looking ahead, ready to announce something |
| `happy` | sitting, tail raised mid-wag, eyes closed in a smile (upturned curves), mouth open in a soft smile |
| `shh` | lying down flat, head resting on the front paws, eyes closed, calm; a small crescent-moon badge on the collar tag |

## Prompt 3 (optional): animation frames for preview

Only for a WebP or APNG preview. In the app, the animation comes from CSS.

```
Sprite sheet, 4 frames in one horizontal row, equal spacing, of the same dog "Argos" from
the reference image, identical design. Flat vector style, 2px outline, flat fills, white
background, no text. Animation: <ANIMATION>, small differences between frames only, the
body stays in the same place.
```

`<ANIMATION>` examples: `tail wagging left to right while sitting`, `slow sleepy breathing
while curled up`, `ears rising from relaxed to alert`.

## Checklist before the art goes in the app

- [ ] All eight poses share one canvas size (square, e.g. 512×512) and the same baseline
      for the feet, so swapping poses does not make the pet jump.
- [ ] Fills reduced to the four colours above.
- [ ] Parts grouped and named for animation.
- [ ] Each SVG under ~8 kB after SVGO.
- [ ] Reads clearly at 72–96 px tall over both a light and a dark wallpaper.
