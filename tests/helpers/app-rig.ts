/**
 * Runs the game's real controller (src/app/app.ts) under Node, so that its
 * flows can be tested: whose turn it is, what a click does, what happens
 * when the computer, the server or a lesson's script acts in the middle of
 * something else.
 *
 * Only what needs a browser's graphics, files or worker is stood in for:
 * the 3D world, the asset loaders, the sound, and the engine's worker. The
 * rules, the engine wrapper, the verdicts, the lessons, the connection and
 * the interface's state are the game's own. The test file declares the
 * stand-ins with `vi.mock`; this file supplies them.
 */
import { Plane, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { vi } from 'vitest';
import type { App } from '../../src/app/app.ts';
import type { ui as Ui } from '../../src/app/store.ts';
import { Game, type PromotionKind, type Square } from '../../src/core/game.ts';
import type { Engine } from '../../src/engine/uci.ts';
import { Tweens } from '../../src/scene/tween.ts';

/** What the stand-ins and the tests share. Module state would be lost each time the game's modules are loaded afresh. */
interface Shared {
  /** How long the stand-in world takes over a move and a take-back, in seconds of the game's clock. */
  moveSeconds: number;
  undoSeconds: number;
  /** What the mocked src/engine/browser.ts hands back. */
  startEngine: () => Promise<Engine>;
  /** What the page's window and document were asked to listen for, by the controller last booted. */
  listeners: { window: Map<string, Listener[]>; document: Map<string, Listener[]> };
  /** What `matchMedia` answers: whether the player has asked for less movement. */
  reducedMotion: boolean;
  /** How long the stand-in world takes to open the case, whole and stones only, in seconds of the game's clock. 0 is at once. */
  opening: { full: number; short: number };
}
type Listener = (event: unknown) => void;
const listen = (into: () => Map<string, Listener[]>) => (type: string, fn: Listener) => {
  const map = into();
  map.set(type, [...(map.get(type) ?? []), fn]);
};
export const shared: Shared = ((globalThis as Record<string, unknown>).__nightpieceRig ??= {
  moveSeconds: 1.1,
  undoSeconds: 0.9,
  startEngine: () => Promise.reject(new Error('no engine was set up')),
  listeners: { window: new Map(), document: new Map() },
  reducedMotion: false,
  opening: { full: 0, short: 0 },
}) as Shared;

/** The world, as far as the controller can tell: a clock for its animations, and promises for moves and take-backs. */
export class FakeWorld {
  readonly tweens = new Tweens();
  readonly camera = new PerspectiveCamera(40, 1.6, 0.1, 220);
  readonly renderer = {};
  readonly maxAnisotropy = 1;
  readonly framingAspect = 1.6;
  readonly aspect = 1.6;
  sound = null;
  /** The marks last laid on the board, by layer. */
  readonly marks = new Map<string, { square: Square; kind: string }[]>();
  readonly markers = { set: (layer: string, marks: { square: Square; kind: string }[]) => void this.marks.set(layer, marks) };
  readonly pieces = { reset: () => {}, setSelected: () => {} };
  /** The square each side's hand is hovering over. */
  readonly considered: Record<string, string | null> = { w: null, b: null };
  /** Every move and take-back the world was asked to show, in order. */
  readonly shown: string[] = [];
  /** Each time the room was stood again for a position: whether it was told the game had ended that moment. */
  readonly stood: boolean[] = [];
  /** Each time the room was told whether to answer only what can be seen on the board, in order. */
  readonly plain: boolean[] = [];
  /** Every verdict passed on to the room, by the move's notation. */
  readonly appraised: string[] = [];
  /** Whether the case stands shut, waiting for a game; and each opening asked for, in order. */
  packed = false;
  readonly unpacked: string[] = [];
  /** How many openings were finished early, by a press, a key or a new position. */
  cut = 0;
  private opening: { resolve: () => void } | null = null;

  constructor() {
    // Anything not spelled out here is a part of the picture that does nothing.
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        return () => undefined;
      },
    });
  }

  playMove(e: { san: string }): Promise<void> {
    this.shown.push(e.san);
    return this.tweens.wait(shared.moveSeconds);
  }
  playUndo(e: { san: string }): Promise<void> {
    this.shown.push(`undo ${e.san}`);
    return this.tweens.wait(shared.undoSeconds);
  }
  resetLife(_status: unknown, happened = false): void {
    this.stood.push(happened);
  }
  setPlain(plain: boolean): void {
    this.plain.push(plain);
  }
  appraise(e: { san: string }): void {
    this.appraised.push(e.san);
  }
  consider(side: string, square: string | null): void {
    this.considered[side] = square;
  }
  /**
   * Stones standing in front of squares, as a low camera sees them: a press that meets the board on
   * the key's square meets the stone on the value's first. Empty: every press meets the board.
   */
  readonly inFront = new Map<Square, Square>();
  private ray = new Raycaster();

  /** The square under a point, by the real camera, as the real world finds it (see World.pick): a stone in front wins unless `reach` says the square behind is meant. */
  pick(clientX: number, clientY: number, reach?: ReadonlySet<Square>): Square | null {
    const ground = groundSquare(this.camera, this.ray, clientX, clientY);
    const piece = ground ? (this.inFront.get(ground) ?? null) : null;
    if (piece && !reach) return piece;
    if (piece && reach && !reach.has(piece) && ground && reach.has(ground)) return ground;
    return piece ?? ground;
  }
  render(dt: number): void {
    this.tweens.update(dt);
  }
  get unpacking(): boolean {
    return this.opening !== null;
  }
  pack(): void {
    this.finishUnpack();
    this.packed = true;
  }
  /** As the real world's: the whole opening needs a shut case, and is the short one without. */
  unpack(mode: 'full' | 'short' | 'none'): Promise<void> | null {
    this.finishUnpack();
    if (mode === 'full' && !this.packed) mode = 'short';
    this.packed = false;
    this.unpacked.push(mode);
    const seconds = mode === 'none' ? 0 : shared.opening[mode];
    if (seconds <= 0) return null;
    return new Promise<void>((resolve) => {
      const opening = { resolve };
      this.opening = opening;
      void this.tweens.wait(seconds).then(() => {
        if (this.opening !== opening) return;
        this.opening = null;
        resolve();
      });
    });
  }
  /** How many times the stones were noted before a new position was set up. */
  remembered = 0;
  remember(): void {
    this.remembered++;
  }
  finishUnpack(): void {
    const opening = this.opening;
    if (!opening) return;
    this.opening = null;
    this.cut++;
    opening.resolve();
  }
}

/** The size of the stand-in canvas, in CSS pixels. */
export const CANVAS = { width: 1280, height: 720 };

/** Where a point on the stand-in canvas meets the board, and the square there. */
function groundSquare(camera: PerspectiveCamera, ray: Raycaster, x: number, y: number): Square | null {
  camera.updateMatrixWorld();
  ray.setFromCamera(new Vector2((x / CANVAS.width) * 2 - 1, -((y / CANVAS.height) * 2 - 1)), camera);
  const hit = ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
  if (!hit) return null;
  const file = Math.floor(hit.x + 4);
  const rank = Math.floor(4 - hit.z);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${'abcdefgh'[file]}${rank + 1}` as Square;
}

/** Where a point on the board (x and z, as squareCenter gives them) is on the stand-in canvas. */
export function onScreen(camera: PerspectiveCamera, x: number, z: number): { x: number; y: number } {
  camera.updateMatrixWorld();
  const v = new Vector3(x, 0, z).project(camera);
  return { x: ((v.x + 1) / 2) * CANVAS.width, y: ((1 - v.y) / 2) * CANVAS.height };
}

export interface ScriptedLine {
  move: string;
  cp?: number;
  mate?: number;
}

/**
 * Stockfish, as far as the real Engine class can tell: it speaks enough of the protocol to be
 * started, set, searched and stopped. What it "finds" is what the test scripted, or else the
 * first legal moves in the order the rules list them.
 */
export class FakePort {
  private onLine: (line: string) => void = () => {};
  readonly sent: string[] = [];
  private fen = '';
  private multipv = 1;
  private running: { fen: string; multipv: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Every position searched, in order. */
  readonly searched: string[] = [];
  /** Every `position` line the engine was sent, with the moves it was told had led there. */
  readonly positions: string[] = [];
  /** How many times an engine has been started on it. */
  started = 0;
  /** Set once it has been told to quit, as a worker that has been ended: it hears nothing more. */
  quit = false;
  /** If set, it never answers: the engine whose program did not finish loading. */
  mute = false;
  /** How long a search takes, in real milliseconds. */
  delay = 0;
  /** What a search of a position finds, best first. Null for the default. */
  script: ((fen: string, lines: number) => ScriptedLine[] | null) | null = null;

  send(line: string): void {
    this.sent.push(line);
    if (this.mute || this.quit) return;
    if (line === 'quit') {
      // The worker is ended: a search under way stops where it is and is never reported.
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.running = null;
      this.quit = true;
      return;
    }
    if (line === 'uci') this.emit('uciok');
    else if (line === 'isready') this.emit('readyok');
    else if (line.startsWith('setoption name MultiPV value ')) this.multipv = Number(line.split(' ').pop());
    else if (line.startsWith('position fen ')) {
      // The position, and perhaps the moves played from it: what is searched is where they lead.
      const [from, played] = line.slice('position fen '.length).split(' moves ');
      this.positions.push(line);
      const game = new Game(from);
      for (const m of played ? played.split(' ') : []) game.move(m.slice(0, 2) as Square, m.slice(2, 4) as Square, m[4] as PromotionKind | undefined);
      this.fen = game.fen();
    }
    else if (line.startsWith('go')) {
      this.running = { fen: this.fen, multipv: this.multipv };
      this.timer = setTimeout(() => this.finish(), this.delay);
    } else if (line === 'stop') this.finish();
  }
  listen(fn: (line: string) => void): void {
    this.onLine = fn;
  }
  close(): void {}

  private finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const r = this.running;
    if (!r) return;
    this.running = null;
    this.searched.push(r.fen);
    const legal = new Game(r.fen).moves().map((m) => m.from + m.to + (m.promotion ?? ''));
    const lines: ScriptedLine[] = this.script?.(r.fen, r.multipv) ?? legal.slice(0, Math.max(1, r.multipv)).map((move, i) => ({ move, cp: 20 - 10 * i }));
    lines.slice(0, Math.max(1, r.multipv)).forEach((l, i) => {
      const score = l.mate !== undefined ? `mate ${l.mate}` : `cp ${l.cp ?? 0}`;
      this.emit(`info depth 11 seldepth 14 multipv ${i + 1} score ${score} nodes 1 nps 1 time 1 pv ${l.move}`);
    });
    this.emit(`bestmove ${lines[0]?.move ?? '(none)'}`);
  }

  private emit(line: string): void {
    // A worker's messages arrive on a later turn of the event loop, never inside postMessage.
    setTimeout(() => this.onLine(line), 0);
  }
}

/** The parts of a browser the controller touches, as plain objects. Call once before any `boot`. */
export function stubBrowser(): void {
  const storage = () => {
    const kept = new Map<string, string>();
    return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k), clear: () => kept.clear() };
  };
  const location = { search: '', href: 'http://127.0.0.1:1/', protocol: 'http:', host: '127.0.0.1:1' };
  vi.stubGlobal('window', { addEventListener: listen(() => shared.listeners.window), devicePixelRatio: 1 });
  vi.stubGlobal('document', { hidden: false, body: { classList: { add() {} } }, addEventListener: listen(() => shared.listeners.document) });
  // Nothing on the stand-in page is an element of it: what is pressed is never a control.
  vi.stubGlobal('Element', class {});
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion') && shared.reducedMotion }));
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', {
    replaceState(_state: unknown, _title: unknown, url: unknown) {
      const u = new URL(String(url));
      location.href = u.href;
      location.search = u.search;
    },
  });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('sessionStorage', storage());
}

export interface Rig {
  app: App;
  ui: typeof Ui;
  world: FakeWorld;
  port: FakePort;
  /** Let pending promises and timers that are due run. */
  settle(turns?: number): Promise<void>;
  /** Advance the game's clock, drawing frames as a browser would. */
  run(seconds: number): Promise<void>;
  /** Advance the clock until `test` holds (or fail after `limit` seconds of game time). */
  until(test: () => boolean, limit?: number): Promise<void>;
  /** Hand an event to what the controller listens with: on its canvas, the window or the document. */
  fire(on: 'canvas' | 'window' | 'document', type: string, event?: object): void;
}

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface BootOptions {
  /** The engine: answers at once, never finishes loading, or fails to load. */
  engine?: 'ready' | 'never' | 'fails';
  /** The page's address, for a game joined by its link. */
  address?: string;
  /** Saved settings to start with. */
  settings?: object;
  /** Whether the stored keys and settings of the last `boot` are kept, as a reload of the page would keep them. */
  keepStorage?: boolean;
  /** Whether the player's system asks for less movement. */
  reducedMotion?: boolean;
  /** How long the case takes to open (see Shared.opening). */
  opening?: { full: number; short: number };
}

/** Load the game afresh and build the controller on the stand-ins. */
export async function boot(options: BootOptions = {}): Promise<Rig> {
  vi.resetModules();
  const g = globalThis as unknown as { localStorage: Storage; sessionStorage: Storage; location: { href: string; search: string; host: string } };
  if (!options.keepStorage) {
    g.localStorage.clear();
    g.sessionStorage.clear();
  }
  if (options.settings) g.localStorage.setItem('nightpiece.settings.v1', JSON.stringify(options.settings));
  const address = new URL(options.address ?? 'http://127.0.0.1:1/');
  g.location.href = address.href;
  g.location.search = address.search;
  g.location.host = address.host;

  const { Engine: EngineClass } = await import('../../src/engine/uci.ts');
  const port = new FakePort();
  const kind = options.engine ?? 'ready';
  port.mute = kind === 'never';
  shared.startEngine =
    kind === 'fails'
      ? () => Promise.reject(new Error('The chess engine did not load'))
      : async () => {
          // Each engine is a new worker: one that was ended before is started again afresh.
          port.quit = false;
          port.started++;
          const engine = new EngineClass(port);
          await engine.start();
          return engine;
        };

  shared.reducedMotion = options.reducedMotion ?? false;
  shared.opening = options.opening ?? { full: 0, short: 0 };
  shared.listeners = { window: new Map(), document: new Map() };
  const onCanvas = new Map<string, Listener[]>();
  const { ui } = await import('../../src/app/store.ts');
  const { App: AppClass } = await import('../../src/app/app.ts');
  const canvas = {
    addEventListener: listen(() => onCanvas),
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: CANVAS.width, height: CANVAS.height }),
    setPointerCapture() {},
    clientWidth: CANVAS.width,
    clientHeight: CANVAS.height,
  };
  const app = new AppClass(canvas as unknown as HTMLCanvasElement);
  app.held = true;

  const settle = async (turns = 6) => {
    for (let i = 0; i < turns; i++) await turn();
  };
  const run = async (seconds: number) => {
    await app.advance(seconds, 1 / 30);
    await settle(3);
  };
  const until = async (test: () => boolean, limit = 30) => {
    for (let t = 0; t < limit && !test(); t += 0.1) await run(0.1);
    if (!test()) throw new Error(`Still waiting after ${limit} seconds of the game's clock`);
  };
  const listeners = { canvas: onCanvas, window: shared.listeners.window, document: shared.listeners.document };
  const fire = (on: 'canvas' | 'window' | 'document', type: string, event: object = {}) => {
    for (const fn of listeners[on].get(type) ?? []) fn({ preventDefault() {}, ...event });
  };
  await settle();
  return { app, ui, world: app.world as unknown as FakeWorld, port, settle, run, until, fire };
}
