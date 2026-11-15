"""
The chapel's echo, as an impulse response: what one clap sounds like in a large concrete room.

It is built, not recorded. The first tenth of a second is the walls answering one at a time
(the reflections of a box of the chapel's size, heard from a seat by the board); after that
the room is too full to count, and is a wash of noise that dies away band by band, the low end
ringing for four seconds and the top for less than one, as bare concrete does.
"""
from __future__ import annotations

import numpy as np

from dsp import SR, bp, hp, lp, n

# The room: length, width, height in metres, and how much of a sound each surface gives back.
ROOM = (31.0, 15.0, 17.0)
GIVES_BACK = 0.93
SPEED = 343.0

# How long each band rings (seconds to fall 60 dB): octaves from 63 Hz up.
BANDS = [(20, 88, 4.4), (88, 177, 4.2), (177, 354, 3.8), (354, 707, 3.4), (707, 1414, 2.9), (1414, 2828, 2.3), (2828, 5657, 1.6), (5657, 11314, 0.95), (11314, 23000, 0.5)]


def chapel(seconds: float = 4.2, seed: int = 7, source=(15.5, 7.5, 1.2), ear=(15.5, 3.4, 2.0)) -> np.ndarray:
    """The room's answer, in stereo, without the sound itself (that is added by whoever uses it)."""
    rng = np.random.default_rng(seed)
    size = n(seconds)
    t = np.arange(size) / SR
    out = np.zeros((size, 2))

    # -- the wash -----------------------------------------------------------------
    for c in range(2):
        white = rng.normal(size=size)
        for lo, hi, t60 in BANDS:
            band = bp(white, lo, hi, 2)
            out[:, c] += band * 10 ** (-3 * t / t60) * (1.0 if lo > 100 else 1.25)
    # Low sound is as wide as the room, so both ears hear much the same of it.
    low = lp(out.mean(axis=1), 140, 2)
    for c in range(2):
        out[:, c] = hp(out[:, c], 140, 2) + low
    # It gathers: thin for the first instants, full after about a tenth of a second.
    gather = 1 / (1 + np.exp(-(t - 0.055) / 0.012))
    out = (out.T * gather).T
    out /= np.sqrt(np.mean(out[n(0.1):n(0.6)] ** 2))

    # -- the walls, one at a time --------------------------------------------------
    early = np.zeros((size, 2))
    lx, ly, lz = ROOM
    sx, sy, sz = source
    ex, ey, ez = ear
    direct = np.sqrt((sx - ex) ** 2 + (sy - ey) ** 2 + (sz - ez) ** 2)
    order = 3
    for ix in range(-order, order + 1):
        for iy in range(-order, order + 1):
            for iz in range(-order, order + 1):
                bounces = abs(ix) + abs(iy) + abs(iz)
                if bounces == 0 or bounces > order:
                    continue
                # Where the sound seems to come from after these bounces.
                px = ix * lx + (sx if ix % 2 == 0 else lx - sx)
                py = iy * ly + (sy if iy % 2 == 0 else ly - sy)
                pz = iz * lz + (sz if iz % 2 == 0 else lz - sz)
                d = np.sqrt((px - ex) ** 2 + (py - ey) ** 2 + (pz - ez) ** 2)
                when = (d - direct) / SPEED + 0.004
                level = (direct / d) * GIVES_BACK ** bounces
                side = np.clip((px - ex) / d, -1, 1)
                # A little later and duller in the far ear.
                for c, s in ((0, -side), (1, side)):
                    at = n(when + 0.00032 * max(0.0, -s))
                    if at + 64 < size:
                        g = level * np.sqrt(0.5 * (1 + 0.7 * s))
                        # Each bounce off rough concrete smears it a little: a short burst, not a click.
                        width = 6 + 10 * bounces
                        burst = rng.normal(size=width) * np.hanning(width)
                        early[at:at + width, c] += g * burst / np.sqrt(np.sum(burst ** 2))
    early = lp(early, 9000, 1)
    out = out * 0.5 + early * 9.0
    # Leave a moment of silence before the first wall answers, and end in silence.
    fade = np.clip((seconds - t) / 0.4, 0, 1)
    out = (out.T * fade).T
    # One clap's worth of room: the same energy whatever the settings above.
    out /= np.sqrt(np.sum(out ** 2) / 2)
    return out


if __name__ == '__main__':
    import sys

    from dsp import save

    ir = chapel()
    save(sys.argv[1] if len(sys.argv) > 1 else 'hall.wav', ir * 0.5, 'PCM_24')
