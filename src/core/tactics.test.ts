import { describe, expect, it } from 'vitest';
import { Game, type Square } from './game';

const play = (fen: string, from: Square, to: Square) => new Game(fen).move(from, to);
const kinds = (fen: string, from: Square, to: Square) => play(fen, from, to).motifs.map((m) => m.kind);

describe('what a move does beyond moving', () => {
  it('sees a knight fork of king and rook', () => {
    const e = play('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', 'd5', 'c7');
    const fork = e.motifs.find((m) => m.kind === 'fork');
    expect(fork).toMatchObject({ kind: 'fork', by: 'c7' });
    expect(fork && fork.kind === 'fork' && [...fork.targets].sort()).toEqual(['a8', 'e8']);
  });

  it('sees a pawn fork of two pieces', () => {
    // The pawn is backed up, so the bishop cannot simply take it.
    expect(kinds('4k3/8/2n1b3/8/2PP4/8/8/4K3 w - - 0 1', 'd4', 'd5')).toContain('fork');
    expect(kinds('4k3/8/2n1b3/8/3P4/8/8/4K3 w - - 0 1', 'd4', 'd5')).not.toContain('fork');
  });

  it('does not call it a fork when the forking piece is simply lost', () => {
    // The knight lands where a pawn takes it.
    expect(kinds('r3k3/1p6/8/3N4/8/8/8/4K3 w - - 0 1', 'd5', 'c7')).toContain('fork');
    expect(kinds('r3k3/8/1p6/1N6/8/8/8/4K3 w - - 0 1', 'b5', 'c7')).toContain('fork');
    expect(kinds('r2bk3/8/8/3N4/8/8/8/4K3 w - - 0 1', 'd5', 'c7')).not.toContain('fork');
  });

  it('does not call an attack on one piece, or on defended pawns, a fork', () => {
    expect(kinds('4k3/p7/8/3N4/8/8/P7/4K3 w - - 0 1', 'd5', 'c7')).toEqual([]);
    expect(kinds('4k3/pp6/8/8/1N6/8/8/4K3 w - - 0 1', 'b4', 'c6')).not.toContain('fork');
  });

  it('sees a pin against the king', () => {
    const e = play('4k3/8/2n5/8/8/8/8/3BK3 w - - 0 1', 'd1', 'a4');
    expect(e.motifs).toContainEqual({ kind: 'pin', by: 'a4', pinned: 'c6', behind: 'e8' });
  });

  it('sees a pin against a queen, but not one piece merely standing in front of a lesser one', () => {
    expect(kinds('3qk3/8/3n4/8/8/8/8/R3K3 w - - 0 1', 'a1', 'd1')).toContain('pin');
    expect(kinds('3nk3/8/3q4/8/8/8/8/R3K3 w - - 0 1', 'a1', 'd1')).not.toContain('pin');
  });

  it('sees a discovered check', () => {
    // The bishop steps off the e-file and the rook behind it gives check.
    const e = play('4k3/8/8/8/4B3/8/8/4RK2 w - - 0 1', 'e4', 'b7');
    expect(e.status.inCheck).toBe(true);
    expect(e.motifs).toContainEqual({ kind: 'discovered', by: 'e1', target: 'e8' });
  });

  it('sees a discovered attack on a loose piece, and not when the line was already open', () => {
    expect(kinds('4k3/8/3r4/8/3N4/8/8/3RK3 w - - 0 1', 'd4', 'f5')).toContain('discovered');
    expect(kinds('4k3/8/3r4/8/5N2/8/8/3RK3 w - - 0 1', 'f4', 'h5')).not.toContain('discovered');
  });

  it('calls a piece left to be taken a sacrifice only when the move forces something', () => {
    // A bishop takes on h7 with check, where the king can take it.
    const offered = play('5rk1/5ppp/8/8/8/3B4/8/4K3 w - - 0 1', 'd3', 'h7');
    expect(offered.status.inCheck).toBe(true);
    expect(offered.exposure).toBe(3);
    expect(offered.gained).toBe(1);
    expect(offered.motifs).toContainEqual({ kind: 'sacrifice', piece: 'h7' });
    // A queen simply left where a pawn takes it is not a sacrifice. It is a blunder.
    const blunder = play('6k1/8/3p4/8/8/8/8/Q3K3 w - - 0 1', 'a1', 'e5');
    expect(blunder.exposure).toBe(9);
    expect(blunder.motifs).toEqual([]);
  });

  it('reports what a capture won and what it risked', () => {
    const safe = play('4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1', 'c3', 'd5');
    expect(safe).toMatchObject({ gained: 9, exposure: 0 });
    const traded = play('4k3/8/2p5/3n4/8/2N5/8/4K3 w - - 0 1', 'c3', 'd5');
    expect(traded).toMatchObject({ gained: 3, exposure: 3 });
  });

  it('says nothing once the game is over', () => {
    const mate = play('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a8');
    expect(mate.status.result).toBe('checkmate');
    expect(mate.motifs).toEqual([]);
  });
});
