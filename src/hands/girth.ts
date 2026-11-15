/**
 * What a piece is like to take hold of: how far out its stone reaches at each
 * height, each way round its own plumb line.
 *
 * A hand closes its fingers on a piece until they meet it, wherever that is:
 * on a flat of its head, on a corner, over its shoulder. This is how the
 * fingers know where the stone is. It is read from the piece's own shape the
 * first time a hand takes hold of one of its kind, so nothing in the hands
 * knows what any piece looks like, and a piece can be reshaped without a word
 * to them.
 *
 * The stone is kept as a drum of numbers, a row for each thin band of height
 * and a number for each narrow wedge of the way round: the farthest the stone
 * reaches in that wedge at that height. A piece is not hollow, so that is
 * enough to say whether a point is inside it.
 */
import { type BufferGeometry, Mesh, type Object3D, type Vector3 } from 'three';

/** How tall a band is, in squares, and how many wedges there are to the round. */
const BAND = 0.02;
const AROUND = 48;
/** The stone is felt for with points no farther apart than this, and no more than this many to a side of one face. */
const GRAIN = 0.012;
const FINEST = 48;
/** A part of the stone ends where it has drawn in to this share of its thickest. */
const NECK = 0.85;

const known = new WeakMap<BufferGeometry, Girth>();

export class Girth {
  private reach: Float32Array;
  /** The farthest the stone reaches in each band, whichever way. */
  private most: Float32Array;
  private bands: number;
  private low: number;

  /** The girth of whatever stone `object` is drawn with, and the mesh it was read from (whose space it is in); null if it has none. */
  static of(object: Object3D): { girth: Girth; mesh: Mesh } | null {
    const mesh = stoneOf(object);
    if (!mesh) return null;
    let girth = known.get(mesh.geometry);
    if (!girth) known.set(mesh.geometry, (girth = new Girth(mesh.geometry)));
    return { girth, mesh };
  }

  constructor(geometry: BufferGeometry) {
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < position.count; i++) {
      low = Math.min(low, position.getY(i));
      high = Math.max(high, position.getY(i));
    }
    if (!(high > low)) {
      low = 0;
      high = BAND;
    }
    this.low = low;
    this.bands = Math.max(1, Math.ceil((high - low) / BAND));
    this.reach = new Float32Array(this.bands * AROUND);
    this.most = new Float32Array(this.bands);
    const corners = index ? index.count : position.count;
    const p = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let t = 0; t + 2 < corners; t += 3) {
      for (let k = 0; k < 3; k++) {
        const i = index ? index.getX(t + k) : t + k;
        p[k * 3] = position.getX(i);
        p[k * 3 + 1] = position.getY(i);
        p[k * 3 + 2] = position.getZ(i);
      }
      const side = (a: number, b: number) => Math.hypot(p[a]! - p[b]!, p[a + 1]! - p[b + 1]!, p[a + 2]! - p[b + 2]!);
      // Points all over the face, not only at its corners: a wide flat has stone in every wedge it crosses.
      const n = Math.min(FINEST, Math.max(1, Math.ceil(Math.max(side(0, 3), side(3, 6), side(6, 0)) / GRAIN)));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; i + j <= n; j++) {
          const a = i / n;
          const b = j / n;
          const c = 1 - a - b;
          this.note(p[0]! * c + p[3]! * a + p[6]! * b, p[1]! * c + p[4]! * a + p[7]! * b, p[2]! * c + p[5]! * a + p[8]! * b);
        }
      }
    }
  }

  private note(x: number, y: number, z: number): void {
    const band = Math.min(this.bands - 1, Math.max(0, Math.floor((y - this.low) / BAND)));
    const cell = band * AROUND + wedge(x, z);
    const out = Math.hypot(x, z);
    if (out > this.reach[cell]!) this.reach[cell] = out;
    if (out > this.most[band]!) this.most[band] = out;
  }

  /** How far the stone reaches from its plumb line at `height`, toward (x, z), in its own space. Nothing above it or below. */
  at(height: number, x: number, z: number): number {
    const band = Math.floor((height - this.low) / BAND);
    if (band < 0 || band >= this.bands) return 0;
    const w = wedge(x, z);
    const row = band * AROUND;
    // A finger is wider than a wedge: the stone to either side counts too.
    return Math.max(this.reach[row + w]!, this.reach[row + ((w + 1) % AROUND)]!, this.reach[row + ((w + AROUND - 1) % AROUND)]!);
  }

  /** How deep a ball is in the stone, its centre given in the stone's own space; less than nothing when it is clear of it. */
  depth(centre: Vector3, radius: number): number {
    const out = Math.hypot(centre.x, centre.z);
    let deepest = -Infinity;
    // The ball is felt at several heights: a ball above a shoulder touches it with its underside.
    for (const lift of [-1, -0.7, 0, 0.7, 1]) {
      const stone = this.at(centre.y + lift * radius, centre.x, centre.z);
      if (stone <= 0) continue;
      deepest = Math.max(deepest, stone + radius * Math.sqrt(1 - lift * lift) - out);
    }
    return deepest;
  }

  /**
   * How high the stone stands, above its own foot, within `reach` of a plumb line that is `distance`
   * from its own; nothing if none of it comes so near. The stone is taken to be as wide all the way
   * round as it is at its widest, which is what something passing over it wants to know.
   */
  over(distance: number, reach: number): number {
    for (let band = this.bands - 1; band >= 0; band--) {
      const stone = this.most[band]!;
      if (stone > 0 && stone + reach >= distance) return this.low + (band + 1) * BAND;
    }
    return 0;
  }

  /** The farthest the stone reaches from its plumb line at `height` or anywhere above it. */
  widest(height: number): number {
    let most = 0;
    for (let band = Math.max(0, Math.floor((height - this.low) / BAND)); band < this.bands; band++) most = Math.max(most, this.most[band]!);
    return most;
  }

  /**
   * The head of the stone, where a hand could close on it from above: the highest part of it that
   * is at least `least` thick all the way round, taken on down for as long as it stays nearly as
   * thick as that part is at its thickest, if that makes at least `tall` of height. The height of
   * its middle above the foot, and the least it reaches from the plumb line there; null if the
   * stone has no such part.
   */
  head(least: number, tall = 0.1): { y: number; half: number } | null {
    let top = -1;
    let thickest = 0;
    for (let band = this.bands - 1; band >= -1; band--) {
      let thin = band >= 0 ? Infinity : 0;
      for (let w = 0; band >= 0 && w < AROUND; w++) thin = Math.min(thin, this.reach[band * AROUND + w]!);
      if (thin >= Math.max(least, thickest * NECK)) {
        if (top < 0) top = band;
        thickest = Math.max(thickest, thin);
        continue;
      }
      // The part from the band above this one up to `top` has ended.
      if (top >= 0 && (top - band) * BAND >= tall) {
        const middle = Math.round((top + band + 1) / 2);
        let half = Infinity;
        for (let w = 0; w < AROUND; w++) half = Math.min(half, this.reach[middle * AROUND + w]!);
        return { y: this.low + (middle + 0.5) * BAND, half };
      }
      top = thin >= least ? band : -1;
      thickest = top < 0 ? 0 : thin;
    }
    return null;
  }

  /**
   * How far the stone goes on from a point inside it (in its own space), along the level direction
   * (dx, dz), looking no farther than `most`. Nothing if the point is not in the stone at all.
   */
  across(from: Vector3, dx: number, dz: number, most: number): number {
    const size = Math.hypot(dx, dz) || 1;
    let last = 0;
    for (let s = 0; s <= most; s += 0.004) {
      const x = from.x + (dx / size) * s;
      const z = from.z + (dz / size) * s;
      if (Math.hypot(x, z) <= this.at(from.y, x, z)) last = s;
    }
    return last;
  }
}

/** The first thing under `object` that is drawn as a solid shape. */
function stoneOf(object: Object3D): Mesh | null {
  if (object instanceof Mesh && (object.geometry as BufferGeometry | undefined)?.getAttribute('position')) return object;
  for (const child of object.children) {
    const found = stoneOf(child);
    if (found) return found;
  }
  return null;
}

/** Which wedge of the round a direction falls in. */
function wedge(x: number, z: number): number {
  const turn = (Math.atan2(x, z) + Math.PI) / (Math.PI * 2);
  return Math.min(AROUND - 1, Math.max(0, Math.floor(turn * AROUND)));
}
