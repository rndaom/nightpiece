/**
 * What the engine makes of a move that was played: was it the one move that
 * held everything together, an ordinary good move, a slip, or a blunder?
 *
 * The room reacts to this (the mover's pieces surge at a strong move and sag
 * at a blunder) and the beginner aids explain it.
 *
 * It works from two searches: one of the position before the move, asking
 * for the two best lines, and one of the position after it. Each position is
 * searched once, since the search after one move is the search before the
 * next.
 *
 * Those searches are quick, and a quick search cannot see far: a sacrifice
 * whose point lies a few moves on looks to it like a piece thrown away. So
 * a move it finds a slip or a blunder is looked at again, much deeper (see
 * `reconsider`), and is called one only if the deeper search agrees.
 */
import type { Analysis, EngineMove, Score, SearchOptions, Setting } from './uci';

export type VerdictKind =
  /** The best move, where every other move was clearly worse. */
  | 'strong'
  /** Nothing to remark on. */
  | 'sound'
  /** Made the mover's chances clearly worse, but did not throw them away. */
  | 'slip'
  /** Threw away much of the mover's chances: from a level game, a piece's worth or so. */
  | 'blunder';

export interface Verdict {
  kind: VerdictKind;
  /** How the mover stood before, with best play, and stands now. Hundredths of a pawn, capped (see `worth`). */
  before: number;
  after: number;
  /** What the move gave up against the best one. Never negative. */
  loss: number;
  /** For the best move: how far ahead of the next best it was. Null when it was not the best, or was the only move. */
  margin: number | null;
  /** What the engine would have played. */
  best: EngineMove;
  /** Whether the move played was that one. */
  wasBest: boolean;
}

export interface MoveFacts {
  /** How the game stood once the move was made: ended by it, or not (a game given up was not ended by a move). */
  result: 'checkmate' | 'draw' | 'resigned' | null;
  /** The move took back, on the same square, a piece that had just taken one. */
  recapture: boolean;
}

/** Scores beyond this are all "winning by a mile"; telling them apart would only be noise. */
const CAP = 1500;
/** A forced mate is worth more than any amount of material, and a quicker one a little more than a slower. */
const MATE = 2000;

/** One capped number for a score, from the point of view of the side to move. */
export function worth(score: Score): number {
  if (score.mate !== undefined) {
    const sooner = 10 * Math.min(40, Math.abs(score.mate));
    return score.mate > 0 ? MATE - sooner : -MATE + sooner;
  }
  return Math.max(-CAP, Math.min(CAP, score.cp ?? 0));
}

function same(a: EngineMove, b: EngineMove): boolean {
  return a.from === b.from && a.to === b.to && (a.promotion ?? null) === (b.promotion ?? null);
}

/**
 * A value (see `worth`) as the mover's chances, from -1 (lost) through 0 (level) to 1 (won): the
 * curve on which games from such a score have been found to end. The same loss counts for less the
 * further a side is ahead or behind: going from seven pawns up to three still wins, where going
 * from level to four down does not.
 */
export function chances(value: number): number {
  return 2 / (1 + Math.exp(-0.00368208 * value)) - 1;
}

/** The move's value was at least this much more than the next best: nothing else would do. */
const ONLY_MOVE = 150;
/**
 * How far the mover's chances must fall for a slip, and for a blunder. From a level game these are
 * about a pawn and two pawns lost; with a side well ahead, or well behind, it takes more.
 */
const SLIP = 0.17;
const BLUNDER = 0.35;
/** Chances this poor (some eight pawns down) are a game already gone. */
const GONE = -0.9;

/**
 * Judge a move. `before` is the search of the position it was played in (two lines); `after`
 * the search of the position it led to, or null if the game ended or the search was not done.
 * Returns null when there is not enough to go on.
 */
export function judge(before: Analysis | null, after: Analysis | null, played: EngineMove, facts: MoveFacts): Verdict | null {
  const first = before?.lines[0];
  if (!before || !first) return null;
  const second = before.lines[1];
  const best = worth(first.score);
  const wasBest = same(first.move, played);

  let now: number;
  if (facts.result === 'checkmate') now = MATE;
  else if (facts.result === 'draw') now = 0;
  // The search that ranked the moves is the fairest judge of the two it ranked.
  else if (wasBest) now = best;
  else if (second && same(second.move, played)) now = worth(second.score);
  else if (after?.lines[0]) now = -worth(after.lines[0].score);
  else return null;

  // A deeper look at the move played can find it better than the first search thought the best was.
  const loss = Math.max(0, best - now);
  const margin = wasBest && second ? best - worth(second.score) : null;
  // Measured in chances, a move that still wins easily, or loses a game already gone, is no mistake.
  const fall = chances(best) - chances(now);

  // Letting the other side force mate, where it could not before, is a blunder unless the game was gone anyway.
  const allowsMate = now < -CAP && best >= -CAP && chances(best) > GONE;

  let kind: VerdictKind = 'sound';
  if (facts.result === 'checkmate') {
    kind = 'strong';
  } else if (fall >= BLUNDER || allowsMate) {
    kind = 'blunder';
  } else if (fall >= SLIP) {
    kind = 'slip';
  } else if (wasBest && margin !== null && margin >= ONLY_MOVE && now >= -100 && !facts.recapture) {
    // Taking back a piece is the only move too, but nobody needs telling.
    kind = 'strong';
  }
  return { kind, before: best, after: now, loss, margin, best: first.move, wasBest };
}

/**
 * The quick look at each position, which every move is judged by first: this deep, or this long,
 * whichever comes first, so that it is ready by the time the player has made the next move.
 */
export const FIRST_LOOK: SearchOptions = { depth: 11, movetime: 450, lines: 2 };

/**
 * The second look, before a move is called a slip or a blunder: a set number of positions, so that
 * the answer is the same on any machine, however busy it is, and is never cut short by the clock.
 * In a middle game that is a search some fifteen to twenty moves deep, where the quick look reaches
 * eleven at most (fewer on a slow or busy machine), and deep enough to see the point of the
 * sacrifices in the games every player is shown (tests/sacrifices.test.ts).
 */
export const SECOND_LOOK: SearchOptions = { nodes: 400_000, lines: 2 };

/**
 * The verdict a move is given in the end. `first` is what the quick look made of it. Praise and
 * silence stand as they are; a slip or a blunder is looked at again with `look`, a search to the
 * depth of `SECOND_LOOK`: of the position the move was played in (`before`) and, unless that ranks
 * the move itself, of the one it led to (`after`); and the deeper word is the one given. When the
 * deeper search cannot be had there is no verdict: a move is never called a mistake on a look too
 * shallow to stand behind it.
 */
export async function reconsider(
  first: Verdict | null,
  look: (line: Setting) => Promise<Analysis | null>,
  before: Setting,
  after: Setting | null,
  played: EngineMove,
  facts: MoveFacts,
): Promise<Verdict | null> {
  if (!first || (first.kind !== 'slip' && first.kind !== 'blunder')) return first;
  const deep = await look(before);
  if (!deep || deep.lines.length === 0) return null;
  const ranked = deep.lines.slice(0, 2).some((l) => same(l.move, played));
  const ended = facts.result === 'checkmate' || facts.result === 'draw';
  const deepAfter = ended || ranked || !after ? null : await look(after);
  return judge(deep, deepAfter, played, facts);
}
