/**
 * Checks the exported hand against what the engine's hand code assumes about
 * it, and checks the finger solver on the real skeleton.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Object3D, type SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { FINGERS, type FingerName, type HandMeta, HandRig } from '../src/hands/rig.ts';

const FILE = path.resolve(import.meta.dirname, '../public/assets/hand.glb');

let scene: Object3D;
let skin: SkinnedMesh;
let meta: HandMeta;
let rig: HandRig;

beforeAll(async () => {
  const bytes = readFileSync(FILE);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  scene = gltf.scene;
  skin = scene.getObjectByName('hand_skin') as SkinnedMesh;
  meta = JSON.parse(skin.userData.meta as string) as HandMeta;
  rig = new HandRig(scene, meta);
});

describe('hand.glb', () => {
  it('is a skinned hand with seventeen bones, a data channel and a plumb weight', () => {
    expect(skin.isSkinnedMesh).toBe(true);
    expect(skin.skeleton.bones).toHaveLength(17);
    for (const attribute of ['position', 'normal', 'color', 'skinIndex', 'skinWeight']) {
      expect(skin.geometry.getAttribute(attribute), attribute).toBeDefined();
    }
    expect(skin.geometry.index!.count / 3).toBeLessThan(16000);
    expect(scene.getObjectByName('plumb')).toBeDefined();
    expect(scene.getObjectByName('forearm')).toBeDefined();
  });

  it('is the size the style bible asks for, with the fingers along -z and the thumb on -x', () => {
    // 3.5 to 4 squares from wrist to fingertip.
    expect(meta.length).toBeGreaterThan(3.5);
    expect(meta.length).toBeLessThan(4);
    const straight = [0, 0, 0, 0, 0];
    const middle = rig.pad('middle', straight, new Vector3(), true);
    expect(middle.z).toBeCloseTo(-meta.length, 2);
    expect(Math.abs(middle.y)).toBeLessThan(0.1);
    expect(rig.pad('thumb', straight, new Vector3(), true).x).toBeLessThan(-1.2);
    expect(rig.pad('little', straight, new Vector3(), true).x).toBeGreaterThan(0.6);
  });

  it('has a forearm that runs on wide to its far end, and does not come to a point', () => {
    const position = skin.geometry.getAttribute('position');
    // How far the skin reaches to either side, and to front and back, in a slice of the forearm.
    const slice = (from: number, to: number) => {
      const found = { wide: 0, deep: 0, count: 0 };
      for (let i = 0; i < position.count; i++) {
        const z = position.getZ(i);
        if (z < from || z >= to) continue;
        found.wide = Math.max(found.wide, Math.abs(position.getX(i)));
        found.deep = Math.max(found.deep, Math.abs(position.getY(i)));
        found.count++;
      }
      return found;
    };
    // Nothing of it lies beyond the place it says it ends, and it gets there.
    let farthest = -Infinity;
    for (let i = 0; i < position.count; i++) farthest = Math.max(farthest, position.getZ(i));
    expect(meta.forearmLength).toBeGreaterThan(3);
    expect(farthest).toBeLessThan(meta.forearmLength + 0.02);
    expect(farthest).toBeGreaterThan(meta.forearmLength - 0.1);
    // Just short of its end it is as wide and as deep as it says.
    const [halfWidth, halfDepth] = meta.forearmEnd;
    const end = slice(meta.forearmLength - 0.5, meta.forearmLength - 0.1);
    expect(end.count).toBeGreaterThan(40);
    expect(end.wide).toBeGreaterThan(halfWidth - 0.05);
    expect(end.wide).toBeLessThan(halfWidth + 0.02);
    expect(end.deep).toBeGreaterThan(halfDepth - 0.05);
    expect(end.deep).toBeLessThan(halfDepth + 0.02);
    // And from the cord on, where a wrist is narrowest, it never narrows.
    const cord = slice(meta.cord[0], meta.cord[1]);
    expect(cord.wide).toBeGreaterThan(0.4);
    for (let z = meta.cord[1]; z < meta.forearmLength - 0.4; z += 0.3) {
      const here = slice(z, z + 0.3);
      expect(here.wide, `how wide at ${z.toFixed(1)}`).toBeGreaterThan(cord.wide - 0.03);
      expect(here.deep, `how deep at ${z.toFixed(1)}`).toBeGreaterThan(cord.deep - 0.03);
    }
  });

  it('has every vertex weighted, with weights that sum to one', () => {
    const w = skin.geometry.getAttribute('skinWeight');
    for (let i = 0; i < w.count; i += 37) {
      const sum = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
      expect(sum).toBeCloseTo(1, 2);
    }
  });
});

describe('finger kinematics', () => {
  it('bends every finger toward the palm', () => {
    for (const finger of FINGERS) {
      const open = rig.pad(finger, [0, 0, 0, 0, 0]);
      const bent = rig.pad(finger, [0.8, 0.8, 0.5, 0, 0]);
      // The palm faces -y. The thumb closes across the palm rather than straight down.
      if (finger === 'thumb') expect(bent.x).toBeGreaterThan(open.x + 0.3);
      else expect(bent.y).toBeLessThan(open.y - 0.6);
    }
  });

  it('spreads the fingers toward the thumb side for a positive spread', () => {
    const a = rig.pad('index', [0, 0, 0, 0, 0]);
    const b = rig.pad('index', [0, 0, 0, 0.3, 0]);
    expect(b.x).toBeLessThan(a.x - 0.2);
  });

  it('puts a pad where it is asked to, for points a finger can reach', () => {
    for (const finger of FINGERS) {
      for (const [f1, f2, spread] of [
        [0.3, 0.4, 0.0],
        [0.9, 0.7, 0.1],
        [1.1, 1.2, -0.15],
        [0.5, 1.0, 0.2],
      ] as [number, number, number][]) {
        // A point this finger can certainly reach: where its pad is for some other angles.
        const twist = finger === 'thumb' ? 0.4 : 0;
        const target = rig.pad(finger, [f1, f2, f2 * 0.66, spread, twist]);
        const found = rig.reach(finger, target, [0.6, 0.6, 0.4, 0, twist]);
        expect(found.miss, `${finger} ${f1} ${f2} ${spread}`).toBeLessThan(0.02);
      }
    }
  });

  it('stays within what a finger can do when asked for the impossible', () => {
    const far = new Vector3(0, 3, 4);
    for (const finger of FINGERS) {
      const found = rig.reach(finger as FingerName, far, [0.6, 0.6, 0.4, 0, 0]);
      expect(found.miss).toBeGreaterThan(1);
      for (const angle of found.angles) expect(Math.abs(angle)).toBeLessThan(2);
      expect(found.angles.every((x) => Number.isFinite(x))).toBe(true);
    }
  });
});
