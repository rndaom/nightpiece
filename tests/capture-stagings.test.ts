/**
 * Two ways a capture is staged (docs/manners.md, "Small takes great" and "The exchange quickens"),
 * on the real skeleton and the real stones: a pawn that takes a rook or a queen is patted once it
 * is down, and its eye goes wide; and captures that answer one another on one square are each made
 * quicker than the one before, to a limit. Both go by the game's own moves, so every screen at the
 * board plays them alike; neither keeps the next player waiting; and the pat gives way to them.
 */
import { type Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MoveEvent, Square } from '../src/core/game.ts';
import type { Arm } from '../src/hands/puppeteer.ts';
import { squareCenter } from '../src/scene/layout.ts';
import { clearOf, DT, handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);

/** A pawn that can take a rook, and one that can take a knight. */
const ROOK = '4k3/8/8/3r1n2/4P3/8/8/4K3 w - - 0 1';
/** A pawn that can take a queen; and a knight that can take a rook. */
const QUEEN = '4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1';
const KNIGHT = '4k3/8/8/3r4/8/2N5/8/4K3 w - - 0 1';
/** A pawn that takes a rook on the last rank, and is made a queen there. */
const LAST = '3rk3/4P3/8/8/8/8/8/4K3 w - - 0 1';
/** A pawn on d5 with two of each side's stones bearing on it and a third behind: five captures there, one after another. */
const EXCHANGE = '3qk3/8/5n2/3p4/4P3/2N5/8/3RK3 w - - 0 1';
/** The same board with the first two of them made, and White to make the third. */
const EXCHANGE_AT_THIRD = '3qk3/8/8/3n4/8/2N5/8/3RK3 w';
const TAKES: [Square, Square][] = [
  ['e4', 'd5'],
  ['f6', 'd5'],
  ['c3', 'd5'],
  ['d8', 'd5'],
  ['d1', 'd5'],
];

const armsOf = (hands: { right: Arm; left: Arm }) => [hands.right, hands.left];

/** A board set up as `fen` with the hands come to rest, what is heard at it, and each manner chosen at the set. */
async function board(fen: string, plain = false) {
  const rig = handsRig(fen);
  rig.stage.reset();
  rig.stage.setTurn(rig.game.turn());
  await rig.run(1.5);
  const heard: { what: string; at: Vector3; time: number }[] = [];
  let time = 0;
  rig.stage.heard = (what, at) => heard.push({ what, at: at.clone(), time });
  const run = (seconds: number, each?: () => void) =>
    rig.run(seconds, () => {
      time += DT;
      each?.();
    });
  const chosen: (string | null)[] = [];
  const table = rig.stage.manners;
  const asked = table.choose.bind(table);
  table.choose = (at, facts) => {
    const name = plain && at === 'set' ? null : asked(at, facts);
    if (at === 'set') chosen.push(name);
    return name;
  };
  const widened: number[] = [];
  const widen = rig.layer.widen.bind(rig.layer);
  rig.layer.widen = (id) => {
    widened.push(id);
    widen(id);
  };
  return { ...rig, run, heard, chosen, widened, now: () => time };
}
type Board = Awaited<ReturnType<typeof board>>;

/** Play a move, and step until it is done with: how long that took, and the event. */
async function untilDone(rig: Board, from: Square, to: Square, promotion?: 'q'): Promise<{ e: MoveEvent; seconds: number }> {
  const e = rig.game.move(from, to, promotion);
  let done = false;
  void rig.stage.playMove(e).then(() => (done = true));
  let seconds = 0;
  for (; !done && seconds < 12; seconds += DT) await rig.run(DT);
  expect(done).toBe(true);
  return { e, seconds };
}

/** How far a stone is from standing exactly on a square. */
function off(rig: Board, square: Square): number {
  const at = squareCenter(square);
  const p = rig.layer.puppetAt(square)!.group.position;
  return Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z);
}

describe('small takes great', { timeout: 120000 }, () => {
  it('pats a pawn that has taken a rook, once, after it is set down, and the eye of the pawn goes wide', async () => {
    const rig = await board(ROOK);
    const pawn = rig.layer.puppetAt('e4')!;
    const { e, seconds } = await untilDone(rig, 'e4', 'd5');
    expect(rig.chosen).toEqual(['small-takes-great']);
    // The move is done with before the pat: the pat goes on as the game does.
    expect(rig.heard.filter((h) => h.what === 'tap')).toHaveLength(0);
    const done = rig.now();
    const others = [...rig.layer.standing()].filter((p) => p.id !== pawn.id);
    let clear = Infinity;
    await rig.run(3, () => {
      for (const arm of armsOf(rig.stage.hands[e.side])) clear = Math.min(clear, clearOf(arm, others));
    });
    const taps = rig.heard.filter((h) => h.what === 'tap');
    expect(taps).toHaveLength(1);
    expect(taps[0]!.time).toBeGreaterThan(done);
    expect(Math.hypot(taps[0]!.at.x - pawn.group.position.x, taps[0]!.at.z - pawn.group.position.z)).toBeLessThan(0.2);
    expect(rig.widened).toEqual([pawn.id]);
    expect(off(rig, 'd5')).toBeLessThan(1e-9);
    expect(clear).toBeGreaterThan(0.005);
    for (const arm of armsOf(rig.stage.hands.w)) expect(arm.busy).toBe(false);
    // And it was done with as soon as the same move set down plainly.
    const plain = await untilDone(await board(ROOK, true), 'e4', 'd5');
    expect(seconds).toBeLessThanOrEqual(plain.seconds + 0.02);
  });

  it('holds a queen a pawn has taken up on her way to the drawer, as the pawn is patted', async () => {
    const rig = await board(QUEEN);
    const queen = rig.layer.puppetAt('d5')!;
    const pawn = rig.layer.puppetAt('e4')!;
    let brightest = 0;
    const e = rig.game.move('e4', 'd5');
    void rig.stage.playMove(e);
    await rig.run(6, () => (brightest = Math.max(brightest, queen.energy)));
    expect(rig.chosen).toEqual(['small-takes-great']);
    expect(brightest).toBeGreaterThan(1.5);
    expect(queen.energy).toBeLessThan(0.05);
    expect(rig.heard.filter((h) => h.what === 'tap')).toHaveLength(1);
    expect(rig.widened).toEqual([pawn.id]);
  });

  it('is for a pawn and a great stone only: not a pawn that takes a knight, nor a knight that takes a rook, nor a pawn made a queen as it takes', async () => {
    const small = await board(ROOK);
    await untilDone(small, 'e4', 'f5');
    await small.run(3);
    const knight = await board(KNIGHT);
    await untilDone(knight, 'c3', 'd5');
    await knight.run(3);
    const last = await board(LAST);
    await untilDone(last, 'e7', 'd8', 'q');
    await last.run(3);
    for (const rig of [small, knight, last]) {
      expect(rig.chosen).not.toContain('small-takes-great');
      expect(rig.widened).toHaveLength(0);
    }
    expect(last.chosen).toEqual(['snap']);
  });

  it('gives way to the next player: turned to a stone, they find the pawn on its square and the hand going home, unpatted', async () => {
    const rig = await board(ROOK);
    await untilDone(rig, 'e4', 'd5');
    rig.stage.setTurn('b');
    rig.stage.consider('b', 'e8');
    await rig.run(3);
    expect(rig.heard.filter((h) => h.what === 'tap')).toHaveLength(0);
    expect(rig.widened).toHaveLength(0);
    expect(off(rig, 'd5')).toBeLessThan(1e-9);
    for (const arm of armsOf(rig.stage.hands.w)) expect(arm.busy).toBe(false);
  });
});

describe('the exchange quickens', { timeout: 240000 }, () => {
  /** Each capture of the exchange, timed; and the same capture timed alone, from a board set up as it then stood. */
  async function exchange(takes: [Square, Square][] = TAKES) {
    const rig = await board(EXCHANGE, true);
    const quick: number[] = [];
    const alone: number[] = [];
    for (const [from, to] of takes) {
      const fresh = await board(rig.game.fen(), true);
      alone.push((await untilDone(fresh, from, to)).seconds);
      quick.push((await untilDone(rig, from, to)).seconds);
      // What is left of it (the taken stone's way to the drawer) is let finish, as against the computer.
      await rig.stage.settled();
      await rig.run(0.5);
      rig.stage.setTurn(rig.game.turn());
    }
    return { rig, quick, alone };
  }

  it('makes each capture on the same square quicker than the one before it, by about a seventh each time, and no quicker after the third', async () => {
    const { rig, quick, alone } = await exchange();
    // The first is a capture like any other.
    expect(quick[0]).toBeCloseTo(alone[0]!, 1);
    for (let i = 1; i < TAKES.length; i++) {
      const pace = 1.15 ** Math.min(i, 3);
      expect(quick[i]! / alone[i]!).toBeGreaterThan(0.9 / pace);
      // (Not all of it is quicker: the fingers close on a stone as fast as they ever do.)
      expect(quick[i]! / alone[i]!).toBeLessThan(1.12 / pace);
    }
    // Every stone stands exactly where it should, and the taken ones are off the board.
    expect(off(rig, 'd5')).toBeLessThan(1e-9);
    expect(rig.layer.puppetAt('d5')!.kind).toBe('r');
    expect([...rig.layer.standing()]).toHaveLength(3);
  });

  it('keeps the hands out of the stones they are not handling, however quick', async () => {
    const rig = await board(EXCHANGE, true);
    for (const [from, to] of TAKES) {
      const e = rig.game.move(from, to);
      const handled = new Set([e.piece.id, e.captured?.id]);
      const others = [...rig.layer.standing()].filter((p) => !handled.has(p.id));
      let done = false;
      let clear = Infinity;
      void rig.stage.playMove(e).then(() => (done = true));
      for (let t = 0; !done && t < 12; t += DT) {
        await rig.run(DT, () => {
          for (const arm of armsOf(rig.stage.hands[e.side])) clear = Math.min(clear, clearOf(arm, others));
        });
      }
      expect(done).toBe(true);
      expect(clear).toBeGreaterThan(0.005);
      await rig.stage.settled();
      await rig.run(0.5);
      rig.stage.setTurn(rig.game.turn());
    }
  });

  it('is a plain capture again once a move is made elsewhere between', async () => {
    const rig = await board(EXCHANGE, true);
    await untilDone(rig, 'e4', 'd5');
    await rig.run(2);
    await untilDone(rig, 'e8', 'e7');
    await rig.run(2);
    await untilDone(rig, 'e1', 'e2');
    await rig.run(2);
    rig.stage.setTurn('b');
    const fresh = await board(rig.game.fen(), true);
    const alone = (await untilDone(fresh, 'f6', 'd5')).seconds;
    const after = (await untilDone(rig, 'f6', 'd5')).seconds;
    expect(after).toBeCloseTo(alone, 1);
  });

  it('is as quick on a screen that comes to the game in the middle of the exchange', async () => {
    const first = await board(EXCHANGE, true);
    for (const [from, to] of TAKES.slice(0, 2)) {
      await untilDone(first, from, to);
      await first.stage.settled();
      await first.run(0.5);
      first.stage.setTurn(first.game.turn());
    }
    const late = await board(EXCHANGE, true);
    for (const [from, to] of TAKES.slice(0, 2)) late.game.move(from, to);
    late.layer.reset(late.game.pieces());
    late.stage.reset();
    late.stage.seatTaken(late.game.history());
    late.stage.setTurn(late.game.turn());
    await late.run(1.5);
    const [from, to] = TAKES[2]!;
    const seen = (await untilDone(first, from, to)).seconds;
    const come = (await untilDone(late, from, to)).seconds;
    expect(come).toBeCloseTo(seen, 1);
    // And quicker than the same capture made alone.
    const alone = (await untilDone(await board(first.game.fen().replace(/^\S+ \S+/, EXCHANGE_AT_THIRD), true), from, to)).seconds;
    expect(come).toBeLessThan(alone * 0.85);
  });

  it('goes back a step with a take-back', async () => {
    const rig = await board(EXCHANGE, true);
    await untilDone(rig, 'e4', 'd5');
    await rig.run(2);
    rig.stage.setTurn('b');
    const first = (await untilDone(rig, 'f6', 'd5')).seconds;
    await rig.run(2);
    const undone = rig.game.undo()!;
    let back = false;
    void rig.stage.playUndo(undone).then(() => (back = true));
    for (let t = 0; !back && t < 12; t += DT) await rig.run(DT);
    await rig.run(1);
    rig.stage.setTurn('b');
    const again = (await untilDone(rig, 'f6', 'd5')).seconds;
    expect(again).toBeCloseTo(first, 1);
  });
});
