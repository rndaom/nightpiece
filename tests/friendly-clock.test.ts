/**
 * A friendly room's clock: none unless its players choose one, chosen by either of them between
 * games, kept by the same server logic as a ranked game's, lost on time and nothing more, waiting
 * for a player who is away, and carried across a restart. Then the same from the game's own
 * controller, through the real server (see tests/helpers/app-rig.ts), and the cards that offer it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Running, startServer } from '../server/main.ts';
import { ABANDON_AFTER, type Connection, Lobby, PAUSE_ALLOWANCE, type SavedRooms } from '../server/rooms.ts';
import { RoomStore } from '../server/store.ts';
import { Game, type Square } from '../src/core/game.ts';
import { type ClientMessage, FRIENDLY_CONTROLS, type MoveData, newRoomName, parseClientMessage, type RoomState, type ServerMessage, type TimeControl } from '../src/net/protocol.ts';
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

const id = (n: number) => n.toString(16).padStart(32, '0');
const mv = (text: string): MoveData => ({ from: text.slice(0, 2) as Square, to: text.slice(2, 4) as Square });
const [THREE, FIVE] = FRIENDLY_CONTROLS as [TimeControl, TimeControl, ...TimeControl[]];

/** The state a connection was last told of, by any message that carries one. */
const told = (c: Fake): RoomState => {
  for (const m of [...c.inbox].reverse()) if ('state' in m && m.state) return m.state;
  throw new Error('No state told');
};

/** A friendly room with a clock the test moves: Ivory sits down first, Void after, a watcher if asked. */
function room(time = 5_000_000) {
  const clock = { now: () => time, pass: (ms: number) => (time += ms) };
  const lobby = new Lobby(clock.now);
  lobby.track();
  const name = 'FRNDLY';
  const sit = (n: number, extra: Partial<Extract<ClientMessage, { t: 'join' }>> = {}) => {
    const c = new Fake();
    lobby.handle(c, { t: 'hello', id: id(n), name: `P${n}` });
    lobby.handle(c, { t: 'join', room: name, ...extra });
    return c;
  };
  const say = (c: Fake, message: ClientMessage) => lobby.handle(c, message);
  const play = (c: Fake, text: string, ply: number) => lobby.handle(c, { t: 'move', ply, move: mv(text) });
  return { lobby, clock, name, sit, say, play };
}

describe('choosing the clock', () => {
  it('reads the new message, and only for a clock on the list or none', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'control', control: null }))).toEqual({ t: 'control', control: null });
    expect(parseClientMessage(JSON.stringify({ t: 'control', control: { base: 300000, increment: 3000 } }))).toEqual({ t: 'control', control: FIVE });
    expect(parseClientMessage(JSON.stringify({ t: 'control', control: { base: 1000, increment: 0 } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'control' }))).toBeNull();
    expect(FRIENDLY_CONTROLS.map((c) => `${c.base / 60000}+${c.increment / 1000}`)).toEqual(['3+2', '5+3', '10+5', '15+10', '30+0']);
  });

  it('has none until one is chosen; the one who made the room chooses, and the friend finds it as they sit down', () => {
    const t = room();
    const ivory = t.sit(1);
    expect(ivory.last('joined')!.state).toMatchObject({ control: null, clock: null });
    t.say(ivory, { t: 'control', control: FIVE });
    expect(told(ivory)).toMatchObject({ control: FIVE, clock: { left: { w: FIVE.base, b: FIVE.base }, running: null } });
    const friend = t.sit(2);
    expect(friend.last('joined')).toMatchObject({ you: 'b', state: { control: FIVE, clock: { left: { w: FIVE.base, b: FIVE.base }, running: null } } });
    // Either player may change it before the first move, and the other sees it at once.
    t.say(friend, { t: 'control', control: THREE });
    expect(told(ivory)).toMatchObject({ control: THREE, clock: { left: { w: THREE.base, b: THREE.base } } });
    t.say(ivory, { t: 'control', control: null });
    expect(told(friend)).toMatchObject({ control: null, clock: null });
  });

  it('is not for a watcher, a ranked room, a clock off the list, or the middle of a game', () => {
    const t = room();
    const ivory = t.sit(1);
    const voidPlayer = t.sit(2);
    const watcher = t.sit(3, { watch: true });
    t.say(watcher, { t: 'control', control: FIVE });
    expect(watcher.last('refused')!.state.control).toBeNull();
    t.say(ivory, { t: 'control', control: { base: 1000, increment: 0 } });
    expect(ivory.last('refused')!.state.control).toBeNull();
    t.say(ivory, { t: 'control', control: FIVE });
    t.play(ivory, 'e2e4', 0);
    t.say(voidPlayer, { t: 'control', control: null });
    expect(voidPlayer.last('refused')).toMatchObject({ reason: 'The clock can be changed between games.', state: { control: FIVE } });

    const ranked = new Lobby();
    const a = new Fake();
    const b = new Fake();
    ranked.handle(a, { t: 'hello', id: id(1) });
    ranked.handle(b, { t: 'hello', id: id(2) });
    ranked.handle(a, { t: 'queue' });
    ranked.handle(b, { t: 'queue' });
    const name = a.last('matched')!.room;
    ranked.handle(a, { t: 'join', room: name });
    expect(a.last('joined')!.state.control).toEqual({ base: 10 * 60000, increment: 5000 });
    ranked.handle(a, { t: 'control', control: null });
    expect(a.last('refused')!.reason).toBe('A ranked game has its own clock.');
  });
});

describe('the clock in play', () => {
  /** A room with 5 + 3 chosen, both players at the board. */
  function timed() {
    const t = room();
    const ivory = t.sit(1);
    const voidPlayer = t.sit(2);
    t.say(ivory, { t: 'control', control: FIVE });
    return { ...t, ivory, void: voidPlayer };
  }

  it('starts with White\'s first move, charges each move, and gives the increment back', () => {
    const t = timed();
    t.clock.pass(20_000);
    // Nothing runs before the first move, however long it takes.
    t.lobby.handle(t.ivory, { t: 'sync' });
    expect(told(t.ivory).clock).toEqual({ left: { w: FIVE.base, b: FIVE.base }, running: null });
    t.play(t.ivory, 'e2e4', 0);
    expect(t.void.last('moved')!.clock).toEqual({ left: { w: FIVE.base, b: FIVE.base }, running: 'b' });
    t.clock.pass(7000);
    t.play(t.void, 'e7e5', 1);
    expect(t.ivory.last('moved')!.clock).toEqual({ left: { w: FIVE.base, b: FIVE.base - 7000 + FIVE.increment }, running: 'w' });
    expect(t.lobby.watchedCount).toBe(1);
  });

  it('is lost on time, even before both have moved: not called off, nothing counted, nobody kept from playing', () => {
    const t = timed();
    t.play(t.ivory, 'e2e4', 0);
    t.clock.pass(FIVE.base + 500);
    t.lobby.tick();
    expect(told(t.ivory)).toMatchObject({ ended: 'time', resigned: 'b', change: null, clock: { left: { w: FIVE.base, b: 0 }, running: null } });
    expect(t.lobby.watchedCount).toBe(0);
    // A move that arrives after the flag has fallen is too late, and says so.
    const late = timed();
    late.play(late.ivory, 'e2e4', 0);
    late.clock.pass(FIVE.base + 10);
    late.play(late.void, 'e7e5', 1);
    expect(told(late.void)).toMatchObject({ ended: 'time', resigned: 'b', moves: [mv('e2e4')] });
  });

  it('is a draw on time when the other side could never have mated', () => {
    const t = room();
    const ivory = t.sit(1);
    const voidPlayer = t.sit(2);
    t.say(ivory, { t: 'control', control: THREE });
    // Ivory has a king alone left against Void's king and queen (set on the board directly: a room offers no way to start from a position).
    const kept = (t.lobby as unknown as { rooms: Map<string, { game: Game }> }).rooms.get(t.name)!;
    kept.game = new Game('k7/8/8/8/8/8/1q6/7K w - - 0 1');
    t.play(ivory, 'h1g1', 0);
    t.clock.pass(THREE.base + 10);
    t.lobby.tick();
    expect(told(voidPlayer)).toMatchObject({ ended: 'time', resigned: null, drawOffer: null });
  });

  it('waits for a player who is away while it is their move, out of an allowance, and runs again when they are back; nobody is forfeited for staying away', () => {
    const t = timed();
    t.play(t.ivory, 'e2e4', 0);
    t.clock.pass(4000);
    // Void, to move, drops: their clock stops where it stood, and says how long it will wait.
    t.lobby.leave(t.void);
    expect(told(t.ivory).clock).toEqual({ left: { w: FIVE.base, b: FIVE.base - 4000 }, running: null, held: { side: 'b', left: PAUSE_ALLOWANCE } });
    // Back within the allowance: nothing was charged to the clock, and the clock runs again.
    t.clock.pass(20_000);
    const back = t.sit(2, { token: t.void.last('joined')!.token });
    expect(back.last('joined')).toMatchObject({ you: 'b', state: { clock: { left: { b: FIVE.base - 4000 }, running: 'b' } } });
    expect(back.last('joined')!.state.clock!.held).toBeUndefined();
    // Ivory goes while it is Void's move. Void moves: Ivory's clock waits for Ivory, with Ivory's whole allowance.
    t.clock.pass(1000);
    t.lobby.leave(t.ivory);
    t.play(back, 'e7e5', 1);
    expect(back.last('moved')!.clock).toEqual({ left: { w: FIVE.base, b: FIVE.base - 5000 + FIVE.increment }, running: null, held: { side: 'w', left: PAUSE_ALLOWANCE } });
    t.clock.pass(30_000);
    const w = t.sit(1, { token: t.ivory.last('joined')!.token });
    expect(w.last('joined')!.state.clock).toEqual({ left: { w: FIVE.base, b: FIVE.base - 5000 + FIVE.increment }, running: 'w' });
    expect(t.lobby.save().rooms[0]!.pause).toEqual({ w: PAUSE_ALLOWANCE - 30_000, b: PAUSE_ALLOWANCE - 20_000 });
  });

  it('cannot be stood still for ever by leaving on one\'s own move: once the allowance is spent the clock runs, everyone is told, and the flag falls', () => {
    const t = room();
    const ivory = t.sit(1);
    const voidPlayer = t.sit(2);
    t.say(ivory, { t: 'control', control: THREE });
    t.play(ivory, 'e2e4', 0);
    t.clock.pass(10_000);
    t.lobby.leave(voidPlayer);
    // The allowance runs out while Void is away: the clock starts, and Ivory is told so without asking.
    t.clock.pass(PAUSE_ALLOWANCE + 1000);
    t.lobby.tick();
    expect(told(ivory)).toMatchObject({ ended: null, clock: { left: { b: THREE.base - 11_000 }, running: 'b' } });
    expect(told(ivory).clock!.held).toBeUndefined();
    // An hour later Void has nothing left: the game was lost on time long since.
    for (let i = 0; i < 60; i++) {
      t.clock.pass(60_000);
      t.lobby.tick();
    }
    expect(told(ivory)).toMatchObject({ ended: 'time', resigned: 'b', clock: { left: { b: 0 } } });
    const late = t.sit(2, { token: voidPlayer.last('joined')!.token });
    expect(late.last('joined')!.state).toMatchObject({ ended: 'time', resigned: 'b' });
  });

  it('spends the allowance across every absence of the game, and a short one costs only what it took', () => {
    const t = timed();
    t.play(t.ivory, 'e2e4', 0);
    let voidSeat = t.void;
    const away = (ms: number) => {
      t.lobby.leave(voidSeat);
      t.clock.pass(ms);
      voidSeat = t.sit(2, { token: voidSeat.last('joined')!.token });
    };
    away(3000);
    expect(voidSeat.last('joined')!.state.clock).toMatchObject({ left: { b: FIVE.base }, running: 'b' });
    away(PAUSE_ALLOWANCE - 3000 - 1000);
    // One second of the allowance left: the next absence waits that second, and then the clock runs.
    t.lobby.leave(voidSeat);
    expect(told(t.ivory).clock!.held).toEqual({ side: 'b', left: 1000 });
    t.clock.pass(11_000);
    t.lobby.tick();
    expect(told(t.ivory).clock).toEqual({ left: { w: FIVE.base, b: FIVE.base - 10_000 }, running: 'b' });
  });

  it('is seen waiting by a watcher as by the player', () => {
    const t = timed();
    const watcher = t.sit(9, { watch: true });
    t.play(t.ivory, 'e2e4', 0);
    t.lobby.leave(t.void);
    t.clock.pass(5000);
    t.lobby.handle(watcher, { t: 'sync' });
    expect(told(watcher).clock).toEqual({ left: { w: FIVE.base, b: FIVE.base }, running: null, held: { side: 'b', left: PAUSE_ALLOWANCE - 5000 } });
    // Void comes back, having spent five seconds of it. A rematch gives each player the whole allowance again.
    const back = t.sit(2, { token: t.void.last('joined')!.token });
    expect(t.lobby.save().rooms[0]!.pause).toEqual({ w: PAUSE_ALLOWANCE, b: PAUSE_ALLOWANCE - 5000 });
    t.say(t.ivory, { t: 'resign' });
    t.say(t.ivory, { t: 'again' });
    t.say(back, { t: 'again' });
    expect(t.lobby.save().rooms[0]).toMatchObject({ moves: [], pause: { w: PAUSE_ALLOWANCE, b: PAUSE_ALLOWANCE } });
  });
});

describe('between games', () => {
  /** A timed game played to its end: Ivory (player 1) resigns after a move each. */
  function finished(control: TimeControl = FIVE) {
    const t = room();
    const ivory = t.sit(1);
    const voidPlayer = t.sit(2);
    t.say(ivory, { t: 'control', control });
    t.play(ivory, 'e2e4', 0);
    t.clock.pass(3000);
    t.play(voidPlayer, 'e7e5', 1);
    t.say(ivory, { t: 'resign' });
    return { ...t, one: ivory, two: voidPlayer };
  }

  it('a rematch keeps the room\'s clock, with both sides\' whole time again; a game lost on time is forgotten with it', () => {
    const t = finished();
    // The clocks stop where they stood as the game ended.
    expect(told(t.two).clock).toEqual({ left: { w: FIVE.base, b: FIVE.base - 3000 + FIVE.increment }, running: null });
    t.say(t.one, { t: 'again' });
    t.say(t.two, { t: 'again' });
    expect(t.two.last('seated')).toMatchObject({ you: 'w', state: { control: FIVE, ended: null, moves: [], clock: { left: { w: FIVE.base, b: FIVE.base }, running: null } } });

    const flagged = room();
    const a = flagged.sit(1);
    const b = flagged.sit(2);
    flagged.say(a, { t: 'control', control: THREE });
    flagged.play(a, 'e2e4', 0);
    flagged.clock.pass(THREE.base + 10);
    flagged.lobby.tick();
    expect(told(a).ended).toBe('time');
    flagged.say(a, { t: 'again' });
    flagged.say(b, { t: 'again' });
    expect(told(a)).toMatchObject({ ended: null, resigned: null, clock: { left: { w: THREE.base, b: THREE.base } } });
  });

  it('either player may change it once the game is over: the finished game keeps its clocks, the next has the new one, and a rematch already asked for is asked again', () => {
    const t = finished();
    t.say(t.one, { t: 'again' });
    expect(told(t.two).again).toEqual({ w: true, b: false });
    t.say(t.two, { t: 'control', control: THREE });
    // Both see the new choice; the request made before it is withdrawn, so that the one who made it agrees having seen it.
    expect(told(t.one)).toMatchObject({ control: THREE, again: { w: false, b: false }, clock: { left: { w: FIVE.base } } });
    t.say(t.two, { t: 'again' });
    expect(t.one.last('seated')).toBeUndefined();
    t.say(t.one, { t: 'again' });
    expect(t.one.last('seated')!.state).toMatchObject({ control: THREE, clock: { left: { w: THREE.base, b: THREE.base }, running: null } });
    // And off again, for the game after.
    t.say(t.one, { t: 'control', control: null });
    expect(told(t.two)).toMatchObject({ control: null, clock: null });
  });
});

describe('across a restart', () => {
  it('a timed friendly game is taken up with its clocks: charged up to the stop, and waiting for the player to move', () => {
    const t = room();
    const ivory = t.sit(1);
    const voidPlayer = t.sit(2);
    t.say(ivory, { t: 'control', control: FIVE });
    t.play(ivory, 'e2e4', 0);
    t.clock.pass(6000);
    const saved = t.lobby.save();
    expect(saved.rooms[0]).toMatchObject({ control: FIVE, timed: FIVE });
    // The server is down for a minute. Nobody is charged for that.
    const next = room(t.clock.now() + 60_000);
    expect(next.lobby.restore(saved)).toBe(1);
    const watcher = next.sit(9, { watch: true });
    expect(watcher.last('joined')!.state).toMatchObject({ control: FIVE, clock: { left: { w: FIVE.base, b: FIVE.base - 6000 }, running: null, held: { side: 'b', left: PAUSE_ALLOWANCE } } });
    // Void comes back half a minute later: that much of the allowance is spent, and the clock runs.
    next.clock.pass(30_000);
    next.lobby.tick();
    expect(told(watcher).ended).toBeNull();
    const back = next.sit(2, { token: voidPlayer.last('joined')!.token });
    expect(back.last('joined')).toMatchObject({ you: 'b', state: { clock: { running: 'b' } } });
    next.clock.pass(2000);
    next.play(back, 'e7e5', 1);
    expect(back.last('moved')!.clock!.left.b).toBe(FIVE.base - 8000 + FIVE.increment);
    expect(next.lobby.save().rooms[0]!.pause).toEqual({ w: PAUSE_ALLOWANCE, b: PAUSE_ALLOWANCE - 30_000 });
  });

  it('a wait begun before a restart goes on after it with what was left, and the time the server was down is charged to nobody', () => {
    const t = room();
    const ivory = t.sit(1);
    const voidPlayer = t.sit(2);
    t.say(ivory, { t: 'control', control: THREE });
    t.play(ivory, 'e2e4', 0);
    t.lobby.leave(voidPlayer);
    t.clock.pass(50_000);
    // Written down mid-absence, read back after ten minutes down.
    const next = room(t.clock.now() + 10 * 60_000);
    next.lobby.restore(t.lobby.save());
    const watcher = next.sit(9, { watch: true });
    expect(watcher.last('joined')!.state.clock).toEqual({ left: { w: THREE.base, b: THREE.base }, running: null, held: { side: 'b', left: PAUSE_ALLOWANCE - 50_000 } });
    // Void stays away: the rest of the allowance goes, then the clock, and the flag falls.
    next.clock.pass(PAUSE_ALLOWANCE - 50_000 + 1000);
    next.lobby.tick();
    expect(told(watcher).clock).toMatchObject({ left: { b: THREE.base - 1000 }, running: 'b' });
    next.clock.pass(THREE.base);
    next.lobby.tick();
    expect(told(watcher)).toMatchObject({ ended: 'time', resigned: 'b' });
  });

  it('a flag that fell as the server stopped ends the game on time when it starts again', () => {
    const t = room();
    const ivory = t.sit(1);
    t.sit(2);
    t.say(ivory, { t: 'control', control: THREE });
    t.play(ivory, 'e2e4', 0);
    t.clock.pass(THREE.base + 2000);
    const next = room(t.clock.now() + 5000);
    next.lobby.restore(t.lobby.save());
    next.lobby.tick();
    const watcher = next.sit(9, { watch: true });
    expect(watcher.last('joined')!.state).toMatchObject({ ended: 'time', resigned: 'b' });
  });

  it('through the store: a choice made and a game played are written as they happen and read back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightpiece-friendly-'));
    try {
      const file = path.join(dir, 'rooms.json');
      const t = room();
      const store = new RoomStore(file);
      store.checkpoint(t.lobby.save());
      const ivory = t.sit(1);
      const voidPlayer = t.sit(2);
      store.write(t.lobby.changes(), t.clock.now());
      t.say(ivory, { t: 'control', control: FIVE });
      store.write(t.lobby.changes(), t.clock.now());
      t.play(ivory, 'e2e4', 0);
      store.write(t.lobby.changes(), t.clock.now());
      t.clock.pass(2000);
      t.play(voidPlayer, 'e7e5', 1);
      store.write(t.lobby.changes(), t.clock.now());
      store.close();
      const read = new RoomStore(file).load()!;
      expect(read.rooms[0]).toMatchObject({ control: FIVE, timed: FIVE, moves: [mv('e2e4'), mv('e7e5')], left: { w: FIVE.base, b: FIVE.base - 2000 + FIVE.increment } });
      // Taken up again from what was read, the game under way is watched for its flag.
      const next = room(t.clock.now() + 1000);
      next.lobby.restore(read);
      expect(next.lobby.watchedCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rooms written before friendly clocks are taken up as they were: a friendly one with none, a ranked one with the ranked clock', () => {
    const t = room();
    const ivory = t.sit(1);
    const voidPlayer = t.sit(2);
    t.play(ivory, 'e2e4', 0);
    const saved = t.lobby.save();
    // As an older server wrote it: no word of the clocks.
    const older: SavedRooms = { ...saved, rooms: saved.rooms.map(({ control: _c, timed: _t, ...r }) => r) };
    const next = room(t.clock.now() + 1000);
    expect(next.lobby.restore(older)).toBe(1);
    const back = next.sit(2, { token: voidPlayer.last('joined')!.token });
    expect(back.last('joined')!.state).toMatchObject({ control: null, clock: null });
    next.play(back, 'e7e5', 1);
    expect(back.last('moved')).toEqual({ t: 'moved', ply: 1, move: mv('e7e5') });
    const ranked = { ...older, rooms: older.rooms.map((r) => ({ ...r, ranked: true })) };
    const third = room(t.clock.now() + 1000);
    third.lobby.restore(ranked);
    expect(third.sit(9, { watch: true }).last('joined')!.state).toMatchObject({ control: { base: 600000, increment: 5000 }, clock: { running: null } });
  });
});

describe('an older page', () => {
  it('that knows nothing of clocks plays a friendly game exactly as before: no clock, no clock on a move', () => {
    const t = room();
    const ivory = t.sit(1);
    const voidPlayer = t.sit(2);
    t.play(ivory, 'e2e4', 0);
    t.clock.pass(ABANDON_AFTER * 20);
    t.play(voidPlayer, 'e7e5', 1);
    expect(ivory.last('moved')).toEqual({ t: 'moved', ply: 1, move: mv('e7e5') });
    t.lobby.tick();
    expect(told(ivory)).toMatchObject({ clock: null, ended: null });
    expect(t.lobby.watchedCount).toBe(0);
    // What it does not know of (the room's choice) it passes over; what it sends is read as ever.
    expect(parseClientMessage(JSON.stringify({ t: 'join', room: t.name }))).toEqual({ t: 'join', room: t.name });
  });

  it('with a friend on a newer page who chooses a clock, sees the clocks in the room and loses on time like anyone', () => {
    const t = room();
    const older = t.sit(1);
    const newer = t.sit(2);
    t.say(newer, { t: 'control', control: THREE });
    t.play(older, 'e2e4', 0);
    t.clock.pass(1000);
    t.play(newer, 'e7e5', 1);
    t.clock.pass(THREE.base + FIVE.increment);
    t.lobby.tick();
    expect(told(older)).toMatchObject({ ended: 'time', resigned: 'w' });
  });
});

// -- from the game's own controller, through the real server ------------------------------------

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

/** The other player: a bare connection that says only what the test tells it to. */
class Opponent {
  state: RoomState | null = null;
  heard: ServerMessage[] = [];
  private socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(port: number, room: string) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ready = new Promise((resolve) => {
      this.socket.addEventListener('open', () => this.send({ t: 'join', room }));
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
    this.send({ t: 'move', ply, move: mv(text) });
  }
  close(): void {
    this.socket.close();
  }
}

describe('the clock at the game\'s own screen', () => {
  let running: Running;
  const others: Opponent[] = [];
  const address = (room: string, watch = false) => `http://127.0.0.1:${running.port}/?room=${room}${watch ? '&watch=1' : ''}`;
  const folder = '../src/ui/';

  beforeAll(async () => {
    stubBrowser();
    const warn = console.warn.bind(console);
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && /Could not load the (hands|finished assets)|chess engine could not be started/.test(args[0])) return;
      warn(...args);
    });
    running = await startServer({ port: 0, root: 'no-such-folder' });
  });
  afterAll(async () => {
    for (const o of others) o.close();
    await running.close();
  });

  /** A room made at this screen (Ivory), with a clock chosen here before the friend comes, and the friend at Void. */
  async function made(control: TimeControl | null): Promise<{ rig: Rig; other: Opponent; room: string }> {
    const room = newRoomName();
    const rig = await boot({ address: address(room) });
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    expect(rig.ui.online.value).toMatchObject({ choosable: true, control: null, clock: null });
    rig.app.setClock(control);
    if (control) await eventually(rig, () => rig.ui.online.value?.control?.base === control.base);
    const other = new Opponent(running.port, room);
    others.push(other);
    await other.ready;
    await eventually(rig, () => rig.ui.online.value?.taken.b === true);
    return { rig, other, room };
  }

  it('chosen here before the friend comes: the friend finds it, both come to the board under its terms, and a watcher sees the clocks', async () => {
    const { rig, other, room } = await made(FIVE);
    expect(other.state).toMatchObject({ control: FIVE, clock: { left: { w: FIVE.base, b: FIVE.base }, running: null } });
    // Nobody is told of a change they made themselves.
    expect(rig.ui.notice.value).toBeNull();
    await eventually(rig, () => rig.ui.intro.value !== null);
    expect(rig.ui.intro.value).toMatchObject({ ranked: false, clock: FIVE });
    const { termsOf } = (await import(/* @vite-ignore */ `${folder}Match.tsx`)) as { termsOf: (i: { ranked: boolean; clock: TimeControl | null }) => string };
    expect(termsOf(rig.ui.intro.value!)).toBe('Friendly · 5 + 3');
    rig.app.click('e2');
    rig.app.click('e4');
    await eventually(rig, () => rig.ui.online.value?.clock?.running === 'b');
    const watcher = await boot({ address: address(room, true) });
    await eventually(watcher, () => watcher.ui.online.value?.seat === 'spectator');
    expect(watcher.ui.online.value).toMatchObject({ choosable: true, control: FIVE, clock: { running: 'b' } });
  });

  it('changed by the friend once a game is over: said here, and the next game is played with it', async () => {
    const { rig, other } = await made(FIVE);
    other.send({ t: 'resign' });
    await eventually(rig, () => rig.ui.status.value.over);
    other.send({ t: 'control', control: THREE });
    await eventually(rig, () => rig.ui.online.value?.control?.base === THREE.base);
    expect(rig.ui.notice.value).toBe('Void set the clock to 3 + 2.');
    rig.app.newGame();
    other.send({ t: 'again' });
    await eventually(rig, () => rig.ui.online.value?.seat === 'b');
    expect(rig.ui.online.value).toMatchObject({ control: THREE, clock: { left: { w: THREE.base, b: THREE.base }, running: null } });
    await eventually(rig, () => rig.ui.intro.value !== null);
    expect(rig.ui.intro.value).toMatchObject({ you: 'b', clock: THREE });
    // And off, between games, from here: the friend hears it, and this screen is not told of its own change.
    rig.app.setClock(null);
    await eventually(rig, () => other.state?.control === null);
    await eventually(rig, () => rig.ui.online.value?.control === null);
    expect(rig.ui.online.value?.clock).toBeNull();
  });

  it('a clock asked for here and refused does not keep the other player\'s later choice of the same clock from being said', async () => {
    const { rig, other } = await made(null);
    rig.app.click('e2');
    rig.app.click('e4');
    await eventually(rig, () => other.heard.some((m) => m.t === 'moved'));
    // Mid-game: the server refuses it, and the room's clock stays as it was.
    rig.app.setClock(THREE);
    await eventually(rig, () => rig.ui.notice.value !== null);
    expect(rig.ui.online.value?.control).toBeNull();
    rig.ui.notice.value = null;
    other.send({ t: 'resign' });
    await eventually(rig, () => rig.ui.status.value.over);
    other.send({ t: 'control', control: THREE });
    await eventually(rig, () => rig.ui.online.value?.control?.base === THREE.base);
    expect(rig.ui.notice.value).toBe('Void set the clock to 3 + 2.');
  });

  it('lost on time: the game ends here, the card says so, and nothing is rated', async () => {
    const { rig, other, room } = await made(THREE);
    rig.app.click('e2');
    rig.app.click('e4');
    await eventually(rig, () => other.heard.some((m) => m.t === 'moved'));
    other.move('e7e5', 1);
    await eventually(rig, () => rig.app.game.history().length === 2 && rig.ui.online.value?.clock?.running === 'w');
    // Ivory's time nearly gone, on the server's own clock: the next look at the clocks finds the flag down.
    const kept = (running.lobby as unknown as { rooms: Map<string, { left: Record<'w' | 'b', number> }> }).rooms.get(room)!;
    kept.left.w = 30;
    await eventually(rig, () => rig.ui.status.value.over, 4000);
    const { outcome } = await import('../src/app/store.ts');
    expect(rig.ui.online.value?.ended).toBe('time');
    expect(outcome.value).toMatchObject({ winner: 'b', cause: 'time', rating: null, flagged: 'w' });
    const { howOf } = (await import(/* @vite-ignore */ `${folder}Match.tsx`)) as { howOf: (o: unknown, you: 'w' | 'b' | null) => string };
    expect(howOf(outcome.value, 'w')).toMatch(/^You ran out of time · move 1 · /);
    expect(other.state).toMatchObject({ ended: 'time', resigned: 'w', change: null });
  });

  it('on a server from before friendly clocks, nothing is offered and nothing is sent', async () => {
    const { rig } = await made(null);
    // As such a server tells it: the room says nothing of a clock.
    const noted = rig.app as unknown as { noteRoom(state: RoomState): void };
    const state = { ...rig.ui.online.value!, ...(running.lobby as unknown as { rooms: Map<string, { state(): RoomState }> }).rooms.get(rig.ui.online.value!.room)!.state() };
    delete (state as Partial<RoomState>).control;
    noted.noteRoom(state);
    expect(rig.ui.online.value).toMatchObject({ choosable: false, control: null });
    const net = (rig.app as unknown as { net: { control: (c: TimeControl | null) => boolean } }).net;
    const sent = vi.spyOn(net, 'control');
    rig.app.setClock(FIVE);
    expect(sent).not.toHaveBeenCalled();
  });
});
