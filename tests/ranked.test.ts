/**
 * Ranked play: who a browser is without an account, the queue, the clock,
 * games the server ends itself, and the scores that are kept.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type Running, startServer } from '../server/main.ts';
import { ABANDON_AFTER, CLOCK_DELAY, CLOCK_INCREMENT, CLOCK_START, type Connection, Lobby } from '../server/rooms.ts';
import { nameFor, playerKey, Scores, START_RATING } from '../server/scores.ts';
import { cleanName, type MoveData, parseClientMessage, type ServerMessage } from '../src/net/protocol.ts';

type Of<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

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

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const move = (text: string): MoveData => ({ from: text.slice(0, 2) as MoveData['from'], to: text.slice(2, 4) as MoveData['to'] });

/** Two players matched by the queue and sat down in their room, with a clock the test can move. */
function matched() {
  let time = 1_000_000;
  const clock = { now: () => time, pass: (ms: number) => (time += ms) };
  const lobby = new Lobby(clock.now);
  const hallA = new Fake();
  const hallB = new Fake();
  lobby.handle(hallA, { t: 'hello', id: ID_A, name: 'Ada' });
  lobby.handle(hallB, { t: 'hello', id: ID_B, name: 'Bo' });
  lobby.handle(hallA, { t: 'queue' });
  lobby.handle(hallB, { t: 'queue' });
  const room = hallA.last('matched')!.room;
  const a = new Fake();
  const b = new Fake();
  lobby.handle(a, { t: 'hello', id: ID_A });
  lobby.handle(a, { t: 'join', room });
  lobby.handle(b, { t: 'hello', id: ID_B });
  lobby.handle(b, { t: 'join', room });
  const aSeat = a.last('joined')!.you;
  const ivory = aSeat === 'w' ? a : b;
  const voidPlayer = aSeat === 'w' ? b : a;
  const ivoryKey = playerKey(aSeat === 'w' ? ID_A : ID_B);
  const voidKey = playerKey(aSeat === 'w' ? ID_B : ID_A);
  const play = (who: Fake, text: string, ply: number) => lobby.handle(who, { t: 'move', ply, move: move(text) });
  return { lobby, clock, room, hallA, hallB, a, b, ivory, void: voidPlayer, ivoryKey, voidKey, play };
}

/** The same, with both players' first moves made (and so a game that counts, however it ends). */
function underWay() {
  const t = matched();
  t.play(t.ivory, 'e2e4', 0);
  t.play(t.void, 'e7e5', 1);
  return t;
}

describe('who a browser is', () => {
  it('reads the new messages, and refuses a secret that is not one', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'hello', id: ID_A, name: '  Ada   Lovelace  ' }))).toEqual({ t: 'hello', id: ID_A, name: 'Ada Lovelace' });
    expect(parseClientMessage(JSON.stringify({ t: 'hello', id: ID_A }))).toEqual({ t: 'hello', id: ID_A });
    expect(parseClientMessage(JSON.stringify({ t: 'hello', id: 'nope' }))).toBeNull();
    for (const t of ['queue', 'unqueue', 'board'] as const) expect(parseClientMessage(JSON.stringify({ t }))).toEqual({ t });
  });

  it('cleans a name of anything that is not one', () => {
    expect(cleanName('<b>Ada</b>')).toBe('bAdab');
    expect(cleanName('x'.repeat(40))).toHaveLength(16);
    expect(cleanName('   ')).toBe('');
    expect(cleanName(7)).toBe('');
  });

  it('gives a new player a name and the starting rating, and never shows the secret', () => {
    const lobby = new Lobby();
    const c = new Fake();
    lobby.handle(c, { t: 'hello', id: ID_A });
    const you = c.last('welcome')!.you;
    expect(you).toEqual({ name: nameFor(playerKey(ID_A)), rating: START_RATING, wins: 0, losses: 0, draws: 0 });
    expect(JSON.stringify(c.inbox)).not.toContain(ID_A);
  });
});

describe('the queue', () => {
  it('makes the first wait and pairs the second with them', () => {
    const lobby = new Lobby();
    const a = new Fake();
    const b = new Fake();
    lobby.handle(a, { t: 'hello', id: ID_A });
    lobby.handle(b, { t: 'hello', id: ID_B });
    lobby.handle(a, { t: 'queue' });
    expect(a.last('queued')).toEqual({ t: 'queued', waiting: 1 });
    lobby.handle(b, { t: 'queue' });
    expect(a.last('matched')!.room).toBe(b.last('matched')!.room);
    expect(lobby.waiting).toBe(0);
  });

  it('does not queue a stranger, pair a player with themself, or keep one who has left', () => {
    const lobby = new Lobby();
    const stranger = new Fake();
    lobby.handle(stranger, { t: 'queue' });
    expect(lobby.waiting).toBe(0);
    const one = new Fake();
    const again = new Fake();
    lobby.handle(one, { t: 'hello', id: ID_A });
    lobby.handle(again, { t: 'hello', id: ID_A });
    lobby.handle(one, { t: 'queue' });
    lobby.handle(again, { t: 'queue' });
    expect(one.last('matched')).toBeUndefined();
    expect(lobby.waiting).toBe(1);
    lobby.leave(again);
    expect(lobby.waiting).toBe(0);
    lobby.handle(one, { t: 'queue' });
    lobby.handle(one, { t: 'unqueue' });
    expect(lobby.waiting).toBe(0);
  });
});

describe('a ranked room', () => {
  it('seats the two who were matched, shows their names, and starts the clock a few seconds later', () => {
    const t = matched();
    const state = t.b.last('joined')!.state;
    expect(state.ranked).toBe(true);
    expect(state.taken).toEqual({ w: true, b: true });
    expect([state.players.w!.name, state.players.b!.name].sort()).toEqual(['Ada', 'Bo']);
    // While the match is introduced, no clock runs.
    expect(state.clock).toEqual({ left: { w: CLOCK_START, b: CLOCK_START }, running: null });
    t.clock.pass(CLOCK_DELAY - 1);
    t.lobby.tick();
    expect(t.a.last('state')?.state.clock?.running ?? null).toBeNull();
    // Then White's starts, and both are told.
    t.clock.pass(1);
    t.lobby.tick();
    for (const who of [t.a, t.b]) expect(who.last('state')!.state.clock).toEqual({ left: { w: CLOCK_START, b: CLOCK_START }, running: 'w' });
    t.clock.pass(2000);
    t.a.inbox.length = 0;
    t.lobby.handle(t.a, { t: 'sync' });
    expect(t.a.last('state')!.state.clock!.left.w).toBe(CLOCK_START - 2000);
  });

  it('starts the clock at White\'s first move, if that comes before the few seconds are up', () => {
    const t = matched();
    t.clock.pass(1000);
    t.play(t.ivory, 'e2e4', 0);
    // Nothing is charged for a move made before the clock ran; Black's clock runs from now.
    expect(t.void.last('moved')!.clock).toEqual({ left: { w: CLOCK_START + CLOCK_INCREMENT, b: CLOCK_START }, running: 'b' });
    t.clock.pass(CLOCK_DELAY);
    t.lobby.tick();
    expect(t.ivory.last('state')?.state.clock?.running ?? 'b').toBe('b');
  });

  it('lets nobody else sit, with or without a name', () => {
    const t = matched();
    const other = new Fake();
    t.lobby.handle(other, { t: 'hello', id: 'c'.repeat(32) });
    t.lobby.handle(other, { t: 'join', room: t.room });
    expect(other.last('joined')!.you).toBe('spectator');
    const nameless = new Fake();
    t.lobby.handle(nameless, { t: 'join', room: t.room });
    expect(nameless.last('joined')!.you).toBe('spectator');
  });

  it('charges each move to the mover, gives the increment back, and says so with the move', () => {
    const t = matched();
    t.clock.pass(CLOCK_DELAY);
    t.lobby.tick();
    t.clock.pass(7000);
    t.play(t.ivory, 'e2e4', 0);
    expect(t.void.last('moved')!.clock).toEqual({ left: { w: CLOCK_START - 7000 + CLOCK_INCREMENT, b: CLOCK_START }, running: 'b' });
    t.clock.pass(3000);
    t.play(t.void, 'e7e5', 1);
    expect(t.ivory.last('moved')!.clock!.left.b).toBe(CLOCK_START - 3000 + CLOCK_INCREMENT);
  });

  it('ends the game against a player whose time runs out, and counts it', () => {
    const t = underWay();
    t.play(t.ivory, 'g1f3', 2);
    t.clock.pass(CLOCK_START + CLOCK_INCREMENT + 1);
    t.lobby.tick();
    const state = t.ivory.last('state')!.state;
    expect(state.ended).toBe('time');
    expect(state.resigned).toBe('b');
    expect(state.clock).toEqual({ left: { w: CLOCK_START + 2 * CLOCK_INCREMENT, b: 0 }, running: null });
    expect(state.change).toEqual({ w: 16, b: -16 });
    expect(t.lobby.scores.get(t.ivoryKey)).toMatchObject({ rating: START_RATING + 16, wins: 1 });
    expect(t.lobby.scores.get(t.voidKey)).toMatchObject({ rating: START_RATING - 16, losses: 1 });
  });

  it('refuses a move that arrives after the time has gone', () => {
    const t = underWay();
    t.clock.pass(CLOCK_START + CLOCK_INCREMENT + 5);
    t.play(t.ivory, 'g1f3', 2);
    const state = t.void.last('state')!.state;
    expect(state.moves).toHaveLength(2);
    expect(state.ended).toBe('time');
    expect(state.resigned).toBe('w');
  });

  it('gives the game to the one who stayed when the other leaves and does not come back', () => {
    const t = underWay();
    t.lobby.leave(t.void);
    t.clock.pass(ABANDON_AFTER - 1000);
    t.lobby.tick();
    expect(t.ivory.last('state')!.state.ended).toBeNull();
    t.clock.pass(2000);
    t.lobby.tick();
    const state = t.ivory.last('state')!.state;
    expect(state.ended).toBe('left');
    expect(state.resigned).toBe('b');
    expect(t.lobby.scores.get(t.ivoryKey)!.wins).toBe(1);
  });

  it('keeps the seat of a player who comes back in time', () => {
    const t = matched();
    t.play(t.ivory, 'e2e4', 0);
    t.lobby.leave(t.void);
    t.clock.pass(20000);
    const back = new Fake();
    t.lobby.handle(back, { t: 'hello', id: t.void === t.a ? ID_A : ID_B });
    t.lobby.handle(back, { t: 'join', room: t.room });
    expect(back.last('joined')!.you).toBe('b');
    t.clock.pass(ABANDON_AFTER);
    t.lobby.tick();
    expect(back.last('joined')!.state.moves).toHaveLength(1);
    expect(t.ivory.last('state')!.state.ended).toBeNull();
  });

  it('calls the game off, and moves no rating, when a player never arrives', () => {
    let time = 0;
    const lobby = new Lobby(() => time);
    const hallA = new Fake();
    const hallB = new Fake();
    lobby.handle(hallA, { t: 'hello', id: ID_A });
    lobby.handle(hallB, { t: 'hello', id: ID_B });
    lobby.handle(hallA, { t: 'queue' });
    lobby.handle(hallB, { t: 'queue' });
    const a = new Fake();
    lobby.handle(a, { t: 'hello', id: ID_A });
    lobby.handle(a, { t: 'join', room: hallA.last('matched')!.room });
    time += ABANDON_AFTER + 1;
    lobby.tick();
    const state = a.last('state')!.state;
    expect(state.ended).toBe('noshow');
    expect(state.change).toBeNull();
    expect(lobby.scores.top(10)).toEqual([]);
  });

  it('counts a resignation and an agreed draw, each once', () => {
    const t = underWay();
    t.lobby.handle(t.ivory, { t: 'resign' });
    t.lobby.handle(t.ivory, { t: 'resign' });
    t.lobby.tick();
    expect(t.lobby.scores.get(t.voidKey)).toMatchObject({ wins: 1, rating: START_RATING + 16 });
    expect(t.ivory.last('state')!.state.ended).toBeNull();

    const d = matched();
    d.play(d.ivory, 'e2e4', 0);
    d.play(d.void, 'e7e5', 1);
    d.lobby.handle(d.ivory, { t: 'draw' });
    d.lobby.handle(d.void, { t: 'agree' });
    expect(d.lobby.scores.get(d.ivoryKey)).toMatchObject({ draws: 1, rating: START_RATING });
    expect(d.void.last('state')!.state.change).toEqual({ w: 0, b: 0 });
  });

  it('plays no second game in the same room: another is found in the queue', () => {
    const t = underWay();
    t.lobby.handle(t.void, { t: 'resign' });
    t.lobby.handle(t.ivory, { t: 'again' });
    t.lobby.handle(t.void, { t: 'again' });
    expect(t.ivory.last('seated')).toBeUndefined();
    expect(t.void.last('refused')!.reason).toMatch(/played once/);
    expect(t.lobby.scores.get(t.ivoryKey)).toMatchObject({ wins: 1 });
  });

  it('calls the game off, unrated, when a player resigns or leaves before both have moved', () => {
    const t = matched();
    t.play(t.ivory, 'e2e4', 0);
    t.lobby.handle(t.void, { t: 'resign' });
    const state = t.ivory.last('state')!.state;
    expect(state).toMatchObject({ ended: 'noshow', resigned: null, change: null });
    expect(t.lobby.scores.get(t.voidKey)).toMatchObject({ losses: 0, rating: START_RATING });
    // The room is gone at once; anyone coming for it is told what became of it.
    expect(t.lobby.roomCount).toBe(0);
    const late = new Fake();
    t.lobby.handle(late, { t: 'join', room: t.room });
    expect(late.last('refused')).toMatchObject({ reason: 'This game was called off.', state: { ended: 'noshow' } });
  });

  it('a friendly room has no clock and counts nothing, but shows the names', () => {
    const lobby = new Lobby();
    const a = new Fake();
    const b = new Fake();
    lobby.handle(a, { t: 'hello', id: ID_A, name: 'Ada' });
    lobby.handle(a, { t: 'join', room: 'ABCDEF' });
    lobby.handle(b, { t: 'join', room: 'ABCDEF' });
    lobby.handle(a, { t: 'move', ply: 0, move: move('e2e4') });
    expect(b.last('moved')).toEqual({ t: 'moved', ply: 0, move: move('e2e4') });
    lobby.handle(b, { t: 'resign' });
    const state = a.last('state')!.state;
    expect(state).toMatchObject({ ranked: false, clock: null, change: null, ended: null });
    expect(state.players).toEqual({ w: { name: 'Ada', rating: START_RATING }, b: null });
    expect(lobby.scores.top(10)).toEqual([]);
  });
});

describe('the scores', () => {
  it('lists the best first, only those who have played three games, and says where a player stands', () => {
    const t = underWay();
    t.lobby.handle(t.void, { t: 'resign' });
    const idle = new Fake();
    t.lobby.handle(idle, { t: 'hello', id: 'c'.repeat(32) });
    t.lobby.handle(idle, { t: 'board' });
    // One game says little of anyone: nobody is listed yet.
    expect(idle.last('board')!.top).toEqual([]);
    for (let i = 0; i < 2; i++) t.lobby.scores.record(t.ivoryKey, t.voidKey, 'w');
    t.lobby.handle(idle, { t: 'board' });
    const board = idle.last('board')!;
    expect(board.top.map((p) => p.wins)).toEqual([3, 0]);
    expect(board.top[0]!.rating).toBeGreaterThan(START_RATING);
    expect(board.you).toMatchObject({ rating: START_RATING, wins: 0 });
  });

  it('keeps the list ready, and works it out again only once a game has been counted', () => {
    const scores = new Scores();
    const [a, b] = ['1'.repeat(32), '2'.repeat(32)];
    for (let i = 0; i < 3; i++) scores.record(a, b, 'w');
    const first = scores.top(20);
    expect(scores.top(20)).toEqual(first);
    expect(first.map((p) => p.wins)).toEqual([3, 0]);
    scores.record(a, b, 'b');
    expect(scores.top(20).map((p) => p.losses)).toEqual([1, 3]);
  });

  it('remembers visitors who have only said hello no longer than it must, and never in place of a player', () => {
    const scores = new Scores();
    const played = 'f'.repeat(32);
    const other = 'e'.repeat(32);
    scores.record(played, other, 'w');
    for (let i = 0; i < 12000; i++) scores.greet(i.toString(16).padStart(32, '0'));
    expect(scores.size.visitors).toBeLessThanOrEqual(5000);
    expect(scores.get(played)).toMatchObject({ wins: 1 });
    // A visitor seen lately is still known by their name; one long forgotten is counted afresh should they finish a game.
    scores.greet('a'.repeat(32), 'Ada');
    expect(scores.get('a'.repeat(32))!.name).toBe('Ada');
    expect(scores.get('0'.repeat(32))).toBeNull();
    expect(scores.record('0'.repeat(32), played, 'w').w).toBeGreaterThan(16);
    expect(scores.get('0'.repeat(32))).toMatchObject({ wins: 1 });
  });

  it('moves a rating less for an expected result than for an upset', () => {
    const scores = new Scores();
    for (const key of ['1', '2']) scores.greet(key.repeat(32));
    for (let i = 0; i < 5; i++) scores.record('1'.repeat(32), '2'.repeat(32), 'w');
    const expected = scores.record('1'.repeat(32), '2'.repeat(32), 'w');
    const upset = scores.record('1'.repeat(32), '2'.repeat(32), 'b');
    expect(expected.w).toBeGreaterThan(0);
    expect(expected.w).toBeLessThan(16);
    expect(upset.b).toBeGreaterThan(16);
  });

  it('are written to a file and read back, with nothing in it but hashes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightpiece-scores-'));
    try {
      const file = path.join(dir, 'deep', 'scores.json');
      const scores = new Scores(file);
      const a = playerKey(ID_A);
      const b = playerKey(ID_B);
      scores.greet(a, 'Ada');
      scores.greet(b);
      scores.greet(playerKey('c'.repeat(32)), 'Never played');
      scores.record(a, b, 'w');
      scores.flush();
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain(ID_A);
      expect(text).not.toContain('Never played');
      const again = new Scores(file);
      expect(again.get(a)).toEqual({ name: 'Ada', rating: START_RATING + 16, wins: 1, losses: 0, draws: 0 });
      expect(again.top(5)).toHaveLength(0);
      for (let i = 0; i < 2; i++) again.record(a, b, 'w');
      expect(again.top(5)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('over real sockets', () => {
  let running: Running | null = null;
  afterAll(async () => {
    await running?.close();
  });

  const open = (port: number, from = '198.51.100.1') =>
    new Promise<{ socket: WebSocket; next: <T extends ServerMessage['t']>(t: T) => Promise<Of<T>>; say: (m: unknown) => void }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-real-ip': from } });
      const heard: ServerMessage[] = [];
      const waiting: (() => void)[] = [];
      socket.on('message', (data) => {
        heard.push(JSON.parse(String(data)) as ServerMessage);
        for (const w of waiting.splice(0)) w();
      });
      const next = async <T extends ServerMessage['t']>(t: T): Promise<Of<T>> => {
        for (;;) {
          const i = heard.findIndex((m) => m.t === t);
          if (i >= 0) return heard.splice(i, 1)[0] as Of<T>;
          await new Promise<void>((done) => waiting.push(done));
        }
      };
      socket.on('open', () => resolve({ socket, next, say: (m) => socket.send(JSON.stringify(m)) }));
      socket.on('error', reject);
    });

  it('matches two players, plays a move with the clock, and turns away an address with too many connections', async () => {
    running = await startServer({ port: 0, root: path.join(tmpdir(), 'nightpiece-no-such-folder'), perAddress: 3, behindProxy: true });
    const port = running.port;
    // Two players from two addresses (as the proxy in front names them): one address alone is never matched with itself.
    const hallA = await open(port, '198.51.100.1');
    const hallB = await open(port, '198.51.100.2');
    hallA.say({ t: 'hello', id: ID_A, name: 'Ada' });
    hallB.say({ t: 'hello', id: ID_B, name: 'Bo' });
    expect((await hallA.next('welcome')).you.name).toBe('Ada');
    hallA.say({ t: 'queue' });
    await hallA.next('queued');
    hallB.say({ t: 'queue' });
    const room = (await hallA.next('matched')).room;
    expect((await hallB.next('matched')).room).toBe(room);

    const a = await open(port);
    const b = await open(port);
    a.say({ t: 'hello', id: ID_A });
    a.say({ t: 'join', room });
    b.say({ t: 'hello', id: ID_B });
    b.say({ t: 'join', room });
    const seatA = (await a.next('joined')).you;
    const joinedB = await b.next('joined');
    // Neither clock runs while the match is introduced: White's first move starts Black's.
    expect(joinedB.state.clock!.running).toBeNull();
    const [ivory, other] = seatA === 'w' ? [a, b] : [b, a];
    ivory.say({ t: 'move', ply: 0, move: move('e2e4') });
    const moved = await other.next('moved');
    expect(moved.clock!.running).toBe('b');
    expect(moved.clock!.left.w).toBeGreaterThan(CLOCK_START);

    // Three connections are open from the first address, and that is all it may have.
    await expect(open(port)).rejects.toThrow(/429/);
    hallA.socket.close();
    await new Promise((done) => hallA.socket.once('close', done));
    const fifth = await open(port);
    for (const c of [hallB, a, b, fifth]) c.socket.close();
  });

  it('behind a proxy, counts the address the proxy names and not the proxy', async () => {
    const proxied = await startServer({ port: 0, root: path.join(tmpdir(), 'nightpiece-no-such-folder'), perAddress: 1, behindProxy: true });
    const from = (headers: Record<string, string>) =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${proxied.port}/ws`, { headers });
        socket.on('open', () => resolve(socket));
        socket.on('error', reject);
      });
    try {
      // A host with proxies in a row: the list ends with one of its own, and the visitor is named apart.
      const one = await from({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' });
      const two = await from({ 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '198.51.100.2, 10.0.0.1' });
      await expect(from({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.1, 10.0.0.2' })).rejects.toThrow(/429/);
      // A single proxy that only keeps the list: its last address is the visitor, whatever the visitor put before it.
      const three = await from({ 'x-forwarded-for': '203.0.113.9, 198.51.100.3' });
      await expect(from({ 'x-forwarded-for': '203.0.113.10, 198.51.100.3' })).rejects.toThrow(/429/);
      for (const socket of [one, two, three]) socket.close();
    } finally {
      await proxied.close();
    }
  });
});
