/**
 * The explanation card and the result card at a tablet's width (761 to 899 pixels), and the
 * explanation card on a phone: docked at the foot like the lesson card, and the board framed in
 * the picture above them, so that no square lies under them. On a short phone the card is set
 * closer, and in an online game the room's card gives way to it, so that neither the board nor
 * the card's own key ends up under the match bar or the bar of keys. The frames themselves are taken by
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
    // A short phone, where the card is set closer.
    [360, 640, 144, 263],
    // A ranked game on a taller phone: the card as it stands, and the two clocks under it.
    [390, 844, 144, 398],
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

describe('the board above a rule explained in a ranked game on a short phone', () => {
  // The card set closer and the two clocks under it take 309 pixels of the foot, as measured in the page; the keys in the corner end at 138, the match bar with its note at 89.
  const screens: [number, number][] = [
    [360, 640],
    [375, 667],
  ];
  for (const [w, h] of screens) {
    for (const mode of ['side', 'orbit'] as CameraMode[]) {
      it(`${mode}: all 64 squares lie between the keys in the corner and the card at ${w}x${h}`, () => {
        for (const p of framed(mode, w, h, 144, 309)) {
          expect(p.y, 'y below the interface').toBeGreaterThanOrEqual(144 - 2);
          expect(p.y, 'y above the card').toBeLessThanOrEqual(h - 309 + 2);
        }
      });
    }
    // Seen from above the board is as tall as it is wide, and there is not the height for all of it: it is kept
    // clear of the card and of the match bar, and its far corners reach a little way in beside the keys in the corner.
    it(`top: all 64 squares lie between the match bar and the card at ${w}x${h}`, () => {
      for (const p of framed('top', w, h, 144, 309)) {
        expect(p.x, 'x').toBeGreaterThanOrEqual(0);
        expect(p.x, 'x').toBeLessThanOrEqual(w);
        expect(p.y, 'y below the match bar').toBeGreaterThanOrEqual(89 + 6);
        expect(p.y, 'y beside the keys in the corner').toBeGreaterThanOrEqual(144 - 28);
        expect(p.y, 'y above the card').toBeLessThanOrEqual(h - 309 + 2);
      }
    });
  }

  it('was under the bar of keys before: the two cards as they stood were taller than the column may be', () => {
    // The room's card (137), the rule (278) and the space between them (24), against the 54vh the column is given at 640.
    expect(137 + 24 + 278).toBeGreaterThan(0.54 * 640);
    // As they stand now: the rule (179), the clocks (38) and the space between (8), with the column's own padding (14).
    expect(179 + 8 + 38 + 14).toBeLessThanOrEqual(0.54 * 640);
    expect(179 + 8 + 38 + 14 + 70).toBe(309);
  });
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

  it('sets the rule closer on a short phone, its key and the way to stop side by side', () => {
    const short = /@media \(max-width: 760px\) and \(min-height: 501px\) and \(max-height: 700px\) \{([\s\S]*?)\n\}/.exec(panels)?.[1] ?? '';
    expect(short).toMatch(/\.rail-left \.card\.explain \{\s*display: grid;\s*grid-template-columns: auto 1fr;/);
    expect(short).toMatch(/\.rail-left \.card\.explain p:not\(\.ways-on\) \{\s*grid-column: 1 \/ -1;/);
    // The key and the way to stop are the card's last two children, one to each column of the last row.
    expect(cards).toMatch(/<section class="card explain"[\s\S]*?<div class="choices">[\s\S]*?<\/div>\s*<p class="ways-on">[\s\S]*?<\/p>\s*<\/section>/);
  });

  it('keeps a rule\'s key in reach in an online game on a phone: the room\'s card is only its clocks while the rule stands', () => {
    const phone = /@media \(max-width: 760px\) and \(min-height: 501px\) \{([\s\S]*?)\n\}/.exec(panels)?.[1] ?? '';
    const room = '\\.rail-left:has\\(\\.card\\.explain\\) \\.card\\.room:not\\(\\.room-asked\\)';
    // The rule first in the column, so that its key is never the part scrolled out of sight.
    expect(phone).toMatch(/\.rail-left \.card\.explain \{\s*order: -1;/);
    // With no clocks the room's card stands aside; with them, nothing of it is left but the list of the two players.
    expect(phone).toMatch(new RegExp(`${room}:not\\(:has\\(\\.players time\\)\\) \\{\\s*display: none;`));
    expect(phone).toMatch(new RegExp(`${room} > :not\\(\\.players\\) \\{\\s*display: none;`));
    expect(phone).toMatch(new RegExp(`${room} \\.players \\{\\s*grid-template-columns: repeat\\(2, minmax\\(0, 1fr\\)\\);`));
    // The clocks themselves are never put away.
    expect(phone).not.toMatch(/\.players time[\s,]*\{/);
    // Both cards are the column's own children, which is what the stylesheet counts on.
    expect(hud).toMatch(/<Room app=\{app\} \/>/);
    expect(hud).toMatch(/<Explain app=\{app\} \/>/);
  });

  it('leaves the graph of the game out where the board needs the height', () => {
    expect(panels).toMatch(/\(max-height: 760px\) \{\s*\.result \.story \{\s*display: none;/);
  });
});
