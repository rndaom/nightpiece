/**
 * Development only. Looking for camera positions: single frames of a scene, without motion
 * blur, from any number of cameras at any number of moments, and a list of what happened when.
 *
 *   node tools/promo/scout.mjs <scene> <cameras.mjs> <seconds,seconds,...> [the rig's options]
 *
 * <cameras.mjs> exports `cams`, an object of camera functions like a shot's (see lib.mjs, `film`),
 * and may export `cues` to replace the scene's own, and `hud`, `hudRate`, `layout` and `css` as a shot
 * that shows the interface has them. Frames go to <out>/_scout/<scene>/<camera>_<seconds>.jpg.
 * Needs the dev server (npm run dev).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { open, options } from './lib.mjs';
import { reach, SCENES } from './scenes.mjs';

const o = options();
const [sceneName, camsFile, timesText] = o.only;
const scene = SCENES[sceneName];
if (!scene || !camsFile || !timesText) throw new Error('usage: scout.mjs <scene> <cameras.mjs> <seconds,...>');
const module = await import(pathToFileURL(path.resolve(camsFile)).href);
const cams = module.cams;
const times = timesText.split(',').map(Number).sort((a, b) => a - b);
const dir = path.join(o.out, '_scout', sceneName);
mkdirSync(dir, { recursive: true });

const g = await open(o, { hud: !!module.hud, css: module.css ?? '', layout: module.layout });
console.log(g.info);
await reach(g, scene, module.settle, module.hud ? (module.hudRate ?? null) : null);
// `probe` is a snippet whose answer is printed: for finding out where things in the room are.
if (module.probe) console.log(JSON.stringify(await g.run(module.probe)));
const lead = 1;
await g.run(`P.t = args[0]; P.log = []; P.cues = args[1].slice().sort((a, b) => a.t - b.t); P.listen();`, -lead, module.cues ?? scene.cues);
let now = -lead;
for (const t of times) {
  await g.run(`await P.advance(args[0], 1 / 60);`, t - now);
  now = t;
  for (const [name, fn] of Object.entries(cams)) {
    await g.run(`P.cameraFn = new Function('return (' + args[0] + ')')(); P.dt = 0; app.rig.update(0, app.world.framingAspect); app.redraw(); P.cameraFn = null;`, fn.toString());
    await g.page.screenshot({ path: path.join(dir, `${name}_${t.toFixed(2)}.jpg`), type: 'jpeg', quality: 90, captureBeyondViewport: false });
  }
}
const log = await g.run(`return P.log.filter((e) => e.depth === 0 && e.method !== 'listen' && e.method !== 'update').map((e) => [Math.round(e.t * 1000) / 1000, e.source, e.method, JSON.stringify(e.args)].join(' '));`);
writeFileSync(path.join(dir, 'log.txt'), log.join('\n'));
console.log(log.join('\n'));
await g.close();
console.log(dir);
