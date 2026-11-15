/**
 * The lessons and the game's plain words. Every lesson must be playable as
 * written: its positions legal, its asked-for move possible, its scripted
 * moves legal. The words about hints and blunders are checked on positions
 * where what should be said is not in doubt.
 */
import { describe, expect, it } from 'vitest';
import { type DrawReason, Game, tidyFen, type MoveEvent } from '../src/core/game.ts';
import type { Analysis, EngineMove, Score } from '../src/engine/uci.ts';
import { describeBlunder, describeClaim, describeClaimable, describeDrawNear, describeHint, describeStatus, enPassantOffered, EXPLAIN, topicsOf } from '../src/learn/explain.ts';
import { answer, LESSONS, solve, stepNumber } from '../src/learn/lessons.ts';

const mv = (text: string): EngineMove => ({ from: text.slice(0, 2), to: text.slice(2, 4), ...(text[4] ? { promotion: text[4] } : {}) }) as EngineMove;
const answered = (move: string, score: Score): Analysis => ({ best: mv(move), lines: [{ move: mv(move), score }], depth: 10 });

describe('the lessons', () => {
  it('can each be played through as written', () => {
    for (const lesson of LESSONS) {
      let game: Game | null = null;
      lesson.steps.forEach((step, i) => {
        const where = `${lesson.id} step ${i + 1}`;
        if (step.fen) {
          // Nothing in the position that the rules would quietly drop.
          expect(tidyFen(step.fen), where).toBe(step.fen);
          game = new Game(step.fen);
        }
        expect(game, `${where} has a position to start from`).not.toBeNull();
        const g = game!;
        if (step.prelude) g.move(step.prelude.from, step.prelude.to, step.prelude.promotion);
        // The player is Ivory, and it is their move.
        expect(g.turn(), where).toBe('w');
        expect(g.status().over, where).toBe(false);
        if (!step.task) return;

        const solution = solve(g.fen(), step.task);
        expect(solution, `${where} can be done`).not.toBeNull();
        // Where a step sets up its own position, the move it names is the one that works.
        if (step.fen) expect(solution, where).toEqual(step.task.solution);
        const e = g.move(solution!.from, solution!.to, solution!.promotion);
        const said = answer(step.task, e);
        expect(said.done, where).toBe(true);
        expect(said.line.length, where).toBeGreaterThan(20);

        // A lesson never ends in a dead position, except by the mate it teaches.
        if (e.status.over) expect(e.status.result, where).toBe('checkmate');
        if (step.task.reply) {
          expect(e.status.over, where).toBe(false);
          const reply = step.task.reply;
          expect(() => g.move(reply.from, reply.to, reply.promotion), `${where} reply`).not.toThrow();
        }
      });
    }
  });

  it('has something to say about every other legal move', () => {
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        if (!step.fen || !step.task) continue;
        const start = new Game(step.fen);
        if (step.prelude) start.move(step.prelude.from, step.prelude.to, step.prelude.promotion);
        let wrong = 0;
        for (const m of start.moves()) {
          const trial = new Game(start.fen());
          const said = answer(step.task, trial.move(m.from, m.to, m.promotion));
          if (said.done) continue;
          wrong++;
          expect(said.line.length, `${lesson.id}: ${m.from}${m.to}`).toBeGreaterThan(20);
        }
        // A step with no wrong answer is the one where any way out of check will do.
        if (wrong === 0) expect(lesson.id).toBe('check');
      }
    }
  });

  it('tells stalemate from checkmate in the lesson about it', () => {
    const step = LESSONS.find((l) => l.id === 'checkmate')!.steps[1]!;
    const game = new Game(step.fen);
    const e = game.move('g5', 'g6');
    expect(e.status).toMatchObject({ over: true, result: 'draw', drawReason: 'stalemate' });
    const said = answer(step.task!, e);
    expect(said.done).toBe(false);
    expect(said.line).toMatch(/stalemate/);
    // Any of the mates will do.
    for (const mate of ['g5g7', 'g5h6', 'g5h5', 'g5h4']) {
      const trial = new Game(step.fen);
      expect(answer(step.task!, trial.move(mate.slice(0, 2) as 'g5', mate.slice(2) as 'g7')).done, mate).toBe(true);
    }
  });

  it('never ends in a position nobody can win, whichever acceptable move is made', () => {
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        const fen = step.fen ?? step.afresh;
        if (!fen || !step.task) continue;
        const start = new Game(fen);
        if (step.prelude) start.move(step.prelude.from, step.prelude.to, step.prelude.promotion);
        for (const m of start.moves()) {
          const trial = new Game(start.fen());
          const e = trial.move(m.from, m.to, m.promotion);
          if (!answer(step.task, e).done) continue;
          // Praise under a status line that says "Draw" would teach the wrong thing.
          if (e.status.over) expect(e.status.result, `${lesson.id}: ${e.san}`).toBe('checkmate');
        }
      }
    }
  });

  it('gives a step that carries on from the one before a position of its own, for when it is reached another way', () => {
    for (const lesson of LESSONS) {
      lesson.steps.forEach((step, i) => {
        if (step.fen) return;
        expect(step.afresh, `${lesson.id} step ${i + 1}`).toBeTruthy();
        expect(tidyFen(step.afresh!)).toBe(step.afresh);
        const game = new Game(step.afresh);
        expect(game.turn()).toBe('w');
        expect(solve(game.fen(), step.task!)).not.toBeNull();
      });
    }
    // The first lesson's second step: the pawn has left its first square, as the card says.
    const second = LESSONS[0]!.steps[1]!;
    const game = new Game(second.afresh);
    expect(game.pieceAt('e4')).toMatchObject({ kind: 'p', side: 'w' });
    expect(game.movesFrom('e4').map((o) => o.to)).toEqual(['e5']);
  });

  it('says which stone was moved when the wrong one was', () => {
    const step = LESSONS.find((l) => l.id === 'king')!.steps[0]!;
    const pawn = new Game(step.fen);
    expect(answer(step.task!, pawn.move('a2', 'a3')).line).toMatch(/^That was the pawn/);
    const king = new Game(step.fen);
    expect(answer(step.task!, king.move('e1', 'f1')).line).toMatch(/^He stepped away/);
  });

  it('finds another way when the move it had in mind cannot be played', () => {
    // The second step of the first lesson carries on from wherever the pawn went.
    const [first, second] = LESSONS[0]!.steps;
    const game = new Game(first!.fen);
    game.move('e2', 'e3');
    game.move('e8', 'd7');
    expect(solve(game.fen(), second!.task!)).toEqual({ from: 'e3', to: 'e4' });
  });

  it('teaches every piece, check, mate and the three special moves', () => {
    const ids = LESSONS.map((l) => l.id);
    for (const needed of ['pawn-takes', 'rook', 'bishop', 'queen', 'knight', 'king', 'check', 'checkmate', 'castling', 'promotion', 'en-passant']) {
      expect(ids).toContain(needed);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('numbers its steps from one to the total', () => {
    const total = LESSONS.reduce((n, l) => n + l.steps.length, 0);
    expect(stepNumber(0, 0)).toEqual({ number: 1, of: total });
    const last = LESSONS.length - 1;
    expect(stepNumber(last, LESSONS[last]!.steps.length - 1)).toEqual({ number: total, of: total });
  });
});

describe('explaining a rule the first time it comes up', () => {
  const play = (fen: string, ...moves: string[]): MoveEvent => {
    const game = new Game(fen);
    let e!: MoveEvent;
    for (const m of moves) e = game.move(m.slice(0, 2) as 'e2', m.slice(2, 4) as 'e4', (m[4] as 'q' | undefined) ?? undefined);
    return e;
  };

  it('knows which rules a move brings up', () => {
    expect(topicsOf(play('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'e1g1'))).toEqual(['castling']);
    expect(topicsOf(play('4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1', 'd7d5', 'e5d6'))).toEqual(['enPassant']);
    expect(topicsOf(play('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8q'))).toEqual(['promotion', 'check']);
    expect(topicsOf(play('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8'))).toEqual(['check']);
    expect(topicsOf(play('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'e2e4'))).toEqual([]);
    // Mate is the end of the game, and the card that ends it does the explaining.
    expect(topicsOf(play('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8'))).toEqual([]);
  });

  it('notices when a pawn can be taken in passing, for that turn only', () => {
    const game = new Game('4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1');
    expect(enPassantOffered(game)).toBe(false);
    game.move('d7', 'd5');
    expect(enPassantOffered(game)).toBe(true);
    game.move('e1', 'e2');
    game.move('e8', 'e7');
    expect(enPassantOffered(game)).toBe(false);
    // A double step with no enemy pawn beside it offers nothing.
    const quiet = new Game();
    quiet.move('e2', 'e4');
    expect(enPassantOffered(quiet)).toBe(false);
  });

  it('has words for every rule', () => {
    for (const topic of ['check', 'castling', 'enPassant', 'enPassantOffer', 'promotion'] as const) {
      expect(EXPLAIN[topic].title.length).toBeGreaterThan(3);
      expect(EXPLAIN[topic].text.length).toBeGreaterThan(60);
    }
  });
});

describe('the end of a game in words', () => {
  it('says first that a stalemate is not checkmate, and why', () => {
    const stuck = new Game('5Q2/7k/5R2/4K2B/8/P7/8/8 b - - 0 1').status();
    const said = describeStatus(stuck);
    expect(said.headline).toBe('Stalemate');
    expect(said.detail).toMatch(/^A draw, not checkmate\. The Void king is not attacked/);
    expect(said.detail).toMatch(/Void has no legal move/);
    // To the player it happened to, and to the player who did it.
    expect(describeStatus(stuck, 'b').detail).toMatch(/Your king is not attacked.*You have no legal move/);
    expect(describeStatus(stuck, 'w').detail).toMatch(/The Void king is not attacked.*Void has no legal move/);
  });

  it('says who won a checkmate, and speaks to the player when there is one', () => {
    const mated = new Game('R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1').status();
    expect(describeStatus(mated)).toEqual({ headline: 'Checkmate', detail: 'Ivory wins. The Void king is attacked and has no escape.' });
    expect(describeStatus(mated, 'w').detail).toBe('You win. The Void king is attacked and has no escape.');
    expect(describeStatus(mated, 'b').detail).toBe('Ivory wins. Your king is attacked and has no escape.');
  });

  it('names the other draws, and whose move it is while the game goes on', () => {
    expect(describeStatus(new Game('4k3/8/8/8/8/8/8/4K3 w - - 0 1').status())).toEqual({ headline: 'Draw', detail: 'Neither side has enough pieces left to checkmate.' });
    expect(describeStatus(new Game().status())).toEqual({ headline: 'Ivory to move', detail: null });
    expect(describeStatus(new Game().status(), 'w').headline).toBe('Your move');
    expect(describeStatus(new Game('4k3/8/8/8/8/8/8/R3K3 b - - 0 1').status(), 'w').headline).toBe('Void to move');
    const check = new Game('R3k3/8/8/8/8/8/8/4K3 b - - 0 1').status();
    expect(describeStatus(check, 'b')).toEqual({ headline: 'Check', detail: 'Your king is under attack and must get safe.' });
  });
});

describe('a draw that is coming, in words', () => {
  it('says that the position has come up twice, and that a third time lets a draw be claimed (it is not one by itself)', () => {
    expect(describeDrawNear({ by: 'threefold' })).toBe('This position has come up twice. A third time, and a draw may be claimed.');
  });

  it('says why a draw may be claimed, as the question before claiming it', () => {
    expect(describeClaim('threefold')).toBe('This position has come up three times. Claim a draw?');
    expect(describeClaim('fifty-move')).toBe('Fifty moves have passed without a capture or a pawn move. Claim a draw?');
    expect(describeClaimable('threefold', 'you')).toBe('The position has come up three times: you may claim a draw.');
    expect(describeClaimable('fifty-move', 'Void')).toBe('Fifty moves without a capture or a pawn move: Void may claim a draw.');
  });

  it('names how each draw came about, claimed or by itself, and a draw on time from either side', () => {
    const drawn = (drawReason: DrawReason, turn: 'w' | 'b' = 'w') => ({ turn, inCheck: false, checkedKing: null, checkers: [], over: true, result: 'draw' as const, winner: null, drawReason, claimable: null });
    expect(describeStatus(drawn('threefold')).detail).toMatch(/^Draw by repetition \(claimed\)/);
    expect(describeStatus(drawn('fifty-move')).detail).toMatch(/^Draw by the fifty-move rule \(claimed\)/);
    expect(describeStatus(drawn('fivefold')).detail).toBe('The position came up five times, which ends the game by itself.');
    expect(describeStatus(drawn('seventy-five-move')).detail).toBe('Seventy-five moves each without a capture or a pawn move, which ends the game by itself.');
    expect(describeStatus(drawn('timeout', 'b')).detail).toBe('Void ran out of time, but Ivory could not have mated.');
    expect(describeStatus(drawn('timeout', 'b'), 'b').detail).toBe('You ran out of time, but Ivory could not have mated.');
    expect(describeStatus(drawn('timeout', 'b'), 'w').detail).toBe('Void ran out of time, but you could not have mated.');
  });

  it('counts down the moves left of the fifty, and says one as one', () => {
    expect(describeDrawNear({ by: 'fifty-move', plies: 20 })).toBe('10 more moves each without a capture or a pawn move, and a draw may be claimed.');
    expect(describeDrawNear({ by: 'fifty-move', plies: 2 })).toBe('One more move each without a capture or a pawn move, and a draw may be claimed.');
  });

  it('says it from the side to move when the count is odd: this move, then so many each', () => {
    expect(describeDrawNear({ by: 'fifty-move', plies: 19 })).toBe('This move, then 9 more each, without a capture or a pawn move, and a draw may be claimed.');
    expect(describeDrawNear({ by: 'fifty-move', plies: 3 })).toBe('This move, then one more each, without a capture or a pawn move, and a draw may be claimed.');
    expect(describeDrawNear({ by: 'fifty-move', plies: 1 })).toBe('After this move a draw may be claimed, unless it takes a stone or moves a pawn.');
  });
});

describe('a hint in words', () => {
  it('names the stone first, then where it goes and what that does', () => {
    expect(describeHint(new Game().fen(), mv('g1f3'))).toEqual({ from: 'g1', to: 'f3', look: 'Look at your knight on g1.', move: 'Knight to f3. It brings your knight out into the game.' });
    expect(describeHint('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', mv('e4d5'))!.move).toBe('Pawn to d5. It takes their pawn.');
    expect(describeHint('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', mv('a1a8'))!.move).toBe('Rook to a8. It is checkmate.');
    expect(describeHint('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', mv('a1a8'))!.move).toBe('Rook to a8. It gives check.');
    expect(describeHint('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', mv('e1g1'))!.move).toMatch(/^King to g1\. That is castling/);
    expect(describeHint('8/P7/7k/8/8/8/8/4K3 w - - 0 1', mv('a7a8q'))!.move).toBe('Pawn to a8. The pawn becomes a queen.');
  });

  it('says when a move attacks two things at once', () => {
    const hint = describeHint('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', mv('b5c7'))!;
    expect(hint.move).toMatch(/^Knight to c7\. It gives check\. From there it attacks their (king and rook|rook and king) at once\.$/);
  });

  it('has nothing to say about a move that cannot be played', () => {
    expect(describeHint(new Game().fen(), mv('e2e5'))).toBeNull();
    expect(describeHint(new Game().fen(), mv('e4e5'))).toBeNull();
  });
});

describe('the reason for a quiet hint', () => {
  const said = (fen: string, uci: string) => describeHint(fen, mv(uci))!.move;

  it('says a knight or a bishop is coming out, only from where it began', () => {
    expect(said(new Game().fen(), 'g1f3')).toBe('Knight to f3. It brings your knight out into the game.');
    expect(said('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'f1c4')).toBe('Bishop to c4. It brings your bishop out into the game.');
    // A knight that has already come out is just moving.
    expect(said('4k3/p7/8/8/8/5N2/8/4K3 w - - 0 1', 'f3g5')).toBe('Knight to g5.');
  });

  it('says a pawn takes the middle, and a knight that reaches much from there', () => {
    expect(said(new Game().fen(), 'e2e4')).toBe('Pawn to e4. It claims the middle of the board.');
    expect(said('4k3/p7/8/8/8/2N5/8/4K3 w - - 0 1', 'c3e4')).toBe('Knight to e4. It puts your knight in the middle of the board, where it reaches the most squares.');
    // A knight in the middle with its way hemmed in by its own side is not said to reach much.
    expect(said('4k3/p7/3P1P2/2P3P1/8/2N3P1/3P1P2/4K3 w - - 0 1', 'c3e4')).toBe('Knight to e4.');
    expect(said('4k3/8/8/8/8/8/3P4/4K3 w - - 0 1', 'd2d3')).toBe('Pawn to d3.');
  });

  it('says a stone that was under attack is out of danger, or protected', () => {
    // The bishop is attacked by a pawn and runs.
    expect(said('4k3/8/8/3p4/4B3/8/8/4K3 w - - 0 1', 'e4f3')).toBe('Bishop to f3. Your bishop was under attack. This takes it out of danger.');
    // Not attacked, nothing is said.
    expect(said('4k3/p7/8/8/4B3/8/8/4K3 w - - 0 1', 'e4f3')).toBe('Bishop to f3.');
    expect(said('4k3/8/8/2p5/3B4/8/8/4K3 w - - 0 1', 'd4e3')).toBe('Bishop to e3. Your bishop was under attack. This takes it out of danger.');
    // The knight on d4 is attacked by a bishop and has nothing guarding it; the rook guards it.
    expect(said('4k3/6b1/8/8/3N4/8/8/R3K3 w - - 0 1', 'a1a4')).toBe('Rook to a4. Your knight on d4 was under attack. This protects it.');
    // A stone that was guarded enough was not in danger, so nothing is said of it.
    expect(said('4k3/6b1/8/8/3N4/2P5/8/R3K3 w - - 0 1', 'a1a4')).toBe('Rook to a4.');
  });

  it('says it gets the king out of check', () => {
    expect(said('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1', 'e1d1')).toBe('King to d1. It gets your king out of check.');
  });

  it('says a pawn is one step from promoting, if nothing stands in its way', () => {
    expect(said('7k/8/P7/8/8/8/8/4K3 w - - 0 1', 'a6a7')).toBe('Pawn to a7. One more step and this pawn becomes a queen.');
    expect(said('1r5k/8/P7/8/8/8/8/4K3 w - - 0 1', 'a6a7')).toBe('Pawn to a7. One more step and this pawn becomes a queen.');
    // Something on the square ahead: nothing is said.
    expect(said('n6k/8/P7/8/8/8/8/4K3 w - - 0 1', 'a6a7')).toBe('Pawn to a7.');
    expect(said('7k/8/P7/8/8/8/8/n3K3 w - - 0 1', 'a6a7')).toMatch(/becomes a queen/);
    // For the other side too.
    expect(said('4k3/8/8/8/8/p7/8/7K b - - 0 1', 'a3a2')).toBe('Pawn to a2. One more step and this pawn becomes a queen.');
  });

  it('says a move opens a way for a long-range stone', () => {
    // After 1.e4 e5, the bishop on f1 sees along a diagonal that the pawn on e2 cleared.
    expect(said('rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2', 'd2d3')).toBe('Pawn to d3. It opens a way for your bishop on c1.');
    expect(said('4k3/8/8/8/8/8/4P3/R3K3 w - - 0 1', 'e2e3')).toBe('Pawn to e3.');
  });

  it('says nothing of a quiet move with no plain reason, and never adds to what a move already does', () => {
    expect(said('4k3/8/8/8/8/8/R7/4K3 w - - 0 1', 'a2a3')).toBe('Rook to a3.');
    expect(said('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 'e4d5')).toBe('Pawn to d5. It takes their pawn.');
    expect(said('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'e1g1')).toMatch(/^King to g1\. That is castling/);
  });
});

describe('a blunder in words', () => {
  it('names the stone that would be lost where it lands', () => {
    const said = describeBlunder('4k3/8/4p3/8/8/8/8/3QK3 w - - 0 1', mv('d1d5'), answered('e6d5', { cp: 880 }));
    expect(said).toBe('This loses your queen: their pawn takes it on d5.');
  });

  it('names a stone left behind to be taken', () => {
    const said = describeBlunder('3r2k1/8/8/8/8/8/3B4/3R2K1 w - - 0 1', mv('d2e3'), answered('d8d1', { cp: 500 }));
    expect(said).toBe('This leaves your rook on d1 to be taken by their rook.');
  });

  it('says so when it allows mate', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
    expect(describeBlunder(fen, mv('g8f6'), answered('h5f7', { mate: 1 }))).toBe('This lets them checkmate you on the very next move.');
    expect(describeBlunder(fen, mv('g8f6'), answered('h5f7', { mate: 3 }))).toBe('This lets them force checkmate in 3 moves.');
  });

  it('says so when it would be stalemate', () => {
    expect(describeBlunder('7k/5K2/8/6Q1/8/8/8/8 w - - 0 1', mv('g5g6'), null)).toMatch(/^This is stalemate/);
  });

  it('says so when the game would end as some other draw, which only the game itself can know', () => {
    // A bare position cannot tell that it has come up twice before; whoever asks says so.
    const fen = '7k/8/8/8/8/8/8/3QK3 w - - 4 3';
    expect(describeBlunder(fen, mv('d1d2'), null, { result: 'draw', drawReason: 'threefold' })).toBe('This brings about the same position for the third time, and your opponent could claim a draw.');
    expect(describeBlunder(fen, mv('d1d2'), null, { result: 'draw', drawReason: 'fifty-move' })).toMatch(/fiftieth move.*could claim a draw/);
    expect(describeBlunder('7k/8/8/8/8/8/8/3QK2r w - - 0 1', mv('e1e2'), null, { result: 'draw', drawReason: 'insufficient' })).toMatch(/neither side enough/);
    // Told the move does not end the game, it goes by the engine's answer as before.
    expect(describeBlunder(fen, mv('d1d2'), answered('h8g8', { cp: -500 }), { result: null, drawReason: null })).toMatch(/their king to g8/);
  });

  it('describes a fork it walks into', () => {
    const said = describeBlunder('4k3/8/8/8/1n6/8/7P/R3K3 w - - 0 1', mv('h2h3'), answered('b4c2', { cp: 420 }));
    expect(said).toMatch(/^This walks into a fork: their knight goes to c2 and attacks your (king and rook|rook and king) at once\.$/);
  });

  it('still says something when it cannot work out what', () => {
    expect(describeBlunder(new Game().fen(), mv('g1f3'), null)).toMatch(/strong answer/);
    expect(describeBlunder(new Game().fen(), mv('g1f3'), answered('e7e5', { cp: 250 }))).toMatch(/their pawn to e5/);
  });
});
