/**
 * Rules core. A thin layer over chess.js that adds what the 3D game needs:
 * stable piece identities (so a piece keeps its mesh through castling,
 * en passant, promotion and undo), move options annotated for the beginner
 * aids, and a plain status object.
 *
 * chess.js stays the single source of truth for legality. This file has no
 * DOM or rendering imports, so the client, the tests and (later) the server
 * can all share it.
 */
import { Chess, type Move, type Square } from 'chess.js';
import { type Motif, motifsOf } from './tactics';

export type { Motif, Square };
export type Side = 'w' | 'b';
export type Kind = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type PromotionKind = 'q' | 'r' | 'b' | 'n';
export type CastleSide = 'k' | 'q';
/**
 * Why nobody won. Three are not on the board but decided by the players: 'agreement', both were
 * willing to stop; and 'threefold' and 'fifty-move', which end a game only when the player to move
 * claims them (FIDE 9.2, 9.3). 'fivefold' and 'seventy-five-move' end it by themselves (FIDE 9.6).
 * 'timeout': a player's time ran out, but the other could not have mated by any series of legal
 * moves, and so could not win (FIDE 6.9).
 */
export type DrawReason = 'stalemate' | 'threefold' | 'fifty-move' | 'fivefold' | 'seventy-five-move' | 'insufficient' | 'agreement' | 'timeout';
/** A draw the player to move may claim, and why: the position has stood three times, or fifty moves each have passed without a capture or a pawn move. */
export type DrawClaim = 'threefold' | 'fifty-move';

/**
 * A draw that is close but cannot yet be claimed: the position on the board has now come up twice
 * (a third time, and the player to move may claim a draw), or only `plies` single moves, counting
 * both sides', remain of the fifty each that may pass without a capture or a pawn move.
 */
export type DrawNear = { by: 'threefold' } | { by: 'fifty-move'; plies: number };

/** From this many moves before the fifty are up, a player is told. */
const FIFTY_WARNING = 20;
/** Single moves without a capture or a pawn move after which a draw may be claimed (fifty each), and after which the game is drawn without one (seventy-five each). */
const FIFTY = 100;
const SEVENTY_FIVE = 150;

export const FILES = 'abcdefgh';
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Conventional material values, used only to judge whether a move loses material. */
export const VALUE: Record<Kind, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

export function squareOf(file: number, rank: number): Square {
  return (FILES.charAt(file) + String(rank + 1)) as Square;
}
/** 0 for the a-file through 7 for the h-file. */
export function fileOf(square: Square): number {
  return square.charCodeAt(0) - 97;
}
/** 0 for rank 1 through 7 for rank 8. */
export function rankOf(square: Square): number {
  return square.charCodeAt(1) - 49;
}
export function opposite(side: Side): Side {
  return side === 'w' ? 'b' : 'w';
}

export interface PieceState {
  /** Stable for the life of the game. */
  readonly id: number;
  kind: Kind;
  readonly side: Side;
  square: Square;
}

export interface MoveOption {
  from: Square;
  to: Square;
  capture: boolean;
  enPassant: boolean;
  castle: CastleSide | null;
  /** A promotion piece must be supplied to play this move. */
  promotion: boolean;
  /** The moved piece can be taken on its new square for a net loss of material. */
  risky: boolean;
}

export interface Status {
  turn: Side;
  inCheck: boolean;
  /** Square of the king that is in check, if any. */
  checkedKing: Square | null;
  /** Squares of the pieces giving check. */
  checkers: Square[];
  over: boolean;
  /** How it ended. Some endings are not on the board: 'resigned', a player gave the game up (or their time ran out); and a draw agreed, claimed, or given when time ran out. */
  result: 'checkmate' | 'draw' | 'resigned' | null;
  winner: Side | null;
  drawReason: DrawReason | null;
  /** While the game goes on: the draw the player to move may claim now, if any (`Game.claimDraw`). */
  claimable: DrawClaim | null;
}

/** Everything that changed in one move, in terms of piece identities. */
export interface MoveEvent {
  san: string;
  side: Side;
  piece: { id: number; kind: Kind; from: Square; to: Square };
  captured: { id: number; kind: Kind; square: Square } | null;
  /** The rook's part of a castling move. */
  rook: { id: number; from: Square; to: Square } | null;
  castle: CastleSide | null;
  enPassant: boolean;
  /** The kind the pawn became, if it promoted. */
  promotion: PromotionKind | null;
  status: Status;
  /** What the move did beyond moving: forks, pins, discovered attacks, a sacrifice. */
  motifs: Motif[];
  /** Material in pawns: what the move took, and what its piece stands to lose, net, where it landed. */
  gained: number;
  exposure: number;
}

export class IllegalMoveError extends Error {}

export class Game {
  private chess: Chess;
  private bySquare = new Map<Square, PieceState>();
  private log: MoveEvent[] = [];
  /**
   * Each position that has stood, the first one first: what repetitions are counted by, and how
   * many moves had passed then without a capture or a pawn move. A position is the stones, the
   * side to move, the castling rights and a pawn that can really be taken in passing (FIDE 9.2.3):
   * the first four fields of the written position, which leaves out a pawn that a pin keeps from
   * being taken. (chess.js's own count notes that pawn all the same, and so counts one short.)
   */
  private seen: { key: string; quiet: number }[] = [];
  /** How often each position in `seen` has stood. */
  private times = new Map<string, number>();
  private initialFen: string;
  /** The side that has given the game up, if one has. */
  private gaveUp: Side | null = null;
  /** Whether the players have agreed to call the game a draw. */
  private agreed = false;
  /** The draw the player to move claimed, if one was. */
  private claimed: DrawClaim | null = null;
  /** Whether the game was drawn because time ran out against a player the other could not have mated. */
  private timedOut = false;
  /** The status of the position as it stands, worked out once: it is asked for often, and working it out means finding every move. */
  private known: Status | null = null;

  constructor(fen: string = START_FEN) {
    this.initialFen = tidyFen(fen);
    this.chess = new Chess(this.initialFen);
    this.note();
    this.assignIdentities();
  }

  /** Replace the position. Throws if the FEN is invalid. */
  load(fen: string = START_FEN): void {
    const tidy = tidyFen(fen);
    this.chess = new Chess(tidy);
    this.known = null;
    this.initialFen = tidy;
    this.log = [];
    this.seen = [];
    this.times.clear();
    this.note();
    this.reopen();
    this.assignIdentities();
  }

  /** Count the position now on the board as having stood once more. */
  private note(): void {
    this.known = null;
    const fields = this.chess.fen().split(' ');
    const key = fields.slice(0, 4).join(' ');
    this.seen.push({ key, quiet: Number(fields[4]) || 0 });
    this.times.set(key, (this.times.get(key) ?? 0) + 1);
  }

  /** Forget the position now on the board, as its move is taken back. */
  private unnote(): void {
    this.known = null;
    const last = this.seen.pop();
    if (!last) return;
    const n = (this.times.get(last.key) ?? 1) - 1;
    if (n > 0) this.times.set(last.key, n);
    else this.times.delete(last.key);
  }

  /** How many times the position now on the board has stood, this time included. */
  repetitions(): number {
    const now = this.seen[this.seen.length - 1];
    return now ? (this.times.get(now.key) ?? 1) : 1;
  }

  /**
   * Give the game up for a side: the other wins. Returns false, and changes nothing, if the game
   * is already over.
   */
  resign(side: Side): boolean {
    if (this.status().over) return false;
    this.gaveUp = side;
    this.known = null;
    return true;
  }

  /** The side that has given the game up, if one has. */
  resigned(): Side | null {
    return this.gaveUp;
  }

  /**
   * End the game as a draw because both players are willing to. Returns false, and changes
   * nothing, if the game is already over.
   */
  agreeDraw(): boolean {
    if (this.status().over) return false;
    this.agreed = true;
    this.known = null;
    return true;
  }

  /** Whether the game was ended as a draw by the players' agreement. */
  drawAgreed(): boolean {
    return this.agreed;
  }

  /**
   * The player to move claims the draw the position allows: it has stood three times, or fifty
   * moves each have passed without a capture or a pawn move. Returns false, and changes nothing,
   * if there is none to claim (or the game is over).
   */
  claimDraw(): boolean {
    const claim = this.status().claimable;
    if (!claim) return false;
    this.claimed = claim;
    this.known = null;
    return true;
  }

  /** The draw that was claimed, if one was. */
  drawClaimed(): DrawClaim | null {
    return this.claimed;
  }

  /**
   * A side's time has run out, and the other side could not have mated it by any series of legal
   * moves: the game is drawn (FIDE 6.9). Returns false, and changes nothing, if the game is
   * already over. Whether the other side could have mated is for the caller to ask (`couldMate`).
   */
  drawOnTime(): boolean {
    if (this.status().over) return false;
    this.timedOut = true;
    this.known = null;
    return true;
  }

  /** Whether the game was drawn because time ran out against a player who could not have been mated. */
  drawnOnTime(): boolean {
    return this.timedOut;
  }

  /** Whether the game was ended by the players or their clocks and not by a move: given up, agreed or claimed drawn, or drawn on time. */
  endedOffBoard(): boolean {
    return this.gaveUp !== null || this.agreed || this.claimed !== null || this.timedOut;
  }

  /** Take up again a game ended off the board: a resignation, or an agreed, claimed or timed draw, is forgotten. Returns whether there was one. */
  reopen(): boolean {
    const had = this.endedOffBoard();
    this.gaveUp = null;
    this.agreed = false;
    this.claimed = null;
    this.timedOut = false;
    this.known = null;
    return had;
  }

  /**
   * Whether `side` could ever give mate, by any series of legal moves at all, however badly the
   * other side played (FIDE 6.9: it is what decides a game whose clock has run out). Not with a
   * bare king; not with a knight alone, unless the other side has something besides its king and
   * queens to hem its own king in; not with bishops all on squares of one colour, unless there is
   * a pawn or a knight on the board or a bishop on the other colour. Two knights can: mate is
   * possible with help.
   */
  couldMate(side: Side): boolean {
    const mine: Kind[] = [];
    const theirs: Kind[] = [];
    let knights = 0;
    let pawns = 0;
    const bishopColours = new Set<number>();
    for (const p of this.bySquare.values()) {
      (p.side === side ? mine : theirs).push(p.kind);
      if (p.kind === 'n') knights++;
      if (p.kind === 'p') pawns++;
      if (p.kind === 'b') bishopColours.add((fileOf(p.square) + rankOf(p.square)) % 2);
    }
    if (mine.some((k) => k === 'p' || k === 'r' || k === 'q')) return true;
    if (mine.includes('n')) {
      // A knight and nothing else: mate needs the other king hemmed in by its own men, and a queen will not do (it can always take or step aside).
      return mine.length > 2 || theirs.some((k) => k !== 'k' && k !== 'q');
    }
    if (mine.includes('b')) return bishopColours.size > 1 || pawns > 0 || knights > 0;
    return false;
  }

  /** Who moved first and what that move was numbered, for a game that began from a set position. */
  start(): { side: Side; moveNumber: number } {
    const fields = this.initialFen.split(/\s+/);
    const moveNumber = Number(fields[5]);
    return { side: fields[1] === 'b' ? 'b' : 'w', moveNumber: Number.isInteger(moveNumber) && moveNumber > 0 ? moveNumber : 1 };
  }

  fen(): string {
    return this.chess.fen();
  }

  /**
   * The position as the engine should be shown it: a starting position and the moves played from
   * it, so that it knows what has stood before. The start is the game's own, or the position just
   * after the last capture or pawn move, before which nothing can come round again. A position set
   * up or loaded has no moves; the count towards the fifty-move draw is carried by the FEN that
   * starts the line, and the engine goes on counting from it.
   */
  engineLine(): { fen: string; moves: { from: Square; to: Square; promotion?: PromotionKind }[] } {
    let k = 0;
    for (let i = this.seen.length - 1; i > 0; i--) {
      if (this.seen[i]!.quiet === 0) {
        k = i;
        break;
      }
    }
    let fen = this.initialFen;
    if (k > 0) {
      const replay = new Chess(this.initialFen);
      for (let i = 0; i < k; i++) replay.move(this.log[i]!.san);
      fen = replay.fen();
    }
    return {
      fen,
      moves: this.log.slice(k).map((e) => ({ from: e.piece.from, to: e.piece.to, ...(e.promotion ? { promotion: e.promotion } : {}) })),
    };
  }

  startFen(): string {
    return this.initialFen;
  }

  turn(): Side {
    return this.chess.turn();
  }

  /** Snapshot of the pieces on the board, ordered by identity. Safe to keep; never mutated. */
  pieces(): PieceState[] {
    return [...this.bySquare.values()].map((p) => ({ ...p })).sort((a, b) => a.id - b.id);
  }

  pieceAt(square: Square): PieceState | null {
    const p = this.bySquare.get(square);
    return p ? { ...p } : null;
  }

  history(): MoveEvent[] {
    return this.log.slice();
  }

  lastMove(): MoveEvent | null {
    return this.log[this.log.length - 1] ?? null;
  }

  /** Kinds captured so far, keyed by the side that lost them. */
  captured(): Record<Side, Kind[]> {
    const out: Record<Side, Kind[]> = { w: [], b: [] };
    for (const e of this.log) {
      if (e.captured) out[opposite(e.side)].push(e.captured.kind);
    }
    return out;
  }

  status(): Status {
    // A copy, so that whoever is handed it may keep or change it.
    if (this.known) return { ...this.known, checkers: [...this.known.checkers] };
    const c = this.chess;
    const turn = c.turn();
    const inCheck = c.isCheck();
    let result: Status['result'] = null;
    let winner: Side | null = null;
    let drawReason: DrawReason | null = null;
    if (c.isCheckmate()) {
      result = 'checkmate';
      winner = opposite(turn);
    } else if (c.isStalemate()) {
      result = 'draw';
      drawReason = 'stalemate';
    } else if (c.isInsufficientMaterial()) {
      result = 'draw';
      drawReason = 'insufficient';
    } else if (this.repetitions() >= 5) {
      result = 'draw';
      drawReason = 'fivefold';
    } else if (this.quiet() >= SEVENTY_FIVE) {
      result = 'draw';
      drawReason = 'seventy-five-move';
    } else if (this.claimed) {
      result = 'draw';
      drawReason = this.claimed;
    } else if (this.agreed) {
      result = 'draw';
      drawReason = 'agreement';
    } else if (this.timedOut) {
      result = 'draw';
      drawReason = 'timeout';
    } else if (this.gaveUp) {
      result = 'resigned';
      winner = opposite(this.gaveUp);
    }
    const over = result !== null;
    // A position that has stood three times, or fifty moves each without a capture or a pawn move:
    // the player to move may claim a draw, and the game goes on until they do.
    const claimable: DrawClaim | null = over ? null : this.repetitions() >= 3 ? 'threefold' : this.quiet() >= FIFTY ? 'fifty-move' : null;
    const checkedKing = inCheck ? (c.findPiece({ type: 'k', color: turn })[0] ?? null) : null;
    const checkers = checkedKing ? c.attackers(checkedKing, opposite(turn)) : [];
    this.known = { turn, inCheck, checkedKing, checkers, over, result, winner, drawReason, claimable };
    return { ...this.known, checkers: [...checkers] };
  }

  /** How many single moves have passed without a capture or a pawn move. */
  private quiet(): number {
    return this.seen[this.seen.length - 1]?.quiet ?? 0;
  }

  /**
   * A draw that is about to become one a player may claim, so that a player can be told before it
   * does and not after. Null while none is close, while one may be claimed already, and once the
   * game is over.
   */
  drawNear(): DrawNear | null {
    const status = this.status();
    if (status.over || status.claimable) return null;
    // Counted exactly as a claim will count it when the position comes up again.
    if (this.repetitions() >= 2) return { by: 'threefold' };
    const plies = FIFTY - this.quiet();
    return plies <= FIFTY_WARNING ? { by: 'fifty-move', plies } : null;
  }

  /**
   * Legal moves for the piece on a square, one entry per destination
   * (the four promotion choices collapse into one option).
   * Empty if the square is empty, holds the other side's piece, or the game is over.
   */
  movesFrom(square: Square): MoveOption[] {
    if (this.status().over) return [];
    const moves = this.chess.moves({ square, verbose: true });
    const byTarget = new Map<Square, MoveOption>();
    for (const m of moves) {
      if (byTarget.has(m.to)) continue;
      byTarget.set(m.to, {
        from: m.from,
        to: m.to,
        capture: takes(m),
        enPassant: m.isEnPassant(),
        castle: m.isKingsideCastle() ? 'k' : m.isQueensideCastle() ? 'q' : null,
        promotion: m.isPromotion(),
        risky: this.losesMaterial(m),
      });
    }
    return [...byTarget.values()];
  }

  /** Every legal move in the position, each promotion choice separately. Cheap: nothing is judged. */
  moves(): { from: Square; to: Square; promotion?: PromotionKind }[] {
    if (this.status().over) return [];
    // Square by square from a8 along each rank and castling last, which is the order chess.js lists them in itself.
    const out: { from: Square; to: Square; promotion?: PromotionKind }[] = [];
    const castling: { from: Square; to: Square }[] = [];
    for (let rank = 7; rank >= 0; rank--) {
      for (let file = 0; file < 8; file++) {
        const from = squareOf(file, rank);
        for (const w of this.written(from)) {
          if (w.castle) castling.push({ from, to: w.to });
          else out.push({ from, to: w.to, ...(w.promotion ? { promotion: w.promotion } : {}) });
        }
      }
    }
    return [...out, ...castling];
  }

  /**
   * The legal moves of the piece on a square, read from the way chess.js writes them. Asking it
   * for each move in full has it list every legal move again for every one of them, which made a
   * whole position cost a millisecond; the written form is all that is needed to know a move.
   */
  private written(from: Square): Written[] {
    return this.chess.moves({ square: from }).map((san) => readWritten(san, from));
  }

  /**
   * The move a player means by what they typed, if it is one in this position: the way moves
   * are written ("Nf3", "exd5", "O-O", "e8=Q") or simply the two squares ("g1f3", "e7e8q").
   * Forgiving of case, of spaces and of the marks people add or leave out ("x", "+", "#", "=").
   * A pawn reaching the last rank may leave out what it becomes; then `promotion` is not set,
   * and the player is to be asked. Null when it is no move here, or could be more than one.
   */
  readMove(text: string): { from: Square; to: Square; promotion?: PromotionKind } | null {
    if (this.status().over) return null;
    let typed = text.trim().replace(/[\s+#!?]/g, '');
    if (typed === '') return null;
    // Castling, written with letters, noughts or either, with or without the dashes.
    const castle = /^[0oO]-?[0oO](-?[0oO])?$/.exec(typed);
    if (castle) typed = castle[1] ? 'O-O-O' : 'O-O';
    // What is left out or put in freely: the capture mark, the dash between two squares, the equals sign.
    const plain = (s: string) => (s.startsWith('O-O') ? s : s.replace(/[xX=:-]/g, ''));
    typed = plain(typed);

    type Read = { from: Square; to: Square; promotion?: PromotionKind };
    const exact: Read[] = [];
    const loose: Read[] = [];
    for (const m of this.chess.moves({ verbose: true })) {
      const read: Read = { from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion as PromotionKind } : {}) };
      const san = plain(m.san.replace(/[+#]/g, ''));
      // The written move, the two squares, and for a pawn made into something greater, either without saying what.
      const forms = [san, m.from + m.to + (m.promotion ?? '')];
      if (m.promotion) forms.push(san.slice(0, -1), m.from + m.to);
      if (forms.includes(typed)) exact.push(read);
      else if (forms.some((f) => f.toLowerCase() === typed.toLowerCase())) loose.push(read);
    }
    // Case decides between a bishop's move and a pawn's ("Bc3", "bc3") where both could be meant.
    const found = exact.length > 0 ? exact : loose;
    if (found.length === 0) return null;
    const first = found[0]!;
    if (found.length === 1) return first;
    // Several, all one pawn's step to the last rank: the move is clear, only what it becomes is not.
    if (found.every((m) => m.from === first.from && m.to === first.to && m.promotion)) return { from: first.from, to: first.to };
    return null;
  }

  /**
   * The squares round the king of the side to move that are not held by its own pieces, and
   * whether the other side covers each. In a stalemate these show why the king cannot move
   * though nothing attacks him.
   */
  kingFlights(): { square: Square; covered: boolean }[] {
    const turn = this.chess.turn();
    const king = this.chess.findPiece({ type: 'k', color: turn })[0];
    if (!king) return [];
    const out: { square: Square; covered: boolean }[] = [];
    for (let df = -1; df <= 1; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        const file = fileOf(king) + df;
        const rank = rankOf(king) + dr;
        if ((df === 0 && dr === 0) || file < 0 || file > 7 || rank < 0 || rank > 7) continue;
        const square = squareOf(file, rank);
        if (this.chess.get(square)?.color === turn) continue;
        out.push({ square, covered: this.chess.isAttacked(square, opposite(turn)) });
      }
    }
    return out;
  }

  /** True if any legal move exists for the piece on this square. */
  canMove(square: Square): boolean {
    return !this.status().over && this.chess.moves({ square }).length > 0;
  }

  /**
   * Play a move. `promotion` is required when a pawn reaches the last rank.
   * Throws IllegalMoveError if the move is not legal in the current position.
   */
  move(from: Square, to: Square, promotion?: PromotionKind): MoveEvent {
    if (this.status().over) throw new IllegalMoveError('The game is over');
    const first = this.written(from).find((w) => w.to === to);
    if (!first) throw new IllegalMoveError(`Illegal move ${from}-${to}`);
    const needsPromotion = first.promotion !== undefined;
    if (needsPromotion && !promotion) throw new IllegalMoveError(`Move ${from}-${to} needs a promotion piece`);

    const mover = this.bySquare.get(from);
    if (!mover) throw new IllegalMoveError(`No tracked piece on ${from}`);

    // Everything the move touches is looked up before it is applied, so a failure leaves the game untouched.
    // A pawn that takes on an empty square has taken in passing: its captive stands beside it.
    const capSquare = first.capture ? (this.chess.get(to) ? to : squareOf(fileOf(to), rankOf(from))) : null;
    const victim = capSquare ? this.bySquare.get(capSquare) : undefined;
    if (capSquare && !victim) throw new IllegalMoveError(`No tracked piece to take on ${capSquare}`);
    const castle = first.castle;
    const rookFrom = castle ? squareOf(castle === 'k' ? 7 : 0, rankOf(from)) : null;
    const rookTo = castle ? squareOf(castle === 'k' ? 5 : 3, rankOf(from)) : null;
    const castler = rookFrom ? this.bySquare.get(rookFrom) : undefined;
    if (rookFrom && !castler) throw new IllegalMoveError(`No tracked rook on ${rookFrom}`);

    const m = this.chess.move({ from, to, promotion: needsPromotion ? promotion : undefined });

    let captured: MoveEvent['captured'] = null;
    if (capSquare && victim) {
      this.bySquare.delete(capSquare);
      captured = { id: victim.id, kind: victim.kind, square: capSquare };
    }

    const kindBefore = mover.kind;
    this.bySquare.delete(from);
    mover.square = to;
    if (m.promotion) mover.kind = m.promotion as PromotionKind;
    this.bySquare.set(to, mover);

    let rook: MoveEvent['rook'] = null;
    if (castler && rookFrom && rookTo) {
      this.bySquare.delete(rookFrom);
      castler.square = rookTo;
      this.bySquare.set(rookTo, castler);
      rook = { id: castler.id, from: rookFrom, to: rookTo };
    }

    // The new position has stood once more: the status (a repetition, the moves without a capture) counts it.
    this.note();
    const status = this.status();
    const gained = captured ? VALUE[captured.kind] : 0;
    // What the opponent can win back on that square, and whether a pawn that stepped twice can be taken in passing.
    let exposure = this.chess.isAttacked(to, this.chess.turn()) ? exchangeGain(this.chess, to) : 0;
    if (m.isBigPawn()) exposure = Math.max(exposure, enPassantLoss(this.chess, to));
    const event: MoveEvent = {
      san: m.san,
      side: m.color,
      piece: { id: mover.id, kind: kindBefore, from, to },
      captured,
      rook,
      castle,
      enPassant: m.isEnPassant(),
      promotion: (m.promotion as PromotionKind | undefined) ?? null,
      status,
      motifs: status.over ? [] : motifsOf(this.chess, { from, to, captured: captured?.kind ?? null, exposure, inCheck: status.inCheck }),
      gained,
      exposure,
    };
    this.log.push(event);
    return event;
  }

  /** Take back the last move. Returns the move that was undone, or null if there is none. */
  undo(): MoveEvent | null {
    // A game that goes back a move is being played again: nobody has given it up, agreed or claimed a draw, or run out of time.
    this.reopen();
    const event = this.log.pop();
    if (!event) return null;
    this.unnote();
    this.chess.undo();
    this.known = null;

    const mover = this.bySquare.get(event.piece.to);
    if (!mover) throw new Error(`Identity tracking lost the piece on ${event.piece.to}`);
    this.bySquare.delete(event.piece.to);
    mover.square = event.piece.from;
    mover.kind = event.piece.kind;
    this.bySquare.set(event.piece.from, mover);

    if (event.rook) {
      const r = this.bySquare.get(event.rook.to);
      if (!r) throw new Error(`Identity tracking lost the rook on ${event.rook.to}`);
      this.bySquare.delete(event.rook.to);
      r.square = event.rook.from;
      this.bySquare.set(event.rook.from, r);
    }
    if (event.captured) {
      this.bySquare.set(event.captured.square, {
        id: event.captured.id,
        kind: event.captured.kind,
        side: opposite(event.side),
        square: event.captured.square,
      });
    }
    return event;
  }

  /** Number of positions reachable in `depth` plies. Exposed for the rules tests. */
  perft(depth: number): number {
    return this.chess.perft(depth);
  }

  // -- internals ------------------------------------------------------------

  private assignIdentities(): void {
    this.bySquare.clear();
    let id = 0;
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const square = squareOf(file, rank);
        const p = this.chess.get(square);
        if (p) this.bySquare.set(square, { id: id++, kind: p.type, side: p.color, square });
      }
    }
  }

  /**
   * Would this move lose material on the destination square? Plays the move,
   * runs a static exchange evaluation for the opponent on that square, and
   * compares it with what the move itself captured.
   */
  private losesMaterial(m: Move): boolean {
    const gained = m.captured ? VALUE[m.captured] : 0;
    const chess = this.chess;
    chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    // Most squares are not attacked at all; the exchange only needs working out when one is.
    let lost = chess.isAttacked(m.to, chess.turn()) ? exchangeGain(chess, m.to) : 0;
    if (m.isBigPawn()) lost = Math.max(lost, enPassantLoss(chess, m.to));
    chess.undo();
    return lost > gained;
  }
}

/**
 * chess.js accepts a position whose castling rights or en passant square do not match the pieces
 * on the board, and then offers moves that cannot be played. This drops any such claim. A FEN
 * that is malformed is returned as it is, for chess.js to reject.
 */
export function tidyFen(fen: string): string {
  const fields = fen.trim().split(/\s+/);
  const rows = (fields[0] ?? '').split('/');
  if (fields.length < 4 || rows.length !== 8) return fen;

  /** The FEN letter on a square, or null if it is empty. Rank 0 is rank 1. */
  const at = (file: number, rank: number): string | null => {
    let f = 0;
    for (const ch of rows[7 - rank]!) {
      if (ch >= '1' && ch <= '8') {
        f += Number(ch);
        if (f > file) return null;
      } else {
        if (f === file) return ch;
        f++;
      }
    }
    return null;
  };

  const rights = fields[2]!;
  let kept = '';
  if (rights.includes('K') && at(4, 0) === 'K' && at(7, 0) === 'R') kept += 'K';
  if (rights.includes('Q') && at(4, 0) === 'K' && at(0, 0) === 'R') kept += 'Q';
  if (rights.includes('k') && at(4, 7) === 'k' && at(7, 7) === 'r') kept += 'k';
  if (rights.includes('q') && at(4, 7) === 'k' && at(0, 7) === 'r') kept += 'q';
  fields[2] = kept || '-';

  const target = fields[3]!;
  if (/^[a-h][36]$/.test(target)) {
    const file = target.charCodeAt(0) - 97;
    const rank = target.charCodeAt(1) - 49;
    // With White to move, Black has just pushed: the square is on rank 6 with the pawn below it on rank 5.
    const real =
      fields[1] === 'w'
        ? rank === 5 && at(file, 4) === 'p' && at(file, 5) === null
        : rank === 2 && at(file, 3) === 'P' && at(file, 2) === null;
    if (!real) fields[3] = '-';
  }
  return fields.join(' ');
}

/** A move as far as its written form tells it. */
interface Written {
  to: Square;
  capture: boolean;
  castle: CastleSide | null;
  /** What the pawn becomes, in a move to the last rank. */
  promotion?: PromotionKind;
}

/** Reads a move chess.js has written ("Nf3", "exd5", "e8=Q+", "O-O") for the piece on `from`. */
function readWritten(san: string, from: Square): Written {
  if (san.startsWith('O-O')) {
    const castle: CastleSide = san.startsWith('O-O-O') ? 'q' : 'k';
    return { to: squareOf(castle === 'k' ? 6 : 2, rankOf(from)), capture: false, castle };
  }
  const m = /([a-h][1-8])(?:=([QRBN]))?[+#]?$/.exec(san);
  if (!m) throw new Error(`A move written in a way that cannot be read: ${san}`);
  return { to: m[1] as Square, capture: san.includes('x'), castle: null, ...(m[2] ? { promotion: m[2].toLowerCase() as PromotionKind } : {}) };
}

/** chess.js reports en passant separately from ordinary captures; the game treats both as taking a piece. */
function takes(m: Move): boolean {
  return m.isCapture() || m.isEnPassant();
}

/**
 * Static exchange evaluation: the material the side to move can win by starting
 * a sequence of captures on `square`, each side always recapturing with its
 * least valuable piece and stopping when continuing would lose material.
 * A capture that is not legal (by a pinned piece, or by a king stepping into
 * an attack) is passed over, so pins are respected.
 *
 * It asks chess.js only for the pieces that bear on the square. Listing every
 * legal move in full at each step made choosing a piece stall for a tenth of
 * a second and more.
 */
function exchangeGain(chess: Chess, square: Square): number {
  const target = chess.get(square);
  const side = chess.turn();
  if (!target || target.color === side) return 0;
  const attackers = chess
    .attackers(square, side)
    .map((from) => ({ from, kind: chess.get(from)!.type as Kind }))
    .sort((a, b) => VALUE[a.kind] - VALUE[b.kind]);
  const lastRank = square.endsWith('8') || square.endsWith('1');
  for (const a of attackers) {
    try {
      chess.move({ from: a.from, to: square, promotion: a.kind === 'p' && lastRank ? 'q' : undefined });
    } catch {
      continue;
    }
    const reply = exchangeGain(chess, square);
    chess.undo();
    return Math.max(0, VALUE[target.type as Kind] - reply);
  }
  return 0;
}

/**
 * What the side to move wins by taking, en passant, the pawn that has just
 * advanced two squares to `pawn`. Nothing if no pawn can.
 */
function enPassantLoss(chess: Chess, pawn: Square): number {
  const side = chess.turn();
  const file = fileOf(pawn);
  const rank = rankOf(pawn);
  const passed = squareOf(file, rank + (side === 'b' ? -1 : 1));
  let worst = 0;
  for (const f of [file - 1, file + 1]) {
    if (f < 0 || f > 7) continue;
    const from = squareOf(f, rank);
    const taker = chess.get(from);
    if (!taker || taker.type !== 'p' || taker.color !== side) continue;
    try {
      chess.move({ from, to: passed });
    } catch {
      continue;
    }
    const reply = exchangeGain(chess, passed);
    chess.undo();
    worst = Math.max(worst, VALUE.p - reply);
  }
  return worst;
}
