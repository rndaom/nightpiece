/**
 * The player's connection to the server outside any room: to say who they
 * are, to wait for a ranked match, and to ask who the best players are.
 *
 * It is opened when first needed and comes back by itself if it drops, still
 * waiting for a match if it was (unless the server turned the player away).
 */
import type { Identity } from './identity';
import type { ClientMessage, PlayerCard, ServerMessage } from './protocol';

export interface HallHandlers {
  /** Whether the connection is up. */
  link(up: boolean): void;
  welcome(you: PlayerCard): void;
  queued(waiting: number): void;
  /** Not put in the queue, or taken out of it, and why. `until` is how many milliseconds from now the player may look again, if they must wait. */
  turned(reason: string, until?: number): void;
  matched(room: string): void;
  board(top: PlayerCard[], you: PlayerCard | null): void;
}

const RETRY = 2000;
/** The server says a word every fifteen seconds. A line that has said nothing for this long is dead, whatever the browser thinks. */
const QUIET = 40000;
/** A connection woken from a page that was in the background, and asked who it is, has this long to answer before it is taken for dead. */
const ANSWER = 6000;

export class Hall {
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  private queueing = false;
  private wantsBoard = false;
  /** Set while a word has been asked of the server to show the line is alive (see `wake`). */
  private owed: ReturnType<typeof setTimeout> | null = null;
  /** When the server was last heard from, and the timer that watches for its silence. */
  private heard = 0;
  private watch: ReturnType<typeof setInterval> | null = null;

  constructor(
    private url: string,
    private who: () => Identity,
    private h: HallHandlers,
    /** How long the line may be silent before it is taken for dead, in milliseconds. */
    private quiet = QUIET,
  ) {
    this.connect();
  }

  /** Wait for an opponent. */
  queue(): void {
    this.queueing = true;
    this.send({ t: 'queue' });
  }

  unqueue(): void {
    this.queueing = false;
    this.send({ t: 'unqueue' });
  }

  /** Ask for the best players; the answer comes to the `board` handler. */
  board(): void {
    this.wantsBoard = !this.send({ t: 'board' });
  }

  /** Say again who this is: the name has changed, or the rating may have. */
  hello(): void {
    const { id, name } = this.who();
    this.send({ t: 'hello', id, ...(name ? { name } : {}) });
  }

  /** Whether the connection is up just now. */
  get up(): boolean {
    return this.socket?.readyState === 1;
  }

  /** Try the server again now, rather than when the next attempt was due. A connection still trying is let go for a new one; one that is up is kept. */
  reconnect(): void {
    if (this.finished || this.socket?.readyState === 1) return;
    const stale = this.socket;
    if (stale) {
      // Still trying, perhaps for minutes on a dead network: let go, and whatever it says later is ignored.
      this.socket = null;
      try {
        stale.close();
      } catch {
        // It was past closing.
      }
    }
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.stopWatching();
    this.connect();
  }

  /**
   * The page has come back from the background, where a phone may have let the line die without
   * a word. One that is down is tried again at once; one that seems up is asked who this is, and
   * if no answer comes soon it is taken for dead and made again.
   */
  wake(): void {
    if (this.finished) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return this.reconnect();
    if (this.owed !== null) return;
    this.hello();
    this.owed = setTimeout(() => this.giveUp(socket), ANSWER);
  }

  close(): void {
    this.finished = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.stopWatching();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
  }

  private send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /** The line has gone dead without saying so: let it go and make another. */
  private giveUp(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.stopWatching();
    this.socket = null;
    try {
      socket.close();
    } catch {
      // It was past closing.
    }
    this.h.link(false);
    this.connect();
  }

  private stopWatching(): void {
    if (this.watch !== null) clearInterval(this.watch);
    if (this.owed !== null) clearTimeout(this.owed);
    this.watch = this.owed = null;
  }

  private connect(): void {
    if (this.finished) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.later();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      // From here on, a line that says nothing for too long is taken for dead: a player waiting for a
      // match on one would wait for ever, the server having long since dropped them from the queue.
      this.heard = Date.now();
      this.watch = setInterval(() => Date.now() - this.heard > this.quiet && this.giveUp(socket), Math.min(5000, this.quiet / 4));
      this.h.link(true);
      this.hello();
      if (this.queueing) this.send({ t: 'queue' });
      if (this.wantsBoard) this.board();
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      this.heard = Date.now();
      if (this.owed !== null) clearTimeout(this.owed);
      this.owed = null;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      switch (message?.t) {
        case 'welcome':
          return this.h.welcome(message.you);
        case 'queued':
          return this.h.queued(message.waiting);
        case 'turned':
          // Turned away: not asked for again when the connection comes back.
          this.queueing = false;
          return this.h.turned(typeof message.reason === 'string' ? message.reason : 'The server would not find a match just now.', typeof message.until === 'number' ? message.until : undefined);
        case 'matched':
          this.queueing = false;
          return this.h.matched(message.room);
        case 'board':
          return this.h.board(message.top, message.you);
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.stopWatching();
      this.socket = null;
      if (this.finished) return;
      this.h.link(false);
      this.later();
    });
    socket.addEventListener('error', () => {});
  }

  private later(): void {
    if (this.retry !== null || this.finished) return;
    // A little chance in the wait, so that a server just restarted is not knocked at by everyone at the same instant.
    this.retry = setTimeout(
      () => {
        this.retry = null;
        this.connect();
      },
      RETRY * (0.75 + Math.random() * 0.5),
    );
  }
}
