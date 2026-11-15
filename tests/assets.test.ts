/**
 * Checks the files the Blender scripts write into public/assets against what
 * the engine expects of them, so a change to a script that breaks the
 * contract fails here and not as a blank screen.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CaseMeta, checkCaseMeta, checkPieceMeta, checkRoomMeta } from '../src/scene/assets.ts';

const ASSETS = path.resolve(import.meta.dirname, '../public/assets');

interface Accessor {
  count: number;
  componentType?: number;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}
interface Gltf {
  nodes: { name: string; mesh?: number; extras?: { meta?: string }; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes: { name: string; primitives: { attributes: Record<string, number>; indices: number; material?: number }[] }[];
  accessors: Accessor[];
  materials?: unknown[];
  images?: unknown[];
}

/** Read the JSON chunk of a binary glTF file. */
function readGlb(file: string): Gltf {
  const bytes = readFileSync(path.join(ASSETS, file));
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
  expect(bytes.readUInt32LE(4)).toBe(2);
  const length = bytes.readUInt32LE(12);
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a); // "JSON"
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as Gltf;
}

function node(gltf: Gltf, name: string) {
  const n = gltf.nodes.find((x) => x.name === name);
  if (!n || n.mesh === undefined) throw new Error(`no mesh node called ${name}`);
  const primitives = gltf.meshes[n.mesh]!.primitives;
  expect(primitives).toHaveLength(1);
  const primitive = primitives[0]!;
  return {
    node: n,
    primitive,
    position: bounds(gltf.accessors[primitive.attributes.POSITION!]!, n),
    triangles: gltf.accessors[primitive.indices]!.count / 3,
    meta: <T>() => JSON.parse(n.extras?.meta ?? 'null') as T,
  };
}

/** Whether a position accessor holds 16-bit fractions of its mesh's extent (KHR_mesh_quantization), which its node scales back. */
const quantized = (a: Accessor): boolean => a.componentType === 5122 && a.normalized === true;

/** A position accessor's bounds in room space: as stored, or brought back through the node's uniform scale and translation if quantized. */
function bounds(a: Accessor, n: Gltf['nodes'][number]): Accessor {
  if (!quantized(a)) return a;
  const k = n.scale?.[0] ?? 1;
  const t = n.translation ?? [0, 0, 0];
  const back = (v: number[] | undefined) => v?.map((x, i) => (x / 32767) * k + t[i]!);
  return { ...a, min: back(a.min), max: back(a.max) };
}

/** What the engine needs on every mesh: two UV sets, normals, and the data channel. */
function expectEngineAttributes(gltf: Gltf, name: string) {
  const { node: n, primitive } = node(gltf, name);
  for (const attribute of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0']) {
    expect(primitive.attributes[attribute], `${name} ${attribute}`).toBeTypeOf('number');
  }
  // Geometry only: materials are built in the engine, and nothing is moved by its node, except
  // that a quantized mesh's node carries the uniform scale and the translation that bring its
  // positions back (the engine applies them as it loads, assets.ts).
  expect(primitive.material).toBeUndefined();
  expect(n.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
  if (quantized(gltf.accessors[primitive.attributes.POSITION!]!)) {
    const [a, b, c] = n.scale ?? [1, 1, 1];
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(a);
    expect(c).toBe(a);
  } else {
    expect(n.translation ?? [0, 0, 0]).toEqual([0, 0, 0]);
    expect(n.scale ?? [1, 1, 1]).toEqual([1, 1, 1]);
  }
}

// Style bible, section 5: the king is 1.7 squares tall and the rest step down from it.
const HEIGHT = { p: 0.86, r: 1.08, n: 1.26, b: 1.39, q: 1.565, k: 1.7 } as const;

describe('pieces.glb', () => {
  const gltf = readGlb('pieces.glb');

  it('carries no materials or images', () => {
    expect(gltf.materials ?? []).toHaveLength(0);
    expect(gltf.images ?? []).toHaveLength(0);
  });

  for (const [kind, height] of Object.entries(HEIGHT)) {
    it(`has a ${kind} that stands on the board at the bible's height`, () => {
      const name = `piece_${kind}`;
      expectEngineAttributes(gltf, name);
      const piece = node(gltf, name);
      expect(piece.position.min![1]).toBeCloseTo(0, 4);
      expect(piece.position.max![1]).toBeCloseTo(height, 3);
      // Centred on its square and narrower than it.
      for (const axis of [0, 2]) {
        expect(piece.position.min![axis]).toBeGreaterThan(-0.42);
        expect(piece.position.max![axis]).toBeLessThan(0.42);
      }
      expect(piece.triangles).toBeLessThan(4000);

      const meta = piece.meta<{
        kind: string;
        height: number;
        modules: { name: string; pivot: number[] }[];
        eye: number[];
        grip: { type: string; y: number; half: number };
      }>();
      expect(meta.kind).toBe(kind);
      expect(meta.height).toBeCloseTo(height, 3);
      // A piece breathes and comes apart along its blocks: at least two, bottom to top, eight at most.
      expect(meta.modules.length).toBeGreaterThanOrEqual(2);
      expect(meta.modules.length).toBeLessThanOrEqual(8);
      const pivots = meta.modules.map((m) => m.pivot[1]!);
      expect([...pivots].sort((a, b) => a - b)).toEqual(pivots);
      expect(meta.eye).toHaveLength(3);
      expect(meta.eye[1]).toBeGreaterThan(0);
      expect(meta.eye[1]).toBeLessThan(height);
      expect(['pinch', 'wrap', 'hook', 'tripod']).toContain(meta.grip.type);
      expect(meta.grip.y).toBeGreaterThan(0);
      expect(meta.grip.y).toBeLessThan(height);
      expect(meta.grip.half).toBeGreaterThan(0.05);
      expect(meta.grip.half).toBeLessThan(0.4);
    });
  }
});

describe('board.glb', () => {
  const gltf = readGlb('board.glb');

  const halves = ['void', 'lid'] as const;
  const drawers = ['drawer_void_w', 'drawer_void_e', 'drawer_lid_w', 'drawer_lid_e'];

  it('has both halves of the case, its four drawers and its clasp, with the playing surface at zero', () => {
    for (const half of halves) {
      for (const part of ['frame', 'tiles_light', 'tiles_dark', 'inlay']) expectEngineAttributes(gltf, `${half}_${part}`);
    }
    for (const name of [...drawers, 'clasp']) expectEngineAttributes(gltf, name);
    for (const half of halves) {
      for (const name of [`${half}_tiles_light`, `${half}_tiles_dark`]) {
        const tiles = node(gltf, name);
        expect(tiles.position.max![1]).toBeCloseTo(0, 4);
        expect(tiles.position.min![0]).toBeGreaterThan(-4.01);
        expect(tiles.position.max![0]).toBeLessThan(4.01);
        // Ivory's squares are on the lid, on the far side of the hinge from Void's.
        if (half === 'lid') expect(tiles.position.min![2]).toBeGreaterThan(-0.01);
        else expect(tiles.position.max![2]).toBeLessThan(0.01);
      }
      // Nothing set into the board stands proud of the squares, or of the rim its letters are cut in, by more than the engraving.
      expect(node(gltf, `${half}_inlay`).position.max![1]).toBeLessThan(0.11);
    }
  });

  it('stands the case where the room and the hands expect it, and says so in its metadata', () => {
    const meta = node(gltf, 'void_frame').meta<CaseMeta>();
    expect(() => checkCaseMeta(meta)).not.toThrow();
    expect(meta.half).toBeCloseTo(4.8, 3);
    expect(meta.rimTop).toBeCloseTo(0.1, 3);
    expect(meta.bottom).toBeCloseTo(-1, 3);
    expect(meta.hinge).toEqual({ y: 0.1, z: 0 });
    for (const half of halves) {
      const frame = node(gltf, `${half}_frame`).position;
      // The rim is the top of the case and the foot its underside: nothing climbs over them but the
      // knuckles of the hinge, whose pin runs along the rim, and nothing hangs under the foot.
      expect(frame.max![1]).toBeLessThan(meta.hinge.y + 0.08);
      expect(frame.min![1]).toBeGreaterThan(meta.bottom - 0.001);
      // Only the brass hardware stands out past the walnut, and only by a little: the studs of the
      // shields on the corners, and the mount of the clasp.
      for (const axis of [0, 2]) {
        expect(Math.max(-frame.min![axis]!, frame.max![axis]!), `${half} ${axis}`).toBeLessThan(meta.half + 0.09);
      }
    }
    for (const name of drawers) {
      const drawer = node(gltf, name).position;
      // Each drawer is shut, inside its half but for its pull, and on the side of the hinge its name says.
      expect(Math.max(-drawer.min![0]!, drawer.max![0]!), name).toBeLessThan(meta.half + 0.1);
      // It is long enough that, out, its back comes to the case's side, and no longer.
      expect(Math.min(Math.abs(drawer.min![0]!), Math.abs(drawer.max![0]!)), name).toBeGreaterThan(meta.half - meta.drawer.travel - 0.1);
      expect(drawer.min![1]).toBeGreaterThan(meta.bottom);
      expect(drawer.max![1]).toBeLessThan(0);
      if (name.includes('_lid_')) expect(drawer.min![2]).toBeGreaterThan(0);
      else expect(drawer.max![2]).toBeLessThan(0);
      if (name.endsWith('_e')) expect(drawer.min![0]).toBeGreaterThan(0);
      else expect(drawer.max![0]).toBeLessThan(0);
    }
    // The stones stand on a floor that is under the rim and the field and above the foot.
    expect(meta.drawer.floor).toBeLessThan(0);
    expect(meta.drawer.floor).toBeGreaterThan(meta.bottom);
    const [x0, x1, z0, z1] = meta.drawer.inside;
    expect(x0).toBeGreaterThanOrEqual(meta.field);
    expect(x1).toBeLessThanOrEqual(meta.half + meta.drawer.travel);
    expect(z1).toBeLessThan(meta.half);
    expect(z0).toBeGreaterThan(0);
  });
});

describe('room.glb', () => {
  const gltf = readGlb('room.glb');

  it('has the altar, floor, shell, timber, metal, candles and everything that glows', () => {
    for (const name of ['plinth', 'floor', 'shell', 'shell_far', 'timber', 'metal', 'candles', 'glow']) expectEngineAttributes(gltf, name);
  });

  it('keeps the file small and the mirror\'s copy of the shell far lighter than the shell', () => {
    expect(statSync(path.join(ASSETS, 'room.glb')).size).toBeLessThan(4.2e6);
    expect(node(gltf, 'shell_far').triangles).toBeLessThan(node(gltf, 'shell').triangles / 5);
  });

  it('stands the altar where the case and the hands expect it', () => {
    const shell = node(gltf, 'shell').meta<{ floorY: number; plinthTop: number; altar: { top: number; mensa: number; body: number; steps: number[][] } }>();
    const plinth = node(gltf, 'plinth').position;
    // Its top is where the case stands, and reaches past the case's foot and the hands' rest.
    expect(shell.plinthTop).toBeCloseTo(-1.0, 6);
    expect(shell.altar.top).toBeCloseTo(-1.0, 6);
    expect(plinth.max![1]).toBeLessThanOrEqual(-1.0 + 5e-4);
    expect(plinth.min![1]).toBeGreaterThanOrEqual(shell.floorY - 5e-4);
    expect(shell.altar.mensa).toBeGreaterThanOrEqual(6.2);
    expect(shell.altar.body).toBeLessThan(shell.altar.mensa);
    // Nothing of it reaches farther out than 7.6.
    for (const i of [0, 2]) {
      expect(plinth.max![i]).toBeLessThanOrEqual(7.6 + 5e-4);
      expect(plinth.min![i]).toBeGreaterThanOrEqual(-7.6 - 5e-4);
    }
    for (const [half, top] of shell.altar.steps) {
      expect(half).toBeLessThanOrEqual(7.6);
      expect(top).toBeLessThan(shell.altar.top);
    }
  });

  it('hangs the lanterns out of the cameras\' way', () => {
    const shell = node(gltf, 'shell').meta<{ wall: number; ceiling: number; lanterns: number[][]; lantern: { radius: number; half: number } }>();
    // One on each pier between the middle of a wall and its corners.
    expect(shell.lanterns).toHaveLength(24);
    for (const [x, y, z] of shell.lanterns as [number, number, number][]) {
      expect(Math.max(Math.abs(x), Math.abs(z)) - shell.lantern.radius).toBeGreaterThan(20.7);
      expect(Math.max(Math.abs(x), Math.abs(z))).toBeLessThan(shell.wall);
      expect(y - shell.lantern.half).toBeGreaterThan(0.6);
      expect(y + shell.lantern.half).toBeLessThan(shell.ceiling);
    }
  });

  it('describes the room the engine lights', () => {
    const shell = node(gltf, 'shell').meta<{
      floorY: number;
      wall: number;
      ceiling: number;
      oculusHalf: number;
      plinthTop: number;
      keyHeight: number;
      bay: number;
      ring: { y: number; outer: number; inner: number };
      disc: { y: number; radius: number };
      cross: { head: number; foot: number; half: number; armY: number; arm: number; armAt: number; armHalf: number; armSill: number; armHead: number };
      door: { half: number; head: number };
      window: { half: number; sill: number; head: number; roundel: number; roundelRadius: number };
      gains: Record<string, number>;
      keyUnit: number;
      beam: number;
      slotGlow: number;
    }>();
    expect(shell.floorY).toBeLessThan(0);
    expect(shell.wall).toBeGreaterThan(10);
    expect(shell.ceiling).toBeGreaterThan(10);
    expect(shell.oculusHalf).toBeGreaterThan(1);
    expect(node(gltf, 'floor').position.max![1]).toBeCloseTo(shell.floorY, 3);
    // The altar stands between the floor and the board, and the key hangs above the ceiling.
    expect(shell.plinthTop).toBeGreaterThan(shell.floorY);
    expect(shell.plinthTop).toBeLessThan(0);
    expect(node(gltf, 'plinth').position.max![1]).toBeLessThan(0);
    expect(shell.keyHeight).toBeGreaterThan(shell.ceiling);
    // The walls are an even number of bays long, with the reliefs and the cross inside them.
    expect((shell.wall * 2) / shell.bay).toBeCloseTo(Math.round((shell.wall * 2) / shell.bay), 6);
    expect(shell.ring.inner).toBeLessThan(shell.ring.outer);
    expect(shell.ring.y + shell.ring.outer).toBeLessThan(shell.ceiling);
    expect(shell.disc.y + shell.disc.radius).toBeLessThan(shell.ceiling);
    expect(shell.cross.head).toBeLessThan(shell.ceiling);
    expect(shell.cross.armY).toBeLessThan(shell.cross.head);
    expect(shell.cross.foot).toBeLessThan(shell.cross.armSill);
    expect(shell.cross.armSill).toBeLessThan(shell.cross.armHead);
    expect(shell.cross.armAt + shell.cross.armHalf).toBeCloseTo(shell.cross.arm, 6);
    // The doorway under the cross, and the windows over the niches, stand inside the wall.
    expect(shell.door.head).toBeLessThan(shell.cross.foot);
    expect(shell.window.sill).toBeLessThan(shell.window.head);
    expect(shell.window.roundel + shell.window.roundelRadius).toBeLessThan(shell.ceiling);
    expect(shell.window.half * 2).toBeLessThan(shell.bay);
    // Every kind of baked light says what it was stored at.
    for (const kind of ['candles', 'sky', 'key', 'ring', 'disc', 'slot']) expect(shell.gains[kind], kind).toBeGreaterThan(0);
    expect(shell.keyUnit).toBeGreaterThan(0);
    expect(shell.slotGlow).toBeGreaterThan(0);
    // What comes through the oculus covers the squares and falls on the slab, no wider.
    expect(shell.beam).toBeGreaterThan(4);
    expect(shell.beam).toBeLessThan(5);

    const candles = node(gltf, 'candles').meta<{
      flames: number[][];
      plinthFlames: number;
      niches: { wall: string; along: number }[];
      niche: { width: number; height: number; depth: number; floor: number };
    }>();
    // Three candles at each corner of the board, and three in each of six niches a wall.
    expect(candles.plinthFlames).toBe(12);
    expect(candles.flames).toHaveLength(candles.plinthFlames + candles.niches.length * 3);
    expect(candles.niches).toHaveLength(24);
    for (const n of candles.niches) expect('nsew').toContain(n.wall);
    // The corner candles stand clear of the case's drawers and low enough for a hand to pass over.
    for (const [x, y, z] of candles.flames.slice(0, candles.plinthFlames) as [number, number, number][]) {
      expect(Math.min(Math.abs(x), Math.abs(z))).toBeGreaterThan(5.2);
      expect(y).toBeLessThan(0.6);
    }
    // Every niche candle stands inside its niche, behind the wall face.
    for (const [x, y, z] of candles.flames.slice(candles.plinthFlames) as [number, number, number][]) {
      const reach = Math.max(Math.abs(x), Math.abs(z));
      expect(reach).toBeGreaterThan(shell.wall);
      expect(reach).toBeLessThan(shell.wall + candles.niche.depth);
      expect(y).toBeGreaterThan(candles.niche.floor);
      expect(y).toBeLessThan(candles.niche.floor + candles.niche.height);
    }
  });
});

describe('textures', () => {
  it('has every surface set, both occlusion atlases and the room\'s baked light', () => {
    for (const surface of ['limestone', 'basalt', 'brass', 'limestone_honed', 'sandstone', 'flagstone', 'oak']) {
      for (const map of ['albedo', 'normal', 'orm']) {
        expect(existsSync(path.join(ASSETS, 'tex', `${surface}_${map}.jpg`)), `${surface}_${map}`).toBe(true);
      }
    }
    expect(existsSync(path.join(ASSETS, 'tex', 'pieces_ao.jpg'))).toBe(true);
    expect(existsSync(path.join(ASSETS, 'tex', 'room_ao.jpg'))).toBe(true);
    expect(existsSync(path.join(ASSETS, 'tex', 'room_light.jpg'))).toBe(true);
  });

  it('has the case\'s marble, walnut and baize, and its occlusion atlas', () => {
    for (const surface of ['marble_light', 'marble_dark', 'walnut', 'baize']) {
      for (const map of ['albedo', 'normal', 'orm']) {
        expect(existsSync(path.join(ASSETS, 'tex', `${surface}_${map}.jpg`)), `${surface}_${map}`).toBe(true);
      }
    }
    expect(existsSync(path.join(ASSETS, 'tex', 'case_ao.jpg'))).toBe(true);
  });
});

describe('what the engine reads from the files, checked as it loads them', () => {
  const room = readGlb('room.glb');
  const shell = () => node(room, 'shell').meta<Record<string, unknown>>();
  const candles = () => node(room, 'candles').meta<Record<string, unknown>>();
  const piece = (kind: string) => node(readGlb('pieces.glb'), `piece_${kind}`).meta<Record<string, unknown>>();
  /** A copy of some metadata with one thing in it changed. `at` is a path: 'ring.y', 'modules.0.pivot'. */
  function without<T extends Record<string, unknown>>(meta: T, at: string, value?: unknown): T {
    const copy = structuredClone(meta);
    const keys = at.split('.');
    let inside = copy as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) inside = inside[key] as Record<string, unknown>;
    if (value === undefined) delete inside[keys.at(-1)!];
    else inside[keys.at(-1)!] = value;
    return copy;
  }

  it('passes the room and the pieces as they are built', () => {
    expect(() => checkRoomMeta(shell(), candles())).not.toThrow();
    for (const kind of Object.keys(HEIGHT)) expect(() => checkPieceMeta(piece(kind), kind), kind).not.toThrow();
  });

  it('refuses a room that does not say something the light or a shader is worked out from', () => {
    const numbers = ['floorY', 'wall', 'ceiling', 'oculusHalf', 'plinthTop', 'keyHeight', 'bay', 'keyUnit', 'beam', 'slotGlow'];
    const inside = ['ring.y', 'ring.outer', 'ring.inner', 'disc.y', 'disc.radius', 'cross.head', 'cross.foot', 'cross.half', 'cross.armY', 'cross.arm',
      'cross.armAt', 'cross.armHalf', 'cross.armSill', 'cross.armHead', 'door.half', 'door.head', 'window.half', 'window.sill', 'window.head',
      'window.roundel', 'window.roundelRadius', 'altar.top', 'altar.mensa', 'altar.body', 'lantern.radius', 'lantern.half'];
    const gains = ['candles', 'sky', 'key', 'ring', 'disc', 'slot'].map((kind) => `gains.${kind}`);
    for (const at of [...numbers, ...inside, ...gains, 'ring', 'disc', 'cross', 'door', 'window', 'altar', 'lantern', 'lanterns', 'gains']) {
      expect(() => checkRoomMeta(without(shell(), at), candles()), at).toThrow(/shell/);
    }
    for (const at of ['niche', 'niche.width', 'niche.height', 'niche.depth', 'niche.floor', 'flames', 'plinthFlames', 'niches']) {
      expect(() => checkRoomMeta(shell(), without(candles(), at)), at).toThrow(/candles/);
    }
    // A room written by an older script altogether, or not a room.
    expect(() => checkRoomMeta({}, {})).toThrow();
    expect(() => checkRoomMeta(null, null)).toThrow();
  });

  it('refuses numbers the room cannot be: a size of nothing, a light stored at nothing, something that is not a number', () => {
    for (const at of ['wall', 'oculusHalf', 'keyHeight', 'bay', 'keyUnit', 'beam', 'slotGlow', 'gains.key', 'gains.slot']) {
      expect(() => checkRoomMeta(without(shell(), at, 0), candles()), at).toThrow();
    }
    expect(() => checkRoomMeta(without(shell(), 'keyHeight', 'tall'), candles())).toThrow();
    expect(() => checkRoomMeta(without(shell(), 'cross.head', null), candles())).toThrow();
    expect(() => checkRoomMeta(without(shell(), 'ceiling', -100), candles())).toThrow(/ceiling/);
    expect(() => checkRoomMeta(shell(), without(candles(), 'plinthFlames', 9999))).toThrow();
    expect(() => checkRoomMeta(shell(), without(candles(), 'flames', [[0, 1]]))).toThrow();
    expect(() => checkRoomMeta(shell(), without(candles(), 'niches', [{ wall: 'up', along: 0 }]))).toThrow();
  });

  it('refuses a piece that does not say how it is built, where it looks from or how it is held', () => {
    for (const at of ['height', 'modules', 'eye', 'grip', 'grip.type', 'grip.y', 'grip.half', 'modules.0.pivot']) {
      expect(() => checkPieceMeta(without(piece('n'), at), 'n'), at).toThrow(/piece_n/);
    }
    expect(() => checkPieceMeta(without(piece('n'), 'modules', []), 'n')).toThrow();
    expect(() => checkPieceMeta(without(piece('n'), 'head', 99), 'n')).toThrow(/head/);
    expect(() => checkPieceMeta(without(piece('n'), 'grip.type', 'fist'), 'n')).toThrow();
    expect(() => checkPieceMeta(without(piece('n'), 'grip.half', 0), 'n')).toThrow();
    // The line a head turns about has to be a direction.
    expect(() => checkPieceMeta(without(piece('n'), 'modules.0.axis', [0, 0, 0]), 'n')).toThrow(/line/);
    expect(() => checkPieceMeta({}, 'k')).toThrow();
  });

  it('refuses a case that does not say how big it is, where it hinges, how its drawers open or how its clasp turns', () => {
    const board = () => node(readGlb('board.glb'), 'void_frame').meta<Record<string, unknown>>();
    expect(() => checkCaseMeta(board())).not.toThrow();
    const numbers = ['half', 'rimTop', 'bottom', 'field', 'face', 'hinge.y', 'hinge.z', 'drawer.travel', 'drawer.floor', 'drawer.wall'];
    for (const at of [...numbers, 'hinge', 'drawer', 'drawer.inside', 'clasp', 'clasp.pivot', 'clasp.shut']) {
      expect(() => checkCaseMeta(without(board(), at)), at).toThrow(/void_frame/);
    }
    // A field as wide as the case, a rim under the foot, drawers that do not open, a drawer inside out.
    expect(() => checkCaseMeta(without(board(), 'field', 5))).toThrow(/field/);
    expect(() => checkCaseMeta(without(board(), 'rimTop', -2))).toThrow(/rim/);
    expect(() => checkCaseMeta(without(board(), 'drawer.travel', 0))).toThrow(/open/);
    expect(() => checkCaseMeta(without(board(), 'drawer.inside', [5, 4, 0.2, 4.4]))).toThrow(/drawers/);
    expect(() => checkCaseMeta(without(board(), 'clasp.pivot', [0]))).toThrow(/clasp/);
    expect(() => checkCaseMeta({})).toThrow();
    expect(() => checkCaseMeta(null)).toThrow();
  });
});
