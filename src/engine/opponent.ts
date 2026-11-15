/**
 * The computer as an opponent: which move it plays at each level.
 *
 * The engine at full strength cannot be beaten, so the lower levels hold it
 * back twice over: Stockfish's own handicap and a shallow search, and on top
 * of that a share of moves made with no thought at all, which is what makes
 * the first level beatable by someone who has just learned how the pieces
 * move.
 */
import type { Engine, EngineMove, Level, Setting } from './uci';

/**
 * Choose a move for the side to move. `legal` is every legal move in the position; null comes
 * back only if there are none. `random` returns a number from 0 up to 1. `setting` is the position
 * with the moves that led to it: the levels that remember (`Level.remembers`) are shown those, and
 * so keep out of a draw by repetition; the others see the position alone, as they always did.
 */
export async function chooseMove(engine: Engine, fen: string, legal: EngineMove[], level: Level, random: () => number = Math.random, setting?: Setting): Promise<EngineMove | null> {
  if (legal.length === 0) return null;
  const thoughtless = () => {
    // A queen when a pawn promotes: even a careless player takes the queen.
    const plain = legal.filter((m) => !m.promotion || m.promotion === 'q');
    return plain[Math.min(plain.length - 1, Math.floor(random() * plain.length))]!;
  };
  if (legal.length > 1 && random() < level.slip) return thoughtless();
  const past = level.remembers && setting && setting.moves.length > 0 ? setting : null;
  const found = await engine.analyse(past ? past.fen : fen, {
    ...(past ? { moves: past.moves } : {}),
    skill: level.skill,
    ...(level.depth ? { depth: level.depth } : {}),
    ...(level.movetime ? { movetime: level.movetime } : {}),
  });
  const best = found.best;
  // Never trust a move that is not in the list, whatever the engine says.
  if (best && legal.some((m) => m.from === best.from && m.to === best.to && (m.promotion ?? null) === (best.promotion ?? null))) return best;
  return thoughtless();
}
