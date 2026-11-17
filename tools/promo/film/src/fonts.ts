import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

/** The game's four typefaces, from the files the game itself ships (setup.mjs copies them into public/fonts). */
export const fonts = Promise.all([
  loadFont({ family: 'Fraunces', url: staticFile('fonts/fraunces-latin-full-normal.woff2'), weight: '100 900' }),
  loadFont({ family: 'Fraunces', url: staticFile('fonts/fraunces-latin-full-italic.woff2'), weight: '100 900', style: 'italic' }),
  loadFont({ family: 'Archivo', url: staticFile('fonts/archivo-latin-wdth-normal.woff2'), weight: '100 900', stretch: '62% 125%' }),
  loadFont({ family: 'Figtree', url: staticFile('fonts/figtree-latin-wght-normal.woff2'), weight: '300 900' }),
  loadFont({ family: 'DM Mono', url: staticFile('fonts/dm-mono-latin-500-normal.woff2'), weight: '500' }),
]);
