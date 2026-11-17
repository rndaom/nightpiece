/**
 * What the interface shows. The app controller writes these signals; the
 * HUD components read them. Nothing here knows about Three.js.
 */
import { computed, signal } from '@preact/signals';
import type { Volumes } from '../audio/sound';
import type { CameraMode } from '../camera/rig';
import { type DrawClaim, type DrawNear, type Kind, type MoveEvent, opposite, type Side, type Square, type Status } from '../core/game';
import { LEVELS } from '../engine/uci';
import type { Topic } from '../learn/explain';
import type { Link } from '../net/client';
import type { Clock, Ended, PlayerCard, Seat, TimeControl } from '../net/protocol';
import type { Quality } from '../scene/post';
import { readStored, storageKey } from './brand';
import type { SavedSummary } from './saved';

export interface PromotionRequest {
  from: Square;
  to: Square;
  side: Side;
}

/** Who is playing whom. */
export type Mode =
  /** Two players taking turns at this screen. */
  | { kind: 'table' }
  /** One player here against the engine. `side` is the player's. */
  | { kind: 'computer'; level: string; side: Side }
  /** A game held by the server, with the other player somewhere else. */
  | { kind: 'online'; room: string }
  /** The lessons: set positions, one task at a time. */
  | { kind: 'lessons' };

/** The help a beginner gets, each part of which can be turned off. */
export interface Aids {
  /** Light the squares a chosen piece can go to. */
  moves: boolean;
  /** Mark the squares where it would be lost. */
  danger: boolean;
  /** Offer a hint. */
  hints: boolean;
  /** Stop and ask before a blunder. */
  warn: boolean;
  /** Explain each rule the first time it comes up. */
  explain: boolean;
  /** Mark each stone with its chess symbol in the view from above. */
  labels: boolean;
}

export const ALL_AIDS: Aids = { moves: true, danger: true, hints: true, warn: true, explain: true, labels: true };

/** What the lesson card shows. */
export interface LessonView {
  /** Which lesson this is, from 1, and how many there are. */
  lesson: number;
  lessons: number;
  /** Which step of the whole course, from 1, and how many. */
  number: number;
  of: number;
  title: string;
  say: string;
  /** The step's instruction in a line, for the card folded away on a narrow screen; null once the course is over. */
  ask: string | null;
  /**
   * Waiting for the player's move; a move that was not the one is being put back; done, with
   * something to read before going on; nothing to do but read; or the course is over.
   */
  state: 'task' | 'wrong' | 'done' | 'read' | 'finished';
  /** What the game says back about the last move tried. */
  line: string | null;
}

/** A move the player has chosen that the engine thinks is a blunder, held until they decide. */
export interface Warning {
  from: Square;
  to: Square;
  promotion?: 'q' | 'r' | 'b' | 'n';
  text: string;
}

/** How things stand in an online room, as far as this screen knows. */
export interface Online {
  room: string;
  /** Null until the server has said where we sit. */
  seat: Seat | null;
  link: Link;
  /** Whether each side's seat has been taken, and whether its player is connected just now. */
  taken: Record<Side, boolean>;
  present: Record<Side, boolean>;
  watching: number;
  /** Which players have asked for another game. */
  again: Record<Side, boolean>;
  /** The side that has offered a draw and is waiting to be answered, if one has. */
  offer: Side | null;
  /** Why the room could not be entered, if it could not. */
  note: string | null;
  /** A game the queue made: timed, and counted towards the players' ratings. */
  ranked: boolean;
  /** Who sits on each side, if they have said. */
  players: Record<Side, { name: string; rating: number } | null>;
  /** The clocks as the server last gave them, and when that was by this page's own clock (performance.now). */
  clock: (Clock & { at: number }) | null;
  /** The clock the room's next game is played with (and the game on the board, until it begins), or null for none. */
  control: TimeControl | null;
  /** Whether the players may choose it: a friendly room, on a server that knows how. */
  choosable: boolean;
  /** Set when the server ended the game itself: time ran out, a player left, or someone never arrived. */
  ended: Ended | null;
  /** What the finished ranked game did to each rating. */
  change: Record<Side, number> | null;
  /**
   * The game this room was for cannot be had, and why, in words to show: it was called off, it is
   * over and gone, or the server restarted without it. Null while there is a game here.
   */
  closed: string | null;
  /** This screen came by a link to a room nobody had opened: it is a new game, and this player the first one in it. */
  firstHere: boolean;
  /** The server has not been reached for a while: the room cannot be entered, or got back to. */
  stuck: boolean;
}

/**
 * The two players of an online game come to the board: shown for a moment as the game begins,
 * over the dimmed board, and then put away (see Intro in Match.tsx). It never stops play.
 */
export interface Intro {
  /** Each showing is a new one, so that its drawing starts again from the beginning. */
  id: number;
  ranked: boolean;
  /** The side this screen plays; null for someone watching. */
  you: Side | null;
  players: Record<Side, { name: string; rating: number } | null>;
  /** What each player's clock starts with and gets back with each move, in milliseconds. Null without a clock. */
  clock: { base: number; increment: number } | null;
}

/** How a game came to an end. */
export type Cause =
  | 'checkmate'
  | 'resigned'
  | 'time'
  | 'left'
  | 'stalemate'
  | 'agreement'
  /** A draw the player to move claimed: the position had stood three times, or fifty moves each had passed without a capture or a pawn move. */
  | 'repetition'
  | 'fifty'
  /** The same, gone so far that the game ended by itself: five times, or seventy-five moves each. */
  | 'fivefold'
  | 'seventy-five'
  | 'material'
  | 'noshow';

/** A finished game, as its result card tells it. */
export interface Outcome {
  result: 'checkmate' | 'draw' | 'resigned';
  winner: Side | null;
  cause: Cause;
  /** The number of the move it ended on. Null if no move was made. */
  move: number | null;
  /** How long it lasted, from the first move to the end, in milliseconds. Null if this screen did not see it begin. */
  duration: number | null;
  /** This player's rating before the game and after it, once a ranked game has been counted. */
  rating: { before: number; after: number } | null;
  /** The side whose time ran out, if that is how it ended: the loser, or, in a draw on time, the side that could not have been mated. */
  flagged: Side | null;
}

export const ui = {
  status: signal<Status>({
    turn: 'w',
    inCheck: false,
    checkedKing: null,
    checkers: [],
    over: false,
    result: null,
    winner: null,
    drawReason: null,
    claimable: null,
  }),
  /** A draw that is close but has not happened: the position has come up twice, or the fifty moves are nearly up. */
  drawNear: signal<DrawNear | null>(null),
  history: signal<MoveEvent[]>([]),
  /** Who moved first and what that move was numbered. Not always Ivory on move 1 for a set position. */
  start: signal<{ side: Side; moveNumber: number }>({ side: 'w', moveNumber: 1 }),
  captured: signal<Record<Side, Kind[]>>({ w: [], b: [] }),
  cameraMode: signal<CameraMode>('side'),
  seat: signal<Side>('w'),
  /** Seated views move to whichever player is to move. */
  followTurn: signal(true),
  /** The camera pushes in for captures, check and checkmate. */
  cinematic: signal(true),
  promotion: signal<PromotionRequest | null>(null),
  settingsOpen: signal(false),
  /** The interface put away, to look at the board alone. */
  bare: signal(false),
  /** The game-over card is on screen. It waits for the final move to land, and can be dismissed. */
  resultVisible: signal(false),
  /** Rendering quality. Lower settings are for weaker graphics hardware. Null until chosen or detected. */
  quality: signal<Quality | null>(null),
  /** The scene is ready to be shown (assets loaded, or given up on). */
  ready: signal(false),
  /** Loudness, 0 to 1: everything, the room's own sound, and the sounds of play. */
  volume: signal<Volumes>({ master: 0.8, music: 0.7, effects: 0.9 }),

  mode: signal<Mode>({ kind: 'table' }),
  /** The side this screen plays, when it plays only one: against the computer, or seated online. */
  you: signal<Side | null>(null),
  online: signal<Online | null>(null),
  /** The name this player goes by (empty until chosen), and how they stand, once the server has said. */
  player: signal<{ name: string; card: PlayerCard | null }>({ name: '', card: null }),
  /** Waiting for a ranked match: how many are waiting, this player included, and whether the server can be heard. Null when not waiting. */
  queue: signal<{ waiting: number; up: boolean } | null>(null),
  /** How many are looking for a match (this player too, if they are) and how many are at a board online, as the server last said. Asked while the choice of game is open or a match is awaited; null until it has said. */
  lobby: signal<{ waiting: number; playing: number } | null>(null),
  /**
   * The server would not put this player in the queue, and why, in its words. `until` is when
   * (by Date.now) they may look again, if they must wait; the turn is forgotten by itself then.
   * `away`: the card that said so has been put away (the choice of game still says it).
   */
  turned: signal<{ reason: string; until: number | null; away?: boolean } | null>(null),
  /** The server has not been reached for some seconds, by the connection that waits for a match and asks for the rankings. */
  unreachable: signal(false),
  /** What became of the name the player last gave: kept, or refused by the server (which then gave its own). Put away after a moment. */
  nameSaid: signal<'saved' | 'refused' | null>(null),
  /** The best players are on screen; and who they are, once the server has said. */
  ranksOpen: signal(false),
  ranks: signal<{ top: PlayerCard[]; you: PlayerCard | null } | null>(null),
  /** The choice of game is on screen. */
  menuOpen: signal(false),
  /** The computer is choosing its move. */
  thinking: signal(false),
  /** The chess engine: not asked for yet (or put away for an online game being played), loading, ready, or could not be loaded. */
  engine: signal<'idle' | 'loading' | 'ready' | 'failed'>('idle'),
  /** Whether there is a move this screen may take back. */
  canTakeBack: signal(false),
  /** Whether the game can be given up from this screen right now. */
  canResign: signal(false),
  /** Whether a draw can be offered from this screen right now. */
  canDraw: signal(false),
  /** The draw the player to move may claim from this screen right now, if there is one: the Draw button claims it instead of offering one. */
  canClaim: signal<DrawClaim | null>(null),
  /** Something the player should know that is not part of the position: a refused move, an engine that will not load. */
  notice: signal<string | null>(null),
  /** How the player last chose to play the computer. */
  computer: signal<{ level: string; side: Side | 'either' }>({ level: 'first', side: 'w' }),

  /** The choice of game is being shown as the opening screen: nothing has been started yet. */
  opening: signal(false),
  aids: signal<Aids>({ ...ALL_AIDS }),
  /** Rules that have already been explained, and are not explained again. */
  seen: signal<Topic[]>([]),
  /** The rule being explained now. */
  explain: signal<Topic | null>(null),
  /** The hint on screen: its words, and whether it has got as far as saying where to move. */
  /** The engine's advice, as it stands on screen. `label` is what its plate says when it is not a hint that was asked for. */
  hint: signal<{ text: string; stage: 1 | 2; label?: string } | null>(null),
  /** Whether a hint can be asked for right now. */
  canHint: signal(false),
  warning: signal<Warning | null>(null),
  lesson: signal<LessonView | null>(null),
  /** The piece under the pointer, named for anyone who cannot yet tell the stones apart. */
  pointed: signal<{ side: Side; kind: Kind; square: Square } | null>(null),
  /** The last move to have been set down on the board. `history` has a move as soon as it is chosen; this waits for the hand. */
  landed: signal<MoveEvent | null>(null),
  /** Counts the engine's verdicts as they arrive, so what shows them (they are kept by the app, per move) knows to look again. */
  appraised: signal(0),
  /**
   * How the engine last judged the position: hundredths of a pawn in Ivory's favour, and how
   * many moves had been played when it said so. Null until it has judged one, and where it
   * is not asked (an online game still being played, and the lessons).
   */
  balance: signal<{ ply: number; cp: number } | null>(null),
  /** A question the player is being asked that is not about a move: whether they mean to give the game up, to offer a draw, or to claim one. */
  asking: signal<'resign' | 'draw' | 'claim' | null>(null),
  /**
   * Looking back: how many moves had been played in the position on the board. Null while the
   * board shows the game as it stands.
   */
  viewing: signal<number | null>(null),
  /** A game left unfinished at this screen that can be carried on. Null if there is none, or it is the one being played. */
  saved: signal<SavedSummary | null>(null),
  /** The players coming to the board at the start of an online game, while that is being shown. */
  intro: signal<Intro | null>(null),
  /** How long the game on the board lasted, once it is over and if this screen saw its first move, in milliseconds. */
  lasted: signal<number | null>(null),
};

/**
 * Whether a game may be looked at with the engine's eyes and a player's tricks pointed out: its
 * moves judged and marked, how it stands weighed, its opening named, a stone's dangerous squares
 * shown, the room taking its cue from what a move risks. Not in an online game still being
 * played, ranked or among friends, where any of it would be help for one player against
 * another (and a spectator's screen could be passing it on). Once that game is over it may be
 * looked over like any other.
 */
export function analysable(mode: Mode, over: boolean): boolean {
  return mode.kind !== 'online' || over;
}

/** The same, for the game on the board, as the interface reads it. */
export const assisted = computed(() => analysable(ui.mode.value, ui.status.value.over));

/** How a game that is over came to be over, from the rules' word on it and the server's. */
export function causeOf(s: Status, ended: Ended | null): Cause | null {
  if (!s.over) return ended === 'noshow' ? 'noshow' : null;
  if (s.result === 'checkmate') return 'checkmate';
  // The server ends a game against a player whose time has gone, or who has gone, by resigning it for them.
  if (s.result === 'resigned') return ended === 'time' ? 'time' : ended === 'left' ? 'left' : 'resigned';
  switch (s.drawReason) {
    case 'threefold':
      return 'repetition';
    case 'fivefold':
      return 'fivefold';
    case 'fifty-move':
      return 'fifty';
    case 'seventy-five-move':
      return 'seventy-five';
    case 'timeout':
      return 'time';
    case 'insufficient':
      return 'material';
    case 'agreement':
      return 'agreement';
    default:
      return 'stalemate';
  }
}

/** The game on the board, once it is over: what its result card says of it. */
export const outcome = computed((): Outcome | null => {
  const s = ui.status.value;
  if (!s.over || !s.result) return null;
  const o = ui.online.value;
  const you = ui.you.value;
  const plies = ui.history.value.length;
  const start = ui.start.value;
  // The move the last one belongs to, numbered as the record numbers it.
  const move = plies === 0 ? null : start.moveNumber + Math.floor((plies - 1 + (start.side === 'b' ? 1 : 0)) / 2);
  // The server counts a ranked game as it ends and then names each player at their new rating.
  const delta = o?.ranked && o.change && you ? o.change[you] : null;
  const now = you ? o?.players[you]?.rating : undefined;
  const rating = delta !== null && now !== undefined ? { before: now - delta, after: now } : null;
  const cause = causeOf(s, o?.ended ?? null) ?? 'resigned';
  // A flag falls on the side to move; a game it lost names that side as the loser all the same.
  const flagged = cause === 'time' ? (s.winner ? opposite(s.winner) : s.turn) : null;
  return { result: s.result, winner: s.winner, cause, move, duration: ui.lasted.value, rating, flagged };
});

const SETTINGS = 'settings.v1';
/** A signal, so that what shows the choice (the Auto chip) is drawn again when it changes. */
const qualityChosen = signal(false);
/** Whether the player has set the cinematic camera themselves, on or off. Until they have, it follows their system's wish for less movement. */
let cinematicChosen = false;

/** Record that the quality was picked by the player, so it is remembered rather than re-detected. */
export function markQualityChosen(): void {
  qualityChosen.value = true;
}

/** The player has asked for the quality to be chosen for them again: it is found afresh, and may be lowered when the game runs slowly. */
export function forgetQualityChoice(): void {
  qualityChosen.value = false;
}

/** Whether the player picked the quality themselves. If they did, the game leaves it alone. */
export function qualityIsChosen(): boolean {
  return qualityChosen.value;
}

/** Record that the player set the cinematic camera themselves. */
export function markCinematicChosen(): void {
  cinematicChosen = true;
}

/** Whether the player has set the cinematic camera themselves. */
export function cinematicIsChosen(): boolean {
  return cinematicChosen;
}

interface Saved {
  cameraMode: CameraMode;
  followTurn: boolean;
  cinematic: boolean;
  /** Present once the player has set the cinematic camera themselves. */
  cinematicChosen?: boolean;
  /** Only present once the player has picked a quality themselves. */
  quality?: Quality;
  volume: Volumes;
  computer: { level: string; side: Side | 'either' };
  aids: Aids;
  seen: Topic[];
}

const TOPICS: Topic[] = ['check', 'castling', 'enPassant', 'enPassantOffer', 'promotion'];

export function loadSettings(): void {
  try {
    const raw = readStored(localStorage, SETTINGS);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Saved>;
    if (saved.cameraMode && ['top', 'side', 'shoulder', 'eyes', 'orbit'].includes(saved.cameraMode)) {
      ui.cameraMode.value = saved.cameraMode;
    }
    if (typeof saved.followTurn === 'boolean') ui.followTurn.value = saved.followTurn;
    // Settings kept before the choice was noted: one turned off was turned off by the player, since it starts on.
    if (typeof saved.cinematic === 'boolean' && (saved.cinematicChosen === true || saved.cinematic === false)) {
      ui.cinematic.value = saved.cinematic;
      cinematicChosen = true;
    }
    if (saved.quality && ['low', 'medium', 'high'].includes(saved.quality)) {
      ui.quality.value = saved.quality;
      qualityChosen.value = true;
    }
    const v = saved.volume;
    const level = (x: unknown, fallback: number) => (typeof x === 'number' && x >= 0 && x <= 1 ? x : fallback);
    if (v && typeof v === 'object') {
      const d = ui.volume.value;
      ui.volume.value = { master: level(v.master, d.master), music: level(v.music, d.music), effects: level(v.effects, d.effects) };
    }
    const c = saved.computer;
    if (c && typeof c === 'object' && LEVELS.some((l) => l.id === c.level) && ['w', 'b', 'either'].includes(c.side)) {
      ui.computer.value = { level: c.level, side: c.side };
    }
    const a = saved.aids as Partial<Aids> | undefined;
    if (a && typeof a === 'object') {
      const aids = { ...ALL_AIDS };
      for (const key of Object.keys(aids) as (keyof Aids)[]) if (typeof a[key] === 'boolean') aids[key] = a[key];
      ui.aids.value = aids;
    }
    if (Array.isArray(saved.seen)) ui.seen.value = TOPICS.filter((t) => saved.seen!.includes(t));
  } catch {
    // Storage can be unavailable (private windows, blocked site data). Defaults are fine.
  }
}

export function saveSettings(): void {
  try {
    const saved: Saved = {
      cameraMode: ui.cameraMode.value,
      followTurn: ui.followTurn.value,
      cinematic: ui.cinematic.value,
      ...(cinematicChosen ? { cinematicChosen: true } : {}),
      ...(qualityChosen.value && ui.quality.value ? { quality: ui.quality.value } : {}),
      volume: ui.volume.value,
      computer: ui.computer.value,
      aids: ui.aids.value,
      seen: ui.seen.value,
    };
    localStorage.setItem(storageKey(SETTINGS), JSON.stringify(saved));
  } catch {
    // See loadSettings.
  }
}
