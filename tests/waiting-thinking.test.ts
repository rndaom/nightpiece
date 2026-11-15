/**
 * What the hands do while they wait and while their player thinks (docs/manners.md, "Sitting
 * down", "Thinking", "Waiting"), on the real skeleton and the real stones: knuckles cracked, the
 * wrist looked at, the hand that lies down on the rail and sleeps, the candle, the captive held
 * up, the finger wagged at a stone left for another, the stone set straight, and the computer's
 * feint. None of it touches a stone it is not said to; none of it is over the squares unless its
 * player is thinking there; and a move, or a thought, ends it at once.
 */
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Side, Square } from '../src/core/game.ts';
import { CHANCE, draw } from '../src/hands/manners.ts';
import type { Arm } from '../src/hands/puppeteer.ts';
import type { FingerName } from '../src/hands/rig.ts';
import { PALM_FOCUS } from '../src/hands/hand.ts';
import { FIELD_HALF, PLINTH_TOP, RIM_TOP, SLAB_HALF, squareCenter } from '../src/scene/layout.ts';
import { clearOf, DT, handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);
vi.setConfig({ testTimeout: 60000 });

const DRUMMERS: FingerName[] = ['little', 'ring', 'middle', 'index'];
const armsOf = (hands: { right: Arm; left: Arm }) => [hands.right, hands.left];
const pad = new Vector3();
const palm = new Vector3();
/** The tallest candle at each corner of the board, as the room has them. */
const FLAMES = [
  [-5.62, -5.62],
  [5.62, -5.62],
  [-5.62, 5.62],
  [5.62, 5.62],
].map(([x, z]) => new Vector3(x, 0.425, z));

/** The first seed, counting up, that `fits`. */
function seedWhere(fits: (seed: string) => boolean): string {
  for (let i = 0; i < 200000; i++) if (fits(`seed-${i}`)) return `seed-${i}`;
  throw new Error('no such seed');
}
/** A seed with which, at `ply`, the row `name` comes up and none of `not` does. */
const seedFor = (name: string, ply: number, chance: number, not: string[] = []) => seedWhere((seed) => draw(seed, ply, name) < chance && not.every((other) => draw(seed, ply, other) >= CHANCE.often));

/** A board, its manners drawn from `seed`, the hands at rest, and what they do that is heard written down. */
async function board(seed = 'rig', fen?: string, turn: Side | 'game' = 'game') {
  const rig = handsRig(fen);
  rig.stage.setSeed(seed);
  rig.stage.reset();
  rig.stage.setTurn(turn === 'game' ? rig.game.turn() : turn);
  const heard: { what: string; at: Vector3; strength: number; time: number }[] = [];
  let time = 0;
  rig.stage.heard = (what, at, strength) => heard.push({ what, at: at.clone(), strength, time });
  const run = (seconds: number, each?: () => void) =>
    rig.run(seconds, () => {
      time += DT;
      each?.();
    });
  await run(1.5);
  const play = async (from: Square, to: Square, after = 2.5) => {
    const e = rig.game.move(from, to);
    let done = false;
    void rig.stage.playMove(e).then(() => (done = true));
    for (let t = 0; t < 8 && !done; t += DT) await run(DT);
    rig.stage.setTurn(rig.game.status().over ? null : rig.game.turn());
    await run(after);
    return e;
  };
  return { ...rig, run, heard, play, now: () => time };
}

/** Whether a point is over the squares of the board. */
const overSquares = (p: Vector3) => Math.abs(p.x) < FIELD_HALF && Math.abs(p.z) < FIELD_HALF;

describe('knuckles', () => {
  it("brings Ivory's hands together before the first move, and presses them until they crack: three to five times, not evenly", async () => {
    const seed = seedWhere((s) => draw(s, 0, 'knuckles') < CHANCE.often && draw(s, 0, 'knuckles, answered') >= 0.25);
    const rig = await board(seed);
    const stones = [...rig.layer.standing()];
    rig.stage.appear();
    let together = 0;
    let clear = Infinity;
    let over = 0;
    await rig.run(11, () => {
      const hands = rig.stage.hands.w;
      if (hands.right.planted && hands.left.planted) together++;
      for (const arm of armsOf(hands)) {
        clear = Math.min(clear, clearOf(arm, stones));
        if (arm.gesturing && overSquares(arm.hand.toWorld(PALM_FOCUS, palm))) over++;
      }
    });
    const cracks = rig.heard.filter((h) => h.what === 'crack');
    expect(cracks.length).toBeGreaterThanOrEqual(3);
    expect(cracks.length).toBeLessThanOrEqual(5);
    // Not evenly, and each a little less than the one before.
    const gaps = cracks.slice(1).map((c, i) => c.time - cracks[i]!.time);
    expect(Math.min(...gaps)).toBeGreaterThan(0.03);
    expect(Math.max(...gaps)).toBeLessThan(0.2);
    expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBeGreaterThan(1);
    expect(cracks.at(-1)!.strength).toBeLessThan(cracks[0]!.strength);
    // The fingertips were on each other; no stone was touched; and none of it was over the squares.
    expect(together).toBeGreaterThan(30);
    expect(clear).toBeGreaterThan(0);
    expect(over).toBe(0);
    // And they have gone home: Void's hands did nothing about it.
    expect(armsOf(rig.stage.hands.w).some((arm) => arm.gesturing)).toBe(false);
    expect(cracks.every((c) => c.at.z > 0)).toBe(true);
  });

  it("is answered by Void, one time in four: one crack, late and small, from a hand that has not left its corner", async () => {
    const seed = seedWhere((s) => draw(s, 0, 'knuckles') < CHANCE.often && draw(s, 0, 'knuckles, answered') < 0.25);
    const rig = await board(seed);
    rig.stage.appear();
    const home = rig.stage.hands.b.right.at.get(new Vector3());
    let strayed = 0;
    await rig.run(11, () => (strayed = Math.max(strayed, rig.stage.hands.b.right.at.get(palm).distanceTo(home))));
    const cracks = rig.heard.filter((h) => h.what === 'crack');
    const void_ = cracks.filter((c) => c.at.z < 0);
    expect(void_).toHaveLength(1);
    expect(void_[0]!.time).toBeGreaterThan(Math.max(...cracks.filter((c) => c.at.z > 0).map((c) => c.time)));
    expect(void_[0]!.strength).toBeLessThan(0.5);
    expect(strayed).toBeLessThan(0.5);
  });

  it('is not made in most games, never after a move has been made, and gives way at once to a stone chosen', async () => {
    const quiet = await board(seedWhere((s) => draw(s, 0, 'knuckles') >= CHANCE.often));
    quiet.stage.appear();
    await quiet.run(9);
    expect(quiet.heard.filter((h) => h.what === 'crack')).toHaveLength(0);

    const seed = seedWhere((s) => draw(s, 0, 'knuckles') < CHANCE.often);
    const late = await board(seed);
    late.stage.appear();
    await late.play('e2', 'e4', 6);
    expect(late.heard.filter((h) => h.what === 'crack')).toHaveLength(0);

    const cut = await board(seed);
    cut.stage.appear();
    await cut.run(3.2);
    expect(armsOf(cut.stage.hands.w).every((arm) => arm.gesturing)).toBe(true);
    cut.stage.consider('w', 'e2');
    await cut.run(0.3);
    expect(armsOf(cut.stage.hands.w).some((arm) => arm.planted)).toBe(false);
    expect(cut.stage.hands.w.right.considering).not.toBeNull();
    await cut.run(6);
    expect(cut.heard.filter((h) => h.what === 'crack')).toHaveLength(0);
  });
});

describe('the ladder of impatience', () => {
  it('turns a wrist over to look at the cord, off the squares, and turns it back', async () => {
    const rig = await board('rig', undefined, 'b');
    const hands = rig.stage.hands.w;
    hands.lookAtCord();
    let turned = 0;
    let over = 0;
    let clear = Infinity;
    const stones = [...rig.layer.standing()];
    await rig.run(4.6, () => {
      for (const arm of armsOf(hands)) {
        turned = Math.min(turned, arm.turn);
        clear = Math.min(clear, clearOf(arm, stones));
        if (overSquares(arm.hand.toWorld(PALM_FOCUS, palm))) over++;
      }
    });
    expect(turned).toBeLessThan(-1.7);
    expect(over).toBe(0);
    expect(clear).toBeGreaterThan(0);
    await rig.run(1.5);
    expect(armsOf(hands).every((arm) => !arm.gesturing && Math.abs(arm.turn) < 0.02)).toBe(true);
  });

  it('lies down on the rail and taps one finger every two seconds; then sleeps; and starts awake when the move comes', async () => {
    const rig = await board('rig', undefined, 'w');
    const hands = rig.stage.hands.b;
    let asleep = false;
    const taps: number[] = [];
    hands.lieOnRail(() => taps.push(rig.now()), () => asleep);
    let lowest = Infinity;
    const watch = () => {
      for (const arm of armsOf(hands)) {
        for (const finger of DRUMMERS) {
          arm.hand.padWorld(finger, pad);
          if (Math.abs(pad.x) < SLAB_HALF && Math.abs(pad.z) < SLAB_HALF) lowest = Math.min(lowest, pad.y);
        }
      }
    };
    await rig.run(12, watch);
    const arm = armsOf(hands).find((a) => a.planted)!;
    expect(arm).toBeDefined();
    // One finger, about every two seconds.
    const lone = taps;
    expect(lone.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < lone.length; i++) expect(lone[i]! - lone[i - 1]!).toBeCloseTo(2, 0);
    // On the rail at Void's own end, and never down in the wood.
    for (const finger of DRUMMERS) {
      arm.hand.padWorld(finger, pad);
      expect(-pad.z).toBeGreaterThan(FIELD_HALF);
      expect(-pad.z).toBeLessThan(SLAB_HALF);
    }
    expect(lowest).toBeGreaterThan(RIM_TOP - 0.04);

    // Asleep: nothing more is heard, but it still lies there, and a finger stirs.
    asleep = true;
    await rig.run(3);
    const heardBy = taps.length;
    let stirred = 0;
    const lain = DRUMMERS.map((finger) => arm.hand.touch[finger]!.y);
    await rig.run(9, () => {
      watch();
      DRUMMERS.forEach((finger, i) => (stirred = Math.max(stirred, arm.hand.touch[finger]!.y - lain[i]!)));
    });
    expect(taps.length).toBe(heardBy);
    expect(arm.planted).toBe(true);
    expect(stirred).toBeGreaterThan(0.02);
    expect(stirred).toBeLessThan(0.1);

    // The move comes: it has let go of the wood at once, starts back a little, and is at rest again.
    const e = rig.game.move('e2', 'e4');
    void rig.stage.playMove(e);
    let started = 0;
    await rig.run(0.4, () => (started = Math.max(started, -arm.swayed.z)));
    expect(arm.planted).toBe(false);
    expect(started).toBeGreaterThan(0.05);
    expect(started).toBeLessThan(0.3);
    await rig.run(3);
    expect(arm.gesturing).toBe(false);
  });

  it('goes no higher than drumming on the rail in a game against a clock', async () => {
    const seed = seedWhere((s) => draw(s, 0, 'look-at-the-cord') < CHANCE.often && draw(s, 0, 'lie-on-the-rail') < CHANCE.often && draw(s, 0, 'drum-on-the-rail') >= CHANCE.seldom);
    for (const timed of [false, true]) {
      const rig = await board(seed, undefined, 'w');
      rig.stage.setTimed(timed);
      let rolled = 0;
      let planted = 0;
      await rig.run(95, () => {
        for (const arm of armsOf(rig.stage.hands.b)) {
          rolled = Math.min(rolled, arm.turn);
          if (arm.planted) planted++;
        }
      });
      // Without a clock, one rung of it was climbed: the wrist looked at, or the hand laid down.
      expect(rolled < -1.7 || planted > 0).toBe(!timed);
    }
  });
});

describe('the candle', () => {
  it('warms a hand at its flame, lets it down too far, snatches it back, and has it rest higher for the rest of the game', async () => {
    const rig = await board('rig', undefined, 'b');
    rig.stage.setCandles(FLAMES);
    const hands = rig.stage.hands.w;
    const flame = FLAMES[3]!;
    const arm = hands.right;
    const rested = arm.at.get(new Vector3()).y;
    const burned: number[] = [];
    hands.warm(flame, () => burned.push(rig.now()));
    let nearest = Infinity;
    let lowest = Infinity;
    let highest = -Infinity;
    let lowestAt = 0;
    let shaken = 0;
    const stones = [...rig.layer.standing()];
    let clear = Infinity;
    await rig.run(8, () => {
      arm.hand.toWorld(PALM_FOCUS, palm);
      nearest = Math.min(nearest, Math.hypot(palm.x - flame.x, palm.z - flame.z));
      if (palm.y < lowest) [lowest, lowestAt] = [palm.y, rig.now()];
      if (burned.length > 0) {
        highest = Math.max(highest, palm.y);
        shaken = Math.max(shaken, Math.abs(arm.turn));
      }
      clear = Math.min(clear, clearOf(arm, stones));
    });
    // Over the flame, and down toward it: but never into it.
    expect(nearest).toBeLessThan(0.25);
    expect(lowest).toBeLessThan(flame.y + 0.75);
    expect(lowest).toBeGreaterThan(flame.y + 0.3);
    // Burned once, at its lowest; then up and away, and shaken out.
    expect(burned).toHaveLength(1);
    expect(Math.abs(burned[0]! - lowestAt)).toBeLessThan(0.25);
    expect(highest).toBeGreaterThan(lowest + 0.6);
    expect(shaken).toBeGreaterThan(0.25);
    expect(clear).toBeGreaterThan(0);
    // At rest again, a hand's breadth higher than it was; and so it stays.
    await rig.run(3);
    expect(arm.gesturing).toBe(false);
    expect(arm.at.get(palm).y - rested).toBeGreaterThan(0.3);
    expect(arm.at.get(palm).y - rested).toBeLessThan(0.6);
    await rig.play('e2', 'e4');
    expect(arm.at.get(palm).y - rested).toBeGreaterThan(0.2);
    // A new game, and it has forgotten.
    rig.stage.reset();
    await rig.run(2.5);
    expect(Math.abs(arm.at.get(palm).y - rested)).toBeLessThan(0.2);
  });

  it('is chosen seldom, only where a candle burns, and not twice at the same candle in a game', async () => {
    const seed = seedFor('candle', 0, CHANCE.seldom, ['look-at-the-cord', 'lie-on-the-rail', 'drum-on-the-rail', 'captives']);
    const without = await board(seed, undefined, 'b');
    let rose = 0;
    await without.run(40, () => armsOf(without.stage.hands.w).forEach((arm) => (rose = Math.max(rose, arm.wary))));
    expect(rose).toBe(0);

    const rig = await board(seed, undefined, 'b');
    rig.stage.setCandles(FLAMES);
    await rig.run(40);
    const wary = armsOf(rig.stage.hands.w).filter((arm) => arm.wary > 0);
    expect(wary).toHaveLength(1);
    expect(rig.heard.filter((h) => h.what === 'burn')).toHaveLength(1);
  });
});

describe('captives', () => {
  it('takes the greatest stone it has taken up from the drawer, holds it up, and stands it back exactly where it stood', async () => {
    // White takes a knight; Black is then left to think, and White's hand has time on it.
    const rig = await board('rig', 'rnbqkb1r/pppppppp/8/8/4n3/3P4/PPP1PPPP/RNBQKBNR w KQkq - 0 1');
    const e = await rig.play('d3', 'e4', 4);
    const seed = seedFor('captives', 1, CHANCE.seldom, ['drum-on-the-rail', 'candle']);
    rig.stage.setSeed(seed);
    // (The seed is taken up by the next game: this one is told it as a game joined part of the way through.)
    rig.stage.reset();
    rig.layer.reset(rig.game.pieces());
    rig.stage.seatTaken(rig.game.history());
    rig.stage.setTurn('b');
    await rig.run(1);
    const captive = rig.layer.puppet(e.captured!.id)!;
    const at = captive.group.position.clone();
    expect(at.y).toBeCloseTo(PLINTH_TOP, 5);
    const others = [...rig.layer.standing(), ...rig.layer.taken()].filter((p) => p !== captive);
    let highest = 0;
    let clear = Infinity;
    let winced = 0;
    await rig.run(30, () => {
      highest = Math.max(highest, captive.group.position.y - at.y);
      for (const arm of armsOf(rig.stage.hands.w)) clear = Math.min(clear, clearOf(arm, others));
      for (const arm of armsOf(rig.stage.hands.b)) winced = Math.max(winced, arm.tip);
    });
    expect(highest).toBeGreaterThan(0.6);
    expect(captive.group.position.distanceTo(at)).toBeLessThan(1e-6);
    expect(Math.hypot(captive.group.rotation.x, captive.group.rotation.z)).toBeLessThan(1e-6);
    expect(clear).toBeGreaterThan(0);
    // Across the board, the hands that lost it felt it.
    expect(winced).toBeGreaterThan(0.05);
    // And the game goes on as ever.
    await rig.play('e7', 'e5');
    expect(rig.layer.puppetAt('e5')).not.toBeNull();
  });
});

describe('second thought', () => {
  it('wags a finger at a stone that was thought about a while and then left for another, and not at one only passed over', async () => {
    const rig = await board();
    const hands = rig.stage.hands.w;
    // Passed over: nothing.
    rig.stage.consider('w', 'b1');
    await rig.run(0.6);
    rig.stage.consider('w', 'g1');
    let wagged = 0;
    await rig.run(0.6, () => armsOf(hands).forEach((arm) => (wagged = Math.max(wagged, Math.abs(arm.hand.wagged)))));
    expect(wagged).toBe(0);
    // Thought about, and left for one on the other side of the board: the hand that leaves wags.
    await rig.run(1.2);
    rig.stage.consider('w', 'b1');
    const leaving = hands.right;
    let one = 0;
    let other = 0;
    await rig.run(0.6, () => {
      one = Math.max(one, leaving.hand.wagged);
      other = Math.min(other, leaving.hand.wagged);
    });
    // Once each way, about five degrees.
    expect(one).toBeGreaterThan(0.05);
    expect(one).toBeLessThan(0.12);
    expect(other).toBeLessThan(-0.05);
    expect(leaving.hand.wagged).toBe(0);
    // Not again for a while, however long the next is looked at.
    await rig.run(1.8);
    rig.stage.consider('w', 'g1');
    wagged = 0;
    await rig.run(0.6, () => armsOf(hands).forEach((arm) => (wagged = Math.max(wagged, Math.abs(arm.hand.wagged)))));
    expect(wagged).toBe(0);
    // And the hand has gone on doing what it was asked all the while.
    expect(hands.right.considering?.puppet).toBe(rig.layer.puppetAt('g1'));
  });
});

describe("j'adoube", () => {
  it('sets a stone straight when it is turned to a third time in one turn: the hand comes down to it, it turns and turns back, and stands exactly as it stood', async () => {
    const rig = await board();
    const stone = rig.layer.puppetAt('g1')!;
    const facing = stone.group.rotation.y;
    const at = stone.group.position.clone();
    for (let i = 0; i < 2; i++) {
      rig.stage.consider('w', 'g1');
      await rig.run(0.6);
      rig.stage.consider('w', null);
      await rig.run(0.4);
    }
    expect(rig.heard.filter((h) => h.what === 'tap')).toHaveLength(0);
    rig.stage.consider('w', 'g1');
    const arm = rig.stage.hands.w.right;
    let dipped = 0;
    let turned = 0;
    let clear = Infinity;
    await rig.run(1.6, () => {
      dipped = Math.max(dipped, arm.dip);
      turned = Math.max(turned, Math.abs(stone.group.rotation.y - facing));
      clear = Math.min(clear, clearOf(arm, [...rig.layer.standing()]));
    });
    expect(dipped).toBeGreaterThan(0.25);
    expect(arm.dip).toBe(0);
    expect(turned).toBeGreaterThan(0.05);
    expect(turned).toBeLessThan(0.12);
    expect(stone.group.rotation.y).toBe(facing);
    expect(stone.group.position.distanceTo(at)).toBe(0);
    expect(clear).toBeGreaterThan(0);
    const taps = rig.heard.filter((h) => h.what === 'tap');
    expect(taps).toHaveLength(1);
    expect(Math.hypot(taps[0]!.at.x - at.x, taps[0]!.at.z - at.z)).toBeLessThan(0.3);
    // Still in thought over it, and a fourth time is nothing new this turn.
    expect(arm.considering?.puppet).toBe(stone);
    rig.stage.consider('w', null);
    await rig.run(0.4);
    rig.stage.consider('w', 'g1');
    await rig.run(1.6);
    expect(rig.heard.filter((h) => h.what === 'tap')).toHaveLength(1);
  });

  it('leaves a stone that is moved in the middle of it exactly on its new square', async () => {
    const rig = await board();
    for (let i = 0; i < 2; i++) {
      rig.stage.consider('w', 'g1');
      await rig.run(0.6);
      rig.stage.consider('w', null);
      await rig.run(0.4);
    }
    rig.stage.consider('w', 'g1');
    await rig.run(0.8);
    const e = await rig.play('g1', 'f3');
    const stone = rig.layer.puppet(e.piece.id)!;
    expect(stone.group.position.distanceTo(squareCenter('f3'))).toBeLessThan(1e-6);
    expect(stone.group.rotation.y).toBeCloseTo(0, 6);
  });
});

describe('the feint', () => {
  const others: Square[] = ['b8', 'g8', 'a7', 'b7', 'c7', 'd7', 'f7', 'g7', 'h7'];

  it("sends the computer's hand to another stone first, has it begin to close, and think better of it: and no stone is touched", async () => {
    const seed = seedWhere((s) => draw(s, 1, 'feint') < CHANCE.sometimes);
    const rig = await board(seed);
    await rig.play('e2', 'e4');
    const before = [...rig.layer.standing()].map((p) => ({ p, at: p.group.position.clone(), turn: p.group.rotation.y }));
    const hands = rig.stage.hands.b;
    let done = false;
    const began = rig.now();
    void rig.stage.feint('b', 'e7', others).then(() => (done = true));
    const over = new Set<unknown>();
    let clear = Infinity;
    let dipped = 0;
    for (let t = 0; t < 4 && !done; t += DT) {
      await rig.run(DT, () => {
        for (const arm of armsOf(hands)) {
          if (arm.considering) over.add(arm.considering.puppet);
          dipped = Math.max(dipped, arm.dip);
          clear = Math.min(clear, clearOf(arm, [...rig.layer.standing()]));
        }
      });
    }
    expect(done).toBe(true);
    // About a second, over one stone, which is not the one it means to move.
    expect(rig.now() - began).toBeGreaterThan(0.7);
    expect(rig.now() - began).toBeLessThan(1.3);
    expect(over.size).toBe(1);
    expect(over.has(rig.layer.puppetAt('e7'))).toBe(false);
    expect([...over][0]).toMatchObject({ side: 'b' });
    expect(dipped).toBeGreaterThan(0.05);
    expect(clear).toBeGreaterThan(0);
    for (const { p, at, turn } of before) {
      expect(p.group.position.distanceTo(at)).toBe(0);
      expect(p.group.rotation.y).toBe(turn);
    }
    // And then it goes to the one it means, and moves it.
    rig.stage.consider('b', 'e7');
    await rig.run(0.6);
    await rig.play('e7', 'e5');
    expect(rig.layer.puppetAt('e5')).not.toBeNull();
  });

  it('is not made in a lesson, in a game between two people, when no other stone could move, or when its chance does not come up', async () => {
    const seed = seedWhere((s) => draw(s, 1, 'feint') < CHANCE.sometimes);
    const never = async (set: (rig: Awaited<ReturnType<typeof board>>) => void, could = others, with_ = seed) => {
      const rig = await board(with_);
      set(rig);
      await rig.play('e2', 'e4');
      const began = rig.now();
      let done = false;
      void rig.stage.feint('b', 'e7', could).then(() => (done = true));
      await rig.run(0.1);
      expect(done).toBe(true);
      expect(rig.now() - began).toBeLessThan(0.2);
      expect(armsOf(rig.stage.hands.b).some((arm) => arm.considering)).toBe(false);
    };
    await never((rig) => rig.stage.setLesson(true));
    await never((rig) => rig.stage.setPlain(true));
    await never(() => undefined, ['e7']);
    await never(() => undefined, others, seedWhere((s) => draw(s, 1, 'feint') >= CHANCE.sometimes));
  });
});
