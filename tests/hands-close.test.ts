/**
 * A hand close to the eye, or with its arm coming toward the eye, still reads as a hand: the line
 * round its forearm lasts as long as the dark does, and for an eye behind the arm the dark by the
 * wrist goes before its line. Away from the eye nothing changes.
 */
import { MathUtils, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { HandMeta } from '../src/hands/rig.ts';
import {
  ARM_FROM,
  armCloseness,
  armEdgeShade,
  armLine,
  armShade,
  CLOSE_FROM,
  CLOSE_TO,
  eyeAlongArm,
  handMaterials,
  OPEN_DARK,
  OPEN_LINE,
  openTo,
  RIM_TURNED,
  squareShare,
  TOWARD_FROM,
  TOWARD_TO,
} from '../src/hands/material.ts';

/** The hand asset's forearm (assets/src/hands.py). */
const FOREARM = 3.4;
/** Where each side's arms lead back to (hand.ts). */
const SHOULDER = { w: new Vector3(0, 5, 12), b: new Vector3(0, 5, -12) };
/** The usual lens, in degrees from top to bottom of the picture. */
const LENS = 40;
/** Where the cameras that show the whole board stand, and where the eyes and the shoulder do (src/camera/rig.ts, as filmed). */
const SIDE = new Vector3(13.7, 5.7, 0);
const TOP = new Vector3(0, 22, 0);
const EYES = new Vector3(0, 8.9, 9.7);
const SHOULDER_EYE = new Vector3(2.5, 5, 10.2);

const steps = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);

/** A forearm from a wrist over the board, back toward its side's shoulder. */
function arm(side: 'w' | 'b', x: number, y: number, z: number) {
  const wrist = new Vector3(x, y, z);
  const way = SHOULDER[side].clone().sub(wrist).normalize();
  return { wrist, way, from: wrist.clone().addScaledVector(way, ARM_FROM) };
}

/** How close to the eye the arm is at each point along it, as the shader takes it. */
function closeness(eye: Vector3, a: ReturnType<typeof arm>): number[] {
  const toward = eyeAlongArm(eye, a.from, a.way);
  return steps(0, FOREARM, 0.1).map((s) => armCloseness(squareShare(eye.distanceTo(a.wrist.clone().addScaledVector(a.way, s)), LENS), toward));
}

/** Every square's centre, at a resting hand's height and a lifted one's. */
const wrists = steps(-3.5, 3.5, 1).flatMap((x) => steps(-3.5, 3.5, 1).flatMap((z) => [2.4, 4].map((y) => [x, y, z] as const)));

describe('what is close to the eye', () => {
  it('takes how large a square looks, as a share of the picture, from its distance and the lens', () => {
    // At the distance where the picture is one square tall, a square fills it.
    const distance = 1 / (2 * Math.tan(MathUtils.degToRad(LENS) / 2));
    expect(squareShare(distance, LENS)).toBeCloseTo(1, 6);
    expect(squareShare(2 * distance, LENS)).toBeCloseTo(0.5, 6);
    // About ten squares off it has not begun, and about seven off it is whole.
    expect(armCloseness(squareShare(10.4, LENS))).toBe(0);
    expect(armCloseness(squareShare(7.1, LENS))).toBe(1);
    expect(CLOSE_FROM).toBeLessThan(CLOSE_TO);
    expect(TOWARD_FROM).toBeLessThan(TOWARD_TO);
  });

  it('counts an arm coming toward the eye, from any distance, and not one running across or away', () => {
    const from = new Vector3(0, 3, 0);
    const way = new Vector3(0, 0, 1);
    expect(eyeAlongArm(new Vector3(0, 3, 40), from, way)).toBe(1);
    expect(eyeAlongArm(new Vector3(0, 3 + 40 * Math.tan(MathUtils.degToRad(30)), 40), from, way)).toBe(1);
    expect(eyeAlongArm(new Vector3(40, 3, 0), from, way)).toBe(0);
    expect(eyeAlongArm(new Vector3(0, 3, -40), from, way)).toBe(0);
    // The eye under the board, whose view the dark squares mirror, sees the same arm as the eye above it.
    expect(eyeAlongArm(new Vector3(1, -8, 9), from, way)).toBe(eyeAlongArm(new Vector3(1, 8, 9), from, way));
  });

  it('leaves every arm as it was for the cameras that show the whole board', () => {
    for (const eye of [SIDE, TOP]) {
      for (const side of ['w', 'b'] as const) {
        for (const [x, y, z] of wrists) {
          const most = Math.max(...closeness(eye, arm(side, x, y, z)));
          expect(most, `${side} hand at ${x},${y},${z} from ${eye.toArray()}`).toBeLessThan(0.05);
        }
      }
    }
  });

  it('takes the arm of a hand at work in front of the eyes or the shoulder as close', () => {
    // A hand lifted over the middle of the board and the near half of it, its arm back toward the player.
    for (const eye of [EYES, SHOULDER_EYE]) {
      for (const [x, z] of [[-2.5, -0.5], [0.5, 1.5], [-0.5, 3.5], [2.5, 0.5]]) {
        const near = closeness(eye, arm('w', x, 4, z));
        // From a little way past the cord on, where its line would otherwise have gone.
        expect(Math.min(...near.slice(10)), `hand at ${x},${z} from ${eye.toArray()}`).toBeGreaterThan(0.9);
      }
    }
  });
});

describe('the line round a forearm', () => {
  it('lasts, close to the eye, as long as the dark at the edge of the arm does, and goes in the same streaks', () => {
    for (const left of steps(0, 1, 0.01)) {
      expect(armLine(left, 1)).toBeGreaterThanOrEqual(armEdgeShade(left) - 1e-9);
      // And no brighter than that dark, past where the arm is a body: there it is an edge, not a beam of light.
      if (left < 0.72) expect(armLine(left, 1)).toBeCloseTo(armEdgeShade(left), 9);
    }
    expect(armEdgeShade(0)).toBe(0);
    expect(armEdgeShade(0.72)).toBe(1);
  });

  it('is drawn hardest there wherever the arm is still a body', () => {
    for (const left of steps(0.72, 1, 0.01)) expect(armLine(left, 1)).toBe(1);
  });

  it('goes first, away from the eye, and the dark after it, as it always has', () => {
    for (const left of steps(0, 1, 0.01)) {
      expect(armLine(left, 0)).toBeCloseTo(MathUtils.smoothstep(left, 0.72, 0.95), 9);
    }
    expect(armLine(0.5, 0)).toBe(0);
    expect(armShade(0.5)).toBeGreaterThan(0.8);
  });

  it('is longer only where the skin lies along the line of sight, at the edge of the arm as seen', () => {
    expect(armLine(0.5, 1, 0)).toBeGreaterThan(0.6);
    expect(armLine(0.5, 1, RIM_TURNED[1])).toBe(0);
    expect(armLine(0.5, 1, 0.9)).toBe(0);
  });
});

describe('for an eye behind the arm', () => {
  it('lets the dark by the wrist go no later than the line round it, however far behind the eye is', () => {
    expect(OPEN_DARK[0]).toBeLessThanOrEqual(OPEN_LINE[0]);
    expect(OPEN_DARK[1]).toBeLessThanOrEqual(OPEN_LINE[1]);
    for (const behind of steps(0, 1, 0.05)) {
      // (The wisps move both by the same amount along the limb, so every place along it covers them.)
      for (const along of steps(-1, 1, 0.01)) {
        expect(openTo(OPEN_DARK, along, behind)).toBeLessThanOrEqual(openTo(OPEN_LINE, along, behind) + 1e-9);
      }
    }
  });

  it('keeps the whole hand for an eye that is not behind the arm at all', () => {
    for (const along of steps(-1, 1, 0.1)) {
      expect(openTo(OPEN_DARK, along, 0)).toBe(1);
      expect(openTo(OPEN_LINE, along, 0)).toBe(1);
    }
  });
});

describe('the shaders', () => {
  const meta = { forearmLength: FOREARM, forearmEnd: [0.5, 0.35] } as unknown as HandMeta;
  const m = handMaterials('w', 1, meta);

  it('draw the line of a forearm by the same sums', () => {
    const line = m.line.fragmentShader;
    expect(line).toContain('return kept * armLined( left );');
    expect(line).toContain(`smoothstep( ${CLOSE_FROM.toFixed(3)}, ${CLOSE_TO.toFixed(3)}, 1.0 / max( vPixel * uViewport.y, 1e-4 ) )`);
    expect(line).toContain(`smoothstep( ${RIM_TURNED[0].toFixed(2)}, ${RIM_TURNED[1].toFixed(2)}, away )`);
    expect(m.line.vertexShader).toContain(`smoothstep( ${TOWARD_FROM.toFixed(2)}, ${TOWARD_TO.toFixed(2)}, lined )`);
  });

  it('take the dark and the line away by the wrist by the same sums, for an eye behind the arm', () => {
    for (const pass of [m.glass, m.line, m.depth, m.veil]) {
      expect(pass.fragmentShader).toContain(`towardEye( ${OPEN_DARK[0].toFixed(2)}, ${OPEN_DARK[1].toFixed(2)} )`);
      expect(pass.fragmentShader).toContain(`towardEye( ${OPEN_LINE[0].toFixed(2)}, ${OPEN_LINE[1].toFixed(2)} )`);
    }
  });
});
