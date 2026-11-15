/**
 * The engine is told the moves that led to a position, so that it knows what has stood before:
 * what is sent, where the line starts, and that the real engine takes it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Game, type Square } from '../src/core/game.ts';
import { chooseMove } from '../src/engine/opponent.ts';
import { Engine, LEVELS, uciOf } from '../src/engine/uci.ts';
import { nodePort } from './helpers/node-engine.ts';

/** An engine that answers every search with the same move, and keeps what it was sent. */
function recorder() {
  const sent: string[] = [];
  let onLine: (line: string) => void = () => {};
  const port = {
    send: (line: string) => {
      sent.push(line);
      if (line === 'uci') onLine('uciok');
      else if (line === 'isready') onLine('readyok');
      else if (line.startsWith('go')) onLine('bestmove e2e4');
    },
    listen: (fn: (line: string) => void) => (onLine = fn),
    close: () => {},
  };
  return { sent, engine: new Engine(port), positions: () => sent.filter((l) => l.startsWith('position')) };
}

const play = (game: Game, moves: string) => {
  for (const m of moves.split(' ')) game.move(m.slice(0, 2) as Square, m.slice(2, 4) as Square, m[4] as 'q' | undefined);
};

describe('the line the engine is shown', () => {
  it('is the start position and every move, until something cannot be undone', () => {
    const game = new Game();
    expect(game.engineLine()).toEqual({ fen: new Game().fen(), moves: [] });
    play(game, 'g1f3 g8f6 f3g1 f6g8');
    const line = game.engineLine();
    expect(line.fen).toBe(new Game().fen());
    expect(line.moves.map(uciOf)).toEqual(['g1f3', 'g8f6', 'f3g1', 'f6g8']);
  });

  it('starts again after a capture or a pawn move, with the count of quiet moves carried in the position', () => {
    const game = new Game();
    play(game, 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6');
    const line = game.engineLine();
    // The last pawn move was 1...e5: nothing before it can come round again.
    expect(line.fen).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
    expect(line.moves.map(uciOf)).toEqual(['g1f3', 'b8c6', 'f1c4', 'g8f6']);
    // And the line really does lead to the position on the board.
    const check = new Game(line.fen);
    for (const m of line.moves) check.move(m.from, m.to, m.promotion);
    expect(check.fen()).toBe(game.fen());
  });

  it('names castling by the king, and a promotion by its piece', () => {
    const game = new Game('r3k2r/6P1/8/8/8/8/8/R3K2R w KQkq - 0 1');
    play(game, 'e1g1 e8c8 g7g8q');
    // The promotion cannot be undone, so the line begins after it.
    expect(game.engineLine().moves).toEqual([]);
    expect(game.engineLine().fen).toBe(game.fen());
    const promoted = new Game('r3k2r/6P1/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(promoted.move('g7', 'g8', 'q').promotion).toBe('q');
    expect(uciOf({ from: 'g7', to: 'g8', promotion: 'q' })).toBe('g7g8q');
    const castled = new Game('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    play(castled, 'e1g1 e8c8');
    expect(castled.engineLine().moves.map(uciOf)).toEqual(['e1g1', 'e8c8']);
  });

  it('has no moves for a position that was set up or loaded, and keeps its fifty-move count', () => {
    const game = new Game('4k3/8/8/8/8/8/4R3/4K3 w - - 37 60');
    expect(game.engineLine()).toEqual({ fen: '4k3/8/8/8/8/8/4R3/4K3 w - - 37 60', moves: [] });
    play(game, 'e2e3 e8d8');
    const line = game.engineLine();
    expect(line.fen).toBe('4k3/8/8/8/8/8/4R3/4K3 w - - 37 60');
    expect(line.moves.map(uciOf)).toEqual(['e2e3', 'e8d8']);
    game.load('8/8/4k3/8/8/4K3/8/7R b - - 12 40');
    expect(game.engineLine()).toEqual({ fen: '8/8/4k3/8/8/4K3/8/7R b - - 12 40', moves: [] });
  });

  it('follows a move taken back', () => {
    const game = new Game();
    play(game, 'e2e4 e7e5 g1f3');
    game.undo();
    expect(game.engineLine().moves.map(uciOf)).toEqual([]);
    expect(game.engineLine().fen).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  });
});

describe('asking the engine', () => {
  it('sends the moves after the position, and nothing extra without any', async () => {
    const { sent, engine, positions } = recorder();
    await engine.analyse('startfen', { depth: 1 });
    await engine.analyse('startfen', { depth: 1, moves: [] });
    await engine.analyse('startfen', { depth: 1, moves: [{ from: 'e2', to: 'e4' }, { from: 'a7', to: 'a8', promotion: 'q' }] });
    expect(positions()).toEqual(['position fen startfen', 'position fen startfen', 'position fen startfen moves e2e4 a7a8q']);
    expect(sent.length).toBeGreaterThan(3);
  });

  it('shows the moves only to the levels that remember', async () => {
    const game = new Game();
    play(game, 'g1f3 g8f6 f3g1 f6g8');
    const setting = game.engineLine();
    const legal = game.moves();
    for (const level of LEVELS) {
      const { engine, positions } = recorder();
      await chooseMove(engine, game.fen(), legal, level, () => 0.99, setting);
      expect(positions(), level.id).toEqual([level.remembers ? `position fen ${setting.fen} moves g1f3 g8f6 f3g1 f6g8` : `position fen ${game.fen()}`]);
    }
    expect(LEVELS.filter((l) => l.remembers).map((l) => l.id)).toEqual(['strong', 'master']);
  });

  it('plays as before when it is given no line, or a lesson position with none', async () => {
    const lesson = new Game('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1');
    const { engine, positions } = recorder();
    const master = LEVELS[LEVELS.length - 1]!;
    await chooseMove(engine, lesson.fen(), lesson.moves(), master, () => 0.99);
    await chooseMove(engine, lesson.fen(), lesson.moves(), master, () => 0.99, lesson.engineLine());
    expect(positions()).toEqual([`position fen ${lesson.fen()}`, `position fen ${lesson.fen()}`]);
  });
});

describe('the real engine given a game', () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = new Engine(nodePort());
    await engine.start();
  }, 30000);
  afterAll(() => engine.close());

  it('takes a line with castling, a capture in passing, and plays a legal move from it', async () => {
    const game = new Game();
    play(game, 'e2e4 a7a6 e4e5 d7d5 e5d6 b8c6 g1f3 c8e6 f1e2 d8d7 e1g1 e8c8');
    // The engine is shown the line from the capture in passing; a misread move would put it on another position.
    const line = game.engineLine();
    expect(line.moves.map(uciOf)).toEqual(['b8c6', 'g1f3', 'c8e6', 'f1e2', 'd8d7', 'e1g1', 'e8c8']);
    const found = await engine.analyse(line.fen, { depth: 6, moves: line.moves });
    const legal = game.moves();
    expect(legal.some((m) => m.from === found.best!.from && m.to === found.best!.to)).toBe(true);
  }, 30000);

  it('is not led astray by a long shuffle, and still finds a mate in one from the end of it', async () => {
    const game = new Game('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
    play(game, 'g1f1 g8f8 f1g1 f8g8');
    const line = game.engineLine();
    expect(line.moves).toHaveLength(4);
    const found = await engine.analyse(line.fen, { depth: 8, moves: line.moves });
    expect(found.best).toEqual({ from: 'a1', to: 'a8' });
    expect(found.lines[0]!.score.mate).toBe(1);
  }, 30000);
});
