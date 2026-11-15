/**
 * Judging a move from the engine's searches, and the computer choosing its
 * own. First with made-up searches, so each rule is tested alone; then with
 * the real engine on positions where the answer is not in doubt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Game } from '../src/core/game.ts';
import { chooseMove } from '../src/engine/opponent.ts';
import { type Analysis, Engine, type EngineMove, LEVELS, type Score } from '../src/engine/uci.ts';
import { judge, worth } from '../src/engine/verdict.ts';
import { nodePort } from './helpers/node-engine.ts';

const mv = (text: string): EngineMove => ({ from: text.slice(0, 2), to: text.slice(2, 4) }) as EngineMove;
/** A search that found these moves, best first, with these scores. */
function search(...lines: [string, Score][]): Analysis {
  return { best: lines[0] ? mv(lines[0][0]) : null, lines: lines.map(([m, score]) => ({ move: mv(m), score })), depth: 10 };
}
const plain = { result: null, recapture: false } as const;

describe('putting one number on a score', () => {
  it('ranks mates above material, quicker mates above slower, and caps the rest', () => {
    expect(worth({ mate: 1 })).toBeGreaterThan(worth({ mate: 6 }));
    expect(worth({ mate: 30 })).toBeGreaterThan(worth({ cp: 9000 }));
    expect(worth({ cp: 9000 })).toBe(worth({ cp: 1500 }));
    expect(worth({ mate: -1 })).toBeLessThan(worth({ mate: -6 }));
    expect(worth({ mate: -6 })).toBeLessThan(worth({ cp: -9000 }));
    expect(worth({ cp: 37 })).toBe(37);
  });
});

describe('judging a move', () => {
  it('calls the best move strong when nothing else would do', () => {
    const v = judge(search(['f3h4', { cp: 620 }], ['d2d4', { cp: -40 }]), null, mv('f3h4'), plain);
    expect(v).toMatchObject({ kind: 'strong', loss: 0, margin: 660, wasBest: true });
  });

  it('calls the best move merely sound when the next best was nearly as good', () => {
    const v = judge(search(['e2e4', { cp: 30 }], ['d2d4', { cp: 25 }]), null, mv('e2e4'), plain);
    expect(v).toMatchObject({ kind: 'sound', margin: 5 });
  });

  it('does not praise a move that was the only one, or a plain recapture', () => {
    expect(judge(search(['e8d8', { cp: -50 }]), null, mv('e8d8'), plain)).toMatchObject({ kind: 'sound', margin: null });
    const taking = search(['d1d8', { cp: 10 }], ['a2a3', { cp: -880 }]);
    expect(judge(taking, null, mv('d1d8'), { result: null, recapture: true })!.kind).toBe('sound');
    expect(judge(taking, null, mv('d1d8'), plain)!.kind).toBe('strong');
  });

  it('does not praise the best move in a position that is lost anyway', () => {
    const v = judge(search(['e8d8', { cp: -400 }], ['e8f8', { cp: -900 }]), null, mv('e8d8'), plain);
    expect(v!.kind).toBe('sound');
  });

  it('measures the second-best move against the best from the same search', () => {
    expect(judge(search(['e2e4', { cp: 40 }], ['a2a4', { cp: -70 }]), null, mv('a2a4'), plain)).toMatchObject({ kind: 'slip', loss: 110, wasBest: false });
    expect(judge(search(['e2e4', { cp: 40 }], ['g2g4', { cp: -260 }]), null, mv('g2g4'), plain)).toMatchObject({ kind: 'blunder', loss: 300 });
  });

  it('measures any other move by the search of where it led', () => {
    const before = search(['e2e4', { cp: 40 }], ['d2d4', { cp: 35 }]);
    // The opponent, to move, stands five pawns up: the mover stands five down.
    expect(judge(before, search(['d8h4', { cp: 500 }]), mv('f2f3'), plain)).toMatchObject({ kind: 'blunder', after: -500, loss: 540 });
    expect(judge(before, search(['e7e5', { cp: -20 }]), mv('g1f3'), plain)).toMatchObject({ kind: 'sound', after: 20, loss: 20 });
    // The move turned out better than the first search thought anything was: no loss, not a negative one.
    expect(judge(before, search(['e7e5', { cp: -90 }]), mv('g1f3'), plain)!.loss).toBe(0);
  });

  it('calls walking into mate a blunder', () => {
    const v = judge(search(['g8f6', { cp: -30 }], ['d7d6', { cp: -45 }]), search(['h5f7', { mate: 1 }]), mv('a7a6'), plain);
    expect(v!.kind).toBe('blunder');
  });

  it('does not call it a mistake to win more slowly, or to lose a lost game faster', () => {
    const winning = judge(search(['d1d8', { mate: 2 }], ['a2a3', { cp: 900 }]), search(['h7h6', { cp: -850 }]), mv('b2b3'), plain);
    expect(winning).toMatchObject({ kind: 'sound', loss: 1130 });
    const lost = judge(search(['e8d8', { cp: -1000 }], ['e8f8', { cp: -1400 }]), null, mv('e8f8'), plain);
    expect(lost!.kind).toBe('sound');
  });

  it('calls the move that gives mate strong, and a move that ends in a draw as it finds it', () => {
    expect(judge(search(['d1d8', { mate: 1 }], ['a2a3', { cp: 900 }]), null, mv('d1d8'), { result: 'checkmate', recapture: false })!.kind).toBe('strong');
    // Stalemating a won game throws the win away.
    expect(judge(search(['d1d7', { cp: 900 }], ['d1d6', { cp: 880 }]), null, mv('d1c7'), { result: 'draw', recapture: false })).toMatchObject({ kind: 'blunder', after: 0 });
  });

  it('says nothing when there is nothing to go on', () => {
    expect(judge(null, null, mv('e2e4'), plain)).toBeNull();
    expect(judge(search(), null, mv('e2e4'), plain)).toBeNull();
    expect(judge(search(['e2e4', { cp: 40 }], ['d2d4', { cp: 35 }]), null, mv('g1f3'), plain)).toBeNull();
  });
});

describe('with the real engine', () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = new Engine(nodePort());
    await engine.start();
  }, 30000);
  afterAll(() => engine.close());

  const look = (fen: string) => engine.analyse(fen, { depth: 10, lines: 2 });

  it('finds taking a hanging queen strong', async () => {
    const game = new Game('rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1');
    const before = await look(game.fen());
    const e = game.move('f3', 'h4');
    const v = judge(before, await look(game.fen()), { from: 'f3', to: 'h4' }, { result: e.status.result, recapture: false });
    expect(v).toMatchObject({ kind: 'strong', wasBest: true });
  }, 30000);

  it('finds leaving mate on the board a blunder', async () => {
    // After 1.e4 e5 2.Qh5 Nc6 3.Bc4, the queen and bishop both aim at f7.
    const game = new Game('r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3');
    const before = await look(game.fen());
    const e = game.move('g8', 'f6');
    const v = judge(before, await look(game.fen()), { from: 'g8', to: 'f6' }, { result: e.status.result, recapture: false });
    expect(v!.kind).toBe('blunder');
    expect(v!.wasBest).toBe(false);
  }, 30000);

  it('finds an ordinary opening move sound', async () => {
    const game = new Game();
    const before = await look(game.fen());
    game.move('g1', 'f3');
    const v = judge(before, await look(game.fen()), { from: 'g1', to: 'f3' }, plain);
    expect(v!.kind).toBe('sound');
  }, 30000);

  it('chooses a legal move at every level, thinking or not', async () => {
    const game = new Game('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
    const legal = game.moves();
    const isLegal = (m: EngineMove | null) => m !== null && legal.some((l) => l.from === m.from && l.to === m.to);
    for (const level of LEVELS) {
      const quick = { ...level, ...(level.movetime ? { movetime: 150 } : {}) };
      // A roll of 0.99 is never a slip; a roll of 0 always is, at a level that slips at all.
      expect(isLegal(await chooseMove(engine, game.fen(), legal, quick, () => 0.99)), level.id).toBe(true);
      expect(isLegal(await chooseMove(engine, game.fen(), legal, quick, () => 0)), level.id).toBe(true);
    }
  }, 60000);

  it('mates in one at full strength, and may miss it when it plays without thinking', async () => {
    const game = new Game('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
    const master = LEVELS[LEVELS.length - 1]!;
    expect(await chooseMove(engine, game.fen(), game.moves(), { ...master, movetime: 200 })).toEqual({ from: 'a1', to: 'a8' });
    // The thoughtless move is taken from the list by the roll alone.
    const novice = LEVELS[0]!;
    const rolls = [0, 0.5];
    const careless = await chooseMove(engine, game.fen(), game.moves(), novice, () => rolls.shift() ?? 0);
    const legal = game.moves();
    expect(careless).toEqual(legal[Math.floor(0.5 * legal.length)]);
  }, 30000);

  it('promotes to a queen when it moves without thinking', async () => {
    const game = new Game('8/P6k/8/8/8/8/7K/8 w - - 0 1');
    const novice = LEVELS[0]!;
    for (const roll of [0, 0.3, 0.6, 0.99]) {
      const rolls = [0, roll];
      const m = await chooseMove(engine, game.fen(), game.moves(), novice, () => rolls.shift() ?? 0);
      if (m!.from === 'a7') expect(m!.promotion).toBe('q');
    }
  });
});

describe('the computer choosing a move', () => {
  it('has no move when there is none, and never plays one that is not legal', async () => {
    const lying = { analyse: async () => ({ best: { from: 'a1', to: 'h8' }, lines: [], depth: 1 }) } as unknown as Engine;
    expect(await chooseMove(lying, 'any', [], LEVELS[2]!)).toBeNull();
    const legal: EngineMove[] = [mv('e2e4'), mv('d2d4')];
    const chosen = await chooseMove(lying, 'any', legal, LEVELS[4]!, () => 0.99);
    expect(legal).toContainEqual(chosen);
  });
});
