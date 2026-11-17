import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/fraunces/full-italic.css';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/figtree/wght.css';
import '@fontsource/dm-mono/latin-400';
import '@fontsource/dm-mono/latin-500';
import './ui/hud.css';
import './ui/panels.css';

import { render } from 'preact';
import { App } from './app/app';
import { BRAND } from './app/brand';
import { ui } from './app/store';
import { Hud } from './ui/Hud';
import { arrived, reached } from './net/visits';
import { showUnavailable } from './ui/Unavailable';
import frauncesFile from '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2?url';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;

document.title = BRAND.name;

// The title is set in Fraunces. Ask for its file now, and keep the loading screen's name unwritten
// until it is here, so that the name is never seen in a stand-in serif first.
const preload = document.createElement('link');
preload.rel = 'preload';
preload.as = 'font';
preload.type = 'font/woff2';
preload.crossOrigin = 'anonymous';
preload.href = frauncesFile;
document.head.append(preload);
const root = document.documentElement;
root.dataset.fonts = 'waiting';
const fontsHere = () => delete root.dataset.fonts;
void Promise.race([document.fonts.load("900 36px 'Fraunces Variable'"), new Promise((done) => setTimeout(done, 2500))]).then(fontsHere, fontsHere);

function start(): App | null {
  try {
    const started = new App(canvas);
    render(<Hud app={started} />, hud);
    return started;
  } catch (error) {
    // Most often there is no WebGL to draw the room with. Say so rather than leave a black page.
    console.error(error);
    fontsHere();
    showUnavailable(canvas, hud);
    return null;
  }
}

arrived();
const app = start();
reached(app ? 'drawn' : 'undrawable');

// A handle for development and automated checks. Not part of the game's interface, and not in the build.
if (import.meta.env.DEV && app !== null) {
  const handle: Record<string, unknown> = { app, ui };
  // The sound engine, so that it can be rendered offline and measured without speakers.
  void import('./audio/sound').then(({ Sound }) => (handle.Sound = Sound));
  void import('./audio/bank').then(({ fetchBank, decodeBank }) => Object.assign(handle, { fetchBank, decodeBank }));
  (window as unknown as Record<string, unknown>)[`__${BRAND.id}`] = handle;
  void import('./dev/capture').then(({ shot }) => {
    handle.shot = (name: string, quality?: number) => shot(app, name, quality);
  });
}
