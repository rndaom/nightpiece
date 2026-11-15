"""
Development only. The film's music, and its final mix.

  tmp/sound/.venv/bin/python tools/promo/score.py [--sound tmp/promo/sound] [--stems]

Reads what sound.mjs wrote (game.wav: the game's own sound for the cut; cues.json: when each
shot begins, when the check, the capture, the mate and the closing card's seal fall, and when
each line, each piece's name and each typed letter comes) and writes film.wav, exactly as long
as the film.

The music is made as the game's sound is, by the same tools (assets/src/sound/dsp.py and
build.py) and from the same recordings: an organ pedal and a bowed bass held low while the
film says what the game is, a wine glass for each thing it says and a harp note for each piece
it names, a cymbal and shivering strings drawn up into the check, a clock that quickens until
the check is answered, the low note again and strings climbing into the mate, the glasses and
the harp again for what the win did, and for the name a harp and a bell tolled twice. Nothing is an oscillator. The game's
sound is left as the game made it; the music only leads up to it and gets out of its way.

`--stems` also writes the music alone (music.wav) and prints how loud each half-second is, and
how much the limiter took off its highest instant.
"""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'assets', 'src', 'sound'))
import dsp  # noqa: E402
import build as B  # noqa: E402
from dsp import SR, cut, db, decay, fade, glide, hp, limit, lp, mix, mono, n, norm, pitch, reverse, room, secs, shape, stereo, swell  # noqa: E402

A, F = 'foley-a', 'foley-b'
VCSL, VSCO = 'instruments/VCSL/**', 'instruments/VSCO-2-CE'


def note(pattern: str, want: str, **kw) -> np.ndarray:
    """The recorded note nearest the one wanted, moved to it. `pattern` has {note} where the name goes."""
    found = {}
    for path in glob.glob(os.path.join(B.CACHE, pattern.replace('{note}', '*')), recursive=True):
        m = re.search(pattern.split('/')[-1].replace('{note}', r'([A-G]#?-?\d)').replace('*', '.*'), os.path.basename(path))
        if m:
            found.setdefault(m.group(1), path)
    assert found, pattern
    has = min(found, key=lambda k: (abs(B.midi(k) - B.midi(want)), k))
    return pitch(B.take(os.path.relpath(found[has], B.CACHE), keep_stereo=True, **kw), B.midi(want) - B.midi(has))


def held(x: np.ndarray, length: float, seed: int, grain: float = 0.6, wander: float = 4) -> np.ndarray:
    """A note held for as long as wanted."""
    return B.pad(x, length, grain, min(0.6, secs(x) * 0.2), min(0.6, secs(x) * 0.2), seed, wander)


def up_to(x: np.ndarray, length: float, after: float = 0.03) -> np.ndarray:
    """A recorded crescendo, cut so that its loudest instant is its last: `length` seconds of the way up, and a moment's fall."""
    e = dsp.envelope(mono(x), 0.01, 0.05)
    top = int(np.argmax(e))
    y = x[max(0, top - n(length)):top + n(after)]
    return fade(y, min(0.4, length / 3), after)


def music(c: dict) -> np.ndarray:
    length, check, capture, mate, seal = c['length'], c['check'], c['capture'], c['mate'], c['seal']
    hand, close, result = c['shots']['2-hand'], c['shots']['4-mate'], c['shots']['result']
    lines, names, keys = c['lines'], c['names'], c['keys']
    parts = []
    organ = B.take(f'{VCSL}/Pipe Organ/Quiet Pedal/NT5_PedalQuiet_D#1_rr1.wav', keep_stereo=True)
    low = note(f'{VSCO}/Strings/Solo Contrabass/SusNV/BKCtbss_SusNV_{{note}}_v1_rr1.wav', 'D#1')
    boom = lp(B.clip(f'{A}/low_boom/fs-door-smash-1-218890.ogg', 1.28, 3.0, keep_stereo=True), 110, 2)
    glasses = f'{VCSL}/Wine Glasses/Sustains/Slow/glass*_{{note}}_Slow_*_Main.wav'
    harp = f'{VCSL}/Concert Harp/KSHarp_{{note}}_mf1.wav'
    clock = f'{F}/clock/fs-323626.mp3'
    beats = [lp(decay(B.strike(B.window(clock, at, 0.3), 0.002, 0.2), 0.35)[:n(0.35)], 6500, 1) for at in (0.495, 1.495)]
    beats[1] = pitch(beats[1], -2)

    def sung(name: str, begins: float, lasts: float, level: float, seed: int, where: float = 0.0) -> None:
        """A glass, begun softly, held, and let go."""
        glass = lp(held(note(glasses, name), lasts, seed, 0.7, 3), 5000, 2)
        t = np.arange(len(glass)) / SR
        parts.append((shape(glass, np.interp(t, [0, 1.1, max(1.2, lasts - 1.8), lasts], [0.0, 1.0, 0.8, 0.0])), begins, level, where))

    def plucked(name: str, at: float, level: float, where: float = 0.0) -> None:
        parts.append((room(fade(cut(note(harp, name), 0, 2.4), 0, 1.4), B.HALL, -12), at, level, where))

    # -- what the game is, and how one is begun: E flat held low under all of it, hardly
    #    moving; a glass for each thing the film says, a line of six notes that goes up and
    #    does not come home; a harp note for each piece as it is named; and the name typed,
    #    a small dry tick for each letter -------------------------------------------------------
    lead = check
    t = np.arange(n(lead)) / SR
    # It is level while the film explains, and from the cut to the hand it grows all the way to the blow, which stops it.
    rising = fade(np.where(t < hand, 0.3 + 0.1 * t / hand, 0.4 + 0.45 * np.clip((t - hand) / (check - hand), 0, 1) ** 1.6), 0.2, 0.12)
    parts.append((shape(lp(held(organ, lead, 1, 1.0), 260, 2), rising), 0, -14))
    parts.append((shape(lp(held(low, lead, 2, 0.9), 420, 2), rising), 0, -11))
    said = [at for at in lines if at < hand]
    for i, (at, name) in enumerate(zip(said, ('D#4', 'A#4', 'F#4', 'G#4', 'A#4', 'C#5'))):
        until = said[i + 1] if i + 1 < len(said) else hand - 0.3
        sung(name, at - 0.1, until - at + 1.9, -22, 10 + i, (-0.25, 0.25)[i % 2])
    for i, (at, name) in enumerate(zip(names, ('D#3', 'F#3', 'A#3', 'D#4', 'F#4', 'A#4'))):
        plucked(name, at, -27.5 + 0.4 * i, -0.5 + 0.2 * i)
    key = fade(lp(pitch(beats[0], 10), 5200, 1)[:n(0.09)], 0, 0.05)
    for i, at in enumerate(keys):
        parts.append((key, at, -27 + (i % 3) * 0.8, -0.35))

    # -- the game: a third glass as the hand comes into it; then drawn up into the check, from
    #    when the hand comes down for the queen: violas and cellos shivering and a cymbal's
    #    swell, all stopped by the blow -------------------------------------------------------------
    sung('F#4', hand, check - hand + 0.3, -22, 19)
    draw = 2.4
    for i, (pattern, name, level) in enumerate((
        (f'{VSCO}/Strings/Viola Section/trem/Violas_trem_{{note}}_v2_rr1.wav', 'D#3', -19.5),
        (f'{VSCO}/Strings/Cello Section/trem/trem_{{note}}_v2_1.wav', 'A#2', -22.5),
    )):
        shiver = held(note(pattern, name), draw, 20 + i, 0.45)
        parts.append((shape(shiver, swell(draw, draw - 0.05, 0.0, 0.05, 2.4)), check - draw, level))
    cymbal = up_to(B.take(f'{VCSL}/Suspended Cymbal 1/susCymb1_cresc_2s.wav', keep_stereo=True), 1.5)
    parts.append((hp(cymbal, 350, 2), check - secs(cymbal) + 0.03, -21.5))
    # ... and weight under it.
    parts.append((fade(boom, 0, 1.2), check, -11))

    # -- the king in check: a clock that quickens until the rook answers, its last beat a
    #    sixth of a second before the rook is set down ------------------------------------------
    ticks, gap = [capture - 0.16], 0.16
    while ticks[-1] - gap / 0.9 > check + 1.0:
        gap = min(0.56, gap / 0.9)
        ticks.append(ticks[-1] - gap)
    ticks.reverse()
    for k, at in enumerate(ticks):
        along = (at - ticks[0]) / (capture - ticks[0])
        parts.append((room(beats[k % 2], B.HALL, -15), at, -15 + 5 * along, 0.0))
    # The answer has weight too, but less than the blows either side of it.
    parts.append((fade(boom, 0, 1.0), capture, -14))

    # -- from the answer to the mate: the opening's low note again, growing; then, from the cut
    #    to the hand closing on the bishop, strings that climb as they shiver, a gong played
    #    backwards, a cymbal, and nothing at all for an instant before the blow -----------------
    begins = capture + 0.6
    span = mate - begins
    growing = fade(0.2 + 0.8 * (np.arange(n(span)) / n(span)) ** 1.6, 0.5, 0.1)
    parts.append((shape(lp(held(organ, span, 3, 1.0), 260, 2), growing), begins, -11))
    parts.append((shape(lp(held(low, span, 4, 0.9), 420, 2), growing), begins, -9.5))
    climb = min(2.2, max(1.5, mate - close - 0.03))
    for i, (pattern, name, level, where) in enumerate((
        (f'{VSCO}/Strings/Cello Section/trem/trem_{{note}}_v2_1.wav', 'D#2', -18, -0.3),
        (f'{VSCO}/Strings/Viola Section/trem/Violas_trem_{{note}}_v2_rr1.wav', 'A#3', -20, 0.3),
        (f'{VSCO}/Strings/Violin Section/Trem/VlnEns_Trem_{{note}}_v2.wav', 'D#5', -22, -0.5),
        (f'{VSCO}/Strings/Violin Section/Trem/VlnEns_Trem_{{note}}_v2.wav', 'E5', -23, 0.5),
    )):
        v = held(note(pattern, name), climb + 0.4, 30 + i, 0.4)
        v = glide(v, lambda t, i=i: (1.0 + 0.5 * i) * max(0.0, (t - (climb - 0.7)) / 0.7) ** 2, climb)
        parts.append((shape(v, swell(climb, climb - 0.025, 0.0, 0.025, 2.6)), mate - climb - 0.03, level))
    gong = reverse(fade(cut(B.take(f'{VCSL}/Gong 1/gong_f.wav', keep_stereo=True), 0.0, 1.8), 0.004, 0.6))
    parts.append((fade(lp(gong, 3000, 2), 0.3, 0.02), mate - 1.8 - 0.03, -21))
    cymbal = up_to(B.take(f'{VCSL}/Suspended Cymbal 1/susCymb1_cresc_1.5s.wav', keep_stereo=True), 1.1, 0.02)
    parts.append((hp(cymbal, 350, 2), mate - secs(cymbal) - 0.01, -21))

    # -- the game won: the mate is left to ring by itself; then the low note comes back under
    #    it, and for the rating and for the rankings a glass and a harp note each, the line of
    #    the opening carried on upward to where it was going ---------------------------------------
    after = seal - (mate + 1.6)
    t = np.arange(n(after)) / SR
    back = np.interp(t, [0, 2.5, after - 0.6, after], [0.0, 1.0, 1.0, 0.75])
    parts.append((shape(lp(held(organ, after, 5, 1.0), 260, 2), back), mate + 1.6, -19.5))
    parts.append((shape(lp(held(low, after, 6, 0.9), 420, 2), back), mate + 1.6, -17.5))
    won = [at for at in lines if result <= at < seal - 2]
    for i, (at, glass, string) in enumerate(zip(won, ('A#4', 'D#5'), ('A#3', 'D#4'))):
        until = won[i + 1] if i + 1 < len(won) else seal - 1.2
        sung(glass, at - 0.1, until - at + 1.6, -23, 40 + i, (0.25, -0.25)[i % 2])
        plucked(string, at, -22, (0.3, -0.3)[i % 2])

    # -- the name: four harp notes going up as its letters are written, and a bell as the seal
    #    is struck, tolled once more, farther off; under it the opening's glasses again, held
    #    until the picture goes -----------------------------------------------------------------
    for i, name in enumerate(('D#3', 'A#3', 'D#4', 'F#4')):
        plucked(name, seal - 0.86 + 0.2 * i + 0.012 * i * i, -25 + 0.6 * i, -0.4 + 0.27 * i)
    bell = note(f'{VCSL}/Tubular Bells 1/chimes_{{note}}_ff_rr*.wav', 'D#3')
    under = lp(B.take(f'{VCSL}/Gong 1/gong_mf.wav', keep_stereo=True), 420, 2)
    toll = mix([(bell, 0, 0), (fade(cut(under, 0, 4.0), 0, 2.0), 0, -11)], channels=2)
    parts.append((room(fade(toll[:n(4.5)], 0, 1.5), B.HALL, -13), seal, -21))
    far = fade(lp(bell, 2600, 1)[:n(4.0)], 0, 1.5)
    parts.append((room(far, B.HALL, -8), seal + 2.0, -20))
    rest = length - seal
    for i, (name, level) in enumerate((('D#4', -22), ('A#4', -23), ('D#5', -27))):
        glass = held(note(glasses, name), rest, 50 + i, 0.7, 3)
        parts.append((shape(lp(glass, 5000, 2), swell(rest, 1.3 + 0.3 * i, 0.0, None, 1.3)), seal + 0.1, level))
    parts.append((shape(lp(held(organ, rest, 60, 1.0), 240, 2), swell(rest, 0.5, 0.0, None, 1.2)), seal, -14))

    return mix(parts, length + 1.0, channels=2)


def measured(path: str) -> tuple[float, float]:
    """Integrated loudness (LUFS) and true peak (dBTP) of a file, as EBU R 128 has them."""
    out = subprocess.run(['ffmpeg', '-nostats', '-hide_banner', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    tail = out[out.rindex('Summary:'):]
    return float(re.search(r'I:\s+(-?[\d.]+) LUFS', tail).group(1)), float(re.search(r'Peak:\s+(-?[\d.]+) dBFS', tail).group(1))


def main() -> None:
    args = sys.argv[1:]
    folder = args[args.index('--sound') + 1] if '--sound' in args else os.path.join(ROOT, 'tmp', 'promo', 'sound')
    c = json.load(open(os.path.join(folder, 'cues.json')))
    length, mate = c['length'], c['mate']
    size = n(length)

    game = dsp.load(os.path.join(folder, 'game.wav'), mono=False)
    score = music(c)
    both = np.zeros((max(len(game), len(score)), 2))
    # The game's sound is ridden, as a hand on a fader would: the check and what follows it (and
    # the taken pawn's knock as it is put down, half a second before) held under the mate, so that the mate is the loudest thing in the film, and the mate itself and
    # all after it brought down by hand to where the ceiling is, so that the limiter has only
    # its highest instants to take off and the choir keeps its own shape.
    t = np.arange(len(game)) / SR
    # Before the game, the interface's own sounds (the pencil's stroke as the pointer comes onto a thing, the card set down
    # as it is pressed, the two glasses of a match made) are heard close and dry, and are put back among the music.
    menu, hand = c['shots']['menu'], c['shots']['2-hand']
    ride = np.interp(
        t,
        [menu - 0.2, menu, hand + 0.4, hand + 0.9, c['check'] - 0.7, c['check'] - 0.5, mate - 0.25, mate - 0.05, c['seal'] - 0.3, c['seal'] - 0.1],
        [0.0, MENU_DB, MENU_DB, 0.0, 0.0, CHECK_DB, CHECK_DB, MATE_DB, MATE_DB, SEAL_DB],
    )
    game = game * (10 ** (ride / 20))[:, None]
    both[:len(game)] += game * db(GAME_DB)
    both[:len(score)] += score * db(MUSIC_DB)
    # The instant of nothing before the mate: everything is let fall away, and is back for the blow.
    t = np.arange(len(both)) / SR
    hush = np.interp(t, [mate - 0.16, mate - 0.035, mate - 0.004, mate - 0.001], [1.0, 0.07, 0.07, 1.0])
    both *= hush[:, None]
    both = hp(both, 24, 2)[:size]
    both = fade(both, FADE_IN, FADE_OUT, 1.6)

    out = os.path.join(folder, 'film.wav')
    gain = 0.0
    for _ in range(8):
        dsp.save(out, limit(both * db(gain), CEILING_DB, 0.12), 'PCM_24')
        loud, peak = measured(out)
        if abs(loud - LOUDNESS) < 0.05:
            break
        gain += LOUDNESS - loud
    # What the music was made from, so that fetch.py can get it again (--list tools/promo/sources.json).
    dsp.USED = {path for path in dsp.USED if path.startswith(B.CACHE + os.sep)}
    B.record_sources(os.path.join(HERE, 'sources.json'))
    held_down = float(np.max(np.abs(both * db(gain))))
    print(f'{out}: {loud:.1f} LUFS, true peak {peak:.1f} dB, gain {gain:+.1f} dB, limiter takes off up to {max(0.0, dsp.to_db(held_down) - CEILING_DB):.1f} dB')

    if '--stems' in args:
        dsp.save(os.path.join(folder, 'music.wav'), score[:size] * db(MUSIC_DB + gain), 'PCM_24')
        final = dsp.load(out, mono=False)
        marks = {round(c['check'] * 2) / 2: 'check', round(c['capture'] * 2) / 2: 'capture', round(mate * 2) / 2: 'mate', round(c['title'] * 2) / 2: 'card', round(c['seal'] * 2) / 2: 'seal'}
        print('   at   game  music   film  limited by')
        for i in range(int(length * 2)):
            a, b = n(i / 2), n(i / 2 + 0.5)
            row = [dsp.loudness(x[a:b], 0.4) for x in (game * db(GAME_DB + gain), score * db(MUSIC_DB + gain), final)]
            over = max(0.0, dsp.to_db(float(np.max(np.abs(both[a:b]))) + 1e-9) + gain - CEILING_DB)
            print(f'{i / 2:5.1f} ' + ' '.join(f'{v:6.1f}' for v in row) + f' {over:5.1f}  ' + '#' * max(0, int(round(row[2] + 50))) + ('  <- ' + marks[i / 2] if i / 2 in marks else ''))


# How the two halves are set against each other, and what the whole is brought to.
GAME_DB = 0.0
MENU_DB = -5.0
CHECK_DB = -12.5
MATE_DB = -8.5
SEAL_DB = -14.0
MUSIC_DB = 8.0
LOUDNESS = -14.0
CEILING_DB = -1.8
FADE_IN = 0.2
FADE_OUT = 1.0

if __name__ == '__main__':
    main()
