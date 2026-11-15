"""Synthesise the game's tileable surface textures.

Every map is generated from seeded noise, so the textures are original and
can be rebuilt bit for bit. All noise is shaped in the frequency domain,
which makes every map tile seamlessly by construction.

Run inside Blender (uses its bundled NumPy and writes through bpy):

    blender -b --factory-startup -P assets/src/textures.py -- --out public/assets/tex

or with a system Python that has NumPy and Pillow, which is quicker while
tuning:

    python assets/src/textures.py --out public/assets/tex [--only limestone] [--size 1024]

Outputs, per material: <name>_albedo.jpg (sRGB), <name>_normal.jpg (tangent
space, +Y up, as glTF expects) and <name>_orm.jpg (R = 1, G = roughness,
B = metalness).

Materials follow docs/style-bible.md, section 4.
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

TAU = np.pi * 2


# ---------------------------------------------------------------------------
# Tileable building blocks
# ---------------------------------------------------------------------------

def _freq(n: int) -> tuple[np.ndarray, np.ndarray]:
    f = np.fft.fftfreq(n) * n
    return np.meshgrid(f, f, indexing="xy")


def spectral(n: int, seed: int, lo: float, hi: float, slope: float = 1.0,
             stretch: tuple[float, float] = (1.0, 1.0)) -> np.ndarray:
    """Band-limited noise in 0..1. `lo` and `hi` are cycles per tile; `slope` is the
    spectral falloff (higher = smoother). `stretch` > 1 on an axis elongates features along it."""
    rng = np.random.default_rng(seed)
    fx, fy = _freq(n)
    r = np.sqrt((fx * stretch[0]) ** 2 + (fy * stretch[1]) ** 2)
    amp = np.zeros_like(r)
    band = (r >= lo) & (r <= hi)
    amp[band] = 1.0 / np.maximum(r[band], 1e-6) ** slope
    phase = rng.uniform(0, TAU, (n, n))
    field = np.fft.ifft2(amp * np.exp(1j * phase)).real
    field -= field.min()
    return field / max(field.max(), 1e-12)


def contrast(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Remap so that `lo` becomes 0 and `hi` becomes 1, clipped."""
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def smooth(x: np.ndarray) -> np.ndarray:
    return x * x * (3.0 - 2.0 * x)


def blur(x: np.ndarray, sigma_px: float) -> np.ndarray:
    """Periodic Gaussian blur."""
    n = x.shape[0]
    fx, fy = _freq(n)
    k = np.exp(-2.0 * (np.pi * sigma_px / n) ** 2 * (fx ** 2 + fy ** 2))
    return np.fft.ifft2(np.fft.fft2(x) * k).real


def pits(n: int, seed: int, count: int, r_min: float, r_max: float, soft: float = 0.35) -> np.ndarray:
    """Scattered round pits, 1 at each centre falling to 0 at its rim. Radii in pixels at 1024."""
    rng = np.random.default_rng(seed)
    out = np.zeros((n, n))
    scale = n / 1024.0
    for _ in range(count):
        cx, cy = rng.uniform(0, n, 2)
        r = rng.uniform(r_min, r_max) * scale
        squash = rng.uniform(0.7, 1.0)
        pad = int(np.ceil(r)) + 2
        ys = (np.arange(-pad, pad + 1) + int(cy)) % n
        xs = (np.arange(-pad, pad + 1) + int(cx)) % n
        dy = (np.arange(-pad, pad + 1) - (cy - int(cy)))[:, None]
        dx = (np.arange(-pad, pad + 1) - (cx - int(cx)))[None, :]
        d = np.sqrt(dx ** 2 + (dy / squash) ** 2) / r
        shape = smooth(np.clip((1.0 - d) / soft, 0.0, 1.0))
        block = out[np.ix_(ys, xs)]
        out[np.ix_(ys, xs)] = np.maximum(block, shape)
    return out


def normal_from_height(h: np.ndarray, strength: float) -> np.ndarray:
    """Tangent-space normal map (+Y up) from a tileable height field. Returns RGB in 0..1."""
    n = h.shape[0]
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5 * n / 1024.0
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5 * n / 1024.0
    nx = -dx * strength
    ny = dy * strength          # image rows run downward; +Y up in tangent space
    nz = np.ones_like(h)
    inv = 1.0 / np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    return np.stack([nx * inv * 0.5 + 0.5, ny * inv * 0.5 + 0.5, nz * inv * 0.5 + 0.5], axis=-1)


def tint(value: np.ndarray, dark: tuple[float, float, float], light: tuple[float, float, float]) -> np.ndarray:
    """Colour a 0..1 field between two sRGB colours given as 0..255 triples."""
    d = np.array(dark) / 255.0
    l = np.array(light) / 255.0
    return d + (l - d) * value[..., None]


def orm(roughness: np.ndarray, metalness: float = 0.0) -> np.ndarray:
    return np.stack([np.ones_like(roughness), np.clip(roughness, 0, 1), np.full_like(roughness, metalness)], axis=-1)


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

def limestone(n: int) -> dict[str, np.ndarray]:
    """Honed bone limestone, close to travertine, for the Ivory pieces: warm and pale, mottled in
    large soft clouds, laid down in faint level beds (image rows, so they ring a standing piece),
    with a few small voids where a bed held one. It has no grain: at the size of a chess piece
    the stone is a smooth solid, and all of its character is in its colour."""
    cloud = spectral(n, 101, 1, 4, 1.9)                                # the big soft mottle
    mottle = spectral(n, 102, 3, 14, 1.7)
    beds = spectral(n, 103, 3, 34, 1.25, stretch=(9.0, 1.0))           # strata: long across, banded up and down
    laminae = spectral(n, 104, 14, 64, 1.3, stretch=(14.0, 1.0))       # hairlines inside the beds
    shown = smooth(contrast(spectral(n, 105, 1, 6, 1.6, stretch=(4.0, 1.0)), 0.3, 0.75))   # the bedding comes and goes
    voids = np.maximum(pits(n, 106, 18, 2.2, 5.5, 0.55), 0.7 * pits(n, 107, 30, 0.9, 1.8, 0.6))

    value = (0.6 + 0.44 * (cloud - 0.5) + 0.24 * (mottle - 0.5)
             + shown * (0.3 * (beds - 0.5) + 0.1 * (laminae - 0.5)) - 0.55 * voids)
    albedo = tint(np.clip(value, 0, 1), (188, 170, 138), (247, 239, 220))
    # Honey in some places, a cooler grey in others, and the darker beds a shade more tan.
    warm = spectral(n, 108, 1, 3, 1.9)[..., None]
    albedo = albedo * (1.0 + (warm - 0.5) * np.array([0.05, 0.0, -0.08]))
    tan = (shown * smooth(contrast(1.0 - beds, 0.5, 0.8)))[..., None]
    albedo = albedo * (1.0 - tan * np.array([0.0, 0.025, 0.07]))
    height = 0.04 * mottle + 0.05 * shown * beds - 1.0 * voids
    polish = smooth(contrast(spectral(n, 109, 1, 8, 1.6), 0.3, 0.7))
    rough = 0.62 - 0.1 * polish + 0.3 * voids + 0.06 * shown * (beds - 0.5)
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 0.8), 5.0), "orm": orm(rough)}


def basalt(n: int) -> dict[str, np.ndarray]:
    """Basalt close to obsidian, for the Void pieces: near-black with a cold green cast and a satin
    face, faint flow bands (image rows) that come and go, and a few fine vesicles. Like the
    limestone it has no grain, and no pale flecks to sparkle: its edges and its sheen do the work."""
    cloud = spectral(n, 201, 1, 4, 1.9)
    flow = spectral(n, 202, 3, 30, 1.3, stretch=(10.0, 1.0))           # flow banding: long across, banded up and down
    shown = smooth(contrast(spectral(n, 203, 1, 5, 1.6, stretch=(3.0, 1.0)), 0.4, 0.8))
    vesicles = pits(n, 204, 26, 1.0, 2.6, 0.5)
    polish = smooth(contrast(spectral(n, 206, 1, 7, 1.5), 0.3, 0.7))       # where the honing bit deeper

    value = 0.42 + 0.34 * (cloud - 0.5) + 0.3 * shown * (flow - 0.5) - 0.5 * vesicles
    albedo = tint(np.clip(value, 0, 1), (14, 18, 18), (52, 64, 60))
    height = 0.03 * shown * flow - 1.0 * vesicles
    rough = 0.44 - 0.1 * polish + 0.35 * vesicles + 0.05 * shown * (flow - 0.5)
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 0.8), 5.0), "orm": orm(rough)}


def brass(n: int) -> dict[str, np.ndarray]:
    """Aged gilt for the inlay: leaf laid over a dark ground, burnished in places and rubbed
    through to the ground in others. Pale and a little green in the gold, never orange."""
    brush = spectral(n, 501, 4, 500, 0.5, stretch=(0.02, 1.0))
    cloud = spectral(n, 502, 1, 8, 1.6)
    worn = smooth(contrast(spectral(n, 503, 5, 48, 1.1), 0.64, 0.9))        # rubbed back to the ground
    burnish = smooth(contrast(spectral(n, 505, 3, 26, 1.3), 0.5, 0.8))      # and polished by handling
    specks = pits(n, 504, 70, 0.8, 2.4, 0.5)
    value = np.clip(0.6 + 0.2 * (brush - 0.5) + 0.16 * (cloud - 0.5) + 0.16 * burnish - 0.3 * specks, 0, 1)
    albedo = tint(value, (132, 104, 52), (232, 198, 124))
    ground = (worn * 0.55)[..., None]
    albedo = albedo * (1 - ground) + ground * np.array([62, 50, 34]) / 255.0
    height = 0.3 * brush - 0.5 * specks - 0.25 * worn
    rough = 0.5 - 0.16 * burnish + 0.2 * worn + 0.1 * (brush - 0.5) + 0.2 * specks
    return {"albedo": albedo, "normal": normal_from_height(height, 5.0), "orm": orm(rough, 1.0)}


def limestone_honed(n: int) -> dict[str, np.ndarray]:
    """Honed bone limestone for the light squares: a dense, creamy bed ground flat and rubbed to a
    soft sheen. Shell fragments show as pale flecks and tan grains, the bedding as faint bands."""
    cloud = spectral(n, 601, 1, 5, 1.7)
    mottle = spectral(n, 602, 5, 36, 1.25)
    grit = spectral(n, 603, 140, 480, 0.0)
    shells = pits(n, 604, 260, 1.2, 4.2, 0.7)
    grains = pits(n, 605, 180, 0.9, 2.6, 0.6)
    pores = pits(n, 606, 60, 0.8, 2.2, 0.5)
    bedding = spectral(n, 610, 2, 16, 1.5, stretch=(3.0, 0.7))

    value = (0.56 + 0.22 * (cloud - 0.5) + 0.2 * (mottle - 0.5) + 0.14 * (bedding - 0.5) + 0.05 * (grit - 0.5)
             + 0.26 * shells - 0.26 * grains - 0.3 * pores)
    albedo = tint(np.clip(value, 0, 1), (178, 164, 136), (240, 232, 212))
    warm = spectral(n, 612, 1, 5, 1.8)[..., None]
    albedo = albedo * (1.0 + (warm - 0.5) * np.array([0.05, 0.0, -0.07]))
    height = 0.05 * grit + 0.04 * mottle - 0.6 * pores
    polish = smooth(contrast(spectral(n, 611, 2, 12, 1.5), 0.3, 0.75))
    rough = 0.52 - 0.12 * polish + 0.25 * pores + 0.04 * (grit - 0.5)
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 0.6), 6.0), "orm": orm(rough)}


def pieces_bone(n: int) -> dict[str, np.ndarray]:
    """Old bone ivory for the Ivory pieces, as if painted: broad soft clouds of cream and a warmer
    honey, the faint level growth lines of the tusk (image rows, so they ring a turned piece), and
    almost no relief. Its character is in its colour and in the way its edges wear pale."""
    cloud = spectral(n, 701, 1, 4, 2.0)
    wash = spectral(n, 702, 2, 9, 1.9)
    growth = spectral(n, 703, 6, 40, 1.4, stretch=(12.0, 1.0))
    shown = smooth(contrast(spectral(n, 704, 1, 5, 1.7, stretch=(3.0, 1.0)), 0.35, 0.8))
    value = 0.62 + 0.36 * (cloud - 0.5) + 0.16 * (wash - 0.5) + 0.12 * shown * (growth - 0.5)
    albedo = tint(np.clip(value, 0, 1), (200, 189, 166), (245, 239, 224))
    honey = smooth(contrast(spectral(n, 705, 1, 3, 2.0), 0.45, 0.85))[..., None]
    albedo = albedo * (1.0 - honey * np.array([0.0, 0.025, 0.07]))
    height = 0.03 * wash + 0.03 * shown * growth
    polish = smooth(contrast(spectral(n, 706, 1, 6, 1.7), 0.3, 0.7))
    rough = 0.5 - 0.08 * polish + 0.04 * shown * (growth - 0.5)
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 1.0), 3.0), "orm": orm(rough)}


def pieces_ebony(n: int) -> dict[str, np.ndarray]:
    """Ebony for the Void pieces: blue-black, with a fine dark grain that runs up the piece (image
    columns) and comes and goes, and a polished face, a little glossier where it was rubbed most."""
    cloud = spectral(n, 801, 1, 4, 2.0)
    grain = spectral(n, 802, 8, 60, 1.3, stretch=(1.0, 14.0))
    streak = spectral(n, 803, 3, 18, 1.5, stretch=(1.0, 8.0))
    shown = smooth(contrast(spectral(n, 804, 1, 5, 1.6, stretch=(1.0, 3.0)), 0.35, 0.8))
    value = 0.45 + 0.3 * (cloud - 0.5) + 0.22 * shown * (grain - 0.5) + 0.18 * (streak - 0.5)
    albedo = tint(np.clip(value, 0, 1), (9, 10, 13), (40, 42, 50))
    height = 0.04 * shown * grain
    polish = smooth(contrast(spectral(n, 805, 1, 6, 1.6), 0.3, 0.7))
    rough = 0.34 - 0.1 * polish + 0.05 * shown * (grain - 0.5)
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 0.8), 3.0), "orm": orm(rough)}


def _wave(n: int, rng: np.random.Generator, cycles: tuple[int, int], amp: float, slope: float = 1.2) -> np.ndarray:
    """A smooth 1D wander along a row of n samples that comes back to where it started (so the
    tile still tiles): a few whole-cycle sines, the slower ones the larger, `amp` pixels at most."""
    x = np.arange(n) / n
    out = np.zeros(n)
    for k in range(cycles[0], cycles[1] + 1):
        out += rng.normal() / k ** slope * np.sin(TAU * k * x + rng.uniform(0, TAU))
    return out * amp / max(np.abs(out).max(), 1e-9)


def _stroke(img: np.ndarray, cols: np.ndarray, ys: np.ndarray, width: np.ndarray, soft: float, weight: np.ndarray) -> None:
    """Draw a line that crosses the image column by column: at column `cols[i]` it is at row
    `ys[i]`, `width[i]` pixels thick (half to either side), with `soft` pixels of edge, and as
    strong as `weight[i]`. Distances are measured square to the line, and everything wraps."""
    n = img.shape[0]
    slope = np.gradient(ys)
    across = 1.0 / np.sqrt(1.0 + slope * slope)
    reach = int(np.ceil((width.max() / 2 + soft) / across.min())) + 2
    rows = np.arange(-reach, reach + 1)
    for c, y, w, a, k in zip(cols, ys, width, across, weight):
        if k <= 0.003:
            continue
        r = np.round(y).astype(int) + rows
        d = np.abs(r - y) * a
        v = k * (1.0 - smooth(np.clip((d - w / 2) / soft, 0.0, 1.0)))
        idx = r % n
        img[idx, c % n] = np.maximum(img[idx, c % n], v)


def _veins(n: int, seed: int, courses: list[tuple[float, int]], width: float, branches: int, threads: int):
    """Marble's veins, drawn as lines and not as the contours of a field, so that none of them
    closes on itself. Each course crosses the whole tile (the slope 0 courses along it, the slope
    1 ones corner to corner), wandering a little, with a sharp kink or two where the stone broke
    and healed, swelling and thinning along its length and here and there all but gone. Off each
    course a few branches split away at a narrow angle and taper out; and a few hair-fine threads
    cross the stone on their own. Sizes are in pixels at 1024. Returns (veins, branches, threads),
    each 0 to 1."""
    rng = np.random.default_rng(seed)
    scale = n / 1024.0
    cols = np.arange(n)
    x = cols / n
    strong = np.zeros((n, n))
    split = np.zeros((n, n))
    fine = np.zeros((n, n))
    for start, slope in courses:
        ys = start * n + slope * cols + _wave(n, rng, (1, 5), 0.055 * n, 1.5) + _wave(n, rng, (6, 20), 0.006 * n, 0.8)
        # Kinks: the line steps aside over a short run, and steps back elsewhere.
        for _ in range(2):
            at, back = rng.uniform(0, 1, 2)
            size = rng.uniform(0.015, 0.035) * n * rng.choice((-1, 1))
            run = rng.uniform(0.015, 0.04)
            ys += size * (np.clip((x - at) / run, 0, 1) - np.clip((x - back) / run, 0, 1))
        ys += _wave(n, rng, (20, 60), 1.2 * scale, 0.5)
        swell = 0.25 + 0.75 * smooth(np.clip(0.5 + 1.4 * _wave(n, rng, (1, 4), 1.0), 0.0, 1.0))
        fade = smooth(np.clip(0.3 + 1.6 * _wave(n, rng, (1, 3), 1.0), 0.0, 1.0))
        _stroke(strong, cols, ys, width * scale * swell, 0.8 * scale, 0.35 + 0.65 * fade)
        for _ in range(branches):
            length = int(rng.uniform(0.08, 0.26) * n)
            at = int(rng.uniform(0, n))
            span = cols[:length]
            part = (at + span) % n
            angle = rng.uniform(0.18, 0.55) * rng.choice((-1, 1))
            bys = ys[part] + angle * span + _wave(length, rng, (1, 3), 0.01 * n) * (span / length)
            taper = (1.0 - span / length) ** 0.7
            _stroke(split, part, bys, width * scale * 0.55 * swell[part] * taper + 0.4 * scale, 0.7 * scale,
                    (0.5 + 0.5 * fade[part]) * np.minimum(1.0, span / (0.02 * n) + 0.4))
    for _ in range(threads):
        slope = rng.choice((0, 1, -1))
        ys = rng.uniform(0, n) + slope * cols + _wave(n, rng, (1, 6), 0.07 * n)
        weight = smooth(np.clip(0.2 + 1.5 * _wave(n, rng, (1, 4), 1.0), 0.0, 1.0))
        _stroke(fine, cols, ys, np.full(n, 0.7 * scale), 0.8 * scale, weight)
    return strong, split, fine


def marble_light(n: int) -> dict[str, np.ndarray]:
    """The ivory squares: polished marble, cool and pale (a step darker and cooler than the bone
    of the stones that stand on it), clouded a little warmer in broad soft drifts, and crossed by
    faint grey veins that run most of the way across a square, with fine branches and threads.
    Polished, so smooth, with the veins a hair rougher than the stone round them."""
    strong, branch, threads = _veins(n, 701, [(0.12, 0), (0.55, 1), (0.78, 0)], 6.0, 2, 3)
    cloud = spectral(n, 710, 1, 6, 1.7)
    drift = spectral(n, 712, 2, 14, 1.4)
    value = 0.62 + 0.16 * (cloud - 0.5) + 0.08 * (drift - 0.5)
    albedo = tint(np.clip(value, 0, 1), (168, 174, 184), (226, 231, 238))
    warm = smooth(contrast(spectral(n, 713, 1, 4, 1.8), 0.35, 0.8))[..., None]
    albedo = albedo * (1.0 - 0.5 * warm) + 0.5 * warm * albedo.mean(axis=-1, keepdims=True) * np.array([1.04, 1.0, 0.94])
    haze = blur(strong, 4.0)
    vein = np.clip(0.55 * strong + 0.4 * branch + 0.2 * threads + 0.15 * haze, 0, 1)[..., None]
    albedo = albedo * (1.0 - vein) + vein * np.array([118, 124, 132]) / 255.0
    height = -0.25 * strong - 0.1 * branch + 0.02 * drift
    rough = 0.2 + 0.06 * (drift - 0.5) + 0.1 * strong
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 0.7), 2.0), "orm": orm(rough)}


def marble_dark(n: int) -> dict[str, np.ndarray]:
    """The dark squares: polished marble, slate-black in the body, a deep blue-green only where
    light falls on it, clouded with depths a shade greener or bluer, and crossed by sparse crisp white
    veins: one or two to a square, each most of the way across with a kink in it and a branch or
    two, and some squares nearly bare."""
    strong, branch, threads = _veins(n, 801, [(0.08, 0), (0.42, 1), (0.71, 0)], 2.8, 2, 2)
    cloud = spectral(n, 810, 1, 6, 1.7)
    deep = spectral(n, 812, 2, 16, 1.4)
    value = 0.42 + 0.3 * (cloud - 0.5) + 0.16 * (deep - 0.5)
    albedo = tint(np.clip(value, 0, 1), (7, 15, 17), (24, 44, 50))
    cast = spectral(n, 813, 1, 5, 1.7)[..., None]
    albedo = albedo * (1.0 + (cast - 0.5) * np.array([-0.08, 0.1, 0.06]))
    # Each vein is crisp at its heart, with a faint pale haze in the stone either side of it.
    halo = blur(strong, 3.5)
    vein = np.clip(0.97 * strong + 0.7 * branch + 0.3 * threads, 0, 1)[..., None]
    albedo = albedo + (0.08 * halo)[..., None] * np.array([0.5, 0.62, 0.6])
    albedo = albedo * (1.0 - vein) + vein * np.array([222, 230, 228]) / 255.0
    height = -0.2 * strong - 0.08 * branch + 0.02 * deep
    rough = 0.18 + 0.05 * (deep - 0.5) + 0.12 * strong
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 0.7), 2.0), "orm": orm(rough)}


def walnut(n: int) -> dict[str, np.ndarray]:
    """Walnut for the case: old and dark, an umber gone grey-brown with age, finished to a satin
    shine. Its figure is broad and quiet (long streaks that come and go, a soft flame here and
    there) because the case is painted in flat planes; only its pores give it a fine tooth.
    The grain runs along image rows (u), as the case lays its UVs along each rail."""
    streaks = spectral(n, 901, 2, 60, 1.1, stretch=(1.0, 0.08))
    figure = spectral(n, 902, 1, 8, 1.6, stretch=(1.0, 0.3))
    flame = smooth(contrast(spectral(n, 903, 2, 14, 1.4, stretch=(1.0, 0.5)), 0.55, 0.85))
    pores = spectral(n, 904, 120, 420, 0.2, stretch=(1.0, 0.05))
    cloud = spectral(n, 905, 1, 4, 1.8)
    value = 0.5 + 0.3 * (streaks - 0.5) + 0.18 * (figure - 0.5) + 0.12 * flame + 0.08 * (cloud - 0.5) - 0.12 * smooth(contrast(pores, 0.6, 0.9))
    value = np.clip(value, 0, 1)
    # A grey-brown where the wood is light, going a shade cooler in its darker streaks.
    albedo = tint(value, (30, 24, 23), (106, 85, 62))
    albedo = albedo * (1.0 + (1.0 - value[..., None]) * np.array([0.0, -0.03, 0.05]))
    cast = spectral(n, 906, 1, 3, 1.8)[..., None]
    albedo = albedo * (1.0 + (cast - 0.5) * np.array([0.04, -0.03, 0.06]))
    height = 0.2 * streaks - 0.5 * smooth(contrast(pores, 0.6, 0.9))
    rough = 0.5 + 0.08 * (streaks - 0.5) + 0.12 * smooth(contrast(pores, 0.6, 0.9)) - 0.06 * flame
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 0.6), 2.5), "orm": orm(rough)}


def baize(n: int) -> dict[str, np.ndarray]:
    """The lining of the drawers: a deep green baize, worn paler where stones have stood and
    been slid, with a fine nap and no shine at all."""
    nap = spectral(n, 951, 200, 500, 0.0)
    fibre = spectral(n, 952, 60, 300, 0.4, stretch=(1.0, 0.3))
    worn = smooth(contrast(spectral(n, 953, 2, 12, 1.5), 0.55, 0.85))
    cloud = spectral(n, 954, 1, 5, 1.7)
    value = 0.45 + 0.12 * (nap - 0.5) + 0.12 * (fibre - 0.5) + 0.18 * worn + 0.1 * (cloud - 0.5)
    albedo = tint(np.clip(value, 0, 1), (12, 30, 24), (46, 76, 60))
    height = 0.5 * nap + 0.3 * fibre
    rough = 0.94 - 0.06 * worn
    return {"albedo": albedo, "normal": normal_from_height(height, 1.5), "orm": orm(rough)}


def sandstone(n: int) -> dict[str, np.ndarray]:
    """Dressed sandstone for the chapel's walls, piers and vault: a warm grey-buff laid in ashlar
    courses, each block a shade apart and tooled across its face, with fine sand in it, a few
    darker iron spots, and thin joints of a paler lime mortar. Eight courses to a tile and three
    blocks to a course, so that a tile is seven units of wall."""
    rng = np.random.default_rng(1001)
    courses = 8
    yy, xx = np.meshgrid((np.arange(n) + 0.5) / n, (np.arange(n) + 0.5) / n, indexing="ij")
    row = np.minimum((yy * courses).astype(int), courses - 1)
    # Each course has its own run of block lengths, starting at its own place.
    block = np.zeros((n, n), dtype=int)
    joint_x = np.full((n, n), 1.0)
    for r in range(courses):
        lengths = rng.uniform(0.8, 1.2, 3)
        edges = np.concatenate([[0.0], np.cumsum(lengths)[:-1]]) / lengths.sum()
        edges = (edges + rng.uniform(0, 1)) % 1.0
        edges = np.sort(np.concatenate([edges, edges[:1] + 1.0, edges[-1:] - 1.0]))
        rows = row == r
        x = xx[rows]
        k = np.searchsorted(edges, x, side="right") - 1
        block[rows] = r * 16 + k
        joint_x[rows] = np.minimum(x - edges[k], edges[k + 1] - x)
    joint_y = np.abs(yy * courses - np.round(yy * courses)) / courses
    joint = np.minimum(joint_x, joint_y) * 1024.0                # distance to the nearest joint, in pixels at 1024
    mortar = np.exp(-(joint / 2.2) ** 2)
    arris = np.exp(-(joint / 7.0) ** 2)                           # each block's edge, a little worn back

    ids = np.unique(block)
    shade = np.zeros((n, n))
    for i in ids:
        shade[block == i] = rng.uniform(-1, 1)
    cloud = spectral(n, 1002, 1, 6, 1.6)
    mottle = spectral(n, 1003, 6, 40, 1.2)
    sand = spectral(n, 1004, 180, 500, 0.0)
    tooling = spectral(n, 1005, 20, 90, 0.8, stretch=(1.0, 0.12))   # fine strokes of the chisel across each face
    bedding = spectral(n, 1006, 3, 30, 1.3, stretch=(0.15, 1.0))     # the stone's own beds, lying level
    spots = pits(n, 1007, 50, 1.0, 3.0, 0.6)
    v = (0.52 + 0.08 * shade + 0.14 * (cloud - 0.5) + 0.12 * (mottle - 0.5) + 0.1 * (sand - 0.5)
         + 0.06 * (tooling - 0.5) + 0.08 * (bedding - 0.5) - 0.25 * spots - 0.08 * arris)
    albedo = tint(np.clip(v, 0, 1), (70, 60, 50), (176, 160, 136))
    albedo = albedo * (1 - mortar[..., None]) + mortar[..., None] * np.array([150, 144, 130]) / 255.0
    warm = spectral(n, 1008, 1, 4, 1.8)[..., None]
    albedo = albedo * (1.0 + (warm - 0.5) * np.array([0.06, 0.01, -0.06]))
    height = 0.2 * sand + 0.25 * tooling + 0.15 * bedding - 1.6 * mortar - 0.5 * arris - 0.4 * spots
    rough = 0.88 - 0.04 * shade + 0.04 * mortar
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 0.6), 5.0), "orm": orm(rough)}


def flagstone(n: int) -> dict[str, np.ndarray]:
    """The chapel's floor: one flag of a dense grey limestone, honed and worn to a dull polish
    where feet have passed, with fossil flecks, faint clouding and a few hairline veins. The
    shader lays the flags, two tones of them and their joints, so the tile has no joints of
    its own."""
    cloud = spectral(n, 1101, 1, 5, 1.7)
    mottle = spectral(n, 1102, 5, 30, 1.3)
    grain = spectral(n, 1103, 120, 400, 0.2)
    fossils = np.maximum(pits(n, 1104, 160, 0.8, 2.6, 0.5), 0.6 * pits(n, 1105, 30, 2.5, 5.5, 0.7))
    # Hairline veins, broken: they show only where a second field lets them.
    veins = _contours(spectral(n, 1106, 1, 4, 1.6), [0.35, 0.62], 0.7, 1.2) * smooth(contrast(spectral(n, 1109, 2, 10, 1.4), 0.45, 0.75))
    wear = smooth(contrast(spectral(n, 1107, 1, 6, 1.6), 0.4, 0.8))
    v = 0.5 + 0.18 * (cloud - 0.5) + 0.12 * (mottle - 0.5) + 0.06 * (grain - 0.5) + 0.22 * fossils - 0.06 * veins
    albedo = tint(np.clip(v, 0, 1), (64, 62, 58), (160, 154, 142))
    cool = spectral(n, 1108, 1, 3, 1.8)[..., None]
    albedo = albedo * (1.0 + (cool - 0.5) * np.array([-0.04, 0.0, 0.05]))
    height = 0.15 * grain - 0.3 * fossils - 0.2 * veins
    rough = 0.5 - 0.16 * wear + 0.1 * fossils
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 0.6), 2.0), "orm": orm(rough)}


def oak(n: int) -> dict[str, np.ndarray]:
    """Old oak for the doors and the chapel's timber: dark and dry, its grain open, the medullary
    rays showing as pale flecks, the surface waxed long ago and gone dull. Grain up the image's columns."""
    streaks = spectral(n, 1201, 3, 80, 1.0, stretch=(0.06, 1.0))
    figure = spectral(n, 1202, 1, 10, 1.5, stretch=(0.25, 1.0))
    rays = smooth(contrast(spectral(n, 1203, 30, 120, 0.4, stretch=(0.15, 1.0)), 0.7, 0.9))
    pores = spectral(n, 1204, 120, 420, 0.2, stretch=(0.04, 1.0))
    cloud = spectral(n, 1205, 1, 4, 1.8)
    open_pores = smooth(contrast(pores, 0.55, 0.85))
    v = 0.48 + 0.26 * (streaks - 0.5) + 0.18 * (figure - 0.5) + 0.1 * rays + 0.12 * (cloud - 0.5) - 0.16 * open_pores
    albedo = tint(np.clip(v, 0, 1), (34, 25, 18), (110, 84, 58))
    height = 0.35 * streaks - 0.8 * open_pores + 0.1 * rays
    rough = 0.72 + 0.08 * open_pores - 0.08 * rays
    return {"albedo": albedo, "normal": normal_from_height(blur(height, 0.5), 3.5), "orm": orm(rough)}


MATERIALS = {
    "limestone": limestone,
    "basalt": basalt,
    "brass": brass,
    "limestone_honed": limestone_honed,
    "pieces_bone": pieces_bone,
    "pieces_ebony": pieces_ebony,
    "marble_light": marble_light,
    "marble_dark": marble_dark,
    "walnut": walnut,
    "baize": baize,
    "sandstone": sandstone,
    "flagstone": flagstone,
    "oak": oak,
}


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def save(path: str, rgb: np.ndarray, is_colour: bool) -> None:
    """Write an RGB float image (rows top to bottom) as a JPEG."""
    data = np.clip(rgb, 0.0, 1.0)
    try:
        import bpy
    except ImportError:
        from PIL import Image
        Image.fromarray((data * 255.0 + 0.5).astype(np.uint8), "RGB").save(path, quality=93, subsampling=0)
        return
    h, w, _ = data.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    img.colorspace_settings.name = "sRGB" if is_colour else "Non-Color"
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = data[::-1]                      # Blender stores rows bottom to top
    img.pixels.foreach_set(rgba.ravel())
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 93
    scene.render.image_settings.color_mode = "RGB"
    # save_render would apply the view transform; write the stored values untouched instead.
    img.filepath_raw = path
    img.file_format = "JPEG"
    img.save(quality=93)
    bpy.data.images.remove(img)


def build(out_dir: str, size: int = 1024, only: str | None = None) -> None:
    out_dir = os.path.abspath(out_dir)      # Blender resolves relative image paths against its own base directory
    os.makedirs(out_dir, exist_ok=True)
    for name, make in MATERIALS.items():
        if only and name != only:
            continue
        maps = make(size)
        for kind, data in maps.items():
            save(os.path.join(out_dir, f"{name}_{kind}.jpg"), data, is_colour=(kind == "albedo"))
        print(f"texture {name}: " + ", ".join(f"{k} {v.shape[1]}x{v.shape[0]}" for k, v in maps.items()))


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/assets/tex")
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--only", default=None)
    a = ap.parse_args(argv)
    build(a.out, a.size, a.only)
