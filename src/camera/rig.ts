/**
 * Camera rig: five switchable views with eased, arcing transitions, and a
 * small director that pushes in for captures, check and checkmate.
 *
 * Every view is described as a shot (where the camera is, what it looks at,
 * which way is up, field of view). Changing view never cuts: the rig blends
 * from wherever the camera is now to the new shot, swinging around the board
 * on an arc while the orientation turns with it.
 */
import { MathUtils, Matrix4, type PerspectiveCamera, Quaternion, Vector2, Vector3 } from 'three';
import type { Side, Square } from '../core/game';
import { squareCenter } from '../scene/layout';
import { Easing, clamp01, lerp } from '../scene/tween';

export type CameraMode = 'top' | 'side' | 'shoulder' | 'eyes' | 'orbit';

export const CAMERA_MODES: { id: CameraMode; label: string; key: string; hint: string }[] = [
  { id: 'top', label: 'Top', key: '1', hint: 'Straight down, for reading the position' },
  { id: 'side', label: 'Side', key: '2', hint: 'From the side of the board, both players in view' },
  { id: 'shoulder', label: 'Shoulder', key: '3', hint: 'Behind the player to move' },
  { id: 'eyes', label: 'Eyes', key: '4', hint: "From the player's own eyes" },
  { id: 'orbit', label: 'Orbit', key: '5', hint: 'Drag to look around, scroll to zoom' },
];

export type CutKind = 'capture' | 'check' | 'mate';

interface Shot {
  position: Vector3;
  target: Vector3;
  up: Vector3;
  fov: number;
}

interface Pose {
  position: Vector3;
  quaternion: Quaternion;
  fov: number;
}

/** Remembers which way round a blend is going, so that it cannot change its mind half way. */
interface Winding {
  turn: number | null;
}

interface Cut extends Winding {
  shot: (age: number, out: Shot) => void;
  rampIn: number;
  hold: number;
  rampOut: number;
  age: number;
  /** Set when the cut is let go early: when, and how far in it was. */
  released: { age: number; weight: number } | null;
}

const PIVOT = new Vector3(0, 0.4, 0);
const UP = new Vector3(0, 1, 0);
/** The room's ceiling is 25 above the board and its walls are 23 out; cameras stay inside both. */
const TOP_HEIGHT = 22;
const ROOM_REACH = 20.5;
/** The shots are composed for screens at least this wide relative to their height. */
const NOMINAL_ASPECT = 1.5;
const ORBIT_TARGET = new Vector3(0, 0.2, 0);
const ORBIT_FOV = 36;

/**
 * A tall screen (a phone held upright) is framed another way. The board is a square and the
 * screen is not, so standing back far enough to see it whole from the side, as on a wide screen,
 * leaves it a strip across the middle with its squares too small to touch. Instead the camera
 * comes in and up until the board spans the width, and the height that is left goes to the far
 * side's hands and the room above it. At this shape and narrower the views are framed wholly
 * that way; from TALL_UNTIL and wider, wholly as before; between the two, a blend of both, so
 * that turning a phone or dragging a window never makes the picture jump.
 */
const TALL_FROM = 1.0;
const TALL_UNTIL = 1.3;
/**
 * How each view is framed on a tall screen. `azimuth` is the bearing round the board from Ivory's
 * side, `elevation` how high (both in radians), `lens` the field of view across the screen in
 * degrees, and `low` where the middle of the board stands, from -1 at the foot of the picture to
 * 1 at its head: a little below the middle, so that what is above it has room. The board's
 * corners come to `margin` of the half width at the widest. `sway` is how far the camera may be
 * carried sideways, by the pointer and its slow breath together, with what it looks at held still
 * (see `compose`); the framing keeps room for it.
 */
interface Tall {
  azimuth: number;
  elevation: number;
  lens: number;
  low: number;
  margin: number;
  sway: number;
}
const TALL: Record<'side' | 'shoulder' | 'eyes' | 'orbit', Omit<Tall, 'azimuth'> & { azimuth?: number }> = {
  // From the side, higher than on a wide screen; both players' hands are at its edges.
  side: { azimuth: Math.PI / 2, elevation: 0.9, lens: 24, low: -0.12, margin: 0.95, sway: 0.05 },
  // From behind the player and a little to their right, as on a wide screen, but higher.
  shoulder: { azimuth: 0.18, elevation: 0.95, lens: 24, low: -0.16, margin: 0.95, sway: 0.4 },
  // Straight on from the player's own place, the lowest of them and the widest lens, so it stays close.
  eyes: { azimuth: 0, elevation: 0.8, lens: 32, low: -0.14, margin: 0.95, sway: 0.3 },
  orbit: { elevation: 0, lens: 24, low: -0.12, margin: 0.95, sway: 0 },
};
/** The free view's height on a tall screen: the whole of its range is carried up into this one, so dragging still does something everywhere. */
const TALL_ORBIT_LOWEST = 0.62;
const ORBIT_LOWEST = 0.12;
const ORBIT_HIGHEST = 1.3;
/** The free view's distance on a tall screen is the distance that fits the board, times its own against this one. */
const ORBIT_HOME_RADIUS = 16.5;
/** The middle of the board, which a tall framing turns about, and its four corners, which it fits. */
const TALL_AIM = new Vector3(0, 0.1, 0);
const BOARD_CORNERS = [new Vector3(-4, 0, -4), new Vector3(4, 0, -4), new Vector3(-4, 0, 4), new Vector3(4, 0, 4)];
/**
 * How far up and down the picture any corner may come, against half its height. On a tablet the
 * foot of the picture is kept clearer, for the buttons along the bottom and the list of moves
 * beside them (on a phone the board stands well above them anyway). Nearer square, where the board
 * is short of height, it may come further down: there it is a phone on its side, framed between the
 * columns of its interface with nothing under it (see World), or a window about as wide as it is tall.
 */
const TALL_HEAD = 0.9;
const TALL_FOOT = { tall: 0.66, square: 0.9, from: 0.8, until: 1.1 };
/** Tall framings keep the camera under the roof beams, as the overhead view does, with a little to spare. */
const TALL_ROOF = TOP_HEIGHT - 0.5;
/** How soft the choice of whichever corner needs the camera furthest back is, in units of distance: a hair, so the free view does not lurch as a corner takes over from another. */
const TALL_SOFTNESS = 0.25;

/**
 * The thud: when a stone is set down the picture dips and springs back, as if the weight had
 * been felt through the floor. It is a spring that is struck, and it is over in a third of a second.
 */
const THUD_RATE = Math.PI * 2 * 6.2;
const THUD_DAMPING = 0.45;
const THUD_RING = THUD_RATE * Math.sqrt(1 - THUD_DAMPING * THUD_DAMPING);
/** How far the spring swings at its furthest for a blow of one, as a share of the blow's speed. */
const THUD_REACH = Math.exp((-THUD_DAMPING * Math.atan2(Math.sqrt(1 - THUD_DAMPING * THUD_DAMPING), THUD_DAMPING)) / Math.sqrt(1 - THUD_DAMPING * THUD_DAMPING)) / THUD_RATE;
/** The dip a blow of one gives, as a share of the height of the picture: three pixels in a thousand. */
const THUD_DIP = 0.003;
/** However hard and however often it is struck, the picture never dips further than this share of its height. */
const THUD_LIMIT = 0.013;

const newShot = (): Shot => ({ position: new Vector3(), target: new Vector3(), up: new Vector3(0, 1, 0), fov: 40 });
const newPose = (): Pose => ({ position: new Vector3(), quaternion: new Quaternion(), fov: 40 });

const lookMatrix = new Matrix4();
function poseFromShot(shot: Shot, out: Pose): Pose {
  out.position.copy(shot.position);
  lookMatrix.lookAt(shot.position, shot.target, shot.up);
  out.quaternion.setFromRotationMatrix(lookMatrix);
  out.fov = shot.fov;
  return out;
}

const va = new Vector3();
const vb = new Vector3();
const qArc = new Quaternion();
const qRest = new Quaternion();
/**
 * Blend two poses. The position travels on an arc around the board (so the
 * camera swings rather than cutting through the pieces), and the orientation
 * is carried round with that arc, so the camera goes on facing the board.
 *
 * Two poses on opposite sides of the board have two equally short ways
 * round. `winding` holds the choice made on the first frame of a blend so
 * that later frames, where the poses have drifted a hair, keep to it.
 */
function blendPose(a: Pose, b: Pose, k: number, out: Pose, winding: Winding): Pose {
  va.copy(a.position).sub(PIVOT);
  vb.copy(b.position).sub(PIVOT);
  const ra = va.length();
  const rb = vb.length();
  const elevationA = Math.asin(MathUtils.clamp(va.y / ra, -1, 1));
  const elevationB = Math.asin(MathUtils.clamp(vb.y / rb, -1, 1));
  const azimuthA = Math.atan2(va.x, va.z);
  const azimuthB = Math.atan2(vb.x, vb.z);
  const flatA = Math.hypot(va.x, va.z);
  const flatB = Math.hypot(vb.x, vb.z);

  // The shortest way round on the first frame; after that, whichever equivalent angle is nearest last frame's.
  const reference = winding.turn ?? 0;
  const turn = reference + MathUtils.euclideanModulo(azimuthB - azimuthA - reference + Math.PI, Math.PI * 2) - Math.PI;
  winding.turn = turn;
  // Directly overhead the azimuth means nothing, so the swing fades out as either pose nears the axis.
  const swing = turn * MathUtils.smoothstep(flatA / ra, 0.02, 0.08) * MathUtils.smoothstep(flatB / rb, 0.02, 0.08);
  // Each pose's bearing is carried round by its share of the swing, and the two are cross-faded by how far
  // each stands from the axis. With a full swing they agree; with none, the pose that has a bearing wins.
  const fromA = azimuthA + swing * k;
  const fromB = azimuthB - swing * (1 - k);
  const azimuth = Math.atan2(
    (1 - k) * flatA * Math.sin(fromA) + k * flatB * Math.sin(fromB),
    (1 - k) * flatA * Math.cos(fromA) + k * flatB * Math.cos(fromB),
  );
  const elevation = lerp(elevationA, elevationB, k);
  const radius = lerp(ra, rb, k);
  out.position
    .set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation))
    .multiplyScalar(radius)
    .add(PIVOT);

  // Take the swing out of the destination, blend what is left, then put back as much swing as has happened.
  qRest.setFromAxisAngle(UP, -swing).multiply(b.quaternion);
  out.quaternion.slerpQuaternions(a.quaternion, qRest, k).premultiply(qArc.setFromAxisAngle(UP, swing * k));
  out.fov = lerp(a.fov, b.fov, k);
  return out;
}

const tAway = new Vector3();
const tRight = new Vector3();
const tUp = new Vector3();
const tForward = new Vector3();
const tCorner = new Vector3();
const tNeeds: number[] = [];
/** How far the last framing (see `tallDistance`) moved the camera sideways, along `tRight`, to put the board in the middle of the picture. */
let tShift = 0;
/** The board's corners across, up and along the camera's axes, measured from the middle of the board. */
const fitX = BOARD_CORNERS.map(() => 0);
const fitY = BOARD_CORNERS.map(() => 0);
const fitZ = BOARD_CORNERS.map(() => 0);

/** The softened greatest of `tNeeds` (see TALL_SOFTNESS). */
function softMost(): number {
  const most = Math.max(...tNeeds);
  let sum = 0;
  for (const n of tNeeds) sum += Math.exp((n - most) / TALL_SOFTNESS);
  return most + TALL_SOFTNESS * Math.log(sum);
}

/**
 * How far back from the middle of the board a camera looking from `tAway` with this lens has to
 * stand for every corner of the board to be in the picture (see `tallShot`). Leaves the camera's
 * axes in `tForward` and `tUp`, and in `tShift` how far it is moved sideways.
 *
 * From any bearing but square to a side, the board's near corners do not stand alike: the one
 * nearer the camera reaches further out. Looking at the middle of the board would leave room to
 * spare on one side and none on the other, and the board would sit off the middle of the picture.
 * So the camera is moved sideways, without turning, until the two sides are alike, which also lets
 * it come in closer. Room is kept for its sway (see TALL): moved sideways with what it looks at
 * held still, the camera carries a point across by the sway times the share by which the point's
 * depth differs from that of what it looks at.
 */
function tallDistance(t: Tall, aspect: number, tanAcross: number): number {
  const tanUp = tanAcross / aspect;
  const tip = Math.atan(-t.low * tanUp);
  const cosTip = Math.cos(tip);
  const sinTip = Math.sin(tip);
  tRight.crossVectors(UP, tAway).normalize();
  tUp.crossVectors(tAway, tRight);
  tForward.copy(tAway).multiplyScalar(-cosTip).addScaledVector(tUp, sinTip);
  tUp.multiplyScalar(cosTip).addScaledVector(tAway, sinTip);

  const head = TALL_HEAD * tanUp;
  const foot = lerp(TALL_FOOT.tall, TALL_FOOT.square, MathUtils.smoothstep(aspect, TALL_FOOT.from, TALL_FOOT.until)) * tanUp;
  // Below the middle the tip helps rather than hinders; only when it does not is there a least distance at all.
  const below = foot * cosTip - sinTip;
  const across = t.margin * tanAcross;
  for (let i = 0; i < BOARD_CORNERS.length; i++) {
    tCorner.copy(BOARD_CORNERS[i]!).sub(TALL_AIM);
    fitX[i] = tCorner.dot(tRight);
    fitY[i] = tCorner.dot(tUp);
    fitZ[i] = tCorner.dot(tForward);
  }
  // The least distance for every point, up and down the picture (which the sideways move does not change) and across it.
  const needs = (shift: number, distance: number): number => {
    tNeeds.length = 0;
    for (let i = 0; i < BOARD_CORNERS.length; i++) {
      const y = fitY[i]!;
      const z = fitZ[i]!;
      tNeeds.push((y - head * z) / (sinTip + head * cosTip));
      if (below > 1e-6) tNeeds.push(-(y + foot * z) / below);
      const depth = Math.max(1e-6, z + distance * cosTip);
      const swayed = t.sway * Math.abs(1 - depth / distance);
      tNeeds.push(((Math.abs(fitX[i]! - shift) + swayed) / across - z) / cosTip);
    }
    return softMost();
  };
  // How far each side of the picture is used, at this distance and this sideways move; the move that makes them alike is found by halving.
  const balance = (distance: number): number => {
    let lo = -4;
    let hi = 4;
    for (let k = 0; k < 30; k++) {
      const shift = (lo + hi) / 2;
      let right = -Infinity;
      let left = -Infinity;
      for (let i = 0; i < BOARD_CORNERS.length; i++) {
        const depth = Math.max(1e-6, fitZ[i]! + distance * cosTip);
        right = Math.max(right, (fitX[i]! - shift) / depth);
        left = Math.max(left, (shift - fitX[i]!) / depth);
      }
      if (right > left) lo = shift;
      else hi = shift;
    }
    return (lo + hi) / 2;
  };
  // The distance and the move each depend on the other; a few rounds settle both.
  let shift = 0;
  let distance = needs(shift, 20);
  for (let round = 0; round < 4; round++) {
    shift = balance(distance);
    distance = needs(shift, distance);
  }
  tShift = shift;
  return distance;
}

/** The furthest a camera may stand from the middle of the board along `tAway` and still be inside the room. */
function tallReach(): number {
  let reach = (TALL_ROOF - TALL_AIM.y) / Math.max(1e-6, tAway.y);
  if (Math.abs(tAway.x) > 1e-6) reach = Math.min(reach, ROOM_REACH / Math.abs(tAway.x));
  if (Math.abs(tAway.z) > 1e-6) reach = Math.min(reach, ROOM_REACH / Math.abs(tAway.z));
  return reach;
}

/**
 * Frame the board for a screen of shape `aspect` held upright (see TALL), looking from this
 * bearing and height. The camera is tipped up from the middle of the board by just enough to put
 * that middle at `low`, then stands back exactly as far as the widest corner needs, and no further.
 *
 * Every corner gives the least distance at which it is inside the picture, in closed form: across
 * the picture, nothing but the depth changes as the camera backs away along its line to the
 * middle of the board, and up the picture the height changes at a fixed rate too. The camera
 * stands at (softly) the greatest of these. If that would put it through the roof or a wall, it
 * stops there and the lens is widened, by just enough, instead.
 */
function tallShot(t: Tall, aspect: number, out: Shot): number {
  tAway.set(Math.sin(t.azimuth) * Math.cos(t.elevation), Math.sin(t.elevation), Math.cos(t.azimuth) * Math.cos(t.elevation));
  const reach = tallReach();
  let tanAcross = Math.tan(MathUtils.degToRad(t.lens) / 2);
  let distance = tallDistance(t, aspect, tanAcross);
  if (distance > reach) {
    // The distance falls as the lens widens; halve the difference until it is where the room allows.
    let narrow = tanAcross;
    let wide = Math.tan(MathUtils.degToRad(80) / 2);
    for (let i = 0; i < 24; i++) {
      const mid = (narrow + wide) / 2;
      if (tallDistance(t, aspect, mid) > reach) narrow = mid;
      else wide = mid;
    }
    tanAcross = wide;
    distance = tallDistance(t, aspect, tanAcross);
  }

  out.position.copy(TALL_AIM).addScaledVector(tAway, distance).addScaledVector(tRight, tShift);
  // What it looks at is as far along its line as the board is, so that a blend with a wide screen's shot turns evenly.
  out.target.copy(out.position).addScaledVector(tForward, distance);
  out.up.copy(UP);
  out.fov = MathUtils.radToDeg(Math.atan(tanAcross / aspect)) * 2;
  return distance;
}

/** How far a screen of this shape is framed as a tall one: 1 at TALL_FROM and narrower, 0 at TALL_UNTIL and wider. */
export function tallness(aspect: number): number {
  return 1 - MathUtils.smootherstep(aspect, TALL_FROM, TALL_UNTIL);
}

/** How far into the frame a cut is: 0 is the view underneath, 1 is the cut's own shot. */
function cutWeight(c: Cut): number {
  if (c.released) return c.released.weight * (1 - Easing.inOutCubic(clamp01((c.age - c.released.age) / c.rampOut)));
  if (c.age < c.rampIn) return Easing.inOutCubic(c.age / c.rampIn);
  if (c.age < c.rampIn + c.hold) return 1;
  return 1 - Easing.inOutCubic(clamp01((c.age - c.rampIn - c.hold) / c.rampOut));
}

function cutOver(c: Cut): boolean {
  return c.released ? c.age >= c.released.age + c.rampOut : c.age >= c.rampIn + c.hold + c.rampOut;
}

export class CameraRig {
  mode: CameraMode = 'side';
  /** Which player's side of the board the seated views use. */
  seat: Side = 'w';
  /** Pointer position in normalised device coordinates, for a little parallax in the seated views. */
  readonly pointer = new Vector2();
  /**
   * How fast the free view turns round the board by itself, in radians a second. Nothing while
   * a game is being played; the opening screen sets it, so that the room is seen moving.
   */
  drift = 0;

  private orbit = { azimuth: 0.62, elevation: 0.62, radius: 16.5, vAzimuth: 0, vElevation: 0, held: false, lastDrag: -1 };
  /** The pointer, eased, so the parallax never snaps (for example when the pointer leaves the canvas). */
  private easedPointer = new Vector2();
  private time = 0;
  private aspect = 16 / 9;
  /**
   * The share of the picture's height the board is framed in, less than 1 while a card docked at
   * the foot of a narrow screen takes the rest. `update` is given the shape of that part (aspect);
   * this is what turns its lens into one for the whole picture.
   */
  share = 1;
  private transition: ({ from: Pose; age: number; duration: number } & Winding) | null = null;
  private cutState: Cut | null = null;

  private shot = newShot();
  private cutShot = newShot();
  /** The view as a tall screen frames it, before it is blended with the wide one. */
  private upright = newShot();
  private tall: Tall = { azimuth: 0, elevation: 0, lens: 40, low: 0, margin: 1, sway: 0 };
  private base = newPose();
  private blended = newPose();
  private cutPose = newPose();
  private directed = newPose();
  /** The pose before any cut is blended in. */
  private undirected = newPose();
  private applied = newPose();
  /** The thud's spring: where it is, as a share of the height of the picture, and how fast it is going. */
  private dip = 0;
  private dipSpeed = 0;

  constructor(private camera: PerspectiveCamera) {
    this.compose(this.applied);
    this.copyPose(this.applied, this.undirected);
    this.apply();
  }

  /** Switch view with an eased swing. Does nothing if the view is already active. */
  setMode(mode: CameraMode, duration = 1.15): void {
    if (mode === this.mode) return;
    if (mode === 'orbit') this.adoptCurrentAsOrbit();
    this.mode = mode;
    this.beginTransition(duration);
  }

  /** Move the seated views to the other player's side. */
  setSeat(seat: Side, duration = 1.5): void {
    if (seat === this.seat) return;
    this.seat = seat;
    if (this.mode !== 'orbit') this.beginTransition(duration);
  }

  /** Jump straight to the current view with no transition. */
  snap(): void {
    this.transition = null;
    this.cutState = null;
    this.easedPointer.copy(this.pointer);
    this.dip = 0;
    this.dipSpeed = 0;
  }

  /**
   * A weight has been set down: the picture dips and springs back. A pawn is a strength of about a
   * half and a king three times that; blows that come together add up, to a limit.
   */
  thud(strength: number): void {
    if (!(strength > 0)) return;
    const most = THUD_LIMIT / THUD_REACH;
    this.dipSpeed = Math.max(-most, this.dipSpeed - (strength * THUD_DIP) / THUD_REACH);
  }

  get transitioning(): boolean {
    return this.transition !== null;
  }

  // -- orbit controls ---------------------------------------------------------

  /** Tell the rig whether the pointer is holding the view, so inertia only runs after release. */
  orbitHold(held: boolean): void {
    this.orbit.held = held;
    // No coasting from a stale sample: if the pointer had stopped before it let go, the view stays put.
    if (held || this.time - this.orbit.lastDrag > 0.1) this.orbit.vAzimuth = this.orbit.vElevation = 0;
  }

  /** Turn the view by a pointer movement. `seconds` is the time since the previous movement. */
  orbitDrag(dxPixels: number, dyPixels: number, seconds: number): void {
    const o = this.orbit;
    const dAzimuth = -dxPixels * 0.0052;
    const dElevation = dyPixels * 0.0042;
    o.azimuth += dAzimuth;
    o.elevation = MathUtils.clamp(o.elevation + dElevation, 0.12, 1.3);
    // Remember the speed (radians per second, capped) so the view can coast after release.
    const dt = Math.max(seconds, 1 / 240);
    o.vAzimuth = MathUtils.clamp(dAzimuth / dt, -2.6, 2.6);
    o.vElevation = MathUtils.clamp(dElevation / dt, -1.6, 1.6);
    o.lastDrag = this.time;
  }

  /** Place the free view: how far round the board, how high (both in radians) and how far out. Anything left out stays as it is. */
  setOrbit(at: { azimuth?: number; elevation?: number; radius?: number }): void {
    const o = this.orbit;
    if (at.azimuth !== undefined) o.azimuth = at.azimuth;
    if (at.elevation !== undefined) o.elevation = MathUtils.clamp(at.elevation, 0.12, 1.3);
    if (at.radius !== undefined) o.radius = MathUtils.clamp(at.radius, 8.5, 20);
    o.vAzimuth = o.vElevation = 0;
  }

  orbitZoom(deltaY: number): void {
    this.orbit.radius = MathUtils.clamp(this.orbit.radius * Math.exp(deltaY * 0.0011), 8.5, 20);
  }

  // -- director ---------------------------------------------------------------

  /** Push in on a square for a moment, then ease back to the active view. */
  cut(kind: CutKind, square: Square): void {
    const focus = squareCenter(square);
    focus.y = 0.55;
    const fromAbove = this.mode === 'top';
    const startAzimuth = Math.atan2(this.applied.position.x - focus.x, this.applied.position.z - focus.z);
    const up = fromAbove ? new Vector3(0, 0, this.seat === 'w' ? -1 : 1) : UP.clone();
    // Measured from the view underneath, so that cuts in quick succession do not tighten the lens each time.
    const baseFov = this.cutState ? this.undirected.fov : this.applied.fov;
    const height = this.topHeight();

    const timing = {
      capture: { rampIn: 0.38, hold: 0.8, rampOut: 0.75 },
      check: { rampIn: 0.45, hold: 1.05, rampOut: 0.85 },
      mate: { rampIn: 0.9, hold: 4.6, rampOut: 1.6 },
    }[kind];
    const total = timing.rampIn + timing.hold;

    if (this.cutState) {
      // A cut is still on screen. Carry on from where the camera is, not from the view underneath:
      // the new cut ramps in over a blend that starts at the current frame.
      const remaining = this.transition ? this.transition.duration - this.transition.age : 0;
      this.transition = {
        from: this.copyPose(this.applied, newPose()),
        age: 0,
        duration: Math.max(timing.rampIn, remaining),
        turn: null,
      };
    }

    this.cutState = {
      ...timing,
      age: 0,
      turn: null,
      released: null,
      shot: (age, out) => {
        const drift = Easing.inOutSine(clamp01(age / total));
        if (fromAbove) {
          // The tactical view stays overhead and simply leans in toward the square.
          const pull = kind === 'mate' ? 0.62 : 0.4;
          out.target.set(focus.x * pull, 0, focus.z * pull);
          out.position.set(out.target.x, height * (kind === 'mate' ? 0.58 - 0.06 * drift : 0.74), out.target.z);
          out.up.copy(up);
          out.fov = baseFov;
          return;
        }
        const radius = kind === 'capture' ? 6.6 - 0.5 * drift : kind === 'check' ? 7.6 - 0.7 * drift : 7.4 - 1.9 * drift;
        const elevation = kind === 'mate' ? 0.3 + 0.12 * drift : kind === 'check' ? 0.34 : 0.42;
        const sweep = kind === 'capture' ? 0.24 + 0.1 * drift : kind === 'check' ? -0.32 - 0.1 * drift : 0.4 + 1.25 * drift;
        const azimuth = startAzimuth + sweep;
        out.target.copy(focus);
        out.position
          .set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation))
          .multiplyScalar(radius)
          .add(focus);
        out.up.copy(UP);
        out.fov = Math.max(26, baseFov - 5);
      },
    };
  }

  /** Let go of a cut early, for example because the player has started their next move. */
  releaseCut(): void {
    const c = this.cutState;
    // Ease out from wherever the cut has got to. The shot itself keeps drifting with age, so nothing jumps.
    if (c && !c.released && c.age < c.rampIn + c.hold) c.released = { age: c.age, weight: cutWeight(c) };
  }

  get cutting(): boolean {
    return this.cutState !== null;
  }

  // -- per frame ----------------------------------------------------------------

  update(dt: number, aspect: number): void {
    this.time += dt;
    this.aspect = aspect;

    if (this.mode === 'orbit') {
      const o = this.orbit;
      if (!o.held) o.azimuth += this.drift * dt;
      if (!o.held && (Math.abs(o.vAzimuth) > 1e-4 || Math.abs(o.vElevation) > 1e-4)) {
        o.azimuth += o.vAzimuth * dt;
        o.elevation = MathUtils.clamp(o.elevation + o.vElevation * dt, 0.12, 1.3);
        const damping = Math.exp(-dt * 4.5);
        o.vAzimuth *= damping;
        o.vElevation *= damping;
      }
    }

    this.easedPointer.lerp(this.pointer, 1 - Math.exp(-dt * 10));
    this.compose(this.base);
    let pose = this.base;

    if (this.transition) {
      const t = this.transition;
      t.age += dt;
      const k = Easing.inOutCubic(clamp01(t.age / t.duration));
      pose = blendPose(t.from, this.base, k, this.blended, t);
      if (t.age >= t.duration) this.transition = null;
    }

    this.copyPose(pose, this.undirected);

    if (this.cutState) {
      const c = this.cutState;
      c.age += dt;
      if (cutOver(c)) {
        this.cutState = null;
      } else {
        c.shot(c.age, this.cutShot);
        poseFromShot(this.cutShot, this.cutPose);
        pose = blendPose(pose, this.cutPose, cutWeight(c), this.directed, c);
      }
    }

    this.copyPose(pose, this.applied);
    this.swing(dt);
    this.apply();
  }

  // -- internals ------------------------------------------------------------------

  private copyPose(from: Pose, to: Pose): Pose {
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.fov = from.fov;
    return to;
  }

  private beginTransition(duration: number): void {
    // While a cut is on screen, swing the view underneath it; the cut is blended over the result as before.
    const from = this.cutState ? this.undirected : this.applied;
    this.transition = { from: this.copyPose(from, newPose()), age: 0, duration, turn: null };
  }

  /** Carry the thud's spring on by a step. The step is worked out exactly, so a long frame cannot throw it. */
  private swing(dt: number): void {
    if (this.dip === 0 && this.dipSpeed === 0) return;
    const fall = THUD_DAMPING * THUD_RATE;
    const x = this.dip;
    const b = (this.dipSpeed + fall * x) / THUD_RING;
    const decay = Math.exp(-fall * dt);
    const c = Math.cos(THUD_RING * dt);
    const s = Math.sin(THUD_RING * dt);
    this.dip = MathUtils.clamp(decay * (x * c + b * s), -THUD_LIMIT, THUD_LIMIT);
    this.dipSpeed = decay * ((b * THUD_RING - fall * x) * c - (fall * b + x * THUD_RING) * s);
    if (Math.abs(this.dip) < 2e-6 && Math.abs(this.dipSpeed) < 1e-4) {
      this.dip = 0;
      this.dipSpeed = 0;
    }
  }

  private apply(): void {
    this.camera.position.copy(this.applied.position);
    this.camera.quaternion.copy(this.applied.quaternion);
    if (this.dip !== 0) {
      // Up and down the picture, never towards the board or away from it, and by the same share of the picture from any seat.
      const tall = 2 * this.applied.position.distanceTo(PIVOT) * Math.tan(MathUtils.degToRad(this.applied.fov) / 2);
      this.camera.position.addScaledVector(va.set(0, 1, 0).applyQuaternion(this.applied.quaternion), this.dip * tall);
    }
    // The shot was composed for the part of the picture's height it is framed in; the lens covers all of it.
    const fov = this.share < 1 ? MathUtils.radToDeg(Math.atan(Math.tan(MathUtils.degToRad(this.applied.fov) / 2) / this.share)) * 2 : this.applied.fov;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** The overhead camera hangs just under the ceiling beams. */
  private topHeight(): number {
    return TOP_HEIGHT;
  }

  /** Field of view at which the overhead view frames the whole slab for the current aspect ratio. */
  private topFov(): number {
    const half = Math.max(5.35 / TOP_HEIGHT, 5.0 / (TOP_HEIGHT * this.aspect));
    return MathUtils.radToDeg(Math.atan(half)) * 2;
  }

  /** The lens a shot composed at `fov` is given on the current screen, before any wall gets in the way. */
  private narrowFov(fov: number): number {
    return Math.min(72, fov * Math.min(1.5, Math.sqrt(NOMINAL_ASPECT / this.aspect)));
  }

  /** How many times further back a shot composed at `fov` has to stand on the current screen. 1 on a wide one. */
  private narrowStepBack(fov: number): number {
    if (this.aspect >= NOMINAL_ASPECT) return 1;
    const wanted = Math.tan(MathUtils.degToRad(fov) / 2) * NOMINAL_ASPECT;
    return Math.max(1, wanted / (Math.tan(MathUtils.degToRad(this.narrowFov(fov)) / 2) * this.aspect));
  }

  /** The free view's height on a tall screen, for its height on a wide one; and back. */
  private static tallElevation(elevation: number): number {
    return TALL_ORBIT_LOWEST + ((elevation - ORBIT_LOWEST) / (ORBIT_HIGHEST - ORBIT_LOWEST)) * (ORBIT_HIGHEST - TALL_ORBIT_LOWEST);
  }

  private static wideElevation(tall: number): number {
    return ORBIT_LOWEST + ((tall - TALL_ORBIT_LOWEST) / (ORBIT_HIGHEST - TALL_ORBIT_LOWEST)) * (ORBIT_HIGHEST - ORBIT_LOWEST);
  }

  /** The active view framed for a tall screen of the current shape (see TALL). Returns how far back from the board it stands. */
  private composeTall(mode: CameraMode, out: Shot, flip: number): number {
    const look = TALL[mode === 'top' ? 'side' : mode];
    const t = this.tall;
    t.lens = look.lens;
    t.low = look.low;
    t.margin = look.margin;
    t.sway = look.sway;
    if (mode === 'orbit') {
      t.azimuth = this.orbit.azimuth;
      t.elevation = CameraRig.tallElevation(this.orbit.elevation);
    } else {
      t.azimuth = (look.azimuth ?? 0) + (flip < 0 ? Math.PI : 0);
      t.elevation = look.elevation;
    }
    const fit = tallShot(t, Math.min(this.aspect, TALL_UNTIL), out);
    if (mode !== 'orbit') return fit;
    // The free view's own distance is how much nearer or further than the fit it stands.
    // Zoomed out it goes no further than the room allows (tallShot has left the bearing in `tAway`).
    const scale = Math.min(this.orbit.radius / ORBIT_HOME_RADIUS, tallReach() / fit);
    out.position.sub(TALL_AIM).multiplyScalar(scale).add(TALL_AIM);
    return fit * scale;
  }

  /** When entering free orbit, start from wherever the camera already is. */
  private adoptCurrentAsOrbit(): void {
    const v = va.copy(this.applied.position).sub(ORBIT_TARGET);
    const r = v.length();
    // On a narrow screen the camera is already standing further back, and the orbit view will step
    // back by the same rule. Adopt the distance from before that step so it is not taken twice.
    const wide = {
      radius: MathUtils.clamp(r / this.narrowStepBack(ORBIT_FOV), 12, 20),
      elevation: MathUtils.clamp(Math.asin(MathUtils.clamp(v.y / r, -1, 1)), 0.3, 1.05),
    };
    if (Math.hypot(v.x, v.z) > 0.03 * r) this.orbit.azimuth = Math.atan2(v.x, v.z);
    else this.orbit.azimuth = this.seat === 'w' ? 0.55 : Math.PI + 0.55;
    // On a tall screen every view already spans the width with the board, so the free view takes
    // the height it is seen from (read back through its own mapping) and the distance that fits.
    const tall = tallness(this.aspect);
    const w = vb.copy(this.applied.position).sub(TALL_AIM);
    const steep = MathUtils.clamp(CameraRig.wideElevation(Math.asin(MathUtils.clamp(w.y / w.length(), -1, 1))), ORBIT_LOWEST, ORBIT_HIGHEST);
    this.orbit.radius = lerp(wide.radius, ORBIT_HOME_RADIUS, tall);
    this.orbit.elevation = lerp(wide.elevation, steep, tall);
    this.orbit.vAzimuth = this.orbit.vElevation = 0;
  }

  /** The active view's shot for this instant, as a pose. */
  private compose(out: Pose): Pose {
    const s = this.shot;
    const t = this.time;
    const flip = this.seat === 'w' ? 1 : -1;
    const pointer = this.easedPointer;
    s.up.copy(UP);

    switch (this.mode) {
      case 'top': {
        s.position.set(0, this.topHeight(), 0);
        s.target.set(0, 0, 0);
        s.up.set(0, 0, -flip);
        s.fov = this.topFov();
        break;
      }
      case 'side': {
        s.target.set(0, 0.1, 0);
        s.position.set(13.7 * flip, 5.7, 0);
        s.fov = 30;
        break;
      }
      case 'shoulder': {
        s.target.set(-0.4 * flip, 0.2, -0.7 * flip);
        s.position.set(2.5 * flip, 5.0, 10.2 * flip);
        s.position.x += pointer.x * 0.35 * flip;
        s.position.y += pointer.y * 0.12;
        s.fov = 40;
        break;
      }
      case 'eyes': {
        s.target.set(pointer.x * 0.5 * flip, 0, (0.5 - pointer.y * 0.45) * flip);
        s.position.set(0, 8.9, 9.7 * flip);
        s.position.x += pointer.x * 0.5 * flip;
        s.position.y += pointer.y * 0.18;
        s.fov = 50;
        break;
      }
      case 'orbit': {
        const o = this.orbit;
        s.target.copy(ORBIT_TARGET);
        s.position
          .set(Math.sin(o.azimuth) * Math.cos(o.elevation), Math.sin(o.elevation), Math.cos(o.azimuth) * Math.cos(o.elevation))
          .multiplyScalar(o.radius)
          .add(s.target);
        s.fov = ORBIT_FOV;
        break;
      }
    }

    if (this.mode !== 'top' && this.aspect < NOMINAL_ASPECT) {
      // Narrow screens: keep the same width of board in frame. Widen the lens first, then step
      // back; if a wall is in the way, stop there and widen the lens the rest of the way.
      const offset = va.copy(s.position).sub(s.target);
      const distance = offset.length();
      const extent = Math.tan(MathUtils.degToRad(s.fov) / 2) * NOMINAL_ASPECT * distance;
      let fov = this.narrowFov(s.fov);
      let back = distance * this.narrowStepBack(s.fov);
      offset.divideScalar(distance);
      let limit = Infinity;
      if (Math.abs(offset.x) > 1e-6) limit = Math.min(limit, (ROOM_REACH - s.target.x * Math.sign(offset.x)) / Math.abs(offset.x));
      if (Math.abs(offset.z) > 1e-6) limit = Math.min(limit, (ROOM_REACH - s.target.z * Math.sign(offset.z)) / Math.abs(offset.z));
      if (back > limit) {
        back = Math.max(distance, limit);
        fov = Math.min(100, MathUtils.radToDeg(Math.atan(extent / (back * this.aspect))) * 2);
      }
      s.position.copy(s.target).addScaledVector(offset, back);
      s.fov = fov;
    }

    const tall = this.mode === 'top' ? 0 : tallness(this.aspect);
    if (tall > 0) {
      // A tall screen: the board across the whole width, from higher up (see TALL). The pointer still
      // moves the seated views, so that they stay alive; but sideways it turns the view about what it
      // looks at, and from the eyes by half as much, rather than carrying the board across, since the
      // board fills the width (and on a phone the pointer stays where the last finger left it).
      const u = this.upright;
      this.composeTall(this.mode, u, flip);
      if (this.mode === 'shoulder') {
        u.position.x += pointer.x * 0.35 * flip;
        u.position.y += pointer.y * 0.12;
      } else if (this.mode === 'eyes') {
        u.position.x += pointer.x * 0.25 * flip;
        u.position.y += pointer.y * 0.18;
        u.target.z -= pointer.y * 0.45 * flip;
      }
      if (tall >= 1) {
        s.position.copy(u.position);
        s.target.copy(u.target);
        s.fov = u.fov;
      } else {
        s.position.lerp(u.position, tall);
        s.target.lerp(u.target, tall);
        s.fov = lerp(s.fov, u.fov, tall);
      }
    }

    if (this.mode !== 'orbit' && this.mode !== 'top') {
      // A slow breath so a still camera never looks frozen.
      s.position.x += Math.sin(t * 0.31) * 0.05;
      s.position.y += Math.sin(t * 0.23 + 1.3) * 0.035;
    }
    return poseFromShot(s, out);
  }
}
