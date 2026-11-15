/**
 * The hands on the real skeleton and the real stones, without a renderer: a game, its pieces and
 * a stage, and a clock to step them by. For tests of what the hands do.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type BufferGeometry, Mesh, MeshBasicMaterial, type Object3D, type SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Game, type Kind } from '../../src/core/game.ts';
import { type HandTemplate, handTemplateFrom } from '../../src/hands/hand.ts';
import { Girth } from '../../src/hands/girth.ts';
import type { Arm, PieceGrip } from '../../src/hands/puppeteer.ts';
import { Stage } from '../../src/hands/stage.ts';
import { PieceLayer, type PieceLook, type Puppet } from '../../src/scene/pieces.ts';
import { Tweens } from '../../src/scene/tween.ts';

export const DT = 1 / 60;
let template: HandTemplate;
const stones = {} as Record<Kind, BufferGeometry>;
const grips = {} as Record<Kind, PieceGrip>;

async function read(file: string): Promise<Object3D> {
  const bytes = readFileSync(path.resolve(import.meta.dirname, '../../public/assets', file));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return (await new GLTFLoader().parseAsync(buffer, '')).scene;
}

/** Read the hand and the stones from their files, as the game does. Call it in `beforeAll`. */
export async function loadHands(): Promise<void> {
  template = handTemplateFrom(await read('hand.glb'));
  (await read('pieces.glb')).traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.name.startsWith('piece_')) return;
    const kind = mesh.name.slice(6) as Kind;
    stones[kind] = mesh.geometry;
    grips[kind] = (JSON.parse(mesh.userData.meta as string) as { grip: PieceGrip }).grip;
  });
}

const plain = new MeshBasicMaterial();
const look: PieceLook = {
  create(kind) {
    const mesh = new Mesh(stones[kind], plain);
    return { object: mesh, setKind: (next) => void (mesh.geometry = stones[next]), update() {}, dispose() {} };
  },
};

export function handsRig(fen?: string) {
  const game = new Game(fen);
  const tweens = new Tweens();
  const layer = new PieceLayer(tweens, look);
  layer.handsOn = true;
  layer.reset(game.pieces());
  const stage = new Stage(template, layer, tweens, grips);
  // The manners' chances drawn from a name of its own, so that every run sees the same ones.
  stage.setSeed('rig');
  stage.reset();
  let time = 0;
  /** Step the whole scene, yielding so that what is scripted can queue its next beat. */
  const run = async (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      time += DT;
      tweens.update(DT);
      stage.update(DT, time);
      layer.update(time);
      each?.();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
  };
  return { game, layer, stage, run };
}

const skins = new WeakMap<Arm, SkinnedMesh>();
const point = new Vector3();
const local = new Vector3();

/**
 * How near a hand's skin is to the nearest of some stones, as it is drawn this frame, going by
 * every third point of it: level from the side of a stone, or up from the top of it if that is
 * less. Less than nothing if a point of the hand is inside one.
 */
export function clearOf(arm: Arm, puppets: Puppet[]): number {
  let skin = skins.get(arm);
  if (!skin) {
    arm.hand.root.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) skin ??= o as SkinnedMesh;
    });
    skins.set(arm, skin!);
  }
  arm.hand.root.updateMatrixWorld(true);
  skin!.skeleton.update();
  const near = puppets.filter((puppet) => puppet !== arm.held?.puppet).map((puppet) => {
    puppet.group.updateWorldMatrix(true, true);
    const stone = Girth.of(puppet.group)!;
    return { stone, height: stone.girth.over(0, 0), at: puppet.group.position };
  });
  let nearest = Infinity;
  const count = skin!.geometry.getAttribute('position').count;
  for (let i = 0; i < count; i += 3) {
    skin!.localToWorld(skin!.getVertexPosition(i, point));
    for (const { stone, height, at } of near) {
      // Nothing a square and a half from where a stone stands is anywhere near it.
      if (Math.abs(point.x - at.x) > 1.5 || Math.abs(point.z - at.z) > 1.5) continue;
      stone.mesh.worldToLocal(local.copy(point));
      const beside = Math.hypot(local.x, local.z) - stone.girth.at(Math.min(local.y, height - 0.01), local.x, local.z);
      nearest = Math.min(nearest, Math.max(beside, local.y - height));
    }
  }
  return nearest;
}
