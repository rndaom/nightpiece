/**
 * Talking to a chess engine. Stockfish speaks UCI, a line-based text
 * protocol; this turns "what is the best move here, and how good is the
 * position?" into those lines and back.
 *
 * It does not care where the engine runs. In the browser it is a WebAssembly
 * build of Stockfish in a worker (see browser.ts); in the tests it is the
 * same engine under Node.
 */
import type { PromotionKind, Square } from '../core/game';

/** A channel to an engine: lines of text each way. */
export interface UciPort {
  send(line: string): void;
  /** Register the one function that receives the engine's output, a line at a time. */
  listen(onLine: (line: string) => void): void;
  close(): void;
}

/** How good a position is for the side to move: in hundredths of a pawn, or as a forced mate in so many moves. */
export interface Score {
  cp?: number;
  /** Positive: the side to move mates in this many moves. Negative: it is mated. */
  mate?: number;
}

export interface EngineMove {
  from: Square;
  to: Square;
  promotion?: PromotionKind;
}

/**
 * A position with the moves that led to it, as the engine wants it: from `fen`, these moves were
 * played. The engine can only know that a position has come up before if it is told how the game
 * got there. `moves` may be empty: a position set up on the board, or loaded, has no past.
 */
export interface Setting {
  fen: string;
  moves: EngineMove[];
}

export interface Line {
  move: EngineMove;
  score: Score;
}

export interface Analysis {
  /** The move the engine would play. At reduced skill this is deliberately not always the best line. */
  best: EngineMove | null;
  /** The lines it looked at, best first. */
  lines: Line[];
  depth: number;
}

export interface SearchOptions {
  /** Search this many plies deep. */
  depth?: number;
  /** Search for at most this many milliseconds. With a depth as well, whichever comes first. */
  movetime?: number;
  /**
   * Search this many positions and no more. Unlike a time, this comes out the same on any machine
   * however busy it is, and unlike a depth it cannot run on for long in a tangled position.
   */
  nodes?: number;
  /** The moves played from the position given since the game (or the last move that cannot be undone), so that the engine knows what has stood before. */
  moves?: EngineMove[];
  /** How many alternative lines to report. */
  lines?: number;
  /** Stockfish's own handicap, 0 (weakest) to 20 (full strength). */
  skill?: number;
  /**
   * Asked when the search's turn comes. If it says the answer is no longer wanted, nothing is
   * searched and the analysis comes back empty (no best move, no lines).
   */
  stale?: () => boolean;
}

/** One number for a score, from the side to move's point of view, so that scores can be compared. */
export function centipawns(score: Score): number {
  if (score.mate !== undefined) return Math.sign(score.mate || 1) * (100000 - Math.abs(score.mate) * 100);
  return score.cp ?? 0;
}

export function uciOf(move: EngineMove): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

export function parseMove(uci: string): EngineMove | null {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  if (!m) return null;
  return { from: m[1] as Square, to: m[2] as Square, ...(m[3] ? { promotion: m[3] as PromotionKind } : {}) };
}

/** What an "info" line from the engine says, if it carries a scored line of play. */
export function parseInfo(line: string): { depth: number; index: number; score: Score; move: EngineMove } | null {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;
  const depth = /\bdepth (\d+)/.exec(line);
  const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
  const pv = /\bpv (\S+)/.exec(line);
  const index = /\bmultipv (\d+)/.exec(line);
  // A bound is not a score: the engine has only said the true value lies to one side of it.
  if (!depth || !score || !pv || /\b(lowerbound|upperbound)\b/.test(line)) return null;
  const move = parseMove(pv[1]!);
  if (!move) return null;
  return {
    depth: Number(depth[1]),
    index: index ? Number(index[1]) : 1,
    score: score[1] === 'cp' ? { cp: Number(score[2]) } : { mate: Number(score[2]) },
    move,
  };
}

export class Engine {
  private waiting: ((line: string) => void) | null = null;
  /** Ends whatever is being waited for with an error, so that nothing queued behind it waits for ever. */
  private abandon: ((error: Error) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private started: Promise<void> | null = null;
  private options = new Map<string, string>();
  private closed = false;
  private searching = false;

  constructor(private port: UciPort) {
    port.listen((line) => this.waiting?.(line.trim()));
  }

  /**
   * Wake the engine. Safe to call more than once; every search waits for it. Given a time limit
   * in milliseconds, an engine that has not answered by then is shut and the promise rejects:
   * a program that failed to load says nothing at all, and would otherwise be waited on for ever.
   */
  start(timeout?: number): Promise<void> {
    if (!this.started) {
      this.started = this.enqueue(async () => {
        await this.until('uci', (line) => line === 'uciok');
        await this.until('isready', (line) => line === 'readyok');
      });
      // Its failure is reported to whoever asked; a search that merely nudged it must not be left with an unhandled error.
      this.started.catch(() => {});
    }
    const started = this.started;
    if (timeout === undefined) return started;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error('The chess engine did not answer in time'));
      }, timeout);
      started.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Search a position. Searches run one at a time, in the order they were asked for. */
  analyse(fen: string, o: SearchOptions = {}): Promise<Analysis> {
    void this.start();
    return this.enqueue(async () => {
      if (o.stale?.()) return { best: null, lines: [], depth: 0 };
      this.set('MultiPV', String(o.lines ?? 1));
      this.set('Skill Level', String(o.skill ?? 20));
      this.port.send(o.moves && o.moves.length > 0 ? `position fen ${fen} moves ${o.moves.map(uciOf).join(' ')}` : `position fen ${fen}`);
      const found = new Map<number, Line>();
      let depth = 0;
      let best: EngineMove | null = null;
      let go = 'go';
      if (o.depth || (!o.movetime && !o.nodes)) go += ` depth ${o.depth ?? 10}`;
      if (o.nodes) go += ` nodes ${Math.round(o.nodes)}`;
      if (o.movetime) go += ` movetime ${Math.round(o.movetime)}`;
      this.searching = true;
      await this.until(go, (line) => {
        const info = parseInfo(line);
        if (info) {
          // A deeper pass replaces what the last one said about each line.
          if (info.depth > depth) depth = info.depth;
          found.set(info.index, { move: info.move, score: info.score });
          return false;
        }
        if (!line.startsWith('bestmove')) return false;
        best = parseMove(line.split(/\s+/)[1] ?? '');
        return true;
      });
      this.searching = false;
      const lines = [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
      return { best: best ?? lines[0]?.move ?? null, lines, depth };
    });
  }

  /**
   * A new game is beginning: the engine lets go of what it found in the last one, so that what it
   * says of this game does not hang on what came before it. In its turn, like a search.
   */
  newGame(): Promise<void> {
    void this.start();
    return this.enqueue(async () => {
      this.port.send('ucinewgame');
      await this.until('isready', (line) => line === 'readyok');
    });
  }

  /**
   * Cut short the search that is running, if one is. It answers at once with the best it has
   * found so far. Searches still waiting their turn are not affected.
   */
  stop(): void {
    if (this.searching && !this.closed) this.port.send('stop');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waiting = null;
    this.abandon?.(new Error('The engine has been closed'));
    this.abandon = null;
    this.port.send('quit');
    this.port.close();
  }

  // -- internals --------------------------------------------------------------

  private set(name: string, value: string): void {
    if (this.options.get(name) === value) return;
    this.options.set(name, value);
    this.port.send(`setoption name ${name} value ${value}`);
  }

  /** Send a command and wait until a line of the reply satisfies `done`. */
  private until(command: string, done: (line: string) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      this.abandon = reject;
      this.waiting = (line) => {
        if (!done(line)) return;
        this.waiting = null;
        this.abandon = null;
        resolve();
      };
      this.port.send(command);
    });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => (this.closed ? Promise.reject(new Error('The engine has been closed')) : job()));
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** How the computer plays at each level. */
export interface Level {
  id: string;
  label: string;
  /** For the player choosing: who this is for. */
  hint: string;
  skill: number;
  depth?: number;
  movetime?: number;
  /** How often, 0 to 1, it plays a move chosen with no thought at all. */
  slip: number;
  /** Whether it is told the moves that led to a position, and so knows (and keeps out of) a draw by repetition. The gentler levels are not: they play each position as it comes. */
  remembers?: boolean;
}

export const LEVELS: Level[] = [
  { id: 'first', label: 'First game', hint: 'As gentle as it gets. Half its moves are made without looking, and it gives pieces away', skill: 0, depth: 1, slip: 0.5 },
  { id: 'novice', label: 'Novice', hint: 'Still careless. It leaves pieces hanging and often misses yours', skill: 0, depth: 1, slip: 0.25 },
  { id: 'casual', label: 'Casual', hint: 'Knows the basics but makes plenty of mistakes', skill: 2, depth: 3, slip: 0.12 },
  { id: 'club', label: 'Club', hint: 'A steady opponent that punishes loose play', skill: 7, depth: 7, slip: 0.03 },
  { id: 'strong', label: 'Strong', hint: 'Hard to beat without real experience', skill: 14, depth: 11, slip: 0, remembers: true },
  { id: 'master', label: 'Master', hint: 'Full strength. It will not be beaten', skill: 20, movetime: 1200, slip: 0, remembers: true },
];
