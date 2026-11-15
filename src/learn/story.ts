/**
 * The course of a game, for looking back over it: how it stood after each
 * move, and the move that cost its player the most.
 *
 * Where the engine judged a move, how the game stood is the engine's word.
 * Where it did not (no engine, or a game carried on from another day), it is
 * only the count of the stones, which is cruder but never wrong about who has
 * more of them.
 */
import { type MoveEvent, type PieceState, type Side, VALUE } from '../core/game';
import type { Verdict, VerdictKind } from '../engine/verdict';

export interface CoursePoint {
  /** How many moves had been played. 0 is the position the game began from. */
  ply: number;
  /** How the game stood then, in hundredths of a pawn in Ivory's favour. */
  cp: number;
  /** Whether that is the engine's judgement, or only the count of the stones. */
  judged: boolean;
  /** What the engine made of the move that led here. */
  kind: VerdictKind | null;
}

type VerdictOf = (e: MoveEvent) => Verdict | null | undefined;

/** The stones on the board, in pawns, Ivory's less Void's. The kings are not counted. */
function stones(pieces: readonly PieceState[]): number {
  let sum = 0;
  for (const p of pieces) if (p.kind !== 'k') sum += p.side === 'w' ? VALUE[p.kind] : -VALUE[p.kind];
  return sum;
}

/** How the game stood at its start and after each move. `start` is the stones it began with. */
export function course(start: readonly PieceState[], history: readonly MoveEvent[], verdictOf: VerdictOf): CoursePoint[] {
  let count = stones(start);
  const points: CoursePoint[] = [{ ply: 0, cp: count * 100, judged: false, kind: null }];
  history.forEach((e, i) => {
    const sign = e.side === 'w' ? 1 : -1;
    // A stone taken is the mover's gain, and so is a pawn become something better.
    count += sign * ((e.captured ? VALUE[e.captured.kind] : 0) + (e.promotion ? VALUE[e.promotion] - VALUE.p : 0));
    const verdict = verdictOf(e);
    points.push(verdict ? { ply: i + 1, cp: sign * verdict.after, judged: true, kind: verdict.kind } : { ply: i + 1, cp: count * 100, judged: false, kind: null });
  });
  return points;
}

export interface Costly {
  /** The game after this many moves is the game after the move. */
  ply: number;
  move: MoveEvent;
  verdict: Verdict;
}

/**
 * The slip or blunder that gave the most away: one side's, or either's when `side` is null.
 * Null if the engine found no move to fault. Of two that cost the same, the earlier.
 */
export function costliest(history: readonly MoveEvent[], verdictOf: VerdictOf, side: Side | null): Costly | null {
  let worst: Costly | null = null;
  history.forEach((move, i) => {
    if (side && move.side !== side) return;
    const verdict = verdictOf(move);
    if (!verdict || (verdict.kind !== 'slip' && verdict.kind !== 'blunder')) return;
    if (!worst || verdict.loss > worst.verdict.loss) worst = { ply: i + 1, move, verdict };
  });
  return worst;
}
