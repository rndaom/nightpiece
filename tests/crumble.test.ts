/**
 * The square a stone has left breaks up in its middle (style bible, 7.3: "the origin crumbles")
 * and is whole again: by its end, or at once if something is to be set down on it.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Game, type Square } from '../src/core/game.ts';
import { BoardFx } from '../src/life/boardfx.ts';
import { Director } from '../src/life/director.ts';
import { squareCenter } from '../src/scene/layout.ts';
import { PieceLayer } from '../src/scene/pieces.ts';
import { Tweens } from '../src/scene/tween.ts';

/** Where the middle of a square is, and which place in the tiles' tables it has (a1 first). */
const centre = (file: number, rank: number) => new Vector3(file - 3.5, 0, 3.5 - rank);
const E2 = 1 * 8 + 4;
const stepFor = (fx: BoardFx, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) fx.update(1 / 60, i / 60);
};
const whole = (broken: Float32Array) => broken.every((v) => v === 0);

function table() {
  const lift = new Float32Array(64);
  const broken = new Float32Array(64);
  return { lift, broken, fx: new BoardFx(lift, broken) };
}

describe('the square a stone has left', () => {
  it('is whole, and costs nothing, until a stone leaves it', () => {
    const { fx, lift, broken } = table();
    stepFor(fx, 1);
    expect(fx.crumbling).toBe(0);
    expect(whole(broken)).toBe(true);
    expect(lift.every((v) => v === 0)).toBe(true);
  });

  it('breaks up where the stone stood and nowhere else, further along as time goes on', () => {
    const { fx, broken } = table();
    fx.crumble(centre(4, 1), 1);
    expect(fx.crumbling).toBe(1);
    stepFor(fx, 0.4);
    const early = broken[E2]!;
    // The whole part is how much of the face is let go (1 to 7); the rest, how far on it is.
    expect(Math.floor(early)).toBeGreaterThanOrEqual(1);
    expect(Math.floor(early)).toBeLessThanOrEqual(7);
    expect(early % 1).toBeGreaterThan(0.1);
    expect(early % 1).toBeLessThan(0.98);
    expect([...broken].filter((v) => v > 0)).toHaveLength(1);
    stepFor(fx, 0.4);
    expect(broken[E2]! % 1).toBeGreaterThan(early % 1);
  });

  it('lets go of more of its face for a heavier stone, and never all of it', () => {
    const level = (amount: number) => {
      const { fx, broken } = table();
      fx.crumble(centre(4, 1), amount);
      fx.update(1 / 60, 0);
      return Math.floor(broken[E2]!);
    };
    expect(level(0.6)).toBeLessThan(level(1.5));
    expect(level(1.5)).toBeLessThanOrEqual(7);
    expect(level(0.01)).toBeGreaterThanOrEqual(1);
  });

  it('is whole and level again within two seconds, with nothing left in its tables', () => {
    const { fx, broken, lift } = table();
    fx.crumble(centre(4, 1), 1.5);
    let deepest = 0;
    for (let i = 0; i < 120; i++) {
      fx.update(1 / 60, i / 60);
      deepest = Math.min(deepest, lift[E2]!);
    }
    // The slab gave a little as it was released, not so much as to show a gap.
    expect(deepest).toBeLessThan(-0.01);
    expect(deepest).toBeGreaterThan(-0.05);
    expect(fx.crumbling).toBe(0);
    expect(whole(broken)).toBe(true);
    expect(lift[E2]).toBe(0);
  });

  it('is hurried to its end when something is set down on the square', () => {
    const { fx, broken, lift } = table();
    fx.crumble(centre(4, 1), 1);
    stepFor(fx, 0.3);
    expect(broken[E2]).toBeGreaterThan(0);
    // Something is set down on it: a ring is sent out from there.
    fx.ripple(centre(4, 1), 1);
    stepFor(fx, 0.25);
    expect(fx.crumbling).toBe(0);
    expect(broken[E2]).toBe(0);
    // And a ripple from another square leaves it alone.
    fx.crumble(centre(4, 1), 1);
    stepFor(fx, 0.3);
    fx.ripple(centre(0, 0), 1);
    stepFor(fx, 0.25);
    expect(fx.crumbling).toBe(1);
    expect(lift.length).toBe(64);
  });

  it('is mended all at once, in a fifth of a second, when told to', () => {
    const { fx, broken } = table();
    fx.crumble(centre(4, 1), 1);
    fx.crumble(centre(6, 0), 1.2);
    stepFor(fx, 0.5);
    expect(fx.crumbling).toBe(2);
    fx.mend();
    stepFor(fx, 0.25);
    expect(fx.crumbling).toBe(0);
    expect(whole(broken)).toBe(true);
  });

  it('mends one square and not another, and ignores a point off the board', () => {
    const { fx } = table();
    fx.crumble(centre(4, 1), 1);
    fx.crumble(centre(6, 0), 1);
    stepFor(fx, 0.3);
    fx.mend(new Vector3(0, 0, 9));
    fx.mend(new Vector3(-9, 0, 0));
    stepFor(fx, 0.25);
    expect(fx.crumbling).toBe(2);
    fx.mend(centre(4, 1));
    stepFor(fx, 0.25);
    expect(fx.crumbling).toBe(1);
  });

  it('starts again, not twice over, when the same square is left again', () => {
    const { fx, broken } = table();
    fx.crumble(centre(4, 1), 1);
    stepFor(fx, 1);
    fx.crumble(centre(4, 1), 1);
    expect(fx.crumbling).toBe(1);
    stepFor(fx, 0.1);
    expect(broken[E2]! % 1).toBeLessThan(0.2);
  });

  it('is gone at once when a new game begins', () => {
    const { fx, broken, lift } = table();
    fx.crumble(centre(4, 1), 1);
    stepFor(fx, 0.1);
    fx.clear();
    expect(fx.crumbling).toBe(0);
    expect(whole(broken)).toBe(true);
    expect(lift.every((v) => v === 0)).toBe(true);
    stepFor(fx, 0.1);
    expect(whole(broken)).toBe(true);
  });

  it('does not touch the board for flecks let go off it (the case settling on its altar)', () => {
    const { fx, broken } = table();
    fx.crumble(new Vector3(-3.6, -0.95, 4.9), 0.35);
    stepFor(fx, 0.2);
    expect(fx.crumbling).toBe(0);
    expect(whole(broken)).toBe(true);
    expect(fx.airborne.flecks).toBeGreaterThan(0);
  });

  it('gives no height to a player who has asked for less motion, and is over in half the time', () => {
    const { fx, broken, lift } = table();
    fx.still = true;
    fx.crumble(centre(4, 1), 1.5);
    let lowest = 0;
    for (let i = 0; i < 60; i++) {
      fx.update(1 / 60, i / 60);
      lowest = Math.min(lowest, lift[E2]!);
    }
    expect(lowest).toBe(0);
    expect(fx.crumbling).toBe(0);
    expect(whole(broken)).toBe(true);
  });

  it('sheds fewer flecks at the lowest quality, but breaks all the same', () => {
    const flecks = (thin: boolean) => {
      const { fx, broken } = table();
      fx.thin = thin;
      fx.crumble(centre(4, 1), 1.5);
      fx.update(1 / 60, 0);
      return { flecks: fx.airborne.flecks, broken: broken[E2]! };
    };
    expect(flecks(true).flecks).toBeLessThan(flecks(false).flecks);
    expect(flecks(true).broken).toBeGreaterThan(0);
  });

  it('tells the tiles only the levels they know, on any square', () => {
    const { fx, broken } = table();
    for (const [file, rank, amount] of [[0, 0, 0.6], [7, 7, 1.5], [3, 3, 1.3]] as const) fx.crumble(centre(file, rank), amount);
    stepFor(fx, 0.3);
    for (const v of broken) expect(v === 0 || (Math.floor(v) >= 1 && Math.floor(v) <= 7)).toBe(true);
  });
});

describe('the room answering a move', () => {
  function room(fen?: string) {
    const game = new Game(fen);
    const tweens = new Tweens();
    const pieces = new PieceLayer(tweens);
    pieces.reset(game.pieces());
    const lift = new Float32Array(64);
    const broken = new Float32Array(64);
    const fx = new BoardFx(lift, broken);
    const director = new Director({ pieces, fx, setMood: () => {}, thud: () => {} }, () => null);
    director.reset(game.status());
    const square = (s: Square) => {
      const c = squareCenter(s);
      return Math.floor(4 - c.z) * 8 + Math.floor(c.x + 4);
    };
    return { game, pieces, fx, director, broken, lift, square };
  }

  it('breaks the square the stone is lifted from, and not the one it is set down on', () => {
    const { game, director, pieces, fx, broken, square } = room();
    const e = game.move('e2', 'e4');
    director.beat(e, 'mover', 'lift');
    expect(fx.crumbling).toBe(1);
    fx.update(1 / 60, 0);
    expect(broken[square('e2')]).toBeGreaterThan(0);
    stepFor(fx, 0.5);
    pieces.settle(e.piece.id, e.piece.to);
    director.beat(e, 'mover', 'set');
    expect(broken[square('e4')]).toBe(0);
    // It is the stone's own square that is left to finish.
    expect(fx.crumbling).toBe(1);
    stepFor(fx, 1.5);
    expect(whole(broken)).toBe(true);
  });

  it('breaks the squares of both king and rook in castling', () => {
    const { game, director, fx, broken, square } = room('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
    const e = game.move('e1', 'g1');
    director.beat(e, 'mover', 'lift');
    director.beat(e, 'rook', 'lift');
    fx.update(1 / 60, 0);
    expect(fx.crumbling).toBe(2);
    expect(broken[square('e1')]).toBeGreaterThan(0);
    expect(broken[square('h1')]).toBeGreaterThan(0);
  });

  it('is mended where a stone is set down on a square that was just left', () => {
    // A stone taken off e5 and another set down there a moment later.
    const { game, director, pieces, fx, broken, square } = room('4k3/8/8/4n3/8/3N4/8/4K3 w - - 0 1');
    const out = game.move('d3', 'e5');
    for (const beat of ['reach', 'close', 'lift'] as const) director.beat(out, 'victim', beat);
    director.beat(out, 'mover', 'lift');
    stepFor(fx, 0.4);
    expect(broken[square('d3')]).toBeGreaterThan(0);
    // Something else set down on the square d3 right away.
    fx.ripple(squareCenter('d3'), 1);
    pieces.settle(out.piece.id, out.piece.to);
    stepFor(fx, 0.25);
    expect(broken[square('d3')]).toBe(0);
  });

  it('leaves no half-broken square when the position is set up again, or a move is taken back', () => {
    const { game, director, fx, broken, lift } = room();
    const e = game.move('e2', 'e4');
    director.beat(e, 'mover', 'lift');
    stepFor(fx, 0.3);
    expect(fx.crumbling).toBe(1);
    director.reset(new Game().status());
    expect(fx.crumbling).toBe(0);
    expect(whole(broken)).toBe(true);
    expect(lift.every((v) => v === 0)).toBe(true);
    // A move taken back while its square is still breaking: the world hurries it first.
    game.undo();
    director.beat(game.move('d2', 'd4'), 'mover', 'lift');
    stepFor(fx, 0.2);
    fx.mend();
    stepFor(fx, 0.25);
    director.undone(game.status());
    expect(fx.crumbling).toBe(0);
    expect(whole(broken)).toBe(true);
  });
});
