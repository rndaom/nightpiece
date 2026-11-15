/**
 * The beginning and the end of a game against someone else: the players coming to the board, and
 * what the result card is told of how the game ended. Through the real server, as in
 * tests/app.test.ts (see tests/helpers/app-rig.ts for what is stood in for); ranked games through
 * the real queue.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
import { WebSocketServer, WebSocket as Ws } from 'ws';
import { type Running, startServer } from '../server/main.ts';
import { CLOCK_INCREMENT, CLOCK_START } from '../server/rooms.ts';
import type { Cause, Outcome } from '../src/app/store.ts';
import type { DrawReason } from '../src/core/game.ts';
import { type ClientMessage, newRoomName, type RoomState, type ServerMessage } from '../src/net/protocol.ts';
import { boot, type Rig, stubBrowser } from './helpers/app-rig.ts';

vi.mock('../src/scene/world.ts', async () => ({ World: (await import('./helpers/app-rig.ts')).FakeWorld }));
vi.mock('../src/scene/post.ts', () => ({ suggestQuality: () => 'low', QUALITY: {} }));
vi.mock('../src/scene/assets.ts', () => ({ loadAssets: () => Promise.reject(new Error('no assets under test')) }));
vi.mock('../src/hands/hand.ts', () => ({ loadHandTemplate: () => Promise.reject(new Error('no hands under test')) }));
vi.mock('../src/audio/sound.ts', () => ({ Sound: class {} }));
vi.mock('../src/engine/browser.ts', async () => {
  const { shared } = await import('./helpers/app-rig.ts');
  return { startEngine: () => shared.startEngine() };
});

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Keep the game's clock and the real one moving together until `test` holds. */
async function eventually(rig: Rig, test: () => boolean, limit = 6000): Promise<void> {
  const began = Date.now();
  while (!test() && Date.now() - began < limit) {
    await rig.run(0.1);
    await pause(8);
  }
  if (!test()) throw new Error('It never happened');
}

const moves = (rig: Rig) => rig.app.game.history().map((e) => e.san);
const play = (rig: Rig, from: string, to: string) => {
  rig.app.click(from as 'e2');
  rig.app.click(to as 'e4');
};

/** The other player: a bare connection that says only what the test tells it to. Given an id, it says who it is first, as a ranked seat needs. */
class Opponent {
  state: RoomState | null = null;
  heard: ServerMessage[] = [];
  private socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(port: number, room: string, options: { watch?: boolean; id?: string } = {}) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ready = new Promise((resolve) => {
      this.socket.addEventListener('open', () => {
        if (options.id) this.send({ t: 'hello', id: options.id });
        this.send({ t: 'join', room, ...(options.watch ? { watch: true } : {}) });
      });
      this.socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        this.heard.push(message);
        if ('state' in message) this.state = message.state;
        if (message.t === 'joined') resolve();
      });
    });
  }
  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }
  move(text: string, ply: number): void {
    this.send({ t: 'move', ply, move: { from: text.slice(0, 2) as 'e2', to: text.slice(2, 4) as 'e4' } });
  }
  close(): void {
    this.socket.close();
  }
}

/** Someone waiting in the queue, by a connection of their own, until they are matched: then the room. */
function queueUp(port: number, id: string, name: string): { matched: Promise<string>; close: () => void } {
  const socket = new Ws(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-real-ip': '198.51.100.9' } });
  const matched = new Promise<string>((resolve) => {
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ t: 'hello', id, name } satisfies ClientMessage));
      socket.send(JSON.stringify({ t: 'queue' } satisfies ClientMessage));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.t === 'matched') resolve(message.room);
    });
  });
  return { matched, close: () => socket.close() };
}

beforeAll(() => {
  stubBrowser();
  const warn = console.warn.bind(console);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && /Could not load the (hands|finished assets)|chess engine could not be started/.test(args[0])) return;
    warn(...args);
  });
});

describe('the start and the end of a game against someone else', () => {
  let running: Running;
  const others: { close: () => void }[] = [];
  const meet = async (room: string, options: { watch?: boolean; id?: string } = {}) => {
    const o = new Opponent(running.port, room, options);
    others.push(o);
    await o.ready;
    return o;
  };
  const address = (room: string, watch = false) => `http://127.0.0.1:${running.port}/?room=${room}${watch ? '&watch=1' : ''}`;

  beforeAll(async () => {
    // Behind a (pretend) proxy, so that the rival can be from another address: one address is never matched with itself.
    running = await startServer({ port: 0, root: 'no-such-folder', behindProxy: true });
  });
  afterAll(async () => {
    for (const o of others) o.close();
    await running.close();
  });

  /** A friendly room with this screen at Ivory and a bare connection at Void, and how it began. */
  async function friendly(): Promise<{ rig: Rig; other: Opponent; room: string }> {
    const room = newRoomName();
    const rig = await boot({ address: address(room) });
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    // Alone in the room, nobody has come to the board yet.
    await rig.run(0.5);
    expect(rig.ui.intro.value).toBeNull();
    const other = await meet(room);
    await eventually(rig, () => rig.ui.online.value?.taken.b === true);
    return { rig, other, room };
  }

  it('ends the game here too when the other player claims a draw by repetition, and a screen opened afterwards shows it ended so', async () => {
    const { rig, other, room } = await friendly();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    const white = ['g1f3', 'f3g1', 'g1f3', 'f3g1', 'g1f3'];
    const black = ['g8f6', 'f6g8', 'g8f6', 'f6g8'];
    for (let ply = 0; ply < 9; ply++) {
      if (ply % 2 === 0) {
        await eventually(rig, () => rig.app.game.turn() === 'w' && moves(rig).length === ply);
        await rig.run(1.5);
        const m = white[ply / 2]!;
        play(rig, m.slice(0, 2), m.slice(2, 4));
      } else {
        other.move(black[(ply - 1) / 2]!, ply);
      }
      await eventually(rig, () => moves(rig).length === ply + 1);
    }
    // The knight's square after White's move has stood three times, and Void, to move, claims the draw.
    expect(rig.app.game.status()).toMatchObject({ over: false, claimable: 'threefold' });
    other.send({ t: 'claim' });
    await eventually(rig, () => rig.ui.status.value.over);
    expect(rig.ui.status.value).toMatchObject({ result: 'draw', drawReason: 'threefold' });
    const late = await meet(room, { watch: true });
    expect(late.state).toMatchObject({ claimed: 'threefold' });
  });

  it('shows the players coming to the board when the second sits down, and puts it away by itself', async () => {
    const { rig } = await friendly();
    expect(rig.ui.intro.value).toMatchObject({ ranked: false, you: 'w', clock: null });
    await rig.run(2.5);
    expect(rig.ui.intro.value).not.toBeNull();
    await rig.run(1.2);
    expect(rig.ui.intro.value).toBeNull();
    // Once a game: someone coming or going does not show it again.
    await rig.run(1);
    expect(rig.ui.intro.value).toBeNull();
  });

  it('puts it away at a click, and at a move from either side', async () => {
    const first = await friendly();
    expect(first.rig.ui.intro.value).not.toBeNull();
    first.rig.app.click(null);
    expect(first.rig.ui.intro.value).toBeNull();

    // A move made here, at once.
    const second = await friendly();
    expect(second.rig.ui.intro.value).not.toBeNull();
    play(second.rig, 'e2', 'e4');
    expect(second.rig.ui.intro.value).toBeNull();
    expect(moves(second.rig)).toEqual(['e4']);

    // And the other player's: watched from a third screen, which is shown it too, without a side of its own.
    const watcher = await boot({ address: address(second.room, true) });
    await eventually(watcher, () => watcher.ui.online.value?.seat === 'spectator');
    // The game has begun by now, so there is nothing to show.
    await watcher.run(0.5);
    expect(watcher.ui.intro.value).toBeNull();
    const third = await friendly();
    const spectator = await boot({ address: address(third.room, true) });
    await eventually(spectator, () => spectator.ui.online.value?.seat === 'spectator' && spectator.ui.intro.value !== null);
    expect(spectator.ui.intro.value).toMatchObject({ you: null, ranked: false });
    play(third.rig, 'd2', 'd4');
    await eventually(spectator, () => moves(spectator).length === 1);
    expect(spectator.ui.intro.value).toBeNull();
  });

  it('tells the result card how a friendly game ended, still offers another, and clears what was said before', async () => {
    const { rig, other } = await friendly();
    const t0 = performance.now();
    play(rig, 'e2', 'e4');
    await eventually(rig, () => other.heard.some((m) => m.t === 'moved'));
    other.move('e7e5', 1);
    await eventually(rig, () => moves(rig).length === 2 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    play(rig, 'g1', 'f3');
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 3);
    // A draw offered and turned down: said in red.
    other.move('b8c6', 3);
    await eventually(rig, () => moves(rig).length === 4 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    rig.app.offerDraw();
    await eventually(rig, () => rig.ui.online.value?.offer === 'w');
    other.send({ t: 'nodraw' });
    await eventually(rig, () => rig.ui.notice.value !== null);
    expect(rig.ui.notice.value).toBe('Void would rather play on.');
    // Void then gives up: the refusal is old news, and the card says how it ended.
    other.send({ t: 'resign' });
    await eventually(rig, () => rig.ui.status.value.over);
    const lasted = performance.now() - t0;
    expect(rig.ui.notice.value).toBeNull();
    await eventually(rig, () => rig.ui.resultVisible.value);
    const { outcome } = await import('../src/app/store.ts');
    expect(outcome.value).toMatchObject({ result: 'resigned', winner: 'w', cause: 'resigned', move: 2, rating: null });
    expect(outcome.value!.duration).toBeGreaterThan(0);
    expect(outcome.value!.duration).toBeLessThanOrEqual(lasted);
    // Among friends, another game in the same room is asked for.
    rig.app.newGame();
    await eventually(rig, () => other.state?.again.w === true);
    other.send({ t: 'again' });
    await eventually(rig, () => rig.ui.online.value?.seat === 'b');
    // And it begins as the first did, with the sides changed.
    await eventually(rig, () => rig.ui.intro.value !== null);
    expect(rig.ui.intro.value).toMatchObject({ you: 'b' });
    expect(outcome.value).toBeNull();
  });

  it('says how a game ended for each way there is to end one', async () => {
    const { causeOf } = await import('../src/app/store.ts');
    const over = (result: 'checkmate' | 'draw' | 'resigned', drawReason: DrawReason | null = null) => ({
      turn: 'w' as const,
      inCheck: false,
      checkedKing: null,
      checkers: [],
      over: true,
      result,
      winner: result === 'draw' ? null : ('b' as const),
      drawReason,
      claimable: null,
    });
    expect(causeOf(over('checkmate'), null)).toBe('checkmate');
    expect(causeOf(over('resigned'), null)).toBe('resigned');
    expect(causeOf(over('resigned'), 'time')).toBe('time');
    expect(causeOf(over('resigned'), 'left')).toBe('left');
    expect(causeOf(over('draw', 'stalemate'), null)).toBe('stalemate');
    expect(causeOf(over('draw', 'agreement'), null)).toBe('agreement');
    expect(causeOf(over('draw', 'threefold'), null)).toBe('repetition');
    expect(causeOf(over('draw', 'fifty-move'), null)).toBe('fifty');
    expect(causeOf(over('draw', 'insufficient'), null)).toBe('material');
    // Those the game ends by itself, and a draw because time ran out against a side that could not have been mated.
    expect(causeOf(over('draw', 'fivefold'), null)).toBe('fivefold');
    expect(causeOf(over('draw', 'seventy-five-move'), null)).toBe('seventy-five');
    expect(causeOf(over('draw', 'timeout'), 'time')).toBe('time');
    expect(causeOf({ ...over('checkmate'), over: false, result: null, winner: null }, 'noshow')).toBe('noshow');

    // And the words the result card says them in.
    // Reached by a name made at run time, as tests/result-card.test.ts reaches the cards: the tests are type-checked without JSX.
    const folder = '../src/ui/';
    const { howOf } = (await import(/* @vite-ignore */ `${folder}Match.tsx`)) as { howOf: (o: Outcome, you: 'w' | 'b' | null) => string };
    const ended = (cause: Cause, winner: 'w' | 'b' | null = null, flagged: 'w' | 'b' | null = null): Outcome => ({ result: winner ? 'resigned' : 'draw', winner, cause, move: 40, duration: null, rating: null, flagged });
    expect(howOf(ended('repetition'), 'w')).toBe('Draw by repetition (claimed) · move 40');
    expect(howOf(ended('fifty'), 'w')).toBe('Draw by the fifty-move rule (claimed) · move 40');
    expect(howOf(ended('fivefold'), null)).toBe('Draw: the position came up five times · move 40');
    expect(howOf(ended('seventy-five'), null)).toBe('Draw: seventy-five moves without a capture or a pawn move · move 40');
    expect(howOf(ended('time', null, 'b'), null)).toBe('Draw: Void ran out of time, but Ivory could not have mated · move 40');
    expect(howOf(ended('time', null, 'b'), 'b')).toBe('Draw: you ran out of time, but Ivory could not have mated · move 40');
    expect(howOf(ended('time', 'w', 'b'), 'w')).toBe('Void ran out of time · move 40');
    expect(howOf({ ...ended('noshow'), move: null }, 'w')).toBe('Called off, unrated');
  });

  it('in a ranked game: shows the terms from the clock, counts the rating, and offers another match, never another game with the same player', async () => {
    const rig = await boot({ address: `http://127.0.0.1:${running.port}/` });
    rig.app.rename('Abcdefghijklmnop');
    rig.app.findMatch();
    await eventually(rig, () => rig.ui.queue.value?.up === true);
    const rival = queueUp(running.port, 'c'.repeat(32), 'Qrstuvwxyzabcdef');
    others.push(rival);
    const room = await rival.matched;
    await eventually(rig, () => rig.ui.online.value?.room === room && rig.ui.online.value.seat !== null);
    const other = await meet(room, { id: 'c'.repeat(32) });
    await eventually(rig, () => rig.ui.intro.value !== null);
    const you = rig.ui.you.value!;
    const them = you === 'w' ? 'b' : 'w';
    // The terms are the server's own, read from the clock (and the increment, which the clock does not say, kept in step with the server's).
    expect(rig.ui.intro.value).toMatchObject({ ranked: true, you, clock: { base: CLOCK_START, increment: CLOCK_INCREMENT } });
    expect(rig.ui.intro.value!.players[you]).toMatchObject({ name: 'Abcdefghijklmnop', rating: 1200 });
    expect(rig.ui.intro.value!.players[them]).toMatchObject({ name: 'Qrstuvwxyzabcdef', rating: 1200 });

    // Three moves, whoever has Ivory, and the player here gives up.
    const line = ['e2e4', 'e7e5', 'g1f3'];
    for (let ply = 0; ply < line.length; ply++) {
      const m = line[ply]!;
      if ((ply % 2 === 0 ? 'w' : 'b') === you) {
        await eventually(rig, () => rig.app.game.turn() === you && rig.ui.online.value?.link === 'open');
        play(rig, m.slice(0, 2), m.slice(2, 4));
      } else {
        other.move(m, ply);
      }
      await eventually(rig, () => moves(rig).length === ply + 1);
      await rig.run(1.5);
    }
    rig.app.askResign();
    rig.app.answerAsk(true);
    await eventually(rig, () => rig.ui.status.value.over);
    const { outcome } = await import('../src/app/store.ts');
    await eventually(rig, () => outcome.value?.rating !== null && outcome.value?.rating !== undefined);
    expect(outcome.value).toMatchObject({ result: 'resigned', winner: them, cause: 'resigned', move: 2 });
    const { before, after } = outcome.value!.rating!;
    expect(before).toBe(1200);
    expect(after).toBeLessThan(before);
    expect(outcome.value!.duration).toBeGreaterThan(0);
    await eventually(rig, () => rig.ui.resultVisible.value);

    // "Play again", by whatever way it is asked for, never asks this player for another game: it looks for another match.
    const net = (rig.app as unknown as { net: { again: () => boolean } }).net;
    const again = vi.spyOn(net, 'again');
    rig.app.newGame();
    expect(again).not.toHaveBeenCalled();
    expect(rig.ui.queue.value).not.toBeNull();
    expect(rig.ui.mode.value.kind).toBe('table');
    expect(rig.ui.online.value).toBeNull();
    await pause(150);
    expect(other.state?.again).toEqual({ w: false, b: false });
    rig.app.cancelMatch();
  });
});

describe('a claim, from this screen', () => {
  let running: Running;
  const others: { close: () => void }[] = [];
  beforeAll(async () => {
    running = await startServer({ port: 0, root: 'no-such-folder' });
  });
  afterAll(async () => {
    for (const o of others) o.close();
    await running.close();
  });

  it('is sent to the server, which draws the game for both', async () => {
    const room = newRoomName();
    const rig = await boot({ address: `http://127.0.0.1:${running.port}/?room=${room}` });
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    const other = new Opponent(running.port, room);
    others.push(other);
    await other.ready;
    await eventually(rig, () => rig.ui.online.value?.taken.b === true);
    const white = ['g1f3', 'f3g1', 'g1f3', 'f3g1'];
    const black = ['g8f6', 'f6g8', 'g8f6', 'f6g8'];
    for (let ply = 0; ply < 8; ply++) {
      if (ply % 2 === 0) {
        await eventually(rig, () => rig.app.game.turn() === 'w' && moves(rig).length === ply);
        await rig.run(1.5);
        const m = white[ply / 2]!;
        play(rig, m.slice(0, 2), m.slice(2, 4));
      } else {
        // Before the third time, nothing may be claimed: the button offers a draw.
        expect(rig.ui.canClaim.value).toBeNull();
        other.move(black[(ply - 1) / 2]!, ply);
      }
      await eventually(rig, () => moves(rig).length === ply + 1);
    }
    await rig.run(1.5);
    // The first position for the third time, Ivory to move: the Draw button claims.
    expect(rig.ui.canClaim.value).toBe('threefold');
    rig.app.askDraw();
    expect(rig.ui.asking.value).toBe('claim');
    rig.app.answerAsk(true);
    await eventually(rig, () => rig.ui.status.value.over);
    expect(rig.ui.status.value).toMatchObject({ result: 'draw', drawReason: 'threefold' });
    await eventually(rig, () => other.state?.claimed === 'threefold');
    const { outcome } = await import('../src/app/store.ts');
    expect(outcome.value).toMatchObject({ cause: 'repetition', winner: null });
  });
});

/**
 * A server that says only what a test tells it to: for what the real one says rarely or never on
 * cue (a turn away from the queue, a room come back after a restart), and for one that says
 * nothing at all.
 */
class Scripted {
  readonly heard: ClientMessage[] = [];
  readonly sockets: Ws[] = [];
  /** How many connections have been made to it. */
  connections = 0;
  /** What it answers each message with, if anything. */
  answer: (message: ClientMessage, socket: Ws) => void = () => {};
  private constructor(private server: WebSocketServer) {
    server.on('connection', (socket) => {
      this.connections++;
      this.sockets.push(socket);
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as ClientMessage;
        this.heard.push(message);
        this.answer(message, socket);
      });
    });
  }
  static start(port = 0): Promise<Scripted> {
    return new Promise((resolve) => {
      const server: WebSocketServer = new WebSocketServer({ port, host: '127.0.0.1' }, () => resolve(new Scripted(server)));
    });
  }
  get port(): number {
    return (this.server.address() as { port: number }).port;
  }
  say(socket: Ws, message: ServerMessage): void {
    socket.send(JSON.stringify(message));
  }
  close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** A room as the server describes it, with whatever a test needs said differently. */
function roomState(part: Partial<RoomState> = {}): RoomState {
  return {
    room: 'ABCDEF',
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: [],
    present: { w: true, b: true },
    taken: { w: true, b: true },
    watching: 0,
    again: { w: false, b: false },
    resigned: null,
    drawOffer: null,
    agreed: false,
    claimed: null,
    ranked: false,
    players: { w: null, b: null },
    clock: null,
    ended: null,
    change: null,
    ...part,
  };
}

/** The Room card's words, as they would be drawn now. */
async function roomLine(rig: Rig): Promise<string> {
  const folder = '../src/ui/';
  const { Room } = (await import(/* @vite-ignore */ `${folder}Cards.tsx`)) as { Room: (props: { app: unknown }) => VNode | null };
  const card = Room({ app: rig.app });
  const said: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'string') return void said.push(node);
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    walk((node as VNode<{ children?: unknown }>).props.children);
  };
  walk(card);
  return said.join(' | ');
}

describe('what the server says that is not a move', () => {
  let server: Scripted;
  beforeAll(async () => {
    server = await Scripted.start();
  });
  afterAll(async () => {
    await server.close();
  });
  const at = (room?: string) => `http://127.0.0.1:${server.port}/${room ? `?room=${room}` : ''}`;

  it('turned away from the queue: says why, stops saying it is waiting, and lets the player try again', async () => {
    server.answer = (m, socket) => {
      if (m.t === 'hello') server.say(socket, { t: 'welcome', you: { name: 'Ash', rating: 1200, wins: 0, losses: 0, draws: 0 } });
      if (m.t === 'queue') server.say(socket, { t: 'turned', reason: 'Too many are waiting for a game just now. Try again in a little while.' });
    };
    const rig = await boot({ address: at() });
    rig.app.findMatch();
    await eventually(rig, () => rig.ui.turned.value !== null);
    expect(rig.ui.queue.value).toBeNull();
    expect(rig.ui.turned.value).toMatchObject({ reason: 'Too many are waiting for a game just now. Try again in a little while.', until: null });
    // Nothing stands in the way of trying again.
    server.answer = (m, socket) => {
      if (m.t === 'queue') server.say(socket, { t: 'queued', waiting: 1 });
    };
    rig.app.findMatch();
    expect(rig.ui.turned.value).toBeNull();
    await eventually(rig, () => rig.ui.queue.value?.up === true);
    rig.app.cancelMatch();
  });

  it('told to wait: says when the wait is over by the clock, will not queue before then, and opens again by itself', async () => {
    server.answer = (m, socket) => {
      if (m.t === 'queue') server.say(socket, { t: 'turned', reason: 'Too many of your games were called off lately. You can look for another in 10 minutes.', until: 400 });
    };
    const rig = await boot({ address: at() });
    const asked = server.heard.length;
    rig.app.findMatch();
    await eventually(rig, () => rig.ui.turned.value !== null);
    const turned = rig.ui.turned.value!;
    expect(turned.until).toBeGreaterThan(Date.now());
    const folder = '../src/ui/';
    const { turnedWords, clockTime } = (await import(/* @vite-ignore */ `${folder}Cards.tsx`)) as { turnedWords: (t: object) => string; clockTime: (at: number) => string };
    expect(turnedWords(turned)).toBe(`Too many of your games were called off lately. You can queue again at ${clockTime(turned.until!)}.`);
    expect(clockTime(new Date(2026, 10, 12, 21, 14).getTime())).toBe('21:14');
    // Asked again too soon: nothing is sent.
    const queues = () => server.heard.slice(asked).filter((m) => m.t === 'queue').length;
    rig.app.findMatch();
    expect(queues()).toBe(1);
    expect(rig.ui.queue.value).toBeNull();
    // The card can be put away; the choice of game still says it until the wait is over.
    rig.app.dismissTurned();
    expect(rig.ui.turned.value).toMatchObject({ away: true });
    await pause(500);
    expect(rig.ui.turned.value).toBeNull();
  });

  it('keeps both clocks whole and still while the game waits to start, and says it will in a moment', async () => {
    const room = newRoomName();
    const clock = { left: { w: CLOCK_START, b: CLOCK_START }, running: null };
    server.answer = (m, socket) => {
      if (m.t === 'join') server.say(socket, { t: 'joined', you: 'w', token: 'a'.repeat(32), state: roomState({ room, ranked: true, clock, players: { w: { name: 'Ash', rating: 1200 }, b: { name: 'Bo', rating: 1200 } } }) });
    };
    const rig = await boot({ address: at(room) });
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    await pause(300);
    const folder = '../src/ui/';
    const { clockShown } = (await import(/* @vite-ignore */ `${folder}Cards.tsx`)) as { clockShown: (c: unknown, side: string, now: number) => number };
    const o = rig.ui.online.value!;
    expect(o.clock?.running).toBeNull();
    expect(clockShown(o.clock, 'w', performance.now() + 60000)).toBe(CLOCK_START);
    expect(clockShown(o.clock, 'b', performance.now() + 60000)).toBe(CLOCK_START);
    expect(await roomLine(rig)).toContain('The clocks start in a moment.');
    // Once the server says Ivory's has started, it runs.
    const running = { ...o.clock!, running: 'w' as const, at: performance.now() - 2000 };
    expect(clockShown(running, 'w', performance.now())).toBeLessThan(CLOCK_START - 1500);
  });

  it('after a restart, says the clocks start again in a moment; and says so plainly if the game was lost', async () => {
    // Waits on the page's own reconnecting and a second of quiet, which a busy machine stretches: it is given the time that needs.
    const room = newRoomName();
    // The game as it was: two moves played, both at the board.
    let state = roomState({ room, moves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }], ranked: true, clock: { left: { w: 590000, b: 595000 }, running: 'w' }, players: { w: { name: 'Ash', rating: 1200 }, b: { name: 'Bo', rating: 1200 } } });
    server.answer = (m, socket) => {
      if (m.t === 'join') server.say(socket, { t: 'joined', you: 'w', token: 'a'.repeat(32), state });
    };
    const rig = await boot({ address: at(room) });
    await eventually(rig, () => moves(rig).length === 2);
    // The server restarts: the clocks are still, the other player not yet back.
    state = { ...state, present: { w: true, b: false }, clock: { left: { w: 590000, b: 595000 }, running: null } };
    for (const s of server.sockets) s.terminate();
    await eventually(rig, () => rig.ui.online.value?.link === 'open' && rig.ui.online.value.clock?.running === null);
    expect(await roomLine(rig)).toContain('The server restarted. The clocks start again in a moment.');
    expect(moves(rig)).toEqual(['e4', 'e5']);

    // Again, and this time what it wrote down was lost: the room it has is new and empty.
    state = roomState({ room, taken: { w: true, b: false }, present: { w: true, b: false } });
    const joins = () => server.heard.filter((m) => m.t === 'join' && m.room === room).length;
    const before = joins();
    for (const s of server.sockets) s.terminate();
    await eventually(rig, () => rig.ui.online.value?.closed !== null);
    expect(rig.ui.online.value?.closed).toBe('The server restarted and this game could not be recovered.');
    // The board is left as the game stood, not emptied, and the room is not asked for again.
    expect(moves(rig)).toEqual(['e4', 'e5']);
    expect(joins()).toBe(before + 1);
    await pause(1000);
    expect(joins()).toBe(before + 1);
    expect(rig.app.canResign()).toBe(false);
    rig.app.leaveRoom();
    expect(rig.ui.menuOpen.value).toBe(true);
    expect(rig.ui.online.value).toBeNull();
  }, 30000);

  it('turned away at the door of a game called off or over: a plain card with the way back, not an empty board', async () => {
    for (const [reason, said] of [
      ['This game was called off.', 'This game was called off. It was not rated.'],
      ['This game is over.', 'This game is over.'],
    ] as const) {
      const room = newRoomName();
      server.answer = (m, socket) => {
        if (m.t === 'join') server.say(socket, { t: 'refused', reason, state: roomState({ room, ranked: true, ended: 'noshow' }) });
      };
      const rig = await boot({ address: at(room) });
      await eventually(rig, () => rig.ui.online.value?.closed !== null);
      expect(rig.ui.online.value?.closed).toBe(said);
      // The card for the room stands aside for it.
      expect(await roomLine(rig)).toBe('');
    }
  });

  it('a line that drops after the game was reached is a brief interruption, not a server that cannot be reached, until it has been down a long while', async () => {
    const host = await Scripted.start();
    const room = newRoomName();
    host.answer = (m, socket) => {
      if (m.t === 'join') host.say(socket, { t: 'joined', you: 'w', token: 'a'.repeat(32), state: roomState({ room, taken: { w: true, b: true }, present: { w: true, b: true } }) });
    };
    const rig = await boot({ address: `http://127.0.0.1:${host.port}/?room=${room}` });
    // Imported once the game is booted, which loads them afresh.
    const app = await import('../src/app/app.ts');
    const folder = '../src/ui/';
    const cards = (await import(/* @vite-ignore */ `${folder}Cards.tsx`)) as { interruption: { longest: number } };
    app.patience.reach = 300;
    cards.interruption.longest = 2500;
    try {
      await eventually(rig, () => rig.ui.online.value?.link === 'open');
      // The server goes away (a new version being put up).
      for (const socket of host.sockets) socket.terminate();
      await host.close();
      await eventually(rig, () => rig.ui.online.value?.stuck === true);
      expect(await roomLine(rig)).toContain('The connection was interrupted. Reconnecting…');
      expect(await roomLine(rig)).not.toContain("Can't reach");
      // Down a long while: said plainly, with the way to try again.
      const began = Date.now();
      while (!(await roomLine(rig)).includes("Can't reach the game server") && Date.now() - began < 12000) {
        await rig.run(0.1);
        await pause(50);
      }
      expect(await roomLine(rig)).toContain("Can't reach the game server right now.");
      expect(await roomLine(rig)).toContain('Try again');
    } finally {
      app.patience.reach = 8000;
      cards.interruption.longest = 60000;
      rig.app.leaveRoom();
    }
  }, 30000);

  it("says when the server cannot be reached, offers to try again, and comes back by itself when it can", async () => {
    const { patience } = await import('../src/app/app.ts');
    // A port with nothing listening on it, for now.
    const later = await Scripted.start();
    const port = later.port;
    await later.close();
    const room = newRoomName();
    const rig = await boot({ address: `http://127.0.0.1:${port}/?room=${room}` });
    const app = await import('../src/app/app.ts');
    app.patience.reach = 300;
    void patience;
    // Joining a friend's room.
    rig.app.leaveRoom();
    rig.app.startOnline(room);
    expect(await roomLine(rig)).toContain('Joining…');
    await eventually(rig, () => rig.ui.online.value?.stuck === true);
    expect(await roomLine(rig)).toContain("Can't reach the game server right now.");
    expect(await roomLine(rig)).toContain('Try again');
    // Finding a match, and the rankings.
    rig.app.findMatch();
    expect(rig.ui.queue.value).toMatchObject({ up: false });
    rig.app.showRanks(true);
    await eventually(rig, () => rig.ui.unreachable.value);
    // Trying again says it is trying, and says it cannot reach the server again if it still cannot.
    rig.app.retryServer();
    expect(rig.ui.unreachable.value).toBe(false);
    expect(rig.ui.online.value?.stuck).toBe(false);
    await eventually(rig, () => rig.ui.unreachable.value && rig.ui.online.value?.stuck === true);
    // The server comes up: both find it by themselves.
    const back = await Scripted.start(port);
    back.answer = (m, socket) => {
      if (m.t === 'join') back.say(socket, { t: 'joined', you: 'w', token: 'a'.repeat(32), state: roomState({ room, taken: { w: true, b: false }, present: { w: true, b: false } }) });
      if (m.t === 'queue') back.say(socket, { t: 'queued', waiting: 1 });
      if (m.t === 'board') back.say(socket, { t: 'board', top: [], you: null });
    };
    try {
      await eventually(rig, () => rig.ui.online.value?.link === 'open' && rig.ui.queue.value?.up === true && rig.ui.ranks.value !== null, 12000);
      expect(rig.ui.unreachable.value).toBe(false);
      expect(rig.ui.online.value?.stuck).toBe(false);
      rig.app.cancelMatch();
    } finally {
      app.patience.reach = 8000;
      rig.app.leaveRoom();
      await back.close();
    }
  }, 30000);

  it('a connection that has gone silent while the page was hidden is found out at once when it is shown again', async () => {
    const { Net } = await import('../src/net/client.ts');
    const silent = await Scripted.start();
    const links: string[] = [];
    const net = new Net({
      url: `ws://127.0.0.1:${silent.port}/ws`,
      room: newRoomName(),
      keys: { own: () => null, remembered: () => [], keep: () => {} },
      handlers: { link: (l) => links.push(l), joined() {}, state() {}, moved() {}, think() {}, refused() {}, seated() {} },
      answer: 200,
      retry: [50],
    });
    try {
      while (silent.connections < 1 || silent.heard.length < 1) await pause(10);
      // Shown again: it is asked for the room, nothing comes back, and a new connection is made without waiting forty seconds.
      net.wake();
      await pause(100);
      expect(silent.heard.some((m) => m.t === 'sync')).toBe(true);
      const began = Date.now();
      while (silent.connections < 2 && Date.now() - began < 2000) await pause(10);
      expect(silent.connections).toBe(2);
      expect(links).toContain('lost');
    } finally {
      net.close();
      await silent.close();
    }
  });
});

describe('a name', () => {
  let running: Running;
  beforeAll(async () => {
    running = await startServer({ port: 0, root: 'no-such-folder', blockedNames: ['grumble'] });
  });
  afterAll(async () => {
    await running.close();
  });

  it('is said to be saved; one the server will not have shows the name in use, and that it was not available', async () => {
    const rig = await boot({ address: `http://127.0.0.1:${running.port}/` });
    rig.app.rename('Ashwood');
    expect(rig.ui.nameSaid.value).toBe('saved');
    await eventually(rig, () => rig.ui.player.value.card?.name === 'Ashwood');
    expect(rig.ui.nameSaid.value).toBe('saved');
    // Gone by itself after a moment.
    await pause(2600);
    expect(rig.ui.nameSaid.value).toBeNull();

    // A word on the server's own list: the server keeps the name it had.
    rig.app.rename('Grumbleton');
    await eventually(rig, () => rig.ui.nameSaid.value === 'refused');
    expect(rig.ui.player.value.name).toBe('Ashwood');
    expect(rig.ui.player.value.card?.name).toBe('Ashwood');

    // A name refused before it is sent (it is the game's own): said at once.
    rig.app.rename('Admin');
    expect(rig.ui.nameSaid.value).toBe('refused');
  }, 15000);
});

describe('a link to a room nobody has opened', () => {
  let running: Running;
  beforeAll(async () => {
    running = await startServer({ port: 0, root: 'no-such-folder' });
  });
  afterAll(async () => {
    await running.close();
  });

  it('says it is a new game with this player the first one in it; a room the player made, or came back to, says only to send the link', async () => {
    const room = newRoomName();
    const rig = await boot({ address: `http://127.0.0.1:${running.port}/?room=${room}` });
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    expect(rig.ui.online.value?.firstHere).toBe(true);
    expect(await roomLine(rig)).toContain('This is a new game, and you are the first one here.');
    // Reloaded: this browser has sat here before.
    const again = await boot({ address: `http://127.0.0.1:${running.port}/?room=${room}`, keepStorage: true });
    await eventually(again, () => again.ui.online.value?.seat === 'w');
    expect(again.ui.online.value?.firstHere).toBe(false);
    expect(await roomLine(again)).toContain('You are Ivory. Send this link to your opponent.');
    // Made from the choice of game.
    const made = await boot({ address: `http://127.0.0.1:${running.port}/` });
    made.app.startOnline();
    await eventually(made, () => made.ui.online.value?.seat === 'w');
    expect(made.ui.online.value?.firstHere).toBe(false);
  });
});
