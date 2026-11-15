import { describe, expect, it } from 'vitest';
import { Governor, refreshOf, STEPS, type Step } from './pace';

/** Low on a desktop: drawn at 0.8 of a pixel, never under half a pixel, and no smoothing of edges to give up (see governorSteps). */
const LOW = [STEPS[0]!, STEPS[1]!, STEPS[2]!, STEPS[4]!];
const lowShare = (s: Step) => (Math.max(0.5, 0.8 * s.scale) / 0.8) ** 2;
/** Low on a phone: never under three quarters of its budget. */
const PHONE = [STEPS[0]!, STEPS[1]!, STEPS[2]!];
const phoneShare = (s: Step) => Math.max(0.75, s.scale) ** 2;
/** Medium or High on a desktop: every step, and smoothing worth some of the cost. */
const allShare = (s: Step) => s.scale * s.scale * (s.smooth ? 1 : 0.75);

/**
 * A machine: a frame costs `fixed` milliseconds plus `pixel` times the share of the full-size
 * pixels drawn; 15% more while a stone is carried (2.5 s of every 8) and a little either way from
 * frame to frame. `pauses` adds what is not load: memory collected now and then, and a stall.
 */
type Machine = { hz: number; fixed: number; pixel: number; share?: (s: Step) => number; carry?: number; pauses?: boolean };

/**
 * A governor driven by a machine on a screen that shows a frame at the first refresh after it is
 * done, as the game hands it frames (see `watchPace`). Its own time carries on from run to run.
 * Everything is worked out from a seeded stream of numbers: no clock or timer is read.
 */
class Bench {
  readonly g = new Governor();
  /** Milliseconds since the start; the times, in seconds, of every change of size. */
  t = 0;
  changes: number[] = [];
  private seed = 12345;

  constructor(steps?: readonly Step[]) {
    if (steps) this.g.use(steps);
  }

  private random(): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return this.seed / 4294967296;
  }

  /** Run for some seconds. Returns the share of frames shown late, and the longest run of seconds with over 5% late in the last ten. */
  run(seconds: number, m: Machine): { late: number; worst: number } {
    const beat = 1000 / m.hz;
    const share = m.share ?? allShare;
    const end = this.t + seconds * 1000;
    const recent: boolean[] = [];
    let frames = 0;
    let late = 0;
    let bad = 0;
    let worst = 0;
    let lateRecent = 0;
    while (this.t < end) {
      const step = { scale: this.g.scale, smooth: this.g.smooth };
      const carried = (this.t / 1000) % 8 < 2.5 ? (m.carry ?? 1.15) : 1;
      const cost = (m.fixed + m.pixel * share(step)) * carried * (0.96 + 0.08 * this.random());
      let pause = 0;
      if (m.pauses && this.random() < beat / 4000) pause = 10 + 30 * this.random();
      if (m.pauses && this.random() < beat / 60000) pause = 300;
      const shown = Math.max(1, Math.ceil(cost / beat - 1e-6));
      const elapsed = Math.max(1, Math.ceil((cost + pause) / beat - 1e-6)) * beat;
      this.t += elapsed;
      if (elapsed < 1000 && this.g.feed(Math.min(elapsed, 250))) this.changes.push(this.t / 1000);
      frames++;
      if (shown > 1) late++;
      // Over 5% late in the last ten seconds' worth of frames, and for how long on end.
      recent.push(shown > 1);
      if (shown > 1) lateRecent++;
      if (recent.length > m.hz * 10 && recent.shift()) lateRecent--;
      if (recent.length >= m.hz * 5 && lateRecent > recent.length * 0.05) {
        bad += elapsed / 1000;
        worst = Math.max(worst, bad);
      } else {
        bad = 0;
      }
    }
    return { late: late / frames, worst };
  }

  /** How many times the size changed after `from` seconds. */
  since(from: number): number {
    return this.changes.filter((t) => t > from).length;
  }

  /** The tab hidden for some seconds: no frames, and the first one after is too long to count. */
  hide(seconds: number): void {
    this.t += seconds * 1000;
    this.g.feed(Math.min(seconds * 1000, 250));
  }
}

describe('the refresh found from frame times', () => {
  const at = (ms: number, n: number) => Array.from({ length: n }, () => ms);

  it('stands while frames lie on its multiples', () => {
    expect(refreshOf([...at(16.667, 50), ...at(33.333, 10), ...at(50, 4)], 1000 / 60)).toBeCloseTo(16.667, 2);
    // Rounded to the millisecond, as some browsers give their times.
    expect(refreshOf([...at(16, 20), ...at(17, 40)], 1000 / 60)).toBeCloseTo(16.667, 2);
  });

  it('is found quicker than sixty a second from frames that come between its multiples', () => {
    expect(refreshOf([...at(8.333, 30), ...at(16.667, 30)], 1000 / 60)).toBeCloseTo(8.333, 2);
    // Every frame in two refreshes of a screen at 144, with some in three: no screen at 72 is made.
    expect(refreshOf([...at(13.889, 50), ...at(20.833, 5)], 1000 / 60)).toBeCloseTo(6.944, 2);
    expect(refreshOf(at(13.889, 50), 1000 / 60)).toBeCloseTo(6.944, 2);
  });

  it('is not led astray by a few long frames, nor by a screen that waits for each frame', () => {
    expect(refreshOf([...at(16.667, 60), 45, 46, 61], 1000 / 60)).toBeCloseTo(16.667, 2);
    const waits = Array.from({ length: 60 }, (_, i) => 10 + (i % 10) * 0.25);
    expect(refreshOf(waits, 1000 / 60)).toBeGreaterThan(9.9);
    expect(refreshOf(waits, 1000 / 60)).toBeLessThanOrEqual(11);
  });
});

describe('Governor', () => {
  it('leaves a machine that keeps up alone, at sixty, a hundred and twenty or a hundred and forty-four a second', () => {
    for (const hz of [60, 120, 144]) {
      const b = new Bench();
      const room = (0.75 * 1000) / hz / 1.15;
      b.run(900, { hz, fixed: room * 0.25, pixel: room * 0.75, pauses: true });
      b.hide(20);
      b.run(300, { hz, fixed: room * 0.25, pixel: room * 0.75, pauses: true });
      expect(b.changes, `${hz}`).toEqual([]);
      expect(b.g.refresh).toBeCloseTo(1000 / hz, 1);
    }
  });

  it('draws smaller a picture whose frames cost a little more than a refresh, which a mean of frame times took for smooth', () => {
    // Low at 1366 by 768 on integrated graphics: 21 ms a frame at full size, and at 0.85 about
    // 16, where one frame in ten or so is late; at 0.72 none are.
    const laptop = { hz: 60, fixed: 5, pixel: 16, share: lowShare, carry: 1.05 };
    const b = new Bench(LOW);
    b.run(15, laptop);
    expect(b.g.scale).toBe(0.72);
    const after = b.changes.length;
    const { late, worst } = b.run(900, laptop);
    expect(late).toBeLessThan(0.02);
    // A try of the larger size, after six minutes, is the only time frames run late, and briefly.
    expect(worst).toBeLessThan(20);
    expect(b.changes.length - after).toBeLessThanOrEqual(3);
    expect(b.g.scale).toBe(0.72);
  });

  it('never sits for long with many frames late while a smaller size would help', () => {
    for (const fixed of [2, 5, 8]) {
      for (const pixel of [14, 18, 24, 30]) {
        const b = new Bench();
        const { worst } = b.run(600, { hz: 60, fixed, pixel });
        expect(worst, `${fixed} + ${pixel}`).toBeLessThanOrEqual(20);
      }
    }
  });

  it('finds a screen at 144 from frames that take two of its refreshes, and draws small enough to take one', () => {
    const b = new Bench();
    const fast = { hz: 144, fixed: 2.5, pixel: 7.5 };
    b.run(15, fast);
    expect(b.g.refresh).toBeCloseTo(1000 / 144, 1);
    expect(b.run(300, fast).late).toBeLessThan(0.02);
  });

  it('tries a larger size seldom, and more seldom each time it does not hold', () => {
    const b = new Bench(LOW);
    const laptop = { hz: 60, fixed: 5, pixel: 16, share: lowShare, carry: 1.05 };
    b.run(15, laptop);
    const settled = b.changes.length;
    b.run(3600, laptop);
    // Each try is a step up and one back: after six minutes, then twelve, then twenty-four at most.
    const tries = b.changes.slice(settled).filter((_, i) => i % 2 === 0);
    expect(tries.length).toBeGreaterThanOrEqual(3);
    expect(tries.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < tries.length; i++) expect(tries[i]! - tries[i - 1]!).toBeGreaterThanOrEqual(Math.min(1440, 360 * 2 ** i) - 5);
    expect(b.g.scale).toBe(0.72);
  });

  it('draws larger again at its next try when the load falls by a third', () => {
    const b = new Bench(LOW);
    b.run(400, { hz: 60, fixed: 5, pixel: 16, share: lowShare, carry: 1.05 });
    expect(b.g.scale).toBe(0.72);
    // The try after six minutes did not hold, so the next is twelve minutes after it.
    expect(b.changes.filter((t) => t > 15)).toHaveLength(2);
    b.run(750, { hz: 60, fixed: 5 * (2 / 3), pixel: 16 * (2 / 3), share: lowShare, carry: 1.05 });
    expect(b.g.scale).toBe(1);
  });

  it('does not take pauses for load: memory collected, a stall, the tab brought back', () => {
    const b = new Bench();
    const busy = { hz: 60, fixed: 3, pixel: 9 };
    for (let i = 0; i < 20; i++) {
      b.run(30, busy);
      // Two frames of a stall, and a burst of shaders built at a first move.
      b.g.feed(250);
      b.g.feed(180);
      for (let k = 0; k < 4; k++) b.g.feed(50);
      b.hide(5);
    }
    expect(b.changes).toEqual([]);
  });

  it('comes to rest on a machine that is not smooth at any size', () => {
    // Bound by its pixels: at the least size frames still take two refreshes, and stay there.
    const pixels = new Bench();
    pixels.run(30, { hz: 60, fixed: 4, pixel: 80 });
    expect(pixels.g.scale).toBe(0.5);
    pixels.run(900, { hz: 60, fixed: 4, pixel: 80 });
    expect(pixels.since(30)).toBe(0);
    // Bound by something else: smaller buys nothing, so it goes back to full size and stays,
    // trying the least size again only after ten minutes, then twenty.
    const other = new Bench();
    other.run(30, { hz: 60, fixed: 20, pixel: 4 });
    expect(other.g.scale).toBe(1);
    other.run(900, { hz: 60, fixed: 20, pixel: 4 });
    expect(other.since(30)).toBeLessThanOrEqual(2);
    expect(other.g.scale).toBe(1);
  });

  it('goes back to full size on a screen that refreshes thirty times a second, and stays there', () => {
    const b = new Bench();
    b.run(30, { hz: 30, fixed: 3, pixel: 9 });
    expect(b.g.scale).toBe(1);
    const first = b.changes.length;
    const { late } = b.run(3600, { hz: 30, fixed: 3, pixel: 9 });
    expect(late).toBe(0);
    // Smaller is tried again for a moment after ten minutes, then twenty, then forty.
    expect(b.changes.length - first).toBeLessThanOrEqual(6);
    expect(b.g.scale).toBe(1);
  });

  it('goes no lower than the least step a phone is given', () => {
    const b = new Bench(PHONE);
    b.run(60, { hz: 60, fixed: 4, pixel: 60, share: phoneShare });
    expect(b.g.scale).toBe(0.72);
    expect(b.since(20)).toBe(0);
  });

  it('starts again at full size when reset, still knowing the refresh', () => {
    const b = new Bench();
    b.run(30, { hz: 144, fixed: 2.5, pixel: 7.5 });
    expect(b.g.scale).toBeLessThan(1);
    b.g.reset();
    expect(b.g.scale).toBe(1);
    expect(b.g.refresh).toBeCloseTo(1000 / 144, 1);
  });

  it('never stands on a step that is not in the list it was given', () => {
    const b = new Bench(LOW);
    for (let i = 0; i < 600; i++) {
      b.run(1, { hz: 60, fixed: 3, pixel: 20 + (i % 120) / 4, share: lowShare });
      expect(LOW.some((s) => s.scale === b.g.scale && s.smooth === b.g.smooth)).toBe(true);
    }
  });

  it('keeps its size when given new steps, or takes the nearest larger one', () => {
    const b = new Bench();
    b.run(30, { hz: 60, fixed: 4, pixel: 80 });
    expect(b.g.scale).toBe(0.5);
    // The same steps again change nothing; a list without that size has it drawn at the next larger.
    expect(b.g.use(STEPS.slice())).toBe(false);
    expect(b.g.scale).toBe(0.5);
    expect(b.g.use([STEPS[0]!, STEPS[1]!])).toBe(true);
    expect(b.g.scale).toBe(0.85);
    expect(b.g.use(STEPS)).toBe(false);
    expect(b.g.scale).toBe(0.85);
  });
});
