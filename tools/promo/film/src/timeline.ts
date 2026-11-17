/**
 * The films' cuts: for each film, which shot is on the picture at each frame, and what is written
 * over it. There are three, cut from the same shots (shots.mjs):
 *
 *   game    a whole game played through, from the case opening to mate, with a few words over it
 *   tour    what there is to do in the game, one thing at a time, each named on a card first
 *   short   the game in twenty seconds
 *
 * Each goes to the same recording, which is at 110 beats a minute, four to the bar, and every cut
 * falls on a bar of it or a part of one. A film's bar 0 is at its frame `f0`; what comes before is
 * the case and the stones, with little or no music under them.
 *
 * This file is plain data, read both by the films themselves and by the scripts that make their
 * sound (sound.mjs, mix.mjs) and their finished files (cut.mjs).
 */

export const FPS = 60;
/** One bar of the music, in frames. */
export const BAR = (240 / 110) * FPS;

/**
 * The recording: its first bar begins `lead` seconds in, and a bar is `bar` seconds. It has a
 * tune of stops (a stab on the first beat, then little for a bar and a half) in its bars 0 to 15,
 * a bar of silence and a bar's pick-up, a walking tune from bar 18, and the stops again for its
 * last sixteen bars, 84 to 99, with the last chord on bar 100.
 */
export const MUSIC = { lead: 0.5882, bar: 240 / 110 };

export interface Cut {
  /** The shot (shots.mjs). */
  shot: string;
  /** The frames of the film it is on for: from `from` up to, not including, `to`. */
  from: number;
  to: number;
  /** How many frames of the shot's used part are passed over before it begins. */
  skip?: number;
  /** The game's sounds from this shot that the film leaves out. */
  without?: string[];
}

/** Words on one sheet at the foot of the picture, on the left: a small line saying what they are about, what is said, and a plainer line under it. */
export interface Caption {
  id: string;
  from: number;
  to: number;
  kicker?: string;
  lines: string[];
  note?: string;
  /** Whether it is whisked off before `to`, or simply gone with the cut. */
  whisk?: boolean;
}

/** A sheet slapped over the middle of the picture for a moment, with a few large words: what the next shot is. */
export interface Card {
  id: string;
  from: number;
  to: number;
  kicker?: string;
  icon?: 'link' | 'match' | 'engine' | 'book' | 'eye';
  lines: string[];
}

/** A word or two, large, slapped down in the middle of the picture. */
export interface Slam {
  id: string;
  from: number;
  to: number;
  text: string;
}

export interface Reel {
  id: string;
  /** The frame the film's bar 0 begins at. */
  f0: number;
  length: number;
  /**
   * The music: the film's bar 0 is the recording's bar `from`, and the recording is begun `pre`
   * bars before that. At the film's bar `splice.at` it is cut to the recording's bar `splice.to`.
   */
  music: { from: number; pre: number; splice: { at: number; to: number } | null };
  cuts: Cut[];
  /** The card with the film's name. */
  title: { from: number; to: number };
  /** The last card, which stays: slapped down on the recording's last chord. */
  end: { from: number; to: number };
  captions: Caption[];
  cards: Card[];
  slams: Slam[];
}

/** How long the last card stays, in frames. */
const HOLD = 318;
/** How long the name is up, and a card that names the next shot. */
const NAME = 68;
const CARD = 62;

/** The frame a film's bar `b` begins at, given where its bar 0 is. Bars may be given in parts. */
const bars = (f0: number) => (b: number) => Math.round(f0 + b * BAR);

function game(): Reel {
  const f0 = 262;
  const at = bars(f0);
  const end = { from: at(16), to: at(16) + HOLD };
  return {
    id: 'game',
    f0,
    length: end.to,
    // The bar of silence and the pick-up under the case and the stones; the walking tune for eight bars; and the last eight bars of all.
    music: { from: 18, pre: 2, splice: { at: 8, to: 92 } },
    cuts: [
      { shot: 'case', from: 0, to: 75, skip: 36 },
      { shot: 'stones', from: 75, to: f0, skip: 11 },
      { shot: 'open', from: at(0), to: at(2) },
      { shot: 'trade', from: at(2), to: at(4) },
      { shot: 'develop', from: at(4), to: at(6) },
      // The bishop's check lands on bar 8, the king is castled on bar 10, the queen is given up on bar 12 and the rook mates on bar 14.
      { shot: 'gambit', from: at(6), to: at(8.5) },
      { shot: 'fear', from: at(8.5), to: at(9) },
      { shot: 'long', from: at(9), to: at(10.5) },
      { shot: 'file', from: at(10.5), to: at(11.4) },
      { shot: 'queen', from: at(11.4), to: at(13.2) },
      { shot: 'rook', from: at(13.2), to: at(14.5) },
      { shot: 'light', from: at(14.5), to: end.to },
    ],
    title: { from: at(0), to: at(0) + NAME },
    end,
    captions: [
      { id: 'is', from: at(0) + NAME + 6, to: at(2), kicker: 'Nightpiece is', lines: ['Chess, in 3D,', 'in your browser.'], whisk: false },
      { id: 'friend', from: at(2) + 6, to: at(4), lines: ['Play a friend', 'with a link.'], whisk: false },
      { id: 'ranked', from: at(4) + 6, to: at(6), lines: ['Or a stranger,', 'in a ranked match.'], whisk: false },
      { id: 'computer', from: at(6) + 6, to: at(8) - 4, lines: ['Or the computer,', 'at six levels.'] },
    ],
    cards: [],
    slams: [],
  };
}

function tour(): Reel {
  const f0 = 198;
  const at = bars(f0);
  const end = { from: at(24), to: at(24) + HOLD };
  const way = (n: number, b: number, icon: Card['icon'], title: string, note: string): [Card, Caption] => [
    { id: `way-${n}`, from: at(b), to: at(b) + CARD, kicker: `Ways to play · ${n} of 4`, icon, lines: [title] },
    { id: `way-${n}-said`, from: at(b) + CARD + 4, to: at(b + 2), kicker: `Ways to play · ${n} of 4`, lines: [title], note, whisk: false },
  ];
  const ways = [
    way(1, 4, 'link', 'Play a friend', 'Send a link. They sit down opposite.'),
    way(2, 6, 'match', 'Find a ranked match', 'Ten minutes a side. Ratings. No account.'),
    way(3, 8, 'engine', 'Play the computer', 'Six levels, from First game to Master.'),
    way(4, 10, 'book', 'Learn the game', 'Twelve short lessons, at the board.'),
  ];
  return {
    id: 'tour',
    f0,
    length: end.to,
    // The tune of stops from its start for sixteen bars, a card on each stab; and the last eight bars of all.
    music: { from: 0, pre: 0, splice: { at: 16, to: 92 } },
    cuts: [
      { shot: 'stones', from: 0, to: f0 },
      { shot: 'open', from: at(0), to: at(2) },
      { shot: 'trade', from: at(2), to: at(4) },
      { shot: 'friend', from: at(4), to: at(6) },
      { shot: 'ranked', from: at(6), to: at(8) },
      { shot: 'computer', from: at(8), to: at(10) },
      { shot: 'lesson', from: at(10), to: at(12) },
      { shot: 'views', from: at(12), to: at(14) },
      // A game going on: a knight given up, and a check.
      { shot: 'gambit', from: at(14), to: at(15.5), skip: 131 },
      { shot: 'fear', from: at(15.5), to: at(16) },
      // The end of another: a queen given up, taken, and a bishop's mate.
      { shot: 'sacrifice', from: at(16), to: at(18) },
      { shot: 'takes', from: at(18), to: at(20) },
      { shot: 'mate', from: at(20), to: at(22) },
      { shot: 'pillar', from: at(22), to: end.to },
    ],
    title: { from: at(0), to: at(0) + NAME },
    end,
    captions: [
      { id: 'is', from: at(2) + CARD + 4, to: at(4), kicker: 'Nightpiece is', lines: ['Chess, in 3D,', 'in your browser.'], whisk: false },
      ...ways.map((w) => w[1]),
      { id: 'views-said', from: at(12) + CARD + 4, to: at(14), kicker: 'See it your way', lines: ['Five cameras'], note: 'From straight above to the player’s own eyes.', whisk: false },
    ],
    cards: [
      { id: 'is', from: at(2), to: at(2) + CARD, kicker: 'Nightpiece is', lines: ['Chess, in 3D,', 'in your browser.'] },
      ...ways.map((w) => w[0]),
      { id: 'views', from: at(12), to: at(12) + CARD, kicker: 'See it your way', icon: 'eye', lines: ['Five cameras'] },
    ],
    slams: [],
  };
}

function short(): Reel {
  const f0 = 48;
  const at = bars(f0);
  const end = { from: at(8), to: at(8) + HOLD };
  return {
    id: 'short',
    f0,
    length: end.to,
    // The last eight bars of all, with the beat before them.
    music: { from: 92, pre: 0.25, splice: null },
    cuts: [
      { shot: 'stones', from: 0, to: f0, skip: 150 },
      { shot: 'open', from: at(0), to: at(1) },
      // The check lands on bar 2, the queen is given up on bar 4 and the rook mates on bar 6.
      { shot: 'gambit', from: at(1), to: at(2.5), skip: 131 },
      { shot: 'long', from: at(2.5), to: at(3.4), skip: 60 },
      { shot: 'queen', from: at(3.4), to: at(5.2) },
      { shot: 'rook', from: at(5.2), to: at(6.5) },
      { shot: 'light', from: at(6.5), to: end.to },
    ],
    title: { from: at(0), to: at(0) + NAME },
    end,
    captions: [],
    cards: [],
    slams: [
      { id: 'in-3d', from: at(2) + 2, to: at(3.2), text: 'In 3D.' },
      { id: 'in-browser', from: at(4) + 2, to: at(5.1), text: 'In your browser.' },
      { id: 'free', from: at(6) + 2, to: at(7.3), text: 'Free.' },
    ],
  };
}

export const REELS: Record<string, Reel> = { game: game(), tour: tour(), short: short() };

/** The last card's parts come down one after another: the frames after the card itself at which each does. */
export const END_STEPS = { seal: 8, line: 18, chips: 34, address: 64 };
