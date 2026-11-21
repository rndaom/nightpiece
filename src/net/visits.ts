/**
 * How many visits reach each step of the game, counted on the server, so that it can be seen
 * where people stop: how many came, how many saw the board, how many began a game, finished one,
 * stayed a while, came back another day.
 *
 * Only the name of the step is sent, and at most once a page load. Nothing about the visitor is
 * kept: no address, no cookie, no name. The server adds each to a count for the day, and that is all.
 *
 * A link to the game may say where it was posted (`?from=forum`), and a visit that comes by it is
 * counted under that word, so that it can be seen which places send people. The word is the
 * link's, the same for everyone who follows it, and says nothing of who they are.
 *
 * A browser that says it is driven by a program counts nothing: link checkers and crawlers open
 * the page many times a day, and are not visitors.
 */
import { apiUrl } from './where';

/** The steps a page counts. The server takes no others. */
export const PAGE_STEPS = [
  /** The page was opened. */
  'open',
  /** For the first time in this browser. */
  'new',
  /** By a browser that was here on an earlier day. */
  'back',
  /** The room was drawn. */
  'drawn',
  /** It could not be: the browser cannot draw it. */
  'undrawable',
  /** A game against the computer was begun. */
  'computer',
  /** A game with a friend was opened, or joined by its link. */
  'friend',
  /** A game for two at one screen was begun. */
  'table',
  /** A lesson was begun. */
  'lesson',
  /** A ranked match was looked for. */
  'match',
  /** A move was made, in any game. */
  'moved',
  /** Ten moves were made, in any games. */
  'moves10',
  /** A game came to an end with the player still at it. */
  'finished',
  /** The page was in sight for a minute, five minutes, a quarter of an hour, all told. */
  'stay1m',
  'stay5m',
  'stay15m',
] as const;

export type PageStep = (typeof PAGE_STEPS)[number];

/** Steps the server counts for itself. */
export const SERVER_STEPS = ['queued', 'matched', 'rated', 'calledoff', 'friendgame'] as const;
export type ServerStep = (typeof SERVER_STEPS)[number];

/** The word a link may carry to say where it was posted: a few small letters and digits. */
export const FROM_WORD = /^[a-z0-9]{1,16}$/;
/** What a visit by such a link is counted under: 'from:forum'. */
export const FROM_STEP = /^from:[a-z0-9]{1,16}$/;

const sent = new Set<string>();

/** Say that this page has reached a step. Once is enough: a step said again is not sent. */
export function reached(step: PageStep): void {
  say(step);
}

function say(step: string): void {
  if (sent.has(step)) return;
  sent.add(step);
  try {
    if (typeof navigator !== 'undefined' && navigator.webdriver) return;
  } catch {
    // Not to be asked: counted like any other.
  }
  let url: string;
  try {
    url = apiUrl('/api/event');
  } catch {
    return;
  }
  // A beacon goes even as the page closes. Where there is none, an ordinary request that may outlive the page.
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url, step)) return;
  } catch {
    // Refused: the request below.
  }
  try {
    void fetch(url, { method: 'POST', body: step, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {});
  } catch {
    // Not counted, and nothing else changes.
  }
}

const SEEN = 'nightpiece.seen';

/**
 * Count where the link that brought this visit was posted, if it says, and take the word out of
 * the page's address: an invitation copied from the address afterwards must not carry it to a
 * friend, who did not come from there.
 */
function cameFrom(): void {
  try {
    const url = new URL(location.href);
    const word = url.searchParams.get('from');
    if (word === null) return;
    if (FROM_WORD.test(word)) say(`from:${word}`);
    url.searchParams.delete('from');
    history.replaceState(null, '', url);
  } catch {
    // No address to read, or none that may be changed: nothing is counted.
  }
}

/** Count the visit: opened, and whether this browser is new here or back on another day. Then the minutes it stays in sight. */
export function arrived(): void {
  reached('open');
  cameFrom();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const last = localStorage.getItem(SEEN);
    if (last === null) reached('new');
    else if (last !== today) reached('back');
    localStorage.setItem(SEEN, today);
  } catch {
    // A browser that keeps nothing is neither new nor back.
  }
  let inSight = 0;
  const every = 5;
  const timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    inSight += every;
    if (inSight >= 60) reached('stay1m');
    if (inSight >= 5 * 60) reached('stay5m');
    if (inSight >= 15 * 60) {
      reached('stay15m');
      clearInterval(timer);
    }
  }, every * 1000);
}
