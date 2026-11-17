/**
 * The lesson card on a narrow screen: docked at the foot, folded to the step's instruction, and
 * the board framed in the picture above it, so that no square a lesson needs lies under the card.
 * The frames themselves are taken by hand (tools/dev/look.mjs).
 */
import { readFileSync } from 'node:fs';
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CameraRig, type CameraMode } from '../src/camera/rig.ts';
import { LESSONS } from '../src/learn/lessons.ts';
import { CLEAR_MOST, dockedShares } from '../src/scene/framing.ts';

const panels = readFileSync('src/ui/panels.css', 'utf8');
const cards = readFileSync('src/ui/Cards.tsx', 'utf8');

describe('the step\'s instruction, for the folded card', () => {
  const steps = LESSONS.flatMap((l) => l.steps.map((s) => ({ lesson: l.id, step: s })));

  it('is given to every step, in a line', () => {
    for (const { lesson, step } of steps) {
      expect(step.ask, lesson).toMatch(/^[A-Z][^\n]*[.]$/);
      expect(step.ask.length, `${lesson}: ${step.ask}`).toBeLessThanOrEqual(56);
      expect(step.ask, lesson).not.toBe(step.say);
    }
  });

  it('is an instruction: it begins with what to do', () => {
    for (const { lesson, step } of steps) expect(step.ask, lesson).toMatch(/^(Click|Move|Take|Put|Get|Give|Walk)\b/);
  });
});

describe('what the camera is told to clear', () => {
  it('is nothing on a phone on its side, which has columns, or with no card docked', () => {
    expect(dockedShares(390, 200, 100, 500)).toEqual([0, 0]);
    expect(dockedShares(500, 200, 100, 500)).toEqual([0, 0]);
    expect(dockedShares(844, 0, 100, 500)).toEqual([0, 0]);
  });

  it('is the card and the head, as shares of the height', () => {
    const [foot, head] = dockedShares(800, 200, 100, 500);
    expect(foot).toBeCloseTo(0.25, 6);
    expect(head).toBeCloseTo(0.125, 6);
  });

  it('never leaves the board less than a third of the picture, whatever the card asks for', () => {
    const [foot, head] = dockedShares(600, 590, 300, 500);
    expect(foot + head).toBeLessThanOrEqual(CLEAR_MOST + 1e-9);
    expect(foot).toBeLessThanOrEqual(CLEAR_MOST);
  });
});

/** The board's four corners and its middle, as pixels of a picture `w` by `h` with the board framed above a card `below` pixels tall and below an interface `above` pixels tall. */
function framed(mode: CameraMode, w: number, h: number, above: number, below: number): { x: number; y: number }[] {
  const [foot, head] = dockedShares(h, below, above, 500);
  const share = 1 - foot - head;
  const camera = new PerspectiveCamera(40, w / h, 0.1, 220);
  const rig = new CameraRig(camera);
  rig.mode = mode;
  rig.share = share;
  rig.snap();
  rig.update(0, (w / h) / share);
  // What World.applyInset does with the same shares.
  camera.setViewOffset(w, h, 0, ((foot - head) / 2) * h, w, h);
  camera.updateMatrixWorld(true);
  return [[-4, -4], [4, -4], [-4, 4], [4, 4], [0, 0]].map(([x, z]) => {
    const p = new Vector3(x, 0, z).project(camera);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
  });
}

describe('the board framed above a docked card', () => {
  const screens: [number, number, number, number][] = [
    // width, height, the interface above the board, the card and the keys below it
    [390, 844, 146, 292],
    [360, 640, 146, 245],
    [768, 1024, 130, 215],
    [800, 600, 130, 215],
    [390, 844, 146, 130],
  ];
  for (const [w, h, above, below] of screens) {
    for (const mode of ['top', 'side', 'orbit'] as CameraMode[]) {
      it(`${mode}: all 64 squares lie between the interface and the card at ${w}x${h}`, () => {
        for (const p of framed(mode, w, h, above, below)) {
          expect(p.x, 'x').toBeGreaterThanOrEqual(0);
          expect(p.x, 'x').toBeLessThanOrEqual(w);
          expect(p.y, 'y below the interface').toBeGreaterThanOrEqual(above - 2);
          expect(p.y, 'y above the card').toBeLessThanOrEqual(h - below + 2);
        }
      });
    }
  }
});

describe('the card\'s layout', () => {
  it('is docked by the same screens in the stylesheet as in the component', () => {
    const query = /const DOCKED = '([^']+)'/.exec(cards)?.[1];
    expect(query).toBe('(max-width: 899px) and (min-height: 501px)');
    expect(panels).toContain(`@media ${query} {`);
  });

  it('keeps the fold key and the one-line instruction out of the way where the card is beside the board', () => {
    expect(panels).toMatch(/\.lesson-fold,\s*\.lesson-ask\s*\{\s*display: none;/);
  });

  it('folds the card to the instruction and its key', () => {
    expect(panels).toMatch(/\.lesson-folded h3,\s*\.lesson-folded \.lesson-say,\s*\.lesson-folded \.ways-on \{\s*display: none;/);
    expect(panels).toMatch(/\.lesson-folded \.lesson-ask \{\s*display: block;/);
  });

  it('tells the camera what it takes, and lets go of it when the card goes', () => {
    expect(cards).toContain('keepClearBetween');
    expect(cards).toMatch(/return \(\) => \{[\s\S]*keepClearBetween\(0, 0\)/);
  });
});
