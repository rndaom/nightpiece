/**
 * The endings the hands play (src/hands/endings.ts, docs/manners.md 5.6 and 5.7), on the real
 * skeleton and the real stones: each is chosen for the way the game ended, both players' hands
 * play it together, none goes into a stone or down among the squares, a hand said to meet another
 * meets it, and a game taken back or begun again stops it, with every hand back at rest.
 */
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrawReason, Side } from '../src/core/game.ts';
import type { Arm } from '../src/hands/puppeteer.ts';
import type { Ended, Heard } from '../src/hands/stage.ts';
import { FINGERS } from '../src/hands/rig.ts';
import { FIELD_HALF } from '../src/scene/layout.ts';
import { PIECE_HEIGHT } from '../src/scene/pieceShapes.ts';
import { clearOf, handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);

const SIDES = ['w', 'b'] as const;
const pad = new Vector3();
const there = new Vector3();
/** A board with a few stones on it, kings and all, as an ending might find it. */
const LATE = '6k1/5p2/8/3q4/8/2N5/5PP1/6K1 w - - 0 60';

type Rig = ReturnType<typeof handsRig>;
const armsOf = (stage: Rig['stage']): Arm[] => SIDES.flatMap((side) => [stage.hands[side].right, stage.hands[side].left]);

/**
 * Play a game's ending through, watching every hand: how near any came to a stone, and how low a
 * fingertip of any hand in the ending came over the middle of the board, where a crown can be.
 */
async function watch(rig: Rig, seconds: number, each?: (t: number) => void) {
  const stones = [...rig.layer.standing()];
  let clear = Infinity;
  let lowest = Infinity;
  let t = 0;
  await rig.run(seconds, () => {
    t += 1 / 60;
    for (const arm of armsOf(rig.stage)) {
      if (arm.hand.dissolve > 0.9) continue;
      clear = Math.min(clear, clearOf(arm, stones));
      // (Once the hands are where the ending has them: on the way there they pass over the stones as in any move.)
      if (!arm.acting || t < 1.5) continue;
      for (const finger of FINGERS) {
        arm.hand.padWorld(finger, pad, true);
        if (Math.abs(pad.x) < FIELD_HALF - 1 && Math.abs(pad.z) < FIELD_HALF - 1) lowest = Math.min(lowest, pad.y);
      }
    }
    each?.(t);
  });
  return { clear, lowest };
}

/** Every hand at rest again: let go of whatever it was set down on, doing nothing, and home. */
function atRest(stage: Rig['stage']) {
  for (const arm of armsOf(stage)) {
    expect(arm.gesturing).toBe(false);
    expect(arm.planted).toBe(false);
    expect(arm.aim).toBeNull();
    expect(arm.hand.touchWeight).toBe(0);
    expect(arm.at.get(there).distanceTo(arm.home)).toBeLessThan(1.4);
  }
}

/** A game that has just ended so; with `seed`, as the manners' chances fall for a board of that name. */
async function ending(how: Ended, winner: Side | null = null, seed?: string, fen = LATE) {
  const rig = handsRig(fen);
  if (seed) {
    rig.stage.setSeed(seed);
    rig.stage.reset();
  }
  const heard: { what: Heard; strength: number; t: number }[] = [];
  let t = 0;
  rig.stage.heard = (what, _, strength) => heard.push({ what, strength, t });
  rig.stage.setTurn('w');
  await rig.run(1.5, () => (t += 1 / 60));
  rig.stage.setTurn(null);
  const name = rig.stage.over(winner, true, false, how);
  return { rig, name, heard, now: () => t };
}

const drawn = (drawReason: DrawReason): Ended => ({ result: 'draw', drawReason, ended: null });

describe('the ending chosen', () => {
  it.each([
    ['stalemate', 'scuffle'],
    ['threefold', 'rock-paper-scissors'],
    ['fivefold', 'rock-paper-scissors'],
    ['fifty-move', 'asleep'],
    ['seventy-five-move', 'asleep'],
    ['insufficient', 'empty-purse'],
    ['agreement', 'handshake'],
  ] as const)('for a draw by %s is %s', async (reason, name) => {
    expect((await ending(drawn(reason))).name).toBe(name);
  });

  it('is the old one, the hands turned up and open, for a draw on time; and none for a mate, or a game only stood again', async () => {
    expect((await ending(drawn('timeout'))).name).toBeNull();
    expect((await ending({ result: 'checkmate' }, 'w')).name).toBeNull();
    const rig = handsRig(LATE);
    expect(rig.stage.over(null, false, false, drawn('stalemate'))).toBeNull();
  });

  it('is time, or gone, when the server ended the game; and nothing of its own for a game given up, whose king is laid down', async () => {
    expect((await ending({ result: 'resigned', ended: 'time' }, 'w')).name).toBe('out-of-time');
    expect((await ending({ result: 'resigned', ended: 'left' }, 'w')).name).toBe('gone');
    expect((await ending({ result: 'resigned', ended: 'noshow' }, 'b')).name).toBe('gone');
    expect((await ending({ result: 'resigned', ended: null }, 'w')).name).toBeNull();
  });
});

describe('each ending, played through', () => {
  // The scuffle and the sleep go differently by chance (who starts, whether a swat misses, which hand wakes): each way is played.
  const seeds = ['s0', 's1', 's2', 's3', 's4', 's5'];
  it.each([
    ...seeds.map((seed) => ['stalemate', 9, seed] as const),
    ['threefold', 9, 's0'],
    ['fivefold', 11, 's0'],
    ...seeds.map((seed) => ['fifty-move', 13, seed] as const),
    ['insufficient', 8, 's0'],
    ['agreement', 9, 's0'],
  ] as const)('a draw by %s: clear of every stone, high over the squares, and every hand at rest after (%i s, %s)', async (reason, seconds, seed) => {
    const { rig } = await ending(drawn(reason), null, seed);
    const { clear, lowest } = await watch(rig, seconds);
    expect(clear).toBeGreaterThan(0);
    expect(lowest).toBeGreaterThan(PIECE_HEIGHT.k + 0.4);
    await rig.run(1.5);
    atRest(rig.stage);
  }, 30000);
});

describe('the scuffle', () => {
  it('has both right hands at it together, by turns, glass on glass; and leaves them turned away from each other', async () => {
    const { rig, heard } = await ending(drawn('stalemate'));
    const [w, b] = SIDES.map((side) => rig.stage.hands[side].right);
    let together = 0;
    let nearest = Infinity;
    await rig.run(8, () => {
      if (w!.acting && b!.acting) together++;
      for (const finger of FINGERS) for (const theirs of FINGERS) nearest = Math.min(nearest, w!.hand.padWorld(finger, pad, true).distanceTo(b!.hand.padWorld(theirs, there, true)));
    });
    expect(together).toBeGreaterThan(60 * 3);
    // Their fingers come near enough to strike each other's.
    expect(nearest).toBeLessThan(0.5);
    expect(heard.filter((h) => h.what === 'chime').length).toBeGreaterThanOrEqual(5);
    // The left hands stayed where they were.
    for (const side of SIDES) expect(rig.stage.hands[side].left.acting).toBe(false);
    await rig.run(2);
    for (const arm of [w!, b!]) expect(arm.turn).toBeGreaterThan(0.2);
  }, 30000);

  it('stops the moment the game is taken back: every hand goes home', async () => {
    for (const cut of [0.5, 1.6, 2.6, 3.4]) {
      const { rig } = await ending(drawn('stalemate'));
      await rig.run(cut);
      rig.stage.resume();
      await rig.run(0.3);
      for (const arm of armsOf(rig.stage)) expect(arm.acting).toBe(false);
      await rig.run(2);
      atRest(rig.stage);
    }
  }, 30000);

  it('is the same on both screens at the same board', async () => {
    const play = async () => {
      const { rig, heard } = await ending(drawn('stalemate'));
      rig.stage.setSeed('room-7');
      rig.stage.reset();
      rig.stage.over(null, true, false, drawn('stalemate'));
      await rig.run(6);
      return heard.map((h) => `${h.what}@${h.t.toFixed(2)}`).join(' ');
    };
    expect(await play()).toBe(await play());
  }, 30000);
});

describe('rock, paper, scissors', () => {
  it('throws three times for a threefold repetition and five for a fivefold, both hands on the same beat', async () => {
    for (const [reason, throws] of [
      ['threefold', 3],
      ['fivefold', 5],
    ] as const) {
      const { rig, heard } = await ending(drawn(reason));
      const [w, b] = SIDES.map((side) => rig.stage.hands[side].right);
      let apart = 0;
      let t = 0;
      // (Once they are there: they set off from where each was at rest, which need not be the same.)
      await rig.run(9, () => {
        t += 1 / 60;
        if (t > 1.6 && w!.acting && b!.acting) apart = Math.max(apart, Math.abs(w!.at.get(pad).y - b!.at.get(there).y));
      });
      expect(heard.filter((h) => h.what === 'chime').length).toBe(throws);
      // They pump together: never more than a hair apart in height.
      expect(apart).toBeLessThan(0.05);
    }
  }, 30000);
});

describe('asleep', () => {
  it('lays all four hands on the rails at once, fingers on the wood, before one starts awake', async () => {
    const { rig } = await ending(drawn('fifty-move'));
    let allDown = 0;
    let woke = false;
    await rig.run(12, () => {
      const arms = armsOf(rig.stage);
      if (arms.every((arm) => arm.planted && arm.hand.touchWeight > 0.99)) allDown++;
      if (allDown > 0 && arms.some((arm) => arm.acting && arm.aim !== null)) woke = true;
    });
    expect(allDown).toBeGreaterThan(60);
    expect(woke).toBe(true);
    await rig.run(2);
    atRest(rig.stage);
  }, 30000);
});

describe('the handshake', () => {
  it('meets palm to palm in the middle of the board, and pumps once: that is what the board rings to', async () => {
    const { rig, heard } = await ending(drawn('agreement'));
    const [w, b] = SIDES.map((side) => rig.stage.hands[side].right);
    let at: number | null = null;
    let apart = Infinity;
    await rig.run(8, () => {
      if (at === null && heard.some((h) => h.what === 'pump')) {
        at = 1;
        apart = w!.hand.toWorld(new Vector3(0, -0.34, -1.25), pad).distanceTo(b!.hand.toWorld(new Vector3(0, -0.34, -1.25), there));
        // In the middle of the board.
        expect(Math.hypot(pad.x, pad.z)).toBeLessThan(0.6);
      }
    });
    expect(heard.filter((h) => h.what === 'pump').length).toBe(1);
    expect(heard.find((h) => h.what === 'pump')!.strength).toBe(1);
    expect(apart).toBeLessThan(0.25);
  }, 30000);

  it('is short if a draw was offered and refused earlier in the game', async () => {
    const rig = handsRig(LATE);
    const heard: { what: Heard; strength: number }[] = [];
    rig.stage.heard = (what, _, strength) => heard.push({ what, strength });
    rig.stage.setTurn('w');
    rig.stage.offer('w');
    await rig.run(2);
    rig.stage.offer(null, 'refused');
    await rig.run(3);
    rig.stage.offer('b');
    await rig.run(1.5);
    rig.stage.setTurn(null);
    expect(rig.stage.over(null, true, false, drawn('agreement'))).toBe('handshake');
    await rig.run(8);
    expect(heard.filter((h) => h.what === 'pump').map((h) => h.strength)).toEqual([0.4]);
  }, 30000);
});

describe('a draw offered', () => {
  it('has the offering side hold its right hand out, palm up, for as long as the offer stands; and close it, little finger first, when it is refused', async () => {
    const rig = handsRig(LATE);
    rig.stage.setTurn('b');
    await rig.run(1);
    rig.stage.offer('w');
    const arm = rig.stage.hands.w.right;
    const stones = [...rig.layer.standing()];
    let clear = Infinity;
    await rig.run(2, () => (clear = Math.min(clear, clearOf(arm, stones))));
    expect(arm.roll.value).toBeLessThan(-2.3);
    await rig.run(6, () => (clear = Math.min(clear, clearOf(arm, stones))));
    // Held out at its own corner, nowhere near a stone.
    expect(clear).toBeGreaterThan(0.3);
    // Still offered, and nothing else has taken the hand.
    expect(arm.roll.value).toBeLessThan(-2.3);
    expect(rig.stage.hands.b.right.roll.value).toBeGreaterThan(-0.5);
    rig.stage.offer(null, 'refused');
    // A beat longer than is comfortable, still open.
    await rig.run(0.6);
    expect(arm.roll.value).toBeLessThan(-2.3);
    await rig.run(1.0);
    const shut = (finger: 'little' | 'index') => arm.hand.pose[['thumb', 'index', 'middle', 'ring', 'little'].indexOf(finger) * 5]!;
    expect(shut('little')).toBeGreaterThan(shut('index'));
    await rig.run(3);
    expect(arm.roll.value).toBeGreaterThan(-0.5);
    expect(arm.gesturing).toBe(false);
  }, 30000);

  it('is let go at once when the hand has a move to make', async () => {
    const rig = handsRig();
    rig.stage.setTurn('w');
    rig.stage.offer('w');
    await rig.run(2);
    const e = rig.game.move('g1', 'f3');
    const played = rig.stage.playMove(e);
    await rig.run(4);
    await played;
    expect(rig.stage.hands.w.right.roll.value).toBeGreaterThan(-0.5);
  }, 30000);
});

describe('time, and gone', () => {
  it("stops the loser's hands where they are, holds them, and lets them drop", async () => {
    const { rig } = await ending({ result: 'resigned', ended: 'time' }, 'w');
    const arm = rig.stage.hands.b.right;
    const from = arm.at.get(new Vector3());
    await rig.run(0.5);
    expect(arm.at.get(pad).distanceTo(from)).toBeLessThan(0.05);
    await rig.run(1.5);
    expect(arm.at.get(pad).y).toBeLessThan(from.y - 0.15);
    await rig.run(3);
    expect(arm.presence).toBeLessThan(0.3);
  }, 30000);

  it('unmakes the hands of the player who has gone, and the other waves; a new game has them all back', async () => {
    const { rig } = await ending({ result: 'resigned', ended: 'left' }, 'w');
    const left = rig.stage.hands.w.left;
    let waved = false;
    await rig.run(7, () => (waved ||= left.acting && left.aim !== null));
    for (const arm of [rig.stage.hands.b.right, rig.stage.hands.b.left]) expect(arm.hand.dissolve).toBeGreaterThan(0.99);
    expect(waved).toBe(true);
    rig.stage.reset();
    for (const arm of armsOf(rig.stage)) expect(arm.hand.dissolve).toBe(0);
  }, 30000);
});
