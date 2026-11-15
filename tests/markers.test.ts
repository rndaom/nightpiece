import { describe, expect, it } from 'vitest';
import type { Square } from '../src/core/game';
import { isPale } from '../src/scene/markers';

const SQUARES: Square[] = [];
for (const file of 'abcdefgh') for (const rank of '12345678') SQUARES.push(`${file}${rank}` as Square);

describe('which squares are pale', () => {
  it("has a dark square in each player's left-hand corner", () => {
    expect(isPale('a1')).toBe(false);
    expect(isPale('h8')).toBe(false);
    expect(isPale('h1')).toBe(true);
    expect(isPale('a8')).toBe(true);
  });

  it('puts each queen on her own colour', () => {
    expect(isPale('d1')).toBe(true);
    expect(isPale('d8')).toBe(false);
  });

  it('splits the board evenly, and no two neighbours match', () => {
    expect(SQUARES.filter(isPale)).toHaveLength(32);
    for (const square of SQUARES) {
      const file = square.charCodeAt(0);
      const rank = square.charCodeAt(1);
      if (file < 104) expect(isPale(`${String.fromCharCode(file + 1)}${String.fromCharCode(rank)}` as Square)).toBe(!isPale(square));
      if (rank < 56) expect(isPale(`${String.fromCharCode(file)}${String.fromCharCode(rank + 1)}` as Square)).toBe(!isPale(square));
    }
  });
});
