/**
 * What the game's server and its clients say to each other. Every message
 * is one JSON object with a `t` that names it.
 *
 * The server holds the game. A client asks to move; the server checks the
 * move against the rules and either tells everyone it happened or refuses
 * it and sends back the true position.
 */
import type { DrawClaim, PromotionKind, Side, Square } from '../core/game';

/** Where someone sits: at the board as Ivory or Void, or watching. */
export type Seat = Side | 'spectator';

export interface MoveData {
  from: Square;
  to: Square;
  promotion?: PromotionKind;
}

/** A player as others see them: the name they chose and how they stand. Nothing here identifies their browser. */
export interface PlayerCard {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
}

/** The time each side has left, in milliseconds, as the message was sent; and whose is running down, if either. */
export interface Clock {
  left: Record<Side, number>;
  running: Side | null;
  /**
   * In a friendly game: the clock of the side to move is waiting for its player, who is away, and
   * runs after `left` more milliseconds if they are not back. Left out when no clock is waiting.
   */
  held?: { side: Side; left: number };
}

/**
 * How long a game's clocks give: what each side begins with, and what each move gives back, in
 * milliseconds. A ranked game's is fixed; a friendly room's is chosen by its players.
 */
export interface TimeControl {
  base: number;
  increment: number;
}

const minutes = (m: number, s: number): TimeControl => ({ base: m * 60 * 1000, increment: s * 1000 });

/**
 * The clocks a friendly room may be played with, besides none: the usual blitz and rapid pools,
 * from three minutes (a move costs a second or two of the hands' own time, which rules out bullet)
 * to half an hour, with 10 + 5 the ranked game's own pace.
 */
export const FRIENDLY_CONTROLS: readonly TimeControl[] = [minutes(3, 2), minutes(5, 3), minutes(10, 5), minutes(15, 10), minutes(30, 0)];

/** Whether two clocks (or none) are the same. */
export function sameControl(a: TimeControl | null | undefined, b: TimeControl | null | undefined): boolean {
  return (a ?? null) === (b ?? null) || (!!a && !!b && a.base === b.base && a.increment === b.increment);
}

/** One of the friendly clocks, as the list has it, if this is one; otherwise null. */
export function friendlyControl(x: unknown): TimeControl | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  return FRIENDLY_CONTROLS.find((c) => c.base === o.base && c.increment === o.increment) ?? null;
}

/**
 * How a ranked game was ended by the server and not by a player:
 * - 'time': one ran out of time. They lose (`resigned` names them), unless the other could not
 *   have mated them by any series of legal moves: then it is drawn and `resigned` is null (FIDE 6.9).
 * - 'left': one went away and did not come back. They lose (`resigned` names them).
 * - 'noshow': the game was called off, unrated, before both players had made a move: someone never
 *   arrived, or went away, resigned or ran out of time before both had moved; or, later in the
 *   game, both players went away and neither came back.
 */
export type Ended = 'time' | 'left' | 'noshow';

/** Everything needed to show a room as it stands. */
export interface RoomState {
  room: string;
  /** The position the game began from, and every move since. */
  startFen: string;
  moves: MoveData[];
  /** Whether each side's player is connected right now. A seat can be taken but its player away. */
  present: Record<Side, boolean>;
  /** Whether each side's seat has been taken at all. */
  taken: Record<Side, boolean>;
  watching: number;
  /** Which players have asked for another game. */
  again: Record<Side, boolean>;
  /** The side that has given the game up, if one has. Not a move, so it is not among them. */
  resigned: Side | null;
  /** The side that has offered a draw and is waiting for an answer, if one has. */
  drawOffer: Side | null;
  /** Whether the players have agreed a draw. Like a resignation, it is not a move. */
  agreed: boolean;
  /**
   * The draw the player to move claimed, and why: the position had stood three times, or fifty
   * moves each had passed without a capture or a pawn move (FIDE 9.2, 9.3). Not a move either.
   */
  claimed: DrawClaim | null;
  /** Whether this room was made by the queue: its games are timed and count towards the players' ratings. */
  ranked: boolean;
  /** Who sits on each side, if they have said who they are. */
  players: Record<Side, { name: string; rating: number } | null>;
  /**
   * The clocks of a ranked game. Null where there are none. Neither runs (`running` is null) until
   * a few seconds after both players have sat down, or White's first move if that comes sooner.
   */
  clock: Clock | null;
  /** Set when the server ended the game itself. */
  ended: Ended | null;
  /** What the finished ranked game did to each player's rating. */
  change: Record<Side, number> | null;
  /**
   * The clock the room's next game is played with, and the game on the board until it begins: a
   * ranked room's fixed one, or the one a friendly room's players chose, or null for none. Left
   * out by a server from before a friendly room could have a clock, which cannot be asked for one.
   */
  control?: TimeControl | null;
  /** Which player last chose the room's clock, if one has since the server started. */
  controlBy?: Side;
}

export type ClientMessage =
  /**
   * Say who this browser is. `id` is a secret the browser made for itself and keeps; it stands
   * in for an account. Sent first on every connection that wants a name, a rating or a match.
   */
  | { t: 'hello'; id: string; name?: string }
  /** Wait to be paired with another player for a ranked game. */
  | { t: 'queue' }
  /** Stop waiting. */
  | { t: 'unqueue' }
  /** Ask for the best players, and where I stand. */
  | { t: 'board' }
  /**
   * Enter a room. `token` is this window's own key to a seat it already holds, and always gets
   * that seat back. `remembered` are keys this browser was given in the past; one of those gets
   * its seat back only if nobody is sitting in it, so that a second window does not take the
   * first one's seat.
   */
  | { t: 'join'; room: string; token?: string; remembered?: string[]; watch?: boolean }
  /** Play a move. `ply` is how many moves the client believes have been played, so a stale request is caught. */
  | { t: 'move'; ply: number; move: MoveData }
  /** Which of my pieces I am thinking about, so that my hand hovers over it on the other screens. */
  | { t: 'think'; square: Square | null }
  /** Give the game up. The other player wins. */
  | { t: 'resign' }
  /** Offer a draw; or, if the other player has offered one, agree to it. */
  | { t: 'draw' }
  /** Say yes to the draw the other player has offered, and only that: if the offer has gone (taken back as this was sent), nothing happens. */
  | { t: 'agree' }
  /** Say no to the draw the other player has offered; or take back the one I offered. */
  | { t: 'nodraw' }
  /**
   * Claim the draw the position allows, as the player to move: it has stood three times, or fifty
   * moves each have passed without a capture or a pawn move. Refused if there is none to claim.
   */
  | { t: 'claim' }
  /** Ask for another game. It starts when both players have asked. Only among friends: a ranked game is played once, and another is looked for in the queue. */
  | { t: 'again' }
  /**
   * Choose the clock of a friendly room (one of `FRIENDLY_CONTROLS`, or none), as either player,
   * between games: before the first move of one, or once it is over. Everyone is told, and anyone
   * who had asked for another game asks again, having seen it.
   */
  | { t: 'control'; control: TimeControl | null }
  /** Ask for the room as it stands. */
  | { t: 'sync' };

export type ServerMessage =
  /** The answer to `hello`: how this player stands. */
  | { t: 'welcome'; you: PlayerCard }
  /** Waiting for an opponent. `waiting` counts everyone in the queue, this player included. */
  | { t: 'queued'; waiting: number }
  /**
   * Not put in the queue (or taken out of it), and why: the queue or the server is full, this
   * player or address has had too many games called off lately, or has games waiting to be joined.
   * `until`, if given, is how many milliseconds from now the player may try again.
   */
  | { t: 'turned'; reason: string; until?: number }
  /** An opponent was found. The game is in this room; join it as any other. */
  | { t: 'matched'; room: string }
  | { t: 'board'; top: PlayerCard[]; you: PlayerCard | null }
  | { t: 'joined'; you: Seat; token: string; state: RoomState }
  /** Someone came or went, another game was asked for, or this was asked for with `sync`. */
  | { t: 'state'; state: RoomState }
  | { t: 'moved'; ply: number; move: MoveData; clock?: Clock }
  | { t: 'think'; side: Side; square: Square | null }
  /** The last request was not carried out. `state` is the truth to return to. */
  | { t: 'refused'; reason: string; state: RoomState }
  /** A new game has begun in this room, and this is now your seat (the colours swap). */
  | { t: 'seated'; you: Seat; state: RoomState }
  /** Nothing to say: sent now and then so that a page can tell its connection is still alive. */
  | { t: 'tick' };

/** What someone is told at the door of a room whose game is gone. The server says it, and the game knows it again, word for word. */
export const GONE = { calledOff: 'This game was called off.', over: 'This game is over.' } as const;

/** The connection was closed because the same seat was opened in another window. Do not reconnect. */
export const CLOSE_DISPLACED = 4001;

/** The connection was closed because it said it was a second, different player. One player to a connection. */
export const CLOSE_TWO_PLAYERS = 4002;

/** The longest name a player may go by, in characters (not the halves of characters JavaScript counts in). */
export const NAME_LENGTH = 16;

/** Names nobody may take, whatever their case or spacing: they would pass for the game's own voice. */
const RESERVED = new Set(['admin', 'administrator', 'moderator', 'mod', 'server', 'system', 'nightpiece', 'staff', 'official']);
/** Letters that show as nothing at all: the Hangul fillers and their kin. (Signs that are not letters, the invisible ones among them, are simply left out.) */
const BLANK = /[\u115F\u1160\u3164\uFFA0\u17B4\u17B5\u{1D159}]/u;
/** Single characters drawn as long as a sentence: the Arabic ligatures of whole phrases, cuneiform and its kind. */
const WIDE = /[\uFDFA\uFDFB\uFDFD\u{12000}-\u{1254F}\u{13000}-\u{1345F}\u{A9C1}\u{A9C2}]/u;

/**
 * A name as it will be shown: letters (with their accents), digits, spaces and a few marks,
 * trimmed and of a sensible length. Empty if nothing is left, or if the name is refused: one
 * with letters that show as nothing or as a whole line, one that mixes Latin letters with
 * Cyrillic or Greek ones that look like them (a name in any one script is welcome), and the
 * few names reserved for the game itself.
 */
export function cleanName(name: unknown): string {
  if (typeof name !== 'string') return '';
  // Looked for before folding, which turns the wide ligatures into ordinary (and long) words.
  if (WIDE.test(name)) return '';
  const folded = name.normalize('NFKC');
  if (BLANK.test(folded) || WIDE.test(folded)) return '';
  const kept = folded
    .replace(/[^\p{L}\p{M}\p{N} _.'-]/gu, '')
    // A mark belongs to the letter before it: none without one, and no more than two to a letter (no towers of them).
    .replace(/(^|[^\p{L}\p{M}])\p{M}+/gu, '$1')
    .replace(/(\p{M}\p{M})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = [...kept].slice(0, NAME_LENGTH).join('').trim();
  const latin = /\p{Script=Latin}/u.test(cut);
  const cyrillic = /\p{Script=Cyrillic}/u.test(cut);
  const greek = /\p{Script=Greek}/u.test(cut);
  if ((latin && (cyrillic || greek)) || (cyrillic && greek)) return '';
  if (RESERVED.has(lettersOf(cut))) return '';
  return cut;
}

/** A name's letters alone, in small letters: what a name is compared by when it is checked against a list. */
export function lettersOf(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}]/gu, '');
}

const SQUARE = /^[a-h][1-8]$/;
const TOKEN = /^[0-9a-f]{32}$/;
const ROOM_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Room names: six characters from a set with nothing that can be misread. */
export const ROOM_NAME = /^[A-HJ-NP-Z2-9]{6}$/;

/** A new room name. There are about a thousand million of them, so one cannot be guessed in passing. */
export function newRoomName(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let name = '';
  for (const b of bytes) name += ROOM_LETTERS[b % ROOM_LETTERS.length];
  return name;
}

function isMove(m: unknown): m is MoveData {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.from === 'string' &&
    SQUARE.test(o.from) &&
    typeof o.to === 'string' &&
    SQUARE.test(o.to) &&
    (o.promotion === undefined || (typeof o.promotion === 'string' && /^[qrbn]$/.test(o.promotion)))
  );
}

/** Read a message from a client. Anything that is not exactly one of the messages above is refused. */
export function parseClientMessage(text: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  switch (o.t) {
    case 'hello': {
      if (typeof o.id !== 'string' || !TOKEN.test(o.id)) return null;
      const name = cleanName(o.name);
      return { t: 'hello', id: o.id, ...(name ? { name } : {}) };
    }
    case 'queue':
      return { t: 'queue' };
    case 'unqueue':
      return { t: 'unqueue' };
    case 'board':
      return { t: 'board' };
    case 'join': {
      if (typeof o.room !== 'string' || !ROOM_NAME.test(o.room)) return null;
      if (o.token !== undefined && (typeof o.token !== 'string' || !TOKEN.test(o.token))) return null;
      let remembered: string[] = [];
      if (o.remembered !== undefined) {
        if (!Array.isArray(o.remembered) || o.remembered.length > 4) return null;
        if (!o.remembered.every((x) => typeof x === 'string' && TOKEN.test(x))) return null;
        remembered = o.remembered as string[];
      }
      return {
        t: 'join',
        room: o.room,
        ...(o.token ? { token: o.token as string } : {}),
        ...(remembered.length > 0 ? { remembered } : {}),
        ...(o.watch === true ? { watch: true } : {}),
      };
    }
    case 'move':
      if (typeof o.ply !== 'number' || !Number.isInteger(o.ply) || o.ply < 0 || !isMove(o.move)) return null;
      return { t: 'move', ply: o.ply, move: { from: o.move.from, to: o.move.to, ...(o.move.promotion ? { promotion: o.move.promotion } : {}) } };
    case 'think':
      if (o.square !== null && (typeof o.square !== 'string' || !SQUARE.test(o.square))) return null;
      return { t: 'think', square: o.square as Square | null };
    case 'resign':
      return { t: 'resign' };
    case 'draw':
      return { t: 'draw' };
    case 'agree':
      return { t: 'agree' };
    case 'nodraw':
      return { t: 'nodraw' };
    case 'claim':
      return { t: 'claim' };
    case 'again':
      return { t: 'again' };
    case 'control': {
      if (o.control === null) return { t: 'control', control: null };
      const control = friendlyControl(o.control);
      return control ? { t: 'control', control } : null;
    }
    case 'sync':
      return { t: 'sync' };
    default:
      return null;
  }
}
