"""
Turn a generated Argos image into a sprite sheet the app can play (docs/COMPANION_ART_PROMPT.md).

The generators hand back a big image (often a JPEG with the checkerboard baked in) whose
frames differ in size and sit on no common line. This cuts the dog out of the checkerboard,
splits the frames by the gaps between them, scales them all by one factor so the dog is
the size of the walk sheet's (94 px tall), puts the paws on the same bottom line, and
writes an N x 96 by 96 PNG with hard alpha like the sheets already in the app.

    python scripts/companion-sheet.py <input image> <output png> <frames> [--keep 1,3,4] [--match idle.png]

`--keep` writes only those frames (1-based, in the order given): for when the generator
spoiled one and the cycle still reads without it. `--match <sheet>` brings the brightness
in line with a sheet already in the app (one gain over the dog's pixels, hue and
saturation untouched): the generators drift darker between images.

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
    # The checkerboard: the grey that reaches the border, read through a slight dilation so
    # an anti-aliased seam does not cut a gap under the belly off from the outside.
    lab, _ = ndimage.label(ndimage.binary_dilation(greyish, iterations=2))
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    background = np.isin(lab, list(border))
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
    core = silhouette & ~greyish
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
    return dog


def match_colours(sheet: Image.Image, reference: str) -> Image.Image:
    """The sheet's dog lifted to the reference sheet's brightness: one gain on every channel, so hue and saturation keep their balance."""
    ref = np.array(Image.open(reference).convert('RGBA')).astype(float)
    out = np.array(sheet.convert('RGBA')).astype(float)
    ref_px = ref[..., :3][ref[..., 3] > 128]
    mask = out[..., 3] > 128
    out_px = out[..., :3][mask]
    gain = ref_px.max(1).mean() / max(1.0, out_px.max(1).mean())
    out[..., :3][mask] = np.clip(out_px * gain, 0, 255)
    print(f'colour gain {gain:.3f}')
    return Image.fromarray(out.astype(np.uint8))


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
    flat = Image.new('RGBA', src_im.size, (255, 255, 255, 255))
    flat.alpha_composite(src_im)
    rgb = np.array(flat.convert('RGB'))
    dog = cut_dog(rgb)
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
        f = Image.fromarray(c).resize((w, h), Image.LANCZOS)
        arr = np.array(f)
        arr[..., 3] = np.where(arr[..., 3] >= 128, 255, 0)
        f = Image.fromarray(arr)
        sheet.paste(f, (i * FRAME + (FRAME - w) // 2, PAW_Y - h + 1), f)
        print(f'frame {i + 1}: {w}x{h} at {s:.3f}')
    if '--match' in sys.argv:
        sheet = match_colours(sheet, sys.argv[sys.argv.index('--match') + 1])
    sheet.save(out)
    sheet.resize((FRAME * frames * 3, FRAME * 3), Image.NEAREST).save(out.replace('.png', '.preview.png'))
    print('wrote', out, 'and its 3x preview')


if __name__ == '__main__':
    main()
