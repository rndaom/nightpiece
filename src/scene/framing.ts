/**
 * How the picture is shared between the board and a card docked at the foot of a narrow screen
 * (see World.keepClearBetween). Pure arithmetic, so that it can be tested by itself.
 */

/** The most of the picture's height that the card and the interface above the board may take between them. */
export const CLEAR_MOST = 0.62;

/**
 * The shares of the picture's height to keep clear below the board and above it, for a card
 * that takes `below` pixels at the foot and an interface that takes `above` pixels at the head.
 * Nothing on a screen as short as a phone on its side (`tallest` pixels or less), which has its
 * columns instead, or when no card is docked.
 */
export function dockedShares(height: number, below: number, above: number, tallest: number): [number, number] {
  if (height <= tallest || below <= 0) return [0, 0];
  const foot = Math.min(CLEAR_MOST, below / height);
  const head = Math.min(CLEAR_MOST - foot, Math.max(0, above) / height);
  return [foot, head];
}
