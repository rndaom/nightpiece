import { describe, expect, it } from 'vitest';
import { BRAND, FORMER_IDS, readStored, storageKey } from '../src/app/brand';

/** A browser's storage, as far as the game uses it. */
function storage(seed: Record<string, string> = {}): Storage {
  const held = new Map(Object.entries(seed));
  return {
    get length() {
      return held.size;
    },
    clear: () => held.clear(),
    getItem: (k: string) => held.get(k) ?? null,
    key: (i: number) => [...held.keys()][i] ?? null,
    removeItem: (k: string) => void held.delete(k),
    setItem: (k: string, v: string) => void held.set(k, v),
  };
}

describe('the name', () => {
  it('is spelled the same way wherever it is used', () => {
    expect(BRAND.words.join('').toLowerCase()).toBe(BRAND.name.toLowerCase());
    expect(BRAND.id).toBe(BRAND.name.toLowerCase());
    expect(storageKey('settings.v1')).toBe('nightpiece.settings.v1');
  });

  it('reads what is stored under the name it has now', () => {
    const s = storage({ 'nightpiece.settings.v1': 'new', 'mortmain.settings.v1': 'old' });
    expect(readStored(s, 'settings.v1')).toBe('new');
    // What is under the old name is left alone when it is not needed.
    expect(s.getItem('mortmain.settings.v1')).toBe('old');
  });

  it('carries over what was stored under a name it had before, once', () => {
    for (const former of FORMER_IDS) {
      const s = storage({ [`${former}.settings.v1`]: '{"quality":"low"}' });
      expect(readStored(s, 'settings.v1')).toBe('{"quality":"low"}');
      expect(s.getItem('nightpiece.settings.v1')).toBe('{"quality":"low"}');
      expect(s.getItem(`${former}.settings.v1`)).toBeNull();
      // The second reading finds it under the new name.
      expect(readStored(s, 'settings.v1')).toBe('{"quality":"low"}');
    }
  });

  it('finds nothing where nothing was stored', () => {
    expect(readStored(storage(), 'settings.v1')).toBeNull();
  });
});
