/**
 * The multiplayer server: first the rules of a room with no network at all,
 * then the real thing over real sockets.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { codingFor, type Running, startServer } from '../server/main.ts';
import { type Connection, Lobby } from '../server/rooms.ts';
import { Game } from '../src/core/game.ts';
import { CLOSE_DISPLACED, type ClientMessage, type MoveData, newRoomName, parseClientMessage, ROOM_NAME, type ServerMessage } from '../src/net/protocol.ts';

type Of<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

class Fake implements Connection {
  inbox: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(message: ServerMessage): void {
    this.inbox.push(message);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  /** The most recent message of a kind. */
  last<T extends ServerMessage['t']>(t: T): Of<T> | undefined {
    return [...this.inbox].reverse().find((m): m is Of<T> => m.t === t);
  }
  all<T extends ServerMessage['t']>(t: T): Of<T>[] {
    return this.inbox.filter((m): m is Of<T> => m.t === t);
  }
}

const ROOM = 'ABCDEF';
const move = (text: string): MoveData => {
  const m: MoveData = { from: text.slice(0, 2) as MoveData['from'], to: text.slice(2, 4) as MoveData['to'] };
  if (text[4]) m.promotion = text[4] as NonNullable<MoveData['promotion']>;
  return m;
};

/** A room with both players seated. */
function table(now: () => number = Date.now) {
  const lobby = new Lobby(now);
  const ivory = new Fake();
  const voidPlayer = new Fake();
  lobby.handle(ivory, { t: 'join', room: ROOM });
  lobby.handle(voidPlayer, { t: 'join', room: ROOM });
  const play = (who: Fake, text: string, ply: number) => lobby.handle(who, { t: 'move', ply, move: move(text) });
  return { lobby, ivory, void: voidPlayer, play };
}

/** Morphy's game at the opera, Paris 1858: castling, checks, captures and a mate, in 33 moves. */
const OPERA =
  'e2e4 e7e5 g1f3 d7d6 d2d4 c8g4 d4e5 g4f3 d1f3 d6e5 f1c4 g8f6 f3b3 d8e7 b1c3 c7c6 c1g5 b7b5 c3b5 c6b5 c4b5 b8d7 e1c1 a8d8 d1d7 d8d7 h1d1 e7e6 b5d7 f6d7 b3b8 d7b8 d1d8'.split(
    ' ',
  );

describe('messages', () => {
  it('reads every message a client may send', () => {
    const token = 'a'.repeat(32);
    const cases: ClientMessage[] = [
      { t: 'join', room: ROOM },
      { t: 'join', room: ROOM, token, remembered: [token], watch: true },
      { t: 'move', ply: 3, move: { from: 'e7', to: 'e8', promotion: 'q' } },
      { t: 'think', square: 'e2' },
      { t: 'think', square: null },
      { t: 'resign' },
      { t: 'draw' },
      { t: 'agree' },
      { t: 'nodraw' },
      { t: 'again' },
      { t: 'sync' },
    ];
    for (const message of cases) expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it('refuses anything else', () => {
    const bad = [
      'not json',
      '[]',
      'null',
      '{"t":"join","room":"abc"}',
      '{"t":"join","room":"ABCDEF","token":"short"}',
      '{"t":"join","room":"ABCDEF","remembered":"x"}',
      '{"t":"move","ply":-1,"move":{"from":"e2","to":"e4"}}',
      '{"t":"move","ply":0,"move":{"from":"e2","to":"e9"}}',
      '{"t":"move","ply":0,"move":{"from":"e2","to":"e4","promotion":"k"}}',
      '{"t":"move","ply":0.5,"move":{"from":"e2","to":"e4"}}',
      '{"t":"think","square":"z9"}',
      '{"t":"shutdown"}',
    ];
    for (const text of bad) expect(parseClientMessage(text), text).toBeNull();
  });

  it('makes room names that the server accepts, and not the same one twice', () => {
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const name = newRoomName();
      expect(name).toMatch(ROOM_NAME);
      names.add(name);
    }
    expect(names.size).toBe(200);
  });
});

describe('a room', () => {
  it('seats the first two to arrive as Ivory and Void, and the rest watch', () => {
    const { lobby, ivory, void: v } = table();
    const third = new Fake();
    lobby.handle(third, { t: 'join', room: ROOM });
    expect(ivory.last('joined')!.you).toBe('w');
    expect(v.last('joined')!.you).toBe('b');
    expect(third.last('joined')!.you).toBe('spectator');
    expect(third.last('joined')!.token).toBe('');
    expect(ivory.last('joined')!.token).toMatch(/^[0-9a-f]{32}$/);
    expect(ivory.last('joined')!.token).not.toBe(v.last('joined')!.token);
    // Those already there are told who has come.
    expect(ivory.last('state')!.state).toMatchObject({ present: { w: true, b: true }, taken: { w: true, b: true }, watching: 1 });
  });

  it('lets someone ask only to watch, leaving the seat free', () => {
    const lobby = new Lobby();
    const watcher = new Fake();
    const player = new Fake();
    lobby.handle(watcher, { t: 'join', room: ROOM, watch: true });
    lobby.handle(player, { t: 'join', room: ROOM });
    expect(watcher.last('joined')!.you).toBe('spectator');
    expect(player.last('joined')!.you).toBe('w');
  });

  it('plays a move and tells everyone, the mover included', () => {
    const { lobby, ivory, void: v, play } = table();
    const watcher = new Fake();
    lobby.handle(watcher, { t: 'join', room: ROOM });
    play(ivory, 'e2e4', 0);
    for (const who of [ivory, v, watcher]) expect(who.last('moved')).toEqual({ t: 'moved', ply: 0, move: { from: 'e2', to: 'e4' } });
    play(v, 'e7e5', 1);
    expect(watcher.all('moved')).toHaveLength(2);
  });

  it('refuses what the rules do not allow, and says what is true', () => {
    const { ivory, void: v, play } = table();
    play(ivory, 'e2e5', 0);
    expect(ivory.last('refused')).toMatchObject({ reason: 'That move is not legal.', state: { moves: [] } });
    play(v, 'e7e5', 0);
    expect(v.last('refused')!.reason).toBe('It is not your turn.');
    play(ivory, 'e2e4', 0);
    // Ivory tries to move for Void.
    play(ivory, 'e7e5', 1);
    expect(ivory.last('refused')).toMatchObject({ reason: 'It is not your turn.', state: { moves: [{ from: 'e2', to: 'e4' }] } });
    // A request made for a position that has since changed.
    play(v, 'e7e5', 0);
    expect(v.last('refused')!.reason).toBe('That move was for an earlier position.');
    expect(v.all('moved')).toHaveLength(1);
  });

  it('does not let a watcher move, or steer a hand', () => {
    const { lobby, ivory } = table();
    const watcher = new Fake();
    lobby.handle(watcher, { t: 'join', room: ROOM });
    lobby.handle(watcher, { t: 'move', ply: 0, move: move('e2e4') });
    expect(watcher.last('refused')!.reason).toBe('Only the two players can move.');
    lobby.handle(watcher, { t: 'think', square: 'e2' });
    expect(ivory.last('think')).toBeUndefined();
  });

  it('does not start until both players have arrived', () => {
    const lobby = new Lobby();
    const alone = new Fake();
    lobby.handle(alone, { t: 'join', room: ROOM });
    lobby.handle(alone, { t: 'move', ply: 0, move: move('e2e4') });
    expect(alone.last('refused')!.reason).toBe('Wait for the other player to arrive.');
  });

  it('passes on which piece a player is thinking about, to the others only, and only their own', () => {
    const { lobby, ivory, void: v } = table();
    lobby.handle(ivory, { t: 'think', square: 'g1' });
    expect(v.last('think')).toEqual({ t: 'think', side: 'w', square: 'g1' });
    expect(ivory.last('think')).toBeUndefined();
    lobby.handle(ivory, { t: 'think', square: 'g8' });
    lobby.handle(ivory, { t: 'think', square: 'e4' });
    expect(v.all('think')).toHaveLength(1);
    lobby.handle(ivory, { t: 'think', square: null });
    expect(v.last('think')).toEqual({ t: 'think', side: 'w', square: null });
  });

  it('plays a whole game through to mate', () => {
    const { lobby, ivory, void: v, play } = table();
    OPERA.forEach((text, ply) => play(ply % 2 === 0 ? ivory : v, text, ply));
    expect(ivory.all('refused')).toHaveLength(0);
    expect(v.all('refused')).toHaveLength(0);
    expect(v.all('moved')).toHaveLength(OPERA.length);

    // Anyone arriving now is given a record that replays to the same end.
    const late = new Fake();
    lobby.handle(late, { t: 'join', room: ROOM });
    const state = late.last('joined')!.state;
    const game = new Game(state.startFen);
    for (const m of state.moves) game.move(m.from, m.to, m.promotion);
    expect(game.status()).toMatchObject({ over: true, result: 'checkmate', winner: 'w' });
    expect(game.lastMove()!.san).toBe('Rd8#');

    // Nothing more can be played.
    play(v, 'e8d8', OPERA.length);
    expect(v.last('refused')!.reason).toBe('That move is not legal.');
  });

  it('keeps a seat for a player who drops out, and gives it back for their key', () => {
    const { lobby, ivory, void: v, play } = table();
    play(ivory, 'e2e4', 0);
    const key = v.last('joined')!.token;
    lobby.leave(v);
    expect(ivory.last('state')!.state).toMatchObject({ present: { w: true, b: false }, taken: { w: true, b: true } });

    // Someone else arriving meanwhile cannot have the seat.
    const stranger = new Fake();
    lobby.handle(stranger, { t: 'join', room: ROOM });
    expect(stranger.last('joined')!.you).toBe('spectator');

    const back = new Fake();
    lobby.handle(back, { t: 'join', room: ROOM, token: key });
    expect(back.last('joined')).toMatchObject({ you: 'b', token: key, state: { moves: [{ from: 'e2', to: 'e4' }] } });
    lobby.handle(back, { t: 'move', ply: 1, move: move('e7e5') });
    expect(ivory.last('moved')).toMatchObject({ ply: 1 });
  });

  it('withdraws the hand of a player who drops out', () => {
    const { lobby, ivory, void: v } = table();
    lobby.handle(v, { t: 'think', square: 'g8' });
    lobby.leave(v);
    expect(ivory.last('think')).toEqual({ t: 'think', side: 'b', square: null });
  });

  it('gives a seat to the newer of two windows holding the same key, and closes the older', () => {
    const { lobby, ivory } = table();
    const key = ivory.last('joined')!.token;
    const again = new Fake();
    lobby.handle(again, { t: 'join', room: ROOM, token: key });
    expect(again.last('joined')!.you).toBe('w');
    expect(ivory.closed?.code).toBe(CLOSE_DISPLACED);
    // The older window closing afterwards does not unseat the newer one.
    lobby.leave(ivory);
    lobby.handle(again, { t: 'sync' });
    expect(again.last('state')!.state.present.w).toBe(true);
  });

  it('honours a key the browser merely remembers only when the seat stands empty', () => {
    const { lobby, ivory, void: v } = table();
    const key = ivory.last('joined')!.token;
    // A second window in the same browser: Ivory is sitting there, so this one watches.
    const second = new Fake();
    lobby.handle(second, { t: 'join', room: ROOM, remembered: [key] });
    expect(second.last('joined')!.you).toBe('spectator');
    expect(ivory.closed).toBeNull();
    // The first window is closed and the address opened afresh: the seat is theirs again.
    lobby.leave(ivory);
    const reopened = new Fake();
    lobby.handle(reopened, { t: 'join', room: ROOM, remembered: ['f'.repeat(32), key] });
    expect(reopened.last('joined')).toMatchObject({ you: 'w', token: key });
    expect(v.last('state')!.state.present.w).toBe(true);
  });

  it('frees a seat that was walked away from before the game began, but not after', () => {
    let now = 1_000_000;
    const { lobby, ivory, void: v, play } = table(() => now);
    lobby.leave(v);
    now += 10_000;
    const early = new Fake();
    lobby.handle(early, { t: 'join', room: ROOM });
    expect(early.last('joined')!.you).toBe('spectator');
    lobby.leave(early);
    now += 31_000;
    const patient = new Fake();
    lobby.handle(patient, { t: 'join', room: ROOM });
    expect(patient.last('joined')!.you).toBe('b');

    // Once a move has been played, the seat waits for its player however long they are gone.
    play(ivory, 'e2e4', 0);
    lobby.leave(patient);
    now += 600_000;
    const hopeful = new Fake();
    lobby.handle(hopeful, { t: 'join', room: ROOM });
    expect(hopeful.last('joined')!.you).toBe('spectator');
  });

  it('starts another game, colours swapped, once both players ask', () => {
    const { lobby, ivory, void: v, play } = table();
    const watcher = new Fake();
    lobby.handle(watcher, { t: 'join', room: ROOM });
    'f2f3 e7e5 g2g4 d8h4'.split(' ').forEach((text, ply) => play(ply % 2 === 0 ? ivory : v, text, ply));
    lobby.handle(ivory, { t: 'again' });
    expect(v.last('state')!.state.again).toEqual({ w: true, b: false });
    expect(v.last('seated')).toBeUndefined();
    lobby.handle(v, { t: 'again' });
    expect(ivory.last('seated')).toMatchObject({ you: 'b', state: { moves: [], again: { w: false, b: false } } });
    expect(v.last('seated')!.you).toBe('w');
    expect(watcher.last('seated')!.you).toBe('spectator');
    // The player who was Void now moves first.
    lobby.handle(v, { t: 'move', ply: 0, move: move('d2d4') });
    expect(ivory.last('moved')).toEqual({ t: 'moved', ply: 0, move: { from: 'd2', to: 'd4' } });
  });

  it('lets a player give the game up at any point, and tells everyone', () => {
    const { lobby, ivory, void: v, play } = table();
    const watcher = new Fake();
    lobby.handle(watcher, { t: 'join', room: ROOM });
    expect(ivory.last('joined')!.state.resigned).toBeNull();
    play(ivory, 'e2e4', 0);
    // It is Void's move, and Ivory who gives up.
    lobby.handle(ivory, { t: 'resign' });
    for (const who of [ivory, v, watcher]) expect(who.last('state')!.state).toMatchObject({ resigned: 'w', moves: [{ from: 'e2', to: 'e4' }] });
    // The game is over: nothing more is played in it.
    play(v, 'e7e5', 1);
    expect(v.last('refused')!.state).toMatchObject({ resigned: 'w', moves: [{ from: 'e2', to: 'e4' }] });
    expect(ivory.all('moved')).toHaveLength(1);
    // Nor can the other side then give up a game it has won.
    lobby.handle(v, { t: 'resign' });
    expect(v.last('state')!.state.resigned).toBe('w');
  });

  it('starts another game after one was given up, with nobody having resigned it', () => {
    const { lobby, ivory, void: v, play } = table();
    play(ivory, 'e2e4', 0);
    lobby.handle(v, { t: 'resign' });
    expect(ivory.last('state')!.state.resigned).toBe('b');
    lobby.handle(ivory, { t: 'again' });
    lobby.handle(v, { t: 'again' });
    expect(ivory.last('seated')).toMatchObject({ you: 'b', state: { moves: [], resigned: null } });
    expect(v.last('seated')).toMatchObject({ you: 'w', state: { moves: [], resigned: null } });
  });

  it('does not let a watcher resign, nor a player before the other has come', () => {
    const { lobby, ivory, play } = table();
    const watcher = new Fake();
    lobby.handle(watcher, { t: 'join', room: ROOM });
    play(ivory, 'e2e4', 0);
    lobby.handle(watcher, { t: 'resign' });
    expect(watcher.last('refused')).toMatchObject({ reason: 'Only the two players can resign.', state: { resigned: null } });
    expect(ivory.last('state')!.state.resigned).toBeNull();

    const alone = new Lobby();
    const first = new Fake();
    alone.handle(first, { t: 'join', room: 'GHJKLM' });
    alone.handle(first, { t: 'resign' });
    expect(first.last('refused')).toMatchObject({ reason: 'Wait for the other player to arrive.', state: { resigned: null } });
  });

  it('has nothing to give up once the game has ended on the board', () => {
    const { lobby, ivory, void: v, play } = table();
    ['f2f3', 'e7e5', 'g2g4', 'd8h4'].forEach((text, ply) => play(ply % 2 ? v : ivory, text, ply));
    const heard = ivory.inbox.length;
    lobby.handle(ivory, { t: 'resign' });
    // Nothing is said, because nothing has changed: Void won by checkmate.
    expect(ivory.inbox).toHaveLength(heard);
    lobby.handle(ivory, { t: 'sync' });
    expect(ivory.last('state')!.state.resigned).toBeNull();
  });

  it('remembers a game given up for someone who comes back to it', () => {
    const { lobby, ivory, void: v, play } = table();
    play(ivory, 'e2e4', 0);
    lobby.handle(v, { t: 'resign' });
    const key = ivory.last('joined')!.token;
    lobby.leave(ivory);
    const back = new Fake();
    lobby.handle(back, { t: 'join', room: ROOM, token: key });
    expect(back.last('joined')).toMatchObject({ you: 'w', state: { resigned: 'b', moves: [{ from: 'e2', to: 'e4' }] } });
  });

  it('ends the game as a draw when one player offers and the other agrees, and tells everyone', () => {
    const { lobby, ivory, void: v, play } = table();
    const watcher = new Fake();
    lobby.handle(watcher, { t: 'join', room: ROOM });
    expect(ivory.last('joined')!.state).toMatchObject({ drawOffer: null, agreed: false });
    play(ivory, 'e2e4', 0);
    play(v, 'e7e5', 1);
    lobby.handle(v, { t: 'draw' });
    for (const who of [ivory, v, watcher]) expect(who.last('state')!.state).toMatchObject({ drawOffer: 'b', agreed: false });
    // The same message from the other side is the answer yes.
    lobby.handle(ivory, { t: 'draw' });
    for (const who of [ivory, v, watcher]) expect(who.last('state')!.state).toMatchObject({ drawOffer: null, agreed: true, resigned: null });
    // The game is over: nothing more is played in it, and there is nothing left to give up.
    play(ivory, 'g1f3', 2);
    expect(ivory.last('refused')!.state).toMatchObject({ agreed: true });
    expect(ivory.last('refused')!.state.moves).toHaveLength(2);
    lobby.handle(ivory, { t: 'resign' });
    expect(ivory.last('state')!.state).toMatchObject({ agreed: true, resigned: null });
  });

  it('takes a plain yes as a yes and nothing else: it ends the game while the offer stands, and is no offer of its own once it does not', () => {
    const { lobby, ivory, void: v, play } = table();
    const watcher = new Fake();
    lobby.handle(watcher, { t: 'join', room: ROOM });
    play(ivory, 'e2e4', 0);
    play(v, 'e7e5', 1);
    const everyone = [ivory, v, watcher];
    const heard = () => everyone.map((who) => who.inbox.length);
    // With nothing offered there is nothing to say yes to, and nobody is told anything.
    let before = heard();
    lobby.handle(ivory, { t: 'agree' });
    expect(heard()).toEqual(before);
    // Void offers. Void cannot agree to it for Ivory, and nor can someone watching.
    lobby.handle(v, { t: 'draw' });
    before = heard();
    lobby.handle(v, { t: 'agree' });
    lobby.handle(watcher, { t: 'agree' });
    expect(heard()).toEqual(before);
    expect(ivory.last('state')!.state).toMatchObject({ drawOffer: 'b', agreed: false });
    // Void takes the offer back as Ivory's yes is on its way: it arrives to no offer, and does not become one.
    lobby.handle(v, { t: 'nodraw' });
    before = heard();
    lobby.handle(ivory, { t: 'agree' });
    expect(heard()).toEqual(before);
    for (const who of everyone) expect(who.last('state')!.state).toMatchObject({ drawOffer: null, agreed: false });
    // Ivory offers in turn, and Void's yes ends the game for everyone.
    lobby.handle(ivory, { t: 'draw' });
    lobby.handle(v, { t: 'agree' });
    for (const who of everyone) expect(who.last('state')!.state).toMatchObject({ drawOffer: null, agreed: true, resigned: null });
    // And it is over: a second yes says nothing.
    before = heard();
    lobby.handle(ivory, { t: 'agree' });
    lobby.handle(v, { t: 'agree' });
    expect(heard()).toEqual(before);
  });

  it('lets a draw be declined, or the offer taken back, and the game goes on', () => {
    const { lobby, ivory, void: v, play } = table();
    play(ivory, 'e2e4', 0);
    play(v, 'e7e5', 1);
    lobby.handle(ivory, { t: 'draw' });
    expect(v.last('state')!.state.drawOffer).toBe('w');
    lobby.handle(v, { t: 'nodraw' });
    for (const who of [ivory, v]) expect(who.last('state')!.state).toMatchObject({ drawOffer: null, agreed: false });
    // Having been told no, the same message from the other side is an offer of their own, not a yes.
    lobby.handle(v, { t: 'draw' });
    expect(ivory.last('state')!.state).toMatchObject({ drawOffer: 'b', agreed: false });
    // Which its maker may take back.
    lobby.handle(v, { t: 'nodraw' });
    expect(ivory.last('state')!.state).toMatchObject({ drawOffer: null, agreed: false });
    play(ivory, 'g1f3', 2);
    expect(v.last('moved')).toMatchObject({ ply: 2 });
  });

  it('takes playing on as the answer no, but lets an offer stand through its maker\'s own move', () => {
    const { lobby, ivory, void: v, play } = table();
    play(ivory, 'e2e4', 0);
    play(v, 'e7e5', 1);
    // Ivory offers with their own move still to make, and makes it: the offer is still there for Void.
    lobby.handle(ivory, { t: 'draw' });
    play(ivory, 'g1f3', 2);
    expect(v.last('state')!.state.drawOffer).toBe('w');
    // Void plays on instead of answering.
    play(v, 'b8c6', 3);
    for (const who of [ivory, v]) expect(who.last('state')!.state).toMatchObject({ drawOffer: null, agreed: false });
    expect(ivory.last('state')!.state.moves).toHaveLength(4);
    // So a yes that arrives after it is no longer a yes to anything: it is Void's own offer.
    lobby.handle(v, { t: 'draw' });
    expect(ivory.last('state')!.state).toMatchObject({ drawOffer: 'b', agreed: false });
  });

  it('allows each side one offer a move, and none before both have moved', () => {
    const { lobby, ivory, void: v, play } = table();
    lobby.handle(ivory, { t: 'draw' });
    expect(ivory.last('refused')).toMatchObject({ reason: 'A draw can be offered once both players have moved.', state: { drawOffer: null } });
    play(ivory, 'e2e4', 0);
    lobby.handle(v, { t: 'draw' });
    expect(v.last('refused')).toMatchObject({ reason: 'A draw can be offered once both players have moved.' });
    play(v, 'e7e5', 1);
    lobby.handle(ivory, { t: 'draw' });
    lobby.handle(v, { t: 'nodraw' });
    // Asking again at once is refused, and so it is after one more move; after two it is not.
    lobby.handle(ivory, { t: 'draw' });
    expect(ivory.last('refused')).toMatchObject({ reason: 'You have already offered a draw on this move.', state: { drawOffer: null } });
    play(ivory, 'g1f3', 2);
    lobby.handle(ivory, { t: 'draw' });
    expect(ivory.last('refused')!.state.moves).toHaveLength(3);
    expect(v.last('state')!.state.drawOffer).toBeNull();
    play(v, 'b8c6', 3);
    lobby.handle(ivory, { t: 'draw' });
    expect(v.last('state')!.state.drawOffer).toBe('w');
    // Asking for what is already being asked says nothing new to anybody.
    const heard = v.inbox.length;
    lobby.handle(ivory, { t: 'draw' });
    expect(v.inbox).toHaveLength(heard);
  });

  it('does not let a watcher offer, agree to or decline a draw, nor a player before the other has come', () => {
    const { lobby, ivory, void: v, play } = table();
    const watcher = new Fake();
    lobby.handle(watcher, { t: 'join', room: ROOM });
    play(ivory, 'e2e4', 0);
    play(v, 'e7e5', 1);
    lobby.handle(watcher, { t: 'draw' });
    expect(watcher.last('refused')).toMatchObject({ reason: 'Only the two players can agree a draw.', state: { drawOffer: null } });
    lobby.handle(ivory, { t: 'draw' });
    lobby.handle(watcher, { t: 'draw' });
    lobby.handle(watcher, { t: 'nodraw' });
    expect(v.last('state')!.state).toMatchObject({ drawOffer: 'w', agreed: false });

    const alone = new Lobby();
    const first = new Fake();
    alone.handle(first, { t: 'join', room: 'GHJKLM' });
    alone.handle(first, { t: 'draw' });
    expect(first.last('refused')).toMatchObject({ reason: 'Wait for the other player to arrive.' });
  });

  it('drops an offer when the game ends some other way, and starts the next game without one', () => {
    const { lobby, ivory, void: v, play } = table();
    play(ivory, 'f2f3', 0);
    play(v, 'e7e5', 1);
    play(ivory, 'g2g4', 2);
    // Void offers a draw and then mates instead.
    lobby.handle(v, { t: 'draw' });
    expect(ivory.last('state')!.state.drawOffer).toBe('b');
    play(v, 'd8h4', 3);
    expect(ivory.last('state')!.state).toMatchObject({ drawOffer: null, agreed: false });
    // An answer to it now is an answer to nothing.
    const heard = ivory.inbox.length;
    lobby.handle(ivory, { t: 'draw' });
    expect(ivory.inbox).toHaveLength(heard);
    lobby.handle(ivory, { t: 'again' });
    lobby.handle(v, { t: 'again' });
    expect(ivory.last('seated')!.state).toMatchObject({ moves: [], drawOffer: null, agreed: false });

    // Given up with an offer standing: the offer goes with the game.
    const other = table();
    other.play(other.ivory, 'e2e4', 0);
    other.play(other.void, 'e7e5', 1);
    other.lobby.handle(other.ivory, { t: 'draw' });
    other.lobby.handle(other.void, { t: 'resign' });
    expect(other.ivory.last('state')!.state).toMatchObject({ drawOffer: null, agreed: false, resigned: 'b' });
    // And in the game after, an offer may be made as soon as both have moved: the last game's count is forgotten.
    other.lobby.handle(other.ivory, { t: 'again' });
    other.lobby.handle(other.void, { t: 'again' });
    // The colours have swapped: the player who was Void is Ivory now.
    other.play(other.void, 'e2e4', 0);
    other.play(other.ivory, 'e7e5', 1);
    other.lobby.handle(other.ivory, { t: 'draw' });
    expect(other.void.last('state')!.state.drawOffer).toBe('b');
  });

  it('remembers an offer, and an agreed draw, for someone who comes back', () => {
    const { lobby, ivory, void: v, play } = table();
    play(ivory, 'e2e4', 0);
    play(v, 'e7e5', 1);
    lobby.handle(v, { t: 'draw' });
    const key = ivory.last('joined')!.token;
    lobby.leave(ivory);
    const back = new Fake();
    lobby.handle(back, { t: 'join', room: ROOM, token: key });
    expect(back.last('joined')).toMatchObject({ you: 'w', state: { drawOffer: 'b', agreed: false } });
    lobby.handle(back, { t: 'draw' });
    lobby.leave(back);
    const again = new Fake();
    lobby.handle(again, { t: 'join', room: ROOM, token: key });
    expect(again.last('joined')).toMatchObject({ you: 'w', state: { drawOffer: null, agreed: true } });
  });

  it('does not start another game while one is being played, however often it is asked', () => {
    const { lobby, ivory, void: v, play } = table();
    play(ivory, 'e2e4', 0);
    lobby.handle(ivory, { t: 'again' });
    lobby.handle(v, { t: 'again' });
    expect(ivory.last('seated')).toBeUndefined();
    lobby.handle(ivory, { t: 'sync' });
    expect(ivory.last('state')!.state).toMatchObject({ moves: [{ from: 'e2', to: 'e4' }], again: { w: false, b: false } });
  });

  it('starts one new game, not two, when both players press twice', () => {
    const { lobby, ivory, void: v, play } = table();
    'f2f3 e7e5 g2g4 d8h4'.split(' ').forEach((text, ply) => play(ply % 2 === 0 ? ivory : v, text, ply));
    for (const who of [ivory, v, ivory, v]) lobby.handle(who, { t: 'again' });
    expect(ivory.all('seated')).toHaveLength(1);
    expect(ivory.last('seated')!.you).toBe('b');
    // Nothing is left over to haunt the end of the next game.
    lobby.handle(ivory, { t: 'sync' });
    expect(ivory.last('state')!.state.again).toEqual({ w: false, b: false });
  });

  it('keeps the seats of a second game for its players, as it does once a first game is under way', () => {
    let now = 9_000_000;
    const { lobby, ivory, void: v, play } = table(() => now);
    'f2f3 e7e5 g2g4 d8h4'.split(' ').forEach((text, ply) => play(ply % 2 === 0 ? ivory : v, text, ply));
    lobby.handle(ivory, { t: 'again' });
    lobby.handle(v, { t: 'again' });
    // Before the first move of the second game, one of them is away for a while.
    const key = v.last('joined')!.token;
    lobby.leave(v);
    now += 60_000;
    const stranger = new Fake();
    lobby.handle(stranger, { t: 'join', room: ROOM });
    expect(stranger.last('joined')!.you).toBe('spectator');
    const back = new Fake();
    lobby.handle(back, { t: 'join', room: ROOM, token: key });
    // They were Void in the first game, so Ivory in the second.
    expect(back.last('joined')!.you).toBe('w');
  });

  it('remembers who is who if both players drop out between games', () => {
    const { lobby, ivory, void: v, play } = table();
    'f2f3 e7e5 g2g4 d8h4'.split(' ').forEach((text, ply) => play(ply % 2 === 0 ? ivory : v, text, ply));
    lobby.handle(ivory, { t: 'again' });
    lobby.handle(v, { t: 'again' });
    const keys = { first: ivory.last('joined')!.token, second: v.last('joined')!.token };
    lobby.leave(ivory);
    lobby.leave(v);
    expect(lobby.roomCount).toBe(1);
    // Whoever is back first, the colours are the swapped ones.
    const b = new Fake();
    lobby.handle(b, { t: 'join', room: ROOM, token: keys.second });
    const a = new Fake();
    lobby.handle(a, { t: 'join', room: ROOM, token: keys.first });
    expect(b.last('joined')!.you).toBe('w');
    expect(a.last('joined')!.you).toBe('b');
  });

  it('withdraws the hand of a window whose seat is taken over by a newer one', () => {
    const { lobby, ivory, void: v } = table();
    lobby.handle(ivory, { t: 'think', square: 'g1' });
    const again = new Fake();
    lobby.handle(again, { t: 'join', room: ROOM, token: ivory.last('joined')!.token });
    expect(v.last('think')).toEqual({ t: 'think', side: 'w', square: null });
  });

  it('keeps rooms apart', () => {
    const { lobby, ivory, play } = table();
    const elsewhere = new Fake();
    lobby.handle(elsewhere, { t: 'join', room: 'ZZZZZZ' });
    expect(elsewhere.last('joined')!.you).toBe('w');
    play(ivory, 'e2e4', 0);
    expect(elsewhere.last('moved')).toBeUndefined();
    expect(lobby.roomCount).toBe(2);
  });

  it('forgets at once a room that everyone has left without playing', () => {
    const { lobby, ivory, void: v } = table();
    lobby.leave(ivory);
    expect(lobby.roomCount).toBe(1);
    lobby.leave(v);
    expect(lobby.roomCount).toBe(0);
    // One connection wandering from room to room leaves nothing behind it.
    const wanderer = new Fake();
    for (const room of ['AAAAAA', 'BBBBBB', 'CCCCCC']) lobby.handle(wanderer, { t: 'join', room });
    expect(lobby.roomCount).toBe(1);
  });

  it('forgets a room that has stood empty for a long time, and not before', () => {
    let now = 5_000_000;
    const { lobby, ivory, void: v, play } = table(() => now);
    play(ivory, 'e2e4', 0);
    lobby.leave(ivory);
    lobby.leave(v);
    now += 19 * 60_000;
    lobby.sweep();
    expect(lobby.roomCount).toBe(1);
    now += 2 * 60_000;
    lobby.sweep();
    expect(lobby.roomCount).toBe(0);
  });
});

// -- over real sockets ----------------------------------------------------------

interface Client {
  socket: WebSocket;
  send(message: ClientMessage | string): void;
  /** The next message of a kind, waiting for it if it has not come yet. */
  next<T extends ServerMessage['t']>(t: T): Promise<Of<T>>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(port: number, options: { origin?: string } = {}): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
  const unread: ServerMessage[] = [];
  const waiting: { t: string; resolve: (m: ServerMessage) => void }[] = [];
  socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    const i = waiting.findIndex((w) => w.t === message.t);
    if (i >= 0) waiting.splice(i, 1)[0]!.resolve(message);
    else unread.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
  const client: Client = {
    socket,
    closed,
    send: (message) => socket.send(typeof message === 'string' ? message : JSON.stringify(message)),
    next: <T extends ServerMessage['t']>(t: T) =>
      new Promise<Of<T>>((resolve) => {
        const i = unread.findIndex((m) => m.t === t);
        if (i >= 0) resolve(unread.splice(i, 1)[0] as Of<T>);
        else waiting.push({ t, resolve: resolve as (m: ServerMessage) => void });
      }),
  };
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(client));
    socket.once('error', reject);
  });
}

describe('the server', () => {
  let running: Running;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'nightpiece-server-'));
    mkdirSync(path.join(root, 'assets'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Nightpiece</title>');
    writeFileSync(path.join(root, 'assets', 'index-B4dc0ffe.js'), 'console.log(1)');
    mkdirSync(path.join(root, 'engine'));
    writeFileSync(path.join(root, 'engine', 'stockfish-19-lite-single.js'), '// the loader');
    writeFileSync(path.join(root, 'engine', 'big.wasm'), Buffer.alloc(6 * 1024 * 1024, 7));
    writeFileSync(path.join(root, '..', 'nightpiece-outside.txt'), 'not for serving');
    running = await startServer({ port: 0, root });
  });
  afterAll(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(path.join(root, '..', 'nightpiece-outside.txt'), { force: true });
  });

  it('plays a game between two connections, with a third watching', async () => {
    const room = newRoomName();
    const ivory = await connect(running.port);
    ivory.send({ t: 'join', room });
    expect((await ivory.next('joined')).you).toBe('w');
    const v = await connect(running.port);
    v.send({ t: 'join', room });
    expect((await v.next('joined')).you).toBe('b');
    const watcher = await connect(running.port);
    watcher.send({ t: 'join', room, watch: true });
    expect((await watcher.next('joined')).state.taken).toEqual({ w: true, b: true });

    // Fool's mate.
    const plies = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
    for (let ply = 0; ply < plies.length; ply++) {
      (ply % 2 === 0 ? ivory : v).send({ t: 'move', ply, move: move(plies[ply]!) });
      for (const who of [ivory, v, watcher]) expect(await who.next('moved')).toEqual({ t: 'moved', ply, move: move(plies[ply]!) });
    }
    ivory.send({ t: 'move', ply: 4, move: move('e2e4') });
    const refused = await ivory.next('refused');
    expect(refused.reason).toBe('That move is not legal.');
    expect(refused.state.moves).toHaveLength(4);
    for (const who of [ivory, v, watcher]) who.socket.close();
  });

  it('gives a dropped player their seat and the game back', async () => {
    const room = newRoomName();
    const ivory = await connect(running.port);
    ivory.send({ t: 'join', room });
    await ivory.next('joined');
    const v = await connect(running.port);
    v.send({ t: 'join', room });
    const key = (await v.next('joined')).token;
    ivory.send({ t: 'move', ply: 0, move: move('d2d4') });
    await ivory.next('moved');
    await v.next('moved');

    v.socket.terminate();
    await v.closed;
    // Ivory hears that Void has gone.
    let state = (await ivory.next('state')).state;
    while (state.present.b) state = (await ivory.next('state')).state;

    const back = await connect(running.port);
    back.send({ t: 'join', room, token: key });
    const joined = await back.next('joined');
    expect(joined.you).toBe('b');
    expect(joined.state.moves).toEqual([{ from: 'd2', to: 'd4' }]);
    back.send({ t: 'move', ply: 1, move: move('d7d5') });
    expect((await ivory.next('moved')).ply).toBe(1);
    ivory.socket.close();
    back.socket.close();
  });

  it('ignores nonsense and carries on', async () => {
    const client = await connect(running.port);
    client.send('{"t":"join","room":"nope"}');
    client.send('][');
    client.socket.send(Buffer.from([1, 2, 3]));
    client.send({ t: 'join', room: newRoomName() });
    expect((await client.next('joined')).you).toBe('w');
    client.socket.close();
  });

  it('drops a connection that floods it, or sends something huge', async () => {
    const flood = await connect(running.port);
    flood.send({ t: 'join', room: newRoomName() });
    await flood.next('joined');
    for (let i = 0; i < 80; i++) flood.send({ t: 'sync' });
    expect((await flood.closed).code).toBe(1008);

    const huge = await connect(running.port);
    huge.send(JSON.stringify({ t: 'join', room: 'ABCDEF', padding: 'x'.repeat(5000) }));
    expect((await huge.closed).code).toBe(1009);
  });

  it('turns away a page on another site, but not one of its own', async () => {
    await expect(connect(running.port, { origin: 'http://elsewhere.example' })).rejects.toThrow(/403/);
    const own = await connect(running.port, { origin: `http://127.0.0.1:${running.port}` });
    own.socket.close();
  });

  it('serves the built game, and nothing outside it', async () => {
    const base = `http://127.0.0.1:${running.port}`;
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(home.headers.get('cache-control')).toBe('no-cache');
    expect(await home.text()).toContain('Nightpiece');

    const script = await fetch(`${base}/assets/index-B4dc0ffe.js`);
    expect(script.headers.get('content-type')).toContain('javascript');
    expect(script.headers.get('cache-control')).toContain('immutable');
    // Only what the bundler named by its contents may be kept for ever. The engine's loader has
    // a name that looks like such a name and is not one.
    const loader = await fetch(`${base}/engine/stockfish-19-lite-single.js`);
    expect(loader.status).toBe(200);
    expect(loader.headers.get('cache-control')).toBe('no-cache');

    // An address that is not a file is the game; a missing file is missing.
    expect(await (await fetch(`${base}/anything/else?room=ABCDEF`)).text()).toContain('Nightpiece');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    // Nor is an address with a part that begins with a dot: there is none, and what asks for one is looking for something left lying about.
    for (const hidden of ['/.env', '/.git/config', '/.git/HEAD', '/anything/.aws/credentials', '/%2egit/config', '/.well-known/nothing']) {
      const response = await fetch(base + hidden);
      expect(response.status, hidden).toBe(404);
      expect(await response.text(), hidden).not.toContain('Nightpiece');
    }

    for (const escape of ['/../nightpiece-outside.txt', '/%2e%2e/nightpiece-outside.txt', '/..%5cnightpiece-outside.txt', '/assets/..%2f..%2fnightpiece-outside.txt']) {
      const response = await fetch(base + escape);
      expect([403, 404], escape).toContain(response.status);
      expect(await response.text(), escape).not.toContain('not for serving');
    }
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });

  it('does not send again a file the browser already has', async () => {
    const url = `http://127.0.0.1:${running.port}/engine/big.wasm`;
    const first = await fetch(url);
    const tag = first.headers.get('etag');
    expect(tag).toBeTruthy();
    expect((await first.arrayBuffer()).byteLength).toBe(6 * 1024 * 1024);
    const second = await fetch(url, { headers: { 'if-none-match': tag! } });
    expect(second.status).toBe(304);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
    // A file that has changed since is sent whole.
    const stale = await fetch(url, { headers: { 'if-none-match': 'W/"1-1"' } });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();

    // The mark is of the contents, not of the file's date: built again and no different, as every
    // file is by a host that builds afresh for each release, it is still the one the browser has.
    const file = path.join(root, 'engine', 'big.wasm');
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    expect((await fetch(url, { headers: { 'if-none-match': tag! } })).status).toBe(304);
    // Different, though no bigger, it is sent.
    const bytes = readFileSync(file);
    bytes[0] = bytes[0]! ^ 1;
    writeFileSync(file, bytes);
    const changed = await fetch(url, { headers: { 'if-none-match': tag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(tag);
    await changed.arrayBuffer();
    bytes[0] = bytes[0]! ^ 1;
    writeFileSync(file, bytes);
  });

  it('sends the big files squeezed to a browser that can undo it, and whole to one that cannot', async () => {
    const url = `http://127.0.0.1:${running.port}/engine/big.wasm`;
    // What actually crosses the wire, which `fetch` would undo before showing it.
    const raw = (accepts: string | null, method = 'GET') =>
      new Promise<{ head: string; body: Buffer }>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const socket = net.connect(running.port, '127.0.0.1', () =>
          socket.write(`${method} /engine/big.wasm HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${accepts === null ? '' : `Accept-Encoding: ${accepts}\r\n`}\r\n`),
        );
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.once('error', reject);
        socket.once('close', () => {
          const all = Buffer.concat(chunks);
          const split = all.indexOf('\r\n\r\n');
          resolve({ head: all.subarray(0, split).toString('latin1').toLowerCase(), body: all.subarray(split + 4) });
        });
      });
    const whole = Buffer.alloc(6 * 1024 * 1024, 7);

    const plain = await raw(null);
    expect(plain.head).not.toContain('content-encoding');
    expect(plain.head).toContain('vary: accept-encoding');
    expect(plain.body.equals(whole)).toBe(true);

    const br = await raw('gzip, deflate, br');
    expect(br.head).toContain('content-encoding: br');
    expect(br.head).toContain('vary: accept-encoding');
    expect(br.head).toContain(`content-length: ${br.body.length}`);
    expect(br.body.length).toBeLessThan(whole.length / 100);
    expect(brotliDecompressSync(br.body).equals(whole)).toBe(true);

    const gz = await raw('gzip');
    expect(gz.head).toContain('content-encoding: gzip');
    expect(gunzipSync(gz.body).equals(whole)).toBe(true);

    // A browser that refuses a way of squeezing is not sent it.
    expect((await raw('br;q=0, gzip;q=0')).head).not.toContain('content-encoding');
    expect((await raw('br;q=0, gzip')).head).toContain('content-encoding: gzip');
    // Asked only how big it is, the server says how big the squeezed copy is and sends nothing.
    const asked = await raw('br', 'HEAD');
    expect(asked.head).toContain(`content-length: ${br.body.length}`);
    expect(asked.body.length).toBe(0);

    // The same mark either way, so a browser that has the file is still told so.
    const tag = (await fetch(url)).headers.get('etag');
    expect(br.head).toContain(`etag: ${tag!.toLowerCase()}`);
    expect((await fetch(url, { headers: { 'if-none-match': tag! } })).status).toBe(304);

    // Small files and files that are packed already go as they are.
    const small = await fetch(`http://127.0.0.1:${running.port}/assets/index-B4dc0ffe.js`);
    expect(small.headers.get('content-encoding')).toBeNull();
    expect(await small.text()).toBe('console.log(1)');
  });

  it('knows which way of squeezing a browser will take', () => {
    expect(codingFor('gzip, deflate, br, zstd')).toBe('br');
    expect(codingFor('gzip, deflate')).toBe('gzip');
    expect(codingFor(' GZIP ; q=0.5 , BR ; q=1 ')).toBe('br');
    expect(codingFor('br;q=0, gzip')).toBe('gzip');
    expect(codingFor('br;q=0.0, gzip;q=0')).toBeNull();
    expect(codingFor('identity')).toBeNull();
    expect(codingFor(undefined)).toBeNull();
    expect(codingFor('')).toBeNull();
  });

  it('lets go of a file when the download is abandoned', async () => {
    // The number the system gives the next file opened: it climbs if files are being left open.
    const nextFree = () => {
      const fd = openSync(path.join(root, 'index.html'), 'r');
      closeSync(fd);
      return fd;
    };
    const abandon = () =>
      new Promise<void>((resolve) => {
        const socket = net.connect(running.port, '127.0.0.1', () => socket.write('GET /engine/big.wasm HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
        // The page is closed as soon as the file starts to arrive.
        socket.once('data', () => socket.destroy());
        socket.once('close', () => resolve());
        socket.once('error', () => resolve());
      });
    const before = nextFree();
    for (let round = 0; round < 3; round++) await Promise.all(Array.from({ length: 10 }, abandon));
    // The files are let go as the closed sockets are noticed: as soon as a busy machine gets to it.
    for (let waited = 0; nextFree() - before > 2 && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(nextFree() - before).toBeLessThanOrEqual(2);
    // And the server is none the worse for it.
    expect((await fetch(`http://127.0.0.1:${running.port}/`)).status).toBe(200);
  });

  it('says so, and survives, when its port is already taken', async () => {
    await expect(startServer({ port: running.port, root })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect((await fetch(`http://127.0.0.1:${running.port}/`)).status).toBe(200);
  });
});
