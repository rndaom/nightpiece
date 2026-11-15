/**
 * The hand's skeleton as numbers: how a set of joint angles places each
 * fingertip, and the reverse, which angles put a fingertip on a given point.
 *
 * Everything here works in "hand space", the space the hand was modelled in
 * (assets/src/hands.py): the wrist is the origin, the fingers point along
 * -z, the back of the hand faces +y and the thumb is on the -x side. A left
 * hand is the same hand mirrored in x by its owner, so nothing here needs to
 * know about left and right.
 *
 * No rendering happens in this file, so it can be tested without a browser.
 */
import { type Bone, type Object3D, Quaternion, Vector3 } from 'three';

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'little';
export const FINGERS: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];

export interface HandMeta {
  /** Wrist to the tip of the middle finger. */
  length: number;
  fingers: Record<FingerName, { bones: [string, string, string]; lengths: [number, number, number]; radii: number[] }>;
  /** A turn of this sign about a finger bone's own x axis bends it toward the palm. */
  flexSign: number;
  /** Wrist to the far end of the forearm, and half its width and half its depth there. */
  forearmLength: number;
  forearmEnd: [number, number];
  /** Where the cord sits along the forearm, as distances from the wrist. */
  cord: [number, number];
  /** Where the plumb weight hangs from, in hand space. */
  plumbAnchor: [number, number, number];
}

/**
 * The angles of one finger, in radians.
 *   0  bend at the knuckle (toward the palm is positive)
 *   1  bend at the middle joint
 *   2  bend at the last joint
 *   3  spread: sideways swing at the knuckle, toward the thumb side is positive.
 *      It is applied after the bend, so it still swings a curled finger sideways
 *   4  twist about the first bone's own length (the thumb only)
 */
export const ANGLES = 5;
export type FingerAngles = [number, number, number, number, number];

/** A whole hand's finger angles: five per finger, in the order of FINGERS. */
export type Pose = Float32Array;
export const newPose = (): Pose => new Float32Array(FINGERS.length * ANGLES);

export function setFinger(pose: Pose, finger: FingerName, angles: ArrayLike<number>): Pose {
  const o = FINGERS.indexOf(finger) * ANGLES;
  for (let i = 0; i < ANGLES; i++) pose[o + i] = angles[i] ?? 0;
  return pose;
}

export function fingerOf(pose: Pose, finger: FingerName): FingerAngles {
  const o = FINGERS.indexOf(finger) * ANGLES;
  return [pose[o]!, pose[o + 1]!, pose[o + 2]!, pose[o + 3]!, pose[o + 4]!];
}

/** Build a pose from per-finger angle lists. Fingers left out stay straight. */
export function pose(parts: Partial<Record<FingerName, number[]>>): Pose {
  const p = newPose();
  for (const finger of FINGERS) if (parts[finger]) setFinger(p, finger, parts[finger]!);
  return p;
}

interface Chain {
  /** Each bone's position and rest rotation relative to its parent bone. */
  position: [Vector3, Vector3, Vector3];
  rest: [Quaternion, Quaternion, Quaternion];
  /** Where the last bone ends, and where its pad (the part that touches things) is, in that bone's space. */
  tip: Vector3;
  pad: Vector3;
  /** How thick the finger is at its knuckle, at its two joints and at its tip. */
  radii: number[];
}

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const q1 = new Quaternion();
const q2 = new Quaternion();
const q3 = new Quaternion();
const qa = new Quaternion();
const v1 = new Vector3();
const v2 = new Vector3();

/** How far a finger's last joint bends for a given bend of its middle joint. The two share a tendon. */
export const COUPLING: Record<FingerName, number> = { thumb: 0.7, index: 0.66, middle: 0.66, ring: 0.66, little: 0.66 };

/** The most a finger's last joint bends when it is closed on something by itself. */
const LAST_MOST = 1.35;

/** [least, most] for the three angles the solver is free to choose: knuckle bend, middle bend, spread. */
const LIMITS: Record<'thumb' | 'finger', [number, number][]> = {
  thumb: [
    [-0.5, 1.25],
    [-0.15, 1.3],
    [-1.0, 0.9],
  ],
  finger: [
    [-0.3, 1.65],
    [0, 1.85],
    [-0.5, 0.5],
  ],
};

export interface Reach {
  angles: FingerAngles;
  /** How far the pad ended from where it was asked to go. */
  miss: number;
}

export class HandRig {
  readonly meta: HandMeta;
  private handRest = new Quaternion();
  private chains = {} as Record<FingerName, Chain>;
  private sign: number;

  /** `root` is the armature as loaded: an object whose descendants include the bones named in `meta`. */
  constructor(root: Object3D, meta: HandMeta) {
    this.meta = meta;
    this.sign = meta.flexSign;
    const hand = root.getObjectByName('hand') as Bone | undefined;
    if (!hand) throw new Error('The hand asset has no "hand" bone');
    this.handRest.copy(hand.quaternion);
    for (const finger of FINGERS) {
      const info = meta.fingers[finger];
      const bones = info.bones.map((name) => {
        const b = root.getObjectByName(name);
        if (!b) throw new Error(`The hand asset has no "${name}" bone`);
        return b;
      });
      const radius = info.radii[3] ?? 0.12;
      const last = info.lengths[2];
      this.chains[finger] = {
        position: [bones[0]!.position.clone(), bones[1]!.position.clone(), bones[2]!.position.clone()],
        rest: [bones[0]!.quaternion.clone(), bones[1]!.quaternion.clone(), bones[2]!.quaternion.clone()],
        tip: new Vector3(0, last, 0),
        // The pad sits short of the tip, on the palm side. A bone's own z axis points out of the back of the hand.
        pad: new Vector3(0, last - radius * 0.9, -radius * 0.8),
        radii: [info.radii[0] ?? 0.14, info.radii[1] ?? 0.13, info.radii[2] ?? 0.12, radius],
      };
    }
  }

  /** The rotations to give a finger's three bones for a set of angles (each relative to its parent bone). */
  rotations(finger: FingerName, a: ArrayLike<number>, out: [Quaternion, Quaternion, Quaternion]): void {
    const c = this.chains[finger];
    const s = this.sign;
    // Bend, then swing sideways in the bent finger's own frame, then (for the thumb) roll about its length.
    // Swinging after the bend keeps the sideways control useful when a finger is curled: a real knuckle
    // loses that freedom, but a hand that must close on pieces of every width needs it.
    out[0].copy(c.rest[0]).multiply(qa.setFromAxisAngle(X, s * a[0]!)).multiply(qa.setFromAxisAngle(Z, a[3] ?? 0));
    if (a[4]) out[0].multiply(qa.setFromAxisAngle(Y, a[4]));
    out[1].copy(c.rest[1]).multiply(qa.setFromAxisAngle(X, s * a[1]!));
    out[2].copy(c.rest[2]).multiply(qa.setFromAxisAngle(X, s * a[2]!));
  }

  /** Where a finger's pad (or, with `tip`, its very end) is in hand space for a set of angles. */
  pad(finger: FingerName, a: ArrayLike<number>, out = new Vector3(), tip = false): Vector3 {
    const c = this.chains[finger];
    const r: [Quaternion, Quaternion, Quaternion] = [q1, q2, q3];
    this.rotations(finger, a, r);
    // Walk out along the chain, accumulating each bone's rotation in hand space.
    const q = qa.copy(this.handRest);
    out.copy(c.position[0]).applyQuaternion(q);
    q.multiply(r[0]);
    out.add(v1.copy(c.position[1]).applyQuaternion(q));
    q.multiply(r[1]);
    out.add(v1.copy(c.position[2]).applyQuaternion(q));
    q.multiply(r[2]);
    return out.add(v1.copy(tip ? c.tip : c.pad).applyQuaternion(q));
  }

  /**
   * The far half of a finger as four balls, for whoever needs to know what it would run into: half
   * way along its middle bone, at its last joint, half way along its last bone, and at its tip.
   * Their centres go into `out` (hand space) and their sizes into `sizes`.
   */
  balls(finger: FingerName, a: ArrayLike<number>, out: [Vector3, Vector3, Vector3, Vector3], sizes: number[]): void {
    const c = this.chains[finger];
    const r: [Quaternion, Quaternion, Quaternion] = [q1, q2, q3];
    this.rotations(finger, a, r);
    const q = qa.copy(this.handRest);
    const at = v1.copy(c.position[0]).applyQuaternion(q);
    q.multiply(r[0]);
    at.add(v2.copy(c.position[1]).applyQuaternion(q));
    q.multiply(r[1]);
    // The middle bone runs from here to where the last one begins.
    const last = v2.copy(c.position[2]).applyQuaternion(q);
    out[0].copy(at).addScaledVector(last, 0.5);
    out[1].copy(at).add(last);
    q.multiply(r[2]);
    const along = v2.copy(c.tip).applyQuaternion(q);
    const size = c.radii[3]!;
    const length = along.length() || 1;
    out[2].copy(out[1]).addScaledVector(along, 0.5);
    out[3].copy(out[1]).addScaledVector(along, Math.max(0.5, 1 - size / length));
    sizes[0] = 0.5 * (c.radii[1]! + c.radii[2]!);
    sizes[1] = c.radii[2]!;
    sizes[2] = 0.5 * (c.radii[2]! + size);
    sizes[3] = size;
  }

  /**
   * The whole of a finger as seven balls, for whoever needs to know what it would pass through: one
   * at its knuckle, at each joint and at its tip, and one half way along each bone. Their centres go
   * into `out` (hand space) and their sizes into `sizes`.
   */
  whole(finger: FingerName, a: ArrayLike<number>, out: Vector3[], sizes: number[]): void {
    const c = this.chains[finger];
    const r: [Quaternion, Quaternion, Quaternion] = [q1, q2, q3];
    this.rotations(finger, a, r);
    const q = qa.copy(this.handRest);
    out[0]!.copy(c.position[0]).applyQuaternion(q);
    q.multiply(r[0]);
    out[2]!.copy(out[0]!).add(v1.copy(c.position[1]).applyQuaternion(q));
    q.multiply(r[1]);
    out[4]!.copy(out[2]!).add(v1.copy(c.position[2]).applyQuaternion(q));
    q.multiply(r[2]);
    const size = c.radii[3]!;
    const length = c.tip.length() || 1;
    out[6]!.copy(out[4]!).addScaledVector(v1.copy(c.tip).applyQuaternion(q), Math.max(0.5, 1 - size / length));
    for (let i = 1; i < 6; i += 2) out[i]!.copy(out[i - 1]!).add(out[i + 1]!).multiplyScalar(0.5);
    for (let i = 0; i < 7; i += 2) sizes[i] = c.radii[i / 2]!;
    for (let i = 1; i < 6; i += 2) sizes[i] = 0.5 * (sizes[i - 1]! + sizes[i + 1]!);
  }

  /**
   * The angles `a` with the finger's outer joints closed further: its middle joint by `middle` (the
   * last one following it, as the tendon makes it) and its last joint by `last` more on its own, as
   * far as the joints go. Written into `out`.
   */
  curled(finger: FingerName, a: ArrayLike<number>, middle: number, last: number, out: number[]): number[] {
    const most = LIMITS[finger === 'thumb' ? 'thumb' : 'finger'][1]![1];
    const bend = Math.max(a[1]!, Math.min(most, a[1]! + middle));
    out[0] = a[0]!;
    out[1] = bend;
    out[2] = Math.max(a[2]!, Math.min(LAST_MOST, a[2]! + (bend - a[1]!) * COUPLING[finger] + last));
    out[3] = a[3] ?? 0;
    out[4] = a[4] ?? 0;
    return out;
  }

  /**
   * Bend a finger so that its pad lands on `target` (in hand space). The knuckle bend, the middle
   * bend and the spread are free; the last joint follows the middle one, as it does in a real
   * finger. `seed` is where to start from and supplies the thumb's twist, which is not solved for.
   */
  reach(finger: FingerName, target: Vector3, seed: ArrayLike<number>): Reach {
    const limits = LIMITS[finger === 'thumb' ? 'thumb' : 'finger'];
    const coupling = COUPLING[finger];
    const twist = seed[4] ?? 0;
    const u = [seed[0] ?? 0.6, seed[1] ?? 0.6, seed[3] ?? 0];
    const angles = (w: number[]): FingerAngles => [w[0]!, w[1]!, w[1]! * coupling, w[2]!, twist];
    const at = new Vector3();
    const moved = new Vector3();
    const miss = new Vector3();
    const J = [new Vector3(), new Vector3(), new Vector3()];
    let error = Infinity;

    for (let step = 0; step < 14; step++) {
      this.pad(finger, angles(u), at);
      miss.copy(target).sub(at);
      error = miss.length();
      if (error < 1e-4) break;
      // How the pad moves for a small change in each angle.
      for (let i = 0; i < 3; i++) {
        const w = u.slice();
        w[i]! += 1e-3;
        J[i]!.copy(this.pad(finger, angles(w), moved)).sub(at).multiplyScalar(1e3);
      }
      // Damped least squares: (JtJ + lambda) d = Jt miss, solved directly for three unknowns.
      const lambda = 0.004;
      const a = J[0]!.dot(J[0]!) + lambda;
      const b = J[0]!.dot(J[1]!);
      const c = J[0]!.dot(J[2]!);
      const d = J[1]!.dot(J[1]!) + lambda;
      const e = J[1]!.dot(J[2]!);
      const f = J[2]!.dot(J[2]!) + lambda;
      const g0 = J[0]!.dot(miss);
      const g1 = J[1]!.dot(miss);
      const g2 = J[2]!.dot(miss);
      const det = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
      if (Math.abs(det) < 1e-12) break;
      const delta = [
        (g0 * (d * f - e * e) - b * (g1 * f - g2 * e) + c * (g1 * e - g2 * d)) / det,
        (a * (g1 * f - g2 * e) - g0 * (b * f - c * e) + c * (b * g2 - c * g1)) / det,
        (a * (d * g2 - e * g1) - b * (b * g2 - c * g1) + g0 * (b * e - c * d)) / det,
      ];
      for (let i = 0; i < 3; i++) {
        const stepped = u[i]! + Math.max(-0.4, Math.min(0.4, delta[i]!));
        u[i] = Math.max(limits[i]![0], Math.min(limits[i]![1], stepped));
      }
    }
    this.pad(finger, angles(u), at);
    return { angles: angles(u), miss: at.distanceTo(target) };
  }
}
