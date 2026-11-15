/**
 * Development only. The game the film is cut from, and the scenes in it.
 *
 * The game is Teed against Delmar, New York 1896, eight moves: Ivory gives up the queen with
 * check, Void's rook has to take her, and a bishop mates.
 *
 *   1. d4 f5  2. Bg5 h6  3. Bh4 g5  4. Bg3 f4  5. e3 h5  6. Bd3 Rh6  7. Qxh5+ Rxh5  8. Bg6#
 *
 * A scene is a position reached by playing the game's moves with the hands, left to settle,
 * and then things that happen at seconds counted from nought. Every shot of the film films the
 * same scene: each plays it again from the start, so they are the same moments from different
 * cameras, to the frame, and the film's time runs on across every cut.
 */
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
 * Bring the game to where a scene begins, unseen, and let the room settle.
 *
 * A scene with `plies` starts a game at one screen and plays that many half-moves of the game with the hands.
 * A scene that is `opening` is the game as it is first opened, the choice of what to play on screen: nothing is started.
 *
 * `hudRate` is for a shot that shows the interface: how fast the interface's own clock runs against the game's
 * while the moves are played and the room settles (lib.mjs, `P.ownTime`). The lines that say the last moves stay up
 * for nine seconds of that clock, so run slowly it has them still up when the scene begins.
 */
export async function reach(g, scene, settle = 6, hudRate = null) {
  if (scene.opening) {
    await g.step(settle ?? 6, { blind: true });
    return;
  }
  await g.run(`app.startTable();`);
  // The camera's swing from the opening screen, the hands coming in.
  await g.step(4, { blind: true });
  if (hudRate !== null) await g.run(`P.clockRate = args[0];`, hudRate);
  for (const [from, to] of MOVES.slice(0, scene.plies)) await g.play(from, to);
  await g.step(settle ?? 6, { blind: true });
}

/**
 * When each thing is done, in seconds of the scene. The game's own beats follow from these (a hand is over a
 * chosen stone three tenths of a second after it is chosen; a stone sent across the board is set down two
 * seconds and a little after it is sent), and edit.mjs is cut to them.
 */
export const AT = {
  /** Ivory's hand goes to the queen and hangs over her. */
  chooseQueen: 0,
  /** 7. Qxh5+: she is sent. Lifted at 2.05, set down at 3.4: check. */
  sendQueen: 1.0,
  /** Void's hand goes to the rook. */
  chooseRook: 4.9,
  /** 7... Rxh5: the queen is lifted away at 6.03 and the rook set down where she stood at 7.4. */
  sendRook: 5.317,
  /** Ivory's hand goes to the bishop. */
  chooseBishop: 9.15,
  /** 8. Bg6#: lifted at 10.15, set down at 11.4: mate. */
  sendBishop: 9.65,
};

/**
 * The ranked game the film shows is not played through the server: a server keeps its clocks by the real
 * clock, and a second of this film takes a minute to draw. It is the game's own interface, given what the
 * server would have sent it: two players' names and ratings, clocks of ten minutes with five seconds back
 * a move, and, when the game is won, what the win did to the winner's rating (the server's own sum:
 * 32 x (1 - 1 / (1 + 10^((1207 - 1200) / 400))) = 16). The names are made up.
 */
export const YOU = { name: 'Vesper', rating: 1200, wins: 0, losses: 0, draws: 0 };
export const THEM = { name: 'Marrow', rating: 1207, wins: 5, losses: 4, draws: 2 };
export const GAIN = 16;
/** The rankings as they stand after it. */
export const TABLE = [
  { name: 'Ashlar', rating: 1388, wins: 21, losses: 6, draws: 3 },
  { name: 'Quillon', rating: 1342, wins: 17, losses: 7, draws: 2 },
  { name: 'Tamsin', rating: 1305, wins: 12, losses: 5, draws: 4 },
  { name: 'Corvid', rating: 1271, wins: 9, losses: 5, draws: 1 },
  { name: 'Oriel', rating: 1239, wins: 6, losses: 3, draws: 2 },
  { name: YOU.name, rating: YOU.rating + GAIN, wins: 1, losses: 0, draws: 0 },
  { name: 'Hollis', rating: 1204, wins: 4, losses: 4, draws: 1 },
  { name: THEM.name, rating: THEM.rating - GAIN, wins: THEM.wins, losses: THEM.losses + 1, draws: THEM.draws },
];

/** The server stood in for: asked for a match, the rankings or a name, it does nothing, and the scene says what came back. */
const NO_SERVER = `app.hall = { queue() {}, unqueue() {}, board() {}, hello() {}, close() {} };`;

/** The clocks as the server would send them: what each side has left (seconds), and whose is running. */
const clock = (w, b, running) =>
  `ui.online.value = { ...ui.online.value, clock: { left: { w: ${Math.round(w * 1000)}, b: ${Math.round(b * 1000)} }, running: ${running ? `'${running}'` : 'null'}, at: performance.now() } };`;

/** Ivory has 9:14.6 and Void 8:51.0 as the scene begins; each move gives its player five seconds back. */
const LEFT = { w: 554.6, b: 531.0 };
const afterQueen = { w: LEFT.w - AT.sendQueen + 5, b: LEFT.b };
const afterRook = { w: afterQueen.w, b: afterQueen.b - (AT.sendRook - AT.sendQueen) + 5 };
const afterBishop = { w: afterRook.w - (AT.sendBishop - AT.sendRook) + 5, b: afterRook.b };

const ENDING = [
  // The interface's clock, where a shot has slowed it to keep the last moves' lines up, runs true from before anything happens.
  { t: -1, name: 'clock', js: `P.clockRate = 1;` },
  { t: AT.chooseQueen, name: 'choose d1', js: `app.click('d1');` },
  { t: AT.sendQueen, name: 'Qxh5+', js: `app.click('h5');` },
  { t: AT.chooseRook, name: 'choose h6', js: `app.click('h6');` },
  { t: AT.sendRook, name: 'Rxh5', js: `app.click('h5');` },
  { t: AT.chooseBishop, name: 'choose d3', js: `app.click('d3');` },
  { t: AT.sendBishop, name: 'Bg6#', js: `app.click('g6');` },
];

export const SCENES = {
  /** The end of the game, whole: from the position after 6... Rh6, the queen given up with check, taken, and the bishop's mate. */
  ending: { plies: 12, cues: ENDING },

  /**
   * The same, as a ranked game sees it: the interface is told it is one, a moment before anything happens, and
   * the page's clock is made the scene's, since a ranked game's clocks are read against it. Void's move comes
   * as the other player's does online: the hand is seen to go to the rook, and then the move arrives.
   * After the mate the rating moves, and the rankings are opened.
   */
  ranked: {
    plies: 12,
    cues: [
      { t: -1, name: 'clock', js: `P.clockRate = 1;` },
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
          ${clock(LEFT.w + 1.2, LEFT.b, 'w')}`,
      },
      { t: AT.chooseQueen, name: 'choose d1', js: `app.click('d1');` },
      { t: AT.sendQueen, name: 'Qxh5+', js: `app.click('h5'); ${clock(afterQueen.w, afterQueen.b, 'b')}` },
      { t: AT.chooseRook, name: 'thinks of h6', js: `app.world.consider('b', 'h6');` },
      { t: AT.sendRook, name: 'Rxh5', js: `void app.play('h6', 'h5', undefined, 'remote'); ${clock(afterRook.w, afterRook.b, 'w')}` },
      { t: AT.chooseBishop, name: 'choose d3', js: `app.click('d3');` },
      { t: AT.sendBishop, name: 'Bg6#', js: `app.click('g6'); ${clock(afterBishop.w, afterBishop.b, null)}` },
      {
        t: 11.5,
        name: 'the rating moves',
        js: `ui.player.value = { name: '${YOU.name}', card: ${JSON.stringify({ ...YOU, rating: YOU.rating + GAIN, wins: 1 })} };
          ui.online.value = { ...ui.online.value, change: { w: ${GAIN}, b: ${-GAIN} } };`,
      },
      { t: 16.6, name: 'the rankings', js: `ui.ranks.value = { top: ${JSON.stringify(TABLE)}, you: ${JSON.stringify({ ...YOU, rating: YOU.rating + GAIN, wins: 1 })} }; ui.ranksOpen.value = true;` },
    ],
  },

  /**
   * The game as it is first opened: the choice of what to play, the board going slowly round behind it.
   * What the pointer does is the shot's (shots.mjs, `act`); here is what the server would have answered.
   */
  opening: {
    opening: true,
    cues: [
      // The film's browser has not the engine in it, which the choice of game would remark on; and it has a game left unfinished in it,
      // which the choice of game offers to carry on (and, having that to offer, folds the computer's strengths away).
      {
        t: -1,
        name: 'no server, a game kept',
        js: `${NO_SERVER} ui.engine.value = 'idle'; ui.saved.value = { kind: 'computer', level: 'casual', moves: 14, at: Date.now() - 20 * 3600 * 1000 };`,
      },
      { t: 6.45, name: 'the server heard', js: `if (ui.queue.value) ui.queue.value = { waiting: 1, up: true };` },
      { t: 7.35, name: 'another is waiting', js: `if (ui.queue.value) ui.queue.value = { waiting: 2, up: true };` },
      // As the game does it when a match is made (app.ts, `matched`): two notes of glass.
      { t: 8.25, name: 'matched', js: `app.world.sound?.glass(null, 3); app.world.sound?.glass(null, 5, 0.16);` },
    ],
  },
};
