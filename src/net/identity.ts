/**
 * Who this browser is, without an account: a secret it makes for itself the
 * first time it is needed and keeps from then on, and the name the player
 * has chosen to go by. The server knows the player by the secret alone.
 *
 * Clearing the browser's storage, or playing from another browser, makes a
 * new player.
 */
import { readStored, storageKey } from '../app/brand';
import { cleanName } from './protocol';

export interface Identity {
  id: string;
  /** Empty until the player has chosen one; the server then gives them one of its own. */
  name: string;
}

const KEY = 'player.v1';
/** For a browser that will not keep anything: the same player for as long as the page lasts. */
let fallback: Identity | null = null;

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function identity(): Identity {
  if (fallback) return fallback;
  try {
    const raw = readStored(localStorage, KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Identity>) : null;
    if (saved && typeof saved.id === 'string' && /^[0-9a-f]{32}$/.test(saved.id)) {
      return { id: saved.id, name: cleanName(saved.name) };
    }
    const made: Identity = { id: newId(), name: '' };
    localStorage.setItem(storageKey(KEY), JSON.stringify(made));
    return made;
  } catch {
    // Storage is unavailable (a private window, blocked site data).
    fallback = { id: newId(), name: '' };
    return fallback;
  }
}

/** Go by another name from now on. Returns the name as it was kept. */
export function setName(name: string): string {
  const who = { ...identity(), name: cleanName(name) };
  if (fallback) fallback = who;
  try {
    localStorage.setItem(storageKey(KEY), JSON.stringify(who));
  } catch {
    fallback = who;
  }
  return who.name;
}
