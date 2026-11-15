/**
 * One hand: where it is, what its fingers are doing, and how it looks.
 *
 * A hand is steered by a focus: one point of the hand (under the palm for a
 * hover, between the fingertips for a grip) is put at a point in the world,
 * and the hand is turned by a heading, a pitch and a roll. The forearm then
 * leads back toward the player's shoulder by itself.
 *
 * Fingers have two layers. Underneath is a pose, blended from one to the
 * next with each finger slightly out of step, because fingers never move as
 * a block (style bible, 6.3). Over that, any finger can be given a point in
 * the world to touch, and is bent to reach it: that is how a grip fits each
 * piece.
 */
import {
  type Bone,
  type BufferGeometry,
  type Camera,
  Group,
  Matrix4,
  Mesh,
  type Object3D,
  Quaternion,
  type ShaderMaterial,
  SkinnedMesh,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Side } from '../core/game';
import { Easing, clamp01 } from '../scene/tween';
import { ARM_FROM, eyeBehindArm, type HandDetail, type HandMaterial, handMaterials, plumbMaterial } from './material';
import { type Silhouette, SILHOUETTE_LAYER } from './silhouette';
import { ANGLES, FINGERS, type FingerName, type HandMeta, HandRig, newPose, type Pose, pose } from './rig';

export interface HandTemplate {
  /** The armature with its skinned mesh, as loaded. Cloned for each hand. */
  armature: Object3D;
  plumb: BufferGeometry;
  meta: HandMeta;
  rig: HandRig;
}

export async function loadHandTemplate(base = `${import.meta.env.BASE_URL}assets/`): Promise<HandTemplate> {
  return handTemplateFrom((await new GLTFLoader().loadAsync(`${base}hand.glb`)).scene);
}

/** Make a template from the contents of hand.glb, however they were loaded. */
export function handTemplateFrom(scene: Object3D): HandTemplate {
  const armature = scene.getObjectByName('hand_rig');
  const skin = scene.getObjectByName('hand_skin') as SkinnedMesh | undefined;
  const plumb = scene.getObjectByName('plumb') as Mesh | undefined;
  if (!armature || !skin || !plumb) throw new Error('The hand asset is missing a part');
  // The vertex colour channel is data, not colour (see assets/src/hands.py).
  const data = skin.geometry.getAttribute('color');
  if (!data) throw new Error('The hand asset has no data channel');
  skin.geometry.setAttribute('aData', data);
  skin.geometry.deleteAttribute('color');
  const meta = JSON.parse(skin.userData.meta as string) as HandMeta;
  if (!(meta.forearmLength > 0) || meta.forearmEnd?.length !== 2) throw new Error('The hand asset has no forearm');
  return { armature, plumb: plumb.geometry, meta, rig: new HandRig(armature, meta) };
}

/** Finger angles: bend at the knuckle, middle and last joints, then spread and twist. See rig.ts. */
export const POSES = {
  open: pose({}),
  /** At rest: a loose curl that deepens toward the little finger. */
  relaxed: pose({
    thumb: [0.3, 0.25, 0.2, -0.05, 0.3],
    index: [0.3, 0.36, 0.24, 0.03],
    middle: [0.38, 0.44, 0.29, 0],
    ring: [0.48, 0.5, 0.33, -0.03],
    little: [0.56, 0.52, 0.34, -0.1],
  }),
  /** Considering a piece: arched over it, a little spread. */
  hover: pose({
    thumb: [0.4, 0.15, 0.1, 0.15, 0.7],
    index: [0.5, 0.5, 0.33, 0.07],
    middle: [0.56, 0.56, 0.37, 0],
    ring: [0.6, 0.6, 0.4, -0.08],
    little: [0.58, 0.6, 0.4, -0.2],
  }),
  /** The moment before closing: opened wider than the grip will need. */
  pregrip: pose({
    thumb: [0.3, 0.05, 0.03, 0.3, 0.9],
    index: [0.62, 0.3, 0.2, 0.12],
    middle: [0.64, 0.33, 0.22, 0],
    ring: [0.55, 0.45, 0.3, -0.1],
    little: [0.48, 0.5, 0.33, -0.24],
  }),
  /** Letting go: sprung open a little past rest, the fingers fanned, still arched over what they held. */
  release: pose({
    thumb: [0.1, 0.05, 0.03, 0.24, 0.6],
    index: [0.2, 0.2, 0.13, 0.15],
    middle: [0.24, 0.22, 0.15, 0.02],
    ring: [0.36, 0.3, 0.2, -0.1],
    little: [0.42, 0.34, 0.22, -0.22],
  }),
  /** A stretch: opened wide and fanned, but with the arch of a hand still in it, not laid flat. */
  splay: pose({
    thumb: [-0.05, 0, 0, 0.16, 0.2],
    index: [-0.05, 0.1, 0.06, 0.19],
    middle: [-0.07, 0.1, 0.06, 0.02],
    ring: [-0.04, 0.12, 0.08, -0.15],
    little: [0, 0.14, 0.1, -0.32],
  }),
  point: pose({
    thumb: [0.75, 0.6, 0.4, -0.2, 0.9],
    index: [0.12, 0.06, 0.04, 0],
    middle: [1.35, 1.45, 0.9, 0],
    ring: [1.4, 1.5, 0.95, 0],
    little: [1.4, 1.45, 0.9, -0.05],
  }),
  fist: pose({
    thumb: [0.8, 0.7, 0.5, -0.25, 1.0],
    index: [1.45, 1.55, 1.0, 0],
    middle: [1.45, 1.55, 1.0, 0],
    ring: [1.45, 1.55, 1.0, 0],
    little: [1.45, 1.5, 0.95, 0],
  }),
} satisfies Record<string, Pose>;

/** Which hand-space point is steered when the hand only hovers: a point under the middle of the palm. */
export const PALM_FOCUS = new Vector3(0, -0.55, -1.5);

interface Blend {
  from: number[];
  to: number[];
  age: number;
  delay: number;
  duration: number;
  ease: (k: number) => number;
}

/** The order the fingers follow one another in a ripple: index leads, the little finger trails, the thumb between. */
const RIPPLE_RANK: Record<FingerName, number> = { index: 0, thumb: 0.5, middle: 1, ring: 2, little: 3 };

/** How long one finger's unprompted adjustment takes. */
const FIDGET = 0.45;
/** How far a joint opens and closes with the breath of a hand at its ease, in radians, and how fast the breath is. */
const BREATH = 0.055;
const BREATHES = 0.95;
const DRUM_ORDER: FingerName[] = ['little', 'ring', 'middle', 'index'];

const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Z = new Vector3(0, 0, 1);

export class Hand {
  /** Holds everything that draws this hand. Add it to the scene. */
  readonly root = new Group();
  /** The hand's own space. A left hand is mirrored here. */
  readonly body = new Group();
  readonly rig: HandRig;
  readonly material: HandMaterial;
  private passes: ShaderMaterial[];
  /** The two passes that are only drawn at full detail: the halo, and the hand's place in the picture of the hands. */
  private extras: SkinnedMesh[] = [];
  private silhouette: Silhouette | null = null;
  private detail: HandDetail;
  /** How far the forearm runs on from the point its own line is taken from. */
  private armLong: number;
  /** The point in the world that the forearm leads back to. */
  readonly shoulder = new Vector3(0, 5, 12);
  /**
   * How far round the wrist the forearm is swung from the way back to the shoulder. A hand that lies
   * askew where it rests has its arm come in from farther out, not a wrist bent to one side.
   */
  swing = 0;
  /** Finger angles before any reaching is applied. */
  readonly pose: Pose = newPose();
  /** Points in the world for fingers to touch, and how fully to commit to them (0 to 1). */
  readonly touch: Partial<Record<FingerName, Vector3>> = {};
  touchWeight = 0;
  /**
   * What the hand holds, as something its fingers must not sink into: asked how deep in it a ball
   * is (its centre in the room, and its size), it answers less than nothing where the ball is clear.
   * A finger closes toward its point only until it meets this, and then its outer joints close on
   * until its end meets it too, so the hand comes to rest round the thing whatever its shape.
   */
  obstacle: ((centre: Vector3, radius: number) => number) | null = null;
  /** How solid the dark body is, and how strong the drawn line is (0 to 1 each). */
  fill = 1;
  outline = 1;
  /** 0 for a hand at rest (dim, slow) to 1 for one at work (bright, quick). */
  energy = 0;
  /** 0 whole to 1 gone: the hand leaves from the wrist toward the fingertips, and arrives the other way. */
  dissolve = 0;
  /** Small unprompted finger movements while the hand waits. 0 stills them. */
  restless = 1;
  /** The index held out a little and swung to one side or the other, in radians, on top of whatever pose the hand has: a finger wagged. */
  wagged = 0;
  /**
   * How much at its ease the hand is, 0 to 1: one with nothing to do breathes, a slow wave that
   * opens and closes it from the little finger across to the index. One at work does not.
   */
  ease = 0;
  /**
   * How nearly behind this hand's forearm the eye that last looked at it was, 0 to 1: such an eye
   * sees the arm go just past the cord (material.ts).
   */
  behind = 0;

  private bones = {} as Record<FingerName, [Bone, Bone, Bone]>;
  private forearm: Bone;
  private handBone: Bone;
  private forearmRest = new Quaternion();
  /** What takes a point of the resting skin to where the hand bone and the forearm bone now hold it. */
  private carried: { bone: Bone; inverse: Matrix4; share: number }[] = [];
  private blends = {} as Record<FingerName, Blend | null>;
  private applied: Pose = newPose();
  /** Where each finger has closed to on what the hand holds, and for how many frames it has been holding. */
  private grasp: Pose = newPose();
  private grasping = 0;
  private plumb: Mesh;
  private plumbAnchor: Vector3;
  private bob = new Vector3();
  private bobVelocity = new Vector3();
  private bobReady = false;
  private fidget = { finger: 'index' as FingerName, age: 9, wait: 1.2, depth: 0 };
  private drum = { age: 0, rounds: 0 };
  private randomState: number;
  private scratch = [new Quaternion(), new Quaternion(), new Quaternion()] as [Quaternion, Quaternion, Quaternion];

  constructor(
    template: HandTemplate,
    readonly side: Side,
    readonly mirrored: boolean,
    seed = 0,
    detail: HandDetail = 'full',
  ) {
    this.rig = template.rig;
    this.detail = detail;
    this.armLong = template.meta.forearmLength - ARM_FROM;
    const materials = handMaterials(side, seed, template.meta, detail);
    this.material = materials.glass;
    this.passes = [materials.depth, materials.glass, materials.line, materials.halo, materials.shape, materials.veil];
    const armature = cloneSkinned(template.armature);
    const skin = armature.getObjectByName('hand_skin') as SkinnedMesh;
    skin.material = this.material;
    // A skinned mesh's bounds are those of its rest pose; the hand is always in view anyway.
    skin.frustumCulled = false;
    // Drawn after the lit squares and before flames, haze and threads, which are light and add over it.
    skin.renderOrder = 3.3;
    // The same skin again on the same bones, once for each of the other passes (see material.ts):
    // depth alone first, twice over, the halo and the drawn line last.
    const again = (material: ShaderMaterial, order: number) => {
      const pass = new SkinnedMesh(skin.geometry, material);
      pass.bind(skin.skeleton, skin.bindMatrix);
      pass.frustumCulled = false;
      pass.renderOrder = order;
      skin.parent!.add(pass);
      return pass;
    };
    const drawn = [skin, again(materials.depth, 3.0), again(materials.veil, 3.1), again(materials.line, 3.6)];
    const halo = again(materials.halo, 3.5);
    drawn.push(halo);
    // The pass that draws the hand into the picture of the hands is seen by no ordinary camera.
    const shape = again(materials.shape, 0);
    shape.layers.set(SILHOUETTE_LAYER);
    this.extras = [halo, shape];
    // Neither is drawn until there is such a picture (useSilhouette).
    for (const extra of this.extras) extra.visible = false;
    // What the material needs to know about the picture is only known as it is drawn.
    const look = (renderer: WebGLRenderer, _scene: unknown, camera: Camera) => this.beforeDraw(renderer, camera);
    for (const mesh of drawn) mesh.onBeforeRender = look;
    this.body.add(armature);
    if (mirrored) this.body.scale.x = -1;

    const bone = (name: string) => armature.getObjectByName(name) as Bone;
    for (const finger of FINGERS) {
      const names = template.meta.fingers[finger].bones;
      this.bones[finger] = [bone(names[0]), bone(names[1]), bone(names[2])];
      this.blends[finger] = null;
    }
    this.forearm = bone('forearm');
    this.handBone = bone('hand');
    this.forearmRest.copy(this.forearm.quaternion);

    this.plumb = new Mesh(template.plumb, plumbMaterial(this.material));
    this.plumb.renderOrder = 3.3;
    this.plumbAnchor = new Vector3().fromArray(template.meta.plumbAnchor);
    // The knot is on skin that the forearm bone and the hand bone share (assets/src/hands.py, skin_of).
    const forearmShare = smooth(-0.2, 0.42, this.plumbAnchor.z);
    for (const [b, share] of [
      [this.forearm, forearmShare],
      [this.handBone, 1 - forearmShare],
    ] as const) {
      this.carried.push({ bone: b, inverse: skin.skeleton.boneInverses[skin.skeleton.bones.indexOf(b)]!.clone().multiply(skin.bindMatrix), share });
    }
    this.root.add(this.body, this.plumb);
    this.pose.set(POSES.relaxed);
    this.randomState = (Math.floor(seed * 7919) + (mirrored ? 104729 : 0) + 1) >>> 0;
    this.fidget.wait = 0.6 + this.random() * 0.6;
  }

  /** A repeatable random number from 0 to 1, different for each hand. */
  private random(): number {
    let t = (this.randomState += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** How much the material does: 'low' for machines that must be spared. */
  setDetail(detail: HandDetail): void {
    this.detail = detail;
    this.fit();
  }

  /**
   * Give the hand the picture of all the hands to go by (silhouette.ts). With it, at full detail,
   * the light inside hugs the hand's edge as it is seen, and the hand has a halo.
   */
  useSilhouette(silhouette: Silhouette | null): void {
    this.silhouette = silhouette;
    // Which picture it reads is settled as it is drawn: there is one for each eye that looks.
    this.material.uniforms.uShape.value = null;
    this.fit();
  }

  /** Match what is compiled and what is drawn to the detail asked for and to whether there is a picture of the hands. */
  private fit(): void {
    const full = this.detail === 'full';
    const edges = full && this.silhouette !== null;
    const [depth, glass, line, , , veil] = this.passes as [ShaderMaterial, ShaderMaterial, ShaderMaterial, ShaderMaterial, ShaderMaterial, ShaderMaterial];
    for (const [material, name, wanted] of [
      [glass, 'DETAIL_FULL', full],
      [glass, 'EDGES', edges],
      [line, 'EDGES', edges],
      // Only with the picture of the hands can the body be let stand back where it is thin (material.ts, DEPTH).
      [depth, 'THIN', edges],
      [veil, 'THIN', edges],
    ] as const) {
      const defines = material.defines as Record<string, string>;
      if (name in defines === wanted) continue;
      if (wanted) defines[name] = '';
      else delete defines[name];
      material.needsUpdate = true;
    }
    for (const extra of this.extras) extra.visible = edges;
  }

  /** Just before any of the hand's passes is drawn: where the eye is, and how big the picture is. */
  private beforeDraw(renderer: WebGLRenderer, camera: Camera): void {
    const u = this.material.uniforms;
    const target = renderer.getRenderTarget();
    if (target) u.uViewport.value.set(target.width, target.height);
    else renderer.getDrawingBufferSize(u.uViewport.value);
    // A picture with no size is not drawn, but nothing is to be divided by it either.
    u.uViewport.value.set(Math.max(1, u.uViewport.value.x), Math.max(1, u.uViewport.value.y));
    // The line is a fixed part of the picture's height, but never so fine that it breaks up; without
    // smoothing of edges it has to be a little wider to hold together.
    const smoothed = target ? target.samples > 0 : smoothsTheScreen(renderer);
    u.uLine.value.x = Math.max(smoothed ? 1.3 : 1.6, (LINE_WIDTH * u.uViewport.value.y) / 1080);
    if (this.silhouette && this.detail === 'full') u.uShape.value = this.silhouette.draw(renderer, camera, u.uViewport.value.x, u.uViewport.value.y);
    this.behind = eyeBehindArm(vTemp.setFromMatrixPosition(camera.matrixWorld), u.uArmFrom.value, u.uArmWay.value, this.armLong);
  }

  // -- placement ----------------------------------------------------------------

  /**
   * Put the hand-space point `focus` at `at` in the world, with the fingers heading along `yaw`
   * (0 is toward -z, positive turns toward -x), tipped down by `pitch`, and rolled about its own
   * length by `roll` (positive lowers the thumb side of a right hand).
   */
  place(at: Vector3, focus: Vector3, yaw: number, pitch: number, roll = 0): void {
    const q = this.body.quaternion;
    q.setFromAxisAngle(UP, yaw);
    q.multiply(qTemp.setFromAxisAngle(AXIS_X, -pitch));
    q.multiply(qTemp.setFromAxisAngle(AXIS_Z, this.mirrored ? -roll : roll));
    vTemp.copy(focus);
    if (this.mirrored) vTemp.x = -vTemp.x;
    this.body.position.copy(at).sub(vTemp.applyQuaternion(q));
  }

  /** The heading that points the fingers from the shoulder toward a point, so the arm reaches out to it. */
  headingTo(at: Vector3): number {
    return Math.atan2(-(at.x - this.shoulder.x), -(at.z - this.shoulder.z));
  }

  /** A point given in hand space, in the world. */
  toWorld(local: Vector3, out = new Vector3()): Vector3 {
    this.body.updateMatrixWorld();
    return this.body.localToWorld(out.copy(local));
  }

  /**
   * A point of the forearm, given where it is on the resting skin, in the world. The forearm is not
   * held as the hand is: it leads back toward the shoulder (see `update`).
   */
  armToWorld(local: Vector3, out = new Vector3()): Vector3 {
    const forearm = this.carried[0]!;
    return out.copy(local).applyMatrix4(forearm.inverse).applyMatrix4(forearm.bone.matrixWorld);
  }

  /** Where a finger's pad is in the world, as the hand is currently posed. With `tip`, its very end. */
  padWorld(finger: FingerName, out = new Vector3(), tip = false): Vector3 {
    const o = FINGERS.indexOf(finger) * ANGLES;
    this.rig.pad(finger, this.applied.subarray(o, o + ANGLES), out, tip);
    this.body.updateMatrixWorld();
    return this.body.localToWorld(out);
  }

  /** The finger angles the hand is drawn with this frame: its pose, as reaching and what it holds have changed it. Not to be written to. */
  get shown(): Pose {
    return this.applied;
  }

  // -- fingers ------------------------------------------------------------------

  /**
   * Move the fingers to a pose over `seconds`. Each finger starts `ripple` seconds after the one
   * before it. `only` limits the change to some fingers.
   */
  setPose(target: Pose, seconds: number, ripple = 0.035, ease: (k: number) => number = Easing.outCubic, only?: FingerName[]): void {
    for (const finger of only ?? FINGERS) {
      const o = FINGERS.indexOf(finger) * ANGLES;
      this.blends[finger] = {
        from: Array.from(this.pose.subarray(o, o + ANGLES)),
        to: Array.from(target.subarray(o, o + ANGLES)),
        age: 0,
        delay: ripple * RIPPLE_RANK[finger],
        duration: Math.max(1e-4, seconds),
        ease,
      };
    }
  }

  /**
   * Fingers that are closed on something are posed where they are on it, so that a pose they are
   * sent to next is reached from there and not from the pose they had before they took hold.
   */
  holdWhereTheyAre(): void {
    if (this.touchWeight <= 0) return;
    for (const finger of FINGERS) {
      if (!this.touch[finger] && !this.obstacle) continue;
      const o = FINGERS.indexOf(finger) * ANGLES;
      for (let i = 0; i < ANGLES; i++) this.pose[o + i] = this.pose[o + i]! + (this.grasp[o + i]! - this.pose[o + i]!) * this.touchWeight;
      this.blends[finger] = null;
    }
  }

  /** Stop asking any finger to touch anything. */
  clearTouch(): void {
    for (const finger of FINGERS) delete this.touch[finger];
    this.touchWeight = 0;
    this.obstacle = null;
  }

  /** How deep in what the hand holds a finger with these angles would be, feeling with its balls from `first` on. */
  private sunk(finger: FingerName, angles: ArrayLike<number>, first = 0): number {
    this.rig.balls(finger, angles, balls, sizes);
    let deepest = -Infinity;
    for (let b = first; b < balls.length; b++) deepest = Math.max(deepest, this.obstacle!(this.body.localToWorld(balls[b]!), sizes[b]!));
    return deepest;
  }

  /**
   * How far along a way of closing a finger can go before it sinks into what the hand holds, from
   * 0 (where it starts) to 1 (the whole way). `at` gives the finger's angles for a share of the way.
   */
  private farthest(finger: FingerName, at: (share: number) => ArrayLike<number>, steps: number): number {
    // In steps first: a finger does not pass through a thin part of the thing to the clear air beyond it.
    let free = 0;
    let met = -1;
    for (let i = 1; i <= steps && met < 0; i++) {
      if (this.sunk(finger, at(i / steps)) > GIVE) met = i / steps;
      else free = i / steps;
    }
    if (met < 0) return 1;
    for (let i = 0; i < 5; i++) {
      const half = 0.5 * (free + met);
      if (this.sunk(finger, at(half)) > GIVE) met = half;
      else free = half;
    }
    return free;
  }

  /**
   * Where a finger comes to rest on what the hand holds, written into `out`. It starts from where it
   * is posed (opening first, if that is already inside the thing), and closes toward the angles `to`
   * until some part of it meets the stone. If it was not its end that met it, the outer joints go on
   * closing, the middle one and then the last, until the end does: fingers wrap what they take hold
   * of. A joint that would close on nothing stays as it was. With no `to`, the finger only keeps clear.
   */
  private closeOn(finger: FingerName, o: number, to: ArrayLike<number> | null, out: number[]): void {
    for (let i = 0; i < ANGLES; i++) out[i] = this.applied[o + i]!;
    if (this.sunk(finger, out) > GIVE) {
      const bend = out[0]!;
      let step = 1;
      for (; step <= 12; step++) {
        out[0] = bend - (OPENS * step) / 12;
        if (this.sunk(finger, out) <= GIVE) break;
      }
      // No way out of it by opening: it stays as it was posed.
      if (step > 12) out[0] = bend;
    }
    if (!to) return;
    for (let i = 0; i < ANGLES; i++) posed[i] = out[i]!;
    const toward = (share: number) => {
      for (let i = 0; i < ANGLES; i++) trial[i] = posed[i]! + (to[i]! - posed[i]!) * share;
      return trial;
    };
    const share = this.farthest(finger, toward, 8);
    for (let i = 0; i < ANGLES; i++) out[i] = posed[i]! + (to[i]! - posed[i]!) * share;
    if (share >= 1 || this.sunk(finger, out, 2) > -TOUCHING) return;

    // Its end is still in the air. The middle joint closes, the last with it; then the last alone.
    for (let i = 0; i < ANGLES; i++) posed[i] = out[i]!;
    const middle = this.farthest(finger, (k) => this.rig.curled(finger, posed, CURLS * k, 0, trial), 6);
    if (middle < 1) this.rig.curled(finger, posed, CURLS * middle, 0, out);
    if (this.sunk(finger, out, 2) > -TOUCHING) return;
    for (let i = 0; i < ANGLES; i++) posed[i] = out[i]!;
    const last = this.farthest(finger, (k) => this.rig.curled(finger, posed, 0, CURLS * k, trial), 6);
    if (last < 1) this.rig.curled(finger, posed, 0, CURLS * last, out);
  }

  /** Roll the fingers on the air, little finger first: the gesture of someone waiting. */
  drumFingers(rounds = 2): void {
    this.drum.age = 0;
    this.drum.rounds = rounds;
  }

  // -- per frame ----------------------------------------------------------------

  update(dt: number, time: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uFill.value = this.fill;
    u.uOutline.value = this.outline;
    u.uEnergy.value = this.energy;
    u.uDissolve.value = this.dissolve;
    this.root.visible = (this.fill > 0.004 || this.outline > 0.004) && this.dissolve < 0.999;

    // 1. Pose blends, each finger in its own time.
    for (const finger of FINGERS) {
      const b = this.blends[finger];
      if (!b) continue;
      b.age += dt;
      const k = b.ease(clamp01((b.age - b.delay) / b.duration));
      const o = FINGERS.indexOf(finger) * ANGLES;
      for (let i = 0; i < ANGLES; i++) this.pose[o + i] = b.from[i]! + (b.to[i]! - b.from[i]!) * k;
      if (b.age >= b.delay + b.duration) this.blends[finger] = null;
    }
    this.applied.set(this.pose);

    // 2. Life: a slow drift in every joint, and now and then one finger lifts and resettles.
    if (this.restless > 0) {
      const f = this.fidget;
      f.age += dt;
      if (f.age > f.wait + FIDGET) {
        // One finger adjusts every 0.6 to 1.2 seconds (style bible, 6.4).
        f.age = 0;
        f.wait = 0.6 + this.random() * 0.6;
        f.finger = FINGERS[1 + Math.floor(this.random() * 4)]!;
        f.depth = 0.09 + this.random() * 0.1;
      }
      const breath = this.restless * this.ease;
      for (const finger of FINGERS) {
        const n = FINGERS.indexOf(finger);
        const o = n * ANGLES;
        const phase = o * 1.7 + (this.mirrored ? 2.1 : 0);
        this.applied[o]! += this.restless * 0.03 * Math.sin(time * 0.7 + phase);
        this.applied[o + 1]! += this.restless * 0.025 * Math.sin(time * 0.53 + phase * 1.3);
        // The breath: each finger a little behind the one outside it, and each joint a little
        // behind the one before, so that it runs through the hand and out at the fingertips. The
        // thumb takes less of it.
        const lag = (FINGERS.length - 1 - n) * 0.55 + (this.mirrored ? 2.1 : 0);
        const share = breath * (finger === 'thumb' ? 0.5 : 1);
        this.applied[o]! += share * BREATH * Math.sin(time * BREATHES - lag);
        this.applied[o + 1]! += share * BREATH * 0.8 * Math.sin(time * BREATHES - lag - 0.7);
        this.applied[o + 2]! += share * BREATH * 0.55 * Math.sin(time * BREATHES - lag - 1.4);
        // The adjusting finger lifts quickly and settles slowly.
        if (finger === f.finger && f.age < FIDGET) this.applied[o]! -= this.restless * f.depth * Math.sin(Math.PI * Math.pow(f.age / FIDGET, 0.6));
      }
    }
    if (this.wagged !== 0) {
      // Straightened as it swings: a finger that is wagged is held out to be.
      const o = FINGERS.indexOf('index') * ANGLES;
      const out = Math.min(1, Math.abs(this.wagged) * 8);
      this.applied[o]! *= 1 - 0.7 * out;
      this.applied[o + 1]! *= 1 - 0.7 * out;
      this.applied[o + 3]! += this.wagged;
    }
    if (this.drum.rounds > 0) {
      const d = this.drum;
      d.age += dt;
      const beat = 0.075;
      const round = beat * 4 + 0.18;
      DRUM_ORDER.forEach((finger, i) => {
        const since = d.age - i * beat;
        if (since < 0) return;
        const k = (since % round) / 0.2;
        if (k >= 1) return;
        // Each finger lifts, then comes down a little past where it rested.
        const o = FINGERS.indexOf(finger) * ANGLES;
        this.applied[o]! += Math.sin(Math.PI * k) * (-0.24 * (1 - k) + 0.12 * k);
      });
      if (d.age > round * d.rounds) d.rounds = 0;
    }

    // 3. Fingers that have something to touch are bent to reach it, and come to rest on what the hand holds.
    this.body.updateMatrixWorld();
    this.grasping = this.touchWeight > 0 ? this.grasping + 1 : 0;
    if (this.touchWeight > 0) {
      // Where a finger rests is found afresh each frame, and followed quickly rather than at once, so
      // that a finger which finds a different hold on the stone moves to it instead of jumping.
      const follow = this.grasping === 1 ? 1 : 1 - Math.exp(-dt * FOLLOW);
      for (const finger of FINGERS) {
        const target = this.touch[finger];
        if (!target && !this.obstacle) continue;
        const o = FINGERS.indexOf(finger) * ANGLES;
        let to: ArrayLike<number> | null = null;
        if (target) to = this.rig.reach(finger, this.body.worldToLocal(vTemp.copy(target)), this.pose.subarray(o, o + ANGLES)).angles;
        if (this.obstacle) {
          this.closeOn(finger, o, to, closed);
          to = closed;
        }
        for (let i = 0; i < ANGLES; i++) {
          const rest = (this.grasp[o + i] = this.grasp[o + i]! + (to![i]! - this.grasp[o + i]!) * follow);
          this.applied[o + i] = this.applied[o + i]! + (rest - this.applied[o + i]!) * this.touchWeight;
        }
      }
    }

    // 4. Write the angles into the skeleton.
    for (const finger of FINGERS) {
      const o = FINGERS.indexOf(finger) * ANGLES;
      this.rig.rotations(finger, this.applied.subarray(o, o + ANGLES), this.scratch);
      const bones = this.bones[finger];
      bones[0].quaternion.copy(this.scratch[0]);
      bones[1].quaternion.copy(this.scratch[1]);
      bones[2].quaternion.copy(this.scratch[2]);
    }

    // 5. The forearm leads back toward the shoulder, swung round the wrist as far as it has been
    // told to be. The wrist only bends so far.
    const wrist = this.body.position;
    const toShoulder = this.body.worldToLocal(vTemp.copy(this.shoulder).sub(wrist).applyAxisAngle(UP, this.swing).add(wrist)).normalize();
    const inHandBone = toShoulder.applyQuaternion(qTemp.copy(this.handBone.quaternion).invert());
    const restDirection = vTemp2.set(0, 1, 0).applyQuaternion(this.forearmRest);
    const bend = restDirection.angleTo(inHandBone);
    qTemp.setFromUnitVectors(restDirection, inHandBone);
    if (bend > 1.1) qTemp.slerp(qIdentity, 1 - 1.1 / bend);
    this.forearm.quaternion.copy(qTemp).multiply(this.forearmRest);

    // 6. The plumb weight swings from the cord.
    this.swingPlumb(dt);

    // 7. Where that leaves the arm in the room, for an eye that may be behind it (material.ts, BEHIND).
    this.armToWorld(vTemp.set(0, 0, ARM_FROM), u.uArmFrom.value);
    this.armToWorld(vTemp.set(0, 0, ARM_FROM + 1), u.uArmWay.value).sub(u.uArmFrom.value).normalize();
    // And the other way: from the room back to the resting skin (material.ts, nearSide).
    const forearm = this.carried[0]!;
    u.uArmRest.value.copy(forearm.bone.matrixWorld).multiply(forearm.inverse).invert();
  }

  private swingPlumb(dt: number): void {
    // The knot rides on the skin of the wrist, which the forearm and the hand each carry part of.
    this.body.updateMatrixWorld(true);
    const anchor = vAnchor.set(0, 0, 0);
    for (const c of this.carried) {
      anchor.addScaledVector(vTemp.copy(this.plumbAnchor).applyMatrix4(c.inverse).applyMatrix4(c.bone.matrixWorld), c.share);
    }
    const length = PLUMB_LINE;
    if (!this.bobReady) {
      this.bob.copy(anchor).addScaledVector(DOWN, length);
      this.bobReady = true;
    }
    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-6) {
      const h = Math.min(remaining, 1 / 120);
      remaining -= h;
      this.bobVelocity.y -= 26 * h;
      this.bobVelocity.multiplyScalar(Math.exp(-2.2 * h));
      this.bob.addScaledVector(this.bobVelocity, h);
      // Keep it on its string, and take out the speed along the string.
      const along = vTemp2.copy(this.bob).sub(anchor);
      const d = along.length() || 1;
      along.divideScalar(d);
      this.bob.copy(anchor).addScaledVector(along, length);
      this.bobVelocity.addScaledVector(along, -this.bobVelocity.dot(along));
    }
    this.plumb.position.copy(anchor);
    this.plumb.quaternion.setFromUnitVectors(DOWN, vTemp2.copy(this.bob).sub(anchor).normalize());
  }

  /** Where the weight on its cord is, in the room. */
  weightWorld(out = new Vector3()): Vector3 {
    return out.copy(this.bob);
  }

  /** The weight is given a push, in the room's terms: it swings from it, and is left to. */
  pullWeight(push: Vector3): void {
    this.bobVelocity.add(push);
  }

  /** How fast the weight is swinging. */
  get weightSpeed(): number {
    return this.bobVelocity.length();
  }

  dispose(): void {
    for (const pass of this.passes) pass.dispose();
    (this.plumb.material as ShaderMaterial).dispose();
  }
}

/** The drawn line's width in pixels, in a picture 1080 pixels high. */
const LINE_WIDTH = 1.7;
/** How far below the knot the plumb weight hangs. */
const PLUMB_LINE = 0.6;
/** How far a finger's flesh gives against what it holds, in squares. */
const GIVE = 0.012;
/** A part of a finger this near the stone is on it. */
const TOUCHING = 0.02;
/** How far a finger's knuckle opens to get out of what the hand holds, and how far an outer joint closes to reach it. */
const OPENS = 0.9;
const CURLS = 0.95;
/** How quickly a finger follows where it should rest, per second. */
const FOLLOW = 40;
const trial = [0, 0, 0, 0, 0];
const posed = [0, 0, 0, 0, 0];
const closed = [0, 0, 0, 0, 0];
const balls: [Vector3, Vector3, Vector3, Vector3] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const sizes = [0, 0, 0, 0];

function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

const screens = new WeakMap<WebGLRenderer, boolean>();

/**
 * Whether a renderer smooths the edges of what it draws straight to the screen. It is asked once:
 * the answer does not change, and asking makes a new object each time, for every pass of every hand.
 */
function smoothsTheScreen(renderer: WebGLRenderer): boolean {
  let smoothed = screens.get(renderer);
  if (smoothed === undefined) screens.set(renderer, (smoothed = renderer.getContextAttributes().antialias === true));
  return smoothed;
}

const qTemp = new Quaternion();
const qIdentity = new Quaternion();
const vTemp = new Vector3();
const vTemp2 = new Vector3();
const vAnchor = new Vector3();
