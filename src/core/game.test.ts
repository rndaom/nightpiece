import { Chess } from 'chess.js';
import { describe, expect, it, vi } from 'vitest';
import { Game, IllegalMoveError, type MoveEvent, type PromotionKind, type Square } from './game';

/** Play moves written as "e2e4 e7e5 a7a8q". */
function play(g: Game, line: string): MoveEvent[] {
  return line
    .trim()
    .split(/\s+/)
    .map((tok) => g.move(tok.slice(0, 2) as Square, tok.slice(2, 4) as Square, tok[4] as PromotionKind | undefined));
}
const targets = (g: Game, sq: Square) => g.movesFrom(sq).map((m) => m.to).sort();
const option = (g: Game, from: Square, to: Square) => g.movesFrom(from).find((m) => m.to === to);

describe('starting position', () => {
  it('has 32 pieces with unique identities, Ivory on ids 0 to 15', () => {
    const g = new Game();
    const ps = g.pieces();
    expect(ps).toHaveLength(32);
    expect(new Set(ps.map((p) => p.id)).size).toBe(32);
    expect(ps.slice(0, 16).every((p) => p.side === 'w')).toBe(true);
    expect(ps.slice(16).every((p) => p.side === 'b')).toBe(true);
    expect(g.pieceAt('e1')).toMatchObject({ id: 4, kind: 'k', side: 'w' });
    expect(g.pieceAt('h1')).toMatchObject({ id: 7, kind: 'r' });
    expect(g.pieceAt('d7')).toMatchObject({ id: 19, kind: 'p', side: 'b' });
  });

  it('offers exactly 20 moves to the side to move and none to the other', () => {
    const g = new Game();
    const total = g.pieces().reduce((n, p) => n + g.movesFrom(p.square).length, 0);
    expect(total).toBe(20);
    expect(targets(g, 'g1')).toEqual(['f3', 'h3']);
    expect(g.movesFrom('e7')).toEqual([]);
    expect(g.canMove('e2')).toBe(true);
    expect(g.canMove('e1')).toBe(false);
  });
});

describe('move generation matches published perft counts', () => {
  const cases: [string, string, number[]][] = [
    ['start', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902]],
    ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039]],
    ['endgame', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812]],
    ['promotions', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
    ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486]],
  ];
  for (const [name, fen, counts] of cases) {
    it(name, () => {
      const g = new Game(fen);
      counts.forEach((n, i) => expect(g.perft(i + 1)).toBe(n));
    });
  }
});

describe('castling', () => {
  const open = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';

  it('moves king and rook together, kingside, from a real game', () => {
    const g = new Game();
    const events = play(g, 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1');
    const e = events[events.length - 1]!;
    expect(e.san).toBe('O-O');
    expect(e.castle).toBe('k');
    expect(e.rook).toEqual({ id: 7, from: 'h1', to: 'f1' });
    expect(g.pieceAt('g1')).toMatchObject({ id: 4, kind: 'k' });
    expect(g.pieceAt('f1')).toMatchObject({ id: 7, kind: 'r' });
    expect(g.pieceAt('e1')).toBeNull();
    expect(g.pieceAt('h1')).toBeNull();
  });

  it('works on all four wings', () => {
    let g = new Game(open);
    expect(g.move('e1', 'c1').rook).toMatchObject({ from: 'a1', to: 'd1' });
    expect(g.move('e8', 'g8').rook).toMatchObject({ from: 'h8', to: 'f8' });
    g = new Game(open);
    expect(g.move('e1', 'g1').rook).toMatchObject({ from: 'h1', to: 'f1' });
    expect(g.move('e8', 'c8').rook).toMatchObject({ from: 'a8', to: 'd8' });
    expect(g.pieceAt('c8')?.kind).toBe('k');
    expect(g.pieceAt('d8')?.kind).toBe('r');
  });

  it('is marked as castling in the move options', () => {
    const g = new Game(open);
    expect(option(g, 'e1', 'g1')?.castle).toBe('k');
    expect(option(g, 'e1', 'c1')?.castle).toBe('q');
    expect(option(g, 'e1', 'e2')?.castle).toBeNull();
  });

  it('is refused through an attacked square but allowed on the other wing', () => {
    const g = new Game('r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1');
    expect(targets(g, 'e1')).not.toContain('g1');
    expect(targets(g, 'e1')).toContain('c1');
  });

  it('is refused while in check', () => {
    const g = new Game('r3k2r/8/8/8/8/4r3/8/R3K2R w KQkq - 0 1');
    expect(g.status().inCheck).toBe(true);
    expect(targets(g, 'e1')).not.toContain('g1');
    expect(targets(g, 'e1')).not.toContain('c1');
  });

  it('is lost for good once the king has moved', () => {
    const g = new Game(open);
    play(g, 'e1e2 e8e7 e2e1 e7e8');
    expect(targets(g, 'e1')).not.toContain('g1');
    expect(targets(g, 'e1')).not.toContain('c1');
    expect(() => g.move('e1', 'g1')).toThrow(IllegalMoveError);
  });
});

describe('en passant', () => {
  it('removes the pawn that is not on the destination square', () => {
    const g = new Game();
    play(g, 'e2e4 a7a6 e4e5 d7d5');
    expect(option(g, 'e5', 'd6')).toMatchObject({ capture: true, enPassant: true });
    const e = g.move('e5', 'd6');
    expect(e.enPassant).toBe(true);
    expect(e.captured).toEqual({ id: 19, kind: 'p', square: 'd5' });
    expect(g.pieceAt('d5')).toBeNull();
    expect(g.pieceAt('d6')).toMatchObject({ id: 12, kind: 'p', side: 'w' });
    expect(g.pieces()).toHaveLength(31);
  });

  it('is only available on the very next move', () => {
    const g = new Game();
    play(g, 'e2e4 a7a6 e4e5 d7d5 h2h3 h7h6');
    expect(targets(g, 'e5')).toEqual(['e6']);
    expect(() => g.move('e5', 'd6')).toThrow(IllegalMoveError);
  });
});

describe('promotion', () => {
  const fen = '8/P6k/8/8/8/8/7K/8 w - - 0 1';

  it('requires a piece to be chosen', () => {
    const g = new Game(fen);
    expect(g.movesFrom('a7')).toEqual([
      { from: 'a7', to: 'a8', capture: false, enPassant: false, castle: null, promotion: true, risky: false },
    ]);
    expect(() => g.move('a7', 'a8')).toThrow(IllegalMoveError);
    expect(g.pieceAt('a7')?.kind).toBe('p');
  });

  it.each(['q', 'r', 'b', 'n'] as PromotionKind[])('promotes to %s and keeps the identity', (kind) => {
    const g = new Game(fen);
    const id = g.pieceAt('a7')!.id;
    const e = g.move('a7', 'a8', kind);
    expect(e.promotion).toBe(kind);
    expect(e.piece.kind).toBe('p');
    expect(g.pieceAt('a8')).toMatchObject({ id, kind, side: 'w' });
  });

  it('can capture while promoting, and undo restores both pieces', () => {
    const g = new Game('1r5k/P7/8/8/8/8/7K/8 w - - 0 1');
    const before = g.pieces();
    const rookId = g.pieceAt('b8')!.id;
    const e = g.move('a7', 'b8', 'q');
    expect(e.san).toBe('axb8=Q+');
    expect(e.captured).toEqual({ id: rookId, kind: 'r', square: 'b8' });
    expect(e.status.inCheck).toBe(true);
    expect(g.pieceAt('b8')?.kind).toBe('q');
    g.undo();
    expect(g.pieces()).toEqual(before);
    expect(g.fen()).toBe('1r5k/P7/8/8/8/8/7K/8 w - - 0 1');
  });
});

describe('check and checkmate', () => {
  it('reports check with the king that is attacked', () => {
    const g = new Game();
    const e = play(g, 'e2e4 f7f6 d1h5').pop()!;
    expect(e.status).toMatchObject({ inCheck: true, checkedKing: 'e8', over: false, turn: 'b' });
    expect(targets(g, 'g7')).toEqual(['g6']);
  });

  it("recognises fool's mate for Void", () => {
    const g = new Game();
    play(g, 'f2f3 e7e5 g2g4 d8h4');
    expect(g.status()).toEqual({
      turn: 'w',
      inCheck: true,
      checkedKing: 'e1',
      checkers: ['h4'],
      over: true,
      result: 'checkmate',
      winner: 'b',
      drawReason: null,
      claimable: null,
    });
    expect(g.pieces().flatMap((p) => g.movesFrom(p.square))).toEqual([]);
    expect(() => g.move('e1', 'f2')).toThrow(IllegalMoveError);
  });

  it("recognises scholar's mate for Ivory", () => {
    const g = new Game();
    const e = play(g, 'e2e4 e7e5 d1h5 b8c6 f1c4 g8f6 h5f7').pop()!;
    expect(e.san).toBe('Qxf7#');
    expect(e.status).toMatchObject({ result: 'checkmate', winner: 'w', checkedKing: 'e8' });
  });
});

describe("the squares round a king", () => {
  it('shows a stalemated king hemmed in with nothing on him', () => {
    // From a real game: queen, rook and bishop cover every square, and none of them gives check.
    const game = new Game('5Q2/7k/5R2/4K2B/8/P7/8/8 b - - 0 1');
    expect(game.status()).toMatchObject({ over: true, result: 'draw', drawReason: 'stalemate', inCheck: false, checkedKing: null });
    const flights = game.kingFlights();
    expect(flights.map((f) => f.square).sort()).toEqual(['g6', 'g7', 'g8', 'h6', 'h8']);
    expect(flights.every((f) => f.covered)).toBe(true);
    // One square further with the rook the move before, and it was mate.
    const before = new Game('5Q2/7k/8/4KR1B/8/P7/8/8 w - - 0 1');
    expect(before.move('f5', 'f7').status).toMatchObject({ result: 'checkmate', winner: 'w' });
  });

  it('leaves out squares the king\'s own pieces stand on, and says which of the rest are safe', () => {
    expect(new Game().kingFlights()).toEqual([]);
    const game = new Game('4k3/8/8/8/8/8/3r4/4K3 w - - 0 1');
    const flights = Object.fromEntries(game.kingFlights().map((f) => [f.square, f.covered]));
    // The rook covers its own file and row; it is itself undefended, so its square is free to take.
    expect(flights).toEqual({ d1: true, d2: false, e2: true, f1: false, f2: true });
  });
});

describe('draws', () => {
  it('stalemate', () => {
    const g = new Game('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(g.status()).toMatchObject({ over: true, result: 'draw', drawReason: 'stalemate', inCheck: false, winner: null });
  });

  it.each([
    ['king against king', '8/8/8/8/8/8/8/K6k w - - 0 1'],
    ['king and bishop against king', '8/8/8/8/8/8/8/KB5k w - - 0 1'],
    ['king and knight against king', '8/8/8/8/8/8/8/KN5k w - - 0 1'],
  ])('insufficient material: %s', (_name, fen) => {
    expect(new Game(fen).status()).toMatchObject({ over: true, result: 'draw', drawReason: 'insufficient' });
  });

  it('a rook is enough material to play on', () => {
    expect(new Game('8/8/8/8/8/8/R7/K6k w - - 0 1').status().over).toBe(false);
  });

  it('threefold repetition: a draw the player to move may claim, not one that happens by itself', () => {
    const g = new Game();
    play(g, 'g1f3 g8f6 f3g1');
    expect(g.claimDraw()).toBe(false);
    play(g, 'f6g8 g1f3 g8f6 f3g1');
    expect(g.status()).toMatchObject({ over: false, claimable: null });
    const e = g.move('f6', 'g8');
    expect(e.status).toMatchObject({ over: false, claimable: 'threefold' });
    expect(g.claimDraw()).toBe(true);
    expect(g.status()).toMatchObject({ over: true, result: 'draw', drawReason: 'threefold', claimable: null });
    expect(g.drawClaimed()).toBe('threefold');
    expect(() => g.move('e2', 'e4')).toThrow(IllegalMoveError);
  });

  it('fivefold repetition ends the game by itself', () => {
    const g = new Game();
    const round = 'g1f3 g8f6 f3g1 f6g8';
    play(g, `${round} ${round} ${round}`);
    expect(g.status()).toMatchObject({ over: false, claimable: 'threefold' });
    play(g, 'g1f3 g8f6 f3g1');
    expect(g.status().over).toBe(false);
    const e = g.move('f6', 'g8');
    expect(e.status).toMatchObject({ over: true, result: 'draw', drawReason: 'fivefold' });
  });

  it('fifty-move rule: claimable at the hundredth quiet move, and the game ends by itself at the hundred and fiftieth', () => {
    const g = new Game('8/8/8/8/8/5k2/R7/4K3 w - - 99 80');
    expect(g.status()).toMatchObject({ over: false, claimable: null });
    const e = g.move('a2', 'b2');
    expect(e.status).toMatchObject({ over: false, claimable: 'fifty-move' });
    const late = new Game('8/8/8/8/8/5k2/R7/4K3 w - - 149 105');
    expect(late.status()).toMatchObject({ over: false, claimable: 'fifty-move' });
    expect(late.move('a2', 'b2').status).toMatchObject({ over: true, result: 'draw', drawReason: 'seventy-five-move' });
    // Claimed in time, the reason is the claim's.
    expect(g.claimDraw()).toBe(true);
    expect(g.status()).toMatchObject({ over: true, drawReason: 'fifty-move' });
  });

  it('a claim taken back with the move before it is forgotten, and can be made again', () => {
    const g = new Game();
    play(g, 'g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8');
    expect(g.claimDraw()).toBe(true);
    g.undo();
    expect(g.status()).toMatchObject({ over: false, claimable: null });
    expect(g.drawClaimed()).toBeNull();
    g.move('f6', 'g8');
    expect(g.status().claimable).toBe('threefold');
    expect(g.reopen()).toBe(false);
    expect(g.claimDraw()).toBe(true);
    // Reopened (a take-back of a game ended off the board), the claim can be made again.
    expect(g.reopen()).toBe(true);
    expect(g.status()).toMatchObject({ over: false, claimable: 'threefold' });
  });

  it('who could still mate, should the other run out of time (FIDE 6.9)', () => {
    const could = (fen: string, side: 'w' | 'b') => new Game(fen).couldMate(side);
    // A bare king, a lone bishop, a lone knight cannot.
    expect(could('4k3/8/8/8/8/8/8/Q3K3 w - - 0 1', 'b')).toBe(false);
    expect(could('4kb2/8/8/8/8/8/8/Q3K3 w - - 0 1', 'b')).toBe(false);
    expect(could('4kn2/8/8/8/8/8/8/Q3K3 w - - 0 1', 'b')).toBe(false);
    // A knight can if the other king has something of its own to be hemmed in by (not a queen alone).
    expect(could('4kn2/8/8/8/8/8/8/R3K3 w - - 0 1', 'b')).toBe(true);
    expect(could('4kn2/8/8/8/8/8/P7/4K3 w - - 0 1', 'b')).toBe(true);
    // Two knights can, with help; two bishops on one colour cannot, on two colours they can.
    expect(could('4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1', 'w')).toBe(true);
    expect(could('4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1', 'w')).toBe(true);
    expect(could('4k3/8/8/8/8/8/1B6/2B1K3 w - - 0 1', 'w')).toBe(false);
    // A bishop can if there is a pawn or a knight anywhere, or a bishop of the other colour.
    expect(could('4k3/p7/8/8/8/8/8/2B1K3 w - - 0 1', 'w')).toBe(true);
    expect(could('4k1b1/8/8/8/8/8/8/2B1K3 w - - 0 1', 'w')).toBe(true);
    expect(could('4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1', 'w')).toBe(false);
    // A pawn, a rook or a queen always can.
    expect(could('4k3/8/8/8/8/8/P7/4K3 w - - 0 1', 'w')).toBe(true);
    expect(could('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'w')).toBe(true);
  });

  it('a draw on time ends the game, and is forgotten if the game is taken back', () => {
    const g = new Game('4k3/8/8/8/8/8/8/Q3K3 w - - 0 1');
    expect(g.drawOnTime()).toBe(true);
    expect(g.status()).toMatchObject({ over: true, result: 'draw', drawReason: 'timeout', winner: null });
    expect(g.drawOnTime()).toBe(false);
    expect(g.endedOffBoard()).toBe(true);
    expect(g.reopen()).toBe(true);
    expect(g.status().over).toBe(false);
  });
});

describe('undo', () => {
  it('restores position and identities through en passant, castling and promotion', () => {
    const fen = 'r3k2r/1P6/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1';
    const g = new Game(fen);
    const before = g.pieces();
    const events = play(g, 'e5d6 e8g8 b7a8q f8a8 e1c1');
    expect(events.map((e) => e.san)).toEqual(['exd6', 'O-O', 'bxa8=Q', 'Rxa8', 'O-O-O']);
    expect(g.captured()).toEqual({ w: ['q'], b: ['p', 'r'] });
    expect(g.history()).toHaveLength(5);

    const undone: string[] = [];
    for (let e = g.undo(); e; e = g.undo()) undone.push(e.san);
    expect(undone).toEqual(['O-O-O', 'Rxa8', 'bxa8=Q', 'O-O', 'exd6']);
    expect(g.fen()).toBe(fen);
    expect(g.pieces()).toEqual(before);
    expect(g.history()).toEqual([]);
    expect(g.undo()).toBeNull();
  });

  it('reopens a finished game', () => {
    const g = new Game();
    play(g, 'f2f3 e7e5 g2g4 d8h4');
    g.undo();
    expect(g.status()).toMatchObject({ over: false, turn: 'b' });
    expect(targets(g, 'd8')).toContain('h4');
  });
});

describe('move options for the beginner aids', () => {
  it('gives a pinned piece no moves', () => {
    const g = new Game('4k3/8/8/8/4r3/8/4N3/4K3 w - - 0 1');
    expect(g.movesFrom('e2')).toEqual([]);
  });

  it('flags squares where the moved piece would simply be lost', () => {
    const g = new Game('6k1/8/8/3p4/8/8/4Q3/4K3 w - - 0 1');
    expect(option(g, 'e2', 'e4')?.risky).toBe(true);
    expect(option(g, 'e2', 'c4')?.risky).toBe(true);
    expect(option(g, 'e2', 'd3')?.risky).toBe(false);
    expect(option(g, 'e2', 'b5')?.risky).toBe(false);
  });

  it('does not flag an even trade or a winning capture', () => {
    const trade = new Game('6k1/8/2p5/3n4/8/2N5/8/6K1 w - - 0 1');
    expect(option(trade, 'c3', 'd5')).toMatchObject({ capture: true, risky: false });
    const win = new Game('6k1/8/8/3q4/8/2N5/8/6K1 w - - 0 1');
    expect(option(win, 'c3', 'd5')).toMatchObject({ capture: true, risky: false });
  });

  it('flags a capture that costs more than it wins', () => {
    const g = new Game('6k1/8/2p5/3p4/8/8/3Q4/6K1 w - - 0 1');
    expect(option(g, 'd2', 'd5')).toMatchObject({ capture: true, risky: true });
  });

  it('flags a defended square when the attacker is worth less than the piece', () => {
    const g = new Game('6k1/8/8/8/1b6/8/1P6/R5K1 w - - 0 1');
    expect(option(g, 'a1', 'a3')?.risky).toBe(true);
    expect(option(g, 'a1', 'a2')?.risky).toBe(false);
  });

  it('leaves the position untouched after computing options', () => {
    const g = new Game();
    play(g, 'e2e4 d7d5');
    const fen = g.fen();
    g.pieces().forEach((p) => g.movesFrom(p.square));
    expect(g.fen()).toBe(fen);
    expect(g.history()).toHaveLength(2);
  });

  it('flags a double step that loses the pawn en passant, unless it can be won back', () => {
    const lost = new Game('4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1');
    expect(option(lost, 'e2', 'e4')?.risky).toBe(true);
    expect(option(lost, 'e2', 'e3')?.risky).toBe(true); // an ordinary capture, for comparison
    const defended = new Game('4k3/8/8/8/3p4/8/3PP3/4K3 w - - 0 1');
    expect(option(defended, 'e2', 'e4')?.risky).toBe(false);
  });

  it('respects pins when counting who can recapture', () => {
    // The knight on d2 is pinned to its king by the rook on d8, so it does not defend e4.
    const g = new Game('3rk3/8/8/5b2/8/8/3NQ3/3K4 w - - 0 1');
    expect(option(g, 'e2', 'e4')?.risky).toBe(true);
  });

  it('works out the options for every piece without listing every legal move over and over', () => {
    // A busy middlegame (the "Kiwipete" test position). Choosing a piece here used to stall for
    // over a tenth of a second, because the exchange evaluation asked chess.js for the full list
    // of legal moves at every step. Counting those requests is steadier than timing them.
    const g = new Game('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
    const listed = vi.spyOn(Chess.prototype, 'moves');
    let options = 0;
    const pieces = g.pieces();
    for (const p of pieces) options += g.movesFrom(p.square).length;
    const requests = listed.mock.calls.length;
    listed.mockRestore();
    expect(options).toBe(48); // the published count of legal moves here; none is a promotion
    // One list for each piece asked about, and no more.
    expect(requests).toBeLessThanOrEqual(pieces.length);
  });
});

describe('positions set up from a FEN', () => {
  it('drops castling rights that the pieces do not support', () => {
    const g = new Game('4k3/8/8/8/8/8/8/4K2R w KQkq - 0 1');
    expect(g.fen()).toBe('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
    expect(option(g, 'e1', 'g1')?.castle).toBe('k');
    expect(option(g, 'e1', 'c1')).toBeUndefined();
    const none = new Game('4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1');
    expect(none.movesFrom('e1').every((m) => m.castle === null)).toBe(true);
  });

  it('drops an en passant square with no pawn to take', () => {
    expect(new Game('4k3/8/8/8/8/8/8/4K3 w - e6 0 1').fen()).toBe('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    // A real one is kept, and can be played.
    const real = new Game('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    expect(option(real, 'e5', 'd6')).toMatchObject({ capture: true, enPassant: true });
  });

  it('reports who moves first and the number of that move', () => {
    expect(new Game().start()).toEqual({ side: 'w', moveNumber: 1 });
    expect(new Game('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 7').start()).toEqual({ side: 'b', moveNumber: 7 });
  });
});

describe('bookkeeping', () => {
  it('rejects illegal moves and moves out of turn', () => {
    const g = new Game();
    expect(() => g.move('e2', 'e5')).toThrow(IllegalMoveError);
    expect(() => g.move('e7', 'e5')).toThrow(IllegalMoveError);
    expect(() => g.move('e3', 'e4')).toThrow(IllegalMoveError);
    expect(g.history()).toEqual([]);
  });

  it('lists captures by the side that lost the piece', () => {
    const g = new Game();
    play(g, 'e2e4 d7d5 e4d5');
    expect(g.captured()).toEqual({ w: [], b: ['p'] });
    expect(g.lastMove()?.san).toBe('exd5');
  });

  it('load replaces the position and clears the record', () => {
    const g = new Game();
    play(g, 'e2e4 e7e5');
    g.load('8/8/8/8/8/8/R7/K6k w - - 0 1');
    expect(g.pieces()).toHaveLength(3);
    expect(g.history()).toEqual([]);
    expect(() => g.load('not a fen')).toThrow();
  });
});

describe('the status, worked out once for each position', () => {
  it('is worked out again after every change, and each caller is handed a copy of its own', () => {
    const g = new Game();
    const first = g.status();
    first.checkers.push('e4');
    first.over = true;
    expect(g.status().over).toBe(false);
    expect(g.status().checkers).toEqual([]);
    for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4']] as const) g.move(from, to);
    expect(g.status().turn).toBe('b');
    g.move('d8', 'h4');
    expect(g.status().result).toBe('checkmate');
    expect(g.status().checkers).toEqual(['h4']);
    g.undo();
    expect(g.status().over).toBe(false);
    expect(g.resign('w')).toBe(true);
    expect(g.status().result).toBe('resigned');
    g.reopen();
    expect(g.status().over).toBe(false);
    expect(g.agreeDraw()).toBe(true);
    expect(g.status().drawReason).toBe('agreement');
    g.load();
    expect(g.status()).toMatchObject({ over: false, turn: 'w', result: null });
  });
});
