import { useCurrentFrame } from 'remotion';

/**
 * Drawn things in the film boil: an outline is not the same line twice, as when each drawing of
 * a held picture is traced afresh. They are redrawn ten times a second (every sixth frame), not
 * every frame, which is what makes it look drawn and not shaken.
 */
export const HOLD = 6;

/** Which drawing this frame shows. `offset` puts a thing out of step with its neighbours. */
export function useBoil(offset = 0): number {
  return Math.floor((useCurrentFrame() + offset) / HOLD);
}

/** A number from a name, to seed with. */
export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Numbers between 0 and 1 that come out the same every time for the same seed. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Point = [number, number];

/**
 * The edge of a sheet cut by hand: the corners of a `w` by `h` rectangle and points along its
 * sides, each put out of true by up to `rough`. The corners are cut a little off square.
 */
export function cutEdge(w: number, h: number, rough: number, seed: number, every = 46): Point[] {
  const r = random(seed);
  const j = (k = 1) => (r() * 2 - 1) * rough * k;
  const points: Point[] = [];
  const side = (ax: number, ay: number, bx: number, by: number) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / every));
    // Along the side, and across it.
    const [ux, uy] = [(bx - ax) / n, (by - ay) / n];
    const len = Math.hypot(ux, uy);
    const [nx, ny] = [-uy / len, ux / len];
    for (let i = 0; i < n; i++) {
      const along = i === 0 ? 0 : j(0.35) * 6;
      const across = j(i === 0 ? 1.6 : 1);
      points.push([ax + ux * i + (ux / len) * along + nx * across, ay + uy * i + (uy / len) * along + ny * across]);
    }
  };
  side(0, 0, w, 0);
  side(w, 0, w, h);
  side(w, h, 0, h);
  side(0, h, 0, 0);
  return points;
}

export const pathOf = (points: Point[], closed = true): string =>
  points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join('') + (closed ? 'Z' : '');

/** A line drawn by hand from one point to another: not quite straight, and not quite the same each drawing. */
export function wobble(points: Point[], amount: number, seed: number, every = 22): Point[] {
  const r = random(seed);
  const out: Point[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / every));
    for (let k = 0; k < n; k++) {
      const u = k / n;
      out.push([a[0] + (b[0] - a[0]) * u + (r() * 2 - 1) * amount, a[1] + (b[1] - a[1]) * u + (r() * 2 - 1) * amount]);
    }
  }
  const last = points[points.length - 1]!;
  out.push([last[0] + (r() * 2 - 1) * amount, last[1] + (r() * 2 - 1) * amount]);
  return out;
}

/** A smooth curve through points, as a path (Catmull-Rom, drawn as cubics). */
export function curveOf(points: Point[], closed = false): string {
  const n = points.length;
  if (n < 3) return pathOf(points, closed);
  const at = (i: number) => (closed ? points[((i % n) + n) % n]! : points[Math.max(0, Math.min(n - 1, i))]!);
  let d = `M${at(0)[0].toFixed(2)} ${at(0)[1].toFixed(2)}`;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return closed ? `${d}Z` : d;
}
