/**
 * The six stones as flat silhouettes of the turned Staunton pieces, drawn by hand as paths in a
 * 32 by 32 box and filled by the even-odd rule. The parts stand a hair apart where the pieces have
 * their grooves of light, and the eye of each piece that shows one from the front is cut through.
 * They are kept apart from the rest of the interface's drawings because the board uses them too,
 * for the medallions on the stones in the Top view.
 */
import type { Kind } from '../core/game';

export const STONES: Record<Kind, string> = {
  p: 'M16 4.4a4.6 4.6 0 1 1 0 9.2a4.6 4.6 0 0 1 0-9.2z M11.2 14.6h9.6v2h-9.6z M13.6 16.6h4.8q.2 5 3.6 8H10q3.4-3 3.6-8z M8.4 28v-2.2l1.3-1.2h12.6l1.3 1.2V28z',
  r: 'M11.2 10.2l-.8-2.6V3.6H13v2.2h2V3.6h2v2.2h2V3.6h2.6v4l-.8 2.6z M15.4 6.6h1.2v2.4h-1.2z M11.4 10.8h9.2v1.8h-9.2z M12.6 12.6h6.8l.4 6.2q.2 3.9 2.4 5.8H9.8q2.2-1.9 2.4-5.8z M8 28v-2.2l1.3-1.2h13.4l1.3 1.2V28z',
  n: 'M12.6 22.4 11.5 20.8V19.3l.7-1.5 1.1-1.1.6-1.1-2.2-.2-1.8-.3-.6-1 .2-1.5.6-.7 5.2-4.5 1.4-1.3.1-3.1h.6l1.1 2.6.5.3 2.2 3.1-.4.9 1.6 3-.6.3.8 2.8-.8.4.4 2.3-.8.6-.2.9-1 2.2z M14.9 9.2l.7-1.2 1.3-.5-.7 1.2z M10.2 23h11.6l.6 1.6H9.6z M8 28v-2.2l1.3-1.2h13.4l1.3 1.2V28z',
  b: 'M16 2.9a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 0 1 0-3.4z M16 7c3.4 2.8 5.4 5.8 5.4 8.6c0 1.4-.6 2.4-1.4 3h-8c-.8-.6-1.4-1.6-1.4-3c0-2.8 2-5.8 5.4-8.6z M14.8 9.4l-1.3 1 4.6 5.2 1.3-1z M11.6 19.2h8.8v1.6h-8.8z M13.6 20.8h4.8q.2 2.6 2.8 3.8H10.8q2.6-1.2 2.8-3.8z M8.2 28v-2.2l1.3-1.2h13l1.3 1.2V28z',
  q: 'M16 2.8a1.6 1.6 0 1 1 0 3.2a1.6 1.6 0 0 1 0-3.2z M9.4 7.4l1.8 1.6 1.6-2 1.6 2 1.6-2 1.6 2 1.6-2 1.6 2 1.8-1.6-1.6 7.2h-9.6z M16 10.7a.9.9 0 1 1 0 1.8a.9.9 0 0 1 0-1.8z M11.2 15.2h9.6v1.6h-9.6z M13.8 16.8h4.4q.2 5 2.8 7.8H11q2.6-2.8 2.8-7.8z M8 28v-2.2l1.3-1.2h13.4l1.3 1.2V28z',
  k: 'M15 1.6h2l-.3 2h2.2v2h-2.2l.3 1.8h-2l.3-1.8h-2.2v-2h2.2z M9.6 8h12.8l-.6 1.2-2.4 5.2h-6.8l-2.4-5.2z M16 9.8l.8 1.5-.8 1.5-.8-1.5z M11.4 15h9.2v1.4h-9.2z M12.2 16.8h7.6v1.2h-7.6z M13.4 18h5.2q.3 4.4 3.2 6.6H10.2q2.9-2.2 3.2-6.6z M7.6 28v-2.2l1.4-1.2h14l1.4 1.2V28z',
};
