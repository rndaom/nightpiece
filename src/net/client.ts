/**
 * One player's connection to a room on the game's server.
 *
 * It joins the room, passes on what the server says, and if the connection
 * drops it comes back and takes the same seat again. The server holds the
 * game; this only carries messages.
 */
import { storageKey } from '../app/brand';
import type { Side, Square } from '../core/game';
import type { Identity } from './identity';
import { CLOSE_DISPLACED, type ClientMessage, type Clock, type MoveData, type PlayerCard, type RoomState, type Seat, type ServerMessage, type TimeControl } from './protocol';

/** The state of the connection: on its way, there, dropped and being retried, or given up because another window has the seat. */
export type Link = 'connecting' | 'open' | 'lost' | 'displaced';

export interface NetHandlers {
  link(status: Link): void;
  joined(you: Seat, state: RoomState): void;
  state(state: RoomState): void;
  moved(ply: number, move: MoveData, clock?: Clock): void;
  /** The server's answer to being told who this is. */
  welcome?(you: PlayerCard): void;
  think(side: Side, square: Square | null): void;
  refused(reason: string, state: RoomState): void;
  seated(you: Seat, state: RoomState): void;
}

/** Where the keys to seats are kept between visits. */
export interface Keys {
  /** This window's own key to a seat in the room, if it has one. */
  own(room: string): string | null;
  /** Keys any window of this browser has been given for the room. */
  remembered(room: string): string[];
  keep(room: string, token: string): void;
}

export interface NetOptions {
  /** The server's WebSocket address. */
  url: string;
  room: string;
  keys: Keys;
  handlers: NetHandlers;
  /** Ask only to watch, leaving the seats for others. */
  watch?: boolean;
  /** Who this browser is, said before the room is entered: the player's name, and their seat in a ranked game. */
  who?: () => Identity;
  /** How long to wait before each attempt to reconnect, in milliseconds. The last is used from then on. */
  retry?: number[];
  /** If nothing at all arrives for this long, in milliseconds, the connection is taken for dead. The server says a word every fifteen seconds. */
  quiet?: number;
  /** If a move gets no answer of any kind for this long, in milliseconds, the connection is taken for dead. */
  answer?: number;
}

const RETRY = [400, 800, 1600, 3200, 5000];
const QUIET = 40000;
const ANSWER = 6000;
/** A player's hand on the other screens follows the pointer no more often than this. */
const THINK_EVERY = 150;

export class Net {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  /** The square last asked for, and the one last sent. */
  private thought: Square | null = null;
  private thoughtSent: Square | null = null;
  private thoughtTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The key to this window's seat, as the server gave it. Kept here as well as in the browser's
   * storage, which may be blocked: the seat must at least last as long as the page does.
   */
  private token: string | null = null;
  /** When anything last arrived, and the timers that act on silence: one for the line as a whole, one for a move sent and not yet answered. */
  private heard = 0;
  private watch: ReturnType<typeof setInterval> | null = null;
  private owed: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: NetOptions) {
    this.connect();
  }

  get room(): string {
    return this.o.room;
  }

  /** Ask the server to play a move. `ply` is how many moves had been played before it. */
  move(ply: number, move: MoveData): boolean {
    const socket = this.socket;
    if (!this.send({ t: 'move', ply, move })) return false;
    // Every move is answered at once, with the move or a refusal. Silence means the line is dead,
    // whatever the browser still believes, and the sooner a new one is made the better.
    if (this.owed === null && socket) this.owed = setTimeout(() => this.giveUp(socket), this.o.answer ?? ANSWER);
    return true;
  }

  /** Say which of my pieces I am thinking about. Sent only when it changes, and not too often. */
  think(square: Square | null): void {
    this.thought = square;
    if (this.thoughtTimer === null) this.flushThought();
  }

  again(): boolean {
    return this.send({ t: 'again' });
  }

  /** Choose the room's clock, or none, between games. The server tells everyone, this screen included. */
  control(control: TimeControl | null): boolean {
    return this.send({ t: 'control', control });
  }

  /** Give the game up. The server tells everyone, this screen included. */
  resign(): boolean {
    return this.send({ t: 'resign' });
  }

  /** Offer a draw, or agree to the one the other player has offered. */
  draw(): boolean {
    return this.send({ t: 'draw' });
  }

  /** Say yes to the draw the other player has offered. If they have just taken it back, this is not an offer in its place. */
  agree(): boolean {
    return this.send({ t: 'agree' });
  }

  /** Say no to the draw that was offered, or take back the one offered from here. */
  noDraw(): boolean {
    return this.send({ t: 'nodraw' });
  }

  /** Claim the draw the position allows, as the player to move. The server checks it, and tells everyone. */
  claim(): boolean {
    return this.send({ t: 'claim' });
  }

  /** Try the server again now, rather than when the next attempt was due. A connection still trying is let go for a new one; one that is up is kept. */
  reconnect(): void {
    if (this.finished || this.socket?.readyState === 1) return;
    const stale = this.socket;
    if (stale) {
      // Still trying, perhaps for minutes on a dead network: let go, and whatever it says later is ignored.
      this.socket = null;
    this.stopWatching();
      try {
        stale.close();
      } catch {
        // It was past closing.
      }
    }
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  /**
   * The page has come back from the background, where a phone may have let the line die without a
   * word. One that is down is tried again at once; one that seems up is asked for the room, and if
   * nothing comes back soon it is taken for dead (as a move with no answer is), not left to the
   * long wait for silence.
   */
  wake(): void {
    if (this.finished) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return this.reconnect();
    if (this.owed !== null) return;
    if (this.sync()) this.owed = setTimeout(() => this.giveUp(socket), this.o.answer ?? ANSWER);
  }

  /** Say who this is, again: the name has changed, or a ranked game has just changed the rating. */
  hello(): boolean {
    if (!this.o.who) return false;
    const { id, name } = this.o.who();
    return this.send({ t: 'hello', id, ...(name ? { name } : {}) });
  }

  /** Ask for the room as it stands; the answer comes to the `state` handler. */
  sync(): boolean {
    return this.send({ t: 'sync' });
  }

  /** Leave for good. */
  close(): void {
    this.finished = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.thoughtTimer !== null) clearTimeout(this.thoughtTimer);
    this.retryTimer = this.thoughtTimer = null;
    this.stopWatching();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
  }

  // -- internals --------------------------------------------------------------

  private send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private flushThought = (): void => {
    this.thoughtTimer = null;
    if (this.thought === this.thoughtSent) return;
    if (this.send({ t: 'think', square: this.thought })) this.thoughtSent = this.thought;
    this.thoughtTimer = setTimeout(this.flushThought, THINK_EVERY);
  };

  private connect(): void {
    if (this.finished) return;
    this.o.handlers.link(this.attempts === 0 ? 'connecting' : 'lost');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.o.url);
    } catch {
      this.retryLater();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      const { room, keys } = this.o;
      const token = this.token ?? keys.own(room);
      const remembered = keys.remembered(room).filter((t) => t !== token);
      // From here on, a line that says nothing for too long is taken for dead.
      const quiet = this.o.quiet ?? QUIET;
      this.heard = Date.now();
      this.watch = setInterval(() => Date.now() - this.heard > quiet && this.giveUp(socket), Math.min(5000, quiet / 4));
      this.hello();
      this.send({
        t: 'join',
        room,
        ...(token ? { token } : {}),
        ...(remembered.length > 0 ? { remembered } : {}),
        ...(this.o.watch ? { watch: true } : {}),
      });
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.heard = Date.now();
      if (this.owed !== null) clearTimeout(this.owed);
      this.owed = null;
      if (typeof event.data === 'string') this.receive(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopWatching();
      if (this.finished) return;
      if (event.code === CLOSE_DISPLACED) {
        this.finished = true;
        this.o.handlers.link('displaced');
        return;
      }
      this.o.handlers.link('lost');
      this.retryLater();
    });
    // A failed connection also closes, and the close is what is acted on.
    socket.addEventListener('error', () => {});
  }

  private stopWatching(): void {
    if (this.watch !== null) clearInterval(this.watch);
    if (this.owed !== null) clearTimeout(this.owed);
    this.watch = this.owed = null;
  }

  /**
   * The line has gone silent without closing (a dead Wi-Fi path, a stalled proxy). The browser
   * can take minutes to notice; this does not wait for it. The old socket is let go, whatever it
   * says afterwards is ignored, and a new connection takes the same seat.
   */
  private giveUp(socket: WebSocket): void {
    if (this.socket !== socket || this.finished) return;
    this.socket = null;
    this.stopWatching();
    try {
      socket.close();
    } catch {
      // It was past closing.
    }
    this.o.handlers.link('lost');
    this.retryLater();
  }

  private retryLater(): void {
    const steps = this.o.retry ?? RETRY;
    const step = steps[Math.min(this.attempts, steps.length - 1)] ?? 1000;
    // Tried for as long as the page is open. When the server restarts every player's line drops at
    // once; a little chance in each wait keeps them all from knocking at the same instant.
    const delay = this.o.retry ? step : step * (0.75 + Math.random() * 0.5);
    this.attempts++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private receive(text: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    const h = this.o.handlers;
    switch (message?.t) {
      case 'joined':
        this.attempts = 0;
        if (message.token) {
          this.token = message.token;
          this.o.keys.keep(this.o.room, message.token);
        }
        // Whatever the other screens last heard of this hand, they hear it afresh.
        this.thoughtSent = null;
        h.link('open');
        h.joined(message.you, message.state);
        if (this.thought !== null && this.thoughtTimer === null) this.flushThought();
        return;
      case 'state':
        return h.state(message.state);
      case 'moved':
        return h.moved(message.ply, message.move, message.clock);
      case 'welcome':
        return h.welcome?.(message.you);
      case 'think':
        return h.think(message.side, message.square);
      case 'refused':
        return h.refused(message.reason, message.state);
      case 'seated':
        return h.seated(message.you, message.state);
    }
  }
}

/** How many rooms a browser remembers its seats in. */
const ROOMS_REMEMBERED = 12;

/** Keys kept in the browser: this window's own in its session, and the browser's in its local storage. */
export function browserKeys(): Keys {
  const OWN = storageKey('seat.');
  const ALL = storageKey('seats.v2');
  /**
   * Rooms and the keys held for each, oldest first. A list of pairs, not an object: an object
   * puts names made only of digits before all others whenever they were added, and "oldest
   * first" is what decides which rooms are forgotten.
   */
  const readAll = (): [string, string[]][] => {
    try {
      const data: unknown = JSON.parse(localStorage.getItem(ALL) ?? '[]');
      if (!Array.isArray(data)) return [];
      return data.filter((entry): entry is [string, string[]] => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1]) && entry[1].every((t) => typeof t === 'string'));
    } catch {
      return [];
    }
  };
  return {
    own(room) {
      try {
        return sessionStorage.getItem(OWN + room);
      } catch {
        return null;
      }
    },
    remembered(room) {
      return (readAll().find(([name]) => name === room)?.[1] ?? []).slice(-2);
    },
    keep(room, token) {
      try {
        sessionStorage.setItem(OWN + room, token);
      } catch {
        // Storage can be unavailable (private windows, blocked site data); the seat then lasts as long as the page.
      }
      try {
        const all = readAll();
        const held = (all.find(([name]) => name === room)?.[1] ?? []).filter((t) => t !== token);
        // The room goes to the end of the list as the most recent, and only the most recent are kept.
        const rest = all.filter(([name]) => name !== room);
        rest.push([room, [...held, token].slice(-2)]);
        localStorage.setItem(ALL, JSON.stringify(rest.slice(-ROOMS_REMEMBERED)));
      } catch {
        // As above.
      }
    },
  };
}
