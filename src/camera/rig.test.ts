import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CAMERA_MODES, CameraRig, type CameraMode } from './rig';

const WIDE = 16 / 9;
const PHONE = 375 / 812;

function setup(mode: CameraMode, aspect = WIDE) {
  const camera = new PerspectiveCamera(40, aspect, 0.1, 220);
  const rig = new CameraRig(camera);
  rig.mode = mode;
  rig.snap();
  rig.update(0, aspect);
  return { camera, rig };
}

/** Where a point on the board lands on screen, in normalised device coordinates. */
function project(camera: PerspectiveCamera, aspect: number, x: number, z: number): Vector3 {
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return new Vector3(x, 0, z).project(camera);
}

const CORNERS: [number, number][] = [
  [-4, -4],
  [4, -4],
  [-4, 4],
  [4, 4],
];

describe('camera views frame the board', () => {
  for (const aspect of [WIDE, 4 / 3, 1, PHONE]) {
    for (const mode of ['top', 'side', 'eyes', 'orbit'] as CameraMode[]) {
      it(`${mode} keeps all 64 squares on screen at aspect ${aspect.toFixed(2)}`, () => {
        const { camera } = setup(mode, aspect);
        for (const [x, z] of CORNERS) {
          const p = project(camera, aspect, x, z);
          expect(Math.abs(p.x), `corner ${x},${z} x`).toBeLessThanOrEqual(1);
          expect(Math.abs(p.y), `corner ${x},${z} y`).toBeLessThanOrEqual(1);
          expect(p.z).toBeLessThan(1);
        }
      });
    }

    it(`shoulder keeps the centre and the far side on screen at aspect ${aspect.toFixed(2)}`, () => {
      const { camera } = setup('shoulder', aspect);
      for (const [x, z] of [
        [0, 0],
        [-4, -4],
        [4, -4],
      ] as [number, number][]) {
        const p = project(camera, aspect, x, z);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
      }
    });
  }

  it('the overhead view looks straight down with the seated player at the bottom', () => {
    const { camera } = setup('top');
    const near = project(camera, WIDE, 0, 3.5);
    const far = project(camera, WIDE, 0, -3.5);
    expect(near.x).toBeCloseTo(0, 5);
    expect(near.y).toBeLessThan(far.y);
  });

  it('the side view puts Ivory on the left', () => {
    const { camera } = setup('side');
    expect(project(camera, WIDE, 0, 3.5).x).toBeLessThan(project(camera, WIDE, 0, -3.5).x);
  });
});

describe('seats', () => {
  it('mirrors the seated views for the other player', () => {
    for (const mode of ['shoulder', 'eyes'] as CameraMode[]) {
      const a = setup(mode);
      const b = setup(mode);
      b.rig.setSeat('b', 0.001);
      b.rig.update(1, WIDE);
      // Compare with the slow idle sway removed: positions mirror through the vertical axis.
      expect(b.camera.position.z).toBeLessThan(-5);
      expect(a.camera.position.z).toBeGreaterThan(5);
      expect(b.camera.position.y).toBeCloseTo(a.camera.position.y, 0);
    }
  });
});

describe('transitions', () => {
  const steps = (rig: CameraRig, seconds: number, each: (t: number) => void) => {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
      rig.update(dt, WIDE);
      each(t);
    }
  };

  for (const from of CAMERA_MODES) {
    for (const to of CAMERA_MODES) {
      if (from.id === to.id) continue;
      it(`${from.id} to ${to.id} swings clear of the board and lands exactly`, () => {
        const { camera, rig } = setup(from.id);
        rig.setMode(to.id, 1);
        expect(rig.transitioning).toBe(true);
        let lowest = Infinity;
        let nearest = Infinity;
        let largestStep = 0;
        const previous = camera.position.clone();
        steps(rig, 1.1, () => {
          lowest = Math.min(lowest, camera.position.y);
          nearest = Math.min(nearest, camera.position.length());
          largestStep = Math.max(largestStep, camera.position.distanceTo(previous));
          previous.copy(camera.position);
        });
        expect(rig.transitioning).toBe(false);
        expect(lowest).toBeGreaterThan(3);
        expect(nearest).toBeGreaterThan(9);
        // No jump cuts: the camera never moves more than a small fraction of the room in one frame.
        expect(largestStep).toBeLessThan(1.6);

        const target = setup(to.id);
        if (to.id !== 'orbit') {
          expect(camera.position.distanceTo(target.camera.position)).toBeLessThan(0.2);
          expect(camera.fov).toBeCloseTo(target.camera.fov, 3);
        }
      });
    }
  }

  it('eases in and out rather than moving at a constant rate', () => {
    const { camera, rig } = setup('side');
    rig.setMode('eyes', 1);
    const speeds: number[] = [];
    const previous = camera.position.clone();
    steps(rig, 1, () => {
      speeds.push(camera.position.distanceTo(previous));
      previous.copy(camera.position);
    });
    const peak = Math.max(...speeds);
    expect(speeds[1]!).toBeLessThan(peak * 0.2);
    expect(speeds[speeds.length - 2]!).toBeLessThan(peak * 0.2);
    expect(speeds.indexOf(peak)).toBeGreaterThan(20);
    expect(speeds.indexOf(peak)).toBeLessThan(40);
  });

  it('can be redirected mid-swing without a jump', () => {
    const { camera, rig } = setup('top');
    rig.setMode('side', 1);
    let previous = camera.position.clone();
    let largest = 0;
    const track = () => {
      largest = Math.max(largest, camera.position.distanceTo(previous));
      previous = camera.position.clone();
    };
    steps(rig, 0.5, track);
    rig.setMode('shoulder', 1);
    steps(rig, 1.1, track);
    expect(largest).toBeLessThan(1.6);
    expect(rig.transitioning).toBe(false);
  });
});

describe('director', () => {
  it('pushes in on a square and returns to the same view', () => {
    const { camera, rig } = setup('side');
    const home = camera.position.clone();
    rig.cut('capture', 'e4');
    expect(rig.cutting).toBe(true);
    let closest = Infinity;
    const focus = new Vector3(0.5, 0.55, -0.5);
    for (let t = 0; t < 3; t += 1 / 60) {
      rig.update(1 / 60, WIDE);
      closest = Math.min(closest, camera.position.distanceTo(focus));
    }
    expect(closest).toBeLessThan(7);
    expect(rig.cutting).toBe(false);
    expect(camera.position.distanceTo(home)).toBeLessThan(0.2);
  });

  it('lets go early when asked', () => {
    const { rig } = setup('eyes');
    rig.cut('mate', 'e8');
    for (let t = 0; t < 1; t += 1 / 60) rig.update(1 / 60, WIDE);
    rig.releaseCut();
    for (let t = 0; t < 1.7; t += 1 / 60) rig.update(1 / 60, WIDE);
    expect(rig.cutting).toBe(false);
  });

  it('stays overhead when the tactical view is active', () => {
    const { camera, rig } = setup('top');
    rig.cut('check', 'e8');
    for (let t = 0; t < 1; t += 1 / 60) rig.update(1 / 60, WIDE);
    const down = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(down.y).toBeLessThan(-0.999);
  });
});

describe('the camera never loses the board or jumps', () => {
  const DT = 1 / 60;
  const run = (rig: CameraRig, seconds: number, aspect = WIDE) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) rig.update(DT, aspect);
  };
  /** Cosine of the angle between where the camera looks and the middle of the board. */
  const facing = (camera: PerspectiveCamera) =>
    new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).dot(camera.position.clone().negate().normalize());

  /** The largest single-frame move and turn over a stretch of time, and the least the camera faced the board. */
  function trace(rig: CameraRig, camera: PerspectiveCamera, seconds: number, each?: (t: number) => void) {
    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    const worst = { step: 0, turn: 0, facing: 1 };
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      each?.(t);
      rig.update(DT, WIDE);
      worst.step = Math.max(worst.step, camera.position.distanceTo(position));
      worst.turn = Math.max(worst.turn, (quaternion.angleTo(camera.quaternion) * 180) / Math.PI);
      worst.facing = Math.min(worst.facing, facing(camera));
      position.copy(camera.position);
      quaternion.copy(camera.quaternion);
    }
    return worst;
  }

  for (const mode of ['top', 'side', 'shoulder', 'eyes'] as CameraMode[]) {
    it(`${mode}: changing seats circles the board facing it, whenever it starts`, () => {
      // The two seats are on opposite sides, so which way round is a coin toss unless it is remembered.
      for (let i = 0; i < 40; i++) {
        const { camera, rig } = setup(mode);
        run(rig, i * 0.37);
        rig.setSeat('b');
        const worst = trace(rig, camera, 1.6);
        expect(worst.facing, `start ${i}: facing`).toBeGreaterThan(0.5);
        expect(worst.turn, `start ${i}: turn`).toBeLessThan(20);
        expect(worst.step, `start ${i}: step`).toBeLessThan(1.6);
      }
    });
  }

  for (const mode of ['shoulder', 'eyes'] as CameraMode[]) {
    it(`${mode}: changing seats is steady while the pointer drifts`, () => {
      for (let i = 0; i < 12; i++) {
        for (const direction of [-1, 1]) {
          const { camera, rig } = setup(mode);
          run(rig, i * 0.83);
          rig.pointer.set(0.1, -0.2);
          run(rig, 0.5);
          rig.setSeat('b');
          const worst = trace(rig, camera, 1.6, (t) => rig.pointer.set(0.1 + direction * 0.6 * t, -0.2));
          expect(worst.facing).toBeGreaterThan(0.5);
          expect(worst.turn).toBeLessThan(20);
          expect(worst.step).toBeLessThan(1.6);
        }
      }
    });
  }

  it('a seat change after a capture on the edge file swings the right way', () => {
    for (const mode of ['shoulder', 'eyes'] as CameraMode[]) {
      for (const square of ['a5', 'h5', 'a2', 'h7'] as const) {
        const { camera, rig } = setup(mode);
        rig.cut('capture', square);
        run(rig, 0.9);
        rig.setSeat('b');
        const worst = trace(rig, camera, 2.6);
        expect(worst.facing, `${mode} ${square}`).toBeGreaterThan(0.3);
        expect(worst.turn, `${mode} ${square}`).toBeLessThan(20);
        expect(worst.step, `${mode} ${square}`).toBeLessThan(1.6);
      }
    }
  });

  it('letting go of a cut does not make the camera jump', () => {
    for (const at of [0.3, 0.8, 2.0, 3.2]) {
      const { camera, rig } = setup('side');
      rig.cut('mate', 'e8');
      run(rig, at);
      const position = camera.position.clone();
      const quaternion = camera.quaternion.clone();
      rig.releaseCut();
      rig.update(DT, WIDE);
      expect(camera.position.distanceTo(position), `released at ${at}s`).toBeLessThan(0.5);
      expect((quaternion.angleTo(camera.quaternion) * 180) / Math.PI, `released at ${at}s`).toBeLessThan(5);
      run(rig, 4);
      expect(rig.cutting).toBe(false);
    }
  });

  it('a second cut takes over from the first without snapping back', () => {
    for (const gap of [0.2, 0.4, 0.8]) {
      const { camera, rig } = setup('side');
      rig.cut('capture', 'd5');
      run(rig, 0.9);
      rig.releaseCut();
      run(rig, gap);
      rig.cut('capture', 'e4');
      const worst = trace(rig, camera, 2.5);
      // A fresh push-in peaks at about one unit a frame; snapping back to the base view first cost three to nine.
      expect(worst.step, `gap ${gap}s`).toBeLessThan(1.3);
      expect(rig.cutting).toBe(false);
    }
  });

  it('cuts in quick succession do not keep tightening the lens', () => {
    const { camera, rig } = setup('side');
    const home = camera.fov;
    let tightest = home;
    for (let i = 0; i < 5; i++) {
      rig.cut('capture', 'e4');
      for (let t = 0; t < 0.5; t += DT) {
        rig.update(DT, WIDE);
        tightest = Math.min(tightest, camera.fov);
      }
    }
    expect(tightest).toBeGreaterThanOrEqual(home - 5 - 1e-6);
    run(rig, 3);
    expect(camera.fov).toBeCloseTo(home, 4);
  });

  it('a view change during a cut does not jump', () => {
    const { camera, rig } = setup('side');
    rig.cut('check', 'e8');
    run(rig, 0.25);
    rig.setMode('shoulder');
    const worst = trace(rig, camera, 3);
    expect(worst.step).toBeLessThan(1.6);
    expect(worst.turn).toBeLessThan(20);
  });

  it('turning back toward overhead early in a swing does not pop', () => {
    const { camera, rig } = setup('top');
    rig.setMode('side');
    run(rig, 0.2);
    rig.setMode('top');
    const worst = trace(rig, camera, 1.4);
    expect(worst.step).toBeLessThan(0.5);
  });

  it('eases the pointer parallax instead of snapping to it', () => {
    for (const mode of ['shoulder', 'eyes'] as CameraMode[]) {
      const { camera, rig } = setup(mode);
      rig.pointer.set(0.9, 0.9);
      run(rig, 1.5);
      const position = camera.position.clone();
      const quaternion = camera.quaternion.clone();
      rig.pointer.set(0, 0);
      rig.update(DT, WIDE);
      expect(camera.position.distanceTo(position)).toBeLessThan(0.15);
      expect((quaternion.angleTo(camera.quaternion) * 180) / Math.PI).toBeLessThan(1);
      // It does arrive.
      run(rig, 1.5);
      const rest = setup(mode);
      run(rest.rig, 3 + DT);
      expect(camera.position.distanceTo(rest.camera.position)).toBeLessThan(0.02);
    }
  });

  it('entering orbit on a narrow screen starts from where the camera is', () => {
    for (const aspect of [1, PHONE]) {
      const { camera, rig } = setup('side', aspect);
      const before = camera.position.length();
      rig.setMode('orbit', 0.5);
      run(rig, 0.7, aspect);
      expect(Math.abs(camera.position.length() - before), `aspect ${aspect.toFixed(2)}`).toBeLessThan(0.6);
    }
  });

  it('coasts after a flick, but not after the pointer has stopped', () => {
    const flick = setup('orbit');
    flick.rig.orbitHold(true);
    for (let i = 0; i < 8; i++) {
      flick.rig.orbitDrag(14, 0, DT);
      flick.rig.update(DT, WIDE);
    }
    const released = flick.camera.position.clone();
    flick.rig.orbitHold(false);
    run(flick.rig, 1);
    expect(flick.camera.position.distanceTo(released)).toBeGreaterThan(0.5);

    const stopped = setup('orbit');
    stopped.rig.orbitHold(true);
    for (let i = 0; i < 8; i++) {
      stopped.rig.orbitDrag(14, 0, DT);
      stopped.rig.update(DT, WIDE);
    }
    run(stopped.rig, 0.4);
    const held = stopped.camera.position.clone();
    stopped.rig.orbitHold(false);
    run(stopped.rig, 1);
    expect(stopped.camera.position.distanceTo(held)).toBeLessThan(0.01);
  });
});

describe('the thud when a stone is set down', () => {
  const STEP = 1 / 120;
  /** Where the middle of the board stands in the picture: -1 at the foot and the left, 1 at the head and the right. */
  const middle = (camera: PerspectiveCamera) => project(camera, WIDE, 0, 0).clone();
  /** Two cameras in the same seat, kept in step; only one of them is ever struck. The seated views breathe, so one alone proves nothing. */
  function pair(mode: CameraMode) {
    const struck = setup(mode);
    const still = setup(mode);
    const step = (dt: number) => {
      struck.rig.update(dt, WIDE);
      still.rig.update(dt, WIDE);
    };
    /** How far the struck picture stands from the other, across and up. */
    const apart = () => middle(struck.camera).sub(middle(still.camera));
    return { struck, still, step, apart };
  }
  /** The furthest the picture is thrown, up or down, in the second after these blows. */
  function throwOf(blows: number[]): number {
    const { struck, step, apart } = pair('side');
    for (const b of blows) struck.rig.thud(b);
    let most = 0;
    for (let i = 0; i < 120; i++) {
      step(STEP);
      most = Math.max(most, Math.abs(apart().y));
    }
    return most;
  }

  for (const mode of ['top', 'side', 'shoulder', 'eyes', 'orbit'] as CameraMode[]) {
    it(`${mode}: the picture dips by about two parts in a thousand, then is exactly where it would have been`, () => {
      const { struck, still, step, apart } = pair(mode);
      struck.rig.thud(1);
      let most = 0;
      let first = 0;
      for (let i = 0; i < 120; i++) {
        step(STEP);
        const d = apart();
        // It goes neither left nor right, and neither nearer nor further.
        expect(Math.abs(d.x)).toBeLessThan(1e-9);
        if (i === 3) first = d.y;
        most = Math.max(most, Math.abs(d.y));
      }
      // The camera goes down first, so what it sees goes up.
      expect(first).toBeGreaterThan(0);
      // The picture is two units tall here, so three thousandths of its height is 0.006. The allowance is for the
      // middle of the board not being at the same distance as the point the views turn about.
      expect(most).toBeGreaterThan(0.0046);
      expect(most).toBeLessThan(0.0079);
      expect(struck.camera.position.equals(still.camera.position)).toBe(true);
    });
  }

  it('is over in a third of a second', () => {
    const { struck, step, apart } = pair('side');
    struck.rig.thud(1.5);
    for (let i = 0; i < 40; i++) step(STEP);
    expect(Math.abs(apart().y)).toBeLessThan(0.0002);
  });

  it('adds up when blows come together, but only so far', () => {
    const one = throwOf([1]);
    expect(throwOf([1, 1])).toBeCloseTo(one * 2, 4);
    // Twenty at once would be twenty times as far. It stops a little past four.
    const many = throwOf(new Array<number>(20).fill(1));
    expect(many).toBeGreaterThan(one * 3.9);
    expect(many).toBeLessThan(one * 4.8);
  });

  it('is the same whatever the length of the frames it is drawn in', () => {
    const at = (frame: number) => {
      const { struck, step, apart } = pair('side');
      struck.rig.thud(1);
      for (let t = 0; t < 0.1 - 1e-9; t += frame) step(frame);
      return apart().y;
    };
    expect(Math.abs(at(1 / 200))).toBeGreaterThan(1e-4);
    expect(at(1 / 20)).toBeCloseTo(at(1 / 200), 7);
  });

  it('does not move the view a change of seat starts from', () => {
    const { struck, still, step } = pair('side');
    struck.rig.thud(3);
    step(0.04);
    // At its lowest, more or less; a swing to another view begins from here.
    expect(struck.camera.position.equals(still.camera.position)).toBe(false);
    struck.rig.setMode('top', 1);
    still.rig.setMode('top', 1);
    for (let i = 0; i < 60; i++) step(STEP);
    // Half a second on the thud has died away, and the swing is where it would have been without it. Had it begun
    // from the shaken view the two would be some hundredths apart here.
    expect(struck.camera.position.distanceTo(still.camera.position)).toBeLessThan(1e-4);
    for (let i = 0; i < 60; i++) step(STEP);
    expect(struck.camera.position.equals(still.camera.position)).toBe(true);
  });

  it('does nothing for a blow of nothing, and is forgotten when the view is snapped', () => {
    const { struck, still, step } = pair('side');
    struck.rig.thud(0);
    struck.rig.thud(-1);
    struck.rig.thud(Number.NaN);
    step(STEP);
    expect(struck.camera.position.equals(still.camera.position)).toBe(true);
    struck.rig.thud(2);
    step(STEP);
    expect(struck.camera.position.equals(still.camera.position)).toBe(false);
    struck.rig.snap();
    still.rig.snap();
    step(STEP);
    expect(struck.camera.position.equals(still.camera.position)).toBe(true);
  });
});

describe('a tall screen', () => {
  const MODES: CameraMode[] = ['top', 'side', 'shoulder', 'eyes', 'orbit'];
  /** A view as it stands on a screen of this shape, from this seat (and, for the free view, this bearing). */
  function at(mode: CameraMode, aspect: number, seat: 'w' | 'b' = 'w', azimuth?: number) {
    const camera = new PerspectiveCamera(40, aspect, 0.1, 220);
    const rig = new CameraRig(camera);
    rig.mode = mode;
    rig.seat = seat;
    if (azimuth !== undefined) rig.setOrbit({ azimuth });
    rig.snap();
    rig.update(0, aspect);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return { camera, rig };
  }
  /** Each of the 64 squares as it is seen on a screen `width` by `height` CSS pixels: the square root of its area there. */
  function squares(camera: PerspectiveCamera, width: number, height: number): number[] {
    const p = (x: number, z: number) => {
      const v = new Vector3(x, 0, z).project(camera);
      return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height] as const;
    };
    const sizes: number[] = [];
    for (let f = 0; f < 8; f++) {
      for (let r = 0; r < 8; r++) {
        const c = [p(f - 4, r - 4), p(f - 3, r - 4), p(f - 3, r - 3), p(f - 4, r - 3)];
        let area = 0;
        for (let i = 0; i < 4; i++) area += c[i]![0] * c[(i + 1) % 4]![1] - c[(i + 1) % 4]![0] * c[i]![1];
        sizes.push(Math.sqrt(Math.abs(area) / 2));
      }
    }
    return sizes.sort((a, b) => a - b);
  }
  const median = (sizes: number[]) => (sizes[31]! + sizes[32]!) / 2;

  it('keeps the whole board on screen from every view and both seats, at every shape from 0.45 to 1', () => {
    for (let aspect = 0.45; aspect <= 1.0001; aspect += 0.05) {
      for (const seat of ['w', 'b'] as const) {
        for (const mode of MODES) {
          const azimuths = mode === 'orbit' ? [undefined, 0, Math.PI / 4, 2, Math.PI + 0.62] : [undefined];
          for (const azimuth of azimuths) {
            const { camera } = at(mode, aspect, seat, azimuth);
            for (const [x, z] of CORNERS) {
              const p = new Vector3(x, 0, z).project(camera);
              const where = `${mode} ${seat} ${azimuth ?? ''} at ${aspect.toFixed(2)}, corner ${x},${z}`;
              expect(Math.abs(p.x), where).toBeLessThanOrEqual(1);
              expect(Math.abs(p.y), where).toBeLessThanOrEqual(1);
              expect(p.z, where).toBeLessThan(1);
              // On a phone or a tablet held upright the foot of the picture is left to the buttons.
              if (mode !== 'top' && aspect <= 0.8) expect(p.y, where).toBeGreaterThanOrEqual(-0.67);
            }
            // And the camera stays inside the room: under the beams, inside the walls.
            expect(camera.position.y).toBeLessThanOrEqual(22);
            expect(Math.max(Math.abs(camera.position.x), Math.abs(camera.position.z))).toBeLessThanOrEqual(20.6);
          }
        }
      }
    }
  });

  it('on a phone 390 by 844 the squares are large enough to touch', () => {
    // Median at least 32 CSS pixels a side, the smallest at least 26; the free view as it is when come to from a seated view.
    for (const seat of ['w', 'b'] as const) {
      for (const [mode, azimuth] of [['side'], ['shoulder'], ['eyes'], ['orbit', seat === 'w' ? 0 : Math.PI]] as [CameraMode, number?][]) {
        const sizes = squares(at(mode, 390 / 844, seat, azimuth).camera, 390, 844);
        expect(median(sizes), `${mode} ${seat} median`).toBeGreaterThanOrEqual(32);
        expect(sizes[0], `${mode} ${seat} smallest`).toBeGreaterThanOrEqual(26);
      }
    }
    // Turned to a corner the board is wider than it is anywhere else, and smaller; still far larger than the 22 it was.
    expect(median(squares(at('orbit', 390 / 844).camera, 390, 844))).toBeGreaterThanOrEqual(28);
  });

  it('keeps each view its own character', () => {
    const aspect = 390 / 844;
    const side = at('side', aspect).camera;
    const shoulder = at('shoulder', aspect).camera;
    const eyes = at('eyes', aspect).camera;
    // Side: from Ivory's right, Ivory on the left.
    expect(side.position.x).toBeGreaterThan(8);
    expect(new Vector3(0, 0, 3.5).project(side).x).toBeLessThan(new Vector3(0, 0, -3.5).project(side).x);
    // Shoulder: behind the player, a little to their right; the far side at the head of the picture.
    expect(shoulder.position.z).toBeGreaterThan(8);
    expect(shoulder.position.x).toBeGreaterThan(0.5);
    expect(new Vector3(0, 0, -3.5).project(shoulder).y).toBeGreaterThan(new Vector3(0, 0, 3.5).project(shoulder).y);
    // Eyes: square on, and the lowest and nearest of the seated views.
    expect(Math.abs(eyes.position.x)).toBeLessThan(0.1);
    expect(eyes.position.y).toBeLessThan(shoulder.position.y);
    expect(eyes.position.y).toBeLessThan(side.position.y);
    expect(eyes.position.length()).toBeLessThan(shoulder.position.length());
    // In every one the board stands in the lower half and the room is above it.
    for (const camera of [side, shoulder, eyes]) expect(new Vector3(0, 0, 0).project(camera).y).toBeLessThan(0);
  });

  it('blends into the wide framing between 1 and 1.3 without a jump', () => {
    /** The most the camera moves, turns (degrees) and changes its lens between neighbouring shapes this far apart, from 0.9 to 1.4. */
    const steps = (mode: CameraMode, seat: 'w' | 'b', step: number) => {
      const most = { move: 0, turn: 0, lens: 0 };
      let previous: PerspectiveCamera | null = null;
      for (let i = 0; 0.9 + i * step <= 1.4 + 1e-9; i++) {
        const aspect = 0.9 + i * step;
        const { camera } = at(mode, aspect, seat);
        for (const [x, z] of mode === 'shoulder' ? ([[0, 0], [-4, -4], [4, -4]] as [number, number][]) : CORNERS) {
          const p = new Vector3(x, 0, z).project(camera);
          expect(Math.max(Math.abs(p.x), Math.abs(p.y)), `${mode} ${seat} at ${aspect.toFixed(4)}`).toBeLessThanOrEqual(1);
        }
        if (previous) {
          most.move = Math.max(most.move, camera.position.distanceTo(previous.position));
          most.turn = Math.max(most.turn, (camera.quaternion.angleTo(previous.quaternion) * 180) / Math.PI);
          most.lens = Math.max(most.lens, Math.abs(camera.fov - previous.fov));
        }
        previous = camera;
      }
      return most;
    };
    for (const seat of ['w', 'b'] as const) {
      for (const mode of MODES) {
        // Steps a quarter the size change things a quarter as much, give or take: nowhere is there a jump, which would not shrink.
        const coarse = steps(mode, seat, 0.002);
        const fine = steps(mode, seat, 0.0005);
        expect(fine.move, `${mode} ${seat} move`).toBeLessThan(coarse.move * 0.3 + 1e-6);
        expect(fine.turn, `${mode} ${seat} turn`).toBeLessThan(coarse.turn * 0.3 + 1e-6);
        expect(fine.lens, `${mode} ${seat} lens`).toBeLessThan(coarse.lens * 0.3 + 1e-6);
        // And even the coarse steps are small: a window dragged two thousandths wider moves the camera no more than a quarter of a unit.
        expect(coarse.move, `${mode} ${seat}`).toBeLessThan(0.25);
        expect(coarse.turn, `${mode} ${seat}`).toBeLessThan(0.6);
      }
    }
  });

  it('leaves the wide views exactly as they were, from 1.3 up', () => {
    // Taken before the tall framing was added: each view at rest from each seat, after 0.7 seconds of its breath.
    for (const [key, want] of Object.entries(WIDE_BEFORE)) {
      const [mode, seat, aspectText] = key.split(' ') as [CameraMode, 'w' | 'b', string];
      const aspect = Number(aspectText);
      const camera = new PerspectiveCamera(40, aspect, 0.1, 220);
      const rig = new CameraRig(camera);
      rig.mode = mode;
      rig.seat = seat;
      rig.snap();
      rig.update(0, aspect === 1.7778 ? 16 / 9 : aspect === 1.7786 ? 1366 / 768 : aspect);
      rig.update(0.7, aspect === 1.7778 ? 16 / 9 : aspect === 1.7786 ? 1366 / 768 : aspect);
      const got = [...camera.position.toArray(), ...camera.quaternion.toArray(), camera.fov];
      got.forEach((v, i) => expect(v, `${key} [${i}]`).toBeCloseTo(want[i]!, 5));
    }
  });
});

/** The views on wide screens before the tall framing: position, orientation and lens, keyed by view, seat and shape (16:9 is 1.7778, 1366 by 768 is 1.7786). */
const WIDE_BEFORE: Record<string, number[]> = {
  'top w 1.7778': [0, 22, 0, -0.707107, 0, 0, 0.707107, 27.335969],
  'side w 1.7778': [13.710765, 5.734789, 0, -0.13699, 0.69371, 0.13699, 0.69371, 30],
  'shoulder w 1.7778': [2.510765, 5.034789, 10.2, -0.199345, 0.12745, 0.026158, 0.971254, 40],
  'eyes w 1.7778': [0.010765, 8.934789, 9.7, -0.375918, 0.000542, 0.00022, 0.926653, 50],
  'orbit w 1.7778': [7.802718, 9.78708, 10.929569, -0.290518, 0.290518, 0.093061, 0.906939, 36],
  'top b 1.7778': [0, 22, 0, 0, 0.707107, 0.707107, 0, 27.335969],
  'side b 1.7778': [-13.689235, 5.734789, 0, -0.137182, -0.693672, -0.137182, 0.693672, 30],
  'shoulder b 1.7778': [-2.489235, 5.034789, -10.2, 0.025986, 0.971353, 0.199455, -0.126552, 40],
  'eyes b 1.7778': [0.010765, 8.934789, -9.7, -0.00022, 0.926653, 0.375918, 0.000542, 50],
  'orbit b 1.7778': [7.802718, 9.78708, 10.929569, -0.290518, 0.290518, 0.093061, 0.906939, 36],
  'top w 1.7786': [0, 22, 0, -0.707107, 0, 0, 0.707107, 27.335969],
  'side w 1.7786': [13.710765, 5.734789, 0, -0.13699, 0.69371, 0.13699, 0.69371, 30],
  'shoulder w 1.7786': [2.510765, 5.034789, 10.2, -0.199345, 0.12745, 0.026158, 0.971254, 40],
  'eyes w 1.7786': [0.010765, 8.934789, 9.7, -0.375918, 0.000542, 0.00022, 0.926653, 50],
  'orbit w 1.7786': [7.802718, 9.78708, 10.929569, -0.290518, 0.290518, 0.093061, 0.906939, 36],
  'top b 1.7786': [0, 22, 0, 0, 0.707107, 0.707107, 0, 27.335969],
  'side b 1.7786': [-13.689235, 5.734789, 0, -0.137182, -0.693672, -0.137182, 0.693672, 30],
  'shoulder b 1.7786': [-2.489235, 5.034789, -10.2, 0.025986, 0.971353, 0.199455, -0.126552, 40],
  'eyes b 1.7786': [0.010765, 8.934789, -9.7, -0.00022, 0.926653, 0.375918, 0.000542, 50],
  'orbit b 1.7786': [7.802718, 9.78708, 10.929569, -0.290518, 0.290518, 0.093061, 0.906939, 36],
  'top w 1.4000': [0, 22, 0, -0.707107, 0, 0, 0.707107, 27.335969],
  'side w 1.4000': [14.167701, 5.921566, 0, -0.136969, 0.693714, 0.136969, 0.693714, 31.05295],
  'shoulder w 1.4000': [2.603314, 5.187974, 10.547857, -0.199307, 0.127437, 0.026151, 0.971263, 41.403934],
  'eyes w 1.4000': [0.010765, 9.201329, 9.975524, -0.375892, 0.000526, 0.000214, 0.926663, 51.754917],
  'orbit w 1.4000': [8.05668, 10.099119, 11.285303, -0.290518, 0.290518, 0.093061, 0.906939, 37.26354],
  'top b 1.4000': [0, 22, 0, 0, 0.707107, 0.707107, 0, 27.335969],
  'side b 1.4000': [-14.146171, 5.921566, 0, -0.137154, -0.693678, -0.137154, 0.693678, 31.05295],
  'shoulder b 1.4000': [-2.581784, 5.187974, -10.547857, 0.025983, 0.97136, 0.199414, -0.126567, 41.403934],
  'eyes b 1.4000': [0.010765, 9.201329, -9.975524, -0.000214, 0.926663, 0.375892, 0.000526, 51.754917],
  'orbit b 1.4000': [8.05668, 10.099119, 11.285303, -0.290518, 0.290518, 0.093061, 0.906939, 37.26354],
  'top w 1.3000': [0, 22, 0, -0.707107, 0, 0, 0.707107, 27.335969],
  'side w 1.3000': [14.67346, 6.128299, 0, -0.136947, 0.693719, 0.136947, 0.693719, 32.225169],
  'shoulder w 1.3000': [2.705207, 5.356624, 10.930833, -0.199269, 0.127424, 0.026143, 0.971273, 42.966892],
  'eyes w 1.3000': [0.010765, 9.492362, 10.276367, -0.375865, 0.00051, 0.000207, 0.926674, 53.708616],
  'orbit w 1.3000': [8.336958, 10.443492, 11.6779, -0.290518, 0.290518, 0.093061, 0.906939, 38.670203],
  'top b 1.3000': [0, 22, 0, 0, 0.707107, 0.707107, 0, 27.335969],
  'side b 1.3000': [-14.651929, 6.128299, 0, -0.137126, -0.693683, -0.137126, 0.693683, 32.225169],
  'shoulder b 1.3000': [-2.683677, 5.356624, -10.930833, 0.025981, 0.971366, 0.199372, -0.126582, 42.966892],
  'eyes b 1.3000': [0.010765, 9.492362, -10.276367, -0.000207, 0.926674, 0.375865, 0.00051, 53.708616],
  'orbit b 1.3000': [8.336958, 10.443492, 11.6779, -0.290518, 0.290518, 0.093061, 0.906939, 38.670203],
  'top w 2.4000': [0, 22, 0, -0.707107, 0, 0, 0.707107, 27.335969],
  'side w 2.4000': [13.710765, 5.734789, 0, -0.13699, 0.69371, 0.13699, 0.69371, 30],
  'shoulder w 2.4000': [2.510765, 5.034789, 10.2, -0.199345, 0.12745, 0.026158, 0.971254, 40],
  'eyes w 2.4000': [0.010765, 8.934789, 9.7, -0.375918, 0.000542, 0.00022, 0.926653, 50],
  'orbit w 2.4000': [7.802718, 9.78708, 10.929569, -0.290518, 0.290518, 0.093061, 0.906939, 36],
  'top b 2.4000': [0, 22, 0, 0, 0.707107, 0.707107, 0, 27.335969],
  'side b 2.4000': [-13.689235, 5.734789, 0, -0.137182, -0.693672, -0.137182, 0.693672, 30],
  'shoulder b 2.4000': [-2.489235, 5.034789, -10.2, 0.025986, 0.971353, 0.199455, -0.126552, 40],
  'eyes b 2.4000': [0.010765, 8.934789, -9.7, -0.00022, 0.926653, 0.375918, 0.000542, 50],
  'orbit b 2.4000': [7.802718, 9.78708, 10.929569, -0.290518, 0.290518, 0.093061, 0.906939, 36],
};
