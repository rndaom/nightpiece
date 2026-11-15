/**
 * The names of the openings: every line in the book is a real one, and a
 * game is told the name of where it has got to.
 */
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { OPENING_PLIES, openingLines, openingOf, prepareOpenings } from '../src/learn/openings.ts';

const key = (fen: string) => fen.split(' ').slice(0, 3).join(' ');

describe('the book of openings', () => {
  it('holds only lines that can be played from the usual start, none longer than the game looks', () => {
    const lines = openingLines();
    expect(lines.length).toBeGreaterThan(100);
    for (const [line, name] of lines) {
      const sans = line.split(' ');
      expect(sans.length, line).toBeLessThanOrEqual(OPENING_PLIES);
      expect(name.trim(), line).not.toBe('');
      const chess = new Chess();
      for (const san of sans) {
        // What is written is what the rules would write: no move spelled a second way.
        expect(() => chess.move(san), `${line}: ${san}`).not.toThrow();
        expect(chess.history().at(-1), `${line}: ${san}`).toBe(san);
      }
    }
  });

  it('gives each position one name', () => {
    const seen = new Map<string, string>();
    for (const [line, name] of openingLines()) {
      const chess = new Chess();
      for (const san of line.split(' ')) chess.move(san);
      const at = key(chess.fen());
      expect(seen.get(at) ?? name, `${line} is also ${seen.get(at)}`).toBe(name);
      seen.set(at, name);
    }
  });
});

describe('naming a game', () => {
  it('says nothing before the first move', () => {
    expect(openingOf([])).toBeNull();
  });

  it('can be made ready ahead of the first move, as often as it is asked', () => {
    expect(() => {
      prepareOpenings();
      prepareOpenings();
    }).not.toThrow();
    expect(openingOf(['e4'])).toEqual({ name: "King's Pawn Opening", ply: 1 });
  });

  it('names the position reached, and when it was reached', () => {
    expect(openingOf(['e4'])).toEqual({ name: "King's Pawn Opening", ply: 1 });
    expect(openingOf(['e4', 'c5'])).toEqual({ name: 'Sicilian Defence', ply: 2 });
    expect(openingOf(['d4', 'd5', 'c4'])).toEqual({ name: "Queen's Gambit", ply: 3 });
    expect(openingOf(['f3', 'e5', 'g4', 'Qh4#'])).toEqual({ name: "Fool's Mate", ply: 4 });
  });

  it('knows a position by its stones, whatever order the moves came in', () => {
    // The Italian Game by way of the Bishop's Opening.
    expect(openingOf(['e4', 'e5', 'Bc4', 'Nc6', 'Nf3'])).toEqual({ name: 'Italian Game', ply: 5 });
  });

  it('keeps the last name once the game has left the book', () => {
    expect(openingOf(['e4', 'c5', 'a3', 'a6'])).toEqual({ name: 'Sicilian Defence', ply: 2 });
  });

  it('looks no further than the first dozen moves', () => {
    const chess = new Chess();
    const sans: string[] = [];
    // Knights out and back, over and over: the start position comes round again, well past the twelfth move.
    for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nc3', 'Nc6', 'Nb1', 'Nb8', 'e4', 'c5']) {
      chess.move(san);
      sans.push(san);
    }
    const found = openingOf(sans);
    expect(found?.ply ?? 0).toBeLessThanOrEqual(OPENING_PLIES);
    expect(found?.name).not.toBe('Sicilian Defence');
  });

  it('says nothing of a game whose moves do not fit the usual start', () => {
    expect(openingOf(['Qh5'])).toBeNull();
    expect(openingOf(['e4', 'e5', 'Ke3'])).toBeNull();
  });
});
