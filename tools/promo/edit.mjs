/**
 * Development only. The promotional film as a list: which shot is on screen from which of its
 * frames and for how long, in order; what is written over it and when; and when the closing card
 * comes. cut.mjs makes the picture from it, overlay.mjs what is written over the picture, and
 * sound.mjs the game's sound; score.py is told where the moments fall.
 *
 * Frames are counted at 60 a second; the film is 2,715 of them, 45.25 seconds.
 *
 * It says what the game is, in the order someone coming to it would ask: what it is and where
 * (the room), what it is played with (the board, the pieces by name), how a game is begun (the
 * opening screen: the ways to play, a name, a match), how it is played (the hands), what a ranked
 * game is (the clocks, the ratings), how one ends (the mate, what it did to the rating, the
 * rankings), and the name. Each thing is said in a line set over the picture while the picture
 * shows it (`CAPTIONS`).
 *
 * The five shots from `2-hand` to `result` film one game without a break: each takes it up at
 * the frame the one before stopped at, so second `s` of that scene is second `s + 19.45` of the
 * film across those four cuts, and its three blows fall four seconds apart (22.83, 26.85 and
 * 30.83). The cut into it is made on the two notes that say a match has been made.
 *
 * Every shot is filmed twelve frames longer at each end than it is used (shots.mjs).
 */
export const FPS = 60;
export const LENGTH = 2715;

/** `without` names calls the shot's own sound made that the film leaves out. */
export const CUTS = [
  // 0.00  The room before anything happens: both sides, all four hands, the cross between them.
  { shot: '1-room', from: 12, frames: 249 },
  // 4.15  The board from high over one end, and then down to the pieces standing on it, which are named.
  { shot: 'pieces', from: 12, frames: 384 },
  // 10.55 The game as it is opened: the ways to play, a name typed, a match looked for and made (18.8).
  { shot: 'menu', from: 12, frames: 507 },
  // 19.00 Ivory's hand sweeps in over the queen, hangs, comes down, closes on her and lifts her.
  //       (The pawn she is about to take is broken out of its square by the other hand, at the
  //       far side of the board and out of the picture: it is not heard.)
  { shot: '2-hand', from: 12, frames: 180, without: ['crack'] },
  // 22.00 The ranked game as it is played, the interface up: she is set down (22.83, check), the
  //       other player's two hands take her with the rook (26.85), and Ivory's hand goes to the bishop.
  { shot: 'ranked', from: 12, frames: 423 },
  // 29.05 The hand closes on the bishop, carries it to g6 and sets it down (30.83): mate.
  { shot: '4-mate', from: 12, frames: 228 },
  // 32.85 The game won: what it did to the rating, and then the rankings (36.05).
  { shot: 'result', from: 12, frames: 348 },
  // 38.65 The mate from far off, the pillar standing in the ring, and the name over it.
  { shot: '5-name', from: 108, frames: 396 },
];

/**
 * What is written over the picture: a word or two above in small capitals and a line under it,
 * from second `at` of the film to second `until`. They stand at the lower right, where the game's
 * own interface leaves room; the last stands in the middle, under the name.
 */
export const CAPTIONS = [
  { at: 0.7, until: 3.95, head: 'This is Nightpiece', line: 'Chess, played in your browser.' },
  { at: 4.45, until: 6.8, head: 'The board', line: 'Sixty-four squares, in a chapel at night.' },
  { at: 7.05, until: 10.4, head: 'The pieces', line: 'Thirty-two of them, in living stone.' },
  { at: 10.8, until: 13.5, head: 'Five ways to play', line: 'Learn it. Play the computer, a friend, a stranger.' },
  { at: 13.75, until: 16.3, head: 'No account', line: 'Your name and your games stay in your browser.' },
  { at: 16.55, until: 18.9, head: 'Find a match', line: 'Ranked play, against whoever is waiting.' },
  { at: 19.3, until: 21.85, head: 'Your move', line: 'Reach in. The stones are moved by hand.' },
  { at: 23.9, until: 26.6, head: 'Ranked play', line: 'Ten minutes each. Five seconds back a move.' },
  { at: 33.2, until: 35.85, head: 'Ratings', line: 'Win, and your rating climbs.' },
  { at: 36.3, until: 38.55, head: 'Rankings', line: 'See where you stand.' },
  { at: 41.45, until: 45.25, head: 'In your browser', line: 'Nothing to install. No account.', place: 'middle' },
];

/**
 * The six kinds of piece, named over the shot `pieces`: each name is tied by a line to the top of
 * one stone of that kind, wherever the camera has it (overlay.mjs works that out from the shot's
 * camera.json). `top` is that point in the room (one unit is a square; shots.mjs says where the
 * squares are); `lift` is how far above it the name stands, in hundredths of the picture's height,
 * and `aside` how far to the right, in hundredths of its width, where straight above is taken.
 */
export const LABELS = {
  shot: 'pieces',
  until: 10.45,
  names: [
    { at: 7.45, name: 'King', top: [0.5, 1.7, 3.5], lift: 9 },
    { at: 7.75, name: 'Queen', top: [-0.5, 1.565, 3.5], lift: 15 },
    { at: 8.05, name: 'Bishop', top: [-0.5, 1.39, 1.5], lift: 12, aside: 8 },
    { at: 8.35, name: 'Knight', top: [2.5, 1.26, 3.5], lift: 12 },
    { at: 8.65, name: 'Rook', top: [3.5, 1.08, 3.5], lift: 7 },
    { at: 8.95, name: 'Pawn', top: [-1.5, 0.86, 2.5], lift: 6 },
  ],
};

/** The closing card: the frame of the film it starts on, and how many frames it is drawn for. */
export const TITLE = { at: 2391, frames: 324 };
/** When the seal is struck onto the card, in seconds from its first frame (as overlay.html has it): 40.83 seconds into the film. */
export const CARD = { seal: 0.98 };
/** The picture comes up out of black and goes back to it, over this many frames. */
export const FADE = { in: 40, out: 54 };

/** Each cut with the frame of the film it starts on. */
export function timeline() {
  let at = 0;
  const out = CUTS.map((c) => {
    const row = { ...c, at };
    at += c.frames;
    return row;
  });
  if (at !== LENGTH) throw new Error(`The cuts come to ${at} frames, not ${LENGTH}.`);
  return out;
}
