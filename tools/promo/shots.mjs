/**
 * Development only. The shots the promotional films are cut from, and the script that films them.
 *
 *   node tools/promo/shots.mjs [shot ...] [options]
 *
 *   node tools/promo/shots.mjs                                  every shot, 3840 x 2160 PNG, into tmp/promo/shots/<shot>/
 *   node tools/promo/shots.mjs open mate                        only these
 *   node tools/promo/shots.mjs --url http://127.0.0.1:5174/     against another dev server (5173 unless told)
 *   node tools/promo/shots.mjs open --draft                     a quick look, small, under tmp/promo/shots/_draft/
 *   node tools/promo/shots.mjs mate --frames 90,120             only these frames of a shot
 *   node tools/promo/shots.mjs --list                           what there is
 *
 * The options are the rig's (lib.mjs, `options`). Needs the dev server running (npm run dev) and
 * a Chromium; nothing opens on screen. Each shot is a folder of frame_00000.png onward at 60 a
 * second, with events.json (every call to the game's sound, by frame, and what the game did),
 * camera.json (where the camera was at each frame) and sheet.jpg (every sixth frame).
 *
 * A shot films a scene (scenes.mjs) from a camera of its own, in a page of its own, with the engine
 * kept out and the game held in the same state (`HELD`), so a shot comes out the same every time it
 * is filmed and a draft is the final, small; only what the hands do of their own accord (a knuckle
 * cracked, a finger drummed) may fall a few frames sooner or later in one than in the other. The
 * films are cut to their music, which goes at 110 beats a minute: most shots are a bar (`BAR`) or
 * two long, some filmed fast (`take`), and each is filmed twelve frames longer at each end than a
 * cut uses (film/src/timeline.ts). Six shots show the game as it is played, with the interface up
 * and the game's own camera.
 */
import { film, open, options } from './lib.mjs';
import { reach, SCENES } from './scenes.mjs';

/**
 * The state the game is held in before every take (lib.mjs, `--clock`, `--aged`): its own clock,
 * which the resting hands' drift, the flames, the dust and the light go by, and how many
 * sixtieths of a second the hands have been in the room.
 */
export const HELD = { clock: 2, aged: 60 };

/** One bar of the film's music, in seconds: four beats at 110 a minute. */
export const BAR = 240 / 110;

/** A shot's part of its scene: used from second `at` for `seconds`, and filmed a fifth of a second more at each end. */
const span = (at, seconds) => ({ from: at - 0.2, to: at + seconds + 0.2, cut: [at, at + seconds] });

/**
 * A shot's part of its scene where the film is cut to the frame: `frames` of film from second `at` of the scene, at
 * `speed` seconds of the scene to a second of film, and twelve frames more at each end.
 */
const take = (at, frames, speed = 1) => ({ from: at - 0.2 * speed, to: at + (frames / 60 + 0.2) * speed, cut: [at, at + (frames / 60) * speed], speed });

/** For the shots that show the interface: the record of moves is left out, so the corner is free for what the film writes there. */
const QUIET = '.record { display: none !important; }';

/** The same, and the row of buttons along the bottom left out too. */
const BARE = '.record, .bar { display: none !important; }';

/** The game's own camera, where the game has it: for the shots that show the interface. */
const own = (t, H) => {
  const o = H.own();
  return { pos: o.pos, target: H.add(o.pos, H.scale(o.forward, 10)), fov: o.fov, lens: 'own', thud: 0 };
};

/**
 * Where things are (one unit is a square; Ivory sits at +z, the a-file is at -x; the board's
 * middle is the origin, and a king is 1.7 tall). The altar's top is a unit below the board and
 * the floor three; a candle stands at each corner, 5.6 out; a resting hand is near (±5, 1.8, ±5.9).
 */
export const SHOTS = [
  // -- before the music: the case and the stones --------------------------------------------------
  {
    name: 'case',
    about: 'The case shut on the altar in the shaft of light, from Ivory\'s end: the clasp goes, and the lid swings up and over, toward the lens, until it is all there is to see.',
    scene: 'unpack',
    settle: 2,
    ...span(-1.0, 2.45),
    camera: (t, H) => {
      const u = H.sine(H.seg(t, -1.4, 1.8));
      return { pos: H.mix3([5.7, 2.9, 9.7], [5.1, 2.55, 8.9], u), target: [0, 0.4, 1.0], fov: 34, focus: H.mix(11.2, 10.2, u), range: 6, amount: 0.008 };
    },
  },
  {
    name: 'stones',
    about: 'From high over a corner: the lid comes down, the drawers slide out, and the stones go up out of them and come down on their squares, pawns first and the kings last.',
    scene: 'unpack',
    settle: 2,
    ...span(1.45, 3.3),
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 1.1, 5.2));
      const pos = H.orbit([0, 0.4, 0], 0.66 - 0.16 * u, 0.44 - 0.05 * u, 13.8 - 1.2 * u);
      return { pos, target: [0, 0.5, 0], fov: 37, focus: 13.2 - 1.2 * u, range: 9, amount: 0.006 };
    },
  },

  // -- a whole game: Morphy at the opera, Paris 1858 (scenes.mjs, OPERA) ---------------------------
  {
    name: 'open',
    about: 'The whole table from over the side of the board, Ivory to the left and Void to the right, going round: the first moves of a game, a pawn out on each side and a knight.',
    scene: 'opera',
    ...take(0.9, 262, 1.6),
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 0.4, 8.4));
      return { pos: H.orbit([0, 0.4, 0], 1.36 - 0.2 * u, 0.42, 13.6 - 0.9 * u), target: [0, 0.5, 0], fov: 34, focus: 12.9 - 0.9 * u, range: 8, amount: 0.006 };
    },
  },
  {
    name: 'trade',
    about: 'As the player sees it from the shoulder, with the interface up: four captures in the middle of the board, each answering the last.',
    scene: 'opera',
    hud: true,
    layout: [1280, 720],
    css: BARE,
    cuts: false,
    cues: [{ t: 10, name: 'the shoulder', js: `app.setCamera('shoulder');` }],
    ...take(14.25, 262, 2.7),
    camera: own,
  },
  {
    name: 'develop',
    about: 'From high over Void\'s right hand: both sides bring their stones out, six moves gone by quickly.',
    scene: 'opera',
    ...take(31.2, 262, 3.2),
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 30.4, 46.2));
      return { pos: H.orbit([0, 0.4, 0], 1.98 - 0.24 * u, 0.5 - 0.04 * u, 12.6 - 0.5 * u), target: [0, 0.3, 0], fov: 34, focus: 12 - 0.5 * u, range: 8, amount: 0.006 };
    },
  },
  {
    name: 'gambit',
    about: 'From over the side of the board, Ivory to the left and Void to the right: a knight is given up for a pawn, the pawn takes it, and the bishop takes the pawn with check; the room turns.',
    scene: 'opera',
    ...take(45.49, 328, 1.91),
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 45.0, 56.4));
      return { pos: H.orbit([-1, 0.4, -1.5], 1.32 - 0.14 * u, 0.43 - 0.02 * u, 10.9 - 0.7 * u), target: [-1, 0.5, -1.5], fov: 34, focusAt: [-1, 0.6, -1.5], range: 5, amount: 0.008 };
    },
  },
  {
    name: 'fear',
    about: 'Void\'s king, close, in check: its eye is a slit, and it trembles.',
    scene: 'opera',
    ...take(55.0, 66, 1),
    camera: (t, H) => {
      const u = H.seg(t, 54.6, 56.5);
      return { pos: H.mix3([-0.7, 1.4, -1.45], [-0.55, 1.38, -1.65], u), target: [0.5, 1.28, -3.5], fov: 27, focusAt: [0.5, 1.2, -3.5], range: 1.0, amount: 0.016 };
    },
  },
  {
    name: 'long',
    about: 'Castling on the queen\'s side, seen from over Void\'s stones: two hands at once, the king over and the rook round it.',
    scene: 'opera',
    ...take(58.49, 197, 1),
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 58.0, 62.2));
      return { pos: H.mix3([0.5, 4.3, -3.3], [0.2, 4.0, -2.8], u), target: [-1.4, 0.3, 3.0], fov: 36, focusAt: [-1.5, 0.6, 3.5], range: 4, amount: 0.008 };
    },
  },
  {
    name: 'file',
    about: 'From over the side of the board: a rook goes up the queen\'s file and takes on the seventh rank, and a rook takes it back.',
    scene: 'opera',
    ...take(63.85, 118, 2.75),
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 63.2, 69.8));
      return { pos: H.orbit([-0.5, 0.4, -1.0], -1.56 + 0.12 * u, 0.5, 9.8 - 0.5 * u), target: [-0.5, 0.5, -1.0], fov: 34, focusAt: [-0.5, 0.5, -2.5], range: 5, amount: 0.008 };
    },
  },
  {
    name: 'queen',
    about: 'Ivory\'s queen is carried the length of the board and set down on the last rank, giving herself up with check; the knight has to take her.',
    scene: 'opera',
    ...take(79.98, 236, 1.4),
    fine: [[81.3, 82.0, 32]],
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 79.5, 86.0));
      return { pos: H.mix3([-5.1, 1.95, 1.1], [-4.6, 1.75, 0.7], u), target: [-1.3, 0.9, -3.3], fov: 34, focusAt: [-2.5, 0.9, -3.5], range: 2.4, amount: 0.012 };
    },
  },
  {
    name: 'rook',
    about: 'From behind Void\'s king: the rook comes down the open file and is set beside it. Mate, and the light stands up over the king.',
    scene: 'opera',
    ...take(85.48, 170, 1.4),
    fine: [[87.5, 88.2, 32]],
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 85.0, 90.0));
      return { pos: H.mix3([3.3, 1.7, -6.1], [2.9, 1.55, -5.7], u), target: [-0.3, 1.0, -3.0], fov: 32, focusAt: [0.5, 1.1, -3.5], range: 2.4, amount: 0.012 };
    },
  },
  {
    name: 'light',
    about: 'Mate, from far back at Ivory\'s end: the pillar of light over the board, all four hands, the room gone over to the winner. The lens rises and draws back.',
    scene: 'opera',
    ...take(89.45, 540, 1),
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 89.0, 99.0));
      return { pos: H.mix3([0.3, 1.7, 12.8], [0.2, 2.6, 15.6], u), target: H.mix3([0.2, 2.2, 0], [0.15, 2.9, 0], u), fov: 33, focus: H.mix(13.5, 16.5, u), range: 7, amount: 0.008 };
    },
  },

  // -- the game's own cameras ---------------------------------------------------------------------
  {
    name: 'views',
    about: 'One game through four of the game\'s five cameras, with the interface up: from the shoulder, round to the side, up to the plan view, and down to the eyes.',
    scene: 'views',
    hud: true,
    layout: [1280, 720],
    css: QUIET,
    cuts: false,
    ...take(0, 262, 1.6),
    camera: own,
  },



  // -- the ways to play, with the interface up ----------------------------------------------------
  {
    name: 'friend',
    about: 'A game across the board from a friend, as the player sees it from the eyes: the other hand answers the first move.',
    scene: 'friend',
    hud: true,
    layout: [1280, 720],
    css: QUIET,
    ...span(0.2, 2 * BAR),
    camera: own,
  },
  {
    name: 'ranked',
    about: 'A ranked match begins: the two players come to the board with their names and ratings, the terms between them, and the side called out; the clocks start.',
    scene: 'ranked',
    hud: true,
    layout: [1280, 720],
    css: QUIET,
    ...span(0.15, 2 * BAR),
    camera: own,
  },
  {
    name: 'computer',
    about: 'A game against the computer, in the view from above with the stones drawn as coins: the computer\'s hand brings a knight out.',
    scene: 'computer',
    hud: true,
    layout: [1280, 720],
    css: QUIET,
    ...span(0.2, 2 * BAR),
    camera: own,
  },
  {
    name: 'lesson',
    about: 'The sixth of the twelve lessons, the knight: the card that says what to do, and the hand shown where to go.',
    scene: 'lesson',
    hud: true,
    layout: [1280, 720],
    css: QUIET,
    ...span(0.1, 2 * BAR),
    camera: own,
  },

  // -- the end of another game --------------------------------------------------------------------
  {
    name: 'sacrifice',
    about: 'Ivory\'s queen is carried across the board and set down beside Void\'s rook, giving herself up with check. From Ivory\'s side, Void\'s hands and window beyond.',
    scene: 'mate',
    ...span(1.24, 2 * BAR),
    fine: [[3.2, 3.9, 32]],
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 0.8, 6.0));
      return { pos: H.mix3([6.1, 1.65, 3.7], [5.4, 1.45, 3.0], u), target: [2.6, 1.0, -1.6], fov: 34, focusAt: [3.5, 1, -0.5], range: 2.6, amount: 0.012 };
    },
  },
  {
    name: 'takes',
    about: 'Void\'s rook has to take her: one hand lifts the queen away, the other sets the rook where she stood. From behind the rook, down its file, Ivory\'s window beyond.',
    scene: 'mate',
    ...span(1.24 + 2 * BAR, 2 * BAR),
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 5.2, 10.4));
      return { pos: H.mix3([3.0, 1.45, -6.4], [3.4, 1.3, -5.8], u), target: [3.1, 1.0, -0.5], fov: 32, focusAt: [3.5, 1, -0.5], range: 2.4, amount: 0.012 };
    },
  },
  {
    name: 'mate',
    about: 'The bishop is carried in and set down: mate. Void\'s king close in front, the bishop arriving behind it, and the room going over to the end.',
    scene: 'mate',
    ...span(1.24 + 4 * BAR, 2 * BAR),
    fine: [[11.9, 12.8, 32]],
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 9.5, 14.8));
      return { pos: H.mix3([-1.9, 1.5, -5.4], [-1.2, 1.35, -5.9], u), target: [1.6, 1.1, -2.2], fov: 33, focusAt: [0.5, 1.2, -3.5], range: 2.6, amount: 0.012 };
    },
  },
  {
    name: 'pillar',
    about: 'Mate, from far back at Ivory\'s end: the pillar of light standing over the board, all four hands, the room gone over to the winner. The lens rises and draws back.',
    scene: 'mate',
    ...span(1.24 + 6 * BAR, 10.4),
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 13.6, 23.0));
      return { pos: H.mix3([0.3, 1.7, 12.8], [0.2, 2.6, 15.6], u), target: H.mix3([0.2, 2.2, 0], [0.15, 2.9, 0], u), fov: 33, focus: H.mix(13.5, 16.5, u), range: 7, amount: 0.008 };
    },
  },
];

if (import.meta.main ?? process.argv[1]?.endsWith('shots.mjs')) {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    for (const s of SHOTS) console.log(`${s.name.padEnd(10)} ${String(Math.round(((s.to - s.from) * 60) / (s.speed ?? 1))).padStart(4)} frames  ${s.about}`);
    process.exit(0);
  }
  const o = options(argv);
  const state = { clock: o.clock, aged: o.aged, motes: o.motes };
  const wanted = o.only.length ? SHOTS.filter((s) => o.only.includes(s.name)) : SHOTS;
  if (wanted.length === 0 || wanted.length < o.only.length) throw new Error(`No such shot. There are: ${SHOTS.map((s) => s.name).join(', ')}`);
  const began = Date.now();
  for (const shot of wanted) {
    const scene = SCENES[shot.scene];
    // Every take is held in the same state, unless the line says otherwise.
    for (const key of ['clock', 'aged', 'motes']) o[key] = state[key] ?? HELD[key] ?? null;
    const g = await open(o, { hud: !!shot.hud, css: shot.css ?? '', layout: shot.layout });
    try {
      await reach(g, scene, shot.settle, shot.hud ? (shot.hudRate ?? null) : null);
      const { seconds, frames } = await film(g, { ...shot, cues: [...scene.cues, ...(shot.cues ?? [])] });
      console.log(`[${shot.name}] ${(seconds / frames).toFixed(2)} s a frame over all`);
    } finally {
      await g.close();
    }
  }
  console.log(`${wanted.length} shot(s) in ${((Date.now() - began) / 1000).toFixed(0)} s -> ${o.out}`);
}
