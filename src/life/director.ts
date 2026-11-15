/**
 * Decides how the room answers what happens on the board: what the pieces
 * feel, what the board does, how the light changes and what is heard. The
 * table it follows is in the style bible, section 7.3; the payoffs escalate
 * from a quiet move to mate.
 *
 * It is told about a move beat by beat as the hands play it (a piece is
 * reached for, lifted, set down), so that each response lands on its beat.
 */
import { Color, Vector3 } from 'three';
import type { Sound } from '../audio/sound';
import { type Kind, type MoveEvent, opposite, type Side, type Square, type Status } from '../core/game';
import type { VerdictKind } from '../engine/verdict';
import type { Told } from '../hands/manners';
import type { Ended, Heard } from '../hands/stage';
import type { Mood } from '../scene/chapel';
import { DRAWER_OUT, FIELD_HALF, PLINTH_TOP, SLAB_HALF, squareCenter } from '../scene/layout';
import type { PieceLayer } from '../scene/pieces';
import { PIECE_HEIGHT } from '../scene/pieceShapes';
import type { BoardFx } from './boardfx';

export type { Mood };
/** A point in a hand's handling of one piece. */
export type Beat = 'reach' | 'close' | 'lift' | 'set' | 'release';
/** Which piece of a move a beat belongs to. */
export type Part = 'mover' | 'victim' | 'rook';

/**
 * What the players' hands can be told of the game (src/hands/stage.ts): they answer it in their
 * own way. Only what both players can see on the board is ever told in a plain game.
 */
export interface HandCues {
  check(by: Side, king: Vector3): void;
  taken(from: Side, kind: Kind): void;
  strong(side: Side): void;
  blunder(side: Side): void;
  /**
   * The game is over (`how`: by what, as far as the board and the clocks say). The name of the
   * ending the hands play for it, if it has one of its own (endings.ts).
   */
  over(winner: Side | null, happened: boolean, struck: boolean, how?: Ended): string | null;
  resume(): void;
  /**
   * `loser` has given the game up. True if their own hand lays their king down for it: `down` is
   * then called when the king strikes the board, and `knock` each time it does (stage.ts).
   */
  concedes(loser: Side, happened: boolean, ended: Told['ended'], down: () => void, knock: (at: Vector3, strength: number) => void): boolean;
}

export interface Room {
  pieces: PieceLayer;
  fx: BoardFx;
  setMood(mood: Mood): void;
  /** The hands, once there are any: until then the pieces move by themselves, and nothing is told. */
  hands?(): HandCues | null;
  /** A weight has come down on the board, hard enough to be felt: a pawn is about a half, a king three times that. */
  thud?(strength: number): void;
}

/** Light colours for the effects, in linear light. */
const LIGHT: Record<Side, Color> = {
  w: new Color(1.0, 0.82, 0.5).multiplyScalar(1.5),
  b: new Color(0.35, 1.0, 0.85).multiplyScalar(1.4),
};
const CHALK = new Color(0.9, 0.87, 0.78).multiplyScalar(0.7);
const VIOLET = new Color(0.62, 0.42, 0.95).multiplyScalar(1.8);
const PALE = new Color(0.76, 0.98, 0.95).multiplyScalar(1.4);
/** The ribbon behind a piece in the air: the bible's near-white, leaning a little toward its side's light. */
const RIBBON = new Color(0xf8f6ed).convertSRGBToLinear();
const WAKE: Record<Side, Color> = {
  w: RIBBON.clone().lerp(new Color(1.0, 0.82, 0.5), 0.22).multiplyScalar(1.25),
  b: RIBBON.clone().lerp(new Color(0.35, 1.0, 0.85), 0.3).multiplyScalar(1.25),
};
/** The square a piece has left stays lit for a moment, which is what its flecks are seen against. */
const LEFT: Record<Side, Color> = {
  w: new Color(1.0, 0.82, 0.5).multiplyScalar(0.62),
  b: new Color(0.35, 1.0, 0.85).multiplyScalar(0.55),
};

const nothing = () => {};
const WEIGHT: Record<Kind, number> = { p: 0.6, n: 0.9, b: 0.9, r: 1.15, q: 1.3, k: 1.5 };
/** How long after a move has landed the room waits to hear what the engine made of it. */
const VERDICT_PATIENCE = 4;
/** The least time between two sounds of a hand coming to rest over a piece, in seconds. */
const MUSE_REST = 0.35;

export class Director {
  /** How many more moves the room stays on edge after something sharp. */
  private edge = 0;
  private waited = 0;
  /** How long since a hand was last heard coming to rest over a piece, in seconds. */
  private sinceMused = Infinity;
  private nextFidget = 14;
  private nextTick = 0;
  private fidgets = 0;
  private status: Status | null = null;
  private over = false;
  /** Moves the engine has been asked about, and what it said of those it has answered for (null: it could not say). */
  private asked = new WeakSet<MoveEvent>();
  private verdicts = new WeakMap<MoveEvent, VerdictKind | null>();
  /** A move that has landed and is still waiting for its verdict, and for how long. */
  private pending: MoveEvent | null = null;
  private pendingFor = 0;
  /** The pieces in the air just now, each with the ribbon that follows it and how far up the piece it is tied. */
  private carried: { id: number; wake: 0 | 1; up: number }[] = [];
  /**
   * In an online game being played the room answers only what both players can see on the board:
   * a stone taken, a check, mate, a draw, a game given up, a pawn made into something greater, a
   * castle. It does not draw a fork, a pin or a discovered attack, burn a sacrifice, or lift or
   * sag a side for what a move won or left hanging, since that would tell one player what the
   * other has done to them, or could do; and the engine's word is never asked there.
   */
  private plain = false;
  /** Set when a server ended the game and not a player (time ran out, somebody left): nobody tipped their king. */
  private ended: Told['ended'] = null;
  /** The last note the hands' glass sounded on (`heard`, 'chime'). */
  private chimes = 0;

  constructor(
    private room: Room,
    private sound: () => Sound | null,
  ) {}

  /**
   * A new position has been set up. `happened` says that the game has this moment been given up
   * or agreed drawn, and is to be seen and heard ending. Without it the position is only being
   * stood again (a look back, a game taken up) and is shown as that left it, in silence.
   */
  reset(status: Status, happened = false): void {
    this.edge = 0;
    this.waited = 0;
    this.over = status.over;
    this.status = status;
    this.pending = null;
    this.carried = [];
    this.room.fx.clear();
    this.room.pieces.setFear(status.checkedKing);
    this.settle(status);
    // A game taken up again with a king in check, or over by mate: the board is as that left it,
    // and so is the side that was mated, with its lights out.
    if (status.result === 'checkmate') {
      this.breakToward(status, true);
      if (status.winner && status.checkedKing) this.room.pieces.extinguish(opposite(status.winner), squareCenter(status.checkedKing), true);
    } else if (status.inCheck && !status.over) this.breakToward(status);
    if (status.result === 'resigned') this.conceded(status, happened);
    // And the hands are as the position leaves them: acting it out, if it has ended this moment.
    const ending = status.over ? (this.room.hands?.()?.over(status.winner, happened, false, this.how(status)) ?? null) : null;
    if (!status.over) this.room.hands?.()?.resume();
    // A draw agreed rings from both kings: on the pump of the hands' handshake, if they shake on it.
    if (happened && status.result === 'draw' && status.drawReason === 'agreement' && ending !== 'handshake') this.shaken();
  }

  /**
   * The players have agreed a draw. Nobody has won and nothing was struck: the board rings once
   * from each king, the two rings meet, and one glass tone is heard from each side, the same note.
   */
  private shaken(): void {
    const { pieces, fx } = this.room;
    for (const p of pieces.standing()) {
      if (p.kind !== 'k') continue;
      fx.ripple(p.group.position, 1);
      this.sound()?.glass(p.group.position, 2, 0.2);
    }
  }

  /**
   * A side has given the game up. Nobody was struck, so nothing erupts: its light goes out,
   * from its king outward, and the side that is left standing takes heart. A game found already
   * given up has its lights out and nothing more.
   */
  private conceded(status: Status, happened: boolean): void {
    if (!status.winner) return;
    const loser = opposite(status.winner);
    const { pieces, fx } = this.room;
    const winner = status.winner;
    let fallen: Vector3 | null = null;
    let crowned: Vector3 | null = null;
    for (const p of pieces.standing()) {
      if (p.kind !== 'k') continue;
      if (p.side === loser) fallen = p.group.position.clone();
      else crowned = p.group.position.clone();
    }
    const hands = this.room.hands?.() ?? null;
    if (!happened) {
      if (fallen) pieces.extinguish(loser, fallen, true);
      // And its king is lying, if its player laid it down.
      hands?.concedes(loser, false, this.ended, nothing, nothing);
      return;
    }
    const down = () => {
      if (fallen) {
        pieces.extinguish(loser, fallen);
        fx.ripple(fallen, 1.2);
        this.sound()?.fall(fallen);
      }
      if (crowned) pieces.rally(winner, crowned);
    };
    // If the loser's own hand lays the king down, all that waits until the king is down, and each
    // time it strikes the board is heard and felt.
    const knock = (at: Vector3, strength: number) => {
      this.sound()?.stoneSet(at, loser === 'w', 1.5 * strength);
      this.room.thud?.(0.9 * strength);
      if (strength > 0.4) fx.ripple(at, 0.7 * strength);
    };
    if (!hands?.concedes(loser, true, this.ended, down, knock)) down();
  }

  /** How the game came to be over, as the hands are told it. */
  private how(status: Status): Ended {
    return { result: status.result, drawReason: status.drawReason, ended: this.ended };
  }

  /** How a server ended the game, if one did: said before the room is told the game is over. */
  setEnded(ended: Told['ended']): void {
    this.ended = ended;
  }

  /** Something the hands did that can be heard, apart from handling a stone (stage.ts). */
  heard(what: Heard, at: Vector3, strength: number): void {
    const sound = this.sound();
    if (what === 'tap') {
      // A fingertip come down: on the rail of the case, if it is out past the squares; on a stone's head, if it is over them.
      if (strength > 0.5) sound?.manner(Math.max(Math.abs(at.x), Math.abs(at.z)) > FIELD_HALF ? 'rail' : 'pat', at, strength);
    } else if (what === 'meet') sound?.manner('meet', at, 2 * strength);
    // Glass struck on glass, a note up or down from the last each time: a wind chime, since the hands are glass.
    else if (what === 'chime') sound?.glass(at, (this.chimes = (this.chimes + 3) % 8), 0.06 + 0.1 * strength);
    else if (what === 'pump') this.shaken();
    // A pawn's foot rapped on the square it takes in passing on, or a stone hopped or laid gently
    // over; fingers snapped, which is glass on glass, short; a pawn pushed along the board.
    else if (what === 'knock') sound?.manner('rap', at, 1.6 * strength);
    else if (what === 'snap') sound?.manner('snap', at, strength);
    else if (what === 'drag') sound?.manner('drag', at, strength);
    // A knuckle cracked, and a hand come too near a flame.
    else if (what === 'crack') sound?.manner('knuckle', at, strength);
    else if (what === 'burn') sound?.manner('burn', at, strength);
  }

  /** The player to move has turned to a piece (`chosen` when they have picked it up in thought), or away. */
  thought(square: Square | null, chosen: boolean): void {
    this.waited = 0;
    if (!square) return;
    const at = squareCenter(square);
    if (chosen) this.sound()?.select(at);
    // Only looked at: fingers brushing the stone, and not for every piece a pointer sweeps across.
    else if (this.sinceMused > MUSE_REST) {
      this.sinceMused = 0;
      this.sound()?.touch(at);
    }
  }

  /** One beat of a move, as it is played. */
  beat(e: MoveEvent, part: Part, beat: Beat): void {
    const sound = this.sound();
    const { pieces, fx } = this.room;
    const pale = (part === 'victim' ? opposite(e.side) : e.side) === 'w';

    if (part === 'mover') {
      const from = squareCenter(e.piece.from);
      const to = squareCenter(e.piece.to);
      if (beat === 'reach') {
        this.waited = 0;
        // A chalk line draws itself along the path. A knight's is two legs.
        if (e.piece.kind === 'n') {
          const corner = Math.abs(to.x - from.x) > Math.abs(to.z - from.z) ? new Vector3(to.x, 0, from.z) : new Vector3(from.x, 0, to.z);
          fx.line(from, corner, CHALK, { chalk: true, draw: 0.22, hold: 1.1, fade: 1.2, width: 0.06 });
          fx.line(corner, to, CHALK, { chalk: true, draw: 0.16, hold: 0.95, fade: 1.2, width: 0.06, delay: 0.2 });
        } else {
          fx.line(from, to, CHALK, { chalk: true, draw: 0.34, hold: 1.0, fade: 1.2, width: 0.06 });
        }
        sound?.whoosh(from, 0.5, 0.2);
      } else if (beat === 'close') {
        // Fingers on the stone.
        sound?.touch(from);
      } else if (beat === 'lift') {
        sound?.stoneLift(from, pale);
        sound?.whoosh(to, 0.7, 0.28);
        // The square it leaves stays lit a moment and sheds a few flecks; a ribbon goes with the piece.
        fx.flash(from, LEFT[e.side], 1.2, 0.96);
        fx.crumble(from, WEIGHT[e.piece.kind]);
        this.carry(e.piece.id, 0, e.piece.kind, e.side);
      } else if (beat === 'set') {
        this.setDown(0);
        const weight = WEIGHT[e.promotion ?? e.piece.kind];
        sound?.stoneSet(to, pale, weight);
        fx.ripple(to, weight);
        fx.flash(to, LIGHT[e.side], 1.1);
        // Set down on the square another stone was just taken from, it comes down harder.
        this.room.thud?.(weight * (e.captured ? 1.4 : 1));
        this.landed(e);
      }
      return;
    }

    if (part === 'rook' && e.rook) {
      if (beat === 'lift') {
        sound?.stoneLift(squareCenter(e.rook.from), pale);
        fx.crumble(squareCenter(e.rook.from), 0.7);
        this.carry(e.rook.id, 1, 'r', e.side);
      }
      if (beat === 'set') {
        this.setDown(1);
        sound?.stoneSet(squareCenter(e.rook.to), pale, WEIGHT.r);
        fx.ripple(squareCenter(e.rook.to), 0.8);
        this.room.thud?.(0.7);
      }
      return;
    }

    if (part === 'victim' && e.captured) {
      const at = squareCenter(e.captured.square);
      if (beat === 'reach') {
        // It sees the hand coming.
        pieces.flinch(e.captured.id, squareCenter(e.piece.from), 1.2);
      } else if (beat === 'close') {
        sound?.crack(at);
        pieces.recoilFrom(at, 1.8, [e.captured.id, e.piece.id]);
        fx.flash(at, VIOLET, 0.7);
        this.room.thud?.(0.45);
      } else if (beat === 'set') {
        // Set down in a drawer, out on the side of the case.
        const out = (SLAB_HALF + DRAWER_OUT) / 2;
        sound?.stoneSet({ x: at.x > 0 ? out : -out, y: PLINTH_TOP, z: at.z }, pale, 0.5);
      }
    }
  }

  /** A piece has left the board in a hand: a ribbon follows it until it is set down. */
  private carry(id: number, wake: 0 | 1, kind: Kind, side: Side): void {
    this.carried = this.carried.filter((c) => c.wake !== wake);
    this.carried.push({ id, wake, up: PIECE_HEIGHT[kind] * 0.56 });
    this.room.fx.wakeBegin(wake, WAKE[side], 0.13 + 0.075 * WEIGHT[kind]);
    this.follow();
  }

  private setDown(wake: 0 | 1): void {
    this.follow();
    this.carried = this.carried.filter((c) => c.wake !== wake);
    this.room.fx.wakeEnd(wake);
  }

  /** Tell each ribbon where its piece has got to. */
  private follow(): void {
    for (const c of this.carried) {
      const at = this.room.pieces.puppet(c.id)?.group.position;
      if (at) this.room.fx.wakeTo(c.wake, at.x, at.y + c.up, at.z);
    }
  }

  /**
   * The engine is being asked what it makes of this move. Until it answers (or is given up on),
   * the pieces do not decide for themselves how to feel about it.
   */
  expect(e: MoveEvent): void {
    this.asked.add(e);
  }

  /** Whether the moves to come are answered only with what can be seen on the board (see `plain`). */
  setPlain(plain: boolean): void {
    this.plain = plain;
  }

  /** What the engine made of a move, or null if it could not say. May come before or after the move lands. */
  appraise(e: MoveEvent, kind: VerdictKind | null): void {
    this.verdicts.set(e, kind);
    if (this.pending === e) {
      this.pending = null;
      this.feel(e, kind);
    }
  }

  /** A take-back has been played out. */
  undone(status: Status): void {
    this.over = status.over;
    this.status = status;
    this.pending = null;
    this.edge = 0;
    this.room.fx.setPillar(null);
    // A mate taken back: the side that had gone dark is lit again and stands up.
    this.room.pieces.relight();
    this.room.pieces.setFear(status.checkedKing);
    this.settle(status);
    // Taken back to a king in check: the board is broken toward it as it was.
    if (status.inCheck && !status.over) this.breakToward(status);
    if (!status.over) this.room.hands?.()?.resume();
  }

  update(dt: number): void {
    const sound = this.sound();
    sound?.update(dt);
    this.sinceMused += dt;
    this.follow();
    if (this.pending) {
      this.pendingFor += dt;
      // The engine has not answered: go by what can be seen on the board.
      if (this.pendingFor > VERDICT_PATIENCE) {
        const e = this.pending;
        this.pending = null;
        this.feel(e, null);
      }
    }
    if (this.over || !this.status) return;
    // A player kept waiting: their pieces shift where they stand, and the room's clock is heard.
    this.waited += dt;
    if (this.waited > this.nextFidget) {
      this.nextFidget = this.waited + 2.5 + ((this.fidgets * 0.618) % 1) * 3.5;
      const ids = this.room.pieces.idsOf(this.status.turn);
      if (ids.length > 0) this.room.pieces.fidget(ids[(this.fidgets * 7 + 3) % ids.length]!);
      this.fidgets++;
    }
    if (this.waited > 22 && this.waited > this.nextTick) {
      this.nextTick = this.waited + 1.5;
      sound?.tick();
    }
    if (this.waited < 1) {
      this.nextFidget = 14;
      this.nextTick = 0;
    }
  }

  // -- internals --------------------------------------------------------------

  /** The moving piece has just been set down: everything the move means happens now. */
  private landed(e: MoveEvent): void {
    const sound = this.sound();
    const { pieces, fx } = this.room;
    const to = squareCenter(e.piece.to);
    const s = e.status;
    this.status = s;
    this.over = s.over;
    this.waited = 0;
    const hands = this.room.hands?.() ?? null;
    // The side that lost a stone feels it in its hands.
    if (e.captured) hands?.taken(opposite(e.side), e.captured.kind);

    // What the move did beyond moving. Not said in a plain game, where it would be pointed out to the side it was done to.
    for (const m of this.plain ? [] : e.motifs) {
      if (m.kind === 'fork') {
        m.targets.forEach((target, i) => {
          fx.line(squareCenter(m.by), squareCenter(target), LIGHT[e.side], { draw: 0.18, hold: 1.5, fade: 0.9, width: 0.07, delay: 0.12 + i * 0.07 });
          const victim = pieces.puppetAt(target);
          if (victim) pieces.flinch(victim.id, squareCenter(m.by), 0.9);
        });
        sound?.stab(to);
      } else if (m.kind === 'pin') {
        // A line through the pinned piece to what it shields, and the pinned square sealed.
        fx.line(squareCenter(m.by), squareCenter(m.behind), PALE, { draw: 0.3, hold: 1.6, fade: 0.9, width: 0.05, delay: 0.1 });
        fx.flash(squareCenter(m.pinned), PALE, 1.8, 0.92);
        const pinned = pieces.puppetAt(m.pinned);
        fx.prism(squareCenter(m.pinned), pinned ? PIECE_HEIGHT[pinned.kind] : 1.2, PALE, 1.6);
        if (pinned) pieces.flinch(pinned.id, squareCenter(m.by), 0.6);
        sound?.seal(squareCenter(m.pinned));
      } else if (m.kind === 'discovered') {
        fx.line(squareCenter(m.by), squareCenter(m.target), LIGHT[e.side], { draw: 0.2, hold: 1.4, fade: 0.9, width: 0.11, delay: 0.05 });
        const target = pieces.puppetAt(m.target);
        if (target) pieces.flinch(target.id, squareCenter(m.by), 1);
        sound?.reveal(squareCenter(m.target));
      }
      // A sacrifice is answered in `feel`, once it is known whether the engine thinks it one.
    }

    if (e.promotion) {
      // A pawn made into something greater: the square blazes, the board rings out from it, and its side takes heart.
      fx.flash(to, LIGHT[e.side], 1.8, 1.6);
      fx.ripple(to, 1.7);
      pieces.rally(e.side, to);
      sound?.lift(to);
      this.room.thud?.(0.9);
    }

    if (s.result === 'checkmate' && s.checkedKing) {
      // The set piece: the board erupts from the king, one pillar of light, the loser's stones go dark.
      const king = squareCenter(s.checkedKing);
      this.breakToward(s, true, sound);
      fx.erupt(king);
      this.room.thud?.(2.2);
      fx.setPillar(king);
      fx.setFog(0.8);
      pieces.setFear(null);
      pieces.extinguish(opposite(e.side), king);
      pieces.rally(e.side, to);
      this.room.setMood('mate');
      sound?.setHeartbeat(false);
      sound?.setTension(0);
      sound?.choir();
      hands?.over(e.side, true, true, { result: 'checkmate' });
      return;
    }

    if (s.inCheck && s.checkedKing) {
      const king = squareCenter(s.checkedKing);
      this.breakToward(s, false, sound);
      const afraid = pieces.puppetAt(s.checkedKing);
      if (afraid) pieces.flinch(afraid.id, s.checkers[0] ? squareCenter(s.checkers[0]) : to, 1.3);
      sound?.stinger(king);
      hands?.check(e.side, king);
    }
    // A game that the move has drawn (stalemate, too little left to mate with, the same position a fifth time).
    if (s.over && s.result === 'draw') hands?.over(null, true, false, this.how(s));

    // How the move's side feels about it: by the engine's verdict if one is coming, by eye if not.
    // In a plain game it keeps its feelings to itself.
    if (!this.plain) {
      if (this.verdicts.has(e)) {
        this.feel(e, this.verdicts.get(e) ?? null);
      } else if (this.asked.has(e)) {
        this.pending = e;
        this.pendingFor = 0;
      } else {
        this.feel(e, null);
      }
    }

    if ((!this.plain && e.motifs.length > 0) || e.captured || s.inCheck) this.edge = 3;
    else this.edge = Math.max(0, this.edge - 1);
    pieces.setFear(s.checkedKing);
    this.settle(s);
  }

  /**
   * The mover's pieces answer the move: they surge at a strong one and sag at a blunder. With no
   * verdict from the engine, a move counts as strong if it forces matters or wins material, and
   * as a blunder if it leaves material to be taken.
   */
  private feel(e: MoveEvent, verdict: VerdictKind | null): void {
    const sound = this.sound();
    const to = squareCenter(e.piece.to);
    let strong = verdict === 'strong';
    let blunder = verdict === 'blunder';
    if (verdict === null) {
      const forcing = e.motifs.some((m) => m.kind === 'fork' || m.kind === 'discovered');
      const sacrificed = e.motifs.some((m) => m.kind === 'sacrifice');
      strong = forcing || e.gained - e.exposure >= 3;
      blunder = !strong && e.exposure - e.gained >= 2 && !sacrificed;
    }
    // A stone given up on purpose burns at its seams, and a bell is struck: unless the engine says
    // it was simply thrown away. With no word from the engine it is taken for what it looks like.
    if (verdict !== 'blunder' && verdict !== 'slip' && e.motifs.some((m) => m.kind === 'sacrifice')) {
      this.room.pieces.burn(e.piece.id);
      sound?.bell(to);
    }
    if (strong) {
      this.room.pieces.rally(e.side, to);
      // A fan of rays behind the stone that made it, taller for a taller stone.
      this.room.fx.rays(to, LIGHT[e.side], 1.3 + PIECE_HEIGHT[e.promotion ?? e.piece.kind]);
      sound?.lift(to);
      // (Not over a check: the hand that would open is the one that points at the king.)
      if (!e.status.inCheck) this.room.hands?.()?.strong(e.side);
    } else if (blunder) {
      this.room.pieces.sag(e.side);
      sound?.fall(to);
      if (!e.status.inCheck) this.room.hands?.()?.blunder(e.side);
    }
  }

  /**
   * Cracks run toward a king in check from whatever attacks it, and lie there until it is safe.
   * Those of an older check close as these open. At mate they are wider, and nothing closes them.
   */
  private breakToward(s: Status, mate = false, sound: Sound | null = null): void {
    const fx = this.room.fx;
    fx.heal();
    if (!s.checkedKing) return;
    const king = squareCenter(s.checkedKing);
    for (const from of s.checkers) {
      fx.crack(squareCenter(from), king, VIOLET, mate ? { width: 1.7, draw: 0.5 } : {});
      // Heard only as it happens: a position taken up again is already broken.
      sound?.fracture(squareCenter(from), king, mate ? 0.5 : 0.35, mate ? 1.7 : 1);
    }
  }

  /** Put the room in the state the position calls for. */
  private settle(s: Status): void {
    const sound = this.sound();
    if (s.result === 'checkmate') {
      this.room.setMood('mate');
      return;
    }
    const check = s.inCheck && !s.over;
    // A king out of check: whatever was broken toward it closes.
    if (!check) this.room.fx.heal();
    this.room.fx.setFog(check ? 0.42 : 0);
    this.room.fx.setPillar(null);
    this.room.setMood(check ? 'check' : this.edge > 0 ? 'sharp' : 'calm');
    sound?.setHeartbeat(check);
    sound?.setTension(check ? 1 : this.edge > 0 ? 0.45 : 0);
  }
}
