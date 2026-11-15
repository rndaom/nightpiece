/**
 * Development only. The shots of the promotional film, and the script that films them.
 *
 *   node tools/promo/shots.mjs [shot ...] [options]
 *
 *   node tools/promo/shots.mjs                                  every shot, 3840 x 2160 PNG, into tmp/promo/shots/<shot>/
 *   node tools/promo/shots.mjs 2-hand 4-mate                    only these
 *   node tools/promo/shots.mjs --url http://127.0.0.1:5174/     against another dev server (5173 unless told)
 *   node tools/promo/shots.mjs 3-play --draft --size 1080p      a quick look, under tmp/promo/shots/_draft/
 *   node tools/promo/shots.mjs 4-mate --frames 90,120           only these frames of a shot
 *   node tools/promo/shots.mjs --list                           what there is
 *
 * The options are the rig's (lib.mjs, `options`). Needs the dev server running (npm run dev) and
 * a Chromium; nothing opens on screen. Each shot is a folder of frame_00000.png onward at 60 a
 * second, with events.json (every call to the game's sound, by frame, and what the game did),
 * camera.json (where the camera was at each frame) and sheet.jpg (every sixth frame).
 *
 * There are eight shots and three scenes (scenes.mjs). Five film the end of a game, played once through:
 * each plays it again from its first move in a page of its own, with the engine kept out and the game held
 * in the same state (`HELD`), so a shot comes out the same every time it is filmed, a draft is the final
 * small, and where one shot is cut to the next the game goes on from the very frame it had reached. Two
 * (`ranked`, `result`) film the same game as a ranked game shows it, with the interface up. One (`menu`)
 * films the game as it is first opened, and someone using it: there the pointer is the shot's own (`act`).
 * Each shot is filmed a fifth of a second longer at each end than the cut uses (edit.mjs).
 */
import { film, open, options } from './lib.mjs';
import { reach, SCENES, YOU } from './scenes.mjs';

/**
 * The state the game is held in before every take (lib.mjs, `--clock`, `--aged`): its own clock,
 * which the resting hands' drift, the flames, the dust and the light go by, and how many
 * sixtieths of a second the hands have been in the room.
 */
export const HELD = { clock: 2, aged: 60 };

/**
 * Where things are (one unit is a square; Ivory sits at +z, the a-file is at -x):
 * d1 (-0.5, 3.5) the queen; h5 (3.5, -0.5) where she lands; e8 (0.5, -3.5) Void's king;
 * h6 (3.5, -1.5) the rook that takes her; d3 (-0.5, 1.5) the bishop; g6 (2.5, -1.5) where it mates.
 * A queen is 1.57 tall, a king 1.7, a pawn 0.86.
 *
 * The scene's clock (seconds), from the game's own beats (scenes.mjs, `AT`):
 *    0      Ivory's hand goes to the queen and hangs over her
 *    1.0    she is sent; the hand comes down at 1.55, closes and lifts her at 2.05
 *    3.4    she is set down on h5: check. The interface calls it out half a second later
 *    4.9    Void's hand goes to the rook; sent at 5.317
 *    6.03   the queen is lifted away by one hand; 6.37 the rook is lifted by the other
 *    7.4    the rook is set down where she stood
 *    9.15   Ivory's hand goes to the bishop; sent at 9.65, lifted at 10.15
 *   11.4    the bishop is set down on g6: mate
 */
/** Where something on the page is, in the page's own pixels: its box, and a point `fx` of the way across it and `fy` of the way down. */
const place = (g, selector, nth = 0, fx = 0.5, fy = 0.5) =>
  g.run(
    `const el = document.querySelectorAll(args[0])[args[1]];
     if (!el) throw new Error('nothing on the page answers to ' + args[0]);
     const r = el.getBoundingClientRect();
     return [r.left + r.width * args[2], r.top + r.height * args[3]];`,
    selector,
    nth,
    fx,
    fy,
  );

/** Where the pointer is at second `t`, given where it is to be at certain seconds: it starts gently, goes quickly and arrives gently. */
function along(keys, t) {
  if (t <= keys[0].t) return keys[0].at;
  for (let i = 1; i < keys.length; i++) {
    const [a, b] = [keys[i - 1], keys[i]];
    if (t > b.t) continue;
    const u = (t - a.t) / (b.t - a.t);
    const e = u * u * u * (u * (u * 6 - 15) + 10);
    // Not quite straight: a hand on a mouse swings a little.
    const bow = Math.sin(Math.PI * u) * 0.06;
    const [dx, dy] = [b.at[0] - a.at[0], b.at[1] - a.at[1]];
    return [a.at[0] + dx * e - dy * bow, a.at[1] + dy * e + dx * bow];
  }
  return keys[keys.length - 1].at;
}

/**
 * What is done at the opening screen, by the scene's seconds: the pointer goes down the ways to play and back up to
 * the game that was left unfinished, then to the field for a name, where a name is typed, and to Find a match, which is pressed.
 */
export const MENU = {
  typing: [4.38, 4.52, 4.7, 4.83, 4.99, 5.12],
  press: [4.05, 6.05],
};
async function useMenu(g, t, frame) {
  const m = (g.menu ??= { done: new Set() });
  // Before the lead the bill is not yet as the scene sets it (scenes.mjs): where things are is found at the first frame.
  if (frame < 0) return g.pointer(1020, 640);
  if (!m.keys) {
    const way = (n, fx = 0.6) => place(g, '.ways > li > button.way', n, fx);
    m.keys = [
      { t: 0.25, at: [1020, 640] },
      { t: 0.9, at: await way(1) },
      { t: 1.2, at: await way(1) },
      { t: 1.7, at: await way(2) },
      { t: 1.95, at: await way(2) },
      { t: 2.45, at: await way(4) },
      { t: 2.7, at: await way(4) },
      { t: 3.2, at: await way(0, 0.7) },
      { t: 3.5, at: await way(0, 0.7) },
      { t: 3.98, at: await place(g, '.who input', 0, 0.45) },
      { t: 5.3, at: await place(g, '.who input', 0, 0.45) },
      { t: 5.95, at: await way(3, 0.55) },
      { t: 9, at: await way(3, 0.55) },
    ];
  }
  const once = async (name, at, fn) => {
    if (t + 1e-6 < at || m.done.has(name)) return;
    m.done.add(name);
    await fn();
  };
  const pressed = MENU.press.some((p) => t >= p - 1e-6 && t < p + 0.11);
  const [x, y] = along(m.keys, t);
  await g.pointer(x, y, pressed);
  for (const p of MENU.press) {
    await once(`down ${p}`, p, () => g.page.mouse.down());
    await once(`up ${p}`, p + 0.1, () => g.page.mouse.up());
  }
  for (const [i, at] of MENU.typing.entries()) await once(`key ${i}`, at, () => g.page.keyboard.type(YOU.name[i]));
  // The mark in the field: there from the press that chose the field until the press that leaves it, steady while typing and for half a second after, then blinking.
  if (t >= MENU.press[0] + 0.1 && t < MENU.press[1]) {
    const since = t - Math.max(MENU.press[0], ...MENU.typing.filter((k) => k <= t));
    await g.caret('.who input', since < 0.5 || Math.floor((since - 0.5) / 0.5) % 2 === 1);
  } else if (m.done.has(`down ${MENU.press[0]}`)) await g.caret(null);
}

export const SHOTS = [
  {
    name: '1-room',
    about: 'The room before anything happens, in profile and from low down: Ivory and its two hands at the left, Void at the right, candles on the corners, the cross of night sky between them. The lens comes in and round until the cross stands over the middle of the board.',
    scene: 'ending',
    from: -4.8,
    to: -0.25,
    cut: [-4.6, -0.45],
    camera: (t, H) => {
      const u = H.sine(H.seg(t, -6.2, 1.0));
      return {
        pos: H.mix3([17.5, 0.8, 3.2], [13.6, 1.4, 0], u),
        target: H.mix3([0, 2.0, 0.6], [0, 1.95, 0], u),
        fov: 35,
        focusAt: [2, 0.8, 0],
        range: 6,
        amount: 0.007,
      };
    },
  },
  {
    name: 'pieces',
    about: 'The board and the pieces, before anything happens: from high over Void\'s end, the whole board and both sides; then down and in over Void\'s stones to Ivory\'s, standing in their ranks with Ivory\'s two hands behind them. The film names the six kinds over this (edit.mjs, `LABELS`).',
    scene: 'ending',
    from: -11.6,
    to: -4.8,
    cut: [-11.4, -5.0],
    camera: (t, H) => {
      const s = t + 11.4;
      const d = H.smoother(H.seg(s, 1.2, 4.0));
      // It is never quite still: a slow drift forward and down, before the descent and after it.
      const c = H.seg(s, -0.4, 7);
      const pos = H.mix3([0, 8.8, -8.6], [0.3, 2.95, -3.75], d);
      return {
        pos: [pos[0], pos[1] - 0.16 * c, pos[2] + 0.3 * c],
        target: H.mix3([0, 0.2, 0.3], [0, 0.85, 2.7], d),
        fov: H.mix(38, 39, d),
        focusAt: H.mix3([0, 0.5, 0], [0, 1.0, 3.0], d),
        range: H.mix(8, 3.2, d),
        amount: H.mix(0.006, 0.012, d),
      };
    },
  },
  {
    name: 'menu',
    about: 'The game as it is first opened, the choice of what to play down the left and the board going slowly round behind it. The pointer goes down the ways to play, a name is typed into the field for one, and Find a match is pressed: the game looks for an opponent, another player is waiting, and the match is made.',
    scene: 'opening',
    hud: true,
    layout: [1600, 900],
    settle: 3,
    from: -0.2,
    to: 8.65,
    cut: [0, 8.45],
    act: useMenu,
    // The game's own camera, as the opening screen has it.
    camera: (t, H) => {
      const o = H.own();
      return { pos: o.pos, target: H.add(o.pos, H.scale(o.forward, 10)), fov: o.fov, lens: 'own', thud: 0 };
    },
  },
  {
    name: '2-hand',
    about: 'Ivory\'s queen and king from Void\'s side of them, candles behind: the hand sweeps in over the queen, hangs in thought, comes down, its fingers close, and she is lifted off the board. The lens creeps, rushes in as the hand comes down, and is still as it grips.',
    scene: 'ending',
    from: -0.65,
    to: 2.75,
    cut: [-0.45, 2.55],
    fine: [
      [-0.05, 0.5, 32],
      [1.9, 2.75, 16],
    ],
    camera: (t, H) => {
      const u = H.smoother(Math.pow(H.seg(t, -1.0, 2.2), 3));
      const queen = H.keep('queen', () => H.idAt('d1'));
      const at = H.follow('at', H.stone(queen), 5);
      return {
        pos: H.mix3([-3.1, 1.55, 0.0], [-1.37, 1.04, 0.9], u),
        target: [-0.45 + (at[0] + 0.5) * 0.5, H.mix(1.7, 1.24, u) + at[1] * 0.5, 3.5 + (at[2] - 3.5) * 0.5],
        fov: H.mix(40, 33, u),
        focusAt: [at[0], 1.25 + at[1], at[2]],
        range: 0.55,
        amount: 0.024,
      };
    },
  },
  {
    name: 'ranked',
    about: 'A ranked game as it is played, from the seat at the side with the whole interface up: the two players, their ratings and their clocks at the left. The queen is carried across and set down, check is called and the banner says what she took; the other player\'s two hands take her with the rook and the banner says that; Ivory\'s hand goes to the bishop.',
    scene: 'ranked',
    hud: true,
    // The page a little smaller than the others', so the interface is a fifth larger in the picture, as it is in a window that size.
    layout: [1600, 900],
    // The lines that say the last quiet moves are still up when the shot begins, and go while Void's hands are moving.
    hudRate: 0.1,
    // The game's own camera, kept in its seat: it would cut to a close view for the check and for the capture.
    cuts: false,
    // Cut before the bishop is sent: the interface says CHECKMATE the instant it is.
    from: 2.35,
    to: 9.8,
    cut: [2.55, 9.6],
    camera: (t, H) => {
      // The seat's own view and lens, and a slow creep toward the board along the line of sight.
      const o = H.own();
      const k = H.sine(H.seg(t, 0.5, 12));
      const pos = H.add(o.pos, H.scale(o.forward, 1.3 * k));
      return { pos, target: H.add(pos, H.scale(o.forward, 10)), fov: o.fov, lens: 'own', thud: 0 };
    },
  },
  {
    name: '4-mate',
    about: 'From off the board\'s east edge, the rook that took the queen in front: Ivory\'s hand closes on the bishop far off among its own stones, lifts it and carries it toward the lens, the lens going with it, and sets it down on g6. Mate: the squares break upward toward the king and the pillar of light stands on him.',
    scene: 'ending',
    from: 9.4,
    to: 13.6,
    cut: [9.6, 13.4],
    fine: [[10.1, 11.5, 16]],
    camera: (t, H) => {
      const bishop = H.keep('bishop', () => H.idAt('d3'));
      const at = H.follow('at', H.stone(bishop), 9);
      // Round to where the bishop will land as it is carried there, and then slowly back and up from the mate.
      const round = H.smoother(H.seg(t, 9.3, 11.3));
      const back = H.quint(H.seg(t, 9.85, 15.05));
      const pos = H.add(H.mix3([7.25, 1.25, 1.9], [7.7, 0.95, -0.35], round), H.scale([1.8, 1.0, 0.8], back));
      return {
        pos,
        target: [at[0] * 0.75 + 0.3 - 0.7 * back, 0.8 + at[1] * 0.4 + 0.55 * back, at[2] * 0.75 - 0.7],
        fov: 30,
        focusAt: [at[0], 0.8 + at[1], at[2]],
        range: H.mix(1.2, 2.6, back),
        amount: 0.018,
      };
    },
  },
  {
    name: 'result',
    about: 'The ranked game won, from the seat with the interface up: the card that says how it ended and what the win did to the player\'s rating, the two players and their stopped clocks, and then the rankings opened over it, the player\'s own line marked.',
    scene: 'ranked',
    hud: true,
    layout: [1600, 900],
    hudRate: 0.1,
    cuts: false,
    from: 13.2,
    to: 19.4,
    cut: [13.4, 19.2],
    camera: (t, H) => {
      const o = H.own();
      const pos = H.add(o.pos, H.scale(o.forward, 1.3));
      return { pos, target: H.add(pos, H.scale(o.forward, 10)), fov: o.fov, lens: 'own', thud: 0 };
    },
  },
  {
    name: '5-name',
    about: 'Mate, from Ivory\'s end: a slow pull back and up, the pillar standing in the ring of spirit light, all four hands in the picture. The name is set over it.',
    scene: 'ending',
    from: 13.2,
    to: 21.8,
    cut: [13.4, 21.6],
    camera: (t, H) => {
      const u = H.sine(H.seg(t, 10.4, 24.0));
      return {
        pos: H.mix3([0.35, 1.5, 12.6], [0.25, 2.5, 16.4], u),
        target: H.mix3([0.3, 1.9, 0], [0.25, 2.75, 0], u),
        fov: 32,
        focus: H.mix(13.5, 17.5, u),
        range: 5,
        amount: 0.012,
      };
    },
  },
];

if (import.meta.main ?? process.argv[1]?.endsWith('shots.mjs')) {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    for (const s of SHOTS) console.log(`${s.name.padEnd(8)} ${String(Math.round((s.to - s.from) * 60)).padStart(4)} frames  ${s.about}`);
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
      const { seconds, frames } = await film(g, { ...shot, cues: scene.cues });
      console.log(`[${shot.name}] ${(seconds / frames).toFixed(2)} s a frame over all`);
    } finally {
      await g.close();
    }
  }
  console.log(`${wanted.length} shot(s) in ${((Date.now() - began) / 1000).toFixed(0)} s -> ${o.out}`);
}
