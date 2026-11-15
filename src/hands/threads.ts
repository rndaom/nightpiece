/**
 * Threads of light from three fingertips to the piece a hand is considering
 * (style bible, 6.4). They say "puppeteer" and show both players which piece
 * is under thought; they vanish the moment the hand commits.
 *
 * Each thread hangs in a shallow curve, a little stronger where it leaves the
 * finger and where it meets the piece than in the air between, and finer at
 * the piece than at the finger. A slow pulse of light runs down it.
 */
import type { Color, Vector3 } from 'three';
import { Strands } from './strands';

const THREADS = 3;
const NODES = 14;

export class Threads {
  readonly strands: Strands;
  /** 0 hidden to 1 fully drawn. Set each frame by the owner. */
  strength = 0;

  constructor(rim: Color) {
    this.strands = new Strands(
      rim,
      THREADS,
      NODES,
      {
        width: 1.5,
        taper: (k) => 1 - 0.45 * k,
        light: (k) => 0.3 + 0.7 * Math.pow(Math.abs(2 * k - 1), 1.6),
        pulses: 1,
        flow: 0.9,
      },
      // Over everything else that is light.
      8,
    );
    this.strands.level = 1.3;
  }

  /** Lay the threads between pairs of points: `from[i]` at a fingertip to `to[i]` on the piece. */
  update(from: Vector3[], to: Vector3[], time: number): void {
    this.strands.strength = this.strength;
    if (this.strength > 0.01) {
      for (let t = 0; t < THREADS; t++) {
        const a = from[t]!;
        const b = to[t]!;
        const sag = 0.05 + 0.03 * Math.sin(time * 1.3 + t * 2.1);
        for (let n = 0; n < NODES; n++) {
          const k = n / (NODES - 1);
          this.strands.set(t, n, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k - sag * 4 * k * (1 - k), a.z + (b.z - a.z) * k);
        }
      }
    }
    this.strands.commit(time);
  }

  dispose(): void {
    this.strands.dispose();
  }
}
