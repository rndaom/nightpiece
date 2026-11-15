import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { Game, type Square } from '../src/core/game';
import { pgnResult, writePgn } from '../src/core/pgn';

function played(moves: string, fen?: string): Game {
  const game = new Game(fen);
  for (const m of moves.split(' ').filter(Boolean)) game.move(m.slice(0, 2) as Square, m.slice(2, 4) as Square, (m[4] as 'q' | 'r' | 'b' | 'n' | undefined) ?? undefined);
  return game;
}

const day = new Date(2026, 10, 10);

describe('a game written out for other chess programs', () => {
  it('opens with the seven tags, in their order', () => {
    const text = writePgn(played('e2e4 e7e5 g1f3'), { event: 'Nightpiece', white: 'Ivory', black: 'Void', date: day });
    expect(text.split('\n').slice(0, 8)).toEqual(['[Event "Nightpiece"]', '[Site "?"]', '[Date "2026.11.10"]', '[Round "-"]', '[White "Ivory"]', '[Black "Void"]', '[Result "*"]', '']);
  });

  it('numbers the moves and marks a game still going with a star', () => {
    const text = writePgn(played('e2e4 e7e5 g1f3'), { date: day });
    expect(text.endsWith('\n\n1. e4 e5 2. Nf3 *\n')).toBe(true);
  });

  it('writes a game with nothing played yet', () => {
    expect(writePgn(new Game(), { date: day }).endsWith('\n\n*\n')).toBe(true);
  });

  it('gives a checkmate to the side that delivered it', () => {
    const game = played('f2f3 e7e5 g2g4 d8h4');
    expect(pgnResult(game.status())).toBe('0-1');
    const text = writePgn(game, { date: day });
    expect(text).toContain('[Result "0-1"]');
    expect(text.endsWith('1. f3 e5 2. g4 Qh4# 0-1\n')).toBe(true);
  });

  it('says a resignation in the result and in words', () => {
    const game = played('e2e4 e7e5');
    game.resign('w');
    const text = writePgn(game, { date: day });
    expect(text).toContain('[Result "0-1"]');
    expect(text.endsWith('1. e4 e5 {White resigns} 0-1\n')).toBe(true);
    const other = played('e2e4');
    other.resign('b');
    expect(writePgn(other, { date: day }).endsWith('1. e4 {Black resigns} 1-0\n')).toBe(true);
  });

  it('says a draw the players agreed', () => {
    const game = played('e2e4 e7e5');
    game.agreeDraw();
    const text = writePgn(game, { date: day });
    expect(text).toContain('[Result "1/2-1/2"]');
    expect(text.endsWith('1. e4 e5 {Draw agreed} 1/2-1/2\n')).toBe(true);
  });

  it('writes a draw on the board without a comment', () => {
    // Stalemate: the Void king has no move and is not in check.
    const game = played('g5g6', '7k/5K2/8/6Q1/8/8/8/8 w - - 0 50');
    expect(game.status().drawReason).toBe('stalemate');
    const text = writePgn(game, { date: day });
    expect(text).toContain('[Result "1/2-1/2"]');
    expect(text.endsWith('\n\n50. Qg6 1/2-1/2\n')).toBe(true);
    expect(text).not.toContain('{');
  });

  it('gives the position a game began from, and starts the count where that position does', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 b - - 0 12';
    const text = writePgn(played('e8d8 e2e4 d8c8', fen), { date: day });
    expect(text).toContain('[SetUp "1"]');
    expect(text).toContain(`[FEN "${fen}"]`);
    expect(text.endsWith('\n\n12... Kd8 13. e4 Kc8 *\n')).toBe(true);
  });

  it('leaves the position out when the game began from the usual one', () => {
    expect(writePgn(played('e2e4'), { date: day })).not.toContain('FEN');
  });

  it('keeps a quote or a backslash in a name from breaking the tag', () => {
    const text = writePgn(new Game(), { white: 'The "Count"', black: 'a\\b', date: day });
    expect(text).toContain('[White "The \\"Count\\""]');
    expect(text).toContain('[Black "a\\\\b"]');
  });

  it('keeps every line under eighty characters, however long the game', () => {
    const game = played('e2e4 e7e5 f1c4 f8c5 d2d3 d7d6 c1g5 c8g4 g1f3 g8f6 b1c3 b8c6 a2a3 a7a6 h2h3 h7h6 g5h4 g4h5 c4a2 c5a7 d1d2 d8d7 a1b1 a8b8 h1g1 h8g8 c3d5 c6d4');
    const text = writePgn(game, { date: day });
    const lines = text.split('\n');
    const moves = lines.slice(lines.indexOf('') + 1).filter(Boolean);
    expect(moves.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    // Nothing is lost at the breaks: put back together, it is the whole game.
    const words = moves.join(' ').split(' ');
    expect(words.filter((w) => !/^\d+\.$/.test(w))).toEqual([...game.history().map((e) => e.san), '*']);
  });

  it('can be read back by another program, move for move', () => {
    const game = played('e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6 c1e3 e7e5 d4b3 c8e6 f2f3 f8e7 d1d2 e8g8 e1c1 b8d7');
    const reader = new Chess();
    reader.loadPgn(writePgn(game, { event: 'Nightpiece', white: 'Ivory', black: 'Void', date: day }));
    expect(reader.history()).toEqual(game.history().map((e) => e.san));
    expect(reader.fen()).toBe(game.fen());
    expect(reader.getHeaders().White).toBe('Ivory');
  });

  it('can be read back from a set position, with a promotion and a capture in passing', () => {
    const fen = '4k3/1P6/8/8/5p2/8/4P3/4K3 w - - 0 30';
    const game = played('e2e4 f4e3 b7b8q e8e7', fen);
    const reader = new Chess();
    reader.loadPgn(writePgn(game, { date: day }));
    expect(reader.history()).toEqual(['e4', 'fxe3', 'b8=Q+', 'Ke7']);
    expect(reader.fen()).toBe(game.fen());
  });
});
