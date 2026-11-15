/**
 * Every drawing the interface uses: the six stones as flat silhouettes (their
 * outlines are in stones.ts, which the board shares), the game's emblem, and
 * the icons on the buttons. All of it is drawn by hand, as paths; nothing is
 * taken from an icon set or a font.
 */
import type { Kind } from '../core/game';
import { STONES } from './stones';

/** A stone, filled with the current text colour. */
export function Stone({ kind, title }: { kind: Kind; title?: string }) {
  return (
    <svg class="stone" viewBox="0 0 32 32" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      <path d={STONES[kind]} fill="currentColor" fill-rule="evenodd" />
    </svg>
  );
}

/**
 * The emblem: a pawn whose head is a crescent moon. A piece, and the night. It is drawn in a
 * 48 by 48 box and takes the current text colour.
 */
export function Emblem({ title }: { title?: string }) {
  return (
    <svg class="emblem" viewBox="0 0 48 48" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      <path
        fill="currentColor"
        d="M31.9 16.1A8.8 8.8 0 1 1 23.2 4.4A7.1 7.1 0 1 0 31.9 16.1z M17.2 22.6h13.6v2.8H17.2z M20.4 26.4h7.2l3.8 10.8H16.6z M12.6 38.4h22.8v4.2H12.6z"
      />
    </svg>
  );
}

/**
 * The seal from the title screen, struck as a coin with two faces: the emblem on the front, and
 * on the back a king's coin, Ivory's, Void's, or half of each. Turned, it shows its back. Its
 * size is the `--seal` of whatever holds it (hud.css, `.seal-coin`).
 */
export function Seal({ back, turned = false }: { back: 'w' | 'b' | 'either'; turned?: boolean }) {
  return (
    <span class={`seal-coin ${turned ? 'seal-turned' : ''}`} aria-hidden="true">
      <span class="seal-face seal-front">
        <Emblem />
      </span>
      <span class={`seal-face seal-back coin coin-${back}`}>
        <Stone kind="k" />
      </span>
    </span>
  );
}

export type IconName =
  | 'hint'
  | 'back'
  | 'flip'
  | 'menu'
  | 'settings'
  | 'sound'
  | 'mute'
  | 'top'
  | 'side'
  | 'shoulder'
  | 'eyes'
  | 'orbit'
  | 'close'
  | 'arrow'
  | 'link'
  | 'book'
  | 'engine'
  | 'two'
  | 'check'
  | 'resign'
  | 'draw'
  | 'review'
  | 'play'
  | 'first'
  | 'prev'
  | 'next'
  | 'last'
  | 'copy'
  | 'take'
  | 'match'
  | 'ranks'
  | 'clock';

/** Line icons in a 24 by 24 box: square ends, mitred corners, one weight. */
const ICONS: Record<IconName, string> = {
  // A candle flame over its wick: light on the way forward.
  hint: 'M12 2.8c3.2 3.6 5 6.2 5 9.2a5 5 0 0 1-10 0c0-3 1.8-5.6 5-9.2z M12 12.4v4.6 M8.5 21h7',
  back: 'M9.5 5.5L4 11l5.5 5.5 M4.5 11H15a4.5 4.5 0 0 1 0 9h-4.5',
  flip: 'M4 8.5h15 M15.5 4.5l4 4-4 4 M20 15.5H5 M8.5 11.5l-4 4 4 4',
  menu: 'M4 6.5h16 M4 12h16 M4 17.5h16',
  settings: 'M4 7h9 M17 7h3 M13 4.5v5h4v-5z M4 17h3 M11 17h9 M7 14.5v5h4v-5z',
  sound: 'M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z M15.5 9a4.2 4.2 0 0 1 0 6 M18 6.5a7.7 7.7 0 0 1 0 11',
  mute: 'M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z M15.5 9.5l5 5 M20.5 9.5l-5 5',
  // The board from straight above.
  top: 'M4.5 4.5h15v15h-15z M12 4.5v15 M4.5 12h15',
  // The board edge-on, a stone at each end.
  side: 'M3 17.5h18 M5.5 17.5v-5h3v5 M15.5 17.5v-7h3v7',
  // Over a player's shoulder.
  shoulder: 'M9 8.5a3 3 0 1 0 6 0a3 3 0 0 0-6 0z M4.5 20c0-4.2 3.3-6.5 7.5-6.5s7.5 2.3 7.5 6.5',
  eyes: 'M2.5 12c2.6-4 5.8-6 9.5-6s6.9 2 9.5 6c-2.6 4-5.8 6-9.5 6s-6.9-2-9.5-6z M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 0 0-5 0z',
  orbit: 'M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z M3.2 14.5c-1.2-2.8 2.2-6.3 7.6-7.9s10.6-.6 11.8 2.2-2.2 6.3-7.6 7.9c-2.4.7-4.8.9-6.8.6 M6.5 14.5l1.7 2.8-3.2 1',
  close: 'M6 6l12 12 M18 6L6 18',
  arrow: 'M5 12h13 M13 6.5l5.5 5.5-5.5 5.5',
  link: 'M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2 M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2',
  book: 'M12 6.5C10 5 7 4.5 4 5v13.5c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z M12 6.5V20',
  engine: 'M7 7h10v10H7z M10 10h4v4h-4z M9.5 3.5V7 M14.5 3.5V7 M9.5 17v3.5 M14.5 17v3.5 M3.5 9.5H7 M3.5 14.5H7 M17 9.5h3.5 M17 14.5h3.5',
  two: 'M8 5.5a2.7 2.7 0 1 0 0 5.4a2.7 2.7 0 0 0 0-5.4z M16 5.5a2.7 2.7 0 1 0 0 5.4a2.7 2.7 0 0 0 0-5.4z M2.8 19c0-3.2 2.3-5 5.2-5s5.2 1.8 5.2 5 M13.8 14.3c.7-.2 1.4-.3 2.2-.3 2.9 0 5.2 1.8 5.2 5',
  check: 'M4.5 12.5l5 5L19.5 7',
  resign: 'M6 21V4 M6 5h12l-3 4 3 4H6',
  draw: 'M5 9h14 M5 15h14',
  review: 'M4 12a8 8 0 1 0 2.6-5.9 M4 4.5V9h4.5 M12 8v4.5l3 2',
  play: 'M7.5 5v14l11.5-7z',
  // Stepping through the record: to its start, back one, on one, to its end.
  first: 'M6.5 5.5v13 M18 6l-7.5 6 7.5 6z',
  prev: 'M15 5.5L8 12l7 6.5',
  next: 'M9 5.5l7 6.5-7 6.5',
  last: 'M17.5 5.5v13 M6 6l7.5 6L6 18z',
  // One sheet lying over another.
  copy: 'M9 8.5h10.5v12H9z M15 8.5v-5H4.5v12H9',
  // One stone taking another: a square stood on its corner, and the way in.
  take: 'M12 2.5l9.5 9.5-9.5 9.5L2.5 12z M7.5 12h8 M12.5 8.5l3.5 3.5-3.5 3.5',
  // Two blades crossed: a game against whoever comes.
  match: 'M5 4.5l13.5 13.5 M19 4.5L5.5 18 M3.5 15l5.5 5.5 M20.5 15L15 20.5',
  // Three steps, the middle one highest.
  ranks: 'M3 20.5h18 M4.5 20.5v-6h5v6 M9.5 20.5v-11h5v11 M14.5 20.5v-8h5v8',
  // A clock face with its two hands, and the button on top.
  clock: 'M12 5.5a7.5 7.5 0 1 0 0 15a7.5 7.5 0 0 0 0-15z M12 9v4l2.8 1.8 M10 2.5h4 M12 2.5v3',
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="square" stroke-linejoin="miter" />
    </svg>
  );
}
