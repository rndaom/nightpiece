/**
 * World layout. One unit is one board square. The board is centred on the
 * origin with its playing surface at y = 0. Ivory (white) sits on the +z
 * side, so rank 1 is at z = +3.5 and the a-file is at x = -3.5.
 */
import { Vector3 } from 'three';
import { fileOf, rankOf, squareOf, type Square } from '../core/game';

/** Colours from the style bible, section 3.4. */
export const PALETTE = {
  soot: 0x0c0b09,
  formwork: 0x25231f,
  concrete: 0x57534b,
  dust: 0xa39d8d,
  bone: 0xece3cc,
  candle: 0xeadbb0,
  whiteHeat: 0xfffeee,
  gilt: 0xc9a45c,
  void: 0x050806,
  deep: 0x1b4a37,
  spirit: 0x59e5cc,
  paleSpirit: 0xc3fbf2,
  violet: 0x715294,
  plum: 0x2a1b33,
  ember: 0xd0634a,
  oldBlood: 0xa75a5f,
} as const;

/**
 * The board is a case, open on the altar (see assets/src/case.py): the squares are set in
 * a field FIELD_HALF each way from the middle, a walnut rim rises round them to RIM_TOP, and the
 * case's outside is SLAB_HALF from the middle. Its foot stands on the altar's top.
 */
export const FIELD_HALF = 4.0;
export const RIM_TOP = 0.1;
export const SLAB_HALF = 4.8;
/** The baize floor of the drawers, where taken stones stand. */
export const PLINTH_TOP = -0.67;
/**
 * The drawers, out: one under each side rail of each half, its baize running from the case's side
 * out to DRAWER_OUT across x, and from DRAWER_NEAR to DRAWER_FAR out from the hinge line along z.
 */
export const DRAWER_OUT = 5.865;
export const DRAWER_NEAR = 0.19;
export const DRAWER_FAR = 4.41;
/** The altar's top and how far it reaches; then the floor. */
export const ALTAR_TOP = -1;
export const ALTAR_HALF = 6.2;
export const FLOOR_Y = -3;

/** The height of whatever a piece would stand on at a point: the squares, the rim, a drawer's baize, the altar or the floor. */
export function groundAt(x: number, z: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const reach = Math.max(ax, az);
  if (reach <= FIELD_HALF) return 0;
  if (reach <= SLAB_HALF) return RIM_TOP;
  if (ax <= DRAWER_OUT && az >= DRAWER_NEAR && az <= DRAWER_FAR) return PLINTH_TOP;
  return reach <= ALTAR_HALF ? ALTAR_TOP : FLOOR_Y;
}

export function squareCenter(square: Square, out: Vector3 = new Vector3()): Vector3 {
  return out.set(fileOf(square) - 3.5, 0, 3.5 - rankOf(square));
}

/** The square under a point on the board plane, or null if the point is off the 8 by 8 grid. */
export function squareAt(x: number, z: number): Square | null {
  const file = Math.floor(x + 4);
  const rank = Math.floor(4 - z);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return squareOf(file, rank);
}
