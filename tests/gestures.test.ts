/**
 * What the hands make of the game: a point at a king in check and a start back from it, a hand
 * closed on a loss, and how they are held when the game is over. None of it may get in the way
 * of a move, or put a finger in among the stones.
 */
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Arm } from '../src/hands/puppeteer.ts';
import { squareCenter } from '../src/scene/layout.ts';
import { clearOf, handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);

const pad = new Vector3();
const place = new Vector3();
const fromHome = (arm: Arm) => arm.at.get(place).distanceTo(arm.home);

describe('what the hands make of the game', () => {
  it('points at a king in check, and goes home', async () => {
    const { stage, run } = handsRig();
    stage.setTurn('w');
    await run(1.5);
    const king = squareCenter('e8');
    stage.check('w', king);
    const arms = [stage.hands.w.right, stage.hands.w.left];
    let nearest = Infinity;
    await run(2.2, () => {
      for (const arm of arms) nearest = Math.min(nearest, Math.hypot(arm.hand.padWorld('index', pad, true).x - king.x, pad.z - king.z));
    });
    // A finger came out over the board to within a square and a half of the king.
    expect(nearest).toBeLessThan(1.5);
    await run(4);
    for (const arm of arms) expect(fromHome(arm)).toBeLessThan(0.5);
  });

  // The stones as a game begins; and the tallest of them on the corner squares, which is where
  // hands that come in over the ends of the board would find them.
  it.each([
    ['as a game begins', undefined],
    ['with kings and queens in the corners', 'q6k/8/8/8/8/8/8/K6Q w - - 0 1'],
    ['with them in the other corners', 'k6q/8/8/8/8/8/8/Q6K b - - 0 1'],
  ] as [string, string | undefined][])('never puts a hand in among the stones, %s', async (_name, fen) => {
    const acts: [(stage: ReturnType<typeof handsRig>['stage']) => void, number][] = [
      [(stage) => stage.check('w', squareCenter('e8')), 6],
      [(stage) => stage.check('w', squareCenter('a8')), 6],
      [(stage) => stage.check('b', squareCenter('h1')), 6],
      [(stage) => stage.strong('w'), 3],
      [(stage) => stage.blunder('b'), 4],
      [(stage) => stage.taken('w', 'q'), 3],
      [(stage) => stage.over('w', true, true), 9],
      [(stage) => stage.over('b', true, false), 6],
      [(stage) => stage.over(null, true, false), 6],
      // And what they do by themselves, left alone for a minute.
      [() => {}, 60],
    ];
    for (const [act, seconds] of acts) {
      const { stage, layer, run } = handsRig(fen);
      stage.setTurn('w');
      await run(1.5);
      act(stage);
      const arms = [stage.hands.w.right, stage.hands.w.left, stage.hands.b.right, stage.hands.b.left];
      const puppets = [...layer.standing()];
      let nearest = Infinity;
      let frame = 0;
      await run(seconds, () => {
        if (frame++ % 3 === 0) for (const arm of arms) nearest = Math.min(nearest, clearOf(arm, puppets));
      });
      // Clear of every stone by a twentieth of a square at the least.
      expect(nearest).toBeGreaterThan(0.05);
    }
  }, 60_000);

  it('starts the checked side back from the board, and lets it settle', async () => {
    const { stage, run } = handsRig();
    stage.setTurn('w');
    await run(1.5);
    const arm = stage.hands.b.right;
    const before = Math.abs(arm.at.get(place).z);
    stage.check('w', squareCenter('e8'));
    let farthest = before;
    await run(0.6, () => (farthest = Math.max(farthest, Math.abs(arm.at.get(place).z))));
    expect(farthest).toBeGreaterThan(before + 0.2);
    await run(3);
    expect(arm.swayed.length()).toBeLessThan(0.01);
    expect(arm.gesturing).toBe(false);
  });

  it('holds the hands as the game ended, and gives them back when it is played again', async () => {
    const { stage, run } = handsRig();
    stage.setTurn('w');
    await run(1.5);
    stage.setTurn(null);
    stage.over('b', true, true);
    await run(8);
    for (const arm of [stage.hands.w.right, stage.hands.w.left]) {
      // The loser's: sunk, and most of the way out.
      expect(arm.presence).toBeLessThan(0.3);
      expect(arm.hand.outline).toBeLessThan(0.5);
      expect(arm.at.get(place).y).toBeLessThan(arm.home.y - 0.3);
    }
    for (const arm of [stage.hands.b.right, stage.hands.b.left]) {
      // The winner's: high over their end of the board, and lit.
      expect(arm.presence).toBe(1);
      expect(arm.hand.energy).toBeGreaterThan(0.5);
      expect(arm.at.get(place).y).toBeGreaterThan(arm.home.y + 0.3);
    }
    stage.resume();
    await run(3);
    for (const arm of [stage.hands.w.right, stage.hands.w.left, stage.hands.b.right, stage.hands.b.left]) {
      expect(arm.presence).toBeCloseTo(1, 3);
      expect(arm.hand.outline).toBeCloseTo(1, 3);
      expect(arm.swayed.length()).toBeLessThan(0.01);
      expect(fromHome(arm)).toBeLessThan(0.5);
    }
  });

  it('stands a game that was already over as it ended, at once', async () => {
    const { stage, run } = handsRig();
    await run(1);
    stage.over('w', false, false);
    await run(0.5);
    expect(stage.hands.b.right.presence).toBeLessThan(0.3);
    expect(stage.hands.w.right.glow).toBeGreaterThan(0.5);
  });

  it('lets a move through whatever the hands were doing', async () => {
    const { game, layer, stage, run } = handsRig();
    stage.setTurn('w');
    await run(1.5);
    // In the middle of opening its hands at a strong move, the side is asked to play.
    stage.strong('w');
    await run(0.3);
    const e = game.move('e2', 'e4');
    let done = false;
    void stage.playMove(e).then(() => (done = true));
    await run(6);
    expect(done).toBe(true);
    const pawn = layer.puppet(e.piece.id)!;
    expect(pawn.group.position.distanceTo(squareCenter('e4'))).toBeLessThan(1e-6);
    for (const arm of [stage.hands.w.right, stage.hands.w.left]) {
      expect(arm.gesturing).toBe(false);
      expect(arm.swayed.length()).toBeLessThan(0.01);
      expect(arm.glow).toBeLessThan(0.01);
    }
    // And the same in the middle of a point at a king, which has the hand out over the board.
    stage.check('w', squareCenter('e8'));
    await run(0.9);
    const back = game.move('e7', 'e5');
    void back;
    const next = game.move('g1', 'f3');
    done = false;
    void stage.playMove(next).then(() => (done = true));
    await run(6);
    expect(done).toBe(true);
    expect(layer.puppet(next.piece.id)!.group.position.distanceTo(squareCenter('f3'))).toBeLessThan(1e-6);
    for (const arm of [stage.hands.w.right, stage.hands.w.left]) expect(fromHome(arm)).toBeLessThan(0.5);
  });

  it('is all put away by a new game', async () => {
    const { stage, run } = handsRig();
    await run(1);
    stage.over('b', true, true);
    await run(1.2);
    stage.reset();
    await run(2);
    for (const arm of [stage.hands.w.right, stage.hands.w.left, stage.hands.b.right, stage.hands.b.left]) {
      expect(arm.presence).toBe(1);
      expect(arm.swayed.length()).toBeLessThan(1e-6);
      expect(arm.glow).toBeLessThan(1e-6);
      expect(arm.gesturing).toBe(false);
    }
  });
});
