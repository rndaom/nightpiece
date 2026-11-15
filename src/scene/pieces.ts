/**
 * The pieces on the board: one small group per piece identity, with eased
 * movement for moves, captures, castling, promotion and take-backs.
 *
 * How a piece looks is supplied by a `PieceLook`: the grey-box blocks while
 * assets load (and as a fallback), then the Blender-built stone. Swapping
 * the look keeps every piece where it is, mid-animation included.
 *
 * Milestone 4 replaces the self-propelled hops with the hands. Until then
 * every motion here still follows the bible's rules: anticipation, an eased
 * arc, a settle with overshoot, and no linear interpolation.
 */
import {
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  type Raycaster,
  type Vector3,
} from 'three';
import type { Kind, MoveEvent, PieceState, Side, Square } from '../core/game';
import type { Assets } from './assets';
import { ContactShadows } from './contact';
import { groundAt, squareCenter } from './layout';
import { GLOW, pieceMaterial, type PieceMaterial } from './materials';
import { pieceGeometry } from './pieceShapes';
import { Spring } from './spring';
import { Easing, lerp, type Tweens } from './tween';

/** How a piece holds itself and glows this frame, beyond where it stands. */
export interface PieceDraw {
  /** Brightness of its seams, marks and eye: 1 at rest. */
  energy: number;
  /** 0 to 1 and back, out of step from piece to piece. */
  breath: number;
  /** How far its head is turned, in radians. */
  turn: number;
  /** 0 at rest; positive squashes it down, negative stretches it up. */
  squash: number;
  /** How far it leans along its own x and z, for each unit of height. */
  leanX: number;
  leanZ: number;
  /** Brightness of the eye alone, 1 at rest. */
  eye: number;
  /** A colour its light is turning toward, and how far it has turned (0 to 1). */
  tint: Color;
  tintAmount: number;
}

/** The drawable part of one piece. */
export interface PieceVisual {
  readonly object: Object3D;
  setKind(kind: Kind): void;
  update(draw: PieceDraw): void;
  dispose(): void;
}

export interface PieceLook {
  create(kind: Kind, side: Side): PieceVisual;
}

const GREYBOX_GLOW: Record<Side, Color> = { w: new Color(0xf6dc92), b: new Color(0x59e5cc) };

/** Blocks generated in code: what the game shows until the real assets arrive. */
export function greyboxLook(): PieceLook {
  const stone: Record<Side, MeshStandardMaterial> = {
    w: new MeshStandardMaterial({ color: 0xcfc7b3, roughness: 0.84, metalness: 0 }),
    b: new MeshStandardMaterial({ color: 0x262c2a, roughness: 0.46, metalness: 0.05 }),
  };
  return {
    create(kind, side) {
      const glowMaterial = new MeshBasicMaterial({ color: GREYBOX_GLOW[side], toneMapped: false });
      const geometry = pieceGeometry(kind);
      const body = new Mesh(geometry.body, stone[side]);
      body.castShadow = true;
      body.receiveShadow = true;
      const glow = new Mesh(geometry.glow, glowMaterial);
      const object = new Group();
      object.add(body, glow);
      return {
        object,
        setKind(next) {
          const g = pieceGeometry(next);
          body.geometry = g.body;
          glow.geometry = g.glow;
        },
        update(d) {
          glowMaterial.color.copy(GREYBOX_GLOW[side]).multiplyScalar((0.72 + 0.28 * d.breath) * d.energy);
        },
        dispose() {
          glowMaterial.dispose();
        },
      };
    },
  };
}

/** The Blender-built pieces: limestone for Ivory, basalt for Void, lit from inside. */
export function assetLook(assets: Assets): PieceLook {
  return {
    create(kind, side) {
      const material: PieceMaterial = pieceMaterial(assets, side);
      const mesh = new Mesh(assets.pieces[kind].geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const u = material.userData.uniforms;
      /**
       * The head is the block the piece names, or else the one that carries the eye, and everything
       * stacked on it. It turns about the plumb line through the foot unless that block gives an axis
       * of its own.
       */
      const setHead = (k: Kind) => {
        const meta = assets.pieces[k].meta;
        let head = 0;
        if (meta.head !== undefined) head = meta.head;
        else
          meta.modules.forEach((block, i) => {
            if (block.pivot[1] <= meta.eye[1]) head = i;
          });
        u.uHead.value = head;
        const block = meta.modules[head];
        if (block?.axis) {
          u.uAxis.value.fromArray(block.axis).normalize();
          u.uPivot.value.fromArray(block.pivot);
        } else {
          u.uAxis.value.set(0, 1, 0);
          u.uPivot.value.set(0, 0, 0);
        }
      };
      setHead(kind);
      return {
        object: mesh,
        setKind(next) {
          mesh.geometry = assets.pieces[next].geometry;
          setHead(next);
        },
        update(d) {
          u.uEnergy.value = (0.7 + 0.3 * d.breath) * d.energy;
          // The blocks ride a few thousandths of a square apart as the piece breathes in.
          u.uBreath.value = 0.0035 * d.breath + 0.006 * Math.max(0, d.energy - 1);
          u.uEye.value = 1.5 * d.eye;
          u.uPose.value.set(d.turn, d.squash, d.leanX, d.leanZ);
          u.uGlowColor.value.copy(GLOW[side]).lerp(d.tint, d.tintAmount);
        },
        dispose() {
          material.dispose();
        },
      };
    },
  };
}

/**
 * A piece as the hands see it. While a hand holds one, the hand moves `group` and the layer leaves
 * it alone.
 */
export interface Puppet {
  readonly id: number;
  readonly side: Side;
  kind: Kind;
  readonly group: Group;
  /** Brightness of its seams and eye: 1 at rest, 0 once it has been taken. */
  energy: number;
}

/** A piece's state of mind, as springs: knock one and it settles back by itself. */
interface Mood {
  turn: Spring;
  squash: Spring;
  leanX: Spring;
  leanZ: Spring;
  eye: Spring;
  /** A multiplier on its light. */
  glow: Spring;
  tint: Color;
  tintAmount: Spring;
  /** 0 to 1: how badly it is trembling. */
  fear: number;
}

const newMood = (): Mood => ({
  turn: new Spring(),
  squash: new Spring(),
  leanX: new Spring(),
  leanZ: new Spring(),
  eye: new Spring(1),
  glow: new Spring(1),
  tint: new Color(),
  tintAmount: new Spring(),
  fear: 0,
});

interface View extends Puppet {
  square: Square;
  visual: PieceVisual;
  mood: Mood;
  /** Bumped whenever a new motion takes over the piece, so that an older one stops steering it. */
  motion: number;
}

/** The style bible's reds for a side that has just blundered and a piece offered up. */
export const OLD_BLOOD = new Color(0xa75a5f).convertSRGBToLinear().multiplyScalar(2.4);
export const EMBER = new Color(0xd0634a).convertSRGBToLinear().multiplyScalar(3.2);

/** Width of each kind's base, in squares, for the shadow it leaves on the board. */
const FOOTPRINT: Record<Kind, number> = { p: 0.56, r: 0.64, n: 0.64, b: 0.6, q: 0.64, k: 0.7 };
const SELECT_LIFT = 0.16;
const KNIGHT_HOP = 1.95;
/** How a piece is drawn when nothing is happening to it. */
const REST: PieceDraw = { energy: 1, breath: 0, turn: 0, squash: 0, leanX: 0, leanZ: 0, eye: 1, tint: new Color(), tintAmount: 0 };
/** What a piece that has left the room is drawn with: nothing at all. */
const NOTHING: PieceVisual = { object: new Group(), setKind() {}, update() {}, dispose() {} };

export class PieceLayer {
  readonly root = new Group();
  /** Soft shadows under the pieces. Kept out of `root` so that it holds the pieces and nothing else. */
  readonly contact = new ContactShadows();
  /**
   * Soft shade to lay on the ground this frame under things that are not pieces. Whoever owns
   * them refills the list each frame: where each is, how big its shade is at ground level, and
   * how much of it is there (0 to 1).
   */
  shades: { x: number; y: number; z: number; size: number; presence: number }[] = [];
  private views = new Map<number, View>();
  /** Captured pieces that are still on their way out. They are drawn and lit, but are no longer in play. */
  private leaving = new Set<View>();
  /** Captured pieces that the hands have stood beside the board. */
  private trophies = new Map<number, View>();
  /**
   * Drawable parts that no piece is using just now, by side, to be handed out again. They are kept
   * because three.js throws a shader program away along with the last material that used it: a
   * reset that disposed of all thirty-two would have the very same program built again, a frame
   * later, for the new position.
   */
  private spare: Record<Side, PieceVisual[]> = { w: [], b: [] };
  /** Counts the times a side's lights were put out or brought back, so that one still going out when they are brought back stops. */
  private lights = 0;
  /** Drawable parts of a look that has been replaced, and how many frames they have left. */
  private stale: PieceVisual[] = [];
  private staleFrames = 0;
  private selected: View | null = null;
  /**
   * True when hands are moving the pieces. A chosen piece then brightens but stays on its square,
   * because it is the hand over it that shows it has been chosen.
   */
  handsOn = false;
  /** Points in the room that the pieces find interesting, such as a hand at work. They turn to look. */
  watch: Vector3[] = [];
  /** How high the tile under a point is standing, when the board can move its tiles. Pieces ride them. */
  tileLift: ((x: number, z: number) => number) | null = null;
  private draw: PieceDraw = { energy: 1, breath: 0, turn: 0, squash: 0, leanX: 0, leanZ: 0, eye: 1, tint: new Color(), tintAmount: 0 };

  constructor(
    private tweens: Tweens,
    private look: PieceLook = greyboxLook(),
  ) {
    this.root.name = 'pieces';
  }

  /** Change how every piece is drawn, keeping each where it is. */
  setLook(look: PieceLook): void {
    this.look = look;
    for (const v of [...this.views.values(), ...this.leaving, ...this.trophies.values()]) {
      v.group.remove(v.visual.object);
      this.stale.push(v.visual);
      v.visual = look.create(v.kind, v.side);
      v.group.add(v.visual.object);
    }
    // The old look's parts go only once the new ones have been drawn: a shader program the two
    // looks share then never loses its last user (see `spare`).
    this.stale.push(...this.spare.w.splice(0), ...this.spare.b.splice(0));
    this.staleFrames = 2;
  }

  /** Clear the board and stand the pieces of a position on it, with no animation. */
  reset(pieces: PieceState[]): void {
    for (const v of [...this.views.values(), ...this.leaving, ...this.trophies.values()]) this.destroy(v);
    this.views.clear();
    this.leaving.clear();
    this.trophies.clear();
    this.selected = null;
    for (const p of pieces) this.create(p);
  }

  /** Raise the piece on a square to show it is held, or pass null to put it down. */
  setSelected(square: Square | null): void {
    const next = square ? (this.viewOn(square) ?? null) : null;
    if (next === this.selected) return;
    const prev = this.selected;
    this.selected = next;
    if (prev && this.views.get(prev.id) === prev) this.raise(prev, 0, 1);
    if (next) this.raise(next, this.handsOn ? 0 : SELECT_LIFT, 1.5);
  }

  // -- for the hands ----------------------------------------------------------

  /** The piece with this identity, whether it is in play or has been taken and stood aside. */
  puppet(id: number): Puppet | null {
    return this.views.get(id) ?? this.trophies.get(id) ?? null;
  }

  /** The piece standing on a square. */
  puppetAt(square: Square): Puppet | null {
    return this.viewOn(square) ?? null;
  }

  /** Every piece in play. */
  standing(): Iterable<Puppet> {
    return this.views.values();
  }

  /** Take over a piece's movement. Anything the layer was doing to it stops. */
  hold(id: number): Puppet | null {
    const v = this.views.get(id) ?? this.trophies.get(id);
    if (!v) return null;
    v.motion++;
    if (this.selected === v) this.selected = null;
    return v;
  }

  /** Stand a piece exactly on a square, upright and facing its opponent, and record that it is there. */
  settle(id: number, square: Square): void {
    const v = this.views.get(id);
    if (!v) return;
    v.square = square;
    squareCenter(square, v.group.position);
    v.group.rotation.set(0, v.side === 'w' ? 0 : Math.PI, 0);
    v.group.scale.setScalar(1);
  }

  /** A captured piece leaves the game but stays in the room, wherever the hands put it. */
  retire(id: number): Puppet | null {
    const v = this.views.get(id);
    if (!v) return null;
    v.motion++;
    if (this.selected === v) this.selected = null;
    this.views.delete(id);
    this.trophies.set(id, v);
    return v;
  }

  /** Bring a captured piece back into play (for a take-back). The hands carry it; this records where it belongs. */
  restore(id: number, kind: Kind, side: Side, square: Square): Puppet {
    let v = this.trophies.get(id);
    if (v) {
      this.trophies.delete(id);
      this.views.set(id, v);
      v.square = square;
    } else {
      v = this.create({ id, kind, side, square });
    }
    return v;
  }

  /** Change what kind of piece this is (promotion, or its undoing). */
  recast(id: number, kind: Kind): void {
    const v = this.views.get(id);
    if (v) this.swapKind(v, kind);
  }

  // -- for the opening of the case ------------------------------------------

  /** Every piece that has been taken and stood aside. */
  taken(): Iterable<Puppet> {
    return this.trophies.values();
  }

  /** A piece comes down on its square from a height: it squashes and springs back. */
  land(id: number, strength = 1): void {
    const v = this.views.get(id) ?? this.trophies.get(id);
    if (v) v.mood.squash.velocity += 2.2 * strength;
  }

  // -- how the pieces feel about it -------------------------------------------

  /**
   * A piece starts: it squashes, shrinks from `from` if a point is given, and its eye narrows.
   * It recovers by itself.
   */
  flinch(id: number, from: Vector3 | null = null, strength = 1): void {
    const v = this.views.get(id) ?? this.trophies.get(id);
    if (!v) return;
    const m = v.mood;
    m.squash.velocity += 2.6 * strength;
    m.eye.value = Math.min(m.eye.value, 0.35);
    if (from) {
      const dx = v.group.position.x - from.x;
      const dz = v.group.position.z - from.z;
      const d = Math.hypot(dx, dz) || 1;
      // Into the piece's own frame, which is turned by the way it faces.
      const f = v.group.rotation.y;
      m.leanX.velocity += ((dx * Math.cos(f) - dz * Math.sin(f)) / d) * 1.7 * strength;
      m.leanZ.velocity += ((dx * Math.sin(f) + dz * Math.cos(f)) / d) * 1.7 * strength;
    }
  }

  /** Everything standing near a point shrinks from it, the nearer the more. */
  recoilFrom(point: Vector3, reach = 1.7, except: number[] = []): void {
    for (const v of this.views.values()) {
      if (except.includes(v.id)) continue;
      const d = Math.hypot(v.group.position.x - point.x, v.group.position.z - point.z);
      if (d < reach) this.flinch(v.id, point, 0.75 * (1 - d / reach) + 0.2);
    }
  }

  /** A side takes heart: its light surges and it stands taller, in a wave out from `origin`. */
  rally(side: Side, origin: Vector3): void {
    for (const v of this.views.values()) {
      if (v.side !== side) continue;
      const delay = 0.045 * Math.hypot(v.group.position.x - origin.x, v.group.position.z - origin.z);
      void this.tweens.wait(delay).then(() => {
        v.mood.glow.value = 2.1;
        v.mood.squash.velocity -= 1.5;
        v.mood.eye.value = 1.8;
      });
    }
  }

  /** A side loses heart for a while: its light sinks toward old blood and it settles lower. */
  sag(side: Side, seconds = 2.8): void {
    for (const v of this.views.values()) {
      if (v.side !== side) continue;
      const m = v.mood;
      m.glow.goal = 0.5;
      m.squash.goal = 0.035;
      m.tint.copy(OLD_BLOOD);
      m.tintAmount.goal = 0.8;
      void this.tweens.wait(seconds).then(() => {
        m.glow.goal = 1;
        m.squash.goal = 0;
        m.tintAmount.goal = 0;
      });
    }
  }

  /** A piece that has been offered up burns ember at its seams for a while. */
  burn(id: number, seconds = 2.4): void {
    const v = this.views.get(id);
    if (!v) return;
    v.mood.tint.copy(EMBER);
    v.mood.tintAmount.goal = 1;
    v.mood.glow.value = 1.7;
    void this.tweens.wait(seconds).then(() => (v.mood.tintAmount.goal = 0));
  }

  /** A piece shuts its eye for a moment, and opens it again by itself. */
  blink(id: number): void {
    const v = this.views.get(id);
    if (v) v.mood.eye.value = 0.05;
  }

  /** The piece on this square is afraid (a king in check): its eye narrows and it trembles. Null calms everyone. */
  setFear(square: Square | null): void {
    for (const v of this.views.values()) {
      const afraid = square !== null && v.square === square;
      v.mood.fear = afraid ? 1 : 0;
      v.mood.eye.goal = afraid ? 0.4 : 1;
    }
  }

  /**
   * A side's light goes out, a piece at a time, starting from `origin`. For the side that has
   * been mated, or has given the game up. `atOnce` is for a game found already lost: its lights
   * are simply out.
   */
  extinguish(side: Side, origin: Vector3, atOnce = false): void {
    const lights = ++this.lights;
    for (const v of this.views.values()) {
      if (v.side !== side) continue;
      const out = () => {
        // The lights have been brought back since (the mate was taken back), or put out afresh.
        if (lights !== this.lights) return;
        v.mood.glow.goal = 0;
        v.mood.eye.goal = 0;
        v.mood.squash.goal = 0.05;
      };
      if (atOnce) {
        out();
        v.mood.glow.snap(0);
        v.mood.eye.snap(0);
        v.mood.squash.snap(0.05);
      } else {
        const delay = 0.3 + 0.16 * Math.hypot(v.group.position.x - origin.x, v.group.position.z - origin.z);
        void this.tweens.wait(delay).then(out);
      }
    }
  }

  /** Every piece's light comes back and it stands up again: the game that had ended goes on after all. */
  relight(): void {
    this.lights++;
    for (const v of this.views.values()) {
      v.mood.glow.goal = 1;
      v.mood.squash.goal = 0;
      if (v.mood.eye.goal === 0) v.mood.eye.goal = 1;
    }
  }

  /** A piece shifts where it stands: a small hop and a look about. For a side kept waiting. */
  fidget(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    v.mood.squash.velocity -= 1.3;
    v.mood.turn.velocity += (v.id % 2 === 0 ? 1 : -1) * 4;
  }

  /** The identities of a side's pieces in play. */
  idsOf(side: Side): number[] {
    return [...this.views.values()].filter((v) => v.side === side).map((v) => v.id);
  }

  /** The scene object for the piece on a square, for anything that needs to know where it is. */
  objectAt(square: Square): Group | null {
    return this.viewOn(square)?.group ?? null;
  }

  /** The kind of piece drawn on a square. */
  kindAt(square: Square): Kind | null {
    return this.viewOn(square)?.kind ?? null;
  }

  /** How many pieces are on the board, including any that are still animating in. */
  get count(): number {
    return this.views.size;
  }

  /**
   * The square of the piece under a ray, if it hits one: what is drawn decides. A box around each
   * piece would be simpler, but from the low cameras the boxes of the pieces in front swallow the
   * pieces and squares behind them.
   */
  pick(raycaster: Raycaster): Square | null {
    this.root.updateMatrixWorld();
    for (const hit of raycaster.intersectObjects(this.root.children, true)) {
      let o: Object3D | null = hit.object;
      while (o && o.parent !== this.root) o = o.parent;
      // A piece that is being taken off the board is drawn but can no longer be chosen.
      for (const v of this.views.values()) if (v.group === o) return v.square;
    }
    return null;
  }

  /** Animate a move that the rules core has already applied. */
  async playMove(e: MoveEvent): Promise<void> {
    const mover = this.views.get(e.piece.id);
    if (!mover) return;
    if (this.selected === mover) this.selected = null;
    mover.square = e.piece.to;

    const to = squareCenter(e.piece.to);
    const distance = Math.hypot(to.x - mover.group.position.x, to.z - mover.group.position.z);
    const hop = mover.kind === 'n' ? KNIGHT_HOP : Math.min(0.75, 0.3 + 0.07 * distance);
    const duration = Math.min(0.9, Math.max(0.42, 0.34 + 0.075 * distance));
    const jobs: Promise<void>[] = [];

    jobs.push(
      this.crouch(mover)
        .then(() => this.travel(mover, to, hop, duration))
        .then(() => (e.promotion ? this.transform(mover, e.promotion) : undefined)),
    );

    if (e.captured) {
      const victim = this.views.get(e.captured.id);
      if (victim) {
        this.views.delete(victim.id);
        this.leaving.add(victim);
        jobs.push(this.vanish(victim, 0.09 + duration * 0.6));
      }
    }
    if (e.rook) {
      const rook = this.views.get(e.rook.id);
      if (rook) {
        rook.square = e.rook.to;
        // The rook has to clear the king that has just arrived next to it.
        jobs.push(this.travel(rook, squareCenter(e.rook.to), 2.05, 0.62, 0.2));
      }
    }
    await Promise.all(jobs);
  }

  /** Animate a take-back that the rules core has already applied. */
  async playUndo(e: MoveEvent): Promise<void> {
    const mover = this.views.get(e.piece.id);
    if (!mover) return;
    if (this.selected === mover) this.selected = null;
    mover.square = e.piece.from;
    if (e.promotion) this.swapKind(mover, e.piece.kind);

    const to = squareCenter(e.piece.from);
    const distance = Math.hypot(to.x - mover.group.position.x, to.z - mover.group.position.z);
    const hop = mover.kind === 'n' ? KNIGHT_HOP : Math.min(0.75, 0.3 + 0.07 * distance);
    const duration = Math.min(0.72, Math.max(0.36, 0.28 + 0.06 * distance));
    const jobs: Promise<void>[] = [this.travel(mover, to, hop, duration)];

    if (e.rook) {
      const rook = this.views.get(e.rook.id);
      if (rook) {
        rook.square = e.rook.from;
        jobs.push(this.travel(rook, squareCenter(e.rook.from), 2.05, 0.56, 0.05));
      }
    }
    if (e.captured) {
      const back = this.create({
        id: e.captured.id,
        kind: e.captured.kind,
        side: e.side === 'w' ? 'b' : 'w',
        square: e.captured.square,
      });
      back.group.scale.setScalar(0.001);
      jobs.push(
        this.tweens.run({
          duration: 0.34,
          delay: duration * 0.55,
          ease: Easing.outBack,
          update: (k) => back.group.scale.setScalar(Math.max(0.001, k)),
        }),
      );
    }
    await Promise.all(jobs);
  }

  /** Per-frame life: the seams breathe, heads turn to watch, and whatever a piece is feeling plays out. */
  update(time: number, dt = 0): void {
    if (this.stale.length > 0 && --this.staleFrames <= 0) for (const visual of this.stale.splice(0)) visual.dispose();
    this.contact.begin();
    for (const v of this.views.values()) this.animate(v, time, dt, true);
    for (const v of this.leaving) this.animate(v, time, dt, false);
    for (const v of this.trophies.values()) this.animate(v, time, dt, false);
    // Whatever else is over the board and should darken it a little: the hands.
    for (const s of this.shades) {
      const ground = groundAt(s.x, s.z);
      this.contact.add(s.x, s.z, s.size, s.y - ground, s.presence, ground);
    }
    this.contact.end();
  }

  // -- internals ------------------------------------------------------------

  private animate(v: View, time: number, dt: number, alive: boolean): void {
    const g = v.group;
    const m = v.mood;
    // Look at the nearest thing worth watching; with nothing to watch, glance about now and then.
    let turn = 0.2 * Math.sin(time * 0.23 + v.id * 2.1) * Math.max(0, Math.sin(time * 0.071 + v.id * 0.9));
    if (alive) {
      let nearest = 36;
      for (const p of this.watch) {
        const dx = p.x - g.position.x;
        const dz = p.z - g.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= nearest || d2 < 0.2) continue;
        nearest = d2;
        const f = g.rotation.y;
        turn = Math.max(-0.8, Math.min(0.8, Math.atan2(-(dx * Math.cos(f) - dz * Math.sin(f)), -(dx * Math.sin(f) + dz * Math.cos(f)))));
      }
    } else {
      turn = 0;
    }
    m.turn.goal = turn;
    m.turn.step(dt, 6.5);
    m.squash.step(dt, 17, 0.4);
    m.leanX.step(dt, 14, 0.38);
    m.leanZ.step(dt, 14, 0.38);
    m.eye.step(dt, 5);
    m.glow.step(dt, 3.2);
    m.tintAmount.step(dt, 4);
    const d = this.draw;
    d.energy = v.energy * m.glow.value;
    d.breath = 0.5 + 0.5 * Math.sin(time * 0.9 + v.id * 1.7);
    d.turn = m.turn.value;
    d.squash = m.squash.value;
    d.leanX = m.leanX.value + m.fear * 0.011 * Math.sin(time * 43 + v.id);
    d.leanZ = m.leanZ.value + m.fear * 0.008 * Math.sin(time * 37 + v.id * 1.3);
    d.eye = m.eye.value * (1 - 0.25 * m.fear * (0.5 + 0.5 * Math.sin(time * 19)));
    d.tint = m.tint;
    d.tintAmount = Math.max(0, Math.min(1, m.tintAmount.value));
    v.visual.update(d);
    // A piece standing on the board goes up and down with its tile.
    v.visual.object.position.y = this.tileLift && alive && Math.abs(g.position.y) < 1e-3 ? this.tileLift(g.position.x, g.position.z) : 0;
    const ground = groundAt(g.position.x, g.position.z);
    this.contact.add(g.position.x, g.position.z, FOOTPRINT[v.kind] * g.scale.x, g.position.y - ground, g.scale.y, ground);
  }

  private viewOn(square: Square): View | undefined {
    for (const v of this.views.values()) if (v.square === square) return v;
    return undefined;
  }

  private create(p: PieceState): View {
    let visual = this.spare[p.side].pop();
    if (visual) {
      // One that has been a piece before begins again as a new one would: at rest, on the ground.
      visual.setKind(p.kind);
      visual.update(REST);
      visual.object.position.y = 0;
    } else {
      visual = this.look.create(p.kind, p.side);
    }
    const group = new Group();
    group.add(visual.object);
    group.position.copy(squareCenter(p.square));
    group.rotation.y = p.side === 'w' ? 0 : Math.PI;
    this.root.add(group);
    const view: View = { id: p.id, kind: p.kind, side: p.side, square: p.square, group, visual, energy: 1, motion: 0, mood: newMood() };
    this.views.set(p.id, view);
    return view;
  }

  private destroy(v: View): void {
    this.leaving.delete(v);
    // Only its own place among the taken: an animation of a piece from the last game, ending late,
    // must not remove the piece of this game that now has its number.
    if (this.trophies.get(v.id) === v) this.trophies.delete(v.id);
    this.root.remove(v.group);
    if (v.visual === NOTHING) return;
    // Its drawable part is kept for the next piece of its side, and the piece lets go of it: an
    // animation of this piece that is still running (a capture, a promotion) then cannot reach
    // what another piece has since been given.
    v.group.remove(v.visual.object);
    this.spare[v.side].push(v.visual);
    v.visual = NOTHING;
  }

  private swapKind(v: View, kind: Kind): void {
    v.kind = kind;
    v.visual.setKind(kind);
  }

  private raise(v: View, height: number, energy: number): void {
    const token = ++v.motion;
    const fromY = v.group.position.y;
    const fromEnergy = v.energy;
    void this.tweens.run({
      duration: 0.2,
      ease: Easing.outCubic,
      update: (k) => {
        if (v.motion !== token) return;
        v.group.position.y = lerp(fromY, height, k);
        v.energy = lerp(fromEnergy, energy, k);
      },
    });
  }

  /** Anticipation: a short squash before the piece leaves the slab. */
  private crouch(v: View): Promise<void> {
    v.motion++;
    return this.tweens.run({
      duration: 0.09,
      ease: Easing.outCubic,
      update: (k) => v.group.scale.set(1 + 0.04 * k, 1 - 0.07 * k, 1 + 0.04 * k),
    });
  }

  /** An eased arc to a new position, stretching slightly in flight, then a settle with overshoot. */
  private travel(v: View, to: Vector3, hop: number, duration: number, delay = 0): Promise<void> {
    const g = v.group;
    let from: Vector3 | null = null;
    let fromEnergy = 1;
    return this.tweens
      .run({
        duration,
        delay,
        ease: Easing.inOutCubic,
        update: (k) => {
          if (!from) {
            v.motion++;
            from = g.position.clone();
            fromEnergy = v.energy;
          }
          const arc = Math.sin(Math.PI * k);
          g.position.x = lerp(from.x, to.x, k);
          g.position.z = lerp(from.z, to.z, k);
          g.position.y = lerp(from.y, 0, k) + hop * arc;
          const stretch = 1 + 0.06 * arc;
          g.scale.set(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch));
          v.energy = lerp(fromEnergy, 1, k) + 0.5 * arc;
        },
      })
      .then(() =>
        this.tweens.run({
          duration: 0.24,
          ease: Easing.outBack,
          update: (k) => g.scale.set(lerp(1.07, 1, k), lerp(0.88, 1, k), lerp(1.07, 1, k)),
        }),
      );
  }

  /** A captured piece shrinks into its square. Milestone 4 gives this to the hands. */
  private vanish(v: View, delay: number): Promise<void> {
    const g = v.group;
    return this.tweens
      .run({
        duration: 0.26,
        delay,
        ease: Easing.inCubic,
        update: (k) => {
          g.scale.set(1 - 0.9 * k, Math.max(0.001, 1 - k), 1 - 0.9 * k);
          v.energy = 1 - k;
        },
      })
      .then(() => this.destroy(v));
  }

  /** Promotion: the pawn draws in, becomes the new piece and springs back out. */
  private transform(v: View, kind: Kind): Promise<void> {
    const g = v.group;
    return this.tweens
      .run({
        duration: 0.12,
        ease: Easing.inCubic,
        update: (k) => g.scale.setScalar(1 - 0.45 * k),
      })
      .then(() => {
        this.swapKind(v, kind);
        return this.tweens.run({
          duration: 0.3,
          ease: Easing.outBack,
          update: (k) => {
            g.scale.setScalar(lerp(0.55, 1, k));
            v.energy = lerp(2.4, 1, k);
          },
        });
      });
  }
}
