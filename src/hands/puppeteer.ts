/**
 * One player's pair of hands, and everything they do to a piece.
 *
 * Each arm follows a goal (where to be, how to be turned) on a critically
 * damped spring, so it eases in and out of everything by construction and
 * can be given a new goal at any moment without a jump. A move is a short
 * script that sets goals and waits: reach, close, lift, carry, set, release,
 * withdraw, to the timings in the style bible (6.4).
 *
 * A grip is fitted to the piece in hand at run time. The piece's own data
 * says where it should be held and how wide it is there; the hand is placed
 * so that point sits between its fingertips, and each gripping finger is
 * bent until its pad touches the piece.
 */
import { Group, Quaternion, Vector3 } from 'three';
import type { Side } from '../core/game';
import { FIELD_HALF, RIM_TOP, SLAB_HALF } from '../scene/layout';
import { PIECE_HEIGHT } from '../scene/pieceShapes';
import type { Puppet } from '../scene/pieces';
import { Spring, Spring3 } from '../scene/spring';
import { type Ease, Easing, type Tweens } from '../scene/tween';
import { ballsOf, chart, DROOP, type Flight, FOLLOW, type Posture, sunk, TRAIL } from './flight';
import { Girth } from './girth';
import { Hand, type HandTemplate, PALM_FOCUS, POSES } from './hand';
import { RIM } from './material';
import { type FingerName, FINGERS, fingerOf, type Pose, setFinger } from './rig';
import { Threads } from './threads';

/** Where and how a piece is meant to be held. Comes from the piece's own data (assets/src/pieces.py). */
export interface PieceGrip {
  type: 'pinch' | 'wrap' | 'hook' | 'tripod';
  /** Height of the grip above the piece's foot, and half its width there. */
  y: number;
  half: number;
  /** How far forward of the piece's centre line the grip is (the knight's overhang). */
  z?: number;
}

interface GripSpec {
  /** Where the middle of the gripped part sits, in hand space. */
  centre: Vector3;
  /** How far the hand is tipped fingers-down. */
  pitch: number;
  /** The direction from the thumb's contact to the fingers', as an angle from straight ahead toward the little finger. */
  axis: number;
  /** The roll of the thumb that brings its pad round to face the fingers. */
  twist: number;
  /** Where each gripping finger touches, as an angle round the piece from the grip axis. */
  contacts: Partial<Record<FingerName, number>>;
}

// Found by searching for the placement at which every gripping finger reaches its contact with
// relaxed bends, across the widths of the pieces that use each grip; and for the roll of the thumb
// at which its pad, not its back or its side, is what faces the piece there.
const PINCH: GripSpec = {
  centre: new Vector3(-0.47, -1.3, -1.86),
  pitch: 0.5,
  axis: 0.3,
  twist: -1.8,
  contacts: { thumb: Math.PI, index: -0.3, middle: 0.3 },
};
const GRIPS: Record<PieceGrip['type'], GripSpec> = {
  pinch: PINCH,
  // The hook under the knight's overhang is a pinch taken a little further forward.
  hook: PINCH,
  tripod: {
    centre: new Vector3(-0.37, -1.3, -1.86),
    pitch: 0.6,
    axis: 0.3,
    twist: -1.8,
    contacts: { thumb: Math.PI, index: -0.9, middle: 0.9 },
  },
  wrap: {
    centre: new Vector3(0.2, -1.1, -1.5),
    pitch: 0.3,
    axis: -0.3,
    twist: -1.3,
    contacts: { thumb: Math.PI + 0.5, index: -0.75, middle: -0.25, ring: 0.25, little: 0.75 },
  },
};

interface Held {
  puppet: Puppet;
  grip: PieceGrip;
  spec: GripSpec;
  /** The heading the hand had when it took hold; it keeps it until it lets go. */
  yaw: number;
  /** True once the piece moves with the hand, false while the fingers are still closing on it. */
  attached: boolean;
  /** 1 is a grip exactly as wide as the piece; a little less squeezes it. */
  squeeze: number;
  /** The piece's own heading, kept while it is carried. */
  facing: number;
  /**
   * How far from the middle of the grip the stone really is where each gripping finger comes to it
   * (a head with flats and corners is not a circle), so that each pad is sent to the stone itself.
   */
  reach: Partial<Record<FingerName, number>>;
}

/** A way of taking hold of a piece that has been settled on: by which part of it, the hand tipped how far, the fingers opened how wide to come down on it. */
interface Hold {
  grip: PieceGrip;
  spec: GripSpec;
  pitch: number;
  gap: number;
  /** The fingers that take no part come down folded all the way in: there is little room round the piece. */
  tucked: boolean;
}

/**
 * How far above where it would hold a piece a hand hovers in thought, and at least how far above
 * the top of it; how far clear of every stone it keeps as it hovers, and how much higher it will go
 * to do so.
 */
const HOVER = 0.62;
const HOVER_OVER = 0.28;
const HOVER_CLEAR = 0.04;
const HOVER_MORE = 0.6;
/** How far clear of a piece the fingers that would take it hang round it, while the hand is in thought over it. */
const POISE = 0.3;
/** An arm that has less far than this to go across the board goes straight there; farther, it crosses over what stands between. */
const NEAR = 0.5;
/**
 * Where a hand rests: this far out from the middle of the board, this high and this far back from
 * it, which is over the corner of the plinth on its own side and above the candles that burn there;
 * and how far round it lies there, in across the corner, its arm coming in from outside it. A hand
 * that pointed straight up the board would be seen end on from behind its player's shoulder, a lump
 * in the corner of the picture. Lying in across the corner it is seen for what it is. It is as high
 * as it is for its fingers, which hang, to stay a finger's breadth clear of the tallest flame
 * however the hand drifts.
 */
const REST_OUT = 5.05;
const REST_HIGH = 1.65;
const REST_BACK = 6;
const LIES_IN = 0.72;
/** How far a resting hand leans in toward the board, and rises, when its player is to move; and how far it sinks when they are not. */
const LEANS_IN = 0.1;
const LEANS_UP = 0.13;
const SITS_LOW = 0.03;
/**
 * How far a waiting hand draws back along its own length as it stretches its fingers out: most of
 * how much farther they reach, so that stretched they are still short of the squares.
 */
const DRAWS_BACK = 0.5;
/** How far clear of the stone the fingers open to come down on a piece, at the least; and how much farther to let it go. */
const OPEN = 0.2;
const LETS_GO = 0.05;
/** How far off the stone a finger that has let go of it is, at the least. */
const OFF = 0.04;
/** How far a hand that has let go of a piece rises straight up before it draws away: its fingers are round the piece still. */
const OFF_PLUMB = 0.6;
/**
 * How far its fingers may tip down as it rises from among stones (see DROOP), in the order they are
 * tried; and how far clear of the stones round about, felt by the hand's balls, that must leave them.
 */
const DROOPS = [DROOP, 0.12, 0.08, 0.04];
const DROOP_CLEAR = 0.03;
/**
 * The tilts a hand may take hold at, as differences from the one its grip would have, in the order
 * they are tried; the least and the most it may be tipped; the shares of the room they would like
 * that its fingers may make do with where pieces stand close; and how deep in a stone still counts
 * as clear of it.
 */
const TILTS = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, 0.5];
const TILT_LEAST = 0;
const TILT_MOST = 1.05;
/**
 * Where two hands must work in one place, one reaches over and the other goes under: the tilts each
 * may take hold at, in the order they are tried. Tipped steeply, a hand stands over its piece and its
 * arm is high above the board; held flat, it lies low behind the piece.
 */
const STEEP = [0.85, 0.95, 0.75, 1.05, 0.65, 0.55, 0.45, 0.35];
const FLAT = [0.15, 0.05, 0.25, 0.35, 0.45, 0.55];
const ROOMS = [1, 0.6, 0.3];
const GRAZE = 0.01;
/** A hand that would come down with its idle fingers nearer than this to a stone, felt by its balls, folds them in first. */
const TUCK_ROOM = 0.02;
/** The heights above where it takes hold at which a hand coming down, or going up, is tried against what stands there. */
const ABOVE = [0.15, 0.3, 0.5, 0.75, 1];
/**
 * A piece that fills the hand may be held by its head instead: the part of it that is at least this
 * share as thick as where it asks to be held, if that is at least this much higher up.
 */
const HEAD_THICK = 0.6;
const HEAD_HIGHER = 0.15;
/** Two stones nearer than this, seen from above, are in the same place: one of them is on its way out of it. */
const SAME_PLACE = 0.3;
/** How quickly a hand on a crossing turns to the way it should be heading: the stiffness of the spring its heading follows on. */
const TURNS = 24;
/** A crossing made in a hurry: quickly away, and slowing all the way in. */
const dart: Ease = (k) => {
  const u = Math.pow(k, 0.75);
  return u * u * (3 - 2 * u);
};

const UP = new Vector3(0, 1, 0);
const AXIS_X = new Vector3(1, 0, 0);
const v1 = new Vector3();
const v2 = new Vector3();
const v3 = new Vector3();
const vBall = new Vector3();
const q1 = new Quaternion();
const q2 = new Quaternion();

/** One arm: a hand, where it rests, and what it is doing. */
class Arm {
  readonly hand: Hand;
  readonly threads: Threads;
  /** Where the palm hovers when the arm has nothing to do. */
  readonly home = new Vector3();
  /** Where the steered point of the hand is, and which point of the hand that is. */
  readonly at = new Spring3();
  readonly focus = new Spring3();
  readonly pitch = new Spring();
  readonly roll = new Spring();
  readonly yaw = new Spring();
  /** How quickly the arm closes on its goal. Set by whatever is directing it. */
  omega = 9;
  /** True while a move is being played with this arm. */
  busy = false;
  /** How many pieces it has been sent to carry: what is left running from one can tell that another has overtaken it. */
  jobs = 0;
  held: Held | null = null;
  /** The piece this arm is hovering over in thought, if any, and how far the hand is tipped over it. */
  considering: { puppet: Puppet; grip: PieceGrip; pitch: number; lift: number } | null = null;
  /** How far the hand has been brought into the room, 0 to 1. Scales its body; its line is faded separately. */
  presence = 1;
  /** Scratch for whoever asks where this arm is. */
  readonly watchPoint = new Vector3();
  /** True while it is this arm's player who is to move. */
  attentive = false;
  /** How far back along its own length the hand is drawn from where it rests, 0 to 1: see DRAWS_BACK. */
  drawn = 0;
  /**
   * Where a gesture has the hand, from where it would otherwise rest: in toward the middle of its
   * player's side of the board (x, so that a negative x is out), up (y) and in toward the board
   * (z); and how far it has tipped its fingers down and rolled its thumb side down.
   */
  readonly swayed = new Vector3();
  tip = 0;
  turn = 0;
  /** The least light a gesture will have the hand give, 0 to 1 (see Hand.energy). */
  glow = 0;
  /** What has been asked of the arm, counted: a gesture that finds the count moved on has been overtaken. */
  acts = 0;
  /** The same for what has been asked of `swayed` and the rest. */
  leans = 0;
  /** How many gestures have been asked of the arm and are waiting their moment: it is not to be given a lesser one meanwhile. */
  pending = 0;
  /** True while a gesture is being made, and while that gesture has the hand somewhere of its own choosing and not about where it rests. */
  gesturing = false;
  acting = false;
  /**
   * True while a gesture has some of the hand's fingers set down on something that is not a piece
   * (the rail of the case, the other hand's fingertips, the crown of a stone it is pushing over); and
   * a count of the times they have been, so that a letting go that has been overtaken stops.
   */
  planted = false;
  plants = 0;
  /** How far a hand in thought has come down toward the stone it is over, from where it hangs: see `Puppeteer.adjust`. */
  dip = 0;
  /** How much farther from where it would rest a hand keeps, upward: one that has been burned (see `Puppeteer.warm`). */
  wary = 0;
  /** A piece the hand hangs over as it would in thought, threads and all, though nobody is thinking: see `Puppeteer.tip`. */
  musing: { puppet: Puppet; grip: PieceGrip } | null = null;
  /** True while the gesture the arm is making is one that only passes the time (on the rail, or with the other hand): a move by anybody ends it. */
  idling = false;
  /** True while a gesture needs the hand's fingers exactly where it puts them: they do not breathe or fidget (hand.ts, `restless`) until it is over. */
  steady = false;
  /**
   * The way a gesture has the hand point, in the room, whatever the way it reaches out from its
   * shoulder: a turn of the wrist only, so its forearm does not come round with it, and as quick
   * as the arm has been told to be. Null when it turns as it reaches. Any crossing or going ends it.
   */
  aim: number | null = null;
  /**
   * How far down the fingers may tip as the wrist leads them up (see DROOP): less, while the hand
   * rises from among stones that stand too close for it, until the crossing it is on is over.
   */
  droops = DROOP;
  /** How solid the hand's body is. A hand in thought is smoked glass, so the board shows through it. */
  private solid = new Spring();
  /** How lit the hand is: see Hand.energy. */
  private energy = new Spring();
  private swing = new Spring3();
  private pads = [new Vector3(), new Vector3(), new Vector3()];
  private ends = [new Vector3(), new Vector3(), new Vector3()];
  private threadStrength = new Spring();
  /** The crossing the arm is making, if it has far to go (flight.ts), and how that says to hold the hand just now. */
  private flight: Flight | null = null;
  private posture: Posture = { focus: new Vector3(), pitch: 0, loose: 1 };
  /** How loose the wrist is: see Posture. */
  private loose = 1;
  /** How far round the hand lies where it is held, when it is not on a crossing (see Posture), and how far its forearm has swung round with it. */
  private askew = 0;
  private swung = new Spring();
  /** How much at its ease the hand is: see Hand.ease. And where in its breath it began. */
  private calm = new Spring();
  private breath: number;

  /** How strongly the threads are drawn, 0 to 1. */
  get threading(): number {
    return this.threadStrength.value;
  }

  constructor(template: HandTemplate, side: Side, mirrored: boolean, seed: number) {
    this.hand = new Hand(template, side, mirrored, seed);
    this.threads = new Threads(RIM[side]);
    this.solid.snap(1);
    this.breath = (seed * 2.399 + (mirrored ? 1.3 : 0)) % (Math.PI * 2);
  }

  /**
   * Cross to `to` in `seconds`, there to be held as `held`: up off whatever the hand is over, across
   * above every one of `stones` that stands in its way, and down. `poses` are the shapes its fingers
   * will take on the way. `others` is what else it must pass above, and `plumb` how far it goes
   * straight up before anything else (flight.ts).
   */
  fly(to: Vector3, held: Posture, seconds: number, ease: Ease, poses: Pose[], stones: Iterable<Puppet>, others?: number[], plumb = 0): void {
    const start = { focus: this.focus.get(new Vector3()), pitch: this.pitch.value, loose: this.loose, askew: this.swung.value };
    this.flight = chart(this.hand, this.at.get(new Vector3()), to, start, held, poses, stones, seconds, ease, this.at.speed(new Vector3()), others, this.yaw.value, plumb);
    this.roll.goal = 0;
    this.aim = null;
  }

  /** The hand as balls in the room, where it is going or, if it is going nowhere, where it is: what the player's other hand has to pass above. */
  inTheWay(): number[] {
    const flight = this.flight;
    const at = flight ? flight.to : this.at.goal(new Vector3());
    const held: Posture = flight ? flight.end : { focus: this.focus.goal(new Vector3()), pitch: this.pitch.goal, loose: 0, askew: this.askew };
    return ballsOf(this.hand, at, held, this.held ? this.held.yaw : this.hand.headingTo(at) + (held.askew ?? 0), this.hand.pose);
  }

  /** True while the arm is on a crossing: it is held as the crossing has it, and nothing else may sway it. */
  get crossing(): boolean {
    return this.flight !== null;
  }

  /** Go straight to `to`, there to be held as `held`: it is too near for anything to stand in the way. */
  go(to: Vector3, held: Posture): void {
    this.flight = null;
    this.at.setGoal(to);
    this.focus.setGoal(held.focus);
    this.pitch.goal = held.pitch;
    this.loose = held.loose;
    this.askew = held.askew ?? 0;
    this.roll.goal = 0;
    this.aim = null;
  }

  /** The place the arm is making for, or is at, has moved a little. */
  shift(to: Vector3, pitch: number): void {
    if (this.flight) {
      this.flight.to.copy(to);
      this.flight.end.pitch = pitch;
    } else {
      this.at.setGoal(to);
      this.pitch.goal = pitch;
    }
  }

  /** Whatever crossing the arm was making is over: what is left of the way, it simply closes. */
  land(): void {
    const flight = this.flight;
    if (!flight) return;
    this.flight = null;
    this.at.setGoal(flight.to);
    this.focus.setGoal(flight.end.focus);
    this.pitch.goal = flight.end.pitch;
    this.loose = flight.end.loose;
    this.askew = flight.end.askew ?? 0;
  }

  /** Be at the goal now, with no travel. */
  snap(): void {
    this.land();
    for (const s of [this.at, this.focus]) s.snap(s.goal(v1));
    this.pitch.snap(this.pitch.goal);
    this.roll.snap(this.roll.goal);
    this.yaw.snap(this.hand.headingTo(this.at.goal(v1)) + this.askew);
    this.swung.snap(this.askew);
  }

  /** Where the middle of a piece's grip is in the world. */
  gripPoint(puppet: Puppet, grip: PieceGrip, out: Vector3): Vector3 {
    puppet.group.updateMatrixWorld();
    return puppet.group.localToWorld(out.set(0, grip.y, grip.z ?? 0));
  }

  /** Where a hand hovers over a piece in thought: above where it would hold it, and clear of the top of it; `lift` higher than that. */
  hoverPoint(puppet: Puppet, grip: PieceGrip, lift: number, out: Vector3): Vector3 {
    const stone = Girth.of(puppet.group);
    const top = stone ? stone.girth.over(0, 1) - stone.mesh.worldToLocal(this.gripPoint(puppet, grip, out)).y : 0;
    this.gripPoint(puppet, grip, out);
    out.y += Math.max(HOVER, top + HOVER_OVER) + lift;
    return out;
  }

  /** The point on a piece that a finger touches in a grip: on the circle of the grip, round from the grip axis. */
  private contact(c: Vector3, spec: GripSpec, grip: PieceGrip, yaw: number, finger: FingerName, squeeze: number, tilt: Quaternion, out: Vector3): Vector3 {
    const around = spec.axis + spec.contacts[finger]!;
    // In the hand's own flat frame first; a left hand is the mirror image.
    out.set((this.hand.mirrored ? -1 : 1) * Math.sin(around), 0, -Math.cos(around)).multiplyScalar((this.held?.reach[finger] ?? grip.half) * squeeze);
    return out.applyAxisAngle(UP, yaw).applyQuaternion(tilt).add(c);
  }

  /**
   * Take the measure of a piece that is about to be held: where its stone is for each gripping
   * finger, and what the fingers must not sink into while they hold it.
   */
  feel(held: Held): void {
    const stone = Girth.of(held.puppet.group);
    if (!stone) return;
    const { girth, mesh } = stone;
    mesh.updateWorldMatrix(true, false);
    const centre = mesh.worldToLocal(this.gripPoint(held.puppet, held.grip, new Vector3()));
    for (const finger of FINGERS) {
      if (held.spec.contacts[finger] === undefined) continue;
      // The way this finger comes at the piece, in the piece's own space.
      const around = held.spec.axis + held.spec.contacts[finger]!;
      const way = v1.set((this.hand.mirrored ? -1 : 1) * Math.sin(around), 0, -Math.cos(around)).applyAxisAngle(UP, held.yaw);
      way.add(this.gripPoint(held.puppet, held.grip, v2));
      mesh.worldToLocal(way).sub(centre);
      const found = girth.across(centre, way.x, way.z, held.grip.half * 2.2);
      if (found > 0) held.reach[finger] = Math.max(held.grip.half * 0.6, found);
    }
    this.hand.obstacle = (ball, radius) => girth.depth(mesh.worldToLocal(vBall.copy(ball)), radius);
  }

  update(dt: number, time: number): void {
    const hand = this.hand;
    const flight = this.flight;
    if (flight) {
      flight.clock += dt;
      flight.now(v1, this.posture);
      this.at.setGoal(v1);
      this.focus.setGoal(this.posture.focus);
      this.pitch.goal = this.posture.pitch;
      this.loose = this.posture.loose;
      if (flight.over) {
        this.flight = null;
        this.askew = flight.end.askew ?? 0;
      }
    }
    // On a crossing the arm keeps close to the path that was worked out for it.
    const omega = flight ? Math.max(this.omega, FOLLOW) : this.omega;
    this.at.step(dt, omega);
    this.focus.step(dt, omega);
    this.pitch.step(dt, omega);
    this.roll.step(dt, omega);

    const at = this.at.get(v1);
    const held = this.held;
    const speed = this.at.speed(v2);
    // The hand keeps the heading it took hold with; otherwise it turns to reach out from the shoulder.
    // On a crossing it turns as the crossing has it turn (not while it is still in among what it has
    // let go of), and toward where it is about to be, since it turns after its goal on a spring too.
    // Where it rests it lies askew, and its forearm swings round with it.
    const aimed = this.aim !== null && !flight && !held;
    if (held) this.yaw.goal = held.yaw;
    else if (aimed) this.yaw.goal = nearestTurn(this.aim!, this.yaw.value);
    else this.yaw.goal = nearestTurn(flight ? hand.headingTo(v3.copy(at).addScaledVector(speed, 2 / TURNS)) + flight.askew : hand.headingTo(at) + this.askew, this.yaw.value);
    const turns = flight ? TURNS : Math.min(this.omega, 14);
    this.yaw.step(dt, held ? 40 : aimed ? this.omega : turns);
    this.swung.goal = flight ? flight.swung : this.askew;
    this.swung.step(dt, turns);
    hand.swing = this.swung.value;

    // The wrist leads: rising, it tips the fingers down a little (on a crossing, as far as that has
    // allowed for); moving sideways, it banks. Coming down, a loose wrist lets the fingers trail up;
    // one held over a piece does not, because that would swing the heel of the hand back into
    // whatever stands behind the piece.
    if (!flight && !this.busy) this.droops = DROOP;
    const lead = Math.max(-TRAIL * this.loose, Math.min(flight ? flight.droop : DROOP, this.droops, speed.y * 0.05));
    const across = speed.x * Math.cos(this.yaw.value) - speed.z * Math.sin(this.yaw.value);
    const bank = Math.max(-0.14, Math.min(0.14, across * 0.022));
    hand.place(at, this.focus.get(v3), this.yaw.value, this.pitch.value + lead, this.roll.value + bank);

    // A carried piece trails its foot behind the motion by a few degrees.
    const horizontal = Math.hypot(speed.x, speed.z);
    const lean = Math.min(0.105, horizontal * 0.024);
    this.swing.setGoal(horizontal > 1e-4 ? v3.set(speed.z, 0, -speed.x).multiplyScalar(lean / horizontal) : v3.set(0, 0, 0));
    this.swing.step(dt, 16);
    const tilt = q1.identity();
    const s = this.swing.get(v3);
    const angle = s.length();
    if (angle > 1e-5) tilt.setFromAxisAngle(v2.copy(s).divideScalar(angle), angle);

    if (held) {
      if (held.attached) {
        // The piece hangs from the grip point.
        const g = held.puppet.group;
        g.quaternion.setFromAxisAngle(UP, held.facing).premultiply(tilt);
        g.position.copy(at).sub(v2.set(0, held.grip.y, held.grip.z ?? 0).applyQuaternion(g.quaternion));
        // The fingers feel for the stone where it is now.
        g.updateMatrixWorld();
      }
      const c = held.attached ? at : this.gripPoint(held.puppet, held.grip, v2);
      for (const finger of FINGERS) {
        if (held.spec.contacts[finger] === undefined) continue;
        const target = (hand.touch[finger] ??= new Vector3());
        this.contact(c, held.spec, held.grip, held.yaw, finger, held.squeeze, held.attached ? tilt : q2.identity(), target);
      }
    }

    // In thought the body thins to smoked glass; the moment it acts it is solid again.
    this.solid.goal = this.considering && !this.busy ? 0.58 : 1;
    this.solid.step(dt, this.busy ? 26 : 9);
    hand.fill = this.solid.value * this.presence;
    // A hand whose player waits is dim and slow. It is half awake when the turn comes round (so
    // that the room shows whose turn it is), more when it hovers in thought, and is brightest
    // while it has a piece to move.
    this.energy.goal = Math.max(this.glow, this.busy ? 1 : this.considering ? 0.72 : this.attentive ? 0.5 : 0);
    this.energy.step(dt, this.busy ? 12 : 4);
    // A hand with nothing to do is at its ease, and breathes: its fingers (hand.ts), and its light
    // with them, a little brighter on each breath in. It stops the moment there is work, and comes
    // back slowly after.
    this.calm.goal = this.busy || flight ? 0 : 1;
    this.calm.step(dt, this.busy ? 14 : 2.2);
    hand.ease = Math.min(1, Math.max(0, this.calm.value));
    hand.energy = this.energy.value + hand.ease * 0.05 * (1 + Math.sin(time * 0.95 + this.breath));
    hand.update(dt, time);

    // Threads to the piece under thought.
    const thought = this.considering ?? this.musing;
    this.threadStrength.goal = thought && !held ? 1 : 0;
    this.threadStrength.step(dt, thought && !held ? 14 : 30);
    this.threads.strength = this.threadStrength.value * hand.outline;
    if (thought && this.threads.strength > 0.01) {
      const spec = GRIPS[thought.grip.type];
      const c = this.gripPoint(thought.puppet, thought.grip, v2);
      (['thumb', 'index', 'middle'] as FingerName[]).forEach((finger, i) => {
        hand.padWorld(finger, this.pads[i]!, true);
        this.contact(c, spec, thought.grip, this.yaw.value, finger, 1, q2.identity(), this.ends[i]!);
      });
    }
    this.threads.update(this.pads, this.ends, time);
  }
}

/** The equivalent of `angle` nearest to `reference`, so that a heading never spins the long way round. */
function nearestTurn(angle: number, reference: number): number {
  const turn = Math.PI * 2;
  return angle + Math.round((reference - angle) / turn) * turn;
}

/**
 * The fingers that take hold of a piece, each `gap` clear of the width it is held at, and off the
 * stone where it rested on it (`reach` says how far out that was, where it is known), and the thumb
 * rolled ready; the other fingers as `rest` has them. It is the grip itself, opened: no wider than
 * it has to be, because other pieces stand close by.
 */
function opened(hand: Hand, spec: GripSpec, grip: PieceGrip, pitch: number, gap: number, rest: Pose, reach: Partial<Record<FingerName, number>> = {}): Pose {
  const p = rest.slice() as Pose;
  for (const finger of FINGERS) {
    const round = spec.contacts[finger];
    if (round === undefined) continue;
    const seed = fingerOf(p, finger);
    if (finger === 'thumb') seed[4] = spec.twist;
    // Where it would touch, in the hand's own space: the hand is tipped fingers-down over the piece (hand.ts, place).
    const around = spec.axis + round;
    v1.set(Math.sin(around), 0, -Math.cos(around)).multiplyScalar(Math.max(grip.half + gap, (reach[finger] ?? 0) + OFF));
    setFinger(p, finger, hand.rig.reach(finger, v1.applyAxisAngle(AXIS_X, pitch).add(spec.centre), seed).angles);
  }
  return p;
}

/** How far clear of a piece the fingers must open to come down on it or to leave it: enough to pass the widest of it above where they hold it. */
function opening(arm: Arm, puppet: Puppet, grip: PieceGrip): number {
  const stone = Girth.of(puppet.group);
  if (!stone) return OPEN;
  stone.mesh.updateWorldMatrix(true, false);
  const above = stone.girth.widest(stone.mesh.worldToLocal(arm.gripPoint(puppet, grip, v1)).y);
  return Math.min(0.45, Math.max(OPEN, above - grip.half + 0.08));
}

/**
 * The parts of a piece it might be held by. The one it asks to be held by comes first. A piece that
 * fills the hand can also be taken by its head, from above: which can still be done when others
 * stand so close round it that fingers will not go down between them.
 */
function holds(puppet: Puppet, grip: PieceGrip): PieceGrip[] {
  const stone = Girth.of(puppet.group);
  if (grip.type !== 'wrap' || !stone) return [grip];
  const head = stone.girth.head(grip.half * HEAD_THICK);
  if (!head) return [grip];
  // From the stone's own space to the piece's.
  stone.mesh.updateWorldMatrix(true, false);
  const y = puppet.group.worldToLocal(stone.mesh.localToWorld(v1.set(0, head.y, 0))).y;
  return y > grip.y + HEAD_HIGHER ? [grip, { type: grip.type, y, half: head.half }] : [grip];
}

/** The tilts a hand may take hold at with a grip, in the order to try them: as the grip would have it and then more and less, or as the reach asked of it would. */
function tilts(spec: GripSpec, reach?: Reach): number[] {
  if (reach === 'over') return STEEP;
  if (reach === 'under') return FLAT;
  return TILTS.map((more) => Math.min(TILT_MOST, Math.max(TILT_LEAST, spec.pitch + more)));
}

/**
 * The pose of a hand in thought over a piece, tipped by `pitch`: the fingers that would take it
 * hang open round it, as they will be when they come down on it but wider, so that it is plain from
 * anywhere in the room which piece is meant. The other fingers trail in a loose curl.
 */
function poised(hand: Hand, spec: GripSpec, grip: PieceGrip, pitch: number): Pose {
  const p = POSES.hover.slice() as Pose;
  // Curled far enough that they do not seem to be reaching for something else.
  if (spec.contacts.ring === undefined) setFinger(p, 'ring', [0.9, 0.95, 0.62, -0.05, 0]);
  if (spec.contacts.little === undefined) setFinger(p, 'little', [0.82, 0.9, 0.58, -0.16, 0]);
  return opened(hand, spec, grip, pitch, POISE, p);
}

/**
 * The pose a hand tipped by `pitch` takes just before closing on a piece: the grip opened by `gap`,
 * thumb rolled ready. With `tucked`, the fingers that take no part are folded all the way in already.
 */
function pregrip(hand: Hand, spec: GripSpec, grip: PieceGrip, pitch: number, gap: number, tucked = false): Pose {
  const p = POSES.pregrip.slice() as Pose;
  // Fingers that take no part are already folded up as the hand comes down: at this size, left
  // hanging they would go in among the pieces standing round the one it has come for.
  if (spec.contacts.ring === undefined) setFinger(p, 'ring', tucked ? TUCKED.ring! : [1.1, 1.3, 0.8, -0.05, 0]);
  if (spec.contacts.little === undefined) setFinger(p, 'little', tucked ? TUCKED.little! : [1.0, 1.2, 0.74, -0.16, 0]);
  return opened(hand, spec, grip, pitch, gap, p);
}

/**
 * Where the fingers that take no part in a grip go once the others have closed: folded into the
 * palm, the little finger a shade less than the ring finger and held a little apart from it.
 */
/** How a hand is held as it comes into the room: half closed, the way a hand hangs that has not been used yet. */
const GATHERED: Pose = (() => {
  const p = POSES.relaxed.slice() as Pose;
  FINGERS.forEach((finger, n) => {
    if (finger === 'thumb') return;
    const at = fingerOf(p, finger);
    setFinger(p, finger, [at[0]! + 0.5 - n * 0.03, at[1]! + 0.55, at[2]! + 0.3, at[3]!, at[4]!]);
  });
  return p;
})();

const TUCKED: Partial<Record<FingerName, number[]>> = {
  ring: [1.25, 1.5, 0.9, -0.03, 0],
  little: [1.15, 1.4, 0.84, -0.14, 0],
};

/** Where along a knight's carry it turns the corner, as a share of the time it is on its way across: after the longer leg. */
const TURNS_AT = 0.62;

/**
 * The way round for a knight that is making a knight's move from `from` to `to`: how far it goes
 * first (the longer leg, as x and z; the shorter if it is going `back` the way it came), and how
 * long each leg is. Null for anything else.
 */
function knightsTurn(puppet: Puppet, from: Vector3, to: Vector3, back: boolean): { x: number; z: number; first: number; second: number } | null {
  if (puppet.kind !== 'n') return null;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const [long, short] = [Math.max(Math.abs(dx), Math.abs(dz)), Math.min(Math.abs(dx), Math.abs(dz))];
  if (Math.abs(long - 2) > 0.1 || Math.abs(short - 1) > 0.1) return null;
  const alongX = Math.abs(dx) > Math.abs(dz) !== back;
  const [first, second] = back ? [short, long] : [long, short];
  return alongX ? { x: dx, z: 0, first, second } : { x: 0, z: dz, first, second };
}

/** The top of a standing stone, in the room. */
function topOf(puppet: Puppet, out: Vector3): Vector3 {
  const stone = Girth.of(puppet.group);
  const p = puppet.group.position;
  if (!stone) return out.set(p.x, p.y + PIECE_HEIGHT[puppet.kind], p.z);
  puppet.group.updateWorldMatrix(true, true);
  return stone.mesh.localToWorld(out.set(0, stone.girth.over(0, 0), 0));
}

/**
 * The point on a standing stone's side, a share `up` of the way up it, on the side that `way` (level)
 * points to: and half a fingertip's thickness out from it, where the middle of a finger on it is.
 */
function sideOf(puppet: Puppet, way: Vector3, up: number, out: Vector3): Vector3 {
  const stone = Girth.of(puppet.group);
  const p = puppet.group.position;
  if (!stone) return out.set(p.x + way.x * 0.3, p.y + PIECE_HEIGHT[puppet.kind] * up, p.z + way.z * 0.3);
  puppet.group.updateWorldMatrix(true, true);
  const height = stone.girth.over(0, 0) * up;
  // The way, in the stone's own space.
  const foot = stone.mesh.worldToLocal(v2.copy(p));
  const toward = stone.mesh.worldToLocal(v3.copy(p).add(way)).sub(foot);
  const length = Math.hypot(toward.x, toward.z) || 1;
  const reach = stone.girth.at(height, toward.x, toward.z);
  stone.mesh.localToWorld(out.set((toward.x / length) * reach, height, (toward.z / length) * reach));
  return out.addScaledVector(way, TIP_HALF);
}

/** How far a point is from the stretch of floor between `a` and `b`. */
function offLine(p: Vector3, a: Vector3, b: Vector3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = dx * dx + dz * dz;
  const along = length > 1e-9 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length)) : 0;
  return Math.hypot(p.x - (a.x + dx * along), p.z - (a.z + dz * along));
}

/** How far a hand that makes way for the player's other hand draws off from where it would hang over its piece: out to its own side, up, and back toward its player. */
const STANDS_OFF = new Vector3(1.9, 0.5, 0.9);
/** How much higher than that it will go to be clear of what stands there, and by how much: enough to set off from there downward. */
const STANDS_CLEAR = 0.2;
const STANDS_OFF_MORE = 1.4;
/** The longest a hand waits for what it was told to wait for (see `CarryOptions.until`), in seconds past its delay. */
const WAITS_AT_MOST = 1.2;

/**
 * How the game stands for a player, as their hands show it: still being played, won, lost, or
 * drawn; drawn and not taking it well (the stalemate, endings.ts); or not there any more.
 */
export type Mood = 'play' | 'won' | 'lost' | 'drawn' | 'sulking' | 'gone';

/** How a hand is held apart from where and how it would rest: see Arm.swayed, and Arm.presence and Hand.outline. */
export interface Bearing {
  x: number;
  y: number;
  z: number;
  tip: number;
  turn: number;
  glow: number;
  presence: number;
  outline: number;
}

/**
 * How the hands are held once the game is over, for as long as it stays over. A winner's hang
 * high over their end of the board, lit. A loser's have sunk and drawn back, fingers hanging,
 * and are most of the way to not being there at all: a sketch of two hands in the dark.
 */
const BEARINGS: Record<Mood, Bearing> = {
  play: { x: 0, y: 0, z: 0, tip: 0, turn: 0, glow: 0, presence: 1, outline: 1 },
  won: { x: 0.4, y: 0.9, z: 0.5, tip: 0, turn: 0, glow: 0.6, presence: 1, outline: 1 },
  lost: { x: -0.3, y: -0.55, z: -0.7, tip: 0.5, turn: 0.1, glow: 0, presence: 0.22, outline: 0.42 },
  drawn: { x: 0, y: 0, z: 0, tip: 0, turn: 0, glow: 0, presence: 1, outline: 1 },
  // Out to its own side, a little up and back, rolled a little away: turned from the other player's, and not looking.
  sulking: { x: -0.35, y: 0.1, z: -0.25, tip: 0.1, turn: 0.3, glow: 0, presence: 1, outline: 1 },
  // Unmade (Hand.dissolve does the unmaking: this is only where nothing is).
  gone: { x: -0.3, y: -0.55, z: -0.7, tip: 0.5, turn: 0.1, glow: 0, presence: 0, outline: 0 },
};

/** The shape a player's hands rest in, for how the game stands for them. */
const restingFor = (mood: Mood): Pose => (mood === 'lost' || mood === 'gone' ? LIMP : POSES.relaxed);

/** A pose part of the way from one to another. */
function between(a: Pose, b: Pose, k: number): Pose {
  const p = a.slice() as Pose;
  for (let i = 0; i < p.length; i++) p[i] = a[i]! + (b[i]! - a[i]!) * k;
  return p;
}

/** A hand with nothing left in it: the fingers hang, each a little more than the one before. */
const LIMP: Pose = (() => {
  const p = POSES.relaxed.slice() as Pose;
  setFinger(p, 'thumb', [0.45, 0.35, 0.25, -0.1, 0.4]);
  setFinger(p, 'index', [0.55, 0.6, 0.4, 0.02, 0]);
  setFinger(p, 'middle', [0.7, 0.72, 0.48, 0, 0]);
  setFinger(p, 'ring', [0.82, 0.8, 0.52, -0.03, 0]);
  setFinger(p, 'little', [0.9, 0.8, 0.5, -0.08, 0]);
  return p;
})();
/** A draw offered: the hand turned palm up at its corner, open, a little up; not so far in that its fingers come near the stones. */
const OFFERED = between(POSES.relaxed, POSES.open, 0.6);
const OFFERING: Partial<Bearing> = { x: 0.15, y: 0.4, z: 0.1, tip: -0.05, turn: -2.75, glow: 0.45 };
/** A hand closed on what it has won: not a fist clenched, a hand shut. */
const CLAIMED = between(POSES.relaxed, POSES.fist, 0.85);

/**
 * A hand that points at a king in check hangs this far back from it, toward its own shoulder, and
 * this high (the point under its palm): its finger ends short of the king and above its crown.
 * And it is tipped this far, so that the finger points down at it.
 */
const POINTS_FROM = 2.2;
const POINTS_HIGH = 3.5;
const POINTS_TIP = 0.6;
/** A hand that has pointed at a king before points from this much farther back from it. */
const POINTS_LESS = 1.1;

/**
 * A hand that drums on the case does it on the rail at its player's own end: held this far out
 * from the middle, this high and this far back from the middle of the board, the fingers a little
 * up from level, turned this far in and rolled this far toward the little finger (which is short,
 * and would not reach). Then it comes down until the shortest of its fingers can get to the wood
 * with this much to spare, and back or forward until the fingertips, which lie in a bow as a
 * hand's do, have the middle of the rail under the middle of the bow. A finger's pad rests this
 * far above the wood (it has some thickness), and a finger that drums lifts this far.
 */
const RAIL_OUT = 3.4;
const RAIL_HIGH = 1.06;
const RAIL_BACK = 5.8;
const RAIL_PITCH = -0.1;
const RAIL_ASKEW = 0.3;
const RAIL_ROLL = -0.05;
const RAIL_MIDDLE = (FIELD_HALF + SLAB_HALF) / 2;
const RAIL_OFF = 0.035;
const RAIL_SPARE = 0.03;
/** It lifts this far off the rail before it goes. */
const RAIL_CLEAR = 0.45;
/** How far toward a fist a finger may be closed to bring its pad down on something: past this it is a claw. */
const ARCH_MOST = 0.7;
const RAIL_LIFT = 0.17;
/** The fingers that drum, in the order they come down. */
const DRUMMERS: FingerName[] = ['little', 'ring', 'middle', 'index'];
/** How a hand is held to drum: the fingers a little straighter than they hang, so that they come down together. */
const SETTLED = between(POSES.relaxed, POSES.open, 0.25);

/**
 * Two hands that meet fingertip to fingertip do it before their player's own end of the case, low,
 * where they stand in front of nothing: each held this far out from the middle to begin with, this
 * high and this far back from the middle of the board, the fingers rising by this much and turned
 * this far in from straight ahead, and the hands rolled this far, so that the palms face one
 * another, thumbs uppermost. Then they come together until the longest finger of each is this far
 * short of the other's, and every finger bends as far as brings it to its fellow: with the palms
 * facing, a finger that bends goes toward the other hand. Pressed together they come this much nearer.
 */
const STEEPLE_APART = 1.5;
const STEEPLE_HIGH = 0.55;
const STEEPLE_BACK = 6.9;
const STEEPLE_PITCH = -0.7;
const STEEPLE_IN = 0.4;
const STEEPLE_ROLL = -1.5;
const STEEPLE_PRESS = 0.1;
const STEEPLE_SHY = 0.05;
/** And for knuckles to be cracked, as much nearer as this, once: the fingers are bent well back. */
const KNUCKLE_PRESS = 0.2;
/** They come this near to one another with their fingers straight, before the fingers bend to meet. */
const STEEPLE_NEARLY = 0.3;
/** Half the thickness of a fingertip: how far from the middle each of two that meet is. */
const TIP_HALF = 0.03;
/** How the fingers are held for it: straight, but not stiff. */
const TENT = between(POSES.open, POSES.relaxed, 0.3);

/**
 * A stone that is to be rapped on its square first (the empty square) is brought down to this
 * high over it, held there this long, struck on it once and lifted this far off it again.
 */
const RAP_HIGH = 0.32;
const RAP_WAIT = 0.3;
const RAP_BACK = 0.1;
/** A stone held up at the top of its carry (the trophy) is lifted this much more, and lit by this much; and the carry takes this long to slow to a stop there, and as long to come up to speed again. */
const SHOWN_UP = 0.18;
const SHOWN_LIGHT = 1.3;
const SHOWN_SLOWS = 0.24;

/**
 * The time of a carry that slows to a stop at `top`, stands still for `show` seconds and comes back
 * up to speed, each in `slows` seconds, at `clock` seconds from its start: how far through the
 * carry's own course it is then.
 */
function slowed(clock: number, top: number, show: number, slows: number): number {
  if (clock < top) return clock;
  const u = (k: number) => Math.min(1, Math.max(0, k / slows));
  // Slowing: the speed falls away as cos², and half the time it would have taken goes by.
  if (clock < top + slows) return top + slows * (u(clock - top) / 2 + Math.sin(Math.PI * u(clock - top)) / (2 * Math.PI));
  if (clock < top + slows + show) return top + slows / 2;
  const k = u(clock - top - slows - show);
  return top + slows / 2 + slows * (k / 2 - Math.sin(Math.PI * k) / (2 * Math.PI)) + Math.max(0, clock - top - 2 * slows - show);
}
/** A hand that pats a stone's crown comes down on it from this high above it, tipped this far; and rises this far off the stone before it straightens its fingers. */
const PAT_LIFT = 0.13;
const PAT_PITCH = 0.3;
const PAT_RISE = 0.35;
/** And this much more, where the stone patted is not the one just let go of (the king, after its rook in castling). */
const PAT_RISE_BESIDE = 0.3;
/** How a hand pats: the fingers out and together, a little bent. */
const PATTING: Pose = (() => {
  const p = between(POSES.open, POSES.relaxed, 0.45);
  for (const finger of ['index', 'middle', 'ring', 'little'] as FingerName[]) {
    const at = fingerOf(p, finger);
    setFinger(p, finger, [at[0]!, at[1]!, at[2]!, at[3]! * 0.3, at[4]!]);
  }
  return p;
})();
/**
 * A stone that is pushed is pushed by a finger set this far up its back (as a share of its
 * height), the hand tipped this far. The finger comes to it from this much higher, and the push
 * takes this long.
 */
const PUSH_UP = 0.8;
const PUSH_PITCH = 1.05;
const PUSH_ABOVE = 0.3;
const PUSH_SECONDS = 0.5;
/** The tip of a finger that pushes is put this far short of the stone (the tip is where the bone ends, inside the flesh); and sent this far past where the push ends. */
const PUSH_SPARE = 0.012;
/** Before it straightens its finger, the hand draws this far up from where it hung over the stone. */
const PUSH_RISE = 0.35;
const PUSH_PAST = 0.03;
/** A hand that squares a stone up comes back for it once it is this long on its way home, and nudges it straight in this long. */
const SQUARE_AFTER = 0.35;
const NUDGE_SECONDS = 0.24;
/**
 * A hand that snaps its fingers does it this far over the stone it is snapping at (above its
 * crown) and this far back from it toward its own player, held on edge so that the snap is seen
 * side on. The fingers are cocked, the middle finger's tip against the thumb's; and snapped, the
 * thumb gone forward and the middle finger struck down into the palm.
 */
const SNAP_HIGH = 1.1;
const SNAP_BACK = 0.9;
const SNAP_PITCH = 0.15;
const SNAP_ROLL = -1.1;
const COCKED: Pose = (() => {
  const p = POSES.relaxed.slice() as Pose;
  setFinger(p, 'thumb', [0.55, 0.35, 0.3, 0.05, 1.05]);
  setFinger(p, 'index', [0.55, 0.6, 0.35, 0.05, 0]);
  setFinger(p, 'middle', [0.85, 0.75, 0.4, 0, 0]);
  setFinger(p, 'ring', [1.25, 1.4, 0.85, -0.03, 0]);
  setFinger(p, 'little', [1.25, 1.35, 0.85, -0.08, 0]);
  return p;
})();
const SNAPPED: Pose = (() => {
  const p = COCKED.slice() as Pose;
  setFinger(p, 'thumb', [0.15, 0.05, 0.02, 0.25, 0.85]);
  setFinger(p, 'index', [0.35, 0.3, 0.2, 0.08, 0]);
  setFinger(p, 'middle', [1.45, 1.5, 0.95, 0, 0]);
  return p;
})();
/** "Really?": the hand turned over, palm up, slowly, a little up and in from where it rests, and how long it is held so. */
const REALLY: Partial<Bearing> = { x: 0.1, y: 0.35, z: 0.05, tip: -0.05, turn: -2.75, glow: 0.3 };
const REALLY_TURNS = 1.3;
const REALLY_HOLDS = 0.8;

/** A hand that has gone to sleep on the rail, or been left with the page hidden, starts awake as at a check, but this much of it. */
const STARTS_AWAKE = 1 / 3;
/** A wrist turned over to be looked at, where a watch would be; and how long it is looked at. */
const CORD_LOOKED_AT: Partial<Bearing> = { y: 0.45, z: -0.15, tip: -0.3, turn: -1.9, glow: 0.3 };
const CORD_HOLDS = 1.5;
/** A hand that lies down on the rail sinks this much from where it drums, and is tipped this much flatter; it taps once in this many seconds; and it lies no longer than this. */
const LIES_LOWER = 0.07;
const LIES_FLATTER = 0.06;
const TAP_EVERY = 2;
const LIES_AT_MOST = 900;
/** A hand warms itself this far above a flame, for this long; this far above it is too near; and a hand that has been burned rests this much higher after. */
const WARMS_AT = 0.95;
const WARMS_FOR = 1.6;
const BURNS_AT = 0.55;
const WARY = 0.42;
const WARMING = between(POSES.relaxed, POSES.splay, 0.7);
/** A finger wagged: how far to each side, and how long the whole of it takes. */
const WAG = 0.09;
const WAG_SECONDS = 0.36;
/** How far a hand in thought comes down to set a stone straight, and to begin to close on one it will not take; and how long it hangs over that one first. */
const ADJUST_DIP = 0.34;
const FEINT_DIP = 0.12;
const FEINT_HANGS = 0.5;
/** A hand shut with its thumb out, and how far it is rolled for the thumb to stand uppermost. */
const THUMB_UP: Pose = (() => {
  const p = POSES.fist.slice() as Pose;
  setFinger(p, 'thumb', [-0.1, 0, 0, 0.55, 0.1]);
  return p;
})();
const THUMB_TURN = -1.5;
/** How high over the board a hand sweeps along a rank: clear of a king's crown. */
const SWEEPS_AT = 3.4;

export type Reach = 'over' | 'under';
export interface Beside {
  puppet: Puppet;
  at: Vector3;
}

export interface CarryOptions {
  /**
   * How far the piece's foot rises above the higher of the two places it stands, at the top of the
   * carry. Defaults to a height that grows with distance.
   */
  apex?: number;
  /** Where the piece's light should be by the time it is set down: 0 for a piece that has been taken. */
  energy?: number;
  /** Seconds to wait before starting, so that two hands need not move in step. */
  delay?: number;
  /**
   * How the hand comes at the piece where the player's other hand is at work in the same place:
   * 'over', from above and by its head if it has one, tipped steeply, so that the arm stands high;
   * 'under', low and flat, so that the other arm can reach across above it. Otherwise as suits the
   * piece and what stands round it.
   */
  reach?: Reach;
  /**
   * A way round, not the straight one: how far out to the side the piece swings, the share of the way
   * over which it swings out, and the share over which it comes back in.
   */
  bow?: { by: Vector3; out: number; back: number };
  /**
   * While it waits (see `delay`) it stays where it is, and does not go to hang over its piece: for a
   * hand that has to come to it over the player's other hand, which must be down first.
   */
  apart?: boolean;
  /**
   * The piece is going back the way it came: a knight then goes one across first and two along
   * after, which is the way it was carried there, the other way about.
   */
  retrace?: boolean;
  /**
   * While it waits (see `delay`) the player's other hand is at work right beside this piece: so
   * the hand does not hang over the piece, where the two would be one on top of the other, but
   * draws up and back from it toward its player, and comes down when the other has gone.
   */
  makeWay?: boolean;
  /** Something else the hand waits for once `delay` has run out, before it goes for its piece: until this says yes. */
  until?: () => boolean;
  /** Another piece that is moved in the same move, and where it will stand when this one is set down. */
  beside?: Beside;
  /**
   * Seconds the hand stays where it is, open, once it has let go, and does not draw back yet: for a
   * hand that lies under the player's other arm, which has to go first.
   */
  stay?: number;
  /** Told as the hand reaches for the piece, closes on it, lifts it, sets it down and lets go. */
  onBeat?: (beat: 'reach' | 'close' | 'lift' | 'set' | 'release') => void;
  /**
   * The stone is brought down over its square and stopped there, a little above it; then its foot
   * is rapped once on the square, `rap` being told where as it strikes, and only then is it set down.
   */
  rap?: (at: Vector3) => void;
  /** Seconds the stone is held up at the top of its carry, lit, before it goes on. */
  show?: number;
  /** How much quicker than usual the whole of it is done: the reach, the lift, the way across and the set. 1 if not said. */
  pace?: number;
  /**
   * Once it has let go, the hand taps the stone on its crown this many times, and `patted` is told
   * each time it does, before the hand goes. The carry is done with when the stone is let go, as
   * any other is: `patting` is given what is left, which resolves when the hand has done. `on` is
   * the stone tapped, if it is not the one just set down: in castling, the king beside the rook.
   */
  pat?: { taps: number; patted: (at: Vector3) => void; patting?: (left: Promise<void>) => void; on?: Puppet };
  /** The stone is set down this much off where it is going, and turned this much: see `squareUp`. */
  askew?: { by: Vector3; turn: number };
}

/**
 * How a scene has a hand held (see Act), in its own player's terms. `heading` is the way its fingers
 * point: none, straight at the other player; more, to its player's left. `pitch` tips them down
 * (less than nothing, up); `roll` rolls the thumb side down (less than nothing, up: about half a
 * turn has the palm up). `focus` is the point of the hand that is put where it is sent.
 */
export interface Stance {
  heading: number;
  pitch: number;
  roll?: number;
  focus?: Vector3;
  loose?: number;
}

/**
 * One arm, lent to a scene that is directed from outside (endings.ts) and may have other players'
 * arms in it. Every place is in the arm's own player's terms: out to their right (x), up (y), and
 * back toward them (z), from the middle of the board; so the same script, played by both
 * players, has their hands mirror each other across the board. Nothing it is asked to do is done
 * once the arm is no longer the scene's (`ok`).
 */
export interface Act {
  readonly arm: Arm;
  readonly hand: Hand;
  /** +1 for White, -1 for Black: what turns the player's terms into the room's. */
  readonly end: number;
  ok(): boolean;
  /** Go to `to`, there to be held so: over whatever stands between, if it is far, in `seconds`. */
  go(to: Vector3, stance: Stance, seconds: number, poses?: Pose[]): void;
  /** Close on `to` from where the hand is, as quickly as it has been told to (`speed`); and tip it so. */
  shift(to: Vector3, pitch?: number): void;
  /** Point the fingers with a turn of the wrist only (see Arm.aim); null to let them point as the arm reaches. */
  aim(heading: number | null): void;
  roll(by: number): void;
  speed(omega: number): void;
  pose(pose: Pose, seconds: number, ripple?: number, fingers?: FingerName[]): void;
  lean(to: Partial<Bearing>, seconds: number): Promise<void>;
  /** Hold the fingers exactly where they are put (Arm.steady). */
  steady(on: boolean): void;
  pause(seconds: number): Promise<boolean>;
  during(seconds: number, update: (k: number) => void): Promise<boolean>;
  /** Down onto the rail of the case at the player's end, fingertips set on the wood: where the hand is then (in the player's terms), or null. */
  rail(): Promise<Vector3 | null>;
  /** Whatever the fingers were set down on, they come away from it, in `seconds`. */
  lift(seconds: number): Promise<void>;
  /** A place in the player's terms in the room's, or back: it is the same sum both ways. */
  room(p: Vector3, out?: Vector3): Vector3;
  /** Where the steered point of the hand is, in the player's terms. */
  where(out?: Vector3): Vector3;
}

export class Puppeteer {
  readonly root = new Group();
  readonly right: Arm;
  readonly left: Arm;
  /** Bumped when the game is reset, so that a move still being played gives up. */
  private generation = 0;
  private flip: number;
  private time = 0;
  private attentive = false;
  /** Seconds the hands have had nothing to do, and how long until one of them shows it. */
  private waiting = 0;
  private patience = 6;
  private habit = 0;
  /** How the game stands for this player, and the shape their hands take at rest for that. */
  private mood: Mood = 'play';
  private resting: Pose = POSES.relaxed;
  /**
   * Asked when the hands have had nothing to do for a while, before they pass the time as they
   * always have: if something out of the ordinary is to be done instead (manners.ts), it is begun
   * here, and this says so.
   */
  idle: ((attentive: boolean) => boolean) | null = null;
  /** True while the two hands have their fingertips set down on each other's. */
  private paired = false;
  /** The arm that lies on the rail asleep, if one does (see `lieOnRail`). */
  private sleeper: Arm | null = null;
  /** True while this player's offer of a draw stands; and how it was answered, once it has been. */
  private offering = false;
  private answered: 'refused' | 'withdrawn' | null = null;

  constructor(
    template: HandTemplate,
    readonly side: Side,
    private tweens: Tweens,
    private gripOf: (puppet: Puppet) => PieceGrip,
    /** Everything of stone in the room that a hand could run into. */
    private around: () => Iterable<Puppet> = () => [],
  ) {
    this.flip = side === 'w' ? 1 : -1;
    this.right = new Arm(template, side, false, side === 'w' ? 1 : 3);
    this.left = new Arm(template, side, true, side === 'w' ? 2 : 4);
    for (const arm of [this.right, this.left]) {
      const sign = (arm === this.right ? 1 : -1) * this.flip;
      // Wide of the near corners of the slab: in view from every camera, in the way of none.
      arm.home.set(sign * REST_OUT, REST_HIGH, this.flip * REST_BACK);
      arm.hand.shoulder.set(sign * 3.7, 4.4, this.flip * 12.5);
      this.root.add(arm.hand.root, arm.threads.strands.mesh);
      // It begins where it rests, not on its way there.
      arm.at.snap(arm.home);
      this.rest(arm);
      arm.snap();
    }
    this.root.name = `hands-${side}`;
  }

  /** Both arms back to rest at once, with nothing in hand. For a new game. */
  reset(): void {
    this.generation++;
    this.mood = 'play';
    this.resting = POSES.relaxed;
    this.offering = false;
    this.sleeper = null;
    for (const arm of [this.right, this.left]) {
      this.still(arm);
      arm.leans++;
      arm.swayed.set(0, 0, 0);
      arm.tip = arm.turn = arm.glow = 0;
      arm.presence = 1;
      arm.hand.outline = 1;
      arm.hand.dissolve = 0;
      arm.busy = false;
      arm.held = null;
      arm.considering = null;
      arm.musing = null;
      arm.planted = false;
      arm.plants++;
      arm.pending = 0;
      arm.dip = arm.wary = 0;
      arm.hand.wagged = 0;
      arm.hand.touchWeight = 0;
      arm.hand.clearTouch();
      arm.hand.setPose(this.resting, 0.2);
      this.rest(arm);
    }
  }

  /**
   * Let the hands appear. Each is drawn into the room from its fingertips back to its wrist: the
   * line first, sketched, and the dark body filling in behind it (style bible, 6.4).
   */
  appear(): void {
    for (const arm of [this.right, this.left]) {
      arm.presence = 1;
      arm.hand.outline = 1;
      arm.hand.dissolve = 1;
      const delay = arm === this.right ? 0 : 0.14;
      void this.tweens.run({ duration: 1.1, delay, ease: Easing.inOutSine, update: (k) => (arm.hand.dissolve = 1 - k) });
      // It comes half closed, and opens as it is drawn: the fingers first, since they are drawn
      // first, one after another from the index out.
      const generation = this.generation;
      arm.hand.setPose(GATHERED, 0);
      void this.tweens.wait(delay + 0.25).then(() => {
        if (generation === this.generation && !arm.busy && !arm.considering) arm.hand.setPose(POSES.relaxed, 1.25, 0.11, Easing.inOutCubic);
      });
    }
  }

  /** Lean in when it is this player's turn, sit back when it is not. */
  setAttentive(on: boolean): void {
    const woken = on && !this.attentive && this.mood === 'play';
    this.attentive = on;
    this.right.attentive = this.left.attentive = on;
    // The turn has come round: the hands stir, as hands do that have been waiting.
    // (Not one that is about to do something else: the stir would take its place.)
    if (woken) this.each((arm, delay) => !arm.gesturing && arm.pending === 0 && !arm.busy && !arm.considering && this.gesture(arm, (ok) => this.stir(arm, ok), { delay }));
  }

  /** The arm on the side of the board a point is on, so that arms do not cross. */
  armFor(x: number): Arm {
    return x * this.flip >= 0 ? this.right : this.left;
  }

  other(arm: Arm): Arm {
    return arm === this.right ? this.left : this.right;
  }

  /**
   * Commit an arm to a move that is about to be played. It stops thinking but stays where it is,
   * so a hand already over its piece does not go home and come back.
   */
  engage(arm: Arm): void {
    if (this.mood !== 'play') this.resume();
    this.still(arm);
    arm.busy = true;
    arm.considering = null;
  }

  /** Hover a hand over a piece in thought, with threads from its fingertips. Pass null to stop. */
  consider(puppet: Puppet | null): void {
    for (const arm of [this.right, this.left]) {
      if (arm.busy) continue;
      const mine = puppet !== null && arm === this.armFor(puppet.group.position.x);
      if (mine) {
        if (arm.considering?.puppet !== puppet) {
          this.still(arm);
          arm.considering = this.hover(arm, puppet);
        } else {
          arm.omega = 12;
          arm.shift(arm.hoverPoint(puppet, arm.considering.grip, arm.considering.lift, v3), arm.considering.pitch);
        }
        arm.hand.restless = 1;
      } else if (arm.considering) {
        arm.considering = null;
        arm.hand.setPose(this.resting, 0.35, 0.04);
        this.rest(arm);
      }
    }
  }

  /**
   * Pick a piece up from where it stands and set it down with its foot at `to`. Resolves a moment
   * after it has been let go, while the hand is still on its way home. The piece is left exactly at
   * `to`, upright.
   */
  async carry(arm: Arm, puppet: Puppet, to: Vector3, options: CarryOptions = {}): Promise<void> {
    const generation = this.generation;
    const stale = () => generation !== this.generation;
    const hand = arm.hand;
    const job = ++arm.jobs;
    if (this.mood !== 'play') this.resume();
    this.still(arm);
    arm.busy = true;
    arm.considering = null;
    arm.droops = DROOP;
    hand.restless = 0.35;
    if (options.delay) {
      // A hand that has to wait its turn does not wait where it happens to be: it goes to its piece
      // and hangs over it, ready.
      // (Or, if the player's other hand has work to do right beside it, up and back from it.)
      if (options.makeWay) this.standOff(arm, puppet, options.reach);
      else if (!options.apart) this.hover(arm, puppet, options.reach);
      await this.tweens.wait(options.delay);
      if (stale()) return;
      // And then for whatever it was told to wait for, though not for ever.
      for (let waited = 0; options.until && !options.until() && waited < WAITS_AT_MOST; waited += 0.04) {
        await this.tweens.wait(0.04);
        if (stale()) return;
      }
    }

    const from = puppet.group.position.clone();
    const facing = puppet.group.rotation.y;
    // The piece is held where it asks to be, the hand tipped as that grip would have it and its
    // fingers open as wide as they like to: or as near to all that as keeps them out of what stands
    // round the piece, here and where it is going.
    const { grip, spec, pitch, gap, tucked } = this.hold(arm, puppet, to, options.reach, options.beside);
    const start = arm.gripPoint(puppet, grip, new Vector3());
    const ready = pregrip(hand, spec, grip, pitch, gap, tucked);

    // Come and reach, slowing into the piece. The fingers open round it before they close: they
    // have to be open by the time they pass the top of it.
    const pace = options.pace ?? 1;
    arm.omega = 13 * pace;
    const posture = { focus: spec.centre, pitch, loose: 0 };
    if (this.far(arm, start)) {
      // A hand that is not already over the piece crosses to it and comes down on it as one path,
      // in the time it used to take to arrive above it and then reach down, opening on the way.
      arm.fly(start, posture, 0.5 / pace, dart, [ready], this.stones(), this.mate(arm));
      hand.setPose(ready, 0.24 / pace, 0.015);
      await this.tweens.wait(0.2 / pace);
      if (stale()) return;
      options.onBeat?.('reach');
      await this.tweens.wait(0.4 / pace);
    } else {
      // One that is over it opens first, and then comes down.
      options.onBeat?.('reach');
      hand.setPose(ready, 0.16 / pace, 0.012);
      await this.tweens.wait(0.06 / pace);
      if (stale()) return;
      arm.go(start, posture);
      await this.tweens.wait(0.34 / pace);
    }
    if (stale()) return;

    // Close, with a squeeze a little past the piece's width that then eases off.
    arm.land();
    const held: Held = { puppet, grip, spec, yaw: arm.yaw.value, attached: false, squeeze: 1.25, facing, reach: {} };
    arm.feel(held);
    arm.held = held;
    arm.omega = 30;
    await this.tweens.run({
      duration: 0.08,
      ease: Easing.outCubic,
      update: (k) => {
        hand.touchWeight = k;
        held.squeeze = 1.25 - 0.32 * k;
      },
    });
    if (stale()) return;
    options.onBeat?.('close');
    void this.tweens.run({ duration: 0.14, ease: Easing.inOutSine, update: (k) => (held.squeeze = 0.93 + 0.07 * k) });
    // The fingers with nothing to hold fold in as the piece comes up.
    const spare = FINGERS.filter((finger) => spec.contacts[finger] === undefined && TUCKED[finger]);
    const closed = hand.pose.slice() as Pose;
    for (const finger of spare) setFinger(closed, finger, TUCKED[finger]!);
    if (spare.length > 0) hand.setPose(closed, 0.34, 0.05, Easing.inOutSine, spare);

    // Lift, carry and set as one path for the grip point. The hand rises first; the piece follows,
    // its fingers tipping down as far as what stands round it leaves room for.
    arm.droops = this.roomToDroop(arm, start, { focus: spec.centre, pitch, loose: 0 }, held.yaw, closed);
    held.attached = true;
    options.onBeat?.('lift');
    const end = to.clone().add(new Vector3(0, grip.y, 0)).add(new Vector3(0, 0, grip.z ?? 0).applyAxisAngle(UP, facing));
    // Where it is set down other things stand round it: the hand tips to suit them on the way, and
    // will open only as far as it can there.
    const down = this.fit(arm, puppet, grip, spec, end, held.yaw, opening(arm, puppet, grip) + LETS_GO, (tip, gap) => opened(hand, spec, grip, tip, gap, closed, held.reach), tilts(spec, options.reach), options.beside);
    const pitchTo = down.pitch;
    // A knight is not carried straight to where it is going. It goes as it moves: two squares
    // along, and then one across.
    const turn = options.bow ? null : knightsTurn(puppet, from, to, options.retrace ?? false);
    const corner = turn ? new Vector3(start.x + turn.x, 0, start.z + turn.z) : null;
    const distance = turn ? turn.first + turn.second : Math.hypot(to.x - from.x, to.z - from.z);
    const lift = 0.25 / pace;
    const travel = Math.min(0.9, 0.45 + (turn ? 0.13 : 0.065) * distance) / pace;
    const set = 0.2 / pace;
    const total = lift + travel + set;
    // Held up at the top of the carry (`show`): the time slows to a stop there, at the middle of the
    // way across, stands still, and comes back up to speed. All of that adds this much to the carry.
    const show = options.show ?? 0;
    const slows = show > 0 ? SHOWN_SLOWS : 0;
    const top = lift + travel * 0.5 - slows / 2;
    const stood = show + slows;
    // Brought down short of the square, to be rapped on it first (`rap`).
    const short = options.rap ? RAP_HIGH : 0;
    const askew = options.askew;
    let apex = options.apex ?? Math.min(1.5, 0.75 + 0.16 * distance);
    // What it was told to rise over is what stands on the straight way. On the way round it is
    // over other squares, and must be clear of what stands on those.
    if (turn) apex = Math.max(apex, this.tallestUnder(puppet, from, v1.set(from.x + turn.x, 0, from.z + turn.z), to) + 0.28);
    // The height of the grip point at the top of the carry.
    const rise = Math.max(from.y, to.y) + apex + grip.y;
    const energyFrom = puppet.energy;
    const energyTo = options.energy ?? energyFrom;
    const bow = options.bow;
    arm.omega = 26 * pace;
    await this.tweens.run({
      duration: total + stood,
      ease: (t) => t,
      update: (t01) => {
        if (stale()) return;
        const clock = t01 * (total + stood);
        const t = show > 0 ? slowed(clock, top, show, slows) : clock;
        // How far through being held up it is, 0 to 1, and 0 when it is not.
        const shown = show > 0 && clock > top && clock < top + show + 2 * slows ? Math.sin((Math.PI * (clock - top)) / (show + 2 * slows)) : 0;
        // Across: starts once the piece is clear of its square, ends as it starts down. (A knight
        // on its way round starts later, when it is nearly as high as it will go: the first
        // square it crosses is the one next to its own, and something may well stand there.)
        const begins = lift * (turn ? 0.95 : 0.55);
        const across = Math.min(1, Math.max(0, (t - begins) / (travel + lift + set * 0.2 - begins)));
        let h = Easing.inOutSine(across);
        if (turn) {
          // Each leg has its own start and stop, and the turn between them is slow but not a halt:
          // one, two; and three.
          const share = turn.first / distance;
          const at = options.retrace ? 1 - TURNS_AT : TURNS_AT;
          const legs = across < at ? share * Easing.inOutSine(across / at) : share + (1 - share) * Easing.inOutSine((across - at) / (1 - at));
          h = legs * 0.72 + h * 0.28;
        }
        // Up, then down: slow out of the top into the square.
        const up = Easing.outCubic(Math.min(1, Math.max(0, (t - 0.03) / (lift + travel * 0.45))));
        const down = Easing.inOutCubic(Math.min(1, Math.max(0, (t - lift - travel * 0.55) / (travel * 0.45 + set))));
        const y = start.y + (rise - start.y) * up - (rise - end.y - short) * down + SHOWN_UP * shown;
        // Out to the side early, along, and back in late: each a quarter of a wave, so that it turns without a corner.
        const aside = bow ? Math.min(Math.sin((Math.PI / 2) * Math.min(1, h / bow.out)), Math.sin((Math.PI / 2) * Math.min(1, (1 - h) / bow.back))) : 0;
        if (turn && corner) {
          const gone = h * distance;
          if (gone <= turn.first) arm.at.setGoal(v1.set(start.x + turn.x * (gone / turn.first), y, start.z + turn.z * (gone / turn.first)));
          else arm.at.setGoal(v1.set(corner.x + (end.x - corner.x) * ((gone - turn.first) / turn.second), y, corner.z + (end.z - corner.z) * ((gone - turn.first) / turn.second)));
        } else arm.at.setGoal(v1.set(start.x + (end.x - start.x) * h + (bow ? bow.by.x * aside : 0), y, start.z + (end.z - start.z) * h + (bow ? bow.by.z * aside : 0)));
        // Coming down a little off, and turning a little round, as it comes.
        if (askew) {
          arm.at.setGoal(v1.addScaledVector(askew.by, down));
          held.facing = facing + askew.turn * down;
        }
        arm.pitch.goal = pitch + (pitchTo - pitch) * h;
        puppet.energy = energyFrom + (energyTo - energyFrom) * Easing.inOutSine(t / total) + SHOWN_LIGHT * shown;
      },
    });
    if (stale()) return;

    if (options.rap) {
      // Stopped over the square; a beat; the foot struck once on it, and lifted off it again.
      await this.tweens.wait(RAP_WAIT);
      if (stale()) return;
      arm.omega = 40;
      arm.at.setGoal(end);
      await this.tweens.wait(0.12);
      if (stale()) return;
      options.rap(to);
      arm.omega = 24;
      arm.at.setGoal(v1.copy(end).setY(end.y + RAP_BACK));
      await this.tweens.wait(0.22);
      if (stale()) return;
      arm.at.setGoal(end);
      await this.tweens.wait(0.14);
      if (stale()) return;
    }

    // Set: let the spring close the last of the distance, then the piece is on its square.
    // (Or, to be squared up afterward, near it.)
    const endAt = askew ? end.clone().add(askew.by) : end;
    arm.at.setGoal(endAt);
    arm.omega = 34;
    await this.tweens.wait(askew ? 0.12 : 0.06);
    if (stale()) return;
    held.attached = false;
    puppet.group.position.copy(to);
    puppet.group.rotation.set(0, facing, 0);
    if (askew) {
      puppet.group.position.add(askew.by);
      puppet.group.rotation.y += askew.turn;
    }
    options.onBeat?.('set');
    // One beat of compression as stone meets stone.
    void this.tweens.run({
      duration: 0.16,
      ease: Easing.outCubic,
      update: (k) => {
        const squash = Math.sin(Math.PI * Math.min(1, k * 1.6)) * (1 - k);
        puppet.group.scale.set(1 + 0.05 * squash, 1 - 0.08 * squash, 1 + 0.05 * squash);
      },
    });

    // Release: the fingers spring open, clear of the stone all round. They open from where they hold
    // it, not from as wide as they came down on it where it stood: here there may be less room.
    hand.holdWhereTheyAre();
    hand.setPose(opened(hand, spec, grip, pitchTo, down.gap, closed, held.reach), 0.12, 0.012, Easing.outCubic);
    await this.tweens.run({ duration: 0.07, ease: Easing.outCubic, update: (k) => (hand.touchWeight = 1 - k) });
    if (stale()) return;
    arm.held = null;
    hand.clearTouch();
    options.onBeat?.('release');
    const overtaken = () => stale() || arm.jobs !== job;
    if (options.pat) {
      // The pat goes on after the move is done with; anything else the hand is given stops it.
      const left = this.patOn(arm, options.pat.on ?? puppet, options.pat.taps, options.pat.patted, () => !overtaken(), options.pat.on && puppet).then(() => {
        if (overtaken()) return;
        hand.restless = 1;
        void this.withdraw(arm, options.stay ?? 0, overtaken);
      });
      options.pat.patting?.(left);
      await this.tweens.wait(0.1);
      return;
    }

    // The hand draws back in the background; the move is over a moment after the piece is let go.
    hand.restless = 1;
    void this.withdraw(arm, options.stay ?? 0, overtaken);
    await this.tweens.wait(0.1);
  }

  /**
   * Take home a hand that has let go of its piece: straight up off it, a slow start, then away. At
   * once, or after `stay` seconds for one that lies under the player's other arm. Its fingers fall
   * back to rest once they are clear of the piece. `overtaken` says whether the hand has been given
   * something else to do in the meantime.
   */
  private async withdraw(arm: Arm, stay: number, overtaken: () => boolean): Promise<void> {
    if (stay > 0) {
      await this.tweens.wait(stay);
      if (overtaken()) return;
    }
    arm.busy = false;
    const at = arm.at.get(new Vector3());
    const held = { focus: arm.focus.get(new Vector3()), pitch: arm.pitch.value, loose: 0 };
    const droops = Math.min(this.roomToDroop(arm, at, held, arm.yaw.value, arm.hand.shown), this.roomToDroop(arm, at, held, arm.yaw.value, this.resting));
    this.rest(arm, OFF_PLUMB);
    arm.droops = droops;
    await this.tweens.wait(Math.max(0.02, 0.2 - stay));
    if (overtaken() || arm.busy || arm.considering || arm.gesturing) return;
    // Not all at once: the fingers fall back one after another, like a held breath let go.
    arm.hand.setPose(this.resting, 0.5, 0.055, Easing.inOutCubic);
  }

  // -- what the hands make of the game ------------------------------------------------

  /**
   * Their king is in check: both hands start back from the board, fingers flung wide, and come
   * slowly back to where they were.
   */
  startle(strength = 1): void {
    this.each((arm, delay) => this.gesture(arm, (ok) => this.recoil(arm, ok, strength), { delay }));
  }

  /**
   * They have given check: the hand on that side of the board goes out over it and points at the
   * king, where `at` is, and holds there a moment before it goes home. `once`: it has done it
   * before, and points the once, from nearer home.
   */
  point(at: Vector3, once = false): void {
    const arm = this.armFor(at.x);
    const king = at.clone();
    void this.gesture(
      arm,
      async (ok) => {
        const hand = arm.hand;
        const way = new Vector3(hand.shoulder.x - king.x, 0, hand.shoulder.z - king.z).normalize();
        const from = POINTS_FROM + (once ? POINTS_LESS : 0);
        const over = new Vector3(king.x + way.x * from, POINTS_HIGH, king.z + way.z * from);
        arm.omega = 12;
        hand.setPose(POSES.point, 0.32, 0.02, Easing.inOutCubic);
        void this.lean(arm, { glow: once ? 0.6 : 1 }, 0.2);
        this.send(arm, over, { focus: PALM_FOCUS, pitch: POINTS_TIP, loose: 0 }, 0.6, dart, [POSES.point]);
        await this.tweens.wait(0.66);
        if (!ok()) return;
        if (once) {
          await this.tweens.wait(0.7);
          return;
        }
        // And once more, a little nearer: there.
        arm.omega = 20;
        arm.shift(over.addScaledVector(way, -0.2).setY(POINTS_HIGH - 0.1), POINTS_TIP + 0.07);
        await this.tweens.wait(0.95);
      },
      { own: true },
    );
  }

  /**
   * A stone of theirs has been taken, `weight` saying how much it mattered (0 a pawn, 1 a queen):
   * the hands close on themselves, and for a heavy loss shake, before they let it go.
   */
  wince(weight: number): void {
    this.each((arm, delay) =>
      this.gesture(
        arm,
        async (ok) => {
          arm.omega = 12;
          arm.hand.setPose(between(this.resting, POSES.fist, 0.4 + 0.5 * weight), 0.16, 0.012, Easing.outCubic);
          void this.lean(arm, { y: -0.08 - 0.08 * weight, z: -0.2 * weight, tip: 0.1 + 0.1 * weight, glow: 0.3 + 0.4 * weight }, 0.2, Easing.outCubic);
          await this.tweens.wait(0.3 + 0.3 * weight);
          if (!ok() || weight < 0.6) return;
          await this.tweens.run({ duration: 0.55, ease: (k) => k, update: (k) => ok() && (arm.turn = Math.sin(k * Math.PI * 9) * 0.05 * (1 - k)) });
        },
        { delay },
      ),
    );
  }

  /** They have made a strong move: the hands lift and open in a fan, lit, like something let out. */
  flourish(): void {
    this.each((arm, delay) =>
      this.gesture(
        arm,
        async () => {
          arm.omega = 10;
          arm.hand.setPose(POSES.splay, 0.34, 0.07, Easing.outCubic);
          void this.lean(arm, { y: 0.4, z: 0.1, turn: -0.4, glow: 1 }, 0.36, Easing.outCubic);
          await this.tweens.wait(0.8);
        },
        { delay: delay * 2 },
      ),
    );
  }

  /** They have blundered: the hands sink, and the fingers hang for a moment. */
  sag(): void {
    this.each((arm, delay) =>
      this.gesture(
        arm,
        async () => {
          arm.omega = 4;
          arm.hand.setPose(between(this.resting, LIMP, 0.8), 0.9, 0.09, Easing.inOutCubic);
          void this.lean(arm, { y: -0.18, tip: 0.22, glow: 0 }, 0.9);
          await this.tweens.wait(1.6);
        },
        { delay },
      ),
    );
  }

  /** The other side has blundered: the hands come in toward the board, and one drums its fingers. */
  perk(): void {
    this.each((arm, delay) =>
      this.gesture(
        arm,
        async (ok) => {
          arm.omega = 10;
          void this.lean(arm, { y: 0.2, z: 0.2, glow: 0.75 }, 0.3, Easing.outCubic);
          await this.tweens.wait(0.3);
          if (!ok()) return;
          if (arm === this.right) arm.hand.drumFingers(3);
          await this.tweens.wait(1.1);
        },
        { delay },
      ),
    );
  }

  /**
   * The game is over, and this is how it stands for this player. If it has `happened` this moment
   * the hands act it out: a winner's rise over the board, open, and close on it (`struck`: by
   * mate; quietly, if the game was given up); a loser's start back if they were struck, and then
   * sink and go most of the way out; at a draw they are turned up, open, and offered. Then, and
   * at once if the game is only being stood again as it ended, they are held as that leaves them.
   */
  outcome(mood: Mood, happened: boolean, struck = false): void {
    this.mood = mood;
    this.resting = restingFor(mood);
    this.offering = false;
    if (!happened || mood === 'play') {
      for (const arm of [this.right, this.left]) {
        const away = arm.acting;
        this.still(arm, 0.05);
        // Hands that had gone are back for a game that is being played again; and are not there for one found as their player left it.
        arm.hand.dissolve = mood === 'gone' ? 1 : 0;
        if (arm.busy || arm.considering) continue;
        arm.hand.setPose(this.resting, 0.3);
        if (away) this.rest(arm);
      }
      return;
    }
    this.each((arm, delay) =>
      this.gesture(
        arm,
        async (ok) => {
          const hand = arm.hand;
          if (mood === 'won' && struck) {
            arm.omega = 5;
            hand.setPose(POSES.splay, 0.8, 0.09, Easing.inOutCubic);
            void this.lean(arm, { x: 0.9, y: 1.5, z: 1.3, tip: -0.12, turn: -0.5, glow: 1 }, 1.2);
            await this.tweens.wait(2.2);
            if (!ok()) return;
            hand.setPose(CLAIMED, 1.0, 0.1, Easing.inOutCubic);
            void this.lean(arm, { y: 1.3, tip: 0.05, turn: 0 }, 1.0);
            await this.tweens.wait(1.5);
          } else if (mood === 'won') {
            arm.omega = 5;
            hand.setPose(POSES.hover, 0.8, 0.07, Easing.inOutCubic);
            void this.lean(arm, { y: 0.5, z: 0.3, glow: 0.8 }, 0.9);
            await this.tweens.wait(1.5);
          } else if (mood === 'lost') {
            if (struck) {
              await this.recoil(arm, ok, 1);
              if (!ok()) return;
            }
            arm.omega = 2.6;
            hand.setPose(LIMP, 1.8, 0.14, Easing.inOutSine);
            void this.lean(arm, BEARINGS.lost, 2.6, Easing.inOutSine);
            await this.tweens.wait(2.7);
          } else {
            arm.omega = 5;
            hand.setPose(POSES.release, 0.8, 0.07, Easing.inOutCubic);
            void this.lean(arm, { x: 0.5, y: 0.9, z: 0.6, tip: -0.05, turn: -1.1, glow: 0.6 }, 0.9);
            await this.tweens.wait(1.9);
          }
        },
        { delay: delay * 2 },
      ),
    );
  }

  /** The game is being played again (a move taken back, a look at an earlier position): the hands are as they are in play. */
  resume(): void {
    if (this.mood !== 'play') this.outcome('play', false);
  }

  /** The hands' start back from the board, on its own: see `startle`. */
  private async recoil(arm: Arm, ok: () => boolean, strength: number): Promise<void> {
    arm.omega = 18;
    arm.hand.setPose(POSES.splay, 0.1, 0.006, Easing.outCubic);
    void this.lean(arm, { y: 0.3 * strength, z: -0.45 * strength, tip: -0.24 * strength, glow: 1 }, 0.12, Easing.outCubic);
    await this.tweens.wait(0.45);
    if (ok()) arm.omega = 5;
  }

  /** A hand whose turn has come stirs: the fingers gather, and its light comes up. */
  private async stir(arm: Arm, ok: () => boolean): Promise<void> {
    arm.hand.setPose(POSES.hover, 0.2, 0.035, Easing.outCubic);
    void this.lean(arm, { y: 0.05, glow: 0.85 }, 0.2, Easing.outCubic);
    await this.tweens.wait(0.38);
    void ok;
  }

  /** Idle, to move: the hand rocks from side to side, weighing one thing against another. */
  private async weigh(arm: Arm, ok: () => boolean): Promise<void> {
    arm.hand.setPose(POSES.release, 0.5, 0.05, Easing.inOutCubic);
    await this.tweens.run({
      duration: 1.9,
      ease: (k) => k,
      update: (k) => {
        if (!ok()) return;
        const swell = Math.sin(Math.PI * k);
        arm.turn = Math.sin(k * Math.PI * 3) * 0.24 * swell;
        arm.swayed.y = 0.07 * swell;
      },
    });
  }

  /** Idle, waiting: the fingers close one after another, and open again the same way. */
  private async furl(arm: Arm, ok: () => boolean): Promise<void> {
    arm.hand.setPose(between(POSES.relaxed, POSES.fist, 0.78), 0.55, 0.1, Easing.inOutCubic);
    void this.lean(arm, { tip: 0.08, y: -0.04 }, 0.7);
    await this.tweens.wait(1.05);
    void ok;
  }

  /** Idle, waiting: the hand is turned over and looked at, the fingers flexed, and turned back. */
  private async turnOver(arm: Arm, ok: () => boolean): Promise<void> {
    arm.omega = 5;
    arm.hand.setPose(POSES.release, 0.9, 0.06, Easing.inOutCubic);
    void this.lean(arm, { y: 0.15, z: -0.1, tip: -0.15, turn: -1.3 }, 0.9);
    await this.tweens.wait(1.15);
    if (!ok()) return;
    arm.hand.setPose(between(POSES.release, POSES.fist, 0.5), 0.5, 0.09, Easing.inOutCubic);
    await this.tweens.wait(0.75);
  }

  // -- manners: what the hands do that is not chess (manners.ts, docs/manners.md) ---------------------

  /**
   * Kept waiting, and tired of it: a hand comes down onto the rail of the case at its player's end
   * and drums on the wood, little finger first. `tap` is told as each finger lands, where, and how
   * hard (the index, which ends the roll, hardest).
   */
  drumOnRail(tap?: (at: Vector3, strength: number) => void, rounds = 3): void {
    this.habit++;
    const arm = this.habit % 2 === 0 ? this.right : this.left;
    void this.gesture(arm, async (ok) => {
      const hand = arm.hand;
      arm.idling = true;
      const down = await this.alight(arm, ok);
      if (!down) return;
      const { place, spots } = down;
      DRUMMERS.forEach((_, i) => ok() && tap?.(spots[i]!, 0.35));
      if (!(await this.pause(0.3, ok))) return;
      // The roll: each finger lifts and comes down, a beat after the one outside it.
      const beat = 0.075;
      const up = 0.2;
      const round = beat * 4 + 0.2;
      const landed = DRUMMERS.map(() => -1);
      const rolled = await this.during(round * rounds, ok, (k) => {
        const t = k * round * rounds;
        DRUMMERS.forEach((finger, i) => {
          const since = t - i * beat;
          if (since < 0) return;
          const turn = Math.min(rounds - 1, Math.floor(since / round));
          const lifted = (since - turn * round) / up;
          hand.touch[finger]!.y = spots[i]!.y + (lifted < 1 ? RAIL_LIFT * Math.sin(Math.PI * lifted) : 0);
          if (lifted >= 1 && landed[i]! < turn) {
            landed[i] = turn;
            tap?.(spots[i]!, i === DRUMMERS.length - 1 ? 1 : 0.7);
          }
        });
      });
      if (!rolled) return;
      if (!(await this.pause(0.35, ok))) return;
      await this.unplant(arm, 0.28);
      if (!ok()) return;
      // Up off the wood before the fingers straighten: or they would straighten into it.
      arm.omega = 9;
      arm.shift(place.setY(place.y + RAIL_CLEAR), RAIL_PITCH);
      await this.pause(0.3, ok);
    }, { own: true });
  }

  /**
   * Bring a hand down onto the rail of the case at its player's end and set its fingertips on the
   * wood, little finger to index, there to stay until they are let go (`plant`). Where each of
   * them is on the wood, and where the hand is; or null, if it was called away first.
   */
  private async alight(arm: Arm, ok: () => boolean): Promise<{ place: Vector3; spots: Vector3[] } | null> {
    const hand = arm.hand;
    arm.steady = true;
    const place = new Vector3(Math.sign(arm.home.x) * RAIL_OUT, RAIL_HIGH, this.flip * RAIL_BACK);
    arm.omega = 6;
    hand.setPose(SETTLED, 0.6, 0.05, Easing.inOutCubic);
    this.send(arm, place, { focus: PALM_FOCUS, pitch: RAIL_PITCH, loose: 0, askew: (arm === this.right ? 1 : -1) * RAIL_ASKEW }, 0.8, Easing.inOutSine, [SETTLED]);
    arm.roll.goal = RAIL_ROLL;
    if (!(await this.pause(1.1, ok))) return null;
    // As much lower as lets the shortest of its fingers get down to the wood. The fingers are
    // arched for where the hand will be before it goes there, so that none goes through the
    // wood on the way; and fitted again when it has got there and is still.
    const level = RIM_TOP + RAIL_OFF;
    const drop = Math.max(...DRUMMERS.map((finger) => this.arch(hand, finger, (pad) => pad.y - level).least)) + RAIL_SPARE;
    const fit = (above: number) => {
      const arched = hand.pose.slice() as Pose;
      const spots = DRUMMERS.map((finger) => {
        const found = this.arch(hand, finger, (pad) => pad.y - level - above);
        setFinger(arched, finger, found.angles);
        return found.at;
      });
      return { arched, spots };
    };
    const first = fit(drop);
    const reach = first.spots.map((spot) => spot.z * this.flip);
    place.y -= drop;
    place.z += this.flip * (RAIL_MIDDLE - (Math.min(...reach) + Math.max(...reach)) / 2);
    hand.setPose(first.arched, 0.35, 0.03, Easing.inOutCubic, DRUMMERS);
    if (!(await this.pause(0.2, ok))) return null;
    arm.omega = 12;
    arm.shift(place, RAIL_PITCH);
    if (!(await this.pause(0.8, ok))) return null;
    const { arched, spots } = fit(0);
    // And the hand is put once more so that the bow of its fingertips has the middle of the rail under its middle.
    const bow = spots.map((spot) => spot.z * this.flip);
    const back = this.flip * (RAIL_MIDDLE - (Math.min(...bow) + Math.max(...bow)) / 2);
    spots.forEach((spot) => spot.set(spot.x, level, spot.z + back));
    place.z += back;
    arm.shift(place, RAIL_PITCH);
    hand.setPose(arched, 0.3, 0.03, Easing.inOutCubic, DRUMMERS);
    if (!(await this.pause(0.36, ok))) return null;
    DRUMMERS.forEach((finger, i) => (hand.touch[finger] = spots[i]!.clone()));
    this.plant(arm);
    await this.tweens.run({ duration: 0.24, ease: Easing.inOutSine, update: (k) => ok() && (hand.touchWeight = k) });
    return ok() ? { place, spots } : null;
  }

  /**
   * How a finger must be bent for its pad to come to something, the hand being where it is: closed
   * from straight toward a fist only as far as first brings the pad there. `short` says how far
   * short of it a pad is (nothing or less, once it is there). The angles, where the pad then is,
   * and the least it can be short by at all.
   */
  private arch(hand: Hand, finger: FingerName, short: (pad: Vector3) => number): { angles: number[]; at: Vector3; least: number } {
    const shut = fingerOf(POSES.fist, finger);
    const spread = fingerOf(hand.pose, finger)[3];
    const angles = (share: number) => [shut[0] * share, shut[1] * share, shut[2] * share, spread, shut[4] * share];
    const at = new Vector3();
    hand.body.updateMatrixWorld();
    const miss = (share: number) => short(hand.body.localToWorld(hand.rig.pad(finger, angles(share), at)));
    let least = Infinity;
    for (let share = 0; share <= ARCH_MOST; share += 0.01) least = Math.min(least, miss(share));
    // So that every finger is bent the same way, a little, and none stands on its nail. If it cannot get there, as near as it can.
    let best = 0;
    let off = Math.abs(miss(0));
    for (let share = 0.005; share <= ARCH_MOST + 1e-6 && miss(share - 0.005) > 0; share += 0.005) {
      const by = Math.abs(miss(share));
      if (by < off) [off, best] = [by, share];
    }
    miss(best);
    return { angles: angles(best), at, least };
  }

  /**
   * To move, and thinking about it: the two hands come together before their player's own end of
   * the case and meet fingertip to fingertip, all five, press twice, and part. `met` is told when
   * they touch, and where.
   */
  steeple(met?: (at: Vector3) => void, crack?: (at: Vector3, strength: number) => void): void {
    const arms = [this.right, this.left];
    void this.duet(async (ok) => {
      const out = (arm: Arm) => Math.sign(arm.home.x);
      const places = arms.map((arm) => new Vector3(out(arm) * STEEPLE_APART, STEEPLE_HIGH, this.flip * STEEPLE_BACK));
      const posture = (arm: Arm, to: Vector3): Posture => {
        // The fingers point at the board, and somewhat at the other hand.
        const heading = Math.atan2(out(arm) * Math.sin(STEEPLE_IN), this.flip * Math.cos(STEEPLE_IN));
        return { focus: PALM_FOCUS, pitch: STEEPLE_PITCH, loose: 0, askew: nearestTurn(heading - arm.hand.headingTo(to), 0) };
      };
      arms.forEach((arm, i) => {
        arm.idling = true;
        arm.steady = true;
        arm.omega = 6;
        arm.hand.setPose(TENT, 0.75, 0.05, Easing.inOutCubic);
        this.send(arm, places[i]!, posture(arm, places[i]!), 0.9, Easing.inOutSine, [TENT]);
        arm.roll.goal = STEEPLE_ROLL;
        void this.lean(arm, { glow: 0.6 }, 0.6);
      });
      if (!(await this.pause(1.25, ok))) return;
      // Most of the way together, the fingers still straight; and then, measured again from there
      // (an arm swings a little as its hand comes in, and the fingers with it), as much nearer as
      // brings the longest finger of each almost to the middle, each finger bent as much as then
      // brings its tip the rest of the way.
      const shortOf = (arm: Arm, nearer: number) => (pad: Vector3) => out(arm) * pad.x - nearer - TIP_HALF;
      const apart = () => Math.min(...arms.flatMap((arm) => FINGERS.map((finger) => out(arm) * arm.hand.padWorld(finger, v1).x)));
      const close = (by: number) => arms.forEach((arm, i) => arm.shift(v1.copy(places[i]!).setX(places[i]!.x - out(arm) * by), STEEPLE_PITCH));
      const nearly = apart() - STEEPLE_NEARLY;
      arms.forEach((arm) => (arm.omega = 9));
      close(nearly);
      if (!(await this.pause(0.55, ok))) return;
      const gap = nearly + apart() - STEEPLE_SHY;
      const fit = (arm: Arm, nearer: number) => {
        const bent = arm.hand.pose.slice() as Pose;
        const spots = FINGERS.map((finger) => {
          const found = this.arch(arm.hand, finger, shortOf(arm, nearer));
          setFinger(bent, finger, found.angles);
          return found.at;
        });
        return { bent, spots };
      };
      arms.forEach((arm) => arm.hand.setPose(fit(arm, gap - nearly).bent, 0.3, 0.03, Easing.inOutCubic));
      close(gap);
      if (!(await this.pause(0.5, ok))) return;
      // Fitted again now that they are there and still; and each tip stays where it and its fellow
      // meet: half way between them, and its own half thickness to its own side.
      const fitted = arms.map((arm) => fit(arm, 0));
      arms.forEach((arm, i) => {
        arm.hand.setPose(fitted[i]!.bent, 0.2, 0.03, Easing.inOutCubic);
        FINGERS.forEach((finger, f) => {
          const meet = v1.addVectors(fitted[0]!.spots[f]!, fitted[1]!.spots[f]!).multiplyScalar(0.5);
          arm.hand.touch[finger] = new Vector3(out(arm) * TIP_HALF, meet.y, meet.z);
        });
      });
      if (!(await this.pause(0.22, ok))) return;
      arms.forEach((arm) => this.plant(arm));
      this.paired = true;
      await this.tweens.run({ duration: 0.22, ease: Easing.inOutSine, update: (k) => ok() && arms.forEach((arm) => (arm.hand.touchWeight = k)) });
      if (!ok()) return;
      const middle = v2.addVectors(fitted[0]!.spots[2]!, fitted[1]!.spots[2]!).multiplyScalar(0.5).clone();
      met?.(middle);
      if (!(await this.pause(crack ? 0.25 : 0.45, ok))) return;
      if (crack) {
        // Knuckles: pressed once, hard, and held there until the fingers, bent back, crack: three to five of them, and not evenly.
        this.habit++;
        const cracks = 3 + (this.habit % 3);
        let made = 0;
        let next = 0.42;
        const pressed = await this.during(1.1, ok, (k) => {
          close(gap + KNUCKLE_PRESS * Math.sin(Math.PI * Math.min(1, k * 1.2) * 0.5) * (k > 0.8 ? (1 - k) / 0.2 : 1));
          if (made < cracks && k >= next) {
            crack(middle, 1 - 0.13 * made);
            made++;
            next += (0.04 + 0.015 * ((made * 7 + this.habit) % 3)) / 1.1;
          }
        });
        if (!pressed) return;
      } else if (!(await this.during(1.5, ok, (k) => close(gap + STEEPLE_PRESS * Math.pow(Math.sin(Math.PI * 2 * k), 2))))) {
        // (Pressed together, twice: the fingers bow, since their tips have nowhere to go.)
        return;
      }
      if (!(await this.pause(0.4, ok))) return;
      await Promise.all(arms.map((arm) => this.unplant(arm, 0.25)));
      if (!ok()) return;
      // Apart, before they turn to go: or each would turn through the other.
      arms.forEach((arm) => arm.hand.setPose(TENT, 0.4, 0.04, Easing.inOutCubic));
      close(0);
      await this.pause(0.4, ok);
    });
  }

  /**
   * Lay a stone over with one finger. The hand on that side goes to hang over `puppet` as it would
   * in thought, threads and all; the threads go out; it draws back until its index, held out, is
   * on the crown; and it pushes. `push` moves the stone to a share of the way to where it will go on falling by itself
   * (0 to 1), and says where on its crown the finger is then. This is true if the hand pushed it
   * all the way; the hand stays as it is, finger out, until it is given something else to do.
   */
  async tip(puppet: Puppet, push: (share: number) => Vector3): Promise<boolean> {
    const arm = this.armFor(puppet.group.position.x);
    if (arm.busy) return false;
    this.still(arm, 0.2);
    const token = arm.acts;
    const generation = this.generation;
    const ok = () => generation === this.generation && arm.acts === token && !arm.busy && !arm.considering;
    const hand = arm.hand;
    arm.gesturing = true;
    arm.acting = true;
    arm.steady = true;
    const over = this.hover(arm, puppet);
    arm.musing = over;
    void this.lean(arm, { glow: 0.5, presence: 1, outline: 1 }, 0.3);
    if (!(await this.pause(0.75, ok))) return false;
    arm.musing = null;
    if (!(await this.pause(0.3, ok))) return false;
    // One finger, on the crown: the hand goes to where that finger, held out, is on it. Twice,
    // since as the hand goes its arm swings a little, and the finger with it.
    const spot = push(0).clone();
    hand.setPose(POSES.point, 0.26, 0.02, Easing.inOutCubic);
    if (!(await this.pause(0.3, ok))) return false;
    arm.omega = 10;
    const from = new Vector3();
    for (let tries = 0; tries < 6; tries++) {
      // (From where the hand is, not from where it is going: so it does not matter that it has not got there.)
      arm.shift(arm.at.get(from).add(spot).sub(hand.padWorld('index', v1)), over.pitch);
      if (!(await this.pause(tries ? 0.15 : 0.36, ok))) return false;
      if (tries && hand.padWorld('index', v1).distanceTo(spot) < 0.012) break;
    }
    arm.at.goal(from);
    hand.touch.index = spot.clone();
    this.plant(arm);
    await this.tweens.run({ duration: 0.14, ease: Easing.inOutSine, update: (k) => ok() && (hand.touchWeight = k) });
    if (!(await this.pause(0.3, ok))) return false;
    // And over it goes: slowly, and then not. The hand goes with it, close, for as long as it pushes.
    arm.omega = 40;
    await this.tweens.run({
      duration: 0.34,
      ease: Easing.inCubic,
      update: (k) => {
        if (!ok()) return;
        const at = push(k);
        hand.touch.index!.copy(at);
        arm.shift(v1.copy(at).sub(spot).add(from), over.pitch);
      },
    });
    return ok();
  }

  /**
   * A move has been made, by either player: a hand that was only passing the time, drumming on the
   * rail or steepled with the other, has done with it and goes back to rest.
   */
  attend(): void {
    for (const arm of [this.right, this.left]) {
      if (!arm.idling || !arm.gesturing || arm.busy || arm.considering) continue;
      const slept = this.sleeper === arm;
      if (slept) this.sleeper = null;
      this.still(arm, 0.3);
      arm.omega = 7.5;
      arm.hand.setPose(this.resting, 0.6, 0.05, Easing.inOutCubic);
      this.rest(arm, RAIL_CLEAR);
      // A hand that had gone to sleep starts awake: as at a check, a third as large.
      if (slept) void this.gesture(arm, (ok) => this.recoil(arm, ok, STARTS_AWAKE));
    }
  }

  /** The hand that tipped a stone over has done with it: its finger comes away. */
  async untip(): Promise<void> {
    for (const arm of [this.right, this.left]) {
      if (!arm.planted) continue;
      await this.unplant(arm, 0.3);
      arm.gesturing = false;
      arm.acting = false;
      arm.steady = false;
    }
  }

  // -- how a stone is set down (the carry's own are in CarryOptions: rap, show, pat, askew) --

  /**
   * Move a stone along the board without lifting it: the hand comes over it as in thought, sets one
   * finger behind its head, and slides it to `to`. Resolves, as `carry` does, a moment after the
   * finger has come away; the stone is left exactly at `to`, upright.
   */
  async push(arm: Arm, puppet: Puppet, to: Vector3, onBeat?: CarryOptions['onBeat']): Promise<void> {
    const generation = this.generation;
    const job = ++arm.jobs;
    const live = () => generation === this.generation && arm.jobs === job;
    const hand = arm.hand;
    if (this.mood !== 'play') this.resume();
    this.still(arm);
    arm.busy = true;
    arm.considering = null;
    arm.droops = DROOP;
    hand.restless = 0.35;
    const facing = puppet.group.rotation.y;
    const over = this.hover(arm, puppet);
    onBeat?.('reach');
    if (!(await this.pause(0.32, live))) return;
    const pitch = Math.max(over.pitch, PUSH_PITCH);
    if (!(await this.fingerBehind(arm, puppet, to, pitch, live, 0.3))) return;
    onBeat?.('close');
    if (!(await this.pause(0.1, live))) return;
    onBeat?.('lift');
    // And along: slow away, slow in.
    if (!(await this.slide(arm, puppet, to, facing, pitch, PUSH_SECONDS, live))) return;
    onBeat?.('set');
    if (!(await this.pause(0.08, live))) return;
    onBeat?.('release');
    hand.restless = 1;
    void this.withdraw(arm, 0, () => !live());
    await this.tweens.wait(0.1);
  }

  /**
   * A stone that was set down a little off its square and a little turned (`CarryOptions.askew`) is
   * put straight: the hand, a little way on its way home, stops, comes back and nudges it with one
   * finger to stand exactly at `to`, facing `facing`. A new game stops it and leaves the stone to the
   * new game; given anything else to do (`letBe` among it), it leaves the stone to whatever gave it.
   */
  async squareUp(arm: Arm, puppet: Puppet, to: Vector3, facing: number): Promise<void> {
    const generation = this.generation;
    const job = ++arm.jobs;
    const live = () => generation === this.generation && arm.jobs === job;
    const hand = arm.hand;
    try {
      if (!(await this.pause(SQUARE_AFTER, live))) return;
      this.still(arm);
      arm.busy = true;
      hand.restless = 0.35;
      const over = this.hover(arm, puppet);
      if (!(await this.pause(0.3, live))) return;
      const pitch = Math.max(over.pitch, PUSH_PITCH);
      if (!(await this.fingerBehind(arm, puppet, to, pitch, live, 0.26))) return;
      if (!(await this.slide(arm, puppet, to, facing, pitch, NUDGE_SECONDS, live))) return;
      if (!(await this.pause(0.08, live))) return;
      hand.restless = 1;
      void this.withdraw(arm, 0, () => !live());
    } finally {
      // Done with, this stone stands where it should. (Called away, what called it away sees to that.)
      if (live()) {
        puppet.group.position.copy(to);
        puppet.group.rotation.set(0, facing, 0);
      }
    }
  }

  /**
   * Whatever a hand is still doing about a stone it has let go of (squaring it up, patting it,
   * snapping its fingers over it) it stops doing, and goes home. Not a hand that holds a stone.
   */
  letBe(arm: Arm): void {
    if (arm.held) return;
    const job = ++arm.jobs;
    this.still(arm);
    arm.hand.restless = 1;
    void this.withdraw(arm, 0, () => arm.jobs !== job);
  }

  /**
   * Bring the tip of a hand's index, held out, to the back of a stone's head, on the side away from
   * `to`: from above it first, and then down onto it. False if the hand was called away first.
   */
  private async fingerBehind(arm: Arm, puppet: Puppet, to: Vector3, pitch: number, live: () => boolean, first: number): Promise<boolean> {
    const at = puppet.group.position;
    const way = new Vector3(to.x - at.x, 0, to.z - at.z).normalize();
    // Up off the head first, so that the finger straightens clear of it.
    arm.omega = 14;
    // (Tipped as it will be there, too: the finger swings down as the hand tips.)
    arm.shift(arm.at.goal(new Vector3()).setY(arm.at.goal(v1).y + PUSH_RISE), pitch);
    if (!(await this.pause(0.2, live))) return false;
    // And straightened before it is sent anywhere by it: where its tip is depends on it.
    arm.hand.setPose(POSES.point, 0.22, 0.02, Easing.inOutCubic);
    if (!(await this.pause(0.24, live))) return false;
    const spot = sideOf(puppet, way.clone().negate(), PUSH_UP, new Vector3()).addScaledVector(way, -PUSH_SPARE);
    arm.omega = 13;
    if (!(await this.fingerTo(arm, spot.clone().setY(spot.y + PUSH_ABOVE).addScaledVector(way, -0.08), pitch, live, first))) return false;
    arm.omega = 18;
    return (await this.fingerTo(arm, spot, pitch, live, 0.12)) !== null;
  }

  /**
   * The hand moves on, toward `to`, and the stone goes in front of its finger: as far as the finger
   * has pushed it, and no farther, so that finger and stone stay together. Then it is set exactly at
   * `to`, facing `facing`. True if it got there before the hand was called away.
   */
  private async slide(arm: Arm, puppet: Puppet, to: Vector3, facing: number, pitch: number, seconds: number, live: () => boolean): Promise<boolean> {
    const hand = arm.hand;
    const from = puppet.group.position.clone();
    const turned = puppet.group.rotation.y;
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const way = new Vector3(to.x - from.x, 0, to.z - from.z).divideScalar(length || 1);
    const start = arm.at.goal(new Vector3());
    const tip = hand.padWorld('index', new Vector3(), true);
    const now = new Vector3();
    let pushed = 0;
    const follow = () => {
      // How far the finger has gone along the way since it was set on the stone.
      const gone = hand.padWorld('index', now, true).sub(tip).dot(way);
      pushed = Math.min(length, Math.max(pushed, gone));
      const k = length > 0 ? pushed / length : 1;
      puppet.group.position.copy(from).addScaledVector(way, pushed);
      puppet.group.rotation.set(0, turned + (facing - turned) * k, 0);
    };
    arm.omega = 30;
    // A little past, for the spring that carries the hand to come all the way.
    const past = length + PUSH_PAST;
    await this.tweens.run({
      duration: seconds,
      ease: (k) => k,
      update: (k) => {
        if (!live()) return;
        arm.shift(v1.copy(start).addScaledVector(way, past * Easing.inOutSine(k)), pitch);
        follow();
      },
    });
    for (let waited = 0; live() && pushed < length - 1e-3 && waited < 0.2; waited += 0.02) {
      await this.tweens.wait(0.02);
      follow();
    }
    if (!live()) return false;
    puppet.group.position.copy(to);
    puppet.group.rotation.set(0, facing, 0);
    // The finger eases back off the stone.
    arm.omega = 14;
    arm.shift(v1.copy(start).addScaledVector(way, length - PUSH_SPARE).setY(start.y + 0.06), pitch);
    return true;
  }

  /**
   * Once a pawn is down on the last rank: the hand that set it there lifts clear of it and snaps its
   * fingers, and `snapped` is told at the snap, and where (and at once, if the hand is called away
   * before it, with `heard` false: there was no snap to hear).
   * Resolves when the snap has been made, or will not be.
   */
  snap(arm: Arm, puppet: Puppet, snapped: (at: Vector3, heard: boolean) => void): Promise<void> {
    let done = false;
    const crown = topOf(puppet, new Vector3());
    const once = (heard: boolean) => {
      if (done) return;
      done = true;
      snapped(arm.hand.padWorld('middle', new Vector3()), heard);
    };
    let fired: () => void = () => undefined;
    const made = new Promise<void>((resolve) => (fired = resolve));
    void this.gesture(
      arm,
      async (ok) => {
        const hand = arm.hand;
        arm.steady = true;
        arm.omega = 9;
        const at = new Vector3(crown.x, crown.y + SNAP_HIGH, crown.z + this.flip * SNAP_BACK);
        hand.setPose(COCKED, 0.4, 0.03, Easing.inOutCubic);
        this.send(arm, at, { focus: PALM_FOCUS, pitch: SNAP_PITCH, loose: 0, askew: 0 }, 0.5, Easing.inOutSine, [COCKED]);
        arm.roll.goal = SNAP_ROLL * this.outward(arm);
        if (!(await this.pause(0.62, ok))) return;
        // The snap: the thumb goes, and the middle finger strikes the palm.
        hand.setPose(SNAPPED, 0.06, 0, Easing.inCubic);
        if (!(await this.pause(0.05, ok))) return;
        once(true);
        fired();
        arm.omega = 14;
        arm.shift(v1.copy(at).setY(at.y + 0.08), SNAP_PITCH - 0.1);
        await this.pause(0.4, ok);
        arm.roll.goal = 0;
      },
      { own: true },
    ).finally(() => {
      once(false);
      fired();
    });
    return made;
  }

  /**
   * "Really?": the other side has made a pawn into something less than a queen. The hand turns over,
   * slowly, palm up, and holds it there a beat: `both`, and the other hand does it too.
   */
  really(both: boolean): void {
    const arms = both ? [this.right, this.left] : [this.right];
    arms.forEach((arm, i) =>
      this.gesture(
        arm,
        async (ok) => {
          arm.omega = 4;
          arm.hand.setPose(OFFERED, REALLY_TURNS, 0.06, Easing.inOutSine);
          void this.lean(arm, REALLY, REALLY_TURNS, Easing.inOutSine);
          await this.pause(REALLY_TURNS + REALLY_HOLDS, ok);
        },
        { delay: 0.35 + 0.25 * i },
      ),
    );
  }

  /** A check given again, and again: the hand does not leave where it rests, but one finger lifts and falls. */
  liftFinger(): void {
    const arm = this.right;
    void this.gesture(arm, async (ok) => {
      const hand = arm.hand;
      const up = this.resting.slice() as Pose;
      setFinger(up, 'index', [-0.15, 0.05, 0.03, 0.05, 0]);
      hand.setPose(up, 0.3, 0, Easing.inOutCubic, ['index']);
      if (!(await this.pause(0.55, ok))) return;
      hand.setPose(this.resting, 0.35, 0, Easing.inCubic, ['index']);
      await this.pause(0.4, ok);
    });
  }

  /** In check again, and again: one finger twitches, and that is all. */
  twitch(): void {
    const arm = this.left;
    void this.gesture(arm, async (ok) => {
      const hand = arm.hand;
      const twitched = this.resting.slice() as Pose;
      const at = fingerOf(this.resting, 'index');
      setFinger(twitched, 'index', [at[0]! - 0.3, at[1]! - 0.2, at[2]!, at[3]!, at[4]!]);
      hand.setPose(twitched, 0.06, 0, Easing.outCubic, ['index']);
      if (!(await this.pause(0.09, ok))) return;
      hand.setPose(this.resting, 0.2, 0, Easing.inOutCubic, ['index']);
      await this.pause(0.3, ok);
    });
  }

  /**
   * The hand pats the stone it has just let go of on its crown, `taps` times, `patted` being told each
   * time: level, the fingers out together, the pads of the longest coming down on it. For a hand that
   * carried it there from above. `ok` says whether it still may. Where it has just let go of
   * another stone (`from`) beside this one, it rises higher, turning to point the way its arm comes
   * at this one and not the way it held the other, so that its fingers clear the stones round both.
   */
  private async patOn(arm: Arm, puppet: Puppet, taps: number, patted: (at: Vector3) => void, ok: () => boolean, from?: Puppet): Promise<void> {
    const hand = arm.hand;
    const crown = topOf(puppet, new Vector3());
    // Up off the head first, so that the fingers straighten clear of it, and level.
    arm.omega = 12;
    if (from) arm.aim = nearestTurn(hand.headingTo(crown), arm.yaw.value);
    arm.shift(arm.at.get(v1).setY(v1.y + PAT_RISE + (from ? PAT_RISE_BESIDE : 0)), PAT_PITCH);
    // (Turned, and higher, before its fingers straighten, so that they do not sweep the stones beyond.)
    if (!(await this.pause(from ? 0.36 : 0.16, ok))) return;
    hand.setPose(PATTING, 0.24, 0.02, Easing.inOutCubic);
    if (!(await this.pause(0.24, ok))) return;
    const above = await this.fingerTo(arm, crown.clone().setY(crown.y + TIP_HALF + PAT_LIFT), PAT_PITCH, ok, 0.18, 'middle');
    if (!above) return;
    for (let i = 0; i < taps; i++) {
      arm.omega = 34;
      arm.shift(v1.copy(above).setY(above.y - PAT_LIFT), PAT_PITCH);
      if (!(await this.pause(0.08, ok))) return;
      patted(crown);
      arm.omega = 22;
      arm.shift(above, PAT_PITCH);
      if (!(await this.pause(0.2, ok))) return;
    }
    await this.pause(0.1, ok);
  }

  /**
   * Bring a hand to where the tip of its index, held out (or the pad of another `finger`), is on `spot`, tipped `pitch`: more than once,
   * since as the hand goes its arm swings a little, and the finger with it. Where the hand was sent in
   * the end; null if it was called away first. `first` is how long it is given to get there at first.
   */
  private async fingerTo(arm: Arm, spot: Vector3, pitch: number, ok: () => boolean, first: number, finger: FingerName = 'index'): Promise<Vector3 | null> {
    // (Its own: the shared scratch vectors do not keep their values over a wait.)
    spot = spot.clone();
    const hand = arm.hand;
    const sent = new Vector3();
    const goal = new Vector3();
    for (let tries = 0; tries < 5; tries++) {
      // (From where the hand is, not from where it is going: so it does not matter that it has not got there.)
      arm.shift(goal.copy(arm.at.get(sent)).add(spot).sub(hand.padWorld(finger, v2, finger === 'index')), pitch);
      if (!(await this.pause(tries ? 0.1 : first, ok))) return null;
      if (hand.padWorld(finger, v2, finger === 'index').distanceTo(spot) < 0.012) break;
    }
    return goal;
  }

  /** +1 for the hand on its player's right, -1 for the one on their left. */
  private outward(arm: Arm): number {
    return arm === this.right ? 1 : -1;
  }


  // -- waiting and thinking (docs/manners.md, 5.1 to 5.3) ---------------------------------------------

  /**
   * Kept waiting a long while: a hand lifts, turns its wrist over and looks at the cord there, where
   * a watch would be; and looks back at the board.
   */
  lookAtCord(): void {
    this.habit++;
    const arm = this.habit % 2 === 0 ? this.right : this.left;
    void this.gesture(arm, async (ok) => {
      arm.idling = true;
      arm.steady = true;
      arm.omega = 5;
      arm.hand.setPose(between(POSES.relaxed, POSES.fist, 0.4), 0.8, 0.05, Easing.inOutCubic);
      void this.lean(arm, CORD_LOOKED_AT, 0.9);
      if (!(await this.pause(0.9 + CORD_HOLDS, ok))) return;
      // And back at the board: nothing has moved.
      void this.lean(arm, { y: 0.2, z: 0.12, tip: 0.12, turn: 0, glow: 0 }, 0.5);
      await this.pause(1, ok);
    });
  }

  /**
   * Kept waiting longer still: a hand comes down onto the rail, as it would to drum, and lies there,
   * one finger tapping every two seconds (`tap` is told, where and how hard); and when `asleep` says
   * it has been long enough the tapping stops, and the fingers only twitch now and then, as a
   * sleeper's do. It lies there until a move is made (`attend`), and then starts awake.
   */
  lieOnRail(tap: ((at: Vector3, strength: number) => void) | undefined, asleep: () => boolean): void {
    this.habit++;
    const arm = this.habit % 2 === 0 ? this.right : this.left;
    void this.gesture(arm, async (ok) => {
      const hand = arm.hand;
      arm.idling = true;
      const down = await this.alight(arm, ok);
      if (!down) return;
      const { place, spots } = down;
      // It lies down: the heel of the hand sinks toward the wood, the fingertips staying where they are.
      arm.omega = 3;
      arm.shift(v1.copy(place).setY(place.y - LIES_LOWER), RAIL_PITCH + LIES_FLATTER);
      if (!(await this.pause(0.9, ok))) return;
      const tapper = DRUMMERS.length - 1;
      const lift = (finger: FingerName, spot: Vector3, high: number, seconds: number) => this.during(seconds, ok, (k) => (hand.touch[finger]!.y = spot.y + high * Math.sin(Math.PI * k)));
      for (let lain = 0; lain < LIES_AT_MOST && !asleep(); lain += TAP_EVERY) {
        if (!(await this.pause(TAP_EVERY - 0.2, ok))) return;
        if (!(await lift(DRUMMERS[tapper]!, spots[tapper]!, RAIL_LIFT, 0.2))) return;
        tap?.(spots[tapper]!, 0.6);
      }
      // Asleep. Nothing is heard; a finger stirs, not the same one each time.
      this.sleeper = arm;
      for (let slept = 0, n = 0; slept < LIES_AT_MOST; slept += 3.4, n++) {
        if (!(await this.pause(3.1, ok))) return;
        const which = (n * 2 + 1) % DRUMMERS.length;
        if (!(await lift(DRUMMERS[which]!, spots[which]!, RAIL_LIFT * 0.35, 0.3))) return;
      }
    }, { own: true }).finally(() => {
      if (this.sleeper === arm && !arm.gesturing) this.sleeper = null;
    });
  }

  /**
   * The other player's answer to knuckles cracked: the right hand, without leaving its corner,
   * presses its index down with its thumb. One crack, late and small (`crack` is told, and where).
   */
  crackOne(crack?: (at: Vector3, strength: number) => void): void {
    const arm = this.right;
    void this.gesture(arm, async (ok) => {
      const hand = arm.hand;
      arm.steady = true;
      const pressed = this.resting.slice() as Pose;
      setFinger(pressed, 'index', fingerOf(POSES.fist, 'index'));
      setFinger(pressed, 'thumb', fingerOf(POSES.fist, 'thumb'));
      hand.setPose(pressed, 0.45, 0, Easing.inOutCubic, ['index', 'thumb']);
      if (!(await this.pause(0.6, ok))) return;
      crack?.(hand.padWorld('index', new Vector3()), 0.45);
      if (!(await this.pause(0.35, ok))) return;
      hand.setPose(this.resting, 0.5, 0.05, Easing.inOutCubic, ['index', 'thumb']);
      await this.pause(0.5, ok);
    });
  }

  /**
   * Kept waiting, beside a candle: the hand that rests over `flame` lowers itself toward it, palm
   * down and fingers spread, as hands do at a fire. It goes a little too low; snatches back
   * (`burned` is told, and where); shakes its fingers out twice; and for the rest of the game rests
   * a hand's breadth farther from the candle than it did.
   */
  warm(flame: Vector3, burned?: (at: Vector3) => void): void {
    const arm = Math.sign(flame.x) === Math.sign(this.right.home.x) ? this.right : this.left;
    const at = flame.clone();
    void this.gesture(arm, async (ok) => {
      const hand = arm.hand;
      arm.idling = true;
      arm.steady = true;
      arm.omega = 4;
      const over = new Vector3(at.x, at.y + WARMS_AT, at.z);
      hand.setPose(WARMING, 0.9, 0.06, Easing.inOutCubic);
      this.send(arm, over, { focus: PALM_FOCUS, pitch: 0.02, loose: 0, askew: (arm === this.right ? 1 : -1) * LIES_IN }, 1.1, Easing.inOutSine, [WARMING]);
      void this.lean(arm, { glow: 0.35 }, 1);
      if (!(await this.pause(1.2 + WARMS_FOR, ok))) return;
      // Lower, slowly: and that is too low.
      arm.omega = 1.6;
      arm.shift(v1.copy(over).setY(at.y + BURNS_AT), 0.02);
      if (!(await this.pause(1.5, ok))) return;
      // Snatched back.
      arm.wary = WARY;
      arm.omega = 34;
      hand.setPose(POSES.splay, 0.07, 0, Easing.outCubic);
      arm.shift(v1.copy(over).setY(over.y + 0.75), -0.25);
      burned?.(hand.toWorld(PALM_FOCUS, new Vector3()));
      void this.lean(arm, { glow: 1 }, 0.08);
      if (!(await this.pause(0.4, ok))) return;
      // Shaken out, twice.
      arm.omega = 12;
      hand.setPose(between(POSES.relaxed, POSES.splay, 0.5), 0.2, 0.02, Easing.inOutCubic);
      await this.during(0.7, ok, (k) => (arm.turn = Math.sin(k * Math.PI * 4) * 0.42 * (1 - 0.4 * k)));
    }, { own: true });
  }

  /** A hand turning from a stone it thought about a while to another: its index wags once as it goes. */
  wag(arm: Arm): void {
    const hand = arm.hand;
    const token = ++this.wags;
    void this.tweens.run({
      duration: WAG_SECONDS,
      ease: (k) => k,
      update: (k) => {
        if (token !== this.wags) return;
        hand.wagged = k >= 1 ? 0 : WAG * Math.sin(Math.PI * 2 * k) * Math.sin(Math.PI * k);
      },
    });
  }
  private wags = 0;

  /** The arm whose side of the board a stone stands on (for whoever tells it something about that stone). */
  armOver(puppet: Puppet): Arm {
    return this.armFor(puppet.group.position.x);
  }

  /**
   * J'adoube: the hand that hangs over `puppet` in thought comes down to its head, sets it straight,
   * and rises to where it hung. `touched` is told when the fingers are on it, and where. Nothing, if
   * no hand is thinking about that stone; and the hand goes on following its player all the while.
   */
  adjust(puppet: Puppet, touched: (at: Vector3) => void): void {
    const arm = [this.right, this.left].find((a) => a.considering?.puppet === puppet && !a.busy);
    if (!arm) return;
    const generation = this.generation;
    let told = false;
    const live = () => generation === this.generation && arm.considering?.puppet === puppet && !arm.busy;
    void this.tweens.run({
      duration: 0.62,
      ease: (k) => k,
      update: (k) => {
        if (!live()) return void (arm.dip = 0);
        arm.dip = k >= 1 ? 0 : ADJUST_DIP * Math.pow(Math.sin(Math.PI * k), 2);
        if (!told && k >= 0.5) {
          told = true;
          touched(topOf(puppet, new Vector3()));
        }
      },
    });
  }

  /**
   * The feint: a hand goes to `puppet` as if to move it, hangs there, begins to close on it, stops,
   * opens, and leaves it. Resolves when it has; the stone is never touched.
   */
  async feint(puppet: Puppet): Promise<void> {
    const generation = this.generation;
    const arm = this.armOver(puppet);
    const ok = () => generation === this.generation && arm.considering?.puppet === puppet && !arm.busy;
    this.consider(puppet);
    if (!(await this.pause(FEINT_HANGS, ok))) return;
    const open = arm.hand.pose.slice() as Pose;
    arm.hand.setPose(between(open, POSES.pregrip, 0.6), 0.16, 0.01, Easing.inCubic);
    arm.dip = FEINT_DIP;
    if (!(await this.pause(0.2, ok))) return void (arm.dip = 0);
    // No.
    arm.hand.setPose(open, 0.2, 0.02, Easing.outCubic);
    arm.dip = 0;
    await this.pause(0.22, ok);
  }

  // -- found on the board, and at a mate (5.7, 5.8) ----------------------------------------------------

  /** Home again: the hand that has just let go of a stone flicks its fingers on its way home. Never mind. */
  flick(arm: Arm): Promise<void> {
    return this.gesture(arm, async (ok) => {
      arm.hand.setPose(GATHERED, 0.14, 0.01, Easing.inOutCubic);
      if (!(await this.pause(0.16, ok))) return;
      arm.hand.setPose(POSES.splay, 0.09, 0.012, Easing.outCubic);
      void this.lean(arm, { tip: -0.2, y: 0.12 }, 0.1, Easing.outCubic);
      await this.pause(0.45, ok);
    });
  }

  /** The right hand lifts, shut, with its thumb up. */
  thumb(delay = 0): void {
    const arm = this.right;
    void this.gesture(
      arm,
      async (ok) => {
        arm.steady = true;
        arm.omega = 6;
        arm.hand.setPose(THUMB_UP, 0.5, 0.03, Easing.inOutCubic);
        void this.lean(arm, { y: 0.55, z: 0.1, turn: THUMB_TURN, glow: 0.6 }, 0.6);
        if (!(await this.pause(0.6 + 0.9, ok))) return;
        // Once: so.
        if (!(await this.during(0.3, ok, (k) => (arm.swayed.y = 0.55 + 0.1 * Math.sin(Math.PI * k))))) return;
        await this.pause(0.3, ok);
      },
      { delay },
    );
  }

  /** The right hand gives a small wave from side to side, open, as one does at a mirror; `fingers`, with its fingers only. */
  wave(delay = 0, fingers = false, arm: Arm = this.right): void {
    void this.gesture(
      arm,
      async (ok) => {
        const hand = arm.hand;
        arm.omega = 8;
        if (fingers) {
          // The fingers only, one after another, twice: the hand does not leave where it rests.
          for (let i = 0; i < 2; i++) {
            hand.setPose(between(this.resting, POSES.fist, 0.45), 0.16, 0.035, Easing.inOutCubic, ['index', 'middle', 'ring', 'little']);
            if (!(await this.pause(0.26, ok))) return;
            hand.setPose(between(this.resting, POSES.open, 0.6), 0.16, 0.035, Easing.inOutCubic, ['index', 'middle', 'ring', 'little']);
            if (!(await this.pause(0.26, ok))) return;
          }
          return;
        }
        hand.setPose(between(POSES.relaxed, POSES.open, 0.7), 0.35, 0.03, Easing.inOutCubic);
        void this.lean(arm, { y: 0.4, tip: -0.5, glow: 0.5 }, 0.4);
        if (!(await this.pause(0.4, ok))) return;
        await this.during(1.1, ok, (k) => (arm.turn = Math.sin(k * Math.PI * 4) * 0.4 * Math.sin(Math.PI * k)));
      },
      { delay },
    );
  }

  /** Both hands go limp for `seconds`, though nothing is over; and come back. */
  slacken(seconds = 1): void {
    this.each((arm, delay) =>
      this.gesture(
        arm,
        async (ok) => {
          arm.omega = 5;
          arm.hand.setPose(LIMP, 0.35, 0.03, Easing.inCubic);
          void this.lean(arm, { y: -0.3, tip: 0.35 }, 0.4, Easing.inCubic);
          await this.pause(0.4 + seconds, ok);
        },
        { delay: 0.3 + delay },
      ),
    );
  }

  /** A bow: both hands turn palm up, and dip. Resolves when it is made, or will not be. */
  bow(): Promise<void> {
    const made: Promise<void>[] = [];
    this.each((arm, delay) =>
      made.push(
        this.gesture(
          arm,
          async (ok) => {
            arm.omega = 5;
            arm.hand.setPose(OFFERED, 0.7, 0.05, Easing.inOutSine);
            void this.lean(arm, { ...REALLY, y: 0.5 }, 0.8, Easing.inOutSine);
            if (!(await this.pause(0.95, ok))) return;
            void this.lean(arm, { y: 0.12, tip: 0.2 }, 0.45, Easing.inOutSine);
            if (!(await this.pause(0.6, ok))) return;
            void this.lean(arm, { y: 0.5, tip: -0.05 }, 0.45, Easing.inOutSine);
            await this.pause(0.5, ok);
          },
          { delay },
        ),
      ),
    );
    return Promise.all(made).then(() => undefined);
  }

  /** That is that: the right hand, where it rests, brushes its thumb across its fingertips, twice. Resolves when it has. */
  brush(): Promise<void> {
    const arm = this.right;
    return this.gesture(arm, async (ok) => {
      const hand = arm.hand;
      // Where it rests: a hand that has just set the mating stone down is let get home first.
      for (let waited = 0; waited < 1.5 && this.far(arm, this.restingPlace(arm, v1)); waited += 0.05) if (!(await this.pause(0.05, ok))) return;
      arm.steady = true;
      void this.lean(arm, { y: 0.15, turn: -0.5, glow: 0.5 }, 0.3);
      hand.setPose(GATHERED, 0.3, 0.02, Easing.inOutCubic);
      if (!(await this.pause(0.34, ok))) return;
      const across = (to: number, seconds: number) => {
        const p = GATHERED.slice() as Pose;
        const at = fingerOf(GATHERED, 'thumb');
        setFinger(p, 'thumb', [at[0]!, at[1]!, at[2]!, at[3]! + to, at[4]! + 0.25]);
        hand.setPose(p, seconds, 0, Easing.inOutSine, ['thumb']);
      };
      for (let i = 0; i < 2; i++) {
        across(0.35, 0.16);
        if (!(await this.pause(0.18, ok))) return;
        across(-0.2, 0.12);
        if (!(await this.pause(0.2, ok))) return;
      }
      await this.pause(0.25, ok);
    });
  }

  /**
   * The back rank: a hand goes out over one end of a rank, flat, and sweeps along it to the other,
   * above the crowns of what stands there. `from` and `to` are the two ends, on the board. Resolves
   * when it has, or will not.
   */
  sweep(from: Vector3, to: Vector3): Promise<void> {
    // From its own side inward: the hand on the side the sweep begins.
    const arm = this.armFor(from.x);
    const a = from.clone().setY(SWEEPS_AT);
    const b = to.clone().setY(SWEEPS_AT);
    return this.gesture(
      arm,
      async (ok) => {
        arm.steady = true;
        arm.omega = 8;
        arm.hand.setPose(PATTING, 0.4, 0.02, Easing.inOutCubic);
        void this.lean(arm, { glow: 0.8 }, 0.3);
        // Up first, where it is, and then out over the board: it does not come in low over the stones.
        arm.shift(arm.at.get(v1).setY(SWEEPS_AT), 0.05);
        if (!(await this.pause(0.5, ok))) return;
        this.send(arm, a, { focus: PALM_FOCUS, pitch: 0.05, loose: 0 }, 0.8, Easing.inOutSine, [PATTING]);
        if (!(await this.pause(0.9, ok))) return;
        arm.omega = 5;
        if (!(await this.during(0.9, ok, (k) => arm.shift(v1.lerpVectors(a, b, Easing.inOutSine(k)), 0.05)))) return;
        await this.pause(0.25, ok);
      },
      { own: true },
    );
  }

  // -- set off by the player (5.9) ----------------------------------------------------------------------

  /** The page has been come back to: hands that were left start awake, and smooth themselves. */
  wakes(): void {
    this.each((arm, delay) =>
      this.gesture(
        arm,
        async (ok) => {
          await this.recoil(arm, ok, STARTS_AWAKE);
          if (!ok()) return;
          // Smoothed: the fingers drawn together and let out again.
          arm.hand.setPose(GATHERED, 0.3, 0.03, Easing.inOutCubic);
          void this.lean(arm, BEARINGS[this.mood], 0.5);
          if (!(await this.pause(0.4, ok))) return;
          arm.hand.setPose(this.resting, 0.5, 0.05, Easing.inOutCubic);
          await this.pause(0.4, ok);
        },
        { delay },
      ),
    );
  }

  /** A weight on its cord has been set swinging: the hand it hangs from tips to look at it, and holds still until it is nearly so. */
  lookAtWeight(arm: Arm): void {
    void this.gesture(arm, async (ok) => {
      arm.steady = true;
      void this.lean(arm, { y: 0.18, tip: -0.2, turn: -0.9, glow: 0.3 }, 0.35);
      if (!(await this.pause(0.5, ok))) return;
      for (let waited = 0; waited < 4 && arm.hand.weightSpeed > 0.25; waited += 0.1) if (!(await this.pause(0.1, ok))) return;
      await this.pause(0.3, ok);
    });
  }

  // -- endings, and scenes directed from outside (endings.ts) -----------------------------------

  /**
   * Lend an arm to a scene: `script` is given it (Act) the moment it is free, and the arm goes back
   * to rest, as the game now leaves it, when the script is done with it or it is called away.
   */
  act(arm: Arm, script: (it: Act) => Promise<void>, delay = 0): Promise<void> {
    return this.gesture(arm, (ok) => script(this.actor(arm, ok)), { own: true, delay });
  }

  /**
   * How the game now stands for this player, without acting it out: what their hands go back to
   * once whatever they are doing is done. A hand that is doing nothing goes to it now, in `seconds`.
   */
  settle(mood: Mood, seconds = 0.8): void {
    this.mood = mood;
    this.resting = restingFor(mood);
    this.offering = false;
    for (const arm of [this.right, this.left]) {
      if (arm.gesturing || arm.busy || arm.considering) continue;
      void this.lean(arm, BEARINGS[mood], seconds);
      arm.hand.setPose(this.resting, seconds, 0.05, Easing.inOutCubic);
    }
  }

  /**
   * Their time has run out. Each hand stops where it is, over a stone if it was over one, and
   * holds there, quite still but for the weight swinging; then drops, as something does whose
   * string has been cut, and goes most of the way out, as a loser's do.
   */
  cut(): void {
    this.mood = 'lost';
    this.resting = LIMP;
    this.offering = false;
    for (const arm of [this.right, this.left]) {
      // Not thinking any longer: but it stays where the thought had it.
      const thought = arm.considering;
      arm.considering = null;
      void this.gesture(
        arm,
        async (ok) => {
          arm.steady = true;
          arm.musing = null;
          arm.omega = 30;
          const at = arm.at.get(new Vector3());
          arm.shift(at, arm.pitch.value);
          arm.aim = arm.yaw.value;
          if (!(await this.pause(0.6, ok))) return;
          // Not far, over the board: it does not go into the stones.
          const over = Math.abs(at.x) < SLAB_HALF && Math.abs(at.z) < SLAB_HALF;
          arm.omega = 16;
          arm.hand.setPose(LIMP, 0.22, 0.02, Easing.inCubic);
          arm.shift(at.setY(at.y - (thought || over ? 0.22 : 0.6)), arm.pitch.value + 0.35);
          await this.pause(0.4, ok);
        },
        { own: true },
      );
    }
  }

  /** Their player has gone: the hands come apart from the fingertips back, wherever they were and whatever they were doing. */
  vanish(): void {
    this.mood = 'gone';
    this.resting = LIMP;
    this.offering = false;
    for (const arm of [this.right, this.left]) {
      arm.considering = null;
      this.still(arm, 1.6);
      const generation = this.generation;
      const from = arm.hand.dissolve;
      void this.tweens.run({ duration: 1.6, ease: Easing.inOutSine, update: (k) => generation === this.generation && this.mood === 'gone' && (arm.hand.dissolve = from + (1 - from) * k) });
    }
  }

  /**
   * This player has offered a draw. While the offer stands their right hand stays at its corner,
   * turned palm up and open toward the other player. It covers nothing.
   */
  offer(): void {
    if (this.mood !== 'play' || this.offering) return;
    const arm = this.right;
    this.offering = true;
    this.answered = null;
    void this.gesture(arm, async (ok) => {
      arm.omega = 5;
      arm.hand.setPose(OFFERED, 0.8, 0.05, Easing.inOutCubic);
      void this.lean(arm, OFFERING, 0.9);
      while (this.offering && (await this.pause(0.1, ok)));
      if (!ok() || !this.answered) return;
      // Refused: it hangs there a beat longer than is comfortable. Taken back: it is its own idea, and quicker.
      const refused = this.answered === 'refused';
      if (!(await this.pause(refused ? 0.9 : 0.15, ok))) return;
      // The fingers close one at a time, the little finger first; and it turns back over.
      const shut = refused ? 0.22 : 0.12;
      for (const finger of ['little', 'ring', 'middle', 'index', 'thumb'] as FingerName[]) {
        arm.hand.setPose(between(POSES.relaxed, POSES.fist, 0.7), shut * 1.4, 0, Easing.inOutCubic, [finger]);
        if (!(await this.pause(shut, ok))) return;
      }
      void this.lean(arm, BEARINGS[this.mood], refused ? 0.7 : 0.45);
      await this.pause(refused ? 0.7 : 0.45, ok);
    });
  }

  /**
   * The offer this player made is over: `refused` by the other player, `withdrawn` by this one, or
   * `taken` (the game is drawn, and what the hand does then is the ending's: endings.ts).
   */
  answer(how: 'refused' | 'withdrawn' | 'taken'): void {
    if (!this.offering) return;
    this.offering = false;
    this.answered = how === 'taken' ? null : how;
  }

  /** True while this player's offer of a draw stands. */
  get offered(): boolean {
    return this.offering;
  }

  private actor(arm: Arm, ok: () => boolean): Act {
    const end = this.flip;
    const room = (p: Vector3, out = new Vector3()) => out.set(p.x * end, p.y, p.z * end);
    const heading = (h: number) => h + (end < 0 ? Math.PI : 0);
    return {
      arm,
      hand: arm.hand,
      end,
      ok,
      go: (to, stance, seconds, poses = [arm.hand.pose]) => {
        if (!ok()) return;
        const at = room(to);
        const askew = nearestTurn(heading(stance.heading) - arm.hand.headingTo(at), 0);
        this.send(arm, at, { focus: stance.focus ?? PALM_FOCUS, pitch: stance.pitch, loose: stance.loose ?? 0, askew }, seconds, Easing.inOutSine, poses);
        arm.roll.goal = stance.roll ?? 0;
      },
      shift: (to, pitch = arm.pitch.goal) => ok() && arm.shift(room(to, v3), pitch),
      aim: (h) => ok() && (arm.aim = h === null ? null : heading(h)),
      roll: (by) => ok() && (arm.roll.goal = by),
      speed: (omega) => ok() && (arm.omega = omega),
      pose: (pose, seconds, ripple = 0.03, fingers) => ok() && arm.hand.setPose(pose, seconds, ripple, Easing.inOutCubic, fingers),
      lean: (to, seconds) => (ok() ? this.lean(arm, to, seconds) : Promise.resolve()),
      steady: (on) => ok() && (arm.steady = on),
      pause: (seconds) => this.pause(seconds, ok),
      during: (seconds, update) => this.during(seconds, ok, update),
      rail: async () => {
        const down = await this.alight(arm, ok);
        return down ? room(down.place) : null;
      },
      lift: async (seconds) => {
        await this.unplant(arm, seconds);
        if (!ok()) return;
        arm.omega = 9;
        arm.shift(arm.at.goal(v3).setY(arm.at.goal(v3).y + RAIL_CLEAR), arm.pitch.goal);
      },
      room,
      where: (out = new Vector3()) => room(arm.at.get(out), out),
    };
  }

  /** Do `update` every frame for `seconds`, with how far through it is (0 to 1): but no longer than the gesture is the hand's to make. True if it still is. */
  private async during(seconds: number, ok: () => boolean, update: (k: number) => void): Promise<boolean> {
    let over = false;
    void this.tweens.run({ duration: seconds, ease: (k) => k, update: (k) => !over && ok() && update(k) }).then(() => (over = true));
    while (!over && ok()) await this.tweens.wait(0.05);
    over = true;
    return ok();
  }

  private async pause(seconds: number, ok: () => boolean): Promise<boolean> {
    for (let left = seconds; left > 1e-6; left -= 0.05) {
      await this.tweens.wait(Math.min(0.05, left));
      if (!ok()) return false;
    }
    return ok();
  }

  /** Some of the arm's fingers have been set down on something (`Hand.touch`), and are to stay there. */
  private plant(arm: Arm): void {
    arm.planted = true;
    arm.plants++;
  }

  /** They come away again, over `seconds`: at once enough that a hand called to a piece has let go before it gets there. */
  private unplant(arm: Arm, seconds = 0.1): Promise<void> {
    if (!arm.planted) return Promise.resolve();
    arm.planted = false;
    const token = ++arm.plants;
    const hand = arm.hand;
    const from = hand.touchWeight;
    return this.tweens.run({
      duration: seconds,
      ease: Easing.inOutSine,
      update: (k) => {
        // Set down again since, or holding a piece now: the fingers are not this one's to move.
        if (arm.plants !== token || arm.held) return;
        hand.touchWeight = from * (1 - k);
        if (k >= 1) hand.clearTouch();
      },
    });
  }

  /**
   * Have both arms make one gesture between them. `steps` is told whether it is still theirs to
   * make: it is not once either is given anything else to do. When it is over, or when one of
   * them has been called away, each that is still free goes back to how it is held at rest.
   */
  private async duet(steps: (ok: () => boolean) => Promise<void>): Promise<void> {
    const arms = [this.right, this.left];
    const generation = this.generation;
    if (arms.some((arm) => arm.busy || arm.considering || arm.gesturing)) return;
    const tokens = arms.map((arm) => ++arm.acts);
    const mine = (i: number) => generation === this.generation && arms[i]!.acts === tokens[i];
    const ok = () => mine(0) && mine(1) && arms.every((arm) => !arm.busy && !arm.considering);
    for (const arm of arms) {
      void this.unplant(arm);
      arm.gesturing = true;
      arm.acting = true;
      arm.idling = false;
      arm.steady = false;
    }
    await steps(ok);
    arms.forEach((arm, i) => {
      // Whatever overtook this one has seen to it.
      if (!mine(i)) return;
      arm.gesturing = false;
      arm.acting = false;
      arm.idling = false;
      arm.steady = false;
      void this.unplant(arm);
      void this.lean(arm, BEARINGS[this.mood], 0.8);
      if (arm.busy || arm.considering) return;
      arm.omega = 7.5;
      arm.hand.setPose(this.resting, 0.7, 0.06, Easing.inOutCubic);
      this.rest(arm);
    });
  }

  /** Both arms, the left a moment after the right: two hands that did the same thing at the same instant would be one hand and a mirror. */
  private each(act: (arm: Arm, delay: number) => unknown): void {
    act(this.right, 0);
    act(this.left, 0.07);
  }

  /**
   * Have an arm make a gesture, once it is free: `steps` is told whether the gesture is still the
   * arm's to make (it is not once a piece is to be moved, a piece is thought about, or another
   * gesture is asked for), and should stop where it finds it is not. `own` says that the gesture
   * takes the hand somewhere of its own, and not about where it rests. When it is over the hand
   * goes back to how it is held at rest.
   */
  private async gesture(arm: Arm, steps: (ok: () => boolean) => Promise<void>, options: { own?: boolean; delay?: number } = {}): Promise<void> {
    const token = ++arm.acts;
    const generation = this.generation;
    const mine = () => generation === this.generation && arm.acts === token;
    const ok = () => mine() && !arm.busy && !arm.considering;
    arm.pending++;
    if (options.delay) await this.tweens.wait(options.delay);
    for (let waited = 0; mine() && arm.busy && waited < 6; waited += 0.05) await this.tweens.wait(0.05);
    arm.pending--;
    if (!ok()) return;
    void this.unplant(arm);
    arm.gesturing = true;
    arm.acting = options.own ?? false;
    arm.idling = false;
    arm.steady = false;
    await steps(ok);
    // Whatever overtook it has seen to the hand.
    if (!mine()) return;
    arm.gesturing = false;
    arm.acting = false;
    arm.idling = false;
    arm.steady = false;
    void this.lean(arm, BEARINGS[this.mood], 0.8);
    if (!ok()) return;
    arm.omega = 7.5;
    arm.hand.setPose(this.resting, 0.7, 0.06, Easing.inOutCubic);
    if (options.own) this.rest(arm);
  }

  /** Whatever gesture an arm was making, it is not making it any longer; what it had done to how the hand is held is undone in `seconds`. */
  private still(arm: Arm, seconds = 0.3): void {
    arm.acts++;
    arm.gesturing = false;
    arm.acting = false;
    arm.idling = false;
    arm.steady = false;
    arm.musing = null;
    arm.aim = null;
    void this.unplant(arm);
    void this.lean(arm, BEARINGS[this.mood], seconds);
  }

  /** Bring how a hand is held (Bearing) to `to`, in `seconds`. What is not named is left as it is. */
  private lean(arm: Arm, to: Partial<Bearing>, seconds: number, ease: Ease = Easing.inOutCubic): Promise<void> {
    const token = ++arm.leans;
    const from: Bearing = { x: arm.swayed.x, y: arm.swayed.y, z: arm.swayed.z, tip: arm.tip, turn: arm.turn, glow: arm.glow, presence: arm.presence, outline: arm.hand.outline };
    const goal: Bearing = { ...from, ...to };
    const at = (a: number, b: number, k: number) => a + (b - a) * k;
    return this.tweens.run({
      duration: Math.max(0.01, seconds),
      ease,
      update: (k) => {
        if (arm.leans !== token) return;
        arm.swayed.set(at(from.x, goal.x, k), at(from.y, goal.y, k), at(from.z, goal.z, k));
        arm.tip = at(from.tip, goal.tip, k);
        arm.turn = at(from.turn, goal.turn, k);
        arm.glow = at(from.glow, goal.glow, k);
        arm.presence = at(from.presence, goal.presence, k);
        arm.hand.outline = at(from.outline, goal.outline, k);
      },
    });
  }

  update(dt: number, time: number): void {
    this.time = time;
    const idle = [this.right, this.left].every((arm) => !arm.busy && !arm.considering);
    this.waiting = idle ? this.waiting + dt : 0;
    if (this.waiting > this.patience) this.passTheTime();
    // Fingers set down on something let go of it the moment there is a piece to see to: and both
    // hands' do, if what they were set down on was each other.
    const wanted = (arm: Arm) => arm.busy || arm.considering !== null;
    for (const arm of [this.right, this.left]) {
      if (arm.planted && (wanted(arm) || (this.paired && wanted(this.other(arm))))) void this.unplant(arm, 0.12);
      // A hand that is not carrying anything is as restless as hands are, unless a gesture has it hold still.
      if (!arm.busy) arm.hand.restless += ((arm.steady && arm.gesturing ? 0 : 1) - arm.hand.restless) * Math.min(1, dt * 7);
    }
    if (!this.right.planted || !this.left.planted) this.paired = false;
    for (const arm of [this.right, this.left]) {
      if (!arm.busy && !arm.considering && !arm.acting) this.driftAtRest(arm);
      else if (!arm.busy && arm.considering) this.driftInThought(arm);
      arm.update(dt, time);
    }
  }

  // -- internals --------------------------------------------------------------

  /**
   * How tall the tallest stone is that stands under the way from `from` by `corner` to `to`, other
   * than `puppet` itself and whatever stands where it is going (which is being taken away): 0 if
   * the way is clear.
   */
  private tallestUnder(puppet: Puppet, from: Vector3, corner: Vector3, to: Vector3): number {
    let tallest = 0;
    for (const other of this.stones()) {
      if (other === puppet) continue;
      const p = other.group.position;
      if (Math.hypot(p.x - to.x, p.z - to.z) < 0.3) continue;
      if (Math.min(offLine(p, from, corner), offLine(p, corner, to)) < 0.7) tallest = Math.max(tallest, PIECE_HEIGHT[other.kind]);
    }
    return tallest;
  }

  /** The stones a hand on its way must keep clear of: every one that is standing, not one that a hand has hold of. */
  private *stones(): Iterable<Puppet> {
    for (const puppet of this.around()) if (puppet !== this.right.held?.puppet && puppet !== this.left.held?.puppet) yield puppet;
  }

  /**
   * Send `arm` to hang over `puppet`, ready to take it: over the part of it the hand would take it
   * by, tipped as it would be to take it, and higher than it likes to hover if a hand hovering there
   * would be touching something. It arrives fast and then holds. This says how it is held there.
   */
  private hover(arm: Arm, puppet: Puppet, reach?: Reach): { puppet: Puppet; grip: PieceGrip; pitch: number; lift: number } {
    const { grip, spec, pitch } = this.hold(arm, puppet, undefined, reach);
    const posture = { focus: spec.centre, pitch: pitch + 0.06, loose: 0 };
    const pose = poised(arm.hand, spec, grip, posture.pitch);
    const over = arm.hoverPoint(puppet, grip, 0, new Vector3());
    const yaw = arm.hand.headingTo(over);
    const stones = [...this.stones()];
    let lift = 0;
    while (lift < HOVER_MORE && sunk(arm.hand, over, posture, yaw, pose, stones) > -HOVER_CLEAR) {
      lift += 0.05;
      over.y += 0.05;
    }
    arm.omega = 22;
    arm.hand.setPose(pose, 0.22, 0.03);
    this.send(arm, over, posture, 0.3, dart, [pose]);
    return { puppet, grip, pitch: posture.pitch, lift };
  }

  /**
   * Send `arm` to wait for `puppet` out of the way of the player's other hand, which has something
   * to do beside it: above where it would hang over the piece, back toward its player and out a
   * little to its own side, tipped less than it will be.
   */
  private standOff(arm: Arm, puppet: Puppet, reach?: Reach): void {
    const { grip, spec, pitch } = this.hold(arm, puppet, undefined, reach);
    const off = arm.hoverPoint(puppet, grip, 0, new Vector3());
    off.x += Math.sign(arm.home.x) * STANDS_OFF.x;
    off.y += STANDS_OFF.y;
    off.z += this.flip * STANDS_OFF.z;
    const posture = { focus: spec.centre, pitch: pitch * 0.6, loose: 0 };
    // Higher, if there is something standing where it has drawn off to.
    const yaw = arm.hand.headingTo(off);
    const stones = [...this.stones()];
    for (let more = 0; more < STANDS_OFF_MORE && sunk(arm.hand, off, posture, yaw, POSES.hover, stones) > -STANDS_CLEAR; more += 0.05) off.y += 0.05;
    arm.omega = 12;
    arm.hand.setPose(POSES.hover, 0.3, 0.03);
    this.send(arm, off, posture, 0.42, Easing.inOutSine, [POSES.hover]);
  }

  /**
   * How `arm` should take hold of `puppet` where it stands, to set it down with its foot at `to` if
   * that is known yet: by the first of the parts it can be held by that the hand can close on, and
   * let go of, clear of everything else; or by whichever comes nearest to that.
   */
  private hold(arm: Arm, puppet: Puppet, to?: Vector3, reach?: Reach, beside?: Beside): Hold {
    let best: Hold | null = null;
    let least = Infinity;
    const parts = holds(puppet, this.gripOf(puppet));
    // From above, its head is the first of it a hand comes to.
    if (reach === 'over') parts.reverse();
    for (const grip of parts) {
      const spec = GRIPS[grip.type];
      const tips = tilts(spec, reach);
      const at = arm.gripPoint(puppet, grip, new Vector3());
      const yaw = arm.hand.headingTo(at);
      const gap = opening(arm, puppet, grip);
      let tucked = false;
      const shape = (tip: number, open: number) => pregrip(arm.hand, spec, grip, tip, open, tucked);
      // Where it stands now, a piece that is to move with it is about to be gone.
      let taken = this.fit(arm, puppet, grip, spec, at, yaw, gap, shape, tips, beside && { puppet: beside.puppet });
      // Where that leaves its idle fingers all but touching what stands by, they come down folded in.
      if (taken.deep > -TUCK_ROOM && (spec.contacts.ring === undefined || spec.contacts.little === undefined)) {
        tucked = true;
        const folded = this.fit(arm, puppet, grip, spec, at, yaw, gap, shape, tips, beside && { puppet: beside.puppet });
        if (folded.deep < taken.deep) taken = folded;
        else tucked = false;
      }
      let deep = taken.deep;
      // Where its grip will be once it stands at `to`.
      if (to) deep = Math.max(deep, this.fit(arm, puppet, grip, spec, at.sub(puppet.group.position).add(to), yaw, gap + LETS_GO, shape, tips, beside).deep);
      if (!best || deep < least - GRAZE) {
        best = { grip, spec, pitch: taken.pitch, gap: taken.gap, tucked };
        least = deep;
      }
      if (least <= GRAZE) break;
    }
    return best!;
  }

  /**
   * How to hold `puppet` where the part it is held by is at `at`, heading along `yaw`: how far to
   * tip the hand, and how far clear of the piece to open the fingers that close on it (`gap` is
   * what they would like; `shape` is the hand's pose, tipped and opened so far). As the grip would
   * have it, if that keeps the hand out of everything standing there, all the way down onto the
   * piece from above it or up off it; otherwise whatever comes nearest to doing so. `deep` is how
   * far into something the hand would still be. `tips` are the tilts it may take, in the order to
   * try them. `beside` is a piece that will not be where it is now: it is tried where it will
   * stand, or left out if that is not said.
   */
  private fit(
    arm: Arm,
    puppet: Puppet,
    grip: PieceGrip,
    spec: GripSpec,
    at: Vector3,
    yaw: number,
    gap: number,
    shape: (tip: number, open: number) => Pose,
    tips: number[],
    beside?: { puppet: Puppet; at?: Vector3 },
  ): { pitch: number; gap: number; deep: number } {
    // Whatever stands in the very place this piece is to stand is on its way out of it.
    const others = [...this.stones()].filter((other) => other !== puppet && other !== beside?.puppet && Math.hypot(other.group.position.x - at.x, other.group.position.z - at.z) > SAME_PLACE);
    const moved = beside?.at ? { puppet: beside.puppet, by: beside.at.clone().sub(beside.puppet.group.position) } : undefined;
    if (moved) others.push(moved.puppet);
    const held = { focus: spec.centre, pitch: spec.pitch, loose: 0 };
    // The piece itself is where it is: the hand is tried against it there, and against the others here.
    const own = [puppet];
    const there = arm.gripPoint(puppet, grip, new Vector3());
    const above = new Vector3();
    const best = { pitch: tips[0]!, gap, deep: Infinity };
    for (const room of ROOMS) {
      for (const tip of tips) {
        held.pitch = tip;
        const pose = shape(held.pitch, gap * room);
        let deep = sunk(arm.hand, at, held, yaw, pose, others, moved);
        // The way down onto the piece, or up off it, past its own top and beside whatever stands round it.
        for (const up of ABOVE) {
          if (deep > best.deep) break;
          deep = Math.max(deep, sunk(arm.hand, above.copy(at).setY(at.y + up), held, yaw, pose, others, moved));
          if (deep > best.deep) break;
          deep = Math.max(deep, sunk(arm.hand, above.copy(there).setY(there.y + up), held, yaw, pose, own));
        }
        if (deep < best.deep) {
          best.deep = deep;
          best.pitch = held.pitch;
          best.gap = gap * room;
        }
        if (deep <= GRAZE) return best;
      }
    }
    return best;
  }

  /**
   * How far down a hand held as `held` at `at`, heading along `yaw`, with its fingers in `pose`, may
   * tip them as it rises from there (see DROOP): as far as takes them no nearer to the stones
   * standing round than they are, or than DROOP_CLEAR from them.
   */
  private roomToDroop(arm: Arm, at: Vector3, held: Posture, yaw: number, pose: Pose): number {
    const stones = [...this.stones()];
    const tipped = { ...held };
    const now = sunk(arm.hand, at, held, yaw, pose, stones);
    for (const droop of DROOPS) {
      tipped.pitch = held.pitch + droop;
      if (sunk(arm.hand, at, tipped, yaw, pose, stones) <= Math.max(now, -DROOP_CLEAR)) return droop;
    }
    return 0;
  }

  /**
   * Send an arm to a point, there to be held as `held`. With far to go it crosses in `seconds`, over
   * whatever stands in its way (flight.ts), and this is true; all but there already, it closes on
   * the point as fast as it has been told to (its omega), and this is false. `plumb` is how far a
   * crossing goes straight up before anything else.
   */
  private send(arm: Arm, to: Vector3, held: Posture, seconds: number, ease: Ease, poses: Pose[], plumb = 0): boolean {
    if (!this.far(arm, to)) {
      arm.go(to, held);
      return false;
    }
    arm.fly(to, held, seconds, ease, poses, this.stones(), this.mate(arm), plumb);
    return true;
  }

  /** The player's other hand, if it is at work too: what `arm` must pass above on its way (flight.ts). */
  private mate(arm: Arm): number[] | undefined {
    const other = this.other(arm);
    return other.busy ? other.inTheWay() : undefined;
  }

  /** Whether an arm has far enough to go to a point for something to stand in its way. */
  private far(arm: Arm, to: Vector3): boolean {
    arm.at.get(v2);
    return Math.hypot(to.x - v2.x, to.z - v2.z) >= NEAR;
  }

  /**
   * What idle hands do (style bible, 6.4): the player to move drums their fingers; the one waiting
   * stretches a hand open and lets it fall closed again. The two arms take turns.
   */
  private passTheTime(): void {
    this.habit++;
    const arm = this.habit % 2 === 0 ? this.right : this.left;
    this.waiting = 0;
    // Not on a fixed beat: the gaps run from about five seconds to eleven.
    this.patience = 5 + ((this.habit * 0.618 + (this.side === 'w' ? 0 : 0.37)) % 1) * 6;
    // Hands that have won or lost have done with waiting.
    if (this.mood !== 'play' || arm.gesturing) return;
    if (this.idle?.(this.attentive)) return;
    // Not the same thing every time. Each arm takes its turns at them: the stretch (or the drumming)
    // every other time, and between those one of the others.
    const turn = Math.floor((this.habit - 1) / 2) + (this.side === 'w' ? 0 : 2);
    if (this.attentive) {
      if (turn % 4 === 1) void this.gesture(arm, (ok) => this.weigh(arm, ok));
      else arm.hand.drumFingers(2 + (this.habit % 2));
      return;
    }
    if (turn % 4 === 1) return void this.gesture(arm, (ok) => this.furl(arm, ok));
    if (turn % 4 === 3) return void this.gesture(arm, (ok) => this.turnOver(arm, ok));
    const generation = this.generation;
    arm.hand.setPose(POSES.splay, 0.55, 0.06, Easing.inOutCubic);
    void this.tweens.run({ duration: 0.55, ease: Easing.inOutCubic, update: (k) => (arm.drawn = k) });
    void this.tweens.wait(0.75).then(() => {
      if (generation === this.generation && !arm.busy && !arm.considering && !arm.gesturing) arm.hand.setPose(this.resting, 0.9, 0.07, Easing.inOutCubic);
      void this.tweens.run({ duration: 0.9, ease: Easing.inOutCubic, update: (k) => (arm.drawn = 1 - k) });
    });
  }

  /** Send an arm home: unhurried, over whatever stands between; and straight up by `plumb` first. */
  private rest(arm: Arm, plumb = 0): void {
    arm.omega = 7.5;
    const home = this.restingPlace(arm, new Vector3());
    arm.at.get(v2);
    const seconds = Math.min(1, 0.5 + 0.045 * Math.hypot(home.x - v2.x, home.z - v2.z));
    const askew = (arm === this.right ? 1 : -1) * LIES_IN;
    this.send(arm, home, { focus: PALM_FOCUS, pitch: this.restingPitch(), loose: 1, askew }, seconds, Easing.inOutSine, [this.resting], plumb);
  }

  /**
   * A resting hand is never quite still: it floats, it tips and rolls a little as something does
   * that hangs in the air, and it leans in when its player is to move.
   */
  private driftAtRest(arm: Arm): void {
    const t = this.time;
    const phase = arm === this.right ? 0 : 1.9;
    arm.shift(this.restingPlace(arm, v1), this.restingPitch() + Math.sin(t * 0.43 + phase * 1.1) * 0.035 + arm.tip);
    if (!arm.crossing) arm.roll.goal = Math.sin(t * 0.33 + phase * 1.3) * 0.05 + arm.turn;
  }

  /**
   * Nor is a hand in thought: it rides a little on the air over the piece it is thinking of. Only
   * upward from where it was put, which was as low as it could be without touching anything.
   */
  private driftInThought(arm: Arm): void {
    const thought = arm.considering;
    if (!thought || arm.crossing) return;
    const t = this.time;
    const phase = arm === this.right ? 0 : 1.9;
    arm.hoverPoint(thought.puppet, thought.grip, thought.lift, v1);
    v1.y += 0.022 * (1 + Math.sin(t * 1.25 + phase)) - arm.dip;
    arm.shift(v1, thought.pitch + Math.sin(t * 0.8 + phase) * 0.018);
  }

  private restingPlace(arm: Arm, out: Vector3): Vector3 {
    const t = this.time;
    const phase = arm === this.right ? 0 : 1.9;
    out.copy(arm.home);
    // Two slow swings in each direction, not in step with one another: it never comes round to
    // the same place the same way.
    out.x += Math.sin(t * 0.37 + phase) * 0.07 + Math.sin(t * 0.83 + phase * 2.3) * 0.025;
    out.y += Math.sin(t * 0.51 + phase * 1.7) * 0.06 + Math.sin(t * 1.13 + phase) * 0.02 + (this.attentive ? LEANS_UP : -SITS_LOW);
    out.z += (Math.cos(t * 0.29 + phase) * 0.07 + Math.sin(t * 0.71 + phase * 0.6) * 0.025 - (this.attentive ? LEANS_IN : 0)) * this.flip;
    // Where a gesture has it, or how the game stands.
    out.x -= Math.sign(arm.home.x) * arm.swayed.x;
    out.y += arm.swayed.y + arm.wary;
    out.z -= this.flip * arm.swayed.z;
    // Back along the way its fingers point, if it is stretching them.
    const back = arm.drawn * DRAWS_BACK;
    out.x += Math.sin(arm.yaw.value) * back;
    out.z += Math.cos(arm.yaw.value) * back;
    return out;
  }

  private restingPitch(): number {
    return this.attentive ? 0.3 : 0.2;
  }
}

export type { Arm };
