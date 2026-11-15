/**
 * The engine wrapper against the real engine: the same Stockfish build the
 * game ships, run under Node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Game } from '../src/core/game.ts';
import { centipawns, Engine, LEVELS, parseInfo, parseMove } from '../src/engine/uci.ts';
import { nodePort } from './helpers/node-engine.ts';

let engine: Engine;
beforeAll(async () => {
  engine = new Engine(nodePort());
  await engine.start();
}, 30000);
afterAll(() => engine.close());

describe('reading the engine', () => {
  it('reads moves, with and without a promotion', () => {
    expect(parseMove('e2e4')).toEqual({ from: 'e2', to: 'e4' });
    expect(parseMove('a7a8q')).toEqual({ from: 'a7', to: 'a8', promotion: 'q' });
    expect(parseMove('(none)')).toBeNull();
  });

  it('reads a scored line and passes over bounds and chatter', () => {
    expect(parseInfo('info depth 12 seldepth 16 multipv 2 score cp -34 nodes 1 nps 1 time 1 pv e7e5 g1f3')).toEqual({
      depth: 12,
      index: 2,
      score: { cp: -34 },
      move: { from: 'e7', to: 'e5' },
    });
    expect(parseInfo('info depth 9 score mate 3 pv d1h5')).toMatchObject({ score: { mate: 3 }, index: 1 });
    expect(parseInfo('info depth 9 score cp 20 lowerbound pv d1h5')).toBeNull();
    expect(parseInfo('info string NNUE evaluation using nn.nnue')).toBeNull();
  });

  it('puts mate above any material, and a quicker mate above a slower one', () => {
    expect(centipawns({ mate: 2 })).toBeGreaterThan(centipawns({ mate: 5 }));
    expect(centipawns({ mate: 5 })).toBeGreaterThan(centipawns({ cp: 3000 }));
    expect(centipawns({ mate: -1 })).toBeLessThan(centipawns({ cp: -3000 }));
  });
});

describe('an engine that does not come up', () => {
  /** A worker whose program never finished loading: it takes every line and says nothing. */
  const dead = () => {
    const port = { sent: [] as string[], closed: false, send: (line: string) => void port.sent.push(line), listen: () => {}, close: () => void (port.closed = true) };
    return port;
  };

  it('is given up on after a set time, and shut', async () => {
    const port = dead();
    const began = Date.now();
    await expect(new Engine(port).start(150)).rejects.toThrow(/did not answer/);
    expect(Date.now() - began).toBeLessThan(1500);
    expect(port.closed).toBe(true);
  });

  it('refuses searches afterwards instead of leaving them waiting for ever', async () => {
    const engine = new Engine(dead());
    await expect(engine.start(50)).rejects.toThrow();
    await expect(engine.analyse(new Game().fen(), { depth: 4 })).rejects.toThrow(/closed/);
  });

  it('is not given up on if it answers in time', async () => {
    // The real engine, already up: asking again with a time limit changes nothing.
    await expect(engine.start(20000)).resolves.toBeUndefined();
    const found = await engine.analyse(new Game().fen(), { depth: 4 });
    expect(found.best).not.toBeNull();
  }, 30000);
});

describe('the engine', () => {
  it('plays a legal move from the starting position', async () => {
    const game = new Game();
    const found = await engine.analyse(game.fen(), { depth: 6 });
    expect(found.best).not.toBeNull();
    expect(game.canMove(found.best!.from)).toBe(true);
    expect(() => game.move(found.best!.from, found.best!.to, found.best!.promotion)).not.toThrow();
  }, 30000);

  it('finds a mate in one and says so', async () => {
    const found = await engine.analyse('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', { depth: 8 });
    expect(found.best).toEqual({ from: 'a1', to: 'a8' });
    expect(found.lines[0]!.score).toEqual({ mate: 1 });
  }, 30000);

  it('scores a position for the side to move', async () => {
    const up = await engine.analyse('4k3/8/8/8/8/8/8/QQ2K3 w - - 0 1', { depth: 8 });
    const down = await engine.analyse('4k3/8/8/8/8/8/8/QQ2K3 b - - 0 1', { depth: 8 });
    expect(centipawns(up.lines[0]!.score)).toBeGreaterThan(900);
    expect(centipawns(down.lines[0]!.score)).toBeLessThan(-900);
  }, 30000);

  it('reports several lines when asked, best first', async () => {
    const found = await engine.analyse(new Game().fen(), { depth: 8, lines: 3 });
    expect(found.lines).toHaveLength(3);
    const scores = found.lines.map((l) => centipawns(l.score));
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]!);
    expect(scores[1]).toBeGreaterThanOrEqual(scores[2]!);
    expect(new Set(found.lines.map((l) => l.move.from + l.move.to)).size).toBe(3);
  }, 30000);

  it('answers searches in the order they were asked', async () => {
    const order: number[] = [];
    await Promise.all([
      engine.analyse(new Game().fen(), { depth: 7 }).then(() => order.push(1)),
      engine.analyse('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', { depth: 4 }).then(() => order.push(2)),
      engine.analyse(new Game().fen(), { depth: 2 }).then(() => order.push(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  }, 30000);

  it('does not search for an answer nobody wants any more', async () => {
    const found = await engine.analyse(new Game().fen(), { depth: 30, stale: () => true });
    expect(found).toEqual({ best: null, lines: [], depth: 0 });
  });

  it('can be told to stop, and answers with what it has', async () => {
    const began = Date.now();
    const search = engine.analyse(new Game().fen(), { movetime: 20000 });
    // The search starts on a later turn of the event loop; stopping before then would do nothing.
    await new Promise((resolve) => setTimeout(resolve, 400));
    engine.stop();
    const found = await search;
    expect(Date.now() - began).toBeLessThan(5000);
    expect(found.best).not.toBeNull();
  }, 30000);

  it('stops at a depth or a time, whichever comes first', async () => {
    const began = Date.now();
    const found = await engine.analyse(new Game().fen(), { depth: 40, movetime: 300 });
    expect(Date.now() - began).toBeLessThan(3000);
    expect(found.depth).toBeLessThan(40);
    expect(found.best).not.toBeNull();
  }, 30000);

  it('plays every level, and plays legal moves at each', async () => {
    for (const level of LEVELS) {
      const game = new Game('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
      const found = await engine.analyse(game.fen(), { skill: level.skill, depth: level.depth, movetime: level.movetime && 200 });
      expect(found.best, level.id).not.toBeNull();
      expect(() => game.move(found.best!.from, found.best!.to, found.best!.promotion)).not.toThrow();
    }
  }, 60000);
});
