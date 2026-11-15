/**
 * The case opening at the start of a game, as one timeline the frame loop drives.
 *
 * Before the first game the case stands shut on the altar: its lid over Void's half, the clasp
 * up over the seam, its drawers in, and no stones and no hands to be seen. When a game begins
 * the clasp gives, the lid comes up, over and down onto the altar with its weight, the four
 * drawers slide out, and the stones come up out of them a few at a time and arc onto their
 * squares, each landing with its own knock, the kings last. Then the hands arrive. The second
 * game in a sitting has only the last part, shorter: the case is open already.
 *
 * Everything is a function of the time since the start, so the opening can be finished at any
 * moment (a click, a key, a new game) by jumping to its end, and a frame skipped or doubled
 * changes nothing. It knows nothing of three.js beyond the pieces' groups and the case's pose,
 * so it is tested without a GPU.
 */
import { Vector3 } from 'three';
import type { DrawerName } from './assets';
import { DRAWER_FAR, DRAWER_NEAR, DRAWER_OUT, PLINTH_TOP, SLAB_HALF } from './layout';
import type { PieceLayer, Puppet } from './pieces';
import { clamp01, Easing, lerp } from './tween';

/** How the board is to be set out: the whole opening from a shut case, the stones alone from an open one, or at once. */
export type Unpacking = 'full' | 'short' | 'none';

export const DRAWER_NAMES: DrawerName[] = ['void_w', 'void_e', 'lid_w', 'lid_e'];

/** Where the case's moving parts are: the lid's turn from open (0) to shut (pi), the clasp's from hanging open (0) to holding the lid (pi), and how far out each drawer is (0 to 1). */
export interface CasePose {
  lid: number;
  clasp: number;
  drawers: Record<DrawerName, number>;
}

export const SHUT = Math.PI;

export function shutPose(): CasePose {
  return { lid: SHUT, clasp: SHUT, drawers: { void_w: 0, void_e: 0, lid_w: 0, lid_e: 0 } };
}
export function openPose(): CasePose {
  return { lid: 0, clasp: 0, drawers: { void_w: 1, void_e: 1, lid_w: 1, lid_e: 1 } };
}

/** What the opening asks the room for as it goes: sounds, a felt thud, and the hands. */
export interface OpeningCues {
  /** The clasp gives and swings down. */
  clasp?(): void;
  /** The lid starts its swing, which takes about `seconds`. */
  swing?(seconds: number): void;
  /** The lid comes down on the altar (strength 1), and again, smaller, as it settles. */
  lands?(strength: number): void;
  /** A drawer starts to slide out. */
  drawer?(name: DrawerName): void;
  /** A stone comes down on its square. */
  knock?(at: Vector3, pale: boolean, weight: number): void;
  /** The stones are all but down: the hands may come. */
  hands?(): void;
}

/** The lid, the drawers and the stones, in seconds from the start of the whole opening. */
const CLASP = 0.12;
const LIFT = 0.38;
const SWING = 0.62;
const DOWN = 1.5;
const DRAWERS = 1.72;
const DRAWER_TIME = 0.5;
const STREAM = 2.15;
/** In the short opening the stones start almost at once and fly faster. */
const SHORT_STREAM = 0.08;
/**
 * A new game on an open case: the stones of the last one go back into the drawers first, all in
 * this long (from the first leaving its square to the last in its drawer), and then come out.
 */
const RETURN = 0.6;

/** Weight of each kind as it lands (as Sound.stoneSet reads it), and the order they leave the drawers. */
const WEIGHT: Record<string, number> = { p: 0.55, n: 0.85, b: 0.9, r: 1.05, q: 1.25, k: 1.5 };
const ORDER: Record<string, number> = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };

/** Where the stones stand on the baize of an open drawer: the middle of it across, and its ends along. */
const TRAY_X = (SLAB_HALF + DRAWER_OUT) / 2;

/** A stone of the game before, as it stood when the new one was set up. */
interface Remembered {
  side: Puppet['side'];
  kind: Puppet['kind'];
  at: Vector3;
  face: number;
  /** Whether it stood on the board (and not in a drawer, taken). */
  board: boolean;
}

/** The way back into its drawer, for a stone of the game before. */
interface Return {
  at: Vector3;
  face: number;
  start: number;
  duration: number;
  /** Already in a drawer: it stays there, in sight, till it goes out again. */
  stays: boolean;
  landed: boolean;
}

interface Flight {
  puppet: Puppet;
  back: Return | null;
  from: Vector3;
  to: Vector3;
  /** Which way it faces at the end, and how far round from that it starts. */
  face: number;
  spin: number;
  start: number;
  duration: number;
  height: number;
  landed: boolean;
}

/** A taken stone waiting in a drawer: it shows once its drawer is out. */
interface Waiting {
  puppet: Puppet;
  at: Vector3;
  drawer: DrawerName;
  shown: boolean;
}

export class Opening {
  readonly pose: CasePose = openPose();
  /** True while the case stands shut and empty, waiting for a game. */
  packed = false;
  private mode: Unpacking = 'none';
  private time = 0;
  private end = 0;
  private flights: Flight[] = [];
  private waiting: Waiting[] = [];
  private done: (() => void) | null = null;
  /** Which of the timeline's one-off moments have passed. */
  private passed = new Set<string>();
  /** The stones of the game before, while a new one is being set up. */
  private before: Remembered[] = [];

  constructor(
    private pieces: PieceLayer,
    public cues: OpeningCues = {},
  ) {}

  /** Whether an opening is under way. */
  get running(): boolean {
    return this.done !== null;
  }

  /** How long the opening under way lasts in all, in seconds; 0 when none is. */
  get duration(): number {
    return this.running ? this.end : 0;
  }

  /** Shut the case at once and put the stones away, to wait for a game. */
  pack(): void {
    this.finish();
    Object.assign(this.pose, shutPose());
    this.packed = true;
    this.showStones(false);
  }

  /**
   * Set the stones of the position just stood (by PieceLayer.reset and the hands' seatTaken)
   * out of the case. 'full' needs a shut case, and is 'short' without one. Resolves when the
   * last stone is down, or at once (null) for 'none'.
   */
  start(mode: Unpacking): Promise<void> | null {
    this.finish();
    if (mode === 'full' && !this.packed) mode = 'short';
    this.mode = mode;
    this.packed = false;
    if (mode !== 'short') this.before = [];
    if (mode === 'none') {
      this.settle();
      return null;
    }
    this.time = 0;
    this.passed.clear();
    this.plan(mode);
    this.showStones(true);
    if (mode === 'full') Object.assign(this.pose, shutPose());
    this.apply();
    return new Promise<void>((resolve) => (this.done = resolve));
  }

  /**
   * Note where every stone stands now, before the position is replaced, so that the next 'short'
   * opening can put them back into the drawers before it brings the new position out.
   */
  remember(): void {
    this.finish();
    this.before = [];
    if (this.packed || !this.pieces.root.visible) return;
    const note = (p: Puppet, board: boolean) => {
      if (!p.group.visible) return;
      this.before.push({ side: p.side, kind: p.kind, at: p.group.position.clone(), face: p.group.rotation.y, board });
    };
    for (const p of this.pieces.standing()) note(p, true);
    for (const p of this.pieces.taken()) note(p, false);
  }

  /** Jump to the end of the opening under way, if there is one. */
  finish(): void {
    if (!this.done) return;
    this.settle();
  }

  /** Advance by `dt` seconds. */
  update(dt: number): void {
    if (!this.done) return;
    this.time += dt;
    this.apply();
    if (this.time >= this.end) this.settle();
  }

  // -- internals ------------------------------------------------------------

  /** Work out where each stone comes from and when it flies. */
  private plan(mode: Unpacking): void {
    const short = mode === 'short';
    const returning = short && this.before.length > 0;
    const stream = short ? (returning ? RETURN + SHORT_STREAM : SHORT_STREAM) : STREAM;
    const flights: Flight[] = [];
    for (const puppet of this.pieces.standing()) {
      this.pieces.hold(puppet.id);
      const to = puppet.group.position.clone();
      const half = puppet.side === 'w' ? 1 : -1;
      const east = to.x >= 0 ? 1 : -1;
      // Out of the drawer on its own side of its own half, from about level with its square.
      const along = Math.min(DRAWER_FAR - 0.35, Math.max(DRAWER_NEAR + 0.35, Math.abs(to.z) + 0.25));
      const from = new Vector3(east * TRAY_X, PLINTH_TOP, half * along);
      const distance = Math.hypot(to.x - from.x, to.z - from.z);
      flights.push({
        puppet,
        back: null,
        from,
        to,
        face: puppet.group.rotation.y,
        spin: -east * half * 0.9,
        start: 0,
        duration: (short ? 0.36 : 0.5) + (short ? 0.025 : 0.04) * distance,
        height: (short ? 0.7 : 0.95) + 0.1 * distance + 0.25 * (puppet.kind === 'k' ? 1 : 0),
        landed: false,
      });
    }
    // Pawns first, the kings last; within a kind, the four drawers by turns, nearest the middle first.
    const drawerOf = (f: Flight) => (f.to.z > 0 ? 2 : 0) + (f.to.x > 0 ? 1 : 0);
    flights.sort((a, b) => ORDER[a.puppet.kind]! - ORDER[b.puppet.kind]! || Math.abs(a.to.x) - Math.abs(b.to.x) || drawerOf(a) - drawerOf(b));
    if (returning) this.planReturn(flights);
    const kings = flights.filter((f) => f.puppet.kind === 'k');
    const rest = flights.filter((f) => f.puppet.kind !== 'k');
    const span = short ? 0.75 : 1.3;
    const gap = rest.length > 1 ? Math.min(short ? 0.04 : 0.07, span / (rest.length - 1)) : 0;
    rest.forEach((f, i) => (f.start = stream + i * gap));
    const last = rest.length > 0 ? rest[rest.length - 1]!.start + (short ? 0.1 : 0.22) : stream;
    kings.forEach((f) => (f.start = last));
    this.flights = flights;

    this.before = [];
    this.waiting = [];
    for (const puppet of this.pieces.taken()) {
      const at = puppet.group.position.clone();
      const drawer = `${at.z > 0 ? 'lid' : 'void'}_${at.x > 0 ? 'e' : 'w'}` as DrawerName;
      this.waiting.push({ puppet, at, drawer, shown: false });
    }

    const landing = Math.max(stream, ...flights.map((f) => f.start + f.duration));
    this.end = short ? landing + 0.15 : Math.max(landing + 0.3, DRAWERS + 3 * 0.08 + DRAWER_TIME + 0.2);
    for (const f of flights) this.place(f, -1);
  }

  /**
   * Give each stone of the new position one of the game before to be, of its own side and kind
   * and the nearest that is left: that stone goes back into the drawer it will come out of (or,
   * taken, waits in its drawer), and this one comes out from there. A stone of the game before
   * with none of its kind to be (a queen a pawn was made into) is given a stone of its side that
   * has nothing else to be (the pawn that was missing), so that it goes back too and does not
   * simply vanish: it is a pawn again as it goes.
   */
  private planReturn(flights: Flight[]): void {
    const left = [...this.before];
    // The taken first, so that a stone waiting in a drawer is used before one on the board.
    left.sort((a, b) => Number(a.board) - Number(b.board));
    for (const kindly of [true, false]) {
      for (const f of flights) {
        if (f.back) continue;
        let best = -1;
        let near = Infinity;
        for (const [i, r] of left.entries()) {
          if (r.side !== f.puppet.side || (kindly && r.kind !== f.puppet.kind)) continue;
          const d = (r.board ? 10 : 0) + r.at.distanceTo(f.to);
          if (d < near) {
            near = d;
            best = i;
          }
        }
        if (best < 0) continue;
        const r = left.splice(best, 1)[0]!;
        if (!r.board) {
          // It waits where it stands in its drawer, and leaves from there.
          f.from = r.at.clone();
          f.back = { at: r.at, face: r.face, start: 0, duration: 0, stays: true, landed: true };
          continue;
        }
        f.back = { at: r.at, face: r.face, start: 0, duration: 0.22 + 0.02 * Math.hypot(r.at.x - f.from.x, r.at.z - f.from.z), stays: false, landed: false };
      }
    }
    // The stones on the board go back the outer files first, quickly, one after another.
    const going = flights.filter((f) => f.back && !f.back.stays).sort((a, b) => Math.abs(b.back!.at.x) - Math.abs(a.back!.at.x));
    const last = Math.max(0, ...going.map((f) => f.back!.duration));
    const gap = going.length > 1 ? (RETURN - last) / (going.length - 1) : 0;
    going.forEach((f, i) => (f.back!.start = i * gap));
  }

  /** Put everything where it is at the current time. */
  private apply(): void {
    const t = this.time;
    if (this.mode === 'full') {
      this.pose.clasp = claspAt(t);
      this.pose.lid = lidAt(t);
      DRAWER_NAMES.forEach((name, i) => (this.pose.drawers[name] = drawerAt(t - DRAWERS - 0.08 * i)));
      this.once('clasp', CLASP, () => this.cues.clasp?.());
      this.once('swing', SWING, () => this.cues.swing?.(DOWN - SWING));
      this.once('lands', DOWN, () => this.cues.lands?.(1));
      this.once('bounce', DOWN + BOUNCE, () => this.cues.lands?.(0.3));
      DRAWER_NAMES.forEach((name, i) => this.once(`drawer ${name}`, DRAWERS + 0.08 * i, () => this.cues.drawer?.(name)));
      this.once('hands', Math.max(DOWN + 0.6, this.end - 0.55), () => this.cues.hands?.());
    } else {
      Object.assign(this.pose, openPose());
    }
    for (const f of this.flights) this.place(f, t);
    for (const w of this.waiting) {
      const out = this.pose.drawers[w.drawer];
      const g = w.puppet.group;
      // A taken stone rides its drawer out, and rises into sight once the drawer is open.
      g.position.set(w.at.x - Math.sign(w.at.x) * (1 - out), w.at.y, w.at.z);
      const k = clamp01((out - 0.75) / 0.25);
      g.visible = k > 0;
      g.scale.setScalar(Math.max(1e-3, Easing.outCubic(k)));
    }
  }

  /** One stone at a time `t` into the opening (or before its flight, for t < 0). */
  private place(f: Flight, t: number): void {
    const g = f.puppet.group;
    const u = (t - f.start) / f.duration;
    if (u <= 0 && f.back) {
      this.goBack(f, f.back, t);
      return;
    }
    if (u <= 0) {
      // Still in its drawer, out of sight.
      g.visible = false;
      g.position.copy(f.from);
      g.scale.setScalar(1e-3);
      return;
    }
    if (u >= 1) {
      g.visible = true;
      g.position.copy(f.to);
      g.rotation.set(0, f.face, 0);
      g.scale.setScalar(1);
      if (!f.landed) {
        f.landed = true;
        this.pieces.land(f.puppet.id, f.puppet.kind === 'k' ? 1.2 : 0.8);
        this.cues.knock?.(f.to, f.puppet.side === 'w', WEIGHT[f.puppet.kind] ?? 1);
      }
      return;
    }
    g.visible = true;
    if (f.back?.stays) {
      // A taken stone, already up out of its drawer: it lifts off as it is.
      const e = Easing.inOutSine(u);
      g.position.set(lerp(f.from.x, f.to.x, e), lerp(f.from.y, f.to.y, u) + f.height * 4 * u * (1 - u), lerp(f.from.z, f.to.z, e));
      g.rotation.set(0, lerp(f.back.face, f.face, Easing.outCubic(u)), 0);
      g.scale.setScalar(1);
      return;
    }
    // Never a straight line: it eases out of the drawer and into its square, and arcs between.
    const e = Easing.inOutSine(u);
    g.position.set(lerp(f.from.x, f.to.x, e), lerp(f.from.y, f.to.y, u) + f.height * 4 * u * (1 - u), lerp(f.from.z, f.to.z, e));
    g.rotation.set(0, f.face + f.spin * (1 - Easing.outCubic(u)), 0);
    // It comes up out of the drawer as it leaves it.
    g.scale.setScalar(0.45 + 0.55 * Easing.outCubic(clamp01(u / 0.3)));
  }

  /** A stone of the game before, on its way back into its drawer (or waiting in it). */
  private goBack(f: Flight, b: Return, t: number): void {
    const g = f.puppet.group;
    const u = b.duration > 0 ? (t - b.start) / b.duration : 1;
    if (b.stays || u <= 0) {
      // Where it stood.
      g.visible = true;
      g.position.copy(b.at);
      g.rotation.set(0, b.face, 0);
      g.scale.setScalar(1);
      return;
    }
    if (u >= 1) {
      // In its drawer, out of sight till it comes out again.
      g.visible = false;
      g.position.copy(f.from);
      g.scale.setScalar(1e-3);
      if (!b.landed) {
        b.landed = true;
        // A soft clatter as they go in: every other stone is heard.
        if (f.puppet.id % 2 === 0) this.cues.knock?.(f.from, f.puppet.side === 'w', 0.4 * (WEIGHT[f.puppet.kind] ?? 1));
      }
      return;
    }
    g.visible = true;
    const e = Easing.inOutSine(u);
    g.position.set(lerp(b.at.x, f.from.x, e), lerp(b.at.y, f.from.y, u) + 0.7 * 4 * u * (1 - u), lerp(b.at.z, f.from.z, e));
    g.rotation.set(0, b.face + 0.6 * Easing.inCubic(u), 0);
    // It sinks into the drawer as it reaches it.
    g.scale.setScalar(1 - 0.55 * Easing.inCubic(clamp01((u - 0.6) / 0.4)));
  }

  private once(name: string, at: number, act: () => void): void {
    if (this.time < at || this.passed.has(name)) return;
    this.passed.add(name);
    act();
  }

  /** The end of it: case open, every stone on its square or in its drawer, and the promise kept. */
  private settle(): void {
    Object.assign(this.pose, openPose());
    for (const f of this.flights) {
      const g = f.puppet.group;
      g.visible = true;
      g.position.copy(f.to);
      g.rotation.set(0, f.face, 0);
      g.scale.setScalar(1);
    }
    for (const w of this.waiting) {
      w.puppet.group.visible = true;
      w.puppet.group.position.copy(w.at);
      w.puppet.group.scale.setScalar(1);
    }
    this.flights = [];
    this.waiting = [];
    this.packed = false;
    this.showStones(true);
    const done = this.done;
    this.done = null;
    done?.();
  }

  private showStones(on: boolean): void {
    this.pieces.root.visible = on;
    this.pieces.contact.mesh.visible = on;
  }
}

/** How long after the lid first comes down it comes down again, smaller. */
const BOUNCE = 0.17;

/** The clasp: pressed up a hair as the lid is eased off it, then let go to swing down and rock on its pin. */
export function claspAt(t: number): number {
  if (t <= 0) return SHUT;
  if (t < CLASP) return SHUT + 0.07 * Easing.inOutSine(t / CLASP);
  const fall = 0.3;
  if (t < CLASP + fall) return (SHUT + 0.07) * (1 - Easing.inCubic((t - CLASP) / fall) ** 0.8);
  const s = t - CLASP - fall;
  return 0.24 * Math.exp(-5 * s) * Math.abs(Math.sin(11 * s));
}

/**
 * The lid: lifted a little and held, as a hand takes its weight; then over, slow at the top and
 * fastest as it falls; down on the altar with its weight, up a hair, and down again.
 */
export function lidAt(t: number): number {
  if (t <= LIFT) return SHUT;
  if (t < SWING) return SHUT - 0.07 * Easing.inOutSine((t - LIFT) / (SWING - LIFT));
  if (t < DOWN) {
    const k = (t - SWING) / (DOWN - SWING);
    return (SHUT - 0.07) * (1 - (0.3 * Easing.inOutSine(k) + 0.7 * k * k));
  }
  const s = t - DOWN;
  return 0.05 * Math.exp(-6 * s) * Math.abs(Math.sin((Math.PI * s) / BOUNCE));
}

/** A drawer, `t` seconds after it starts: out with a little too much, and back. */
export function drawerAt(t: number): number {
  if (t <= 0) return 0;
  const k = clamp01(t / DRAWER_TIME);
  const c1 = 0.9;
  return 1 + (c1 + 1) * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}
