/**
 * A piece that takes one standing close by: the two hands are not over the two pieces at once.
 * The hand that takes draws off to its own side while the other lifts the taken piece away, and
 * comes in when it is off its square; and neither goes in among the stones on the way.
 */
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Square } from '../src/core/game.ts';
import type { Arm } from '../src/hands/puppeteer.ts';
import { clearOf, handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);

const a = new Vector3();
const b = new Vector3();

describe('a piece taken from close by', () => {
  it.each([
    ['a pawn takes a pawn', undefined, [['e2', 'e4'], ['d7', 'd5']], 'e4', 'd5'],
    ['with tall stones where the hand draws off to', '4k3/8/8/8/8/3p4/4P1Q1/6K1 w - - 0 1', [], 'e2', 'd3'],
    ['Void takes', '6k1/4p1q1/3P4/8/8/8/8/4K3 b - - 0 1', [], 'e7', 'd6'],
    ['a rook takes the next square up its file', '4k3/8/8/8/8/8/r7/R3K3 w - - 0 1', [], 'a1', 'a2'],
    ['a knight takes', undefined, [['g1', 'f3'], ['e7', 'e5']], 'f3', 'e5'],
    ['a pawn on the edge takes inward', '4k3/8/8/8/8/6p1/7P/4K2R w - - 0 1', [], 'h2', 'g3'],
  ] as [string, string | undefined, [Square, Square][], Square, Square][])('%s', async (_name, fen, before, from, to) => {
    const { game, layer, stage, run } = handsRig(fen);
    stage.setTurn(game.turn());
    await run(1.5);
    for (const [x, y] of before) {
      void stage.playMove(game.move(x, y));
      await run(6);
    }
    const e = game.move(from, to);
    const side = stage.hands[e.side];
    const arms = [side.right, side.left];
    const taker = layer.puppet(e.piece.id)!;
    const puppets = [...layer.standing()];
    // How near each hand came to a stone while it had nothing in it.
    const clear = new Map<Arm, number>(arms.map((arm) => [arm, Infinity]));
    let done = false;
    let lifted = false;
    let mover: Arm | undefined;
    let tookTooSoon = false;
    let apart = Infinity;
    void stage.playMove(e).then(() => (done = true));
    await run(7, () => {
      if (done) return;
      mover ??= arms.find((arm) => arm.held?.puppet === taker);
      const remover = arms.find((arm) => arm.held && arm.held.puppet !== taker);
      for (const arm of arms) if (!arm.held) clear.set(arm, Math.min(clear.get(arm)!, clearOf(arm, puppets)));
      if (remover?.held?.attached && remover.held.puppet.group.position.y > 0.02) lifted = true;
      if (lifted) return;
      // Until the taken piece is off the board the other hand has not taken hold of anything, and
      // while the taken piece is held it is well away.
      if (arms.some((arm) => arm.held?.puppet === taker)) tookTooSoon = true;
      if (remover?.held?.attached) apart = Math.min(apart, Math.hypot(side.right.at.get(a).x - side.left.at.get(b).x, a.z - b.z));
    });
    expect(done).toBe(true);
    expect(layer.puppetAt(to)).toBe(taker);
    expect(lifted).toBe(true);
    expect(tookTooSoon).toBe(false);
    expect(apart).toBeGreaterThan(2.4);
    // It does not put a finger into a stone to get out of the way, or coming back in.
    expect(clear.get(mover!)).toBeGreaterThan(-0.02);
  }, 60_000);
});
