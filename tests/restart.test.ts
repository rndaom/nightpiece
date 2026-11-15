/**
 * Games that outlive the server: a new version put up (the host asks the server to stop) or a
 * crash (it is killed without a word), with the players' own connections coming back by
 * themselves to the server that starts next on the same data folder, and finding the game, the
 * clocks, the seats and a draw offered all as they were. And what the store of rooms does with
 * clocks, absences, ratings and its own files across a restart.
 *
 * The server is run here as it is run for real, as a process of its own, so that it can be killed.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../server/main.ts';
import { ABANDON_AFTER, CLOCK_INCREMENT, CLOCK_START, type Connection, Lobby, RESTART_GRACE, type SavedRooms } from '../server/rooms.ts';
import { playerKey, Scores } from '../server/scores.ts';
import { RoomStore } from '../server/store.ts';
import type { PromotionKind, Side, Square } from '../src/core/game.ts';
import { type Keys, type Link, Net } from '../src/net/client.ts';
import { Hall } from '../src/net/hall.ts';
import { type Clock, type MoveData, newRoomName, type RoomState, type Seat, type ServerMessage } from '../src/net/protocol.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = (n: number) => n.toString(16).padStart(32, '0');
const mv = (text: string): MoveData => ({ from: text.slice(0, 2) as Square, to: text.slice(2, 4) as Square, ...(text[4] ? { promotion: text[4] as PromotionKind } : {}) });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A port nobody was using a moment ago. Another program may take it before the server does; `serve` then tries another. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

type Served = { child: ChildProcess; said: string[]; port: number };
const running = new Set<ChildProcess>();

/** Start the server once on a data folder of its own: with node and tsx (as the start command runs it), or through `npm run serve`. */
function startOnce(dir: string, port: number, how: 'node' | 'npm'): Promise<Served> {
  const [command, args] = how === 'npm' ? ['npm', ['run', 'serve']] : [process.execPath, ['--import', 'tsx', 'server/main.ts']];
  const child = spawn(command as string, args as string[], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, BEHIND_PROXY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  const said: string[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The server did not start: ${said.join(' ')}`)), 30000);
    const hear = (data: Buffer) => {
      said.push(String(data));
      if (said.join('').includes('is being served')) {
        clearTimeout(timer);
        resolve({ child, said, port });
      }
    };
    child.stdout!.on('data', hear);
    child.stderr!.on('data', hear);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The server stopped as it started (${code}): ${said.join(' ')}`));
    });
  });
}

/**
 * Start the server, on the port given (the one the last server had, which is free again a moment
 * after it stops) or on a free one. A port taken in the meantime is tried again, or another chosen.
 */
async function serve(dir: string, port?: number, how: 'node' | 'npm' = 'node'): Promise<Served> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await startOnce(dir, port ?? (await freePort()), how);
    } catch (error) {
      if (attempt >= 9 || !String(error).includes('EADDRINUSE')) throw error;
      await pause(300);
    }
  }
}

/** Stop the server: asked to (as the host asks), or killed without a word (as a crash is). */
function stop(child: ChildProcess, how: 'SIGTERM' | 'SIGKILL'): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    child.once('exit', (code) => resolve(code));
    child.kill(how);
  });
}

afterAll(async () => {
  for (const child of running) await stop(child, 'SIGKILL');
});

type Of<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

/** A bare connection, from an address of its own (the server is told it stands behind a proxy). */
function connect(port: number, from: string): Promise<{ send(m: object): void; next<T extends ServerMessage['t']>(t: T): Promise<Of<T>>; close(): void }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-real-ip': from } });
  const heard: ServerMessage[] = [];
  return new Promise((resolve, reject) => {
    socket.on('message', (data) => heard.push(JSON.parse(String(data)) as ServerMessage));
    socket.once('error', reject);
    socket.once('open', () =>
      resolve({
        send: (m) => socket.send(JSON.stringify(m)),
        next: async <T extends ServerMessage['t']>(t: T) => {
          for (let waited = 0; waited < 5000; waited += 20) {
            const i = heard.findIndex((m) => m.t === t);
            if (i >= 0) return heard.splice(i, 1)[0] as Of<T>;
            await pause(20);
          }
          throw new Error(`No ${t} came`);
        },
        close: () => socket.close(),
      }),
    );
  });
}

/** Wait until `test` holds, for some seconds at most. */
async function until(test: () => boolean, what: string, limit = 15000): Promise<void> {
  for (let waited = 0; waited < limit; waited += 20) {
    if (test()) return;
    await pause(20);
  }
  throw new Error(`Waited in vain for ${what}`);
}

/** Keys to seats as a browser keeps them, kept here in memory. */
function memoryKeys(): Keys {
  const own = new Map<string, string>();
  return {
    own: (room) => own.get(room) ?? null,
    remembered: (room) => (own.has(room) ? [own.get(room)!] : []),
    keep: (room, token) => void own.set(room, token),
  };
}

/** A player's own connection to a room, as the game makes it, and everything it has been told. */
class Player {
  links: Link[] = [];
  seat: Seat | null = null;
  state: RoomState | null = null;
  clock: Clock | null = null;
  joins: { you: Seat; state: RoomState; at: number }[] = [];
  moves: MoveData[] = [];
  refusals: string[] = [];
  readonly net: Net;

  constructor(port: number, room: string, n: number | null) {
    this.net = new Net({
      url: `ws://127.0.0.1:${port}/ws`,
      room,
      keys: memoryKeys(),
      ...(n !== null ? { who: () => ({ id: id(n), name: `Player ${n}` }) } : {}),
      // Tried again every fifth of a second, for as long as it takes: the server is away a few seconds.
      retry: [200],
      handlers: {
        link: (link) => void this.links.push(link),
        joined: (you, state) => {
          this.seat = you;
          this.state = state;
          this.clock = state.clock;
          this.joins.push({ you, state, at: performance.now() });
        },
        state: (state) => {
          this.state = state;
          this.clock = state.clock;
        },
        moved: (_ply, move, clock) => {
          this.moves.push(move);
          if (clock) this.clock = clock;
          if (this.state) this.state = { ...this.state, moves: [...this.state.moves, move] };
        },
        think: () => {},
        refused: (reason, state) => {
          this.refusals.push(reason);
          this.state = state;
        },
        seated: (you, state) => {
          this.seat = you;
          this.state = state;
        },
      },
    });
  }

  async until(test: () => boolean, what: string, limit = 15000): Promise<void> {
    for (let waited = 0; waited < limit; waited += 20) {
      if (test()) return;
      await pause(20);
    }
    throw new Error(`Waited in vain for ${what}`);
  }
}

/** Two players matched by the queue (from addresses of their own), each then at the board through the game's own connection. */
async function rankedGame(port: number): Promise<{ room: string; white: Player; black: Player; ids: Record<Side, number> }> {
  const a = await connect(port, '198.51.100.1');
  const b = await connect(port, '198.51.100.2');
  a.send({ t: 'hello', id: id(1), name: 'Player 1' });
  b.send({ t: 'hello', id: id(2), name: 'Player 2' });
  await a.next('welcome');
  await b.next('welcome');
  a.send({ t: 'queue' });
  await a.next('queued');
  b.send({ t: 'queue' });
  const room = (await b.next('matched')).room;
  a.close();
  b.close();
  const one = new Player(port, room, 1);
  const two = new Player(port, room, 2);
  await one.until(() => one.seat !== null, 'the first seat');
  await two.until(() => two.seat !== null, 'the second seat');
  const [white, black] = one.seat === 'w' ? [one, two] : [two, one];
  return { room, white, black, ids: { w: white === one ? 1 : 2, b: white === one ? 2 : 1 } };
}

/** Play a move and wait until both screens have it. */
async function play(by: Player, other: Player, text: string): Promise<void> {
  const ply = by.state!.moves.length;
  expect(by.net.move(ply, mv(text))).toBe(true);
  await other.until(() => (other.state?.moves.length ?? 0) > ply, `${text} to arrive`);
  await by.until(() => (by.state?.moves.length ?? 0) > ply, `${text} to be confirmed`);
}

const dirs: string[] = [];
const players: Player[] = [];
afterEach(() => {
  for (const p of players.splice(0)) p.net.close();
});
afterAll(() => {
  for (const dir of dirs) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Gone already.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
const folder = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightpiece-restart-'));
  dirs.push(dir);
  return dir;
};

describe.each([
  ['a new version put up (the server is asked to stop)', 'SIGTERM'],
  ['a crash (the server is killed without a word)', 'SIGKILL'],
] as const)('a game survives %s', (_name, how) => {
  it(
    'both seats come back by themselves to the position, the turn, the clocks, the offer and the ranking; and the game is finished and rated',
    async () => {
      const dir = folder();
      const first = await serve(dir);
      const port = first.port;

      // A ranked game four moves in, Ivory having offered a draw on its own move, its clock running.
      const { white, black, ids } = await rankedGame(port);
      players.push(white, black);
      await play(white, black, 'e2e4');
      await play(black, white, 'e7e5');
      await play(white, black, 'g1f3');
      // Ivory's clock begins to run somewhere between these two moments, as the server sees it.
      const voidMoves = Date.now();
      await play(black, white, 'b8c6');
      expect(white.net.draw()).toBe(true);
      await black.until(() => black.state?.drawOffer === 'w', 'the offer');
      const before = { ...white.clock!.left };
      // What Ivory was last told of its clock was charged up to a moment before this one (a clock is told as it stands, not as it stood when it began to run).
      const told = Date.now();
      expect(white.clock!.running).toBe('w');
      await pause(1200);

      // A friendly game beside it, one move in.
      const friendly = newRoomName();
      const fa = new Player(port, friendly, null);
      players.push(fa);
      await fa.until(() => fa.seat === 'w', 'the friendly seat');
      const fb = new Player(port, friendly, null);
      players.push(fb);
      await fb.until(() => fb.seat === 'b', 'the second friendly seat');
      await play(fa, fb, 'd2d4');

      // The server stops somewhere between these two moments.
      const stopping = Date.now();
      const code = await stop(first.child, how);
      if (how === 'SIGTERM') {
        expect(code).toBe(0);
        expect(first.said.join('')).toContain('2 games written down');
      }
      await white.until(() => white.links.at(-1) === 'lost', 'the line to drop');
      const stopped = Date.now();
      const joinsBefore = { white: white.joins.length, black: black.joins.length, fa: fa.joins.length, fb: fb.joins.length };

      // A moment later the next server starts on the same folder and port, and both screens come back by themselves.
      await pause(500);
      const second = await serve(dir, port);
      expect(second.said.join('')).toContain('2 games taken up again');
      await white.until(() => white.joins.length > joinsBefore.white, 'Ivory to be back');
      await black.until(() => black.joins.length > joinsBefore.black, 'Void to be back');
      const backs = { w: white.joins.at(-1)!, b: black.joins.at(-1)! };
      expect(backs.w.you).toBe('w');
      expect(backs.b.you).toBe('b');
      for (const back of Object.values(backs)) {
        expect(back.state).toMatchObject({ ranked: true, drawOffer: 'w', ended: null, moves: [mv('e2e4'), mv('e7e5'), mv('g1f3'), mv('b8c6')] });
        expect(back.state.players).toEqual({ w: { name: `Player ${ids.w}`, rating: 1200 }, b: { name: `Player ${ids.b}`, rating: 1200 } });
      }
      // The first back finds the clocks as they stood: Ivory's running again only if Ivory is the
      // one back (it is Ivory's move). Void's is as it was. Ivory has been charged for the time it
      // thought, up to the stop (asked to stop) or the last word the server wrote that it was still
      // running (a crash: every two seconds, so anything from nothing up), and never for the time
      // the server was down. The bounds are the moments measured here around the server's own.
      const firstBack = backs.w.at < backs.b.at ? backs.w : backs.b;
      const clock = firstBack.state.clock!;
      expect(clock.running).toBe(firstBack === backs.w ? 'w' : null);
      expect(clock.left.b).toBe(before.b);
      const charged = before.w - clock.left.w;
      expect(charged).toBeGreaterThanOrEqual(how === 'SIGTERM' ? stopping - told : 0);
      expect(charged).toBeLessThanOrEqual(stopped - voidMoves + 5);

      // Ivory being back, Ivory's clock runs again from where it stood.
      await white.until(() => white.state?.clock?.running === 'w', 'the clock to run again');

      // The friendly game: both seats by their own keys, the move as it was played.
      await fa.until(() => fa.joins.length > joinsBefore.fa, 'the friendly seat back');
      await fb.until(() => fb.joins.length > joinsBefore.fb, 'the other friendly seat back');
      expect(fa.joins.at(-1)).toMatchObject({ you: 'w', state: { ranked: false, moves: [mv('d2d4')] } });
      expect(fb.joins.at(-1)!.you).toBe('b');
      await play(fb, fa, 'd7d5');

      // The ranked game goes on and is finished: Void takes no offer and plays on, then gives up.
      expect(black.net.noDraw()).toBe(true);
      await white.until(() => white.state?.drawOffer === null, 'the offer turned down');
      await play(white, black, 'f1b5');
      expect(white.clock!.left.w).toBeLessThanOrEqual(clock.left.w + CLOCK_INCREMENT);
      expect(black.net.resign()).toBe(true);
      await white.until(() => white.state?.change !== null && white.state?.change !== undefined, 'the game to be rated');
      expect(white.state).toMatchObject({ resigned: 'b', change: { w: 16, b: -16 } });
      // Written to the scores within a couple of seconds (and put right from the room, had the server stopped first).
      const rating = (n: number) => {
        try {
          return (JSON.parse(readFileSync(path.join(dir, 'scores.json'), 'utf8')) as Record<string, { rating: number }>)[playerKey(id(n))]?.rating;
        } catch {
          return undefined;
        }
      };
      await until(() => rating(ids.w) === 1216, 'the scores to be written', 6000);
      expect(rating(ids.b)).toBe(1184);
      // Nothing was ever refused, and neither screen had to begin again.
      expect([...white.refusals, ...black.refusals, ...fa.refusals, ...fb.refusals]).toEqual([]);

      await stop(second.child, 'SIGTERM');
    },
    90000,
  );
});

describe('stopping as the host stops it', () => {
  it('`npm run serve`, sent SIGTERM, passes it on: the server writes everything down and stops cleanly', async () => {
    const dir = folder();
    const served = await serve(dir, undefined, 'npm');
    const room = newRoomName();
    const a = await connect(served.port, '198.51.100.7');
    const b = await connect(served.port, '198.51.100.8');
    a.send({ t: 'join', room });
    await a.next('joined');
    b.send({ t: 'join', room });
    await b.next('joined');
    a.send({ t: 'move', ply: 0, move: mv('c2c4') });
    await b.next('moved');
    await stop(served.child, 'SIGTERM');
    await until(() => served.said.join('').includes('One game written down'), 'the stop to be written', 5000);
    const saved = JSON.parse(readFileSync(path.join(dir, 'rooms.json'), 'utf8')) as SavedRooms;
    expect(saved.rooms.find((r) => r.name === room)?.moves).toEqual([mv('c2c4')]);
  }, 60000);
});

describe('the queue across a restart', () => {
  it('a player waiting for a match is waiting again once the server is back, without asking', async () => {
    const dir = folder();
    const first = await serve(dir);
    const port = first.port;
    const told: string[] = [];
    const hall = new Hall(`ws://127.0.0.1:${port}/ws`, () => ({ id: id(9), name: 'Waiting' }), {
      link: (up) => void told.push(up ? 'up' : 'down'),
      welcome: () => {},
      queued: () => void told.push('queued'),
      turned: (reason) => void told.push(`turned: ${reason}`),
      matched: () => void told.push('matched'),
      board: () => {},
    });
    try {
      hall.queue();
      await until(() => told.includes('queued'), 'the queue');
      await stop(first.child, 'SIGKILL');
      await until(() => told.at(-1) === 'down', 'the line to drop');
      const second = await serve(dir, port);
      await until(() => told.filter((x) => x === 'queued').length === 2, 'the queue again');
      expect(told.some((x) => x.startsWith('turned'))).toBe(false);
      await stop(second.child, 'SIGTERM');
    } finally {
      hall.close();
    }
  }, 60000);
});

describe('the running server and its files', () => {
  it('says nothing to anyone about a change until it is written down', async () => {
    const dir = folder();
    const server = await startServer({ port: 0, root: 'no-such-folder', roomsFile: path.join(dir, 'rooms.json') });
    const sent = vi.spyOn(WebSocket.prototype, 'send');
    const movedSent = () => sent.mock.calls.filter(([data]) => String(data).includes('"t":"moved"')).length;
    const seen: number[] = [];
    const write = RoomStore.prototype.write;
    const writes = vi.spyOn(RoomStore.prototype, 'write').mockImplementation(function (this: RoomStore, ...args) {
      if (args[0].some((c) => 'step' in c || ('put' in c && c.put.moves.length > 0))) seen.push(movedSent());
      return write.apply(this, args);
    });
    try {
      const room = newRoomName();
      const a = await connect(server.port, '198.51.100.1');
      const b = await connect(server.port, '198.51.100.2');
      a.send({ t: 'join', room });
      await a.next('joined');
      b.send({ t: 'join', room });
      await b.next('joined');
      a.send({ t: 'move', ply: 0, move: mv('e2e4') });
      await b.next('moved');
      // Written once, with the move, before a word of it was sent to either player.
      expect(seen).toEqual([0]);
      expect(movedSent()).toBe(2);
    } finally {
      writes.mockRestore();
      sent.mockRestore();
      await server.close();
    }
  });

  it('a journal that could not be begun at the start is begun once it can be, and the changes after are written', async () => {
    const dir = folder();
    const roomsFile = path.join(dir, 'rooms.json');
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    chmodSync(dir, 0o500);
    const server = await startServer({ port: 0, root: 'no-such-folder', roomsFile });
    try {
      expect(said.mock.calls.some(([line]) => /^The rooms could not be written/.test(String(line)))).toBe(true);
      chmodSync(dir, 0o700);
      // The server tries again every two seconds: the checkpoint that begins the journal is what is waited for.
      await until(() => existsSync(roomsFile), 'the journal to be begun');
      const room = newRoomName();
      const a = await connect(server.port, '198.51.100.1');
      const b = await connect(server.port, '198.51.100.2');
      a.send({ t: 'join', room });
      await a.next('joined');
      b.send({ t: 'join', room });
      await b.next('joined');
      a.send({ t: 'move', ply: 0, move: mv('d2d4') });
      await b.next('moved');
      expect(new RoomStore(roomsFile).load()!.rooms.find((r) => r.name === room)?.moves).toEqual([mv('d2d4')]);
    } finally {
      chmodSync(dir, 0o700);
      said.mockRestore();
      await server.close();
    }
  }, 30000);

  it('a name changed over and over is written with the scores a couple of seconds later, not with every message', async () => {
    const dir = folder();
    const scoresFile = path.join(dir, 'scores.json');
    const key = playerKey(id(5));
    writeFileSync(scoresFile, JSON.stringify({ [key]: { name: 'Old', rating: 1250, wins: 3, losses: 1, draws: 0, seen: 1 } }));
    const server = await startServer({ port: 0, root: 'no-such-folder', scoresFile, roomsFile: path.join(dir, 'rooms.json') });
    const name = () => (JSON.parse(readFileSync(scoresFile, 'utf8')) as Record<string, { name: string }>)[key]!.name;
    try {
      const c = await connect(server.port, '198.51.100.1');
      for (const n of ['Alpha', 'Beta', 'Alpha', 'Beta']) {
        c.send({ t: 'hello', id: id(5), name: n });
        await c.next('welcome');
      }
      expect(name()).toBe('Old');
      await until(() => name() === 'Beta', 'the name to be written', 15000);
    } finally {
      await server.close();
    }
  }, 30000);

  it('rooms written by a machine whose clock was a little ahead are taken up, not thrown away', async () => {
    const dir = folder();
    const roomsFile = path.join(dir, 'rooms.json');
    const first = await startServer({ port: 0, root: 'no-such-folder', roomsFile });
    const room = newRoomName();
    const a = await connect(first.port, '198.51.100.1');
    a.send({ t: 'join', room });
    await a.next('joined');
    await first.close();
    const saved = JSON.parse(readFileSync(roomsFile, 'utf8')) as SavedRooms;
    writeFileSync(roomsFile, JSON.stringify({ ...saved, savedAt: Date.now() + 90_000 }));
    const second = await startServer({ port: 0, root: 'no-such-folder', roomsFile });
    expect(second.lobby.roomCount).toBe(1);
    await second.close();
  });
});

// -- the rooms across a restart, by the lobby's own clock ----------------------------------------

class Fake implements Connection {
  inbox: ServerMessage[] = [];
  send(message: ServerMessage): void {
    this.inbox.push(message);
  }
  close(): void {}
  last<T extends ServerMessage['t']>(t: T): Of<T> | undefined {
    return [...this.inbox].reverse().find((m): m is Of<T> => m.t === t);
  }
}

/** A lobby with a clock of its own, as the server keeps it, and its scores (in a file, if one is given). */
function lobbyAt(time = 7_000_000, scoresFile: string | null = null) {
  const clock = { now: () => time, pass: (ms: number) => (time += ms) };
  const scores = new Scores(scoresFile, clock.now);
  const lobby = new Lobby(clock.now, scores);
  lobby.track();
  const sit = (n: number, room: string) => {
    const c = new Fake();
    lobby.handle(c, { t: 'hello', id: id(n), name: `P${n}` });
    lobby.handle(c, { t: 'join', room });
    return c;
  };
  /** A ranked game between players 1 and 2, both at the board, both having moved. */
  const ranked = () => {
    const a = new Fake();
    const b = new Fake();
    (a as { address?: string }).address = '198.51.100.1';
    (b as { address?: string }).address = '198.51.100.2';
    lobby.handle(a, { t: 'hello', id: id(1) });
    lobby.handle(a, { t: 'queue' });
    lobby.handle(b, { t: 'hello', id: id(2) });
    lobby.handle(b, { t: 'queue' });
    const room = a.last('matched')!.room;
    const one = sit(1, room);
    const two = sit(2, room);
    const [w, b2] = one.last('joined')!.you === 'w' ? [one, two] : [two, one];
    lobby.handle(w, { t: 'move', ply: 0, move: mv('e2e4') });
    lobby.handle(b2, { t: 'move', ply: 1, move: mv('e7e5') });
    return { room, w, b: b2, ids: { w: w === one ? 1 : 2, b: w === one ? 2 : 1 } };
  };
  return { lobby, clock, scores, sit, ranked };
}

/** The state a connection was last told of, by any message that carries one. */
const told = (c: Fake): RoomState => {
  for (const m of [...c.inbox].reverse()) if ('state' in m && m.state) return m.state;
  throw new Error('No state told');
};

describe('absences, clocks and flags across a restart', () => {
  it('a player already away when the server stopped has what was left of their time (at least a few seconds), and loses for it; the one who stayed does not', () => {
    const t = lobbyAt();
    const g = t.ranked();
    t.lobby.leave(g.b);
    t.clock.pass(50_000);
    const saved = t.lobby.save();
    const next = lobbyAt(t.clock.now() + 30_000);
    next.lobby.restore(saved);
    // Neither comes back. Void had ten seconds left, and is given the grace instead.
    const watcher = new Fake();
    next.lobby.handle(watcher, { t: 'join', room: g.room, watch: true });
    next.clock.pass(RESTART_GRACE - 1000);
    next.lobby.tick();
    expect(told(watcher).ended).toBeNull();
    next.clock.pass(2000);
    next.lobby.tick();
    expect(told(watcher)).toMatchObject({ ended: 'left', resigned: 'b', change: { w: 16, b: -16 } });
  });

  it('when both were here at the stop and neither comes back, nobody is more to blame: the game is called off, unrated', () => {
    const t = lobbyAt();
    const g = t.ranked();
    const saved = t.lobby.save();
    const next = lobbyAt(t.clock.now() + 5000);
    next.lobby.restore(saved);
    const watcher = new Fake();
    next.lobby.handle(watcher, { t: 'join', room: g.room, watch: true });
    next.clock.pass(ABANDON_AFTER + 1000);
    next.lobby.tick();
    expect(told(watcher)).toMatchObject({ ended: 'noshow', resigned: null, change: null });
    expect(next.scores.get(playerKey(id(1)))!.rating).toBe(1200);
  });

  it('a flag that fell as the server stopped ends the game on time at once, whoever comes back', () => {
    const t = lobbyAt();
    const g = t.ranked();
    // Ivory to move, and Ivory's time all gone just as the server stops.
    t.lobby.handle(g.w, { t: 'move', ply: 2, move: mv('g1f3') });
    t.lobby.handle(g.b, { t: 'move', ply: 3, move: mv('b8c6') });
    t.clock.pass(CLOCK_START + 4 * CLOCK_INCREMENT);
    const saved = t.lobby.save();
    const next = lobbyAt(t.clock.now() + 5000);
    next.lobby.restore(saved);
    const watcher = new Fake();
    next.lobby.handle(watcher, { t: 'join', room: g.room, watch: true });
    next.lobby.tick();
    expect(told(watcher)).toMatchObject({ ended: 'time', resigned: 'w', change: { w: -16, b: 16 } });
  });

  it('the clock of the side to move runs again as soon as its player is back, or after a few seconds if they are not', () => {
    const t = lobbyAt();
    const g = t.ranked();
    const saved = t.lobby.save();
    const left = saved.rooms[0]!.left.w;
    // Ivory, to move, comes back alone and thinks: Ivory's clock runs.
    const next = lobbyAt(t.clock.now() + 5000);
    next.lobby.restore(saved);
    const back = next.sit(g.ids.w, g.room);
    expect(told(back).clock).toEqual({ left: { w: left, b: saved.rooms[0]!.left.b }, running: 'w' });
    next.clock.pass(20_000);
    next.lobby.handle(back, { t: 'sync' });
    expect(told(back).clock!.left.w).toBe(left - 20_000);
    // Ivory is not back: Ivory's clock runs all the same after the grace, as it would for anyone whose connection had dropped.
    const other = lobbyAt(t.clock.now() + 5000);
    other.lobby.restore(saved);
    const voidBack = other.sit(g.ids.b, g.room);
    expect(told(voidBack).clock!.running).toBeNull();
    other.clock.pass(RESTART_GRACE + 10_000);
    other.lobby.tick();
    expect(told(voidBack).clock).toEqual({ left: { w: left - 10_000, b: saved.rooms[0]!.left.b }, running: 'w' });
  });

  it('a game counted as the server stopped, before the scores were written, is counted when it starts again, and only once', () => {
    const dir = folder();
    const scoresFile = path.join(dir, 'scores.json');
    const t = lobbyAt(7_000_000, scoresFile);
    const g = t.ranked();
    t.lobby.handle(g.b, { t: 'resign' });
    expect(told(g.w).change).toEqual({ w: 16, b: -16 });
    // The room is written down; the scores, not yet (the server is killed now).
    const store = new RoomStore(path.join(dir, 'rooms.json'));
    store.checkpoint({ version: 1, savedAt: 0, rooms: [] });
    store.write(t.lobby.changes(), t.clock.now());
    store.close();
    for (let start = 0; start < 2; start++) {
      const next = lobbyAt(t.clock.now() + 5000, scoresFile);
      next.lobby.restore(new RoomStore(path.join(dir, 'rooms.json')).load()!);
      expect(next.scores.get(playerKey(id(g.ids.w)))!.rating).toBe(1216);
      expect(next.scores.get(playerKey(id(g.ids.b)))!.rating).toBe(1184);
      next.scores.flush();
    }
    expect(Object.keys(JSON.parse(readFileSync(scoresFile, 'utf8')) as object)).toContain('counted');
  });

  it('scores that could not be written are tried again', async () => {
    const dir = folder();
    const scoresFile = path.join(dir, 'scores.json');
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scores = new Scores(scoresFile);
    try {
      chmodSync(dir, 0o500);
      scores.record(playerKey(id(1)), playerKey(id(2)), 'w');
      scores.flush();
      expect(said).toHaveBeenCalled();
      chmodSync(dir, 0o700);
      await until(() => {
        try {
          return (JSON.parse(readFileSync(scoresFile, 'utf8')) as Record<string, { rating: number }>)[playerKey(id(1))]?.rating === 1216;
        } catch {
          return false;
        }
      }, 'the scores to be written', 8000);
    } finally {
      chmodSync(dir, 0o700);
      said.mockRestore();
    }
  }, 15000);
});

describe('the store of rooms', () => {
  it('lays the journal over the checkpoint; a line cut short by a crash, and a journal older than the checkpoint, are passed over', () => {
    const dir = folder();
    const file = path.join(dir, 'rooms.json');
    const t = lobbyAt();
    const store = new RoomStore(file);
    expect(store.load()).toBeNull();
    store.checkpoint(t.lobby.save());
    const w = new Fake();
    const b = new Fake();
    t.lobby.handle(w, { t: 'join', room: 'ABCDEF' });
    t.lobby.handle(b, { t: 'join', room: 'ABCDEF' });
    t.lobby.handle(w, { t: 'move', ply: 0, move: mv('e2e4') });
    store.write(t.lobby.changes(), t.clock.now());
    // A room touched but not changed is not written again.
    const size = store.bytes;
    t.lobby.handle(w, { t: 'sync' });
    t.lobby.handle(w, { t: 'think', square: 'd2' });
    t.lobby.handle(w, { t: 'hello', id: id(3) });
    store.write(t.lobby.changes(), t.clock.now());
    expect(store.bytes).toBe(size);
    t.lobby.handle(b, { t: 'move', ply: 1, move: mv('c7c5') });
    store.write(t.lobby.changes(), t.clock.now());
    // The crash: half a line.
    writeFileSync(store.journalFile, `${readFileSync(store.journalFile, 'utf8')}{"at":1,"put":{"name":"GHJK`);
    const read = new RoomStore(file).load()!;
    expect(read.rooms.map((r) => r.moves)).toEqual([[mv('e2e4'), mv('c7c5')]]);

    // A checkpoint written, and the server stopped before its journal was begun again: the old journal is not read over it.
    const old = readFileSync(store.journalFile, 'utf8');
    store.checkpoint(t.lobby.save());
    t.lobby.handle(w, { t: 'resign' });
    writeFileSync(store.journalFile, old);
    expect(new RoomStore(file).load()!.rooms[0]!.resigned).toBeNull();
    store.close();
  });

  it('writes a move as the move and what changed with it, not the whole game; and passes over one that does not follow on', () => {
    const dir = folder();
    const file = path.join(dir, 'rooms.json');
    const t = lobbyAt();
    const store = new RoomStore(file);
    store.checkpoint(t.lobby.save());
    const w = new Fake();
    const b = new Fake();
    t.lobby.handle(w, { t: 'join', room: 'ABCDEF' });
    t.lobby.handle(b, { t: 'join', room: 'ABCDEF' });
    store.write(t.lobby.changes(), t.clock.now());
    const dance = ['e2e3', 'e7e6', 'd2d3', 'd7d6', 'c2c3', 'c7c6', 'b2b3', 'b7b6', 'a2a3', 'a7a6', 'h2h3', 'h7h6', 'g2g3', 'g7g6', 'f2f3', 'f7f6'];
    const lines: number[] = [];
    dance.forEach((m, ply) => {
      t.lobby.handle(ply % 2 === 0 ? w : b, { t: 'move', ply, move: mv(m) });
      const was = store.bytes;
      store.write(t.lobby.changes(), t.clock.now());
      lines.push(store.bytes - was);
    });
    // Every move a short line, however long the game has grown.
    expect(Math.max(...lines)).toBeLessThan(200);
    expect(new RoomStore(file).load()!.rooms[0]!.moves).toEqual(dance.map(mv));
    // A line that does not follow on (as if one before it were lost) is passed over, and so is what follows it, until the room is written whole.
    const journal = readFileSync(store.journalFile, 'utf8').split('\n');
    const at = journal.findIndex((l) => l.includes('"ply":4'));
    writeFileSync(store.journalFile, [...journal.slice(0, at), ...journal.slice(at + 1)].join('\n'));
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(new RoomStore(file).load()!.rooms[0]!.moves).toEqual(dance.slice(0, 4).map(mv));
    said.mockRestore();
    store.close();
  });

  it('a write that fails is not taken as written: once the journal can be written again, the room is written whole', () => {
    const dir = folder();
    const file = path.join(dir, 'rooms.json');
    const t = lobbyAt();
    const store = new RoomStore(file);
    store.checkpoint(t.lobby.save());
    const w = new Fake();
    const b = new Fake();
    t.lobby.handle(w, { t: 'join', room: 'ABCDEF' });
    t.lobby.handle(b, { t: 'join', room: 'ABCDEF' });
    store.write(t.lobby.changes(), t.clock.now());
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The journal is taken away from under the store: the next write fails.
    const inside = store as unknown as { fd: number };
    closeSync(inside.fd);
    t.lobby.handle(w, { t: 'move', ply: 0, move: mv('e2e4') });
    store.write(t.lobby.changes(), t.clock.now());
    expect(store.wanting).toBe(true);
    // It can be written again (opened afresh, here by hand): the next move brings the first with it.
    inside.fd = openSync(store.journalFile, 'a');
    t.lobby.handle(b, { t: 'move', ply: 1, move: mv('e7e5') });
    store.write(t.lobby.changes(), t.clock.now());
    expect(new RoomStore(file).load()!.rooms[0]!.moves).toEqual([mv('e2e4'), mv('e7e5')]);
    said.mockRestore();
    store.close();
  });

  it('a change made before something went wrong is written down all the same', () => {
    const t = lobbyAt();
    const g = t.ranked();
    t.lobby.changes();
    // The game is given up, and counting it fails.
    const failing = vi.spyOn(Scores.prototype, 'record').mockImplementation(() => {
      throw new Error('the scores are broken');
    });
    try {
      expect(() => t.lobby.handle(g.b, { t: 'resign' })).toThrow('the scores are broken');
    } finally {
      failing.mockRestore();
    }
    const put = t.lobby.changes().find((c) => 'put' in c);
    expect(put && 'put' in put ? put.put.resigned : null).toBe('b');
  });

  it('writes who has played whom, and who is to blame for games called off, as they change', () => {
    const dir = folder();
    const file = path.join(dir, 'rooms.json');
    const t = lobbyAt();
    const store = new RoomStore(file);
    store.checkpoint(t.lobby.save());
    const g = t.ranked();
    t.lobby.handle(g.b, { t: 'resign' });
    // A game called off: a strike against the one who never came.
    const a = new Fake();
    const c = new Fake();
    (a as { address?: string }).address = '198.51.100.3';
    (c as { address?: string }).address = '198.51.100.4';
    t.lobby.handle(a, { t: 'hello', id: id(3) });
    t.lobby.handle(a, { t: 'queue' });
    t.lobby.handle(c, { t: 'hello', id: id(4) });
    t.lobby.handle(c, { t: 'queue' });
    t.sit(3, a.last('matched')!.room);
    t.clock.pass(ABANDON_AFTER + 1000);
    t.lobby.tick();
    store.write(t.lobby.changes(), t.clock.now());
    const read = new RoomStore(file).load()!;
    expect(read.pairs!.map(([pair]) => pair)).toEqual([[playerKey(id(1)), playerKey(id(2))].sort().join(':')]);
    expect(read.strikes!.map(([who]) => who)).toEqual([`key:${playerKey(id(4))}`]);
    // No address is ever written.
    expect(readFileSync(store.journalFile, 'utf8')).not.toContain('198.51.100');
    store.close();
  });

  it('a word that the server is still running does not bring on a checkpoint; a gone game is kept short', () => {
    const dir = folder();
    const store = new RoomStore(path.join(dir, 'rooms.json'));
    const t = lobbyAt();
    store.checkpoint(t.lobby.save());
    store.alive(t.clock.now());
    expect(store.bytes).toBe(0);
    store.close();
    // A ranked game called off is remembered for whoever arrives late, its moves as one line.
    const g = t.ranked();
    t.lobby.leave(g.w);
    t.lobby.leave(g.b);
    const watcher = new Fake();
    t.lobby.handle(watcher, { t: 'join', room: g.room, watch: true });
    t.clock.pass(ABANDON_AFTER + 1000);
    t.lobby.tick();
    t.lobby.leave(watcher);
    t.clock.pass(3 * 60_000);
    t.lobby.sweep();
    const saved = t.lobby.save();
    expect(saved.gone![0]![1].state.moves).toBe('e2e4 e7e5');
    const next = lobbyAt(t.clock.now() + 5000);
    next.lobby.restore(saved);
    const late = new Fake();
    next.lobby.handle(late, { t: 'join', room: g.room });
    expect(late.last('refused')!.state.moves).toEqual([mv('e2e4'), mv('e7e5')]);
  });

  it('forgets finished and abandoned games after a while, in the store as in memory, by the clock on the wall', () => {
    const dir = folder();
    const file = path.join(dir, 'rooms.json');
    const t = lobbyAt();
    const store = new RoomStore(file);
    store.checkpoint(t.lobby.save());
    const game = (name: string, finish: boolean) => {
      const w = new Fake();
      const b = new Fake();
      t.lobby.handle(w, { t: 'join', room: name });
      t.lobby.handle(b, { t: 'join', room: name });
      t.lobby.handle(w, { t: 'move', ply: 0, move: mv('e2e4') });
      if (finish) t.lobby.handle(b, { t: 'resign' });
      t.lobby.leave(w);
      t.lobby.leave(b);
    };
    game('ABCDEF', true);
    game('GHJKLM', false);
    store.write(t.lobby.changes(), t.clock.now());
    expect(new RoomStore(file).load()!.rooms).toHaveLength(2);
    // A finished game nobody is looking at goes after two minutes; one left unfinished, after twenty.
    t.clock.pass(3 * 60_000);
    t.lobby.sweep();
    store.write(t.lobby.changes(), t.clock.now());
    expect(new RoomStore(file).load()!.rooms.map((r) => r.name)).toEqual(['GHJKLM']);
    // Taken up by a server that starts ten minutes later (restarting over and over refreshes nothing):
    // it has stood empty thirteen minutes, and has seven left, not twenty.
    const saved = new RoomStore(file).load()!;
    const next = lobbyAt(t.clock.now() + 10 * 60_000);
    expect(next.lobby.restore(saved)).toBe(1);
    next.clock.pass(6 * 60_000);
    next.lobby.sweep();
    expect(next.lobby.roomCount).toBe(1);
    next.clock.pass(3 * 60_000);
    next.lobby.sweep();
    expect(next.lobby.roomCount).toBe(0);
    store.close();
  });

  it('rooms written by an older server, as it stopped (no journal, clocks read as they stood), are taken up as they were', () => {
    const older: SavedRooms = {
      version: 1,
      savedAt: 7_000_000,
      rooms: [
        {
          name: 'ABCDEF',
          ranked: true,
          startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          moves: [mv('e2e4')],
          resigned: null,
          agreed: false,
          claimed: null,
          drawnOnTime: false,
          players: { w: { key: playerKey(id(1)), tokenHash: 'x', name: 'A' }, b: { key: playerKey(id(2)), tokenHash: 'y', name: 'B' } },
          expected: { w: playerKey(id(1)), b: playerKey(id(2)) },
          left: { w: CLOCK_START - 3000, b: CLOCK_START - 7000 },
          ended: null,
          change: null,
          recorded: false,
          moved: { w: true, b: false },
          held: true,
          again: { w: false, b: false },
          offer: null,
          offeredAt: { w: null, b: null },
        },
      ],
    };
    const t = lobbyAt(7_005_000);
    expect(t.lobby.restore(older)).toBe(1);
    const c = t.sit(1, 'ABCDEF');
    expect(c.last('joined')).toMatchObject({ you: 'w', state: { ranked: true, clock: { left: { w: CLOCK_START - 3000, b: CLOCK_START - 7000 }, running: null } } });
  });
});
