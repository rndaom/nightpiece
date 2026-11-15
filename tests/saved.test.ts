/**
 * The game kept in the browser: what is written, and how little of what is
 * read back is taken on trust.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { storageKey } from '../src/app/brand.ts';
import { clearSavedGame, readSavedGame, type SavedGame, summarise, writeSavedGame } from '../src/app/saved.ts';

function storage(): Storage {
  const kept = new Map<string, string>();
  return {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
    clear: () => kept.clear(),
    key: (i: number) => [...kept.keys()][i] ?? null,
    get length() {
      return kept.size;
    },
  };
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const SLOT = storageKey('game.v1');
const game = (over: Partial<SavedGame> = {}): SavedGame => ({
  kind: 'computer',
  level: 'club',
  side: 'b',
  asked: 'either',
  startFen: START,
  moves: [
    { from: 'e2', to: 'e4' },
    { from: 'e7', to: 'e5' },
    { from: 'g1', to: 'f3' },
  ],
  seat: 'b',
  at: 1_700_000_000_000,
  ...over,
});

let store: Storage;
beforeEach(() => {
  store = storage();
});

describe('the kept game', () => {
  it('comes back as it was written', () => {
    writeSavedGame(store, game());
    expect(readSavedGame(store)).toEqual(game());
  });

  it('is nothing when nothing was kept', () => {
    expect(readSavedGame(store)).toBeNull();
    expect(summarise(null)).toBeNull();
  });

  it('keeps a game between two at one screen without a level or a side', () => {
    writeSavedGame(store, game({ kind: 'table', level: 'club', side: 'b', asked: 'b' }));
    const back = readSavedGame(store)!;
    expect(back.kind).toBe('table');
    expect(back).not.toHaveProperty('level');
    expect(back).not.toHaveProperty('side');
    expect(back).not.toHaveProperty('asked');
  });

  it('keeps a promotion', () => {
    const promoting = game({
      kind: 'table',
      // A pawn is left on the board as well, so that the game is not at once a draw for want of stones.
      startFen: '7k/P7/8/8/8/8/7P/K7 w - - 0 1',
      moves: [{ from: 'a7', to: 'a8', promotion: 'n' }],
    });
    writeSavedGame(store, promoting);
    expect(readSavedGame(store)!.moves).toEqual([{ from: 'a7', to: 'a8', promotion: 'n' }]);
  });

  it('is summed up in whole moves, counting one not yet answered', () => {
    expect(summarise(game())).toEqual({ kind: 'computer', level: 'club', side: 'b', moves: 2, at: 1_700_000_000_000 });
    expect(summarise(game({ moves: [{ from: 'e2', to: 'e4' }] }))!.moves).toBe(1);
  });

  it('can be thrown away', () => {
    writeSavedGame(store, game());
    clearSavedGame(store);
    expect(store.getItem(SLOT)).toBeNull();
    expect(readSavedGame(store)).toBeNull();
  });
});

describe('what is not a game to go back to', () => {
  const rejected = (raw: string) => {
    store.setItem(SLOT, raw);
    expect(readSavedGame(store), raw).toBeNull();
    // And it is thrown away, so that it is not offered again.
    expect(store.getItem(SLOT), raw).toBeNull();
  };

  it('something that is not a record at all', () => {
    rejected('not json');
    rejected('null');
    rejected('[]');
    rejected(JSON.stringify({ kind: 'online', startFen: START, moves: [{ from: 'e2', to: 'e4' }] }));
    rejected(JSON.stringify({ kind: 'table', moves: [{ from: 'e2', to: 'e4' }] }));
    rejected(JSON.stringify({ kind: 'table', startFen: START, moves: 'e2e4' }));
  });

  it('a game with no move made', () => {
    rejected(JSON.stringify(game({ moves: [] })));
  });

  it('a position that cannot be set up', () => {
    rejected(JSON.stringify(game({ startFen: 'nonsense' })));
  });

  it('a move that is not a move, or that the rules do not allow', () => {
    rejected(JSON.stringify({ ...game(), moves: [{ from: 'e2', to: 'e9' }] }));
    rejected(JSON.stringify({ ...game(), moves: [{ from: 'e2', to: 'e4', promotion: 'k' }] }));
    rejected(JSON.stringify({ ...game(), moves: [{ from: 'e2', to: 'e5' }] }));
    rejected(JSON.stringify({ ...game(), moves: [null] }));
  });

  it('a game that has already ended', () => {
    const mate = [
      { from: 'f2', to: 'f3' },
      { from: 'e7', to: 'e5' },
      { from: 'g2', to: 'g4' },
      { from: 'd8', to: 'h4' },
    ] as SavedGame['moves'];
    rejected(JSON.stringify(game({ moves: mate })));
  });

  it('a record longer than any game', () => {
    const shuffle: SavedGame['moves'] = [];
    for (let i = 0; i < 301; i++) shuffle.push({ from: 'g1', to: 'f3' }, { from: 'g8', to: 'f6' }, { from: 'f3', to: 'g1' }, { from: 'f6', to: 'g8' });
    rejected(JSON.stringify(game({ moves: shuffle })));
  });
});

describe('what is mended rather than refused', () => {
  it('a level that no longer exists, a side that is not one, a seat or a time that is missing', () => {
    store.setItem(SLOT, JSON.stringify({ kind: 'computer', level: 'grandmaster', side: 'x', asked: 7, startFen: START, moves: [{ from: 'e2', to: 'e4' }] }));
    expect(readSavedGame(store)).toEqual({ kind: 'computer', level: 'casual', side: 'w', asked: 'w', startFen: START, moves: [{ from: 'e2', to: 'e4' }], seat: 'w', at: 0 });
  });

  it('drops anything else that was written beside a move', () => {
    store.setItem(SLOT, JSON.stringify({ ...game(), moves: [{ from: 'e2', to: 'e4', san: 'e4', evil: true }], extra: 1 }));
    const back = readSavedGame(store)!;
    expect(back.moves).toEqual([{ from: 'e2', to: 'e4' }]);
    expect(back).not.toHaveProperty('extra');
  });

  it('does not throw when the storage itself fails', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(readSavedGame(broken)).toBeNull();
    expect(() => writeSavedGame(broken, game())).not.toThrow();
    expect(() => clearSavedGame(broken)).not.toThrow();
  });
});
