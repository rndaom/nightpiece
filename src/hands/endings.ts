/**
 * How the hands end a game that did not end by mate or by a king laid down (docs/manners.md, 5.7):
 * scenes that take both players' hands at once. Each is a script played on arms lent to it
 * (`Puppeteer.act`); every place in it is in a player's own terms, so that one script, played by
 * both, has their hands mirror each other across the board. A scene stops the moment any arm in
 * it is called away (a move taken back, a new game), and every arm then goes to rest.
 */
import { Vector3 } from 'three';
import { opposite, type Side } from '../core/game';
import { POSES } from './hand';
import type { Act, Mood, Puppeteer, Stance } from './puppeteer';
import { type FingerName, fingerOf, type Pose, setFinger } from './rig';

/** The scenes, by the names of the rows of the table that choose them (manners.ts). */
export const ENDINGS = ['out-of-time', 'gone', 'scuffle', 'rock-paper-scissors', 'asleep', 'empty-purse', 'handshake'] as const;
export type Ending = (typeof ENDINGS)[number];

export const isEnding = (name: string | null): name is Ending => name !== null && (ENDINGS as readonly string[]).includes(name);

/** What the hands do that can be heard in an ending: glass on glass (struck how hard), and the handshake's one pump. */
export type Sounded = 'chime' | 'pump';

/** What a scene is played with. */
export interface Cast {
  hands: Record<Side, Puppeteer>;
  /** Who won, if anybody did. */
  winner: Side | null;
  /** Who made the move that ended it, and how far ahead in stones they then were (a pawn one, a queen nine). */
  last: Side;
  ahead: number;
  /** The side whose offer of a draw was taken, if it was; and whether one was refused earlier in the game. */
  offered: Side | null;
  refused: boolean;
  /** A draw by repetition that came of the position standing five times, and not three. */
  fivefold: boolean;
  /** The ending's own chance, from 0 up to 1, the same on every screen at this board: drawn again for each `name`. */
  chance(name: string): number;
  /** Told of what is heard: what, where in the room, and how hard (0 to 1). */
  heard(what: Sounded, at: Vector3, strength: number): void;
}

/** Play an ending. Resolves when it is over, or has been cut short. */
export function playEnding(name: Ending, cast: Cast): Promise<void> {
  switch (name) {
    case 'out-of-time':
      return outOfTime(cast);
    case 'gone':
      return gone(cast);
    case 'scuffle':
      return scuffle(cast);
    case 'rock-paper-scissors':
      return rockPaperScissors(cast);
    case 'asleep':
      return asleep(cast);
    case 'empty-purse':
      return emptyPurse(cast);
    case 'handshake':
      return handshake(cast);
  }
}

/**
 * Have several arms play one script between them. It begins only if every one of them is free to
 * be lent; `ok` is true for as long as every one of them is still the script's. When it is over,
 * or cut short, they all go to rest together.
 */
async function together(parts: [Puppeteer, 'right' | 'left'][], script: (acts: Act[], ok: () => boolean) => Promise<void>): Promise<void> {
  const acts: Act[] = [];
  let done = () => {};
  const over = new Promise<void>((resolve) => (done = resolve));
  // An arm that is free is lent at once (Puppeteer.act), so every one has its part by the next line, or never will.
  const lent = parts.map(([player, which], i) =>
    player.act(player[which], async (it) => {
      acts[i] = it;
      await over;
    }),
  );
  if (parts.every((_, i) => acts[i])) await script(acts, () => acts.every((it) => it.ok()));
  done();
  await Promise.all(lent);
}

const SIDES = ['w', 'b'] as const;
const both = (cast: Cast, which: 'right' | 'left' = 'right'): [Puppeteer, 'right' | 'left'][] => SIDES.map((side) => [cast.hands[side], which]);
const settle = (cast: Cast, mood: Mood) => SIDES.forEach((side) => cast.hands[side].settle(mood));
const at = (x: number, y: number, z: number) => new Vector3(x, y, z);
const bump = (u: number) => (u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0);

/**
 * How high over the board the hands meet, at the point under their palms: low enough to be in the
 * middle of the picture from behind either player, and their fingers still well above the tallest
 * crown.
 */
const MIDDLE_HIGH = 2.95;
/** The same for hands held on edge, thumb up, whose little fingers hang lower than the rest of them. */
const UPRIGHT_HIGH = 3.45;

/** A pose with some of its fingers taken from another. */
function mixed(base: Pose, from: Pose, fingers: FingerName[]): Pose {
  const p = base.slice() as Pose;
  for (const finger of fingers) setFinger(p, finger, fingerOf(from, finger));
  return p;
}

/** Fingers a little spread: ready for anything. */
const READY = POSES.splay.map((angle, i) => angle * 0.6 + POSES.relaxed[i]! * 0.4) as Pose;
/** The index caught under the thumb, to flick. */
const COCKED = (() => {
  const p = mixed(READY, POSES.fist, ['ring', 'little']);
  setFinger(p, 'index', [1.1, 1.2, 0.7, 0.02, 0]);
  setFinger(p, 'thumb', [0.6, 0.5, 0.35, -0.2, 1.0]);
  return p;
})();
const FLICKED = (() => {
  const p = mixed(READY, POSES.fist, ['ring', 'little']);
  setFinger(p, 'index', [-0.08, -0.05, 0, 0.04, 0]);
  return p;
})();
/** Two fingers out and apart, the rest shut. */
const SCISSORS = (() => {
  const p = POSES.fist.slice() as Pose;
  setFinger(p, 'index', [0.04, 0.04, 0.02, 0.24, 0]);
  setFinger(p, 'middle', [0.04, 0.04, 0.02, -0.16, 0]);
  setFinger(p, 'thumb', [0.75, 0.75, 0.5, -0.3, 1.0]);
  return p;
})();
const THROWS: Record<'rock' | 'paper' | 'scissors', Pose> = { rock: POSES.fist, paper: POSES.open, scissors: SCISSORS };
/** A hand held out to shake another: open, the fingers a little curled and together, the thumb up and out. */
const OFFERED_HAND = (() => {
  const p = POSES.open.slice() as Pose;
  for (const finger of ['index', 'middle', 'ring', 'little'] as FingerName[]) setFinger(p, finger, [0.25, 0.2, 0.12, 0, 0]);
  setFinger(p, 'thumb', [0.05, 0.05, 0.03, 0.35, 0.4]);
  return p;
})();
/** And closed on the other: the fingers round its back, the thumb over its knuckles. */
const CLASPED = (() => {
  const p = OFFERED_HAND.slice() as Pose;
  for (const finger of ['index', 'middle', 'ring', 'little'] as FingerName[]) setFinger(p, finger, [0.75, 0.85, 0.5, 0, 0]);
  setFinger(p, 'thumb', [0.35, 0.3, 0.2, 0.15, 0.6]);
  return p;
})();
/** Cupped, palm up, as one looks into a purse with nothing in it. */
const CUPPED = POSES.relaxed.map((angle, i) => angle * 0.7 + POSES.fist[i]! * 0.3) as Pose;

// -- time ----------------------------------------------------------------------------------------

/** The loser's hands stop where they are, hold, and drop as if their strings were cut. The winner's are only quietly glad. */
async function outOfTime(cast: Cast): Promise<void> {
  if (!cast.winner) return;
  cast.hands[opposite(cast.winner)].cut();
  cast.hands[cast.winner].outcome('won', true, false);
}

// -- gone ----------------------------------------------------------------------------------------

/**
 * The hands of the player who has gone come apart where they are. After a while the other player's
 * left hand lifts, and waves, slowly, at where they were. (The left: a camera behind a player
 * hangs over their right shoulder, and a hand raised there would fill the picture.)
 */
async function gone(cast: Cast): Promise<void> {
  if (!cast.winner) return;
  cast.hands[opposite(cast.winner)].vanish();
  const player = cast.hands[cast.winner];
  player.settle('won');
  const waving: Stance = { heading: -0.15, pitch: -1.0, roll: 0.1 };
  await player.act(
    player.left,
    async (it) => {
      it.speed(5);
      it.pose(POSES.release, 0.7);
      // Over its own corner of the case, a little up and in: no higher than it need be to be seen.
      it.go(at(-3.5, 2.35, 5.0), waving, 1.1);
      if (!(await it.pause(1.3))) return;
      // Side to side from the wrist, twice and a half, slowly; and a little less each time.
      it.speed(9);
      if (!(await it.during(2.4, (k) => it.aim(-0.15 + 0.32 * Math.sin(k * Math.PI * 5) * (1 - 0.35 * k))))) return;
      it.aim(null);
      await it.pause(0.5);
    },
    2,
  );
}

// -- stalemate -----------------------------------------------------------------------------------

/**
 * The scuffle. Both right hands come to the middle of the board and stop, facing, a hand's length
 * apart. One provokes the other (a wiggle of the fingers, goodbye; or, the stones being even, a
 * flick at its fingertips), and the other swats it; and then they are at it, by turns, faster and
 * faster, two children told not to hit, until both stop dead, look at each other, and withdraw with
 * what dignity they have, each turned a little away from the other. Which provokes is read from the
 * board: a side that gave stalemate five stones or more ahead is furious, and the other is smug.
 */
async function scuffle(cast: Cast): Promise<void> {
  settle(cast, 'drawn');
  const furious = cast.ahead >= 5;
  // The one who starts the swatting, and the one who provokes it.
  const starter: Side = furious ? cast.last : cast.chance('scuffle-starter') < 0.5 ? 'w' : 'b';
  const smug = opposite(starter);
  // One time in three the second swat misses, and that is what starts it.
  const misses = cast.chance('scuffle-miss') < 1 / 3;
  const swats = 7 + Math.floor(cast.chance('scuffle-swats') * 3);
  await together(both(cast), async ([w, b], ok) => {
    const acts: Record<Side, Act> = { w: w!, b: b! };
    const face: Stance = { heading: 0, pitch: 0.06, roll: -0.18 };
    // Where each is: out to its own right, so their fingers pass side by side and not into each
    // other; standing off (the stand-off), and in close enough to reach (the fight).
    const off = at(0.78, MIDDLE_HIGH, 2.55);
    const near = at(0.78, MIDDLE_HIGH, 2.05);
    for (const it of [w!, b!]) {
      it.steady(true);
      it.speed(8);
      it.pose(READY, 0.6);
      it.go(off, face, 0.75);
      void it.lean({ glow: 0.75 }, 0.5);
    }
    if (!(await w!.pause(1.15))) return;
    // Nobody moves.
    if (!(await w!.pause(0.35))) return;
    const provoker = acts[smug];
    if (furious || cast.chance('scuffle-provoke') < 0.5) {
      // Goodbye: the fingers wiggle, one after another.
      for (let i = 0; i < 4 && ok(); i++) {
        provoker.pose(i % 2 ? READY : POSES.relaxed, 0.09, 0.025);
        if (!(await provoker.pause(0.1))) return;
      }
    } else {
      // A flick at the other's fingertips: in, cocked, and let go.
      provoker.speed(16);
      provoker.pose(COCKED, 0.18);
      provoker.shift(at(0.62, MIDDLE_HIGH + 0.05, 2.15));
      if (!(await provoker.pause(0.3))) return;
      provoker.pose(FLICKED, 0.05, 0);
      cast.heard('chime', provoker.room(at(0, MIDDLE_HIGH + 0.4, 0)), 0.4);
      acts[starter].speed(30);
      acts[starter].aim(-0.12);
      if (!(await provoker.pause(0.25))) return;
      acts[starter].aim(null);
      provoker.speed(8);
      provoker.shift(off);
      provoker.pose(READY, 0.2);
    }
    if (!(await provoker.pause(0.25))) return;
    // The other draws back a sixth of a square, and swats.
    const first = acts[starter];
    first.speed(14);
    first.shift(at(0.78, MIDDLE_HIGH + 0.04, 2.55 + 0.17));
    if (!(await first.pause(0.22))) return;

    // The swats: who, and when. Each is a turn of the wrist toward the other hand (its fingers pass
    // over the other's) with a little lift, out and back in 130 ms; the hand it lands on is knocked
    // aside and comes back. 150 ms apart at first, 110 at the end.
    const order: { by: Side; t: number; lands: boolean }[] = [];
    let t = 0;
    for (let i = 0; i < swats; i++) {
      const by = i % 2 === 0 ? starter : smug;
      order.push({ by, t, lands: !(misses && i === 1) });
      t += 0.15 - (0.04 * i) / Math.max(1, swats - 1) + (misses && i === 1 ? 0.3 : 0);
    }
    const length = t + 0.12;
    const SWING = 0.3;
    const KNOCK = 0.2;
    const heard = order.map(() => false);
    for (const it of [w!, b!]) {
      it.speed(45);
      it.pose(READY, 0.15);
    }
    const fought = await w!.during(length, (k) => {
      const now = k * length;
      for (const side of SIDES) {
        const it = acts[side];
        let heading = 0;
        const place = near.clone();
        for (const [i, swat] of order.entries()) {
          const since = now - swat.t;
          if (swat.by === side) {
            const swing = bump(since / 0.13) * (swat.lands ? 1 : 1.6);
            heading += SWING * swing;
            place.x -= 0.12 * swing;
            place.y += 0.12 * swing;
          } else if (swat.lands && since > 0.06) {
            // Struck, a moment into the other's swing: knocked aside, back toward its own right.
            const after = since - 0.06;
            const knocked = Math.min(1, after / 0.025) * Math.exp(-after / 0.09);
            heading -= KNOCK * knocked;
            place.x += 0.1 * knocked;
            if (!heard[i]) {
              heard[i] = true;
              cast.heard('chime', it.room(at(0.2, MIDDLE_HIGH + 0.45, 0)), 0.55 + 0.45 * (i / swats));
            }
          } else if (!swat.lands && since > 0) {
            // Ducked: it was not there.
            place.z += 0.3 * bump(since / 0.3);
            place.y -= 0.1 * bump(since / 0.3);
          }
        }
        it.aim(heading);
        it.shift(place);
      }
    });
    if (!fought) return;
    // Both stop dead, mid-swat. Nobody moves.
    for (const it of [w!, b!]) {
      it.speed(60);
      it.shift(it.where());
    }
    if (!(await w!.pause(0.55))) return;
    // And they withdraw, slowly, with dignity: each turned a little away from the other.
    for (const it of [w!, b!]) {
      it.aim(null);
      it.speed(3);
      it.pose(POSES.relaxed, 1.2, 0.06);
    }
    settle(cast, 'sulking');
    await w!.pause(0.3);
  });
}

// -- repetition ----------------------------------------------------------------------------------

/**
 * The same position three times: rock, paper, scissors. Both right hands come to the middle, fists
 * up; three pumps, and they throw: rock and rock. Paper and paper. Scissors and scissors. They hold
 * it, turn up their palms, and go. Five times over (the fivefold), five rounds, each quicker than
 * the last.
 */
async function rockPaperScissors(cast: Cast): Promise<void> {
  settle(cast, 'drawn');
  const throws: (keyof typeof THROWS)[] = cast.fivefold ? ['rock', 'paper', 'scissors', 'rock', 'paper'] : ['rock', 'paper', 'scissors'];
  await together(both(cast), async ([w, b], ok) => {
    const hands = [w!, b!];
    const stance: Stance = { heading: 0.05, pitch: 0.1, roll: -1.25 };
    const place = at(0.62, UPRIGHT_HIGH, 3.0);
    for (const it of hands) {
      it.steady(true);
      it.speed(7);
      it.pose(POSES.fist, 0.5);
      it.go(place, stance, 0.85);
    }
    if (!(await w!.pause(1.2))) return;
    for (const [round, thrown] of throws.entries()) {
      // Three pumps, each down and up; the throw is made on the way down the third time.
      const beat = 0.34 * Math.pow(0.8, Math.max(0, round - (throws.length > 3 ? 1 : 3)));
      for (const it of hands) {
        it.speed(26);
        it.pose(POSES.fist, 0.12);
      }
      let thrownYet = false;
      const pumped = await w!.during(beat * 3, (k) => {
        const n = k * 3;
        const down = n < 2 ? Math.sin(Math.PI * (n % 1)) : Math.min(1, (n - 2) * 2.2);
        for (const it of hands) {
          it.shift(at(place.x, place.y - 0.26 * down, place.z), stance.pitch + 0.06 * down);
          if (n >= 2.15 && !thrownYet) it.pose(THROWS[thrown], beat * 0.35, 0.01);
        }
        if (n >= 2.15 && !thrownYet) {
          thrownYet = true;
          cast.heard('chime', w!.room(at(0, place.y, 0)), 0.3);
        }
      });
      if (!pumped || !ok()) return;
      if (!(await w!.pause(round === throws.length - 1 ? 0.8 : beat * 1.4))) return;
    }
    // Well then. Both palms up; and home.
    for (const it of hands) {
      it.speed(5);
      it.pose(POSES.release, 0.6);
      it.roll(-2.7);
      it.shift(at(place.x + 0.3, place.y + 0.2, place.z + 0.4), 0.05);
    }
    await w!.pause(1.0);
  });
}

// -- fifty moves ---------------------------------------------------------------------------------

/**
 * Fifty moves and nothing taken: asleep. All four hands come down onto the rails and lie there,
 * fingers on the wood, breathing slowly. One twitches. Then it starts awake, and looks one way and
 * the other; and they all get up.
 */
async function asleep(cast: Cast): Promise<void> {
  settle(cast, 'drawn');
  const parts: [Puppeteer, 'right' | 'left'][] = [...both(cast, 'right'), ...both(cast, 'left')];
  const waker = Math.min(3, Math.floor(cast.chance('asleep-waker') * 4));
  await together(parts, async (acts, ok) => {
    // Down, all of them, each in its own time.
    const lain = await Promise.all(acts.map(async (it, i) => ((await it.pause(0.25 * i)) ? it.rail() : null)));
    if (!ok() || lain.some((place) => !place)) return;
    for (const it of acts) {
      it.pose(it.hand.pose, 0.1);
      void it.lean({ glow: 0, tip: 0.1 }, 1.2);
    }
    // Asleep: each breathing slowly, and not in step; the wrist sinks and rises a little, the
    // fingertips staying where they lie on the wood.
    const places = lain.map((place) => place!.clone());
    const index = acts[waker]!.hand.touch.index;
    const wood = index?.y ?? 0;
    const sleep = 2.6;
    const slept = await acts[0]!.during(sleep, (k) => {
      const t = k * sleep;
      acts.forEach((it, i) => it.shift(places[i]!.clone().setY(places[i]!.y - 0.035 * (1 - Math.cos(t * 1.7 + i * 1.3)))));
      // The twitch: its index lifts off the wood, and comes down again.
      if (index) index.y = wood + 0.12 * bump((t - 1.7) / 0.16);
    });
    if (!slept || !ok()) return;
    // Awake! Up off the wood at once, fingers wide; it looks one way, and the other.
    const it = acts[waker]!;
    await it.lift(0.06);
    it.speed(16);
    const woken = places[waker]!.clone().add(at(0, 0.95, 0.35));
    it.shift(woken, -0.35);
    // Up off the wood first, fingers tipping up, and clear of whatever stands by the rail: then
    // they fly open, and not into it.
    if (!(await it.pause(0.2))) return;
    it.pose(POSES.splay, 0.14, 0.01);
    if (!(await it.pause(0.3))) return;
    it.speed(10);
    for (const look of [0.5, -0.5, 0]) {
      it.aim(look);
      if (!(await it.pause(0.4))) return;
    }
    it.aim(null);
    // The others wake too, slowly, one after another.
    for (const [i, other] of acts.entries()) {
      if (i === waker) continue;
      void other.lift(0.4);
      void other.lean({ glow: 0 }, 0.5);
      if (!(await other.pause(0.3))) return;
    }
    // Up off the wood, all of them, before any fingers straighten: or they would straighten into it.
    await it.pause(0.8);
  });
}

// -- too little left -----------------------------------------------------------------------------

/**
 * Neither side has enough left to mate with: each side's left hand turns over, looks, and shakes
 * itself out, three times, like an empty purse. (The left, as for the wave: see `gone`.)
 */
async function emptyPurse(cast: Cast): Promise<void> {
  settle(cast, 'drawn');
  await together(both(cast, 'left'), async ([w, b]) => {
    const hands = [w!, b!];
    // Over its own corner of the case, not much above where it rests, and in toward the middle a
    // little (or it would be in the face of a camera behind its player); the fingers turned out from
    // the board, so that shaken they go nowhere near the stones.
    const place = at(-3.7, 2.3, 5.0);
    for (const it of hands) {
      it.speed(6);
      it.pose(CUPPED, 0.6);
      it.go(place, { heading: 0.55, pitch: 0.05, roll: -0.15 }, 0.85);
    }
    if (!(await w!.pause(1.0))) return;
    // Turned up, and looked into.
    for (const it of hands) {
      it.speed(7);
      it.roll(-2.85);
      it.shift(at(place.x, place.y + 0.15, place.z), -0.1);
    }
    if (!(await w!.pause(0.9))) return;
    // Over again, the fingers loose and hanging; and shaken out, three times.
    for (const it of hands) {
      it.roll(-0.1);
      it.pose(POSES.release, 0.35);
      it.shift(place, 0.45);
    }
    if (!(await w!.pause(0.5))) return;
    for (let shake = 0; shake < 3; shake++) {
      for (const it of hands) it.speed(40);
      const shook = await w!.during(0.36, (k) => {
        for (const it of hands) it.shift(at(place.x, place.y + 0.13 * Math.sin(k * Math.PI * 6) * (1 - 0.5 * k), place.z), 0.45 + 0.12 * Math.sin(k * Math.PI * 6 + 0.6));
      });
      if (!shook || !(await w!.pause(0.28))) return;
    }
    for (const it of hands) it.speed(6);
    await w!.pause(0.4);
  });
}

// -- agreed --------------------------------------------------------------------------------------

/**
 * A draw agreed: the handshake. The hand that was offered is already open; the other side's right
 * hand comes to the middle of the board, and the offered one comes to meet it. They clasp, thumbs
 * over. One pump, down and up, and on it the board rings from both kings (director.ts). They let go
 * and go. If an offer was refused earlier in the game, the pump is very short, and both let go first.
 */
async function handshake(cast: Cast): Promise<void> {
  settle(cast, 'drawn');
  const offerer = cast.offered;
  await together(both(cast), async ([w, b], ok) => {
    const acts: Record<Side, Act> = { w: w!, b: b! };
    // The palm, against the other's: the point under the middle of the palm, on its skin.
    const focus = new Vector3(0, -0.34, -1.25);
    const clasp: Stance = { heading: 0.05, pitch: 0.12, roll: -1.5, focus };
    // Where they meet: the middle of the board, each palm on the other's. The palm faces its
    // player's left, so each is a little to its own right of the middle.
    const meet = at(0.02, UPRIGHT_HIGH, 0);
    const reach = at(0.25, UPRIGHT_HIGH + 0.05, 0.9);
    const first = offerer ? opposite(offerer) : 'w';
    const second = opposite(first);
    for (const side of [first, second]) {
      const it = acts[side];
      it.steady(true);
      it.speed(6);
      it.pose(OFFERED_HAND, 0.6);
      if (side === first) it.go(reach, clasp, 1.0);
    }
    if (!(await w!.pause(0.4))) return;
    acts[second].go(reach, clasp, 0.95);
    if (!(await w!.pause(1.1))) return;
    // In, palm to palm, and the fingers close round.
    for (const it of [w!, b!]) {
      it.speed(9);
      it.shift(meet);
    }
    if (!(await w!.pause(0.35))) return;
    for (const it of [w!, b!]) it.pose(CLASPED, 0.25, 0.02);
    if (!(await w!.pause(0.35))) return;
    // One pump: down, and up. Very short, if there was an offer refused.
    const short = cast.refused;
    if (short) for (const it of [w!, b!]) it.pose(OFFERED_HAND, 0.18, 0.01);
    const depth = short ? 0.08 : 0.22;
    const time = short ? 0.28 : 0.5;
    let pumped = false;
    for (const it of [w!, b!]) it.speed(30);
    const shook = await w!.during(time, (k) => {
      for (const it of [w!, b!]) it.shift(at(meet.x, meet.y - depth * Math.sin(Math.PI * k), meet.z));
      if (k > 0.45 && !pumped) {
        pumped = true;
        cast.heard('pump', w!.room(meet), short ? 0.4 : 1);
      }
    });
    if (!shook || !ok()) return;
    if (!(await w!.pause(short ? 0.1 : 0.3))) return;
    // Let go; apart; and home.
    for (const it of [w!, b!]) {
      it.pose(OFFERED_HAND, 0.25, 0.02);
      it.speed(7);
      it.shift(reach);
    }
    await w!.pause(0.45);
  });
}
