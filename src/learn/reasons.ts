/**
 * Why a quiet move is a good one, where that can be told from the position alone.
 *
 * A hint says what a move does when it takes, checks, promotes or forks. A move that does none of
 * these still has a reason sometimes, and this finds the few that can be read off the board with
 * certainty: it gets the king out of check, takes a stone out of danger, brings out a knight or a
 * bishop, takes the middle, one step from promoting, opens a way for a long-range stone. Each
 * test is strict, and when none holds, nothing is said: a reason that is not true of the position
 * is worse than none.
 *
 * The engine's own line is not used. It says which move is best, not why, and a story made up to
 * fit would be a guess.
 */
import { Chess, type Square as ChessSquare } from 'chess.js';
import { fileOf, type Kind, opposite, rankOf, type Side, squareOf, type Square, VALUE } from '../core/game';

const NAME: Record<Kind, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const HOME: Record<Side, Partial<Record<Kind, Square[]>>> = {
  w: { n: ['b1', 'g1'], b: ['c1', 'f1'] },
  b: { n: ['b8', 'g8'], b: ['c8', 'f8'] },
};
const MIDDLE: Square[] = ['d4', 'e4', 'd5', 'e5'];
const ORTHOGONAL: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const KNIGHT: [number, number][] = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
/** How many more squares a stone must see after the move for it to be said that the move opens a way. */
const OPENED = 3;
/** How many squares a knight must see in the middle for it to be said that it reaches the most. */
const KNIGHT_REACH = 6;

const at = (file: number, rank: number): Square | null => (file >= 0 && file < 8 && rank >= 0 && rank < 8 ? (squareOf(file, rank) as Square) : null);

/** Whether the stone on `square`, of the side given, is under attack by something that would win material by taking it. */
function endangered(chess: Chess, square: Square, side: Side): boolean {
  const piece = chess.get(square as ChessSquare);
  if (!piece || piece.color !== side || piece.type === 'k') return false;
  const attackers = chess.attackers(square as ChessSquare, opposite(side));
  if (attackers.length === 0) return false;
  if (chess.attackers(square as ChessSquare, side).length === 0) return true;
  return Math.min(...attackers.map((a) => VALUE[chess.get(a)!.type as Kind])) < VALUE[piece.type as Kind];
}

/** How many squares a stone can see along its lines (a bishop, rook or queen) or by its jumps (a knight), up to and including the first stone in each direction. */
function reach(chess: Chess, square: Square): number {
  const piece = chess.get(square as ChessSquare);
  if (!piece) return 0;
  let n = 0;
  if (piece.type === 'n') {
    for (const [df, dr] of KNIGHT) {
      const s = at(fileOf(square) + df, rankOf(square) + dr);
      if (s && chess.get(s as ChessSquare)?.color !== piece.color) n++;
    }
    return n;
  }
  const dirs = piece.type === 'r' ? ORTHOGONAL : piece.type === 'b' ? DIAGONAL : piece.type === 'q' ? [...ORTHOGONAL, ...DIAGONAL] : [];
  for (const [df, dr] of dirs) {
    for (let f = fileOf(square) + df, r = rankOf(square) + dr; ; f += df, r += dr) {
      const s = at(f, r);
      if (!s) break;
      const there = chess.get(s as ChessSquare);
      if (there?.color === piece.color) break;
      n++;
      if (there) break;
    }
  }
  return n;
}

/**
 * The reason for a move that does nothing more showy, or null. `before` and `after` are the
 * position the side `side` moves in and the one it leads to; `from` and `to` are the squares of the move.
 */
export function quietReason(before: string, after: string, side: Side, kind: Kind, from: Square, to: Square): string | null {
  let was: Chess;
  let now: Chess;
  try {
    was = new Chess(before);
    now = new Chess(after);
  } catch {
    return null;
  }
  const name = NAME[kind];

  if (was.isCheck()) return 'It gets your king out of check.';

  // Something of yours was under attack, and now it is not.
  const saved: { square: Square; kind: Kind }[] = [];
  for (const row of was.board()) {
    for (const p of row) {
      if (!p || p.color !== side || !endangered(was, p.square, side)) continue;
      const square = p.square === from ? to : p.square;
      if (!endangered(now, square, side)) saved.push({ square, kind: p.type as Kind });
    }
  }
  if (saved.length > 0) {
    saved.sort((a, b) => VALUE[b.kind] - VALUE[a.kind]);
    const s = saved[0]!;
    if (s.square === to) return `Your ${name} was under attack. This takes it out of danger.`;
    if (now.attackers(s.square as ChessSquare, side).includes(to as ChessSquare) && !was.attackers(s.square as ChessSquare, side).includes(from as ChessSquare)) {
      return `Your ${NAME[s.kind]} on ${s.square} was under attack. This protects it.`;
    }
    return `Your ${NAME[s.kind]} on ${s.square} was under attack. This deals with it.`;
  }

  // A pawn one step from the far side, with the way ahead clear.
  if (kind === 'p') {
    const ahead = at(fileOf(to), rankOf(to) + (side === 'w' ? 1 : -1));
    if (rankOf(to) === (side === 'w' ? 6 : 1) && ahead && !now.get(ahead as ChessSquare)) return 'One more step and this pawn becomes a queen.';
  }

  // A knight or a bishop that has not yet moved, coming out.
  if (HOME[side][kind]?.includes(from)) return `It brings your ${name} out into the game.`;

  // The middle of the board.
  if (MIDDLE.includes(to)) {
    if (kind === 'p') return 'It claims the middle of the board.';
    if (kind === 'n' && reach(now, to) >= KNIGHT_REACH) return 'It puts your knight in the middle of the board, where it reaches the most squares.';
  }

  // Something of yours that sees far now sees more: the stone that moved was in its way.
  let best: { square: Square; kind: Kind; gain: number } | null = null;
  for (const row of now.board()) {
    for (const p of row) {
      if (!p || p.color !== side || p.square === to || (p.type !== 'b' && p.type !== 'r' && p.type !== 'q')) continue;
      const gain = reach(now, p.square) - reach(was, p.square);
      if (gain >= OPENED && (!best || gain > best.gain)) best = { square: p.square, kind: p.type, gain };
    }
  }
  if (best) return `It opens a way for your ${NAME[best.kind]} on ${best.square}.`;
  return null;
}
