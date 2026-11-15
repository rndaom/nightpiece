/**
 * What the hands make of things found in the record of the game, of a mate by what gave it, and of
 * what the player at the screen does to their own hands (docs/manners.md, "Found on the board",
 * "Mate, by what gave it", "Set off by the player"), on the real skeleton and the real stones. Every
 * stone ends exactly on its square; no hand goes into a stone; over the squares the fingers keep
 * above the crowns; and what is part of a move is the same on a screen that comes to the game late.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MoveEvent, Side, Square } from '../src/core/game.ts';
import { PALM_FOCUS } from '../src/hands/hand.ts';
import { CHANCE, draw } from '../src/hands/manners.ts';
import type { Arm } from '../src/hands/puppeteer.ts';
import { FINGERS } from '../src/hands/rig.ts';
import { Shake } from '../src/hands/shake.ts';
import { FIELD_HALF, squareCenter } from '../src/scene/layout.ts';
import { PIECE_HEIGHT } from '../src/scene/pieceShapes.ts';
import type { Puppet } from '../src/scene/pieces.ts';
import { clearOf, DT, handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);
vi.setConfig({ testTimeout: 90000 });

const armsOf = (hands: { right: Arm; left: Arm }) => [hands.right, hands.left];
const UP = new Vector3(0, 1, 0);
const tilt = (puppet: Puppet) => UP.clone().applyQuaternion(puppet.group.quaternion).angleTo(UP);
const pad = new Vector3();
const palm = new Vector3();

function seedWhere(fits: (seed: string) => boolean): string {
  for (let i = 0; i < 200000; i++) if (fits(`seed-${i}`)) return `seed-${i}`;
  throw new Error('no such seed');
}

async function board(seed = 'rig', fen?: string) {
  const rig = handsRig(fen);
  rig.stage.setSeed(seed);
  rig.stage.reset();
  rig.stage.setTurn(rig.game.turn());
  const heard: { what: string; at: Vector3; strength: number; time: number }[] = [];
  let time = 0;
  rig.stage.heard = (what, at, strength) => heard.push({ what, at: at.clone(), strength, time });
  const run = (seconds: number, each?: () => void) =>
    rig.run(seconds, () => {
      time += DT;
      each?.();
    });
  await run(1.5);
  /** Play a move, and go on `after` seconds past the end of all of it; `each` is called every frame. */
  const play = async (from: Square, to: Square, after = 1.2, each?: () => void, promotion?: 'q' | 'n') => {
    const e = rig.game.move(from, to, promotion);
    let done = false;
    void rig.stage
      .playMove(e)
      .then(() => rig.stage.settled())
      .then(() => (done = true));
    for (let t = 0; t < 10 && !done; t += DT) await run(DT, each);
    rig.stage.setTurn(rig.game.status().over ? null : rig.game.turn());
    await run(after, each);
    return e;
  };
  const line = async (moves: string, after = 0.3) => {
    let last: MoveEvent | null = null;
    for (const m of moves.split(' ')) last = await play(m.slice(0, 2) as Square, m.slice(2, 4) as Square, after);
    return last!;
  };
  return { ...rig, run, heard, play, line, now: () => time };
}

/** Every stone that stands is exactly on a square, upright. */
function allSquare(stones: Iterable<Puppet>): void {
  for (const p of stones) {
    expect(p.group.position.x - Math.round(p.group.position.x - 0.5)).toBeCloseTo(0.5, 6);
    expect(p.group.position.z - Math.round(p.group.position.z - 0.5)).toBeCloseTo(0.5, 6);
    expect(p.group.position.y).toBeCloseTo(0, 6);
    expect(tilt(p)).toBeLessThan(1e-6);
  }
}

/** The lowest any fingertip of these arms is, while it is over the squares. */
function lowestOverSquares(arms: Arm[]): number {
  let lowest = Infinity;
  for (const arm of arms) {
    for (const finger of FINGERS) {
      arm.hand.padWorld(finger, pad);
      if (Math.abs(pad.x) < FIELD_HALF && Math.abs(pad.z) < FIELD_HALF) lowest = Math.min(lowest, pad.y);
    }
  }
  return lowest;
}

describe('the Bongcloud', () => {
  it("pats the king stepped up on its side's second move, and turns both of the other side's hands palm up at it", async () => {
    const rig = await board();
    await rig.line('e2e4 e7e5');
    rig.heard.length = 0;
    let turned = 0;
    const e = await rig.play('e1', 'e2', 3.2, () => armsOf(rig.stage.hands.b).forEach((arm) => (turned = Math.min(turned, arm.turn))));
    const king = rig.layer.puppet(e.piece.id)!;
    const taps = rig.heard.filter((h) => h.what === 'tap');
    expect(taps).toHaveLength(1);
    expect(Math.hypot(taps[0]!.at.x - king.group.position.x, taps[0]!.at.z - king.group.position.z)).toBeLessThan(0.3);
    expect(taps[0]!.at.y).toBeGreaterThan(PIECE_HEIGHT.k - 0.2);
    expect(turned).toBeLessThan(-2.4);
    allSquare(rig.layer.standing());
  });

  it('has a thumb up from each player when the other side does the same straight after', async () => {
    const rig = await board();
    await rig.line('e2e4 e7e5 e1e2', 1.5);
    rig.heard.length = 0;
    const rights = [rig.stage.hands.w.right, rig.stage.hands.b.right];
    const rolled = [0, 0];
    const rose = [0, 0];
    let clear = Infinity;
    await rig.play('e8', 'e7', 4.5, () => {
      rights.forEach((arm, i) => {
        rolled[i] = Math.min(rolled[i]!, arm.turn);
        rose[i] = Math.max(rose[i]!, arm.swayed.y);
        clear = Math.min(clear, clearOf(arm, [...rig.layer.standing()]));
      });
    });
    expect(rig.heard.filter((h) => h.what === 'tap')).toHaveLength(1);
    for (const i of [0, 1]) {
      expect(rolled[i]).toBeLessThan(-1.3);
      expect(rose[i]).toBeGreaterThan(0.45);
    }
    expect(clear).toBeGreaterThan(0);
    allSquare(rig.layer.standing());
  });

  it('is nothing in a lesson, or for a king that steps up later in the game', async () => {
    const lesson = await board();
    lesson.stage.setLesson(true);
    await lesson.line('e2e4 e7e5 e1e2', 1.5);
    expect(lesson.heard.filter((h) => h.what === 'tap')).toHaveLength(0);
    const later = await board(seedWhere((s) => [1, 2, 3, 4, 5].every((ply) => draw(s, ply, 'squaring-up') >= CHANCE.seldom && draw(s, ply, 'push') >= CHANCE.often)));
    await later.line('e2e4 e7e5 g1f3 b8c6 e1e2', 1.5);
    expect(later.heard.filter((h) => h.what === 'tap')).toHaveLength(0);
  });
});

describe('the copycat', () => {
  it("waves Ivory's right hand as at a mirror when Void has made its first four moves after it, and Void's a little later", async () => {
    const seed = seedWhere((s) => [1, 2, 3, 4, 5, 6, 7, 8].every((ply) => ['squaring-up', 'push', 'home-again'].every((name) => draw(s, ply, name) >= CHANCE.often)));
    const rig = await board(seed);
    await rig.line('e2e4 e7e5 g1f3 g8f6 b1c3 b8c6 f1c4');
    const rights = { w: rig.stage.hands.w.right, b: rig.stage.hands.b.right };
    const first: Partial<Record<Side, number>> = {};
    const swung: Record<Side, number[]> = { w: [], b: [] };
    await rig.play('f8', 'c5', 4, () => {
      for (const side of ['w', 'b'] as const) {
        const turn = rights[side].turn;
        swung[side].push(turn);
        if (first[side] === undefined && Math.abs(turn) > 0.1) first[side] = rig.now();
      }
    });
    for (const side of ['w', 'b'] as const) {
      // From side to side: both ways, and more than once.
      expect(Math.max(...swung[side])).toBeGreaterThan(0.2);
      expect(Math.min(...swung[side])).toBeLessThan(-0.2);
    }
    // The mirror is late: by about a third of a second.
    expect(first.b! - first.w!).toBeGreaterThan(0.2);
    expect(first.b! - first.w!).toBeLessThan(0.45);
    expect(lowestOverSquares([rights.w, rights.b])).toBe(Infinity);
    allSquare(rig.layer.standing());
  });

  it('is nothing if any of the four was not the same', async () => {
    const rig = await board();
    await rig.line('e2e4 e7e5 g1f3 g8f6 b1c3 b8c6 f1c4');
    let swung = 0;
    await rig.play('f8', 'b4', 3, () => (swung = Math.max(swung, Math.abs(rig.stage.hands.w.right.turn))));
    expect(swung).toBeLessThan(0.1);
  });
});

describe('home again', () => {
  it('flicks the fingers of the hand that sets a knight down where it began, now and then; and the knight stands exactly there', async () => {
    const seed = seedWhere((s) => draw(s, 3, 'home-again') < CHANCE.sometimes && [1, 2, 3].every((ply) => draw(s, ply, 'squaring-up') >= CHANCE.seldom && draw(s, ply, 'push') >= CHANCE.often));
    const rig = await board(seed);
    await rig.line('g1f3 g8f6');
    const arm = rig.stage.hands.w.right;
    let flicked = 0;
    const e = await rig.play('f3', 'g1', 1.5, () => (flicked = Math.min(flicked, arm.tip)));
    expect(flicked).toBeLessThan(-0.15);
    const knight = rig.layer.puppet(e.piece.id)!;
    expect(knight.group.position.distanceTo(squareCenter('g1'))).toBeLessThan(1e-6);
    allSquare(rig.layer.standing());
    // Not for a knight that goes to the other knight's square, or one that has not been away.
    const other = await board(seed);
    await other.line('g1f3 g8f6');
    let tipped = 0;
    await other.play('f3', 'e5', 1.5, () => (tipped = Math.min(tipped, other.stage.hands.w.right.tip)));
    expect(tipped).toBeGreaterThan(-0.1);
  });

  it('is chosen alike by a screen that comes to the game after it', async () => {
    const seed = seedWhere((s) => draw(s, 3, 'home-again') < CHANCE.sometimes && [1, 2, 3].every((ply) => draw(s, ply, 'squaring-up') >= CHANCE.seldom && draw(s, ply, 'push') >= CHANCE.often));
    const saw = await board(seed);
    await saw.line('g1f3 g8f6 f3g1');
    const late = handsRig();
    late.stage.setSeed(seed);
    late.stage.reset();
    for (const m of ['g1f3', 'g8f6', 'f3g1']) late.game.move(m.slice(0, 2) as Square, m.slice(2, 4) as Square);
    late.layer.reset(late.game.pieces());
    late.stage.seatTaken(late.game.history());
    // What the moves have spent of the game's budget is the same on both: neither may square a stone up within twelve plies.
    for (const stage of [saw.stage, late.stage]) expect(stage.manners.has('home-again')).toBe(true);
  });
});

describe('a third queen', () => {
  it("lets the other side's hands go limp for a second when a side with two queens makes another, and then they are as they were", async () => {
    const rig = await board('rig', '4k3/1P6/8/8/8/8/8/QQ2K3 w - - 0 1');
    const arms = armsOf(rig.stage.hands.b);
    let sank = 0;
    await rig.play('b7', 'b8', 3.2, () => arms.forEach((arm) => (sank = Math.min(sank, arm.swayed.y))), 'q');
    expect(sank).toBeLessThan(-0.2);
    expect(rig.layer.puppetAt('b8')!.kind).toBe('q');
    await rig.run(1.5);
    expect(arms.every((arm) => !arm.gesturing && Math.abs(arm.swayed.y) < 0.02)).toBe(true);
    // A second queen is nothing out of the ordinary.
    const second = await board('rig', '4k3/1P6/8/8/8/8/8/Q3K3 w - - 0 1');
    let sunk = 0;
    await second.play('b7', 'b8', 3.2, () => armsOf(second.stage.hands.b).forEach((arm) => (sunk = Math.min(sunk, arm.swayed.y))), 'q');
    expect(sunk).toBeGreaterThan(-0.1);
  });
});

describe('mate, by what gave it', () => {
  const mate = (rig: Awaited<ReturnType<typeof board>>, winner: Side) => rig.stage.over(winner, true, true, { result: 'checkmate' });

  it('pats the knight that smothers a king', async () => {
    const rig = await board('rig', '6rk/6pp/8/6N1/8/8/8/4K3 w - - 0 1');
    const e = await rig.play('g5', 'f7', 2);
    expect(e.status.result).toBe('checkmate');
    const taps = rig.heard.filter((h) => h.what === 'tap');
    expect(taps).toHaveLength(1);
    const at = squareCenter('f7');
    expect(Math.hypot(taps[0]!.at.x - at.x, taps[0]!.at.z - at.z)).toBeLessThan(0.3);
    allSquare(rig.layer.standing());
    // Not a knight's mate on a king that has an empty square beside it.
    const open = await board('rig', '5r1k/6pp/8/6N1/8/8/8/4K2R w - - 0 1');
    const not = await open.play('g5', 'f7', 2);
    expect(not.status.result).not.toBe('checkmate');
    expect(open.heard.filter((h) => h.what === 'tap')).toHaveLength(0);
  });

  it('has a pawn that gives mate hop where it stands, once it is let go', async () => {
    const rig = await board('rig', '6bk/7p/6PK/8/8/8/8/8 w - - 0 1');
    const pawn = rig.layer.puppetAt('g6')!;
    let let_go = false;
    let hopped = 0;
    const e = rig.game.move('g6', 'g7');
    expect(e.status.result).toBe('checkmate');
    void rig.stage.playMove(e, (part, beat) => {
      if (part === 'mover' && beat === 'release') let_go = true;
    });
    await rig.run(5, () => {
      if (let_go) hopped = Math.max(hopped, pawn.group.position.y);
    });
    expect(hopped).toBeGreaterThan(0.06);
    expect(hopped).toBeLessThan(0.12);
    expect(pawn.group.position.distanceTo(squareCenter('g7'))).toBeLessThan(1e-6);
    expect(rig.heard.filter((h) => h.what === 'knock')).toHaveLength(1);
  });

  it("sweeps the winner's hand along the back rank above the crowns of the stones that shut their king in, and then claims the game", async () => {
    const rig = await board('rig', '6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
    await rig.play('a1', 'a8', 0.2);
    expect(mate(rig, 'w')).toBeNull();
    const arms = armsOf(rig.stage.hands.w);
    const stones = [...rig.layer.standing()];
    const rank = squareCenter('e8').z;
    const xs: number[] = [];
    let lowest = Infinity;
    let clear = Infinity;
    await rig.run(4, () => {
      for (const arm of arms) {
        arm.hand.toWorld(PALM_FOCUS, palm);
        if (arm.gesturing && Math.abs(palm.z - rank) < 0.6 && Math.abs(palm.x) < FIELD_HALF) xs.push(palm.x);
        clear = Math.min(clear, clearOf(arm, stones));
      }
      lowest = Math.min(lowest, lowestOverSquares(arms.filter((arm) => arm.gesturing)));
    });
    // From one end of the rank to the other.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(5);
    expect(lowest).toBeGreaterThan(PIECE_HEIGHT.k);
    expect(clear).toBeGreaterThan(0);
    // And then the hands rise, as a winner's do.
    let rose = 0;
    await rig.run(4, () => arms.forEach((arm) => (rose = Math.max(rose, arm.swayed.y))));
    expect(rose).toBeGreaterThan(1);
    // A take-back, and it is all undone.
    rig.stage.resume();
    await rig.run(2);
    expect(arms.every((arm) => Math.abs(arm.swayed.y) < 0.05)).toBe(true);
  });

  it("brushes an early mate off: the winner's hand does not rise over the board to claim it", async () => {
    const rig = await board(seedWhere((s) => [1, 2, 3, 4].every((ply) => draw(s, ply, 'squaring-up') >= CHANCE.seldom && draw(s, ply, 'push') >= CHANCE.often)));
    const e = await rig.line('f2f3 e7e5 g2g4 d8h4');
    expect(e.status.result).toBe('checkmate');
    mate(rig, 'b');
    const arm = rig.stage.hands.b.right;
    const thumb: number[] = [];
    let rose = 0;
    let over = 0;
    await rig.run(6, () => {
      thumb.push(arm.hand.pose[3]!);
      const brushing = arm.steady && arm.gesturing;
      for (const a of armsOf(rig.stage.hands.b)) {
        rose = Math.max(rose, a.swayed.y);
        // Where it rests: not over the squares, though it had just set the queen down there.
        if (brushing && Math.abs(a.hand.toWorld(PALM_FOCUS, palm).z) < FIELD_HALF && Math.abs(palm.x) < FIELD_HALF) over++;
      }
    });
    // The thumb went across the fingertips and back, twice.
    let turns = 0;
    let way = 0;
    for (let i = 1; i < thumb.length; i++) {
      const by = thumb[i]! - thumb[i - 1]!;
      if (Math.abs(by) < 1e-4) continue;
      if (way !== 0 && Math.sign(by) !== way) turns++;
      way = Math.sign(by);
    }
    expect(turns).toBeGreaterThanOrEqual(3);
    expect(rose).toBeLessThan(1);
    expect(over).toBe(0);
    // The loser's hands have sunk as ever.
    expect(rig.stage.hands.w.right.swayed.y).toBeLessThan(-0.4);
  });

  it('bows with both hands, palms up, off the squares', async () => {
    const rig = await board();
    const hands = rig.stage.hands.w;
    let done = false;
    void hands.bow().then(() => (done = true));
    const low = [Infinity, Infinity];
    const turned = [0, 0];
    let over = 0;
    await rig.run(4, () =>
      armsOf(hands).forEach((arm, i) => {
        if (arm.turn < -2.4) low[i] = Math.min(low[i]!, arm.swayed.y);
        turned[i] = Math.min(turned[i]!, arm.turn);
        if (Math.abs(arm.hand.toWorld(PALM_FOCUS, palm).z) < FIELD_HALF && Math.abs(palm.x) < FIELD_HALF) over++;
      }),
    );
    expect(done).toBe(true);
    for (const i of [0, 1]) {
      expect(turned[i]).toBeLessThan(-2.4);
      // Up, and then down: a dip.
      expect(low[i]).toBeLessThan(0.2);
    }
    expect(over).toBe(0);
  });

  it("now and then lays the mated king down, gently, by the winner's hand; and it is stood again if the mate is taken back", async () => {
    // Eighteen plies, so that the mate is not an early one; and a queen's mate off the back rank.
    const shuffle = 'g1f3 g8f6 f3g1 f6g8 b1c3 b8c6 c3b1 c6b8 g1f3 g8f6 f3g1 f6g8 b1a3 b8a6 f2f3 e7e5 g2g4 d8h4';
    const plies = shuffle.split(' ').length;
    const seed = seedWhere((s) => draw(s, plies, 'laid-down') < CHANCE.often && Array.from({ length: plies }, (_, i) => i + 1).every((ply) => draw(s, ply, 'squaring-up') >= CHANCE.seldom && draw(s, ply, 'home-again') >= CHANCE.sometimes));
    const rig = await board(seed);
    const e = await rig.line(shuffle, 0.05);
    expect(e.status.result).toBe('checkmate');
    rig.heard.length = 0;
    mate(rig, 'b');
    const king = [...rig.layer.standing()].find((p) => p.kind === 'k' && p.side === 'w')!;
    const stones = [...rig.layer.standing()].filter((p) => p !== king);
    let clear = Infinity;
    let nearest = Infinity;
    await rig.run(11, () => {
      for (const arm of armsOf(rig.stage.hands.b)) {
        clear = Math.min(clear, clearOf(arm, stones));
        nearest = Math.min(nearest, arm.hand.padWorld('index', pad, true).distanceTo(king.group.position.clone().setY(PIECE_HEIGHT.k)));
      }
    });
    // It lies, or leans on its neighbour: it was a finger of the winner's that did it, and softly.
    expect(tilt(king)).toBeGreaterThan(0.1);
    expect(nearest).toBeLessThan(0.6);
    expect(clear).toBeGreaterThan(0);
    const knocks = rig.heard.filter((h) => h.what === 'knock');
    expect(knocks.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...knocks.map((k) => k.strength))).toBeLessThanOrEqual(0.3);
    // Taken back: the king stands where it stood.
    rig.stage.resume();
    await rig.run(1);
    expect(tilt(king)).toBeLessThan(1e-6);
    expect(king.group.position.distanceTo(squareCenter('e1'))).toBeLessThan(1e-6);
  });

  it('claims a plain mate as it always has, most times', async () => {
    const shuffle = 'g1f3 g8f6 f3g1 f6g8 b1c3 b8c6 c3b1 c6b8 g1f3 g8f6 f3g1 f6g8 b1a3 b8a6 f2f3 e7e5 g2g4 d8h4';
    const plies = shuffle.split(' ').length;
    const rig = await board(seedWhere((s) => draw(s, plies, 'laid-down') >= CHANCE.often));
    await rig.line(shuffle, 0.05);
    mate(rig, 'b');
    const king = [...rig.layer.standing()].find((p) => p.kind === 'k' && p.side === 'w')!;
    let rose = 0;
    await rig.run(11, () => armsOf(rig.stage.hands.b).forEach((arm) => (rose = Math.max(rose, arm.swayed.y))));
    expect(rose).toBeGreaterThan(1.2);
    expect(tilt(king)).toBeLessThan(1e-6);
  });
});

describe('set off by the player', () => {
  /** A camera that looks down the board from behind White, as the Shoulder camera does. */
  const camera = () => {
    const c = new PerspectiveCamera(40, 16 / 9, 0.1, 200);
    c.position.set(0, 9, 13);
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld(true);
    return c;
  };
  /** Where a point in the room is in the picture. */
  const seen = (p: Vector3, c: PerspectiveCamera) => p.clone().project(c);

  it('tells a pointer shaken from side to side from one that only passes, or is shaken slowly', () => {
    const shaken = (xs: number[], step: number) => {
      const shake = new Shake();
      return xs.some((x, i) => shake.feed(x, i * step));
    };
    const toAndFro = [0, 0.03, 0.06, 0.03, 0, 0.03, 0.06, 0.03, 0];
    expect(shaken(toAndFro, 0.05)).toBe(true);
    expect(shaken(toAndFro, 0.4)).toBe(false);
    expect(shaken([0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3], 0.05)).toBe(false);
    // A pointer that only trembles has not been shaken.
    expect(shaken([0, 0.002, 0, 0.002, 0, 0.002, 0, 0.002, 0], 0.05)).toBe(false);
  });

  it("waves back, with its fingers only, when the pointer is shaken over the player's own resting hand; and not again for twenty seconds", async () => {
    const rig = await board();
    const c = camera();
    const arm = rig.stage.hands.w.right;
    const at = () => seen(arm.hand.toWorld(PALM_FOCUS, new Vector3()), c);
    const rested = arm.at.get(new Vector3());
    const fingers = () => arm.hand.pose[5 + 0]!;
    const before = fingers();
    let closed = 0;
    let strayed = 0;
    const watch = () => {
      closed = Math.max(closed, fingers() - before);
      strayed = Math.max(strayed, arm.at.get(palm).distanceTo(rested));
    };
    const shakeOver = async (side: readonly Side[]) => {
      for (let i = 0; i < 16; i++) {
        const p = at();
        rig.stage.pointer(c, p.x + (i % 2 === 0 ? -0.04 : 0.04), p.y, side, false);
        await rig.run(0.05, watch);
      }
    };
    // Shaken over somebody else's hands: nothing.
    await shakeOver(['b']);
    await rig.run(1.5, watch);
    expect(closed).toBeLessThan(0.1);
    await shakeOver(['w']);
    await rig.run(1.5, watch);
    expect(closed).toBeGreaterThan(0.2);
    expect(strayed).toBeLessThan(0.35);
    // Again at once: it has waved, and does not.
    await rig.run(1);
    closed = 0;
    await shakeOver(['w']);
    await rig.run(1.5, watch);
    expect(closed).toBeLessThan(0.1);
    await rig.run(20);
    await shakeOver(['w']);
    await rig.run(1.5, watch);
    expect(closed).toBeGreaterThan(0.2);
  });

  it('sets a weight swinging when it is pressed on, and the hand it hangs from tips to look at it', async () => {
    const rig = await board();
    const c = camera();
    const arm = rig.stage.hands.w.left;
    const weight = seen(arm.hand.weightWorld(), c);
    // A press somewhere else does nothing.
    rig.stage.pointer(c, weight.x + 0.3, weight.y, ['w'], true);
    await rig.run(0.2);
    expect(arm.hand.weightSpeed).toBeLessThan(0.5);
    rig.stage.pointer(c, weight.x, weight.y, ['w'], true);
    let fastest = 0;
    let looked = 0;
    await rig.run(1.2, () => {
      fastest = Math.max(fastest, arm.hand.weightSpeed);
      looked = Math.min(looked, arm.turn);
    });
    expect(fastest).toBeGreaterThan(1.5);
    expect(looked).toBeLessThan(-0.6);
    await rig.run(6);
    expect(arm.gesturing).toBe(false);
    expect(arm.hand.weightSpeed).toBeLessThan(0.3);
  });

  it("starts the player's own hands awake when the page is come back to, and not the other player's, nor once the game is over", async () => {
    const rig = await board();
    const started: Record<Side, number> = { w: 0, b: 0 };
    const watch = () => {
      for (const side of ['w', 'b'] as const) for (const arm of armsOf(rig.stage.hands[side])) started[side] = Math.max(started[side], -arm.swayed.z);
    };
    expect(rig.stage.poke('w', 'back')).toBe(true);
    await rig.run(2.5, watch);
    expect(started.w).toBeGreaterThan(0.08);
    expect(started.w).toBeLessThan(0.3);
    expect(started.b).toBe(0);
    await rig.run(1);
    expect(armsOf(rig.stage.hands.w).every((arm) => !arm.gesturing)).toBe(true);
    rig.stage.setTurn(null);
    expect(rig.stage.poke('w', 'back')).toBe(false);
  });
});
