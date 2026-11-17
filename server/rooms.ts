/**
 * Rooms: who is sitting where, and the one true copy of each game.
 *
 * This file knows nothing about sockets. A connection is anything that can
 * be sent a message, which is what lets the rules of a room be tested
 * without a network.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Game, IllegalMoveError, opposite, type Side } from '../src/core/game.ts';
import {
  CLOSE_DISPLACED,
  CLOSE_TWO_PLAYERS,
  type ClientMessage,
  type Clock,
  type Ended,
  friendlyControl,
  GONE,
  lettersOf,
  type MoveData,
  newRoomName,
  ROOM_NAME,
  type RoomState,
  sameControl,
  type Seat,
  type ServerMessage,
  type TimeControl,
} from '../src/net/protocol.ts';
import { readAs } from '../src/net/lookalikes.ts';
import { playerKey, Scores, START_RATING } from './scores.ts';

export interface Connection {
  send(message: ServerMessage): void;
  /** End the connection, saying why. */
  close(code: number, reason: string): void;
  /**
   * Where the connection comes from, as the server counts it (a visitor's whole IPv6 block counts
   * as one). Left out where it is not known, as in tests that have no network.
   */
  readonly address?: string;
}

const SIDES = ['w', 'b'] as const;
/** How many rooms there may be at once, ranked and friendly together. */
export const MAX_ROOMS = 1000;
const MAX_WATCHING = 40;
/** How long an empty room is kept, so that both players can come back after a dropped connection. */
const EMPTY_ROOM_LIFE = 20 * 60 * 1000;
/** How long an empty room is kept once its game is over: long enough to come back and look at the end, not to fill the server. */
const FINISHED_ROOM_LIFE = 2 * 60 * 1000;
/** How long the name of a ranked room that has gone is remembered, so that someone arriving late is told what became of it. */
const GONE_ROOM_LIFE = 20 * 60 * 1000;
/** How many such names are remembered at most: past this, the oldest is forgotten first. */
const MOST_GONE = 5000;
/**
 * After a restart: how long a player who was already away has, at the least, to come back before
 * it counts against them (one who was here when the server stopped has the whole `ABANDON_AFTER`);
 * and how long the clock of the side to move stands still waiting for its player, at most.
 */
export const RESTART_GRACE = 15 * 1000;
/** Before the first move, a seat whose player has been gone this long can be taken by someone else. */
const UNSTARTED_SEAT_LIFE = 30 * 1000;

/** A ranked game: how long each side has for all its moves, and how much each move gives back, in milliseconds. */
export const CLOCK_START = 10 * 60 * 1000;
export const CLOCK_INCREMENT = 5 * 1000;
/** A ranked game's clock, as a room carries it. */
export const RANKED_CONTROL: TimeControl = { base: CLOCK_START, increment: CLOCK_INCREMENT };
/**
 * Among friends, how long in all a player's clock may wait for them in one game while they are
 * away on their own move: enough for a dropped connection or a reload, not for thinking at leisure
 * with the board on screen. Spent across every absence of the game; once it is spent, their clock
 * runs whether they are there or not.
 */
export const PAUSE_ALLOWANCE = 2 * 60 * 1000;
/** How long after both players have sat down White's clock starts (sooner if White moves): the time the match is introduced in. */
export const CLOCK_DELAY = 4 * 1000;
/** A player of a ranked game who is gone this long has left it: they forfeit, or, before both players have moved, the game is called off. */
export const ABANDON_AFTER = 60 * 1000;
/**
 * How long each player of a ranked game has, from the moment their clock first runs, to make their
 * first move. One who sits at the board and never moves has the game called off, and is to blame
 * for it: the other player is not kept waiting for the whole of a clock to run down.
 */
export const FIRST_MOVE_WITHIN = 45 * 1000;
/** How many players the leaderboard shows. */
const BOARD_SIZE = 20;
/** How many may wait for a match at once. */
const MAX_QUEUE = 200;
/** Two players are not matched again once they have played this many rated games against each other in `PAIR_WINDOW`. */
export const PAIR_LIMIT = 3;
const PAIR_WINDOW = 24 * 60 * 60 * 1000;
/**
 * Nor are players from two addresses matched again once this many rated games have been finished
 * between those addresses in `PAIR_WINDOW`: a new player made for every game is no way round
 * `PAIR_LIMIT`. Several households behind one address each (a campus, a telephone company) are
 * left room to meet.
 */
export const ADDRESS_PAIR_LIMIT = 6;
/** A player or address that has had this many ranked games called off in `STRIKE_WINDOW` may not look for another for `STRIKE_BAN`. */
export const STRIKE_LIMIT = 2;
const STRIKE_WINDOW = 10 * 60 * 1000;
export const STRIKE_BAN = 10 * 60 * 1000;
/** How many ranked games matched to one address may be waiting for it to sit down at once. */
export const UNJOINED_PER_ADDRESS = 2;
/** How many rooms opened from one address there may be at once: a household or a classroom, not someone filling the server. */
export const OPENED_PER_ADDRESS = 20;

/** The messages that can change what is written down of a room. A hand hovering, or a room asked for, changes nothing. */
const CHANGING = new Set<ClientMessage['t']>(['hello', 'join', 'move', 'resign', 'draw', 'agree', 'nodraw', 'claim', 'again', 'control']);

/** What a seat's key is kept as: a hash, so that a copy of the rooms written to disk would let nobody sit down in them. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface Player {
  /** The server's name for the browser, if it has said who it is. Null for a visitor with no name. */
  key: string | null;
  /** The seat's key as given to its window, while the server has it (not after a restart: then only its hash). */
  token: string | null;
  tokenHash: string;
  /** The name this player went by when last seen, for when the scores no longer remember a visitor. */
  name: string | null;
  /** Null while the player is away. Their seat is kept for them. */
  connection: Connection | null;
  /** When they went away, or null while they are here. */
  awaySince: number | null;
}

function newPlayer(key: string | null): Player {
  const token = randomBytes(16).toString('hex');
  return { key, token, tokenHash: hashToken(token), name: null, connection: null, awaySince: null };
}

class Room {
  game = new Game();
  players: Record<Side, Player | null> = { w: null, b: null };
  watching = new Set<Connection>();
  again: Record<Side, boolean> = { w: false, b: false };
  /** The side that has offered a draw and not yet been answered. */
  offer: Side | null = null;
  /** How many moves had been played when each side last offered a draw. One offer a move is enough. */
  offeredAt: Record<Side, number | null> = { w: null, b: null };
  /** Whether each side has made a move in the game on the board. A ranked game is not rated until both have. */
  moved: Record<Side, boolean> = { w: false, b: false };
  /**
   * Whether a move has ever been played in this room. Until one has, there is no game to come
   * back to: a seat walked away from can be given to someone else and an empty room forgotten.
   * It stays true through every later game, whose seats belong to the same two players.
   */
  held = false;
  /** When the last person left, or null while anyone is here. */
  emptySince: number | null = null;
  /** The address the room was opened from, for counting how many rooms one address has open. Not written down. */
  openedFrom: string | null = null;

  /** Made by the queue: timed, and counted towards the players' ratings. Only the two who were matched may sit. */
  ranked = false;
  expected: Record<Side, string> | null = null;
  /** The addresses the two were matched from, for counting the games each address has yet to sit down to. */
  from: Record<Side, string | null> = { w: null, b: null };
  /** When the room was made, for telling how long a player who never arrived has been awaited. */
  made = 0;
  /** A ranked game's own name, by which its rating is counted once and only once (see `Scores.settle`). */
  id = '';
  /**
   * The clock the room's next game is to be played with: a ranked room's own, or the one a
   * friendly room's players chose; null for none. And the clock the game on the board is being
   * played with, which is the room's choice as that game began (null for an untimed game).
   */
  control: TimeControl | null = null;
  timed: TimeControl | null = null;
  /** Which player last chose it, so that the other can be told. */
  controlBy: Side | null = null;
  /**
   * Time left to each side as of `since`, and when the clock of the side to move began (or will
   * begin) to run: null while no clock runs. Before the first move it may lie a few seconds ahead.
   */
  left: Record<Side, number> = { w: CLOCK_START, b: CLOCK_START };
  since: number | null = null;
  /** Whether the players are yet to be told that a clock has started (the first, or one that waited for its player). */
  startPending = false;
  /**
   * Among friends: how much each player's clock may yet wait for them in this game while they are
   * away (see `PAUSE_ALLOWANCE`), as of `pausedAt`; and when the clock of the side to move began to
   * wait for its player, who is away, or null if it is not waiting. While it waits, `since` lies
   * ahead by what is left of the allowance, and the clock runs from then on if they are not back.
   */
  pause: Record<Side, number> = { w: PAUSE_ALLOWANCE, b: PAUSE_ALLOWANCE };
  pausedAt: number | null = null;
  ended: Ended | null = null;
  change: Record<Side, number> | null = null;
  /** Whether the game on the board has been counted towards the ratings. Once is enough. */
  recorded = false;

  constructor(
    readonly name: string,
    private now: () => number = Date.now,
    private scores: Scores | null = null,
  ) {}

  /** Whether the game is over, on the board, by the players, or by the server. */
  get over(): boolean {
    return this.ended !== null || this.game.status().over;
  }

  /** The clocks as they stand this instant. */
  clock(): Clock | null {
    if (!this.timed) return null;
    const now = this.now();
    const running = this.since !== null && now >= this.since && !this.over ? this.game.turn() : null;
    const left = { ...this.left };
    if (running && this.since !== null) left[running] = Math.max(0, left[running] - (now - this.since));
    // A friendly clock waiting for its player, who is away: whose, and for how much longer at most.
    const turn = this.game.turn();
    const waiting = this.pausedAt !== null && this.since !== null && now < this.since && !this.over;
    // A ranked game's first move, on either side, is not waited for long. (A player who is away is waited for as any other is: `ABANDON_AFTER`.)
    const first = this.ranked && running && this.since !== null && !this.moved[running] && this.players[running]?.connection ? Math.max(0, FIRST_MOVE_WITHIN - (now - this.since)) : null;
    return { left, running, ...(waiting ? { held: { side: turn, left: this.since! - now } } : {}), ...(first !== null && running ? { first: { side: running, left: first } } : {}) };
  }

  /** Begin a game with this clock (or none): both sides' whole time, and neither running. */
  setTimed(control: TimeControl | null): void {
    this.timed = control;
    const base = control?.base ?? CLOCK_START;
    this.left = { w: base, b: base };
    this.since = null;
    this.startPending = false;
    this.pause = { w: PAUSE_ALLOWANCE, b: PAUSE_ALLOWANCE };
    this.pausedAt = null;
  }

  /**
   * Among friends: the player to move is away. Their clock is charged up to now and then waits for
   * them for as long as their allowance lasts; after that it runs, and everyone is told when it does.
   */
  waitForMover(): void {
    const turn = this.game.turn();
    this.stopClock();
    const now = this.now();
    this.since = now + this.pause[turn];
    this.pausedAt = this.pause[turn] > 0 ? now : null;
    this.startPending = this.pausedAt !== null;
  }

  /** Among friends: the player to move is back. What the wait took is spent from their allowance, and their clock runs from now if it was still waiting. */
  moverBack(): void {
    if (this.pausedAt === null) return;
    const now = this.now();
    const turn = this.game.turn();
    this.pause[turn] = Math.max(0, this.pause[turn] - Math.max(0, now - this.pausedAt));
    this.pausedAt = null;
    if (this.since !== null && this.since > now) this.since = now;
    this.startPending = false;
  }

  /** Stop the clock, charging the side to move for the time it has used. */
  stopClock(): void {
    if (this.since === null) return;
    const turn = this.game.turn();
    this.left[turn] = Math.max(0, this.left[turn] - Math.max(0, this.now() - this.since));
    this.since = null;
    this.startPending = false;
    this.pausedAt = null;
  }

  who(side: Side): { name: string; rating: number } | null {
    const p = this.players[side];
    const card = p?.key ? this.scores?.get(p.key) : null;
    if (card) return { name: card.name, rating: card.rating };
    // A visitor the scores have since forgotten (too many others said hello) is still who they were.
    return p?.key && p.name ? { name: p.name, rating: START_RATING } : null;
  }

  state(): RoomState {
    return {
      ranked: this.ranked,
      players: { w: this.who('w'), b: this.who('b') },
      clock: this.clock(),
      ended: this.ended,
      change: this.change,
      room: this.name,
      startFen: this.game.startFen(),
      moves: this.game.history().map((e) => ({ from: e.piece.from, to: e.piece.to, ...(e.promotion ? { promotion: e.promotion } : {}) })),
      present: { w: !!this.players.w?.connection, b: !!this.players.b?.connection },
      taken: { w: !!this.players.w, b: !!this.players.b },
      watching: this.watching.size,
      again: { ...this.again },
      resigned: this.game.resigned(),
      drawOffer: this.offer,
      agreed: this.game.drawAgreed(),
      claimed: this.game.drawClaimed(),
      control: this.control,
      ...(this.controlBy ? { controlBy: this.controlBy } : {}),
    };
  }

  seatOf(connection: Connection): Seat | null {
    if (this.players.w?.connection === connection) return 'w';
    if (this.players.b?.connection === connection) return 'b';
    return this.watching.has(connection) ? 'spectator' : null;
  }

  everyone(): Connection[] {
    const out: Connection[] = [...this.watching];
    for (const side of SIDES) {
      const c = this.players[side]?.connection;
      if (c) out.push(c);
    }
    return out;
  }

  broadcast(message: ServerMessage, except?: Connection): void {
    for (const c of this.everyone()) if (c !== except) c.send(message);
  }

  get empty(): boolean {
    return this.everyone().length === 0;
  }
}

/**
 * A room as it is written down, to be taken up again when the server next starts. Nothing in it
 * lets anyone sit down. It is the same whenever it is written until something in the room changes:
 * a running clock is kept as the time left when it began to run (`left`) and when that was
 * (`since`), not as it reads this instant.
 */
export interface SavedRoom {
  name: string;
  ranked: boolean;
  startFen: string;
  moves: MoveData[];
  resigned: Side | null;
  agreed: boolean;
  claimed: 'threefold' | 'fifty-move' | null;
  drawnOnTime: boolean;
  players: Record<Side, { key: string | null; tokenHash: string; name: string | null } | null>;
  expected: Record<Side, string> | null;
  left: Record<Side, number>;
  ended: Ended | null;
  change: Record<Side, number> | null;
  recorded: boolean;
  moved: Record<Side, boolean>;
  held: boolean;
  again: Record<Side, boolean>;
  offer: Side | null;
  offeredAt: Record<Side, number | null>;
  /**
   * When the clock of the side to move began to run, if one was running (`left` is then as of
   * this moment). Left out by an older server, which wrote `left` as the clocks read when it stopped.
   */
  since?: number | null;
  /** When the last person left the room, if it stood empty. */
  emptySince?: number | null;
  /** When each player went away, if they were away (left out by an older server). */
  away?: Record<Side, number | null>;
  /** When the room was made (for a player who has not yet arrived), and a ranked game's own name. */
  made?: number;
  game?: string;
  /**
   * The clock the room's next game is played with, and the one the game on the board is played
   * with (see `Room.control`). Left out by an older server: a friendly room then has none, and a
   * ranked one the ranked clock.
   */
  control?: TimeControl | null;
  timed?: TimeControl | null;
  /**
   * Among friends: how much each player's clock may yet wait for them while they are away, as of
   * `pausedAt`, when the clock of the side to move began to wait (if it was waiting). Left out by an
   * older server: each has the whole allowance.
   */
  pause?: Record<Side, number>;
  pausedAt?: number | null;
}

/** A ranked room that has gone, as it is written down: its moves as one line of text ("e2e4 e7e5 ..."), the rest as it was. */
export interface SavedGone {
  at: number;
  state: Omit<RoomState, 'moves'> & { moves: string | MoveData[] };
}

/** A ranked room that has gone, as it ended: for anyone who arrives for it late. */
export interface GoneRoom {
  at: number;
  state: RoomState;
}

/**
 * What has changed in the rooms worth keeping: one written down afresh, or one forgotten; or the
 * games a pair of players has finished together, or a player's games called off and the wait it earned.
 */
export type RoomChange = { put: SavedRoom } | { drop: string; gone?: SavedGone } | { pair: string; times: number[] } | { strike: string; times: number[]; until: number | null };

export interface SavedRooms {
  version: 1;
  /** When they were written, in milliseconds since 1970: the last moment the server that wrote them is known to have been running. */
  savedAt: number;
  rooms: SavedRoom[];
  /** Which writing of the rooms this is (see server/store.ts). Left out by an older server. */
  epoch?: number;
  /** Ranked rooms that had gone lately, by name. */
  gone?: [string, SavedGone][];
  /** When pairs of players finished rated games against each other, and the players to blame for games called off lately, and those waiting for that. */
  pairs?: [string, number[]][];
  strikes?: [string, number[]][];
  banned?: [string, number][];
}

export interface LobbyOptions {
  /** How many rooms there may be at once. */
  maxRooms?: number;
  /** Words no name may contain, in small letters (the operator's own list, read from a file). */
  blockedNames?: string[];
}

export class Lobby {
  private rooms = new Map<string, Room>();
  private where = new Map<Connection, Room>();
  /** Who each connection has said it is. */
  private known = new Map<Connection, string>();
  /** Those waiting for a match, longest first. */
  private queue: Connection[] = [];
  /** Ranked rooms whose clocks and players have to be looked at every second: those whose game is not over. */
  private watched = new Set<Room>();
  /** Ranked rooms that have gone, by name, as they ended: for anyone who arrives late. */
  private gone = new Map<string, { at: number; state: RoomState }>();
  /** When each pair of players (their keys, in order) finished rated games against each other. */
  private pairs = new Map<string, number[]>();
  /** The same between pairs of addresses. Kept in memory only: an address is never written down. */
  private addressPairs = new Map<string, number[]>();
  /** When each player ('key:') or address ('from:') was last to blame for a ranked game called off, and until when they may not look for another. */
  private strikes = new Map<string, number[]>();
  private banned = new Map<string, number>();
  /** Ranked rooms matched to each address, some of which may still be waiting for it to sit down. */
  private pending = new Map<string, Set<Room>>();
  private maxRooms: number;
  /** When the rooms were last looked over because the server was full. */
  private sweptAt = Number.NEGATIVE_INFINITY;
  private blockedNames: string[];
  /** The same words as they read (see `readAs`), to be looked for in a name as it reads. */
  private blockedAsRead: string[];
  /** Whether the rooms are being written down as they change (see `track`), and what has changed since they were last asked for. */
  private tracking = false;
  private touched = new Set<Room>();
  private dropped = new Map<string, GoneRoom | null>();
  /** Pairs ('pair:') and players ('key:') whose limits have changed since they were last asked for. */
  private limits = new Set<string>();
  readonly scores: Scores;

  constructor(
    private now: () => number = Date.now,
    scores?: Scores,
    options: LobbyOptions = {},
  ) {
    this.scores = scores ?? new Scores(null, now);
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
    this.blockedNames = (options.blockedNames ?? []).map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0);
    this.blockedAsRead = this.blockedNames.map((w) => readAs(w)).filter((w) => w.length > 0);
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** How many games are being watched by the clock: ranked games still being played, and timed friendly games under way. */
  get watchedCount(): number {
    return this.watched.size;
  }

  /** Act on a message from a client. */
  handle(connection: Connection, message: ClientMessage): void {
    try {
      this.act(connection, message);
    } finally {
      // The room it was about may have changed (even if something went wrong part of the way); the
      // room left for another is looked at as it is left.
      if (this.tracking && CHANGING.has(message.t)) {
        const room = this.where.get(connection);
        if (room) this.touch(room);
      }
    }
  }

  private act(connection: Connection, message: ClientMessage): void {
    switch (message.t) {
      case 'hello':
        return this.hello(connection, message);
      case 'queue':
        return this.enqueue(connection);
      case 'unqueue':
        this.queue = this.queue.filter((c) => c !== connection);
        return;
      case 'board': {
        const key = this.known.get(connection);
        connection.send({ t: 'board', top: this.scores.top(BOARD_SIZE), you: key ? this.scores.get(key) : null });
        return;
      }
    }
    if (message.t === 'join') return this.join(connection, message);
    const room = this.where.get(connection);
    if (!room) return;
    const seat = room.seatOf(connection);
    switch (message.t) {
      case 'move':
        return this.move(room, connection, seat, message.ply, message.move);
      case 'think': {
        // Only a player, and only about a piece of their own.
        if (seat !== 'w' && seat !== 'b') return;
        if (message.square && room.game.pieceAt(message.square)?.side !== seat) return;
        room.broadcast({ t: 'think', side: seat, square: message.square }, connection);
        return;
      }
      case 'resign':
        return this.resign(room, connection, seat);
      case 'draw':
        return this.draw(room, connection, seat);
      case 'agree':
        return this.agree(room, seat);
      case 'nodraw':
        return this.noDraw(room, seat);
      case 'claim':
        return this.claim(room, connection, seat);
      case 'again':
        return this.again(room, connection, seat);
      case 'control':
        return this.setControl(room, connection, seat, message.control);
      case 'sync':
        connection.send({ t: 'state', state: room.state() });
        return;
    }
  }

  /** A connection has closed. Its seat, if it had one, is kept for its return. */
  leave(connection: Connection): void {
    this.queue = this.queue.filter((c) => c !== connection);
    this.depart(connection);
    this.known.delete(connection);
  }

  /**
   * Look at every ranked game still being played for a clock that has started or run out, or a
   * player who has gone and not come back; and every timed friendly game for a clock that has run
   * out. Called every second or so; only the games still being
   * played are looked at, however many rooms there are.
   */
  tick(): void {
    const now = this.now();
    for (const room of [...this.watched]) {
      if (room.over || this.rooms.get(room.name) !== room) {
        this.watched.delete(room);
        continue;
      }
      // The first clock has just started: everyone is told, since nothing else would tell them.
      if (room.startPending && room.since !== null && now >= room.since) {
        room.startPending = false;
        room.broadcast({ t: 'state', state: room.state() });
      }
      // A flag that has fallen, whether or not the clock is running: it may have fallen as the server stopped.
      const clock = room.clock();
      const turn = room.game.turn();
      if (clock && clock.left[turn] <= 0) {
        this.flagFell(room, turn);
        continue;
      }
      // Among friends nobody loses for staying away: only the clock is watched.
      if (!room.ranked) continue;
      // At the board, and the first move not made in its time: the game is called off, and the one who sat on it is to blame.
      if (clock?.first && clock.first.left <= 0) {
        this.callOff(room, [clock.first.side]);
        continue;
      }
      // Those who have been gone too long. A player who never arrived has been gone since the room was made.
      const gone = SIDES.map((side) => {
        const p = room.players[side];
        return { side, since: p ? (p.connection ? null : p.awaySince) : room.made };
      })
        .filter((x): x is { side: Side; since: number } => x.since !== null && now - x.since > ABANDON_AFTER)
        .sort((a, b) => a.since - b.since);
      if (gone.length === 0) continue;
      // Both gone at once (they went together, or neither came back after a restart): nobody is
      // more to blame than the other, and the game is called off, unrated, both to blame.
      if (this.rated(room) && gone.length === 1) this.forfeit(room, gone[0]!.side, 'left');
      // Before both have moved nothing is lost: the game is called off, and whoever stayed away is to blame.
      else this.callOff(room, gone.map((g) => g.side));
    }
  }

  // -- ranked games -------------------------------------------------------------

  /** Whether a ranked game, if it ended now, would count: only once both players have made a move. */
  private rated(room: Room): boolean {
    return room.moved.w && room.moved.b;
  }

  /** Say who this connection is. One connection is one player: a second, different player closes it. */
  private hello(connection: Connection, message: Extract<ClientMessage, { t: 'hello' }>): void {
    const key = playerKey(message.id);
    const was = this.known.get(connection);
    if (was !== undefined && was !== key) {
      this.queue = this.queue.filter((c) => c !== connection);
      connection.close(CLOSE_TWO_PLAYERS, 'One player to a connection');
      return;
    }
    this.known.set(connection, key);
    // A name the operator has ruled out is no name: the player keeps the one they had, or the server's.
    const name = message.name && !this.blocked(message.name) ? message.name : undefined;
    connection.send({ t: 'welcome', you: this.scores.greet(key, name) });
    // A new name is seen at once by whoever they are playing.
    const room = this.where.get(connection);
    if (room && name) {
      for (const side of SIDES) if (room.players[side]?.key === key) room.players[side]!.name = name;
      room.broadcast({ t: 'state', state: room.state() });
    }
  }

  /** Whether a name holds a word on the operator's list. */
  private blocked(name: string): boolean {
    if (this.blockedNames.length === 0) return false;
    const plain = name.toLowerCase();
    const letters = lettersOf(name);
    // And as the name reads: with another alphabet's letters, or digits, standing for the word's own.
    const read = readAs(name);
    return this.blockedNames.some((word) => plain.includes(word) || letters.includes(word)) || this.blockedAsRead.some((word) => read.includes(word));
  }

  /** Put a player in the queue, or pair them with the one who has waited longest of those they may play. */
  private enqueue(connection: Connection): void {
    const turn = (reason: string, until?: number) => connection.send({ t: 'turned', reason, ...(until !== undefined ? { until } : {}) });
    const key = this.known.get(connection);
    if (!key) return turn('Say who you are before looking for a game.');
    const now = this.now();
    // Someone who has let games be called off lately waits a while before looking for another.
    const ban = Math.max(this.banned.get(`key:${key}`) ?? 0, connection.address ? (this.banned.get(`from:${connection.address}`) ?? 0) : 0);
    if (ban > now) {
      const minutes = Math.ceil((ban - now) / 60000);
      return turn(`Too many of your games were called off lately. You can look for another in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`, ban - now);
    }
    if (connection.address && this.unjoined(connection.address) >= UNJOINED_PER_ADDRESS) {
      return turn('Games matched to you are still waiting for you to sit down to them.');
    }
    // One place in the queue for each player, however many windows they have open: the newest has it.
    this.queue = this.queue.filter((c) => c !== connection && this.known.get(c) !== key);
    const i = this.queue.findIndex((c) => this.compatible(connection, key, c, now));
    if (i < 0) {
      if (this.queue.length >= MAX_QUEUE) return turn('Too many are waiting for a game just now. Try again in a little while.');
      this.queue.push(connection);
      connection.send({ t: 'queued', waiting: this.queue.length });
      return;
    }
    if (!this.roomForOneMore()) return turn('The server has no room for another game just now.');
    const other = this.queue.splice(i, 1)[0]!;
    const otherKey = this.known.get(other)!;
    let name = newRoomName();
    while (this.rooms.has(name) || this.gone.has(name)) name = newRoomName();
    const room = new Room(name, this.now, this.scores);
    room.ranked = true;
    room.control = RANKED_CONTROL;
    room.setTimed(RANKED_CONTROL);
    room.made = now;
    room.id = randomBytes(8).toString('hex');
    // Empty until they arrive, so that a room neither player ever opens is forgotten in the end.
    room.emptySince = room.made;
    // Who has Ivory is drawn by lot.
    const first = randomBytes(1)[0]! < 128;
    room.expected = first ? { w: key, b: otherKey } : { w: otherKey, b: key };
    room.from = first ? { w: connection.address ?? null, b: other.address ?? null } : { w: other.address ?? null, b: connection.address ?? null };
    for (const address of [connection.address, other.address]) {
      if (!address) continue;
      let set = this.pending.get(address);
      if (!set) this.pending.set(address, (set = new Set()));
      set.add(room);
    }
    this.rooms.set(name, room);
    this.watched.add(room);
    this.touch(room);
    for (const c of [other, connection]) c.send({ t: 'matched', room: name });
  }

  /** Whether the newcomer may be matched with one who is waiting: not themself, not from the same address, and not a pair (of players, or of addresses) that has played enough today. */
  private compatible(connection: Connection, key: string, waiting: Connection, now: number): boolean {
    const otherKey = this.known.get(waiting);
    if (!otherKey || otherKey === key) return false;
    if (connection.address && waiting.address) {
      if (connection.address === waiting.address) return false;
      const between = this.addressPairs.get(this.addressPairName(connection.address, waiting.address));
      if (between && between.filter((t) => now - t < PAIR_WINDOW).length >= ADDRESS_PAIR_LIMIT) return false;
    }
    return this.pairCount(key, otherKey, now) < PAIR_LIMIT;
  }

  /** (An address may hold colons: a space sets the two apart.) */
  private addressPairName(a: string, b: string): string {
    return a < b ? `${a} ${b}` : `${b} ${a}`;
  }

  private pairName(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  /** How many rated games these two have finished against each other in the last day. */
  private pairCount(a: string, b: string, now: number): number {
    const times = this.pairs.get(this.pairName(a, b));
    return times ? times.filter((t) => now - t < PAIR_WINDOW).length : 0;
  }

  /** How many ranked games matched to this address are still waiting for it to sit down. */
  private unjoined(address: string): number {
    const set = this.pending.get(address);
    if (!set) return 0;
    for (const room of set) {
      const waiting = this.rooms.get(room.name) === room && room.ended === null && SIDES.some((side) => room.from[side] === address && !room.players[side]);
      if (!waiting) set.delete(room);
    }
    if (set.size === 0) this.pending.delete(address);
    return set.size;
  }

  /** A player or address is to blame for a game called off. Twice in a short time, and they wait before looking for another. */
  private strike(id: string): void {
    const now = this.now();
    const recent = (this.strikes.get(id) ?? []).filter((t) => now - t < STRIKE_WINDOW);
    recent.push(now);
    this.strikes.set(id, recent);
    if (recent.length >= STRIKE_LIMIT) this.banned.set(id, now + STRIKE_BAN);
    // Only a player's own (hashed) key is written down, never an address.
    if (this.tracking && id.startsWith('key:')) this.limits.add(id);
  }

  /**
   * A side's time has run out (FIDE 6.9): in a ranked game before both have moved the game is
   * called off; otherwise it is lost, unless the other side could never have mated, when it is drawn.
   */
  private flagFell(room: Room, side: Side): void {
    if (room.ranked && !this.rated(room)) return this.callOff(room, [side]);
    this.forfeit(room, side, 'time');
  }

  /** The server ends a game against one side: its time ran out, or (a ranked game only) it left. */
  private forfeit(room: Room, side: Side, why: Ended): void {
    room.stopClock();
    if (why === 'time') room.left[side] = 0;
    const ended = why === 'time' && !room.game.couldMate(opposite(side)) ? room.game.drawOnTime() : room.game.resign(side);
    if (!ended) return;
    room.ended = why;
    room.offer = null;
    this.finish(room);
    this.touch(room);
    room.broadcast({ t: 'state', state: room.state() });
  }

  /**
   * A ranked game ended before both players had moved: nobody's rating moves, and those whose
   * absence, resignation or idle clock ended it are to blame. The room goes at once; anyone who
   * arrives for it afterwards is told what became of it.
   */
  private callOff(room: Room, blamed: Side[]): void {
    if (room.over) return;
    room.stopClock();
    room.ended = 'noshow';
    room.offer = null;
    this.watched.delete(room);
    for (const side of blamed) {
      const key = room.players[side]?.key ?? room.expected?.[side];
      if (key) this.strike(`key:${key}`);
      const address = room.players[side]?.connection?.address ?? room.from[side];
      if (address) this.strike(`from:${address}`);
    }
    room.broadcast({ t: 'state', state: room.state() });
    this.retire(room);
  }

  /**
   * If a ranked game has just ended, stop its clock and count it, once. Every ending comes through
   * here, and every caller tells the room afterwards with a state that carries the change.
   */
  private finish(room: Room): void {
    if (!room.game.status().over) return;
    if (!room.ranked) {
      // A friendly game's clock, if it has one, stops where it stands. Nothing is counted.
      room.stopClock();
      this.watched.delete(room);
      return;
    }
    if (room.recorded) return;
    room.stopClock();
    room.recorded = true;
    room.offer = null;
    this.watched.delete(room);
    const w = room.players.w?.key;
    const b = room.players.b?.key;
    if (!w || !b || !this.rated(room)) return;
    room.change = this.scores.record(w, b, room.game.status().winner, room.id || undefined);
    const now = this.now();
    const pair = this.pairName(w, b);
    this.pairs.set(pair, [...(this.pairs.get(pair) ?? []).filter((t) => now - t < PAIR_WINDOW), now]);
    if (this.tracking) this.limits.add(`pair:${pair}`);
    const [from, against] = SIDES.map((side) => room.players[side]?.connection?.address ?? room.from[side]);
    if (from && against && from !== against) {
      const between = this.addressPairName(from, against);
      this.addressPairs.set(between, [...(this.addressPairs.get(between) ?? []).filter((t) => now - t < PAIR_WINDOW), now]);
    }
  }

  // -- internals --------------------------------------------------------------

  /** Take a connection out of the room it is in. */
  private depart(connection: Connection): void {
    const room = this.where.get(connection);
    if (!room) return;
    this.where.delete(connection);
    room.watching.delete(connection);
    this.touch(room);
    for (const side of SIDES) {
      const p = room.players[side];
      if (p?.connection === connection) {
        p.connection = null;
        p.awaySince = this.now();
        // Among friends a clock never runs for a player who is not there: theirs waits for them.
        if (!room.ranked && room.timed && side === room.game.turn() && !room.over && room.game.history().length > 0) room.waitForMover();
        // The hand they left hovering over a piece goes back to rest on the other screens.
        room.broadcast({ t: 'think', side, square: null });
      }
    }
    if (room.empty) {
      room.emptySince = this.now();
      // A room nobody has played in is not worth keeping: there is no game to come back to. (A
      // ranked one is kept all the same: the other player is on their way to it by its name.)
      // Nor is one whose game was called off.
      if ((!room.held && !room.ranked) || room.ended === 'noshow') this.retire(room);
    }
    room.broadcast({ t: 'state', state: room.state() });
  }

  /** Forget a room. A ranked one's name is remembered a while, with how it ended. */
  private retire(room: Room): void {
    const here = this.rooms.get(room.name) === room;
    if (here) this.rooms.delete(room.name);
    this.watched.delete(room);
    let gone: GoneRoom | null = null;
    if (room.ranked) {
      gone = { at: this.now(), state: room.state() };
      this.gone.set(room.name, gone);
      if (this.gone.size > MOST_GONE) this.gone.delete(this.gone.keys().next().value!);
    }
    if (this.tracking && here) {
      this.touched.delete(room);
      this.dropped.set(room.name, gone);
    }
  }

  /** Note that a room may have changed, to be written down before anyone is told. */
  private touch(room: Room): void {
    if (this.tracking) this.touched.add(room);
  }

  /**
   * Whether another room may be opened. A full server first forgets what it may (looking over
   * all its rooms at most once a second, however many ask), and then, if it is still full, makes
   * way: a game somebody is at comes before one nobody is at. Of the empty rooms, the finished
   * one that has stood empty longest goes first. If none is finished, a game among friends that
   * both have walked away from goes: the one with the fewest moves played, and of those the one
   * empty longest, so that rooms opened only to fill the server go before a real game whose
   * players have dropped. A ranked game still to be decided is never forgotten here: its players'
   * absence ends it in a minute by itself.
   */
  private roomForOneMore(): boolean {
    if (this.rooms.size < this.maxRooms) return true;
    const now = this.now();
    if (now - this.sweptAt >= 1000) {
      this.sweptAt = now;
      this.sweep();
      if (this.rooms.size < this.maxRooms) return true;
    }
    let finished: Room | null = null;
    let left: Room | null = null;
    let leftMoves = 0;
    for (const room of this.rooms.values()) {
      if (room.emptySince === null) continue;
      if (room.over) {
        if (!finished || room.emptySince < finished.emptySince!) finished = room;
      } else if (!room.ranked && !finished) {
        const moves = room.game.history().length;
        if (!left || moves < leftMoves || (moves === leftMoves && room.emptySince < left.emptySince!)) {
          left = room;
          leftMoves = moves;
        }
      }
    }
    const going = finished ?? left;
    if (!going) return false;
    this.retire(going);
    return true;
  }

  /** How many rooms opened from this address there still are. */
  private openedFrom(address: string): number {
    let n = 0;
    for (const room of this.rooms.values()) if (room.openedFrom === address) n++;
    return n;
  }

  /** Forget rooms that have stood empty too long (not long, once their game is over), and other things whose time is up. */
  sweep(): void {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.emptySince === null) continue;
      const life = room.over ? FINISHED_ROOM_LIFE : EMPTY_ROOM_LIFE;
      if (now - room.emptySince > life) this.retire(room);
    }
    for (const [name, gone] of this.gone) if (now - gone.at > GONE_ROOM_LIFE) this.gone.delete(name);
    for (const [pair, times] of this.pairs) {
      const recent = times.filter((t) => now - t < PAIR_WINDOW);
      if (recent.length === 0) this.pairs.delete(pair);
      else this.pairs.set(pair, recent);
    }
    for (const [pair, times] of this.addressPairs) {
      const recent = times.filter((t) => now - t < PAIR_WINDOW);
      if (recent.length === 0) this.addressPairs.delete(pair);
      else this.addressPairs.set(pair, recent);
    }
    for (const [id, times] of this.strikes) if (times.every((t) => now - t >= STRIKE_WINDOW)) this.strikes.delete(id);
    for (const [id, until] of this.banned) if (until <= now) this.banned.delete(id);
    for (const address of [...this.pending.keys()]) this.unjoined(address);
  }

  private join(connection: Connection, message: Extract<ClientMessage, { t: 'join' }>): void {
    if (this.where.has(connection)) this.depart(connection);
    let room = this.rooms.get(message.room);
    if (!room) {
      const gone = this.gone.get(message.room);
      if (gone) {
        const why = gone.state.ended === 'noshow' ? GONE.calledOff : GONE.over;
        connection.send({ t: 'refused', reason: why, state: gone.state });
        return;
      }
      // One address may not open rooms without end: left full of games nobody means to finish, they would keep everyone else out.
      if (connection.address && this.openedFrom(connection.address) >= OPENED_PER_ADDRESS) {
        connection.send({ t: 'refused', reason: 'Too many games are open from your network just now. Finish one, or try again in a while.', state: new Room(message.room).state() });
        return;
      }
      if (!this.roomForOneMore()) {
        connection.send({ t: 'refused', reason: 'The server has no room for another game just now.', state: new Room(message.room).state() });
        return;
      }
      room = new Room(message.room, this.now, this.scores);
      room.openedFrom = connection.address ?? null;
      this.rooms.set(message.room, room);
    }
    const here = room;
    const key = this.known.get(connection) ?? null;
    const remembered = message.remembered?.map(hashToken) ?? [];
    const presented = message.token ? hashToken(message.token) : null;

    let seat: Seat = 'spectator';
    let token = '';
    const sit = (side: Side, player: Player, given: string | null = null) => {
      const old = player.connection;
      player.connection = connection;
      player.awaySince = null;
      // In a friendly room a seat is held by its key, and whoever holds it may have a name by now.
      if (!here.ranked && key) player.key = key;
      if (player.key) player.name = this.scores.get(player.key)?.name ?? player.name;
      // The seat's key goes back to its window: the one the window gave, or (after a restart, when
      // the server keeps only a hash of the old one) a new one.
      if (given) player.token = given;
      if (!player.token) {
        player.token = randomBytes(16).toString('hex');
        player.tokenHash = hashToken(player.token);
      }
      seat = side;
      token = player.token;
      if (old && old !== connection) {
        // The same seat, opened again elsewhere: the newer window has it. Whatever the older one's
        // hand was hovering over, it is not any more.
        this.where.delete(old);
        old.close(CLOSE_DISPLACED, 'This seat was opened in another window');
        here.broadcast({ t: 'think', side, square: null }, connection);
      }
    };

    // A ranked room's seats belong to the two players the queue matched, and to nobody else.
    if (here.ranked && here.expected && key && !message.watch) {
      for (const side of SIDES) {
        if (seat !== 'spectator' || here.expected[side] !== key) continue;
        const player: Player = here.players[side] ?? newPlayer(key);
        here.players[side] = player;
        sit(side, player);
      }
    }
    // This window's own key always gets its seat back.
    for (const side of SIDES) {
      const p = here.players[side];
      if (!here.ranked && p && presented && p.tokenHash === presented) sit(side, p, message.token ?? null);
    }
    // A key the browser remembers gets its seat back only if the seat stands empty.
    if (seat === 'spectator' && !here.ranked) {
      for (const side of SIDES) {
        const p = here.players[side];
        const i = p ? remembered.indexOf(p.tokenHash) : -1;
        if (seat === 'spectator' && p && !p.connection && i >= 0) sit(side, p, message.remembered![i]!);
      }
    }
    // Otherwise the first two to arrive (and not asking only to watch) are the players: Ivory, then Void.
    if (seat === 'spectator' && !message.watch && !here.ranked) {
      const unstarted = !here.held;
      const free = SIDES.find((side) => {
        const p = here.players[side];
        if (!p) return true;
        // Before a move has been played, a seat somebody walked away from is free again.
        return unstarted && !p.connection && p.awaySince !== null && this.now() - p.awaySince > UNSTARTED_SEAT_LIFE;
      });
      if (free) {
        const player = newPlayer(key);
        here.players[free] = player;
        sit(free, player);
      }
    }
    if (seat === 'spectator') {
      if (here.watching.size >= MAX_WATCHING) {
        connection.send({ t: 'refused', reason: 'This room is full.', state: here.state() });
        return;
      }
      here.watching.add(connection);
    }
    here.emptySince = null;
    // A ranked game's clock starts once both players have sat down to it: the first a few seconds
    // later, while the match is introduced (or at White's first move, if that is sooner).
    if (here.ranked && here.since === null && !here.over && here.players.w?.connection && here.players.b?.connection) {
      const first = here.game.history().length === 0;
      here.since = this.now() + (first ? CLOCK_DELAY : 0);
      here.startPending = first;
    }
    // One stopped by a restart of the server runs again as soon as the player to move is back (see `restore`).
    if (here.ranked && !here.over && here.since !== null && here.since > this.now() && here.game.history().length > 0 && (seat as Seat) === here.game.turn()) {
      here.since = this.now();
      here.startPending = false;
    }
    // A friendly clock that was waiting for the player to move (away, or the server restarted) runs again once they are back.
    if (!here.ranked && here.timed && !here.over && here.game.history().length > 0 && here.players[here.game.turn()]?.connection) {
      here.moverBack();
      if (here.since === null) here.since = this.now();
    }
    this.where.set(connection, here);
    connection.send({ t: 'joined', you: seat, token, state: here.state() });
    here.broadcast({ t: 'state', state: here.state() }, connection);
  }

  private move(room: Room, connection: Connection, seat: Seat | null, ply: number, move: MoveData): void {
    const refuse = (reason: string) => connection.send({ t: 'refused', reason, state: room.state() });
    if (seat !== 'w' && seat !== 'b') return refuse('Only the two players can move.');
    if (!room.players.w || !room.players.b) return refuse('Wait for the other player to arrive.');
    if (ply !== room.game.history().length) return refuse('That move was for an earlier position.');
    if (room.game.turn() !== seat) return refuse('It is not your turn.');
    if (room.ended === 'noshow') return refuse(GONE.calledOff);
    // A move that arrives after the mover's time has gone is too late.
    const before = room.clock();
    if (before && before.left[seat] <= 0) return this.flagFell(room, seat);
    let played;
    try {
      played = room.game.move(move.from, move.to, move.promotion);
    } catch (error) {
      if (error instanceof IllegalMoveError) return refuse('That move is not legal.');
      throw error;
    }
    room.moved[seat] = true;
    room.held = true;
    const over = room.game.status().over;
    if (before && room.timed) {
      // The mover is charged for the time they took and given a little back; then the other clock
      // runs. A friendly clock starts with White's first move, which is made before any clock has
      // run and so gives nothing back (a ranked game's first move, made in its few seconds' grace, does).
      const started = room.ranked || before.running !== null;
      room.left[seat] = before.left[seat] + (started ? room.timed.increment : 0);
      room.since = over ? null : this.now();
      room.startPending = false;
      room.pausedAt = null;
      // Among friends, a player who is away when their move comes has their clock wait for them, as far as their allowance goes.
      if (!over && !room.ranked && !room.players[opposite(seat)]?.connection) room.waitForMover();
      if (!over && !room.ranked) this.watched.add(room);
      this.finish(room);
    }
    // To move on is to say no to a draw that was offered; and a game that has ended has nothing left to offer.
    const answered = room.offer !== null && (room.offer !== seat || over);
    if (answered) room.offer = null;
    const clock = room.clock();
    // The move as it was played, not as it was asked for: a promotion named for a move that promotes nothing is not passed on.
    const as: MoveData = { from: played.piece.from, to: played.piece.to, ...(played.promotion ? { promotion: played.promotion } : {}) };
    room.broadcast({ t: 'moved', ply, move: as, ...(clock ? { clock } : {}) });
    // The end of a ranked game changes more than the board: the ratings, and the clocks stop.
    if (answered || (room.ranked && over)) room.broadcast({ t: 'state', state: room.state() });
  }

  /** A player gives the game up, at any point in it and whoever is to move. Everyone is told. */
  private resign(room: Room, connection: Connection, seat: Seat | null): void {
    const refuse = (reason: string) => connection.send({ t: 'refused', reason, state: room.state() });
    if (seat !== 'w' && seat !== 'b') return refuse('Only the two players can resign.');
    if (!room.players.w || !room.players.b) return refuse('Wait for the other player to arrive.');
    // Already over (perhaps the other player's mating move crossed with this): nothing to give up.
    if (room.over) return;
    // A ranked game given up before both have moved is not a game: it is called off, unrated, and the one who gave it up is to blame.
    if (room.ranked && !this.rated(room)) return this.callOff(room, [seat]);
    if (!room.game.resign(seat)) return;
    room.held = true;
    room.offer = null;
    this.finish(room);
    room.broadcast({ t: 'state', state: room.state() });
  }

  /**
   * A player offers a draw, or agrees to the one the other has offered. An offer stands until
   * it is answered: by a yes, a no, or the other player moving on. Each side may offer once a move.
   */
  private draw(room: Room, connection: Connection, seat: Seat | null): void {
    const refuse = (reason: string) => connection.send({ t: 'refused', reason, state: room.state() });
    if (seat !== 'w' && seat !== 'b') return refuse('Only the two players can agree a draw.');
    if (!room.players.w || !room.players.b) return refuse('Wait for the other player to arrive.');
    // Already over (the offer crossed with the end of the game), or my own offer asked again: nothing to do.
    if (room.over || room.offer === seat) return;
    const played = room.game.history().length;
    if (room.offer === opposite(seat)) {
      room.offer = null;
      room.game.agreeDraw();
      this.finish(room);
    } else {
      if (played < 2) return refuse('A draw can be offered once both players have moved.');
      const last = room.offeredAt[seat];
      if (last !== null && played < last + 2) return refuse('You have already offered a draw on this move.');
      room.offer = seat;
      room.offeredAt[seat] = played;
    }
    room.broadcast({ t: 'state', state: room.state() });
  }

  /**
   * A player says yes to the draw the other has offered. With no such offer standing (it was
   * taken back as the yes was on its way) nothing happens: a yes is never an offer of one's own.
   */
  private agree(room: Room, seat: Seat | null): void {
    if ((seat !== 'w' && seat !== 'b') || room.over || room.offer !== opposite(seat)) return;
    room.offer = null;
    room.game.agreeDraw();
    this.finish(room);
    room.broadcast({ t: 'state', state: room.state() });
  }

  /** A player says no to the draw they were offered, or takes back the one they offered. */
  private noDraw(room: Room, seat: Seat | null): void {
    if ((seat !== 'w' && seat !== 'b') || room.offer === null) return;
    room.offer = null;
    room.broadcast({ t: 'state', state: room.state() });
  }

  /**
   * The player to move claims a draw: the position has stood three times, or fifty moves each
   * have passed without a capture or a pawn move (FIDE 9.2, 9.3). It needs no answer: the game is
   * drawn, and counted in a ranked room, and everyone is told.
   */
  private claim(room: Room, connection: Connection, seat: Seat | null): void {
    const refuse = (reason: string) => connection.send({ t: 'refused', reason, state: room.state() });
    if (seat !== 'w' && seat !== 'b') return refuse('Only the two players can claim a draw.');
    if (!room.players.w || !room.players.b) return refuse('Wait for the other player to arrive.');
    // Already over (the claim crossed with the end of the game): nothing to claim.
    if (room.over) return;
    if (room.game.turn() !== seat) return refuse('Only the player to move can claim a draw.');
    if (!room.game.claimDraw()) return refuse('There is no draw to claim in this position.');
    room.offer = null;
    this.finish(room);
    room.broadcast({ t: 'state', state: room.state() });
  }

  /** Another game starts once both players have asked, with the colours swapped. Only among friends: a ranked game is one game, and the next is found in the queue. */
  private again(room: Room, connection: Connection, seat: Seat | null): void {
    if (seat !== 'w' && seat !== 'b') return;
    if (room.ranked) {
      connection.send({ t: 'refused', reason: 'A ranked game is played once. Look for another opponent to play again.', state: room.state() });
      return;
    }
    // Only once the game is over. A second press arriving after the new game has begun is not a request to end that one too.
    if (!room.game.status().over) return;
    room.again[seat] = true;
    if (!room.again[opposite(seat)]) {
      room.broadcast({ t: 'state', state: room.state() });
      return;
    }
    room.game = new Game();
    room.again = { w: false, b: false };
    room.offer = null;
    room.offeredAt = { w: null, b: null };
    // A new game: nobody has moved in it yet. (The seats stay the two players': `held` stays.)
    room.moved = { w: false, b: false };
    room.players = { w: room.players.b, b: room.players.w };
    // With the clock the room has chosen now, whatever the last game had; and the last one's flag, if it fell, is forgotten.
    room.setTimed(room.control);
    room.ended = null;
    const state = room.state();
    for (const side of SIDES) room.players[side]?.connection?.send({ t: 'seated', you: side, state });
    for (const c of room.watching) c.send({ t: 'seated', you: 'spectator', state });
  }

  /**
   * A player of a friendly room chooses its clock, or none, between games: before the first move
   * of one (which then has it at once), or once it is over (the next has it). Everyone sees it,
   * and a request for another game made before it is asked again, by someone who has seen it.
   */
  private setControl(room: Room, connection: Connection, seat: Seat | null, control: TimeControl | null): void {
    const refuse = (reason: string) => connection.send({ t: 'refused', reason, state: room.state() });
    if (seat !== 'w' && seat !== 'b') return refuse('Only the two players can choose the clock.');
    if (room.ranked) return refuse('A ranked game has its own clock.');
    const between = room.over || room.game.history().length === 0;
    if (!between) return refuse('The clock can be changed between games.');
    // Only the room's own list, whatever was sent.
    const chosen = control === null ? null : friendlyControl(control);
    if (control !== null && !chosen) return refuse('That clock is not one of those on offer.');
    if (sameControl(chosen, room.control)) return;
    room.control = chosen;
    room.controlBy = seat;
    if (!room.over) room.setTimed(chosen);
    room.again = { w: false, b: false };
    room.broadcast({ t: 'state', state: room.state() });
  }

  // -- a restart ------------------------------------------------------------------

  /**
   * From now on, note every room that changes, so that what has changed can be written down (see
   * `changes`) before anyone is told of it.
   */
  track(): void {
    this.tracking = true;
  }

  /**
   * What has changed since this was last asked: the rooms forgotten, then the rooms worth keeping
   * as they now stand, then the limits on who may play whom. A room that is touched but has not
   * really changed is given all the same; whoever writes them down can tell.
   */
  changes(): RoomChange[] {
    const out: RoomChange[] = [];
    // The forgotten first: a room of the same name made since is written after.
    for (const [name, gone] of this.dropped) out.push(gone ? { drop: name, gone: packGone(gone) } : { drop: name });
    for (const room of this.touched) if (this.rooms.get(room.name) === room && this.worthKeeping(room)) out.push({ put: this.saveRoom(room) });
    for (const id of this.limits) {
      if (id.startsWith('pair:')) out.push({ pair: id.slice(5), times: this.pairs.get(id.slice(5)) ?? [] });
      else out.push({ strike: id, times: this.strikes.get(id) ?? [], until: this.banned.get(id) ?? null });
    }
    this.dropped.clear();
    this.touched.clear();
    this.limits.clear();
    return out;
  }

  /**
   * A room whose seats are taken, or that has been played in, is kept: after a restart each seat is
   * its player's again, and not the first to come back's. A ranked one is kept from the moment it is
   * made: both players are on their way to it. (A friendly room nobody has played in goes as soon
   * as it stands empty, here as in memory.)
   */
  private worthKeeping(room: Room): boolean {
    return room.held || room.ranked || room.players.w !== null || room.players.b !== null;
  }

  /** One room, written down. Seat keys are kept only as hashes, players by their hashed keys. */
  private saveRoom(room: Room): SavedRoom {
    return {
      name: room.name,
      ranked: room.ranked,
      startFen: room.game.startFen(),
      moves: room.game.history().map((e) => ({ from: e.piece.from, to: e.piece.to, ...(e.promotion ? { promotion: e.promotion } : {}) })),
      resigned: room.game.resigned(),
      agreed: room.game.drawAgreed(),
      claimed: room.game.drawClaimed(),
      drawnOnTime: room.game.drawnOnTime(),
      players: {
        w: room.players.w ? { key: room.players.w.key, tokenHash: room.players.w.tokenHash, name: room.who('w')?.name ?? room.players.w.name } : null,
        b: room.players.b ? { key: room.players.b.key, tokenHash: room.players.b.tokenHash, name: room.who('b')?.name ?? room.players.b.name } : null,
      },
      expected: room.expected,
      left: { ...room.left },
      since: room.since,
      ended: room.ended,
      change: room.change,
      recorded: room.recorded,
      moved: { ...room.moved },
      held: room.held,
      again: { ...room.again },
      offer: room.offer,
      offeredAt: { ...room.offeredAt },
      emptySince: room.emptySince,
      away: { w: room.players.w?.awaySince ?? null, b: room.players.b?.awaySince ?? null },
      made: room.made,
      ...(room.id ? { game: room.id } : {}),
      control: room.control,
      timed: room.timed,
      pause: { ...room.pause },
      pausedAt: room.pausedAt,
    };
  }

  /**
   * Every room worth taking up again after a restart, written down, with what the server remembers
   * of ranked rooms that have gone and of who has played whom and who is to blame for what. Only
   * players' hashed keys: no seat key, and no address.
   */
  save(): SavedRooms {
    const rooms: SavedRoom[] = [];
    for (const room of this.rooms.values()) if (this.worthKeeping(room)) rooms.push(this.saveRoom(room));
    const byKey = <T>(map: Map<string, T>) => [...map].filter(([id]) => id.startsWith('key:'));
    const gone = [...this.gone].map(([name, g]): [string, SavedGone] => [name, packGone(g)]);
    return { version: 1, savedAt: this.now(), rooms, gone, pairs: [...this.pairs], strikes: byKey(this.strikes), banned: byKey(this.banned) };
  }

  /**
   * Take up the rooms written down by the server that ran before. `savedAt` is the last moment it
   * is known to have been running; the time from then until now, while the server was down, counts
   * against nobody:
   * - The side that was to move is charged for the time it took up to `savedAt`. Its clock runs
   *   again as soon as its player is back, or `RESTART_GRACE` from now if they are not (as it would
   *   for any player who had lost their connection).
   * - A player who was here when the server stopped has the usual time to come back; one who was
   *   already away has what was left of theirs, and at least `RESTART_GRACE`.
   * - A finished game is counted towards the ratings if the scores never heard of it (the server
   *   stopped before they were written), and never twice.
   * Rooms are forgotten by the clock on the wall: one that stood empty long enough is not taken up.
   * Returns how many rooms were taken up.
   */
  restore(saved: SavedRooms): number {
    if (saved?.version !== 1 || !Array.isArray(saved.rooms)) return 0;
    const now = this.now();
    const stopped = Number.isFinite(Number(saved.savedAt)) ? Number(saved.savedAt) : now;
    /** Someone away since `at` before the stop: away as long, not counting the time the server was down, and with at least the grace still to run. */
    const away = (at: number) => Math.max(now - Math.max(0, stopped - at), now - ABANDON_AFTER + RESTART_GRACE);
    let taken = 0;
    for (const s of saved.rooms) {
      if (this.rooms.size >= this.maxRooms) break;
      try {
        if (!ROOM_NAME.test(s.name) || this.rooms.has(s.name)) continue;
        const room = new Room(s.name, this.now, this.scores);
        room.game = new Game(s.startFen);
        for (const m of s.moves) room.game.move(m.from, m.to, m.promotion);
        if (s.claimed) room.game.claimDraw();
        if (s.agreed) room.game.agreeDraw();
        if (s.drawnOnTime) room.game.drawOnTime();
        if (s.resigned) room.game.resign(s.resigned);
        room.ranked = s.ranked === true;
        room.ended = s.ended ?? null;
        // A room that has stood empty long enough to be forgotten is not taken up.
        const emptySince = typeof s.emptySince === 'number' ? Math.min(now, s.emptySince) : null;
        if (emptySince !== null && now - emptySince > (room.over ? FINISHED_ROOM_LIFE : EMPTY_ROOM_LIFE)) continue;
        room.expected = s.expected ?? null;
        for (const side of SIDES) {
          const p = s.players[side];
          if (!p || typeof p.tokenHash !== 'string') continue;
          const was = s.away?.[side];
          room.players[side] = { key: p.key ?? null, token: null, tokenHash: p.tokenHash, name: p.name ?? null, connection: null, awaySince: typeof was === 'number' ? away(was) : now };
          // A visitor who had not yet finished a game is remembered again by name.
          if (p.key && p.name && !this.scores.get(p.key)) this.scores.greet(p.key, p.name);
        }
        // The clocks: a ranked room's own (also for one written before rooms said so), or a friendly
        // room's choice, which one written before friendly clocks were made does not have.
        const control = (x: unknown) => (room.ranked ? RANKED_CONTROL : friendlyControl(x));
        room.control = control(s.control);
        room.timed = s.timed === undefined && room.ranked ? RANKED_CONTROL : control(s.timed);
        room.left = { w: Number(s.left.w), b: Number(s.left.b) };
        // The clock that was running is charged up to the stop.
        if (typeof s.since === 'number' && room.timed && !room.over) {
          const turn = room.game.turn();
          room.left[turn] = Math.max(0, room.left[turn] - Math.max(0, stopped - s.since));
        }
        // From here it stands still until the player to move is back, or for the grace at most; and
        // everyone is told when it runs. A game not yet begun starts as any other, once both are here.
        if (room.ranked && !room.over && room.game.history().length > 0) {
          room.since = now + RESTART_GRACE;
          room.startPending = true;
        }
        // Among friends, it waits for the player to move as it would for one who had gone away, out
        // of what is left of their allowance: a wait already begun is charged up to the stop, and the
        // time the server was down is charged to nobody.
        const allowed = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(PAUSE_ALLOWANCE, Math.max(0, x)) : PAUSE_ALLOWANCE);
        room.pause = { w: allowed(s.pause?.w), b: allowed(s.pause?.b) };
        if (!room.ranked && room.timed && !room.over && room.game.history().length > 0) {
          const turn = room.game.turn();
          if (typeof s.pausedAt === 'number') room.pause[turn] = Math.max(0, room.pause[turn] - Math.max(0, stopped - s.pausedAt));
          room.since = now;
          room.waitForMover();
        }
        room.change = s.change ?? null;
        room.recorded = s.recorded === true;
        room.moved = { w: s.moved?.w === true, b: s.moved?.b === true };
        room.held = s.held === true;
        room.again = { w: s.again?.w === true, b: s.again?.b === true };
        room.offer = s.offer ?? null;
        room.offeredAt = { w: s.offeredAt?.w ?? null, b: s.offeredAt?.b ?? null };
        room.id = typeof s.game === 'string' ? s.game : '';
        // A player who had not yet arrived is awaited as one who was away.
        room.made = typeof s.made === 'number' ? away(s.made) : now;
        // Empty now, whoever was here; one that already stood empty, since then.
        room.emptySince = emptySince ?? now;
        // Counted, but perhaps not yet written to the scores when the server stopped. Only a game
        // with a name of its own can be told apart from one counted already.
        const w = room.players.w?.key;
        const b = room.players.b?.key;
        if (room.recorded && room.change && room.id && w && b) this.scores.settle(room.id, w, b, room.game.status().winner, room.change);
        this.rooms.set(room.name, room);
        if (room.ranked && !room.over) this.watched.add(room);
        // A timed friendly game under way: a flag that fell as the server stopped falls now.
        if (!room.ranked && room.timed && !room.over && room.game.history().length > 0) this.watched.add(room);
        taken++;
      } catch (error) {
        console.error(`A saved room could not be taken up again: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    // What is remembered besides the rooms, if it is still of use.
    for (const entry of saved.gone ?? []) {
      const [name, gone] = Array.isArray(entry) ? entry : [];
      if (typeof name !== 'string' || !ROOM_NAME.test(name) || this.rooms.has(name) || typeof gone?.at !== 'number' || typeof gone.state !== 'object' || !gone.state) continue;
      const at = Math.min(now, gone.at);
      if (now - at < GONE_ROOM_LIFE) this.gone.set(name, { at, state: unpackGone(gone.state) });
    }
    const times = (x: unknown): x is number[] => Array.isArray(x) && x.every((t) => typeof t === 'number');
    for (const [pair, at] of saved.pairs ?? []) if (typeof pair === 'string' && times(at) && at.length > 0) this.pairs.set(pair, at);
    for (const [id, at] of saved.strikes ?? []) if (typeof id === 'string' && id.startsWith('key:') && times(at) && at.length > 0) this.strikes.set(id, at);
    for (const [id, until] of saved.banned ?? []) if (typeof id === 'string' && id.startsWith('key:') && typeof until === 'number' && until > now) this.banned.set(id, until);
    return taken;
  }
}

/** A gone room as it is written down: the moves, which are most of it, as one short line. */
function packGone(gone: GoneRoom): SavedGone {
  const moves = gone.state.moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).join(' ');
  return { at: gone.at, state: { ...gone.state, moves } };
}

function unpackGone(state: SavedGone['state']): RoomState {
  if (typeof state.moves !== 'string') return state as RoomState;
  const moves = state.moves
    .split(' ')
    .filter((m) => m.length >= 4)
    .map((m) => ({ from: m.slice(0, 2), to: m.slice(2, 4), ...(m[4] ? { promotion: m[4] } : {}) }) as MoveData);
  return { ...state, moves };
}
