"""
Turn a generated Argos image into a sprite sheet the app can play (docs/COMPANION_ART_PROMPT.md).

The generators hand back a big image (often a JPEG with the checkerboard baked in) whose
frames differ in size and sit on no common line. This cuts the dog out of the checkerboard,
splits the frames by the gaps between them, scales them all by one factor so the dog is
the size of the walk sheet's (94 px tall), puts the paws on the same bottom line, and
writes an N x 96 by 96 PNG with hard alpha like the sheets already in the app.

    python scripts/companion-sheet.py <input image> <output png> <frames> [--keep 1,3,4] [--match idle.png]

`--keep` writes only those frames (1-based, in the order given): for when the generator
spoiled one and the cycle still reads without it. `--match <sheet>` brings the colours
in line with a sheet already in the app (the orange, the cream and the outline each
carried onto the reference's): the generators drift between images. Given a finished
96 px sheet as input, only that recolouring is done.

Needs Pillow, numpy and scipy. Check the result at 3x before it goes in: a frame the
generator drew much bigger or smaller than the others still comes out odd.
"""
import sys
from PIL import Image
import numpy as np
from scipy import ndimage

FRAME = 96
TARGET_H = 94  # the walk dog's height
PAW_Y = 94  # the walk dog's bottom line


def cut_dog(rgb: np.ndarray) -> np.ndarray:
    """A mask of the dog: not the checkerboard, not a motion streak, eye highlights kept."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    greyish = ((mx - mn) < 28) & (mx > 150)
    keyed = np.zeros(greyish.shape, bool)
    # A flat key colour behind him (the green or magenta the prompt asks for): whatever the
    # border is painted, and everything near that colour, is background like the grey.
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    key = np.median(border, axis=0)
    if key.max() - key.min() > 60:
        # Every paint sits far from a saturated key (the dark outline is the nearest, ~250 away
        # from pure green); an edge pixel the JPEG blended with it sits half way, and goes.
        keyed = np.sqrt(((rgb.astype(int) - key) ** 2).sum(-1)) < 160
        greyish = greyish | keyed
        rgb[keyed] = 255
        # Despill: the key's channel never leads on the dog, so an edge pixel the JPEG blended
        # with the green keeps its orange rather than a green tint.
        lead = int(np.argmax(key))
        others = [c for c in range(3) if c != lead]
        cap = (rgb[..., others[0]].astype(int) + rgb[..., others[1]].astype(int)) // 2
        rgb[..., lead] = np.minimum(rgb[..., lead].astype(int), cap).astype(rgb.dtype)
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        mx = np.maximum(np.maximum(r, g), b)
        mn = np.minimum(np.minimum(r, g), b)
    # What only the real dog has: the dark outline and the strong orange. A pale "ghost"
    # copy the generator smears behind him has neither, and nor does the checkerboard.
    strong = (mx < 90) | ((mx - mn) > 100)
    lab2, n2 = ndimage.label(strong)
    sizes = ndimage.sum(strong, lab2, range(1, n2 + 1))
    # Every size below is relative to the dog, since a generator hands back a 1024 px dog
    # and a screenshot a 250 px one: H is the tallest strong piece, the dog's body.
    objs = ndimage.find_objects(lab2)
    H = max(o[0].stop - o[0].start for o in objs if o is not None)
    strong = np.isin(lab2, [i + 1 for i, s in enumerate(sizes) if s > 0.02 * H * H])
    # Closed into a silhouette, which takes the cream muzzle, chest and paws inside the
    # outline with it; the checkerboard showing through a gap stays out.
    k = max(3, int(H * 0.03))
    silhouette = ndimage.binary_fill_holes(ndimage.binary_closing(strong, np.ones((k, k))))
    # Outside the silhouette the grey is the checkerboard. Inside, a pale paint (a near-white
    # muzzle, the white of an eye) reads as grey too, but it is flat where a pocket of
    # checkerboard the closing swallowed alternates light and dark: by its spread, it stays.
    # The cream that sits at the edge of the outline (the muzzle, the chest) is neither
    # grey nor strong, and the closing can miss it where the outline is thin: any paint
    # touching the silhouette and within reach of it is the dog too; a ghost smeared
    # further off is not.
    near = ndimage.distance_transform_edt(~silhouette) < 0.12 * H
    lab_t, n_t = ndimage.label(~greyish & near)
    touching = np.unique(lab_t[silhouette & (lab_t > 0)])
    silhouette = silhouette | np.isin(lab_t, touching[touching > 0])
    background = greyish & ~silhouette
    core = silhouette & ~greyish
    pale = greyish & silhouette & ~keyed
    lab_p, n_p = ndimage.label(pale)
    for i in range(1, n_p + 1):
        comp = lab_p == i
        if mx[comp].std() < 12:
            core |= comp
    body = ndimage.binary_fill_holes(core)
    # A motion streak the generator drew: near-white, long and flat. Painted over with the
    # nearest colour where it crosses the body, dropped where it sticks out of it.
    streaky = (mx > 225) & ((mx - mn) < 40) & core
    lab_s, n_s = ndimage.label(streaky)
    for i, sl in enumerate(ndimage.find_objects(lab_s)):
        if sl is None:
            continue
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if w < 0.15 * H or h * 3 > w:
            continue
        comp = lab_s == i + 1
        core &= ~comp
        body = ndimage.binary_fill_holes(ndimage.binary_opening(core, np.ones((45, 9))))
        inside = comp & body
        if inside.any():
            _, idx = ndimage.distance_transform_edt(~core, return_indices=True)
            ys, xs = np.where(inside)
            rgb[ys, xs] = rgb[idx[0][ys, xs], idx[1][ys, xs]]
            core |= inside
    dog = core.copy()
    # Grey pixels the dog encloses: an eye highlight stays; a long streak is painted over
    # with the nearest colour inside the body and dropped outside it.
    enclosed = greyish & ~background
    lab3, n3 = ndimage.label(enclosed)
    sizes3 = ndimage.sum(enclosed, lab3, range(1, n3 + 1))
    for i, s in enumerate(sizes3):
        comp = lab3 == i + 1
        if s < (0.05 * H) ** 2:
            # An eye highlight, the white of an open mouth.
            dog |= comp & body
        else:
            inside = comp & body
            if inside.any():
                _, idx = ndimage.distance_transform_edt(~core, return_indices=True)
                ys, xs = np.where(inside)
                rgb[ys, xs] = rgb[idx[0][ys, xs], idx[1][ys, xs]]
                dog |= inside
    # Whatever was the key colour is never the dog, however the silhouette fell around it.
    return dog & ~keyed


def colour_classes(px: np.ndarray) -> dict[str, np.ndarray]:
    """The dog's three paints, by hue and value: the orange coat, the cream, the dark outline."""
    mx = px.max(1)
    mn = px.min(1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    val = mx / 255.0
    return {
        'orange': (sat > 0.45) & (val > 0.6) & (px[:, 0] > px[:, 2]),
        'cream': (sat < 0.3) & (val > 0.75),
        'dark': val < 0.35
    }


def match_colours(sheet: Image.Image, reference: str) -> Image.Image:
    """
    The sheet's paints brought onto the reference sheet's: for each channel, the gain and
    offset that carry the mean orange, cream and outline of this sheet onto the reference's
    (least squares over the three), applied to every pixel of the dog.
    """
    ref = np.array(Image.open(reference).convert('RGBA')).astype(float)
    out = np.array(sheet.convert('RGBA')).astype(float)
    ref_px = ref[..., :3][ref[..., 3] > 128]
    mask = out[..., 3] > 128
    out_px = out[..., :3][mask]
    rc, oc = colour_classes(ref_px), colour_classes(out_px)
    names = [n for n in rc if rc[n].sum() > 20 and oc[n].sum() > 20]
    if len(names) < 2:
        return sheet
    src = np.array([out_px[oc[n]].mean(0) for n in names])
    dst = np.array([ref_px[rc[n]].mean(0) for n in names])
    fixed = out_px.copy()
    for c in range(3):
        gain, offset = np.polyfit(src[:, c], dst[:, c], 1)
        fixed[:, c] = out_px[:, c] * gain + offset
    # The coat is most of the dog and what the eye compares first: whatever the three-way
    # fit left of the gap in the orange is closed on the orange alone, fading out at its edge.
    if 'orange' in names:
        fc = colour_classes(fixed)
        residual = ref_px[rc['orange']].mean(0) - fixed[fc['orange']].mean(0)
        mx = fixed.max(1)
        sat = np.where(mx > 0, (mx - fixed.min(1)) / np.maximum(mx, 1), 0)
        weight = np.clip((sat - 0.3) / 0.15, 0, 1) * (mx > 150) * (fixed[:, 0] > fixed[:, 2])
        fixed += residual * weight[:, None]
    out[..., :3][mask] = np.clip(fixed, 0, 255)
    print('colours matched on', ', '.join(names))
    return Image.fromarray(out.astype(np.uint8))


def clean_mask(dog: np.ndarray) -> np.ndarray:
    """A colour-cut mask without its specks and pinholes, so the edge comes out even."""
    ys = np.where(dog.any(1))[0]
    H = ys.max() - ys.min() + 1
    k = max(3, int(H * 0.012))
    if k % 2 == 0:
        k += 1
    smooth = ndimage.median_filter(dog, size=k)
    return ndimage.binary_fill_holes(smooth) & ~(ndimage.binary_fill_holes(smooth) & ~smooth & ~ndimage.binary_dilation(smooth, iterations=k))


def split_frames(dog: np.ndarray, frames: int) -> list[tuple[int, int]]:
    ys = np.where(dog.any(1))[0]
    H = ys.max() - ys.min() + 1
    cols = dog.sum(0) > 0.1 * H
    ranges: list[list[int]] = []
    start = None
    for x, v in enumerate(cols):
        if v and start is None:
            start = x
        if not v and start is not None:
            ranges.append([start, x])
            start = None
    if start is not None:
        ranges.append([start, len(cols)])
    merged = [ranges[0]]
    for a, b in ranges[1:]:
        if a - merged[-1][1] < 0.05 * H:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    if len(merged) != frames:
        # The generator drew them touching: cut the row into equal parts instead.
        w = dog.shape[1] // frames
        merged = [[i * w, (i + 1) * w] for i in range(frames)]
    return [(a, b) for a, b in merged]


def main() -> None:
    src, out, frames = sys.argv[1], sys.argv[2], int(sys.argv[3])
    keep = [int(k) - 1 for k in sys.argv[sys.argv.index('--keep') + 1].split(',')] if '--keep' in sys.argv else list(range(frames))
    # A PNG with real transparency is laid over white first: the cutter reads a background
    # of white and grey, and transparent black would otherwise read as outline.
    src_im = Image.open(src).convert('RGBA')
    if src_im.height == FRAME and src_im.width % FRAME == 0 and '--match' in sys.argv:
        # Already a sheet: only the colours are brought in line.
        sheet = match_colours(src_im, sys.argv[sys.argv.index('--match') + 1])
        sheet.save(out)
        print('wrote', out, 'recoloured')
        return
    alpha = np.array(src_im)[..., 3]
    flat = Image.new('RGBA', src_im.size, (255, 255, 255, 255))
    flat.alpha_composite(src_im)
    rgb = np.array(flat.convert('RGB'))
    if (alpha < 128).mean() > 0.05:
        # The file carries its own transparency (a PNG from the generator): that is the dog.
        dog = alpha >= 128
    else:
        dog = clean_mask(cut_dog(rgb))
    crops = []
    found = split_frames(dog, frames)
    for a, b in [found[k] for k in keep]:
        sub = dog[:, a:b]
        ys = np.where(sub.any(1))[0]
        xs = np.where(sub.any(0))[0]
        y0, y1 = ys.min(), ys.max() + 1
        x0, x1 = a + xs.min(), a + xs.max() + 1
        rgba = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
        rgba[..., :3] = rgb[y0:y1, x0:x1]
        rgba[..., 3] = dog[y0:y1, x0:x1] * 255
        crops.append(rgba)
    fit = [min(TARGET_H / c.shape[0], (FRAME - 2) / c.shape[1]) for c in crops]
    scale = float(np.median(fit))
    frames = len(crops)
    sheet = Image.new('RGBA', (FRAME * frames, FRAME), (0, 0, 0, 0))
    for i, c in enumerate(crops):
        s = min(scale, fit[i])
        w, h = max(1, round(c.shape[1] * s)), max(1, round(c.shape[0] * s))
        pre = c.astype(float)
        pre[..., :3] *= pre[..., 3:4] / 255.0
        small = np.array(Image.fromarray(pre.astype(np.uint8)).resize((w, h), Image.LANCZOS)).astype(float)
        a = small[..., 3:4]
        small[..., :3] = np.where(a > 0, small[..., :3] * 255.0 / np.maximum(a, 1), 0)
        small[..., 3] = np.where(small[..., 3] >= 128, 255, 0)
        f = Image.fromarray(np.clip(small, 0, 255).astype(np.uint8))
        sheet.paste(f, (i * FRAME + (FRAME - w) // 2, PAW_Y - h + 1), f)
        print(f'frame {i + 1}: {w}x{h} at {s:.3f}')
    if '--match' in sys.argv:
        sheet = match_colours(sheet, sys.argv[sys.argv.index('--match') + 1])
    sheet.save(out)
    sheet.resize((FRAME * frames * 3, FRAME * 3), Image.NEAREST).save(out.replace('.png', '.preview.png'))
    print('wrote', out, 'and its 3x preview')


if __name__ == '__main__':
    main()
