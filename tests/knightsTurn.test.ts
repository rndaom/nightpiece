/**
 * A knight in the hand goes as it moves: two squares along and then one across, over whatever
 * stands on the way, and not straight to where it is going.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Square } from '../src/core/game.ts';
import { squareCenter } from '../src/scene/layout.ts';
import { PIECE_HEIGHT } from '../src/scene/pieceShapes.ts';
import { handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);

/** Play one move (after `before`, each played to its end) and say where the moved piece's foot was on every frame: or, with `undone`, on every frame of its being taken back. */
async function pathOf(from: Square, to: Square, before: [Square, Square][] = [], fen?: string, undone = false) {
  const { game, layer, stage, run } = handsRig(fen);
  stage.setTurn('w');
  await run(1.5);
  for (const [a, b] of before) {
    void stage.playMove(game.move(a, b));
    await run(6);
  }
  const e = game.move(from, to);
  const puppet = layer.puppet(e.piece.id)!;
  const path: { x: number; y: number; z: number }[] = [];
  let done = false;
  void stage.playMove(e).then(() => (done = true));
  await run(6, () => !done && path.push({ x: puppet.group.position.x, y: puppet.group.position.y, z: puppet.group.position.z }));
  expect(done).toBe(true);
  if (!undone) return path;
  // And the same move taken back.
  const back: typeof path = [];
  done = false;
  void stage.playUndo(game.undo()!).then(() => (done = true));
  await run(6, () => !done && back.push({ x: puppet.group.position.x, y: puppet.group.position.y, z: puppet.group.position.z }));
  expect(done).toBe(true);
  return back;
}

/** The nearest the path came to the middle of a square, and how high the piece's foot was then. */
function nearest(path: { x: number; y: number; z: number }[], square: Square) {
  const c = squareCenter(square);
  let best = { off: Infinity, y: 0 };
  for (const p of path) {
    const off = Math.hypot(p.x - c.x, p.z - c.z);
    if (off < best.off) best = { off, y: p.y };
  }
  return best;
}

describe('a knight in the hand', () => {
  it('goes two along and one across, over the pawn in front of it', async () => {
    const path = await pathOf('g1', 'f3');
    // By the corner of its move, where the straight way never comes nearer than two fifths of a square.
    const corner = nearest(path, 'g3');
    expect(corner.off).toBeLessThan(0.2);
    // And over the pawn on the way to it, clear of its head.
    const pawn = nearest(path, 'g2');
    expect(pawn.off).toBeLessThan(0.2);
    expect(pawn.y).toBeGreaterThan(PIECE_HEIGHT.p + 0.1);
    // It ends where the rules say.
    const end = squareCenter('f3');
    const last = path[path.length - 1]!;
    expect(Math.hypot(last.x - end.x, last.z - end.z)).toBeLessThan(0.02);
  });

  it('takes the longer leg first whichever way that lies, and for Void as for Ivory', async () => {
    // Sideways first: b1 to d2 is two files and one rank.
    const wide = await pathOf('b1', 'd2', [], 'r1bqkbnr/pppppppp/2n5/8/8/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1');
    expect(nearest(wide, 'd1').off).toBeLessThan(0.2);
    const far = await pathOf('b8', 'c6', [['e2', 'e4']]);
    expect(nearest(far, 'b6').off).toBeLessThan(0.2);
  });

  it('goes back the way it came when the move is taken back', async () => {
    const path = await pathOf('g1', 'f3', [], undefined, true);
    // By the same corner, and not by the other one.
    expect(nearest(path, 'g3').off).toBeLessThan(0.2);
    expect(nearest(path, 'f1').off).toBeGreaterThan(0.8);
    const end = squareCenter('g1');
    const last = path[path.length - 1]!;
    expect(Math.hypot(last.x - end.x, last.z - end.z)).toBeLessThan(0.02);
  });

  it('is the only piece that does: a bishop goes straight', async () => {
    const path = await pathOf('f1', 'c4', [
      ['e2', 'e4'],
      ['e7', 'e5'],
    ]);
    // Never off its diagonal by more than a little.
    const a = squareCenter('f1');
    const b = squareCenter('c4');
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    for (const p of path) expect(Math.abs((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / length).toBeLessThan(0.15);
  });
});
