/**
 * The hands' manners: the small things they do that are not chess (docs/manners.md).
 *
 * Every manner is a row in one table. A row says at what moment it may be chosen, what must be
 * true for it, and how rare it is. Of the rows that fit, the one with the most conditions wins:
 * a general answer to a moment is the fallback, and a rarer, exacter moment gets its own answer
 * without the general one having to be told to stand aside.
 *
 * This file knows nothing of hands. It only chooses; what a manner looks like is in stage.ts and
 * puppeteer.ts, under the same name.
 *
 * Three things keep it honest:
 *
 * - Fairness, by type. A row is written against `Told` (what both players can see) or against
 *   `Judged` (that, and what the engine thinks). A plain game has only a `Told` to give, so a row
 *   that would read the engine's mind is never looked at there, and could not read it if it were.
 * - The same on every screen. Chance is drawn from a seed, the ply and the row's own name, never
 *   from the clock or a die, so two players online see the same thing with nothing sent. What is
 *   part of a move (the moments `set` and `after`) goes by nothing else: its budget is counted from
 *   the game's own moves, so that a screen that comes to the game late, or has seen other games
 *   before it, can count it again and come to the same.
 * - Not too much. Rows that are not rituals share a budget for the game, and none plays twice
 *   running. The moments that go by each screen's own sense of time (sitting down, waiting,
 *   thinking) are only ever as each screen sees them: they keep the rest of the budget themselves,
 *   counting the moves' share as spent.
 */
import type { DrawReason, Kind, Motif, Side, Square, Status } from '../core/game';
import type { VerdictKind } from '../engine/verdict';

/** When the table is asked. */
export type Moment = 'sit' | 'wait' | 'think' | 'set' | 'after' | 'offer' | 'end' | 'poke';
/** The moments that are part of a move: what is chosen at them is the same on every screen. */
const OF_A_MOVE: ReadonlySet<Moment> = new Set<Moment>(['set', 'after']);

/** How often a row that fits is played. `always` is a ritual: it answers something that is rare by itself. */
export type Rarity = 'always' | 'often' | 'sometimes' | 'seldom' | 'once';

/** The chance each rarity has, when its row fits. A `once` is also never played twice in a sitting. */
export const CHANCE: Record<Rarity, number> = { always: 1, often: 1 / 5, sometimes: 1 / 12, seldom: 1 / 40, once: 1 / 12 };
/** A `seldom` row that has been seen in this sitting has this share of its chance left (not one that is part of a move: see `Manners`). */
export const SPENT = 0.1;
/** Rows that are not rituals: how many plies must lie between two of them, and how many a game may have. */
export const APART = 12;
export const MOST = 2;

/** What both players can see: the board, the record, the clocks, how the game ended. */
export interface Told {
  /** Plies played so far. */
  ply: number;
  /** Whose hands are being asked about. */
  side: Side;
  /** Whether it is that side to move. */
  toMove: boolean;
  /** Seconds since the last move was made: how long the player to move has been about it. */
  waited: number;
  /** A game between two people, with nothing said that the board does not say (director.ts, `plain`). */
  plain: boolean;
  /** How the game ended, if it has; and whether it ended this moment, or is only being shown as it ended. */
  result: Status['result'];
  drawReason: DrawReason | null;
  winner: Side | null;
  happened: boolean;
  /** Set when a server ended the game and not a player: time ran out, or somebody left or never came. */
  ended: 'time' | 'left' | 'noshow' | null;
  /** The player has asked their machine for less motion: rituals only. */
  quiet: boolean;
  /** How far ahead in stones `side` is, counted as players count them (a pawn one, a queen nine): less than nothing if it is behind. */
  ahead: number;
  /** A draw was offered earlier in this game, and refused. */
  refused: boolean;
  /** The move being made, or just made: null when the hands are asked about anything else. */
  move: Moved | null;
  /** What the move before it took, if it took anything. */
  tookBefore: Kind | null;
  /** How many checks running `side` has given, the move just made the last of them: none if it gave none. */
  checks: number;
  /** The game is a lesson. */
  lesson: boolean;
  /** The game is played against a clock. */
  timed: boolean;
  /** Seconds the stone that has just been turned from was held in thought. */
  held: number;
  /** How many times this turn the stone now in thought was turned to and let go before. */
  again: number;
  /** The greatest stone `side` has taken that stands in its drawer. */
  captive: Kind | null;
  /** A candle burns at the corner one of `side`'s hands rests over. */
  candle: boolean;
  /** `side`'s hands are the computer's; and it has another stone it could have moved. */
  computer: boolean;
  feint: boolean;
  /** The move gave mate; the mated king has no empty square beside it; and it is mated on its own back rank by a stone that came onto that rank. */
  mates: boolean;
  hemmed: boolean;
  backRank: boolean;
  /** What the record of the game shows, that the move just made the last of (stage.ts, `found`). */
  found: Found | null;
  /** How many queens the side that moved has, the move's own among them. */
  queens: number;
  /** What the player at this screen has done to their own hands, that the hands are asked about. */
  poked: Poked | null;
}

/**
 * Found in the record: a king stepped up to its second rank on its side's second move, and the
 * same by the other side straight after; Void having made, move for move, the first four moves
 * Ivory made; a knight set down again on the square it began the game on.
 */
export type Found = 'bongcloud' | 'bongcloud-both' | 'copycat' | 'home-again';
/** The pointer shaken over a resting hand; a weight on its cord pulled; the page come back to after a minute and more away. */
export type Poked = 'wave' | 'weight' | 'back';

/** A move, as anyone watching the board saw it made. */
export interface Moved {
  by: Side;
  kind: Kind;
  from: Square;
  to: Square;
  /** What it took, if anything; and whether it took in passing. */
  took: Kind | null;
  passing: boolean;
  /** What a pawn was made into on the last rank. */
  becomes: Kind | null;
  castle: 'short' | 'long' | null;
}

/** That, and what the engine made of the last move. Never to be had in a plain game. */
export interface Judged extends Told {
  verdict: VerdictKind | null;
  motifs: readonly Motif[];
}

interface Row<F, N extends string> {
  name: N;
  at: Moment;
  /** Every one of these must hold. How many there are is how specific the row is. */
  when: ReadonlyArray<(f: F) => boolean>;
  rarity: Rarity;
  /** Plies that must pass before it may be played again in the same game. */
  rest?: number;
}

export type Manner<N extends string = string> = ({ sees: 'told' } & Row<Told, N>) | ({ sees: 'judged' } & Row<Judged, N>);

/** A row that goes only by what both players can see. */
export function told<N extends string>(row: Row<Told, N>): Manner<N> {
  return { sees: 'told', ...row };
}

/** A row that goes by the engine's judgement as well. It is never chosen in a plain game. */
export function judged<N extends string>(row: Row<Judged, N>): Manner<N> {
  return { sees: 'judged', ...row };
}

const waiting = (f: Told) => !f.toMove && f.result === null;
const toMove = (f: Told) => f.toMove && f.result === null;
/** The game has this moment been drawn, in one of these ways. */
const drawn =
  (...reasons: DrawReason[]) =>
  (f: Told) =>
    f.result === 'draw' && f.happened && f.drawReason !== null && reasons.includes(f.drawReason);
/** It is `side` that is making the move. */
const moving = (f: Told) => f.move !== null && f.move.by === f.side;
/** A pawn going one square forward, taking nothing, and staying a pawn. */
const pawnStep = (f: Told) => f.move !== null && f.move.kind === 'p' && f.move.took === null && f.move.becomes === null && f.move.from[0] === f.move.to[0] && Math.abs(Number(f.move.from[1]) - Number(f.move.to[1])) === 1;
/** A stone carried and set down with nothing else to it: no castling, no taking in passing, no pawn made into anything, no queen taken. */
const ordinary = (f: Told) => f.move !== null && f.move.castle === null && !f.move.passing && f.move.becomes === null && f.move.took !== 'q';

/** The game has this moment been won by mate, and it is the winner's hands that are asked about. */
const mated = (f: Told) => f.result === 'checkmate' && f.happened && f.winner === f.side;
/** How many plies a game has had when White has made seven moves and Black six: a mate before White's eighth is an early one. */
const EARLY = 14;

/** The table. What each row looks like is in docs/manners.md, under the name in the comment. */
export const MANNERS = [
  // "Tip the king": a player has given the game up, and their own hand lays their king down.
  told({
    name: 'tip-the-king',
    at: 'end',
    when: [(f) => f.result === 'resigned', (f) => f.ended === null, (f) => f.winner !== null && f.side !== f.winner],
    rarity: 'always',
  }),
  // "Time": a clock ran out. Nobody gave anything up: the hands of the player it ran out on are cut down where they are.
  told({
    name: 'out-of-time',
    at: 'end',
    when: [(f) => f.result === 'resigned', (f) => f.ended === 'time', (f) => f.happened],
    rarity: 'always',
  }),
  // "Gone": a player left, or never came. Their hands go out, and the one who is left waves at where they were.
  told({
    name: 'gone',
    at: 'end',
    when: [(f) => f.result === 'resigned', (f) => f.ended === 'left' || f.ended === 'noshow', (f) => f.happened],
    rarity: 'always',
  }),
  // "Stalemate: the scuffle".
  told({ name: 'scuffle', at: 'end', when: [drawn('stalemate')], rarity: 'always' }),
  // "Repetition: rock, paper, scissors".
  told({ name: 'rock-paper-scissors', at: 'end', when: [drawn('threefold', 'fivefold')], rarity: 'always' }),
  // "Fifty moves: asleep".
  told({ name: 'asleep', at: 'end', when: [drawn('fifty-move', 'seventy-five-move')], rarity: 'always' }),
  // "Too little left".
  told({ name: 'empty-purse', at: 'end', when: [drawn('insufficient')], rarity: 'always' }),
  // "Agreed: the handshake".
  told({ name: 'handshake', at: 'end', when: [drawn('agreement')], rarity: 'always' }),
  // "The ladder of impatience", second rung: the hand of the player kept waiting drums on the rail.
  told({
    name: 'drum-on-the-rail',
    at: 'wait',
    when: [waiting, (f) => f.waited >= 30],
    rarity: 'seldom',
  }),
  // "Lace and steeple": the hands of the player to move, who has been some time about it, meet fingertip to fingertip.
  told({
    name: 'steeple',
    at: 'wait',
    when: [toMove, (f) => f.waited >= 20],
    rarity: 'seldom',
  }),
  // How a piece is set down. "The empty square": taking in passing, the pawn rapped once on the square it goes to, that has nothing on it.
  // Not against a clock: the rap, and the pawn taken away only after it, keep the other player waiting on the move while their time runs.
  told({ name: 'empty-square', at: 'set', when: [moving, (f) => f.move!.passing, (f) => !f.timed], rarity: 'always' }),
  // "The snap": a pawn made into something else changes when the hand that set it down snaps its fingers.
  told({ name: 'snap', at: 'set', when: [moving, (f) => f.move!.becomes !== null], rarity: 'always' }),
  // "Really?": a pawn made into anything but a queen. The other side's hand turns over, palm up.
  told({
    name: 'really',
    at: 'after',
    when: [(f) => f.move !== null && f.move.by !== f.side, (f) => f.move!.becomes !== null && f.move!.becomes !== 'q'],
    rarity: 'always',
  }),
  // "The trophy": a queen taken is held up at the top of the carry. Not the second of two queens taken one after the other.
  told({ name: 'trophy', at: 'set', when: [moving, (f) => f.move!.took === 'q', (f) => f.tookBefore !== 'q'], rarity: 'always' }),
  // "The pat": the king that has castled is tapped on its crown; twice, castling long.
  told({ name: 'pat', at: 'set', when: [moving, (f) => f.move!.castle !== null], rarity: 'often' }),
  // "The push": a pawn going one square early in the game is slid there by one finger, not carried.
  // Not against a clock: it is slower to the square than a carry.
  told({ name: 'push', at: 'set', when: [moving, pawnStep, (f) => f.ply <= 6, (f) => !f.timed], rarity: 'often' }),
  // "Squaring up": set down a little off and a little round, and nudged straight.
  told({ name: 'squaring-up', at: 'set', when: [moving, ordinary, (f) => !f.lesson], rarity: 'seldom' }),
  // "It wears off": checks given on moves running by the same side, the second, the third, and the fourth and on.
  told({ name: 'check-again', at: 'after', when: [moving, (f) => f.checks === 2], rarity: 'always' }),
  told({ name: 'check-thrice', at: 'after', when: [moving, (f) => f.checks === 3], rarity: 'always' }),
  told({ name: 'check-on', at: 'after', when: [moving, (f) => f.checks >= 4], rarity: 'always' }),

  // Sitting down. "Knuckles": before the first move Ivory's hands come together and press until they crack.
  told({ name: 'knuckles', at: 'sit', when: [(f) => f.side === 'w', (f) => f.ply === 0], rarity: 'often' }),

  // "The ladder of impatience", third rung: the hand kept waiting turns its wrist over and looks at the cord, where a watch would be.
  // Not against a clock, this rung or the next: a player whose time is running is not to be needled.
  told({ name: 'look-at-the-cord', at: 'wait', when: [waiting, (f) => f.waited >= 50, (f) => !f.timed], rarity: 'often' }),
  // The fourth and the fifth: it lies down along the rail, one finger tapping; and in the end that stops, and it sleeps.
  told({ name: 'lie-on-the-rail', at: 'wait', when: [waiting, (f) => f.waited >= 75, (f) => !f.timed], rarity: 'often' }),
  // "Captives": the hand kept waiting takes up the greatest stone it has taken, looks at it, and stands it back.
  told({ name: 'captives', at: 'wait', when: [waiting, (f) => f.captive !== null && f.captive !== 'p', (f) => f.waited >= 8], rarity: 'seldom' }),
  // "The candle": it warms itself at its flame, goes a little too low, and snatches back.
  told({ name: 'candle', at: 'wait', when: [waiting, (f) => f.candle, (f) => f.waited >= 12], rarity: 'seldom' }),

  // Thinking. "Second thought": a stone held in thought a while and then left for another. The finger wags as the hand goes.
  told({ name: 'second-thought', at: 'think', when: [toMove, (f) => f.held >= 1.5], rarity: 'always', rest: 6 }),
  // "J'adoube": the same stone turned to and let go twice in one turn. The third time, the hand sets it straight.
  told({ name: 'jadoube', at: 'think', when: [toMove, (f) => f.again >= 2], rarity: 'always' }),
  // "The feint": the computer's hand goes first to another stone it could have moved. Never the engine's second choice: any stone.
  told({ name: 'feint', at: 'think', when: [(f) => f.computer, (f) => f.feint, (f) => !f.lesson, (f) => !f.plain], rarity: 'sometimes' }),

  // Found on the board. "The Bongcloud": the king stepped up on its side's second move is patted; and if the other side has just done the same, more is made of it.
  told({ name: 'bongcloud', at: 'set', when: [moving, (f) => f.move!.kind === 'k', (f) => f.found === 'bongcloud', (f) => !f.lesson], rarity: 'always' }),
  told({ name: 'bongcloud-both', at: 'set', when: [moving, (f) => f.move!.kind === 'k', (f) => f.found === 'bongcloud-both', (f) => !f.lesson], rarity: 'always' }),
  // "Home again": a knight set down where it began. The hand lets go and flicks its fingers: never mind.
  told({ name: 'home-again', at: 'set', when: [moving, ordinary, (f) => f.found === 'home-again'], rarity: 'sometimes' }),
  // "The copycat": Void has made Ivory's first four moves after it. Ivory's hand waves, as at a mirror; and so does Void's.
  told({ name: 'copycat', at: 'after', when: [(f) => f.move !== null && f.move.by !== f.side, (f) => f.found === 'copycat', (f) => !f.lesson], rarity: 'always' }),
  // "A third queen": a side with two queens makes another. The other side's hands go limp, though nothing is over.
  told({ name: 'third-queen', at: 'after', when: [(f) => f.move !== null && f.move.by !== f.side, (f) => f.move!.becomes === 'q', (f) => f.queens >= 3], rarity: 'always' }),

  // "Mate, by what gave it". Smothered: a knight's mate on a king with no empty square beside it. The knight is patted.
  told({ name: 'smothered', at: 'set', when: [moving, (f) => f.mates, (f) => f.move!.kind === 'n', (f) => f.hemmed], rarity: 'always' }),
  // By a pawn: the pawn gives a small hop where it stands.
  told({ name: 'mate-by-pawn', at: 'set', when: [moving, (f) => f.mates, (f) => f.move!.kind === 'p', (f) => f.move!.becomes === null], rarity: 'always' }),
  // The back rank: the winner's hand sweeps flat along the rank, above the stones that shut their king in.
  told({ name: 'back-rank', at: 'end', when: [mated, (f) => f.move !== null, (f) => f.backRank], rarity: 'always' }),
  // By castling: both of the winner's hands turn palm up and dip. A bow.
  told({ name: 'mate-by-castling', at: 'end', when: [mated, (f) => f.move !== null, (f) => f.move!.castle !== null], rarity: 'always' }),
  // Early: the winner's hand brushes its thumb across its fingertips, twice. That is that.
  told({ name: 'early-mate', at: 'end', when: [mated, (f) => f.ply <= EARLY], rarity: 'always' }),
  // Laid down: now and then the winner's hand comes back, last of all, and lays the mated king on its side.
  told({ name: 'laid-down', at: 'end', when: [mated], rarity: 'often' }),

  // Set off by the player, at this screen only. "The wave": the pointer shaken over one's own resting hand.
  told({ name: 'wave', at: 'poke', when: [(f) => f.poked === 'wave'], rarity: 'always' }),
  // "The weight, pulled": a weight on its cord set swinging, and the hand looks at it.
  told({ name: 'weight-pulled', at: 'poke', when: [(f) => f.poked === 'weight'], rarity: 'always' }),
  // "Back": the page come back to after a minute and more. The hands start awake.
  told({ name: 'back', at: 'poke', when: [(f) => f.poked === 'back'], rarity: 'always' }),
] as const;

export type MannerName = (typeof MANNERS)[number]['name'];

/**
 * A number from 0 up to 1 that is always the same for the same seed, ply and name, and has
 * nothing to do with the one for any other.
 */
export function draw(seed: string, ply: number, name: string): number {
  const text = `${seed}|${ply}|${name}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Stirred, so that seeds and plies that differ by one letter or by one do not give numbers that lie together.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/**
 * Chooses from a table, and remembers what it has chosen: for one sitting, game after game.
 *
 * What is part of a move is chosen from the seed, the ply and what was chosen at the plies before
 * it in this game, and from nothing else: not from what this sitting has seen, nor from how long
 * anything took here. A screen that comes to a game part of the way through is told its moves
 * first (`Stage.seatTaken`), and so has the same to go by. The other moments go by each screen's
 * own time, and may differ between screens: those may also go by what the sitting has seen.
 */
export class Manners<N extends string = MannerName> {
  private seed = '';
  /** In this game: the ply each row was last played at. */
  private played = new Map<string, number>();
  /** For each ply of the game as it now stands: the row that is not a ritual that was part of its move, if one was. */
  private byMove: (string | null)[] = [];
  /** Of the moments that go by this screen's time, in this game: which row was played last, at what ply, and how many. */
  private last: string | null = null;
  private lastExtra = -Infinity;
  private extras = 0;
  /** In this sitting: every row that has been played. */
  private seen = new Set<string>();
  /** Every row that was looked at the last time the table was asked, fit or not: for the tests. */
  readonly considered: string[] = [];

  constructor(private table: ReadonlyArray<Manner<N>> = MANNERS as unknown as ReadonlyArray<Manner<N>>) {}

  /** A new game, with the seed its chances are drawn from. What has been seen in the sitting is kept. */
  begin(seed: string): void {
    this.seed = seed;
    this.played.clear();
    this.byMove = [];
    this.last = null;
    this.lastExtra = -Infinity;
    this.extras = 0;
  }

  /** What the hands do at this moment, going only by what both players can see; null for nothing out of the ordinary. */
  choose(at: Moment, facts: Told): N | null {
    this.considered.length = 0;
    const fit: Manner<N>[] = [];
    for (const row of this.table) {
      if (row.at !== at || row.sees !== 'told') continue;
      this.considered.push(row.name);
      if (row.when.every((holds) => holds(facts))) fit.push(row);
    }
    return this.pick(fit, facts, at);
  }

  /** The same, for a game in which the engine's judgement may be shown: every row is looked at. */
  chooseJudged(at: Moment, facts: Judged): N | null {
    this.considered.length = 0;
    const fit: Manner<N>[] = [];
    for (const row of this.table) {
      if (row.at !== at) continue;
      this.considered.push(row.name);
      if ((row.when as ReadonlyArray<(f: Judged) => boolean>).every((holds) => holds(facts))) fit.push(row);
    }
    return this.pick(fit, facts, at);
  }

  /**
   * The moves from ply `ply` on have been taken back: what was played at them may be played again
   * when they are made again, and what they spent of the game's budget is the game's again.
   */
  takeBack(ply: number): void {
    for (const [name, at] of this.played) if (at >= ply) this.played.delete(name);
    this.byMove.length = Math.min(this.byMove.length, ply);
  }

  /** Whether a row has been played in this sitting. */
  has(name: N): boolean {
    return this.seen.has(name);
  }

  private pick(fit: Manner<N>[], facts: Told, at: Moment): N | null {
    const ofMove = OF_A_MOVE.has(at);
    const rolls = new Map<string, number>();
    for (const row of fit) rolls.set(row.name, draw(this.seed, facts.ply, row.name));
    // The most specific first; between rows as specific as one another, the draw decides.
    fit.sort((a, b) => b.when.length - a.when.length || rolls.get(a.name)! - rolls.get(b.name)!);
    for (const row of fit) {
      if (!this.may(row, facts, ofMove, at)) continue;
      const chance = CHANCE[row.rarity] * (!ofMove && row.rarity === 'seldom' && this.seen.has(row.name) ? SPENT : 1);
      if (rolls.get(row.name)! >= chance) continue;
      this.played.set(row.name, facts.ply);
      this.seen.add(row.name);
      if (row.rarity !== 'always') {
        if (ofMove) this.byMove[facts.ply] = row.name;
        else {
          this.last = row.name;
          this.lastExtra = facts.ply;
          this.extras++;
        }
      }
      // Chosen as it is on every screen; a player who has asked for less motion is shown only the rituals of it.
      if (ofMove && facts.quiet && row.rarity !== 'always') return null;
      return row.name;
    }
    return null;
  }

  private may(row: Manner<N>, facts: Told, ofMove: boolean, at: Moment): boolean {
    const before = this.played.get(row.name);
    // Never twice in one ply; and not again until it has rested. (What the player sets off themself, they may set off again.)
    if (before !== undefined && at !== 'poke' && facts.ply - before <= (row.rest ?? 0)) return false;
    if (row.rarity === 'always') return true;
    if (!ofMove && facts.quiet) return false;
    if (row.rarity === 'once' && this.seen.has(row.name)) return false;
    // What the moves of this game have spent, at the plies before this one.
    let spent = 0;
    let lastAt = -Infinity;
    let lastName: string | null = null;
    for (let ply = 0; ply < Math.min(facts.ply, this.byMove.length); ply++) {
      const name = this.byMove[ply];
      if (!name) continue;
      spent++;
      lastAt = ply;
      lastName = name;
    }
    if (ofMove) return row.name !== lastName && spent < MOST && facts.ply - lastAt >= APART;
    return row.name !== this.last && this.extras + spent < MOST && facts.ply - Math.max(this.lastExtra, lastAt) >= APART;
  }
}
