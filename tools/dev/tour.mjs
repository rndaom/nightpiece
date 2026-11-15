/**
 * Development only. A fixed tour of the game, saved as frames, so that a change can be looked
 * at the same way every time:
 *
 *   node tools/dev/tour.mjs [folder] [width height]
 *
 * Frames go to tmp/look/<folder>/ (not kept in git). See look.mjs for what it needs.
 */
import { launch } from './look.mjs';

const folder = process.argv[2] ?? 'tour';
const width = Number(process.argv[3] ?? 1920);
const height = Number(process.argv[4] ?? 1080);
const g = await launch({ out: `tmp/look/${folder}`, width, height });
await g.hold();
await g.advance(2.0);
await g.shot('00-opening');

// A table game from each camera.
await g.ev(`app.setAid('warn', false); app.startTable();`);
await g.advance(3.0);
for (const camera of ['top', 'side', 'shoulder', 'eyes', 'orbit']) {
  await g.ev(`app.setCamera(args[0]);`, camera);
  await g.advance(2.2);
  await g.shot(`01-${camera}`);
}

// A piece chosen, then carried.
await g.ev(`app.setCamera('shoulder');`);
await g.advance(2.0);
await g.click('e2');
await g.advance(1.0);
await g.shot('02-chosen');
await g.click('e4');
await g.advance(0.9);
await g.shot('03-carry');
await g.advance(3.0);

// A capture and a check: 1.e4 d5 2.exd5 Qxd5 3.Nc3 Qe5+
await g.ev(`app.setCamera('side');`);
await g.move('d7', 'd5');
await g.click('e4');
await g.advance(0.6);
await g.shot('04-capture-offered');
await g.click('d5');
await g.advance(1.4);
await g.shot('05-capture');
await g.advance(3.0);
await g.shot('06-after-capture');
await g.move('d8', 'd5');
await g.move('b1', 'c3');
await g.click('d5');
await g.advance(0.3);
await g.click('e5');
await g.advance(2.2);
await g.shot('07-check');
await g.advance(2.5);
await g.shot('08-check-settled');

await g.ev(`ui.settingsOpen.value = true;`);
await g.advance(0.3);
await g.shot('09-settings');
await g.ev(`ui.settingsOpen.value = false;`);

// Fool's mate.
await g.ev(`app.startTable();`);
await g.advance(1.5);
await g.ev(`app.setCamera('side');`);
await g.move('f2', 'f3');
await g.move('e7', 'e5');
await g.move('g2', 'g4');
await g.click('d8');
await g.advance(0.3);
await g.click('h4');
await g.advance(2.4);
await g.shot('10-mate-struck');
await g.advance(2.5);
await g.shot('11-mate');
await g.advance(4.0);
await g.shot('12-mate-card');

await g.ev(`app.startLessons();`);
await g.advance(3.0);
await g.shot('13-lesson');

await g.ev(`ui.menuOpen.value = true;`);
await g.advance(0.5);
await g.shot('14-menu');

await g.close();
console.log(`tmp/look/${folder}`);
