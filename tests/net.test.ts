/**
 * The game's side of the connection, against the real server: joining,
 * moving, the hand that follows a player's thought, and coming back after
 * the connection drops.
 */
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Running, startServer } from '../server/main.ts';
import type { Side, Square } from '../src/core/game.ts';
import { browserKeys, type Keys, type Link, Net, type NetOptions } from '../src/net/client.ts';
import { type MoveData, newRoomName, type RoomState, type Seat } from '../src/net/protocol.ts';

/** Everything one player's connection has been told, with a way to wait for the next thing of a kind. */
class Player {
  links: Link[] = [];
  seat: Seat | null = null;
  state: RoomState | null = null;
  moves: { ply: number; move: MoveData }[] = [];
  thoughts: { side: Side; square: Square | null }[] = [];
  refusals: string[] = [];
  joins = 0;
  private waiting: { test: () => boolean; resolve: () => void }[] = [];
  readonly net: Net;

  constructor(port: number, room: string, keys: Keys, watch = false, patience: Pick<NetOptions, 'quiet' | 'answer'> = {}) {
    const told = () => {
      this.waiting = this.waiting.filter((w) => {
        if (!w.test()) return true;
        w.resolve();
        return false;
      });
    };
    this.net = new Net({
      url: `ws://127.0.0.1:${port}/ws`,
      room,
      keys,
      watch,
      retry: [30],
      ...patience,
      handlers: {
        link: (link) => (this.links.push(link), told()),
        joined: (you, state) => ((this.seat = you), (this.state = state), this.joins++, told()),
        state: (state) => ((this.state = state), told()),
        moved: (ply, move) => (this.moves.push({ ply, move }), told()),
        think: (side, square) => (this.thoughts.push({ side, square }), told()),
        refused: (reason, state) => (this.refusals.push(reason), (this.state = state), told()),
        seated: (you, state) => ((this.seat = you), (this.state = state), told()),
      },
    });
  }

  /** Resolves once `test` holds. */
  until(test: () => boolean): Promise<void> {
    if (test()) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push({ test, resolve }));
  }

  /** Cut the connection from this end without the client meaning to leave, as a network failure would. */
  drop(): void {
    (this.net as unknown as { socket: WebSocket | null }).socket?.close();
  }
}

/** Keys held in memory. Windows of one browser share `browser`; each has its own session. */
function keysFor(browser: Map<string, string[]> = new Map()): Keys & { session: Map<string, string> } {
  const session = new Map<string, string>();
  return {
    session,
    own: (room) => session.get(room) ?? null,
    remembered: (room) => browser.get(room) ?? [],
    keep: (room, token) => {
      session.set(room, token);
      browser.set(room, [...(browser.get(room) ?? []).filter((t) => t !== token), token].slice(-2));
    },
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Something between a player and the server that can stop carrying anything, in either
 * direction, without closing: what a dead Wi-Fi path or a stalled proxy looks like from both
 * ends. Connections made after it has gone silent work normally.
 */
async function relay(target: number): Promise<{ port: number; silence(): void; close(): Promise<void> }> {
  const pairs: { silent: boolean; a: net.Socket; b: net.Socket }[] = [];
  const server = net.createServer((a) => {
    const b = net.connect(target, '127.0.0.1');
    const pair = { silent: false, a, b };
    pairs.push(pair);
    a.on('data', (d) => void (pair.silent || b.write(d)));
    b.on('data', (d) => void (pair.silent || a.write(d)));
    for (const s of [a, b]) s.on('error', () => {});
    a.on('close', () => b.destroy());
    b.on('close', () => a.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    silence: () => pairs.forEach((p) => (p.silent = true)),
    close: () =>
      new Promise((resolve) => {
        for (const p of pairs) p.a.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('a connection to the server', () => {
  let running: Running;
  const players: Player[] = [];
  const join = (room: string, keys: Keys = keysFor(), watch = false) => {
    const p = new Player(running.port, room, keys, watch);
    players.push(p);
    return p;
  };

  beforeAll(async () => {
    running = await startServer({ port: 0, root: 'no-such-folder' });
  });
  afterEach(() => {
    for (const p of players.splice(0)) p.net.close();
  });
  afterAll(() => running.close());

  it('joins a room and is given a seat', async () => {
    const room = newRoomName();
    const a = join(room);
    await a.until(() => a.seat !== null);
    expect(a.seat).toBe('w');
    expect(a.links).toEqual(['connecting', 'open']);
    const b = join(room);
    await b.until(() => b.seat !== null);
    expect(b.seat).toBe('b');
    await a.until(() => a.state?.taken.b === true);
    const c = join(room, keysFor(), true);
    await c.until(() => c.seat !== null);
    expect(c.seat).toBe('spectator');
  });

  it('carries moves both ways, and a refusal back to the one who asked', async () => {
    const room = newRoomName();
    const a = join(room);
    const b = join(room);
    await Promise.all([a.until(() => a.state?.taken.b === true), b.until(() => b.seat !== null)]);
    expect(a.net.move(0, { from: 'e2', to: 'e4' })).toBe(true);
    await Promise.all([a.until(() => a.moves.length === 1), b.until(() => b.moves.length === 1)]);
    b.net.move(1, { from: 'e7', to: 'e5' });
    await a.until(() => a.moves.length === 2);
    expect(a.moves[1]).toEqual({ ply: 1, move: { from: 'e7', to: 'e5' } });
    b.net.move(2, { from: 'd7', to: 'd5' });
    await b.until(() => b.refusals.length === 1);
    expect(b.refusals[0]).toBe('It is not your turn.');
    expect(b.state!.moves).toHaveLength(2);
  });

  it('passes on a hand following a thought, but not every twitch of it', async () => {
    const room = newRoomName();
    const a = join(room);
    const b = join(room);
    await Promise.all([a.until(() => a.state?.taken.b === true), b.until(() => b.seat !== null)]);
    for (const square of ['e2', 'd2', 'c2', 'g1'] as const) a.net.think(square);
    a.net.think('g1');
    await b.until(() => b.thoughts.some((t) => t.square === 'g1'));
    // The first is sent at once and the last when the pause is over; the ones between are skipped.
    expect(b.thoughts).toEqual([
      { side: 'w', square: 'e2' },
      { side: 'w', square: 'g1' },
    ]);
    a.net.think(null);
    await b.until(() => b.thoughts.at(-1)?.square === null);
    expect(a.thoughts).toEqual([]);
  });

  it('comes back after the connection drops, to the same seat and the same game', async () => {
    const room = newRoomName();
    const a = join(room);
    const b = join(room);
    await Promise.all([a.until(() => a.state?.taken.b === true), b.until(() => b.seat !== null)]);
    a.net.move(0, { from: 'd2', to: 'd4' });
    await b.until(() => b.moves.length === 1);

    b.drop();
    await b.until(() => b.links.at(-1) === 'lost');
    // Nothing can be sent while it is down.
    expect(b.net.move(1, { from: 'd7', to: 'd5' })).toBe(false);
    await a.until(() => a.state?.present.b === false);
    await b.until(() => b.joins === 2);
    expect(b.seat).toBe('b');
    expect(b.links.at(-1)).toBe('open');
    expect(b.state!.moves).toEqual([{ from: 'd2', to: 'd4' }]);
    await a.until(() => a.state?.present.b === true);
    expect(b.net.move(1, { from: 'd7', to: 'd5' })).toBe(true);
    await a.until(() => a.moves.length === 2);
  });

  it('keeps trying while the server cannot be reached', async () => {
    // Nothing listens here: the port was open a moment ago and has been closed.
    const gone = await startServer({ port: 0, root: 'no-such-folder' });
    const port = gone.port;
    await gone.close();
    const p = new Player(port, newRoomName(), keysFor());
    players.push(p);
    await p.until(() => p.links.filter((l) => l === 'lost').length >= 3);
    expect(p.seat).toBeNull();
    // And joins as soon as there is a server.
    const back = await startServer({ port, root: 'no-such-folder' });
    try {
      await p.until(() => p.seat !== null);
      expect(p.links.at(-1)).toBe('open');
    } finally {
      p.net.close();
      await back.close();
    }
  });

  it('gives up its seat to a newer window with the same key, and does not fight for it', async () => {
    const room = newRoomName();
    const keys = keysFor();
    const first = join(room, keys);
    await first.until(() => first.seat !== null);
    // The same window's storage, as when a tab is duplicated.
    const second = join(room, keys);
    await second.until(() => second.seat !== null);
    expect(second.seat).toBe('w');
    await first.until(() => first.links.at(-1) === 'displaced');
    await pause(150);
    expect(first.links.at(-1)).toBe('displaced');
    expect(first.joins).toBe(1);
    expect(second.links.at(-1)).toBe('open');
  });

  it('does not take the seat of another window of the same browser, but takes it back once that window is gone', async () => {
    const room = newRoomName();
    const browser = new Map<string, string[]>();
    const first = join(room, keysFor(browser));
    await first.until(() => first.seat !== null);
    const second = join(room, keysFor(browser));
    await second.until(() => second.seat !== null);
    // The second window is the other player, not a thief of the first one's seat.
    expect(second.seat).toBe('b');
    expect(first.links.at(-1)).toBe('open');

    first.net.close();
    await second.until(() => second.state?.present.w === false);
    const reopened = join(room, keysFor(browser));
    await reopened.until(() => reopened.seat !== null);
    expect(reopened.seat).toBe('w');
  });

  it('keeps its seat through a dropped connection even when the browser will store nothing', async () => {
    const room = newRoomName();
    // A browser with site data blocked: nothing kept is ever read back.
    const forgetful: Keys = { own: () => null, remembered: () => [], keep: () => {} };
    const a = join(room, forgetful);
    const b = join(room);
    await Promise.all([a.until(() => a.state?.taken.b === true), b.until(() => b.seat !== null)]);
    a.net.move(0, { from: 'e2', to: 'e4' });
    await b.until(() => b.moves.length === 1);
    a.drop();
    await a.until(() => a.joins === 2);
    expect(a.seat).toBe('w');
    expect(a.state!.moves).toHaveLength(1);
  });

  it('notices when a move gets no answer, and makes a new connection', async () => {
    const path = await relay(running.port);
    try {
      const room = newRoomName();
      const a = new Player(path.port, room, keysFor(), false, { answer: 1000 });
      players.push(a);
      // Seated before the other player arrives, so that there is no doubt who is Ivory.
      await a.until(() => a.seat !== null);
      const b = join(room);
      await Promise.all([a.until(() => a.state?.taken.b === true), b.until(() => b.seat !== null)]);
      // The line goes dead without closing, and Ivory moves.
      path.silence();
      expect(a.net.move(0, { from: 'e2', to: 'e4' })).toBe(true);
      await a.until(() => a.links.includes('lost'));
      await a.until(() => a.joins === 2);
      expect(a.seat).toBe('w');
      // The server never heard the move: the game is as it was, for whoever sent it to send again.
      expect(a.state!.moves).toHaveLength(0);
      expect(b.moves).toHaveLength(0);
      a.net.move(0, { from: 'e2', to: 'e4' });
      await b.until(() => b.moves.length === 1);
    } finally {
      await path.close();
    }
  });

  it('notices when the line simply goes quiet, and is not fooled while the server keeps in touch', async () => {
    // A server that says a word every 100 ms, so that a quiet of 800 ms means the line is dead (room enough that a busy machine, which holds up the words and the watch alike, is not taken for a dead line).
    const chatty = await startServer({ port: 0, root: 'no-such-folder', tick: 100 });
    const path = await relay(chatty.port);
    try {
      const a = new Player(path.port, newRoomName(), keysFor(), false, { quiet: 800 });
      players.push(a);
      await a.until(() => a.seat !== null);
      await pause(2000);
      expect(a.joins).toBe(1);
      expect(a.links.at(-1)).toBe('open');
      path.silence();
      await a.until(() => a.joins === 2);
      expect(a.links).toContain('lost');
      expect(a.seat).toBe('w');
    } finally {
      for (const p of players.splice(0)) p.net.close();
      await path.close();
      await chatty.close();
    }
  }, 30000);

  it('stays gone once it has left', async () => {
    const room = newRoomName();
    const a = join(room);
    const b = join(room);
    await Promise.all([a.until(() => a.state?.taken.b === true), b.until(() => b.seat !== null)]);
    b.net.close();
    await a.until(() => a.state?.present.b === false);
    await pause(150);
    expect(b.joins).toBe(1);
    expect(a.state!.present.b).toBe(false);
  });
});

describe('the keys a browser keeps', () => {
  const storage = () => {
    const kept = new Map<string, string>();
    return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  };
  afterEach(() => vi.unstubAllGlobals());

  it('remembers a seat for the window and for the browser', () => {
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('sessionStorage', storage());
    const keys = browserKeys();
    expect(keys.own('ABCDEF')).toBeNull();
    keys.keep('ABCDEF', 'a'.repeat(32));
    expect(keys.own('ABCDEF')).toBe('a'.repeat(32));
    expect(keys.remembered('ABCDEF')).toEqual(['a'.repeat(32)]);
    // Another window of the same browser has its own session and shares what the browser remembers.
    vi.stubGlobal('sessionStorage', storage());
    const other = browserKeys();
    expect(other.own('ABCDEF')).toBeNull();
    other.keep('ABCDEF', 'b'.repeat(32));
    expect(other.remembered('ABCDEF')).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
  });

  it('forgets the oldest rooms first, whatever they are called', () => {
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('sessionStorage', storage());
    const keys = browserKeys();
    const key = (n: number) => n.toString(16).padStart(32, '0');
    for (let i = 0; i < 12; i++) keys.keep(`ROOM${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`, key(i));
    // A name that is all digits: a plain object would file it before every other name, as the oldest.
    keys.keep('234567', key(99));
    expect(keys.remembered('234567')).toEqual([key(99)]);
    expect(keys.remembered('ROOMAA')).toEqual([]);
    expect(keys.remembered('ROOMLL')).toEqual([key(11)]);
  });

  it('does without storage that cannot be had', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    vi.stubGlobal('localStorage', blocked);
    vi.stubGlobal('sessionStorage', blocked);
    const keys = browserKeys();
    expect(() => keys.keep('ABCDEF', 'a'.repeat(32))).not.toThrow();
    expect(keys.own('ABCDEF')).toBeNull();
    expect(keys.remembered('ABCDEF')).toEqual([]);
  });
});
