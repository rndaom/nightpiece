/**
 * How a stone is set down, when it is set down in a way of its own (docs/manners.md, "How a piece is
 * set down", and "It wears off"), on the real skeleton and the real stones: the pawn rapped on the
 * empty square it takes in passing on, the snap that makes a pawn into something, the hand turned
 * over at a pawn made into less than a queen, a queen held up, the king patted, the pawn pushed,
 * the stone squared up, and checks that are made less of each time. Every stone ends exactly on
 * its square; no hand goes into a stone it is not handling; and what is played on the other
 * player's turn is played off the squares or stopped by them at once.
 */
import { type SkinnedMesh, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MoveEvent, PromotionKind, Side, Square } from '../src/core/game.ts';
import { Girth } from '../src/hands/girth.ts';
import { CHANCE, draw } from '../src/hands/manners.ts';
import type { Arm } from '../src/hands/puppeteer.ts';
import { squareCenter } from '../src/scene/layout.ts';
import { PIECE_HEIGHT } from '../src/scene/pieceShapes.ts';
import type { Puppet } from '../src/scene/pieces.ts';
import { clearOf, DT, handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PASSANT = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
const PROMOTION = '4k3/1P6/8/8/8/8/6p1/4K3 w - - 0 1';
const CASTLE = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4';
const LONG = 'r3kbnr/ppp1pppp/2nqb3/3p4/3P4/2NQB3/PPP1PPPP/R3KBNR w KQkq - 0 5';
/** Two queens face to face on the d-file, and a rook behind one of them to take back with. */
const QUEENS = '3rk3/8/8/3q4/8/8/8/3QK3 w - - 0 1';
/** A queen that can check a king on the h-file from the a-file, rank after rank, as it backs down the board. */
const LADDER = '7k/8/8/8/8/8/8/Q3K3 w - - 0 1';

const armsOf = (hands: { right: Arm; left: Arm }) => [hands.right, hands.left];

/** The first seed, counting up, for which `fits` is true at the first ply of a game. */
function seedWhere(fits: (seed: string) => boolean): string {
  for (let i = 0; i < 100000; i++) if (fits(`seed-${i}`)) return `seed-${i}`;
  throw new Error('no such seed');
}
const comes = (seed: string, name: string, chance: number) => draw(seed, 1, name) < chance;

/** A board set up as `fen`, its manners' chances drawn from `seed`, and the hands come to rest. */
async function board(fen: string, seed = 'rig') {
  const rig = handsRig(fen);
  rig.stage.setSeed(seed);
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
  return { ...rig, run, heard, now: () => time };
}

/** Where a stone should stand on a square, and how far it is from that, and from upright facing its opponent. */
function offSquare(puppet: Puppet, square: Square): { by: number; turned: number } {
  const at = squareCenter(square);
  const facing = puppet.side === 'w' ? 0 : Math.PI;
  return {
    by: Math.hypot(puppet.group.position.x - at.x, puppet.group.position.y - at.y, puppet.group.position.z - at.z),
    turned: Math.abs(Math.atan2(Math.sin(puppet.group.rotation.y - facing), Math.cos(puppet.group.rotation.y - facing))) + Math.hypot(puppet.group.rotation.x, puppet.group.rotation.z),
  };
}

/**
 * Play a move with the hands, and watch it until `after` seconds past the end of all of it, what is
 * left of it once its stones are down among it (`Stage.settled`): how near any of the mover's hands
 * comes to a stone other than those it handles (until a second past that end, while they are on
 * their way home), and the beats of each part. `done` is whether the move itself was done with.
 */
async function play(rig: Awaited<ReturnType<typeof board>>, from: Square, to: Square, promotion?: PromotionKind, each?: (e: MoveEvent) => void, after = 1) {
  const e = rig.game.move(from, to, promotion);
  const handled = new Set([e.piece.id, e.captured?.id, e.rook?.id]);
  const others = [...rig.layer.standing()].filter((p) => !handled.has(p.id));
  const beats: { part: string; beat: string; time: number }[] = [];
  let done = false;
  let settled = false;
  let clear = Infinity;
  void rig.stage
    .playMove(e, (part, beat) => beats.push({ part, beat, time: rig.now() }))
    .then(() => (done = true))
    .then(() => rig.stage.settled())
    .then(() => (settled = true));
  let since = 0;
  for (let t = 0; t < 12 && since < after; t += DT) {
    await rig.run(DT, () => {
      if (since < 1) for (const arm of armsOf(rig.stage.hands[e.side])) clear = Math.min(clear, clearOf(arm, others));
      each?.(e);
    });
    if (settled) since += DT;
  }
  const when = (part: string, beat: string) => beats.find((b) => b.part === part && b.beat === beat)?.time ?? NaN;
  return { e, done, clear, beats, when };
}

describe('the empty square', { timeout: 60000 }, () => {
  it('brings the pawn over the square it takes in passing on, raps it there once, and sets it down; only then is the taken pawn lifted away', async () => {
    const rig = await board(PASSANT);
    const mover = rig.layer.puppetAt('e5')!;
    const target = squareCenter('f6');
    let hung = 0;
    let lowest = Infinity;
    const { e, done, clear, when } = await play(rig, 'e5', 'f6', undefined, () => {
      const p = mover.group.position;
      if (Math.hypot(p.x - target.x, p.z - target.z) > 0.05) return;
      // Over the square, still in the hand, its foot off the board.
      if (p.y > 0.2) hung++;
      lowest = Math.min(lowest, p.y);
    });
    expect(done).toBe(true);
    expect(hung * DT).toBeGreaterThan(0.25);
    const rapped = rig.heard.filter((h) => h.what === 'knock');
    expect(rapped).toHaveLength(1);
    expect(rapped[0]!.at.distanceTo(target)).toBeLessThan(1e-6);
    expect(rapped[0]!.time).toBeLessThan(when('mover', 'set'));
    expect(lowest).toBeLessThan(0.06);
    // The other hand comes for the taken pawn once the pawn that took it has been let go.
    expect(when('victim', 'close')).toBeGreaterThan(when('mover', 'release'));
    expect(offSquare(mover, 'f6').by).toBeLessThan(1e-9);
    expect(rig.layer.puppetAt('f5')).toBeNull();
    expect(e.enPassant).toBe(true);
    expect(clear).toBeGreaterThan(0.005);
  });
});

describe('the snap', { timeout: 60000 }, () => {
  it('sets the pawn down, lifts clear of it and snaps; the pawn is a pawn until the snap, and changes on it', async () => {
    const rig = await board(PROMOTION);
    const pawn = rig.layer.puppetAt('b7')!;
    const before: string[] = [];
    let set = false;
    const { done, when, clear } = await play(rig, 'b7', 'b8', 'q', () => {
      set ||= rig.layer.puppetAt('b8') !== null;
      if (set && !rig.heard.some((h) => h.what === 'snap')) before.push(pawn.kind);
    });
    expect(done).toBe(true);
    const snaps = rig.heard.filter((h) => h.what === 'snap');
    expect(snaps).toHaveLength(1);
    // Well after it was set down, and from well above it.
    expect(snaps[0]!.time - when('mover', 'set')).toBeGreaterThan(0.5);
    expect(snaps[0]!.at.y).toBeGreaterThan(1.5);
    expect(before.length * DT).toBeGreaterThan(0.5);
    expect(new Set(before)).toEqual(new Set(['p']));
    expect(pawn.kind).toBe('q');
    expect(offSquare(pawn, 'b8').by).toBeLessThan(1e-9);
    expect(clear).toBeGreaterThan(0.005);
  });

  it('changes the pawn at once if the hand is called away before it snaps, and the hand goes where it is called', async () => {
    const rig = await board(PROMOTION);
    const pawn = rig.layer.puppetAt('b7')!;
    let letGo = false;
    let done = false;
    const e = rig.game.move('b7', 'b8', 'q');
    void rig.stage.playMove(e, (part, beat) => part === 'mover' && beat === 'release' && (letGo = true)).then(() => (done = true));
    for (let i = 0; i < 600 && !letGo; i++) await rig.run(DT);
    await rig.run(0.3);
    expect(rig.heard.some((h) => h.what === 'snap')).toBe(false);
    expect(pawn.kind).toBe('p');
    // The player turns to the stone itself.
    rig.stage.consider('w', 'b8');
    await rig.run(0.3);
    expect(pawn.kind).toBe('q');
    expect(armsOf(rig.stage.hands.w).some((arm) => arm.considering?.puppet === pawn)).toBe(true);
    await rig.run(2);
    expect(done).toBe(true);
    expect(rig.heard.some((h) => h.what === 'snap')).toBe(false);
    expect(offSquare(pawn, 'b8').by).toBeLessThan(1e-9);
  });
});

describe('really?', { timeout: 60000 }, () => {
  it.each([
    ['n', 1],
    ['r', 1],
    ['b', 2],
  ] as const)('turns a hand of the other side over, palm up, at a pawn made into a %s (%i hands), above the crowns of the stones', async (kind, hands) => {
    const rig = await board(PROMOTION);
    const turned = new Set<Arm>();
    let low = Infinity;
    const theirs = armsOf(rig.stage.hands.b);
    await play(
      rig,
      'b7',
      'b8',
      kind,
      () => {
        for (const arm of theirs) {
          if (arm.turn < -2) turned.add(arm);
          low = Math.min(low, lowestOverSquares(arm));
        }
      },
      4,
    );
    expect(turned.size).toBe(hands);
    if (hands === 1) expect(turned.has(rig.stage.hands.b.right)).toBe(true);
    // It is that side's turn now; but the hand is where it rests, and what comes over the edge of the board is above any crown.
    expect(low).toBeGreaterThan(PIECE_HEIGHT.k);
    // And back over again.
    for (const arm of theirs) expect(Math.abs(arm.turn)).toBeLessThan(0.05);
  });

  it('turns nothing over at a queen', async () => {
    const rig = await board(PROMOTION);
    let most = 0;
    await play(rig, 'b7', 'b8', 'q', () => {
      for (const arm of armsOf(rig.stage.hands.b)) most = Math.max(most, Math.abs(arm.turn));
    });
    expect(most).toBeLessThan(0.5);
  });

  it('lets a hand go to a stone its player turns to, at once', async () => {
    const rig = await board(PROMOTION);
    await play(rig, 'b7', 'b8', 'b', undefined, 1.8);
    // Turned over by now; and its player turns to their king.
    rig.stage.setTurn('b');
    const right = rig.stage.hands.b.right;
    const left = rig.stage.hands.b.left;
    expect(Math.min(right.turn, left.turn)).toBeLessThan(-1);
    rig.stage.consider('b', 'e8');
    await rig.run(0.3);
    const thinking = [right, left].find((arm) => arm.considering)!;
    expect(thinking).toBeDefined();
    expect(thinking.gesturing).toBe(false);
  });
});

describe('the trophy', { timeout: 60000 }, () => {
  it('holds a queen that is taken up at the top of her carry, lit, before she goes to the drawer', async () => {
    const rig = await board(QUEENS);
    const queen = rig.layer.puppetAt('d5')!;
    const held = stillAtTop(queen);
    let brightest = 0;
    const { done, clear } = await play(rig, 'd1', 'd5', undefined, () => {
      held.look();
      brightest = Math.max(brightest, queen.energy);
    });
    expect(done).toBe(true);
    expect(held.seconds()).toBeGreaterThan(0.3);
    expect(brightest).toBeGreaterThan(1.5);
    expect(queen.energy).toBeLessThan(0.05);
    expect(clear).toBeGreaterThan(0.005);
  });

  it('takes the second queen of two taken one after the other briskly, with no ceremony', async () => {
    const rig = await board(QUEENS);
    await play(rig, 'd1', 'd5');
    rig.stage.setTurn('b');
    const queen = rig.layer.puppetAt('d5')!;
    const held = stillAtTop(queen);
    let brightest = 0;
    await play(rig, 'd8', 'd5', undefined, () => {
      held.look();
      brightest = Math.max(brightest, queen.energy);
    });
    expect(held.seconds()).toBeLessThan(0.1);
    expect(brightest).toBeLessThan(1.2);
  });
});

describe('the pat', { timeout: 60000 }, () => {
  it.each([
    ['castling', 1, CASTLE, 'e1', 'g1'],
    ['castling long', 2, LONG, 'e1', 'c1'],
  ] as const)('%s: taps the king on its crown %i times before the hand goes, and goes into nothing', async (_name, taps, fen, from, to) => {
    const rig = await board(fen, seedWhere((seed) => comes(seed, 'pat', CHANCE.often)));
    const king = rig.layer.puppetAt(from)!;
    const { done, clear, when } = await play(rig, from, to);
    expect(done).toBe(true);
    const tapped = rig.heard.filter((h) => h.what === 'tap');
    expect(tapped).toHaveLength(taps);
    const crown = king.group.position.y + 1.6;
    for (const tap of tapped) {
      expect(tap.time).toBeGreaterThan(when('mover', 'release'));
      expect(Math.hypot(tap.at.x - king.group.position.x, tap.at.z - king.group.position.z)).toBeLessThan(0.05);
      expect(tap.at.y).toBeGreaterThan(crown);
    }
    expect(offSquare(king, to).by).toBeLessThan(1e-9);
    expect(clear).toBeGreaterThan(0.005);
  });

  it('keeps the hand that carried the rook under the other arm until the other has gone', async () => {
    const rig = await board(LONG, seedWhere((seed) => comes(seed, 'pat', CHANCE.often)));
    const e = rig.game.move('e1', 'c1');
    const player = rig.stage.hands.w;
    let worst = Infinity;
    void rig.stage.playMove(e);
    await rig.run(6, () => {
      const [a, b] = armsOf(player);
      worst = Math.min(worst, a!.hand.toWorld(new Vector3(0, 0, 0), new Vector3()).distanceTo(b!.hand.toWorld(new Vector3(0, 0, 0), new Vector3())));
    });
    expect(worst).toBeGreaterThan(0.45);
  });
});

describe('the push', { timeout: 60000 }, () => {
  it.each([
    ['e2', 'e3', START],
    ['h2', 'h3', START],
    ['d7', 'd6', START.replace(' w ', ' b ')],
  ] as const)('slides a pawn early in the game, %s to %s, with one finger behind it, without lifting it', async (from, to, fen) => {
    const rig = await board(fen, seedWhere((seed) => comes(seed, 'push', CHANCE.often) && !comes(seed, 'squaring-up', CHANCE.seldom)));
    const pawn = rig.layer.puppetAt(from)!;
    let highest = 0;
    // While the stone moves, how far the tip of a finger is from the back of its head, at most.
    let behind = 0;
    const back = new Vector3();
    const start = pawn.group.position.clone();
    const { done, clear, e } = await play(rig, from, to, undefined, (move) => {
      highest = Math.max(highest, pawn.group.position.y);
      const p = pawn.group.position;
      if (p.distanceTo(start) < 0.05 || offSquare(pawn, to).by < 0.05) return;
      const gaps = armsOf(rig.stage.hands[move.side]).map((arm) => gapTo(pawn, arm.hand.padWorld('index', back, true)));
      behind = Math.max(behind, Math.min(...gaps));
      // On the side it is being pushed from.
      expect((back.z - p.z) * (move.side === 'w' ? 1 : -1)).toBeGreaterThan(0);
    });
    expect(done).toBe(true);
    expect(highest).toBeLessThan(1e-9);
    expect(behind).toBeGreaterThan(0);
    expect(behind).toBeLessThan(0.08);
    expect(offSquare(pawn, to)).toEqual({ by: 0, turned: 0 });
    expect(clear).toBeGreaterThan(0.005);
    void e;
  });
});

describe('squaring up', { timeout: 60000 }, () => {
  it.each([
    ['a knight', START, 'g1', 'f3'],
    ['a pawn two squares', START, 'e2', 'e4'],
  ] as const)('sets %s down a little off and a little round, and nudges it straight with one finger', async (_name, fen, from, to) => {
    const rig = await board(fen, seedWhere((seed) => comes(seed, 'squaring-up', CHANCE.seldom)));
    const stone = rig.layer.puppetAt(from)!;
    let set: { by: number; turned: number } | null = null;
    let nudged = false;
    const { done, clear } = await play(rig, from, to, undefined, (e) => {
      if (!set && rig.layer.puppetAt(to) === stone) set = offSquare(stone, to);
      // Moved after it was let go: by a finger, since no hand has hold of it.
      if (set && offSquare(stone, to).by < set.by - 0.02 && armsOf(rig.stage.hands[e.side]).every((arm) => !arm.held)) nudged = true;
    });
    expect(done).toBe(true);
    expect(set!.by).toBeGreaterThan(0.06);
    expect(set!.by).toBeLessThan(0.1);
    expect(set!.turned).toBeGreaterThan(0.05);
    expect(nudged).toBe(true);
    expect(offSquare(stone, to)).toEqual({ by: 0, turned: 0 });
    expect(clear).toBeGreaterThan(0.005);
  });

  it('never in a lesson', async () => {
    const rig = await board(START, seedWhere((seed) => comes(seed, 'squaring-up', CHANCE.seldom)));
    rig.stage.setLesson(true);
    const stone = rig.layer.puppetAt('g1')!;
    let most = 0;
    await play(rig, 'g1', 'f3', undefined, () => {
      if (rig.layer.puppetAt('f3') === stone) most = Math.max(most, offSquare(stone, 'f3').by);
    });
    expect(most).toBeLessThan(1e-9);
  });

  it('leaves the stone exactly on its square however it is stopped', async () => {
    const rig = await board(START, seedWhere((seed) => comes(seed, 'squaring-up', CHANCE.seldom)));
    const stone = rig.layer.puppetAt('g1')!;
    const e = rig.game.move('g1', 'f3');
    let letGo = false;
    void rig.stage.playMove(e, (part, beat) => part === 'mover' && beat === 'release' && (letGo = true));
    for (let i = 0; i < 600 && !letGo; i++) await rig.run(DT);
    await rig.run(0.5);
    expect(offSquare(stone, 'f3').by).toBeGreaterThan(0.05);
    // The move is taken back while the hand is on its way to put it straight.
    rig.game.undo();
    void rig.stage.playUndo(e);
    await rig.run(0.3);
    expect(offSquare(stone, 'f3').by).toBeLessThan(1e-9);
  });
});

describe('it wears off', { timeout: 60000 }, () => {
  /** The queen checks the king down the h-file, rank after rank; each move answered by the king stepping down. */
  const LADDER_MOVES: [Square, Square][] = [
    ['a1', 'a8'],
    ['h8', 'h7'],
    ['a8', 'a7'],
    ['h7', 'h6'],
    ['a7', 'a6'],
    ['h6', 'h5'],
    ['a6', 'a5'],
    ['h5', 'h4'],
    ['a5', 'a4'],
    ['h4', 'h3'],
  ];

  it('makes less of each check given running: points, points once from nearer home, lifts a finger, and then nothing while the other drums', async () => {
    const rig = await board(LADDER);
    const seen: string[] = [];
    const spy = (side: Side, name: 'point' | 'startle' | 'liftFinger' | 'twitch' | 'drumOnRail') => {
      const hands = rig.stage.hands[side] as unknown as Record<string, (...args: unknown[]) => void>;
      const was = hands[name]!.bind(hands);
      hands[name] = (...args: unknown[]) => {
        seen.push(`${side} ${name}${name === 'point' && args[1] ? ' once' : ''}${name === 'startle' && args[0] !== undefined ? ` ${args[0]}` : ''}`);
        was(...args);
      };
    };
    for (const side of ['w', 'b'] as const) for (const name of ['point', 'startle', 'liftFinger', 'twitch', 'drumOnRail'] as const) spy(side, name);
    const checks: string[][] = [];
    for (const [from, to] of LADDER_MOVES) {
      const e = rig.game.move(from, to);
      rig.stage.setTurn(null);
      seen.length = 0;
      await until(rig, rig.stage.playMove(e));
      if (e.status.inCheck && e.status.checkedKing) rig.stage.check(e.side, squareCenter(e.status.checkedKing));
      if (e.side === 'w') checks.push([...seen]);
      await rig.run(4);
    }
    expect(checks).toEqual([['w point', 'b startle'], ['w point once', 'b startle 0.5'], ['w liftFinger', 'b twitch'], ['b drumOnRail'], ['b drumOnRail']]);
  });

  it('starts again from the first after a move that gives no check, or once the checks are taken back', async () => {
    const rig = await board(LADDER);
    const points: boolean[] = [];
    const hands = rig.stage.hands.w;
    const point = hands.point.bind(hands);
    hands.point = (at, once) => {
      points.push(!!once);
      point(at, once);
    };
    const move = async (from: Square, to: Square) => {
      const e = rig.game.move(from, to);
      await until(rig, rig.stage.playMove(e));
      if (e.status.inCheck && e.status.checkedKing) rig.stage.check(e.side, squareCenter(e.status.checkedKing));
      await rig.run(3);
      return e;
    };
    await move('a1', 'a8');
    await move('h8', 'h7');
    const second = await move('a8', 'a7');
    expect(points).toEqual([false, true]);
    // Taken back, and made again: the second check is the second again.
    rig.game.undo();
    await until(rig, rig.stage.playUndo(second));
    await rig.run(3);
    await move('a8', 'a7');
    expect(points).toEqual([false, true, true]);
    await move('h7', 'h6');
    // A quiet move, and then a check: the first again.
    await move('e1', 'd1');
    await move('h6', 'h5');
    await move('a7', 'a5');
    expect(points).toEqual([false, true, true, false]);
  });
});

/** Step the scene until `done` has resolved, and no longer than ten seconds. */
async function until(rig: Awaited<ReturnType<typeof board>>, done: Promise<unknown>): Promise<void> {
  let over = false;
  void done.then(() => (over = true));
  for (let t = 0; t < 10 && !over; t += DT) await rig.run(DT);
  expect(over).toBe(true);
}

/** How far a point is from the side of a stone, level, at its height: less than nothing inside it. */
function gapTo(puppet: Puppet, at: Vector3): number {
  puppet.group.updateWorldMatrix(true, true);
  const stone = Girth.of(puppet.group)!;
  const local = stone.mesh.worldToLocal(at.clone());
  return Math.hypot(local.x, local.z) - stone.girth.at(local.y, local.x, local.z);
}

/** How long a stone is held up off the board without going anywhere, all told. */
function stillAtTop(puppet: Puppet) {
  const last = puppet.group.position.clone();
  let frames = 0;
  return {
    look: () => {
      const p = puppet.group.position;
      if (p.y > 1 && Math.hypot(p.x - last.x, p.z - last.z) < 0.002) frames++;
      last.copy(p);
    },
    seconds: () => frames * DT,
  };
}

/** The lowest any point of a hand comes over the squares, every third point of it. */
function lowestOverSquares(arm: Arm): number {
  let low = Infinity;
  arm.hand.root.updateMatrixWorld(true);
  arm.hand.root.traverse((o) => {
    const skin = o as SkinnedMesh;
    if (!skin.isSkinnedMesh) return;
    skin.skeleton.update();
    const count = skin.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i += 3) {
      skin.localToWorld(skin.getVertexPosition(i, point));
      if (Math.abs(point.x) < 4 && Math.abs(point.z) < 4) low = Math.min(low, point.y);
    }
  });
  return low;
}
const point = new Vector3();

/**
 * A board on which the table answers the next stone set down with `manner`, whatever the chances say
 * (or with nothing out of the ordinary, given null); the rest of it is asked as ever.
 */
async function boardWith(fen: string, manner: string | null) {
  const rig = await board(fen);
  const table = rig.stage.manners;
  const asked = table.choose.bind(table);
  let once = true;
  table.choose = (at, facts) => (at === 'set' && once ? ((once = false), manner as ReturnType<typeof asked>) : asked(at, facts));
  return rig;
}

/** How long, from a move coming to the hands, before they have done with it and the next may be played. */
async function untilDone(rig: Awaited<ReturnType<typeof board>>, from: Square, to: Square, promotion?: PromotionKind): Promise<{ e: MoveEvent; seconds: number }> {
  const e = rig.game.move(from, to, promotion);
  let done = false;
  void rig.stage.playMove(e).then(() => (done = true));
  let seconds = 0;
  for (; !done && seconds < 12; seconds += DT) await rig.run(DT);
  expect(done).toBe(true);
  return { e, seconds };
}

describe('the next player is not kept waiting', { timeout: 120000 }, () => {
  it.each([
    ['squaring-up', START, 'g1', 'f3', undefined, 0.1],
    ['pat', LONG, 'e1', 'c1', undefined, 0.02],
    ['snap', PROMOTION, 'b7', 'b8', 'q', 0.02],
    ['trophy', QUEENS, 'd1', 'd5', undefined, 0.02],
  ] as const)('the stone set down with %s is done with as soon as it would have been without', async (manner, fen, from, to, promotion, more) => {
    const plain = await untilDone(await boardWith(fen, null), from, to, promotion);
    const rig = await boardWith(fen, manner);
    const shown = await untilDone(rig, from, to, promotion);
    expect(shown.seconds).toBeLessThanOrEqual(plain.seconds + more);
    // And what is left of it is still to come, or going on.
    if (manner === 'snap') expect(rig.layer.puppetAt('b8')!.kind).toBe('p');
    if (manner === 'squaring-up') expect(offSquare(rig.layer.puppetAt('f3')!, 'f3').by).toBeGreaterThan(0.05);
    if (manner === 'pat') expect(rig.heard.filter((h) => h.what === 'tap')).toHaveLength(0);
  });

  it('gives way when the next player turns to a stone: a stone being squared up stands exactly on its square at once, and the hand goes home', async () => {
    const rig = await boardWith(START, 'squaring-up');
    await untilDone(rig, 'g1', 'f3');
    const knight = rig.layer.puppetAt('f3')!;
    await rig.run(0.6);
    expect(offSquare(knight, 'f3').by).toBeGreaterThan(0.05);
    rig.stage.setTurn('b');
    rig.stage.consider('b', 'e7');
    await rig.run(0.3);
    expect(offSquare(knight, 'f3')).toEqual({ by: 0, turned: 0 });
    let moved = 0;
    const at = knight.group.position.clone();
    await rig.run(2, () => (moved = Math.max(moved, knight.group.position.distanceTo(at))));
    expect(moved).toBe(0);
    for (const arm of armsOf(rig.stage.hands.w)) expect(arm.busy).toBe(false);
  });

  it('gives way when the next player turns to a stone: a king being patted is patted no more', async () => {
    const rig = await boardWith(LONG, 'pat');
    await untilDone(rig, 'e1', 'c1');
    rig.stage.setTurn('b');
    rig.stage.consider('b', 'e7');
    await rig.run(2);
    expect(rig.heard.filter((h) => h.what === 'tap')).toHaveLength(0);
    expect(offSquare(rig.layer.puppetAt('c1')!, 'c1')).toEqual({ by: 0, turned: 0 });
  });

  it('gives way when the next player turns to a stone: a pawn on the last rank changes at once, with no snap', async () => {
    const rig = await boardWith(PROMOTION, 'snap');
    await untilDone(rig, 'b7', 'b8', 'q');
    const pawn = rig.layer.puppetAt('b8')!;
    expect(pawn.kind).toBe('p');
    rig.stage.setTurn('b');
    rig.stage.consider('b', 'e8');
    await rig.run(0.3);
    expect(pawn.kind).toBe('q');
    await rig.run(2);
    expect(rig.heard.some((h) => h.what === 'snap')).toBe(false);
  });

  it('gives way to the next move: the stone being squared up stands exactly on its square as the other player plays', async () => {
    const rig = await boardWith(START, 'squaring-up');
    await untilDone(rig, 'g1', 'f3');
    const knight = rig.layer.puppetAt('f3')!;
    expect(offSquare(knight, 'f3').by).toBeGreaterThan(0.05);
    const answer = rig.game.move('e7', 'e5');
    let done = false;
    void rig.stage.playMove(answer).then(() => (done = true));
    await rig.run(0.3);
    expect(offSquare(knight, 'f3')).toEqual({ by: 0, turned: 0 });
    for (let t = 0; t < 12 && !done; t += DT) await rig.run(DT);
    expect(done).toBe(true);
    expect(offSquare(rig.layer.puppetAt('e5')!, 'e5').by).toBeLessThan(1e-9);
  });

  it('against a clock, takes in passing and steps a pawn early as any other move: no rap, no push', async () => {
    const plain = await untilDone(await boardWith(PASSANT, null), 'e5', 'f6');
    const rig = await board(PASSANT, seedWhere((seed) => comes(seed, 'push', CHANCE.often)));
    rig.stage.setTimed(true);
    const timed = await untilDone(rig, 'e5', 'f6');
    expect(rig.heard.some((h) => h.what === 'knock')).toBe(false);
    expect(Math.abs(timed.seconds - plain.seconds)).toBeLessThan(0.05);
    // And a pawn's first step, at a board whose chances would have it pushed.
    const steps = await board(START, seedWhere((seed) => comes(seed, 'push', CHANCE.often)));
    steps.stage.setTimed(true);
    const pawn = steps.layer.puppetAt('e2')!;
    let highest = 0;
    const e = steps.game.move('e2', 'e3');
    void steps.stage.playMove(e);
    await steps.run(4, () => (highest = Math.max(highest, pawn.group.position.y)));
    expect(highest).toBeGreaterThan(0.2);
  });
});
