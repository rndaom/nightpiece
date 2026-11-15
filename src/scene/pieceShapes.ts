/**
 * Grey-box piece shapes, drawn for a moment while the Blender pieces load
 * (and for good if they fail): rough Staunton forms in turned blocks, with
 * a seam of light and one eye each, built to the style bible's height ladder
 * (king = 1.7 squares) so that the swap to the real pieces does not jolt.
 *
 * Each piece is described as a list of parts. Stone parts merge into one
 * geometry and glowing parts into another, so a piece costs two draw calls.
 * Local axes: +y up, -z is the direction the piece faces.
 */
import { BoxGeometry, BufferGeometry, CylinderGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Kind } from '../core/game';

/** An n-sided block, optionally tapered. `w` is the width across flats; `y` is its underside. */
interface Prism {
  t: 'prism';
  n: number;
  w: number;
  top?: number;
  h: number;
  y: number;
  x?: number;
  z?: number;
  /** Extra turn about the vertical axis, in radians. */
  turn?: number;
  glow?: boolean;
}
/** A rectangular block. `y` is its underside unless `cy` gives the centre height. */
interface Box {
  t: 'box';
  w: number;
  h: number;
  d: number;
  y?: number;
  cy?: number;
  x?: number;
  z?: number;
  /** Tilt about x, in radians: less than nothing leans its top forward. */
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  glow?: boolean;
}
/** A glowing disc: an eye on the front face, or a mark on a top face. */
interface Disc {
  t: 'disc';
  r: number;
  y: number;
  x?: number;
  z?: number;
  face: 'front' | 'up';
}
type Part = Prism | Box | Disc;

const SEAM = 0.022;

const seam = (w: number, y: number, n = 4, extra: Partial<Prism> = {}): Prism => ({
  t: 'prism',
  n,
  w,
  h: SEAM,
  y,
  glow: true,
  ...extra,
});

/** A turned block: twelve flats to the round, like the Blender pieces, tapering from `w` to `top`. */
const turn = (w: number, h: number, y: number, top?: number): Prism => ({ t: 'prism', n: 12, w, top, h, y });

const SHAPES: Record<Kind, Part[]> = {
  // A ball on a collar on a flared stem, with a small round eye.
  p: [
    turn(0.56, 0.1, 0),
    turn(0.43, 0.26, 0.1, 0.24),
    turn(0.35, 0.07, 0.36),
    seam(0.18, 0.43, 12),
    turn(0.2, 0.12, 0.45, 0.34),
    turn(0.34, 0.14, 0.57),
    turn(0.34, 0.15, 0.71, 0.18),
    { t: 'disc', r: 0.011, y: 0.673, z: -0.172, face: 'front' },
  ],
  // A flared drum, a collar, a turret with an arrow slit.
  r: [
    turn(0.64, 0.1, 0),
    turn(0.5, 0.55, 0.1, 0.38),
    turn(0.47, 0.08, 0.65),
    seam(0.36, 0.73, 12),
    turn(0.4, 0.07, 0.75, 0.52),
    turn(0.52, 0.26, 0.82),
    { t: 'box', w: 0.026, h: 0.1, d: 0.012, y: 0.85, z: -0.262, glow: true },
  ],
  // A horse on a turned plinth, the only piece that overhangs its square: an arched neck, a long
  // head carried low on a leaning joint, deep in the jaw, with an eye in each side and a mane behind.
  n: [
    turn(0.64, 0.1, 0),
    turn(0.47, 0.1, 0.1, 0.43),
    { t: 'box', w: 0.28, h: 0.56, d: 0.42, cy: 0.46, z: 0.0, rotX: 0.12 },
    { t: 'box', w: 0.1, h: 0.5, d: 0.08, cy: 0.66, z: 0.28, rotX: -0.15 },
    { t: 'box', w: 0.22, h: SEAM, d: 0.46, cy: 0.7, z: 0.065, rotX: -0.73, glow: true },
    { t: 'box', w: 0.22, h: 0.24, d: 0.6, cy: 0.88, z: -0.12, rotX: -0.72 },
    { t: 'box', w: 0.29, h: 0.2, d: 0.26, cy: 0.84, z: 0.03, rotX: -0.72 },
    { t: 'box', w: 0.232, h: 0.026, d: 0.09, cy: 0.968, z: -0.02, rotX: -0.72, glow: true },
    { t: 'box', w: 0.05, h: 0.14, d: 0.05, y: 1.12, x: -0.06, z: 0.07 },
    { t: 'box', w: 0.05, h: 0.14, d: 0.05, y: 1.12, x: 0.06, z: 0.07 },
  ],
  // A mitre with a diagonal slit of light, and a ball for a finial.
  b: [
    turn(0.6, 0.1, 0),
    turn(0.46, 0.6, 0.1, 0.25),
    turn(0.37, 0.07, 0.7),
    seam(0.2, 0.77, 12),
    turn(0.26, 0.15, 0.79, 0.33),
    turn(0.33, 0.29, 0.94, 0.12),
    { t: 'box', w: 0.3, h: 0.026, d: 0.18, cy: 1.04, z: -0.08, rotZ: 0.62, glow: true },
    turn(0.12, 0.12, 1.27),
  ],
  // A coronet flaring round a ball, a jewel in its front.
  q: [
    turn(0.64, 0.1, 0),
    turn(0.5, 0.82, 0.1, 0.26),
    turn(0.39, 0.07, 0.92),
    seam(0.2, 0.99, 12),
    turn(0.22, 0.31, 1.01, 0.43),
    turn(0.43, 0.08, 1.32),
    { t: 'disc', r: 0.016, y: 1.3, z: -0.19, face: 'front' },
    turn(0.13, 0.145, 1.42),
  ],
  // The tallest: a crown flaring to a flat top, and a cross.
  k: [
    turn(0.7, 0.11, 0),
    turn(0.56, 0.85, 0.11, 0.29),
    turn(0.42, 0.1, 0.96),
    seam(0.24, 1.06, 12),
    turn(0.25, 0.3, 1.08, 0.45),
    turn(0.4, 0.06, 1.38),
    { t: 'disc', r: 0.024, y: 1.29, z: -0.18, face: 'front' },
    { t: 'box', w: 0.09, h: 0.26, d: 0.08, y: 1.44 },
    { t: 'box', w: 0.28, h: 0.09, d: 0.08, y: 1.55 },
    { t: 'box', w: 0.08, h: 0.09, d: 0.28, y: 1.55 },
  ],
};

/** Overall heights in squares. The style bible's ladder: king = 1.7. */
export const PIECE_HEIGHT: Record<Kind, number> = { p: 0.86, r: 1.08, n: 1.26, b: 1.39, q: 1.565, k: 1.7 };

function partGeometry(part: Part): BufferGeometry {
  let g: BufferGeometry;
  if (part.t === 'prism') {
    const radius = (w: number) => w / 2 / Math.cos(Math.PI / part.n);
    g = new CylinderGeometry(
      radius(part.top ?? part.w),
      radius(part.w),
      part.h,
      part.n,
      1,
      false,
      Math.PI / part.n + (part.turn ?? 0),
    );
    g.translate(part.x ?? 0, part.y + part.h / 2, part.z ?? 0);
  } else if (part.t === 'box') {
    g = new BoxGeometry(part.w, part.h, part.d);
    if (part.rotX) g.rotateX(part.rotX);
    if (part.rotY) g.rotateY(part.rotY);
    if (part.rotZ) g.rotateZ(part.rotZ);
    g.translate(part.x ?? 0, part.cy ?? (part.y ?? 0) + part.h / 2, part.z ?? 0);
  } else {
    const t = 0.012;
    g = new CylinderGeometry(part.r, part.r, t, 20);
    if (part.face === 'front') {
      g.rotateX(Math.PI / 2);
      g.translate(part.x ?? 0, part.y, (part.z ?? 0) - t / 2);
    } else {
      g.translate(part.x ?? 0, part.y + t / 2, part.z ?? 0);
    }
  }
  // Flat shading for the faceted parts: unshare vertices so each face gets its own normal.
  const flat = part.t !== 'prism' || part.n <= 12;
  const out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  if (flat) out.computeVertexNormals();
  return out;
}

export interface PieceGeometry {
  body: BufferGeometry;
  glow: BufferGeometry;
  height: number;
}

const cache = new Map<Kind, PieceGeometry>();

/** Shared geometry for a kind of piece. Do not dispose; it is reused by every piece of that kind. */
export function pieceGeometry(kind: Kind): PieceGeometry {
  let entry = cache.get(kind);
  if (!entry) {
    const body: BufferGeometry[] = [];
    const glow: BufferGeometry[] = [];
    for (const part of SHAPES[kind]) {
      const isGlow = part.t === 'disc' || part.glow === true;
      (isGlow ? glow : body).push(partGeometry(part));
    }
    entry = { body: mergeGeometries(body), glow: mergeGeometries(glow), height: PIECE_HEIGHT[kind] };
    for (const g of [...body, ...glow]) g.dispose();
    cache.set(kind, entry);
  }
  return entry;
}
