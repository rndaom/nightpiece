/**
 * The lessons: a short course that teaches how each stone moves, what check
 * and checkmate are, and the three odd rules, on the real board with the
 * real hands.
 *
 * Each step sets up a small position, says one thing, and asks for one move.
 * A move that is legal but not the one asked for is taken back with a word
 * about why; nothing here can be failed.
 *
 * This file is only data and the tests for "did that move do what was
 * asked". The app runs the steps (src/app/app.ts).
 */
import { Game, type MoveEvent, type PromotionKind, type Square } from '../core/game';

export interface LessonMove {
  from: Square;
  to: Square;
  promotion?: PromotionKind;
}

export interface Task {
  /** Whether a move the player made is the one asked for. */
  done: (e: MoveEvent) => boolean;
  /** A move that does it. If it is not legal where the step finds itself, `solve` looks for another. */
  solution: LessonMove;
  /** Said when the player makes some other legal move, before it is taken back. */
  retry: string | ((e: MoveEvent) => string);
  /** Said when they get it. */
  praise: string | ((e: MoveEvent) => string);
  /** What the other side then plays, when the lesson has something to show by it. */
  reply?: LessonMove;
}

export interface Step {
  /** The position, with the player as Ivory. Left out, the step carries on from where the last one ended. */
  fen?: string;
  /** For a step with no position of its own: the one to set up when it is reached by skipping or going back, not by finishing the step before. */
  afresh?: string;
  /** A move the other side makes first, for the player to answer. */
  prelude?: LessonMove;
  /** What the card says. */
  say: string;
  /** What to do, in a line, for the card folded away on a narrow screen: the step's instruction, which stays in view when the rest is put aside. */
  ask: string;
  /** Null when there is nothing to do but read on. */
  task: Task | null;
}

export interface Lesson {
  id: string;
  title: string;
  steps: Step[];
}

const text = (line: string | ((e: MoveEvent) => string), e: MoveEvent): string => (typeof line === 'string' ? line : line(e));

/** What to say about a move made in a step: praise if it was the one asked for, or why not. */
export function answer(task: Task, e: MoveEvent): { done: boolean; line: string } {
  const done = task.done(e);
  return { done, line: text(done ? task.praise : task.retry, e) };
}

/**
 * A move that does what a task asks in the position given: the task's own if it is legal there,
 * or else the first legal move that passes. Null if nothing does. Marked on the board when the
 * player asks to be shown.
 */
export function solve(fen: string, task: Task): LessonMove | null {
  const game = new Game(fen);
  const works = (m: LessonMove): boolean => {
    const trial = new Game(fen);
    try {
      return task.done(trial.move(m.from, m.to, m.promotion));
    } catch {
      return false;
    }
  };
  if (works(task.solution)) return task.solution;
  return game.moves().find(works) ?? null;
}

export const LESSONS: Lesson[] = [
  {
    id: 'hands',
    title: 'Your hands',
    steps: [
      {
        fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
        say: 'The pale stones are yours. Click the small one in front, the pawn, to take hold of it. The lit squares are where it may go. Click one.',
        ask: 'Click the pawn, then a lit square.',
        task: {
          done: (e) => e.piece.kind === 'p',
          solution: { from: 'e2', to: 'e4' },
          retry: 'That was your king. Put a hand on the pawn this time: the small stone in front of him.',
          praise: 'A pawn steps straight ahead: one square, or two if it has not moved yet. Now the other side moves. You take turns, one move each.',
          reply: { from: 'e8', to: 'd7' },
        },
      },
      {
        afresh: '8/3k4/8/8/4P3/8/8/4K3 w - - 1 2',
        say: 'Move the pawn again. It has left its first square, so now it goes one step at a time. Pawns never go backwards.',
        ask: 'Move the pawn one step.',
        task: {
          done: (e) => e.piece.kind === 'p',
          solution: { from: 'e4', to: 'e5' },
          retry: 'That was your king. Move the pawn once more.',
          praise: 'That is all a pawn does when nothing is in reach. It is the weakest stone, and you have eight of them.',
        },
      },
    ],
  },
  {
    id: 'pawn-takes',
    title: 'The pawn takes',
    steps: [
      {
        fen: '4k3/8/8/3p1p2/4P3/8/8/4K3 w - - 0 1',
        say: 'A pawn does not take what stands in front of it. It takes one square diagonally forward. Red corners mark a stone you can take. Take one of the dark pawns.',
        ask: 'Take one of the dark pawns.',
        task: {
          done: (e) => e.piece.kind === 'p' && e.captured !== null,
          solution: { from: 'e4', to: 'd5' },
          retry: 'Nothing was taken. Click your pawn, then one of the squares with red corners.',
          praise: 'Taken. Your stone now stands where theirs stood, and theirs is out of the game for good.',
        },
      },
    ],
  },
  {
    id: 'rook',
    title: 'The rook',
    steps: [
      {
        fen: '4k3/8/p7/8/8/8/8/R3K3 w - - 0 1',
        say: 'The tower in the corner is a rook. It moves in straight lines, forward, back or sideways, as far as it likes until something is in the way. Take the pawn at the end of its line.',
        ask: 'Take the pawn at the end of the rook\'s line.',
        task: {
          done: (e) => e.piece.kind === 'r' && e.captured !== null,
          solution: { from: 'a1', to: 'a6' },
          retry: 'A legal move, but the pawn is still standing. The rook can go all the way up its line and take it.',
          praise: 'Every stone but the pawn takes the same way it moves: it lands on the enemy stone and removes it.',
        },
      },
    ],
  },
  {
    id: 'bishop',
    title: 'The bishop',
    steps: [
      {
        fen: '4k3/8/8/6p1/8/8/P7/2B1K3 w - - 0 1',
        say: 'The bishop moves on the diagonals, as far as it likes. It can never leave the colour of square it starts on. Take the pawn.',
        ask: 'Take the pawn with your bishop.',
        task: {
          done: (e) => e.piece.kind === 'b' && e.captured !== null,
          solution: { from: 'c1', to: 'g5' },
          retry: 'The pawn is still standing. Follow the diagonal from your bishop: it runs straight to it.',
          praise: 'You start with two bishops, one for the light squares and one for the dark.',
        },
      },
    ],
  },
  {
    id: 'queen',
    title: 'The queen',
    steps: [
      {
        fen: 'k7/8/3p4/7p/8/8/8/3QK3 w - - 0 1',
        say: 'The queen is your strongest stone. She moves like a rook and a bishop together: any straight line, any diagonal. Take either pawn.',
        ask: 'Take either pawn with your queen.',
        task: {
          done: (e) => e.piece.kind === 'q' && e.captured !== null,
          solution: { from: 'd1', to: 'h5' },
          retry: 'Nothing was taken. One pawn is straight ahead of her and the other is on her diagonal.',
          praise: 'Losing her for nothing usually loses the game, so the board will warn you when she is in danger.',
        },
      },
    ],
  },
  {
    id: 'knight',
    title: 'The knight',
    steps: [
      {
        fen: '4k3/8/8/8/8/8/4pPPP/K5N1 w - - 0 1',
        say: 'The knight moves in an L: two squares one way, then one to the side. It is the only stone that jumps over others. Take the pawn that has got in behind your wall.',
        ask: 'Take the pawn behind your wall with the knight.',
        task: {
          done: (e) => e.piece.kind === 'n' && e.captured !== null,
          solution: { from: 'g1', to: 'e2' },
          retry: 'The pawn is still there. Click the knight to see where its jumps land. One of them lands on the pawn.',
          praise: 'It went over your own pawns to do it. A knight changes the colour of its square with every jump.',
        },
      },
    ],
  },
  {
    id: 'king',
    title: 'The king',
    steps: [
      {
        fen: '4k3/8/8/8/8/8/P2r4/4K3 w - - 0 1',
        say: 'The king is the stone the whole game is about. He moves one square in any direction, and never onto a square an enemy attacks: those squares are simply not offered. Their rook has come too close. Take it with your king.',
        ask: 'Take their rook with your king.',
        task: {
          done: (e) => e.piece.kind === 'k' && e.captured !== null,
          solution: { from: 'e1', to: 'd2' },
          retry: (e) =>
            e.piece.kind === 'k'
              ? 'He stepped away, which is allowed, but the rook is undefended and right beside him. Take it.'
              : 'That was the pawn. This lesson is about the king: their rook is undefended and right beside him. Take it with him.',
          praise: 'A king can take, as long as the stone he takes is not protected by another.',
        },
      },
    ],
  },
  {
    id: 'check',
    title: 'Check',
    steps: [
      {
        fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1',
        say: 'Attacking the enemy king is called check. Their player must deal with it at once. Give check with your rook: put it on a line that runs straight to their king.',
        ask: 'Put your rook on a line to their king.',
        task: {
          done: (e) => e.status.inCheck,
          solution: { from: 'a1', to: 'a8' },
          retry: 'Their king is not attacked from there. Find a square where the rook sees him along an empty line.',
          praise: 'Check. The room turns on him. Watch: he has to step out of the line.',
          reply: { from: 'e8', to: 'e7' },
        },
      },
      {
        fen: '4r1k1/8/8/8/8/8/8/2B1K3 w - - 0 1',
        say: 'Now it is your king in check: their rook attacks him down the open line. There are three ways out of any check: move the king, put a stone in the way, or take the attacker. Get out of this one.',
        ask: 'Get your king out of check.',
        task: {
          done: () => true,
          solution: { from: 'c1', to: 'e3' },
          retry: '',
          praise: (e) => (e.piece.kind === 'k' ? 'You stepped out of the line. That always works if there is a safe square.' : 'You put your bishop in the way. Blocking keeps your king where he is.'),
        },
      },
    ],
  },
  {
    id: 'checkmate',
    title: 'Checkmate',
    steps: [
      {
        fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1',
        say: 'If a king is in check and none of the three ways out works, that is checkmate, and the game is won. Their king is shut in behind his own pawns. Finish it.',
        ask: 'Give checkmate.',
        task: {
          done: (e) => e.status.result === 'checkmate',
          solution: { from: 'a1', to: 'a8' },
          retry: 'He can still get by after that. Attack him along the far row, where his own pawns leave him nowhere to go.',
          praise: 'Checkmate. He is attacked, he cannot move, nothing can block and nothing can take your rook. This is how every won game ends.',
        },
      },
      {
        fen: '7k/5K2/8/6Q1/8/8/8/8 w - - 0 1',
        say: 'One warning. If the player to move has no legal move but is not in check, the game is a draw: stalemate. Give checkmate here, and take care not to leave their king with nowhere to go while he is not attacked.',
        ask: 'Give checkmate, but not stalemate.',
        task: {
          done: (e) => e.status.result === 'checkmate',
          solution: { from: 'g5', to: 'g7' },
          retry: (e) =>
            e.status.drawReason === 'stalemate'
              ? 'That is stalemate: their king is not attacked, but he has no square to go to, so nobody wins. It throws away a won game. Try again.'
              : 'Not mate yet. Put your queen right beside their king, on a square your own king protects.',
          praise: 'Checkmate, not stalemate: the difference is that he is attacked.',
        },
      },
    ],
  },
  {
    id: 'castling',
    title: 'Castling',
    steps: [
      {
        fen: '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1',
        say: 'Three odd rules, and then you know them all. The first is castling: in one move your king goes two squares toward a rook, and the rook hops over him. It tucks the king away. Click your king and choose a square two steps to the side.',
        ask: 'Click your king, then a square two to the side.',
        task: {
          done: (e) => e.castle !== null,
          solution: { from: 'e1', to: 'g1' },
          retry: 'That was an ordinary move. Click the king and pick the square two steps to his left or right.',
          praise: 'One hand, one move: the king first, then the rook. You may castle only if neither stone has moved before, nothing stands between them, and the king is not in check or crossing an attacked square.',
        },
      },
    ],
  },
  {
    id: 'promotion',
    title: 'Promotion',
    steps: [
      {
        fen: '8/P7/7k/8/8/8/6P1/4K3 w - - 0 1',
        say: 'The second: a pawn that reaches the far side of the board becomes a stronger stone of your choosing. Walk this one home.',
        ask: 'Walk the pawn to the far side.',
        task: {
          done: (e) => e.promotion !== null,
          solution: { from: 'a7', to: 'a8', promotion: 'q' },
          retry: 'The pawn on the left is one step from the far side. Move that one there.',
          praise: (e) => (e.promotion === 'q' ? 'A new queen. This is why a pawn that gets far up the board is worth protecting.' : 'It is your choice, though a queen is almost always the one to take.'),
        },
      },
    ],
  },
  {
    id: 'en-passant',
    title: 'Taking in passing',
    steps: [
      {
        fen: '4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1',
        prelude: { from: 'd7', to: 'd5' },
        say: 'The last, and the strangest. Their pawn has just gone two squares and landed beside yours. For this one turn you may take it as if it had gone only one: your pawn moves diagonally to the empty square behind it. It is called en passant, "in passing". Do it.',
        ask: 'Take their pawn en passant.',
        task: {
          done: (e) => e.enPassant,
          solution: { from: 'e5', to: 'd6' },
          retry: 'A fine move, but not the one. Click your pawn and take the square with red corners, diagonally behind their pawn.',
          praise: 'Your pawn went to an empty square and theirs was lifted off the board. It can only be done on the very next move, and only by a pawn.',
        },
      },
    ],
  },
];

/** How many steps come before a given one, for "step 5 of 14". */
export function stepNumber(lesson: number, step: number): { number: number; of: number } {
  let before = 0;
  let total = 0;
  LESSONS.forEach((l, i) => {
    if (i < lesson) before += l.steps.length;
    total += l.steps.length;
  });
  return { number: before + step + 1, of: total };
}
