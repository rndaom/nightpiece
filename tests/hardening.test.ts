/**
 * What was put right before the game went public, after the audits of its rules, its security
 * and its load: the queue and who may be matched, games called off and those to blame, one
 * player to a connection, names, the limits on rooms and connections, the headers every answer
 * carries, a server that survives its own mistakes, and games that survive a restart.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { addressKey, contentSecurityPolicy, inlineStyleHashes, type Running, startServer } from '../server/main.ts';
import { ABANDON_AFTER, CLOCK_DELAY, CLOCK_START, type Connection, Lobby, PAIR_LIMIT, STRIKE_BAN, UNJOINED_PER_ADDRESS } from '../server/rooms.ts';
import { nameFor, playerKey, Scores } from '../server/scores.ts';
import { Game, type PromotionKind, type Side, type Square } from '../src/core/game.ts';
import { CLOSE_TWO_PLAYERS, type ClientMessage, cleanName, type MoveData, newRoomName, type ServerMessage } from '../src/net/protocol.ts';

type Of<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

class Fake implements Connection {
  inbox: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(readonly address?: string) {}
  send(message: ServerMessage): void {
    this.inbox.push(message);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  last<T extends ServerMessage['t']>(t: T): Of<T> | undefined {
    return [...this.inbox].reverse().find((m): m is Of<T> => m.t === t);
  }
}

const id = (n: number) => n.toString(16).padStart(32, '0');
const mv = (text: string): MoveData => ({ from: text.slice(0, 2) as Square, to: text.slice(2, 4) as Square, ...(text[4] ? { promotion: text[4] as PromotionKind } : {}) });

function lobbyWithClock(options: ConstructorParameters<typeof Lobby>[2] = {}) {
  let time = 5_000_000;
  const clock = { now: () => time, pass: (ms: number) => (time += ms) };
  const scores = new Scores(null, clock.now);
  const lobby = new Lobby(clock.now, scores, options);
  /** A player saying who they are from an address, and asking for a game. */
  const queue = (n: number, address?: string) => {
    const c = new Fake(address);
    lobby.handle(c, { t: 'hello', id: id(n) });
    lobby.handle(c, { t: 'queue' });
    return c;
  };
  /** A player sitting down in their ranked room. */
  const sit = (n: number, room: string, address?: string) => {
    const c = new Fake(address);
    lobby.handle(c, { t: 'hello', id: id(n) });
    lobby.handle(c, { t: 'join', room });
    return c;
  };
  return { lobby, clock, scores, queue, sit };
}

// -- the queue ------------------------------------------------------------------------

describe('the queue', () => {
  it('holds several who cannot be matched yet, and pairs a newcomer with the longest waiting of those they may play', () => {
    const t = lobbyWithClock();
    const a = t.queue(1, '198.51.100.1');
    const b = t.queue(2, '198.51.100.1');
    // Same address: both wait.
    expect(t.lobby.waiting).toBe(2);
    expect(a.last('queued')!.waiting).toBe(1);
    expect(b.last('queued')!.waiting).toBe(2);
    // A third, from elsewhere, is paired with the first (the longest waiting), not the second.
    const c = t.queue(3, '198.51.100.2');
    expect(c.last('matched')!.room).toBe(a.last('matched')!.room);
    expect(b.last('matched')).toBeUndefined();
    expect(t.lobby.waiting).toBe(1);
  });

  it('does not match two players who have finished three rated games together today; tomorrow it does', () => {
    const t = lobbyWithClock();
    for (let game = 0; game < PAIR_LIMIT; game++) {
      const a = t.queue(1, '198.51.100.1');
      t.queue(2, '198.51.100.2');
      const room = a.last('matched')!.room;
      const pa = t.sit(1, room);
      const pb = t.sit(2, room);
      const [w, b] = pa.last('joined')!.you === 'w' ? [pa, pb] : [pb, pa];
      t.lobby.handle(w, { t: 'move', ply: 0, move: mv('e2e4') });
      t.lobby.handle(b, { t: 'move', ply: 1, move: mv('e7e5') });
      t.lobby.handle(w, { t: 'resign' });
      expect(w.last('state')!.state.change).not.toBeNull();
    }
    const a = t.queue(1, '198.51.100.1');
    const b = t.queue(2, '198.51.100.2');
    expect(b.last('matched')).toBeUndefined();
    expect(t.lobby.waiting).toBe(2);
    // Someone else is matched with either of them at once.
    const c = t.queue(3, '198.51.100.3');
    expect(c.last('matched')!.room).toBe(a.last('matched')!.room);
    t.lobby.handle(b, { t: 'unqueue' });
    t.clock.pass(24 * 60 * 60 * 1000 + 1);
    t.lobby.sweep();
    t.queue(1, '198.51.100.1');
    const again = t.queue(2, '198.51.100.2');
    expect(again.last('matched')).toBeDefined();
  });

  it('says so when it cannot take a player: no name given, or the queue full', () => {
    const t = lobbyWithClock();
    const stranger = new Fake('198.51.100.1');
    t.lobby.handle(stranger, { t: 'queue' });
    expect(stranger.last('turned')!.reason).toMatch(/Say who you are/);
    // Two hundred from one address may wait (none can be matched with another); the next is turned away.
    for (let n = 1; n <= 200; n++) t.queue(n, '198.51.100.9');
    expect(t.lobby.waiting).toBe(200);
    const late = t.queue(201, '198.51.100.9');
    expect(late.last('turned')!.reason).toMatch(/Too many are waiting/);
    expect(t.lobby.waiting).toBe(200);
  });
});

// -- called off, and those to blame ---------------------------------------------------

describe('games called off', () => {
  it('a player (and an address) to blame for two called-off games in ten minutes may not look for another for ten minutes', () => {
    const t = lobbyWithClock();
    for (let round = 0; round < 2; round++) {
      // Player 1 is matched and never sits down; player 2 (another each round) does.
      const idle = t.queue(1, '203.0.113.1');
      t.queue(10 + round, '198.51.100.2');
      const room = idle.last('matched')!.room;
      const there = t.sit(10 + round, room);
      t.clock.pass(ABANDON_AFTER + 1);
      t.lobby.tick();
      expect(there.last('state')!.state.ended).toBe('noshow');
    }
    const turned = t.queue(1, '203.0.113.1');
    expect(turned.last('turned')).toMatchObject({ reason: expect.stringMatching(/called off lately.*10 minutes/), until: STRIKE_BAN });
    // A new id from the same address is held back too; the players who came are not.
    expect(t.queue(99, '203.0.113.1').last('turned')).toBeDefined();
    expect(t.queue(10, '198.51.100.2').last('queued')).toBeDefined();
    t.clock.pass(STRIKE_BAN + 1);
    expect(t.queue(1, '203.0.113.1').last('matched')).toBeDefined();
  });

  it('one connection that never sits down cannot be matched with everyone who arrives', () => {
    const t = lobbyWithClock();
    let matchedWithIdle = 0;
    for (let n = 0; n < 10; n++) {
      const idle = t.queue(1, '203.0.113.1');
      if (idle.last('turned')) break;
      t.queue(100 + n, `198.51.100.${n + 10}`);
      if (idle.last('matched')) matchedWithIdle++;
      t.clock.pass(ABANDON_AFTER + 1);
      t.lobby.tick();
    }
    expect(matchedWithIdle).toBe(2);
  });

  it('a called-off room is gone at once, and the per-second look at clocks covers only the games being played', () => {
    const t = lobbyWithClock();
    for (let n = 0; n < 50; n++) t.lobby.handle(new Fake(), { t: 'join', room: newRoomName() });
    const a = t.queue(1, '198.51.100.1');
    t.queue(2, '198.51.100.2');
    expect(t.lobby.roomCount).toBe(51);
    expect(t.lobby.watchedCount).toBe(1);
    t.clock.pass(ABANDON_AFTER + 1);
    t.lobby.tick();
    expect(t.lobby.roomCount).toBe(50);
    expect(t.lobby.watchedCount).toBe(0);
    expect(a.closed).toBeNull();
  });
});

// -- one player to a connection, and addresses ---------------------------------------

describe('who a connection is', () => {
  it('is one player: a second hello with another id closes it; a new name for the same id is welcome', () => {
    const lobby = new Lobby();
    const c = new Fake();
    lobby.handle(c, { t: 'hello', id: id(1), name: 'Ada' });
    lobby.handle(c, { t: 'hello', id: id(1), name: 'Ada Lovelace' });
    expect(c.last('welcome')!.you.name).toBe('Ada Lovelace');
    expect(c.closed).toBeNull();
    lobby.handle(c, { t: 'queue' });
    lobby.handle(c, { t: 'hello', id: id(2) });
    expect(c.closed).toMatchObject({ code: CLOSE_TWO_PLAYERS });
    expect(lobby.waiting).toBe(0);
  });

  it('an address may have only two matched games waiting for it to sit down', () => {
    const t = lobbyWithClock();
    const rooms: string[] = [];
    for (let n = 0; n < UNJOINED_PER_ADDRESS; n++) {
      t.queue(1 + n * 2, '203.0.113.1');
      rooms.push(t.queue(2 + n * 2, `198.51.100.${n}`).last('matched')!.room);
    }
    const third = t.queue(50, '203.0.113.1');
    expect(third.last('turned')!.reason).toMatch(/waiting for you to sit down/);
    // Once one of them is sat down to, there is room for another.
    t.sit(1, rooms[0]!, '203.0.113.1');
    expect(t.queue(50, '203.0.113.1').last('queued')).toBeDefined();
  });

  it('counts an IPv6 visitor by the block of addresses it is given, and an IPv4 address written as IPv6 as itself', () => {
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0db8:0001:0002::9')).toBe('2001:db8:1:2::/64');
    expect(addressKey('[2001:db8:1:2::ffff:1.2.3.4]')).toBe('2001:db8:1:2::/64');
    expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(addressKey('::ffff:198.51.100.4')).toBe('198.51.100.4');
    expect(addressKey('198.51.100.4')).toBe('198.51.100.4');
    expect(addressKey('2001:db8:1:3::1')).not.toBe(addressKey('2001:db8:1:2::1'));
  });
});

// -- names --------------------------------------------------------------------------

describe('names', () => {
  it('folds look-alike forms into plain ones, and counts characters, not their halves', () => {
    expect(cleanName('\uFF21\uFF44\uFF41')).toBe('Ada');
    // Deseret letters each take two halves in JavaScript: sixteen of them are a whole name.
    const deseret = '\u{10400}'.repeat(20);
    expect([...cleanName(deseret)]).toHaveLength(16);
    expect(cleanName('x'.repeat(40))).toHaveLength(16);
  });

  it('refuses letters that show as nothing, and characters as wide as a sentence', () => {
    for (const blank of ['\u3164', '\u115F', '\u1160', '\uFFA0', 'Ada\u3164', '\u3164\u3164\u3164']) expect(cleanName(blank), JSON.stringify(blank)).toBe('');
    for (const wide of ['\uFDFA', 'Ada\uFDFA', '\u{12219}', '\uFDFD']) expect(cleanName(wide), JSON.stringify(wide)).toBe('');
  });

  it('refuses Latin mixed with Cyrillic or Greek, and welcomes a name in any one script', () => {
    expect(cleanName('Аda')).toBe(''); // a Cyrillic A
    expect(cleanName('Adα')).toBe(''); // a Greek alpha
    for (const name of ['Наташа', 'Ελένη', '李小龍', 'Zoë', 'José María', 'محمد', 'राहुल', 'さくら']) expect(cleanName(name), name).toBe(name);
    // Accents stay with their letter; a tower of them does not.
    // (The first accent is folded into the letter, which keeps two more.)
    expect([...cleanName(`a${'\u0301'.repeat(6)}b`)]).toEqual(['\u00E1', '\u0301', '\u0301', 'b']);
  });

  it('refuses the names reserved for the game itself, however written', () => {
    for (const name of ['admin', 'Admin', 'ADMINISTRATOR', 'ａｄｍｉｎ', 'Mod', 'Night Piece', 'nightpiece', 'Staff', 'Official', 'System', 'server', 'moderator', 'a.d.m.i.n', 'Admin 2']) {
      expect(cleanName(name), name).toBe('');
    }
    expect(cleanName('Moderna')).toBe('Moderna');
    expect(cleanName('Adminah')).toBe('Adminah');
  });

  it('refuses a name with a word on the operator\'s list; such a player keeps the name the server gave them', () => {
    const lobby = new Lobby(Date.now, undefined, { blockedNames: ['rude'] });
    const c = new Fake();
    lobby.handle(c, { t: 'hello', id: id(1), name: 'VeryRude One' });
    expect(c.last('welcome')!.you.name).toBe(nameFor(playerKey(id(1))));
    lobby.handle(c, { t: 'hello', id: id(1), name: 'Polite' });
    expect(c.last('welcome')!.you.name).toBe('Polite');
    lobby.handle(c, { t: 'hello', id: id(1), name: 'R.u.d.e' });
    expect(c.last('welcome')!.you.name).toBe('Polite');
  });
});

// -- rooms: limits, and how long they are kept ----------------------------------------

describe('rooms', () => {
  it('counts ranked rooms against the limit, and says so to those it cannot match', () => {
    const t = lobbyWithClock({ maxRooms: 1 });
    t.lobby.handle(new Fake(), { t: 'join', room: 'ABCDEF' });
    t.queue(1, '198.51.100.1');
    const b = t.queue(2, '198.51.100.2');
    expect(b.last('turned')!.reason).toMatch(/no room for another game/);
    expect(t.lobby.roomCount).toBe(1);
  });

  it('when full, makes way for a new game by forgetting the finished room that has stood empty longest, never a game being played', () => {
    const t = lobbyWithClock({ maxRooms: 3 });
    // Two finished games, both players gone: the first left before the second.
    const finished = (room: string) => {
      const w = new Fake();
      const b = new Fake();
      t.lobby.handle(w, { t: 'join', room });
      t.lobby.handle(b, { t: 'join', room });
      for (const [i, m] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) t.lobby.handle(i % 2 === 0 ? w : b, { t: 'move', ply: i, move: mv(m) });
      t.lobby.leave(w);
      t.lobby.leave(b);
      t.clock.pass(1000);
    };
    finished('AAAAAA');
    finished('BBBBBB');
    // And one being played.
    const live = new Fake();
    t.lobby.handle(live, { t: 'join', room: 'CCCCCC' });
    t.lobby.handle(live, { t: 'move', ply: 0, move: mv('e2e4') });
    expect(t.lobby.roomCount).toBe(3);
    // A new friendly room, then a ranked match, each take the place of a finished room, oldest first.
    const first = new Fake();
    t.lobby.handle(first, { t: 'join', room: 'DDDDDD' });
    expect(first.last('joined')!.you).toBe('w');
    const late = new Fake();
    t.lobby.handle(late, { t: 'join', room: 'AAAAAA' });
    expect(late.last('joined')!.state.moves).toEqual([]);
    expect(t.lobby.roomCount).toBe(3);
    // Now every room holds a game nobody has finished: the next is turned away.
    t.queue(1, '198.51.100.1');
    const b = t.queue(2, '198.51.100.2');
    expect(b.last('turned')!.reason).toMatch(/no room for another game/);
    expect(t.lobby.roomCount).toBe(3);
  });

  it('forgets a room whose game is over two minutes after both players have left it (not twenty)', () => {
    const t = lobbyWithClock();
    const w = new Fake();
    const b = new Fake();
    t.lobby.handle(w, { t: 'join', room: 'ABCDEF' });
    t.lobby.handle(b, { t: 'join', room: 'ABCDEF' });
    for (const [i, m] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) t.lobby.handle(i % 2 === 0 ? w : b, { t: 'move', ply: i, move: mv(m) });
    t.lobby.leave(w);
    t.lobby.leave(b);
    t.clock.pass(2 * 60_000 - 1000);
    t.lobby.sweep();
    expect(t.lobby.roomCount).toBe(1);
    t.clock.pass(2000);
    t.lobby.sweep();
    expect(t.lobby.roomCount).toBe(0);
  });

  it('a ranked room that has gone tells a player arriving late how its game ended', () => {
    const t = lobbyWithClock();
    const a = t.queue(1, '198.51.100.1');
    t.queue(2, '198.51.100.2');
    const room = a.last('matched')!.room;
    const pa = t.sit(1, room);
    const pb = t.sit(2, room);
    const [w, b] = pa.last('joined')!.you === 'w' ? [pa, pb] : [pb, pa];
    for (const [i, m] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) t.lobby.handle(i % 2 === 0 ? w : b, { t: 'move', ply: i, move: mv(m) });
    t.lobby.leave(w);
    t.lobby.leave(b);
    t.clock.pass(3 * 60_000);
    t.lobby.sweep();
    expect(t.lobby.roomCount).toBe(0);
    const late = t.sit(1, room);
    expect(late.last('refused')).toMatchObject({ reason: 'This game is over.', state: { moves: { length: 4 } } });
    expect(late.last('refused')!.state.change).not.toBeNull();
  });
});

// -- every ending of a ranked game is counted once, and said with the change ----------

describe('every way a ranked game ends', () => {
  /** A small seeded random number generator, so that a failure can be replayed. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let x = s;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('records each game exactly once, and both players hear the end with its rating change (or that it was called off)', () => {
    const random = rng(18);
    const t = lobbyWithClock();
    const endings = new Map<string, number>();
    for (let n = 0; n < 300; n++) {
      // Fresh players each time, so that no pair reaches its daily limit.
      const ida = 1000 + n * 2;
      const idb = ida + 1;
      const a = t.queue(ida, `10.0.${n % 250}.1`);
      t.queue(idb, `10.1.${n % 250}.1`);
      const room = a.last('matched')!.room;
      const pa = t.sit(ida, room);
      const pb = t.sit(idb, room);
      const seat: Record<Side, Fake> = pa.last('joined')!.you === 'w' ? { w: pa, b: pb } : { w: pb, b: pa };
      const before = (n: number) => {
        const c = t.scores.get(playerKey(id(n)));
        return c ? c.wins + c.losses + c.draws : 0;
      };
      const counted = before(ida) + before(idb);
      const mirror = new Game();
      // Now and then the knights go back and forth, so that a draw may be claimed.
      const script = random() < 0.15 ? 'g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8'.split(' ').map(mv) : null;
      const plies = script ? script.length : Math.floor(random() * 40);
      const send = (side: Side, message: ClientMessage) => t.lobby.handle(seat[side], message);
      // The game is played out by random moves, with the clock now and then running down, and then ended one of many ways.
      for (let ply = 0; ply < plies && !mirror.status().over; ply++) {
        const legal = mirror.moves();
        const m = script?.[ply] ?? legal[Math.floor(random() * legal.length)]!;
        if (random() < 0.05) t.clock.pass(CLOCK_START / 4);
        send(mirror.turn(), { t: 'move', ply, move: m });
        if (t.lobby.watchedCount === 0) break;
        mirror.move(m.from, m.to, m.promotion);
        if (mirror.status().claimable && random() < 0.5) send(mirror.turn(), { t: 'claim' });
      }
      const how = Math.floor(random() * 6);
      const side: Side = random() < 0.5 ? 'w' : 'b';
      if (how === 0) send(side, { t: 'resign' });
      else if (how === 1) {
        send(side, { t: 'draw' });
        send(side === 'w' ? 'b' : 'w', { t: 'agree' });
      } else if (how === 2) t.lobby.leave(seat[side]);
      else if (how === 3) t.clock.pass(CLOCK_START * 3);
      else if (how === 4) send(mirror.turn(), { t: 'claim' });
      // Whatever is left is ended by a player's absence or the clock, and anything after the end changes nothing.
      t.clock.pass(ABANDON_AFTER * 2);
      t.lobby.tick();
      t.clock.pass(CLOCK_START * 3);
      t.lobby.tick();
      send('w', { t: 'resign' });
      send('b', { t: 'resign' });
      t.lobby.tick();

      // The room as each player last heard it, by whatever message told them.
      const last = (who: Fake) => (who.inbox.filter((m) => 'state' in m).at(-1) as Of<'state'>).state;
      const end = { w: last(seat.w), b: last(seat.b) };
      // A player who left heard nothing after: the one who stayed tells how it ended.
      const told = how === 2 ? end[side === 'w' ? 'b' : 'w'] : end.w;
      const why = told.ended === 'noshow' ? 'called off' : told.ended ?? (told.claimed ? 'claimed' : told.agreed ? 'agreed' : told.resigned ? 'resigned' : 'on the board');
      endings.set(why, (endings.get(why) ?? 0) + 1);
      const now = before(ida) + before(idb);
      if (told.ended === 'noshow') {
        expect(now, `game ${n}`).toBe(counted);
        expect(told.change).toBeNull();
      } else {
        expect(now, `game ${n} (${why})`).toBe(counted + 2);
        // Everyone still there heard the end with what it did to the ratings.
        for (const s of ['w', 'b'] as const) if (!(how === 2 && s === side)) expect(end[s].change, `game ${n} (${why}) for ${s}`).not.toBeNull();
      }
    }
    // Every kind of ending came up.
    for (const why of ['called off', 'time', 'left', 'claimed', 'agreed', 'resigned']) expect(endings.get(why) ?? 0, why).toBeGreaterThan(0);
  }, 60_000);
});

// -- over real sockets ----------------------------------------------------------------

interface Client {
  socket: WebSocket;
  heard: ServerMessage[];
  send(message: ClientMessage | string): void;
  next<T extends ServerMessage['t']>(t: T, limit?: number): Promise<Of<T>>;
  closed: Promise<{ code: number }>;
}

function connect(port: number, from?: string): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, from ? { headers: { 'x-real-ip': from } } : {});
  const heard: ServerMessage[] = [];
  const waiting: (() => void)[] = [];
  socket.on('message', (data) => {
    heard.push(JSON.parse(String(data)) as ServerMessage);
    for (const w of waiting.splice(0)) w();
  });
  const closed = new Promise<{ code: number }>((resolve) => socket.on('close', (code) => resolve({ code })));
  const client: Client = {
    socket,
    heard,
    closed,
    send: (m) => socket.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next: async <T extends ServerMessage['t']>(t: T, limit = 4000) => {
      const began = Date.now();
      for (;;) {
        const i = heard.findIndex((m) => m.t === t);
        if (i >= 0) return heard.splice(i, 1)[0] as Of<T>;
        if (Date.now() - began > limit) throw new Error(`No ${t} came`);
        await new Promise<void>((done) => {
          waiting.push(done);
          setTimeout(done, 50);
        });
      }
    },
  };
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(client));
    socket.once('error', reject);
  });
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('the server, over real sockets', () => {
  let running: Running;
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'nightpiece-hardening-'));
    mkdirSync(path.join(root, 'engine'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><noscript><style>.nojs{}</style></noscript><title>Nightpiece</title>');
    writeFileSync(path.join(root, 'engine', 'stockfish-19-lite-single.js'), '// the loader');
    for (const ext of ['flac', 'mp3', 'ico', 'webmanifest', 'webp', 'xml']) writeFileSync(path.join(root, `file.${ext}`), 'x');
    running = await startServer({ port: 0, root, behindProxy: true, perAddress: 1 });
  });
  afterAll(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('sends the security headers with every answer, the engine\'s worker and a missing file included', async () => {
    const base = `http://127.0.0.1:${running.port}`;
    // The page's one block of style is allowed by its hash (worked out apart from the server), and nothing else inline is.
    const policy = contentSecurityPolicy(['sha256-ylAivAqgRFhfgR+l420oZsN6z+AH7Rve64BtJRqi+tE=']);
    expect(inlineStyleHashes('<noscript><style>.nojs{}</style></noscript>')).toEqual(['sha256-ylAivAqgRFhfgR+l420oZsN6z+AH7Rve64BtJRqi+tE=']);
    expect(policy).toContain("style-src 'self' 'sha256-ylAivAqgRFhfgR+l420oZsN6z+AH7Rve64BtJRqi+tE='; ");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'; ");
    for (const url of ['/', '/engine/stockfish-19-lite-single.js', '/missing.js', '/../x']) {
      const response = await fetch(base + url);
      expect(response.headers.get('content-security-policy'), url).toBe(policy);
      expect(response.headers.get('referrer-policy'), url).toBe('no-referrer');
      expect(response.headers.get('permissions-policy'), url).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      expect(response.headers.get('cross-origin-opener-policy'), url).toBe('same-origin');
      expect(response.headers.get('x-frame-options'), url).toBe('DENY');
      expect(response.headers.get('x-content-type-options'), url).toBe('nosniff');
      // Over plain HTTP there is no promise to keep to HTTPS.
      expect(response.headers.get('strict-transport-security'), url).toBeNull();
      await response.arrayBuffer();
    }
    expect((await fetch(base, { method: 'POST' })).headers.get('x-frame-options')).toBe('DENY');
    // Reached over HTTPS, as the proxy in front says: keep to it.
    const secure = await fetch(`${base}/`, { headers: { 'x-forwarded-proto': 'https' } });
    expect(secure.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('names the kinds of the files it may serve', async () => {
    const kinds: Record<string, string> = { flac: 'audio/flac', mp3: 'audio/mpeg', ico: 'image/x-icon', webmanifest: 'application/manifest+json', webp: 'image/webp', xml: 'application/xml' };
    for (const [ext, kind] of Object.entries(kinds)) {
      const response = await fetch(`http://127.0.0.1:${running.port}/file.${ext}`);
      expect(response.headers.get('content-type'), ext).toContain(kind);
      await response.arrayBuffer();
    }
  });

  it('does not wait long for a visitor who is slow to ask', () => {
    expect(running.server.headersTimeout).toBe(10000);
    expect(running.server.requestTimeout).toBe(30000);
    // An error after the start is said, and lived through.
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    running.server.emit('error', new Error('a problem after the start'));
    expect(said).toHaveBeenCalledTimes(1);
    said.mockRestore();
  });

  it('counts an IPv6 visitor\'s whole block as one address', async () => {
    const one = await connect(running.port, '2001:db8:aa:bb::1');
    await expect(connect(running.port, '2001:db8:aa:bb::2')).rejects.toThrow(/429/);
    const other = await connect(running.port, '2001:db8:aa:cc::1');
    one.socket.close();
    other.socket.close();
    await Promise.all([one.closed, other.closed]);
  });

  it('answers sync once a second at most', async () => {
    const c = await connect(running.port, '198.51.100.50');
    c.send({ t: 'join', room: newRoomName() });
    await c.next('joined');
    for (let i = 0; i < 6; i++) c.send({ t: 'sync' });
    // The first is answered, as late as a busy machine makes it; the other five, sent with it, are not.
    await c.next('state');
    await pause(300);
    expect(c.heard.filter((m) => m.t === 'state')).toHaveLength(0);
    await pause(900);
    c.send({ t: 'sync' });
    await c.next('state');
    c.socket.close();
    await c.closed;
  });

  it('drops a connection that does not read what it is sent, before it piles up', async () => {
    const c = await connect(running.port, '198.51.100.51');
    c.send({ t: 'join', room: newRoomName() });
    await c.next('joined');
    // As if a quarter of a megabyte and more were already waiting to go to it.
    const piled = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(300 * 1024);
    try {
      c.send({ t: 'sync' });
      expect((await c.closed).code).toBe(1006);
    } finally {
      piled.mockRestore();
    }
  });

  it('closes only the connection whose message it could not handle, says so in one line, and carries on', async () => {
    const c = await connect(running.port, '198.51.100.52');
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = vi.spyOn(running.lobby, 'handle').mockImplementationOnce(() => {
      throw new Error('something unforeseen');
    });
    try {
      c.send({ t: 'hello', id: 'f'.repeat(32), name: 'Secret Name' });
      expect((await c.closed).code).toBe(1011);
      expect(said).toHaveBeenCalledTimes(1);
      const line = String(said.mock.calls[0]![0]);
      expect(line).toMatch(/^A message could not be handled: Error: something unforeseen/);
      expect(line).not.toContain('\n');
      expect(line).not.toContain('Secret');
      expect(line).not.toContain('198.51.100.52');
    } finally {
      handle.mockRestore();
      said.mockRestore();
    }
    const d = await connect(running.port, '198.51.100.53');
    d.send({ t: 'join', room: newRoomName() });
    expect((await d.next('joined')).you).toBe('w');
    d.socket.close();
    await d.closed;
  });

  it('reads the operator\'s list of words no name may hold from a file at the start', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightpiece-names-'));
    const file = path.join(dir, 'blocked-names.txt');
    writeFileSync(file, '# words\nrude\n\nNasty\n');
    const server = await startServer({ port: 0, root, blockedNamesFile: file });
    try {
      const c = await connect(server.port);
      c.send({ t: 'hello', id: 'e'.repeat(32), name: 'So Nasty' });
      expect((await c.next('welcome')).you.name).toBe(nameFor(playerKey('e'.repeat(32))));
      c.socket.close();
      await c.closed;
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -- a restart --------------------------------------------------------------------------

describe('a restart', () => {
  it('writes down the games being played, seat keys only as hashes, and takes them up again with the clocks stood still', () => {
    const t = lobbyWithClock();
    // A friendly game under way.
    const w = new Fake();
    const b = new Fake();
    t.lobby.handle(w, { t: 'hello', id: id(7), name: 'Ada' });
    t.lobby.handle(w, { t: 'join', room: 'ABCDEF' });
    t.lobby.handle(b, { t: 'join', room: 'ABCDEF' });
    t.lobby.handle(w, { t: 'move', ply: 0, move: mv('e2e4') });
    t.lobby.handle(b, { t: 'move', ply: 1, move: mv('e7e5') });
    t.lobby.handle(w, { t: 'draw' });
    const tokens = { w: w.last('joined')!.token, b: b.last('joined')!.token };
    // A ranked game under way, its clock running.
    const qa = t.queue(1, '198.51.100.1');
    t.queue(2, '198.51.100.2');
    const room = qa.last('matched')!.room;
    const pa = t.sit(1, room);
    const pb = t.sit(2, room);
    const rw = pa.last('joined')!.you === 'w' ? pa : pb;
    const whiteId = rw === pa ? 1 : 2;
    t.clock.pass(CLOCK_DELAY);
    t.lobby.handle(rw, { t: 'move', ply: 0, move: mv('d2d4') });
    t.clock.pass(10_000);
    // A room someone has sat down in is written down too, so that the seat is still theirs; one only watched is not.
    t.lobby.handle(new Fake(), { t: 'join', room: 'GHJKLM' });
    t.lobby.handle(new Fake(), { t: 'join', room: 'NPQRST', watch: true });

    const saved = t.lobby.save();
    const text = JSON.stringify(saved);
    expect(saved.rooms.map((r) => r.name).sort()).toEqual(['ABCDEF', 'GHJKLM', room].sort());
    for (const token of [...Object.values(tokens), rw.last('joined')!.token]) expect(text).not.toContain(token);
    expect(text).not.toContain(id(1));
    const ranked = saved.rooms.find((r) => r.ranked)!;
    // Written as it began to run, so that it reads the same however often it is written; charged up to the stop when taken up.
    expect(ranked.left.b).toBe(CLOCK_START);
    expect(ranked.since).toBe(saved.savedAt - 10_000);

    // The next server, a while later.
    const next = lobbyWithClock();
    next.clock.pass(5 * 60_000);
    expect(next.lobby.restore(saved)).toBe(3);
    // A friendly seat comes back by its window's key, with the game and the offer as they were.
    const back = new Fake();
    next.lobby.handle(back, { t: 'join', room: 'ABCDEF', token: tokens.w });
    expect(back.last('joined')).toMatchObject({ you: 'w', token: tokens.w, state: { moves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }], drawOffer: 'w', players: { w: { name: 'Ada' } } } });
    // A key that is not one gets no seat.
    const thief = new Fake();
    next.lobby.handle(thief, { t: 'join', room: 'ABCDEF', token: 'a'.repeat(32) });
    expect(thief.last('joined')!.you).toBe('spectator');
    expect(thief.last('joined')!.state.taken).toEqual({ w: true, b: true });

    // The ranked clocks stand still while the player to move is not back (for a few seconds at most: see tests/restart.test.ts).
    const one = next.sit(whiteId, room);
    next.clock.pass(10_000);
    next.lobby.tick();
    expect(one.last('joined')!.state.clock).toEqual({ left: { w: ranked.left.w, b: CLOCK_START - 10_000 }, running: null });
    const two = next.sit(whiteId === 1 ? 2 : 1, room);
    expect(two.last('joined')!.you).toBe('b');
    next.clock.pass(1000);
    next.lobby.handle(two, { t: 'sync' });
    expect(two.last('state')!.state.clock).toEqual({ left: { w: ranked.left.w, b: CLOCK_START - 11_000 }, running: 'b' });
  });

  it('gives each player the usual time to come back before a ranked game counts against them', () => {
    const t = lobbyWithClock();
    const qa = t.queue(1, '198.51.100.1');
    t.queue(2, '198.51.100.2');
    const room = qa.last('matched')!.room;
    const pa = t.sit(1, room);
    const pb = t.sit(2, room);
    const [rw, rb] = pa.last('joined')!.you === 'w' ? [pa, pb] : [pb, pa];
    t.lobby.handle(rw, { t: 'move', ply: 0, move: mv('d2d4') });
    t.lobby.handle(rb, { t: 'move', ply: 1, move: mv('d7d5') });
    const saved = t.lobby.save();
    const next = lobbyWithClock();
    next.lobby.restore(saved);
    const whiteId = rw === pa ? 1 : 2;
    const back = next.sit(whiteId, room);
    next.clock.pass(ABANDON_AFTER - 1000);
    next.lobby.tick();
    expect(back.last('state')?.state.ended ?? null).toBeNull();
    next.clock.pass(2000);
    next.lobby.tick();
    expect(back.last('state')!.state).toMatchObject({ ended: 'left', change: { w: 16, b: -16 } });
  });

  it('over real sockets: written as it is played, read when the server starts (if it stopped within the hour)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightpiece-rooms-'));
    const roomsFile = path.join(dir, 'rooms.json');
    try {
      const first = await startServer({ port: 0, root: 'no-such-folder', roomsFile });
      const room = newRoomName();
      const w = await connect(first.port);
      w.send({ t: 'join', room });
      const token = (await w.next('joined')).token;
      const b = await connect(first.port);
      b.send({ t: 'join', room });
      await b.next('joined');
      w.send({ t: 'move', ply: 0, move: mv('g1f3') });
      await b.next('moved');
      // Written down before anyone was told, seat keys only as hashes.
      expect(readFileSync(path.join(dir, 'rooms.journal'), 'utf8')).toContain('"g1","to":"f3"');
      await first.close();
      expect(readFileSync(roomsFile, 'utf8')).not.toContain(token);

      const second = await startServer({ port: 0, root: 'no-such-folder', roomsFile });
      expect(existsSync(roomsFile)).toBe(true);
      const again = await connect(second.port);
      again.send({ t: 'join', room, token });
      const joined = await again.next('joined');
      expect(joined).toMatchObject({ you: 'w', token, state: { moves: [{ from: 'g1', to: 'f3' }] } });
      // Written once more at the stop, and too old to be taken up the time after.
      await second.close();
      const data = JSON.parse(readFileSync(roomsFile, 'utf8')) as { savedAt: number };
      writeFileSync(roomsFile, JSON.stringify({ ...data, savedAt: Date.now() - 61 * 60_000 }));
      const third = await startServer({ port: 0, root: 'no-such-folder', roomsFile });
      expect(third.lobby.roomCount).toBe(0);
      await third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
