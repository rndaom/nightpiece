/**
 * Both players' hands, and how a chess move becomes something they do.
 *
 * The rules core says what happened (this piece went there, that one was
 * taken, the rook came round); this file decides which hand does which part
 * and in what order, and keeps the taken pieces standing on the plinth's
 * ledge beside the board.
 */
import { type Camera, Group, Vector3, type WebGLRenderer } from 'three';
import { type DrawReason, type Kind, type MoveEvent, opposite, type Side, type Square, type Status } from '../core/game';
import { PLINTH_TOP, squareCenter } from '../scene/layout';
import { PIECE_HEIGHT } from '../scene/pieceShapes';
import type { PieceLayer, Puppet } from '../scene/pieces';
import { Easing, type Tweens } from '../scene/tween';
import { Girth } from './girth';
import { type Ending, isEnding, playEnding } from './endings';
import { Ground } from './ground';
import { type HandTemplate, PALM_FOCUS } from './hand';
import { draw, type Found, Manners, type Moved, type Poked, type Told } from './manners';
import { Shake } from './shake';
import { ARM_GONE_BEFORE, ARM_WHOLE_TO, NEAR_GONE_IN, NEAR_WHOLE_TO, RIM } from './material';
import { type Arm, type CarryOptions, type PieceGrip, Puppeteer } from './puppeteer';
import { Silhouette } from './silhouette';
import { chooseFall, crownOf, layOver } from './topple';
import { Trail } from './trail';

/** Which piece of a move a beat belongs to, and which beat. */
export type OnBeat = (part: 'mover' | 'victim' | 'rook', beat: Parameters<NonNullable<CarryOptions['onBeat']>>[0]) => void;

/**
 * Taken pieces stand in the case's drawers, out on the baize (the "ledge"): one drawer under each
 * side rail of each half. How far out from the board's centre line their middle is, where the
 * first stands (nearest its player's end) and how they are spaced toward the hinge, how far to
 * either side of the drawer's middle line they stand by turns (so that each stands clear of the
 * next, foot from foot), and how many one drawer holds. A player's two drawers hold fourteen; the
 * fifteenth stone a player takes goes into the other half's drawer, at its hinge end.
 */
export const LEDGE_X = 5.33;
export const LEDGE_FIRST = 4.07;
export const LEDGE_STEP = 0.59;
export const LEDGE_ZIG = 0.17;
export const LEDGE_ROOM = 7;

/**
 * Castling takes both of a player's hands in one place. The king goes straight to its square, lifted
 * well clear, under a hand that has it from above and so stands high; the rook swings round the front
 * of it, low, this far out toward its own player, under a hand held flat, which the other arm reaches
 * across.
 */
const KING_OVER: CarryOptions = { apex: 1, reach: 'over' };
/** A piece that takes another standing nearer to it than this many squares is too near for both hands to be over them at once. */
const CROWDED = 2.6;
/** A taken piece is off its square, for the hand that waits to take its place, when its foot is this high or it is this far aside. */
const GONE_UP = 0.5;
const GONE_ASIDE = 0.6;
/** How much the loss of a stone is felt by the hands of the player who lost it, 0 to 1. */
const LOSS: Record<Kind, number> = { p: 0.15, n: 0.45, b: 0.45, r: 0.7, q: 1, k: 1 };
const ROOK_ROUND = 1.65;
/** Taken in passing, the hand that lifts the taken pawn away waits at least this long for the other to have let go of its own. */
const PASSING_WAITS = 1.5;
/** A king that is patted keeps the hand over it this much longer, and this much more for a second tap: the rook's hand under it waits for it. */
const PAT_STAYS = 1.1;
const PAT_STAYS_MORE = 0.3;
/** A queen taken is held up this long at the top of her carry (the trophy): a little longer than she is seen quite still there, since the hand takes a moment to stop. */
const TROPHY_SECONDS = 0.6;
/** A stone to be squared up is set down this far off the middle of its square, and turned this far. */
const ASKEW_BY = 1 / 12;
const ASKEW_TURN = 0.07;

/** How many motes a second a hand lets go of: waiting, at work, in fast flight; and while it is being made or unmade. */
const MOTES_AT_REST = 0.45;
const MOTES_AT_WORK = 0.8;
const MOTES_IN_FLIGHT = 7;
const MOTES_UNMADE = 44;
/** How strongly a hand at work lights the stone right under it. */
const GROUND_LIGHT = 0.05;

/** The way toward the other player, for each side. */
const FORWARD: Record<Side, Vector3> = { w: new Vector3(0, 0, -1), b: new Vector3(0, 0, 1) };
/**
 * A king that has been laid down strikes the board, and rocks: how far back up it comes each
 * time, how long that takes, and how hard it comes down again. One that only leans on its
 * neighbour settles against it once.
 */
const ROCKS: [number, number, number][] = [
  [0.12, 0.26, 0.45],
  [0.045, 0.18, 0.2],
];
const SETTLES: [number, number, number][] = [[0.02, 0.14, 0.15]];

/**
 * What the hands do that can be heard, apart from the stones: a fingertip on the case or on a stone,
 * a stone going over or rapped on the board, two hands meeting, glass struck on glass (the scuffle),
 * the pump of a handshake, fingers snapped, a knuckle cracked, and a hand come too near a flame.
 */
export type Heard = 'tap' | 'knock' | 'meet' | 'chime' | 'pump' | 'snap' | 'crack' | 'burn';

/** The hands have been in the room this long when they are asked what they make of sitting down. */
const SITS_AFTER = 1.6;
/** Void's answer to knuckles cracked comes this long after, one time in this many. */
const ANSWERS_AFTER = 4.2;
const ANSWERS = 1 / 4;
/** A hand kept waiting this long has gone to sleep on the rail, if it was lying there. */
const ASLEEP_AFTER = 120;
/** A captive is held up this long to be looked at, this high; and the hand that lost it feels it this much. */
const CAPTIVE_SECONDS = 0.9;
const CAPTIVE_UP = 0.8;
const CAPTIVE_FELT = 0.12;
/** A stone has been turned to, and not only passed over, when a hand has hung over it this long; and one turned to a third time is set straight when it has hung this long. */
const VISIT = 0.35;
const ADJUST_AFTER = 0.45;
/** How far round a stone is turned, and back, as it is set straight. */
const ADJUST_TURN = 0.09;
/** A pawn that has given mate hops this high, this long after it is let go. */
const HOP = 0.09;
const HOP_AFTER = 0.3;
/** The winner's hand comes back to lay the mated king down this long after the mate. */
const LAID_AFTER = 4.4;
/** How much quicker each capture of an exchange on one square is made than the one before it, and after how many it is made no quicker. */
const QUICKENS = 1.15;
const QUICKENS_AT_MOST = 3;
/** How near the pointer must be to a resting hand's palm to be over it, and to a weight to pull it, as shares of the picture's height; how hard a pulled weight is pushed; and how long a hand that has waved does not wave again. */
const HAND_NEAR = 0.11;
const WEIGHT_NEAR = 0.035;
const WEIGHT_PUSH = 3.4;
const WAVE_REST = 20;

/** What stones are worth, as players count them: what `Told.ahead` is counted in. */
const WORTH: Record<Kind, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** How a game came to be over, as far as its ending is told it (director.ts). */
export interface Ended {
  result: Status['result'];
  drawReason?: DrawReason | null;
  ended?: Told['ended'];
}

/** What is left of a move once its stones are down (Stage.tails). */
interface Tail {
  /** Stop what can be stopped at once, leaving every stone as the game has it. */
  cut: () => void;
  /** Resolves when nothing is left of it. */
  done: Promise<unknown>;
}

/** The longest a move or a take-back waits for what is left of the move before it (a taken stone still on its way to the drawer). */
const TAIL_WAITS_AT_MOST = 3;

interface Slot {
  /** +1 for the ledge on the world's +x side, -1 for the other. */
  ledge: 1 | -1;
  index: number;
}

export class Stage {
  readonly root = new Group();
  readonly hands: Record<Side, Puppeteer>;
  /** Where each taken piece stands, by the side that took it. */
  private slots: Record<Side, Map<number, Slot>> = { w: new Map(), b: new Map() };
  private generation = 0;
  private watched: Vector3[] = [];
  /** The motes each player's hands shed. */
  private trails: Record<Side, Trail>;
  /** Where each palm was last frame, and how nearly each hand is due to shed its next mote. */
  private palms = new Map<object, Vector3>();
  private due = new Map<object, number>();
  /** What the hands do to the stone under them. */
  private ground = new Ground();
  /** Wrist to fingertips, and wrist to the far end of the forearm, in the hand's own space; and half the forearm's width and depth there. */
  private reach: number;
  private back: number;
  private girth: [number, number];
  private palm = new Vector3();
  private wrist = new Vector3();
  private tips = new Vector3();
  private mote = new Vector3();
  /** The hands as the eye sees them, which their glass goes by (silhouette.ts). */
  private silhouette: Silhouette;
  /** What the hands do that is not chess, and what it is chosen by (manners.ts). */
  readonly manners = new Manners();
  /** What the manners' chances are drawn from: the room's name, online; otherwise something of this sitting's own. */
  private seed: string | null = null;
  private salt = Math.floor(Math.random() * 0x7fffffff).toString(36);
  private games = 0;
  /** Plies played, whose turn it is, the time now and the time the last move was made. */
  private ply = 0;
  private turn: Side | null = null;
  private time = 0;
  private since = 0;
  private plain = false;
  /** The player has asked their machine for less motion: only the rituals are played. */
  quiet = false;
  /** Told of what the hands do that can be heard: what, where, and how hard (0 to 1). */
  heard: ((what: Heard, at: Vector3, strength: number) => void) | null = null;
  /** A king that has been laid down, and where and how it stood; the laying of it, while that is going on; and a count that moves on whenever the game's ending is acted or undone. */
  private fallen: { group: Puppet['group']; id: number; base: Vector3; facing: number } | null = null;
  private tipping: Promise<void> | null = null;
  private ends = 0;
  /** Who made the last move; who has a draw on offer, if anybody; and whether an offer has been refused in this game. */
  private last: Side | null = null;
  private offering: Side | null = null;
  private refused = false;
  /** For each ply played: its move, what it took, and whether it gave check. And the move last made, and what was told of it. */
  private record: Played[] = [];
  private moved: Moved | null = null;
  private told: Partial<Told> = {};
  /** The stone each side's hand hangs over in thought, and since when; and how many times each stone has been turned to and let go this turn. */
  private thought: Record<Side, { id: number; since: number; adjusted: boolean } | null> = { w: null, b: null };
  private visits: Record<Side, Map<number, number>> = { w: new Map(), b: new Map() };
  /** The flames of the candles at the corners of the board; and the ones a hand has been burned at in this game. */
  private candles: Vector3[] = [];
  private burned = new Set<Vector3>();
  /** How the pointer has been moving over each resting hand; when a hand last waved back; and which way the last weight was pushed. */
  private shakes = new Map<object, Shake>();
  private waved = -Infinity;
  private pushed = 1;
  /** The game is a lesson; it is played against a clock. */
  private lesson = false;
  private timed = false;
  /**
   * What is left of each side's last move once its stones were down (a stone being squared up, a
   * king patted, a snap, a taken stone on its way to the drawer): how to cut it short, and when it is
   * over.
   */
  private tails: Record<Side, Tail | null> = { w: null, b: null };

  constructor(
    template: HandTemplate,
    private pieces: PieceLayer,
    private tweens: Tweens,
    grips: Record<Kind, PieceGrip>,
  ) {
    const gripOf = (puppet: Puppet) => grips[puppet.kind];
    const around = () => this.around();
    this.hands = {
      w: new Puppeteer(template, 'w', tweens, gripOf, around),
      b: new Puppeteer(template, 'b', tweens, gripOf, around),
    };
    this.trails = { w: new Trail(RIM.w), b: new Trail(RIM.b) };
    this.root.name = 'hands';
    this.reach = template.meta.length;
    this.back = template.meta.forearmLength;
    this.girth = template.meta.forearmEnd;
    this.root.add(this.ground.mesh, this.hands.w.root, this.hands.b.root, this.trails.w.points, this.trails.b.points);
    this.silhouette = new Silhouette(this.root);
    for (const arm of this.arms()) arm.hand.useSilhouette(this.silhouette);
    for (const side of ['w', 'b'] as const) this.hands[side].idle = () => this.idle(side);
    this.manners.begin(this.seedNow());
  }

  /** All four arms. */
  private arms() {
    return [this.hands.w.right, this.hands.w.left, this.hands.b.right, this.hands.b.left];
  }

  /**
   * Read the shape of every stone that is standing, so that the first hand to reach among them
   * does not stop to: a hand's way is worked out from all of them at once.
   */
  warm(): void {
    for (const puppet of this.pieces.standing()) Girth.of(puppet.group);
  }

  /**
   * Build what the hands draw into a picture of their own (the picture of how near they are,
   * silhouette.ts), which is otherwise built in the frame of the first move. Resolves when it is ready.
   */
  warmPictures(renderer: WebGLRenderer, camera: Camera): Promise<unknown> {
    return this.silhouette.warm(renderer, camera);
  }

  /** How much the hands may cost to draw: on 'low' they do without what a weak machine cannot spare. */
  setQuality(quality: 'low' | 'medium' | 'high'): void {
    for (const arm of this.arms()) arm.hand.setDetail(quality === 'low' ? 'low' : 'full');
  }

  /** The height of the picture in pixels, for the size of the motes. */
  setViewportHeight(pixels: number): void {
    this.trails.w.setViewportHeight(pixels);
    this.trails.b.setViewportHeight(pixels);
  }

  /** A new game: hands to rest, the ledges cleared. The piece layer rebuilds the pieces itself. */
  reset(): void {
    this.generation++;
    this.ends++;
    this.fallen = null;
    this.tipping = null;
    this.last = null;
    this.offering = null;
    this.refused = false;
    this.record = [];
    this.moved = null;
    this.told = {};
    this.forget();
    this.burned.clear();
    this.tails = { w: null, b: null };
    this.ply = 0;
    this.since = this.time;
    this.games++;
    this.manners.begin(this.seedNow());
    this.slots.w.clear();
    this.slots.b.clear();
    this.hands.w.reset();
    this.hands.b.reset();
    this.trails.w.clear();
    this.trails.b.clear();
    this.palms.clear();
    this.due.clear();
  }

  /**
   * Stand the pieces taken so far on the ledges, where the hands would have put them. For a
   * game that is joined part of the way through, after the piece layer has set up the position.
   */
  seatTaken(history: MoveEvent[]): void {
    this.record = history.map(played);
    // How each of those moves was set down is chosen again, as every other screen chose it, so that
    // what the moves have spent of the game's budget is counted here too (manners.ts).
    history.forEach((e, i) => {
      this.ply = i + 1;
      this.manners.choose('set', this.facts(e.side, { ...this.tellOf(e, i), quiet: false }));
    });
    this.ply = history.length;
    this.moved = null;
    for (const e of history) {
      const c = e.captured;
      if (!c) continue;
      const player = this.hands[e.side];
      const remover = player.other(this.moverOf(e));
      const spot = this.claim(e.side, remover === player.right, c.id);
      const victim = this.pieces.restore(c.id, c.kind, e.side === 'w' ? 'b' : 'w', c.square);
      this.pieces.retire(c.id);
      victim.group.position.copy(spot);
      victim.energy = 0;
    }
  }

  /** Bring the hands into the room. */
  appear(): void {
    this.hands.w.appear();
    this.hands.b.appear();
    // Sitting down (manners.ts): once they are drawn in, if no move has been made by then.
    const generation = this.generation;
    void this.tweens.wait(SITS_AFTER).then(() => {
      if (generation === this.generation && this.ply === 0 && this.turn !== null) this.sit();
    });
  }

  /** Where the candles at the corners of the board burn. */
  setCandles(flames: Vector3[]): void {
    this.candles = flames.map((f) => f.clone());
    this.burned.clear();
  }

  /** Whose turn it is, so that their hands lean in and the other's sit back. Null when the game is over. */
  setTurn(side: Side | null): void {
    this.turn = side;
    this.hands.w.setAttentive(side === 'w');
    this.hands.b.setAttentive(side === 'b');
  }

  /** A player turns their thought to the piece on a square, or (with null) away from the board. */
  consider(side: Side, square: Square | null): void {
    // The player to move has turned to the board: what is left of the other's move gives way.
    if (square) this.cut(opposite(side));
    const puppet = square ? this.pieces.puppetAt(square) : null;
    const mine = puppet && puppet.side === side ? puppet : null;
    const before = this.thought[side];
    const left = before && before.id !== mine?.id ? before : null;
    this.hands[side].consider(mine);
    if (left) {
      const held = this.time - left.since;
      if (held >= VISIT) this.visits[side].set(left.id, (this.visits[side].get(left.id) ?? 0) + 1);
      // Second thought (manners.ts): left for another after a while, the finger wags as the hand goes, and the stone passed over lets its eye fall.
      const was = this.pieces.puppet(left.id);
      if (mine && was && this.manners.choose('think', this.facts(side, { held })) === 'second-thought') {
        this.hands[side].wag(this.hands[side].armOver(was));
        this.pieces.blink(left.id);
      }
    }
    if (!mine) this.thought[side] = null;
    else if (before?.id !== mine.id) this.thought[side] = { id: mine.id, since: this.time, adjusted: false };
  }

  /**
   * The computer is about to move the stone on `from`, and could have moved one of those on
   * `others`: now and then its hand goes to one of those first, and thinks better of it
   * (manners.ts, the feint). Resolves when it has, at once if it does not.
   */
  async feint(side: Side, from: Square, others: Square[]): Promise<void> {
    const could = others.filter((square) => square !== from && this.pieces.puppetAt(square)?.side === side);
    if (this.manners.choose('think', this.facts(side, { computer: true, feint: could.length > 0 })) !== 'feint') return;
    const puppet = this.pieces.puppetAt(could[Math.floor(draw(this.seedNow(), this.ply, 'feint, at which') * could.length)]!);
    if (puppet) await this.hands[side].feint(puppet);
  }

  /**
   * What the player at this screen does to their own hands (manners.ts, `Poked`): the pointer is at
   * (`x`, `y`) in the picture, each from -1 to 1, `pressed` if it has just been pressed there, and
   * `sides` are the hands this screen moves. A pointer shaken over a resting hand is waved back at;
   * a weight that is pressed on is set swinging.
   */
  pointer(camera: Camera, x: number, y: number, sides: readonly Side[], pressed: boolean): void {
    const aspect = (camera as { aspect?: number }).aspect ?? 1;
    const near = (p: Vector3) => {
      const seen = p.project(camera);
      return seen.z < 1 ? Math.hypot((seen.x - x) * aspect, seen.y - y) / 2 : Infinity;
    };
    for (const side of sides) {
      const player = this.hands[side];
      for (const arm of [player.right, player.left]) {
        if (pressed) {
          if (near(arm.hand.weightWorld(this.mote)) > WEIGHT_NEAR) continue;
          // Pushed across the picture, one way and then the other.
          this.pushed = -this.pushed;
          arm.hand.pullWeight(this.mote.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(WEIGHT_PUSH * this.pushed));
          this.poke(side, 'weight', arm);
          return;
        }
        let shake = this.shakes.get(arm);
        if (!shake) this.shakes.set(arm, (shake = new Shake()));
        const over = !arm.busy && !arm.considering && !arm.gesturing && near(arm.hand.toWorld(PALM_FOCUS, this.mote)) < HAND_NEAR;
        if (!over) shake.clear();
        else if (shake.feed((x * aspect) / 2, this.time)) this.poke(side, 'wave', arm);
      }
    }
  }

  /** The player at this screen has done something to `side`'s hands, which are theirs: what the hands make of it, if anything. */
  poke(side: Side, what: Poked, arm: Arm = this.hands[side].right): boolean {
    if (what === 'wave' && this.time - this.waved < WAVE_REST) return false;
    if (what === 'back' && this.turn === null) return false;
    if (this.manners.choose('poke', this.facts(side, { poked: what })) === null) return false;
    const player = this.hands[side];
    if (what === 'wave') {
      this.waved = this.time;
      player.wave(0, true, arm);
    } else if (what === 'weight') player.lookAtWeight(arm);
    else player.wakes();
    return true;
  }

  // -- what the hands make of the game: told by the director, which knows what a move meant --

  /** `by` has given check to the king that stands at `king`: one of their hands points at it, and the other player's start back. */
  check(by: Side, king: Vector3): void {
    const other = opposite(by);
    // It wears off (manners.ts): checks given one after another are made less of each time.
    const name = this.manners.choose('after', this.facts(by, { move: this.moved, checks: this.checksBy(by) }));
    if (name === 'check-again') {
      this.hands[by].point(king, true);
      this.hands[other].startle(0.5);
    } else if (name === 'check-thrice') {
      this.hands[by].liftFinger();
      this.hands[other].twitch();
    } else if (name === 'check-on') {
      this.hands[other].drumOnRail((at, strength) => this.heard?.('tap', at, strength));
    } else {
      this.hands[by].point(king);
      this.hands[other].startle();
    }
  }

  /** A stone of `from`'s has been taken: their hands close on themselves, the more for a greater stone. */
  taken(from: Side, kind: Kind): void {
    this.hands[from].wince(LOSS[kind]);
  }

  /** `side` has made a strong move: their hands open, lit. */
  strong(side: Side): void {
    this.hands[side].flourish();
  }

  /** `side` has blundered: their hands sink, and the other player's come in toward the board. */
  blunder(side: Side): void {
    this.hands[side].sag();
    this.hands[side === 'w' ? 'b' : 'w'].perk();
  }

  /**
   * The game is over: won by `winner`, or drawn. If it has `happened` this moment the hands act
   * it out (`struck`: it was mate, and not a game given up); either way they are then held as it
   * leaves them, until the game is being played again.
   */
  over(winner: Side | null, happened: boolean, struck: boolean, how?: Ended): Ending | null {
    const end = ++this.ends;
    const offered = this.offering;
    this.offering = null;
    // An ending of its own, if the way the game ended has one (manners.ts): a king laid down has had its own already.
    const ending = happened && how && !(how.result === 'resigned' && !how.ended) ? this.ending(winner, how) : null;
    if (ending) {
      const cast = {
        hands: this.hands,
        winner,
        last: this.last ?? 'w',
        ahead: this.ahead(this.last ?? 'w'),
        offered,
        refused: this.refused,
        fivefold: how?.drawReason === 'fivefold',
        chance: (name: string) => draw(this.seedNow(), this.ply, name),
        heard: (what: 'chime' | 'pump', at: Vector3, strength: number) => this.heard?.(what, at, strength),
      };
      for (const side of ['w', 'b'] as const) this.hands[side].answer('taken');
      // Once nobody is still setting a stone down: the hands of both sides begin it together.
      void this.free().then(() => (end === this.ends ? playEnding(ending, cast) : undefined));
      return ending;
    }
    const act = () => {
      for (const side of ['w', 'b'] as const) this.hands[side].outcome(winner === null ? 'drawn' : winner === side ? 'won' : 'lost', happened, struck);
    };
    // Mate, by what gave it (manners.ts): something of the winner's own before the hands claim it, or after.
    const mate = happened && struck && winner ? this.manners.choose('end', this.facts(winner, { ...this.told, toMove: false, result: 'checkmate', winner, happened: true })) : null;
    if (winner && (mate === 'back-rank' || mate === 'mate-by-castling' || mate === 'early-mate')) {
      const victor = this.hands[winner];
      this.hands[opposite(winner)].outcome('lost', true, true);
      void (async () => {
        await this.free();
        if (end !== this.ends) return;
        await (mate === 'back-rank' ? this.sweepRank(winner) : mate === 'mate-by-castling' ? victor.bow() : victor.brush());
        // An early mate is not claimed: the hand that brushed it off only comes to hang as a winner's does.
        if (end === this.ends) victor.outcome('won', true, mate !== 'early-mate');
      })();
      return null;
    }
    if (winner && mate === 'laid-down') {
      void (async () => {
        await this.free();
        await this.tweens.wait(LAID_AFTER);
        if (end === this.ends) await this.layDown(winner, end);
      })();
    }
    // A king is being laid down: the hands act the ending out when it is down, and not across it.
    if (this.tipping && happened) void this.tipping.then(() => end === this.ends && act());
    else act();
    return null;
  }

  /**
   * A draw has been offered by `side`, or (null) the offer there was is over: `refused` by the other
   * player, or `withdrawn` by the one who made it. An offer that is taken is the end of the game,
   * and `over` sees to that.
   */
  offer(side: Side | null, how: 'refused' | 'withdrawn' = 'withdrawn'): void {
    if (side) {
      if (this.offering && this.offering !== side) this.hands[this.offering].answer('withdrawn');
      this.offering = side;
      this.hands[side].offer();
      return;
    }
    const was = this.offering;
    this.offering = null;
    if (!was) return;
    if (how === 'refused') this.refused = true;
    this.hands[was].answer(how);
  }

  /** The game is being played: after one that was over has been taken back, or another position stood. */
  resume(): void {
    this.ends++;
    this.stand();
    this.hands.w.resume();
    this.hands.b.resume();
  }

  /**
   * `loser` has given the game up. If a player did it (and not a clock, or a server), their own
   * hand lays their king down: this is then true, `down` is called when the king strikes the
   * board, and `knock` each time it does, with where and how hard. A game found already given up
   * (`happened` false) has its king lying, and nothing more.
   */
  concedes(loser: Side, happened: boolean, ended: Told['ended'], down: () => void, knock: (at: Vector3, strength: number) => void): boolean {
    let king: Puppet | null = null;
    for (const p of this.pieces.standing()) if (p.kind === 'k' && p.side === loser) king = p;
    if (!king || ended !== null) return false;
    if (this.fallen?.group === king.group) return true;
    if (!happened) {
      const base = king.group.position.clone();
      const facing = king.group.rotation.y;
      const fall = chooseFall(king, this.around(), FORWARD[loser]);
      this.fallen = { group: king.group, id: king.id, base, facing };
      layOver(king, base, facing, fall, fall.rest);
      return true;
    }
    const facts = this.facts(loser, { toMove: false, result: 'resigned', winner: opposite(loser), happened: true, ended });
    if (this.manners.choose('end', facts) !== 'tip-the-king') return false;
    const tipping: Promise<void> = this.tip(king, down, knock).finally(() => {
      if (this.tipping === tipping) this.tipping = null;
    });
    this.tipping = tipping;
    return true;
  }

  /** Whether the game is one in which only what the board shows is told (director.ts, `plain`). */
  setPlain(plain: boolean): void {
    this.plain = plain;
  }

  /** Whether the game is a lesson. */
  setLesson(lesson: boolean): void {
    this.lesson = lesson;
  }

  /** Whether the game is played against a clock: the same on every screen at the board. */
  setTimed(timed: boolean): void {
    this.timed = timed;
  }

  /** Resolves once nothing is left of the moves made so far, or after a few seconds whatever is. */
  settled(): Promise<void> {
    const left = [this.tails.w?.done, this.tails.b?.done].filter((done) => done !== undefined);
    return Promise.race([Promise.all(left).then(() => undefined), this.tweens.wait(TAIL_WAITS_AT_MOST)]);
  }

  /** Cut short what is left of `side`'s last move. */
  private cut(side: Side): void {
    this.tails[side]?.cut();
  }

  /**
   * Cut short what is left of both sides' last moves; and if anything of them cannot be cut (a stone
   * still on its way to the drawer), what to wait for. Null if there is nothing.
   */
  private finish(): Promise<void> | null {
    this.cut('w');
    this.cut('b');
    return this.tails.w || this.tails.b ? this.settled() : null;
  }

  /** What the manners' chances are to be drawn from, from the next game on: the same for everyone at the same board. Null for this sitting's own. */
  setSeed(seed: string | null): void {
    this.seed = seed;
  }

  /**
   * Play a move that the rules core has already applied. Resolves when every stone it moves is down
   * on its square and let go, and every stone it takes is off the board: what the hands do after
   * that (a stone squared up, a king patted, the snap, the taken stone carried to the drawer) goes
   * on as the next player is free to play, and gives way to them (`tails`). `onBeat` is told as
   * each piece is reached for, lifted and set down.
   */
  async playMove(e: MoveEvent, onBeat?: OnBeat): Promise<void> {
    const generation = this.generation;
    // Whatever is left of the moves before it gives way.
    const finishing = this.finish();
    if (finishing) {
      await finishing;
      if (generation !== this.generation) return;
    }
    this.ply++;
    this.last = e.side;
    this.record.length = this.ply - 1;
    this.record.push(played(e));
    const told = (this.told = this.tellOf(e, this.ply - 1));
    this.moved = movedBy(e);
    this.forget();
    // Whoever was passing the time while this move was waited for has done with it.
    this.hands.w.attend();
    this.hands.b.attend();
    const player = this.hands[e.side];
    const mover = this.pieces.hold(e.piece.id);
    if (!mover) return;
    // What has to be done before the next player may play; and what may go on after it, and how to cut that short.
    const jobs: Promise<unknown>[] = [];
    const left: Promise<unknown>[] = [];
    const cuts: (() => void)[] = [];
    // How the stone is to be set down, if it is to be set down in a way of its own (manners.ts).
    const manner = this.manners.choose('set', this.facts(e.side, told));
    // A king that has castled is patted, now and then; one stepped up on its side's second move always is, and a knight that has smothered a king, and a pawn that has taken a rook or a queen.
    const pats = manner === 'pat' ? (e.castle === 'q' ? 2 : 1) : manner === 'bongcloud' || manner === 'bongcloud-both' || manner === 'smothered' || manner === 'small-takes-great' ? 1 : 0;
    // A capture that answers a capture on the same square is made quicker than the one before it.
    const pace = QUICKENS ** this.exchange(this.ply - 1);

    // Castling takes both hands at once: the hand on the rook's side takes the rook, the other the king.
    const rook = e.rook ? this.pieces.hold(e.rook.id) : null;
    const moverArm = this.moverOf(e);
    player.engage(moverArm);
    player.consider(null);
    let moverDelay = 0;
    let crowded = false;
    let gone: (() => boolean) | undefined;
    // Taken in passing, the capturing pawn goes first, and the taken one is lifted away once it is down.
    const passing = manner === 'empty-square';
    let letGo = false;

    if (e.captured) {
      // The other hand lifts the taken piece away first; the capturing hand follows it in.
      const victim = this.pieces.retire(e.captured.id);
      if (victim) {
        const remover = player.other(moverArm);
        const spot = this.claim(e.side, remover === player.right, victim.id);
        // Where the two stand close together the hands would be one on top of the other: the
        // capturing hand draws off to its own side, and comes in when the taken piece is off the board.
        crowded = Math.hypot(victim.group.position.x - mover.group.position.x, victim.group.position.z - mover.group.position.z) < CROWDED;
        if (crowded && !passing) {
          const stood = victim.group.position.clone();
          const p = victim.group.position;
          gone = () => p.y > GONE_UP || Math.hypot(p.x - stood.x, p.z - stood.z) > GONE_ASIDE;
        }
        // A queen is held up on her way to the drawer: and so is one a pawn took, as the pawn is patted.
        const show = manner === 'trophy' || (manner === 'small-takes-great' && e.captured.kind === 'q' && told.tookBefore !== 'q') ? { show: TROPHY_SECONDS } : {};
        const after = passing ? { delay: PASSING_WAITS, makeWay: true, until: () => letGo } : {};
        // The taken stone has only to be off the board: the hand takes it on to the drawer as the game goes on.
        let off: () => void = () => undefined;
        const lifted = new Promise<void>((resolve) => (off = resolve));
        const carried = player.carry(remover, victim, spot, {
          energy: 0,
          apex: this.apexOver(victim, spot, [mover.id]),
          pace,
          ...show,
          ...after,
          onBeat: (b) => {
            if (b === 'lift') off();
            onBeat?.('victim', b);
          },
        });
        jobs.push(Promise.race([lifted, carried]));
        left.push(carried);
        if (!passing) moverDelay = (crowded ? 0.3 : 0.55) / pace;
      }
    }

    const to = squareCenter(e.piece.to);
    // To be squared up after: which way off, and which way round, is drawn as every manner's chance is.
    const askew = manner === 'squaring-up' ? this.askew() : undefined;
    const lay = () => {
      this.pieces.settle(mover.id, e.piece.to);
      if (askew) {
        mover.group.position.add(askew.by);
        mover.group.rotation.y += askew.turn;
      }
    };
    const beats = (b: Parameters<NonNullable<CarryOptions['onBeat']>>[0]) => {
      // The square is the piece's from the moment it touches down, so that what follows can find it there.
      if (b === 'set' && generation === this.generation) lay();
      if (b === 'release') letGo = true;
      onBeat?.('mover', b);
    };
    const carried =
      manner === 'push'
        ? player.push(moverArm, mover, to, beats)
        : player.carry(moverArm, mover, to, {
            ...(rook && e.rook ? { ...KING_OVER, beside: { puppet: rook, at: squareCenter(e.rook.to) } } : { apex: this.apexOver(mover, to) }),
            delay: moverDelay,
            pace,
            makeWay: crowded && !passing,
            until: gone,
            onBeat: beats,
            ...(passing ? { rap: (at: Vector3) => this.heard?.('knock', at, 0.6) } : {}),
            ...(pats > 0
              ? {
                  pat: {
                    taps: pats,
                    patted: (at: Vector3) => (manner === 'small-takes-great' ? this.pattedSmall(mover, at) : this.patted(mover, at)),
                    patting: (rest: Promise<void>) => {
                      left.push(rest);
                      cuts.push(() => player.letBe(moverArm));
                    },
                  },
                }
              : {}),
            ...(askew ? { askew } : {}),
          });
    jobs.push(
      carried.then(async () => {
        if (generation !== this.generation) return;
        const facing = mover.group.rotation.y;
        lay();
        if (askew) {
          // Squared up as the game goes on: cut short, the stone simply stands as it should.
          left.push(player.squareUp(moverArm, mover, to, facing - askew.turn));
          cuts.push(() => {
            player.letBe(moverArm);
            this.pieces.settle(mover.id, e.piece.to);
          });
          return;
        }
        if (manner === 'home-again') {
          // Never mind: a flick of the fingers, as the game goes on.
          left.push(player.flick(moverArm));
          cuts.push(() => player.letBe(moverArm));
        }
        // A pawn that has given mate hops where it stands.
        if (manner === 'mate-by-pawn') left.push(this.hop(mover, generation));
        if (!e.promotion) return;
        const becomes = e.promotion;
        if (manner !== 'snap') return this.recast(mover, becomes, generation);
        // The stone changes on the snap, and not before: and the snap is made as the game goes on.
        // Cut short, the stone changes at once, and nothing is heard.
        let changed = false;
        const change = () => {
          if (changed || generation !== this.generation) return;
          changed = true;
          left.push(this.recast(mover, becomes, generation));
        };
        left.push(
          player.snap(moverArm, mover, (at, heard) => {
            if (heard && !changed && generation === this.generation) this.heard?.('snap', at, 1);
            change();
          }),
        );
        cuts.push(() => {
          change();
          player.letBe(moverArm);
        });
      }),
    );

    if (rook && e.rook) {
      const to = e.rook.to;
      jobs.push(
        player.carry(player.other(moverArm), rook, squareCenter(to), { ...this.roundTheKing(e, mover, false, manner === 'pat' ? PAT_STAYS + PAT_STAYS_MORE * (e.castle === 'q' ? 1 : 0) : 0), onBeat: (b) => onBeat?.('rook', b) }).then(() => {
          if (generation === this.generation) this.pieces.settle(rook.id, to);
        }),
      );
    }
    await Promise.all(jobs);
    if (generation !== this.generation) return;
    if (left.length > 0) {
      let cut = false;
      const tail: Tail = {
        cut: () => {
          if (cut || generation !== this.generation) return;
          cut = true;
          for (const c of cuts) c();
        },
        done: Promise.resolve(),
      };
      // (What is left may add to itself as it goes, as a snap adds the stone's change.)
      tail.done = (async () => {
        for (let seen = 0; seen < left.length; ) {
          const now = left.length;
          await Promise.all(left);
          seen = now;
        }
        if (this.tails[e.side] === tail) this.tails[e.side] = null;
      })();
      this.tails[e.side] = tail;
    }
    this.since = this.time;
    // What the other side's hands make of it.
    const other = opposite(e.side);
    const after = this.manners.choose('after', this.facts(other, told));
    if (after === 'really') this.hands[other].really(e.promotion === 'b');
    else if (after === 'third-queen') this.hands[other].slacken();
    else if (after === 'copycat') {
      // As one tests a mirror: and the mirror is a little late.
      this.hands.w.wave(0.3);
      this.hands.b.wave(0.6);
    }
    // The king stepped up: the other side's hands turn palm up at it; and if theirs has just done the same, a thumb from each player.
    if (manner === 'bongcloud') this.hands[other].really(true);
    else if (manner === 'bongcloud-both') {
      this.hands[e.side].thumb(0.9);
      this.hands[other].thumb(1.02);
    }
  }

  /** Play a take-back that the rules core has already applied. */
  async playUndo(e: MoveEvent): Promise<void> {
    const generation = this.generation;
    // Whatever is left of the move being taken back, and of the one before it, gives way first.
    const finishing = this.finish();
    if (finishing) {
      await finishing;
      if (generation !== this.generation) return;
    }
    this.manners.takeBack(this.ply);
    this.ply = Math.max(0, this.ply - 1);
    this.record.length = this.ply;
    this.moved = null;
    this.told = {};
    this.forget();
    this.last = opposite(e.side);
    this.since = this.time;
    // Whatever the move being taken back had ended, it has not ended now.
    this.resume();
    const player = this.hands[e.side];
    const mover = this.pieces.hold(e.piece.id);
    if (!mover) return;
    if (e.promotion) this.pieces.recast(mover.id, e.piece.kind);
    const jobs: Promise<void>[] = [];

    const rook = e.rook ? this.pieces.hold(e.rook.id) : null;
    // The hand that made the move takes it back.
    const moverArm = this.moverOf(e);
    player.engage(moverArm);
    player.consider(null);

    jobs.push(
      player.carry(moverArm, mover, squareCenter(e.piece.from), rook && e.rook ? { ...KING_OVER, delay: 0.12, apart: true, beside: { puppet: rook, at: squareCenter(e.rook.from) } } : { apex: this.apexOver(mover, squareCenter(e.piece.from)), retrace: true }).then(() => {
        if (generation === this.generation) this.pieces.settle(mover.id, e.piece.from);
      }),
    );
    if (rook && e.rook) {
      const from = e.rook.from;
      jobs.push(
        player.carry(player.other(moverArm), rook, squareCenter(from), this.roundTheKing(e, mover, true)).then(() => {
          if (generation === this.generation) this.pieces.settle(rook.id, from);
        }),
      );
    }
    if (e.captured) {
      // The taken piece comes back from the ledge once its square is free again.
      const c = e.captured;
      const slot = this.slots[e.side].get(c.id);
      this.slots[e.side].delete(c.id);
      const victim = this.pieces.restore(c.id, c.kind, e.side === 'w' ? 'b' : 'w', c.square);
      // The hand that stood it aside brings it back. That is never the one carrying the mover home,
      // even where its own half of the ledge was full and the piece stands on the other half.
      const arm = player.other(moverArm);
      if (slot) {
        jobs.push(
          player.carry(arm, victim, squareCenter(c.square), { energy: 1, apex: this.apexOver(victim, squareCenter(c.square), [mover.id]), delay: 0.55 }).then(() => {
            if (generation === this.generation) this.pieces.settle(c.id, c.square);
          }),
        );
      } else {
        // It was never stood aside (the hands arrived after it was taken): let it simply return.
        this.pieces.settle(c.id, c.square);
        victim.energy = 1;
      }
    }
    await Promise.all(jobs);
  }

  update(dt: number, time: number): void {
    this.time = time;
    this.hands.w.update(dt, time);
    this.hands.b.update(dt, time);
    this.silhouette.touch();
    this.adjusting();
    this.ground.begin();
    for (const side of ['w', 'b'] as const) {
      const player = this.hands[side];
      const trail = this.trails[side];
      for (const arm of [player.right, player.left]) {
        const hand = arm.hand;
        const whole = 1 - smooth(0.1, 0.7, hand.dissolve);
        // A hand over the stone darkens it, the more the nearer and the more solid it is; and
        // one at work lays a little of its own light there.
        hand.toWorld(this.wrist.set(0, -0.1, 0.35), this.wrist);
        hand.toWorld(this.tips.set(0, -0.35, -0.92 * this.reach), this.tips);
        this.ground.add(this.wrist, this.tips, arm.presence * Math.min(1, hand.fill) * whole, RIM[side], GROUND_LIGHT * hand.energy * hand.outline * whole);

        const palm = hand.toWorld(PALM_FOCUS, this.palm);
        let last = this.palms.get(arm);
        if (!last) this.palms.set(arm, (last = palm.clone()));
        const speed = dt > 0 ? last.distanceTo(palm) / dt : 0;
        last.copy(palm);
        if (hand.outline < 0.3 || dt <= 0) continue;
        let due = this.due.get(arm) ?? trail.random();
        if (hand.dissolve > 0.04 && hand.dissolve < 0.96) {
          // A hand that is arriving or going sheds them from where it is being made or unmade.
          due += MOTES_UNMADE * dt;
          // (The same sum as the shader's: material.ts, vanish.)
          const along = Math.min(1, Math.max(0, (2.2 * hand.dissolve - 0.5) / 0.95));
          for (; due >= 1; due--) {
            this.mote.set((trail.random() - 0.5) * 1.5, (trail.random() - 0.5) * 0.4, this.back - along * (this.back + this.reach));
            trail.shed(hand.toWorld(this.mote, this.mote), time, 0.1, 1.5);
          }
        } else if (hand.dissolve <= 0.04) {
          // One comes loose from where its forearm is thinning away now and then; a scatter of them when it moves fast.
          due += (MOTES_AT_REST + MOTES_AT_WORK * hand.energy + MOTES_IN_FLIGHT * smooth(1.2, 5, speed)) * dt;
          // (Where the eye sees it thin: for one behind the arm that is just past the cord. The same sum as the shader's: material.ts, leftAt.)
          const whole = ARM_WHOLE_TO + (NEAR_WHOLE_TO - ARM_WHOLE_TO) * hand.behind;
          const going = this.back - ARM_GONE_BEFORE - ARM_WHOLE_TO + (NEAR_GONE_IN - (this.back - ARM_GONE_BEFORE - ARM_WHOLE_TO)) * hand.behind;
          for (; due >= 1; due--) {
            const round = trail.random() * Math.PI * 2;
            const from = whole + (0.25 + 0.6 * trail.random()) * going;
            this.mote.set(0.85 * this.girth[0] * Math.cos(round), 0.85 * this.girth[1] * Math.sin(round), from);
            trail.shed(hand.armToWorld(this.mote, this.mote), time, 0.03, 2.4);
          }
        }
        this.due.set(arm, due);
      }
      trail.update(time);
    }
    this.ground.end();
  }

  /** Where the hands that are doing something are: what the pieces watch. */
  attention(): Vector3[] {
    this.watched.length = 0;
    for (const player of [this.hands.w, this.hands.b]) {
      for (const arm of [player.right, player.left]) {
        if (arm.busy || arm.considering) this.watched.push(arm.at.get(arm.watchPoint));
      }
    }
    return this.watched;
  }

  // -- internals --------------------------------------------------------------

  private seedNow(): string {
    return this.seed ?? `${this.salt}-${this.games}`;
  }

  /** What both players can see, as the manners are told it, for `side`'s hands. */
  private facts(side: Side, more: Partial<Told> = {}): Told {
    return {
      ply: this.ply,
      side,
      toMove: this.turn === side,
      waited: this.time - this.since,
      plain: this.plain,
      result: null,
      drawReason: null,
      winner: null,
      happened: false,
      ended: null,
      quiet: this.quiet,
      ahead: this.ahead(side),
      refused: this.refused,
      move: null,
      tookBefore: null,
      checks: 0,
      lesson: this.lesson,
      timed: this.timed,
      held: 0,
      again: 0,
      captive: null,
      candle: false,
      computer: false,
      feint: false,
      mates: false,
      hemmed: false,
      backRank: false,
      found: null,
      queens: 0,
      poked: null,
      ...more,
    };
  }

  /** How far ahead in stones `side` is, by what is standing on the board. */
  private ahead(side: Side): number {
    let by = 0;
    for (const p of this.pieces.standing()) by += (p.side === side ? 1 : -1) * WORTH[p.kind];
    return by;
  }

  /** How many checks running `side` has given, the last move's among them if it gave one. */
  private checksBy(side: Side): number {
    let checks = 0;
    for (let i = this.ply - 1; i >= 0; i -= 2) {
      if (!this.record[i]?.check) break;
      checks++;
    }
    return this.last === side ? checks : 0;
  }

  /** Which way off its square, and which way round, a stone to be squared up is set down: the same on every screen. */
  private askew(): { by: Vector3; turn: number } {
    const way = draw(this.seedNow(), this.ply, 'squaring-up, which way') * Math.PI * 2;
    const round = draw(this.seedNow(), this.ply, 'squaring-up, which way round') < 0.5 ? -1 : 1;
    return { by: new Vector3(Math.cos(way) * ASKEW_BY, 0, Math.sin(way) * ASKEW_BY), turn: round * ASKEW_TURN };
  }

  /** A king that has castled is tapped on its crown: its eye closes for a moment. */
  private patted(king: Puppet, at: Vector3): void {
    this.pieces.blink(king.id);
    this.heard?.('tap', at, 0.7);
  }

  /** A pawn patted for what it took: its eye goes wide. */
  private pattedSmall(pawn: Puppet, at: Vector3): void {
    this.pieces.widen(pawn.id);
    this.heard?.('tap', at, 0.7);
  }

  /**
   * How many captures running, before the `index`th move of the game, were made on the square that
   * move takes on, each answering the one before it: none unless that move is itself a capture
   * there, and never more than `QUICKENS_AT_MOST`.
   */
  private exchange(index: number): number {
    const m = this.record[index];
    if (!m || m.took === null) return 0;
    let run = 0;
    for (let i = index - 1; i >= 0 && run < QUICKENS_AT_MOST; i--) {
      const r = this.record[i];
      if (!r || r.took === null || r.to !== m.to) break;
      run++;
    }
    return run;
  }

  /** Which ending the game is to have, if it has one of its own. */
  private ending(winner: Side | null, how: Ended): Ending | null {
    const side = winner ? opposite(winner) : (this.last ?? 'w');
    const name = this.manners.choose('end', this.facts(side, { toMove: false, result: how.result, drawReason: how.drawReason ?? null, winner, happened: true, ended: how.ended ?? null }));
    return isEnding(name) ? name : null;
  }

  /** Resolves once no hand is setting a stone down, or after a few seconds whatever they are doing. */
  private async free(): Promise<void> {
    for (let waited = 0; waited < 4 && this.arms().some((arm) => arm.busy); waited += 0.05) await this.tweens.wait(0.05);
  }

  /** A player's hands have had nothing to do for a while: whether they do something out of the ordinary about it. */
  private idle(side: Side): boolean {
    if (this.turn === null) return false;
    const captive = this.captive(side);
    const flame = this.flameBy(side);
    const name = this.manners.choose('wait', this.facts(side, { captive: captive?.kind ?? null, candle: flame !== null }));
    const tap = (at: Vector3, strength: number) => this.heard?.('tap', at, strength);
    if (name === 'drum-on-the-rail') this.hands[side].drumOnRail(tap);
    else if (name === 'steeple') this.hands[side].steeple((at) => this.heard?.('meet', at, 0.5));
    else if (name === 'look-at-the-cord') this.hands[side].lookAtCord();
    else if (name === 'lie-on-the-rail') this.hands[side].lieOnRail(tap, () => this.time - this.since >= ASLEEP_AFTER);
    else if (name === 'captives' && captive) this.lookAt(side, captive);
    else if (name === 'candle' && flame) {
      this.burned.add(flame);
      this.hands[side].warm(flame, (at) => this.heard?.('burn', at, 1));
    }
    return name !== null;
  }

  /** Sitting down: Ivory's hands crack their knuckles, some games; and now and then Void's answer, late and small. */
  private sit(): void {
    if (this.manners.choose('sit', this.facts('w')) !== 'knuckles') return;
    const crack = (at: Vector3, strength: number) => this.heard?.('crack', at, strength);
    this.hands.w.steeple(undefined, crack);
    if (draw(this.seedNow(), 0, 'knuckles, answered') >= ANSWERS) return;
    const generation = this.generation;
    void this.tweens.wait(ANSWERS_AFTER).then(() => {
      if (generation === this.generation && this.ply === 0) this.hands.b.crackOne(crack);
    });
  }

  /** A new turn, or a new game: nobody is thinking of any stone yet, and none has been turned to. */
  private forget(): void {
    this.thought = { w: null, b: null };
    this.visits.w.clear();
    this.visits.b.clear();
  }

  /** J'adoube (manners.ts): a stone turned to for the third time in one turn is set straight by the hand that hangs over it. */
  private adjusting(): void {
    for (const side of ['w', 'b'] as const) {
      const thought = this.thought[side];
      const again = thought ? (this.visits[side].get(thought.id) ?? 0) : 0;
      if (!thought || thought.adjusted || again < 2 || this.time - thought.since < ADJUST_AFTER) continue;
      thought.adjusted = true;
      const puppet = this.pieces.puppet(thought.id);
      if (!puppet || this.manners.choose('think', this.facts(side, { again })) !== 'jadoube') continue;
      this.hands[side].adjust(puppet, (at) => {
        this.heard?.('tap', at, 0.6);
        this.pieces.blink(puppet.id);
        this.turned(puppet);
      });
    }
  }

  /** A stone is turned a little on its square, and back to where it faced: unless a hand takes it up meanwhile. */
  private turned(puppet: Puppet): void {
    const generation = this.generation;
    const group = puppet.group;
    const facing = group.rotation.y;
    const mine = () => generation === this.generation && this.pieces.puppet(puppet.id)?.group === group && !this.arms().some((arm) => arm.held?.puppet === puppet || arm.busy);
    let over = false;
    void this.tweens.run({
      duration: 0.3,
      ease: (k) => k,
      update: (k) => {
        if (over) return;
        if (!mine()) {
          // (Whatever has it now puts it as it should be.)
          over = true;
          return;
        }
        group.rotation.y = facing + (k >= 1 ? 0 : ADJUST_TURN * Math.sin(Math.PI * k));
      },
    });
  }

  /** The greatest stone `side` has taken that stands in its drawers, if it has taken any. */
  private captive(side: Side): Puppet | null {
    let best: Puppet | null = null;
    for (const id of this.slots[side].keys()) {
      const puppet = this.pieces.puppet(id);
      if (puppet && (!best || WORTH[puppet.kind] > WORTH[best.kind])) best = puppet;
    }
    return best;
  }

  /**
   * Captives (manners.ts): the hand on that side takes the stone up from the drawer, holds it up to
   * look at, and stands it back where it stood. Across the board, the hands that lost it curl a little.
   */
  private lookAt(side: Side, captive: Puppet): void {
    const player = this.hands[side];
    const arm = player.armFor(captive.group.position.x);
    if (arm.busy || this.tails[side]) return;
    const generation = this.generation;
    const spot = captive.group.position.clone();
    const done = player.carry(arm, captive, spot, { energy: 0, apex: CAPTIVE_UP, show: CAPTIVE_SECONDS }).then(() => {
      if (this.tails[side] === tail) this.tails[side] = null;
    });
    // It is that side's to finish before its hands are wanted for a move of its own.
    const tail: Tail = { cut: () => undefined, done };
    this.tails[side] = tail;
    void this.tweens.wait(1.1).then(() => {
      if (generation === this.generation && this.tails[side] === tail) this.hands[opposite(side)].wince(CAPTIVE_FELT);
    });
  }

  /** The candle that burns under one of `side`'s hands, if there is one it has not been burned at in this game. */
  private flameBy(side: Side): Vector3 | null {
    const end = side === 'w' ? 1 : -1;
    for (const flame of this.candles) if (flame.z * end > 0 && !this.burned.has(flame)) return flame;
    return null;
  }

  /** What is told of a move, the `index`th of the game, to the manners: the move, and what the board and the record show with it. */
  private tellOf(e: MoveEvent, index: number): Partial<Told> {
    const loser = opposite(e.side);
    const mates = e.status.result === 'checkmate';
    let king: Square | null = null;
    if (mates) for (const square of SQUARES) if (this.pieces.kindAt(square) === 'k' && this.pieces.puppetAt(square)?.side === loser) king = square;
    let queens = e.promotion === 'q' ? 1 : 0;
    for (const p of this.pieces.standing()) if (p.kind === 'q' && p.side === e.side) queens++;
    const home = loser === 'w' ? '1' : '8';
    return {
      move: movedBy(e),
      tookBefore: this.record[index - 1]?.took ?? null,
      found: this.found(index),
      mates,
      hemmed: king !== null && neighbours(king).every((square) => this.pieces.puppetAt(square)?.side === loser),
      backRank: king !== null && king[1] === home && e.piece.to[1] === home && (e.piece.kind === 'r' || e.piece.kind === 'q'),
      queens,
    };
  }

  /** What the record shows, that the `index`th move of the game was the last of (manners.ts, `Found`). */
  private found(index: number): Found | null {
    const m = this.record[index];
    if (!m) return null;
    // A king stepped straight up from where it began, on its side's second move.
    const stepped = (at: number) => {
      const r = this.record[at];
      return (at === 2 || at === 3) && r !== undefined && r.kind === 'k' && r.from === (r.by === 'w' ? 'e1' : 'e8') && r.to === (r.by === 'w' ? 'e2' : 'e7');
    };
    if (stepped(index)) return stepped(index - 1) ? 'bongcloud-both' : 'bongcloud';
    // Void's first four moves, Ivory's own seen in a glass.
    if (index === 7) {
      const across = (a: Square, b: Square) => a[0] === b[0] && Number(a[1]) + Number(b[1]) === 9;
      let mirrored = true;
      for (let i = 0; i < 8; i += 2) {
        const ivory = this.record[i];
        const dark = this.record[i + 1];
        mirrored &&= ivory !== undefined && dark !== undefined && ivory.by === 'w' && dark.by === 'b' && ivory.kind === dark.kind && across(ivory.from, dark.from) && across(ivory.to, dark.to);
      }
      if (mirrored) return 'copycat';
    }
    // A knight back on the square it began the game on.
    if (m.kind === 'n' && ['b1', 'g1', 'b8', 'g8'].includes(m.to)) {
      const first = this.record.find((r) => r.id === m.id);
      if (first && first !== m && first.from === m.to) return 'home-again';
    }
    return null;
  }

  /** A pawn that has given mate hops where it stands, once it has been let go. */
  private async hop(pawn: Puppet, generation: number): Promise<void> {
    await this.tweens.wait(HOP_AFTER);
    const group = pawn.group;
    const stood = group.position.y;
    const mine = () => generation === this.generation && this.pieces.puppet(pawn.id)?.group === group;
    await this.tweens.run({ duration: 0.26, ease: (k) => k, update: (k) => mine() && (group.position.y = stood + (k >= 1 ? 0 : HOP * Math.sin(Math.PI * k))) });
    if (mine()) this.heard?.('knock', group.position, 0.4);
  }

  /** The back rank: the winner's hand sweeps along the rank the mated king is shut in on, above the crowns. */
  private sweepRank(winner: Side): Promise<void> {
    const rank = winner === 'w' ? '8' : '1';
    // From the winner's own right to their left.
    const [from, to] = winner === 'w' ? (['h', 'a'] as const) : (['a', 'h'] as const);
    return this.hands[winner].sweep(squareCenter(`${from}${rank}` as Square), squareCenter(`${to}${rank}` as Square));
  }

  /** Laid down: the winner's hand lays the mated king on its side, gently. Respect, not triumph. */
  private async layDown(winner: Side, end: number): Promise<void> {
    let king: Puppet | null = null;
    for (const p of this.pieces.standing()) if (p.kind === 'k' && p.side !== winner) king = p;
    if (!king || this.fallen || this.tipping) return;
    const tipping: Promise<void> = this.tip(king, () => undefined, (at, strength) => this.heard?.('knock', at, 0.3 * strength), winner).finally(() => {
      if (this.tipping === tipping) this.tipping = null;
    });
    this.tipping = tipping;
    await tipping;
    // The hand that did it goes back to hang as a winner's does.
    if (end === this.ends) this.hands[winner].outcome('won', false);
  }

  /**
   * A king is laid down by its own player's hand: pushed until it goes by itself, and then it
   * falls, strikes the board and rocks until it is still.
   */
  private async tip(king: Puppet, down: () => void, knock: (at: Vector3, strength: number) => void, by: Side = king.side): Promise<void> {
    const generation = this.generation;
    const base = king.group.position.clone();
    const facing = king.group.rotation.y;
    const fall = chooseFall(king, this.around(), FORWARD[king.side]);
    this.fallen = { group: king.group, id: king.id, base, facing };
    const live = () => generation === this.generation && this.fallen?.group === king.group;
    const player = this.hands[by];
    // Laid down by the other player's hand, it is let down slowly, and does not rock.
    const gently = by !== king.side;
    const spot = new Vector3();
    let pushed = 0;
    await player.tip(king, (share) => {
      if (live()) {
        pushed = share;
        layOver(king, base, facing, fall, fall.tips * share);
      }
      return crownOf(base, fall, fall.tips * pushed, spot);
    });
    if (!live()) return;
    // Pushed all the way or not, it goes over: a game given up is not left with its king half down.
    const from = fall.tips * pushed;
    if (fall.rest > from + 1e-3) {
      await this.tweens.run({
        duration: (0.2 + 0.16 * (fall.rest - from)) * (gently ? 2.4 : 1),
        ease: gently ? Easing.inOutSine : (k) => k * k,
        update: (k) => live() && layOver(king, base, facing, fall, from + (fall.rest - from) * k),
      });
      if (!live()) return;
    }
    // Where it struck: under its crown.
    const struck = crownOf(base, fall, fall.rest, new Vector3());
    if (!fall.leans) struck.y = base.y;
    down();
    knock(struck, fall.leans ? 0.45 : 1);
    for (const [back, seconds, strength] of fall.leans || gently ? SETTLES : ROCKS) {
      await this.tweens.run({
        duration: seconds,
        ease: (k) => k,
        update: (k) => live() && layOver(king, base, facing, fall, fall.rest - back * Math.sin(Math.PI * k)),
      });
      if (!live()) return;
      knock(struck, strength);
    }
    void player.untip();
  }

  /** A king that was laid down is stood up again where it stood, if it is still the same stone: the game goes on. */
  private stand(): void {
    const fallen = this.fallen;
    this.fallen = null;
    this.tipping = null;
    if (!fallen || this.pieces.puppet(fallen.id)?.group !== fallen.group) return;
    fallen.group.position.copy(fallen.base);
    fallen.group.rotation.set(0, fallen.facing, 0);
    void this.hands.w.untip();
    void this.hands.b.untip();
  }

  /**
   * Which of a player's hands moves the piece in a move; the other lifts away whatever it takes.
   * Castling takes both: the hand on the rook's side takes the rook. A piece that takes another
   * is moved by the hand on the far side of it from what it takes, so that the taken piece goes
   * off to its own side of the board and the two hands never have to cross. Otherwise a piece is
   * moved by the hand on its own side.
   */
  private moverOf(e: MoveEvent): Arm {
    const player = this.hands[e.side];
    const from = squareCenter(e.piece.from).x;
    if (e.rook) return player.other(player.armFor(squareCenter(e.rook.from).x));
    const taken = e.captured ? squareCenter(e.captured.square).x - from : 0;
    return Math.abs(taken) > 0.5 ? player.other(player.armFor(taken)) : player.armFor(from);
  }

  /**
   * How the rook is carried in castling, or back again when castling is taken back: round the front
   * of the king, toward its own player, and lower than the king goes. It is out in front by the time
   * the king comes by, and comes back in to its square behind it; and stays there, under the other
   * arm, until that has gone, and `longer` if that has something more to do there first.
   */
  private roundTheKing(e: MoveEvent, king: Puppet, back: boolean, longer = 0): CarryOptions {
    const by = new Vector3(0, 0, e.side === 'w' ? ROOK_ROUND : -ROOK_ROUND);
    const beside = { puppet: king, at: squareCenter(back ? e.piece.from : e.piece.to) };
    // Taken back, it is the rook that goes first, as it was the rook that came last.
    return back
      ? { apex: 0.35, reach: 'under', beside, bow: { by, out: 0.2, back: 0.4 } }
      : { apex: 0.35, reach: 'under', beside, delay: 0.1, stay: 0.25 + longer, bow: { by, out: 0.4, back: 0.2 } };
  }

  /** Everything of stone that a hand could run into: the pieces in play, and the taken ones standing on the ledges. */
  private *around(): Iterable<Puppet> {
    yield* this.pieces.standing();
    for (const taken of [this.slots.w, this.slots.b]) {
      for (const id of taken.keys()) {
        const puppet = this.pieces.puppet(id);
        if (puppet) yield puppet;
      }
    }
  }

  /**
   * How high a piece's foot must rise to be carried from where it stands to `to`: a height that
   * grows with the distance, and in any case clear of the tallest piece it passes over.
   */
  private apexOver(puppet: Puppet, to: Vector3, ignore: number[] = []): number {
    const from = puppet.group.position;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    let tallest = 0;
    for (const other of this.pieces.standing()) {
      if (other === puppet || ignore.includes(other.id)) continue;
      const p = other.group.position;
      // How far along the path the piece is, and how far to one side of it.
      const along = length > 1e-6 ? ((p.x - from.x) * dx + (p.z - from.z) * dz) / (length * length) : 0;
      if (along < 0.12 || along > 0.88) continue;
      const aside = Math.hypot(p.x - (from.x + dx * along), p.z - (from.z + dz * along));
      if (aside < 0.7) tallest = Math.max(tallest, PIECE_HEIGHT[other.kind]);
    }
    return Math.max(Math.min(1.4, 0.7 + 0.15 * length), tallest > 0 ? tallest + 0.28 : 0);
  }

  /** Reserve a place on the ledge for a piece that `captor` has taken with one of their hands. */
  private claim(captor: Side, withRight: boolean, id: number): Vector3 {
    const flip = captor === 'w' ? 1 : -1;
    const used = [...this.slots[captor].values()];
    const count = (ledge: number) => used.filter((s) => s.ledge === ledge).length;
    // Each hand uses the ledge on its own side, unless that half is full.
    let ledge = ((withRight ? 1 : -1) * flip) as 1 | -1;
    if (count(ledge) >= LEDGE_ROOM) ledge = -ledge as 1 | -1;
    const taken = new Set(used.filter((s) => s.ledge === ledge).map((s) => s.index));
    let index = 0;
    while (taken.has(index)) index++;
    this.slots[captor].set(id, { ledge, index });
    // Each player fills the half of the ledge nearest them, from their own end toward the middle;
    // past that, the other half's, from the middle back toward its end.
    const place = index < LEDGE_ROOM ? index : 2 * LEDGE_ROOM - 1 - index;
    const along = LEDGE_FIRST - LEDGE_STEP * place;
    // By turns a little in toward the case and a little out from it.
    const across = LEDGE_X + (place % 2 === 0 ? -LEDGE_ZIG : LEDGE_ZIG);
    return new Vector3(ledge * across, PLINTH_TOP, flip * (index < LEDGE_ROOM ? along : -along));
  }

  /** A pawn becomes its promoted piece: it draws in, changes, and springs back out. */
  private async recast(puppet: Puppet, kind: Kind, generation: number): Promise<void> {
    const g = puppet.group;
    await this.tweens.run({ duration: 0.12, ease: Easing.inCubic, update: (k) => g.scale.setScalar(1 - 0.45 * k) });
    // A new position may have been set up in that instant. Its stones are numbered afresh, and
    // the one that now has this number is not the pawn that was promoting.
    if (generation !== this.generation) return;
    this.pieces.recast(puppet.id, kind);
    await this.tweens.run({
      duration: 0.3,
      ease: Easing.outBack,
      update: (k) => {
        g.scale.setScalar(0.55 + 0.45 * k);
        puppet.energy = 2.4 - 1.4 * k;
      },
    });
  }
}

/** A move as the record keeps it: who made it, with which stone, from where to where, what it took, and whether it gave check. */
interface Played {
  by: Side;
  id: number;
  kind: Kind;
  from: Square;
  to: Square;
  took: Kind | null;
  check: boolean;
}

function played(e: MoveEvent): Played {
  return { by: e.side, id: e.piece.id, kind: e.piece.kind, from: e.piece.from, to: e.piece.to, took: e.captured?.kind ?? null, check: e.status.inCheck };
}

const SQUARES: Square[] = [];
for (const file of 'abcdefgh') for (const rank of '12345678') SQUARES.push(`${file}${rank}` as Square);

/** The squares beside a square, on the board. */
function neighbours(square: Square): Square[] {
  const out: Square[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      const file = square.charCodeAt(0) - 97 + df;
      const rank = Number(square[1]) + dr;
      if ((df !== 0 || dr !== 0) && file >= 0 && file < 8 && rank >= 1 && rank <= 8) out.push(`${String.fromCharCode(97 + file)}${rank}` as Square);
    }
  }
  return out;
}

/** A move, as the manners are told it. */
function movedBy(e: MoveEvent): Moved {
  return {
    by: e.side,
    kind: e.piece.kind,
    from: e.piece.from,
    to: e.piece.to,
    took: e.captured?.kind ?? null,
    passing: e.enPassant,
    becomes: e.promotion,
    castle: e.castle === 'k' ? 'short' : e.castle === 'q' ? 'long' : null,
  };
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
