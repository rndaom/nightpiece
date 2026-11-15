/**
 * The game's name. Every place the name is shown or used as a key takes it from here, so the
 * game can be renamed by editing this file (and the three places a build cannot reach: the
 * <title> in index.html, "name" in package.json and the heading of the README).
 *
 * A nightpiece is a nocturne: a piece of music, or a painting, of the night. Here it is also
 * what stands on the board: pieces moved by hands made of night. Two players, four hands.
 */
export const BRAND = {
  /** As written in a sentence. */
  name: 'Nightpiece',
  /** As set on the title screen, where the two words stack. */
  words: ['Night', 'piece'] as const,
  /** A longer line for the opening screen. */
  epigraph: 'A nocturne for four hands, in ivory and void.',
  /** Lower-case, no spaces: storage keys, shader cache keys, the dev handle. */
  id: 'nightpiece',
} as const;

/** Names the game has had before. Settings saved under them are carried over once. */
export const FORMER_IDS = ['mortmain'] as const;

/** A key in the browser's storage that belongs to this game. */
export function storageKey(name: string): string {
  return `${BRAND.id}.${name}`;
}

/**
 * Read a stored value, looking under the game's former names if nothing is stored under this
 * one. What is found under an old name is moved to the new one, so it is only looked for once.
 */
export function readStored(storage: Storage, name: string): string | null {
  const key = storageKey(name);
  const current = storage.getItem(key);
  if (current !== null) return current;
  for (const former of FORMER_IDS) {
    const old = `${former}.${name}`;
    const value = storage.getItem(old);
    if (value === null) continue;
    storage.setItem(key, value);
    storage.removeItem(old);
    return value;
  }
  return null;
}
