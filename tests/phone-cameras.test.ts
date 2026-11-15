/**
 * Every camera on a phone, held upright and on its side: the whole board, all 64 squares and the
 * stones standing round its edge, kept inside the part of the picture left clear for it, with a
 * little to spare; from both seats, with and without a card docked at the foot, and wherever the
 * pointer was last left (on a phone, where the last finger lifted). The shoulder view in particular
 * stands to one side of the board, and is not to leave the board leaning off the middle of the
 * picture with its near corner at the edge. On a wide screen it is as it always was.
 */
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CameraRig, type CameraMode } from '../src/camera/rig.ts';
import type { Kind } from '../src/core/game.ts';
import { dockedShares } from '../src/scene/framing.ts';
import { pieceGeometry } from '../src/scene/pieceShapes.ts';

/**
 * What is kept clear at the left and the right on a phone on its side, as shares of the width: the
 * interface's two columns (World.clearance and its SIDEWAYS widths); nothing on any other screen.
 */
function columns(w: number, h: number): [number, number] {
  if (h > 500 || w < 640 || w <= h) return [0, 0];
  const side = Math.min(300, Math.max(176, 0.5 * w - 200));
  return [(10 + side) / w, (10 + 2 * 44 + 6 + 3) / w];
}

/**
 * The points that must be in the picture: the corners of every square, and every corner of every
 * kind of stone standing on any square round the edge of the board, turned either way.
 */
const POINTS = (() => {
  const at: number[] = [];
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) at.push(x, 0, z);
  const kinds: Kind[] = ['p', 'n', 'b', 'r', 'q', 'k'];
  const shapes = kinds.map((kind) => {
    const position = pieceGeometry(kind).body.getAttribute('position');
    const seen = new Map<string, [number, number, number]>();
    for (let i = 0; i < position.count; i++) {
      const v: [number, number, number] = [position.getX(i), position.getY(i), position.getZ(i)];
      seen.set(v.map((n) => n.toFixed(3)).join(), v);
    }
    return [...seen.values()];
  });
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) {
      if (f > 0 && f < 7 && r > 0 && r < 7) continue;
      const cx = f - 3.5;
      const cz = 3.5 - r;
      for (const shape of shapes) for (const [x, y, z] of shape) at.push(cx + x, y, cz + z, cx - x, y, cz - z);
    }
  }
  return new Float32Array(at);
})();

const projection = new Matrix4();
/** The extent of every point in the picture, in pixels from its left and top. */
function extent(camera: PerspectiveCamera, w: number, h: number): { left: number; right: number; top: number; bottom: number } {
  projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = projection.elements;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < POINTS.length; i += 3) {
    const x = POINTS[i]!;
    const y = POINTS[i + 1]!;
    const z = POINTS[i + 2]!;
    const d = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
    const px = (((e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) / d + 1) / 2) * w;
    const py = ((1 - (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) / d) / 2) * h;
    left = Math.min(left, px);
    right = Math.max(right, px);
    top = Math.min(top, py);
    bottom = Math.max(bottom, py);
  }
  return { left, right, top, bottom };
}

interface Screen {
  w: number;
  h: number;
  /** The interface above the board and the card below it, in pixels, while a card is docked at the foot. */
  above: number;
  below: number;
}

/** The view on this screen, as the game sets it up (what World.applyInset and World.framingAspect do), with the pointer at `pointer` and the breath at its furthest. */
function view(mode: CameraMode, seat: 'w' | 'b', s: Screen, pointer: [number, number], azimuth?: number): PerspectiveCamera {
  const [foot, head] = dockedShares(s.h, s.below, s.above, 500);
  const share = 1 - foot - head;
  const [left, right] = columns(s.w, s.h);
  const camera = new PerspectiveCamera(40, s.w / s.h, 0.1, 220);
  const rig = new CameraRig(camera);
  rig.mode = mode;
  rig.seat = seat;
  rig.share = share;
  if (azimuth !== undefined) rig.setOrbit({ azimuth });
  rig.drift = 0;
  rig.pointer.set(...pointer);
  rig.snap();
  // A quarter of the slow breath's sway, its furthest to one side.
  rig.update(Math.PI / (2 * 0.31), ((s.w / s.h) * (1 - left - right)) / share);
  if (left || right || foot || head) camera.setViewOffset(s.w, s.h, ((right - left) / 2) * s.w, ((foot - head) / 2) * s.h, s.w, s.h);
  camera.updateMatrixWorld(true);
  return camera;
}

/** The part of the picture the board is to keep to: between the interface's columns, and between the interface above and the card below while one is docked. */
function clear(s: Screen): { left: number; right: number; top: number; bottom: number } {
  const [left, right] = columns(s.w, s.h);
  const [foot] = dockedShares(s.h, s.below, s.above, 500);
  return { left: left * s.w, right: s.w - right * s.w, top: foot > 0 ? s.above : 0, bottom: foot > 0 ? s.h - s.below : s.h };
}

const PHONES: [number, number][] = [
  [360, 640],
  [390, 844],
  [430, 932],
  [844, 390],
];
/** The screens, each bare and (held upright) with each kind of card docked: a lesson's, and an explanation's, as measured in the page. */
const SCREENS: Screen[] = PHONES.flatMap(([w, h]) => [
  { w, h, above: 0, below: 0 },
  ...(h > w ? [{ w, h, above: 146, below: h < 700 ? 245 : 292 }, { w, h, above: h < 700 ? 0 : 144, below: 348 }] : []),
]);
const POINTERS: [number, number][] = [
  [0, 0],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
/** The least room left between the board and the edge of its part of the picture, as a share of that part's width (across) and height (up and down). */
const SPARE = 0.012;
const label = (s: Screen) => `${s.w}x${s.h}${s.below ? ` above a card of ${s.below}` : ''}`;

describe('the board on a phone, from every camera', () => {
  for (const mode of ['top', 'side', 'shoulder', 'eyes'] as CameraMode[]) {
    for (const seat of ['w', 'b'] as const) {
      it(`${mode}, from ${seat === 'w' ? "Ivory's" : "Void's"} seat: every square and every stone on the edge squares inside the picture, with room to spare`, () => {
        for (const s of SCREENS) {
          const room = clear(s);
          for (const pointer of POINTERS) {
            const e = extent(view(mode, seat, s, pointer), s.w, s.h);
            const across = SPARE * (room.right - room.left);
            const down = SPARE * (room.bottom - room.top);
            const where = `${label(s)}, pointer at ${pointer}`;
            expect(e.left - room.left, `left, ${where}`).toBeGreaterThanOrEqual(across);
            expect(room.right - e.right, `right, ${where}`).toBeGreaterThanOrEqual(across);
            expect(e.top - room.top, `top, ${where}`).toBeGreaterThanOrEqual(down);
            expect(room.bottom - e.bottom, `bottom, ${where}`).toBeGreaterThanOrEqual(down);
          }
        }
      });
    }
  }

  it('the free view, turned to any bearing at its usual distance', () => {
    for (const s of SCREENS) {
      const room = clear(s);
      for (let azimuth = 0; azimuth < Math.PI * 2; azimuth += Math.PI / 8) {
        const e = extent(view('orbit', 'w', s, [0, 0], azimuth), s.w, s.h);
        const across = SPARE * (room.right - room.left);
        const down = SPARE * (room.bottom - room.top);
        const where = `${label(s)}, bearing ${azimuth.toFixed(2)}`;
        expect(e.left - room.left, `left, ${where}`).toBeGreaterThanOrEqual(across);
        expect(room.right - e.right, `right, ${where}`).toBeGreaterThanOrEqual(across);
        expect(e.top - room.top, `top, ${where}`).toBeGreaterThanOrEqual(down);
        expect(room.bottom - e.bottom, `bottom, ${where}`).toBeGreaterThanOrEqual(down);
      }
    }
  });
});

describe('the shoulder view on a phone held upright', () => {
  for (const [w, h] of PHONES.filter(([w, h]) => h > w)) {
    it(`at ${w}x${h} puts the board in the middle of the picture, and still looks over the player's right shoulder`, () => {
      for (const seat of ['w', 'b'] as const) {
        const flip = seat === 'w' ? 1 : -1;
        const camera = view('shoulder', seat, { w, h, above: 0, below: 0 }, [0, 0]);
        const e = extent(camera, w, h);
        // As much room at the left as at the right, to a pixel or two.
        expect(Math.abs(e.left - (w - e.right)), seat).toBeLessThan(3);
        // Behind the player and to their right, looking across to the left, so that the near corner
        // on the right stands nearer the camera than the one on the left.
        expect(camera.position.z * flip, seat).toBeGreaterThan(8);
        expect(camera.position.x * flip, seat).toBeGreaterThan(1.5);
        const ahead = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        expect(ahead.x * flip, seat).toBeLessThan(-0.08);
        const nearRight = new Vector3(4 * flip, 0, 4 * flip).distanceTo(camera.position);
        const nearLeft = new Vector3(-4 * flip, 0, 4 * flip).distanceTo(camera.position);
        expect(nearRight, seat).toBeLessThan(nearLeft - 0.5);
      }
    });
  }
});

describe('the shoulder view on a wide screen', () => {
  it('is as it always was: from behind the player and to their right, looking a little to the left of the middle', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1280, 720],
      [1440, 900],
    ]) {
      for (const seat of ['w', 'b'] as const) {
        const flip = seat === 'w' ? 1 : -1;
        const camera = new PerspectiveCamera(40, w / h, 0.1, 220);
        const rig = new CameraRig(camera);
        rig.mode = 'shoulder';
        rig.seat = seat;
        rig.snap();
        rig.update(0, w / h);
        camera.updateMatrixWorld(true);
        // The breath at its start: nothing sideways, a little up.
        expect(camera.position.x).toBeCloseTo(2.5 * flip, 6);
        expect(camera.position.y).toBeCloseTo(5.0 + Math.sin(1.3) * 0.035, 6);
        expect(camera.position.z).toBeCloseTo(10.2 * flip, 6);
        expect(camera.fov).toBeCloseTo(40, 6);
        const ahead = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const toward = new Vector3(-0.4 * flip, 0.2, -0.7 * flip).sub(camera.position).normalize();
        expect(ahead.distanceTo(toward)).toBeLessThan(1e-6);
      }
    }
  });
});
