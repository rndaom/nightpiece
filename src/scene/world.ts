/**
 * Owns the renderer, the scene graph and the lights, and answers the one
 * question input needs from 3D: which square is under the pointer.
 *
 * The world starts as the grey-box so there is something on screen at once.
 * When the Blender assets arrive, `useAssets` swaps in the finished chapel,
 * the stone pieces and the post-processing chain.
 */
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  SpotLight,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Sound } from '../audio/sound';
import type { Kind, MoveEvent, Side, Square, Status } from '../core/game';
import type { VerdictKind } from '../engine/verdict';
import type { HandTemplate } from '../hands/hand';
import type { PieceGrip } from '../hands/puppeteer';
import { Stage } from '../hands/stage';
import { BoardFx } from '../life/boardfx';
import { Director } from '../life/director';
import { boundSkins, texturesIn } from './ahead';
import type { Assets } from './assets';
import { Board } from './board';
import { Casework } from './casework';
import { Chapel, type Mood } from './chapel';
import { dockedShares } from './framing';
import { Labels } from './labels';
import { PALETTE, squareAt } from './layout';
import { Markers } from './markers';
import { Opening, type Unpacking } from './opening';
import { STEPS, type Step } from './pace';
import { assetLook, PieceLayer } from './pieces';
import { drawingRatio, governedRatio, governorSteps, Post, QUALITY, type Quality } from './post';
import { Spring } from './spring';
import { Tweens } from './tween';

/**
 * What the picture as a whole does in each of the room's states: corner fall-off, a tint, fill
 * light, and how far its darks and lights are pulled apart (1 leaves them as they are).
 */
/**
 * A phone on its side (src/ui/hud.css, `@media (max-height: 500px) and (orientation: landscape)`)
 * stands its interface down both sides of the board: who plays and the cards on the left, the rows
 * of buttons on the right. The board is framed in what is left between them. These mirror that
 * rule's widths, in CSS pixels: `--edge` is `max(10px, safe area)` and `--side` is
 * `clamp(176px, 50vw - 200px, 300px)` (the left column, and the cards in it); the right column is
 * the keys of the bar, two wide (two `.slot-face` 44px wide with 6px between, and 3px of hard
 * shadow), from the edge. The safe area of a phone with a notch is not known here, so on one
 * the columns stand in a little further than this allows for.
 */
const SIDEWAYS = { tallest: 500, narrowest: 640, edge: 10, side: { least: 176, share: 0.5, less: 200, most: 300 }, keys: 2 * 44 + 6 + 3 };
/** The middle of the shut case, which lies on Void's half: how far along z from the middle of the board. */
const SHUT_MIDDLE = -2.43;
/**
 * And how the shut case is looked at: the view tipped up by this much (radians) and its lens
 * opened by this many degrees, so that the case sits low in the picture with the chapel standing
 * behind it, its candles and its windows, where otherwise there would be floor.
 */
const SHUT_TIP = 0.15;
const SHUT_WIDER = 13;
/**
 * On a phone held upright the menu lies across the foot of the screen and its name across the
 * head, and what they leave is a band between: the shut case is drawn in the middle of that
 * band, this share of the screen's height above the middle of the screen, and not tipped.
 */
const SHUT_RAISED = 0.24;
/**
 * Whether the player has asked their system for less movement: `set` is told at once, and again
 * whenever they change it. (Asked once, and not every frame.)
 */
export function watchStillness(set: (still: boolean) => void): void {
  const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  set(motion?.matches ?? false);
  motion?.addEventListener?.('change', (e) => set(e.matches));
}

/** The longest the room is kept from being shown while what it draws is built ahead (`warm`), in seconds. */
const WARM_AT_MOST = 4;

const GRADES: Record<Mood, [number, number, number, number, number, number]> = {
  calm: [0.6, 1, 1, 1, 0.14, 1.18],
  sharp: [0.66, 0.97, 1.0, 1.0, 0.12, 1.16],
  check: [0.74, 0.96, 0.92, 1.04, 0.1, 1.2],
  mate: [0.88, 0.86, 0.8, 1.1, 0.06, 1.26],
};

export class World {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.1, 220);
  readonly tweens = new Tweens();
  readonly pieces = new PieceLayer(this.tweens);
  readonly markers = new Markers();
  /** The medallions that name each stone in the overhead view. */
  private labels = new Labels();
  /** The grey-box room. Removed once the finished one is in. */
  private board: Board | null;
  private chapel: Chapel | null = null;
  /** The case the board is, once the finished room is in. */
  private casework: Casework | null = null;
  /** The case shut and opened at the start of a game; it moves the stones while it opens. */
  private opening: Opening;
  /** The players' hands. Until they have loaded, the pieces move by themselves. */
  private stage: Stage | null = null;
  /** What the board does, and what decides how the room answers a move. Both arrive with the finished room. */
  private fx: BoardFx | null = null;
  private director: Director | null = null;
  /** Whether the room is to answer only what anyone can see on the board: see `setPlain`. */
  private plain = false;
  private lesson = false;
  private timed = false;
  /** Whether the player has asked their system for less movement: read once, and again whenever they change it. */
  private still = false;
  private handSeed: string | null = null;
  /** The game's sound, once the player has done something that lets the browser start it. */
  sound: Sound | null = null;
  /** Told when a weight comes down on the board hard enough to be felt, and how hard. */
  onThud: ((strength: number) => void) | null = null;
  private fill: HemisphereLight | null = null;
  /** What is kept out of the reflection in the board's dark squares. */
  private unmirrored: Object3D[] = [];
  private grade = GRADES.calm.map((v) => new Spring(v));
  private forward = new Vector3();
  /** The camera's own bearing, kept while the shut case is drawn from a tipped one. */
  private held = new Quaternion();
  private post: Post | null = null;
  private greyLights = new Group();
  private quality: Quality;
  /** The size the picture is drawn at against what the quality asks for. */
  private scale = 1;
  /** Whether edges are anti-aliased as the quality asks, or that has been given up for speed. */
  private smooth = true;

  private raycaster = new Raycaster();
  private ndc = new Vector2();
  private surface = new Plane(new Vector3(0, 1, 0), 0);
  private hit = new Vector3();
  private width = 0;
  private height = 0;
  /** Frames for which the shadow map still needs redrawing. */
  private shadowFrames = 4;
  /**
   * Room kept clear at the left of the picture for a card of text: how many pixels are asked
   * for, the fraction of the width in use now (it eases), and the fraction last given to the camera.
   */
  private insetPixels = 0;
  private inset = new Spring(0);
  private insetApplied = 0;
  /** The same at the right of the picture, for the column of buttons on a phone on its side; and the share last given to the camera. */
  private insetRight = new Spring(0);
  private insetRightApplied = 0;
  /**
   * The same at the foot and the head of the picture, for a card docked at the foot of a narrow
   * screen and the interface along its head: the pixels asked for, the shares of the height in
   * use now, and the shares last given to the camera.
   */
  private insetBelowPixels = 0;
  private insetAbovePixels = 0;
  private insetBottom = new Spring(0);
  private insetBottomApplied = 0;
  private insetTop = new Spring(0);
  private insetTopApplied = 0;
  /**
   * The lens: whether it is drawn tight on something (a cinematic cut, the opening screen), and
   * the focus distance, depth of the sharp zone and width of the blur, all of which ease.
   */
  private tight = false;
  private lens = { focus: new Spring(16), range: new Spring(7), amount: new Spring(0) };

  constructor(
    readonly canvas: HTMLCanvasElement,
    quality: Quality = 'medium',
  ) {
    this.quality = quality;
    watchStillness((still) => this.setStill(still));
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    // Shadows are redrawn only while something that casts them is moving (see render).
    this.renderer.shadowMap.autoUpdate = false;

    this.scene.background = new Color(PALETTE.soot);

    // Grey-box lighting: one hard, cool key from above, a little fill, and two faint rims.
    const key = new SpotLight(0xdce6e2, 3300, 60, 0.47, 0.6, 2);
    key.position.set(1.6, 21, 2.4);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 8;
    key.shadow.camera.far = 40;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    this.greyLights.add(key, key.target, new HemisphereLight(0x97a2a8, 0x3a332b, 0.95), ...this.rims(0.55));
    this.scene.add(this.greyLights);

    this.board = new Board(this.renderer.capabilities.getMaxAnisotropy());
    this.scene.add(this.board.root, this.pieces.contact.mesh, this.markers.root, this.pieces.root, this.labels.mesh);

    this.opening = new Opening(this.pieces, this.cues());

    this.resize(true);
  }

  get aspect(): number {
    return this.height > 0 ? this.width / this.height : 1;
  }

  /**
   * The shape of the part of the picture the board is framed in: the whole of it, or what is
   * left beside a card of text (see `keepClear`). The camera rig composes its views for this.
   */
  get framingAspect(): number {
    return (this.aspect * (1 - this.inset.value - this.insetRight.value)) / this.framingShare;
  }

  /** The share of the picture's height that the board is framed in: less than the whole when a card is docked at the foot of a narrow screen (see `keepClearBetween`). */
  get framingShare(): number {
    return 1 - (this.insetBottom.value < 0.0005 ? 0 : this.insetBottom.value) - (this.insetTop.value < 0.0005 ? 0 : this.insetTop.value);
  }

  /**
   * Keep a strip at the left of the picture clear of the board, for a card of text. The board
   * is reframed in what remains and the view glides over. Nothing happens on a narrow screen,
   * where there is no room to give; a phone on its side keeps both its columns clear whatever is
   * asked (see `clearance`).
   */
  keepClear(pixels: number): void {
    this.insetPixels = pixels;
  }

  /**
   * Keep a strip at the foot of the picture clear of the board, for a card docked there, and
   * one at its head, for the interface along the top. It is for the narrow screens (see
   * `clearance`), where a card cannot stand beside the board: the board is framed in the part
   * between, and the view glides. A card at the left of a wide screen is `keepClear`.
   */
  keepClearBetween(above: number, below: number): void {
    this.insetAbovePixels = Math.max(0, above);
    this.insetBelowPixels = Math.max(0, below);
  }

  /**
   * Draw the lens tight (a shallow depth of field, for a cinematic cut or the opening screen)
   * or let it relax to the quality setting's ordinary depth.
   */
  setLens(tight: boolean): void {
    this.tight = tight;
  }

  /** Where the camera is looking on the board, how far away that is, and so what the lens should do. */
  private focusLens(dt: number): void {
    const post = this.post;
    if (!post?.focuses) return;
    const p = this.camera.position;
    const f = this.camera.getWorldDirection(this.forward);
    // The point of the board the middle of the picture shows, kept within the slab: or, while the
    // case is shut (or its lid still over it), the top of the shut lid.
    const top = this.opening.pose.lid > 1.6 ? 1.15 : 0.45;
    let distance = p.length();
    if (f.y < -0.04) {
      const t = (top - p.y) / f.y;
      const x = Math.max(-4.6, Math.min(4.6, p.x + f.x * t));
      const z = Math.max(-4.6, Math.min(4.6, p.z + f.z * t));
      distance = Math.hypot(x - p.x, top - p.y, z - p.z);
    }
    const always = QUALITY[this.quality].focus === 'always';
    const { focus, range, amount } = this.lens;
    focus.goal = distance;
    // Tight: little more than the piece looked at is sharp (or, behind the menu, the whole of the
    // shut case, end to end). Otherwise the whole board is.
    range.goal = this.tight ? (top > 1 ? 5 : 1.5) : 7.5;
    // Behind the menu the lens is drawn less tight than for a cut: the chapel is to be seen, not guessed at.
    amount.goal = this.tight ? (top > 1 ? 0.0055 : 0.014) : always ? 0.004 : 0;
    focus.step(dt, 5);
    range.step(dt, 3.5);
    amount.step(dt, 3.5);
    post.setFocus(focus.value, range.value, amount.value);
  }

  /** Slide the picture sideways so that its middle is the middle of the part left clear. */
  private applyInset(force = false): void {
    const inset = this.inset.value < 0.0005 ? 0 : this.inset.value;
    const right = this.insetRight.value < 0.0005 ? 0 : this.insetRight.value;
    const bottom = this.insetBottom.value < 0.0005 ? 0 : this.insetBottom.value;
    const top = this.insetTop.value < 0.0005 ? 0 : this.insetTop.value;
    if (!force && Math.abs(inset - this.insetApplied) < 0.0002 && Math.abs(right - this.insetRightApplied) < 0.0002 && Math.abs(bottom - this.insetBottomApplied) < 0.0002 && Math.abs(top - this.insetTopApplied) < 0.0002) return;
    this.insetApplied = inset;
    this.insetRightApplied = right;
    this.insetBottomApplied = bottom;
    this.insetTopApplied = top;
    if ((inset === 0 && right === 0 && bottom === 0 && top === 0) || this.width === 0) this.camera.clearViewOffset();
    // The picture slides up by half of what is cleared below and down by half of what is cleared above, so that the middle of what is left is the middle of the picture.
    else this.camera.setViewOffset(this.width, this.height, ((right - inset) / 2) * this.width, ((bottom - top) / 2) * this.height, this.width, this.height);
  }

  /**
   * What is kept clear at the left and the right of the picture, as shares of its width. On a
   * wide screen, the card asked for at the left; on a phone on its side, both of the interface's
   * columns, whatever is asked (see SIDEWAYS); on any other narrow screen, the foot of the
   * picture, for the card docked there (see `keepClearBetween`); otherwise nothing.
   */
  private clearance(): [number, number, number, number] {
    const w = this.width;
    if (w === 0) return [0, 0, 0, 0];
    if (this.height <= SIDEWAYS.tallest && w >= SIDEWAYS.narrowest && w > this.height) {
      const side = Math.min(SIDEWAYS.side.most, Math.max(SIDEWAYS.side.least, SIDEWAYS.side.share * w - SIDEWAYS.side.less));
      return [(SIDEWAYS.edge + side) / w, (SIDEWAYS.edge + SIDEWAYS.keys) / w, 0, 0];
    }
    // Behind the choice of game, the shut case keeps to the part of the picture the menu leaves:
    // the whole of the column it asks for, which on a squarer screen is most of the width.
    const menu = this.opening.packed ? Math.min(0.7, Math.max(380, this.insetPixels) / w) : 0;
    if (w >= 900) return [Math.max(menu, Math.min(0.36, this.insetPixels / w)), 0, 0, 0];
    // The same screens as the lesson card is docked on (see DOCKED in src/ui/Cards.tsx): not a phone on its side, which has its columns.
    const [below, above] = dockedShares(this.height, this.insetBelowPixels, this.insetAbovePixels, SIDEWAYS.tallest);
    return [0, 0, below, above];
  }

  /** Whether the player has asked their system for less movement. */
  private stillness(): boolean {
    return this.still;
  }

  /** The player has asked their system for less movement, or no longer does: everything that goes by it is told. */
  private setStill(still: boolean): void {
    this.still = still;
    if (this.fx) this.fx.still = still;
    if (this.stage) this.stage.quiet = still;
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  /** True once the finished room and pieces are in place. */
  get finished(): boolean {
    return this.chapel !== null;
  }

  /** Repaint what is drawn with the page's typefaces, once they are available. */
  refreshLabels(): void {
    this.board?.refreshLabels();
    this.labels.repaint();
  }

  /** Whether each stone is named by a medallion on its top (for the overhead view), and which player that view faces. */
  nameStones(on: boolean, seat: Side): void {
    this.labels.show = on;
    this.labels.seat = seat;
  }

  /** Swap the grey-box for the finished room, stone pieces and post-processing. */
  useAssets(assets: Assets): void {
    if (this.chapel) return;
    // Everything that can go wrong is made before anything is taken away, so that a fault in the
    // assets leaves the plain board whole and playable and not half of each.
    const chapel = new Chapel(assets, this.maxAnisotropy, this.quality);
    const environment = chapel.environment(this.renderer, assets);
    let look: ReturnType<typeof assetLook>;
    let post: Post;
    try {
      look = assetLook(assets);
      post = new Post(this.renderer, this.scene, this.camera, this.quality);
    } catch (error) {
      environment.dispose();
      throw error;
    }

    if (this.board) {
      this.scene.remove(this.board.root);
      this.board = null;
    }
    this.scene.remove(this.greyLights);

    this.chapel = chapel;
    this.chapel.ease(this.scale < 1);
    this.scene.add(this.chapel.root);
    // The chapel brings its own lights: the key through the oculus and a low one from each end
    // of the room. This only keeps the deepest shadow on the pieces from going to nothing.
    this.fill = new HemisphereLight(0x8d9aa0, 0x2c261f, GRADES.calm[4]);
    this.scene.add(this.fill);

    // The board: the case, standing as the opening has it.
    this.casework = new Casework(assets, this.chapel.materials);
    this.casework.apply(this.opening.pose);
    this.scene.add(this.casework.root);

    const fx = new BoardFx(this.chapel.tileLift, this.chapel.tileCrumble);
    fx.thin = this.quality === 'low';
    fx.still = this.stillness();
    this.fx = fx;
    this.scene.add(fx.root);
    this.pieces.tileLift = (x, z) => fx.liftAt(x, z);
    this.director = new Director({ pieces: this.pieces, fx, setMood: (mood) => this.setMood(mood), thud: (strength) => this.onThud?.(strength), hands: () => this.stage ?? null }, () => this.sound);
    this.director.setPlain(this.plain);

    // What the pieces and the tiles mirror and are lit by from all round: the room itself, as it looks from the board.
    this.scene.environment = environment;
    this.scene.environmentIntensity = this.chapel.ambient;
    // What lies flat on the board, and so has no place in what the dark squares reflect; and the case itself.
    this.unmirrored = [this.markers.root, this.pieces.contact.mesh, this.labels.mesh, fx.root, this.casework.root];

    this.pieces.setLook(look);
    this.markers.setBoost(1.9);
    this.markers.setStone(true);
    this.post = post;
    this.post.setSmooth(this.smooth);
    this.shadowFrames = 4;
    this.resize(true);
  }

  /**
   * Have everything ready to draw before the room is shown: the program of every material, the
   * ones not yet on screen included, the pictures of the marks, and the shape of each stone as the
   * hands feel it. Without this the first stone chosen, the first move and the first check each
   * cost a frame several times too long.
   * Call it once the room and the hands are in. Resolves when it is done.
   */
  async warm(): Promise<void> {
    // Never longer than this, and never to the game's cost: what is not ready by then is built
    // where it is first drawn, as it would have been without any of this. (A context lost while it
    // is being built would leave it waiting for ever.)
    await Promise.race([this.warming(), new Promise((resolve) => setTimeout(resolve, WARM_AT_MOST * 1000))]);
  }

  private async warming(): Promise<void> {
    this.stage?.warm();
    if (!this.post) return;
    this.markers.warm(this.renderer);
    this.sendAhead();
    await Promise.all([this.post.warm(this.scene, this.camera), this.stage?.warmPictures(this.renderer, this.camera)]);
  }

  /**
   * Send every texture in the scene to the graphics card now; one is otherwise sent in the frame
   * its object is first drawn in, and the first stone chosen drew eight of them at once (a frame
   * of 25 ms on this machine's card, near a hundred with the processor slowed to a laptop's). And
   * work out the bounds of the hands' skinned meshes, which three.js otherwise does from every
   * vertex as each first comes into the picture (35 ms so slowed, when Void's first hand comes in).
   */
  private sendAhead(): void {
    for (const texture of texturesIn(this.scene)) this.renderer.initTexture(texture);
    boundSkins(this.scene);
  }

  /** Bring in the hands. From here on they move the pieces. */
  useHands(template: HandTemplate, assets: Assets): void {
    if (this.stage) return;
    const grips = {} as Record<Kind, PieceGrip>;
    for (const kind of Object.keys(assets.pieces) as Kind[]) grips[kind] = assets.pieces[kind].meta.grip;
    this.stage = new Stage(template, this.pieces, this.tweens, grips);
    this.stage.setPlain(this.plain);
    this.stage.setLesson(this.lesson);
    this.stage.setTimed(this.timed);
    this.stage.setSeed(this.handSeed);
    // Someone who has asked their machine for less motion gets the hands' rituals and none of their idling about.
    this.stage.quiet = this.still;
    this.stage.heard = (what, at, strength) => this.director?.heard(what, at, strength);
    this.scene.add(this.stage.root);
    this.pieces.handsOn = true;
    // While the case is shut, or opening, the hands wait for it.
    if (this.opening.packed || this.opening.running) this.stage.root.visible = false;
    else this.stage.appear();
    this.resize(true);
  }

  // -- the case ---------------------------------------------------------------

  /** True while the case stands shut and empty, waiting for a game. */
  get packed(): boolean {
    return this.opening.packed;
  }

  /** Whether the case is opening and the stones are on their way out of it. */
  get unpacking(): boolean {
    return this.opening.running;
  }

  /** Shut the case at once, with the stones put away and no hands, to wait for a game. */
  pack(): void {
    this.opening.pack();
    if (this.stage) this.stage.root.visible = false;
    this.casework?.apply(this.opening.pose);
    this.shadowFrames = 4;
  }

  /**
   * Set the position just stood out of the case (see Opening): 'full' opens a shut case, 'short'
   * only brings the stones out of the drawers. Resolves when the stones are down and the hands are
   * coming; null if there is nothing to wait for.
   */
  unpack(mode: Unpacking): Promise<void> | null {
    const opening = this.opening.start(mode);
    this.casework?.apply(this.opening.pose);
    this.shadowFrames = 4;
    if (!opening) {
      this.showHands();
      return null;
    }
    return opening.then(() => this.showHands());
  }

  /** Note where the stones stand before the position is replaced, so that the next opening puts them back in the drawers first. */
  remember(): void {
    this.opening.remember();
  }

  /** Finish the opening under way at once, if there is one. */
  finishUnpack(): void {
    this.opening.finish();
    this.casework?.apply(this.opening.pose);
    this.shadowFrames = 4;
  }

  /** Bring the hands in, if they were kept out while the case opened. */
  private showHands(): void {
    if (!this.stage || this.stage.root.visible) return;
    this.stage.root.visible = true;
    this.stage.appear();
  }

  /** What the room does as the case opens. */
  private cues(): Opening['cues'] {
    const front = new Vector3(0, -0.2, -4.9);
    return {
      clasp: () => this.sound?.clasp(front),
      swing: (seconds) => this.sound?.lidSwing({ x: 0, y: 1.6, z: -1.2 }, seconds),
      lands: (strength) => {
        this.sound?.lidLands({ x: 0, y: -0.5, z: 2.6 }, strength);
        this.onThud?.(0.9 * strength);
        if (strength < 0.5 || !this.fx) return;
        // The squares take the blow, and dust comes up where the lid meets the altar.
        this.fx.ripple(new Vector3(0, 0, 0.5), 0.8);
        for (const x of [-3.6, -1.2, 1.2, 3.6]) this.fx.crumble(new Vector3(x, -0.95, 4.9), 0.35);
      },
      drawer: (name) => this.sound?.drawer({ x: name.endsWith('_e') ? 5 : -5, y: -0.6, z: name.startsWith('lid') ? 2.3 : -2.3 }),
      knock: (at, pale, weight) => this.sound?.stoneSet(at, pale, weight),
      hands: () => this.showHands(),
    };
  }

  /** Show a move that the rules core has already applied. Resolves when it has been played out. */
  async playMove(e: MoveEvent): Promise<void> {
    const director = this.director;
    if (this.stage) {
      await this.stage.playMove(e, (part, beat) => director?.beat(e, part, beat));
      return;
    }
    // Without hands the pieces move themselves; the room still answers at the start and the end.
    director?.beat(e, 'mover', 'reach');
    director?.beat(e, 'mover', 'lift');
    if (e.captured) director?.beat(e, 'victim', 'close');
    await this.pieces.playMove(e);
    director?.beat(e, 'mover', 'set');
  }

  /** Show a take-back that the rules core has already applied. `status` is the position it returns to. */
  async playUndo(e: MoveEvent, status: Status): Promise<void> {
    // A square still breaking up is whole by the time the stone is back on it.
    this.fx?.mend();
    await (this.stage ? this.stage.playUndo(e) : this.pieces.playUndo(e));
    this.director?.undone(status);
  }

  /** The player to move has turned to a piece (`chosen` once they have picked it), or away. */
  thought(square: Square | null, chosen: boolean): void {
    this.director?.thought(square, chosen);
  }

  /** The engine is being asked about this move; the room waits for the answer before the pieces react to it. */
  expectVerdict(e: MoveEvent): void {
    this.director?.expect(e);
  }

  /** What the engine made of a move, or null if it could not say. */
  appraise(e: MoveEvent, kind: VerdictKind | null): void {
    this.director?.appraise(e, kind);
  }

  /** Whether the room answers the moves to come only with what both players can see on the board (an online game being played). */
  setPlain(plain: boolean): void {
    this.plain = plain;
    this.director?.setPlain(plain);
    this.stage?.setPlain(plain);
  }

  /** Whether the game being played is a lesson: the hands keep to the plainest of manners in one. */
  setLesson(lesson: boolean): void {
    this.lesson = lesson;
    this.stage?.setLesson(lesson);
  }

  /** Whether the game being played is against a clock: the hands then keep the other player waiting on no move. */
  setTimed(timed: boolean): void {
    this.timed = timed;
    this.stage?.setTimed(timed);
  }

  /** Resolves once the hands have done with the moves made so far (what they do after a stone is down), or after a few seconds. */
  settled(): Promise<void> {
    return this.stage?.settled() ?? Promise.resolve();
  }

  /**
   * A draw has been offered by `side`, and the hands show it; or (null) the offer there was is over:
   * `refused` by the other player, or `withdrawn` by the one who made it. One that is taken ends
   * the game, and the hands shake on it.
   */
  setOffer(side: Side | null, how: 'refused' | 'withdrawn' = 'withdrawn'): void {
    this.stage?.offer(side, how);
  }

  /** How a server ended the game, if one did and not a player: said before the room is told that the game is over. */
  setEnded(ended: 'time' | 'left' | 'noshow' | null): void {
    this.director?.setEnded(ended);
  }

  /**
   * What the hands' manners draw their chances from, from the next game on (manners.ts): the same
   * for everyone at the same board, so that they all see the same thing. Null for a game that is
   * only on this screen.
   */
  setHandSeed(seed: string | null): void {
    this.handSeed = seed;
    this.stage?.setSeed(seed);
  }

  /** Stand the pieces taken so far on the ledges, for a game joined part of the way through. */
  seatTaken(history: MoveEvent[]): void {
    this.stage?.seatTaken(history);
  }

  /**
   * A new position has been set up: the room forgets the last game. `happened` is for a game
   * given up or agreed drawn this moment, which the room answers; a position that is only being
   * stood again is shown as it was left, without the answer.
   */
  resetLife(status: Status, happened = false): void {
    this.director?.reset(status, happened);
  }

  /** Change the room's state of light. It eases there over a few seconds. */
  setMood(mood: Mood): void {
    this.chapel?.setMood(mood);
    GRADES[mood].forEach((goal, i) => (this.grade[i]!.goal = goal));
  }

  /** A player turns their thought to a square (their hand goes to hover over it), or away from the board. */
  consider(side: Side, square: Square | null): void {
    this.stage?.consider(side, square);
  }

  /** Whose turn it is, for the hands' bearing. Null when the game is over. */
  setTurn(side: Side | null): void {
    this.stage?.setTurn(side);
  }

  /** Send the hands back to rest and clear the ledges, for a new game. */
  resetHands(): void {
    this.stage?.reset();
  }

  /** Ask for the shadows to be redrawn, after something that casts them has changed. */
  refreshShadows(): void {
    this.shadowFrames = 4;
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    if (this.fx) this.fx.thin = quality === 'low';
    if (this.chapel) {
      const key = this.chapel.key;
      key.shadow.mapSize.setScalar(QUALITY[quality].shadow);
      key.shadow.map?.dispose();
      key.shadow.map = null;
      this.chapel.setQuality(quality);
    }
    if (this.post) {
      this.post.dispose();
      this.post = new Post(this.renderer, this.scene, this.camera, quality);
      this.post.setSmooth(this.smooth);
    }
    this.shadowFrames = 4;
    this.resize(true);
  }

  /**
   * Draw the picture at this size against what the quality setting asks for (1 is all of it), the
   * browser stretching it to the window. For a machine the chosen quality is too much for: see `Governor`.
   */
  setRenderScale(scale: number, smooth = true): void {
    if (scale === this.scale && smooth === this.smooth) return;
    this.scale = scale;
    this.smooth = smooth;
    this.chapel?.ease(scale < 1);
    this.post?.setSmooth(smooth);
    this.resize(true);
  }

  get renderScale(): number {
    return this.scale;
  }

  private steps: { key: string; steps: Step[] } = { key: '', steps: [] };

  /** The governor's steps that change anything at this quality and size (see `governorSteps`). The same list while neither changes. */
  governorSteps(): readonly Step[] {
    // A canvas with no size draws nothing, and has no steps to tell apart: the last ones hold until it has room again.
    if (this.width === 0 || this.height === 0) return this.steps.steps.length ? this.steps.steps : STEPS;
    const dpr = window.devicePixelRatio || 1;
    const key = `${this.quality} ${this.width} ${this.height} ${dpr}`;
    if (key !== this.steps.key) this.steps = { key, steps: governorSteps(this.quality, this.width, this.height, dpr) };
    return this.steps.steps;
  }

  /** Match the drawing buffer to the canvas's displayed size. Returns true if it changed. */
  resize(force = false): boolean {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!force && w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    // A canvas with no size (a pane dragged shut, a page not yet laid out) has nothing to draw
    // into, and every buffer sized to it would be refused. They keep the size they had, and
    // nothing is drawn until there is room again.
    if (w === 0 || h === 0) return true;
    // The grey-box stands in for a moment while the room loads, and is drawn as it always was.
    const full = this.chapel ? drawingRatio(this.quality, w, h, window.devicePixelRatio || 1) : Math.min(window.devicePixelRatio || 1, 1.5);
    // Drawn smaller when the machine cannot keep up, but never so small that the stones lose their edges.
    const pixelRatio = governedRatio(full, this.scale, w, h);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h, pixelRatio);
    this.chapel?.setViewport(w * pixelRatio, h * pixelRatio);
    this.stage?.setViewportHeight(h * pixelRatio);
    this.stage?.setQuality(this.quality);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.applyInset(true);
    return true;
  }

  /**
   * The square under a point given in client coordinates. A piece's whole
   * body counts as its square, so tall pieces can be clicked from low cameras;
   * where no piece is drawn, it is the square of the board that shows there.
   *
   * `reach` is for a stone being carried: the squares it may be set down on. A stone that only
   * stands in front of one of them does not then hide it: the board behind is what is meant.
   */
  pick(clientX: number, clientY: number, reach?: ReadonlySet<Square>): Square | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const piece = this.pieces.pick(this.raycaster);
    if (piece && !reach) return piece;
    const p = this.raycaster.ray.intersectPlane(this.surface, this.hit);
    const ground = p ? squareAt(p.x, p.z) : null;
    if (piece && reach && !reach.has(piece) && ground && reach.has(ground)) return ground;
    return piece ?? ground;
  }

  /** Advance scene-owned animation and draw one frame. */
  render(dt: number, time: number): void {
    const [left, right, below, above] = this.clearance();
    this.inset.goal = left;
    this.insetRight.goal = right;
    this.insetBottom.goal = below;
    this.insetTop.goal = above;
    this.inset.step(dt, 4.5);
    this.insetRight.step(dt, 4.5);
    // A player who has asked for less motion has the board framed at once, not glided into place.
    if (this.stillness()) {
      this.insetBottom.snap(below);
      this.insetTop.snap(above);
    } else {
      this.insetBottom.step(dt, 4.5);
      this.insetTop.step(dt, 4.5);
    }
    this.applyInset();
    // The pieces only move under a tween or while the case opens, so that is when the shadow map is stale.
    this.opening.update(dt);
    if (this.casework?.apply(this.opening.pose)) this.shadowFrames = 3;
    if (this.tweens.busy || this.opening.running) this.shadowFrames = 3;
    this.renderer.shadowMap.needsUpdate = this.shadowFrames > 0;
    if (this.shadowFrames > 0) this.shadowFrames--;
    this.tweens.update(dt);
    this.stage?.update(dt, time);
    if (this.stage) this.pieces.watch = this.stage.attention();
    this.fx?.update(dt, time);
    this.director?.update(dt);
    this.pieces.update(time, dt);
    this.labels.update(dt, this.pieces.standing(), this.camera.position);
    this.markers.update(dt, time);
    this.board?.update(time);
    this.chapel?.update(time, dt);
    for (const s of this.grade) s.step(dt, 1.1);
    const [vignette, r, g, b, fill, contrast] = this.grade.map((s) => s.value) as [number, number, number, number, number, number];
    if (this.fill) this.fill.intensity = fill;
    if (this.chapel) this.scene.environmentIntensity = this.chapel.ambient;
    this.sound?.listen(this.camera.position, this.camera.getWorldDirection(this.forward), this.camera.up);
    // The game goes on in a canvas with no size; it is only not drawn.
    if (this.width === 0 || this.height === 0) return;
    // The view behind the menu turns about the middle of the board, but the shut case lies on
    // Void's half: while it is shut the view is carried over by as much, so that the case is what
    // it is framed on, and it comes back as the lid swings open. Only for the drawing.
    const shut = MathUtils.smoothstep(this.opening.pose.lid, 1.2, Math.PI - 0.05);
    if (this.chapel) this.chapel.materials.caseShut.value = MathUtils.smoothstep(this.opening.pose.lid, 2.6, Math.PI);
    const carried = SHUT_MIDDLE * shut;
    const fov = this.camera.fov;
    if (shut !== 0) {
      this.camera.position.z += carried;
      this.camera.updateMatrixWorld();
    }
    this.focusLens(dt);
    const upright = this.width < 900 && this.height > this.width;
    if (shut !== 0) {
      // After the lens has found the case, which the tipped view no longer looks straight at.
      this.held.copy(this.camera.quaternion);
      if (upright) {
        this.camera.setViewOffset(this.width, this.height, 0, SHUT_RAISED * shut * this.height, this.width, this.height);
      } else {
        this.camera.rotateX(SHUT_TIP * shut);
        this.camera.fov = fov + SHUT_WIDER * shut;
        this.camera.updateProjectionMatrix();
      }
      this.camera.updateMatrixWorld();
    }
    if (this.post) {
      if (this.chapel) {
        this.chapel.prepare(this.renderer, this.scene, this.camera, this.unmirrored);
        this.post.setShaft(this.chapel.shaft);
      }
      this.post.setGrade(vignette, r, g, b, contrast);
      this.post.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    if (shut !== 0) {
      this.camera.position.z -= carried;
      this.camera.quaternion.copy(this.held);
      this.camera.fov = fov;
      if (upright) this.applyInset(true);
      else this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
    }
  }

  /** Two faint lights from behind each player, so dark stone keeps an edge against a dark room. */
  private rims(intensity: number): DirectionalLight[] {
    return [-1, 1].map((z) => {
      const rim = new DirectionalLight(z < 0 ? 0x9fd8cf : 0xd9c9a3, intensity);
      rim.position.set(-4 * z, 5, 14 * z);
      return rim;
    });
  }
}
