import { type Mesh, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Game, type PromotionKind, type Square } from '../core/game';
import { squareCenter } from './layout';
import { PIECE_HEIGHT, pieceGeometry } from './pieceShapes';
import { greyboxLook, PieceLayer, type PieceLook, type PieceVisual } from './pieces';
import { Tweens } from './tween';

const DT = 1 / 120;

/** Step the tween clock, yielding between steps so chained stages can queue themselves. */
async function run(tweens: Tweens, seconds: number, each?: () => void): Promise<void> {
  for (let t = 0; t < seconds; t += DT) {
    tweens.update(DT);
    each?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

function setup(fen?: string) {
  const game = new Game(fen);
  const tweens = new Tweens();
  const layer = new PieceLayer(tweens);
  layer.reset(game.pieces());
  const move = async (from: Square, to: Square, promotion?: PromotionKind, each?: () => void) => {
    const e = game.move(from, to, promotion);
    const done = layer.playMove(e);
    await run(tweens, 2.5, each);
    await done;
    return e;
  };
  const undo = async () => {
    const e = game.undo()!;
    const done = layer.playUndo(e);
    await run(tweens, 2.5);
    await done;
  };
  return { game, tweens, layer, move, undo };
}

function expectAtRest(layer: PieceLayer, square: Square) {
  const g = layer.objectAt(square)!;
  const c = squareCenter(square);
  expect(g.position.x).toBeCloseTo(c.x, 6);
  expect(g.position.y).toBeCloseTo(0, 6);
  expect(g.position.z).toBeCloseTo(c.z, 6);
  expect(g.scale.toArray().every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
}

describe('piece layer', () => {
  it('sets up 32 pieces on their squares, each side facing the other', () => {
    const { layer } = setup();
    expect(layer.count).toBe(32);
    expectAtRest(layer, 'e1');
    expectAtRest(layer, 'd8');
    expect(layer.objectAt('e1')!.rotation.y).toBe(0);
    expect(layer.objectAt('e8')!.rotation.y).toBeCloseTo(Math.PI);
    expect(layer.objectAt('e4')).toBeNull();
  });

  it('builds every piece to the height ladder in the style bible', () => {
    for (const kind of ['p', 'r', 'n', 'b', 'q', 'k'] as const) {
      const g = pieceGeometry(kind);
      g.body.computeBoundingBox();
      const box = g.body.boundingBox!;
      expect(box.min.y).toBeCloseTo(0, 5);
      expect(box.max.y).toBeCloseTo(PIECE_HEIGHT[kind], 2);
      // No footprint is wider than three quarters of a square (the bishop is measured corner to corner).
      expect(box.max.x - box.min.x).toBeLessThanOrEqual(kind === 'b' ? 0.78 : 0.76);
    }
    expect(PIECE_HEIGHT.k).toBe(1.7);
  });

  it('moves on an eased arc and lands exactly on the square', async () => {
    const { layer, move } = setup();
    const pawn = layer.objectAt('e2')!;
    const steps: number[] = [];
    let highest = 0;
    let last = pawn.position.clone();
    await move('e2', 'e4', undefined, () => {
      steps.push(Math.hypot(pawn.position.x - last.x, pawn.position.z - last.z));
      highest = Math.max(highest, pawn.position.y);
      last = pawn.position.clone();
    });
    expect(layer.objectAt('e4')).toBe(pawn);
    expectAtRest(layer, 'e4');
    expect(highest).toBeGreaterThan(0.3);

    const moving = steps.filter((s) => s > 1e-9);
    const peak = Math.max(...moving);
    // Slow at both ends, fastest in the middle: not linear.
    expect(moving[0]!).toBeLessThan(peak * 0.1);
    expect(moving[moving.length - 1]!).toBeLessThan(peak * 0.1);
  });

  it('lifts a knight clear of the tallest piece', async () => {
    const { layer, move } = setup();
    const knight = layer.objectAt('g1')!;
    let highest = 0;
    await move('g1', 'f3', undefined, () => (highest = Math.max(highest, knight.position.y)));
    expect(highest).toBeGreaterThan(PIECE_HEIGHT.k);
    expectAtRest(layer, 'f3');
  });

  it('removes a captured piece and brings it back on undo', async () => {
    const { layer, move, undo } = setup();
    await move('e2', 'e4');
    await move('d7', 'd5');
    await move('e4', 'd5');
    expect(layer.count).toBe(31);
    expect(layer.root.children).toHaveLength(31);
    expectAtRest(layer, 'd5');

    await undo();
    expect(layer.count).toBe(32);
    expect(layer.root.children).toHaveLength(32);
    expectAtRest(layer, 'd5');
    expectAtRest(layer, 'e4');
  });

  it('handles en passant, castling and promotion, forwards and back', async () => {
    const { layer, move, undo } = setup('r3k2r/1P6/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1');
    await move('e5', 'd6');
    expect(layer.objectAt('d5')).toBeNull();
    expectAtRest(layer, 'd6');

    const rook = layer.objectAt('h8')!;
    await move('e8', 'g8');
    expect(layer.objectAt('f8')).toBe(rook);
    expectAtRest(layer, 'f8');
    expectAtRest(layer, 'g8');

    const pawn = layer.objectAt('b7')!;
    await move('b7', 'a8', 'q');
    expect(layer.objectAt('a8')).toBe(pawn);
    expect(layer.kindAt('a8')).toBe('q');
    expectAtRest(layer, 'a8');
    expect(layer.count).toBe(7);

    await undo();
    await undo();
    await undo();
    expect(layer.count).toBe(9);
    expect(layer.kindAt('b7')).toBe('p');
    expect(layer.objectAt('b7')).toBe(pawn);
    for (const sq of ['a1', 'e1', 'h1', 'e5', 'b7', 'd5', 'a8', 'e8', 'h8'] as Square[]) expectAtRest(layer, sq);
  });

  it('raises the selected piece and sets it down again', async () => {
    const { layer, tweens } = setup();
    layer.setSelected('b1');
    await run(tweens, 0.4);
    expect(layer.objectAt('b1')!.position.y).toBeGreaterThan(0.1);
    layer.setSelected('c1');
    await run(tweens, 0.4);
    expect(layer.objectAt('b1')!.position.y).toBeCloseTo(0, 6);
    expect(layer.objectAt('c1')!.position.y).toBeGreaterThan(0.1);
    layer.setSelected(null);
    await run(tweens, 0.4);
    expect(layer.objectAt('c1')!.position.y).toBeCloseTo(0, 6);
  });

  it('picks a piece by its whole body, not just its square', () => {
    const { layer } = setup();
    const toward = (from: Vector3, to: Vector3) => new Raycaster(from, to.clone().sub(from).normalize());
    // A low ray that crosses the board above the squares and meets the e1 king's head.
    expect(layer.pick(toward(new Vector3(0.5, 1.5, 9), new Vector3(0.5, 1.5, 3.5)))).toBe('e1');
    // The same kind of ray one file over finds the queen.
    expect(layer.pick(toward(new Vector3(-0.5, 1.3, 9), new Vector3(-0.5, 1.3, 3.5)))).toBe('d1');
  });

  it('picks what is drawn: a ray that passes beside a piece does not choose it', () => {
    const { layer } = setup();
    const toward = (from: Vector3, to: Vector3) => new Raycaster(from, to.clone().sub(from).normalize());
    // Steeply down over the heads of the e1 king and the e2 pawn, onto the empty square behind them.
    const over = toward(new Vector3(0.5, 8, 4.2), new Vector3(0.5, 0, 1.5));
    expect(layer.pick(over)).toBeNull();
    // Along the gap between the e and f files, where a box around each piece used to catch the ray.
    const between = toward(new Vector3(0.95, 0.6, 9), new Vector3(0.95, 0.6, 2.5));
    expect(layer.pick(between)).toBeNull();
    // Straight down onto the pawn.
    expect(layer.pick(toward(new Vector3(0.5, 5, 2.5), new Vector3(0.5, 0, 2.5)))).toBe('e2');
  });

  it('keeps a captured piece drawn and fading until it has gone, but no longer choosable', async () => {
    const { layer, game, tweens } = setup();
    for (const [from, to] of [['e2', 'e4'], ['d7', 'd5']] as [Square, Square][]) {
      const done = layer.playMove(game.move(from, to));
      await run(tweens, 2.5);
      await done;
    }
    const victim = layer.objectAt('d5')!;
    const done = layer.playMove(game.move('e4', 'd5'));
    await run(tweens, 0.05);
    layer.update(0);
    // Still in the scene on its way out, and not what a click on its square finds.
    expect(layer.root.children).toContain(victim);
    expect(layer.count).toBe(31);
    await run(tweens, 2.5);
    await done;
    expect(layer.root.children).not.toContain(victim);
    expect(layer.root.children).toHaveLength(31);
  });

  it('keeps what it draws the pieces with from one position to the next', async () => {
    // A look that counts: three.js throws a shader program away with the last material that used
    // it, so a new position must be stood up out of the parts of the old one, none thrown away.
    const made: PieceVisual[] = [];
    let disposed = 0;
    const counting = (): PieceLook => {
      const inner = greyboxLook();
      return {
        create(kind, side) {
          const visual = inner.create(kind, side);
          const counted: PieceVisual = { ...visual, dispose: () => (disposed++, visual.dispose()) };
          made.push(counted);
          return counted;
        },
      };
    };
    const game = new Game();
    const tweens = new Tweens();
    const layer = new PieceLayer(tweens, counting());
    layer.reset(game.pieces());
    expect(made).toHaveLength(32);

    // A capture, then the board set up afresh: the taken piece's part is used again as well.
    for (const [from, to] of [['e2', 'e4'], ['d7', 'd5'], ['e4', 'd5']] as [Square, Square][]) {
      const done = layer.playMove(game.move(from, to));
      await run(tweens, 2.5);
      await done;
    }
    expect(layer.root.children).toHaveLength(31);
    layer.reset(new Game().pieces());
    layer.update(0);
    expect(layer.root.children).toHaveLength(32);
    expect(made).toHaveLength(32);
    expect(disposed).toBe(0);
    // Every piece is drawn again by a part of its own side, of the right shape, standing on the ground.
    for (const square of ['e1', 'd8', 'a2', 'h7', 'd7'] as Square[]) {
      const group = layer.objectAt(square)!;
      expect(group.children).toHaveLength(1);
      expect(made.map((v) => v.object)).toContain(group.children[0]);
      expect(group.children[0]!.position.y).toBe(0);
    }
    expect(new Set(layer.root.children.map((g) => g.children[0])).size).toBe(32);

    // A smaller position leaves parts over; the next full one takes them up again.
    layer.reset(new Game('4k3/8/8/8/8/8/8/4K3 w - - 0 1').pieces());
    layer.reset(new Game().pieces());
    expect(made).toHaveLength(32);
    expect(disposed).toBe(0);

    // A new look replaces them all, and the old ones go once the new have been drawn.
    layer.setLook(counting());
    expect(made).toHaveLength(64);
    expect(disposed).toBe(0);
    layer.update(0);
    expect(disposed).toBe(0);
    layer.update(0);
    expect(disposed).toBe(32);
    layer.reset(new Game().pieces());
    expect(made).toHaveLength(64);
    expect(disposed).toBe(32);
  });

  it('does not let a capture from the last game, ending late, put away a taken piece of this one', async () => {
    // A capture the layer plays by itself, cut short by a new position.
    const fen = '3r4/4P3/8/8/8/8/8/K6k w - - 0 1';
    const game = new Game(fen);
    const tweens = new Tweens();
    const layer = new PieceLayer(tweens);
    layer.reset(game.pieces());
    const e = game.move('e7', 'd8', 'q');
    const done = layer.playMove(e);
    await run(tweens, 0.05);
    // The same position again. This time the hands take the rook, and it stands among the taken.
    const again = new Game(fen);
    layer.reset(again.pieces());
    const rook = again.pieces().find((p) => p.square === 'd8')!;
    expect(rook.id).toBe(e.captured!.id);
    const taken = layer.retire(rook.id);
    expect(taken).not.toBeNull();
    // The first capture runs out. Its rook had the same number.
    await run(tweens, 3);
    await done;
    expect(layer.puppet(rook.id)).toBe(taken);
    expect(layer.root.children).toContain(taken!.group);
  });

  it('puts a side\'s lights out at once or one by one, and brings them back', async () => {
    const { layer, tweens } = setup();
    const moods = (side: 'w' | 'b') => [...layer.standing()].filter((v) => v.side === side).map((v) => (v as unknown as { mood: { glow: { value: number; goal: number }; eye: { goal: number }; squash: { goal: number } } }).mood);
    const king = squareCenter('e1');
    // One by one, from the king outward: nothing yet, then all of them.
    layer.extinguish('w', king);
    expect(moods('w').every((m) => m.glow.goal === 1)).toBe(true);
    await run(tweens, 0.5);
    expect(moods('w').some((m) => m.glow.goal === 0)).toBe(true);
    expect(moods('w').some((m) => m.glow.goal === 1)).toBe(true);
    await run(tweens, 2);
    expect(moods('w').every((m) => m.glow.goal === 0 && m.eye.goal === 0 && m.squash.goal > 0)).toBe(true);
    expect(moods('b').every((m) => m.glow.goal === 1)).toBe(true);
    // Brought back.
    layer.relight();
    expect(moods('w').every((m) => m.glow.goal === 1 && m.eye.goal === 1 && m.squash.goal === 0)).toBe(true);
    // Put out again and brought back before the last of them has gone: none goes out afterwards.
    layer.extinguish('w', king);
    await run(tweens, 0.5);
    layer.relight();
    await run(tweens, 3);
    expect(moods('w').every((m) => m.glow.goal === 1 && m.squash.goal === 0)).toBe(true);
    // At once: out now, with nothing to wait for.
    layer.extinguish('b', squareCenter('e8'), true);
    expect(moods('b').every((m) => m.glow.goal === 0 && m.glow.value === 0)).toBe(true);
    expect(moods('w').every((m) => m.glow.goal === 1)).toBe(true);
  });

  it('lets go of a piece that is still being animated when the board is cleared', async () => {
    // A capture that is also a promotion, cut short by a new position. What was still to happen
    // to the two pieces (one turned into a queen, one put away) must not happen to the pieces
    // that are now drawn with the same parts.
    const game = new Game('3r4/4P3/8/8/8/8/8/K6k w - - 0 1');
    const tweens = new Tweens();
    const layer = new PieceLayer(tweens);
    layer.reset(game.pieces());
    const pawnPart = layer.objectAt('e7')!.children[0]!;
    const rookPart = layer.objectAt('d8')!.children[0]!;
    const done = layer.playMove(game.move('e7', 'd8', 'q'));
    await run(tweens, 0.2);
    const fresh = new Game();
    const intact = (count: number) => {
      layer.update(0);
      expect(layer.root.children).toHaveLength(count);
      for (const group of layer.root.children) expect(group.children).toHaveLength(1);
      expect(new Set(layer.root.children.map((g) => g.children[0])).size).toBe(count);
      for (const p of fresh.pieces()) {
        const body = layer.objectAt(p.square)!.children[0]!.children[0] as Mesh;
        expect(body.geometry).toBe(pieceGeometry(p.kind).body);
      }
    };
    layer.reset(fresh.pieces());
    // Both parts are in use again, and the pawn's by a piece that is not a queen: so it would show.
    const wearing = (part: unknown) => fresh.pieces().find((p) => layer.objectAt(p.square)!.children[0] === part);
    expect(wearing(pawnPart)).toBeDefined();
    expect(wearing(pawnPart)!.kind).not.toBe('q');
    expect(wearing(rookPart)).toBeDefined();
    intact(32);
    await run(tweens, 3);
    await done;
    intact(32);
    // Nor is the part of the piece that was put away handed out a second time.
    layer.restore(99, 'q', 'b', 'e5');
    intact(33);
  });
});
