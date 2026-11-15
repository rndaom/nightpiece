/**
 * The table the hands' manners are chosen from (docs/manners.md): the exactest row that fits is
 * the one played, the same thing is chosen on every screen, there is never too much of it, and a
 * game between two people is never told what the engine thinks.
 */
import { describe, expect, it } from 'vitest';
import { APART, CHANCE, MANNERS, MOST, Manners, type Judged, type Manner, type Moved, type Told, draw, judged, told } from '../src/hands/manners.ts';

const facts = (more: Partial<Told> = {}): Told => ({
  ply: 0,
  side: 'w',
  toMove: false,
  waited: 0,
  plain: false,
  result: null,
  drawReason: null,
  winner: null,
  happened: false,
  ended: null,
  quiet: false,
  ahead: 0,
  refused: false,
  move: null,
  tookBefore: null,
  checks: 0,
  lesson: false,
  timed: false,
  held: 0,
  again: 0,
  captive: null,
  candle: false,
  computer: false,
  feint: false,
  mates: false,
  hemmed: false,
  backRank: false,
  found: null,
  queens: 0,
  poked: null,
  ...more,
});

/** A move by white, a pawn from e2 to e3 unless told otherwise. */
const moved = (more: Partial<Moved> = {}): Moved => ({ by: 'w', kind: 'p', from: 'e2', to: 'e3', took: null, passing: false, becomes: null, castle: null, ...more });

/** A table of rows that always fit, so that only what is being tested decides. */
const always = () => true;
const table = <N extends string>(...rows: Manner<N>[]) => new Manners<N>(rows);

/** The first seed, counting up, for which `fits` is true: chance in these tests is looked for, never waited for. */
function seedWhere(fits: (seed: string) => boolean): string {
  for (let i = 0; i < 100000; i++) if (fits(`seed-${i}`)) return `seed-${i}`;
  throw new Error('no such seed');
}

describe('the draw', () => {
  it('is always the same for the same seed, ply and name, and is spread evenly from 0 up to 1', () => {
    expect(draw('room', 12, 'steeple')).toBe(draw('room', 12, 'steeple'));
    const tenths = new Array<number>(10).fill(0);
    for (let ply = 0; ply < 5000; ply++) {
      const n = draw('room', ply, 'steeple');
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
      tenths[Math.floor(n * 10)]!++;
    }
    for (const count of tenths) expect(Math.abs(count - 500)).toBeLessThan(90);
  });

  it('has nothing to do with the one for the next ply, or for another row at the same ply', () => {
    // If one told anything of the other, they would rise and fall together more often than not.
    for (const other of [(ply: number) => draw('room', ply + 1, 'steeple'), (ply: number) => draw('room', ply, 'drum-on-the-rail')]) {
      let together = 0;
      for (let ply = 0; ply < 4000; ply++) if (draw('room', ply, 'steeple') < 0.5 === other(ply) < 0.5) together++;
      expect(Math.abs(together - 2000)).toBeLessThan(160);
    }
  });
});

describe('choosing', () => {
  it('plays the row with the most conditions, of those that fit', () => {
    const rows = table(
      told({ name: 'general', at: 'end', when: [always], rarity: 'always' }),
      told({ name: 'exact', at: 'end', when: [always, (f) => f.result === 'resigned'], rarity: 'always' }),
    );
    rows.begin('a');
    expect(rows.choose('end', facts({ result: 'resigned' }))).toBe('exact');
    rows.begin('a');
    expect(rows.choose('end', facts({ result: 'checkmate' }))).toBe('general');
  });

  it('falls back to the general row when the exact one fits but its chance does not come up', () => {
    const rows = () =>
      table(
        told({ name: 'general', at: 'end', when: [always], rarity: 'always' }),
        told({ name: 'exact', at: 'end', when: [always, always], rarity: 'seldom' }),
      );
    const missed = seedWhere((seed) => draw(seed, 0, 'exact') >= CHANCE.seldom);
    const came = seedWhere((seed) => draw(seed, 0, 'exact') < CHANCE.seldom);
    const a = rows();
    a.begin(missed);
    expect(a.choose('end', facts())).toBe('general');
    const b = rows();
    b.begin(came);
    expect(b.choose('end', facts())).toBe('exact');
  });

  it('asks only the rows of the moment it is asked about', () => {
    const rows = table(told({ name: 'sitting', at: 'sit', when: [always], rarity: 'always' }), told({ name: 'ending', at: 'end', when: [always], rarity: 'always' }));
    rows.begin('a');
    expect(rows.choose('end', facts())).toBe('ending');
    expect(rows.considered).toEqual(['ending']);
  });

  it('chooses the same on two screens with the same seed, with nothing sent between them', () => {
    const rows = () => new Manners();
    for (let game = 0; game < 40; game++) {
      const [mine, theirs] = [rows(), rows()];
      mine.begin(`room-${game}`);
      theirs.begin(`room-${game}`);
      for (let ply = 0; ply < 80; ply++) {
        const now = facts({ ply, toMove: ply % 2 === 0, waited: 45 });
        expect(mine.choose('wait', now)).toBe(theirs.choose('wait', now));
      }
    }
  });

  it('plays each rarity about as often as it says', () => {
    for (const rarity of ['often', 'sometimes', 'seldom'] as const) {
      let played = 0;
      const games = 4000;
      for (let game = 0; game < games; game++) {
        const rows = table(told({ name: 'row', at: 'wait', when: [always], rarity }));
        rows.begin(`game-${game}`);
        if (rows.choose('wait', facts())) played++;
      }
      const share = played / games;
      expect(share).toBeGreaterThan(CHANCE[rarity] * 0.6);
      expect(share).toBeLessThan(CHANCE[rarity] * 1.5);
    }
  });
});

describe('not too much', () => {
  /** Every ply of a long game, asked of rows that would play every time if they were let. */
  const eager = () => {
    const rows = table(told({ name: 'one', at: 'wait', when: [always], rarity: 'often' }), told({ name: 'other', at: 'wait', when: [always], rarity: 'often' }));
    return rows;
  };
  const playAll = (rows: ReturnType<typeof eager>, seed: string, more: Partial<Told> = {}) => {
    rows.begin(seed);
    const played: { ply: number; name: string }[] = [];
    for (let ply = 0; ply < 200; ply++) {
      const name = rows.choose('wait', facts({ ply, ...more }));
      if (name) played.push({ ply, name });
    }
    return played;
  };

  it('plays no more than the budget in a game, with the plies between that it must leave, and never the same row twice running', () => {
    for (let game = 0; game < 60; game++) {
      const played = playAll(eager(), `game-${game}`);
      expect(played.length).toBeLessThanOrEqual(MOST);
      for (let i = 1; i < played.length; i++) {
        expect(played[i]!.ply - played[i - 1]!.ply).toBeGreaterThanOrEqual(APART);
        expect(played[i]!.name).not.toBe(played[i - 1]!.name);
      }
    }
  });

  it('has the whole budget again in the next game', () => {
    const rows = eager();
    const first = playAll(rows, 'first');
    const second = playAll(rows, 'second');
    expect(first.length).toBe(MOST);
    expect(second.length).toBe(MOST);
  });

  it('plays a ritual whatever the budget, but never twice in one ply', () => {
    const rows = table(told({ name: 'extra', at: 'wait', when: [always], rarity: 'often' }), told({ name: 'ritual', at: 'end', when: [always], rarity: 'always' }));
    rows.begin(seedWhere((seed) => draw(seed, 0, 'extra') < CHANCE.often));
    expect(rows.choose('wait', facts())).toBe('extra');
    expect(rows.choose('end', facts())).toBe('ritual');
    expect(rows.choose('end', facts())).toBeNull();
    expect(rows.choose('end', facts({ ply: 1 }))).toBe('ritual');
  });

  it('plays a ritual again at a ply that was taken back and made again', () => {
    const rows = table(told({ name: 'ritual', at: 'set', when: [always], rarity: 'always' }));
    rows.begin('a');
    expect(rows.choose('set', facts({ ply: 5 }))).toBe('ritual');
    expect(rows.choose('set', facts({ ply: 5 }))).toBeNull();
    rows.takeBack(5);
    expect(rows.choose('set', facts({ ply: 5 }))).toBe('ritual');
  });

  it('plays a row marked once only once in a sitting, however many games are played', () => {
    const rows = table(told({ name: 'joke', at: 'sit', when: [always], rarity: 'once' }));
    let played = 0;
    for (let game = 0; game < 400; game++) {
      rows.begin(`game-${game}`);
      if (rows.choose('sit', facts())) played++;
    }
    expect(played).toBe(1);
    expect(rows.has('joke')).toBe(true);
  });

  it('plays only the rituals for a player who has asked for less motion', () => {
    const rows = table(told({ name: 'extra', at: 'wait', when: [always], rarity: 'often' }), told({ name: 'ritual', at: 'end', when: [always], rarity: 'always' }));
    for (let game = 0; game < 200; game++) {
      rows.begin(`game-${game}`);
      expect(rows.choose('wait', facts({ quiet: true }))).toBeNull();
    }
    expect(rows.choose('end', facts({ quiet: true }))).toBe('ritual');
  });
});

describe('fairness', () => {
  const mind = judged({ name: 'reads-the-engine', at: 'after', when: [(f: Judged) => f.verdict === 'blunder'], rarity: 'always' });
  const open = told({ name: 'sees-the-board', at: 'after', when: [always], rarity: 'always' });

  it('never so much as looks at a row that goes by the engine, in a game that is only told what the board shows', () => {
    const rows = new Manners<string>([...MANNERS, mind, open]);
    const moments = ['sit', 'wait', 'think', 'set', 'after', 'offer', 'end'] as const;
    let n = 7;
    const next = () => (n = (Math.imul(n, 1103515245) + 12345) >>> 0) / 0x100000000;
    for (let game = 0; game < 300; game++) {
      rows.begin(`plain-${game}`);
      for (let ply = 0; ply < 60; ply++) {
        const now = facts({ ply, plain: true, side: next() < 0.5 ? 'w' : 'b', toMove: next() < 0.5, waited: next() * 90 });
        const name = rows.choose(moments[Math.floor(next() * moments.length)]!, now);
        expect(rows.considered).not.toContain('reads-the-engine');
        expect(name).not.toBe('reads-the-engine');
      }
    }
  });

  it('looks at every row where the engine may be shown', () => {
    const rows = new Manners<string>([mind, open]);
    rows.begin('a');
    expect(rows.chooseJudged('after', { ...facts(), verdict: 'blunder', motifs: [] })).toBe('reads-the-engine');
    expect(rows.considered).toEqual(['reads-the-engine', 'sees-the-board']);
  });
});

describe('the table as it stands', () => {
  const resigned = (more: Partial<Told> = {}) => facts({ result: 'resigned', winner: 'b', side: 'w', happened: true, ...more });

  it("lays the king down for a player who gives the game up, by that player's own hand", () => {
    const rows = new Manners();
    rows.begin('a');
    expect(rows.choose('end', resigned())).toBe('tip-the-king');
    rows.begin('a');
    expect(rows.choose('end', resigned({ side: 'b' }))).toBeNull();
  });

  it.each([
    ['time', 'out-of-time'],
    ['left', 'gone'],
    ['noshow', 'gone'],
  ] as const)('does not when it was the clock or the server that ended it (%s), but has an ending of its own for that', (ended, ending) => {
    const rows = new Manners();
    rows.begin('a');
    expect(rows.choose('end', resigned({ ended }))).toBe(ending);
  });

  it.each([
    ['stalemate', 'scuffle'],
    ['threefold', 'rock-paper-scissors'],
    ['fivefold', 'rock-paper-scissors'],
    ['fifty-move', 'asleep'],
    ['seventy-five-move', 'asleep'],
    ['insufficient', 'empty-purse'],
    ['agreement', 'handshake'],
  ] as const)('ends a game drawn by %s with %s, every time', (drawReason, ending) => {
    const rows = new Manners();
    for (let game = 0; game < 50; game++) {
      rows.begin(`game-${game}`);
      expect(rows.choose('end', facts({ result: 'draw', drawReason, happened: true }))).toBe(ending);
    }
  });

  it('has nothing out of the ordinary for a draw on time, or for a draw only being stood again as it was left', () => {
    const rows = new Manners();
    rows.begin('a');
    expect(rows.choose('end', facts({ result: 'draw', drawReason: 'timeout', happened: true }))).toBeNull();
    expect(rows.choose('end', facts({ result: 'draw', drawReason: 'stalemate', happened: false }))).toBeNull();
  });

  it('does nothing out of the ordinary to a player who moves in good time', () => {
    const rows = new Manners();
    for (let game = 0; game < 300; game++) {
      rows.begin(`game-${game}`);
      for (let ply = 0; ply < 80; ply++) {
        expect(rows.choose('wait', facts({ ply, toMove: true, waited: 11 }))).toBeNull();
        expect(rows.choose('wait', facts({ ply, toMove: false, waited: 11 }))).toBeNull();
      }
    }
  });

  it('is not met in every game, even by players who take their time over every move', () => {
    let games = 0;
    let extras = 0;
    for (let game = 0; game < 400; game++) {
      const rows = new Manners();
      rows.begin(`game-${game}`);
      let any = 0;
      // Sixty plies, and ten of them long thinks: a slow game.
      for (let ply = 0; ply < 60; ply++) {
        if (ply % 6) continue;
        for (const toMove of [true, false]) if (rows.choose('wait', facts({ ply, toMove, side: toMove ? 'w' : 'b', waited: 40 }))) any++;
      }
      if (any) games++;
      extras += any;
      expect(any).toBeLessThanOrEqual(MOST);
    }
    expect(games / 400).toBeLessThan(0.5);
    expect(games / 400).toBeGreaterThan(0.1);
    expect(extras / 400).toBeLessThan(0.6);
  });

  describe('how a piece is set down', () => {
    /** What is chosen as `side`'s stone is set down, in each of many games, at this ply. */
    const setting = (move: Moved, more: Partial<Told> = {}, games = 400) => {
      const chosen: (string | null)[] = [];
      for (let game = 0; game < games; game++) {
        const rows = new Manners();
        rows.begin(`game-${game}`);
        chosen.push(rows.choose('set', facts({ ply: 3, side: move.by, toMove: true, move, ...more })));
      }
      return chosen;
    };
    const share = (chosen: (string | null)[], name: string) => chosen.filter((c) => c === name).length / chosen.length;

    it('raps the pawn on the empty square every time a pawn takes in passing', () => {
      expect(new Set(setting(moved({ from: 'e5', to: 'd6', took: 'p', passing: true })))).toEqual(new Set(['empty-square']));
    });

    it('snaps its fingers every time a pawn is made into something, whatever it is made into', () => {
      for (const becomes of ['q', 'r', 'b', 'n'] as const) expect(new Set(setting(moved({ from: 'b7', to: 'b8', becomes })))).toEqual(new Set(['snap']));
    });

    it('holds a queen up when one is taken, but not the second of two taken one after the other', () => {
      expect(new Set(setting(moved({ kind: 'n', from: 'c3', to: 'd5', took: 'q' })))).toEqual(new Set(['trophy']));
      expect(setting(moved({ kind: 'q', from: 'd1', to: 'd8', took: 'q' }), { tookBefore: 'q' })).not.toContain('trophy');
    });

    it('pats the king about one castling in five, and nothing else', () => {
      const chosen = setting(moved({ kind: 'k', from: 'e1', to: 'g1', castle: 'short' }), {}, 2000);
      expect(share(chosen, 'pat')).toBeGreaterThan(CHANCE.often * 0.75);
      expect(share(chosen, 'pat')).toBeLessThan(CHANCE.often * 1.25);
      expect(chosen.every((c) => c === 'pat' || c === null)).toBe(true);
    });

    it('pushes a pawn one square, now and then, in the first six plies only, and never two squares or a capture', () => {
      const early = setting(moved(), {}, 2000);
      expect(share(early, 'push')).toBeGreaterThan(CHANCE.often * 0.75);
      expect(share(early, 'push')).toBeLessThan(CHANCE.often * 1.25);
      expect(setting(moved(), { ply: 7 })).not.toContain('push');
      expect(setting(moved({ to: 'e4' }))).not.toContain('push');
      expect(setting(moved({ to: 'd3', took: 'n' }))).not.toContain('push');
      expect(setting(moved({ by: 'b', from: 'e7', to: 'e6' }))).toContain('push');
    });

    it('squares a stone up seldom, and never in a lesson, after castling, taking in passing, making a pawn into something or taking a queen', () => {
      const knight = moved({ kind: 'n', from: 'g1', to: 'f3' });
      const chosen = setting(knight, { ply: 9 }, 8000);
      expect(share(chosen, 'squaring-up')).toBeGreaterThan(CHANCE.seldom * 0.7);
      expect(share(chosen, 'squaring-up')).toBeLessThan(CHANCE.seldom * 1.3);
      expect(setting(knight, { ply: 9, lesson: true }, 8000)).not.toContain('squaring-up');
      for (const move of [
        moved({ kind: 'k', from: 'e1', to: 'g1', castle: 'short' }),
        moved({ from: 'e5', to: 'd6', took: 'p', passing: true }),
        moved({ from: 'b7', to: 'b8', becomes: 'n' }),
        moved({ kind: 'n', from: 'c3', to: 'd5', took: 'q' }),
      ])
        expect(setting(move, { ply: 9 }, 2000)).not.toContain('squaring-up');
    });

    it('is asked only of the hands whose move it is', () => {
      expect(setting(moved({ from: 'e5', to: 'd6', took: 'p', passing: true }), { side: 'b', toMove: false })).toEqual(new Array(400).fill(null));
    });

    it('plays the pat, the push and squaring up only for a player who has not asked for less motion, and the rituals whatever', () => {
      expect(setting(moved(), { quiet: true })).toEqual(new Array(400).fill(null));
      expect(setting(moved({ kind: 'k', from: 'e1', to: 'c1', castle: 'long' }), { quiet: true })).toEqual(new Array(400).fill(null));
      expect(new Set(setting(moved({ from: 'b7', to: 'b8', becomes: 'q' }), { quiet: true }))).toEqual(new Set(['snap']));
    });
  });

  describe('after a move', () => {
    const after = (more: Partial<Told>) => {
      const rows = new Manners();
      rows.begin('a');
      return rows.choose('after', facts({ ply: 30, ...more }));
    };

    it("turns the other side's hand over when a pawn is made into anything but a queen", () => {
      for (const becomes of ['r', 'b', 'n'] as const) expect(after({ side: 'b', move: moved({ from: 'b7', to: 'b8', becomes }) })).toBe('really');
      expect(after({ side: 'b', move: moved({ from: 'b7', to: 'b8', becomes: 'q' }) })).toBeNull();
      expect(after({ side: 'w', move: moved({ from: 'b7', to: 'b8', becomes: 'n' }) })).toBeNull();
    });

    it('makes less of each check given running by the same side, and nothing new of the first', () => {
      const check = (checks: number) => after({ side: 'w', move: moved({ kind: 'q', from: 'd1', to: 'h5' }), checks });
      expect(check(1)).toBeNull();
      expect(check(2)).toBe('check-again');
      expect(check(3)).toBe('check-thrice');
      expect(check(4)).toBe('check-on');
      expect(check(9)).toBe('check-on');
      expect(after({ side: 'b', move: moved({ kind: 'q', from: 'd1', to: 'h5' }), checks: 3 })).toBeNull();
    });
  });
});


describe('waiting, thinking, and what is found on the board', () => {
  /** How often `name` is chosen at `at`, over many games, with these facts. */
  const share = (at: Parameters<Manners['choose']>[0], name: string, more: Partial<Told>, games = 2000) => {
    let chosen = 0;
    for (let game = 0; game < games; game++) {
      const rows = new Manners();
      rows.begin(`game-${game}`);
      if (rows.choose(at, facts(more)) === name) chosen++;
    }
    return chosen / games;
  };
  const once = (at: Parameters<Manners['choose']>[0], more: Partial<Told>) => {
    const rows = new Manners();
    rows.begin('one game');
    return rows.choose(at, facts(more));
  };

  it('cracks knuckles before the first move in about one game in five, and only with the hands of the player who moves first', () => {
    expect(share('sit', 'knuckles', { side: 'w' })).toBeGreaterThan(0.15);
    expect(share('sit', 'knuckles', { side: 'w' })).toBeLessThan(0.25);
    expect(share('sit', 'knuckles', { side: 'b' })).toBe(0);
    expect(share('sit', 'knuckles', { side: 'w', ply: 1 })).toBe(0);
  });

  it('climbs the ladder of impatience past drumming only without a clock, and only for the player kept waiting', () => {
    const rung = (waited: number, more: Partial<Told> = {}) => share('wait', 'look-at-the-cord', { waited, ...more }) + share('wait', 'lie-on-the-rail', { waited, ...more });
    expect(share('wait', 'look-at-the-cord', { waited: 49 })).toBe(0);
    expect(share('wait', 'look-at-the-cord', { waited: 50 })).toBeGreaterThan(0.15);
    expect(share('wait', 'lie-on-the-rail', { waited: 74 })).toBe(0);
    expect(share('wait', 'lie-on-the-rail', { waited: 75 })).toBeGreaterThan(0.08);
    expect(rung(200, { timed: true })).toBe(0);
    expect(rung(200, { toMove: true })).toBe(0);
    // In a game against a clock the drumming is as far as it goes.
    expect(share('wait', 'drum-on-the-rail', { waited: 200, timed: true }, 4000)).toBeGreaterThan(0);
  });

  it('looks at a captive seldom, and never at a pawn or with nothing taken; warms a hand seldom, and only where a candle burns', () => {
    expect(share('wait', 'captives', { waited: 10, captive: 'n' }, 4000)).toBeGreaterThan(0.01);
    expect(share('wait', 'captives', { waited: 10, captive: 'n' }, 4000)).toBeLessThan(0.05);
    expect(share('wait', 'captives', { waited: 10, captive: 'p' })).toBe(0);
    expect(share('wait', 'captives', { waited: 10 })).toBe(0);
    expect(share('wait', 'captives', { waited: 10, captive: 'q', toMove: true })).toBe(0);
    expect(share('wait', 'candle', { waited: 12, candle: true }, 4000)).toBeGreaterThan(0.01);
    expect(share('wait', 'candle', { waited: 12, candle: true }, 4000)).toBeLessThan(0.05);
    expect(share('wait', 'candle', { waited: 12 })).toBe(0);
  });

  it('wags a finger at a stone left after a second and a half, and then not for six plies', () => {
    const rows = new Manners();
    rows.begin('a game');
    expect(rows.choose('think', facts({ toMove: true, held: 1.4 }))).toBeNull();
    expect(rows.choose('think', facts({ toMove: true, held: 1.5 }))).toBe('second-thought');
    expect(rows.choose('think', facts({ toMove: true, held: 3, ply: 6 }))).toBeNull();
    expect(rows.choose('think', facts({ toMove: true, held: 3, ply: 7 }))).toBe('second-thought');
    // A ritual, though a small one: it is not shown to a player who is not to move.
    expect(once('think', { toMove: false, held: 3 })).toBeNull();
  });

  it('sets a stone straight the third time it is turned to in a turn, once', () => {
    const rows = new Manners();
    rows.begin('a game');
    expect(rows.choose('think', facts({ toMove: true, again: 1 }))).toBeNull();
    expect(rows.choose('think', facts({ toMove: true, again: 2 }))).toBe('jadoube');
    expect(rows.choose('think', facts({ toMove: true, again: 3 }))).toBeNull();
    expect(rows.choose('think', facts({ toMove: true, again: 2, ply: 1 }))).toBe('jadoube');
  });

  it("feints with the computer's hand about one move in twelve, and never in a lesson, in a game between two people, or with nothing to feint at", () => {
    const feint = (more: Partial<Told>) => share('think', 'feint', { computer: true, feint: true, ...more }, 4000);
    expect(feint({})).toBeGreaterThan(0.05);
    expect(feint({})).toBeLessThan(0.12);
    expect(feint({ lesson: true })).toBe(0);
    expect(feint({ plain: true })).toBe(0);
    expect(feint({ feint: false })).toBe(0);
    expect(feint({ computer: false })).toBe(0);
  });

  it('knows the king stepped up, the knight home again, the copy and the third queen for what they are', () => {
    const king = moved({ kind: 'k', from: 'e1', to: 'e2' });
    expect(once('set', { ply: 3, move: king, found: 'bongcloud' })).toBe('bongcloud');
    expect(once('set', { ply: 4, side: 'b', move: { ...king, by: 'b', from: 'e8', to: 'e7' }, found: 'bongcloud-both' })).toBe('bongcloud-both');
    expect(once('set', { ply: 3, move: king, found: 'bongcloud', lesson: true })).not.toBe('bongcloud');
    const knight = moved({ kind: 'n', from: 'f3', to: 'g1' });
    expect(share('set', 'home-again', { ply: 3, move: knight, found: 'home-again' }, 4000)).toBeGreaterThan(0.04);
    expect(share('set', 'home-again', { ply: 3, move: knight, found: 'home-again' }, 4000)).toBeLessThan(0.13);
    expect(share('set', 'home-again', { ply: 3, move: knight })).toBe(0);
    expect(once('after', { ply: 8, side: 'w', move: moved({ by: 'b', kind: 'b', from: 'f8', to: 'c5' }), found: 'copycat' })).toBe('copycat');
    expect(once('after', { ply: 8, side: 'b', move: moved({ by: 'b', kind: 'b', from: 'f8', to: 'c5' }), found: 'copycat' })).toBeNull();
    const queen = moved({ from: 'b7', to: 'b8', becomes: 'q' });
    expect(once('after', { side: 'b', move: queen, queens: 3 })).toBe('third-queen');
    expect(once('after', { side: 'b', move: queen, queens: 2 })).toBeNull();
    expect(once('after', { side: 'w', move: queen, queens: 3 })).toBeNull();
    // Made into a knight with two queens standing: that is "really?", as ever.
    expect(once('after', { side: 'b', move: { ...queen, becomes: 'n' }, queens: 2 })).toBe('really');
  });

  it('answers a mate by what gave it: the exactest that fits, and the plain claim most times for a plain one', () => {
    const mate = (more: Partial<Told>) => ({ result: 'checkmate' as const, happened: true, winner: 'w' as const, side: 'w' as const, ply: 40, ...more });
    const rook = moved({ kind: 'r', from: 'a1', to: 'a8' });
    expect(once('end', mate({ move: rook, backRank: true }))).toBe('back-rank');
    expect(once('end', mate({ move: moved({ kind: 'k', from: 'e1', to: 'g1', castle: 'short' }) }))).toBe('mate-by-castling');
    expect(once('end', mate({ move: moved({ kind: 'q', from: 'd8', to: 'h4' }), ply: 4 }))).toBe('early-mate');
    // On the back rank and early at once: the rank, which says more.
    expect(once('end', mate({ move: rook, backRank: true, ply: 10 }))).toBe('back-rank');
    expect(share('end', 'laid-down', mate({ move: moved({ kind: 'q', from: 'd1', to: 'h5' }) }))).toBeGreaterThan(0.15);
    expect(share('end', 'laid-down', mate({ move: moved({ kind: 'q', from: 'd1', to: 'h5' }) }))).toBeLessThan(0.25);
    // Not for the loser's hands, nor for a mate only being shown as it was left.
    expect(once('end', mate({ move: rook, backRank: true, side: 'b' }))).toBeNull();
    expect(once('end', mate({ move: rook, backRank: true, happened: false }))).toBeNull();
    // At the set: the knight that smothers is patted, and the pawn that mates hops.
    expect(once('set', { move: moved({ kind: 'n', from: 'g5', to: 'f7' }), mates: true, hemmed: true, ply: 30 })).toBe('smothered');
    expect(once('set', { move: moved({ kind: 'n', from: 'g5', to: 'f7' }), mates: true, hemmed: false, ply: 30 })).not.toBe('smothered');
    expect(once('set', { move: moved({ from: 'g6', to: 'g7' }), mates: true, ply: 30 })).toBe('mate-by-pawn');
    expect(once('set', { move: moved({ from: 'g7', to: 'g8', becomes: 'q' }), mates: true, ply: 30 })).toBe('snap');
  });

  it('may be set off by the player again and again, and only by what the player did', () => {
    const rows = new Manners();
    rows.begin('a game');
    for (let i = 0; i < 3; i++) expect(rows.choose('poke', facts({ poked: 'wave' }))).toBe('wave');
    expect(rows.choose('poke', facts({ poked: 'weight' }))).toBe('weight-pulled');
    expect(rows.choose('poke', facts({ poked: 'back' }))).toBe('back');
    expect(rows.choose('poke', facts())).toBeNull();
    // Even by a player who has asked for less motion: they asked for this.
    expect(rows.choose('poke', facts({ poked: 'wave', quiet: true }))).toBe('wave');
  });
});

describe('what is part of a move', () => {
  const ROW = told({ name: 'flourish', at: 'set', when: [always], rarity: 'seldom' });
  const OTHER = told({ name: 'other', at: 'set', when: [always], rarity: 'often' });
  const ANOTHER = told({ name: 'another', at: 'set', when: [always], rarity: 'often' });
  /** A board at which the one row comes up at the first ply, and the other at the thirteenth. */
  const TWICE = seedWhere((s) => draw(s, 1, 'other') < CHANCE.often && draw(s, 1, 'another') >= CHANCE.often && draw(s, 13, 'another') < CHANCE.often && draw(s, 25, 'other') < CHANCE.often && draw(s, 30, 'idle') < CHANCE.often);

  it('is chosen alike whatever the sitting has seen before the game', () => {
    for (let game = 0; game < 2000; game++) {
      const fresh = table(ROW);
      const seasoned = table(ROW);
      // The seasoned screen has seen the row in a game of its own.
      seasoned.begin(seedWhere((seed) => draw(seed, 0, 'flourish') < CHANCE.seldom));
      expect(seasoned.choose('set', facts())).toBe('flourish');
      fresh.begin(`room-${game}`);
      seasoned.begin(`room-${game}`);
      expect(seasoned.choose('set', facts({ ply: 3 }))).toBe(fresh.choose('set', facts({ ply: 3 })));
    }
  });

  it('counts its budget from the moves of the game as it stands: what is taken back is the game to spend again', () => {
    const seed = seedWhere((s) => draw(s, 1, 'other') < CHANCE.often && draw(s, 3, 'other') < CHANCE.often);
    const rows = table(OTHER);
    rows.begin(seed);
    expect(rows.choose('set', facts({ ply: 1 }))).toBe('other');
    // Too soon after the last.
    expect(rows.choose('set', facts({ ply: 3 }))).toBeNull();
    // The first is taken back; and so the third ply is free to have it.
    rows.takeBack(1);
    expect(rows.choose('set', facts({ ply: 3 }))).toBe('other');
  });

  it('is chosen, and spends the budget, for a player who has asked for less motion as for any other; it is only not shown to them', () => {
    const [still, moving] = [table(OTHER, ANOTHER), table(OTHER, ANOTHER)];
    still.begin(TWICE);
    moving.begin(TWICE);
    const shown: (string | null)[] = [];
    for (const ply of [1, 13]) {
      expect(still.choose('set', facts({ ply, quiet: true }))).toBeNull();
      shown.push(moving.choose('set', facts({ ply })));
    }
    expect(shown).toEqual(['other', 'another']);
    // Spent alike: a third would go over the budget on either screen, even one shown it.
    expect(moving.choose('set', facts({ ply: 25 }))).toBeNull();
    expect(still.choose('set', facts({ ply: 25 }))).toBeNull();
  });

  it('keeps the moments that go by the time a screen keeps itself to what the moves have left of the budget', () => {
    const idle = told({ name: 'idle', at: 'wait', when: [always], rarity: 'often' });
    const spent = table(OTHER, ANOTHER, idle);
    spent.begin(TWICE);
    expect(spent.choose('set', facts({ ply: 1 }))).toBe('other');
    expect(spent.choose('set', facts({ ply: 13 }))).toBe('another');
    expect(spent.choose('wait', facts({ ply: 30 }))).toBeNull();
    // With the moves having spent nothing, it would have come.
    const unspent = table(OTHER, ANOTHER, idle);
    unspent.begin(TWICE);
    expect(unspent.choose('wait', facts({ ply: 30 }))).toBe('idle');
  });

  it('against a clock, neither raps the empty square nor pushes a pawn', () => {
    const passing = moved({ from: 'e5', to: 'f6', took: 'p', passing: true });
    const rows = new Manners();
    rows.begin(seedWhere((s) => draw(s, 1, 'push') < CHANCE.often));
    expect(rows.choose('set', facts({ ply: 1, move: moved(), timed: true }))).toBeNull();
    expect(rows.choose('set', facts({ ply: 2, move: passing, timed: true }))).toBeNull();
    expect(rows.choose('set', facts({ ply: 3, move: passing }))).toBe('empty-square');
  });
});
