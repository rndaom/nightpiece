/**
 * Every sound in the game. All of it is recorded: stone knocked on stone, glasses struck,
 * tubular bells, a bowed double bass, an orchestra's strings and drums, paper and card. The
 * recordings are cut and layered by assets/src/sound/build.py (CREDITS.md says whose they
 * are); this plays them, and places them in the room.
 *
 * The room is a large concrete hall: a low bowed drone with a long, dark tail behind
 * everything. Stone is dense, short and dry, with limestone knocking a little higher than
 * basalt. Lit squares and threads are glass. The hands are air.
 *
 * Each sound has several takes, and no take is played twice running; each is played a shade
 * faster or slower and louder or softer than the last, so that no two moves sound alike.
 *
 * Sounds are placed in the room: each is given a point, and the listener follows the camera.
 * Three volumes (master, music, effects) are the player's.
 *
 * It works against any audio context, including an offline one, which is how it is checked
 * without speakers (tools/dev/hear.mjs).
 */
import type { Vector3 } from 'three';
import type { Bank, Take } from './bank';

export interface Volumes {
  master: number;
  music: number;
  effects: number;
}

type At = { x: number; y: number; z: number } | null;

/** A sound of the interface: card and paper. */
export type UiSound = 'hover' | 'press' | 'open' | 'close';

interface Playing {
  /** Louder or softer: 1 is as recorded. */
  gain?: number;
  /** Faster and higher, or slower and lower: 1 is as recorded. */
  rate?: number;
  /** When, in the audio clock's seconds. Now, if left out. */
  when?: number;
  /** How far the speed may stray either way, as a part of 1. */
  stray?: number;
}

/** How many of the glass tones there are, low to high: a pentatonic set, so that any run of them is consonant. */
const GLASS_STEPS = 8;

export class Sound {
  readonly ctx: BaseAudioContext;
  private master: GainNode;
  private music: GainNode;
  private effects: GainNode;
  /** The room's own sound passes through here, and is turned down a little while a set piece is heard. */
  private bed: GainNode;
  /** Where placed sounds arrive, ahead of the player's effects volume: brings them up to the level of the room. */
  private placed: GainNode;
  private reverb: ConvolverNode;
  private bank: Bank | null = null;
  private room: { tension: GainNode } | null = null;
  private roomWanted = false;
  private heart: { timer: number; on: boolean } = { timer: 0, on: false };
  /** The take of each sound that was played last, so that the next is another. */
  private last = new Map<string, number>();
  private seed = 0x9e3779b9;

  constructor(ctx: BaseAudioContext, volumes: Volumes, bank: Bank | null = null) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.music = ctx.createGain();
    this.effects = ctx.createGain();
    this.bed = ctx.createGain();
    // The last thing before the speakers: holds a pile-up of effects under the ceiling, and
    // leaves a single stone alone.
    const guard = ctx.createDynamicsCompressor();
    guard.threshold.value = -9;
    guard.knee.value = 6;
    guard.ratio.value = 10;
    guard.attack.value = 0.002;
    guard.release.value = 0.16;
    this.placed = ctx.createGain();
    this.placed.gain.value = 1.5;
    this.placed.connect(this.effects);
    this.bed.connect(this.music);
    this.music.connect(this.master);
    this.effects.connect(this.master);
    this.master.connect(guard).connect(ctx.destination);
    this.setVolumes(volumes);

    this.reverb = ctx.createConvolver();
    this.reverb.normalize = false;
    const tail = ctx.createGain();
    tail.gain.value = 0.55;
    this.reverb.connect(tail).connect(this.effects);
    if (bank) this.use(bank);
  }

  /** Give it the recordings. Until then nothing is heard; a room asked for earlier starts now. */
  use(bank: Bank): void {
    this.bank = bank;
    if (bank.hall) {
      try {
        this.reverb.buffer = bank.hall;
      } catch (error) {
        console.warn('The room has no echo: its recording could not be used.', error);
      }
    }
    if (this.roomWanted) this.startRoom();
  }

  setVolumes(v: Volumes): void {
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(v.master, t, 0.05);
    this.music.gain.setTargetAtTime(v.music, t, 0.05);
    this.effects.gain.setTargetAtTime(v.effects, t, 0.05);
  }

  /** Put the listener where the camera is, facing the way it faces. */
  listen(position: Vector3, forward: Vector3, up: Vector3): void {
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(position.x, t, 0.05);
      l.positionY.setTargetAtTime(position.y, t, 0.05);
      l.positionZ.setTargetAtTime(position.z, t, 0.05);
      l.forwardX.setTargetAtTime(forward.x, t, 0.05);
      l.forwardY.setTargetAtTime(forward.y, t, 0.05);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.05);
      l.upX.setTargetAtTime(up.x, t, 0.05);
      l.upY.setTargetAtTime(up.y, t, 0.05);
      l.upZ.setTargetAtTime(up.z, t, 0.05);
    }
  }

  // -- the room -----------------------------------------------------------------

  /**
   * Start the room's own sound: the air of a large stone hall, a double bass bowed low with
   * glasses coming and going over it, and strings that shiver when the position sharpens.
   * Safe to call twice, and before the recordings have arrived.
   */
  startRoom(): void {
    if (this.room) return;
    if (!this.bank) {
      this.roomWanted = true;
      return;
    }
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.gain.setTargetAtTime(1, t, 2.5);
    out.connect(this.bed);

    this.loop('air', out, 0.16, 0);
    this.loop('calm', out, 0.28, 7);
    // Silent until called for.
    const tension = ctx.createGain();
    tension.gain.value = 0;
    tension.connect(out);
    this.loop('tense', tension, 1, 3);

    this.room = { tension };
  }

  /** 0 for a quiet position to 1 for a king in check: brings the uneasy layer up or down over a few seconds. */
  setTension(level: number): void {
    this.room?.tension.gain.setTargetAtTime(level * 0.4, this.ctx.currentTime, 1.2);
  }

  /** A heartbeat under the room while a king is in check. Call `update` each frame to keep it going. */
  setHeartbeat(on: boolean): void {
    this.heart.on = on;
    if (!on) this.heart.timer = 0;
  }

  update(dt: number): void {
    if (!this.heart.on || !this.room) return;
    this.heart.timer -= dt;
    if (this.heart.timer > 0) return;
    this.heart.timer = 0.92;
    this.play('heart', this.music, { gain: 0.4, stray: 0.02 });
  }

  // -- stone --------------------------------------------------------------------

  /** A piece is set down. Limestone (`pale`) knocks a little higher than basalt; `weight` runs 0.5 (a pawn) to 1.5 (a king). */
  stoneSet(at: At, pale: boolean, weight = 1): void {
    const size = weight < 0.75 ? 'light' : weight < 1.2 ? 'mid' : 'heavy';
    // The recordings are already as much louder as they are heavier; this only leans on it.
    const level = 0.85 + 0.15 * Math.min(1, Math.max(0, weight - 0.5));
    this.play(`set.${pale ? 'pale' : 'dark'}.${size}`, this.place(at, 0.5), { gain: level, stray: 0.03 });
  }

  /** A piece leaves the board: a short dry scrape. */
  stoneLift(at: At, pale: boolean): void {
    this.play(`lift.${pale ? 'pale' : 'dark'}`, this.place(at, 0.3), { gain: 0.26, stray: 0.05 });
  }

  /** Fingers close on a stone: skin on stone, barely there. */
  touch(at: At): void {
    this.play('touch', this.place(at, 0.2), { gain: 0.17, stray: 0.06 });
  }

  /** A piece is taken: a crack, then pieces of it settling. */
  crack(at: At): void {
    this.play('crack', this.place(at, 0.6), { gain: 0.78, stray: 0.04 });
  }

  /**
   * Stone splitting along a line: dry snaps that run from one end to the other, over the slab
   * giving way under them. For a crack toward a king in check; `weight` above 1 is the deeper
   * break of a mate.
   */
  fracture(from: At, to: At, seconds = 0.35, weight = 1): void {
    const t = this.ctx.currentTime;
    const ends = [this.place(from, 0.45), this.place(to, 0.45)] as const;
    const snaps = Math.round(6 + 4 * weight);
    const low = 1 / Math.sqrt(weight);
    for (let i = 0; i < snaps; i++) {
      const k = i / (snaps - 1);
      // Uneven, as a crack runs: quick, a catch, quick again. It is heard where it has got to.
      const when = t + seconds * Math.min(1, Math.max(0, k + (0.42 / snaps) * Math.sin(i * 12.9898)));
      this.play('snap', ends[k < 0.5 ? 0 : 1], { when, gain: (0.3 + 0.3 * k) * Math.sqrt(weight), rate: low * (1.12 - 0.3 * k), stray: 0.08 });
    }
    // The slab giving: a low grind that falls away once the crack has arrived.
    this.play('grind', ends[1], { when: t, gain: 0.42 * weight, rate: low * (0.35 / seconds) ** 0.35, stray: 0.04 });
  }

  // -- the case -------------------------------------------------------------------
  //
  // The case's own sounds (case.*) are made from the nearest recordings there are: a watch's tick
  // for its brass catch, a church door for its lid, something dragged over wood for a drawer.

  /** The hasp lets go of the lid: the catch clicks, and the brass drops against its plate. */
  clasp(at: At): void {
    const t = this.ctx.currentTime;
    this.play('case.latch', this.place(at, 0.4), { gain: 1.2, stray: 0.03 });
    this.play('clack', this.place(at, 0.4), { when: t + 0.3, gain: 0.35, rate: 1.3, stray: 0.05 });
  }

  /** The lid goes over: air moved by something wide, over about `seconds`. */
  lidSwing(at: At, seconds: number): void {
    this.play('whoosh.long', this.place(at, 0.4), { gain: 0.5, rate: 0.8 / Math.max(0.5, seconds), stray: 0.03 });
  }

  /** The lid comes down on the altar: a deep wooden knock with the brass in it. `strength` 1 for the first, less for each bounce. */
  lidLands(at: At, strength: number): void {
    const t = this.ctx.currentTime;
    this.play('case.lid', this.place(at, 0.7), { gain: strength, rate: strength < 0.5 ? 1.12 : 1, stray: 0.02 });
    if (strength > 0.5) this.play('clack', this.place(at, 0.5), { when: t + 0.025, gain: 0.25, rate: 0.75, stray: 0.05 });
  }

  /** A drawer slides out: wood drawn over wood. */
  drawer(at: At): void {
    this.play('case.drawer', this.place(at, 0.35), { gain: 0.7, stray: 0.05 });
  }

  // -- glass --------------------------------------------------------------------

  /** One struck glass. `step` picks its pitch, low to high. */
  glass(at: At, step: number, level = 0.22): void {
    const s = Math.max(0, Math.min(GLASS_STEPS - 1, Math.round(step)));
    this.play(`glass.${s}`, this.place(at, 0.55), { gain: level * 2.2, stray: 0.004 });
  }

  /** A piece is chosen: a hand's breath, and two glasses touched. */
  select(at: At): void {
    this.play('select', this.place(at, 0.5), { gain: 0.5, stray: 0.01 });
  }

  /** A strong move: a harp runs up, and glasses open over it. */
  lift(at: At): void {
    this.moment('rise', at, 0.7, 0.7, 2.4);
  }

  /** A blunder: a bowed bass note that sinks. */
  fall(at: At): void {
    this.moment('fall', at, 0.6, 0.62, 1.4);
  }

  /** A glass prism closes: a pin. */
  seal(at: At): void {
    this.play('seal', this.place(at, 0.6), { gain: 0.88, stray: 0.01 });
  }

  // -- air ----------------------------------------------------------------------

  /** A hand moves through the air: a breath that rises and falls over about `seconds`. */
  whoosh(at: At, seconds = 0.6, level = 0.3): void {
    // The recordings are 0.5 and 0.8 seconds long, and are played a little faster or slower to fit.
    const long = seconds > 0.6;
    this.play(long ? 'whoosh.long' : 'whoosh.short', this.place(at, 0.25), { gain: level * 1.6, rate: (long ? 0.8 : 0.5) / seconds, stray: 0.06 });
  }

  // -- moments ------------------------------------------------------------------

  /** Two notes struck hard by low strings: a fork. */
  stab(at: At): void {
    this.moment('fork', at, 0.6, 0.92, 0.8);
  }

  /** A cymbal's breath drawn backwards into a low stroke: a discovered attack. */
  reveal(at: At): void {
    this.moment('reveal', at, 0.6, 0.86, 1.0);
  }

  /** A low bell: a sacrifice. */
  bell(at: At): void {
    this.moment('bell', at, 0.8, 0.82, 3.0);
  }

  /** Check: two bell notes, the second lower, over a drum and a string that shivers. */
  stinger(at: At): void {
    this.moment('check', at, 0.7, 0.8, 2.4);
  }

  /** Mate: the room is struck; strings gather, hold, and collapse into silence as the board's plates go over. */
  choir(): void {
    this.moment('mate', null, 0.9, 0.95, 5.0);
  }

  /** The clock in the room, for a player who is taking their time. */
  tick(): void {
    this.play('tick', this.place(null, 0.4), { gain: 0.31, stray: 0.01 });
  }

  // -- the interface -------------------------------------------------------------

  /** The interface is card and paper, and sounds like it. Heard close, not in the room. */
  ui(kind: UiSound): void {
    const level = kind === 'hover' ? 0.36 : kind === 'press' ? 0.58 : 0.46;
    this.play(`ui.${kind}`, this.effects, { gain: level, stray: 0.05 });
  }

  // -- building blocks ----------------------------------------------------------

  /**
   * Where a sound comes out: at a point in the room, or (with null) everywhere. `send` is how
   * much of it also goes into the hall.
   */
  private place(at: At, send: number): AudioNode {
    const input = this.ctx.createGain();
    let out: AudioNode = input;
    if (at) {
      const p = this.ctx.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = 9;
      p.rolloffFactor = 0.7;
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = at.z;
      input.connect(p);
      out = p;
    }
    out.connect(this.placed);
    const wet = this.ctx.createGain();
    wet.gain.value = send;
    out.connect(wet).connect(this.reverb);
    return input;
  }

  /** A set piece: played whole, and the room's own sound stands back a little while it lasts. */
  private moment(name: string, at: At, send: number, gain: number, seconds: number): void {
    this.play(name, this.place(at, send), { gain });
    const t = this.ctx.currentTime;
    this.bed.gain.cancelScheduledValues(t);
    this.bed.gain.setTargetAtTime(0.55, t, 0.08);
    this.bed.gain.setTargetAtTime(1, t + seconds, 0.9);
  }

  /**
   * Play one take of a sound into `out`. Which take is left to chance, except that it is never
   * the one played last. Nothing is heard if the recordings have not arrived or the sound is
   * not among them.
   */
  private play(name: string, out: AudioNode, o: Playing = {}): void {
    const takes = this.bank?.clips[name];
    if (!takes || takes.length === 0) return;
    const take = takes[this.pick(name, takes.length)]!;
    const src = this.ctx.createBufferSource();
    src.buffer = take.buffer;
    const stray = o.stray ?? 0;
    src.playbackRate.value = (o.rate ?? 1) * (1 + stray * (this.chance() * 2 - 1));
    const g = this.ctx.createGain();
    // Half as far in loudness as in speed, and never louder than asked.
    g.gain.value = (o.gain ?? 1) * (1 - stray * 2 * this.chance());
    src.connect(g).connect(out);
    src.start(o.when ?? this.ctx.currentTime, take.start, take.length);
  }

  /** One of the room's loops, going round for good. `into` seconds of it are skipped, so the loops do not all begin at their beginnings. */
  private loop(name: string, out: AudioNode, gain: number, into: number): void {
    const bed: Take | undefined = this.bank?.beds[name];
    if (!bed) return;
    const src = this.ctx.createBufferSource();
    src.buffer = bed.buffer;
    src.loop = true;
    src.loopStart = bed.start;
    src.loopEnd = bed.start + bed.length;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(out);
    src.start(this.ctx.currentTime, bed.start + (into % bed.length));
  }

  private pick(name: string, count: number): number {
    if (count === 1) return 0;
    const before = this.last.get(name) ?? -1;
    let i = Math.floor(this.chance() * (before < 0 ? count : count - 1));
    if (before >= 0 && i >= before) i++;
    this.last.set(name, i);
    return i;
  }

  /** A number from 0 up to 1. Its own sequence, so that a sound rendered twice comes out the same. */
  private chance(): number {
    let x = (this.seed += 0x6d2b79f5);
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }
}
