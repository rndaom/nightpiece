/**
 * The explanation card and the result card at a tablet's width (761 to 899 pixels), and the
 * explanation card on a phone: docked at the foot like the lesson card, and the board framed in
 * the picture above them, so that no square lies under them. The frames themselves are taken by
 * hand (tools/dev/look.mjs, see docs/progress.md).
 */
import { readFileSync } from 'node:fs';
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CameraRig, type CameraMode } from '../src/camera/rig.ts';
import { dockedShares } from '../src/scene/framing.ts';

const panels = readFileSync('src/ui/panels.css', 'utf8');
const cards = readFileSync('src/ui/Cards.tsx', 'utf8');
const hud = readFileSync('src/ui/Hud.tsx', 'utf8');

/** The board's four corners and its middle, as pixels of a picture `w` by `h` with the board framed above a card `below` pixels tall and below an interface `above` pixels tall. */
function framed(mode: CameraMode, w: number, h: number, above: number, below: number): { x: number; y: number }[] {
  const [foot, head] = dockedShares(h, below, above, 500);
  const share = 1 - foot - head;
  const camera = new PerspectiveCamera(40, w / h, 0.1, 220);
  const rig = new CameraRig(camera);
  rig.mode = mode;
  rig.share = share;
  rig.snap();
  rig.update(0, w / h / share);
  // What World.applyInset does with the same shares.
  camera.setViewOffset(w, h, 0, ((foot - head) / 2) * h, w, h);
  camera.updateMatrixWorld(true);
  return [[-4, -4], [4, -4], [-4, 4], [4, 4], [0, 0]].map(([x, z]) => {
    const p = new Vector3(x, 0, z).project(camera);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
  });
}

describe('the board framed above a docked explanation or result card', () => {
  // width, height, the interface above the board, the card and the keys below it: as measured in the page.
  const explained: [number, number, number, number][] = [
    [768, 1024, 120, 281],
    [820, 1180, 120, 281],
    [800, 600, 120, 281],
    [390, 844, 144, 348],
    // So short that the board cannot be kept clear of the match bar as well as of the card (see CLEAR_MOST): it is kept clear of the card.
    [360, 640, 0, 348],
  ];
  const ended: [number, number, number, number][] = [
    [768, 1024, 120, 421],
    [820, 1180, 120, 421],
    [800, 600, 120, 259],
  ];
  for (const [what, screens] of [['rule explained', explained], ['result', ended]] as const) {
    for (const [w, h, above, below] of screens) {
      for (const mode of ['top', 'side', 'orbit'] as CameraMode[]) {
        it(`${mode}: all 64 squares lie between the interface and the ${what} card at ${w}x${h}`, () => {
          for (const p of framed(mode, w, h, above, below)) {
            expect(p.x, 'x').toBeGreaterThanOrEqual(0);
            expect(p.x, 'x').toBeLessThanOrEqual(w);
            expect(p.y, 'y below the interface').toBeGreaterThanOrEqual(above - 2);
            expect(p.y, 'y above the card').toBeLessThanOrEqual(h - below + 2);
          }
        });
      }
    }
  }
});

describe('the cards\' layout', () => {
  it('docks the result card by the same screens in the stylesheet as in the component', () => {
    const query = /const TABLET = '([^']+)'/.exec(cards)?.[1];
    expect(query).toBe('(min-width: 761px) and (max-width: 899px) and (min-height: 501px)');
    expect(panels).toContain(`@media ${query} {`);
  });

  it('docks both cards at the foot, and puts the record by', () => {
    expect(panels).toMatch(/\.hud:has\(\.card\.explain, \.card\.result\) \.rail\.rail-left \{\s*top: auto;/);
    expect(panels).toMatch(/\.hud:has\(\.rail-left \.card\.explain, \.rail-left \.card\.result\) \.record \{\s*display: none;/);
  });

  it('tells the camera what each card takes, and lets go of it when the card goes', () => {
    expect(cards).toMatch(/useFraming\(app, result \|\| explaining\(\), [^;]*result \? TABLET : DOCKED\);/);
    expect(hud).toContain('<Docking app={app} />');
  });

  it('leaves the graph of the game out where the board needs the height', () => {
    expect(panels).toMatch(/\(max-height: 760px\) \{\s*\.result \.story \{\s*display: none;/);
  });
});
