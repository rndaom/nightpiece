/**
 * The game's plain words for what is happening: the rules explained the
 * first time each comes up, what a hinted move does, and what a blunder
 * would cost.
 *
 * Everything here is text worked out from the position. It draws nothing
 * and can be tested by itself.
 */
import { type DrawClaim, type DrawNear, Game, type Kind, type MoveEvent, type Side, type Square, type Status } from '../core/game';
import type { Analysis, EngineMove } from '../engine/uci';
import { quietReason } from './reasons';

export const KIND_NAME: Record<Kind, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
export const SIDE_NAME: Record<Side, string> = { w: 'Ivory', b: 'Void' };

/**
 * The state of the game in plain language. `you` is the side this screen plays, when it plays
 * only one; the wording then speaks to that player.
 */
export function describeStatus(s: Status, you: Side | null = null): { headline: string; detail: string | null } {
  const king = (side: Side) => (side === you ? 'Your king' : `The ${SIDE_NAME[side]} king`);
  if (s.result === 'checkmate' && s.winner) {
    const won = you === s.winner ? 'You win.' : `${SIDE_NAME[s.winner]} wins.`;
    return { headline: 'Checkmate', detail: `${won} ${king(s.turn)} is attacked and has no escape.` };
  }
  if (s.result === 'resigned' && s.winner) {
    const loser = s.winner === 'w' ? 'b' : 'w';
    if (you === s.winner) return { headline: 'You win', detail: `${SIDE_NAME[loser]} resigned.` };
    if (you === loser) return { headline: 'You resigned', detail: `${SIDE_NAME[s.winner]} wins.` };
    return { headline: `${SIDE_NAME[loser]} resigns`, detail: `${SIDE_NAME[s.winner]} wins.` };
  }
  if (s.result === 'draw') {
    const stuck = s.turn === you ? 'You have' : `${SIDE_NAME[s.turn]} has`;
    const other: Side = s.turn === 'w' ? 'b' : 'w';
    const detail = {
      // The one that is always taken for checkmate, so it says first what it is not.
      stalemate: `A draw, not checkmate. ${king(s.turn)} is not attacked: nothing points at him. ${stuck} no legal move, though (the hatched squares are all covered), and a player who cannot move and is not in check has not lost. Nobody wins.`,
      threefold: 'Draw by repetition (claimed): the same position came up three times.',
      'fifty-move': 'Draw by the fifty-move rule (claimed): fifty moves each without a capture or a pawn move.',
      fivefold: 'The position came up five times, which ends the game by itself.',
      'seventy-five-move': 'Seventy-five moves each without a capture or a pawn move, which ends the game by itself.',
      insufficient: 'Neither side has enough pieces left to checkmate.',
      agreement: 'Agreed by both players.',
      // A flag falls on the side to move.
      timeout: `${s.turn === you ? 'You' : SIDE_NAME[s.turn]} ran out of time, but ${other === you ? 'you' : SIDE_NAME[other]} could not have mated.`,
    }[s.drawReason ?? 'stalemate'];
    return { headline: s.drawReason === 'stalemate' ? 'Stalemate' : 'Draw', detail };
  }
  if (s.inCheck) {
    return { headline: 'Check', detail: `${king(s.turn)} is under attack and must get safe.` };
  }
  return { headline: s.turn === you ? 'Your move' : `${SIDE_NAME[s.turn]} to move`, detail: null };
}

/**
 * A draw that is about to become one a player may claim, said before it does. It is claimed, not
 * given: the game goes on until the player to move asks for it (FIDE 9.2, 9.3).
 */
export function describeDrawNear(near: DrawNear): string {
  if (near.by === 'threefold') return 'This position has come up twice. A third time, and a draw may be claimed.';
  // The count is of single moves. An even one is so many each; an odd one is the move about to be made, and then so many each.
  const each = Math.floor(near.plies / 2);
  if (near.plies % 2 === 0) return `${each === 1 ? 'One more move' : `${each} more moves`} each without a capture or a pawn move, and a draw may be claimed.`;
  if (each === 0) return 'After this move a draw may be claimed, unless it takes a stone or moves a pawn.';
  return `This move, then ${each === 1 ? 'one more' : `${each} more`} each, without a capture or a pawn move, and a draw may be claimed.`;
}

/** Why a draw may be claimed now, as the question before claiming it puts it. */
export function describeClaim(claim: DrawClaim): string {
  return claim === 'threefold'
    ? 'This position has come up three times. Claim a draw?'
    : 'Fifty moves have passed without a capture or a pawn move. Claim a draw?';
}

/** That a draw may be claimed, said under whose move it is: to `who` ("You", "Ivory"), the player to move. */
export function describeClaimable(claim: DrawClaim, who: string): string {
  const why = claim === 'threefold' ? 'The position has come up three times' : 'Fifty moves without a capture or a pawn move';
  return `${why}: ${who} may claim a draw.`;
}

/** A rule that is explained the first time it comes up in a game. */
export type Topic = 'check' | 'castling' | 'enPassant' | 'enPassantOffer' | 'promotion';

export const EXPLAIN: Record<Topic, { title: string; text: string }> = {
  check: {
    title: 'Check',
    text: 'A king is under attack. The player whose king it is must deal with that now: move the king to a safe square, put a stone in the way, or take the attacker. No other move is allowed.',
  },
  castling: {
    title: 'Castling',
    text: 'That was one move. The king goes two squares toward a rook and the rook hops over him. Each side may do it once, if neither stone has moved, nothing stands between them, and the king is not in check or crossing an attacked square.',
  },
  enPassant: {
    title: 'Taken in passing',
    text: 'A pawn that has just gone two squares can be taken by an enemy pawn beside it as if it had gone only one. The taking pawn moves diagonally to the empty square behind it. It is called en passant, and it must be done on the very next move or not at all.',
  },
  enPassantOffer: {
    title: 'You can take in passing',
    text: 'Their pawn has just gone two squares and landed beside one of yours. For this turn only, your pawn may take it by moving diagonally to the empty square behind it. The rule is called en passant.',
  },
  promotion: {
    title: 'Promotion',
    text: 'A pawn that reaches the far side of the board becomes a queen, rook, bishop or knight, whichever its player chooses. Nearly always a queen.',
  },
};

/** The rules a move just played brings up, in the order to explain them. */
export function topicsOf(e: MoveEvent): Topic[] {
  const topics: Topic[] = [];
  if (e.castle) topics.push('castling');
  if (e.enPassant) topics.push('enPassant');
  if (e.promotion) topics.push('promotion');
  if (e.status.inCheck && !e.status.over) topics.push('check');
  return topics;
}

/** Whether the side to move can take a pawn in passing. */
export function enPassantOffered(game: Game): boolean {
  const last = game.lastMove();
  if (!last || last.piece.kind !== 'p' || Math.abs(Number(last.piece.to[1]) - Number(last.piece.from[1])) !== 2) return false;
  return game.pieces().some((p) => p.kind === 'p' && p.side === game.turn() && game.movesFrom(p.square).some((o) => o.enPassant));
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export interface Hint {
  from: Square;
  to: Square;
  /** Said first: which stone to look at. */
  look: string;
  /** Said when the player asks again: where it goes, and what that does. */
  move: string;
}

/** Put a suggested move into words. `fen` is the position it would be played in. */
export function describeHint(fen: string, move: EngineMove): Hint | null {
  const trial = new Game(fen);
  const piece = trial.pieceAt(move.from);
  if (!piece) return null;
  let e: MoveEvent;
  try {
    e = trial.move(move.from, move.to, move.promotion);
  } catch {
    return null;
  }
  const name = KIND_NAME[piece.kind];
  const does: string[] = [];
  if (e.castle) does.push('That is castling: the rook comes round to guard him.');
  if (e.captured) does.push(e.enPassant ? 'It takes their pawn in passing.' : `It takes their ${KIND_NAME[e.captured.kind]}.`);
  if (e.promotion) does.push(`The pawn becomes a ${KIND_NAME[e.promotion]}.`);
  if (e.status.result === 'checkmate') does.push('It is checkmate.');
  else if (e.status.inCheck) does.push('It gives check.');
  for (const m of e.motifs) {
    if (m.kind === 'fork') {
      const targets = m.targets.map((s) => trial.pieceAt(s)).filter((p) => p !== null);
      if (targets.length >= 2) does.push(`From there it attacks their ${list(targets.map((p) => KIND_NAME[p.kind]))} at once.`);
    } else if (m.kind === 'pin') {
      const pinned = trial.pieceAt(m.pinned);
      const behind = trial.pieceAt(m.behind);
      if (pinned && behind) does.push(`It pins their ${KIND_NAME[pinned.kind]}, which cannot move without exposing the ${KIND_NAME[behind.kind]} behind it.`);
    }
  }
  // A move that does nothing showy may still have a reason, if the position shows one plainly.
  if (does.length === 0) {
    const why = quietReason(fen, trial.fen(), piece.side, piece.kind, move.from, move.to);
    if (why) does.push(why);
  }
  return {
    from: move.from,
    to: move.to,
    look: `Look at your ${name} on ${move.from}.`,
    move: [`${capital(name)} to ${move.to}.`, ...does].join(' '),
  };
}

/**
 * What a move would cost, in words, for the warning before a blunder. `fen` is the position
 * before the move; `after` is the engine's look at the position it leads to, whose first line
 * is the other side's best answer.
 */
export function describeBlunder(fen: string, move: EngineMove, after: Analysis | null, ended?: Pick<Status, 'result' | 'drawReason'>): string {
  const vague = 'This gives your opponent a strong answer and throws away a good part of your position.';
  const trial = new Game(fen);
  let e: MoveEvent;
  try {
    e = trial.move(move.from, move.to, move.promotion);
  } catch {
    return vague;
  }
  // How the move ends the game, if it does. The caller knows best: a position by itself does not
  // remember how often it has come up, and so cannot see a draw by repetition.
  const end = ended ?? e.status;
  if (end.result === 'draw') {
    return {
      stalemate: 'This is stalemate: their king would have no move without being in check, and the game would be a draw.',
      threefold: 'This brings about the same position for the third time, and your opponent could claim a draw.',
      'fifty-move': 'This is the fiftieth move each with no capture and no pawn moved, and your opponent could claim a draw.',
      fivefold: 'This brings about the same position for the fifth time, and the game would be a draw.',
      'seventy-five-move': 'This is the seventy-fifth move each with no capture and no pawn moved, and the game would be a draw.',
      insufficient: 'This leaves neither side enough to give checkmate, and the game would be a draw.',
      // No move brings these about.
      agreement: vague,
      timeout: vague,
    }[end.drawReason ?? 'stalemate'];
  }
  const answer = after?.lines[0];
  if (!answer) return vague;
  if (answer.score.mate !== undefined && answer.score.mate > 0) {
    return answer.score.mate === 1 ? 'This lets them checkmate you on the very next move.' : `This lets them force checkmate in ${answer.score.mate} moves.`;
  }
  let r: MoveEvent;
  try {
    r = trial.move(answer.move.from, answer.move.to, answer.move.promotion);
  } catch {
    return vague;
  }
  const their = KIND_NAME[r.promotion ? 'p' : r.piece.kind];
  if (r.captured) {
    const lost = KIND_NAME[r.captured.kind];
    if (r.captured.id === e.piece.id) return `This loses your ${lost}: their ${their} takes it on ${r.piece.to}.`;
    return `This leaves your ${lost} on ${r.captured.square} to be taken by their ${their}.`;
  }
  const fork = r.motifs.find((m) => m.kind === 'fork');
  if (fork && fork.kind === 'fork') {
    const targets = fork.targets.map((s) => trial.pieceAt(s)).filter((p) => p !== null);
    if (targets.length >= 2) return `This walks into a fork: their ${their} goes to ${r.piece.to} and attacks your ${list(targets.map((p) => KIND_NAME[p.kind]))} at once.`;
  }
  if (r.promotion) return `This lets their pawn through to become a ${KIND_NAME[r.promotion]}.`;
  return `This gives them a strong answer: their ${their} to ${r.piece.to}. It costs you a good part of your position.`;
}
