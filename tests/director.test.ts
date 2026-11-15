/**
 * How the room answers a move: the right response, on the right beat, for
 * each tier of the style bible's table (section 7.3).
 */
import { Color, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Sound } from '../src/audio/sound.ts';
import { Game, type MoveEvent, type Square } from '../src/core/game.ts';
import { BoardFx } from '../src/life/boardfx.ts';
import { Director, type Mood } from '../src/life/director.ts';
import { PieceLayer } from '../src/scene/pieces.ts';
import { Tweens } from '../src/scene/tween.ts';

/** A stand-in for the sound engine that only notes what it was asked to play. */
function listener() {
  const heard: string[] = [];
  /** How heavy each break of the stone was asked to be. */
  const breaks: number[] = [];
  const sound = new Proxy(
    {},
    {
      get: (_, name: string) => (...args: unknown[]) => {
        if (name === 'fracture') breaks.push(Number(args[3]));
        if (name === 'setHeartbeat' || name === 'setTension') heard.push(`${name}:${String(args[0])}`);
        else if (name !== 'update') heard.push(name);
      },
    },
  ) as unknown as Sound;
  return { heard, breaks, sound };
}

function setup(fen?: string) {
  const game = new Game(fen);
  const tweens = new Tweens();
  const pieces = new PieceLayer(tweens);
  pieces.reset(game.pieces());
  const fx = new BoardFx(new Float32Array(64));
  const moods: Mood[] = [];
  const { heard, breaks, sound } = listener();
  const thuds: number[] = [];
  const director = new Director({ pieces, fx, setMood: (m) => moods.push(m), thud: (s) => thuds.push(s) }, () => sound);
  director.reset(game.status());
  moods.length = 0;
  heard.length = 0;
  thuds.length = 0;
  const spies = {
    line: vi.spyOn(fx, 'line'),
    ripple: vi.spyOn(fx, 'ripple'),
    flash: vi.spyOn(fx, 'flash'),
    erupt: vi.spyOn(fx, 'erupt'),
    fog: vi.spyOn(fx, 'setFog'),
    pillar: vi.spyOn(fx, 'setPillar'),
    flinch: vi.spyOn(pieces, 'flinch'),
    recoil: vi.spyOn(pieces, 'recoilFrom'),
    rally: vi.spyOn(pieces, 'rally'),
    sag: vi.spyOn(pieces, 'sag'),
    burn: vi.spyOn(pieces, 'burn'),
    fear: vi.spyOn(pieces, 'setFear'),
    extinguish: vi.spyOn(pieces, 'extinguish'),
    fidget: vi.spyOn(pieces, 'fidget'),
  };
  /** Play a move through every beat, the way the hands report it. */
  const play = (from: Square, to: Square): MoveEvent => {
    const e = game.move(from, to);
    if (e.captured) for (const beat of ['reach', 'close', 'lift'] as const) director.beat(e, 'victim', beat);
    for (const beat of ['reach', 'close', 'lift', 'set', 'release'] as const) {
      // The piece is on its new square by the time it is set down.
      if (beat === 'set') pieces.settle(e.piece.id, e.piece.to);
      director.beat(e, 'mover', beat);
    }
    return e;
  };
  /** How bright each of a side's pieces is meant to be, and whether it stands at its full height: its mood, not what has been drawn of it yet. */
  const lights = (side: 'w' | 'b') =>
    [...pieces.standing()]
      .filter((v) => v.side === side)
      .map((v) => (v as unknown as { mood: { glow: { goal: number; value: number }; eye: { goal: number }; squash: { goal: number } } }).mood);
  return { game, tweens, pieces, fx, director, moods, heard, breaks, thuds, spies, play, lights };
}

describe('a quiet move', () => {
  it('draws its path, is heard leaving and landing, and ripples the board where it lands', () => {
    const { play, heard, spies, moods } = setup();
    play('e2', 'e4');
    expect(spies.line).toHaveBeenCalledTimes(1);
    expect(spies.line.mock.calls[0]![3]).toMatchObject({ chalk: true });
    expect(heard).toEqual(expect.arrayContaining(['whoosh', 'stoneLift', 'stoneSet']));
    expect(heard.indexOf('stoneLift')).toBeLessThan(heard.indexOf('stoneSet'));
    expect(spies.ripple).toHaveBeenCalledTimes(1);
    // The square it left, as it leaves; the square it lands on, as it lands.
    expect(spies.flash).toHaveBeenCalledTimes(2);
    expect(spies.flash.mock.calls[0]![0]).toMatchObject({ x: 0.5, z: 2.5 });
    expect(spies.flash.mock.calls[1]![0]).toMatchObject({ x: 0.5, z: 0.5 });
    expect(moods.at(-1)).toBe('calm');
    expect(spies.rally).not.toHaveBeenCalled();
    expect(spies.sag).not.toHaveBeenCalled();
  });

  it('sheds flecks from the square it leaves, and a ribbon follows it through the air until it is set down', () => {
    const { game, director, pieces, fx } = setup();
    const e = game.move('e2', 'e4');
    const stone = pieces.puppet(e.piece.id)!.group;
    director.beat(e, 'mover', 'reach');
    expect(fx.airborne).toEqual({ flecks: 0, wakes: [0, 0], rays: false, prisms: 0, cracks: 0 });
    director.beat(e, 'mover', 'lift');
    expect(fx.airborne.flecks).toBeGreaterThan(2);
    // Carried over half a second in an arc, as a hand would.
    const from = stone.position.clone();
    for (let i = 1; i <= 30; i++) {
      const k = i / 30;
      stone.position.set(from.x, from.y + Math.sin(Math.PI * k) * 0.8, from.z - 2 * k);
      fx.update(1 / 60, i / 60);
      director.update(1 / 60);
    }
    const held = fx.airborne.wakes[0]!;
    expect(held).toBeGreaterThan(20);
    expect(fx.airborne.wakes[1]).toBe(0);
    pieces.settle(e.piece.id, e.piece.to);
    director.beat(e, 'mover', 'set');
    // Set down, it gathers no more, however the piece is moved about after.
    stone.position.y += 3;
    fx.update(1 / 60, 1);
    director.update(1 / 60);
    expect(fx.airborne.wakes[0]).toBeLessThanOrEqual(held + 1);
    // It hangs for a second or so and is gone, and so are the flecks.
    for (let i = 0; i < 100; i++) fx.update(1 / 60, 1 + i / 60);
    expect(fx.airborne).toEqual({ flecks: 0, wakes: [0, 0], rays: false, prisms: 0, cracks: 0 });
  });

  it('gives the rook a ribbon of its own when a king castles', () => {
    const { game, director, pieces, fx } = setup('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
    const e = game.move('e1', 'g1');
    const king = pieces.puppet(e.piece.id)!.group;
    const rook = pieces.puppet(e.rook!.id)!.group;
    director.beat(e, 'mover', 'lift');
    director.beat(e, 'rook', 'lift');
    for (let i = 1; i <= 20; i++) {
      king.position.x += 0.1;
      rook.position.x -= 0.1;
      fx.update(1 / 60, i / 60);
      director.update(1 / 60);
    }
    expect(fx.airborne.wakes[0]).toBeGreaterThan(10);
    expect(fx.airborne.wakes[1]).toBeGreaterThan(10);
  });

  it('leaves nothing in the air when a new position is set up', () => {
    const { game, director, pieces, fx } = setup();
    const e = game.move('e2', 'e4');
    director.beat(e, 'mover', 'lift');
    pieces.puppet(e.piece.id)!.group.position.y += 1;
    fx.update(1 / 60, 0);
    director.update(1 / 60);
    director.reset(new Game().status());
    expect(fx.airborne).toEqual({ flecks: 0, wakes: [0, 0], rays: false, prisms: 0, cracks: 0 });
    // And the piece that was in the air is not followed any further.
    pieces.puppet(e.piece.id)!.group.position.y += 1;
    director.update(1 / 60);
    fx.update(1 / 60, 0);
    expect(fx.airborne.wakes).toEqual([0, 0]);
  });

  it("draws a knight's path as two legs", () => {
    const { play, spies } = setup();
    play('g1', 'f3');
    expect(spies.line).toHaveBeenCalledTimes(2);
  });
});

describe('a capture', () => {
  it('makes the taken piece flinch as the hand comes, cracks, and sends its neighbours back', () => {
    const { play, heard, spies, moods } = setup();
    play('e2', 'e4');
    play('d7', 'd5');
    heard.length = 0;
    const e = play('e4', 'd5');
    expect(spies.flinch).toHaveBeenCalledWith(e.captured!.id, expect.anything(), expect.any(Number));
    expect(heard).toContain('crack');
    expect(spies.recoil).toHaveBeenCalledTimes(1);
    // The room is on edge after a capture, and settles again over the next quiet moves.
    expect(moods.at(-1)).toBe('sharp');
  });

  it('lets the room settle after a few quiet moves', () => {
    const { play, moods } = setup();
    play('e2', 'e4');
    play('d7', 'd5');
    play('e4', 'd5');
    for (const [from, to] of [['a7', 'a6'], ['a2', 'a3'], ['b7', 'b6']] as [Square, Square][]) play(from, to);
    expect(moods.at(-1)).toBe('calm');
  });
});

describe('moves that do more', () => {
  it('answers a fork with a line to each target, which flinch, and a rally', () => {
    const { play, heard, spies } = setup('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1');
    play('d5', 'c7');
    // Two lines for the path of the knight, two for the fork, one from the knight to the king it checks.
    expect(spies.line.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(heard).toContain('stab');
    expect(spies.rally).toHaveBeenCalledTimes(1);
  });

  it('stands a fan of rays behind a strong move, and it is gone within a second and a half', () => {
    const { play, fx } = setup('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1');
    expect(fx.airborne.rays).toBe(false);
    play('d5', 'c7');
    expect(fx.airborne.rays).toBe(true);
    fx.update(1.0, 1.0);
    expect(fx.airborne.rays).toBe(true);
    fx.update(0.5, 1.5);
    expect(fx.airborne.rays).toBe(false);
  });

  it('closes a glass prism round a pinned piece, with a line through it to what it shields', () => {
    // The bishop goes to b5: the knight on c6 can no longer move, because the king stands behind it.
    const { play, fx, spies, heard } = setup('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1');
    const e = play('f1', 'b5');
    expect(e.motifs.some((m) => m.kind === 'pin')).toBe(true);
    expect(fx.airborne.prisms).toBe(1);
    expect(heard).toContain('seal');
    expect(spies.flinch).toHaveBeenCalled();
    // It stands for a second and a half and then goes.
    fx.update(1.5, 1.5);
    expect(fx.airborne.prisms).toBe(1);
    fx.update(1.5, 3);
    expect(fx.airborne.prisms).toBe(0);
  });

  it('leaves no rays or prisms standing when a new game begins', () => {
    const { play, fx, director, game } = setup('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1');
    play('f1', 'b5');
    fx.rays(new Vector3(0.5, 0, 0.5), new Color(1, 1, 1));
    expect(fx.airborne).toMatchObject({ rays: true, prisms: 1 });
    director.reset(game.status());
    expect(fx.airborne).toMatchObject({ rays: false, prisms: 0 });
  });

  it('answers a blunder with a sag and a falling tone', () => {
    const { play, heard, spies } = setup('6k1/8/3p4/8/8/8/8/Q3K3 w - - 0 1');
    play('a1', 'e5');
    expect(spies.sag).toHaveBeenCalledWith('w');
    expect(heard).toContain('fall');
    expect(spies.rally).not.toHaveBeenCalled();
  });

  it('answers a sacrifice with ember at the seams and a bell, not a sag', () => {
    const { play, heard, spies } = setup('5rk1/5ppp/8/8/8/3B4/8/4K3 w - - 0 1');
    const e = play('d3', 'h7');
    expect(spies.burn).toHaveBeenCalledWith(e.piece.id);
    expect(heard).toContain('bell');
    expect(spies.sag).not.toHaveBeenCalled();
  });

  it('waits for the engine before calling a stone given up a sacrifice, and does not if it was thrown away', () => {
    const sac = '5rk1/5ppp/8/8/8/3B4/8/4K3 w - - 0 1';
    // The engine is still thinking when the stone lands: nothing yet.
    const good = setup(sac);
    const e = good.game.move('d3', 'h7');
    good.director.expect(e);
    good.pieces.settle(e.piece.id, e.piece.to);
    for (const beat of ['reach', 'close', 'lift', 'set', 'release'] as const) good.director.beat(e, 'mover', beat);
    expect(good.spies.burn).not.toHaveBeenCalled();
    expect(good.heard).not.toContain('bell');
    // It was sound: now it burns, and the bell is struck.
    good.director.appraise(e, 'sound');
    expect(good.spies.burn).toHaveBeenCalledWith(e.piece.id);
    expect(good.heard).toContain('bell');

    // The engine calls the same move a blunder: no ember, no bell, and its side sags.
    for (const kind of ['blunder', 'slip'] as const) {
      const bad = setup(sac);
      const f = bad.game.move('d3', 'h7');
      bad.director.expect(f);
      bad.director.appraise(f, kind);
      bad.pieces.settle(f.piece.id, f.piece.to);
      for (const beat of ['reach', 'close', 'lift', 'set', 'release'] as const) bad.director.beat(f, 'mover', beat);
      expect(bad.spies.burn).not.toHaveBeenCalled();
      expect(bad.heard).not.toContain('bell');
      if (kind === 'blunder') expect(bad.spies.sag).toHaveBeenCalledWith('w');
    }

    // The engine never answers: after its patience runs out, the move is taken for what it looks like.
    const slow = setup(sac);
    const g = slow.game.move('d3', 'h7');
    slow.director.expect(g);
    slow.pieces.settle(g.piece.id, g.piece.to);
    for (const beat of ['reach', 'close', 'lift', 'set', 'release'] as const) slow.director.beat(g, 'mover', beat);
    expect(slow.spies.burn).not.toHaveBeenCalled();
    for (let t = 0; t < 5; t += 0.25) slow.director.update(0.25);
    expect(slow.spies.burn).toHaveBeenCalledWith(g.piece.id);
    expect(slow.heard).toContain('bell');
  });
});

describe('an online game being played: only what both players can see', () => {
  /** A director told to answer plainly, as the game tells it for every move of an online game. */
  function plain(fen?: string) {
    const r = setup(fen);
    r.director.setPlain(true);
    return r;
  }

  it('draws no fork and lifts no side for one, though the knight checks and the check is answered', () => {
    const { play, heard, spies, moods } = plain('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1');
    const e = play('d5', 'c7');
    expect(e.motifs.some((m) => m.kind === 'fork')).toBe(true);
    // Only the knight's own path: two legs, and nothing to its targets.
    expect(spies.line).toHaveBeenCalledTimes(2);
    expect(heard).not.toContain('stab');
    expect(spies.rally).not.toHaveBeenCalled();
    // The check is on the board for anyone to see, and the room answers it as ever.
    expect(heard).toContain('stinger');
    expect(moods.at(-1)).toBe('check');
  });

  it('seals no pinned piece, and the room is not set on edge by a pin alone', () => {
    const { play, fx, heard, moods } = plain('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1');
    const e = play('f1', 'b5');
    expect(e.motifs.some((m) => m.kind === 'pin')).toBe(true);
    expect(fx.airborne.prisms).toBe(0);
    expect(heard).not.toContain('seal');
    expect(moods.at(-1)).toBe('calm');
  });

  it('does not sag a side for a stone left hanging, nor burn a stone given up', () => {
    const hung = plain('6k1/8/3p4/8/8/8/8/Q3K3 w - - 0 1');
    const e = hung.play('a1', 'e5');
    expect(e.exposure).toBeGreaterThan(0);
    expect(hung.spies.sag).not.toHaveBeenCalled();
    expect(hung.heard).not.toContain('fall');

    const sac = plain('5rk1/5ppp/8/8/8/3B4/8/4K3 w - - 0 1');
    const f = sac.play('d3', 'h7');
    expect(f.motifs.some((m) => m.kind === 'sacrifice')).toBe(true);
    expect(sac.spies.burn).not.toHaveBeenCalled();
    expect(sac.heard).not.toContain('bell');
    // And nothing comes of it later, as it would for a move still waiting on the engine.
    for (let t = 0; t < 5; t += 0.25) sac.director.update(0.25);
    expect(sac.spies.burn).not.toHaveBeenCalled();
    expect(sac.spies.sag).not.toHaveBeenCalled();
  });

  it('pays no heed to a verdict, should one come', () => {
    const { game, director, pieces, spies, fx } = plain('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1');
    const e = game.move('d5', 'c7');
    director.expect(e);
    director.appraise(e, 'strong');
    pieces.settle(e.piece.id, e.piece.to);
    for (const beat of ['reach', 'close', 'lift', 'set', 'release'] as const) director.beat(e, 'mover', beat);
    director.appraise(e, 'blunder');
    expect(spies.rally).not.toHaveBeenCalled();
    expect(spies.sag).not.toHaveBeenCalled();
    expect(fx.airborne.rays).toBe(false);
  });

  it('answers a capture, a promotion and mate exactly as before', () => {
    const taken = plain();
    taken.play('e2', 'e4');
    taken.play('d7', 'd5');
    const e = taken.play('e4', 'd5');
    expect(taken.spies.flinch).toHaveBeenCalledWith(e.captured!.id, expect.anything(), expect.any(Number));
    expect(taken.heard).toContain('crack');
    expect(taken.moods.at(-1)).toBe('sharp');

    const crowned = plain('8/P7/7k/8/8/8/8/4K3 w - - 0 1');
    const p = crowned.game.move('a7', 'a8', 'q');
    crowned.pieces.settle(p.piece.id, p.piece.to);
    crowned.director.beat(p, 'mover', 'set');
    expect(crowned.spies.rally).toHaveBeenCalledTimes(1);

    const fool = plain();
    for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']] as [Square, Square][]) fool.play(from, to);
    expect(fool.spies.erupt).toHaveBeenCalledTimes(1);
    expect(fool.spies.extinguish).toHaveBeenCalled();
    expect(fool.moods.at(-1)).toBe('mate');
  });

  it('goes back to reading the board once told the game is not plain', () => {
    const { director, play, spies } = plain('6k1/8/3p4/8/8/8/8/Q3K3 w - - 0 1');
    director.setPlain(false);
    play('a1', 'e5');
    expect(spies.sag).toHaveBeenCalledWith('w');
  });
});

describe('promotion', () => {
  it('blazes on the square, rings the board and lifts its side', () => {
    const { game, director, pieces, heard, spies } = setup('8/P7/7k/8/8/8/8/4K3 w - - 0 1');
    const e = game.move('a7', 'a8', 'q');
    pieces.settle(e.piece.id, e.piece.to);
    director.beat(e, 'mover', 'set');
    // The landing's own flash and ripple, and the promotion's on top of them.
    expect(spies.flash).toHaveBeenCalledTimes(2);
    expect(spies.ripple).toHaveBeenCalledTimes(2);
    expect(spies.rally).toHaveBeenCalledWith('w', expect.anything());
    expect(heard).toContain('lift');
  });
});

describe('the weight of a stone set down', () => {
  const sum = (blows: number[]) => blows.reduce((a, b) => a + b, 0);

  it('is felt once, when it lands, and the heavier the stone the harder', () => {
    const { play, thuds } = setup();
    play('e2', 'e4');
    expect(thuds).toHaveLength(1);
    const pawn = thuds[0]!;
    play('e7', 'e5');
    play('d1', 'h5');
    expect(thuds).toHaveLength(3);
    expect(thuds[2]!).toBeGreaterThan(pawn * 2);
  });

  it('is felt twice when a stone is taken: the crack as it is seized, then the taker coming down harder than it would have', () => {
    const { play, thuds } = setup();
    play('e2', 'e4');
    play('d7', 'd5');
    const quiet = thuds[0]!;
    thuds.length = 0;
    play('e4', 'd5');
    expect(thuds).toHaveLength(2);
    expect(thuds[0]!).toBeLessThan(quiet);
    expect(thuds[1]!).toBeGreaterThan(quiet);
  });

  it('is felt for the rook as well as the king in castling', () => {
    const { game, director, pieces, thuds } = setup('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
    const e = game.move('e1', 'g1');
    pieces.settle(e.piece.id, e.piece.to);
    director.beat(e, 'mover', 'set');
    expect(thuds).toHaveLength(1);
    director.beat(e, 'rook', 'lift');
    director.beat(e, 'rook', 'set');
    expect(thuds).toHaveLength(2);
    // The king is the heavier of the two.
    expect(thuds[1]!).toBeLessThan(thuds[0]!);
  });

  it('is hardest of all at mate', () => {
    const quiet = setup('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
    quiet.play('a1', 'a7');
    const mate = setup('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
    mate.play('a1', 'a8');
    expect(sum(mate.thuds)).toBeGreaterThan(sum(quiet.thuds) * 2.5);
  });

  it('is harder for a pawn made into a queen than for a queen set down', () => {
    const made = setup('8/P7/7k/8/8/8/8/4K3 w - - 0 1');
    const e = made.game.move('a7', 'a8', 'q');
    made.pieces.settle(e.piece.id, e.piece.to);
    made.director.beat(e, 'mover', 'set');
    const moved = setup('8/8/7k/8/8/8/Q7/4K3 w - - 0 1');
    moved.play('a2', 'a4');
    expect(sum(made.thuds)).toBeGreaterThan(sum(moved.thuds));
  });

  it('needs nobody to be listening', () => {
    const game = new Game();
    const pieces = new PieceLayer(new Tweens());
    pieces.reset(game.pieces());
    const director = new Director({ pieces, fx: new BoardFx(new Float32Array(64)), setMood: () => {} }, () => null);
    director.reset(game.status());
    const e = game.move('e2', 'e4');
    pieces.settle(e.piece.id, e.piece.to);
    expect(() => director.beat(e, 'mover', 'set')).not.toThrow();
  });
});

describe('a draw the players agree', () => {
  it('rings the board once from each king, with one note from each side, and nothing erupts', () => {
    const { game, director, heard, spies, moods } = setup();
    game.move('e2', 'e4');
    game.move('e7', 'e5');
    game.agreeDraw();
    director.reset(game.status(), true);
    expect(spies.ripple).toHaveBeenCalledTimes(2);
    const where = spies.ripple.mock.calls.map((c) => `${c[0].x},${c[0].z}`).sort();
    // The two kings, on e1 and e8.
    expect(where).toEqual(['0.5,-3.5', '0.5,3.5']);
    expect(heard.filter((h) => h === 'glass')).toHaveLength(2);
    expect(spies.erupt).not.toHaveBeenCalled();
    expect(spies.extinguish).not.toHaveBeenCalled();
    expect(moods.at(-1)).toBe('calm');
  });

  it('is not how a draw on the board is answered', () => {
    const { game, director, heard, spies } = setup('8/8/4k3/8/8/4K3/8/8 w - - 0 1');
    director.reset(game.status(), true);
    expect(game.status()).toMatchObject({ result: 'draw', drawReason: 'insufficient' });
    expect(spies.ripple).not.toHaveBeenCalled();
    expect(heard).not.toContain('glass');
  });

  it('is not rung again each time the finished game is stood again: come back to from a look at an earlier move, or found saved', () => {
    const { game, director, heard, spies } = setup();
    game.move('e2', 'e4');
    game.move('e7', 'e5');
    game.agreeDraw();
    director.reset(game.status());
    expect(spies.ripple).not.toHaveBeenCalled();
    // The room is told how tense it is, as for any position, and that is all that is said to it.
    expect(heard.filter((h) => !h.startsWith('set'))).toEqual([]);
  });
});

describe('a game given up', () => {
  function givenUp() {
    const room = setup();
    room.game.move('e2', 'e4');
    room.game.move('e7', 'e5');
    room.game.resign('b');
    return room;
  }

  it("puts out the loser's light from its king, rings the board there, is heard falling, and lifts the side left standing", () => {
    const { game, director, heard, spies, moods } = givenUp();
    director.reset(game.status(), true);
    expect(game.status()).toMatchObject({ result: 'resigned', winner: 'w' });
    // Void's king, on e8, is where it starts; Ivory's, on e1, is where the rally does.
    expect(spies.extinguish).toHaveBeenCalledTimes(1);
    expect(spies.extinguish.mock.calls[0]![0]).toBe('b');
    expect(spies.extinguish.mock.calls[0]![1]).toMatchObject({ x: 0.5, z: -3.5 });
    expect(spies.ripple).toHaveBeenCalledTimes(1);
    expect(spies.ripple.mock.calls[0]![0]).toMatchObject({ x: 0.5, z: -3.5 });
    expect(heard.filter((h) => h === 'fall')).toHaveLength(1);
    expect(spies.rally).toHaveBeenCalledTimes(1);
    expect(spies.rally.mock.calls[0]![0]).toBe('w');
    expect(spies.rally.mock.calls[0]![1]).toMatchObject({ x: 0.5, z: 3.5 });
    // Nobody was struck.
    expect(spies.erupt).not.toHaveBeenCalled();
    expect(moods.at(-1)).toBe('calm');
  });

  it('shows the lights out, and nothing more, each time the finished game is stood again', () => {
    const { game, director, heard, spies } = givenUp();
    director.reset(game.status());
    director.reset(game.status());
    expect(spies.extinguish).toHaveBeenCalledTimes(2);
    expect(spies.extinguish.mock.calls[1]![0]).toBe('b');
    expect(spies.ripple).not.toHaveBeenCalled();
    expect(spies.rally).not.toHaveBeenCalled();
    expect(heard.filter((h) => !h.startsWith('set'))).toEqual([]);
  });
});

describe("the engine's verdict", () => {
  it('surges at a move the engine calls strong, though nothing on the board says so', () => {
    const { game, director, pieces, heard, spies } = setup();
    const e = game.move('e2', 'e4');
    director.expect(e);
    director.appraise(e, 'strong');
    pieces.settle(e.piece.id, e.piece.to);
    director.beat(e, 'mover', 'set');
    expect(spies.rally).toHaveBeenCalledTimes(1);
    expect(heard).toContain('lift');
  });

  it('waits for a verdict that has not come yet, and acts on it when it does', () => {
    const { game, director, pieces, heard, spies } = setup();
    const e = game.move('e2', 'e4');
    director.expect(e);
    pieces.settle(e.piece.id, e.piece.to);
    director.beat(e, 'mover', 'set');
    director.update(1);
    expect(spies.rally).not.toHaveBeenCalled();
    expect(spies.sag).not.toHaveBeenCalled();
    director.appraise(e, 'blunder');
    expect(spies.sag).toHaveBeenCalledTimes(1);
    expect(heard).toContain('fall');
    // Told once: the same verdict again changes nothing.
    director.update(10);
    expect(spies.sag).toHaveBeenCalledTimes(1);
  });

  it('overrules what the board suggests: a fork the engine finds merely sound draws its lines but no surge', () => {
    // The knight forks king and rook.
    const { game, director, pieces, spies } = setup('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1');
    const e = game.move('b5', 'c7');
    expect(e.motifs.some((m) => m.kind === 'fork')).toBe(true);
    director.expect(e);
    director.appraise(e, 'sound');
    pieces.settle(e.piece.id, e.piece.to);
    director.beat(e, 'mover', 'set');
    expect(spies.line).toHaveBeenCalled();
    expect(spies.rally).not.toHaveBeenCalled();
  });

  it('goes by the board when the engine does not answer in time, or cannot say', () => {
    const slow = setup('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1');
    const e = slow.game.move('b5', 'c7');
    slow.director.expect(e);
    slow.pieces.settle(e.piece.id, e.piece.to);
    slow.director.beat(e, 'mover', 'set');
    slow.director.update(3);
    expect(slow.spies.rally).not.toHaveBeenCalled();
    slow.director.update(1.5);
    expect(slow.spies.rally).toHaveBeenCalledTimes(1);

    const mute = setup('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1');
    const f = mute.game.move('b5', 'c7');
    mute.director.expect(f);
    mute.pieces.settle(f.piece.id, f.piece.to);
    mute.director.beat(f, 'mover', 'set');
    mute.director.appraise(f, null);
    expect(mute.spies.rally).toHaveBeenCalledTimes(1);
  });

  it('forgets a verdict it was waiting for when the move is taken back', () => {
    const { game, director, pieces, spies } = setup();
    const e = game.move('e2', 'e4');
    director.expect(e);
    pieces.settle(e.piece.id, e.piece.to);
    director.beat(e, 'mover', 'set');
    game.undo();
    director.undone(game.status());
    director.appraise(e, 'blunder');
    director.update(10);
    expect(spies.sag).not.toHaveBeenCalled();
  });
});

describe('check and mate', () => {
  it('turns the room to check: fog, a frightened king, a stinger and a heartbeat', () => {
    const { play, heard, spies, moods } = setup('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    play('a1', 'a8');
    expect(moods.at(-1)).toBe('check');
    expect(spies.fear).toHaveBeenLastCalledWith('e8');
    expect(heard).toEqual(expect.arrayContaining(['stinger', 'setHeartbeat:true', 'setTension:1']));
    expect(spies.fog.mock.calls.at(-1)![0]).toBeGreaterThan(0);
    // The king steps out of it and the room lets go.
    play('e8', 'e7');
    expect(moods.at(-1)).not.toBe('check');
    expect(spies.fear).toHaveBeenLastCalledWith(null);
    expect(heard).toContain('setHeartbeat:false');
    expect(spies.fog).toHaveBeenLastCalledWith(0);
  });

  it('plays the set piece at mate: eruption, pillar, the loser going dark, the choir', () => {
    const { play, heard, spies, moods, fx } = setup('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
    play('a1', 'a8');
    expect(moods.at(-1)).toBe('mate');
    expect(spies.erupt).toHaveBeenCalledTimes(1);
    expect(spies.pillar).toHaveBeenLastCalledWith(expect.objectContaining({ x: 2.5, z: -3.5 }));
    expect(spies.extinguish).toHaveBeenCalledWith('b', expect.anything());
    expect(heard).toContain('choir');
    expect(heard).not.toContain('stinger');
    // The tiles really do rise, a square at a time, outward from the king.
    fx.update(0.4, 0.4);
    expect(fx.liftAt(1.5, -3.5)).toBeGreaterThan(0.05);
    expect(fx.liftAt(-3.5, 3.5)).toBe(0);
    fx.update(1.2, 1.6);
    expect(fx.liftAt(-3.5, 3.5)).toBeGreaterThan(0);
  });

  it('lights the mated side again when the mate is taken back, even one whose lights were still going out', async () => {
    /** Let time pass in the room. What waits on it is told between steps. */
    const pass = async (tweens: Tweens, seconds: number) => {
      for (let t = 0; t < seconds; t += 0.05) {
        tweens.update(0.05);
        await Promise.resolve();
        await Promise.resolve();
      }
    };
    for (const waited of [3, 0.4]) {
      const { game, play, director, tweens, lights } = setup('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
      play('a1', 'a8');
      // The lights go out from the king outward: after three seconds all of them, after less only the nearest.
      await pass(tweens, waited);
      const out = lights('b').filter((m) => m.glow.goal === 0).length;
      if (waited === 3) {
        expect(out).toBe(lights('b').length);
      } else {
        expect(out).toBeGreaterThan(0);
        expect(out).toBeLessThan(lights('b').length);
      }
      expect(lights('w').every((m) => m.glow.goal === 1)).toBe(true);
      game.undo();
      director.undone(game.status());
      await pass(tweens, 3);
      // All of Void is lit and standing, and the king's eye is open: he is no longer attacked.
      expect(lights('b').every((m) => m.glow.goal === 1 && m.squash.goal === 0 && m.eye.goal === 1), `after ${waited} s`).toBe(true);
    }
  });

  it('shows a game found already ended by mate with the loser dark at once, and nothing heard', () => {
    const { heard, spies, lights, moods } = setup('R5k1/5ppp/8/8/8/8/8/4K3 b - - 0 1');
    // `setup` stands the position and then forgets what it heard; stand it again and listen.
    const again = setup('R5k1/5ppp/8/8/8/8/8/4K3 b - - 0 1');
    again.director.reset(again.game.status());
    expect(again.game.status()).toMatchObject({ result: 'checkmate', winner: 'w' });
    expect(again.lights('b').every((m) => m.glow.goal === 0 && m.glow.value === 0)).toBe(true);
    expect(again.lights('w').every((m) => m.glow.goal === 1)).toBe(true);
    expect(again.heard.filter((h) => !h.startsWith('set'))).toEqual([]);
    expect(again.spies.erupt).not.toHaveBeenCalled();
    // The first one, too, was dark from the moment it was stood up.
    expect(lights('b').every((m) => m.glow.value === 0)).toBe(true);
    expect(spies.erupt).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
    expect(moods).toEqual([]);
  });

  it('cracks the board toward a king in check, and the crack closes when the king is safe', () => {
    const { play, fx } = setup('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    expect(fx.cracked).toBe(0);
    play('a1', 'a8');
    expect(fx.cracked).toBe(1);
    // It lies there for as long as the check does.
    fx.update(6, 6);
    expect(fx.cracked).toBe(1);
    play('e8', 'e7');
    expect(fx.cracked).toBe(0);
    // Closing, not gone at once.
    expect(fx.airborne.cracks).toBe(1);
    fx.update(1, 7);
    expect(fx.airborne.cracks).toBe(0);
  });

  it('cracks it from each attacker when two give check at once', () => {
    // The bishop steps off the file its rook stands on and gives check itself.
    const { play, fx } = setup('4k3/8/8/8/4B3/8/8/4R1K1 w - - 0 1');
    play('e4', 'c6');
    expect(fx.cracked).toBe(2);
  });

  it('closes the cracks of one check as an answering check opens its own', () => {
    // The rook checks along the rank; the queen takes it, and from there looks down the long line at the other king.
    const { play, fx } = setup('4k3/q7/8/8/8/8/7K/1R6 w - - 0 1');
    play('b1', 'b8');
    expect(fx.cracked).toBe(1);
    play('a7', 'b8');
    expect(fx.cracked).toBe(1);
    // The one closing and the one standing are both there for a moment.
    expect(fx.airborne.cracks).toBe(2);
    fx.update(1, 1);
    expect(fx.airborne.cracks).toBe(1);
  });

  it('leaves the cracks of a mate standing, wider than a check', () => {
    const { play, fx, spies } = setup('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
    const crack = vi.spyOn(fx, 'crack');
    play('a1', 'a8');
    expect(crack).toHaveBeenCalledTimes(1);
    expect(crack.mock.calls[0]![3]!.width).toBeGreaterThan(1);
    expect(spies.line.mock.calls.every((c) => (c[3] as { chalk?: boolean }).chalk)).toBe(true);
    fx.update(10, 10);
    expect(fx.cracked).toBe(1);
  });

  it('puts the cracks back when a move is taken back to a king in check, and closes them when a check is taken back', () => {
    const { play, fx, game, director } = setup('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    play('a1', 'a8');
    play('e8', 'e7');
    fx.update(2, 2);
    expect(fx.airborne.cracks).toBe(0);
    game.undo();
    director.undone(game.status());
    expect(fx.cracked).toBe(1);
    game.undo();
    director.undone(game.status());
    expect(fx.cracked).toBe(0);
  });

  it('is heard breaking as it happens, once for each attacker, and deeper at mate', () => {
    const one = setup('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    one.play('a1', 'a8');
    expect(one.breaks).toEqual([1]);
    // Out of check: nothing breaks.
    one.heard.length = 0;
    one.play('e8', 'e7');
    expect(one.heard).not.toContain('fracture');

    const two = setup('4k3/8/8/8/4B3/8/8/4R1K1 w - - 0 1');
    two.play('e4', 'c6');
    expect(two.breaks).toEqual([1, 1]);

    const mate = setup('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
    mate.play('a1', 'a8');
    expect(mate.breaks).toHaveLength(1);
    expect(mate.breaks[0]).toBeGreaterThan(1);
  });

  it('is not heard for a crack that is only put back: a move taken back, or a game taken up again', () => {
    const { play, game, director, heard } = setup('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    play('a1', 'a8');
    play('e8', 'e7');
    heard.length = 0;
    game.undo();
    director.undone(game.status());
    expect(heard).not.toContain('fracture');
    const again = setup('R3k3/8/8/8/8/8/8/4K3 b - - 0 1');
    expect(again.fx.cracked).toBe(1);
    again.director.reset(again.game.status());
    expect(again.heard).not.toContain('fracture');
  });

  it('shows the cracks of a game taken up again with a king in check, or mated, but not of one given up in check', () => {
    const check = setup('R3k3/8/8/8/8/8/8/4K3 b - - 0 1');
    expect(check.fx.cracked).toBe(1);
    const mate = setup('R5k1/5ppp/8/8/8/8/8/4K3 b - - 0 1');
    expect(mate.game.status().result).toBe('checkmate');
    expect(mate.fx.cracked).toBe(1);
    check.game.resign('b');
    check.director.reset(check.game.status());
    expect(check.fx.cracked).toBe(0);
  });
});

describe('waiting', () => {
  it('has the pieces of a player who is taking their time shift where they stand, and the clock heard', () => {
    const { director, heard, spies } = setup();
    for (let t = 0; t < 12; t += 0.5) director.update(0.5);
    expect(spies.fidget).not.toHaveBeenCalled();
    for (let t = 0; t < 16; t += 0.5) director.update(0.5);
    expect(spies.fidget).toHaveBeenCalled();
    expect(heard).toContain('tick');
    // A thought resets the wait.
    const before = spies.fidget.mock.calls.length;
    director.thought('e2', true);
    for (let t = 0; t < 10; t += 0.5) director.update(0.5);
    expect(spies.fidget.mock.calls.length).toBe(before);
  });
});
