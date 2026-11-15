/**
 * The app controller: owns the game, the 3D world and the camera rig, turns
 * pointer and keyboard input into moves, and keeps the interface signals in
 * step with the position.
 *
 * It also decides who may move. Two players can share this screen; one can
 * play the chess engine; or the game can be held by the server, with the
 * other player on another machine and this screen showing what the server
 * says happened.
 */
import { effect } from '@preact/signals';
import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import { decodeBank, fetchBank, type RawBank } from '../audio/bank';
import { Sound, type UiSound, type Volumes } from '../audio/sound';
import { CAMERA_MODES, CameraRig, type CameraMode } from '../camera/rig';
import { type DrawClaim, Game, opposite, type MoveEvent, type MoveOption, type PromotionKind, type Side, type Square } from '../core/game';
import { writePgn } from '../core/pgn';
import { startEngine } from '../engine/browser';
import { chooseMove } from '../engine/opponent';
import { type Analysis, type Engine, type EngineMove, LEVELS, type SearchOptions, type Setting, uciOf } from '../engine/uci';
import { FIRST_LOOK, judge, reconsider, SECOND_LOOK, type Verdict, worth } from '../engine/verdict';
import { loadHandTemplate } from '../hands/hand';
import { describeBlunder, describeHint, enPassantOffered, type Hint, SIDE_NAME, topicsOf, type Topic } from '../learn/explain';
import { answer, LESSONS, solve, stepNumber, type Step } from '../learn/lessons';
import { prepareOpenings } from '../learn/openings';
import { browserKeys, Net } from '../net/client';
import { Hall } from '../net/hall';
import { identity, setName } from '../net/identity';
import { type Clock, cleanName, type MoveData, newRoomName, type PlayerCard, ROOM_NAME, type RoomState, sameControl, type Seat, type TimeControl } from '../net/protocol';
import { loadAssets } from '../scene/assets';
import { squareCenter } from '../scene/layout';
import type { Mark } from '../scene/markers';
import type { Unpacking } from '../scene/opening';
import { Governor } from '../scene/pace';
import { suggestQuality, type Quality } from '../scene/post';
import { World } from '../scene/world';
import { BRAND } from './brand';
import { clearSavedGame, readSavedGame, type SavedSummary, summarise, writeSavedGame } from './saved';
import {
  type Aids,
  ALL_AIDS,
  analysable,
  cinematicIsChosen,
  forgetQualityChoice,
  type LessonView,
  loadSettings,
  markCinematicChosen,
  markQualityChosen,
  type Online,
  qualityIsChosen,
  saveSettings,
  ui,
} from './store';

/** How far a press must move, in CSS pixels, before it is a drag and not a tap: further for a finger, which is never quite still. */
const DRAG_THRESHOLD = 6;
const TOUCH_DRAG_THRESHOLD = 10;
/** A stone carried by a finger is held this far above it, in CSS pixels, so that the finger does not hide it or the square it is going to. */
const TOUCH_LIFT = 50;
/** A finger's tap on the board finds the nearest square the chosen stone may go to, within this many squares of where it fell. */
const TOUCH_REACH = 0.6;
/** What CameraRig.orbitZoom multiplies a wheel's `deltaY` by before it is a change in the distance's logarithm: a pinch is turned into the same. */
const WHEEL_ZOOM = 0.0011;
/**
 * If the picture is being drawn slower than this many milliseconds a frame, averaged over a few
 * seconds, and the player did not choose the quality themselves, the game steps it down.
 */
const TOO_SLOW = 30;
const PACE_FRAMES = 240;
/** How fast the camera goes round the board behind the opening screen, in radians a second: a full turn in about two minutes. */
const OPENING_DRIFT = 0.055;
/** The width, in pixels, of the column at the left that a lesson or an explanation stands in. */
const CARD_COLUMN = 372;
/** The same, for the choice of game. */
const BILL_COLUMN = 620;
const SIDES = ['w', 'b'] as const;

/** The computer's hand dwells on a piece for at least this long before taking it, and it never answers faster than the second figure. */
const DWELL = 0.6;
const QUICKEST_REPLY = 1.2;
/** A screen this many moves behind the server (a watcher's tab left in the background, say) jumps to the present. */
const TOO_FAR_BEHIND = 3;

/**
 * A game as it is recorded: where it started, every move since, and how it ended if not by a move:
 * a side gave it up, the players agreed a draw, the player to move claimed one, or (`ended` 'time'
 * with nobody resigned) time ran out against a side that could not have been mated.
 */
type GameRecord = Pick<RoomState, 'startFen' | 'moves'> & { resigned?: Side | null; agreed?: boolean; claimed?: DrawClaim | null; ended?: RoomState['ended'] };
/** How long after a resignation the card that ends the game waits, so that the room is seen to answer first. */
const RESIGN_PAUSE = 1.1;
/** The computer takes a moment over a draw it is offered, as anyone would. */
const DRAW_PAUSE = 0.9;
/**
 * It agrees to one only once the game is this many moves old (counting each side's, and those
 * before a position that was set up), and it does not think it stands better by more than this.
 */
const DRAW_NOT_BEFORE = 30;
const DRAW_MARGIN = 25;
/** The computer takes as long over claiming a draw that is its to claim. */
const CLAIM_PAUSE = 0.9;

/**
 * How long the server may go unreached, in milliseconds, before the player is told so and offered
 * another try: waiting for a match, asking for the rankings, or going into a room. An object so
 * that the tests can be patient for less long.
 */
export const patience = { reach: 8000 };
/** How long "Saved" stands beside the name field, in milliseconds. */
const SAVED_SHOWS = 2400;
/** How long the players' coming to the board is shown at the start of an online game, in seconds. The drawing of it (panels.css, `.intro`) is timed to fit. */
const INTRO_SECONDS = 3.4;
/**
 * What a ranked game gives back to a player's clock with each move, in milliseconds. The room's
 * clock says what each side begins with but not this, so it is written down here as the server
 * has it (CLOCK_INCREMENT in server/rooms.ts; tests/match.test.ts holds the two together).
 */
export const RANKED_INCREMENT = 5 * 1000;

/** A move chosen here is held no longer than this while the engine checks it for a blunder. */
const FORESIGHT_PATIENCE = 1200;
/** In a lesson: how long a wrong move stands before it is put back, and how long before the other side's scripted move. */
const WRONG_MOVE_STANDS = 1.3;
const SCRIPT_PAUSE = 0.8;

/** Whose decision a move was: this screen's, the other player's by way of the server, the computer's, or a lesson's script. */
type Origin = 'local' | 'remote' | 'computer' | 'script';

function sameMove(a: MoveData | undefined, b: MoveData | undefined): boolean {
  return !!a && !!b && a.from === b.from && a.to === b.to && (a.promotion ?? null) === (b.promotion ?? null);
}

const KIND_WORD = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' } as const;

/** The square of the pawn that a capture in passing removes: beside where the capturing pawn started, on the file it moves to. */
function passedPawn(option: MoveOption): Square {
  return (option.to[0]! + option.from[1]!) as Square;
}

function dataOf(e: MoveEvent): MoveData {
  return { from: e.piece.from, to: e.piece.to, ...(e.promotion ? { promotion: e.promotion } : {}) };
}

/** The room named in the page's address, if it names one. */
function roomInAddress(): { room: string; watch: boolean } | null {
  const query = new URLSearchParams(location.search);
  const room = (query.get('room') ?? '').toUpperCase();
  return ROOM_NAME.test(room) ? { room, watch: query.get('watch') === '1' } : null;
}

/** Put the room in the page's address, so that the address is the link to share. Null takes it out. */
function setAddress(room: string | null, watch = false): void {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  url.searchParams.delete('watch');
  if (room) url.searchParams.set('room', room);
  if (room && watch) url.searchParams.set('watch', '1');
  history.replaceState(null, '', url);
}

/** Whether the player has asked their system for less movement on screen. */
function stillness(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Where the game's server is: the address the page came from, unless the build names another. */
function serverUrl(): string {
  const named = import.meta.env.VITE_GAME_SERVER as string | undefined;
  if (named) return named;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export class App {
  readonly game = new Game();
  readonly world: World;
  readonly rig: CameraRig;
  /** Rolling frame statistics, for the performance notes and the debug hook. */
  readonly stats = { frameMs: 16.7, fps: 60, frames: 0, scale: 1 };
  /** Draws the picture smaller when the quality in use is more than the machine can draw smoothly. */
  private governor = new Governor();
  /** How long recent frames have taken, and how many have been counted since the quality last changed. */
  private pace = { ms: 16.7, counted: 0 };
  /** What the engine made of each move it has judged. */
  readonly verdicts = new WeakMap<MoveEvent, Verdict | null>();

  /**
   * The recordings the sound is made of, once they have been asked for: after the room's models
   * and textures are in, or at the first touch if that is sooner. Null if they could not be had.
   */
  private recordings: Promise<RawBank | null> | null = null;

  /** The game as it stood at the point being looked back at, while one is. */
  private shown: Game | null = null;
  /** Whether the game kept in the browser is the one on the board. */
  private keeping = false;
  /** Online: the side the server says has given the game up, applied once every move has been shown. */
  private givenUp: Side | null = null;
  /** Online: the server says the players have agreed a draw. Applied, like a resignation, once every move has been shown. */
  private agreedDraw = false;
  /** Online: the server says a draw was claimed (threefold, fifty moves), or given when time ran out against a side that could not be mated. Applied the same way. */
  private claimedDraw = false;
  private timedDraw = false;
  /** How many moves had been played when a draw was last offered from this screen. One offer a move is enough. */
  private drawAsked: number | null = null;
  /** Online: the offer from this screen is being taken back from here, so its going is no news. */
  private withdrawing = false;
  /** Online: a yes to the other player's offer is on its way. If the offer goes without a draw, they took it back first. */
  private agreeing = false;
  /** Online: this player has said no to the draw the other offered, and the server has not yet said it is gone. */
  private declining = false;

  private selected: Square | null = null;
  private options: MoveOption[] = [];
  private hovered: Square | null = null;
  /** The last square the room was told the player is thinking about, so that it is told once. */
  private mused: Square | null = null;
  private busy = false;
  /** Bumped whenever the position is replaced, so that a move still animating knows it has been overtaken. */
  private epoch = 0;
  private press: {
    /** The pointer pressing, and whether it is a finger. */
    id: number;
    touch: boolean;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    lastTime: number;
    dragging: boolean;
    /** The stone of the player's own that the press began on, if it did: it is being carried, not the camera turned. */
    grabbed: Square | null;
    /** Whether that stone was already the chosen one, so that a plain click on it lets it go. */
    wasChosen: boolean;
  } | null = null;
  private last = performance.now();
  private time = 0;
  /**
   * When true, only `advance` moves time on; the browser's own frames draw nothing new. For
   * automated checks that need every step to be exactly the size they asked for.
   */
  held = false;

  /** The chess engine, once it has been asked for. Resolves to null if it could not be loaded. */
  private engine: Promise<Engine | null> | null = null;
  /** The engine's look at each position of this game, by FEN. */
  private notes = new Map<string, Promise<Analysis | null>>();
  /** The position (by `epoch`) of the finished online game the engine was last set to looking over, so that it is set to it once. */
  private reviewed = -1;
  /** When the first move of the game on the board was made (performance.now), if this screen saw it made. */
  private began: number | null = null;
  /** Whether the players have been shown coming to the board for the online game on it, which is done once a game. */
  private introduced = false;
  private introCount = 0;
  /** The computer's answer to the position it is thinking about. Replaced or dropped when the position moves on. */
  private reply: { epoch: number; ply: number; move: Promise<EngineMove | null>; claimed: boolean } | null = null;

  private net: Net | null = null;
  /** The connection to the server outside any room, once it has been needed: the queue and the rankings. */
  private hall: Hall | null = null;
  /** Running while the server is being tried and not reached: by the hall, and by the room. When one goes off, the player is told. */
  private hallWait: ReturnType<typeof setTimeout> | null = null;
  private roomWait: ReturnType<typeof setTimeout> | null = null;
  /** The player has been turned away from the queue until a set time: what puts the turn away then. */
  private turnedTimer: ReturnType<typeof setTimeout> | null = null;
  /** A name just given, waiting for the server to say whether it is the one in use; and what puts "Saved" away. */
  private naming: string | null = null;
  private savedTimer: ReturnType<typeof setTimeout> | null = null;
  /** The fingers on the board, by pointer, where each last was: two of them pinch the view nearer or further. */
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: number | null = null;
  /** For finding where a finger meets the board: the board's surface is the plane y = 0. */
  private ray = new Raycaster();
  private surface = new Plane(new Vector3(0, 1, 0), 0);
  /** Moves the server has announced that have not been shown yet (one is shown at a time). */
  private inbox: { ply: number; move: MoveData }[] = [];
  /** A move of this player's that has been shown here but not yet confirmed by the server. */
  private unconfirmed: { ply: number; move: MoveData } | null = null;

  /** How the player asked for their side in the game against the computer being played: a side, or by lot. */
  private sideAsked: Side | 'either' = 'w';
  /** Where the lessons have got to. */
  private lessonAt: { lesson: number; step: number } | null = null;
  /** The hint worked out for a position, kept so that asking again shows more of the same one. */
  private hinted: { fen: string; hint: Hint } | null = null;
  /** Rules waiting to be explained, after the one on screen. */
  private explainQueue: Topic[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {
    loadSettings();
    this.world = new World(canvas, ui.quality.value ?? 'medium');
    if (!ui.quality.value) {
      ui.quality.value = suggestQuality(this.world.renderer);
      this.world.setQuality(ui.quality.value);
    }
    this.rig = new CameraRig(this.world.camera);
    this.rig.mode = ui.cameraMode.value;
    this.rig.snap();
    // A player who has asked their system for less movement gets a camera that does not push in,
    // unless they have turned it on themselves.
    if (stillness() && !cinematicIsChosen()) ui.cinematic.value = false;
    // A stone set down is felt in the picture, unless the camera has been asked to keep still.
    this.world.onThud = (strength) => {
      if (ui.cinematic.value && !stillness()) this.rig.thud(strength);
    };
    this.world.pieces.reset(this.game.pieces());
    this.publish();
    ui.saved.value = this.kept();
    ui.player.value = { name: identity().name, card: null };
    this.bind();
    // While a card of text stands at the left (a lesson, a rule being explained, how the game ended), the board is framed beside it.
    // The choice of game stands down the left as well, and is wider.
    effect(() =>
      this.world.keepClear(ui.menuOpen.value ? BILL_COLUMN : ui.lesson.value || ui.explain.value || (ui.resultVisible.value && ui.status.value.over) ? CARD_COLUMN : 0),
    );

    // Put away to look at the board alone, the interface comes back by itself for anything that wants reading or answering.
    effect(() => {
      if (this.wantsReading()) ui.bare.value = false;
    });

    // The board's coordinates are painted with a webfont; repaint once it has loaded.
    void document.fonts?.load('500 24px "DM Mono"').then(() => this.world.refreshLabels());

    // An address that names a room is an invitation to it. Otherwise the game opens on the choice of what to play.
    const invited = roomInAddress();
    if (invited) {
      this.startOnline(invited.room, invited.watch, 'link');
    } else {
      ui.opening.value = true;
      ui.menuOpen.value = true;
      // The board waits shut in its case, with the stones put away; it opens when a game begins.
      this.world.pack();
      // Behind the opening screen the camera goes slowly round the shut case, low, and back far
      // enough to keep it whole in the part of the picture the menu leaves; and is still, for a
      // player who has asked for less movement.
      this.rig.setMode('orbit', 0.01);
      this.rig.setOrbit({ azimuth: 0.95, elevation: 0.3, radius: 17 });
      this.rig.drift = stillness() ? 0 : OPENING_DRIFT;
    }

    void this.loadFinishedLook();
    requestAnimationFrame(this.frame);
  }

  /** Fetch the Blender-built assets and swap them in. If that fails, the grey-box stays. */
  private async loadFinishedLook(): Promise<void> {
    // The hands are fetched alongside; without them the pieces go on moving by themselves.
    const hands = loadHandTemplate().catch((error: unknown) => {
      console.warn('Could not load the hands; the pieces will move by themselves.', error);
      return null;
    });
    try {
      const assets = await loadAssets(this.world.maxAnisotropy);
      // The sounds are fetched once the room's models and textures are in, not alongside them: on
      // a slow line the first picture comes sooner. (A touch before then asks for them at once.)
      void this.soundBank();
      this.world.useAssets(assets);
      document.body.classList.add('finished');
      const template = await hands;
      if (template) {
        this.world.useHands(template, assets);
        this.world.seatTaken(this.game.history());
        this.world.setTurn(this.game.status().over ? null : this.game.turn());
      }
      // The room is shown once everything in it can be drawn without a pause to build it.
      try {
        await this.world.warm();
      } catch (error) {
        console.warn('Could not build the shaders ahead of time; each will be built as it is first drawn.', error);
      }
    } catch (error) {
      console.warn('Could not load the finished assets; staying on the grey-box.', error);
    } finally {
      // The book of openings is built behind the loading screen too, not in the frame of the first move.
      try {
        prepareOpenings();
      } catch (error) {
        console.warn('Could not build the book of openings ahead of time.', error);
      }
      // The room does not wait for its sounds: they come when they come, and until then it is quiet.
      void this.soundBank();
      ui.ready.value = true;
      // The engine is fetched last: the room should not wait for it. A page opened on an online
      // game still being played does not fetch it at all.
      if (this.assisted()) void this.bootEngine();
    }
  }

  /** The position on the board: the game as it stands or, while looking back, as it stood then. */
  get board(): Game {
    return this.shown ?? this.game;
  }

  // -- actions the interface can call -----------------------------------------

  setCamera(mode: CameraMode): void {
    ui.cameraMode.value = mode;
    this.rig.setMode(mode);
    this.syncSeat(1.15);
    saveSettings();
    this.refreshHover();
  }

  /** Sit on the other side of the board. */
  flip(): void {
    ui.seat.value = opposite(ui.seat.value);
    this.rig.setSeat(ui.seat.value);
  }

  setFollowTurn(on: boolean): void {
    ui.followTurn.value = on;
    this.syncSeat();
    saveSettings();
  }

  setQuality(quality: Quality): void {
    ui.quality.value = quality;
    this.world.setQuality(quality);
    markQualityChosen();
    saveSettings();
    this.pace.counted = 0;
    this.restoreScale();
  }

  /**
   * Let the game choose the quality again, as it does the first time: what suits this machine,
   * stepped down by itself if the game then runs slowly. The player's own choice is forgotten.
   */
  setQualityAuto(): void {
    forgetQualityChoice();
    const quality = suggestQuality(this.world.renderer);
    ui.quality.value = quality;
    this.world.setQuality(quality);
    saveSettings();
    this.pace = { ms: 16.7, counted: 0 };
    this.restoreScale();
  }

  /** A new quality starts at its full size; how it runs is then found out afresh. */
  private restoreScale(): void {
    this.governor.reset();
    this.world.setRenderScale(1);
    this.stats.scale = 1;
  }

  setCinematic(on: boolean): void {
    ui.cinematic.value = on;
    markCinematicChosen();
    if (!on) this.rig.releaseCut();
    saveSettings();
  }

  setVolume(which: keyof Volumes, level: number): void {
    ui.volume.value = { ...ui.volume.value, [which]: Math.max(0, Math.min(1, level)) };
    this.world.sound?.setVolumes(ui.volume.value);
    saveSettings();
  }

  /**
   * Start the sound. Browsers only allow this from something the player has done, so it is
   * called from the first click or key press. Does nothing if sound cannot be had.
   */
  private wakeSound(): void {
    // A touch before the room has finished loading asks for the recordings at once: they will be wanted now.
    void this.soundBank();
    if (this.world.sound) {
      // Suspended, or (Safari, after a call or the screen locking) interrupted: either way not playing.
      const ctx = this.world.sound.ctx as AudioContext;
      if (ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => {});
      return;
    }
    try {
      const ctx = new AudioContext();
      const sound = new Sound(ctx, ui.volume.value);
      // The room starts as soon as its recordings have been decoded for this output.
      sound.startRoom();
      this.world.sound = sound;
      // The room takes up the game as it stands, to be heard. Not one that is over: that is as its
      // ending left it, and standing it again would cut short whatever the hands are playing for it.
      if (!this.game.status().over) this.world.resetLife(this.game.status());
      void this.soundBank()
        .then((raw) => (raw ? decodeBank(ctx, raw) : null))
        .then((bank) => {
          if (bank) sound.use(bank);
        })
        .catch((error: unknown) => console.warn('The sounds could not be made ready.', error));
    } catch (error) {
      console.warn('No sound: the browser would not open an audio output.', error);
    }
  }

  /** The recordings the sound is made of: asked for the first time they are wanted, and only once. */
  private soundBank(): Promise<RawBank | null> {
    this.recordings ??= fetchBank().catch((error: unknown) => {
      console.warn('Could not load the sounds; the game will be silent.', error);
      return null;
    });
    return this.recordings;
  }

  /** Put away the choice of game. The first time, the camera comes round from its drift to the view the player uses. */
  private closeMenu(): void {
    ui.menuOpen.value = false;
    if (!ui.opening.value) return;
    ui.opening.value = false;
    this.rig.drift = 0;
    // Swept round, unless the player has asked for less movement: then it is simply there. While
    // the case opens the sweep is slower, so that it comes round as the stones come out.
    const sweep = stillness() ? 0.01 : this.world.packed ? 3.4 : 1.8;
    this.rig.setMode(ui.cameraMode.value, sweep);
    this.rig.setSeat(ui.seat.value, sweep);
  }

  /** Two players at this screen, taking turns. */
  startTable(fen?: string): void {
    this.leaveMode();
    ui.mode.value = { kind: 'table' };
    ui.you.value = null;
    this.closeMenu();
    this.wakeEngine();
    this.setUp(fen);
  }

  /** The lessons, from the first step or from a given one. */
  startLessons(lesson = 0, step = 0): void {
    this.leaveMode();
    ui.mode.value = { kind: 'lessons' };
    ui.you.value = 'w';
    this.closeMenu();
    this.wakeEngine();
    ui.seat.value = 'w';
    this.enterStep(Math.max(0, Math.min(LESSONS.length - 1, lesson)), step, true);
  }

  /** On to the next step of the lessons, or to the end of them. */
  nextStep(): void {
    const at = this.lessonAt;
    if (!at) return;
    // Only a step that was done leaves the board as the next one expects to find it. One that
    // was skipped (perhaps with a move still in the air) does not, and the next sets itself up.
    const afresh = ui.lesson.value?.state !== 'done';
    if (at.step + 1 < LESSONS[at.lesson]!.steps.length) this.enterStep(at.lesson, at.step + 1, afresh);
    else if (at.lesson + 1 < LESSONS.length) this.enterStep(at.lesson + 1, 0, afresh);
    else {
      this.select(null);
      this.world.markers.set('hint', []);
      ui.lesson.value = { ...this.lessonView('finished', null), title: 'That is the whole game', ask: null, say: 'You know how every stone moves, what check and checkmate are, and the three odd rules. Play your first game: the computer will go gently, a hint is one click away, the board will stop you before a blunder, and you can take moves back.' };
    }
  }

  /** Back to the step before. */
  previousStep(): void {
    const at = this.lessonAt;
    if (!at) return;
    if (ui.lesson.value?.state === 'finished') this.enterStep(at.lesson, at.step, true);
    else if (at.step > 0) this.enterStep(at.lesson, at.step - 1, true);
    else if (at.lesson > 0) this.enterStep(at.lesson - 1, LESSONS[at.lesson - 1]!.steps.length - 1, true);
  }

  /** In a lesson: mark the move that is being asked for. */
  showMe(): void {
    const step = this.lessonStep();
    if (!step?.task || ui.lesson.value?.state !== 'task' || this.busy) return;
    const move = solve(this.game.fen(), step.task);
    if (!move) return;
    this.select(null);
    this.world.markers.set('hint', [
      { square: move.from, kind: 'hint' },
      { square: move.to, kind: 'hint', delay: 0.25 },
    ]);
    this.world.consider('w', move.from);
  }

  /**
   * Ask the engine what it would play. The first time it only points at the stone; asked again
   * in the same position, it says where the stone should go and what that does.
   */
  async hint(): Promise<void> {
    if (!this.canHint()) return;
    const fen = this.game.fen();
    const epoch = this.epoch;
    if (this.hinted?.fen !== fen) {
      const found = await this.analysis();
      // The game has moved on while the engine thought, or the player has: to look back, or to a question.
      if (epoch !== this.epoch || fen !== this.game.fen() || !this.canHint()) return;
      const best = found?.lines[0]?.move;
      const hint = best ? describeHint(fen, best) : null;
      if (!hint) {
        ui.notice.value = 'No hint this time: the chess engine has nothing to say about this position.';
        return;
      }
      this.hinted = { fen, hint };
      ui.hint.value = null;
    }
    const hint = this.hinted!.hint;
    const stage = ui.hint.value?.stage === 1 ? 2 : (ui.hint.value?.stage ?? 1);
    ui.hint.value = { stage, text: stage === 1 ? hint.look : hint.move };
    this.select(null);
    this.world.markers.set('hint', stage === 1 ? [{ square: hint.from, kind: 'hint' }] : [
      { square: hint.from, kind: 'hint' },
      { square: hint.to, kind: 'hint', delay: 0.2 },
    ]);
    this.world.consider(this.game.turn(), hint.from);
  }

  /** The player has read the warning about a blunder: play the move after all, or let it go. */
  answerWarning(playAnyway: boolean): void {
    const w = ui.warning.value;
    if (!w) return;
    ui.warning.value = null;
    if (playAnyway) void this.play(w.from, w.to, w.promotion);
    else this.refreshHover();
  }

  /** The player has read the rule being explained. With `stop`, nothing more is explained. */
  dismissExplain(stop = false): void {
    const topic = ui.explain.value;
    if (topic && !ui.seen.value.includes(topic)) ui.seen.value = [...ui.seen.value, topic];
    if (stop) {
      this.explainQueue = [];
      ui.aids.value = { ...ui.aids.value, explain: false };
    }
    ui.explain.value = this.explainQueue.shift() ?? null;
    saveSettings();
  }

  /** Turn one kind of help on or off. */
  setAid(which: keyof Aids, on: boolean): void {
    ui.aids.value = { ...ui.aids.value, [which]: on };
    saveSettings();
    this.refreshAids();
  }

  /** Turn all of the help on or off at once. */
  setAllAids(on: boolean): void {
    ui.aids.value = { moves: on, danger: on, hints: on, warn: on, explain: on, labels: on };
    saveSettings();
    this.refreshAids();
  }

  /** Explain every rule again from the next time it comes up. */
  forgetExplained(): void {
    ui.seen.value = [];
    saveSettings();
  }

  /** One player here against the engine. With 'either', the side is drawn by lot. */
  startComputer(level: string, side: Side | 'either', fen?: string): void {
    this.leaveMode();
    ui.computer.value = { level, side };
    saveSettings();
    const mine: Side = side === 'either' ? (Math.random() < 0.5 ? 'w' : 'b') : side;
    ui.mode.value = { kind: 'computer', level: LEVELS.some((l) => l.id === level) ? level : 'casual', side: mine };
    this.sideAsked = side;
    ui.you.value = mine;
    this.closeMenu();
    ui.seat.value = mine;
    // An engine that failed to load is asked for again: the trouble may have passed.
    if (ui.engine.value === 'failed') this.engine = null;
    void this.bootEngine();
    this.setUp(fen);
  }

  /**
   * A game held by the server. With no room named, a new one is made, and this player is its
   * first. `how` says how the room was come to: by a link (the page's address), or a match the
   * queue made.
   */
  startOnline(room?: string, watch = false, how: 'link' | 'match' = 'link'): void {
    this.leaveMode();
    const name = room ?? newRoomName();
    const keys = browserKeys();
    // A link to a room this browser has never sat in. If the server has no game there either, the
    // player is the first one in a new one, and should know it rather than wait for nobody.
    const stranger = room !== undefined && how === 'link' && !watch && !keys.own(name) && keys.remembered(name).length === 0;
    ui.mode.value = { kind: 'online', room: name };
    ui.you.value = null;
    this.closeMenu();
    const nobody = { w: false, b: false };
    // Sitting down to a game is the end of waiting for one.
    if (ui.queue.value) this.cancelMatch();
    this.introduced = false;
    ui.online.value = {
      room: name,
      seat: null,
      link: 'connecting',
      taken: nobody,
      present: nobody,
      watching: 0,
      again: nobody,
      offer: null,
      note: null,
      ranked: false,
      players: { w: null, b: null },
      clock: null,
      control: null,
      choosable: false,
      ended: null,
      change: null,
      closed: null,
      firstHere: false,
      stuck: false,
    };
    setAddress(name, watch);
    this.setUp();
    this.awaitRoom();
    this.net = new Net({
      url: serverUrl(),
      room: name,
      keys,
      watch,
      who: identity,
      handlers: {
        link: (link) => {
          this.patchOnline({ link });
          // In, or given up for good: there is nothing to wait for. Dropped: the wait begins again.
          if (link === 'open' || link === 'displaced') this.reachedRoom();
          else if (link === 'lost') this.awaitRoom();
        },
        joined: (you, state) => {
          const o = ui.online.value;
          const other = you === 'w' || you === 'b' ? opposite(you) : null;
          if (o && stranger && other && !state.ranked && state.moves.length === 0 && !state.taken[other]) this.patchOnline({ firstHere: true });
          this.onJoined(you, state);
        },
        state: (state) => this.onRoom(state),
        moved: (ply, move, clock) => this.onMoved(ply, move, clock),
        welcome: (card) => this.welcomed(card),
        think: (side, square) => {
          if (side !== ui.you.value) this.world.consider(side, square);
        },
        refused: (reason, state) => {
          // At the door of a room whose game is gone (called off, or over and put away): there is
          // nothing to sit down to, and the player is told so plainly and shown the way back.
          if (ui.online.value?.seat === null && (reason === 'This game was called off.' || reason === 'This game is over.')) {
            this.closeRoom(reason === 'This game was called off.' ? 'This game was called off. It was not rated.' : 'This game is over.');
            return;
          }
          this.noteRoom(state);
          this.adopt(state);
          // Said after the board has been put right, which clears whatever was being said before. A
          // move that crossed with the end of the game (the other player gave up first) was not a
          // mistake of the player's, and how the game ended is already being said.
          const crossed = ui.you.value !== null && this.game.status().over;
          ui.notice.value = crossed ? null : reason;
          // Refused at the door (the room is full): there is no seat, and the card for the room says why.
          if (ui.online.value?.seat === null) this.patchOnline({ note: reason });
        },
        seated: (you, state) => {
          this.sit(you);
          this.noteRoom(state);
          this.adopt(state, true);
        },
      },
    });
  }

  // -- ranked play: the queue, the name, the rankings ------------------------------

  private theHall(): Hall {
    if (this.hall) return this.hall;
    this.awaitHall();
    this.hall = new Hall(serverUrl(), identity, {
      link: (up) => {
        if (ui.queue.value) ui.queue.value = { ...ui.queue.value, up };
        if (up) this.reachedHall();
        else this.awaitHall();
      },
      welcome: (card) => this.welcomed(card),
      queued: (waiting) => {
        if (ui.queue.value) ui.queue.value = { waiting, up: true };
      },
      turned: (reason, until) => this.turnedAway(reason, until),
      matched: (room) => {
        ui.queue.value = null;
        this.world.sound?.glass(null, 3);
        this.world.sound?.glass(null, 5, 0.16);
        this.startOnline(room, false, 'match');
      },
      board: (top, you) => (ui.ranks.value = { top, you }),
    });
    return this.hall;
  }

  /** The hall is being tried: if it is still not reached in a while, the player is told so. */
  private awaitHall(): void {
    if (this.hallWait !== null) return;
    this.hallWait = setTimeout(() => {
      this.hallWait = null;
      if (!this.hall?.up) ui.unreachable.value = true;
    }, patience.reach);
  }

  private reachedHall(): void {
    if (this.hallWait !== null) clearTimeout(this.hallWait);
    this.hallWait = null;
    ui.unreachable.value = false;
  }

  /** The room is being tried: if it is still not reached in a while, the player is told so. */
  private awaitRoom(): void {
    if (this.roomWait !== null) return;
    const net = this.net;
    this.roomWait = setTimeout(() => {
      this.roomWait = null;
      // Only for the room it was set for, and only if it is still not in.
      if (this.net === net && ui.online.value && ui.online.value.link !== 'open') this.patchOnline({ stuck: true });
    }, patience.reach);
  }

  private reachedRoom(): void {
    if (this.roomWait !== null) clearTimeout(this.roomWait);
    this.roomWait = null;
    if (ui.online.value?.stuck) this.patchOnline({ stuck: false });
  }

  /**
   * The player asks for the server to be tried again now, after being told it could not be
   * reached. The tries go on by themselves meanwhile; this only makes the next one now, and gives
   * it as long again before saying anything.
   */
  retryServer(): void {
    if (this.hall) {
      ui.unreachable.value = false;
      if (this.hallWait !== null) clearTimeout(this.hallWait);
      this.hallWait = null;
      if (!this.hall.up) this.awaitHall();
      this.hall.reconnect();
    }
    if (this.net && ui.online.value && ui.online.value.link !== 'open') {
      if (this.roomWait !== null) clearTimeout(this.roomWait);
      this.roomWait = null;
      this.patchOnline({ stuck: false });
      this.awaitRoom();
      this.net.reconnect();
    }
  }

  /** The server would not put this player in the queue. If they must wait, the turn is put away when the wait is over. */
  private turnedAway(reason: string, until?: number): void {
    ui.queue.value = null;
    if (this.turnedTimer !== null) clearTimeout(this.turnedTimer);
    this.turnedTimer = null;
    const wait = until !== undefined && until > 0 ? until : null;
    ui.turned.value = { reason, until: wait === null ? null : Date.now() + wait };
    if (wait !== null) {
      this.turnedTimer = setTimeout(() => {
        this.turnedTimer = null;
        if (ui.turned.value?.until !== null) ui.turned.value = null;
      }, wait);
    }
  }

  /** Put away the card that says the server turned the player away. A wait still running is still said in the choice of game. */
  dismissTurned(): void {
    const t = ui.turned.value;
    if (!t) return;
    ui.turned.value = t.until !== null && t.until > Date.now() ? { ...t, away: true } : null;
  }

  /** Wait to be matched with another player for a ranked game. Whatever is being played goes on until one is found. */
  findMatch(): void {
    if (ui.queue.value) return;
    // Told to wait: the wait is not over yet.
    const turned = ui.turned.value;
    if (turned?.until && turned.until > Date.now()) return;
    ui.turned.value = null;
    ui.queue.value = { waiting: 1, up: this.hall?.up ?? false };
    this.theHall().queue();
  }

  cancelMatch(): void {
    if (!ui.queue.value) return;
    ui.queue.value = null;
    this.hall?.unqueue();
  }

  /**
   * After a ranked game: leave its room and wait for the next match. The board is cleared for a
   * game at this screen meanwhile, as when a match is looked for from the choice of game.
   */
  anotherMatch(): void {
    this.findMatch();
    if (ui.mode.value.kind === 'online') this.startTable();
  }

  /** Leave the online room for the choice of game. */
  leaveRoom(): void {
    if (ui.mode.value.kind === 'online') this.startTable();
    ui.menuOpen.value = true;
  }

  /**
   * Show the players coming to the board, once, as an online game begins: when both seats are
   * taken and no move has been made. It is heard as well, unless the queue has just been heard
   * making the match. It goes by itself, or at a click, a key or a move.
   */
  private introduce(): void {
    const o = ui.online.value;
    if (this.introduced || !o || o.seat === null || !o.taken.w || !o.taken.b) return;
    if (this.game.history().length > 0 || this.game.status().over) return;
    this.introduced = true;
    const id = ++this.introCount;
    // The room's clock, as it says it; a ranked room on a server from before rooms said so, read from its clocks.
    const clock = o.control ?? (o.ranked && o.clock ? { base: Math.round(Math.max(o.clock.left.w, o.clock.left.b) / 1000) * 1000, increment: RANKED_INCREMENT } : null);
    ui.intro.value = { id, ranked: o.ranked, you: ui.you.value, players: o.players, clock };
    if (!o.ranked) {
      this.world.sound?.glass(null, 3);
      this.world.sound?.glass(null, 5, 0.16);
    }
    void this.world.tweens.wait(INTRO_SECONDS).then(() => {
      // Played out to its end, it is put away with the sound of a card laid down.
      if (ui.intro.value?.id !== id) return;
      ui.intro.value = null;
      this.world.sound?.ui('close');
    });
  }

  /** Choose the clock of a friendly room, or none, between games. The server tells both players (see `noteRoom`). */
  setClock(control: TimeControl | null): void {
    const o = ui.online.value;
    if (!o?.choosable || (o.seat !== 'w' && o.seat !== 'b') || sameControl(control, o.control)) return;
    this.net?.control(control);
  }

  /** Put the players' coming to the board away before its time: a click, a key, or a move. */
  skipIntro(): void {
    if (ui.intro.value) ui.intro.value = null;
  }

  /**
   * Go by another name. The server and whoever is being played are told, and the server's answer
   * says whether it is the name now in use: it refuses some (see `cleanName`, and the server's own
   * list), and then keeps the player's old one or gives one of its own.
   */
  rename(name: string): void {
    const typed = name.trim();
    const kept = setName(typed);
    ui.player.value = { ...ui.player.value, name: kept };
    if (this.savedTimer !== null) clearTimeout(this.savedTimer);
    this.savedTimer = null;
    // Refused here already: nothing of it could be kept. The server is told no name, and says which it gives.
    const refused = typed !== '' && kept === '';
    ui.nameSaid.value = refused ? 'refused' : 'saved';
    this.naming = refused ? null : kept;
    if (!refused) this.savedTimer = setTimeout(() => ui.nameSaid.value === 'saved' && (ui.nameSaid.value = null), SAVED_SHOWS);
    // The hall is opened to ask, if it is not open yet: the answer is what says whether the name was taken.
    if (this.hall) this.hall.hello();
    else this.theHall();
    this.net?.hello();
  }

  /** The server has said who this player is. If it is not the name just given, that name was refused, and the field shows the one in use. */
  private welcomed(card: PlayerCard): void {
    const asked = this.naming;
    this.naming = null;
    if (asked !== null && asked !== '' && card.name !== asked) {
      if (this.savedTimer !== null) clearTimeout(this.savedTimer);
      this.savedTimer = null;
      setName(cleanName(card.name));
      ui.player.value = { name: card.name, card };
      ui.nameSaid.value = 'refused';
      return;
    }
    ui.player.value = { name: ui.player.value.name, card };
  }

  /** Show the best players, or put them away. */
  showRanks(open: boolean): void {
    ui.ranksOpen.value = open;
    if (open) this.theHall().board();
  }

  /**
   * Another game of the kind being played. Online, this asks for one, and it starts when the
   * other player asks too. A position can be given to start from (not online).
   */
  newGame(fen?: string): void {
    const mode = ui.mode.value;
    if (mode.kind === 'online') {
      // A ranked game is never played twice running against the same player: the next one is
      // against whoever the queue finds.
      if (ui.online.value?.ranked) this.anotherMatch();
      else this.net?.again();
      return;
    }
    if (mode.kind === 'computer' && !fen) {
      // The same opponent as the game just played, whatever has been looked at in the menu since;
      // and the side drawn by lot again, if that is how it was chosen.
      this.startComputer(mode.level, this.sideAsked);
      return;
    }
    if (mode.kind === 'lessons' && this.lessonAt) {
      this.enterStep(this.lessonAt.lesson, this.lessonAt.step, true);
      return;
    }
    this.setUp(fen);
  }

  /** Carry on the game kept in the browser from where it was left. */
  resume(): void {
    let saved: ReturnType<typeof readSavedGame> = null;
    try {
      saved = readSavedGame(localStorage);
    } catch {
      // No storage, so nothing kept.
    }
    if (!saved) {
      ui.saved.value = null;
      return;
    }
    this.leaveMode();
    if (saved.kind === 'computer') {
      const side = saved.side ?? 'w';
      ui.mode.value = { kind: 'computer', level: saved.level ?? 'casual', side };
      this.sideAsked = saved.asked ?? side;
      ui.you.value = side;
      if (ui.engine.value === 'failed') this.engine = null;
      void this.bootEngine();
    } else {
      ui.mode.value = { kind: 'table' };
      ui.you.value = null;
      this.wakeEngine();
    }
    this.closeMenu();
    ui.seat.value = saved.seat;
    // Putting it on the board keeps it again, as the game being played (see `keep`).
    this.restore(saved);
  }

  /** The side that would be giving the game up if this screen resigned: whoever is to move at a shared screen, or the one side this screen plays. */
  private resigner(): Side | null {
    const mode = ui.mode.value;
    if (mode.kind === 'lessons') return null;
    return mode.kind === 'table' ? this.game.turn() : ui.you.value;
  }

  /** Whether the game can be given up from this screen right now. */
  canResign(): boolean {
    if (this.game.status().over || this.game.history().length === 0 || !this.resigner()) return false;
    return ui.mode.value.kind !== 'online' || this.inPlay();
  }

  /** Online: whether the game in the room is one being played, with both players, a connection to it, and no end the server has put to it. */
  private inPlay(): boolean {
    const o = ui.online.value;
    return !!o && o.link === 'open' && o.taken.w && o.taken.b && o.ended === null && o.closed === null;
  }

  /** The Resign button. It ends the game, so the player is asked first. */
  askResign(): void {
    if (!this.canResign() || ui.promotion.value || ui.warning.value) return;
    ui.asking.value = 'resign';
  }

  /** The player has answered the question on screen. */
  answerAsk(yes: boolean): void {
    const asked = ui.asking.value;
    ui.asking.value = null;
    if (asked === 'resign' && yes) this.resign();
    if (asked === 'draw' && yes) this.offerDraw();
    if (asked === 'claim' && yes) this.claimDraw();
  }

  /**
   * The draw the player to move may claim from this screen now, if any: the position has stood
   * three times, or fifty moves each have passed without a capture or a pawn move (FIDE 9.2, 9.3).
   * It is the player to move who claims, so at one screen whoever is to move, and otherwise only
   * on this player's own move.
   */
  canClaim(): DrawClaim | null {
    const s = this.game.status();
    if (s.over || !s.claimable || this.busy || ui.viewing.value !== null || this.resigner() !== s.turn) return null;
    if (ui.mode.value.kind === 'online' && !this.inPlay()) return null;
    return s.claimable;
  }

  /** Claim the draw the position allows. Online the server checks the claim and tells everyone; otherwise the game is drawn at once. */
  claimDraw(): void {
    if (!this.canClaim()) return;
    if (ui.mode.value.kind === 'online') this.net?.claim();
    else this.claimFor();
  }

  /** The player to move has claimed a draw: the game is over, and the room answers. */
  private claimFor(): void {
    this.conclude(
      () => this.game.claimDraw(),
      () => this.game.drawClaimed() !== null,
    );
  }

  /**
   * Whether a draw can be offered from this screen right now. Both sides must have moved, and
   * each offer has to wait for the next move before there can be another.
   */
  canDraw(): boolean {
    const played = this.game.history().length;
    if (this.game.status().over || played < 2 || !this.resigner()) return false;
    const mode = ui.mode.value;
    if (mode.kind === 'online') {
      // An offer that is standing, from either side, is answered where it is shown and not by another.
      if (!this.inPlay() || ui.online.value?.offer !== null) return false;
    }
    // The computer answers for the position in front of the player, so it is asked on the player's own turn.
    if (mode.kind === 'computer' && (this.game.turn() !== mode.side || this.engine === null || ui.engine.value === 'failed')) return false;
    return this.drawAsked === null || played >= this.drawAsked + 2;
  }

  /**
   * The Draw button. Like giving the game up, it can end the game, so the player is asked first.
   * Where a draw may be claimed it claims one, and the question says why it may.
   */
  askDraw(): void {
    if (ui.promotion.value || ui.warning.value) return;
    if (this.canClaim()) ui.asking.value = 'claim';
    else if (this.canDraw()) ui.asking.value = 'draw';
  }

  /**
   * Offer a draw. Two players at one screen have agreed it between themselves; the computer
   * answers for itself; online the other player is asked, and may take as long as they like.
   */
  offerDraw(): void {
    if (!this.canDraw()) return;
    const mode = ui.mode.value;
    this.drawAsked = this.game.history().length;
    // Online the hands hold it out once the server has it (noteRoom).
    if (mode.kind !== 'online') this.world.setOffer(this.resigner());
    if (mode.kind === 'table') this.agree();
    else if (mode.kind === 'online') this.net?.draw();
    else if (mode.kind === 'computer') void this.considerDraw();
    this.refreshHover();
  }

  /** Online: say yes or no to the draw the other player has offered, or (with no) take back the one offered from here. */
  answerDraw(yes: boolean): void {
    const o = ui.online.value;
    const you = ui.you.value;
    if (ui.mode.value.kind !== 'online' || !o || !you || o.link !== 'open' || o.offer === null) return;
    if (yes) {
      if (o.offer !== you && this.net?.agree()) this.agreeing = true;
      return;
    }
    // Taking my own back is not being told no.
    if (o.offer === you) this.withdrawing = true;
    else this.declining = true;
    this.net?.noDraw();
  }

  /**
   * The computer is offered a draw. It agrees if the game has gone on a while and the engine
   * does not think the computer's side is the better off; otherwise it would rather play on.
   */
  private async considerDraw(): Promise<void> {
    const epoch = this.epoch;
    const played = this.game.history().length;
    const fen = this.game.fen();
    const [look] = await Promise.all([this.analysis(), this.world.tweens.wait(DRAW_PAUSE)]);
    // The game has moved on, or ended, or been put away while it thought: the offer is forgotten.
    if (epoch !== this.epoch || this.game.fen() !== fen || this.game.history().length !== played || this.game.status().over) {
      if (epoch === this.epoch && !this.game.status().over) this.world.setOffer(null);
      return;
    }
    const score = look?.lines[0]?.score;
    // The engine's number is for the side to move, which is the player: the computer's is the other way up.
    const forComputer = score ? -worth(score) : null;
    const began = this.game.start();
    const old = (began.moveNumber - 1) * 2 + (began.side === 'b' ? 1 : 0) + played >= DRAW_NOT_BEFORE;
    if (forComputer !== null && old && forComputer <= DRAW_MARGIN) {
      this.agree();
      return;
    }
    this.world.setOffer(null, 'refused');
    ui.notice.value =
      forComputer === null
        ? 'The computer would rather play on.'
        : old
          ? 'The computer would rather play on: it likes its position.'
          : 'The computer would rather play on: the game is young yet.';
    this.refreshHover();
  }

  /** Give the game up. Online the server is told, and tells everyone; otherwise it is over at once. */
  resign(): void {
    const side = this.resigner();
    if (!side || !this.canResign()) return;
    if (ui.mode.value.kind === 'online') this.net?.resign();
    else this.concede(side);
  }

  /** A side has given the game up: the game is over, and the room answers. */
  private concede(side: Side): void {
    this.conclude(
      () => this.game.resign(side),
      () => this.game.resigned() === side,
    );
  }

  /** The players have agreed a draw: the game is over, and the room answers. */
  private agree(): void {
    this.conclude(
      () => this.game.agreeDraw(),
      () => this.game.drawAgreed(),
    );
  }

  /**
   * The players have ended the game themselves, with no move: `end` does it in the rules, and
   * `holds` says whether it is still so a moment later, when the card that says how it ended comes up.
   */
  private conclude(end: () => boolean, holds: () => boolean): void {
    this.leaveView();
    if (!end()) return;
    const epoch = this.epoch;
    this.cancelThinking();
    this.select(null);
    this.clearHint();
    ui.warning.value = null;
    ui.promotion.value = null;
    ui.asking.value = null;
    this.rig.releaseCut();
    this.publish();
    // An online game given up or agreed drawn is over, and may now be looked over.
    this.review();
    // With a move still in the air the room answers when it lands (see `play`).
    if (!this.busy) this.world.resetLife(this.game.status(), true);
    void this.world.tweens.wait(RESIGN_PAUSE).then(() => {
      if (epoch === this.epoch && holds() && ui.viewing.value === null) ui.resultVisible.value = true;
    });
    this.refreshHover();
  }

  /**
   * The game so far written out the way other chess programs read it (PGN), to keep or to look
   * at more closely somewhere else.
   */
  record(): string {
    const mode = ui.mode.value;
    const name = (side: Side): string => {
      if (mode.kind !== 'computer' || side === mode.side) return SIDE_NAME[side];
      const level = LEVELS.find((l) => l.id === mode.level)?.label;
      return level ? `${SIDE_NAME[side]} (computer, ${level})` : `${SIDE_NAME[side]} (computer)`;
    };
    return writePgn(this.game, { event: BRAND.name, white: name('w'), black: name('b') });
  }

  /**
   * Look back at the game as it stood after `ply` moves, without changing it. Null comes back
   * to the present, and so does the last position of a game still being played.
   */
  view(ply: number | null): void {
    const moves = this.game.history();
    let to = ply === null ? null : Math.max(0, Math.min(moves.length, Math.round(ply)));
    if (to === moves.length && !this.game.status().over) to = null;
    if (to === null) return this.leaveView();
    if (to === ui.viewing.value) return;
    if (this.busy || ui.promotion.value || ui.warning.value || ui.asking.value || ui.mode.value.kind === 'lessons' || moves.length === 0) return;
    let shown: Game;
    try {
      shown = new Game(this.game.startFen());
      for (let i = 0; i < to; i++) {
        const m = dataOf(moves[i]!);
        shown.move(m.from, m.to, m.promotion);
      }
      // The end of a game that ended off the board is the end of it here too: given up, agreed, claimed or drawn on time.
      if (to === moves.length) {
        const gaveUp = this.game.resigned();
        if (this.game.drawClaimed()) shown.claimDraw();
        else if (this.game.drawAgreed()) shown.agreeDraw();
        else if (this.game.drawnOnTime()) shown.drawOnTime();
        else if (gaveUp) shown.resign(gaveUp);
      }
    } catch {
      return;
    }
    const from = ui.viewing.value ?? moves.length;
    this.select(null);
    this.clearHint();
    this.rig.releaseCut();
    this.shown = shown;
    ui.viewing.value = to;
    ui.resultVisible.value = false;
    this.stand(shown);
    this.world.setTurn(null);
    this.secondThought(to, shown);
    // One step on is heard as the stone being set down; one step back, as it being picked up again.
    const sound = this.world.sound;
    if (to === from + 1) {
      const e = moves[to - 1]!;
      sound?.stoneSet(squareCenter(e.piece.to), e.side === 'w', 0.7);
    } else if (to === from - 1) {
      const e = moves[to]!;
      sound?.stoneLift(squareCenter(e.piece.from), e.side === 'w');
    }
    this.refreshHover();
  }

  /**
   * Looking back at a position from which a slip or a blunder was then played: mark the move the
   * engine would have made instead, and say what it was. It is the same help as a hint, so it is
   * given where hints are, and online only once the game is over (when it is all there is to see).
   */
  private secondThought(ply: number, at: Game): void {
    const e = this.game.history()[ply];
    const verdict = e ? this.verdicts.get(e) : null;
    if (!e || !verdict || (verdict.kind !== 'slip' && verdict.kind !== 'blunder')) return;
    if (!ui.aids.value.hints || !this.assisted()) return;
    const better = describeHint(at.fen(), verdict.best);
    if (!better) return;
    const said = better.move.charAt(0).toLowerCase() + better.move.slice(1);
    ui.hint.value = {
      stage: 2,
      label: 'Better',
      text: `${SIDE_NAME[e.side]} played ${e.san} here, ${verdict.kind === 'blunder' ? 'a blunder' : 'a slip'}. Better: ${said}`,
    };
    this.world.markers.set('hint', [
      { square: better.from, kind: 'hint' },
      { square: better.to, kind: 'hint', delay: 0.2 },
    ]);
  }

  /** Step the look back by a number of moves: a negative number goes back. */
  stepView(by: number): void {
    this.view((ui.viewing.value ?? this.game.history().length) + by);
  }

  /** Come back from looking at an earlier position to the game as it stands. */
  private leaveView(): void {
    if (ui.viewing.value === null) return;
    this.shown = null;
    ui.viewing.value = null;
    this.clearHint();
    this.stand(this.game);
    const s = this.game.status();
    this.world.setTurn(s.over ? null : s.turn);
    ui.resultVisible.value = s.over && ui.mode.value.kind !== 'lessons';
    this.refreshHover();
  }

  /** Take back the last move (and, against the computer, its answer). `forced` is a lesson putting a wrong move back. */
  async takeBack(forced = false): Promise<void> {
    if (this.busy || ui.promotion.value || ui.warning.value || ui.asking.value) return;
    this.leaveView();
    if (!forced && this.game.endedOffBoard()) {
      // A game given up, or agreed drawn, is taken up again. Nothing on the board has to move.
      if (this.takeBackCount() === 0) return;
      this.game.reopen();
      this.showPosition();
      this.next();
      return;
    }
    const count = forced ? Math.min(1, this.game.history().length) : this.takeBackCount();
    if (count === 0) return;
    const epoch = this.epoch;
    this.cancelThinking();
    this.busy = true;
    this.select(null);
    this.rig.releaseCut();
    ui.resultVisible.value = false;
    ui.notice.value = null;
    this.clearHint();
    this.world.markers.set('check', []);
    for (let i = 0; i < count; i++) {
      const e = this.game.undo();
      if (!e) break;
      this.showLastMove();
      this.publish();
      await this.world.playUndo(e, this.game.status());
      if (epoch !== this.epoch) return;
    }
    // A draw offered on a move since taken back counts as offered here: one more move, and there can be another.
    if (this.drawAsked !== null) this.drawAsked = Math.min(this.drawAsked, this.game.history().length);
    this.showCheck();
    this.busy = false;
    this.syncSeat();
    this.refreshHover();
    this.next();
  }

  /** Finish a pawn move that is waiting for a promotion choice, or cancel it with null. */
  choosePromotion(kind: PromotionKind | null): void {
    const request = ui.promotion.value;
    if (!request) return;
    ui.promotion.value = null;
    if (kind) void this.attempt(request.from, request.to, kind);
  }

  /**
   * A move the player has chosen. With the blunder warning on, the engine looks at it first,
   * and if it would throw the game away the player is asked before it is played.
   */
  private async attempt(from: Square, to: Square, promotion?: PromotionKind): Promise<void> {
    if (!this.warns()) {
      await this.play(from, to, promotion);
      return;
    }
    const epoch = this.epoch;
    const ply = this.game.history().length;
    // What can be said without the engine: the stone would simply be lost where it lands.
    const hangs = this.options.find((o) => o.to === to)?.risky ?? false;
    const mover = this.game.pieceAt(from);
    let seen: string | null | undefined;
    // Only an engine that is up is asked. One still on its way (or never coming) would only hold the move back.
    if (ui.engine.value === 'ready') {
      this.busy = true;
      const patience = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), FORESIGHT_PATIENCE));
      seen = await Promise.race([this.foresee(from, to, promotion).catch(() => undefined), patience]);
      if (epoch !== this.epoch || ply !== this.game.history().length) return;
      this.busy = false;
      // Asked whether to give up or to offer a draw while the engine looked, or the game ended:
      // the move is let go. Played under the question, it would change whose answer it is.
      if (this.game.status().over || ui.asking.value) {
        this.select(null);
        // The room waits for a move in the air before it answers an ending (see `conclude`). This one never left the board.
        if (this.game.endedOffBoard()) this.world.resetLife(this.game.status(), true);
        return;
      }
    }
    let text = seen ?? null;
    // The engine could not say (it is not there, or it was too slow): go by what the board itself shows.
    if (seen === undefined && hangs && mover) {
      text = `Your ${KIND_WORD[mover.kind]} can be taken there, and you would not get its worth back.`;
    }
    if (text === null) {
      await this.play(from, to, promotion);
      return;
    }
    ui.warning.value = { from, to, ...(promotion ? { promotion } : {}), text };
  }

  /**
   * What the engine makes of a move before it is played: the words of a warning if it is a
   * blunder, null if it is not, and undefined if the engine cannot say.
   */
  private async foresee(from: Square, to: Square, promotion?: PromotionKind): Promise<string | null | undefined> {
    const fen = this.game.fen();
    const ply = this.game.history().length;
    const move: MoveData = { from, to, ...(promotion ? { promotion } : {}) };
    // Tried on the game itself and put straight back, before anything else can happen: only the
    // game knows its own history, and so whether this move repeats a position for the third time.
    const played = this.game.move(from, to, promotion).status;
    // A move that lets the other player claim a draw is judged as if it drew: they may well take it.
    const ended = played.claimable ? { ...played, over: true, result: 'draw' as const, drawReason: played.claimable } : played;
    const lineAfter = this.game.engineLine();
    this.game.undo();
    const lineBefore = this.game.engineLine();
    const before = await this.analysis();
    if (!before) return undefined;
    if (sameMove(before.lines[0]?.move, move) && !ended.over) return null;
    // The same search will be wanted again if the move is played, so it is kept.
    const after = ended.over ? null : await this.analysisOf(lineAfter, ply + 1);
    const facts = { result: ended.result, recapture: false };
    // A move is warned of as a blunder only if a second, deeper look agrees (and that is kept too).
    const verdict = await reconsider(judge(before, after, move, facts), (line) => this.secondLook(line), lineBefore, ended.over ? null : lineAfter, move, facts);
    if (!verdict) return undefined;
    return verdict.kind === 'blunder' ? describeBlunder(fen, move, after, ended) : null;
  }

  /**
   * Play a move by squares, and show it. Rejects if the move is not legal. `origin` says whose
   * decision it was.
   */
  async play(from: Square, to: Square, promotion?: PromotionKind, origin: Origin = 'local'): Promise<MoveEvent> {
    // A move made while an earlier position is being looked at is made in the present.
    this.leaveView();
    const ply = this.game.history().length;
    // Whether the engine may judge this move, and the room take its cue from what the move risks,
    // is settled by the game as the move is made: a move that ends an online game is still one of it.
    const counsel = this.assisted();
    const before = counsel ? this.analysis() : Promise.resolve(null);
    const lineBefore = this.game.engineLine();
    const prior = this.game.lastMove();
    const e = this.game.move(from, to, promotion);
    const epoch = this.epoch;
    const lessons = ui.mode.value.kind === 'lessons';
    this.busy = true;
    // The game's length is counted from its first move. And a move, from either side, is the end of the players' coming to the board.
    if (ply === 0) this.began = performance.now();
    this.skipIntro();
    // What the player was told stands until they do something themselves: the other player's move
    // may be the very thing it was about (a draw turned down by playing on).
    if (origin !== 'remote') ui.notice.value = null;
    this.clearHint();
    this.select(null);
    this.world.markers.set('check', []);
    this.showLastMove();
    this.publish();

    if (counsel) this.appraiseLater(e, before, lineBefore, !!(e.captured && prior?.captured && prior.piece.to === e.piece.to));
    this.world.setPlain(!counsel);
    this.world.setLesson(lessons);
    this.world.setTimed(this.timed());
    if (ui.mode.value.kind === 'online' && origin === 'local') {
      // Shown here at once; the server confirms it, or refuses it and says what is true.
      const move = dataOf(e);
      this.unconfirmed = { ply, move };
      this.net?.move(ply, move);
    }
    // The computer starts on its answer while the hand is still carrying the piece.
    if (this.computerToMove()) this.startThinking();

    if (ui.cinematic.value && !stillness()) {
      if (e.status.result === 'checkmate' && e.status.checkedKing) this.rig.cut('mate', e.status.checkedKing);
      else if (e.status.inCheck && e.status.checkedKing) this.rig.cut('check', e.status.checkedKing);
      else if (e.captured) this.rig.cut('capture', e.piece.to);
    }

    await this.world.playMove(e);
    // A new game may have been started while this move was in the air; it owns the board now.
    if (epoch !== this.epoch) return e;
    this.showCheck();
    this.busy = false;
    ui.landed.value = e;
    // The game was given up, or agreed drawn, while this move was in the air: now the room can answer.
    if (this.game.endedOffBoard()) this.world.resetLife(this.game.status(), true);
    if (lessons) {
      // A lesson says for itself what a move meant, and has no result card.
      if (origin === 'local') this.judgeLesson(e);
    } else if (e.status.over) {
      // Let the final move land (and the camera arrive) before the result card covers it.
      const pause = e.status.result === 'checkmate' && ui.cinematic.value && !stillness() ? 2.2 : 0.7;
      void this.world.tweens.wait(pause).then(() => {
        // Only if this very move is still the last one: it may have been taken back, and even replayed.
        if (epoch === this.epoch && this.game.lastMove() === e && ui.viewing.value === null) ui.resultVisible.value = true;
      });
    } else {
      this.syncSeat();
    }
    if (!lessons) this.explainLater(topicsOf(e));
    this.refreshHover();
    this.next();
    return e;
  }

  /** What a click on a square (or on nothing) means in the current state. */
  click(square: Square | null): void {
    // A click on the board puts away the players' coming to it, and still does what it does.
    this.skipIntro();
    // Nothing is moved while a question is on screen, or on a position that is only being looked back at.
    if (this.busy || ui.promotion.value || ui.warning.value || ui.asking.value || ui.viewing.value !== null) return;
    this.rig.releaseCut();
    if (!square) return this.select(null);

    let option = this.selected ? this.options.find((o) => o.to === square) : undefined;
    if (this.selected && !option) {
      // A pawn that can be taken in passing may be clicked itself, as any other stone would be to take it.
      const passing = this.options.filter((o) => o.enPassant);
      if (passing.length === 1 && square === passedPawn(passing[0]!)) option = passing[0];
    }
    if (this.selected && option) {
      // The stone may have been chosen before the right to move it was lost (the lesson ended, the seat was taken over).
      if (!this.controls(this.game.turn())) return this.select(null);
      if (option.promotion) {
        ui.promotion.value = { from: this.selected, to: option.to, side: this.game.turn() };
        return;
      }
      void this.attempt(this.selected, option.to);
      return;
    }
    const piece = this.game.pieceAt(square);
    const turn = this.game.turn();
    const mine = piece !== null && piece.side === turn && this.controls(turn) && !this.game.status().over;
    this.select(mine && square !== this.selected ? square : null);
  }

  /**
   * A move typed instead of clicked: "Nf3", "exd5", "O-O", "e8=Q", or the two squares. It goes
   * the way two clicks would, so it is warned about, asked about and refused exactly as they are.
   * Returns what to tell the player if it could not be made, or null if it is on its way.
   */
  typeMove(text: string): string | null {
    const typed = text.trim();
    if (typed === '') return null;
    if (ui.viewing.value !== null) return 'You are looking back through the game. Come back to it first (Esc).';
    if (this.game.status().over) return 'The game is over.';
    if (ui.promotion.value || ui.warning.value || ui.asking.value) return 'There is a question on the screen to answer first.';
    if (!this.controls(this.game.turn())) return 'It is not your move.';
    if (this.busy) return 'A move is still being made. Try again in a moment.';
    const read = this.game.readMove(typed);
    if (!read) return `“${typed}” is not a move here. Write it like Nf3 or exd5, or as two squares: g1f3.`;
    // Chosen and placed as the pointer would: whatever a click is refused, this is refused too.
    if (this.selected !== read.from) this.click(read.from);
    if (this.selected !== read.from) return 'That stone cannot be moved just now.';
    this.click(read.to);
    // A pawn at the last rank, and what it becomes was typed with it: no need to ask.
    if (ui.promotion.value && read.promotion) this.choosePromotion(read.promotion);
    return null;
  }

  // -- who may move -------------------------------------------------------------

  /** Whether this screen moves this side's pieces at all. */
  private owns(side: Side): boolean {
    const mode = ui.mode.value;
    if (mode.kind === 'table') return true;
    return ui.you.value === side;
  }

  /**
   * Whether this game may be looked at with the engine's eyes, and its tricks pointed out: not an
   * online game still being played (see `analysable`). Everything the engine says of a game, and
   * every mark of danger, asks this first.
   */
  private assisted(): boolean {
    return analysable(ui.mode.value, this.game.status().over);
  }

  /** Whether the engine may help the player: not in a game against another person somewhere else, where it would be cheating. */
  private mayAdvise(): boolean {
    const kind = ui.mode.value.kind;
    return this.assisted() && (kind === 'table' || kind === 'computer') && this.engine !== null && ui.engine.value !== 'failed';
  }

  private canHint(): boolean {
    const turn = this.game.turn();
    if (ui.viewing.value !== null || ui.asking.value) return false;
    return ui.aids.value.hints && this.mayAdvise() && !this.busy && !this.game.status().over && this.controls(turn) && !ui.warning.value && !ui.promotion.value;
  }

  /** Whether a chosen move is looked at for a blunder before it is played. */
  private warns(): boolean {
    const kind = ui.mode.value.kind;
    return ui.aids.value.warn && (kind === 'table' || kind === 'computer');
  }

  private clearHint(): void {
    this.hinted = null;
    ui.hint.value = null;
    this.world.markers.set('hint', []);
  }

  /** After a change to the help that is on: redraw what a chosen stone shows, and drop what is now off. */
  private refreshAids(): void {
    if (!ui.aids.value.hints) this.clearHint();
    if (!ui.aids.value.explain) {
      this.explainQueue = [];
      ui.explain.value = null;
    }
    this.select(this.selected);
  }

  /** Queue rules to be explained, leaving out any the player has already been told. */
  private explainLater(topics: Topic[]): void {
    if (!ui.aids.value.explain) return;
    for (const topic of topics) {
      if (ui.seen.value.includes(topic) || this.explainQueue.includes(topic) || ui.explain.value === topic) continue;
      // Having seen it done, there is no need to be told it can be.
      if (topic === 'enPassantOffer' && ui.seen.value.includes('enPassant')) continue;
      if (ui.explain.value === null) ui.explain.value = topic;
      else this.explainQueue.push(topic);
    }
  }

  /** The squares the chosen stone may go to. */
  private reach(): Set<Square> {
    return new Set(this.options.map((o) => o.to));
  }

  /** Whether a press on this square takes hold of a stone: one of the side to move, which this screen may move now. */
  private mayGrab(square: Square): boolean {
    if (this.busy || ui.promotion.value || ui.warning.value || ui.asking.value || ui.viewing.value !== null || this.game.status().over) return false;
    const turn = this.game.turn();
    return this.game.pieceAt(square)?.side === turn && this.controls(turn);
  }

  /** Whether this screen may move this side's pieces right now. */
  private controls(side: Side): boolean {
    if (!this.owns(side)) return false;
    // In a lesson, only while a move is being asked for.
    if (ui.mode.value.kind === 'lessons') return ui.lesson.value?.state === 'task';
    // Online, a game needs both its players, a connection to tell the server through, and not to have been called off.
    return ui.mode.value.kind !== 'online' || this.inPlay();
  }

  /** How many moves "take back" would undo: none, the last one, or a move and the computer's answer to it. */
  private takeBackCount(): number {
    const mode = ui.mode.value;
    const played = this.game.history().length;
    if (mode.kind === 'online' || mode.kind === 'lessons') return 0;
    // A game given up, or agreed drawn, can be taken up again.
    if (this.game.endedOffBoard()) return 1;
    if (mode.kind === 'table') return played > 0 ? 1 : 0;
    // Against the computer, back to the player's own last decision.
    const count = this.game.turn() === mode.side ? 2 : 1;
    return played >= count ? count : 0;
  }

  // -- setting up ---------------------------------------------------------------

  /** Leave whatever game is being played: stop the computer thinking, hang up on the server. */
  private leaveMode(): void {
    this.cancelThinking();
    this.net?.close();
    this.net = null;
    this.reachedRoom();
    this.inbox = [];
    this.unconfirmed = null;
    this.givenUp = null;
    this.agreedDraw = false;
    this.claimedDraw = false;
    this.timedDraw = false;
    if (ui.online.value) setAddress(null);
    this.world.setEnded(null);
    this.world.setHandSeed(null);
    ui.online.value = null;
    ui.intro.value = null;
    ui.notice.value = null;
    ui.asking.value = null;
    this.letGo();
    this.lessonAt = null;
    ui.lesson.value = null;
    this.explainQueue = [];
    ui.explain.value = null;
  }

  // -- the lessons --------------------------------------------------------------

  private lessonStep(): Step | null {
    const at = this.lessonAt;
    return at ? (LESSONS[at.lesson]?.steps[at.step] ?? null) : null;
  }

  private lessonView(state: LessonView['state'], line: string | null): LessonView {
    const at = this.lessonAt!;
    const lesson = LESSONS[at.lesson]!;
    return { lesson: at.lesson + 1, lessons: LESSONS.length, ...stepNumber(at.lesson, at.step), title: lesson.title, say: lesson.steps[at.step]!.say, ask: lesson.steps[at.step]!.ask, state, line };
  }

  /**
   * Begin a step. A step with a position of its own sets it up. One without carries on from
   * where the step before left off, unless it was not reached that way (`afresh`), in which
   * case the lesson's position is set up again.
   */
  private enterStep(lesson: number, step: number, afresh: boolean): void {
    const steps = LESSONS[lesson]!.steps;
    const s = steps[Math.max(0, Math.min(steps.length - 1, step))]!;
    this.lessonAt = { lesson, step: steps.indexOf(s) };
    this.clearHint();
    let fen = s.fen;
    if (!fen && afresh) fen = s.afresh;
    if (!fen && afresh) for (let i = this.lessonAt.step; i >= 0 && !fen; i--) fen = steps[i]!.fen;
    ui.lesson.value = this.lessonView(s.task ? 'task' : 'read', null);
    if (fen) this.setUp(fen);
    else this.refreshHover();
    const epoch = this.epoch;
    const prelude = s.fen ? s.prelude : undefined;
    if (prelude) {
      // The other side moves first, and the player answers.
      void this.world.tweens.wait(SCRIPT_PAUSE).then(() => {
        if (epoch === this.epoch) void this.play(prelude.from, prelude.to, prelude.promotion, 'script');
      });
    }
  }

  /** The player has made a move in a lesson: say whether it was the one, and put it back if not. */
  private judgeLesson(e: MoveEvent): void {
    const task = this.lessonStep()?.task;
    if (!task) return;
    const epoch = this.epoch;
    const said = answer(task, e);
    ui.lesson.value = this.lessonView(said.done ? 'done' : 'wrong', said.line);
    if (said.done) {
      const reply = task.reply;
      if (reply && !e.status.over) {
        void this.world.tweens.wait(SCRIPT_PAUSE).then(() => {
          if (epoch === this.epoch) void this.play(reply.from, reply.to, reply.promotion, 'script');
        });
      }
      return;
    }
    // It stands for a moment, so that what it did can be seen, and then goes back.
    void this.world.tweens.wait(WRONG_MOVE_STANDS).then(async () => {
      if (epoch !== this.epoch) return;
      await this.takeBack(true);
      if (epoch === this.epoch && ui.lesson.value?.state === 'wrong') {
        ui.lesson.value = { ...ui.lesson.value, state: 'task' };
        this.refreshHover();
      }
    });
  }

  /** Begin a game from the starting position, or from one given. */
  private setUp(fen?: string): void {
    this.letGo();
    this.clearBoard();
    // The stones of the game before go back into the drawers before the new game's come out.
    this.world.remember();
    this.game.load(fen);
    this.showPosition();
    this.unpack(true);
    this.next();
  }

  /**
   * Put a game on the board from its record, with nothing in motion. Returns false if the
   * record could not be played through, in which case the board shows as much of it as could.
   */
  private restore(record: GameRecord): boolean {
    this.clearBoard();
    let whole = true;
    try {
      this.game.load(record.startFen);
      for (const m of record.moves) this.game.move(m.from, m.to, m.promotion);
      // The ways a game ends off the board, as the server applies them when it takes a room up again.
      if (record.claimed) this.game.claimDraw();
      if (record.agreed) this.game.agreeDraw();
      if (record.ended === 'time' && !record.resigned) this.game.drawOnTime();
      if (record.resigned) this.game.resign(record.resigned);
    } catch (error) {
      console.warn('A recorded game could not be replayed.', error);
      whole = false;
    }
    this.showPosition();
    this.unpack(false);
    this.next();
    return whole;
  }

  /**
   * Set the position just stood out of the case. The first time the case opens and the stones come
   * out of its drawers onto their squares; a new game after that has only the stones; a game taken
   * up again where it stood, a step of a lesson and a player who has asked for less movement have
   * nothing. Moves wait till it is done; a click or a key finishes it at once.
   */
  private unpack(fresh: boolean): void {
    const mode: Unpacking = stillness() ? 'none' : this.world.packed ? 'full' : fresh && ui.mode.value.kind !== 'lessons' ? 'short' : 'none';
    const done = this.world.unpack(mode);
    if (!done) return;
    const epoch = this.epoch;
    this.busy = true;
    void done.then(() => {
      if (epoch !== this.epoch) return;
      this.busy = false;
      this.next();
    });
  }

  /** Before the position is replaced: whatever belonged to the old one is dropped. */
  private clearBoard(): void {
    this.epoch++;
    this.cancelThinking();
    this.notes.clear();
    // The engine begins the new position afresh: what it makes of it does not hang on the last game.
    void this.engine?.then((engine) => engine?.newGame().catch(() => {}));
    this.drawAsked = null;
    this.began = null;
    ui.lasted.value = null;
    ui.warning.value = null;
    ui.landed.value = null;
    ui.balance.value = null;
    this.clearHint();
    // An opening under way ends where it would have ended, and then the old position is let go.
    this.world.finishUnpack();
    this.world.tweens.finishAll();
  }

  /** Show the game as it now stands, with nothing in motion. */
  private showPosition(): void {
    this.shown = null;
    ui.viewing.value = null;
    this.stand(this.game);
    this.mused = null;
    this.busy = false;
    this.select(null);
    ui.promotion.value = null;
    ui.asking.value = null;
    this.rig.releaseCut();
    this.publish();
    ui.resultVisible.value = this.game.status().over && ui.mode.value.kind !== 'lessons';
    this.syncSeat();
  }

  /** Whether the game being played is against a clock: the same for everyone at the board. */
  private timed(): boolean {
    const o = ui.online.value;
    return ui.mode.value.kind === 'online' && !!o && (o.ranked || o.control !== null || o.clock !== null);
  }

  /** Stand a position on the board: the stones, the hands at rest, what has been taken, and the mood it calls for. */
  private stand(game: Game): void {
    // (Before the hands are told the moves so far: how they were set down goes by it.)
    this.world.setTimed(this.timed());
    this.world.pieces.reset(game.pieces());
    this.world.resetHands();
    this.world.seatTaken(game.history());
    this.world.resetLife(game.status());
    this.world.refreshShadows();
    this.showLastMove(game);
    this.showCheck(game);
  }

  // -- the game kept in the browser -------------------------------------------------

  /** The game kept in the browser, as the choice of game describes it. */
  private kept(): SavedSummary | null {
    try {
      return summarise(readSavedGame(localStorage));
    } catch {
      return null;
    }
  }

  /** A different game is about to be on the board: the one kept in the browser, if there is one, becomes one to offer. */
  private letGo(): void {
    this.keeping = false;
    ui.saved.value = this.kept();
  }

  /**
   * Keep the game on the board in the browser, so that it can be carried on after the page is
   * closed: a game at this screen in which a move has been made and which has not ended.
   */
  private keep(): void {
    const mode = ui.mode.value;
    if (mode.kind !== 'table' && mode.kind !== 'computer') return;
    const moves = this.game.history();
    try {
      if (moves.length > 0 && !this.game.status().over) {
        writeSavedGame(localStorage, {
          kind: mode.kind,
          ...(mode.kind === 'computer' ? { level: mode.level, side: mode.side, asked: this.sideAsked } : {}),
          startFen: this.game.startFen(),
          moves: moves.map(dataOf),
          seat: ui.seat.value,
          at: Date.now(),
        });
        this.keeping = true;
        ui.saved.value = null;
      } else if (this.keeping) {
        // Finished, or taken back to before its first move: there is nothing to come back to.
        clearSavedGame(localStorage);
        this.keeping = false;
      }
    } catch {
      // No storage: the game is simply not kept.
    }
  }

  /** Whatever should happen now that the position has changed and nothing is moving. */
  private next(): void {
    if (this.busy) return;
    if (ui.mode.value.kind === 'online') {
      // A new game in the room (the players asked for another) begins as the first one did.
      this.introduce();
      this.drain();
    } else if (this.computerToMove()) void this.computerMove();
    if (this.assisted()) {
      // The engine looks at the position while the player thinks, so that it can judge their move
      // as it is made; an online game that has just ended is looked over from its first move.
      void this.analysis();
      this.review();
    } else {
      // An online game being played: the engine is put away, and does no work at all until it is over.
      this.idleEngine();
    }
    // A chance to take in passing lasts one turn, so it is pointed out as it arrives: except in an
    // online game being played, where pointing at a capture is help with the game.
    if (ui.aids.value.explain && ui.mode.value.kind !== 'lessons' && this.assisted() && !ui.seen.value.includes('enPassantOffer') && this.controls(this.game.turn()) && enPassantOffered(this.game)) {
      this.explainLater(['enPassantOffer']);
    }
  }

  // -- the engine ---------------------------------------------------------------

  private bootEngine(): Promise<Engine | null> {
    if (!this.engine) {
      ui.engine.value = 'loading';
      // One put away while it was still coming up (an online game began) says nothing of how it went.
      const booting: Promise<Engine | null> = startEngine().then(
        (engine) => {
          if (this.engine === booting) ui.engine.value = 'ready';
          return engine;
        },
        (error: unknown) => {
          console.warn('The chess engine could not be started. Moves will not be judged and the computer cannot play.', error);
          if (this.engine === booting) ui.engine.value = 'failed';
          return null;
        },
      );
      this.engine = booting;
      void booting.then(() => this.analysis());
    }
    return this.engine;
  }

  /** A game at this screen is beginning, which the engine may help with: it is fetched, unless the room is still loading (which fetches it itself once it is ready). */
  private wakeEngine(): void {
    if (ui.ready.value) void this.bootEngine();
  }

  /**
   * Put the engine away for an online game being played. Its worker is ended, so that a search
   * under way (of the game before) is dropped unfinished and nothing it was going to say can
   * arrive; what it had said of earlier positions goes too. It is fetched again for the next game
   * at this screen, or to look over this one once it is over. One that could not be loaded is
   * left as it is: it does nothing either way.
   */
  private idleEngine(): void {
    const engine = this.engine;
    if (!engine || ui.engine.value === 'failed') return;
    this.engine = null;
    this.notes.clear();
    ui.engine.value = 'idle';
    void engine.then((e) => e?.close());
  }

  /**
   * An online game has ended: the engine may look it over now, move by move, as it judges a game
   * at this screen while it is played, for the record's marks, the graph and the scales. It is
   * not told to the room, which has finished answering the game. Another game in the same room
   * replaces the position, and that ends the looking over: nothing it finds is kept for a game
   * begun after this one.
   */
  private review(): void {
    if (ui.mode.value.kind !== 'online' || !this.game.status().over || this.reviewed === this.epoch) return;
    this.reviewed = this.epoch;
    const epoch = this.epoch;
    const moves = this.game.history();
    const startFen = this.game.startFen();
    const stale = () => epoch !== this.epoch;
    void this.bootEngine().then(async (engine) => {
      if (!engine || stale() || moves.length === 0) return;
      const look = (line: Setting, how: SearchOptions): Promise<Analysis | null> =>
        engine.analyse(line.fen, { ...how, moves: line.moves, stale }).then(
          (a) => (a.lines.length > 0 ? a : null),
          () => null,
        );
      const replay = new Game(startFen);
      let lineBefore = replay.engineLine();
      let before = await look(lineBefore, FIRST_LOOK);
      for (let i = 0; i < moves.length; i++) {
        if (stale()) return;
        const e = moves[i]!;
        const prior = moves[i - 1];
        const move = dataOf(e);
        replay.move(move.from, move.to, move.promotion);
        // A move that ended the game on the board is judged by how it ended, as at this screen.
        const lineAfter = e.status.over ? null : replay.engineLine();
        const after = lineAfter ? await look(lineAfter, FIRST_LOOK) : null;
        if (stale()) return;
        const facts = { result: e.status.result, recapture: !!(e.captured && prior?.captured && prior.piece.to === e.piece.to) };
        const verdict = await reconsider(judge(before, after, move, facts), (line) => look(line, SECOND_LOOK), lineBefore, lineAfter, move, facts);
        if (stale()) return;
        this.verdicts.set(e, verdict);
        if (verdict) ui.balance.value = { ply: i + 1, cp: e.side === 'w' ? verdict.after : -verdict.after };
        ui.appraised.value += 1;
        before = after;
        if (lineAfter) lineBefore = lineAfter;
      }
    });
  }

  /** The engine's look at the position as it stands: its two best lines. Null if it cannot be had. */
  private analysis(): Promise<Analysis | null> {
    if (this.game.status().over) return Promise.resolve(null);
    return this.analysisOf(this.game.engineLine(), this.game.history().length);
  }

  /**
   * The engine's look at a position `ply` moves into this game: the one on the board, or one a
   * move away from it. It is shown the moves that led there (`Game.engineLine`), so that it knows
   * what has stood before.
   */
  private analysisOf(line: Setting, ply: number): Promise<Analysis | null> {
    const engine = this.engine;
    // Never for an online game being played.
    if (!engine || !this.assisted()) return Promise.resolve(null);
    // The same position reached by another road may be a repetition where this one is not.
    const key = `${line.fen} ${line.moves.map(uciOf).join(' ')}`;
    const known = this.notes.get(key);
    if (known) return known;
    const epoch = this.epoch;
    // By the time its turn comes the game may have moved on, or been replaced.
    const stale = () => epoch !== this.epoch || Math.abs(this.game.history().length - ply) > 1 || !this.assisted();
    const found: Promise<Analysis | null> = engine
      .then((e) => (e ? e.analyse(line.fen, { ...FIRST_LOOK, moves: line.moves, stale }) : null))
      .then(
        (a) => (a && a.lines.length > 0 ? a : null),
        () => null,
      )
      .then((a) => {
        // Nothing found is not worth remembering: the position may be asked about again.
        if (!a && this.notes.get(key) === found) this.notes.delete(key);
        return a;
      });
    this.notes.set(key, found);
    return found;
  }

  /**
   * Ask the engine what it makes of a move just played, and tell the room when it answers. `before`
   * is its quick look at the position the move was played in, `lineBefore` that position as the
   * engine is shown it. A move the quick looks find a slip or a blunder is looked at again, deeper,
   * before anything is said of it (see `reconsider`).
   */
  private appraiseLater(e: MoveEvent, before: Promise<Analysis | null>, lineBefore: Setting, recapture: boolean): void {
    if (!this.engine || ui.engine.value === 'failed' || !this.assisted()) return;
    const epoch = this.epoch;
    const lineAfter = e.status.over ? null : this.game.engineLine();
    const facts = { result: e.status.result, recapture };
    this.world.expectVerdict(e);
    void Promise.all([before, this.analysis()]).then(async ([b, a]) => {
      if (epoch !== this.epoch) return;
      const verdict = await reconsider(judge(b, a, dataOf(e), facts), (line) => this.secondLook(line), lineBefore, lineAfter, dataOf(e), facts);
      if (epoch !== this.epoch) return;
      this.verdicts.set(e, verdict);
      this.world.appraise(e, verdict?.kind ?? null);
      ui.appraised.value += 1;
      // How the game stands now, for the scales in the interface. Only for a move still on the board.
      const ply = ui.history.value.indexOf(e) + 1;
      if (verdict && ply > 0) ui.balance.value = { ply, cp: e.side === 'w' ? verdict.after : -verdict.after };
    });
  }

  /**
   * The engine's second, deeper look at a position (see `SECOND_LOOK`), to stand behind calling a
   * move played from it a slip or a blunder. Kept, as the quick looks are: a move warned of and then
   * played is looked at once. Null if it cannot be had. Unlike the quick look it is not dropped when
   * the game moves on, since what it is asked about stays where it was; only a new position drops it.
   */
  private secondLook(line: Setting): Promise<Analysis | null> {
    const engine = this.engine;
    if (!engine || !this.assisted()) return Promise.resolve(null);
    const key = `deep ${line.fen} ${line.moves.map(uciOf).join(' ')}`;
    const known = this.notes.get(key);
    if (known) return known;
    const epoch = this.epoch;
    const stale = () => epoch !== this.epoch || !this.assisted();
    const found: Promise<Analysis | null> = engine
      .then((e) => (e ? e.analyse(line.fen, { ...SECOND_LOOK, moves: line.moves, stale }) : null))
      .then(
        (a) => (a && a.lines.length > 0 ? a : null),
        () => null,
      )
      .then((a) => {
        if (!a && this.notes.get(key) === found) this.notes.delete(key);
        return a;
      });
    this.notes.set(key, found);
    return found;
  }

  private computerToMove(): boolean {
    const mode = ui.mode.value;
    return mode.kind === 'computer' && !this.game.status().over && this.game.turn() !== mode.side;
  }

  /** Set the engine to choosing the computer's move in the position as it stands. */
  private startThinking(): void {
    const mode = ui.mode.value;
    if (mode.kind !== 'computer') return;
    const level = LEVELS.find((l) => l.id === mode.level) ?? LEVELS[1]!;
    const fen = this.game.fen();
    const setting = this.game.engineLine();
    const legal = this.game.moves();
    ui.thinking.value = true;
    this.reply = {
      epoch: this.epoch,
      ply: this.game.history().length,
      claimed: false,
      move: this.bootEngine()
        .then((engine) => (engine ? chooseMove(engine, fen, legal, level, Math.random, setting) : null))
        .catch(() => null),
    };
  }

  /**
   * Whether the computer, to move, claims the draw the position allows: when it does not think
   * itself the better off, by the engine's last word on the game. With no word yet, it claims.
   */
  private computerClaims(side: Side): boolean {
    if (!this.game.status().claimable) return false;
    const judged = ui.balance.value;
    if (!judged) return true;
    const forComputer = side === 'w' ? judged.cp : -judged.cp;
    return forComputer <= DRAW_MARGIN;
  }

  /** The computer's turn: wait for its choice, let its hand dwell on the piece, and play. Or, where it may and would rather, claim a draw. */
  private async computerMove(): Promise<void> {
    const mode = ui.mode.value;
    if (mode.kind !== 'computer') return;
    const ply = this.game.history().length;
    if (this.reply?.epoch === this.epoch && this.reply.ply === ply && this.reply.claimed) return;
    if (this.computerClaims(opposite(mode.side))) {
      // Whatever it had begun to think about its move is not wanted; it takes a moment over the claim, as over a move.
      this.cancelThinking();
      const claim = { epoch: this.epoch, ply, move: Promise.resolve(null), claimed: true };
      this.reply = claim;
      ui.thinking.value = true;
      await this.world.tweens.wait(CLAIM_PAUSE);
      if (this.reply !== claim) return;
      this.reply = null;
      ui.thinking.value = false;
      if (this.game.history().length === ply && !this.game.status().over) this.claimFor();
      return;
    }
    if (!this.reply || this.reply.epoch !== this.epoch || this.reply.ply !== ply) this.startThinking();
    const reply = this.reply!;
    if (reply.claimed) return;
    reply.claimed = true;
    const began = this.time;
    const move = await reply.move;
    // A take-back, a new game or a change of opponent may have overtaken it.
    if (this.reply !== reply) return;
    if (!move) {
      this.reply = null;
      ui.thinking.value = false;
      ui.notice.value = 'The chess engine could not be loaded, so the computer cannot play. Check the connection and load the page again.';
      return;
    }
    // It lets the player's own hands finish setting their stone down: it has no clock to save.
    await this.world.settled();
    if (this.reply !== reply) return;
    // Its hand goes to a stone of the game as it stands, so the board must be showing that.
    this.leaveView();
    this.world.consider(opposite(mode.side), move.from);
    await this.world.tweens.wait(Math.max(DWELL, QUICKEST_REPLY - (this.time - began)));
    if (this.reply !== reply) return;
    this.reply = null;
    ui.thinking.value = false;
    await this.play(move.from, move.to, move.promotion, 'computer');
  }

  private cancelThinking(): void {
    if (this.reply) {
      this.reply = null;
      // Whatever it is searching is no longer wanted.
      void this.engine?.then((engine) => engine?.stop());
    }
    ui.thinking.value = false;
    const mode = ui.mode.value;
    if (mode.kind === 'computer') this.world.consider(opposite(mode.side), null);
  }

  // -- the server ---------------------------------------------------------------

  private patchOnline(part: Partial<Online>): void {
    if (!ui.online.value) return;
    ui.online.value = { ...ui.online.value, ...part };
    this.refreshHover();
  }

  private noteRoom(state: RoomState): void {
    const asked = (ui.online.value?.again.w ? 1 : 0) + (ui.online.value?.again.b ? 1 : 0);
    const counted = ui.online.value?.change ?? null;
    const clockWas = ui.online.value?.choosable ? ui.online.value.control : undefined;
    this.patchOnline({
      taken: state.taken,
      present: state.present,
      watching: state.watching,
      again: state.again,
      // A server from before ranked play says none of these.
      ranked: state.ranked === true,
      players: state.players ?? { w: null, b: null },
      clock: state.clock ? { ...state.clock, at: performance.now() } : null,
      // A server from before friendly clocks says nothing of the room's.
      control: state.control ?? null,
      choosable: state.ranked !== true && state.control !== undefined,
      ended: state.ended ?? null,
      change: state.change ?? null,
    });
    this.heardClock(clockWas, state.control, state.controlBy);
    // A ranked game has just been counted: ask how this player stands now.
    if (state.change && !counted) this.net?.hello();
    // Someone has just asked for another game. If the card that ends a game has been put away,
    // it comes back, since it is where the other player answers.
    const asking = (state.again.w ? 1 : 0) + (state.again.b ? 1 : 0);
    if (asking > asked && this.game.status().over) ui.resultVisible.value = true;
    // For the hands: how the server ended the game, if it did, and something every screen at this board has in common.
    this.world.setEnded(state.ended ?? null);
    this.world.setHandSeed(`${state.room}:${state.startFen}:${(state.players?.w?.name ?? '') + (state.players?.b?.name ?? '')}`);
    this.givenUp = state.resigned ?? null;
    this.agreedDraw = state.agreed === true;
    this.claimedDraw = !!state.claimed;
    this.timedDraw = state.ended === 'time' && !state.resigned;
    const offer = state.drawOffer ?? null;
    const was = ui.online.value?.offer ?? null;
    if (offer !== was) {
      this.patchOnline({ offer });
      const you = ui.you.value;
      // The hands hold an offer out while it stands. One that is taken is the end of the game, and theirs to shake on.
      if (offer !== null) this.world.setOffer(offer);
      else if (!state.agreed) this.world.setOffer(null, (was === you ? !this.withdrawing : this.declining) ? 'refused' : 'withdrawn');
      // An offer that has just arrived for this player is heard as well as shown; and the question
      // of making one, if it was being asked here, has been overtaken.
      if (offer !== null && you !== null && offer !== you) {
        this.world.sound?.glass(null, 3);
        this.world.sound?.glass(null, 5, 0.16);
        if (ui.asking.value === 'draw') ui.asking.value = null;
      }
      // Mine has gone and the game has not ended: the other player said no, or played on. (Unless I took it back.)
      if (offer === null && you !== null && was === you && !state.agreed && state.resigned === null && !this.withdrawing && !this.game.status().over) {
        ui.notice.value = `${SIDE_NAME[opposite(you)]} would rather play on.`;
      }
      // Theirs has gone as I was saying yes to it, and the game goes on: they took it back first.
      if (offer === null && you !== null && was === opposite(you) && this.agreeing && !state.agreed && state.resigned === null && !this.game.status().over) {
        ui.notice.value = `${SIDE_NAME[opposite(you)]} took the offer back.`;
      }
      this.withdrawing = false;
      this.agreeing = false;
      this.declining = false;
    }
    // The second player may have just sat down.
    this.introduce();
  }

  /**
   * There is no game to be had in this room, and why, said on a card with the way back: called
   * off, over and gone, or lost by the server. The connection is let go, so that the seat the
   * server may have given in a room it has made afresh is let go too.
   */
  private closeRoom(why: string): void {
    this.net?.close();
    this.net = null;
    this.reachedRoom();
    this.inbox = [];
    this.unconfirmed = null;
    this.select(null);
    this.patchOnline({ closed: why });
  }

  /** Online: once every move the server has announced is on the board, a game it says the players have ended is over here too. */
  private settleEnding(): void {
    if (this.busy || this.unconfirmed || this.inbox.length > 0 || this.game.status().over) return;
    if (this.givenUp) this.concede(this.givenUp);
    else if (this.agreedDraw) this.agree();
    else if (this.claimedDraw)
      this.conclude(
        () => this.game.claimDraw(),
        () => this.game.drawClaimed() !== null,
      );
    else if (this.timedDraw)
      this.conclude(
        () => this.game.drawOnTime(),
        () => this.game.drawnOnTime(),
      );
  }

  /** The room's clock has changed. Changed by the other player, it is said, so that it is not missed before the game begins. */
  private heardClock(was: TimeControl | null | undefined, now: TimeControl | null | undefined, by: Side | undefined): void {
    const you = ui.you.value;
    // The room says who chose it: a change of this screen's own, or one refused, is never said as the other player's.
    if (was === undefined || now === undefined || sameControl(was, now) || you === null || by !== opposite(you)) return;
    const them = SIDE_NAME[opposite(you)];
    ui.notice.value = now ? `${them} set the clock to ${now.base / 60000} + ${now.increment / 1000}.` : `${them} took the clock off.`;
  }

  /** Take the seat the server has given: a side of the board, or a place to watch from. */
  private sit(you: Seat): void {
    ui.you.value = you === 'spectator' ? null : you;
    this.patchOnline({ seat: you, note: null });
    if (you !== 'spectator' && ui.seat.value !== you) {
      ui.seat.value = you;
      this.rig.setSeat(you, 1.15);
    }
  }

  /** Whether the first `count` moves of the server's record are the ones shown here. */
  private agrees(state: GameRecord, count: number): boolean {
    const shown = this.game.history();
    if (state.startFen !== this.game.startFen() || shown.length < count || state.moves.length < count) return false;
    for (let i = 0; i < count; i++) if (!sameMove(dataOf(shown[i]!), state.moves[i])) return false;
    return true;
  }

  private onJoined(you: Seat, state: RoomState): void {
    // The room has come back with fewer moves than were played here, and not because a new game
    // was asked for: the server has lost the game (it restarted, and what it wrote down was lost).
    // The seat it has given is in a new, empty room, perhaps on the other side. That is said
    // plainly, and the board is left as the game stood.
    const had = this.game.history().length - (this.unconfirmed ? 1 : 0);
    const o = ui.online.value;
    const again = o && ui.you.value ? o.again[ui.you.value] : false;
    if (had > 0 && state.moves.length < had && !(this.game.status().over && again)) {
      this.closeRoom('The server restarted and this game could not be recovered.');
      return;
    }
    this.sit(you);
    this.noteRoom(state);
    // A move made here that the server never heard (the connection dropped as it was sent) is sent again.
    const u = this.unconfirmed;
    if (u && you !== 'spectator' && state.moves.length === u.ply && this.game.history().length === u.ply + 1 && this.agrees(state, u.ply)) {
      this.net?.move(u.ply, u.move);
      return;
    }
    this.adopt(state);
  }

  /** The server has described the room: someone came or went, or it was asked. Check that this screen agrees. */
  private onRoom(state: RoomState): void {
    this.noteRoom(state);
    const known = [...this.game.history().map(dataOf), ...this.inbox.map((x) => x.move)];
    if (state.startFen !== this.game.startFen()) return this.adopt(state);
    const shared = Math.min(known.length, state.moves.length);
    for (let i = 0; i < shared; i++) if (!sameMove(known[i], state.moves[i])) return this.adopt(state);
    if (state.moves.length > known.length) {
      for (let i = known.length; i < state.moves.length; i++) this.inbox.push({ ply: i, move: state.moves[i]! });
      this.drain();
    } else if (known.length > state.moves.length + (this.unconfirmed ? 1 : 0)) {
      // This screen is ahead of the server by more than a move still on its way.
      this.adopt(state);
    } else {
      this.settleEnding();
    }
  }

  private onMoved(ply: number, move: MoveData, clock?: Clock): void {
    if (clock) this.patchOnline({ clock: { ...clock, at: performance.now() } });
    if (this.unconfirmed && this.unconfirmed.ply === ply && sameMove(this.unconfirmed.move, move)) {
      this.unconfirmed = null;
      return;
    }
    const shown = this.game.history();
    if (ply < shown.length) {
      if (!sameMove(dataOf(shown[ply]!), move)) this.net?.sync();
      return;
    }
    const expected = shown.length + this.inbox.length;
    if (ply < expected) return;
    if (ply > expected) {
      this.net?.sync();
      return;
    }
    this.inbox.push({ ply, move });
    this.drain();
  }

  /** Show the next move the server has announced, if nothing else is moving. */
  private drain(): void {
    if (this.busy || ui.mode.value.kind !== 'online') return;
    const first = this.inbox[0];
    if (!first) return this.settleEnding();
    if (first.ply !== this.game.history().length) {
      this.inbox = [];
      this.net?.sync();
      return;
    }
    if (this.inbox.length >= TOO_FAR_BEHIND) {
      // Too many to watch one by one and still be watching the game as it is played.
      const moves = [...this.game.history().map(dataOf), ...this.inbox.map((x) => x.move)];
      this.adopt({ startFen: this.game.startFen(), moves }, true);
      return;
    }
    this.inbox.shift();
    this.play(first.move.from, first.move.to, first.move.promotion, 'remote').catch(() => {
      this.inbox = [];
      this.net?.sync();
    });
  }

  /**
   * Make this screen show the game the server holds. If it already does, nothing happens; if it
   * is a move or two behind, those are played out; otherwise the position is set up afresh.
   */
  private adopt(state: GameRecord, afresh = false): void {
    const shown = this.game.history().length;
    this.unconfirmed = null;
    this.inbox = [];
    if (!afresh && this.agrees(state, shown) && state.moves.length - shown < TOO_FAR_BEHIND) {
      for (let i = shown; i < state.moves.length; i++) this.inbox.push({ ply: i, move: state.moves[i]! });
      this.refreshHover();
      this.drain();
      return;
    }
    if (!this.restore(state)) ui.notice.value = 'The game on the server could not be read.';
  }

  // -- internals ----------------------------------------------------------------

  private select(square: Square | null): void {
    this.selected = square;
    this.options = square ? this.game.movesFrom(square) : [];
    this.world.pieces.setSelected(square);
    const marks: Mark[] = [];
    // A lesson always shows everything; otherwise the player decides how much the board tells them.
    // Where a stone would be lost is never shown in an online game being played: only where it may go.
    const aids = ui.mode.value.kind === 'lessons' ? ALL_AIDS : ui.aids.value;
    const danger = aids.danger && this.assisted();
    if (square) {
      const origin = squareCenter(square);
      marks.push({ square, kind: 'origin' });
      for (const o of aids.moves ? this.options : []) {
        const c = squareCenter(o.to);
        const distance = Math.hypot(c.x - origin.x, c.z - origin.z);
        const risky = o.risky && danger;
        marks.push({
          square: o.to,
          kind: o.capture ? (risky ? 'captureRisk' : 'capture') : risky ? 'risk' : 'move',
          delay: 0.022 * distance,
        });
        // Taking in passing lands on an empty square: the pawn it removes is marked too.
        if (o.enPassant) marks.push({ square: passedPawn(o), kind: 'victim', delay: 0.022 * distance });
      }
    }
    this.world.markers.set('options', marks);
    if (square) {
      this.mused = square;
      this.world.thought(square, true);
    }
    this.refreshHover();
  }

  private showLastMove(game: Game = this.game): void {
    const last = game.lastMove();
    this.world.markers.set(
      'last',
      last
        ? [
            { square: last.piece.from, kind: 'last' },
            { square: last.piece.to, kind: 'last' },
          ]
        : [],
    );
  }

  private showCheck(game: Game = this.game): void {
    const s = game.status();
    const marks: Mark[] = s.checkedKing ? [{ square: s.checkedKing, kind: 'check' }] : [];
    // Stalemate is always taken for checkmate. The board shows the difference: every square the
    // king might step to is covered, and nothing is on the king himself.
    if (s.drawReason === 'stalemate') {
      for (const flight of game.kingFlights()) if (flight.covered) marks.push({ square: flight.square, kind: 'risk' });
    }
    this.world.markers.set('check', marks);
  }

  private publish(): void {
    const wasOver = ui.status.value.over;
    ui.status.value = this.game.status();
    const over = ui.status.value.over;
    // Whether to give up, or to offer a draw, is not a question about a game that has ended (the other side's move may have ended it).
    if (over) ui.asking.value = null;
    // Whatever was being said about the game as it was played (a draw turned down, say) is
    // overtaken by its end, which its own card says.
    if (over && !wasOver) ui.notice.value = null;
    // How long it lasted, if this screen saw it begin; counted once, as it ends.
    ui.lasted.value = !over ? null : (ui.lasted.value ?? (this.began === null ? null : performance.now() - this.began));
    // The next game in an online room begins with the players coming to the board again.
    if (over) this.introduced = false;
    ui.drawNear.value = this.game.drawNear();
    ui.history.value = this.game.history();
    ui.start.value = this.game.start();
    ui.captured.value = this.game.captured();
    ui.canTakeBack.value = this.takeBackCount() > 0;
    this.world.setTurn(ui.status.value.over ? null : ui.status.value.turn);
    this.keep();
  }

  /** In the seated views, two players sharing this screen sit by turns (when that setting is on). */
  private syncSeat(duration?: number): void {
    const seated = this.rig.mode === 'shoulder' || this.rig.mode === 'eyes';
    const shared = ui.mode.value.kind === 'table';
    if (shared && seated && ui.followTurn.value && !this.game.status().over) ui.seat.value = this.game.turn();
    this.rig.setSeat(ui.seat.value, duration);
  }

  private isInteresting(square: Square | null): boolean {
    if (!square || this.busy || this.game.status().over || ui.viewing.value !== null) return false;
    if (!this.controls(this.game.turn())) return false;
    if (this.selected && this.options.some((o) => o.to === square)) return true;
    const piece = this.game.pieceAt(square);
    return piece !== null && piece.side === this.game.turn();
  }

  private refreshHover(): void {
    const show = this.isInteresting(this.hovered) && this.hovered !== this.selected;
    // Over a square the selected piece can reach, the lit square brightens; over a piece, a plain outline.
    const target = this.selected !== null && this.options.some((o) => o.to === this.hovered);
    this.world.markers.set('hover', show && this.hovered ? [{ square: this.hovered, kind: target ? 'target' : 'hover' }] : []);
    // The hand of the player to move goes to the piece they have chosen or, failing that, the one under the pointer.
    const turn = this.game.turn();
    const acting = !this.busy && !this.game.status().over && this.controls(turn) && ui.viewing.value === null;
    const mine = show && !target && this.hovered ? this.hovered : null;
    const thought = acting ? (this.selected ?? mine) : null;
    // Only the hands this screen moves: the computer's and the other player's are steered from elsewhere.
    for (const side of SIDES) if (this.owns(side)) this.world.consider(side, side === turn ? thought : null);
    if (ui.mode.value.kind === 'online' && ui.you.value) this.net?.think(thought);
    // The room hears a soft tone the first time the pointer settles on a piece.
    const musing = this.selected ?? mine;
    if (musing !== this.mused) {
      this.mused = musing;
      if (musing && !this.selected) this.world.thought(musing, false);
    }
    this.canvas.style.cursor = this.isInteresting(this.hovered) ? 'pointer' : this.rig.mode === 'orbit' ? 'grab' : 'default';
    ui.canHint.value = this.canHint();
    ui.canResign.value = this.canResign();
    ui.canDraw.value = this.canDraw();
    ui.canClaim.value = this.canClaim();
    // Whatever stone the pointer is on is named, whoever it belongs to and whoever is to move.
    const under = this.hovered ? this.board.pieceAt(this.hovered) : null;
    const was = ui.pointed.value;
    if ((under?.square ?? null) !== (was?.square ?? null) || under?.kind !== was?.kind) {
      ui.pointed.value = under ? { side: under.side, kind: under.kind, square: under.square } : null;
    }
  }

  private bind(): void {
    const c = this.canvas;

    window.addEventListener('pointerdown', () => this.wakeSound(), { capture: true });
    window.addEventListener('keydown', () => this.wakeSound(), { capture: true });

    // The interface is paper, and is heard: a pencil's stroke as the pointer comes onto
    // something that can be pressed, a card set down when it is.
    const control = (target: EventTarget | null): Element | null => (target instanceof Element ? target.closest('button, a[href], select, input, [role="button"], [role="tab"]') : null);
    const usable = (el: Element | null): el is Element => el !== null && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
    let over: Element | null = null;
    window.addEventListener('pointerover', (ev) => {
      const el = control(ev.target);
      if (el === over) return;
      over = el;
      if (usable(el) && ev.pointerType === 'mouse') this.world.sound?.ui('hover');
    });
    window.addEventListener('pointerdown', (ev) => {
      if (usable(control(ev.target))) this.world.sound?.ui('press');
    });
    // A card or a panel coming up, or being put away.
    const leaf = (shown: () => boolean): void => {
      let was = shown();
      effect(() => {
        const is = shown();
        if (is === was) return;
        was = is;
        this.world.sound?.ui((is ? 'open' : 'close') satisfies UiSound);
      });
    };
    leaf(() => ui.menuOpen.value);
    leaf(() => ui.settingsOpen.value);
    leaf(() => ui.ranksOpen.value);
    leaf(() => ui.explain.value !== null);
    leaf(() => ui.promotion.value !== null);
    leaf(() => ui.asking.value !== null);

    // Where a press points, for choosing a square: a finger carrying a stone holds it a little above itself.
    const lifted = (ev: PointerEvent, carrying: boolean): number => ev.clientY - (carrying && ev.pointerType === 'touch' ? TOUCH_LIFT : 0);
    const pickFor = (ev: PointerEvent, carrying: boolean): Square | null =>
      ev.pointerType === 'touch' ? this.touchPick(ev.clientX, lifted(ev, carrying), carrying) : this.world.pick(ev.clientX, ev.clientY, carrying ? this.reach() : undefined);

    c.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      // A press while the case is opening finishes it, and does nothing more.
      if (this.world.unpacking) return this.world.finishUnpack();
      if (ev.pointerType === 'touch') {
        this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        // A second finger: the two pinch the view nearer or further, and whatever the first had taken up is put back.
        if (this.touches.size >= 2) return this.beginPinch();
      }
      c.setPointerCapture(ev.pointerId);
      // Pressing on a stone the player may move takes hold of it, so that it can be carried to
      // its square and let go there. A click on it and then on the square does the same.
      const square = pickFor(ev, false);
      const wasChosen = square !== null && this.selected === square;
      if (square && !wasChosen && this.mayGrab(square)) this.click(square);
      const grabbed = square && this.selected === square ? square : null;
      this.press = { id: ev.pointerId, touch: ev.pointerType === 'touch', x: ev.clientX, y: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, lastTime: ev.timeStamp, dragging: false, grabbed, wasChosen };
    });

    c.addEventListener('pointermove', (ev) => {
      if (this.touches.has(ev.pointerId)) {
        this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (this.pinch !== null) return this.pinchMoved();
      }
      const rect = c.getBoundingClientRect();
      this.rig.pointer.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -(((ev.clientY - rect.top) / rect.height) * 2 - 1),
      );
      const p = this.press;
      if (p) {
        if (p.id !== ev.pointerId) return;
        if (!p.dragging && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > (p.touch ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD)) {
          p.dragging = true;
          // With a stone in hand the drag carries the stone; otherwise, in the free view, it turns the camera.
          if (!p.grabbed && this.rig.mode === 'orbit') this.rig.orbitHold(true);
        }
        if (p.grabbed) {
          // The square under the stone is the one it would be set down on.
          const over = pickFor(ev, true);
          if (over !== this.hovered) {
            this.hovered = over;
            this.refreshHover();
          }
        } else if (p.dragging && this.rig.mode === 'orbit') {
          this.rig.orbitDrag(ev.clientX - p.lastX, ev.clientY - p.lastY, (ev.timeStamp - p.lastTime) / 1000);
        }
        if (p.dragging && (p.grabbed || this.rig.mode === 'orbit')) c.style.cursor = 'grabbing';
        p.lastX = ev.clientX;
        p.lastY = ev.clientY;
        p.lastTime = ev.timeStamp;
        return;
      }
      // A finger only points while it presses: there is nothing to hover over.
      if (ev.pointerType === 'touch') return;
      const square = this.world.pick(ev.clientX, ev.clientY);
      if (square !== this.hovered) {
        this.hovered = square;
        this.refreshHover();
      }
    });

    const release = (ev: PointerEvent, cancelled: boolean) => {
      const pinching = this.pinch !== null;
      if (this.touches.delete(ev.pointerId) && this.touches.size < 2) this.pinch = null;
      // A finger lifted from a pinch, or one that never pressed for itself, does nothing more.
      if (pinching) return;
      const p = this.press;
      if (!p || p.id !== ev.pointerId) return;
      this.press = null;
      this.rig.orbitHold(false);
      // A stone being carried is let go over a square it may stand on, even where another stone stands in front of that square.
      const carrying = p.grabbed !== null && p.dragging && this.selected === p.grabbed;
      const square = pickFor(ev, carrying);
      if (p.grabbed && this.selected === p.grabbed) {
        if (cancelled) {
          // The press was taken away (the window lost the pointer): the stone stays chosen.
        } else if (!p.dragging || square === p.grabbed) {
          // A plain click. The stone was taken hold of on the way down; a click on one already chosen lets it go.
          if (p.wasChosen && !p.dragging) this.select(null);
        } else if (square && this.game.pieceAt(square)?.side !== this.game.turn()) {
          // Let go over a square: a move if the stone may stand there, and otherwise it goes back.
          this.click(square);
        } else {
          this.select(null);
        }
      } else if (!p.grabbed && !p.dragging && !cancelled) {
        this.click(square);
      }
      // A finger leaves nothing under itself to hover over.
      this.hovered = p.touch ? null : square;
      this.refreshHover();
    };
    c.addEventListener('pointerup', (ev) => release(ev, false));
    c.addEventListener('pointercancel', (ev) => release(ev, true));

    c.addEventListener('pointerleave', (ev) => {
      if (this.press || ev.pointerType === 'touch') return;
      this.hovered = null;
      this.rig.pointer.set(0, 0);
      this.refreshHover();
    });

    c.addEventListener(
      'wheel',
      (ev) => {
        if (this.rig.mode !== 'orbit') return;
        ev.preventDefault();
        this.rig.orbitZoom(ev.deltaY);
      },
      { passive: false },
    );

    // Back to the page after it was hidden (another tab, another app, the screen locked): the sound
    // is started again if the system stopped it, and the connections to the server are checked at
    // once, not after the long silence that would otherwise tell a dead one.
    document.addEventListener?.('visibilitychange', () => {
      if (!document.hidden) this.wake();
    });

    window.addEventListener('keydown', (ev) => {
      if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // A key while the case is opening finishes it, and does nothing more.
      if (this.world.unpacking) {
        this.world.finishUnpack();
        return;
      }
      const mode = CAMERA_MODES.find((m) => m.key === ev.key);
      if (ev.key === 'Escape') {
        if (ui.bare.value) ui.bare.value = false;
        else if (ui.asking.value) this.answerAsk(false);
        else if (ui.warning.value) this.answerWarning(false);
        else if (ui.promotion.value) this.choosePromotion(null);
        else if (ui.menuOpen.value && !ui.opening.value) ui.menuOpen.value = false;
        else if (ui.settingsOpen.value) ui.settingsOpen.value = false;
        else if (ui.viewing.value !== null) this.view(null);
        else this.select(null);
      } else if (ui.menuOpen.value || ui.warning.value || ui.asking.value || ui.promotion.value) {
        // A question on screen has the keyboard while it is up.
        return;
      } else if (ev.key === 'ArrowLeft') {
        this.stepView(-1);
      } else if (ev.key === 'ArrowRight') {
        this.stepView(1);
      } else if (ev.key === 'Home') {
        this.view(0);
      } else if (ev.key === 'End') {
        this.view(this.game.history().length);
      } else if (ev.key === 'h' || ev.key === 'H') {
        void this.hint();
      } else if (mode) {
        this.setCamera(mode.id);
      } else if (ev.key === 'f' || ev.key === 'F') {
        this.flip();
      } else if (ev.key === 'Backspace') {
        void this.takeBack();
      } else if (ev.key === 'r' || ev.key === 'R') {
        // Asks first: see `askResign`.
        this.askResign();
      } else if (ev.key === 'd' || ev.key === 'D') {
        this.askDraw();
      } else if (ev.key === 'p' || ev.key === 'P') {
        this.setBare(!ui.bare.value);
      } else if (ev.key === 'm' || ev.key === 'M') {
        // To the field where a move can be typed, if it is on screen.
        const field = document.getElementById('type-move');
        if (!field || field.offsetParent === null) return;
        field.focus();
      } else {
        return;
      }
      ev.preventDefault();
    });
  }

  /**
   * Put the interface away, to look at the board alone, or bring it back. The game can still be
   * played by its stones. Nothing is put away while something on it wants reading or answering.
   */
  setBare(on: boolean): void {
    if (!on) {
      ui.bare.value = false;
      return;
    }
    // Asked from the settings, which close for it.
    if (ui.opening.value || this.wantsReading(true)) return;
    ui.settingsOpen.value = false;
    ui.bare.value = true;
  }

  /**
   * The square a finger means. A finger is broad and the camera may be low, so it is helped: the
   * player's own stones that can move are preferred to whatever stands in front of them (from the
   * Shoulder view the king can hide the pawn before him), and while a stone is chosen the squares
   * it may go to are preferred to any stone, and a tap just beside one of them lands on it.
   * `carrying` is for a stone being carried: there, the player's own stones are not wanted.
   */
  private touchPick(x: number, y: number, carrying = false): Square | null {
    const targets = this.selected ? this.reach() : new Set<Square>();
    const prefer = new Set<Square>(targets);
    if (!carrying) for (const square of this.movable()) prefer.add(square);
    const square = this.world.pick(x, y, prefer.size > 0 ? prefer : undefined);
    if (targets.size === 0 || (square !== null && (targets.has(square) || (!carrying && prefer.has(square))))) return square;
    const ground = this.groundPoint(x, y);
    if (!ground) return square;
    let nearest: Square | null = null;
    let best = TOUCH_REACH;
    for (const target of targets) {
      const c = squareCenter(target);
      const d = Math.hypot(c.x - ground.x, c.z - ground.z);
      if (d <= best) {
        best = d;
        nearest = target;
      }
    }
    return nearest ?? square;
  }

  /** The squares of the stones this screen may move now that have somewhere to go. */
  private movable(): Square[] {
    if (this.busy || ui.viewing.value !== null || this.game.status().over) return [];
    const turn = this.game.turn();
    if (!this.controls(turn)) return [];
    return this.game
      .pieces()
      .filter((p) => p.side === turn && this.game.canMove(p.square))
      .map((p) => p.square);
  }

  /** Where a point on the screen meets the board's surface, if it does. */
  private groundPoint(x: number, y: number): Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new Vector2(((x - rect.left) / rect.width) * 2 - 1, -(((y - rect.top) / rect.height) * 2 - 1));
    this.world.camera.updateMatrixWorld();
    this.ray.setFromCamera(ndc, this.world.camera);
    const hit = this.ray.ray.intersectPlane(this.surface, new Vector3());
    return hit;
  }

  /** A second finger has come down: a pinch begins. Whatever the first had taken up is put back; a stone chosen before stays chosen. */
  private beginPinch(): void {
    const p = this.press;
    this.press = null;
    this.rig.orbitHold(false);
    if (p?.grabbed && !p.wasChosen && this.selected === p.grabbed) this.select(null);
    this.hovered = null;
    this.pinch = this.spread();
    this.refreshHover();
  }

  /** How far apart the first two fingers are, in CSS pixels. */
  private spread(): number {
    const [a, b] = [...this.touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /**
   * The fingers of a pinch have moved: their coming together or going apart is the camera's zoom,
   * as the wheel's turn is (it is the same scale: a turn of the wheel `deltaY` multiplies the
   * distance by e^(0.0011 deltaY), in CameraRig.orbitZoom). Only the free view zooms.
   */
  private pinchMoved(): void {
    const now = this.spread();
    const was = this.pinch;
    this.pinch = now;
    if (!was || !now || this.rig.mode !== 'orbit') return;
    this.rig.orbitZoom(Math.log(was / now) / WHEEL_ZOOM);
  }

  /** The page is shown again after being hidden: sound started again, connections checked. */
  wake(): void {
    const sound = this.world.sound;
    if (sound) {
      const ctx = sound.ctx as AudioContext;
      if (ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => {});
    }
    this.net?.wake();
    this.hall?.wake();
  }

  /** Whether something on the interface wants reading or answering just now, so that it cannot be put away. */
  private wantsReading(butSettings = false): boolean {
    // Online, a draw offered by the other player waits for an answer that only the interface can give.
    const offer = ui.online.value?.offer ?? null;
    const offered = ui.you.value !== null && offer !== null && offer !== ui.you.value;
    const settings = ui.settingsOpen.value && !butSettings;
    const closed = ui.online.value?.closed != null;
    return !!(ui.menuOpen.value || settings || ui.asking.value || ui.warning.value || ui.promotion.value || ui.lesson.value || ui.explain.value || ui.notice.value || offered || closed || (ui.resultVisible.value && ui.status.value.over));
  }

  /**
   * Advance the whole app by a fixed amount of time in small steps, drawing each one.
   * For automated checks, where the browser may not be delivering animation frames.
   */
  async advance(seconds: number, step = 1 / 60): Promise<void> {
    for (let t = 0; t < seconds - 1e-9; t += step) {
      this.tick(step);
      // Yield a full task so that chained animations can queue their next stage.
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      });
    }
  }

  /** Draw the current state again without advancing time. For frame captures. */
  redraw(): void {
    this.world.resize();
    this.world.render(0, this.time);
  }

  private tick(dt: number): void {
    this.time += dt;
    this.world.resize();
    this.rig.share = this.world.framingShare;
    this.rig.update(dt, this.world.framingAspect);
    this.world.setLens(this.rig.cutting || ui.opening.value);
    // From straight above, each stone wears its chess symbol (always in a lesson; otherwise if that help is on).
    this.world.nameStones(this.rig.mode === 'top' && !this.rig.cutting && (ui.mode.value.kind === 'lessons' || ui.aids.value.labels), ui.seat.value);
    this.world.render(dt, this.time);
  }

  /** What has gone wrong in a frame so far, so that the same fault is not said sixty times a second. */
  private faults = new Set<string>();

  private frame = (now: number): void => {
    const elapsed = now - this.last;
    this.last = now;
    if (elapsed > 0 && elapsed < 500) {
      this.stats.frameMs += (elapsed - this.stats.frameMs) * 0.05;
      this.stats.fps = 1000 / this.stats.frameMs;
    }
    this.stats.frames++;
    try {
      // Cap the step so a stalled tab resumes smoothly instead of jumping, without slowing a 10 fps machine.
      if (!this.held) {
        this.tick(Math.min(0.1, Math.max(0, elapsed / 1000)));
        this.watchPace(elapsed);
      }
    } catch (error) {
      // One frame that goes wrong must not be the last: left to itself the fault would stop the
      // game for good, where it may be gone by the next frame. Each fault is said once.
      const what = String(error);
      if (!this.faults.has(what) && this.faults.size < 12) {
        this.faults.add(what);
        console.error('A frame went wrong. The game goes on.', error);
      }
    } finally {
      requestAnimationFrame(this.frame);
    }
  };

  /**
   * Keep the game smooth on a machine the starting quality was too much for. Only frames the
   * browser is really showing count (a tab in the background is drawn a few times a second
   * whatever the machine), and a quality the player picked is never touched.
   */
  private watchPace(elapsed: number): void {
    if (!ui.ready.value || document.hidden || elapsed <= 0) return;
    // A quality the player picked is kept, and so is the lowest, which has nothing below it:
    // what gives instead is the size the picture is drawn at. A machine drawing four frames a
    // second is the one this is most for, so long frames count here; only a stall does not.
    if (qualityIsChosen() || ui.quality.value === 'low') {
      const moved = this.governor.use(this.world.governorSteps());
      if ((elapsed < 1000 && this.governor.feed(Math.min(elapsed, 250))) || moved) {
        this.world.setRenderScale(this.governor.scale, this.governor.smooth);
        this.stats.scale = this.governor.scale;
      }
      return;
    }
    if (elapsed > 250) return;
    const p = this.pace;
    p.ms += (elapsed - p.ms) * 0.03;
    if (++p.counted < PACE_FRAMES || p.ms < TOO_SLOW) return;
    const lower: Partial<Record<Quality, Quality>> = { high: 'medium', medium: 'low' };
    const next = ui.quality.value ? lower[ui.quality.value] : undefined;
    p.counted = 0;
    p.ms = 16.7;
    if (!next) return;
    ui.quality.value = next;
    this.world.setQuality(next);
    this.restoreScale();
    ui.notice.value = 'The picture quality has been lowered to keep the game smooth. You can change it in Settings.';
  }
}
