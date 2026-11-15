/**
 * The two endings that are not on the board: a game given up, and a draw
 * the players agree. And the draws that come by themselves, seen coming.
 */
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { Game, IllegalMoveError, type Square } from '../src/core/game.ts';

describe('resigning', () => {
  it('ends the game for the other side, whoever is to move', () => {
    const game = new Game();
    game.move('e2', 'e4');
    expect(game.resigned()).toBeNull();
    // Ivory gives up on Void's move.
    expect(game.resign('w')).toBe(true);
    expect(game.resigned()).toBe('w');
    expect(game.status()).toMatchObject({ over: true, result: 'resigned', winner: 'b', turn: 'b', drawReason: null });
  });

  it('leaves nothing to be played', () => {
    const game = new Game();
    game.move('e2', 'e4');
    game.resign('b');
    expect(game.moves()).toEqual([]);
    expect(game.movesFrom('e7')).toEqual([]);
    expect(game.canMove('e7')).toBe(false);
    expect(() => game.move('e7', 'e5')).toThrow(IllegalMoveError);
    expect(game.history()).toHaveLength(1);
  });

  it('cannot be done twice, nor once the game has ended on the board', () => {
    const game = new Game();
    game.resign('w');
    expect(game.resign('b')).toBe(false);
    expect(game.status().winner).toBe('b');

    const mated = new Game();
    for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']] as const) mated.move(from, to);
    expect(mated.resign('b')).toBe(false);
    expect(mated.resigned()).toBeNull();
    expect(mated.status()).toMatchObject({ result: 'checkmate', winner: 'b' });
  });

  it('can be taken back, and the game goes on from where it was', () => {
    const game = new Game();
    game.move('e2', 'e4');
    game.resign('b');
    expect(game.reopen()).toBe(true);
    expect(game.reopen()).toBe(false);
    expect(game.status()).toMatchObject({ over: false, result: null, winner: null });
    expect(game.move('e7', 'e5').san).toBe('e5');
  });

  it('is forgotten when a move is taken back or the board is set up again', () => {
    const game = new Game();
    game.move('e2', 'e4');
    game.resign('w');
    expect(game.undo()?.san).toBe('e4');
    expect(game.resigned()).toBeNull();
    expect(game.status().over).toBe(false);

    game.move('d2', 'd4');
    game.resign('b');
    game.load();
    expect(game.resigned()).toBeNull();
    expect(game.status().over).toBe(false);
  });
});

describe('agreeing a draw', () => {
  it('ends the game with nobody winning, whoever is to move', () => {
    const game = new Game();
    game.move('e2', 'e4');
    expect(game.drawAgreed()).toBe(false);
    expect(game.endedOffBoard()).toBe(false);
    expect(game.agreeDraw()).toBe(true);
    expect(game.drawAgreed()).toBe(true);
    expect(game.endedOffBoard()).toBe(true);
    expect(game.status()).toMatchObject({ over: true, result: 'draw', drawReason: 'agreement', winner: null, turn: 'b', inCheck: false });
    // Nothing is left to be played, or given up.
    expect(game.moves()).toEqual([]);
    expect(() => game.move('e7', 'e5')).toThrow(IllegalMoveError);
    expect(game.resign('b')).toBe(false);
    expect(game.resigned()).toBeNull();
  });

  it('cannot be done once the game is over, however it ended', () => {
    const agreed = new Game();
    agreed.agreeDraw();
    expect(agreed.agreeDraw()).toBe(false);

    const givenUp = new Game();
    givenUp.resign('w');
    expect(givenUp.agreeDraw()).toBe(false);
    expect(givenUp.drawAgreed()).toBe(false);
    expect(givenUp.status()).toMatchObject({ result: 'resigned', winner: 'b' });

    const mated = new Game();
    for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']] as const) mated.move(from, to);
    expect(mated.agreeDraw()).toBe(false);
    expect(mated.status()).toMatchObject({ result: 'checkmate', winner: 'b', drawReason: null });

    // A draw that is on the board already is that draw, not an agreed one.
    const bare = new Game('8/8/4k3/8/8/4K3/8/8 w - - 0 1');
    expect(bare.agreeDraw()).toBe(false);
    expect(bare.status()).toMatchObject({ result: 'draw', drawReason: 'insufficient' });
  });

  it('can be taken back, and the game goes on from where it was', () => {
    const game = new Game();
    game.move('e2', 'e4');
    game.agreeDraw();
    expect(game.reopen()).toBe(true);
    expect(game.reopen()).toBe(false);
    expect(game.drawAgreed()).toBe(false);
    expect(game.status()).toMatchObject({ over: false, result: null, drawReason: null });
    expect(game.move('e7', 'e5').san).toBe('e5');
  });

  it('is forgotten when a move is taken back or the board is set up again', () => {
    const game = new Game();
    game.move('e2', 'e4');
    game.agreeDraw();
    expect(game.undo()?.san).toBe('e4');
    expect(game.drawAgreed()).toBe(false);
    expect(game.status().over).toBe(false);

    game.move('d2', 'd4');
    game.agreeDraw();
    game.load();
    expect(game.drawAgreed()).toBe(false);
    expect(game.status().over).toBe(false);
    expect(game.history()).toHaveLength(0);
  });

  it('does not stand in the way of how the board itself ended a game looked back at', () => {
    // The last position of a game is rebuilt move by move to be looked at; the agreement is then put on it.
    const game = new Game();
    game.move('e2', 'e4');
    game.move('e7', 'e5');
    const shown = new Game(game.startFen());
    for (const e of game.history()) shown.move(e.piece.from, e.piece.to);
    expect(shown.agreeDraw()).toBe(true);
    expect(shown.status().drawReason).toBe('agreement');
  });
});

describe('a draw that is coming by itself', () => {
  const shuffle = (game: Game, times: number) => {
    for (let i = 0; i < times; i++) {
      game.move('g1', 'f3');
      game.move('g8', 'f6');
      game.move('f3', 'g1');
      game.move('f6', 'g8');
    }
  };

  it('is not near at the start of a game, nor after ordinary moves', () => {
    const game = new Game();
    expect(game.drawNear()).toBeNull();
    game.move('e2', 'e4');
    game.move('e7', 'e5');
    expect(game.drawNear()).toBeNull();
  });

  it('is near once the position on the board has come up twice', () => {
    const game = new Game();
    game.move('g1', 'f3');
    game.move('g8', 'f6');
    game.move('f3', 'g1');
    expect(game.drawNear()).toBeNull();
    // The knights are home again: the first position, for the second time.
    game.move('f6', 'g8');
    expect(game.drawNear()).toEqual({ by: 'threefold' });
    // And each position of the shuffle after it, as it too comes round again.
    game.move('g1', 'f3');
    expect(game.drawNear()).toEqual({ by: 'threefold' });
  });

  it('is no longer near once a draw may be claimed, nor once it has been', () => {
    const game = new Game();
    shuffle(game, 2);
    expect(game.status()).toMatchObject({ over: false, claimable: 'threefold' });
    expect(game.drawNear()).toBeNull();
    game.claimDraw();
    expect(game.status()).toMatchObject({ over: true, drawReason: 'threefold' });
    expect(game.drawNear()).toBeNull();
  });

  it('goes away when the move that brought the position back is taken back', () => {
    const game = new Game();
    shuffle(game, 1);
    expect(game.drawNear()).toEqual({ by: 'threefold' });
    game.undo();
    expect(game.drawNear()).toBeNull();
  });

  it('does not take the same stones with the other side to move for the same position', () => {
    // Kings and a rook: Ivory loses a move with the rook, so the stones are as they were but it is the other's turn.
    const game = new Game('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    game.move('a1', 'a2');
    game.move('e8', 'd8');
    game.move('a2', 'a1');
    game.move('d8', 'e8');
    expect(game.drawNear()).toEqual({ by: 'threefold' });
    const other = new Game('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    other.move('a1', 'a3');
    other.move('e8', 'd8');
    other.move('a3', 'a2');
    other.move('d8', 'e8');
    other.move('a2', 'a1');
    // The stones of the start, with Void to move where it was Ivory.
    expect(other.drawNear()).toBeNull();
  });

  it('is near when ten moves each are left of the fifty, and counts them down', () => {
    expect(new Game('4k3/8/8/8/8/8/8/R3K3 w - - 79 60').drawNear()).toBeNull();
    const game = new Game('4k3/8/8/8/8/8/8/R3K3 w - - 80 60');
    expect(game.drawNear()).toEqual({ by: 'fifty-move', plies: 20 });
    game.move('a1', 'a2');
    expect(game.drawNear()).toEqual({ by: 'fifty-move', plies: 19 });
    game.move('e8', 'd8');
    expect(game.drawNear()).toEqual({ by: 'fifty-move', plies: 18 });
  });

  it('counts single moves, so that what it says is true for both sides: a draw may be claimed exactly when the count runs out', () => {
    for (const quiet of [81, 90, 97, 98, 99]) {
      const game = new Game(`8/8/4k3/8/8/4K3/8/R7 w - - ${quiet} 80`);
      const promised = game.drawNear();
      expect(promised, String(quiet)).toEqual({ by: 'fifty-move', plies: 100 - quiet });
      // The rook walks round the corner, out of the king's way, and the king steps aside and back: nothing is taken, no pawn moves.
      let played = 0;
      let rook: Square = 'a1';
      let king: Square = 'e6';
      while (!game.status().claimable) {
        if (game.turn() === 'w') {
          const to = (['a1', 'a2', 'a3', 'a4', 'b4', 'b3', 'b2', 'b1'] as Square[])[(played / 2 + 1) % 8]!;
          game.move(rook, to);
          rook = to;
        } else {
          const to: Square = king === 'e6' ? 'f6' : 'e6';
          game.move(king, to);
          king = to;
        }
        played += 1;
      }
      expect(game.status(), String(quiet)).toMatchObject({ over: false, claimable: 'fifty-move' });
      expect(played, String(quiet)).toBe(100 - quiet);
    }
  });

  it('counts a position as FIDE does when a pawn could be taken in passing but for a pin: the same as the later ones', () => {
    // The pawn on d4 stands beside e4 once it is pushed there, but taking it would lay its own king open to the rook.
    const game = new Game('8/8/8/8/R2p3k/8/4P3/4K3 w - - 0 1');
    game.move('e2', 'e4');
    const round: [Square, Square][] = [['h4', 'h5'], ['e1', 'f1'], ['h5', 'h4'], ['f1', 'e1']];
    for (const [from, to] of round) game.move(from, to);
    // The stones stand as they did after e4, and the same moves can be made (the pawn cannot be taken in passing): the second time.
    expect(game.drawNear()).toEqual({ by: 'threefold' });
    for (const [from, to] of round) game.move(from, to);
    expect(game.status()).toMatchObject({ over: false, claimable: 'threefold' });
    expect(game.repetitions()).toBe(3);
  });

  it('starts the count again at a capture or a pawn move', () => {
    const game = new Game('4k3/8/8/8/8/8/P7/R3K3 w - - 90 60');
    expect(game.drawNear()).toEqual({ by: 'fifty-move', plies: 10 });
    game.move('a2', 'a3');
    expect(game.drawNear()).toBeNull();
  });
});

describe('a move typed instead of clicked', () => {
  const read = (fen: string | undefined, text: string) => new Game(fen).readMove(text);

  it('reads a move the way moves are written', () => {
    expect(read(undefined, 'e4')).toEqual({ from: 'e2', to: 'e4' });
    expect(read(undefined, 'Nf3')).toEqual({ from: 'g1', to: 'f3' });
    expect(read('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2', 'exd5')).toEqual({ from: 'e4', to: 'd5' });
  });

  it('reads the two squares, with or without something between them', () => {
    for (const text of ['g1f3', 'g1-f3', 'g1 f3', 'G1F3', ' g1f3 ']) expect(read(undefined, text), text).toEqual({ from: 'g1', to: 'f3' });
  });

  it('forgives case and the marks people add or leave out', () => {
    expect(read(undefined, 'nf3')).toEqual({ from: 'g1', to: 'f3' });
    expect(read(undefined, 'Nf3!?')).toEqual({ from: 'g1', to: 'f3' });
    const taking = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    for (const text of ['ed5', 'exd5', 'e:d5', 'EXD5']) expect(read(taking, text), text).toEqual({ from: 'e4', to: 'd5' });
    // A check or a mate may be marked or not.
    const mating = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2';
    for (const text of ['Qh4#', 'Qh4+', 'Qh4', 'qh4']) expect(read(mating, text), text).toEqual({ from: 'd8', to: 'h4' });
  });

  it('reads castling however it is written', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    for (const text of ['O-O', 'o-o', '0-0', 'OO', 'e1g1']) expect(read(fen, text), text).toEqual({ from: 'e1', to: 'g1' });
    for (const text of ['O-O-O', 'o-o-o', '0-0-0', 'ooo', 'e1c1']) expect(read(fen, text), text).toEqual({ from: 'e1', to: 'c1' });
  });

  it('reads what a pawn becomes, and leaves it to be asked when it is not said', () => {
    const fen = '3n3k/4P3/8/8/8/8/8/4K3 w - - 0 1';
    for (const text of ['e8=Q', 'e8Q', 'e8q', 'e7e8q', 'e7e8=Q']) expect(read(fen, text), text).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(read(fen, 'e8=N')).toEqual({ from: 'e7', to: 'e8', promotion: 'n' });
    expect(read(fen, 'exd8=R')).toEqual({ from: 'e7', to: 'd8', promotion: 'r' });
    for (const text of ['e8', 'e7e8', 'E8']) expect(read(fen, text), text).toEqual({ from: 'e7', to: 'e8' });
    expect(read(fen, 'exd8')).toEqual({ from: 'e7', to: 'd8' });
  });

  it('tells a bishop from a pawn by the case of the letter, and gives up when it cannot', () => {
    // The bishop on d2 can go to c3, and the pawn on b2 can take there.
    const fen = '4k3/8/8/8/8/2n5/1P1B4/4K3 w - - 0 1';
    expect(read(fen, 'Bxc3')).toEqual({ from: 'd2', to: 'c3' });
    expect(read(fen, 'bxc3')).toEqual({ from: 'b2', to: 'c3' });
    expect(read(fen, 'bc3')).toEqual({ from: 'b2', to: 'c3' });
    expect(read(fen, 'BC3')).toBeNull();
  });

  it('wants to be told which, when two of a kind can go there', () => {
    const fen = '4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1';
    expect(read(fen, 'Nd2')).toBeNull();
    expect(read(fen, 'Nbd2')).toEqual({ from: 'b1', to: 'd2' });
    expect(read(fen, 'Nfd2')).toEqual({ from: 'f1', to: 'd2' });
    expect(read(fen, 'f1d2')).toEqual({ from: 'f1', to: 'd2' });
  });

  it('reads nothing that is not a move in the position', () => {
    for (const text of ['', '   ', 'e5', 'Ke2', 'O-O', 'hello', 'x', 'e2e5', 'Nf3Nf6']) expect(read(undefined, text), text).toBeNull();
    // Nor anything at all once the game is over.
    const over = new Game();
    over.resign('w');
    expect(over.readMove('e4')).toBeNull();
  });

  it('reads every legal move of a busy position from its own notation and from its squares', () => {
    const game = new Game('r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 6 8');
    const chess = new Chess(game.fen());
    for (const m of chess.moves({ verbose: true })) {
      expect(game.readMove(m.san), m.san).toMatchObject({ from: m.from, to: m.to });
      expect(game.readMove(m.from + m.to), m.from + m.to).toMatchObject({ from: m.from, to: m.to });
    }
  });
});
