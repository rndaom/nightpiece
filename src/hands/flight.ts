/**
 * How a hand crosses the room.
 *
 * A hand with somewhere to go does not go there in a straight line: at the
 * size these hands are, that would take it through the pieces standing in
 * between. It rises off whatever it is over, crosses above everything in its
 * way and comes down onto where it is going, as one path, the way an arm
 * reaches across a crowded board.
 *
 * The path is worked out once, as the hand sets off, from where the stone of
 * each piece really is (girth.ts) and from the hand's own shape: its fingers
 * as they are and as they are about to be, its palm and its wrist. Nothing
 * here knows what any piece looks like.
 */
import { Quaternion, Vector3 } from 'three';
import type { Puppet } from '../scene/pieces';
import { Spring } from '../scene/spring';
import { clamp01, type Ease } from '../scene/tween';
import { Girth } from './girth';
import type { Hand } from './hand';
import { ANGLES, FINGERS, type Pose } from './rig';

/**
 * How a hand is held: which of its points is steered, how far its fingers are tipped down, and how
 * loose its wrist is (1 lets it trail behind the hand's movement, 0 holds it as it is told).
 */
export interface Posture {
  focus: Vector3;
  pitch: number;
  loose: number;
  /**
   * How far round the hand lies from the way an arm reaches out to where it is, its forearm swung
   * round with it. Nothing, unless it is said: only a hand at rest lies askew (puppeteer.ts).
   */
  askew?: number;
}

/** How far above a piece the hand passes, and how near to one side of it counts as over it. */
const CLEAR = 0.12;
const BESIDE = 0.07;
/** The way across is looked at in steps this long, and in steps as short as this for this far from either end. */
const STEP = 0.25;
const FINE = 0.1;
const EDGE = 0.3;
/** How much fatter than the balls it is felt with a hand is taken to be, when asking whether it would be in something. */
const FLESH = 0.03;
/** How closely an arm keeps to a crossing that has been worked out for it: the stiffness of the spring it follows on. */
export const FOLLOW = 60;
/**
 * Something drawn after a moving goal on such a spring runs this many seconds behind it. So the
 * path is read this far ahead of the clock, and the arm is where it should be when it should be.
 */
const AHEAD = 2 / FOLLOW;
/**
 * The wrist leads the fingers (puppeteer.ts tips the hand so). How much farther down they hang
 * while it goes up, and the shares of the way across between which that is taken to pass off; and
 * how much higher they trail behind a loose wrist as it comes down, which swings them out ahead
 * of it as well.
 */
export const DROOP = 0.16;
const DROOPS_FROM = 0.1;
const DROOPS_BY = 0.45;
export const TRAIL = 0.16;
/**
 * The hand turns from the way it was held to the way it will be held between these shares of the way
 * across: not where it sets off, in among what it has just let go of, nor where it comes down.
 */
const TURNS_FROM = 0.12;
const TURNS_BY = 0.88;
/**
 * A hand that lay askew where it rested has straightened by this share of the way across: early,
 * so that it has done with turning well before it comes down in among the pieces.
 */
const STRAIGHT_BY = 0.65;
/** Nothing farther than this from the straight line of a crossing, or from a hand, can be under any part of the hand. */
const REACH = 4.2;
/** Within this of where a crossing begins and of where it ends, the hand is not asked to be above anything. */
const END = 0.08;

/** Everything of the hand but its fingers, as balls in hand space (x, y, z, size): the two heels, the pad under the fingers, the wrist and the forearm. */
const BODY = [-0.45, -0.12, -0.8, 0.3, 0.42, -0.08, -0.8, 0.27, 0, -0.06, -1.5, 0.26, 0, 0, 0, 0.3, 0, 0.02, 0.6, 0.32];

interface Stone {
  x: number;
  y: number;
  z: number;
  girth: Girth;
  widest: number;
}

const UP = new Vector3(0, 1, 0);
const AXIS_X = new Vector3(1, 0, 0);
const q = new Quaternion();
const qTip = new Quaternion();
const v = new Vector3();
const focus = new Vector3();
const held: Posture = { focus: new Vector3(), pitch: 0, loose: 0 };
const joints = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const sizes = [0, 0, 0, 0, 0, 0, 0];

/** One crossing: where the hand should be at each moment of it, and how it should be held. */
export class Flight {
  /** Seconds since it set off. */
  clock = 0;
  /** How far round from the way an arm reaches out to where it is the hand should be turned just now (see `now`). */
  askew = 0;
  /**
   * How much of that the forearm is swung round with the hand just now: as far as the hand lies
   * askew where it rests, and none of the heading a hand keeps from a piece it has carried.
   */
  swung = 0;
  /** How much farther down than it is held its fingers may hang just now, the wrist leading them up. */
  droop = DROOP;
  /** How far along the path each of its corners is. */
  private run: number[] = [0];
  private length = 0;

  constructor(
    readonly from: Vector3,
    /** Where it is going. This may be moved a little while it is on its way. */
    readonly to: Vector3,
    readonly start: Posture,
    readonly end: Posture,
    readonly seconds: number,
    private ease: Ease,
    /** The corners of the path: how far across each is (0 to 1), and how high above the straight line. */
    private across: number[],
    private lift: number[],
    /** How far round from the way an arm reaches out the hand was turned as it set off: a hand that has carried a piece keeps the heading it took hold with. */
    private skew = 0,
  ) {
    const wide = Math.hypot(to.x - from.x, to.z - from.z);
    const rise = to.y - from.y;
    for (let i = 1; i < across.length; i++) {
      const step = across[i]! - across[i - 1]!;
      this.length += Math.hypot(wide * step, rise * step + lift[i]! - lift[i - 1]!);
      this.run.push(this.length);
    }
  }

  get over(): boolean {
    return this.clock >= this.seconds;
  }

  /** The highest the path goes above the straight line. */
  get height(): number {
    return Math.max(...this.lift);
  }

  /** Where the hand should be now, into `at`, and how it should be held, into `held`. */
  now(at: Vector3, held: Posture): void {
    // Read ahead, but not by a jump as it sets off: for its first moments the clock simply runs fast.
    const along = this.ease(clamp01((this.clock + Math.min(this.clock, AHEAD)) / this.seconds)) * this.length;
    let i = 1;
    while (i < this.run.length - 1 && this.run[i]! < along) i++;
    const a = this.run[i - 1]!;
    const b = this.run[i]!;
    const k = b > a ? clamp01((along - a) / (b - a)) : 1;
    const across = this.across[i - 1]! + (this.across[i]! - this.across[i - 1]!) * k;
    at.lerpVectors(this.from, this.to, across);
    at.y += this.lift[i - 1]! + (this.lift[i]! - this.lift[i - 1]!) * k;
    const turned = smooth(TURNS_FROM, TURNS_BY, across);
    held.focus.lerpVectors(this.start.focus, this.end.focus, turned);
    held.pitch = this.start.pitch + (this.end.pitch - this.start.pitch) * turned;
    held.loose = this.start.loose + (this.end.loose - this.start.loose) * turned;
    turnAt(this.skew, this.start.askew ?? 0, this.end.askew ?? 0, across, this);
    this.droop = DROOP * (1 - smooth(DROOPS_FROM, DROOPS_BY, across));
  }
}

/**
 * Work out a crossing for `hand` from `from` to `to` in `seconds`, held as `start` when it sets off
 * and as `end` when it arrives, over all of `stones`. `poses` are the shapes its fingers will have
 * on the way, besides the one they have now; `speed` is how fast it is moving as it sets off.
 * `others` is whatever else is in the room that it must pass above, as balls (x, y, z and size
 * for each): the player's other hand, where that is at work in the same place. `yaw` is the way
 * the hand is heading as it sets off, if that is not the way an arm reaches out to where it is.
 * `plumb` is how far it goes straight up before anything else: a hand that has just let go of a
 * piece has its fingers round it still, and must not draw them across it.
 */
export function chart(
  hand: Hand,
  from: Vector3,
  to: Vector3,
  start: Posture,
  end: Posture,
  poses: Pose[],
  stones: Iterable<Puppet>,
  seconds: number,
  ease: Ease,
  speed?: Vector3,
  others?: number[],
  yaw?: number,
  plumb = 0,
): Flight {
  const wide = Math.max(1e-4, Math.hypot(to.x - from.x, to.z - from.z));
  let skew = yaw === undefined ? 0 : yaw - hand.headingTo(from);
  skew -= Math.round(skew / (Math.PI * 2)) * Math.PI * 2;
  const turn = { askew: 0, swung: 0 };
  const shapes = [shapeOf(hand, hand.pose), ...poses.map((pose) => shapeOf(hand, pose))];
  // Only what stands near the way across matters.
  const near: Stone[] = [];
  for (const puppet of stones) {
    const found = Girth.of(puppet.group);
    if (!found) continue;
    found.mesh.updateWorldMatrix(true, false);
    const e = found.mesh.matrixWorld.elements;
    const k = clamp01(((e[12]! - from.x) * (to.x - from.x) + (e[14]! - from.z) * (to.z - from.z)) / (wide * wide));
    if (Math.hypot(e[12]! - from.x - (to.x - from.x) * k, e[14]! - from.z - (to.z - from.z) * k) > REACH) continue;
    near.push({ x: e[12]!, y: e[13]!, z: e[14]!, girth: found.girth, widest: found.girth.widest(-Infinity) });
  }

  // The way across is looked at in steps, short ones near its two ends, where the hand is in among
  // things: how high must it be at each for every part of it to be clear of what it is over there?
  // Not at the ends themselves: the hand is where it is, and is going where it is going.
  const across = [0];
  const lift = [0];
  for (let d = FINE; d < wide - 1e-3; d += d < EDGE - 1e-3 || d > wide - EDGE - STEP ? FINE : STEP) {
    const share = d / wide;
    const turned = smooth(TURNS_FROM, TURNS_BY, share);
    focus.lerpVectors(start.focus, end.focus, turned);
    const pitch = start.pitch + (end.pitch - start.pitch) * turned;
    const loose = start.loose + (end.loose - start.loose) * turned;
    const x = from.x + (to.x - from.x) * share;
    const z = from.z + (to.z - from.z) * share;
    turnAt(skew, start.askew ?? 0, end.askew ?? 0, share, turn);
    const heading = hand.headingTo(v.set(x, 0, z)) + turn.askew;
    // With its fingers as low as they may hang here, and as high as they may trail.
    let height = lowest(x, z, focus, pitch + DROOP * (1 - smooth(DROOPS_FROM, DROOPS_BY, share)), heading, hand.mirrored, shapes, near, others);
    if (loose > 0.05) height = Math.max(height, lowest(x, z, focus, pitch - TRAIL * loose, heading, hand.mirrored, shapes, near, others));
    across.push(share);
    lift.push(Math.max(0, height - (from.y + (to.y - from.y) * share)));
  }
  across.push(1);
  lift.push(0);

  // The lowest path over all of that which never dips: a hand makes one arc of a crossing, not a
  // climb for each thing in its way.
  const keep: number[] = [];
  for (let i = 0; i < across.length; i++) {
    while (keep.length >= 2) {
      const a = keep[keep.length - 2]!;
      const b = keep[keep.length - 1]!;
      if ((lift[b]! - lift[a]!) * (across[i]! - across[a]!) > (lift[i]! - lift[a]!) * (across[b]! - across[a]!)) break;
      keep.pop();
    }
    keep.push(i);
  }
  const corners = keep.map((i) => across[i]!);
  const heights = keep.map((i) => lift[i]!);
  // Straight up first, as far as it was told to or as far as its way rises at all.
  const straight = heights.length > 2 ? Math.min(plumb, heights[1]!) : 0;
  if (straight > 0.01) {
    corners.splice(1, 0, 0);
    heights.splice(1, 0, straight);
  }
  // And straight down last, from as high as it has to be just short of where it is going. It does
  // not slide in sideways past what stands there, the piece it is coming for least of all: how far
  // short of the end the last look at the way was taken would otherwise decide how near it came.
  const down = lift.length > 2 ? lift[lift.length - 2]! : 0;
  if (down > 0.01) {
    corners.splice(corners.length - 1, 0, 1);
    heights.splice(heights.length - 1, 0, down);
  }
  const first = { ...start, focus: start.focus.clone() };
  const last = { ...end, focus: end.focus.clone() };
  let flight = new Flight(from.clone(), to.clone(), first, last, seconds, ease, corners, heights, skew);

  // An arm does not keep to its path exactly: it is drawn after it on a spring, which rounds off
  // every corner. The path is raised until what the arm will really do clears everything.
  const along = speed ? (speed.x * (to.x - from.x) + speed.z * (to.z - from.z)) / (wide * wide) : 0;
  for (let pass = 0; pass < 3; pass++) {
    const short = shortfall(flight, across, lift, along, speed?.y ?? 0);
    if (short < 0.01) break;
    for (let i = 1; i < heights.length - 1; i++) heights[i]! += short + 0.01;
    flight = new Flight(flight.from, flight.to, first, last, seconds, ease, corners, heights, skew);
  }
  return flight;
}

/**
 * How far short of clearing everything an arm would fall, following `flight` as an arm follows
 * (puppeteer.ts), when `lift` is how high above the straight line it has to be at each share
 * `across`. It sets off moving at `along` (shares of the way a second) and `up`.
 */
function shortfall(flight: Flight, across: number[], lift: number[], along: number, up: number): number {
  const { from, to } = flight;
  const gone = new Spring();
  const high = new Spring(from.y);
  gone.velocity = along;
  high.velocity = up;
  const wide2 = (to.x - from.x) ** 2 + (to.z - from.z) ** 2;
  let short = 0;
  let i = 1;
  const step = 1 / 90;
  for (let t = step; t < flight.seconds + 0.3; t += step) {
    flight.clock = t;
    flight.now(v, held);
    gone.goal = ((v.x - from.x) * (to.x - from.x) + (v.z - from.z) * (to.z - from.z)) / wide2;
    high.goal = v.y;
    gone.step(step, FOLLOW);
    high.step(step, FOLLOW);
    const share = clamp01(gone.value);
    while (i < across.length - 1 && across[i]! < share) i++;
    while (i > 1 && across[i - 1]! > share) i--;
    const k = (share - across[i - 1]!) / Math.max(1e-6, across[i]! - across[i - 1]!);
    const needed = from.y + (to.y - from.y) * share + lift[i - 1]! + (lift[i]! - lift[i - 1]!) * k;
    // Not at the very ends: there the hand is where it is, and is going where it is going.
    const wide = Math.sqrt(wide2);
    if (share * wide > END && (1 - share) * wide > END) short = Math.max(short, needed - high.value);
  }
  flight.clock = 0;
  return short;
}

/**
 * How deep in stone a hand would be if it were held as `held` with its steered point at `at`,
 * heading along `yaw`, its fingers in `pose`: the deepest that any part of it would be in any of
 * `stones`, and less than nothing if it would be clear of them all. The hand is taken to be a
 * little fatter than it is, because the balls it is felt with do not fill its skin. A stone that is
 * on its way somewhere else can be tried where it will stand: `moved` says which, and how far from
 * where it is now.
 */
export function sunk(hand: Hand, at: Vector3, held: Posture, yaw: number, pose: Pose, stones: Iterable<Puppet>, moved?: { puppet: Puppet; by: Vector3 }): number {
  const shape = shapeOf(hand, pose);
  q.setFromAxisAngle(UP, yaw).multiply(qTip.setFromAxisAngle(AXIS_X, -held.pitch));
  const side = hand.mirrored ? -1 : 1;
  let deepest = -Infinity;
  for (const puppet of stones) {
    const found = Girth.of(puppet.group);
    if (!found) continue;
    found.mesh.updateWorldMatrix(true, false);
    const e = found.mesh.matrixWorld.elements;
    const by = moved && moved.puppet === puppet ? moved.by : null;
    if (Math.hypot(e[12]! + (by ? by.x : 0) - at.x, e[14]! + (by ? by.z : 0) - at.z) > REACH) continue;
    for (let i = 0; i < shape.length; i += 4) {
      v.set((shape[i]! - held.focus.x) * side, shape[i + 1]! - held.focus.y, shape[i + 2]! - held.focus.z).applyQuaternion(q).add(at);
      if (by) v.sub(by);
      deepest = Math.max(deepest, found.girth.depth(found.mesh.worldToLocal(v), shape[i + 3]! + FLESH));
    }
  }
  return deepest;
}

/**
 * A hand as balls in the room (x, y, z and size for each), held as `held` with its steered point at
 * `at`, heading along `yaw`, its fingers in `pose`: what another hand has to keep clear of.
 */
export function ballsOf(hand: Hand, at: Vector3, held: Posture, yaw: number, pose: Pose): number[] {
  const shape = shapeOf(hand, pose);
  q.setFromAxisAngle(UP, yaw).multiply(qTip.setFromAxisAngle(AXIS_X, -held.pitch));
  const side = hand.mirrored ? -1 : 1;
  for (let i = 0; i < shape.length; i += 4) {
    v.set((shape[i]! - held.focus.x) * side, shape[i + 1]! - held.focus.y, shape[i + 2]! - held.focus.z).applyQuaternion(q).add(at);
    shape[i] = v.x;
    shape[i + 1] = v.y;
    shape[i + 2] = v.z;
  }
  return shape;
}

/** A hand as balls in the room (x, y, z and size for each), just as it is drawn at this moment: for whoever asks whether something is in it. */
export function ballsNow(hand: Hand): number[] {
  const shape = shapeOf(hand, hand.shown);
  for (let i = 0; i < shape.length; i += 4) {
    hand.toWorld(v.set(shape[i]!, shape[i + 1]!, shape[i + 2]!), v);
    shape[i] = v.x;
    shape[i + 1] = v.y;
    shape[i + 2] = v.z;
  }
  return shape;
}

/** A hand's shape with its fingers in `pose`, as balls in hand space: x, y, z and size for each. */
function shapeOf(hand: Hand, pose: Pose): number[] {
  const shape = BODY.slice();
  FINGERS.forEach((finger, f) => {
    hand.rig.whole(finger, pose.subarray(f * ANGLES, (f + 1) * ANGLES), joints, sizes);
    joints.forEach((joint, i) => shape.push(joint.x, joint.y, joint.z, sizes[i]!));
  });
  return shape;
}

/**
 * How low the steered point of a hand can be when it is over (x, z), held with `focus` and `pitch`
 * and heading along `yaw`, for every part of it to be clear above every stone it is over, and
 * above every one of the balls of `others` that it is over. Less than anything if it is over none.
 */
function lowest(x: number, z: number, focus: Vector3, pitch: number, yaw: number, mirrored: boolean, shapes: number[][], stones: Stone[], others?: number[]): number {
  q.setFromAxisAngle(UP, yaw).multiply(qTip.setFromAxisAngle(AXIS_X, -pitch));
  const side = mirrored ? -1 : 1;
  let least = -Infinity;
  for (const shape of shapes) {
    for (let i = 0; i < shape.length; i += 4) {
      // Where this part of the hand is from the steered point (hand.ts, place).
      v.set((shape[i]! - focus.x) * side, shape[i + 1]! - focus.y, shape[i + 2]! - focus.z).applyQuaternion(q);
      const size = shape[i + 3]!;
      for (const stone of stones) {
        const distance = Math.hypot(x + v.x - stone.x, z + v.z - stone.z);
        if (distance - size - BESIDE > stone.widest) continue;
        const top = stone.girth.over(distance, size + BESIDE);
        if (top > 0) least = Math.max(least, stone.y + top + CLEAR + size - v.y);
      }
      if (!others) continue;
      for (let o = 0; o < others.length; o += 4) {
        // Over a ball, as far as this is concerned, is anywhere over the widest of it.
        if (Math.hypot(x + v.x - others[o]!, z + v.z - others[o + 2]!) > size + others[o + 3]! + BESIDE) continue;
        least = Math.max(least, others[o + 1]! + others[o + 3]! + CLEAR + size - v.y);
      }
    }
  }
  return least;
}

/**
 * How far round from the way an arm reaches out to where it is a hand on a crossing is turned, a
 * share `across` of the way, and how much of that its forearm is swung round with it. It set off
 * turned `skew` and lying `from` askew, and will lie `to` askew where it is going.
 */
function turnAt(skew: number, from: number, to: number, across: number, out: { askew: number; swung: number }): void {
  const turned = smooth(TURNS_FROM, TURNS_BY, across);
  // As far as it lies the same way askew at both ends, it simply stays so.
  const kept = from * to > 0 ? Math.sign(to) * Math.min(Math.abs(from), Math.abs(to)) : 0;
  out.swung = kept + (from - kept) * (1 - smooth(0, STRAIGHT_BY, across)) + (to - kept) * turned;
  out.askew = out.swung + (skew - from) * (1 - turned);
}

function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
