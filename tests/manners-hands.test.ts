/**
 * The first three of the hands' manners, on the real skeleton and the real stones
 * (docs/manners.md): fingers drummed on the rail of the case, two hands steepled, and a king laid
 * down by its own player's hand. A finger that is said to be on something is on it; no hand goes
 * into a stone; none of it is over the squares; and a move stops any of it at once.
 */
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Side } from '../src/core/game.ts';
import { draw } from '../src/hands/manners.ts';
import type { Arm } from '../src/hands/puppeteer.ts';
import { FINGERS, type FingerName } from '../src/hands/rig.ts';
import { FIELD_HALF, RIM_TOP, SLAB_HALF } from '../src/scene/layout.ts';
import type { Puppet } from '../src/scene/pieces.ts';
import { clearOf, handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);
// Each test here steps the real hands frame by frame, and many measure every point of their skin each frame. They run in one or two seconds on an idle machine; the default five is too little for a runner that is busy with other work.
vi.setConfig({ testTimeout: 30000 });

const DRUMMERS: FingerName[] = ['little', 'ring', 'middle', 'index'];
const pad = new Vector3();
const other = new Vector3();
const UP = new Vector3(0, 1, 0);
const armsOf = (hands: { right: Arm; left: Arm }) => [hands.right, hands.left];
/** How far from upright a stone is, in radians. */
const tilt = (puppet: Puppet) => UP.clone().applyQuaternion(puppet.group.quaternion).angleTo(UP);
const kingOf = (stones: Iterable<Puppet>, side: Side) => [...stones].find((p) => p.kind === 'k' && p.side === side)!;

describe('drumming on the rail', () => {
  it.each([
    ['w', 1],
    ['w', 2],
    ['b', 1],
    ['b', 2],
  ] as const)("sets four fingers down on the rail at its player's own end, and drums (%s, hand %i)", async (side, nth) => {
    const { stage, layer, run } = handsRig();
    stage.setTurn(side === 'w' ? 'b' : 'w');
    await run(1.5);
    const hands = stage.hands[side];
    // The two hands take turns at it: the second asking gets the other hand.
    if (nth === 2) {
      hands.drumOnRail(undefined, 1);
      await run(6);
    }
    const taps: number[] = [];
    hands.drumOnRail((_, strength) => taps.push(strength));
    const stones = [...layer.standing()];
    const end = side === 'w' ? 1 : -1;
    let clear = Infinity;
    let planted = 0;
    let lowest = Infinity;
    await run(6.5, () => {
      for (const arm of armsOf(hands)) {
        clear = Math.min(clear, clearOf(arm, stones));
        for (const finger of DRUMMERS) {
          arm.hand.padWorld(finger, pad);
          // Over the case, no fingertip is ever down in the wood.
          if (Math.abs(pad.x) < SLAB_HALF && Math.abs(pad.z) < SLAB_HALF) lowest = Math.min(lowest, pad.y);
          if (!arm.planted || arm.hand.touchWeight < 0.999) continue;
          planted++;
          // On the rail: outside the squares, inside the edge of the case, and on its player's side.
          expect(pad.z * end).toBeGreaterThan(FIELD_HALF + 0.04);
          expect(pad.z * end).toBeLessThan(SLAB_HALF - 0.04);
          expect(Math.abs(pad.x)).toBeLessThan(SLAB_HALF - 0.04);
          // And on the wood, or lifted from it to come down again.
          expect(pad.y).toBeGreaterThan(RIM_TOP);
          expect(pad.y).toBeLessThan(RIM_TOP + 0.3);
        }
      }
    });
    expect(planted).toBeGreaterThan(200);
    expect(lowest).toBeGreaterThan(RIM_TOP - 0.04);
    expect(clear).toBeGreaterThan(0);
    // Four fingers set down, and then three rolls of four, the index hardest.
    expect(taps.length).toBe(16);
    expect(taps.slice(4).filter((strength) => strength === 1).length).toBe(3);
    // And it has let go of the rail and gone home.
    for (const arm of armsOf(hands)) {
      expect(arm.planted).toBe(false);
      expect(arm.hand.touchWeight).toBe(0);
      expect(arm.at.get(pad).distanceTo(arm.home)).toBeLessThan(0.5);
    }
  });

  it('lets go at once when its player has a move to make', async () => {
    const { game, stage, run } = handsRig();
    stage.setTurn('b');
    await run(1.5);
    stage.hands.w.drumOnRail();
    await run(3.2);
    const arm = armsOf(stage.hands.w).find((a) => a.planted)!;
    expect(arm).toBeDefined();
    game.move('e2', 'e4');
    game.move('e7', 'e5');
    let done = false;
    void stage.playMove(game.move('g1', 'f3')).then(() => (done = true));
    await run(0.3);
    expect(arm.planted).toBe(false);
    expect(arm.hand.touchWeight).toBeLessThan(0.05);
    await run(4);
    expect(done).toBe(true);
  });
});

describe('the steeple', () => {
  it.each(['w', 'b'] as const)('brings all five fingertips of each hand to the other hand\'s, low before its player\'s end of the case (%s)', async (side) => {
    const { stage, layer, run } = handsRig();
    stage.setTurn(side);
    await run(1.5);
    const hands = stage.hands[side];
    const met: Vector3[] = [];
    hands.steeple((at) => met.push(at.clone()));
    const stones = [...layer.standing()];
    const end = side === 'w' ? 1 : -1;
    let clear = Infinity;
    let together = 0;
    let crossed = -Infinity;
    await run(6.5, () => {
      for (const arm of armsOf(hands)) clear = Math.min(clear, clearOf(arm, stones));
      for (const finger of FINGERS) {
        hands.right.hand.padWorld(finger, pad);
        hands.left.hand.padWorld(finger, other);
        // Neither hand's fingertips are ever through the other's: each keeps to its own side of the middle.
        crossed = Math.max(crossed, -pad.x * Math.sign(hands.right.home.x), -other.x * Math.sign(hands.left.home.x));
        if (!hands.right.planted || hands.right.hand.touchWeight < 0.999) continue;
        together++;
        // Tip to tip: no farther apart than two fingertips are thick.
        expect(pad.distanceTo(other)).toBeLessThan(0.12);
        // Before the case, not over it; and low.
        expect(pad.z * end).toBeGreaterThan(SLAB_HALF);
        expect(pad.y).toBeLessThan(2.4);
      }
    });
    expect(together).toBeGreaterThan(400);
    expect(crossed).toBeLessThan(0.12);
    expect(clear).toBeGreaterThan(0.3);
    expect(met.length).toBe(1);
    expect(Math.abs(met[0]!.x)).toBeLessThan(0.05);
    for (const arm of armsOf(hands)) {
      expect(arm.planted).toBe(false);
      expect(arm.at.get(pad).distanceTo(arm.home)).toBeLessThan(0.6);
    }
  });

  it('parts at once when a piece is to be moved, and the move is made', async () => {
    const { game, stage, run } = handsRig();
    stage.setTurn('w');
    await run(1.5);
    stage.hands.w.steeple();
    await run(3);
    expect(stage.hands.w.right.planted && stage.hands.w.left.planted).toBe(true);
    let done = false;
    void stage.playMove(game.move('e2', 'e4')).then(() => (done = true));
    await run(0.3);
    for (const arm of armsOf(stage.hands.w)) {
      expect(arm.planted).toBe(false);
      expect(arm.hand.touchWeight).toBeLessThan(0.05);
    }
    await run(4);
    expect(done).toBe(true);
    for (const arm of armsOf(stage.hands.w)) expect(arm.at.get(pad).distanceTo(arm.home)).toBeLessThan(0.6);
  });
});

describe('waiting, as the stage has it', () => {
  it('drums or steeples only when the table says so, and then on what both players can see', async () => {
    // A seed for which the steeple's chance comes up at the first ply, and one for which it does not.
    const seed = (comes: boolean) => {
      for (let i = 0; ; i++) if (draw(`s${i}`, 0, 'steeple') < 1 / 40 === comes) return `s${i}`;
    };
    for (const comes of [true, false]) {
      const { stage, run } = handsRig();
      stage.setSeed(seed(comes));
      stage.reset();
      stage.setTurn('w');
      let met = 0;
      stage.heard = (what) => void (what === 'meet' && met++);
      await run(45);
      expect(met).toBe(comes ? 1 : 0);
    }
  }, 30000);
});

describe('a king laid down', () => {
  it.each([
    ['in the open', '4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', false],
    ['in a corner', '7k/8/8/8/8/8/8/K7 w - - 0 1', 'w', false],
    ['among its own stones, as a game begins', undefined, 'w', true],
    ['castled, behind its pawns', 'r4rk1/ppp2ppp/2n5/8/8/8/PPP2PPP/R4RK1 w - - 0 1', 'b', true],
  ] as const)("is pushed over by its own player's finger, falls, and stands again if the game goes on (%s)", async (_, fen, loser, leans) => {
    const { stage, layer, run } = handsRig(fen);
    stage.setTurn('w');
    await run(1.5);
    const king = kingOf(layer.standing(), loser);
    const stood = king.group.position.clone();
    const others = [...layer.standing()].filter((p) => p !== king);
    const events: string[] = [];
    let onCrown = Infinity;
    let clear = Infinity;
    const hands = stage.hands[loser];
    const did = stage.concedes(
      loser,
      true,
      null,
      () => events.push('down'),
      () => events.push('knock'),
    );
    expect(did).toBe(true);
    stage.over(loser === 'w' ? 'b' : 'w', true, false);
    await run(5, () => {
      for (const arm of armsOf(hands)) {
        clear = Math.min(clear, clearOf(arm, others));
        // Before it has begun to go over, the finger that will push it is on its crown.
        if (arm.planted && arm.hand.touchWeight > 0.999 && tilt(king) < 1e-4) onCrown = arm.hand.padWorld('index', pad).distanceTo(arm.hand.touch.index!);
      }
    });
    // (To within the thickness of a fingertip.)
    expect(onCrown).toBeLessThan(0.08);
    expect(clear).toBeGreaterThan(0);
    // It struck once, and what the game makes of its ending waited for that; then it rocked.
    expect(events[0]).toBe('down');
    expect(events.filter((e) => e === 'down').length).toBe(1);
    expect(events.filter((e) => e === 'knock').length).toBe(leans ? 2 : 3);
    if (leans) {
      // Hemmed in, it has not room to lie: it rests against a neighbour.
      expect(tilt(king)).toBeGreaterThan(0.4);
      expect(tilt(king)).toBeLessThan(1.3);
    } else {
      // It lies along the board, its crown still over the squares.
      expect(tilt(king)).toBeGreaterThan(Math.PI / 2 - 0.05);
      const crown = new Vector3(0, 1.7, 0).applyQuaternion(king.group.quaternion).add(king.group.position);
      expect(Math.abs(crown.x)).toBeLessThan(FIELD_HALF);
      expect(Math.abs(crown.z)).toBeLessThan(FIELD_HALF);
      expect(crown.y).toBeGreaterThan(0);
    }
    for (const arm of armsOf(hands)) expect(arm.planted).toBe(false);
    // The resignation is taken back (or another game begun on the same stones): it stands where it stood.
    stage.resume();
    await run(0.5);
    expect(tilt(king)).toBeLessThan(1e-6);
    expect(king.group.position.distanceTo(stood)).toBeLessThan(1e-6);
  });

  it('is found lying, with no hand near it, in a game that was given up before it was looked at', async () => {
    const { stage, layer, run } = handsRig('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    await run(1);
    const king = kingOf(layer.standing(), 'b');
    let told = 0;
    expect(stage.concedes('b', false, null, () => told++, () => told++)).toBe(true);
    expect(tilt(king)).toBeGreaterThan(Math.PI / 2 - 0.05);
    await run(1);
    expect(told).toBe(0);
    for (const arm of armsOf(stage.hands.b)) expect(arm.at.get(pad).distanceTo(arm.home)).toBeLessThan(0.5);
  });

  it.each(['time', 'left', 'noshow'] as const)('is left standing when it was the clock or the server that ended the game (%s)', async (ended) => {
    const { stage, layer, run } = handsRig();
    await run(1);
    const king = kingOf(layer.standing(), 'w');
    expect(stage.concedes('w', true, ended, () => {}, () => {})).toBe(false);
    await run(2);
    expect(tilt(king)).toBeLessThan(1e-6);
  });
});
