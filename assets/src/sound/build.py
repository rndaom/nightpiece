"""
Builds every sound the game plays, from recordings, into public/assets/sound/.

  uv run --with numpy --with scipy --with soundfile python assets/src/sound/build.py [--only name,name] [--wav folder]

Nothing here is an oscillator. Stone is recordings of stone; the bells are tubular bells; the
room's drone is a bowed double bass, a bowed vibraphone and wine glasses; the stingers are an
orchestra's strings, drums and gong. Each sound is cut, tuned, layered and shaped here, and
written out dry: the game adds the chapel's echo itself, so that everything is heard in one room.

The recordings are not kept in git. `fetch.py` gets them again from `sources.json` (which this
script rewrites with exactly the files it opened); CREDITS.md says whose they are.

What is written:
  foley.flac    every short sound that is placed in the room, one after another, mono
  moments.flac  the set pieces (check, mate, the bell, ...), stereo
  hall.flac     the chapel's echo
  bed-*.mp3     the room's own sound, in loops
  sounds.json   where each sound is in those files
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.parse

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dsp  # noqa: E402
from dsp import SR, bell, bp, cut, db, decay, fade, glide, hp, limit, loopable, lp, mix, mono, n, norm, pan, pitch, punch, reverse, room, secs, shape, shelf, stereo, swell, trim, warm, widen  # noqa: E402
from hall import chapel  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
CACHE = os.path.join(HERE, 'cache')
OUT = os.path.join(ROOT, 'public', 'assets', 'sound')

RNG = np.random.default_rng(1911)

# -- finding recordings ------------------------------------------------------------

def find(pattern: str) -> str:
    """The one recording in the cache whose path matches (a glob under cache/)."""
    hits = sorted(glob.glob(os.path.join(CACHE, pattern), recursive=True))
    if not hits:
        raise FileNotFoundError(f'no recording matches {pattern}; run fetch.py')
    return hits[0]


def take(pattern: str, level_db: float = -3.0, keep_stereo: bool = False, lead: float = 0.002) -> np.ndarray:
    """A recording with the silence cut off its ends, brought to a known level."""
    x = dsp.load(find(pattern), mono=not keep_stereo)
    return norm(trim(x, -40, lead), level_db)


NOTES = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def midi(name: str) -> int:
    m = re.fullmatch(r'([A-G])(#|b)?(-?\d)', name)
    assert m, name
    return 12 * (int(m.group(3)) + 1) + NOTES[m.group(1)] + {'#': 1, 'b': -1, None: 0}[m.group(2)]


def tuned(pattern: str, has: str, want: str, **kw) -> np.ndarray:
    """A recorded note moved to another pitch by playing it faster or slower."""
    return pitch(take(pattern, **kw), midi(want) - midi(has))


def pad(x: np.ndarray, length: float, grain: float = 0.5, begin: float = 0.25, end: float = 0.2, seed: int = 0, wander: float = 0.0) -> np.ndarray:
    """
    A held note made endless: short overlapping pieces of its steady middle, taken from here
    and there, so that it goes on as long as wanted without the loop being heard.
    `wander` detunes each piece by up to that many cents either way, which thickens it.
    """
    rng = np.random.default_rng(seed)
    a, b = n(begin), len(x) - n(end) - n(grain)
    assert b > a, 'the note is too short to hold'
    size, g = n(length), n(grain)
    out = np.zeros((size + g,) + x.shape[1:])
    window = np.hanning(g)
    hop = g // 4
    for at in range(0, size, hop):
        start = int(rng.integers(a, b))
        piece = x[start:start + g + 64]
        if wander:
            piece = pitch(piece, rng.uniform(-wander, wander) / 100)
        piece = piece[:g]
        out[at:at + len(piece)] += (piece.T * window[:len(piece)]).T
    return out[:size] / 2.0


def strike(x: np.ndarray, lead: float = 0.001, part: float = 0.15) -> np.ndarray:
    """A hit cut so that it begins a millisecond in, and ends when it has died away."""
    e = np.abs(mono(x))
    p = e.max()
    if p == 0:
        return x
    a = max(0, int(np.argmax(e > p * part)) - n(lead))
    heard = np.nonzero(e[a:] > p * db(-60))[0]
    y = x[a:a + (heard[-1] + n(0.02) if len(heard) else len(x))]
    return fade(y, 0.0003, min(0.012, secs(y) / 4))


def clip(pattern: str, start: float = 0.0, length: float | None = None, level_db: float = -3.0, keep_stereo: bool = False) -> np.ndarray:
    """One sound out of a recording of several: the part from `start`, `length` seconds long."""
    x = dsp.load(find(pattern), mono=not keep_stereo)
    if length is not None:
        x = x[max(0, n(start - 0.02)):n(start + length + 0.04)]
    elif start:
        x = x[n(start):]
    return norm(strike(x), level_db)


def loudest(x: np.ndarray, length: float, count: int) -> list[int]:
    """Where the `count` loudest stretches of `length` seconds begin (they do not overlap)."""
    size = n(length)
    total = np.concatenate([[0.0], np.cumsum(mono(x) ** 2)])
    power = total[size:] - total[:-size]
    out: list[int] = []
    for _ in range(count):
        if power.max() <= 0:
            break
        i = int(np.argmax(power))
        out.append(i)
        power[max(0, i - size):i + size] = 0
    return out


# -- what the game will be given ---------------------------------------------------

FOLEY: dict[str, list[np.ndarray]] = {}
MOMENTS: dict[str, list[np.ndarray]] = {}
BEDS: dict[str, np.ndarray] = {}
HALL = chapel()


def in_hall(x: np.ndarray, wet_db: float = -16.0) -> np.ndarray:
    """With a little of the chapel already on it, for sounds that are their own event."""
    return room(x, HALL, wet_db)


def finish(x: np.ndarray, level_db: float = -1.0, tail: float = 0.03) -> np.ndarray:
    """Ready to be played: no rumble below hearing, peaks held, ends in silence."""
    x = hp(x, 28, 2)
    x = limit(norm(x, level_db + 1.5), level_db)
    return fade(x, 0.0005, tail)


# -- the bell, the stingers, the set pieces ----------------------------------------

def make_bell() -> None:
    """A sacrifice: one low bell, with a gong under it so that it is felt as well as heard."""
    takes = []
    for note, dyn, low in (('C3', 'f', 0), ('D3', 'ff', -2)):
        chime = pitch(take(f'instruments/VCSL/**/Tubular Bells 1/chimes_{note}_{dyn}_rr1.wav', keep_stereo=True), low)
        gong = lp(take('instruments/VCSL/**/Gong 1/gong_p.wav', keep_stereo=True), 500, 2)
        x = mix([(chime, 0, 0), (fade(cut(gong, 0, 4.6), 0, 1.5), 0.0, -9)], channels=2)
        x = shape(x, swell(secs(x), 0.0, 2.2, None, 1.5))[:n(4.6)]
        takes.append(finish(fade(x, 0, 1.2), -2))
    MOMENTS['bell'] = takes


def make_check() -> None:
    """Check: two bell notes, the second lower, over a drum and a low string that shivers."""
    takes = []
    for first, second, gap in ((('G#3', 'ff'), ('D3', 'ff'), 0.34), (('A#3', 'ff'), ('E3', 'ff'), 0.31)):
        a = take(f'instruments/VCSL/**/Tubular Bells 1/chimes_{first[0]}_{first[1]}_rr1.wav', keep_stereo=True)
        b = take(f'instruments/VCSL/**/Tubular Bells 1/chimes_{second[0]}_{second[1]}_rr*.wav', keep_stereo=True)
        drum = take('instruments/VCSL/**/Bass Drum 1/BDrumNew_hit_v5_rr1_Sum.wav', keep_stereo=True)
        drum = lp(drum, 900, 2)
        shiver = take('instruments/VSCO-2-CE/Strings/Solo Contrabass/Trem/BKCtbss_Trem_E0_v2_rr1.wav', keep_stereo=True)
        shiver = shape(cut(pitch(shiver, -1), 0.15, 2.8), swell(2.8, 0.5, 0.5, 1.8, 1.6))
        x = mix([(drum, 0, -3), (a, 0.0, -5), (b, gap, -3), (shiver, 0.05, -11)], channels=2)
        x = x[:n(3.4)]
        takes.append(finish(fade(x, 0, 1.4), -1.5))
    MOMENTS['check'] = takes


def make_fork() -> None:
    """A fork: two notes struck hard, one on the heels of the other, by low strings."""
    takes = []
    for lo, hi, rr in (('E1', 'A#0', 1), ('E1', 'A#0', 2)):
        one = pitch(take(f'instruments/VSCO-2-CE/Strings/Solo Contrabass/Spic/BKCtbss_Spic_E1_v3_rr{rr}.wav', keep_stereo=True), -1)
        two = pitch(take(f'instruments/VSCO-2-CE/Strings/Solo Contrabass/Spic/BKCtbss_Spic_E2_v1_rr{rr}.wav', keep_stereo=True), 5)
        celli = pitch(take(f'instruments/VSCO-2-CE/Strings/Cello Section/spic/spic_E3_v2_RR{rr}.wav', keep_stereo=True), -1)
        x = mix([(one, 0, -2), (celli, 0.0, -8), (two, 0.09, -3)], channels=2)
        x = decay(x, 1.6)[:n(1.1)]
        takes.append(finish(x, -2))
    MOMENTS['fork'] = takes


def make_reveal() -> None:
    """A discovered attack: a cymbal's breath drawn backwards into a low stroke."""
    takes = []
    for cym, level in (('susCymb1_hit_mp1', 0), ('susCymb1_hit_pp1', 2)):
        breath = take(f'instruments/VCSL/**/Suspended Cymbal 1/{cym}.wav', keep_stereo=True)
        breath = reverse(fade(cut(breath, 0.0, 0.5), 0.002, 0.15))
        breath = hp(shape(breath, swell(0.5, 0.36, 0.0, 0.14, 2.4)), 500, 2)
        stroke = pitch(take('instruments/VSCO-2-CE/Strings/Solo Contrabass/Spic/BKCtbss_Spic_A1_v1_rr1.wav', keep_stereo=True), 0)
        drum = lp(take('instruments/VCSL/**/Bass Drum 1/BDrumNew_hit_v3_rr1_Sum.wav', keep_stereo=True), 400, 2)
        x = mix([(breath, 0, -12 + level), (stroke, 0.36, -2), (drum, 0.36, -8)], channels=2)
        x = decay(x, 1.5, 0.4)[:n(1.3)]
        takes.append(finish(x, -2))
    MOMENTS['reveal'] = takes


def make_fall() -> None:
    """A blunder: a bowed bass note that gives way to the one below it, and a soft drum under the first."""
    takes = []
    bass = lambda note, v: take(f'instruments/VSCO-2-CE/Strings/Solo Contrabass/SusNV/BKCtbss_SusNV_{note}_v{v}_rr1.wav', keep_stereo=True)
    for first, second, v in ((('A1', 1), ('A1', 0), 3), (('G#1', 0), ('G#1', -1), 3)):
        one = shape(cut(pitch(bass(first[0], v), first[1]), 0.05, 0.8), swell(0.8, 0.04, 0.3, None, 1.6))
        two = shape(cut(pitch(bass(second[0], 1), second[1]), 0.05, 1.5), swell(1.5, 0.22, 0.1, None, 1.8))
        thud = lp(take('instruments/VCSL/**/Bass Drum 2/bassdrum_hit_pp1.wav', keep_stereo=True), 300, 2)
        x = mix([(one, 0, -3), (lp(two, 900, 2), 0.34, -2), (thud, 0.0, -8)], channels=2)[:n(1.85)]
        takes.append(finish(fade(x, 0, 0.5), -3))
    MOMENTS['fall'] = takes


def make_rise() -> None:
    """A strong move: a harp runs up, and glasses and a bowed vibraphone open over it."""
    takes = []
    harp = lambda note, dyn='mf1': take(f'instruments/VCSL/**/Concert Harp/KSHarp_{note}_{dyn}.wav', keep_stereo=True)
    runs = (
        [('D4', 'D#4'), ('F4', 'F#4'), ('A4', 'A#4'), ('D6', 'D#5'), ('F6', 'F#5')],
        [('D4', 'D#4'), ('A4', 'A#4'), ('C5', 'C#5'), ('D6', 'D#5'), ('F6', 'A#5')],
    )
    for k, run in enumerate(runs):
        parts = []
        for i, (has, want) in enumerate(run):
            note = pitch(harp(has), midi(want) - midi(has))
            parts.append((fade(cut(note, 0, 2.6), 0, 1.0), 0.075 * i + 0.004 * i * i, -8 - (1.5 if i == 0 else 0), -0.5 + i * 0.25))
        glasses = []
        for g, name in enumerate(('glass1_D#4_Slow_1_Main', 'glass3_A#4_Slow_1_Main', 'glass2_F#4_Slow_1_Main')):
            held = pad(take(f'instruments/VCSL/**/Wine Glasses/Sustains/Slow/{name}.wav', keep_stereo=True), 2.6, 0.4, 0.6, 0.4, seed=k * 7 + g)
            glasses.append((shape(held, swell(2.6, 0.5 + 0.12 * g, 0.3, 1.6, 1.8)), 0.12, -17, 0.0))
        vibes = pitch(take('instruments/VCSL/**/Vibraphone/Bowed/Vibes_bowed_D4_rr1_Main.wav', keep_stereo=True), 1)
        vibes = shape(cut(vibes, 0, 2.8), swell(2.8, 0.6, 0.4, 1.8, 1.6))
        x = mix(parts + glasses + [(vibes, 0.1, -16, 0.0)], channels=2)[:n(3.0)]
        takes.append(finish(fade(x, 0, 1.2), -3))
    MOMENTS['rise'] = takes


def make_mate() -> None:
    """
    Mate: the room is struck; strings gather into a cluster, hold, and every voice slides down
    by a different amount into silence.
    """
    struck = mix([
        (take('instruments/VCSL/**/Bass Drum 2/bassdrum_hit_ff.wav', keep_stereo=True), 0, 0),
        (lp(clip(f'{A}/low_boom/fs-door-smash-1-218890.ogg', 1.28, 3.0, keep_stereo=True), 320, 2), 0.0, -5),
        (lp(take('instruments/VCSL/**/Gong 1/gong_f.wav', keep_stereo=True), 2500, 2)[:n(5.2)], 0.0, -6),
        (take('instruments/VCSL/**/Timpani 1/Hit/Timpani1_Hit_v4_rr1_Sum.wav', keep_stereo=True), 0.0, -8),
    ], channels=2)
    voices = [
        ('instruments/VSCO-2-CE/Strings/Cello Section/trem/trem_G1_v2_1.wav', 0, -4, -0.3, 7),
        ('instruments/VSCO-2-CE/Strings/Cello Section/trem/trem_G3_v2_1.wav', 0, -6, 0.2, 9),
        ('instruments/VSCO-2-CE/Strings/Cello Section/trem/trem_G3_v2_1.wav', 1, -7, -0.2, 12),
        ('instruments/VSCO-2-CE/Strings/Viola Section/trem/Violas_trem_C4_v2_rr1.wav', 0, -7, 0.4, 10),
        ('instruments/VSCO-2-CE/Strings/Viola Section/trem/Violas_trem_C4_v2_rr1.wav', 1, -8, -0.5, 14),
        ('instruments/VSCO-2-CE/Strings/Violin Section/Trem/VlnEns_Trem_E4_v2.wav', 3, -9, 0.6, 11),
        ('instruments/VSCO-2-CE/Strings/Violin Section/Trem/VlnEns_Trem_E4_v2.wav', 4, -10, -0.6, 16),
    ]
    cluster = []
    for i, (pattern, up, level, where, sink) in enumerate(voices):
        v = take(pattern, keep_stereo=True)
        held = pad(pitch(v, up), 4.6, 0.45, 0.4, 0.5, seed=40 + i)
        fallen = glide(held, lambda t, s=sink: -s * (max(0.0, (t - 2.6) / 1.7) ** 1.6), 4.6)
        cluster.append((shape(fallen, swell(secs(fallen), 1.3, 1.3, None, 1.8)), 0.0, level, where))
    # The board's plates go over, one after another, across the room.
    plates = []
    for i in range(14):
        tile = FOLEY['clack'][(i * 3) % len(FOLEY['clack'])]
        plates.append((pitch(tile, -3 + (i * 5) % 7), 0.5 + i * 0.16 + 0.02 * ((i * 7) % 3), -15 - 0.4 * i, -0.8 + 1.6 * ((i * 0.381966) % 1)))
    # Voices: a crowd holding one vowel, twice a semitone apart, and one man's low note far under
    # them, all sinking with the strings.
    ooh = take(f'{B}/breath_voice/fs-763894.mp3', keep_stereo=True)
    low = norm(dsp.load(find(f'{B}/breath_voice/fs-8067.mp3'), mono=False)[n(5.0):n(13.0)], -3)
    for i, (voice, shift, level, where, sink) in enumerate(((ooh, -2.28, -9, -0.35, 8), (ooh, -1.28, -11, 0.35, 13), (low, 1.0, -8, 0.0, 6))):
        held = pad(pitch(voice, shift), 4.6, 0.6, 1.2, 1.5, seed=60 + i, wander=6)
        fallen = glide(held, lambda t, s=sink: -s * (max(0.0, (t - 2.6) / 1.7) ** 1.6), 4.6)
        cluster.append((lp(shape(fallen, swell(secs(fallen), 1.6, 1.0, None, 1.8)), 5000, 1), 0.0, level, where))
    x = mix([(struck, 0, -1)] + cluster + plates, channels=2)[:n(5.2)]
    MOMENTS['mate'] = [finish(fade(x, 0, 0.6), -1)]


# -- stone --------------------------------------------------------------------------

A = 'foley-a'
B = 'foley-b'
ROCKS = f'{A}/stone_impact/fs-rock-stone-hits-b-179360.ogg'
COBBLES = f'{A}/stone_impact/fs-cobblestone-blocks-268055.ogg'
DROPS = f'{A}/stone_impact/fs-stone-drop-ground-369981.ogg'
TUMBLE = f'{A}/rock_crack/fs-tumbling-rocks-stairs-488660.ogg'

# Where each separate hit is in those recordings: (start, length) in seconds.
KNOCKS = [(ROCKS, 2.29, 0.28), (ROCKS, 16.68, 0.27), (ROCKS, 0.75, 0.4), (ROCKS, 10.42, 0.45), (ROCKS, 20.33, 0.42), (ROCKS, 15.39, 0.11), (ROCKS, 25.58, 0.5),
          (f'{A}/stone_impact/fs-stone-knock-530354.ogg', 0.01, 0.6), (f'{A}/stone_impact/fs-stone-on-stone-bounce-364711.ogg', 0.0, 0.42)]
BODIES = [(COBBLES, 2.97, 0.22), (COBBLES, 12.02, 0.34), (COBBLES, 11.22, 0.34), (COBBLES, 1.62, 0.23), (COBBLES, 17.57, 0.27), (COBBLES, 0.24, 0.23),
          (COBBLES, 5.42, 0.22), (COBBLES, 12.86, 0.29), (COBBLES, 14.55, 0.18), (COBBLES, 4.21, 0.26)]
SUBS = [(DROPS, 0.48, 0.46), (DROPS, 13.16, 0.7), (DROPS, 18.81, 0.6), (DROPS, 24.51, 0.7)]
PEBBLES = [(TUMBLE, 0.62, 0.06), (TUMBLE, 2.65, 0.05), (TUMBLE, 2.74, 0.04), (TUMBLE, 4.53, 0.07), (TUMBLE, 0.79, 0.08), (TUMBLE, 3.16, 0.12)]

# A stone set down. Limestone (pale) is the brighter knock over a little of the heavy block;
# basalt (dark) is the heavy block itself, with the knock far back. `knock` and `body` are
# (semitones, level in dB); `settle` is how loud the slabs round it are heard dropping back.
SETS = {
    ('pale', 'light'): dict(knock=(1, 0), body=(2, -7), settle=None),
    ('pale', 'mid'): dict(knock=(0, 0), body=(2, -5), settle=-27),
    ('pale', 'heavy'): dict(knock=(-2, -1), body=(0, -2), settle=-23),
    ('dark', 'light'): dict(knock=(-2, -8), body=(2, 0), settle=None),
    ('dark', 'mid'): dict(knock=(-5, -9), body=(0, 0), settle=-28),
    ('dark', 'heavy'): dict(knock=(-7, -10), body=(-3, 0), settle=-24),
}
HEFT = {'light': 0, 'mid': 1, 'heavy': 2}


def make_stone() -> None:
    """Stone set on stone, in six weights and colours, four takes of each; and stone leaving stone."""
    for (colour, weight), r in SETS.items():
        heft = HEFT[weight]
        takes = []
        for i in range(4):
            k = KNOCKS[(i * 2 + (0 if colour == 'pale' else 3) + len(weight)) % len(KNOCKS)]
            b = BODIES[(i * 3 + (1 if colour == 'pale' else 0) + len(weight)) % len(BODIES)]
            # The knock and the block; under them the slab it lands on, and the floor under that.
            # The heavier the stone, the more of the slab and the floor.
            slab = lp(clip(*SUBS[(i + 1) % len(SUBS)]), 420, 2)
            floor = lp(clip(*SUBS[i % len(SUBS)]), 160, 2)
            parts = [(pitch(clip(*k), r['knock'][0]), 0, r['knock'][1]), (pitch(clip(*b), r['body'][0]), 0, r['body'][1]), (slab, 0.004, -10 + 3 * heft), (floor, 0.0, -14 + 4 * heft)]
            if r['settle'] is not None:
                # The slabs round it lift and drop back: a few small knocks, each later and quieter.
                rng = np.random.default_rng(100 + i + len(weight) * 10 + (0 if colour == 'pale' else 50))
                for j in range(4 if weight == 'heavy' else 3):
                    tick = pitch(clip(*PEBBLES[int(rng.integers(len(PEBBLES)))]), float(rng.uniform(-6, 2)) - (0 if colour == 'pale' else 3))
                    parts.append((lp(tick, 5000, 1), 0.1 + 0.075 * j + float(rng.uniform(0, 0.03)), r['settle'] - 2.5 * j))
            # Pressed together, so that it is one dense sound and not a click with something under it.
            x = warm(norm(mix(parts), -4), 7)
            if colour == 'pale':
                x = bell(shelf(x, 3200, 2.5), 260, -2, 1.0)
            else:
                x = bell(shelf(x, 4500, -4), 150, 3, 0.9)
            x = decay(x, 0.7 + 0.35 * heft, 0.03)[:n(0.5 + 0.25 * heft)]
            takes.append(finish(x, -1, 0.08))
        FOLEY[f'set.{colour}.{weight}'] = takes

    # A stone leaves its square: a short dry scrape. Granite dragged over a cement floor and a
    # cinder block over concrete; basalt is the same played lower.
    granite = f'{A}/stone_scrape/fs-granite-block-move-543703.ogg'
    cinder = f'{A}/stone_scrape/oga-cinderblock-scrape-03.wav'
    scrapes = {
        'pale': [(granite, 1.96, 0), (granite, 4.23, 0), (cinder, 1.01, -4), (granite, 0.41, 0)],
        'dark': [(granite, 1.96, -4), (granite, 0.41, -4), (granite, 1.96, -2), (granite, 4.23, -2)],
    }
    for colour, sources in scrapes.items():
        takes = []
        for i, (path, start, shift) in enumerate(sources):
            whole = dsp.load(find(path))
            length = 0.26 + 0.03 * (i % 2)
            x = pitch(whole[n(start):n(start + length * 2 ** (shift / 12))], shift)
            x = hp(shape(x, swell(secs(x), 0.012, 0.03, None, 2.2)), 150, 2)
            if colour == 'dark':
                x = shelf(x, 5000, -3)
            takes.append(finish(norm(x, -3), -3, 0.04))
        FOLEY[f'lift.{colour}'] = takes


def make_breaks() -> None:
    """A stone struck and taken; the dry snaps of a crack running through the board; the slab giving way."""
    smash = f'{A}/rock_crack/fs-rock-smash-512243.ogg'
    hits = [(smash, 2.66, 0.6), (smash, 4.07, 0.7), (f'{A}/rock_crack/fs-stone-falls-breaks-109360.ogg', 0.0, 0.7), (f'{A}/rock_crack/fs-rock-destroy-524312.ogg', 0.0, 0.7)]
    snaps = [(TUMBLE, 0.0, 0.09), (TUMBLE, 1.5, 0.16), (TUMBLE, 4.16, 0.06), (f'{A}/rock_crack/fs-kirkstall-rock-crumble-262118.ogg', 0.09, 0.3)]
    rubble = dsp.load(find(f'{A}/rock_crack/fs-stones-falls-debris-550342.ogg'))
    takes = []
    for i in range(4):
        start = loudest(rubble[n(4.9):n(9.0)], 0.55, 4)[i] + n(4.9)
        debris = shape(norm(rubble[start:start + n(0.55)], -3), swell(0.55, 0.02, 0.1, None, 1.8))
        x = mix([(clip(*hits[i]), 0, 0), (clip(*snaps[i]), 0.0, -2), (hp(debris, 600, 2), 0.06, -15)])
        x = decay(punch(x, 3), 0.85, 0.03)[:n(0.9)]
        takes.append(finish(x, -1, 0.06))
    FOLEY['crack'] = takes

    # The snaps: small rocks knocking and breaking, each a tenth of a second.
    hits_a = f'{A}/stone_impact/fs-rock-stone-hits-a-179365.ogg'
    broken = f'{A}/rock_crack/oga-bfh1-rock-breaking-02.ogg'
    sources = [(TUMBLE, 0.79, 0.09, -3), (TUMBLE, 1.5, 0.16, 0), (TUMBLE, 0.0, 0.09, -3), (hits_a, 14.33, 0.08, 0), (hits_a, 1.72, 0.09, 0), (hits_a, 10.06, 0.07, -3),
               (hits_a, 1.72, 0.09, -2), (broken, 0.0, 0.13, -3), (hits_a, 8.62, 0.09, 0), (broken, 0.16, 0.1, -3),
               (hits_a, 11.63, 0.1, -3), (TUMBLE, 4.16, 0.16, 0)]
    FOLEY['snap'] = [finish(decay(pitch(clip(path, start, length), shift), 0.22)[:n(0.2)], -2, 0.03) for path, start, length, shift in sources]

    # The slab giving: a heavy stone ground over stone.
    slab = dsp.load(find(f'{A}/stone_scrape/fs-slab-grinding-heavy-844329.ogg'))
    takes = []
    for start in loudest(slab, 1.4, 3):
        x = shape(slab[start:start + n(1.4)], swell(1.4, 0.3, 0.25, None, 1.6))
        takes.append(finish(lp(norm(x, -3), 2600, 2), -3, 0.1))
    FOLEY['grind'] = takes

    # Glazed tiles knocking together, for the board's plates.
    plates = f'{A}/ceramic_clack/fs-plates-set-down-420440.ogg'
    FOLEY['clack'] = [finish(decay(clip(plates, start, length), 0.3)[:n(0.3)], -2, 0.03)
                      for start, length in ((10.04, 0.37), (24.55, 0.35), (18.52, 0.33), (28.23, 0.38), (14.58, 0.33), (26.32, 0.28), (2.75, 0.22), (31.91, 0.2))]


# -- glass --------------------------------------------------------------------------

# Three glasses, and the note each one rings at (measured).
GLASSES = [(f'{A}/glass/fs-wine-glass-hard-198401.ogg', 713.0), (f'{A}/glass/fs-crystal-wine-clink-178178.ogg', 875.0), (f'{A}/glass/fs-champagne-flute-hard-198388.ogg', 1000.0)]
# The eight steps the game plays: E flat minor pentatonic from E flat 5, the key the room is in.
STEPS = ['D#5', 'F#5', 'G#5', 'A#5', 'C#6', 'D#6', 'F#6', 'G#6']


def hz(name: str) -> float:
    return 440.0 * 2 ** ((midi(name) - 69) / 12)


def glass_note(name: str, which: int = 0, length: float = 1.5) -> np.ndarray:
    """A struck glass at a given note: whichever real glass is nearest it (or the next nearest)."""
    want = hz(name)
    order = sorted(GLASSES, key=lambda g: abs(np.log2(want / g[1])))
    path, has = order[min(which, len(order) - 1)]
    x = pitch(clip(path, 0.0, None), 12 * np.log2(want / has))
    return fade(decay(x, 1.6)[:n(length)], 0, 0.3)


def make_glass() -> None:
    """Lit squares and threads: real glasses struck, each with a breath of bowed glass behind it."""
    bowed = take('instruments/VCSL/**/Wine Glasses/Sustains/Slow/glass1_D#4_Slow_1_Main.wav')
    for i, name in enumerate(STEPS):
        takes = []
        for which in range(2):
            ting = glass_note(name, which, 1.4)
            # Bowed glass an octave or two under it, swelling in after the strike.
            under = pitch(bowed, (midi(name) - midi('D#4')) % 12 + (0 if i < 5 else 0))
            under = shape(pad(under, 1.2, 0.3, 0.5, 0.4, seed=i * 2 + which), swell(1.2, 0.25, 0.1, None, 1.6))
            x = mix([(ting, 0, 0), (under, 0.02, -15)])
            takes.append(finish(x, -3, 0.2))
        FOLEY[f'glass.{i}'] = takes

    # A pin: a glass prism closes round the piece. Two glasses touch, and one rings on, high.
    clink = f'{A}/glass/fs-glasses-clink-96k-269395.ogg'
    takes = []
    for i, (start, ring) in enumerate(((0.15, 'A#6'), (2.2, 'G#6'))):
        try:
            touch = clip(clink, start, 0.5)
        except Exception:
            touch = clip(clink, 0.15, 0.5)
        x = mix([(decay(touch, 0.5)[:n(0.5)], 0, 0), (glass_note(ring, 0, 0.8), 0.035, -9)])
        takes.append(finish(x, -3, 0.15))
    FOLEY['seal'] = takes


# -- air, hands, the clock ---------------------------------------------------------

def window(pattern: str, start: float, length: float, level_db: float = -3.0, keep_stereo: bool = False) -> np.ndarray:
    """A stretch of a recording exactly as it lies, with only its ends eased (for sounds with no hard start)."""
    x = dsp.load(find(pattern), mono=not keep_stereo)
    return norm(x[n(start):n(start + length)], level_db)


def breath(x: np.ndarray, length: float, rise: float = 0.45) -> np.ndarray:
    """A pass of air: laid in the middle of `length` seconds, rising into its peak and falling away."""
    size = n(length)
    e = dsp.envelope(mono(x), 0.02)
    centre = int(np.argmax(e))
    at = int(size * rise) - centre
    out = np.zeros((size,) + x.shape[1:])
    a, b = max(0, at), min(size, at + len(x))
    out[a:b] = x[a - at:b - at]
    return fade(out, length * 0.2, length * 0.3)


def make_air() -> None:
    """Something passing through the air: a hand reaching (short), a stone carried (long)."""
    stick = f'{B}/whoosh/fs-427979.mp3'
    # A bamboo cane swung, played well below its speed: no longer a whip, but a sleeve.
    short = []
    for start, length, shift in ((12.49, 0.31, -8), (10.27, 0.34, -9), (13.59, 0.30, -7), (9.20, 0.31, -8)):
        x = pitch(window(stick, start - 0.06, length + 0.12), shift)
        x = lp(hp(breath(x, 0.5), 110, 2), 5200, 2)
        short.append(finish(norm(x, -4), -4, 0.08))
    FOLEY['whoosh.short'] = short
    # A shirt swept through the air, with the cane under it for the push at the start.
    shirt = f'{B}/whoosh/fs-391448.mp3'
    long = []
    for i, (path, start, length, shift) in enumerate(((shirt, 6.80, 0.86, -3), (shirt, 8.10, 1.2, 0), (f'{B}/cloth_skin/owlish-cloth-01.wav', 0.22, 1.0, -4), (shirt, 6.80, 0.86, -6))):
        cloth = pitch(window(path, start, length), shift)
        cane = pitch(window(stick, (8.02, 11.45, 3.47, 9.20)[i] - 0.06, 0.42), -14)
        x = mix([(breath(cloth, 0.8, 0.5), 0, 0), (lp(breath(cane, 0.8, 0.4), 1800, 2), 0, -8)])
        x = lp(hp(x, 90, 2), 6000, 2)
        long.append(finish(norm(x, -4), -4, 0.12))
    FOLEY['whoosh.long'] = long


def make_hands() -> None:
    """A hand closing on a stone, a piece chosen, the room's clock, a heart."""
    # Skin on stone: a hand drawn over rough concrete, or one palm over the other, the length of a
    # fingertip, and a sleeve's soft pat under it.
    hand = dsp.load(find(f'{B}/cloth_skin/fs-82723.mp3'))
    palms = dsp.load(find(f'{B}/cloth_skin/fs-315750.mp3'))
    cloth = f'{B}/cloth_skin/kenney-cloth-1.ogg'

    def pat(shift: float, length: float = 0.2) -> np.ndarray:
        x = pitch(window(cloth, 0.07, 0.3), shift)
        x = x[max(0, int(np.argmax(dsp.envelope(x, 0.004))) - n(0.03)):]
        return lp(decay(fade(x, 0.012, 0.02), length, 0.03)[:n(length)], 2600, 2)

    takes = []
    for skin, start, shift in ((palms, 5.39, -2), (hand, 8.89, -4), (palms, 6.0, 0), (hand, 63.86, -3)):
        brush = lp(hp(shape(skin[n(start):n(start + 0.18)], swell(0.18, 0.03, 0.03, None, 1.6)), 300, 2), 2400, 2)
        x = mix([(norm(brush, -3), 0, -3), (norm(pat(shift), -3), 0.02, -9)])
        takes.append(finish(x, -6, 0.05))
    FOLEY['touch'] = takes

    # A piece chosen: a fingertip on the stone, and the stone answering with one high glass note.
    takes = []
    for i, (note, shift) in enumerate((('A#5', 3), ('D#6', 1), ('A#5', 5))):
        tap = norm(pat(shift, 0.13), -3)
        tick = lp(pitch(clip(*PEBBLES[i]), -2), 6000, 1)
        x = mix([(tap, 0, -4), (tick, 0.004, -14), (glass_note(note, i % 2, 0.9), 0.012, -7)])
        takes.append(finish(x, -5, 0.2))
    FOLEY['select'] = takes

    # The clock, when a player is kept waiting: a tick and a tock, of a large slow movement.
    # An old long-case clock: two of its beats, one a little lower. The room makes it large.
    clock = f'{B}/clock/fs-323626.mp3'
    one = window(clock, 0.495, 0.3)
    two = pitch(window(clock, 1.495, 0.3), -2)
    FOLEY['tick'] = [finish(lp(decay(strike(x, 0.002, 0.2), 0.4)[:n(0.4)], 6500, 1), -4, 0.05) for x in (one, two)]

    # A heart: both sounds of one beat, from a stethoscope, with only the low end kept.
    heart = dsp.load(find(f'{B}/heartbeat/fs-831630.mp3'))
    takes = []
    for start in (6.31, 9.76, 19.11, 11.53):
        x = lp(heart[n(start):n(start + 0.62)], 140, 4)
        x = shape(x, swell(0.62, 0.05, 0.3, None, 1.5))
        takes.append(finish(norm(x, -4), -4, 0.1))
    MOMENTS['heart'] = [stereo(x) for x in takes]


def make_paper() -> None:
    """The interface is drawn on paper, so it sounds of paper: a pencil's stroke, a card set down, a page turned."""
    scratch = f'{B}/paper_card/owlish-pencil-scratch-2.wav'
    # Passing over a button: one short stroke of a pencil.
    takes = []
    write = f'{B}/paper_card/oga-pencil-write.flac'
    for path, start, length in ((write, 0.13, 0.085), (write, 0.05, 0.12), (write, 0.89, 0.12)):
        x = hp(dsp.load(find(path))[n(start):n(start + length)], 700, 2)
        takes.append(finish(norm(shape(x, swell(length, 0.012, 0.02, None, 1.5)), -8), -8, 0.02))
    FOLEY['ui.hover'] = takes
    # Pressing one: a card set down.
    takes = []
    for shift in (0, -2, -4):
        x = pitch(clip(f'{B}/paper_card/bmac-card-contact1.wav', 0.0, 0.1), shift)
        takes.append(finish(decay(x, 0.16, 0.01)[:n(0.16)], -5, 0.03))
    FOLEY['ui.press'] = takes
    # A card or a page coming up, and going away again.
    takes = []
    for path, start, length in ((f'{B}/paper_card/oga-bookflip-03.ogg', 0.22, 0.5), (f'{B}/paper_card/fs-464302.mp3', 0.86, 0.5)):
        x = hp(window(path, start, length), 250, 2)
        takes.append(finish(shape(x, swell(length, 0.06, 0.16, None, 1.6)), -6, 0.1))
    FOLEY['ui.open'] = takes
    takes = []
    for path, start, length in ((f'{B}/paper_card/kenney-card-slide-5.ogg', 0.03, 0.42), (f'{B}/paper_card/kenney-card-shove-2.ogg', 0.05, 0.42)):
        x = hp(window(path, start, length), 250, 2)
        takes.append(finish(shape(x, swell(length, 0.03, 0.12, None, 1.6)), -6, 0.1))
    FOLEY['ui.close'] = takes


# -- the case ----------------------------------------------------------------------

def make_case() -> None:
    """The case opening: its brass catch let go, its walnut lid come down on the altar, a drawer run out.
    There is no recording of any of them as such; each is made from the nearest there is."""
    # The catch: a pocket watch's tick, the metal of it only, a little higher.
    takes = []
    tick = f'{B}/clock/fs-117280.mp3'
    for start, shift in ((0.225, 2), (0.45, 1)):
        x = hp(pitch(clip(tick, start, 0.09), shift), 1500, 2)
        takes.append(finish(decay(x, 0.12, 0.004)[:n(0.12)], -6, 0.02))
    FOLEY['case.latch'] = takes
    # The lid down on the altar: a church door shut, made smaller and boxier (higher, with its
    # top taken off), with a hard book cover slapped shut over it for the lid's face.
    takes = []
    door = f'{A}/low_boom/fs-church-door-shut-392240.ogg'
    book = f'{B}/paper_card/kenney-book-close.ogg'
    for shift, slap in ((3, -10), (5, -9), (4, -12)):
        thud = lp(pitch(clip(door, 0.2, 0.55), shift), 1400, 2)
        cover = lp(pitch(clip(book, 0.06, 0.15), -3), 2500, 2)
        x = mix([(thud, 0.0, 0.0), (cover, 0.004, slap)])
        takes.append(finish(decay(x, 0.6, 0.05), -3, 0.08))
    FOLEY['case.lid'] = takes
    # A drawer run out: something hard dragged over wood, its grit taken out, with a creak of the
    # wood under it.
    takes = []
    drag = f'{A}/stone_scrape/oga-stone-rock-wood-moved.mp3'
    creak = f'{B}/cloth_skin/kenney-creak-1.ogg'
    for shift, at in ((-2, 0.16), (-4, 0.38)):
        x = hp(lp(pitch(take(drag), shift), 3000, 2), 300, 2)
        wood = hp(pitch(window(creak, at, 0.2), -3), 250, 2)
        y = mix([(x, 0.0, 0.0), (wood, 0.05, -12)])
        takes.append(finish(shape(y, swell(secs(y), 0.04, 0.1, None, 1.6)), -6, 0.06))
    FOLEY['case.drawer'] = takes


# -- the hands' manners ------------------------------------------------------------

def make_manners() -> None:
    """What the hands do that is not chess, and is heard: a fingertip on the rail of the case and
    on a stone's head, a knuckle cracked, fingers snapped, two hands met, a pawn's foot rapped on
    its square, a pawn pushed, and a hand come too near a candle. The hands are glass, so what
    they do to themselves is glass, small and dry; what they do to wood and stone is skin on it."""
    cloth = f'{B}/cloth_skin/kenney-cloth-1.ogg'
    palms = dsp.load(find(f'{B}/cloth_skin/fs-315750.mp3'))
    book = f'{B}/paper_card/kenney-book-close.ogg'
    clink = f'{A}/glass/fs-glasses-clink-96k-269395.ogg'

    def pad_of(shift: float, length: float) -> np.ndarray:
        """The pad of a finger come down on something: a sleeve's soft pat, cut to its start."""
        x = pitch(window(cloth, 0.07, 0.3), shift)
        x = x[max(0, int(np.argmax(dsp.envelope(x, 0.004))) - n(0.02)):]
        return lp(decay(fade(x, 0.008, 0.02), length, 0.02)[:n(length)], 2800, 2)

    # The rail: a fingertip on walnut. The pad of the finger, and under it the wood answering, which
    # is a hard book cover shut, with its slap taken off and only the knock of the board kept.
    takes = []
    for shift, wood in ((0, -2), (2, -4), (-1, -3), (3, -5)):
        board = lp(hp(pitch(clip(book, 0.06, 0.12), wood), 180, 2), 1500, 2)
        x = mix([(norm(pad_of(shift, 0.12), -3), 0, -5), (norm(decay(board, 0.14, 0.01)[:n(0.14)], -3), 0.003, -2)])
        takes.append(finish(x, -5, 0.03))
    FOLEY['hand.rail'] = takes

    # A stone patted on its head: the pad of the finger again, and the stone under it, which is a
    # pebble's tick, dulled.
    takes = []
    for i, shift in enumerate((1, 3, 0)):
        tick = lp(pitch(clip(*PEBBLES[(i * 2 + 1) % len(PEBBLES)]), -5), 3200, 2)
        x = mix([(norm(pad_of(shift, 0.14), -3), 0, -3), (norm(tick, -3), 0.004, -9)])
        takes.append(finish(x, -5, 0.04))
    FOLEY['hand.pat'] = takes

    # A knuckle cracked: glass giving a very little. Two glasses touched, the first instant of it
    # only, with a pebble's tick under it for the dry part. No ring is left on it.
    takes = []
    for i, (start, shift) in enumerate(((0.15, 5), (2.2, 3), (0.15, 8), (2.2, 6))):
        try:
            touch = clip(clink, start, 0.2)
        except Exception:
            touch = clip(clink, 0.15, 0.2)
        glass = hp(decay(pitch(touch, shift), 0.045, 0.002)[:n(0.05)], 1800, 2)
        tick = hp(pitch(clip(*PEBBLES[i % len(PEBBLES)]), 4), 900, 2)
        x = mix([(norm(glass, -3), 0, -4), (norm(decay(tick, 0.04)[:n(0.045)], -3), 0.001, -3)])
        takes.append(finish(x, -4, 0.012))
    FOLEY['hand.knuckle'] = takes

    # Fingers snapped: the same two glasses, let ring a moment longer, and a breath of palm on palm
    # ahead of it for the fingers sliding off each other.
    takes = []
    for start, shift, note in ((0.15, 2, 'G#6'), (2.2, 0, 'A#6')):
        try:
            touch = clip(clink, start, 0.3)
        except Exception:
            touch = clip(clink, 0.15, 0.3)
        slide = lp(hp(shape(palms[n(5.39):n(5.39 + 0.05)], swell(0.05, 0.03, 0.0, None, 1.6)), 600, 2), 5000, 2)
        x = mix([(norm(slide, -3), 0, -12), (norm(decay(pitch(touch, shift), 0.16, 0.004)[:n(0.18)], -3), 0.045, 0), (glass_note(note, 0, 0.35), 0.05, -16)])
        takes.append(finish(x, -3, 0.05))
    FOLEY['hand.snap'] = takes

    # Two hands met, fingertip to fingertip or palm to palm: one palm come down on the other, and
    # the glass of them barely sounding, low.
    takes = []
    for start, note in ((6.0, 'D#5'), (5.39, 'F#5')):
        palm = lp(hp(shape(palms[n(start):n(start + 0.12)], swell(0.12, 0.012, 0.02, None, 1.8)), 250, 2), 2600, 2)
        x = mix([(norm(palm, -3), 0, -2), (norm(pad_of(-2, 0.16), -3), 0.004, -6), (glass_note(note, 1, 0.5), 0.01, -20)])
        takes.append(finish(x, -5, 0.08))
    FOLEY['hand.meet'] = takes

    # A pawn's foot rapped on its square, and a stone hopped or laid over: stone on stone with no
    # weight behind it. The knock alone, a little higher, with none of the slab under it.
    takes = []
    for i, shift in enumerate((3, 5, 2, 4)):
        k = pitch(clip(*KNOCKS[(i * 2 + 1) % len(KNOCKS)]), shift)
        x = hp(decay(k, 0.16, 0.01)[:n(0.18)], 260, 2)
        takes.append(finish(norm(x, -3), -3, 0.03))
    FOLEY['hand.rap'] = takes

    # A pawn pushed a square with one finger: granite drawn over a cement floor, for as long as the
    # push lasts, rising and falling away, its grit kept and its rumble taken off.
    granite = dsp.load(find(f'{A}/stone_scrape/fs-granite-block-move-543703.ogg'))
    takes = []
    for start, shift in ((1.96, 2), (4.23, 3), (0.41, 1)):
        length = 0.5
        x = pitch(granite[n(start):n(start + length * 2 ** (shift / 12))], shift)
        x = lp(hp(shape(x, swell(secs(x), 0.1, 0.12, None, 1.8)), 320, 2), 5200, 2)
        takes.append(finish(norm(x, -3), -4, 0.06))
    FOLEY['hand.drag'] = takes

    # A hand come too near a flame: the spit of a candle's wick, the loudest there are in the
    # recording, played higher and with only their top kept.
    flame = dsp.load(find(f'{B}/fire/fs-680476.mp3'))
    takes = []
    for i, at in enumerate(loudest(flame, 0.12, 3)):
        spit = hp(pitch(flame[max(0, at - n(0.01)):at + n(0.16)], 5 + 2 * i), 1400, 2)
        x = shape(spit, swell(secs(spit), 0.006, 0.02, None, 1.6))
        takes.append(finish(norm(x, -3), -4, 0.03))
    FOLEY['hand.burn'] = takes


# -- the room's own sound ----------------------------------------------------------

def make_beds() -> None:
    """
    The room when nothing is happening: a double bass bowed on two low notes, glasses and a bowed
    vibraphone that come and go above it, a harp note now and then from the far end. And the
    uneasy layer that is brought up as the position sharpens: strings shivering a semitone apart.
    """
    length, cross = 72.0, 8.0
    t = np.arange(n(length)) / SR
    bass = lambda note, v, shift, seed: pad(pitch(take(f'instruments/VSCO-2-CE/Strings/Solo Contrabass/SusNV/BKCtbss_SusNV_{note}_v{v}_rr1.wav', keep_stereo=True), shift), length, 0.9, 0.8, 1.0, seed, wander=4)
    # E flat and B flat: the wine glasses are tuned to E flat minor, so the room is.
    root = lp(bass('D1', 1, 1, 1), 380, 2) * (0.75 + 0.25 * np.sin(2 * np.pi * t / 23.0))[:, None]
    fifth = lp(bass('A1', 1, 1, 2), 520, 2) * (0.45 + 0.35 * np.sin(2 * np.pi * t / 31.0 + 1.3))[:, None]
    organ = pad(take('instruments/VCSL/**/Pipe Organ/Quiet Pedal/NT5_PedalQuiet_D#1_rr1.wav', keep_stereo=True), length, 1.2, 0.8, 0.8, 3)
    organ = lp(organ, 240, 2) * (0.5 + 0.5 * np.sin(2 * np.pi * t / 47.0 + 0.4))[:, None]
    parts = [(root, 0, -9), (fifth, 0, -15), (organ, 0, -20)]
    # Glasses: each swells in and out on its own slow clock, so the chord is never the same twice.
    for i, (name, period, phase) in enumerate((('glass1_D#4_Slow_1_Main', 37.0, 0.0), ('glass2_F#4_Slow_1_Main', 53.0, 2.1), ('glass3_A#4_Slow_1_Main', 43.0, 4.0))):
        held = pad(take(f'instruments/VCSL/**/Wine Glasses/Sustains/Slow/{name}.wav', keep_stereo=True), length, 0.7, 0.8, 0.6, 10 + i, wander=3)
        breath = np.clip(np.sin(2 * np.pi * t / period + phase), 0, 1) ** 2.5
        parts.append((lp(held, 4500, 2) * breath[:, None], 0, -31))
    vibes = pad(pitch(take('instruments/VCSL/**/Vibraphone/Bowed/Vibes_bowed_G3_rr1_Main.wav', keep_stereo=True), -1), length, 0.8, 0.6, 0.8, 20, wander=3)
    parts.append((vibes * (np.clip(np.sin(2 * np.pi * t / 61.0 + 3.0), 0, 1) ** 2)[:, None], 0, -27))
    dry = mix(parts, length, channels=2)
    # A harp, far off: single notes, well apart, almost all echo.
    far = []
    for at, has, want, where in ((6.0, 'A4', 'A#4', -0.4), (19.5, 'D4', 'D#4', 0.3), (33.0, 'F4', 'F#4', -0.2), (45.5, 'A4', 'A#3', 0.5), (58.0, 'D4', 'C#4', -0.5)):
        note = pitch(take(f'instruments/VCSL/**/Concert Harp/KSHarp_{has}_mf1.wav', keep_stereo=True), midi(want) - midi(has))
        far.append((lp(fade(cut(note, 0, 4.0), 0, 1.5), 2600, 1), at, -24, where))
    harp = mix(far, length, channels=2)
    wet = room(dry, HALL, -15)[:n(length)] + room(harp, HALL, -3, -6)[:n(length)]
    BEDS['calm'] = finish_bed(loopable(wet, cross), -20)

    length = 40.0
    t = np.arange(n(length)) / SR
    parts = []
    for i, (pattern, shift, level, where, period) in enumerate((
        ('instruments/VSCO-2-CE/Strings/Viola Section/trem/Violas_trem_A3_v1_rr1.wav', 1, -8, -0.4, 9.0),
        ('instruments/VSCO-2-CE/Strings/Viola Section/trem/Violas_trem_A3_v1_rr1.wav', 2, -9, 0.4, 11.0),
        ('instruments/VSCO-2-CE/Strings/Violin Section/Trem/VlnEns_Trem_E4_v1.wav', 0, -12, 0.1, 13.0),
        ('instruments/VSCO-2-CE/Strings/Cello Section/trem/trem_E1_v1_1.wav', -1, -7, 0.0, 17.0),
    )):
        v = take(pattern, keep_stereo=True)
        held = pad(pitch(v, shift), length, 0.5, 0.5, 0.6, 30 + i, wander=5)
        parts.append((held * (0.72 + 0.28 * np.sin(2 * np.pi * t / period + i))[:, None], 0, level, where))
    bowed = pad(take('instruments/VCSL/**/Suspended Cymbal 1/susCymb1_bow_7.wav', keep_stereo=True), length, 0.6, 0.3, 0.5, 39)
    parts.append((hp(bowed, 1500, 2) * (np.clip(np.sin(2 * np.pi * t / 19.0), 0, 1) ** 3)[:, None], 0, -24, 0.0))
    wet = room(lp(mix(parts, length, channels=2), 5000, 1), HALL, -13)[:n(length)]
    BEDS['tense'] = finish_bed(loopable(wet, 6.0), -22)

    # The air of the place: wind heard from inside an empty church, the still air of a cathedral's
    # crypt, and the candles by the board.
    length = 46.0
    church = dsp.load(find(f'{B}/room_tone/fs-557380.mp3'), mono=False)
    start = quietest(church, length)
    crypt = dsp.load(find(f'{B}/room_tone/fs-131107.mp3'), mono=False)
    under = quietest(crypt, length)
    tone = church[start:start + n(length)] / max(dsp.rms(church[start:start + n(length)]), 1e-9)
    tone = tone + 0.5 * crypt[under:under + n(length)] / max(dsp.rms(crypt[under:under + n(length)]), 1e-9)
    flame = dsp.load(find(f'{B}/fire/fs-680476.mp3'))
    a = quietest(flame, length / 2)
    flame = hp(flame[a:a + n(length / 2)], 900, 2)
    # One candle either side, each the other half of the same recording.
    candles = mix([(np.tile(flame, 2)[:n(length)], 0, 0, -0.6), (np.tile(flame[::-1], 2)[:n(length)], 0, 0, 0.6)], length, channels=2)
    tone = tone * (db(-30) / max(dsp.rms(tone), 1e-9))
    # A flame is all but silent: its flutter is kept, far under the air, and its spits are held down.
    candles = limit(candles * (db(-48) / max(dsp.rms(candles), 1e-9)), -36)
    BEDS['air'] = finish_bed(loopable(lp(tone, 9000, 2) + lp(candles, 7000, 1), 6.0), -30)


def quietest(x: np.ndarray, length: float) -> int:
    """Where the steadiest stretch of `length` seconds begins: the one with the least in it that stands out."""
    e = dsp.envelope(mono(x), 0.05)
    size, hop = n(length), n(0.5)
    best, at = None, 0
    for i in range(0, max(1, len(e) - size), hop):
        seg = e[i:i + size]
        score = seg.max() / (np.median(seg) + 1e-12)
        if best is None or score < best:
            best, at = score, i
    return at


def finish_bed(x: np.ndarray, rms_db: float) -> np.ndarray:
    """A loop at a known loudness, with nothing below hearing."""
    x = hp(x, 24, 2)
    x = x * (db(rms_db) / max(dsp.rms(x), 1e-9))
    return limit(x, -3)


# -- how loud each is ---------------------------------------------------------------

# Every take of a sound is brought to the same loudness (LUFS, over its loudest 0.4 seconds), so
# that the game can set one sound against another without knowing which take it will get. The
# longest name that a sound's name begins with is the one that counts.
LOUDNESS = {
    'set.pale.light': -21, 'set.dark.light': -21, 'set.pale.mid': -19, 'set.dark.mid': -19, 'set.pale.heavy': -17, 'set.dark.heavy': -17,
    'lift.': -23, 'crack': -15, 'snap': -26, 'grind': -20, 'clack': -25,
    'glass.': -22, 'seal': -22, 'select': -23,
    'whoosh.short': -24, 'whoosh.long': -23, 'touch': -28, 'tick': -25,
    'ui.hover': -32, 'ui.press': -26, 'ui.open': -24, 'ui.close': -24,
    'bell': -12, 'check': -13, 'fork': -16, 'reveal': -16, 'rise': -15, 'fall': -15, 'mate': -11, 'heart': -24,
    'case.latch': -26, 'case.lid': -16, 'case.drawer': -25,
    'hand.rail': -27, 'hand.pat': -27, 'hand.knuckle': -25, 'hand.snap': -23, 'hand.meet': -27, 'hand.rap': -23, 'hand.drag': -25, 'hand.burn': -26,
}


def level() -> None:
    for group in (FOLEY, MOMENTS):
        for key, takes in group.items():
            names = [name for name in LOUDNESS if key.startswith(name)]
            if not names:
                print('  no loudness is set for', key)
                continue
            want = LOUDNESS[max(names, key=len)]
            group[key] = [fade(dsp.to_loudness(x, want, -1.0), 0.0003, 0.01) for x in takes]


# -- writing it out ----------------------------------------------------------------

def write(only: set[str] | None, wav: str | None) -> None:
    os.makedirs(OUT, exist_ok=True)
    manifest: dict = {'rate': SR, 'files': {}, 'clips': {}, 'beds': {}}
    gap = n(0.05)

    def sprite(name: str, sounds: dict[str, list[np.ndarray]], channels: int) -> None:
        if not sounds:
            return
        at = gap
        pieces = [np.zeros(gap) if channels == 1 else np.zeros((gap, 2))]
        for key in sorted(sounds):
            takes = []
            for x in sounds[key]:
                x = mono(x) if channels == 1 else stereo(x)
                pieces += [x, np.zeros(gap) if channels == 1 else np.zeros((gap, 2))]
                takes.append([round(at / SR, 5), round(len(x) / SR, 5)])
                at += len(x) + gap
            manifest['clips'][key] = {'file': name, 'takes': takes}
        dsp.save(os.path.join(OUT, f'{name}.flac'), np.concatenate(pieces))
        manifest['files'][name] = f'{name}.flac'

    sprite('foley', FOLEY, 1)
    sprite('moments', MOMENTS, 2)
    dsp.save(os.path.join(OUT, 'hall.flac'), HALL * 0.5, 'PCM_24')
    manifest['files']['hall'] = 'hall.flac'
    # A loop is written with a little of its end before it and a little of its start after it, so
    # that the game can loop the middle exactly, however many samples a decoder adds at the front.
    roll = 0.5
    for key, x in BEDS.items():
        padded = np.concatenate([x[-n(roll):], x, x[:n(roll)]])
        tmp = os.path.join(OUT, f'bed-{key}.wav')
        dsp.save(tmp, padded, 'PCM_24')
        subprocess.run(['lame', '--quiet', '-V', '2', '--noreplaygain', tmp, os.path.join(OUT, f'bed-{key}.mp3')], check=True)
        os.remove(tmp)
        manifest['files'][f'bed-{key}'] = f'bed-{key}.mp3'
        manifest['beds'][key] = {'file': f'bed-{key}', 'start': roll, 'length': round(len(x) / SR, 5)}
    if only is None:
        json.dump(manifest, open(os.path.join(OUT, 'sounds.json'), 'w'), indent=1)
    if wav:
        os.makedirs(wav, exist_ok=True)
        for group in (FOLEY, MOMENTS):
            for key, takes in group.items():
                for i, x in enumerate(takes):
                    dsp.save(os.path.join(wav, f'{key}.{i + 1}.wav'), x)
        for key, x in BEDS.items():
            dsp.save(os.path.join(wav, f'bed-{key}.wav'), x)


MAKERS = {
    'stone': make_stone, 'breaks': make_breaks, 'glass': make_glass,
    'bell': make_bell, 'check': make_check, 'fork': make_fork, 'reveal': make_reveal, 'fall': make_fall, 'rise': make_rise, 'mate': make_mate, 'air': make_air, 'hands': make_hands, 'paper': make_paper, 'case': make_case, 'manners': make_manners, 'beds': make_beds,
}


def main() -> None:
    only = None
    wav = None
    args = sys.argv[1:]
    if '--only' in args:
        only = set(args[args.index('--only') + 1].split(','))
    if '--wav' in args:
        wav = args[args.index('--wav') + 1]
    for name, make in MAKERS.items():
        if only is None or name in only:
            make()
            print('made', name, flush=True)
    level()
    write(only, wav)
    if only is None:
        record_sources()
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f'{len(FOLEY)} placed sounds, {len(MOMENTS)} set pieces, {len(BEDS)} loops; {total / 1e6:.1f} MB in {OUT}')


def record_sources(to: str = os.path.join(HERE, 'sources.json')) -> None:
    """Note down every recording that was opened, with what fetch.py needs to get it again."""
    known = {}
    for manifest in glob.glob(os.path.join(CACHE, '*', 'manifest.json')):
        base = os.path.dirname(manifest)
        for m in json.load(open(manifest)):
            known[os.path.abspath(os.path.join(base, m['file']))] = m
    commits = {}
    try:
        commits = json.load(open(os.path.join(CACHE, 'instruments', 'commits.json')))
    except FileNotFoundError:
        pass
    rows = []
    for path in sorted(dsp.USED):
        rel = os.path.relpath(path, CACHE)
        sha = hashlib.sha256(open(path, 'rb').read()).hexdigest()
        if rel.startswith('instruments' + os.sep):
            _, repo, inner = rel.split(os.sep, 2)
            rows.append({'file': rel, 'url': f'https://raw.githubusercontent.com/sgossner/{repo}/{commits.get(repo, "master")}/' + urllib.parse.quote(inner.replace(os.sep, '/')),
                         'sha256': sha, 'licence': 'CC0-1.0', 'author': 'Versilian Studios', 'source': f'https://github.com/sgossner/{repo}'})
        elif path in known:
            m = known[path]
            rows.append({'file': rel, 'url': m['download_url'], 'sha256': sha, 'licence': m['licence'], 'author': m.get('author', ''), 'title': m.get('title', ''), 'source': m['source_page']})
        else:
            rows.append({'file': rel, 'url': None, 'sha256': sha})
    json.dump(rows, open(to, 'w'), indent=1)


if __name__ == '__main__':
    main()
