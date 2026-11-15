/**
 * Easing curves and a small tween scheduler driven by the frame loop.
 * Nothing in the game moves linearly, so every tween takes an easing curve.
 */
export type Ease = (t: number) => number;

export const Easing = {
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  outQuint: (t: number) => 1 - Math.pow(1 - t, 5),
  /** Overshoots its target by about 10% and settles back. */
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
} satisfies Record<string, Ease>;

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
export function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

interface Active {
  elapsed: number;
  delay: number;
  duration: number;
  ease: Ease;
  update: (k: number) => void;
  resolve: () => void;
}

export interface TweenOptions {
  /** Seconds. */
  duration: number;
  /** Seconds to wait before starting. */
  delay?: number;
  ease?: Ease;
  /** Called with the eased progress, 0 at the start and exactly 1 on the final call. */
  update: (k: number) => void;
}

export class Tweens {
  private active: Active[] = [];

  /** Start a tween. The promise resolves after the final update. */
  run(o: TweenOptions): Promise<void> {
    return new Promise((resolve) => {
      this.active.push({
        elapsed: 0,
        delay: o.delay ?? 0,
        duration: Math.max(o.duration, 1e-4),
        ease: o.ease ?? Easing.inOutCubic,
        update: o.update,
        resolve,
      });
    });
  }

  /** A pause that respects the same clock as the tweens. */
  wait(seconds: number): Promise<void> {
    return this.run({ duration: seconds, update: () => {} });
  }

  get busy(): boolean {
    return this.active.length > 0;
  }

  update(dt: number): void {
    if (this.active.length === 0) return;
    const current = this.active;
    const still: Active[] = [];
    this.active = still;
    for (const a of current) {
      a.elapsed += dt;
      const t = (a.elapsed - a.delay) / a.duration;
      if (t < 0) {
        still.push(a);
      } else if (t >= 1) {
        a.update(1);
        a.resolve();
      } else {
        a.update(a.ease(t));
        still.push(a);
      }
    }
  }

  /** Jump every running tween to its end state. */
  finishAll(): void {
    const current = this.active;
    this.active = [];
    for (const a of current) {
      a.update(1);
      a.resolve();
    }
  }
}
