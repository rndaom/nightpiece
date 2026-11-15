/**
 * A stone laid over: which way it can fall, how far over it goes before it lies on the board, and
 * where it is at any angle on the way.
 *
 * It goes over about the rim of its own foot, as a real one does, and comes to rest on that rim
 * and whatever part of it meets the board next: so a king, which is narrower at the crown than at
 * the foot, lies a little past flat. Nothing here knows what any piece looks like; the stone's
 * shape is read as the hands read it (girth.ts).
 *
 * It falls toward the other player if it can, and if it cannot, some other way. Where it is
 * hemmed in on every side it only leans, against whatever it meets first.
 */
import { Quaternion, Vector3 } from 'three';
import { FIELD_HALF } from '../scene/layout';
import { PIECE_HEIGHT } from '../scene/pieceShapes';
import type { Puppet } from '../scene/pieces';
import { Girth } from './girth';

export interface Fall {
  /** The way it goes over, level, of length one. */
  way: Vector3;
  /** How far out from the middle of its foot the rim is that it goes over about. */
  foot: number;
  /** How tall it stands. */
  height: number;
  /** The angle from upright at which it comes to rest, in radians. */
  rest: number;
  /** The angle past which it goes on by itself: until then it has to be pushed. No more than `rest`. */
  tips: number;
  /** True if it does not get to lie down: it is resting against another stone. */
  leans: boolean;
}

/** The ways a stone may fall, as turns from the way toward the other player, in the order they are liked. */
const WAYS = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1].map((turn) => turn * Math.PI);
/** The stone is felt at heights this far apart, and each way round from the way it falls by these angles. */
const BAND = 0.06;
const ROUND = [0, 0.55, -0.55, 1.1, -1.1];
/** The fall is tried in steps of this angle, and a point of the stone counts as this thick. */
const STEP = 0.03;
const SKIN = 0.02;
/** Nothing farther off than this from where the stone stands can be in its way. */
const NEAR = 3.4;
/** How high up a stone its weight is, as a share of its height: what decides when it goes over by itself. */
const WEIGHT_AT = 0.42;

const UP = new Vector3(0, 1, 0);
const v1 = new Vector3();
const v2 = new Vector3();
const q1 = new Quaternion();
const q2 = new Quaternion();

/** Points on the skin of a standing stone, in the room, on the side of it that leads as it falls `way`. */
function skin(puppet: Puppet, way: Vector3): { points: Vector3[]; foot: number; height: number } {
  const base = puppet.group.position;
  const stone = Girth.of(puppet.group);
  if (!stone) {
    // Nothing to feel: a plain post of the piece's height.
    const height = PIECE_HEIGHT[puppet.kind];
    const points: Vector3[] = [];
    for (let y = BAND; y <= height; y += BAND) points.push(new Vector3(base.x + way.x * 0.3, base.y + y, base.z + way.z * 0.3));
    return { points, foot: 0.3, height };
  }
  const { girth, mesh } = stone;
  mesh.updateWorldMatrix(true, false);
  const height = girth.over(0, 0);
  const here = mesh.worldToLocal(v1.copy(base)).clone();
  const reach = (y: number, toward: Vector3): number => {
    const local = mesh.worldToLocal(v2.copy(base).add(toward)).sub(here);
    return girth.at(here.y + y, local.x, local.z);
  };
  const foot = Math.max(reach(0.01, way), reach(0.03, way), 0.1);
  const points: Vector3[] = [];
  const toward = new Vector3();
  for (let y = BAND; y <= height + 1e-6; y += BAND) {
    for (const round of ROUND) {
      toward.copy(way).applyAxisAngle(UP, round);
      const out = reach(Math.min(y, height - 0.005), toward);
      if (out > 0) points.push(new Vector3(base.x + toward.x * out, base.y + y, base.z + toward.z * out));
    }
  }
  return { points, foot, height };
}

/** The turn that lays something over by `angle` the way `way`. */
function turnOver(way: Vector3, angle: number, out: Quaternion): Quaternion {
  return out.setFromAxisAngle(v1.set(way.z, 0, -way.x), angle);
}

/**
 * How a stone would fall the way `way`: how far over it goes before it lies on what it stands on,
 * or before it meets one of `others`.
 */
function fallOf(puppet: Puppet, way: Vector3, others: Puppet[]): Fall {
  const base = puppet.group.position;
  const { points, foot, height } = skin(puppet, way);
  const pivot = new Vector3(base.x + way.x * foot, base.y, base.z + way.z * foot);
  // It lies on its rim and on whichever point of it comes down first.
  let rest = Math.PI;
  for (const p of points) {
    const up = p.y - base.y;
    if (up < BAND * 1.5) continue;
    // A point this far out from the rim and this far up comes down to the level of the rim when the stone has turned this far.
    const out = (p.x - pivot.x) * way.x + (p.z - pivot.z) * way.z;
    rest = Math.min(rest, Math.atan2(up, out));
  }
  if (rest > Math.PI - 1e-6) rest = Math.PI / 2;
  const stones = others
    .filter((o) => o !== puppet && Math.hypot(o.group.position.x - base.x, o.group.position.z - base.z) < NEAR)
    .map((o) => Girth.of(o.group))
    .filter((s) => s !== null);
  for (const s of stones) s.mesh.updateWorldMatrix(true, false);
  let leans = false;
  for (let angle = STEP; angle < rest && !leans; angle += STEP) {
    turnOver(way, angle, q1);
    for (const p of points) {
      v2.copy(p).sub(pivot).applyQuaternion(q1).add(pivot);
      if (stones.some((s) => s.girth.depth(s.mesh.worldToLocal(v1.copy(v2)), SKIN) > 0)) {
        leans = true;
        rest = Math.max(0, angle - STEP);
        break;
      }
    }
  }
  return { way: way.clone(), foot, height, rest, tips: Math.min(rest, Math.atan2(foot, height * WEIGHT_AT)), leans };
}

/**
 * The way a stone should fall, standing where it does among `others`: toward the other player
 * (`forward`) if it can lie down that way, with all of it on the squares; if not, the first way
 * it can; and if there is none, the way it can lean farthest.
 */
export function chooseFall(puppet: Puppet, others: Iterable<Puppet>, forward: Vector3): Fall {
  const round = [...others];
  const base = puppet.group.position;
  const way = new Vector3();
  let best: Fall | null = null;
  for (const turn of WAYS) {
    way.copy(forward).setY(0).normalize().applyAxisAngle(UP, turn);
    const fall = fallOf(puppet, way, round);
    if (!fall.leans) {
      // Lying down, its crown must still be over the squares, not out on the rail.
      const end = fall.foot + fall.height;
      if (Math.abs(base.x + way.x * end) <= FIELD_HALF && Math.abs(base.z + way.z * end) <= FIELD_HALF) return fall;
      continue;
    }
    if (!best || fall.rest > best.rest + 1e-6) best = fall;
  }
  // Nowhere to lie and nothing to lean on: a stone alone in a corner of an empty board. Forward, then, as far as flat.
  return best ?? fallOf(puppet, way.copy(forward).setY(0).normalize(), []);
}

/**
 * Put a stone where it is when it has gone over by `angle`, from standing at `base` and facing
 * `facing`: turned about the rim of its foot.
 */
export function layOver(puppet: Puppet, base: Vector3, facing: number, fall: Fall, angle: number): void {
  const g = puppet.group;
  turnOver(fall.way, angle, q1);
  const pivot = v2.set(base.x + fall.way.x * fall.foot, base.y, base.z + fall.way.z * fall.foot);
  g.position.copy(base).sub(pivot).applyQuaternion(q1).add(pivot);
  g.quaternion.copy(q1).multiply(q2.setFromAxisAngle(UP, facing));
}

/** Where a finger pushing it over is on its crown, in the room, when it has gone over by `angle`: on the side it is pushed from. */
export function crownOf(base: Vector3, fall: Fall, angle: number, out: Vector3): Vector3 {
  turnOver(fall.way, angle, q1);
  const pivot = v2.set(base.x + fall.way.x * fall.foot, base.y, base.z + fall.way.z * fall.foot);
  out.set(base.x - fall.way.x * 0.1, base.y + fall.height + 0.03, base.z - fall.way.z * 0.1);
  return out.sub(pivot).applyQuaternion(q1).add(pivot);
}
