/**
 * The hands, playing real moves on the real skeleton and the real stones,
 * without a renderer: pieces must end exactly where the rules say, never pass
 * through the board, stay in the fingers while they are carried, and taken
 * pieces must end on the ledge with their light out. And a hand must not go
 * through a stone it has not come for, or through the player's other hand.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type BufferGeometry, Mesh, MeshBasicMaterial, type Object3D, type SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Game, type Kind, type PromotionKind, type Square } from '../src/core/game.ts';
import { ballsNow, ballsOf, chart, type Flight, type Posture, sunk } from '../src/hands/flight.ts';
import { Girth } from '../src/hands/girth.ts';
import { type Hand, type HandTemplate, handTemplateFrom, PALM_FOCUS } from '../src/hands/hand.ts';
import type { Arm, PieceGrip } from '../src/hands/puppeteer.ts';
import { ANGLES, type FingerName, FINGERS } from '../src/hands/rig.ts';
import { LEDGE_X, Stage } from '../src/hands/stage.ts';
import { DRAWER_FAR, DRAWER_NEAR, DRAWER_OUT, PLINTH_TOP, SLAB_HALF, squareCenter } from '../src/scene/layout.ts';
import { PieceLayer, type PieceLook, type Puppet } from '../src/scene/pieces.ts';
import { Easing, Tweens } from '../src/scene/tween.ts';

const DT = 1 / 60;
let template: HandTemplate;
/** The stones as they were built, and how each says it is to be held: read from the file, as the game reads them. */
const stones = {} as Record<Kind, BufferGeometry>;
const grips = {} as Record<Kind, PieceGrip>;
/** How tall each stone stands, and how far it reaches from its plumb line at its widest. */
const heights = {} as Record<Kind, number>;
const widths = {} as Record<Kind, number>;
/** How far each stone reaches from its plumb line at its foot, where it stands on the baize of a drawer. */
const feet = {} as Record<Kind, number>;

async function read(file: string): Promise<Object3D> {
  const bytes = readFileSync(path.resolve(import.meta.dirname, '../public/assets', file));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return (await new GLTFLoader().parseAsync(buffer, '')).scene;
}

// Each test here steps the real hands frame by frame, and many measure every point of their skin each frame. They run in one or two seconds on an idle machine; the default five is too little for a runner that is busy with other work.
vi.setConfig({ testTimeout: 30000 });

beforeAll(async () => {
  template = handTemplateFrom(await read('hand.glb'));
  (await read('pieces.glb')).traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.name.startsWith('piece_')) return;
    const kind = mesh.name.slice(6) as Kind;
    stones[kind] = mesh.geometry;
    grips[kind] = (JSON.parse(mesh.userData.meta as string) as { grip: PieceGrip }).grip;
    const girth = new Girth(mesh.geometry);
    heights[kind] = girth.over(0, 0);
    widths[kind] = girth.widest(-Infinity);
    feet[kind] = Math.max(...[0.02, 0.06, 0.1, 0.15].flatMap((y) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => girth.at(y, Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)))));
  });
});

const plain = new MeshBasicMaterial();
/** The stones themselves, undressed: the hands go by the shape of a piece, not by what it is made of. */
const look: PieceLook = {
  create(kind) {
    const mesh = new Mesh(stones[kind], plain);
    return { object: mesh, setKind: (next) => void (mesh.geometry = stones[next]), update() {}, dispose() {} };
  },
};

function setup(fen?: string) {
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
  /** Step the whole scene, yielding so that scripted moves can queue their next beat. */
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
  /** Play a move to its end. `each` is called every frame until the piece is let go; with `home`, until the hands are back at rest as well. */
  const move = async (from: Square, to: Square, promotion?: PromotionKind, each?: () => void, home = false) => {
    const e = game.move(from, to, promotion);
    let done = false;
    void stage.playMove(e).then(() => (done = true));
    await run(6, () => (home || !done) && each?.());
    expect(done, `${from}-${to} finished`).toBe(true);
    return e;
  };
  const undo = async (each?: () => void) => {
    const e = game.undo()!;
    let done = false;
    void stage.playUndo(e).then(() => (done = true));
    await run(6, each);
    expect(done).toBe(true);
    return e;
  };
  return { game, tweens, layer, stage, run, move, undo };
}

function expectStanding(layer: PieceLayer, square: Square) {
  const g = layer.objectAt(square)!;
  expect(g, `a piece on ${square}`).not.toBeNull();
  const c = squareCenter(square);
  expect(g.position.distanceTo(c)).toBeLessThan(1e-6);
  expect(g.rotation.x).toBeCloseTo(0, 6);
  expect(g.rotation.z).toBeCloseTo(0, 6);
  expect(g.scale.toArray().every((v) => Math.abs(v - 1) < 1e-3)).toBe(true);
}

const balls = [new Vector3(), new Vector3(), new Vector3(), new Vector3()] as [Vector3, Vector3, Vector3, Vector3];
const sizes: number[] = [];
const local = new Vector3();

/** How deep the far half of a finger is in a piece's stone, as the hand is drawn now: less than nothing when it is clear of it. */
function fingerIn(arm: Arm, finger: FingerName, piece: Object3D): number {
  const stone = Girth.of(piece)!;
  stone.mesh.updateWorldMatrix(true, false);
  const o = FINGERS.indexOf(finger) * ANGLES;
  arm.hand.rig.balls(finger, arm.hand.shown.subarray(o, o + ANGLES), balls, sizes);
  let deepest = -Infinity;
  balls.forEach((ball, i) => (deepest = Math.max(deepest, stone.girth.depth(stone.mesh.worldToLocal(arm.hand.toWorld(ball, ball)), sizes[i]!))));
  return deepest;
}

const skins = new WeakMap<Arm, SkinnedMesh>();
const point = new Vector3();

/** Every `step`th point of a hand's skin where it is drawn this frame, in the room. */
function eachPointOf(arm: Arm, step: number, each: (point: Vector3) => void): void {
  let skin = skins.get(arm);
  if (!skin) {
    arm.hand.root.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) skin ??= o as SkinnedMesh;
    });
    skins.set(arm, skin!);
  }
  arm.hand.root.updateMatrixWorld(true);
  skin!.skeleton.update();
  const count = skin!.geometry.getAttribute('position').count;
  for (let i = 0; i < count; i += step) each(skin!.localToWorld(skin!.getVertexPosition(i, point)));
}

/**
 * How far outside a stone a point of the room is: level from the side of it, or up from the top of
 * it if that is less. Less than nothing for a point inside it.
 */
function outside(puppet: Puppet, p: Vector3): number {
  const stone = Girth.of(puppet.group)!;
  stone.mesh.worldToLocal(local.copy(p));
  const beside = Math.hypot(local.x, local.z) - stone.girth.at(Math.min(local.y, heights[puppet.kind] - 0.01), local.x, local.z);
  return Math.max(beside, local.y - heights[puppet.kind]);
}

/**
 * How deep a hand's skin is in what it should be clear of, going by every third point of it: in a
 * stone it has not got hold of; and in the player's other hand, if that is given, which is taken
 * as the balls a hand is felt with.
 */
function skinIn(arm: Arm, puppets: Puppet[], other?: Arm): { stone: number; hand: number } {
  const near = puppets.filter((puppet) => puppet !== arm.held?.puppet);
  for (const puppet of near) puppet.group.updateWorldMatrix(true, true);
  const shape = other ? ballsNow(other.hand) : [];
  // Nothing outside this box is in any of the other hand's balls.
  const low = new Vector3(Infinity, Infinity, Infinity);
  const high = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let b = 0; b < shape.length; b += 4) {
    low.min(point.set(shape[b]!, shape[b + 1]!, shape[b + 2]!).subScalar(shape[b + 3]!));
    high.max(point.addScalar(2 * shape[b + 3]!));
  }
  const deepest = { stone: 0, hand: 0 };
  eachPointOf(arm, 3, (p) => {
    for (const puppet of near) {
      const at = puppet.group.position;
      if (Math.abs(p.x - at.x) > 0.6 || Math.abs(p.z - at.z) > 0.6 || p.y < at.y || p.y > at.y + heights[puppet.kind]) continue;
      deepest.stone = Math.max(deepest.stone, -outside(puppet, p));
    }
    if (p.x < low.x || p.y < low.y || p.z < low.z || p.x > high.x || p.y > high.y || p.z > high.z) return;
    for (let b = 0; b < shape.length; b += 4) deepest.hand = Math.max(deepest.hand, shape[b + 3]! - Math.hypot(p.x - shape[b]!, p.y - shape[b + 1]!, p.z - shape[b + 2]!));
  });
  return deepest;
}

/**
 * The least room there is between two stones: how far outside the one the nearest corner of the
 * other is. Less than nothing if a corner of either is inside the other.
 */
function roomBetween(a: Puppet, b: Puppet): number {
  let least = a.group.position.distanceTo(b.group.position) - widths[a.kind] - widths[b.kind];
  // Too far apart for it to matter by how much.
  if (least > 0.5) return least;
  least = Infinity;
  for (const puppet of [a, b]) puppet.group.updateWorldMatrix(true, true);
  for (const [one, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const corners = Girth.of(one.group)!.mesh;
    const position = corners.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) least = Math.min(least, outside(other, corners.localToWorld(point.fromBufferAttribute(position, i))));
  }
  return least;
}

describe('a hand moves a piece', () => {
  it('lifts it, carries it over and sets it exactly on its square', async () => {
    const { layer, move } = setup();
    const pawn = layer.objectAt('e2')!;
    let highest = 0;
    let lowest = Infinity;
    await move('e2', 'e4', undefined, () => {
      highest = Math.max(highest, pawn.position.y);
      lowest = Math.min(lowest, pawn.position.y);
    });
    expect(layer.objectAt('e4')).toBe(pawn);
    expectStanding(layer, 'e4');
    expect(highest).toBeGreaterThan(0.7);
    // It never sinks into the board.
    expect(lowest).toBeGreaterThan(-0.02);
  });

  // One of each kind, each with room round it, so that it is held as it asks to be.
  const OPEN = '4k3/8/8/8/8/8/8/R2QKB1R w KQ - 0 1';
  it.each([
    ['pawn', undefined, 'e2', 'e4'],
    ['knight', undefined, 'g1', 'f3'],
    ['bishop', OPEN, 'f1', 'c4'],
    ['rook', OPEN, 'a1', 'a4'],
    ['queen', OPEN, 'd1', 'd5'],
    ['king', OPEN, 'e1', 'e2'],
  ] as [string, string | undefined, Square, Square][])('keeps its fingers on a %s for the whole carry', async (name, fen, from, to) => {
    const { layer, stage, move } = setup(fen);
    const piece = layer.objectAt(from)!;
    let checked = 0;
    const most: Partial<Record<FingerName, number>> = {};
    const least: Partial<Record<FingerName, number>> = {};
    await move(from, to, undefined, () => {
      for (const arm of [stage.hands.w.right, stage.hands.w.left]) {
        if (!arm.held?.attached) continue;
        for (const finger of FINGERS) {
          if (arm.held.spec.contacts[finger] === undefined) continue;
          const deep = fingerIn(arm, finger, piece);
          most[finger] = Math.max(most[finger] ?? -Infinity, deep);
          least[finger] = Math.min(least[finger] ?? Infinity, deep);
          checked++;
        }
      }
    });
    expect(checked).toBeGreaterThan(150);
    // Each finger that takes part rests on the stone itself, wherever that is for this piece: it is
    // never off it by more than a hair, and never in it by more than a squeeze.
    for (const finger of Object.keys(most) as FingerName[]) {
      expect(least[finger], `${finger} off the ${name}`).toBeGreaterThan(-0.05);
      expect(most[finger], `${finger} in the ${name}`).toBeLessThan(0.04);
    }
  });

  it('carries a knight clear over the pieces in its way, and no higher than it needs', async () => {
    const { layer, move } = setup();
    const knight = layer.objectAt('g1')!;
    let overPawns = Infinity;
    let highest = 0;
    await move('g1', 'f3', undefined, () => {
      highest = Math.max(highest, knight.position.y);
      // While it is over the second rank, its foot is above the pawns standing there.
      if (knight.position.z < 3.0 && knight.position.z > 2.0) overPawns = Math.min(overPawns, knight.position.y);
    });
    expect(overPawns).toBeGreaterThan(heights.p + 0.15);
    expect(highest).toBeLessThan(heights.p + 0.65);
    expectStanding(layer, 'f3');

    // With a king in the way, it goes over the king.
    const tall = setup('4k3/p7/8/8/8/8/4K3/3N4 w - - 0 1');
    const hopper = tall.layer.objectAt('d1')!;
    let overKing = Infinity;
    await tall.move('d1', 'e3', undefined, () => {
      if (Math.hypot(hopper.position.x - 0.5, hopper.position.z - 2.5) < 0.45) overKing = Math.min(overKing, hopper.position.y);
    });
    expect(overKing).toBeGreaterThan(heights.k);
    expectStanding(tall.layer, 'e3');
  });

  it('uses the hand on the piece\'s own side of the board', async () => {
    const { stage, move } = setup();
    let right = false;
    let left = false;
    await move('g1', 'f3', undefined, () => {
      right ||= stage.hands.w.right.busy;
      left ||= stage.hands.w.left.busy;
    });
    expect(right).toBe(true);
    expect(left).toBe(false);
    // Void sits on the other side: its right hand is on the b-file's side.
    let voidRight = false;
    let voidLeft = false;
    await move('b8', 'c6', undefined, () => {
      voidRight ||= stage.hands.b.right.busy;
      voidLeft ||= stage.hands.b.left.busy;
    });
    expect(voidRight).toBe(true);
    expect(voidLeft).toBe(false);
    expect(stage.hands.b.left.busy || stage.hands.b.right.busy).toBe(false);
  });
});

describe('the hands among the stones', () => {
  const MIDDLE = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/2PP1B2/2N1PN2/PP2BPPP/R2Q1RK1 w - - 0 8';
  it.each([
    ['a pawn on its own rank', undefined, 'e2', 'e4'],
    ['a knight behind its pawns', undefined, 'g1', 'f3'],
    ['a queen among her own pieces', MIDDLE, 'd1', 'b3'],
    ['a rook with pieces close round it', MIDDLE, 'a1', 'c1'],
    ['a bishop in the middle of the board', MIDDLE, 'f4', 'e5'],
  ] as [string, string | undefined, Square, Square][])('goes through none of them coming to %s, carrying it, or going home', async (_name, fen, from, to) => {
    const { layer, stage, run, move } = setup(fen);
    stage.setTurn('w');
    // The hands are where they rest before anything is asked of them.
    await run(1.5);
    const puppets = [...layer.standing()];
    const arms = [stage.hands.w.right, stage.hands.w.left];
    let deepest = 0;
    let quiet = 0;
    await move(
      from,
      to,
      undefined,
      () => {
        // Until both are home again.
        quiet = arms.some((arm) => arm.busy) ? 0 : quiet + DT;
        if (quiet > 1.2) return;
        for (const arm of arms) deepest = Math.max(deepest, skinIn(arm, puppets).stone);
      },
      true,
    );
    // Not by a hundredth of a square.
    expect(deepest).toBeLessThan(0.01);
  });

  it('rests well clear of them, whoever is to move', async () => {
    const { layer, stage, run } = setup();
    const puppets = [...layer.standing()];
    const arms = [stage.hands.w.right, stage.hands.w.left, stage.hands.b.right, stage.hands.b.left];
    for (const turn of ['w', 'b', null] as const) {
      // The player to move leans in over the board; a resting hand drifts a little all the while.
      stage.setTurn(turn);
      await run(2);
      let nearest = Infinity;
      for (let i = 0; i < 10; i++) {
        await run(1.3);
        for (const arm of arms) {
          eachPointOf(arm, 3, (p) => {
            for (const puppet of puppets) {
              const at = puppet.group.position;
              if (Math.abs(p.x - at.x) > 1 || Math.abs(p.z - at.z) > 1) continue;
              nearest = Math.min(nearest, outside(puppet, p));
            }
          });
        }
      }
      expect(nearest, `with ${turn ?? 'nobody'} to move`).toBeGreaterThan(0.25);
    }
  });
});

describe('a hand at rest', () => {
  /** How far round a hand is turned from the way its arm reaches out to where it is. */
  const askew = (arm: Arm): number => {
    const turn = arm.yaw.value - arm.hand.headingTo(arm.at.get(new Vector3()));
    return turn - Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
  };

  it('lies in across its corner of the board, its arm with it, and is straight again before it takes hold', async () => {
    const { stage, run, move } = setup();
    stage.setTurn('w');
    await run(2);
    for (const side of ['w', 'b'] as const) {
      const { right, left } = stage.hands[side];
      for (const arm of [right, left]) {
        // Out past the corner of the slab, and well above it.
        const at = arm.at.get(new Vector3());
        expect(Math.abs(at.x)).toBeGreaterThan(4.7);
        expect(Math.abs(at.z)).toBeGreaterThan(4.7);
        expect(at.y).toBeGreaterThan(1.2);
        // Turned in toward the middle of the board: a right hand one way round, a left hand the other.
        const inward = askew(arm) * (arm === right ? 1 : -1);
        expect(inward).toBeGreaterThan(0.6);
        expect(inward).toBeLessThan(0.85);
        expect(-Math.sin(arm.yaw.value) * Math.sign(at.x)).toBeLessThan(-0.3);
        // And its forearm comes in from outside it by as much: the wrist is not bent to one side.
        expect(arm.hand.swing).toBeCloseTo(askew(arm), 2);
      }
    }
    // Reaching for a piece it straightens, and by the time it has hold of it the arm reaches out from the shoulder as it always did.
    const arm = stage.hands.w.right;
    let onTaking = Number.NaN;
    let swungOnTaking = Number.NaN;
    await move(
      'g1',
      'f3',
      undefined,
      () => {
        if (!arm.held || !Number.isNaN(onTaking)) return;
        onTaking = askew(arm);
        swungOnTaking = arm.hand.swing;
      },
      true,
    );
    expect(Math.abs(onTaking)).toBeLessThan(0.02);
    expect(Math.abs(swungOnTaking)).toBeLessThan(0.02);
    // Home again, it lies as it did.
    await run(1.5);
    expect(askew(arm)).toBeGreaterThan(0.6);
    expect(arm.hand.swing).toBeCloseTo(askew(arm), 2);
  });

  it('hangs over the candles at its corner and never in their flames, whoever is to move', async () => {
    // The flames at the corners of the board, where the room was built with them.
    let flames: number[][] = [];
    (await read('room.glb')).traverse((o) => {
      if (o.name !== 'candles') return;
      const meta = JSON.parse(o.userData.meta as string) as { flames: number[][]; plinthFlames: number };
      flames = meta.flames.slice(0, meta.plinthFlames);
    });
    expect(flames).toHaveLength(12);
    const { stage, run } = setup();
    const arms = [stage.hands.w.right, stage.hands.w.left, stage.hands.b.right, stage.hands.b.left];
    for (const turn of ['w', 'b', null] as const) {
      stage.setTurn(turn);
      await run(2);
      let nearest = Infinity;
      let over = 0;
      // Long enough for a waiting hand to have stretched its fingers out, and a ready one to have drummed them.
      for (let i = 0; i < 64; i++) {
        await run(0.25);
        for (const arm of arms) {
          eachPointOf(arm, 3, (p) => {
            for (const [x, y, z] of flames as [number, number, number][]) {
              // A flame stands as far above where it is said to be as below (flames.ts), taller when it flares, and is half as wide as that.
              // (Written out with sqrt: Math.hypot is many times slower, and this runs for every point of every hand against every flame.)
              const beside = Math.sqrt((p.x - x) ** 2 + (p.z - z) ** 2) - 0.065;
              const above = p.y - (y + 0.18);
              if (beside < 0.3) over++;
              // From its side, from its tip, or from the rim of its tip for a point that is out past both.
              nearest = Math.min(nearest, beside > 0 && above > 0 ? Math.sqrt(beside * beside + above * above) : Math.max(beside, above));
            }
          });
        }
      }
      // It is over them, and a good finger's breadth clear of every one.
      expect(over, `with ${turn ?? 'nobody'} to move`).toBeGreaterThan(0);
      expect(nearest, `with ${turn ?? 'nobody'} to move`).toBeGreaterThan(0.2);
    }
  });

  it('draws back as it stretches its fingers out, so that they are never out over the squares', async () => {
    const { stage, run } = setup();
    // Void to move: Ivory's hands wait, and now and then one of them stretches its fingers out.
    stage.setTurn('b');
    await run(2);
    const tip = new Vector3();
    const place = new Vector3();
    const watched = [stage.hands.w.right, stage.hands.w.left].map((arm) => {
      /** How far the end of its middle finger is from its wrist. */
      const long = () => arm.hand.padWorld('middle', tip, true).distanceTo(arm.hand.body.position);
      /** How far out from the middle of the board the hand is held. */
      const out = () => Math.hypot(arm.at.get(place).x, place.z);
      /** How near the squares the nearest point of the hand is: under 4, it would be over them. */
      const near = () => {
        let nearest = Infinity;
        eachPointOf(arm, 3, (p) => (nearest = Math.min(nearest, Math.max(Math.abs(p.x), Math.abs(p.z)))));
        return nearest;
      };
      const hung = long();
      return { arm, long, out, near, hung, rested: out(), longest: hung, farthest: out(), nearest: near() };
    });
    // Both arms are watched through the same stretch of time, in which each has its turn: the two take their turns about twenty seconds apart.
    let frame = 0;
    await run(48, () => {
      frame++;
      for (const w of watched) {
        const reach = w.long();
        w.longest = Math.max(w.longest, reach);
        w.farthest = Math.max(w.farthest, w.out());
        // Where the hand is is measured every frame it is stretched or drawing back, and while it hangs a few times a second: all of its skin, every frame, is what takes the time.
        if (reach > w.hung + 0.05 || w.arm.drawn > 0 || frame % 15 === 0) w.nearest = Math.min(w.nearest, w.near());
      }
    });
    for (const { longest, hung, farthest, rested, nearest } of watched) {
      // It did stretch: its middle finger reached a good deal farther from the wrist than it hangs.
      expect(longest).toBeGreaterThan(hung + 0.2);
      // It drew back from the board as it did.
      expect(farthest).toBeGreaterThan(rested + 0.25);
      // So its fingers, stretched as far as they go, were still a fifth of a square short of the squares.
      expect(nearest).toBeGreaterThan(4.2);
    }
  });
});

describe('a crossing', () => {
  // Nothing on the board but the kings on their own squares, or with a queen in the middle of it.
  const BARE = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
  const QUEEN = '4k3/8/8/4Q3/8/8/8/4K3 w - - 0 1';
  // Along the fifth rank, from the h-file's side to the a-file's, the hand held as it is at rest.
  const from = new Vector3(3, 1.2, -0.5);
  const to = new Vector3(-3, 1.2, -0.5);
  // The same way a little lower, so that the fingers, which hang below the palm, come to the queen's
  // collar and not to the narrow neck under her coronet.
  const collarFrom = new Vector3(3, 1.1, -0.5);
  const collarTo = new Vector3(-3, 1.1, -0.5);
  const held: Posture = { focus: PALM_FOCUS, pitch: 0.3, loose: 0 };
  const at = new Vector3();
  const now: Posture = { focus: new Vector3(), pitch: 0, loose: 0 };

  /** Every moment of a crossing, as the path has it: where the hand is, how it is held and which way it heads. */
  function along(flight: Flight, hand: Hand, each: (at: Vector3, held: Posture, yaw: number) => void): void {
    for (let t = 0; t <= flight.seconds; t += flight.seconds / 60) {
      flight.clock = t;
      flight.now(at, now);
      each(at, now, hand.headingTo(at) + flight.askew);
    }
  }

  it('is straight where nothing stands in the way', () => {
    const { layer, stage } = setup(BARE);
    const flight = chart(stage.hands.w.right.hand, from, to, held, held, [], layer.standing(), 0.6, Easing.inOutSine);
    expect(flight.height).toBeLessThan(0.01);
  });

  it('rises over a piece that does, in one arc, and never has the hand in it', () => {
    const { layer, stage } = setup(QUEEN);
    const hand = stage.hands.w.right.hand;
    const stones = [...layer.standing()];
    // The straight way would take the hand through the queen.
    let through = -Infinity;
    for (let k = 0; k <= 1; k += 0.05) through = Math.max(through, sunk(hand, at.lerpVectors(collarFrom, collarTo, k), held, hand.headingTo(at), hand.pose, stones));
    expect(through).toBeGreaterThan(0.2);

    const flight = chart(hand, collarFrom, collarTo, held, held, [], stones, 0.6, Easing.inOutSine);
    expect(flight.height).toBeGreaterThan(heights.q - collarFrom.y);
    let deepest = -Infinity;
    let highest = -Infinity;
    let turns = 0;
    let rising = true;
    along(flight, hand, (at, held, yaw) => {
      deepest = Math.max(deepest, sunk(hand, at, held, yaw, hand.pose, stones));
      // Up, and then down: once it has begun to come down it does not go up again.
      if (at.y > highest + 1e-6) {
        if (!rising) turns++;
        highest = at.y;
      } else if (at.y < highest - 1e-6) rising = false;
    });
    expect(deepest).toBeLessThan(0);
    expect(turns).toBe(0);
  });

  it('passes above the other hand, where that is in the way', () => {
    const { layer, stage } = setup(BARE);
    const hand = stage.hands.w.right.hand;
    // Something the size of a fist, in the air half way across.
    const fist = [0, 1.5, -0.5, 0.35];
    const flight = chart(hand, from, to, held, held, [], layer.standing(), 0.6, Easing.inOutSine, undefined, fist);
    expect(flight.height).toBeGreaterThan(0.5);
    let nearest = Infinity;
    along(flight, hand, (at, held, yaw) => {
      const shape = ballsOf(hand, at, held, yaw, hand.pose);
      for (let b = 0; b < shape.length; b += 4) nearest = Math.min(nearest, Math.hypot(shape[b]! - fist[0]!, shape[b + 1]! - fist[1]!, shape[b + 2]! - fist[2]!) - shape[b + 3]! - fist[3]!);
    });
    expect(nearest).toBeGreaterThan(0.05);
  });

  it('keeps the heading it set off with until it is clear, and then turns to the way an arm reaches out', () => {
    const { layer, stage } = setup(BARE);
    const hand = stage.hands.w.right.hand;
    const flight = chart(hand, from, to, held, held, [], layer.standing(), 0.6, Easing.inOutSine, undefined, undefined, hand.headingTo(from) + 0.4);
    const askew: number[] = [];
    along(flight, hand, () => askew.push(flight.askew));
    expect(askew[0]).toBeCloseTo(0.4, 5);
    expect(askew[3]).toBeCloseTo(0.4, 2);
    expect(askew[askew.length - 1]).toBeCloseTo(0, 5);
    for (let i = 1; i < askew.length; i++) expect(askew[i]!).toBeLessThanOrEqual(askew[i - 1]! + 1e-9);
  });

  it('straightens a hand that lay askew where it rested early on, and lays one that is going to rest askew late', () => {
    const { layer, stage } = setup(BARE);
    const hand = stage.hands.w.right.hand;
    const rested: Posture = { ...held, askew: 0.7 };
    // From where it rested to its work: it sets off turned as it lay, and its forearm with it.
    const out = chart(hand, from, to, rested, held, [], layer.standing(), 0.6, Easing.inOutSine, undefined, undefined, hand.headingTo(from) + 0.7);
    const leaving: number[] = [];
    const swung: number[] = [];
    along(out, hand, () => {
      leaving.push(out.askew);
      swung.push(out.swung);
    });
    expect(leaving[0]).toBeCloseTo(0.7, 5);
    expect(swung[0]).toBeCloseTo(0.7, 5);
    for (let i = 1; i < leaving.length; i++) expect(leaving[i]!).toBeLessThanOrEqual(leaving[i - 1]! + 1e-9);
    // It is straight with a third of the time still to go: it does not turn as it comes down among the pieces.
    expect(leaving[40]).toBeCloseTo(0, 6);
    expect(swung[40]).toBeCloseTo(0, 6);

    // From its work to where it rests: not until it is clear of what it has let go of, and lying as it will lie by the time it is there.
    const home = chart(hand, to, from, held, rested, [], layer.standing(), 0.6, Easing.inOutSine);
    const coming: number[] = [];
    along(home, hand, () => coming.push(home.askew));
    expect(coming[0]).toBeCloseTo(0, 5);
    expect(coming[3]).toBeCloseTo(0, 2);
    expect(coming[coming.length - 1]).toBeCloseTo(0.7, 5);
    expect(home.swung).toBeCloseTo(0.7, 5);
    for (let i = 1; i < coming.length; i++) expect(coming[i]!).toBeGreaterThanOrEqual(coming[i - 1]! - 1e-9);

    // From rest to rest it stays as it lies.
    const stay = chart(hand, from, to, rested, rested, [], layer.standing(), 0.6, Easing.inOutSine, undefined, undefined, hand.headingTo(from) + 0.7);
    along(stay, hand, () => {
      expect(stay.askew).toBeCloseTo(0.7, 5);
      expect(stay.swung).toBeCloseTo(0.7, 5);
    });
  });

  it('comes straight down the last of its way onto what it is coming for', () => {
    const { layer, stage } = setup(QUEEN);
    const hand = stage.hands.w.right.hand;
    const queen = layer.puppetAt('e5')!.group.position;
    const onto = new Vector3(queen.x, heights.q * 0.7, queen.z);
    const flight = chart(hand, from, onto, held, held, [], layer.standing(), 0.6, Easing.inOutSine);
    // Once it is over where it is going it stays over it, and only comes down: it does not slide in sideways.
    let over = 0;
    let high = 0;
    let last = Infinity;
    along(flight, hand, (at) => {
      if (Math.hypot(at.x - onto.x, at.z - onto.z) > 1e-6) {
        expect(over).toBe(0);
        return;
      }
      if (!over++) high = at.y - onto.y;
      expect(at.y).toBeLessThanOrEqual(last + 1e-9);
      last = at.y;
    });
    // And it is over it while it is still well above it, with time to come down in.
    expect(high).toBeGreaterThan(0.2);
    expect(over).toBeGreaterThan(5);
  });

  it('can be asked about a stone where it will stand, not where it is', () => {
    const { layer, stage } = setup(QUEEN);
    const hand = stage.hands.w.right.hand;
    const queen = layer.puppetAt('e5')!;
    const inIt = new Vector3(0.5, collarFrom.y, -0.5);
    expect(sunk(hand, inIt, held, hand.headingTo(inIt), hand.pose, [queen])).toBeGreaterThan(0.2);
    expect(sunk(hand, inIt, held, hand.headingTo(inIt), hand.pose, [queen], { puppet: queen, by: new Vector3(-3, 0, 0) })).toBeLessThan(0);
  });
});

describe('captures, castling and promotion', () => {
  it('lifts a taken piece away to the ledge, where its light goes out', async () => {
    const { layer, move } = setup();
    await move('e2', 'e4');
    await move('d7', 'd5');
    const victim = layer.objectAt('d5')!;
    const taker = layer.objectAt('e4')!;
    await move('e4', 'd5');
    expect(layer.objectAt('d5')).toBe(taker);
    expectStanding(layer, 'd5');
    expect(layer.count).toBe(31);
    // Still in the room, standing on the plinth beside the board.
    expect(layer.root.children).toContain(victim);
    expect(victim.position.y).toBeCloseTo(PLINTH_TOP, 5);
    expect(Math.abs(victim.position.x)).toBeGreaterThan(4.8);
    expect(layer.puppet(19)!.energy).toBeCloseTo(0, 5);
  });

  it('takes with the hand on the far side from what it takes, which waits off to its own side while the other clears the square', async () => {
    const { layer, stage, move } = setup();
    await move('e2', 'e4');
    await move('d7', 'd5');
    const taker = layer.puppetAt('e4')!;
    const victim = layer.puppetAt('d5')!;
    const { right, left } = stage.hands.w;
    const puppets = [...layer.standing()];
    const palm = { right: new Vector3(), left: new Vector3() };
    let waitedOff = Infinity;
    let apart = Infinity;
    let inHand = 0;
    let inStone = 0;
    let quiet = 0;
    const holders = new Set<string>();
    await move(
      'e4',
      'd5',
      undefined,
      () => {
        quiet = right.busy || left.busy ? 0 : quiet + DT;
        if (quiet > 1.2) return;
        if (right.held?.puppet === taker) holders.add('right has the taker');
        if (left.held?.puppet === victim) holders.add('left has the victim');
        if (left.held?.puppet === taker || right.held?.puppet === victim) holders.add('the wrong way round');
        right.hand.toWorld(PALM_FOCUS, palm.right);
        left.hand.toWorld(PALM_FOCUS, palm.left);
        // As the taken piece leaves its square, the hand that will take is not over its own piece
        // beside it, but drawn off to its own side.
        if (left.held?.attached && victim.group.position.y > 0.05 && victim.group.position.y < 0.3 && !right.held) {
          waitedOff = Math.min(waitedOff, Math.hypot(palm.right.x - taker.group.position.x, palm.right.z - taker.group.position.z));
        }
        // Ivory's right hand is on the side of the h-file, and stays on that side of the left.
        apart = Math.min(apart, palm.right.x - palm.left.x);
        for (const [arm, other] of [
          [right, left],
          [left, right],
        ] as const) {
          const deep = skinIn(arm, puppets, other);
          inHand = Math.max(inHand, deep.hand);
          inStone = Math.max(inStone, deep.stone);
        }
      },
      true,
    );
    expect([...holders].sort()).toEqual(['left has the victim', 'right has the taker']);
    expect(waitedOff).toBeGreaterThan(1.2);
    expect(waitedOff).toBeLessThan(4);
    expect(apart).toBeGreaterThan(0.5);
    expect(inHand).toBeLessThan(0.02);
    expect(inStone).toBeLessThan(0.02);
  });

  it('gives each taken piece its own place', async () => {
    const { layer, move } = setup('4k3/8/8/2ppp3/3P4/8/8/3QK3 w - - 0 1');
    const taken = [layer.objectAt('e5')!, layer.objectAt('d5')!];
    await move('d4', 'e5');
    await move('e8', 'e7');
    await move('d1', 'd5');
    expect(taken[0]!.position.distanceTo(taken[1]!.position)).toBeGreaterThan(0.4);
    for (const t of taken) expect(t.position.y).toBeCloseTo(PLINTH_TOP, 5);
  });

  it('stands every taken piece on the baize of an open drawer, clear of its walls and of every other', () => {
    // The widest any stone reaches from its plumb line at its foot (a king is never taken; the
    // knight's head reaches out further, but above the next stone's foot).
    const foot = Math.max(feet.p, feet.n, feet.b, feet.r, feet.q);
    const { stage } = setup();
    const claim = (captor: 'w' | 'b', right: boolean, id: number) => (stage as unknown as { claim(c: 'w' | 'b', r: boolean, id: number): Vector3 }).claim(captor, right, id);
    // Ivory takes all fifteen it can, by either hand in turn; Void twelve.
    const places: Vector3[] = [];
    for (let i = 0; i < 15; i++) places.push(claim('w', i % 2 === 0, 100 + i));
    for (let i = 0; i < 12; i++) places.push(claim('b', i % 2 === 0, 200 + i));
    for (const [i, p] of places.entries()) {
      expect(p.y).toBe(PLINTH_TOP);
      // Across the drawer: between the case's side and the drawer's front, with the drawer out.
      expect(Math.abs(p.x) - foot, `${i}`).toBeGreaterThan(SLAB_HALF);
      expect(Math.abs(p.x) + foot, `${i}`).toBeLessThan(DRAWER_OUT);
      // Along it: inside the drawer's two ends.
      expect(Math.abs(p.z) - foot, `${i}`).toBeGreaterThan(DRAWER_NEAR);
      expect(Math.abs(p.z) + foot, `${i}`).toBeLessThan(DRAWER_FAR);
      for (const q of places.slice(0, i)) expect(Math.hypot(p.x - q.x, p.z - q.z), `${i}`).toBeGreaterThan(2 * foot);
    }
    // Ivory's first fourteen are in the drawers of its own half, the lid; the fifteenth in Void's.
    expect(places.slice(0, 14).every((p) => p.z > 0)).toBe(true);
    expect(places[14]!.z).toBeLessThan(0);
    expect(places.slice(15).every((p) => p.z < 0)).toBe(true);
  });

  it('puts what a hand takes into a drawer of the taker\'s own half', async () => {
    const { layer, move } = setup();
    await move('e2', 'e4');
    await move('d7', 'd5');
    const victim = layer.objectAt('d5')!;
    await move('e4', 'd5');
    const at = victim.position;
    expect(Math.abs(Math.abs(at.x) - LEDGE_X)).toBeLessThan(0.2);
    // Ivory took it: it stands in a drawer of Ivory's half, the lid.
    expect(at.z).toBeGreaterThan(DRAWER_NEAR);
    expect(at.z).toBeLessThan(DRAWER_FAR);
  });

  it('takes en passant by removing the pawn that was passed', async () => {
    const { layer, move } = setup('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    const victim = layer.objectAt('d5')!;
    await move('e5', 'd6');
    expectStanding(layer, 'd6');
    expect(layer.objectAt('d5')).toBeNull();
    expect(victim.position.y).toBeCloseTo(PLINTH_TOP, 5);
  });

  const SHORT = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4';
  const LONG = 'r3kbnr/ppp1pppp/2nqb3/3p4/3P4/2NQB3/PPP1PPPP/R3KBNR w KQkq - 0 5';
  const CASTLES: [string, string, Square, Square, Square, Square][] = [
    ['short, as Ivory', SHORT, 'e1', 'g1', 'h1', 'f1'],
    ['long, as Ivory', LONG, 'e1', 'c1', 'a1', 'd1'],
    ['short, as Void', SHORT.replace(' w ', ' b '), 'e8', 'g8', 'h8', 'f8'],
    ['long, as Void', LONG.replace(' w ', ' b '), 'e8', 'c8', 'a8', 'd8'],
  ];

  /** Everything that is watched while a king and a rook change places, either way. */
  function watchCastle(stage: Stage, layer: PieceLayer, side: 'w' | 'b', kingOn: Square, rookOn: Square) {
    const king = layer.puppetAt(kingOn)!;
    const rook = layer.puppetAt(rookOn)!;
    const player = stage.hands[side];
    const arm = player.armFor(rook.group.position.x);
    const idle = player.other(arm);
    const puppets = [...layer.standing()];
    const seen = {
      /** How long the hand on the rook's side held each stone, and the first and last moment it did. */
      kingHeld: 0,
      rookHeld: 0,
      kingFrom: Infinity,
      kingTo: 0,
      rookFrom: Infinity,
      rookTo: 0,
      /** How long the player's other hand held anything at all. */
      otherHeld: 0,
      /** How high each piece's foot went, and how high the king's crown stands. */
      kingUp: 0,
      rookUp: 0,
      crown: 0,
      /** The least room there was between the two stones, and the deepest a hand was in the other or in a stone that was not its own. */
      room: Infinity,
      inHand: 0,
      inStone: 0,
      time: 0,
    };
    const each = () => {
      seen.time += DT;
      const holding = arm.held?.attached ? arm.held.puppet : null;
      if (holding === king) {
        seen.kingHeld += DT;
        seen.kingFrom = Math.min(seen.kingFrom, seen.time);
        seen.kingTo = seen.time;
      }
      if (holding === rook) {
        seen.rookHeld += DT;
        seen.rookFrom = Math.min(seen.rookFrom, seen.time);
        seen.rookTo = seen.time;
      }
      if (idle.held) seen.otherHeld += DT;
      seen.kingUp = Math.max(seen.kingUp, king.group.position.y);
      seen.rookUp = Math.max(seen.rookUp, rook.group.position.y);
      if (arm.held) seen.room = Math.min(seen.room, roomBetween(king, rook));
      for (const [a, other] of [
        [arm, idle],
        [idle, arm],
      ] as const) {
        const deep = skinIn(a, puppets, other);
        seen.inHand = Math.max(seen.inHand, deep.hand);
        seen.inStone = Math.max(seen.inStone, deep.stone);
      }
    };
    return { seen, each };
  }

  it.each(CASTLES)('castles %s with one hand, as the rules ask: the king first, then the rook over it, and nothing through anything', async (_name, fen, from, to, rookFrom, rookTo) => {
    const { layer, stage, run, move } = setup(fen);
    const side = fen.includes(' w ') ? 'w' : 'b';
    stage.setTurn(side);
    await run(1.5);
    const { seen, each } = watchCastle(stage, layer, side, from, rookFrom);
    await move(from, to, undefined, each, true);
    expectStanding(layer, to);
    expectStanding(layer, rookTo);
    expect(layer.kindAt(to)).toBe('k');
    expect(layer.kindAt(rookTo)).toBe('r');
    // The hand on the rook's side does it all; the other never takes hold of anything.
    expect(seen.kingHeld).toBeGreaterThan(0.3);
    expect(seen.rookHeld).toBeGreaterThan(0.3);
    expect(seen.otherHeld).toBe(0);
    // The king is let go of before the rook is touched.
    expect(seen.rookFrom).toBeGreaterThan(seen.kingTo);
    // The stones never meet; the hand is never in the other, nor in a stone but for a fingertip's touch.
    expect(seen.room).toBeGreaterThan(0.05);
    expect(seen.inHand).toBeLessThan(0.02);
    expect(seen.inStone).toBeLessThan(0.05);
  });

  it.each([CASTLES[1]!, CASTLES[2]!])('takes castling %s back with the one hand: the rook first, then the king', async (_name, fen, from, to, rookFrom, rookTo) => {
    const { layer, stage, run, move, undo } = setup(fen);
    const side = fen.includes(' w ') ? 'w' : 'b';
    stage.setTurn(side);
    await move(from, to);
    await run(1.5);
    const { seen, each } = watchCastle(stage, layer, side, to, rookTo);
    await undo(each);
    expectStanding(layer, from);
    expectStanding(layer, rookFrom);
    expect(layer.kindAt(from)).toBe('k');
    expect(layer.kindAt(rookFrom)).toBe('r');
    expect(seen.kingHeld).toBeGreaterThan(0.3);
    expect(seen.rookHeld).toBeGreaterThan(0.3);
    expect(seen.otherHeld).toBe(0);
    expect(seen.kingFrom).toBeGreaterThan(seen.rookTo);
    expect(seen.room).toBeGreaterThan(0.05);
    expect(seen.inHand).toBeLessThan(0.02);
    expect(seen.inStone).toBeLessThan(0.05);
  });

  it('promotes a pawn where it lands', async () => {
    const { layer, move } = setup('8/1P2k3/8/8/8/8/8/4K3 w - - 0 1');
    const pawn = layer.objectAt('b7')!;
    await move('b7', 'b8', 'q');
    expect(layer.objectAt('b8')).toBe(pawn);
    expect(layer.kindAt('b8')).toBe('q');
    expectStanding(layer, 'b8');
  });
});

describe('take-backs', () => {
  it('carries everything back, and brings a taken piece back from the ledge alight', async () => {
    const { layer, move, undo } = setup();
    await move('e2', 'e4');
    await move('d7', 'd5');
    const victim = layer.objectAt('d5')!;
    await move('e4', 'd5');
    await undo();
    expect(layer.count).toBe(32);
    expect(layer.objectAt('d5')).toBe(victim);
    expectStanding(layer, 'd5');
    expectStanding(layer, 'e4');
    expect(layer.puppet(19)!.energy).toBeCloseTo(1, 5);
    await undo();
    await undo();
    expectStanding(layer, 'e2');
    expectStanding(layer, 'd7');
  });

  it('brings a taken piece back with the hand that stood it aside, though it stands on the other half of the ledge', async () => {
    type Slots = { slots: { w: Map<number, { ledge: 1 | -1; index: number }> } };
    const fen = 'k7/8/8/8/8/8/p7/R6K w - - 0 1';
    // Which half of the ledge this capture uses when there is room on it.
    const roomy = setup(fen);
    await roomy.move('a1', 'a2');
    const own = [...(roomy.stage as unknown as Slots).slots.w.values()][0]!.ledge;

    // That half is full, as it is once one hand has taken eight pieces: the ninth goes to the
    // other half, which is on the side of the hand that carries the mover.
    const { layer, stage, move, undo } = setup(fen);
    const slots = (stage as unknown as Slots).slots.w;
    for (let i = 0; i < 8; i++) slots.set(1000 + i, { ledge: own, index: i });
    const rook = layer.objectAt('a1')!;
    const pawn = layer.objectAt('a2')!;
    await move('a1', 'a2');
    expect([...slots.entries()].find(([id]) => id < 1000)![1].ledge).toBe(-own);

    const last = { rook: rook.position.clone(), pawn: pawn.position.clone() };
    const jump = { rook: 0, pawn: 0 };
    const held = { rook: new Set<string>(), pawn: new Set<string>() };
    await undo(() => {
      jump.rook = Math.max(jump.rook, rook.position.distanceTo(last.rook));
      jump.pawn = Math.max(jump.pawn, pawn.position.distanceTo(last.pawn));
      last.rook.copy(rook.position);
      last.pawn.copy(pawn.position);
      for (const [name, arm] of [['right', stage.hands.w.right], ['left', stage.hands.w.left]] as const) {
        if (arm.held?.puppet.group === rook) held.rook.add(name);
        if (arm.held?.puppet.group === pawn) held.pawn.add(name);
      }
    });
    // Each stone is carried by one hand, and not the same one; neither is anywhere it was not a frame before.
    expect([...held.rook]).toHaveLength(1);
    expect([...held.pawn]).toHaveLength(1);
    expect([...held.pawn][0]).not.toBe([...held.rook][0]);
    expect(jump.rook).toBeLessThan(0.5);
    expect(jump.pawn).toBeLessThan(0.5);
    expectStanding(layer, 'a1');
    expectStanding(layer, 'a2');
  });

  it('undoes castling and promotion', async () => {
    const castle = setup('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    await castle.move('e1', 'c1');
    await castle.undo();
    expectStanding(castle.layer, 'e1');
    expectStanding(castle.layer, 'a1');

    const promote = setup('8/1P2k3/8/8/8/8/8/4K3 w - - 0 1');
    await promote.move('b7', 'b8', 'n');
    await promote.undo();
    expect(promote.layer.kindAt('b7')).toBe('p');
    expectStanding(promote.layer, 'b7');
  });
});

describe('thought and interruption', () => {
  it('hovers over the piece a player is considering, with threads, and thins to glass', async () => {
    const { stage, layer, run } = setup();
    const arm = stage.hands.w.right;
    const solidAtRest = arm.hand.fill;
    stage.consider('w', 'g1');
    await run(0.8);
    const knight = layer.objectAt('g1')!.position;
    const palm = arm.hand.toWorld(new Vector3(0, -0.5, -1.6));
    expect(Math.hypot(palm.x - knight.x, palm.z - knight.z)).toBeLessThan(1.2);
    expect(palm.y).toBeGreaterThan(1.2);
    expect(arm.threading).toBeGreaterThan(0.8);
    expect(arm.hand.fill).toBeLessThan(solidAtRest * 0.7);
    // Thinking about something else sends it there; thinking of nothing sends it home.
    stage.consider('w', null);
    await run(1.5);
    expect(arm.threading).toBeLessThan(0.05);
    expect(arm.hand.fill).toBeGreaterThan(solidAtRest * 0.9);
  });

  it('does not let the other player\'s hands think about a piece that is not theirs', async () => {
    const { stage, run } = setup();
    stage.consider('b', 'e2');
    await run(0.5);
    expect(stage.hands.b.right.considering).toBeNull();
    expect(stage.hands.b.left.considering).toBeNull();
  });

  it('gives up a move when the game is reset under it', async () => {
    const { game, layer, stage, run } = setup();
    void stage.playMove(game.move('e2', 'e4'));
    await run(0.9);
    game.load();
    layer.reset(game.pieces());
    stage.reset();
    await run(4);
    for (const square of ['e2', 'd2', 'e7', 'g1'] as Square[]) expectStanding(layer, square);
    expect(layer.objectAt('e4')).toBeNull();
    expect(stage.hands.w.right.busy || stage.hands.w.left.busy).toBe(false);
  });
});

describe('a new game set up while a pawn is changing', () => {
  it('leaves every stone of the new position as what it is', async () => {
    const { game, tweens, layer, stage, run } = setup('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    const e = game.move('a7', 'a8', 'q');
    void stage.playMove(e);
    // Until the pawn stands on a8 and has begun to draw in, just before it becomes the queen.
    for (let i = 0; i < 600; i++) {
      await run(DT);
      const p = layer.puppetAt('a8');
      if (p && p.id === e.piece.id && p.kind === 'p' && p.group.scale.x < 0.999) break;
    }
    expect(layer.puppetAt('a8')).toMatchObject({ kind: 'p' });
    expect(layer.puppetAt('a8')!.group.scale.x).toBeLessThan(0.999);

    // What the game does for a new one: everything in motion is finished, and the board laid out again.
    const fresh = new Game();
    tweens.finishAll();
    layer.reset(fresh.pieces());
    stage.reset();
    await run(1.5);
    // The stones are numbered afresh; the one that has the pawn's old number is not turned into a queen.
    for (const piece of fresh.pieces()) expect(layer.puppetAt(piece.square), piece.square).toMatchObject({ kind: piece.kind, side: piece.side });
  });
});
