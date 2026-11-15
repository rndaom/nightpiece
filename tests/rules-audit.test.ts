/**
 * An audit of the rules and of ranked play, written before the game is made public: that it is
 * exactly chess (FIDE Laws), and that no player of an online game is helped.
 *
 * Passing tests show what is right. A test marked `it.fails` states what FIDE (or fairness)
 * requires and fails today: it is a finding, kept here so that the suite stays green and the
 * finding is proved, not merely claimed. When one is fixed, vitest says so (the `fails` test
 * starts passing, which fails it), and the mark comes off.
 */
import { Chess } from 'chess.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { type Running, startServer } from '../server/main.ts';
import { ABANDON_AFTER, CLOCK_DELAY, CLOCK_INCREMENT, CLOCK_START, type Connection, Lobby } from '../server/rooms.ts';
import { playerKey, Scores, START_RATING } from '../server/scores.ts';
import { Game, IllegalMoveError, type PromotionKind, type Square, START_FEN } from '../src/core/game.ts';
import { type ClientMessage, type MoveData, newRoomName, parseClientMessage, type ServerMessage } from '../src/net/protocol.ts';
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

// -- helpers ------------------------------------------------------------------------

const sq = (s: string) => s as Square;

/** Play moves given as "e2e4" / "e7e8q". */
function playAll(game: Game, ...moves: string[]): void {
  for (const m of moves) game.move(sq(m.slice(0, 2)), sq(m.slice(2, 4)), (m[4] as PromotionKind | undefined) ?? undefined);
}

/** The pieces the FEN says are on the board, as "square:colour+kind". */
function fenBoard(fen: string): string[] {
  const out: string[] = [];
  const rows = fen.split(' ')[0]!.split('/');
  rows.forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else {
        out.push(`${'abcdefgh'[file]}${8 - i}:${ch === ch.toUpperCase() ? 'w' : 'b'}${ch.toLowerCase()}`);
        file++;
      }
    }
  });
  return out.sort();
}

/** The wrapper's tracked pieces agree with the rules engine's board, and every identity is unique. */
function identityConsistent(game: Game): boolean {
  const pieces = game.pieces();
  const ids = new Set(pieces.map((p) => p.id));
  if (ids.size !== pieces.length) return false;
  const tracked = pieces.map((p) => `${p.square}:${p.side}${p.kind}`).sort();
  return JSON.stringify(tracked) === JSON.stringify(fenBoard(game.fen()));
}

/** Perft through the wrapper's own moves()/move()/undo(), checking identity tracking at every interior node. */
function wrapperPerft(game: Game, depth: number, problems: string[]): number {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of game.moves()) {
    game.move(m.from, m.to, m.promotion);
    if (depth > 1 && !identityConsistent(game)) problems.push(game.fen());
    n += wrapperPerft(game, depth - 1, problems);
    game.undo();
  }
  return n;
}

/** A small seeded random number generator, so a failure can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Of<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;
class Fake implements Connection {
  inbox: ServerMessage[] = [];
  closed = false;
  send(message: ServerMessage): void {
    this.inbox.push(message);
  }
  close(): void {
    this.closed = true;
  }
  last<T extends ServerMessage['t']>(t: T): Of<T> | undefined {
    return [...this.inbox].reverse().find((m): m is Of<T> => m.t === t);
  }
}
const mv = (text: string): MoveData => ({
  from: sq(text.slice(0, 2)),
  to: sq(text.slice(2, 4)),
  ...(text[4] ? { promotion: text[4] as PromotionKind } : {}),
});
/** The server's own copy of a room's game, for tests that set up a position directly. */
type RoomInternals = { game: Game; moved: Record<'w' | 'b', boolean>; since: number | null; left: Record<'w' | 'b', number> };
const roomOf = (lobby: Lobby, name: string) => (lobby as unknown as { rooms: Map<string, RoomInternals> }).rooms.get(name)!;

/** A private (friendly) room with two players seated. */
function privateRoom() {
  const lobby = new Lobby(() => 1_000_000);
  const name = 'ABCDEF';
  const w = new Fake();
  const b = new Fake();
  lobby.handle(w, { t: 'join', room: name });
  lobby.handle(b, { t: 'join', room: name });
  expect(w.last('joined')!.you).toBe('w');
  expect(b.last('joined')!.you).toBe('b');
  return { lobby, name, w, b, room: () => roomOf(lobby, name) };
}

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

/** Two players matched by the queue and seated in their ranked room, on a clock the test moves. */
function ranked() {
  let time = 1_000_000;
  const clock = { now: () => time, pass: (ms: number) => (time += ms) };
  const scores = new Scores(null, clock.now);
  const lobby = new Lobby(clock.now, scores);
  const hallA = new Fake();
  const hallB = new Fake();
  lobby.handle(hallA, { t: 'hello', id: ID_A });
  lobby.handle(hallB, { t: 'hello', id: ID_B });
  lobby.handle(hallA, { t: 'queue' });
  lobby.handle(hallB, { t: 'queue' });
  const name = hallA.last('matched')!.room;
  const a = new Fake();
  const b = new Fake();
  lobby.handle(a, { t: 'hello', id: ID_A });
  lobby.handle(a, { t: 'join', room: name });
  lobby.handle(b, { t: 'hello', id: ID_B });
  lobby.handle(b, { t: 'join', room: name });
  const aIsWhite = a.last('joined')!.you === 'w';
  const w = aIsWhite ? a : b;
  const bl = aIsWhite ? b : a;
  const wKey = playerKey(aIsWhite ? ID_A : ID_B);
  const bKey = playerKey(aIsWhite ? ID_B : ID_A);
  // The first clock starts a few seconds after both have sat down.
  clock.pass(CLOCK_DELAY);
  lobby.tick();
  return { lobby, clock, scores, name, w, b: bl, wKey, bKey, room: () => roomOf(lobby, name) };
}

/** A ranked game in which both players have made their first move. */
function rankedUnderWay() {
  const r = ranked();
  r.lobby.handle(r.w, { t: 'move', ply: 0, move: mv('e2e4') });
  r.lobby.handle(r.b, { t: 'move', ply: 1, move: mv('e7e5') });
  return r;
}

// =====================================================================================
// Part 1: the rules
// =====================================================================================

describe('move generation by perft', () => {
  const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  const POS3 = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';
  const POS5 = 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8';

  it('start position, depth 1-4: 20, 400, 8902, 197281', () => {
    const g = new Game();
    expect([1, 2, 3, 4].map((d) => g.perft(d))).toEqual([20, 400, 8902, 197281]);
  });
  it('Kiwipete, depth 1-3: 48, 2039, 97862', () => {
    const g = new Game(KIWIPETE);
    expect([1, 2, 3].map((d) => g.perft(d))).toEqual([48, 2039, 97862]);
  });
  it('position 3, depth 1-4: 14, 191, 2812, 43238', () => {
    const g = new Game(POS3);
    expect([1, 2, 3, 4].map((d) => g.perft(d))).toEqual([14, 191, 2812, 43238]);
  });
  it('position 5, depth 1-3: 44, 1486, 62379', () => {
    const g = new Game(POS5);
    expect([1, 2, 3].map((d) => g.perft(d))).toEqual([44, 1486, 62379]);
  });

  // The counts above are chess.js's own. These walk the wrapper itself (moves, move, undo) so the
  // layer the game and the server actually use is checked too, and identity tracking with it.
  it('the wrapper (moves/move/undo) gives the same counts and never loses a piece', () => {
    const cases: [string, number, number][] = [
      [START_FEN, 3, 8902],
      [KIWIPETE, 2, 2039],
      [POS3, 3, 2812],
      [POS5, 2, 1486],
    ];
    for (const [fen, depth, expected] of cases) {
      const g = new Game(fen);
      const problems: string[] = [];
      expect(wrapperPerft(g, depth, problems)).toBe(expected);
      expect(problems).toEqual([]);
      expect(g.fen()).toBe(new Game(fen).fen());
      expect(identityConsistent(g)).toBe(true);
    }
  }, 120_000);

  it('the wrapper lists the very moves chess.js lists in full, in its order, through random games', () => {
    const random = rng(31);
    let seen = 0;
    for (const fen of [START_FEN, KIWIPETE, POS3, POS5, '4k3/1P6/8/8/8/8/6p1/4K3 w - - 0 1', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8']) {
      for (let game = 0; game < 3; game++) {
        const g = new Game(fen);
        for (let ply = 0; ply < 60 && !g.status().over; ply++) {
          const legal = g.moves();
          const full = new Chess(g.fen()).moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}) }));
          expect(legal).toEqual(full);
          seen += legal.length;
          const m = legal[Math.floor(random() * legal.length)]!;
          g.move(m.from, m.to, m.promotion);
        }
      }
    }
    expect(seen).toBeGreaterThan(10_000);
  }, 120_000);

  it('the per-square options (what the board offers on a click) cover exactly the legal moves', () => {
    for (const fen of [START_FEN, KIWIPETE, POS3, POS5]) {
      const g = new Game(fen);
      const legal = new Set(g.moves().map((m) => m.from + m.to));
      const offered = new Set<string>();
      for (const p of g.pieces()) for (const o of g.movesFrom(p.square)) offered.add(o.from + o.to);
      expect([...offered].sort()).toEqual([...legal].sort());
    }
  });
});

describe('castling', () => {
  const BOTH = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  const castles = (g: Game) =>
    g
      .moves()
      .filter((m) => m.from === 'e1' || m.from === 'e8')
      .filter((m) => Math.abs(m.from.charCodeAt(0) - m.to.charCodeAt(0)) === 2)
      .map((m) => m.from + m.to)
      .sort();

  it('both sides, both colours, and the rook comes round', () => {
    const g = new Game(BOTH);
    expect(castles(g)).toEqual(['e1c1', 'e1g1']);
    const e = g.move(sq('e1'), sq('g1'));
    expect(e.castle).toBe('k');
    expect(e.rook).toMatchObject({ from: 'h1', to: 'f1' });
    expect(castles(g)).toEqual(['e8c8', 'e8g8']);
    const f = g.move(sq('e8'), sq('c8'));
    expect(f.castle).toBe('q');
    expect(f.rook).toMatchObject({ from: 'a8', to: 'd8' });
    expect(identityConsistent(g)).toBe(true);
  });

  it('not out of check', () => {
    expect(castles(new Game('r3k2r/8/8/8/4r3/8/8/R3K2R w KQkq - 0 1'))).toEqual([]);
  });
  it('not through an attacked square (f1 / d1), but b1 attacked does not matter', () => {
    expect(castles(new Game('4k3/8/8/8/8/5r2/8/R3K2R w KQ - 0 1'))).toEqual(['e1c1']); // f1 covered
    expect(castles(new Game('4k3/8/8/8/8/3r4/8/R3K2R w KQ - 0 1'))).toEqual(['e1g1']); // d1 covered
    expect(castles(new Game('4k3/8/8/8/8/1r6/8/R3K2R w KQ - 0 1'))).toEqual(['e1c1', 'e1g1']); // only b1 covered: allowed
  });
  it('not into check', () => {
    expect(castles(new Game('4k3/8/8/8/8/6r1/8/R3K2R w KQ - 0 1'))).toEqual(['e1c1']);
    expect(castles(new Game('4k3/8/8/8/8/2r5/8/R3K2R w KQ - 0 1'))).toEqual(['e1g1']);
  });
  it('not with a piece between king and rook (b1 included)', () => {
    expect(castles(new Game('4k3/8/8/8/8/8/8/RN2K1NR w KQ - 0 1'))).toEqual([]);
  });
  it('not after the king has moved and come back, nor after a rook has', () => {
    const OPEN = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const g = new Game(OPEN);
    playAll(g, 'e1e2', 'e8e7', 'e2e1', 'e7e8');
    expect(castles(g)).toEqual([]);
    const h = new Game(OPEN);
    playAll(h, 'h1h2', 'a8b8', 'h2h1', 'b8a8');
    expect(castles(h)).toEqual(['e1c1']);
  });
  it('not with a rook that was captured on its home square (and a new rook arriving there gives no right)', () => {
    // The black bishop takes the h1 rook; the right to castle short is gone for good.
    const g = new Game('4k3/8/8/8/8/8/6b1/R3K2R b KQ - 0 1');
    playAll(g, 'g2h1');
    expect(g.fen().split(' ')[2]).toBe('Q');
    expect(castles(g)).toEqual(['e1c1']);
  });
  it('rights read from the FEN are honoured, and a right the board contradicts is dropped', () => {
    expect(castles(new Game('r3k2r/8/8/8/8/8/8/R3K2R w Kq - 0 1'))).toEqual(['e1g1']);
    // FEN claims KQ but the h1 rook is on g1: only the long right survives (tidyFen).
    const g = new Game('4k3/8/8/8/8/8/8/R3K1R1 w KQ - 0 1');
    expect(g.startFen().split(' ')[2]).toBe('Q');
    expect(castles(g)).toEqual(['e1c1']);
  });
});

describe('en passant', () => {
  it('only on the very next move', () => {
    const g = new Game();
    playAll(g, 'e2e4', 'a7a6', 'e4e5', 'd7d5');
    expect(g.moves().some((m) => m.from === 'e5' && m.to === 'd6')).toBe(true);
    playAll(g, 'h2h3', 'a6a5');
    expect(g.moves().some((m) => m.from === 'e5' && m.to === 'd6')).toBe(false);
  });
  it('removes the right pawn and keeps identities', () => {
    const g = new Game();
    playAll(g, 'e2e4', 'a7a6', 'e4e5', 'd7d5');
    const victim = g.pieceAt(sq('d5'))!;
    const e = g.move(sq('e5'), sq('d6'));
    expect(e.enPassant).toBe(true);
    expect(e.captured).toMatchObject({ id: victim.id, square: 'd5' });
    expect(g.pieceAt(sq('d5'))).toBeNull();
    expect(identityConsistent(g)).toBe(true);
    g.undo();
    expect(identityConsistent(g)).toBe(true);
  });
  it('is refused when it would expose the king along the rank', () => {
    // White Ka5, Pb5; Black plays c7-c5 with a rook on h5: bxc6 would leave the king to the rook.
    const g = new Game('7k/2p5/8/KP5r/8/8/8/8 b - - 0 1');
    playAll(g, 'c7c5');
    expect(g.moves().some((m) => m.from === 'b5' && m.to === 'c6')).toBe(false);
    expect(() => g.move(sq('b5'), sq('c6'))).toThrow(IllegalMoveError);
  });
  it('can give check (discovered along the diagonal)', () => {
    // Bishop a2, black king g8; ...d7-d5 blocks the diagonal and exd6 e.p. opens it again.
    const g = new Game('6k1/3p4/8/4P3/8/8/B7/4K3 b - - 0 1');
    playAll(g, 'd7d5');
    const e = g.move(sq('e5'), sq('d6'));
    expect(e.enPassant).toBe(true);
    expect(e.status.inCheck).toBe(true);
  });
  it('a FEN en passant square that no pawn could have made is dropped', () => {
    expect(new Game('4k3/8/8/8/8/8/8/4K3 w - e6 0 1').startFen().split(' ')[3]).toBe('-');
  });
});

describe('promotion', () => {
  const FEN = '1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1';
  it('to each of the four pieces, straight and with a capture; never to a king or a pawn', () => {
    const got = new Game(FEN)
      .moves()
      .filter((m) => m.from === 'a7')
      .map((m) => m.to + m.promotion)
      .sort();
    expect(got).toEqual(['a8b', 'a8n', 'a8q', 'a8r', 'b8b', 'b8n', 'b8q', 'b8r']);
    for (const p of ['q', 'r', 'b', 'n'] as const) {
      const g = new Game(FEN);
      const e = g.move(sq('a7'), sq('b8'), p);
      expect(e.promotion).toBe(p);
      expect(e.captured?.kind).toBe('r');
      expect(g.pieceAt(sq('b8'))).toMatchObject({ kind: p, side: 'w' });
      expect(identityConsistent(g)).toBe(true);
    }
  });
  it('is required: a pawn cannot reach the last rank without becoming something', () => {
    const g = new Game(FEN);
    expect(() => g.move(sq('a7'), sq('a8'))).toThrow(IllegalMoveError);
    expect(g.fen()).toBe(new Game(FEN).fen());
  });
  it('underpromotion to a knight gives check; to a queen it gives mate', () => {
    const g = new Game('8/5P1k/8/6K1/8/8/8/8 w - - 0 1');
    expect(g.move(sq('f7'), sq('f8'), 'n').status.inCheck).toBe(true);
    const h = new Game('7k/1P6/6K1/8/8/8/8/8 w - - 0 1');
    expect(h.move(sq('b7'), sq('b8'), 'q').status).toMatchObject({ result: 'checkmate', winner: 'w' });
  });
  it('underpromotion to a rook avoids the stalemate a queen would give', () => {
    const FEN2 = '8/k1P5/2K5/8/8/8/8/8 w - - 0 1';
    expect(new Game(FEN2).move(sq('c7'), sq('c8'), 'q').status).toMatchObject({ result: 'draw', drawReason: 'stalemate' });
    expect(new Game(FEN2).move(sq('c7'), sq('c8'), 'r').status.over).toBe(false);
  });
  it('a promoted piece that is then captured, and the capture taken back, keeps its identity and kind', () => {
    const g = new Game('1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    const e = g.move(sq('a7'), sq('a8'), 'q');
    const id = e.piece.id;
    const f = g.move(sq('b8'), sq('a8'));
    expect(f.captured).toMatchObject({ id, kind: 'q' });
    g.undo();
    expect(g.pieceAt(sq('a8'))).toMatchObject({ id, kind: 'q' });
    g.undo();
    expect(g.pieceAt(sq('a7'))).toMatchObject({ id, kind: 'p' });
    expect(identityConsistent(g)).toBe(true);
  });
  it('typed: "a8" alone is read as needing a choice, "a8=N" as a knight', () => {
    const g = new Game(FEN);
    expect(g.readMove('a8')).toEqual({ from: 'a7', to: 'a8' });
    expect(g.readMove('a8=N')).toEqual({ from: 'a7', to: 'a8', promotion: 'n' });
  });
});

describe('check, mate, stalemate', () => {
  it("fool's mate is mate", () => {
    const g = new Game();
    playAll(g, 'f2f3', 'e7e5', 'g2g4', 'd8h4');
    expect(g.status()).toMatchObject({ over: true, result: 'checkmate', winner: 'b' });
    expect(g.moves()).toEqual([]);
  });
  it('double check: only king moves are legal', () => {
    // Knight from e4 to f6 gives check, uncovering the e1 rook on e8: double check.
    const g = new Game('4k3/8/8/8/4N3/8/8/4RK2 w - - 0 1');
    const e = g.move(sq('e4'), sq('f6'));
    expect(e.status.inCheck).toBe(true);
    expect(e.status.checkers.sort()).toEqual(['e1', 'f6']);
    expect(new Set(g.moves().map((m) => m.from))).toEqual(new Set(['e8']));
  });
  it('discovered check', () => {
    const g = new Game('4k3/8/8/8/4N3/8/8/4RK2 w - - 0 1');
    const e = g.move(sq('e4'), sq('c5'));
    expect(e.status.inCheck).toBe(true);
    expect(e.status.checkers).toEqual(['e1']);
  });
  it('a pinned piece may not move off the line; a king may not step into check', () => {
    const g = new Game('4k3/4r3/8/8/8/8/4B3/4K3 w - - 0 1');
    expect(g.movesFrom(sq('e2'))).toEqual([]);
    const h = new Game('4k3/8/8/8/8/8/3r4/4K3 w - - 0 1');
    expect(h.movesFrom(sq('e1')).map((o) => o.to).sort()).toEqual(['d2', 'f1']);
  });
  it('stalemate is a draw, not a loss', () => {
    const g = new Game('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(g.status()).toMatchObject({ over: true, result: 'draw', drawReason: 'stalemate', winner: null });
  });
});

describe('draws', () => {
  const ended = (fen: string) => new Game(fen).status();
  it('insufficient material: K v K, K+B v K, K+N v K, K+B v K+B on the same colour end the game', () => {
    expect(ended('4k3/8/8/8/8/8/8/4K3 w - - 0 1').drawReason).toBe('insufficient');
    expect(ended('4k3/8/8/8/8/8/8/2B1K3 w - - 0 1').drawReason).toBe('insufficient');
    expect(ended('4k3/8/8/8/8/8/8/1N2K3 w - - 0 1').drawReason).toBe('insufficient');
    // c1 and f8 are both dark squares.
    expect(ended('4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1').drawReason).toBe('insufficient');
  });
  it('K+N+N v K, K+B v K+N, K+B v K+B on opposite colours, and K+N v K+N are played on (mate is possible)', () => {
    for (const fen of [
      '4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1',
      '4kn2/8/8/8/8/8/8/2B1K3 w - - 0 1',
      '4k1b1/8/8/8/8/8/8/2B1K3 w - - 0 1', // g8 light, c1 dark
      '4kn2/8/8/8/8/8/8/1N2K3 w - - 0 1',
    ]) {
      expect(ended(fen).over).toBe(false);
    }
  });

  // FIDE 9.2 / 9.3: threefold repetition and the fifty-move rule are draws only when CLAIMED by a
  // player; the game ends by itself only at the fifth repetition (9.6.1) or after 75 moves (9.6.2).
  const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  it('threefold: the game goes on, and the player to move may claim the draw', () => {
    const g = new Game();
    playAll(g, ...shuffle, ...shuffle);
    expect(g.status()).toMatchObject({ over: false, claimable: 'threefold' });
    expect(g.claimDraw()).toBe(true);
    expect(g.status()).toMatchObject({ over: true, result: 'draw', drawReason: 'threefold' });
  });
  it('FIDE 9.2: threefold is only claimable; the game should go on until a claim (or the fifth occurrence)', () => {
    const g = new Game();
    playAll(g, ...shuffle, ...shuffle);
    expect(g.status().over).toBe(false);
    playAll(g, ...shuffle, ...shuffle);
    expect(g.status()).toMatchObject({ over: true, drawReason: 'fivefold' });
  });
  it('fifty-move: at the 100th quiet ply the draw may be claimed, and the game goes on', () => {
    const g = new Game('4k3/8/8/8/8/8/R7/4K3 w - - 99 80');
    playAll(g, 'a2a3');
    expect(g.status()).toMatchObject({ over: false, claimable: 'fifty-move' });
  });
  it('FIDE 9.3: fifty moves are only claimable; the game should go on until a claim or 75 moves (9.6.2)', () => {
    const g = new Game('4k3/8/8/8/8/8/R7/4K3 w - - 99 80');
    playAll(g, 'a2a3');
    expect(g.status().over).toBe(false);
    const late = new Game('4k3/8/8/8/8/8/R7/4K3 w - - 149 105');
    playAll(late, 'a2a3');
    expect(late.status()).toMatchObject({ over: true, drawReason: 'seventy-five-move' });
  });
  it('a mate on the hundredth quiet ply is a mate, not a fifty-move draw (FIDE 9.3)', () => {
    const g = new Game('7k/R7/6K1/8/8/8/8/8 w - - 99 80');
    playAll(g, 'a7a8');
    expect(g.status()).toMatchObject({ result: 'checkmate', winner: 'w' });
  });
  it('the server does not end a game on threefold by itself; the player to move claims it, and in a ranked room that is rated as a draw', () => {
    const r = ranked();
    const seq = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
    seq.forEach((m, i) => r.lobby.handle(i % 2 === 0 ? r.w : r.b, { t: 'move', ply: i, move: mv(m) }));
    expect(r.w.last('state')?.state.change ?? null).toBeNull();
    expect(r.scores.get(r.wKey)!.draws).toBe(0);
    // Black has just moved: only White, to move, may claim.
    r.lobby.handle(r.b, { t: 'claim' });
    expect(r.b.last('refused')!.reason).toMatch(/player to move/);
    r.lobby.handle(r.w, { t: 'claim' });
    const state = r.b.last('state')!.state;
    expect(state).toMatchObject({ claimed: 'threefold', change: { w: 0, b: 0 }, agreed: false, resigned: null });
    expect(r.scores.get(r.wKey)).toMatchObject({ draws: 1 });
    // And nothing more can be claimed, moved or resigned.
    r.lobby.handle(r.w, { t: 'claim' });
    r.lobby.handle(r.b, { t: 'resign' });
    expect(r.scores.get(r.bKey)).toMatchObject({ draws: 1, losses: 0 });
  });

  // FIDE 9.2.3: positions are the same when the same moves are possible. An en passant capture that
  // a pin forbids is not a possible move, so the position after ...c5 is the same as the later ones.
  it('repetition counts a position with an en passant capture that a pin forbids as the same position (FIDE 9.2.3)', () => {
    const g = new Game('7k/2p5/8/KP5r/8/8/8/8 b - - 0 1');
    playAll(g, 'c7c5'); // 1st occurrence (ep "possible" only on paper)
    playAll(g, 'a5a4', 'h8g8', 'a4a5', 'g8h8'); // 2nd
    playAll(g, 'a5a4', 'h8g8', 'a4a5', 'g8h8'); // 3rd: should be threefold
    expect(g.status().claimable).toBe('threefold');
    g.claimDraw();
    expect(g.status().drawReason).toBe('threefold');
  });

  it('draw by agreement', () => {
    const g = new Game();
    playAll(g, 'e2e4', 'e7e5');
    expect(g.agreeDraw()).toBe(true);
    expect(g.status()).toMatchObject({ over: true, result: 'draw', drawReason: 'agreement' });
    expect(() => g.move(sq('g1'), sq('f3'))).toThrow(IllegalMoveError);
  });
});

describe('identity tracking never throws on a legal game', () => {
  it('random games of every kind of move, with take-backs, keep the identities true to the board', () => {
    const random = rng(20261112);
    const starts = [START_FEN, 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', '4k3/1P6/8/8/8/8/6p1/4K3 w - - 0 1'];
    let moves = 0;
    for (let game = 0; game < 120; game++) {
      const g = new Game(starts[game % starts.length]);
      for (let ply = 0; ply < 200 && !g.status().over; ply++) {
        const legal = g.moves();
        const m = legal[Math.floor(random() * legal.length)]!;
        g.move(m.from, m.to, m.promotion);
        moves++;
        expect(identityConsistent(g)).toBe(true);
        // Now and then, take one or two back and go on.
        if (random() < 0.08) {
          g.undo();
          if (random() < 0.5) g.undo();
          expect(identityConsistent(g)).toBe(true);
        }
      }
    }
    expect(moves).toBeGreaterThan(5000);
  }, 120_000);
});

// =====================================================================================
// Part 1, again through the server's move path
// =====================================================================================

describe("the server's move path", () => {
  it('a private room can only be started from the usual position (no FEN in the protocol)', () => {
    const r = privateRoom();
    expect(r.w.last('joined')!.state.startFen).toBe(START_FEN);
    // A join message carrying a fen is read without it.
    expect(parseClientMessage(JSON.stringify({ t: 'join', room: 'ABCDEF', fen: '4k3/8/8/8/8/8/8/QQQQK3 w - - 0 1' }))).toEqual({ t: 'join', room: 'ABCDEF' });
  });

  it('refuses a pawn reaching the last rank with no piece named, and does not change the game', () => {
    const r = privateRoom();
    r.room().game = new Game('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    const before = r.room().game.fen();
    r.lobby.handle(r.w, { t: 'move', ply: 0, move: mv('b7b8') });
    expect(r.w.last('refused')).toBeDefined();
    expect(r.room().game.fen()).toBe(before);
    r.lobby.handle(r.w, { t: 'move', ply: 0, move: mv('b7b8n') });
    expect(r.room().game.pieceAt(sq('b8'))).toMatchObject({ kind: 'n', side: 'w' });
  });

  it('refuses a promotion to a king or a pawn at the door (the message is not even read)', () => {
    for (const p of ['k', 'p', 'Q', 'x', '']) {
      expect(parseClientMessage(JSON.stringify({ t: 'move', ply: 0, move: { from: 'b7', to: 'b8', promotion: p } }))).toBeNull();
    }
  });

  it('a promotion named on a move that does not promote is ignored by the rules (the game is safe)', () => {
    const r = privateRoom();
    r.lobby.handle(r.w, { t: 'move', ply: 0, move: mv('e2e4q') });
    expect(r.room().game.pieceAt(sq('e4'))).toMatchObject({ kind: 'p' });
    expect(r.room().game.history()[0]!.promotion).toBeNull();
  });
  it('...and the server passes on the move as played: a stray promotion is not sent to everyone', () => {
    const r = privateRoom();
    r.lobby.handle(r.w, { t: 'move', ply: 0, move: mv('e2e4q') });
    expect(r.b.last('moved')!.move).toEqual({ from: 'e2', to: 'e4' });
  });

  it('refuses moves out of turn, by a spectator, for an old position, and illegal ones', () => {
    const r = privateRoom();
    const watcher = new Fake();
    r.lobby.handle(watcher, { t: 'join', room: r.name });
    r.lobby.handle(r.b, { t: 'move', ply: 0, move: mv('e7e5') });
    r.lobby.handle(watcher, { t: 'move', ply: 0, move: mv('e2e4') });
    r.lobby.handle(r.w, { t: 'move', ply: 3, move: mv('e2e4') });
    r.lobby.handle(r.w, { t: 'move', ply: 0, move: mv('e2e5') });
    expect(r.room().game.history()).toHaveLength(0);
  });

  it('random games through the server: no exception escapes Lobby.handle, and both copies agree', () => {
    const random = rng(7);
    for (let n = 0; n < 40; n++) {
      const r = privateRoom();
      const local = new Game();
      for (let ply = 0; ply < 250 && !local.status().over; ply++) {
        const legal = local.moves();
        const m = legal[Math.floor(random() * legal.length)]!;
        const mover = local.turn() === 'w' ? r.w : r.b;
        // Junk first: a stray promotion, a wrong square, a stale ply. None may throw.
        expect(() => r.lobby.handle(mover, { t: 'move', ply, move: { from: m.from, to: m.from, promotion: 'q' } })).not.toThrow();
        expect(() => r.lobby.handle(mover, { t: 'move', ply: ply + 1, move: m })).not.toThrow();
        expect(() => r.lobby.handle(mover, { t: 'move', ply, move: { from: m.from, to: m.to, ...(m.promotion ? {} : { promotion: 'n' }) } as MoveData })).not.toThrow();
        // The last one may have been played (a non-promoting move with a stray promotion is accepted). Keep in step.
        if (r.room().game.history().length === ply + 1) {
          local.move(m.from, m.to, m.promotion);
          // (a promotion would have been refused without its piece; play the real one)
        } else {
          r.lobby.handle(mover, { t: 'move', ply, move: m });
          local.move(m.from, m.to, m.promotion);
        }
        expect(r.room().game.fen()).toBe(local.fen());
      }
    }
  }, 120_000);
});

// =====================================================================================
// Ranked: clocks, forfeits, rematch, ratings
// =====================================================================================

describe('ranked: the clock', () => {
  it('a player whose time runs out loses, and it is rated', () => {
    const r = rankedUnderWay();
    r.lobby.handle(r.w, { t: 'move', ply: 2, move: mv('g1f3') });
    // Black's own move gave back a little time.
    r.clock.pass(CLOCK_START + CLOCK_INCREMENT + 1);
    r.lobby.tick();
    const s = r.w.last('state')!.state;
    expect(s.ended).toBe('time');
    expect(s.resigned).toBe('b');
    expect(r.scores.get(r.wKey)!.rating).toBeGreaterThan(START_RATING);
  });

  // FIDE 6.9: a player whose flag falls loses, unless the opponent cannot checkmate by any legal
  // sequence of moves; then the game is drawn.
  it('FIDE 6.9: flag falls against a bare king is a draw, not a win for the bare king', () => {
    const r = ranked();
    r.room().game = new Game('4k3/8/8/8/8/8/8/Q3K3 w - - 0 1'); // White K+Q v bare black king, White to move
    r.room().moved = { w: true, b: true };
    r.clock.pass(CLOCK_START + 1);
    r.lobby.tick();
    const s = r.w.last('state')!.state;
    expect(s.ended).toBe('time');
    expect(s.resigned).toBeNull();
    expect(s.change).toEqual({ w: 0, b: 0 });
    // A draw: Black (a bare king) cannot mate.
    expect(r.scores.get(r.bKey)!.wins).toBe(0);
    expect(r.scores.get(r.wKey)!.draws).toBe(1);
    // A client reading the state draws the game the same way.
    const g = new Game(s.startFen);
    expect(g.drawOnTime()).toBe(true);
    expect(g.status()).toMatchObject({ result: 'draw', drawReason: 'timeout' });
  });
  it('...but a lone knight with something of the other side\'s to hem its king in could mate: that flag fall is a loss', () => {
    const r = ranked();
    r.room().game = new Game('4k1n1/8/8/8/8/8/P7/4K3 w - - 0 1');
    r.room().moved = { w: true, b: true };
    r.clock.pass(CLOCK_START + 1);
    r.lobby.tick();
    expect(r.w.last('state')!.state).toMatchObject({ ended: 'time', resigned: 'w' });
    expect(r.scores.get(r.bKey)).toMatchObject({ wins: 1 });
  });

  it('a move that arrives after the flag has fallen is not played: it loses on time (or draws, against a side that could not mate)', () => {
    const r = rankedUnderWay();
    r.clock.pass(CLOCK_START + CLOCK_INCREMENT + 5);
    r.lobby.handle(r.w, { t: 'move', ply: 2, move: mv('g1f3') });
    expect(r.room().game.history()).toHaveLength(2);
    expect(r.w.last('state')!.state).toMatchObject({ ended: 'time', resigned: 'w' });

    const d = ranked();
    d.room().game = new Game('4k3/8/8/8/8/8/8/Q3K3 w - - 0 1');
    d.room().moved = { w: true, b: true };
    d.clock.pass(CLOCK_START + 5);
    d.lobby.handle(d.w, { t: 'move', ply: 0, move: mv('a1a2') });
    expect(d.w.last('state')!.state).toMatchObject({ ended: 'time', resigned: null, change: { w: 0, b: 0 } });
  });

  it('before both have moved, a flag fall calls the game off, unrated', () => {
    const r = ranked();
    r.clock.pass(CLOCK_START + 5);
    r.lobby.tick();
    expect(r.w.last('state')!.state).toMatchObject({ ended: 'noshow', change: null, resigned: null });
    expect(r.scores.get(r.wKey)).toMatchObject({ wins: 0, losses: 0, draws: 0 });
  });
});

describe('ranked: leaving, never arriving, and being counted once', () => {
  it('closing the tab after the game has begun loses it (after the grace period)', () => {
    const r = rankedUnderWay();
    r.lobby.leave(r.b);
    r.clock.pass(ABANDON_AFTER + 1);
    r.lobby.tick();
    expect(r.w.last('state')!.state).toMatchObject({ ended: 'left', resigned: 'b' });
    expect(r.scores.get(r.bKey)).toMatchObject({ losses: 1 });
  });
  it('an opponent who never arrives: the game is called off and nobody is rated', () => {
    let time = 1_000_000;
    const scores = new Scores(null, () => time);
    const lobby = new Lobby(() => time, scores);
    const a = new Fake();
    const b = new Fake();
    lobby.handle(a, { t: 'hello', id: ID_A });
    lobby.handle(b, { t: 'hello', id: ID_B });
    lobby.handle(a, { t: 'queue' });
    lobby.handle(b, { t: 'queue' });
    const room = a.last('matched')!.room;
    const seat = new Fake();
    lobby.handle(seat, { t: 'hello', id: ID_A });
    lobby.handle(seat, { t: 'join', room });
    time += ABANDON_AFTER + 1;
    lobby.tick();
    expect(seat.last('state')!.state.ended).toBe('noshow');
    expect(scores.get(playerKey(ID_A))).toMatchObject({ wins: 0, losses: 0, draws: 0, rating: START_RATING });
    // Nothing can be played or resigned in a called-off game.
    const s = seat.last('joined')!.you as 'w' | 'b';
    lobby.handle(seat, { t: 'move', ply: 0, move: s === 'w' ? mv('e2e4') : mv('e7e5') });
    expect(scores.get(playerKey(ID_A))!.wins + scores.get(playerKey(ID_A))!.losses).toBe(0);
  });
  it('a game is counted exactly once, whatever follows its end (resign, then time, leaving, resign again)', () => {
    const r = rankedUnderWay();
    r.lobby.handle(r.b, { t: 'resign' });
    r.lobby.handle(r.w, { t: 'resign' });
    r.lobby.handle(r.b, { t: 'draw' });
    r.lobby.leave(r.w);
    r.clock.pass(CLOCK_START * 2);
    r.lobby.tick();
    const w = r.scores.get(r.wKey)!;
    const b = r.scores.get(r.bKey)!;
    expect(w.wins + w.losses + w.draws).toBe(1);
    expect(b.wins + b.losses + b.draws).toBe(1);
    expect(w.rating + b.rating).toBe(2 * START_RATING);
  });
  it('two connections with the same player id are never matched against each other', () => {
    const lobby = new Lobby(() => 1);
    const one = new Fake();
    const two = new Fake();
    lobby.handle(one, { t: 'hello', id: ID_A });
    lobby.handle(two, { t: 'hello', id: ID_A });
    lobby.handle(one, { t: 'queue' });
    lobby.handle(two, { t: 'queue' });
    expect(one.last('matched')).toBeUndefined();
    expect(two.last('matched')).toBeUndefined();
    expect(lobby.waiting).toBe(1);
    // Nor by changing its name after queueing and coming back as itself.
    lobby.handle(one, { t: 'hello', id: ID_A });
    lobby.handle(one, { t: 'queue' });
    expect(one.last('matched')).toBeUndefined();
    // And a record of a player against themself changes nothing.
    const scores = new Scores(null, () => 1);
    scores.greet(playerKey(ID_A));
    expect(scores.record(playerKey(ID_A), playerKey(ID_A), 'w')).toEqual({ w: 0, b: 0 });
  });
  it('one person with two ids (any 32 hex digits is an id) from one address is NOT matched with themself', () => {
    const lobby = new Lobby(() => 1);
    const one = Object.assign(new Fake(), { address: '198.51.100.7' });
    const two = Object.assign(new Fake(), { address: '198.51.100.7' });
    lobby.handle(one, { t: 'hello', id: '1'.repeat(32) });
    lobby.handle(two, { t: 'hello', id: '2'.repeat(32) });
    lobby.handle(one, { t: 'queue' });
    lobby.handle(two, { t: 'queue' });
    expect(one.last('matched')).toBeUndefined();
    expect(lobby.waiting).toBe(2);
  });
});

describe('ranked: another game', () => {
  it('there is no rematch in a ranked room: another game is found in the queue', () => {
    const r = rankedUnderWay();
    r.lobby.handle(r.b, { t: 'resign' });
    r.lobby.handle(r.w, { t: 'again' });
    r.lobby.handle(r.b, { t: 'again' });
    expect(r.w.last('seated')).toBeUndefined();
    expect(r.w.last('refused')!.reason).toMatch(/ranked game is played once/);
    expect(r.b.last('state')!.state.again).toEqual({ w: false, b: false });
  });
  it('a private rematch nobody has moved in yet starts afresh: nobody has moved in it', () => {
    const r = privateRoom();
    for (const [i, m] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) r.lobby.handle(i % 2 === 0 ? r.w : r.b, { t: 'move', ply: i, move: mv(m) });
    r.lobby.handle(r.w, { t: 'again' });
    r.lobby.handle(r.b, { t: 'again' });
    expect(r.room().moved).toEqual({ w: false, b: false });
    expect(r.w.last('seated')!.state).toMatchObject({ moves: [], startFen: START_FEN, resigned: null, claimed: null });
  });
  it('a ranked game in which only one side has moved is called off (unrated) if a player goes, or resigns', () => {
    const r = ranked();
    r.lobby.handle(r.w, { t: 'move', ply: 0, move: mv('e2e4') });
    r.lobby.leave(r.b);
    r.clock.pass(ABANDON_AFTER + 1);
    r.lobby.tick();
    expect(r.w.last('state')!.state).toMatchObject({ ended: 'noshow', change: null });
    const s = ranked();
    s.lobby.handle(s.w, { t: 'move', ply: 0, move: mv('e2e4') });
    s.lobby.handle(s.b, { t: 'resign' });
    expect(s.w.last('state')!.state).toMatchObject({ ended: 'noshow', change: null, resigned: null });
    expect(s.scores.get(s.bKey)).toMatchObject({ wins: 0, losses: 0, draws: 0, rating: START_RATING });
  });
});

describe('ratings', () => {
  const scores = () => {
    const s = new Scores(null, () => 1);
    s.greet('1'.repeat(32));
    s.greet('2'.repeat(32));
    return s;
  };
  const A = '1'.repeat(32);
  const B = '2'.repeat(32);
  it('Elo with K = 32: equal players, a win is +16 / -16 and a draw changes nothing', () => {
    const s = scores();
    expect(s.record(A, B, 'w')).toEqual({ w: 16, b: -16 });
    const t = scores();
    expect(t.record(A, B, null)).toEqual({ w: 0, b: 0 });
  });
  it('the change is symmetric (zero sum), and follows 1/(1+10^((Rb-Ra)/400))', () => {
    const s = scores();
    for (let i = 0; i < 5; i++) s.record(A, B, 'w');
    const a = s.get(A)!.rating;
    const b = s.get(B)!.rating;
    expect(a + b).toBe(2 * START_RATING);
    const expected = 1 / (1 + 10 ** ((b - a) / 400));
    const before = { a, b };
    const change = s.record(A, B, 'b');
    expect(change.w).toBe(Math.round(32 * (0 - expected)));
    expect(s.get(A)!.rating).toBe(before.a + change.w);
    expect(s.get(B)!.rating).toBe(before.b - change.w);
  });
  it('there is no floor: a rating can fall without limit (here, below 1000 after a run of losses)', () => {
    const s = scores();
    for (let i = 0; i < 40; i++) s.record(A, B, 'b');
    expect(s.get(A)!.rating).toBeLessThan(1000);
  });
});

// =====================================================================================
// Part 2: help given to a player during an online game (the real client controller)
// =====================================================================================

/** The other player: a bare connection. */
class Opponent {
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

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function eventually(rig: Rig, test: () => boolean, limit = 6000): Promise<void> {
  const began = Date.now();
  while (!test() && Date.now() - began < limit) {
    await rig.run(0.1);
    await pause(8);
  }
  if (!test()) throw new Error('It never happened');
}

describe('help during an online game (the same code path serves ranked: the client tells them apart only by `ranked` for the clock)', () => {
  let running: Running;
  const others: Opponent[] = [];
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

  /** This screen is Ivory in a private room; 1.e4 e5 has been played. */
  async function underWay() {
    const room = newRoomName();
    const rig = await boot({ address: `http://127.0.0.1:${running.port}/?room=${room}` });
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    const other = new Opponent(running.port, room);
    others.push(other);
    await other.ready;
    await eventually(rig, () => rig.ui.online.value?.taken.b === true);
    rig.app.click(sq('e2'));
    rig.app.click(sq('e4'));
    await eventually(rig, () => other.heard.some((m) => m.t === 'moved'));
    other.move('e7e5', 1);
    await eventually(rig, () => rig.app.game.history().length === 2 && rig.app.game.turn() === 'w');
    await rig.run(2);
    return { rig, other };
  }

  it('what is correctly withheld online: hints, the blunder warning, take-back', async () => {
    const { rig } = await underWay();
    expect(rig.ui.mode.value.kind).toBe('online');
    expect(rig.ui.canHint.value).toBe(false);
    expect(rig.ui.canTakeBack.value).toBe(false);
    // A move that hangs a bishop is played at once: no warning is put up.
    rig.app.click(sq('f1'));
    rig.app.click(sq('a6'));
    await rig.run(0.5);
    expect(rig.ui.warning.value).toBeNull();
  });

  it('FINDING: the engine (Stockfish) is not running during an online game', async () => {
    const { rig } = await underWay();
    // Every position of the online game has been searched by the engine.
    expect(rig.port.searched.length).toBe(0);
  });

  it("FINDING: no engine verdict (!, ?, ??, 'Blunder') is put on either player's moves while the game is on", async () => {
    const { rig } = await underWay();
    const judged = rig.app.game.history().filter((e) => rig.app.verdicts.get(e) !== undefined);
    expect(judged).toEqual([]);
  });

  it('FINDING: no engine evaluation (the Scales bar) is fed during an online game', async () => {
    const { rig } = await underWay();
    expect(rig.ui.balance.value).toBeNull();
  });

  it('FINDING: a chosen stone does not show which of its squares lose material ("danger" marks) online', async () => {
    const { rig } = await underWay();
    rig.app.click(sq('f1'));
    const marks = rig.world.marks.get('options') ?? [];
    // a6 is covered by the b7 pawn and the b8 knight: today it is marked 'risk'.
    expect(marks.filter((m) => m.kind === 'risk' || m.kind === 'captureRisk')).toEqual([]);
    // Where it may go is still shown, and the capture as a capture.
    expect(marks.some((m) => m.square === 'a6' && m.kind === 'move')).toBe(true);
  });

  /** The settings of the interface, as the game's own module has them (loaded afresh with each `boot`). */
  const store = () => import('../src/app/store.ts');

  it('a page opened on an online game never starts the engine, and the game is not open to the engine\'s eyes', async () => {
    const { rig } = await underWay();
    expect(rig.port.started).toBe(0);
    expect(rig.port.sent).toEqual([]);
    expect(rig.ui.engine.value).toBe('idle');
    expect((await store()).assisted.value).toBe(false);
    // Nothing for the room to take its cue from but the board.
    expect(rig.world.plain.length).toBeGreaterThan(0);
    expect(rig.world.plain.every((p) => p)).toBe(true);
    expect(rig.world.appraised).toEqual([]);
  });

  it('a search under way when an online game begins is dropped, and nothing it was going to say arrives', async () => {
    // The page is the server's, with no room in its address: a game at this screen first.
    const rig = await boot({ address: `http://127.0.0.1:${running.port}/` });
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await rig.until(() => rig.ui.engine.value === 'ready');
    // The engine takes its time: the move just played at this screen is still being judged.
    rig.port.delay = 400;
    rig.app.click(sq('e2'));
    rig.app.click(sq('e4'));
    await rig.settle();
    expect(rig.port.sent.at(-1)?.startsWith('go')).toBe(true);
    const searched = rig.port.searched.length;
    const room = newRoomName();
    rig.app.startOnline(room);
    // The worker is ended as the game begins, and the search with it.
    await rig.settle(2);
    expect(rig.port.sent.at(-1)).toBe('quit');
    expect(rig.ui.engine.value).toBe('idle');
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    const other = new Opponent(running.port, room);
    others.push(other);
    await other.ready;
    await eventually(rig, () => rig.ui.online.value?.taken.b === true);
    rig.app.click(sq('d2'));
    rig.app.click(sq('d4'));
    await eventually(rig, () => other.heard.some((m) => m.t === 'moved'));
    other.move('d7d5', 1);
    await eventually(rig, () => rig.app.game.history().length === 2);
    await rig.run(2);
    await pause(600);
    await rig.run(1);
    expect(rig.port.searched.length).toBe(searched);
    expect(rig.port.sent.at(-1)).toBe('quit');
    expect(rig.app.game.history().filter((e) => rig.app.verdicts.get(e) !== undefined)).toEqual([]);
    expect(rig.ui.balance.value).toBeNull();
    expect(rig.world.appraised).toEqual([]);
  });

  it('a spectator is given no more than the players: no engine, no verdicts, no scales, no danger', async () => {
    const room = newRoomName();
    const white = new Opponent(running.port, room);
    others.push(white);
    await white.ready;
    const black = new Opponent(running.port, room);
    others.push(black);
    await black.ready;
    // Each move waits until the server has passed the one before to both players.
    const told = async (count: number) => {
      while ([white, black].some((o) => o.heard.filter((m) => m.t === 'moved').length < count)) await pause(5);
    };
    white.move('e2e4', 0);
    await told(1);
    black.move('e7e5', 1);
    await told(2);
    white.move('f1c4', 2);
    await told(3);
    const rig = await boot({ address: `http://127.0.0.1:${running.port}/?room=${room}&watch=1` });
    await eventually(rig, () => rig.ui.online.value?.seat === 'spectator');
    await eventually(rig, () => rig.app.game.history().length === 3);
    black.move('b8c6', 3);
    await eventually(rig, () => rig.app.game.history().length === 4);
    await rig.run(2);
    expect(rig.port.started).toBe(0);
    expect(rig.port.searched).toEqual([]);
    expect(rig.app.game.history().filter((e) => rig.app.verdicts.get(e) !== undefined)).toEqual([]);
    expect(rig.ui.balance.value).toBeNull();
    expect((await store()).assisted.value).toBe(false);
    expect(rig.world.plain.every((p) => p)).toBe(true);
  });

  it('a chance to take in passing is not pointed out online', async () => {
    const { rig, other } = await underWay();
    rig.ui.seen.value = [];
    // 2. d4 a6 3. d5 c5: the pawn on d5 may take on c6 in passing, this move only.
    rig.app.click(sq('d2'));
    rig.app.click(sq('d4'));
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 3);
    other.move('a7a6', 3);
    await eventually(rig, () => rig.app.game.history().length === 4 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    rig.app.click(sq('d4'));
    rig.app.click(sq('d5'));
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 5);
    other.move('c7c5', 5);
    await eventually(rig, () => rig.app.game.history().length === 6 && rig.app.game.turn() === 'w');
    await rig.run(2);
    expect(rig.app.game.movesFrom(sq('d5')).some((o) => o.enPassant)).toBe(true);
    expect(rig.ui.explain.value).not.toBe('enPassantOffer');
    expect(rig.ui.seen.value).not.toContain('enPassantOffer');
  });

  it('once the online game is over it is looked over, and another game in the room starts clean', async () => {
    const room = newRoomName();
    const rig = await boot({ address: `http://127.0.0.1:${running.port}/?room=${room}` });
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    const other = new Opponent(running.port, room);
    others.push(other);
    await other.ready;
    await eventually(rig, () => rig.ui.online.value?.taken.b === true);
    // Fool's mate, Ivory the fool.
    rig.app.click(sq('f2'));
    rig.app.click(sq('f3'));
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 1);
    other.move('e7e5', 1);
    await eventually(rig, () => rig.app.game.history().length === 2 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    rig.app.click(sq('g2'));
    rig.app.click(sq('g4'));
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 3);
    expect(rig.port.started).toBe(0);
    other.move('d8h4', 3);
    await eventually(rig, () => rig.app.game.status().over);
    const s = await store();
    expect(s.assisted.value).toBe(true);
    // Over: the engine is fetched and judges every move of the game, for the record and the graph.
    await eventually(rig, () => rig.app.game.history().every((e) => rig.app.verdicts.get(e) !== undefined));
    expect(rig.port.started).toBe(1);
    expect(rig.app.game.history().some((e) => rig.app.verdicts.get(e) !== null)).toBe(true);
    // None of it was told to the room, which had finished with the game.
    expect(rig.world.appraised).toEqual([]);

    // Another game, with the engine slow, so that a look at the old one would still be under way.
    rig.port.delay = 300;
    other.send({ t: 'again' });
    await eventually(rig, () => rig.ui.online.value?.again.b === true);
    rig.app.newGame();
    await eventually(rig, () => rig.ui.online.value?.seat === 'b' && rig.app.game.history().length === 0);
    expect(s.assisted.value).toBe(false);
    expect(rig.ui.balance.value).toBeNull();
    expect(rig.ui.engine.value).toBe('idle');
    expect(rig.port.sent.at(-1)).toBe('quit');
    const searched = rig.port.searched.length;
    const sent = rig.port.sent.length;
    other.move('e2e4', 0);
    await eventually(rig, () => rig.app.game.history().length === 1);
    await rig.run(1.5);
    rig.app.click(sq('f7'));
    // Not a mark of danger on f6 or f5 (the queen sees h5 and the pawn on e4 covers f5).
    const marks = rig.world.marks.get('options') ?? [];
    expect(marks.filter((m) => m.kind === 'risk' || m.kind === 'captureRisk')).toEqual([]);
    rig.app.click(sq('f5'));
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length >= 6);
    await rig.run(2);
    await pause(500);
    expect(rig.port.searched.length).toBe(searched);
    expect(rig.port.sent.length).toBe(sent);
    expect(rig.app.game.history().filter((e) => rig.app.verdicts.get(e) !== undefined)).toEqual([]);
    expect(rig.ui.balance.value).toBeNull();
    expect(rig.world.plain.at(-1)).toBe(true);
  });

  it('a game at this screen after an online one has everything back: the engine, its verdicts, the scales and the danger marks', async () => {
    const { rig } = await underWay();
    expect(rig.port.started).toBe(0);
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await rig.until(() => rig.ui.engine.value === 'ready');
    expect((await store()).assisted.value).toBe(true);
    rig.app.click(sq('e2'));
    rig.app.click(sq('e4'));
    await rig.until(() => rig.ui.balance.value !== null);
    expect(rig.app.verdicts.get(rig.app.game.history()[0]!)).not.toBeUndefined();
    expect(rig.world.plain.at(-1)).toBe(false);
    expect(rig.world.appraised).toEqual(['e4']);
    await rig.run(1.5);
    rig.app.click(sq('d7'));
    rig.app.click(sq('d5'));
    await rig.until(() => rig.app.game.history().length === 2 && rig.world.appraised.length === 2);
    await rig.run(1.5);
    // a6 is covered by the pawn on b7 and the knight on b8.
    rig.app.click(sq('f1'));
    const marks = rig.world.marks.get('options') ?? [];
    expect(marks.some((m) => m.square === 'a6' && m.kind === 'risk')).toBe(true);
  });
});
