/**
 * Loads what the Blender scripts in assets/src/ produce: geometry-only GLBs
 * and the texture sets. Materials are built in materials.ts, because they
 * need shader hooks that a stock glTF material cannot carry.
 *
 * Every mesh arrives with a vertex colour attribute that is data, not
 * colour (see assets/src/lib.py). It is renamed to `aData` here so the
 * renderer never mistakes it for a tint.
 */
import {
  BufferAttribute,
  type BufferGeometry,
  Matrix4,
  type Mesh,
  NoColorSpace,
  type Object3D,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Kind } from '../core/game';

export interface PieceMeta {
  kind: Kind;
  height: number;
  /**
   * Rigid blocks, bottom to top. A piece breathes, turns and comes apart along these. A block that
   * turns about something other than the plumb line (the knight's head, on its leaning neck) says so
   * with `axis`, a unit vector through its pivot.
   */
  modules: { name: string; pivot: [number, number, number]; axis?: [number, number, number] }[];
  /** The first block that turns when the piece looks about; it and everything above it is the head. */
  head?: number;
  /** Where the piece looks from. */
  eye: [number, number, number];
  /** How a hand takes hold of it. */
  grip: { type: 'pinch' | 'wrap' | 'hook' | 'tripod'; y: number; half: number; z?: number };
}

export type SurfaceName = 'limestone' | 'basalt' | 'brass' | 'limestone_honed' | 'pieces_bone' | 'pieces_ebony' | 'sandstone' | 'flagstone' | 'oak'
  | 'marble_light' | 'marble_dark' | 'walnut' | 'baize';

export interface Surface {
  albedo: Texture;
  normal: Texture;
  /** R unused (1), G roughness, B metalness. */
  orm: Texture;
}

/** One half of the case: its walnut and brass, its squares, and the coordinates and joint light set into it. */
export interface CaseHalf {
  frame: BufferGeometry;
  tilesLight: BufferGeometry;
  tilesDark: BufferGeometry;
  inlay: BufferGeometry;
}

export type DrawerName = 'void_w' | 'void_e' | 'lid_w' | 'lid_e';

/** The case's measurements, as case.py wrote them down. */
export interface CaseMeta {
  /** Half the width of the case, the top of its rim, its underside, half the width of the field of squares, and where its faces stand. */
  half: number;
  rimTop: number;
  bottom: number;
  field: number;
  face: number;
  /** The hinge line runs along x at this height and z. */
  hinge: { y: number; z: number };
  /**
   * How far a drawer comes out; the height of its baize and the top of its walls; and the baize as
   * it lies with the drawer out: from x to x across the case's side, from z to z out from the hinge line.
   */
  drawer: { travel: number; floor: number; wall: number; inside: [number, number, number, number] };
  /** The hasp turns about the x axis through (y, z); at `shut` radians it holds the lid. */
  clasp: { pivot: [number, number]; shut: number };
}

export interface Assets {
  pieces: Record<Kind, { geometry: BufferGeometry; meta: PieceMeta }>;
  /**
   * The board is a case of two halves. Every mesh is placed as the case stands open with its
   * drawers shut; the lid turns about the hinge, and the drawers slide out along x.
   */
  board: { void: CaseHalf; lid: CaseHalf; drawers: Record<DrawerName, BufferGeometry>; clasp: BufferGeometry; meta: CaseMeta };
  room: {
    plinth: BufferGeometry;
    floor: BufferGeometry;
    shell: BufferGeometry;
    /** The shell with a tenth of its triangles, for the board's mirror, which sees it small and blurred. */
    shellFar: BufferGeometry;
    /** The doors' oak, and the room's iron and brass: the lanterns, their rods and brackets, the candlesticks (red says brass). */
    timber: BufferGeometry;
    metal: BufferGeometry;
    candles: BufferGeometry;
    /** Everything in the room that is itself light; the data channel says which part is which (see environment.py). */
    glow: BufferGeometry;
    /** Flame positions; the first `plinthFlames` stand at the corners of the board, three to a corner, the tallest first. */
    flames: Vector3[];
    plinthFlames: number;
    /** Candle niches in the walls: which wall (north is Void's side), and how far along it from its middle. */
    niches: { wall: 'n' | 's' | 'e' | 'w'; along: number }[];
    /** The shape every niche shares: its opening, how far back it goes, and the height of its floor. */
    niche: { width: number; height: number; depth: number; floor: number };
    floorY: number;
    wall: number;
    ceiling: number;
    oculusHalf: number;
    plinthTop: number;
    /** How high above the board the key hangs, and the width of one bay of the walls. */
    keyHeight: number;
    bay: number;
    /** The hollow ring on Void's wall, the disc on Ivory's, and the cross of lancets over the doorway in each of the other two. */
    ring: { y: number; outer: number; inner: number };
    disc: { y: number; radius: number };
    cross: { head: number; foot: number; half: number; armY: number; arm: number; armAt: number; armHalf: number; armSill: number; armHead: number };
    /** The doorway under each cross: its half width and the top of its arch. */
    door: { half: number; head: number };
    /** The tall windows of the outer bays: half width, sill, head; and the roundel over each. */
    window: { half: number; sill: number; head: number; roundel: number; roundelRadius: number };
    /** The altar the case stands on: its top, the half width of its top and of its body, and its two steps as (half width, top). */
    altar: { top: number; mensa: number; body: number; steps: [number, number][] };
    /** The middle of each lantern's glass, and the glass's radius and half height. */
    lanterns: Vector3[];
    lantern: { radius: number; half: number };
    /**
     * What each kind of baked light was multiplied by before it was stored, and what the key
     * itself would read, in the same units, where it falls straight on the board.
     */
    gains: { candles: number; sky: number; key: number; ring: number; disc: number; slot: number };
    keyUnit: number;
    /** Half the width of the square of light the key lays on the board, and how bright the slot under the slab was when its light was baked. */
    beam: number;
    slotGlow: number;
  };
  surfaces: Record<SurfaceName, Surface>;
  piecesAo: Texture;
  /**
   * How much of its own inner light reaches each part of a piece's stone: red from the seams,
   * green from the eye, blue from the marks, each stored as a square root. Shares the pieces' atlas.
   */
  piecesGlow: Texture;
  /** The room's atlases: occlusion with two kinds of baked light beside it, and three more kinds of light (see environment.py). */
  roomAo: Texture;
  roomLight: Texture;
  /** The case's ambient occlusion, read through UV1. */
  caseAo: Texture;
}

const SURFACES: SurfaceName[] = ['limestone', 'basalt', 'brass', 'limestone_honed', 'pieces_bone', 'pieces_ebony', 'sandstone', 'flagstone', 'oak',
  'marble_light', 'marble_dark', 'walnut', 'baize'];
const DRAWERS: DrawerName[] = ['void_w', 'void_e', 'lid_w', 'lid_e'];
const PIECE_KINDS: Kind[] = ['p', 'r', 'n', 'b', 'q', 'k'];

function meshes(root: Object3D): Map<string, Mesh> {
  const found = new Map<string, Mesh>();
  root.traverse((o) => {
    if ((o as Mesh).isMesh) found.set(o.name, o as Mesh);
  });
  return found;
}

/** Take a mesh's geometry and rename its data channel. Throws if the export is not what the engine expects. */
/**
 * The room is stored compactly (environment.py, `quantize`): its positions as fractions of each
 * mesh's extent, which its node's scale and translation bring back, and its tiling coordinates
 * as fractions of the number in its node's extras as \`uv0\`. Undo both here, so that the
 * engine has the room's geometry in room space with nothing on its node, as it always has.
 */
function roomGeometryOf(found: Map<string, Mesh>, name: string): BufferGeometry {
  const mesh = found.get(name);
  if (!mesh) throw new Error(`Asset mesh "${name}" is missing`);
  const g = mesh.geometry;
  mesh.updateMatrix();
  const position = g.getAttribute('position');
  if (position && (!(position.array instanceof Float32Array) || !mesh.matrix.equals(IDENTITY))) {
    const out = new Float32Array(position.count * 3);
    const v = new Vector3();
    for (let i = 0; i < position.count; i++) v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix).toArray(out, i * 3);
    g.setAttribute('position', new BufferAttribute(out, 3));
  }
  const k = mesh.userData.uv0 as number | undefined;
  const uv = g.getAttribute('uv');
  if (uv && k !== undefined) {
    const out = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
      out[i * 2] = uv.getX(i) * k;
      out[i * 2 + 1] = uv.getY(i) * k;
    }
    g.setAttribute('uv', new BufferAttribute(out, 2));
  }
  return geometryOf(found, name);
}

function geometryOf(found: Map<string, Mesh>, name: string): BufferGeometry {
  const mesh = found.get(name);
  if (!mesh) throw new Error(`Asset mesh "${name}" is missing`);
  const g = mesh.geometry;
  const data = g.getAttribute('color');
  if (!data || !g.getAttribute('uv') || !g.getAttribute('uv1') || !g.getAttribute('normal')) {
    throw new Error(`Asset mesh "${name}" lacks an attribute the engine needs`);
  }
  g.setAttribute('aData', data);
  g.deleteAttribute('color');
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function metaOf<T>(found: Map<string, Mesh>, name: string): T {
  const raw = found.get(name)?.userData.meta as string | undefined;
  if (!raw) throw new Error(`Asset mesh "${name}" has no metadata`);
  return JSON.parse(raw) as T;
}

const IDENTITY = new Matrix4();
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(isNumber);
const fieldsOf = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/** Throw unless there is a number under each of `keys`. `what` names the thing in the message. */
function needNumbers(value: unknown, keys: readonly string[], what: string): void {
  const fields = fieldsOf(value);
  for (const key of keys) if (!isNumber(fields[key])) throw new Error(`${what} has no ${key} in its metadata`);
}

/**
 * Throws unless the room's metadata says everything the engine reads from it. The room's light
 * and several of its shaders are worked out from these numbers, by division among other things.
 * A room.glb from before one of them was written down (a stale copy beside a newer game, say)
 * has to fail here, where the game falls back to its plain board, and not later as a picture
 * with no numbers in it or a shader that cannot be written.
 */
export function checkRoomMeta(shell: unknown, candles: unknown): void {
  const what = 'Asset mesh "shell"';
  needNumbers(shell, ['floorY', 'wall', 'ceiling', 'oculusHalf', 'plinthTop', 'keyHeight', 'bay', 'keyUnit', 'beam', 'slotGlow'], what);
  const s = fieldsOf(shell);
  // Sizes, and what other things are divided by.
  for (const key of ['wall', 'oculusHalf', 'keyHeight', 'bay', 'keyUnit', 'beam', 'slotGlow']) {
    if (!((s[key] as number) > 0)) throw new Error(`${what} has a ${key} of nothing in its metadata`);
  }
  if (!((s.ceiling as number) > (s.floorY as number))) throw new Error(`${what} has its ceiling under its floor`);
  needNumbers(s.ring, ['y', 'outer', 'inner'], `The ring of ${what.toLowerCase()}`);
  needNumbers(s.disc, ['y', 'radius'], `The disc of ${what.toLowerCase()}`);
  needNumbers(s.cross, ['head', 'foot', 'half', 'armY', 'arm', 'armAt', 'armHalf', 'armSill', 'armHead'], `The cross of ${what.toLowerCase()}`);
  needNumbers(s.door, ['half', 'head'], `The door of ${what.toLowerCase()}`);
  needNumbers(s.window, ['half', 'sill', 'head', 'roundel', 'roundelRadius'], `The windows of ${what.toLowerCase()}`);
  needNumbers(s.altar, ['top', 'mensa', 'body'], `The altar of ${what.toLowerCase()}`);
  needNumbers(s.lantern, ['radius', 'half'], `The lanterns of ${what.toLowerCase()}`);
  if (!Array.isArray(s.lanterns) || !s.lanterns.every(isPoint)) throw new Error(`${what} does not say where its lanterns hang`);
  const gains = fieldsOf(s.gains);
  for (const kind of ['candles', 'sky', 'key', 'ring', 'disc', 'slot']) {
    if (!(isNumber(gains[kind]) && gains[kind] > 0)) throw new Error(`${what} does not say what its ${kind} light was stored at`);
  }

  const c = fieldsOf(candles);
  needNumbers(c.niche, ['width', 'height', 'depth', 'floor'], 'The niche of asset mesh "candles"');
  if (!Array.isArray(c.flames) || !c.flames.every(isPoint)) throw new Error('Asset mesh "candles" does not say where its flames are');
  if (!Number.isInteger(c.plinthFlames) || (c.plinthFlames as number) < 0 || (c.plinthFlames as number) > c.flames.length) {
    throw new Error('Asset mesh "candles" does not say how many of its flames stand at the board');
  }
  const niches = c.niches;
  if (!Array.isArray(niches) || !niches.every((n) => ['n', 's', 'e', 'w'].includes(fieldsOf(n).wall as string) && isNumber(fieldsOf(n).along))) {
    throw new Error('Asset mesh "candles" does not say where its niches are');
  }
}

/**
 * Throws unless the case's metadata says everything the engine reads from it: where the hinge is,
 * how its drawers open and what is inside them, and how the clasp turns. The hands, the pieces and
 * the opening all stand on these numbers.
 */
export function checkCaseMeta(meta: unknown): void {
  const what = 'Asset mesh "void_frame"';
  needNumbers(meta, ['half', 'rimTop', 'bottom', 'field', 'face'], what);
  const m = fieldsOf(meta);
  if (!((m.half as number) > (m.field as number) && (m.field as number) > 0)) throw new Error(`${what} has a field no smaller than the case`);
  if (!((m.rimTop as number) > (m.bottom as number))) throw new Error(`${what} has its rim under its foot`);
  needNumbers(m.hinge, ['y', 'z'], `The hinge of ${what.toLowerCase()}`);
  const drawer = fieldsOf(m.drawer);
  needNumbers(drawer, ['travel', 'floor', 'wall'], `The drawers of ${what.toLowerCase()}`);
  if (!((drawer.travel as number) > 0)) throw new Error(`${what} has drawers that do not open`);
  const inside = drawer.inside;
  if (!(Array.isArray(inside) && inside.length === 4 && inside.every(isNumber) && inside[1] > inside[0] && inside[3] > inside[2])) {
    throw new Error(`${what} does not say what is inside its drawers`);
  }
  const clasp = fieldsOf(m.clasp);
  if (!(Array.isArray(clasp.pivot) && clasp.pivot.length === 2 && clasp.pivot.every(isNumber) && isNumber(clasp.shut))) {
    throw new Error(`${what} does not say how its clasp turns`);
  }
}

/** Throws unless a piece's metadata says everything the engine reads from it: its blocks, its eye, and how it is held. */
export function checkPieceMeta(meta: unknown, kind: string): void {
  const what = `Asset mesh "piece_${kind}"`;
  const m = fieldsOf(meta);
  if (!(isNumber(m.height) && m.height > 0)) throw new Error(`${what} has no height in its metadata`);
  const modules = m.modules;
  if (!Array.isArray(modules) || modules.length === 0) throw new Error(`${what} has no blocks in its metadata`);
  for (const block of modules) {
    const b = fieldsOf(block);
    if (!isPoint(b.pivot)) throw new Error(`${what} has a block with no pivot`);
    // An axis is a direction: it has to have one.
    if (b.axis !== undefined && !(isPoint(b.axis) && Math.hypot(...(b.axis as number[])) > 1e-6)) throw new Error(`${what} has a block that turns about no line`);
  }
  if (m.head !== undefined && !(Number.isInteger(m.head) && (m.head as number) >= 0 && (m.head as number) < modules.length)) {
    throw new Error(`${what} has a head that is none of its blocks`);
  }
  if (!isPoint(m.eye)) throw new Error(`${what} has no eye in its metadata`);
  const grip = fieldsOf(m.grip);
  if (!['pinch', 'wrap', 'hook', 'tripod'].includes(String(grip.type))) throw new Error(`${what} does not say how it is held`);
  needNumbers(grip, ['y', 'half'], `The grip of ${what.toLowerCase()}`);
  if (!((grip.half as number) > 0)) throw new Error(`${what} is held by nothing`);
  if (grip.z !== undefined && !isNumber(grip.z)) throw new Error(`The grip of ${what.toLowerCase()} has no z in its metadata`);
}

export async function loadAssets(maxAnisotropy: number, base = `${import.meta.env.BASE_URL}assets/`): Promise<Assets> {
  const gltf = new GLTFLoader();
  const textures = new TextureLoader();

  const tiling = async (file: string, colour: boolean): Promise<Texture> => {
    const t = await textures.loadAsync(`${base}tex/${file}`);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.colorSpace = colour ? SRGBColorSpace : NoColorSpace;
    t.anisotropy = maxAnisotropy;
    // Match the orientation the glTF UVs were written for.
    t.flipY = false;
    return t;
  };
  const atlas = async (file: string): Promise<Texture> => {
    const t = await textures.loadAsync(`${base}tex/${file}`);
    t.colorSpace = NoColorSpace;
    t.flipY = false;
    t.channel = 1; // sampled with the second, non-overlapping UV set
    return t;
  };

  const [piecesFile, boardFile, roomFile, piecesAo, piecesGlow, roomAo, roomLight, caseAo, ...sets] = await Promise.all([
    gltf.loadAsync(`${base}pieces.glb`),
    gltf.loadAsync(`${base}board.glb`),
    gltf.loadAsync(`${base}room.glb`),
    atlas('pieces_ao.jpg'),
    atlas('pieces_glow.jpg'),
    atlas('room_ao.jpg'),
    atlas('room_light.jpg'),
    atlas('case_ao.jpg'),
    ...SURFACES.map(async (name): Promise<Surface> => {
      const [albedo, normal, orm] = await Promise.all([
        tiling(`${name}_albedo.jpg`, true),
        tiling(`${name}_normal.jpg`, false),
        tiling(`${name}_orm.jpg`, false),
      ]);
      return { albedo, normal, orm };
    }),
  ]);

  const pieceMeshes = meshes(piecesFile.scene);
  const pieces = {} as Assets['pieces'];
  for (const kind of PIECE_KINDS) {
    const meta = metaOf<PieceMeta>(pieceMeshes, `piece_${kind}`);
    checkPieceMeta(meta, kind);
    pieces[kind] = { geometry: geometryOf(pieceMeshes, `piece_${kind}`), meta };
  }

  const boardMeshes = meshes(boardFile.scene);
  const roomMeshes = meshes(roomFile.scene);
  const shellMeta = metaOf<
    Pick<Assets['room'], 'floorY' | 'wall' | 'ceiling' | 'oculusHalf' | 'plinthTop' | 'keyHeight' | 'bay' | 'ring' | 'disc' | 'cross' | 'door' | 'window' | 'altar' | 'lantern' | 'gains' | 'keyUnit' | 'beam' | 'slotGlow'> & {
      lanterns: [number, number, number][];
    }
  >(roomMeshes, 'shell');
  const candleMeta = metaOf<{
    flames: [number, number, number][];
    plinthFlames: number;
    niches: Assets['room']['niches'];
    niche: Assets['room']['niche'];
  }>(roomMeshes, 'candles');
  checkRoomMeta(shellMeta, candleMeta);

  const caseMeta = metaOf<CaseMeta>(boardMeshes, 'void_frame');
  checkCaseMeta(caseMeta);
  const half = (name: 'void' | 'lid'): CaseHalf => ({
    frame: geometryOf(boardMeshes, `${name}_frame`),
    tilesLight: geometryOf(boardMeshes, `${name}_tiles_light`),
    tilesDark: geometryOf(boardMeshes, `${name}_tiles_dark`),
    inlay: geometryOf(boardMeshes, `${name}_inlay`),
  });
  const drawers = {} as Assets['board']['drawers'];
  for (const name of DRAWERS) drawers[name] = geometryOf(boardMeshes, `drawer_${name}`);

  const surfaces = {} as Assets['surfaces'];
  SURFACES.forEach((name, i) => (surfaces[name] = sets[i]!));

  return {
    pieces,
    board: { void: half('void'), lid: half('lid'), drawers, clasp: geometryOf(boardMeshes, 'clasp'), meta: caseMeta },
    room: {
      plinth: roomGeometryOf(roomMeshes, 'plinth'),
      floor: roomGeometryOf(roomMeshes, 'floor'),
      shell: roomGeometryOf(roomMeshes, 'shell'),
      shellFar: roomGeometryOf(roomMeshes, 'shell_far'),
      timber: roomGeometryOf(roomMeshes, 'timber'),
      metal: roomGeometryOf(roomMeshes, 'metal'),
      candles: roomGeometryOf(roomMeshes, 'candles'),
      glow: roomGeometryOf(roomMeshes, 'glow'),
      flames: candleMeta.flames.map(([x, y, z]) => new Vector3(x, y, z)),
      plinthFlames: candleMeta.plinthFlames,
      niches: candleMeta.niches,
      niche: candleMeta.niche,
      ...shellMeta,
      lanterns: shellMeta.lanterns.map(([x, y, z]) => new Vector3(x, y, z)),
    },
    surfaces,
    piecesAo,
    piecesGlow,
    roomAo,
    roomLight,
    caseAo,
  };
}
