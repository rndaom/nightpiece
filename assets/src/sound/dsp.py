"""
The tools the sound library is made with: reading and cutting recordings, filters, pitch,
envelopes, the hall, a limiter, and laying sounds over one another. Everything works on
float arrays at 48 kHz, mono as (n,) and stereo as (n, 2).

Needs numpy, scipy and soundfile. Time-stretching uses the `rubberband` program if present.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

import numpy as np
import soundfile as sf
from scipy import signal

SR = 48000

# Every recording that is opened is noted here, so that the build can say what it used.
USED: set[str] = set()


# -- reading and writing ----------------------------------------------------------

def load(path: str, mono: bool = True) -> np.ndarray:
    """A recording at 48 kHz. `mono` folds it down; otherwise it comes back as (n, 2)."""
    USED.add(os.path.abspath(path))
    x, rate = sf.read(path, dtype='float64', always_2d=True)
    if rate != SR:
        g = np.gcd(SR, rate)
        x = signal.resample_poly(x, SR // g, rate // g, axis=0)
    if mono:
        return x.mean(axis=1)
    if x.shape[1] == 1:
        return np.repeat(x, 2, axis=1)
    return x[:, :2]


def save(path: str, x: np.ndarray, subtype: str = 'PCM_16') -> None:
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    sf.write(path, np.clip(x, -1, 1), SR, subtype=subtype)


def secs(x: np.ndarray) -> float:
    return len(x) / SR


def n(seconds: float) -> int:
    return max(0, int(round(seconds * SR)))


def db(level: float) -> float:
    return 10 ** (level / 20)


def to_db(gain: float) -> float:
    return 20 * np.log10(max(gain, 1e-12))


def mono(x: np.ndarray) -> np.ndarray:
    return x if x.ndim == 1 else x.mean(axis=1)


def stereo(x: np.ndarray) -> np.ndarray:
    return x if x.ndim == 2 else np.stack([x, x], axis=1)


# -- level ------------------------------------------------------------------------

def peak(x: np.ndarray) -> float:
    return float(np.max(np.abs(x))) if len(x) else 0.0


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0


def norm(x: np.ndarray, level_db: float = -1.0) -> np.ndarray:
    """Bring the loudest sample to `level_db`."""
    p = peak(x)
    return x if p == 0 else x * (db(level_db) / p)


def envelope(x: np.ndarray, attack: float = 0.0005, release: float = 0.02) -> np.ndarray:
    """How loud it is from moment to moment: rises at once, falls slowly."""
    from scipy.ndimage import maximum_filter1d
    a = np.abs(mono(x))
    # The loudest sample of the last `release` seconds, then smoothed: quick up, slow down.
    held = maximum_filter1d(a, size=max(1, n(release)), origin=0)
    return smooth(held, max(attack, release / 4))


def smooth(x: np.ndarray, seconds: float) -> np.ndarray:
    from scipy.ndimage import uniform_filter1d
    return uniform_filter1d(x, size=max(1, n(seconds)), mode='nearest')


# -- cutting ----------------------------------------------------------------------

def fade(x: np.ndarray, fin: float = 0.0, fout: float = 0.0, power: float = 1.0) -> np.ndarray:
    y = x.copy()
    a, b = min(n(fin), len(y)), min(n(fout), len(y))
    if a:
        ramp = np.linspace(0, 1, a) ** power
        y[:a] = (y[:a].T * ramp).T
    if b:
        ramp = np.linspace(1, 0, b) ** power
        y[-b:] = (y[-b:].T * ramp).T
    return y


def cut(x: np.ndarray, start: float, length: float | None = None) -> np.ndarray:
    a = n(start)
    return x[a:] if length is None else x[a:a + n(length)]


def trim(x: np.ndarray, threshold_db: float = -45.0, lead: float = 0.0015, tail_db: float = -60.0, hold: float = 0.02) -> np.ndarray:
    """Cut the silence off both ends: starts just ahead of the first thing heard."""
    e = np.abs(mono(x))
    p = e.max() if len(e) else 0
    if p == 0:
        return x
    loud = np.nonzero(e > p * db(threshold_db))[0]
    quiet = np.nonzero(e > p * db(tail_db))[0]
    start = max(0, loud[0] - n(lead))
    end = min(len(x), quiet[-1] + n(hold))
    return fade(x[start:end], 0.0005, min(0.01, (end - start) / SR / 4))


def events(x: np.ndarray, threshold_db: float = -28.0, gap: float = 0.12, lead: float = 0.002, least: float = 0.03, floor_db: float = -50.0) -> list[tuple[int, int]]:
    """
    Where the separate sounds are in a recording of several takes: (first, last) sample of each.
    One starts where the level climbs past `threshold_db` under the recording's peak and runs
    until it has stayed under `floor_db` for `gap` seconds.
    """
    e = smooth(np.abs(mono(x)), 0.003)
    p = e.max() if len(e) else 0
    if p == 0:
        return []
    on, off = p * db(threshold_db), p * db(floor_db)
    out: list[tuple[int, int]] = []
    i, size, hold = 0, len(e), n(gap)
    while i < size:
        if e[i] < on:
            i += 1
            continue
        start = max(0, i - n(lead))
        quiet = 0
        j = i
        while j < size and quiet < hold:
            quiet = quiet + 1 if e[j] < off else 0
            j += 1
        end = j - quiet + n(0.01)
        if (end - start) / SR >= least:
            out.append((start, min(size, end)))
        i = j
    return out


# -- filters ----------------------------------------------------------------------

def _sos(kind: str, f, order: int):
    return signal.butter(order, np.asarray(f) / (SR / 2), btype=kind, output='sos')


def lp(x, f, order=2):
    return signal.sosfilt(_sos('lowpass', min(f, SR * 0.49), order), x, axis=0)


def hp(x, f, order=2):
    return signal.sosfilt(_sos('highpass', f, order), x, axis=0)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(_sos('bandpass', [lo, min(hi, SR * 0.49)], order), x, axis=0)


def _biquad(b0, b1, b2, a0, a1, a2):
    return np.array([[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]])


def bell(x, f, gain_db, q=1.0):
    """Lift or cut a band round `f`."""
    a = 10 ** (gain_db / 40)
    w = 2 * np.pi * f / SR
    al = np.sin(w) / (2 * q)
    return signal.sosfilt(_biquad(1 + al * a, -2 * np.cos(w), 1 - al * a, 1 + al / a, -2 * np.cos(w), 1 - al / a), x, axis=0)


def shelf(x, f, gain_db, high=True, slope=0.8):
    """Lift or cut everything above (or below) `f`."""
    a = 10 ** (gain_db / 40)
    w = 2 * np.pi * f / SR
    cs, sn = np.cos(w), np.sin(w)
    al = sn / 2 * np.sqrt((a + 1 / a) * (1 / slope - 1) + 2)
    k = 2 * np.sqrt(a) * al
    if high:
        return signal.sosfilt(_biquad(a * ((a + 1) + (a - 1) * cs + k), -2 * a * ((a - 1) + (a + 1) * cs), a * ((a + 1) + (a - 1) * cs - k),
                                      (a + 1) - (a - 1) * cs + k, 2 * ((a - 1) - (a + 1) * cs), (a + 1) - (a - 1) * cs - k), x, axis=0)
    return signal.sosfilt(_biquad(a * ((a + 1) - (a - 1) * cs + k), 2 * a * ((a - 1) - (a + 1) * cs), a * ((a + 1) - (a - 1) * cs - k),
                                  (a + 1) + (a - 1) * cs + k, -2 * ((a - 1) + (a + 1) * cs), (a + 1) + (a - 1) * cs - k), x, axis=0)


def sweep_lp(x, f_start, f_end, q=0.7):
    """A low-pass whose corner moves from one frequency to another over the sound (in 5 ms steps)."""
    y = np.zeros_like(x)
    hop = n(0.005)
    zi = None
    for i in range(0, len(x), hop):
        k = i / max(1, len(x) - 1)
        f = f_start * (f_end / f_start) ** k
        sos = signal.butter(2, min(f, SR * 0.45) / (SR / 2), output='sos')
        if zi is None:
            zi = np.zeros((sos.shape[0], 2) + x.shape[1:])
        y[i:i + hop], zi = signal.sosfilt(sos, x[i:i + hop], axis=0, zi=zi)
    return y


# -- pitch and time ---------------------------------------------------------------

def pitch(x: np.ndarray, semitones: float) -> np.ndarray:
    """Played faster or slower, as a tape would: higher and shorter, or lower and longer."""
    if semitones == 0:
        return x.copy()
    ratio = 2 ** (semitones / 12)
    size = max(2, int(round(len(x) / ratio)))
    at = np.linspace(0, len(x) - 1, size)
    # Going up, take out what would fold over first.
    src = lp(x, SR * 0.45 / ratio, 6) if ratio > 1 else x
    if x.ndim == 1:
        return np.interp(at, np.arange(len(x)), src)
    return np.stack([np.interp(at, np.arange(len(x)), src[:, c]) for c in range(x.shape[1])], axis=1)


def glide(x: np.ndarray, curve, length: float | None = None) -> np.ndarray:
    """
    Pitch that moves while it plays. `curve(t)` gives semitones at each second of the OUTPUT.
    It runs for `length` seconds, or until its source runs out, whichever is first.
    """
    size = n(length) if length is not None else len(x) * 4
    t = np.arange(size) / SR
    ratio = 2 ** (np.array([curve(v) for v in t[::32]]).repeat(32)[:size] / 12)
    at = np.concatenate([[0.0], np.cumsum(ratio)[:-1]])
    at = at[at < len(x) - 1]
    if x.ndim == 1:
        return np.interp(at, np.arange(len(x)), x)
    return np.stack([np.interp(at, np.arange(len(x)), x[:, c]) for c in range(x.shape[1])], axis=1)


def stretch(x: np.ndarray, ratio: float, semitones: float = 0.0) -> np.ndarray:
    """Longer or shorter without changing pitch (and, with `semitones`, the reverse)."""
    exe = shutil.which('rubberband')
    if not exe:
        raise RuntimeError('rubberband is needed for time-stretching')
    with tempfile.TemporaryDirectory() as d:
        a, b = os.path.join(d, 'a.wav'), os.path.join(d, 'b.wav')
        sf.write(a, x, SR, subtype='FLOAT')
        subprocess.run([exe, '-q', '--fine', '-t', str(ratio), '-p', str(semitones), a, b], check=True, capture_output=True)
        y, _ = sf.read(b, dtype='float64')
    return y


def reverse(x: np.ndarray) -> np.ndarray:
    return x[::-1].copy()


# -- shape ------------------------------------------------------------------------

def decay(x: np.ndarray, t60: float, start: float = 0.0) -> np.ndarray:
    """Make it die away: 60 dB down after `t60` seconds, counted from `start`."""
    t = np.maximum(0, np.arange(len(x)) / SR - start)
    g = 10 ** (-3 * t / t60)
    return (x.T * g).T


def swell(length: float, rise: float, hold: float = 0.0, fall: float | None = None, power: float = 2.0) -> np.ndarray:
    """A level that rises, stays and falls, as an array to multiply a sound by."""
    size = n(length)
    t = np.arange(size) / SR
    fall = length - rise - hold if fall is None else fall
    g = np.ones(size)
    g = np.where(t < rise, (t / max(rise, 1e-6)) ** power, g)
    end = rise + hold
    g = np.where(t > end, np.clip(1 - (t - end) / max(fall, 1e-6), 0, 1) ** power, g)
    return g


def shape(x: np.ndarray, g: np.ndarray) -> np.ndarray:
    size = min(len(x), len(g))
    return (x[:size].T * g[:size]).T


def punch(x: np.ndarray, attack_db: float = 3.0, sustain_db: float = 0.0, fast: float = 0.002, slow: float = 0.03) -> np.ndarray:
    """Bring the first instant of a hit up (or down) against what follows it."""
    quick = envelope(x, 0.0002, fast)
    slowly = envelope(x, 0.0002, slow)
    ahead = np.clip((quick - slowly) / (quick + 1e-9), -1, 1)
    g = db(attack_db) ** np.clip(ahead, 0, 1) * db(sustain_db) ** np.clip(1 - np.abs(ahead), 0, 1)
    return (x.T * smooth(g, 0.0005)).T


def warm(x: np.ndarray, drive_db: float = 6.0) -> np.ndarray:
    """Soft saturation: thicker, and the peaks rounded."""
    d = db(drive_db)
    return np.tanh(x * d) / np.tanh(d)


def limit(x: np.ndarray, ceiling_db: float = -1.0, release: float = 0.08, ahead: float = 0.004) -> np.ndarray:
    """Hold the peaks under a ceiling, turning down just before each one and coming back up slowly."""
    from scipy.ndimage import minimum_filter1d
    c = db(ceiling_db)
    level = np.abs(x) if x.ndim == 1 else np.abs(x).max(axis=1)
    need = np.minimum(1.0, c / np.maximum(level, 1e-9))
    if need.min() >= 1.0:
        return x
    # The gain wanted now is the least wanted over the few milliseconds either side.
    need = minimum_filter1d(need, size=2 * n(ahead) + 1)
    # Coming back up is slow: the least of the last `release` seconds, smoothed.
    slow = minimum_filter1d(need, size=n(release), origin=-(n(release) // 2 - 1))
    g = np.minimum(need, smooth(slow, release / 2))
    g = np.minimum(smooth(g, ahead), need)
    return np.clip((x.T * g).T, -c, c)


def loudness(x: np.ndarray, window: float = 0.4) -> float:
    """How loud it is to the ear at its loudest: K-weighted, over the loudest `window` seconds, in LUFS."""
    y = x if x.ndim == 2 else x[:, None]
    y = np.concatenate([y, np.zeros((n(window), y.shape[1]))])
    y = signal.lfilter([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585], y, axis=0)
    y = signal.lfilter([1, -2, 1], [1, -1.99004745483398, 0.99007225036621], y, axis=0)
    total = np.concatenate([[0.0], np.cumsum(np.sum(y ** 2, axis=1))])
    size = n(window)
    power = (total[size:] - total[:-size]).max() / size
    return -0.691 + 10 * np.log10(power + 1e-12)


def ceiling(x: np.ndarray, ceiling_db: float = -1.0, knee_db: float = 6.0) -> np.ndarray:
    """Round off whatever stands above a level, with no pumping: the top `knee_db` is squeezed, the rest untouched."""
    c = db(ceiling_db)
    k = c * db(-knee_db)
    a = np.abs(x)
    over = a > k
    out = x.copy()
    out[over] = np.sign(x[over]) * (k + (c - k) * np.tanh((a[over] - k) / (c - k)))
    return out


def to_loudness(x: np.ndarray, lufs: float, ceiling_db: float = -1.0) -> np.ndarray:
    """Bring a sound to a loudness, not to a peak, so that one take of it is as loud as the next."""
    for _ in range(5):
        x = ceiling(x * db(lufs - loudness(x)), ceiling_db)
    return x


# -- space ------------------------------------------------------------------------

def convolve(x: np.ndarray, ir: np.ndarray) -> np.ndarray:
    """A sound heard in a room: stereo out, as long as the sound plus the room's tail."""
    x2, ir2 = stereo(x), stereo(ir)
    return np.stack([signal.fftconvolve(x2[:, c], ir2[:, c]) for c in range(2)], axis=1)


def room(x: np.ndarray, ir: np.ndarray, wet_db: float = -12.0, dry_db: float = 0.0, predelay: float = 0.0) -> np.ndarray:
    """The sound with the room behind it."""
    wet = convolve(x, ir) * db(wet_db)
    out = np.zeros((len(wet) + n(predelay), 2))
    out[n(predelay):] += wet
    out[:len(x)] += stereo(x) * db(dry_db)
    return out


def pan(x: np.ndarray, where: float) -> np.ndarray:
    """Mono placed between the speakers: -1 left, 0 middle, 1 right (equal power)."""
    a = (np.clip(where, -1, 1) + 1) * np.pi / 4
    m = mono(x)
    return np.stack([m * np.cos(a), m * np.sin(a)], axis=1)


def widen(x: np.ndarray, amount: float = 0.5, seed: int = 1) -> np.ndarray:
    """Mono made wide by giving each side its own short, quiet reflections."""
    rng = np.random.default_rng(seed)
    m = mono(x)
    out = np.stack([m, m], axis=1).astype(float)
    for c in range(2):
        for _ in range(6):
            d = n(rng.uniform(0.004, 0.028))
            g = amount * rng.uniform(0.15, 0.4) * rng.choice([-1, 1])
            out[d:, c] += m[:len(m) - d] * g
    return out


# -- putting sounds together ------------------------------------------------------

def mix(parts, length: float | None = None, channels: int = 1) -> np.ndarray:
    """
    Lay sounds over one another. Each part is (sound, start in seconds, level in dB[, pan]).
    Mono or stereo is chosen by `channels`.
    """
    end = max((n(p[1]) + len(p[0]) for p in parts), default=0)
    size = n(length) if length is not None else end
    out = np.zeros(size) if channels == 1 else np.zeros((size, 2))
    for p in parts:
        x, start, level = p[0], n(p[1]), p[2]
        if channels == 1:
            x = mono(x)
        else:
            x = pan(x, p[3]) if len(p) > 3 and x.ndim == 1 else stereo(x)
        x = x[:max(0, size - start)]
        out[start:start + len(x)] += x * db(level)
    return out


def loopable(x: np.ndarray, cross: float) -> np.ndarray:
    """Make a stretch of sound join up with itself: the end is faded into the beginning."""
    c = n(cross)
    body = x[:len(x) - c].copy()
    tail = x[len(x) - c:]
    t = np.linspace(0, 1, c)
    a, b = np.sqrt(t), np.sqrt(1 - t)
    body[:c] = (body[:c].T * a).T + (tail.T * b).T
    return body


# -- measuring --------------------------------------------------------------------

def centroid(x: np.ndarray) -> float:
    """Where the weight of its spectrum lies, in Hz: low for dull, high for bright."""
    m = mono(x)
    spec = np.abs(np.fft.rfft(m * np.hanning(len(m))))
    f = np.fft.rfftfreq(len(m), 1 / SR)
    return float((spec * f).sum() / max(spec.sum(), 1e-12))


def band_db(x: np.ndarray, lo: float, hi: float) -> float:
    """How much of it lies between two frequencies, in dB against the whole."""
    m = mono(x)
    spec = np.abs(np.fft.rfft(m)) ** 2
    f = np.fft.rfftfreq(len(m), 1 / SR)
    part = spec[(f >= lo) & (f < hi)].sum()
    return float(10 * np.log10(max(part, 1e-20) / max(spec.sum(), 1e-20)))
