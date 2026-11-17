/**
 * Development only. The scenes the promotional films are cut from: each is a position, reached
 * unseen, and things that then happen at seconds counted from nought. A shot (shots.mjs) films
 * a scene from a camera of its own; two shots of one scene are the same moments from two
 * cameras, to the frame.
 *
 * A scene has:
 *   shut      true to leave the case shut on the altar, as the game is first opened; its cues start the game
 *   begin     a snippet that begins the game some other way than at a table for two (a lesson, say)
 *   fen       the position the game is begun from (the usual one if none)
 *   moves     [[from, to], ...] played with the hands before the scene, unseen
 *   unpack    seconds given to the case opening and the hands coming in (ten unless said)
 *   prep      a snippet run in the page once the position stands, before the room settles
 *   settle    seconds the room is left to come to rest (three unless said)
 *   cues      [{ t, name, js }]: what is done, and at which second of the scene
 */

/** Teed against Delmar, New York 1896: Ivory gives up the queen with check, Void's rook has to take her, and a bishop mates. */
export const MOVES = [
  ['d2', 'd4'],
  ['f7', 'f5'],
  ['c1', 'g5'],
  ['h7', 'h6'],
  ['g5', 'h4'],
  ['g7', 'g5'],
  ['h4', 'g3'],
  ['f5', 'f4'],
  ['e2', 'e3'],
  ['h6', 'h5'],
  ['f1', 'd3'],
  ['h8', 'h6'],
  ['d1', 'h5'],
  ['h6', 'h5'],
  ['d3', 'g6'],
];

/**
 * Morphy against the Duke of Brunswick and Count Isouard, Paris 1858: seventeen moves, with captures
 * answered by captures, a knight given up, a check, castling on the queen's side, the queen given up
 * and a rook's mate. Each move, and the second of the scene it is begun at; a move takes two to
 * three seconds, and the rest is left between them.
 */
export const OPERA = [
  ['e2', 'e4', 0.0], ['e7', 'e5', 2.3], ['g1', 'f3', 4.6], ['d7', 'd6', 7.15], ['d2', 'd4', 9.35], ['c8', 'g4', 11.65],
  ['d4', 'e5', 14.2], ['g4', 'f3', 17.35], ['d1', 'f3', 20.55], ['d6', 'e5', 22.95], ['f1', 'c4', 26.15], ['g8', 'f6', 28.6],
  ['f3', 'b3', 31.15], ['d8', 'e7', 33.55], ['b1', 'c3', 35.8], ['c7', 'c6', 38.35], ['c1', 'g5', 40.55], ['b7', 'b5', 43.1],
  ['c3', 'b5', 45.4], ['c6', 'b5', 48.85], ['c4', 'b5', 51.7], ['b8', 'd7', 56.3], ['e1', 'c1', 58.85], ['a8', 'd8', 61.3],
  ['d1', 'd7', 63.7], ['d8', 'd7', 66.65], ['h1', 'd1', 69.4], ['e7', 'e6', 71.8], ['b5', 'd7', 74.0], ['f6', 'd7', 76.7],
  ['b3', 'b8', 79.8], ['d7', 'b8', 82.3], ['d1', 'd8', 85.8],
];

/**
 * Bring the game to where a scene begins, unseen, and let the room settle.
 * `hudRate` is for a shot that shows the interface: how fast the interface's own clock runs
 * against the game's while the scene is reached (lib.mjs, `P.ownTime`).
 */
export async function reach(g, scene, settle = null, hudRate = null) {
  if (scene.shut) {
    if (scene.prep) await g.run(scene.prep);
    await g.step(settle ?? scene.settle ?? 3, { blind: true });
    return;
  }
  if (scene.begin) await g.run(scene.begin);
  else await g.run(`app.setFollowTurn?.(false); app.startTable(args[0] ?? undefined);`, scene.fen ?? null);
  // The case opening, the stones set out, the hands coming in.
  await g.step(scene.unpack ?? 10, { blind: true });
  if (hudRate !== null) await g.run(`P.clockRate = args[0];`, hudRate);
  for (const [from, to, seconds] of scene.moves ?? []) await g.play(from, to, seconds ?? 3.6);
  if (scene.prep) await g.run(scene.prep);
  await g.step(settle ?? scene.settle ?? 3, { blind: true });
}

/**
 * The ranked game the film shows is not played through the server: a server keeps its clocks by the real
 * clock, and a second of this film takes far longer than that to draw. It is the game's own interface,
 * given what the server would have sent it: two players' names and ratings, and clocks of ten minutes
 * with five seconds back a move. The names are made up.
 */
export const YOU = { name: 'Vesper', rating: 1216, wins: 4, losses: 2, draws: 1 };
export const THEM = { name: 'Marrow', rating: 1207, wins: 5, losses: 4, draws: 2 };

/** The server stood in for: asked for a match, the rankings or a name, it does nothing, and the scene says what came back. */
const NO_SERVER = `app.hall = { queue() {}, unqueue() {}, board() {}, hello() {}, close() {} };`;

/** The clocks as the server would send them: what each side has left (seconds), and whose is running. */
const clock = (w, b, running) =>
  `ui.online.value = { ...ui.online.value, clock: { left: { w: ${Math.round(w * 1000)}, b: ${Math.round(b * 1000)} }, running: ${running ? `'${running}'` : 'null'}, at: performance.now() } };`;

const click = (t, square) => ({ t, name: `click ${square}`, js: `app.click('${square}');` });
const play = (t, from, to, promotion) => ({ t, name: `${from}${to}`, js: `void app.play('${from}', '${to}'${promotion ? `, '${promotion}'` : ''});` });

export const SCENES = {
  /** The middle of a quiet game, seen through the game's own cameras one after another while a king is castled. */
  views: {
    fen: 'r2qk2r/ppp2ppp/2npbn2/2b1p1B1/2B1P3/2NP1N2/PPP2PPP/R2QK2R w KQkq - 4 7',
    prep: `app.setCamera('shoulder');`,
    cues: [
      { t: 1.85, name: 'the side', js: `app.setCamera('side');` },
      play(2.0, 'e1', 'g1'),
      { t: 3.6, name: 'the plan', js: `app.setCamera('top');` },
      play(4.8, 'h7', 'h6'),
      { t: 5.35, name: 'the eyes', js: `app.setCamera('eyes');` },
    ],
  },

  /** A whole game, played through at the pace the hands make it. */
  opera: { cues: OPERA.map(([from, to, t]) => play(t, from, to)) },

  /**
   * A ranked game, as the interface shows one: the two players come to the board, the clocks start,
   * and a move is made on each side. Void's comes as the other player's does online.
   */
  ranked: {
    cues: [
      {
        t: -1.2,
        name: 'a ranked game',
        js: `performance.now = () => P.clock.now;
          ${NO_SERVER}
          ui.player.value = { name: '${YOU.name}', card: ${JSON.stringify(YOU)} };
          ui.mode.value = { kind: 'online', room: 'film' };
          ui.you.value = 'w';
          ui.online.value = { room: 'film', seat: 'w', link: 'open', taken: { w: true, b: true }, present: { w: true, b: true }, watching: 0,
            again: { w: false, b: false }, offer: null, note: null, ranked: true,
            players: { w: { name: '${YOU.name}', rating: ${YOU.rating} }, b: { name: '${THEM.name}', rating: ${THEM.rating} } },
            clock: null, ended: null, change: null };
          ${clock(600, 600, null)}`,
      },
      {
        t: 0,
        name: 'the players come to the board',
        js: `ui.intro.value = { id: 1, ranked: true, you: 'w', players: ui.online.value.players, clock: { base: 600000, increment: 5000 } };`,
      },
      { t: 3.4, name: 'put away', js: `ui.intro.value = null; app.world.sound?.ui('close'); ${clock(600, 600, 'w')}` },
      { t: 3.5, name: 'thinks of e2', js: `app.world.consider('w', 'e2');` },
      { t: 4.2, name: 'e4', js: `void app.play('e2', 'e4', undefined, 'remote'); ${clock(599.2 + 5, 600, 'b')}` },
    ],
  },

  /** A game with a friend, from the eyes: the friend's hand answers across the board. */
  friend: {
    moves: [['e2', 'e4']],
    prep: `app.setCamera('eyes');`,
    cues: [
      { t: 0, name: 'thinks of e7', js: `app.world.consider('b', 'e7');` },
      { t: 0.8, name: 'e5', js: `void app.play('e7', 'e5', undefined, 'remote');` },
    ],
  },

  /** A game against the computer, from above: Ivory has played, and the computer's hand answers. */
  computer: {
    begin: `app.setFollowTurn?.(false); app.startComputer('master', 'w');`,
    moves: [['d2', 'd4']],
    prep: `ui.engine.value = 'idle'; ui.notice.value = null; ui.thinking.value = false; app.setCamera('top');`,
    cues: [
      { t: 0, name: 'thinks of g8', js: `app.world.consider('b', 'g8');` },
      { t: 0.8, name: 'Nf6', js: `void app.play('g8', 'f6', undefined, 'computer');` },
    ],
  },

  /** A lesson at the board: the sixth, the knight. */
  lesson: {
    begin: `app.setFollowTurn?.(false); app.startLessons(5, 0);`,
    cues: [{ t: 0.9, name: 'show me', js: `app.showMe();` }],
  },

  /** The case shut on the altar; the game is begun: the clasp, the lid, the drawers, the stones, the hands. */
  unpack: {
    shut: true,
    cues: [{ t: 0, name: 'begin', js: `app.setFollowTurn?.(false); app.startTable();` }],
  },

  /** The end of Teed against Delmar: the queen given up with check, taken, and the bishop's mate. */
  mate: {
    moves: MOVES.slice(0, 12),
    settle: 6,
    cues: [click(0, 'd1'), click(1.0, 'h5'), click(4.9, 'h6'), click(5.317, 'h5'), click(9.89, 'd3'), click(10.39, 'g6')],
  },
};
