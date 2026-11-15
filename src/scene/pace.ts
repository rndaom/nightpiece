/**
 * Keeps the picture smooth at a quality the machine cannot quite draw, by drawing it smaller and
 * letting the browser stretch it to the window. Most of what a frame costs on weak graphics is
 * paid per pixel (the anti-aliased buffer, the mirror, the lit air, bloom, depth of field), so a
 * picture three quarters the size across costs little more than half as much, and every effect
 * the player asked for is still there.
 *
 * What it watches is how many frames miss the screen's refresh. A screen shows a new picture
 * only when it refreshes, so a frame that costs a little more than one refresh is shown for two:
 * frame times come in whole refreshes, a mean of them hides which, and what the eye sees as a
 * stutter is the share of frames shown late. That share is counted over some seconds, against
 * the refresh the frames themselves show the screen to have (sixty a second is only the first guess).
 *
 * Too many late frames, and the picture is drawn smaller, by as many steps as the lateness shows
 * are needed at the least, and on down until few are late. If even the least size leaves frames
 * late, the size rests at the largest that ran as well as it; if that is where it began (a screen
 * that refreshes thirty times a second, a machine held back by something other than its
 * graphics), drawing smaller is left alone for a long while. A larger size is tried again only
 * after minutes, and after longer each time it has not held, since nothing in frames that are on
 * time says how much room there is. A long frame the load does not explain (memory collected, a
 * shader built, the tab brought back) is let pass.
 */

/**
 * The steps down. `scale` is the size the picture is drawn at against the size the quality
 * setting asks for. `smooth` is whether edges are still anti-aliased: on integrated graphics
 * that is about half of what a frame costs at High, and a picture that is being stretched to
 * the window has its edges softened by the stretching, so it goes before the last of the size does.
 */
export type Step = { scale: number; smooth: boolean };

export const STEPS: readonly Step[] = [
  { scale: 1, smooth: true },
  { scale: 0.85, smooth: true },
  { scale: 0.72, smooth: true },
  { scale: 0.72, smooth: false },
  { scale: 0.6, smooth: false },
  { scale: 0.5, smooth: false },
];

/** The refresh rates screens are made with, slowest first: the screen's is taken to be one of these. */
const RATES = [50, 60, 75, 90, 100, 120, 144, 165, 240];

/** How long, in seconds, frames are not counted after the start, a change of quality or a new list of steps. */
const GRACE = 2;
/** How long, in seconds, a new size is drawn before its frames are counted: the change itself costs a frame or two. */
const SETTLE = 0.75;
/** How long, in seconds, frames are gathered to find the screen's refresh from. */
const SAMPLE = 2;
/** Frames are tallied in spans this long; the watch runs over the last few of them. */
const SPAN = 0.5;
/** Over how many seconds the share of late frames is watched while the size stays as it is. */
const WATCH = 8;
/** Over how many seconds a burst of late frames is caught sooner. */
const BURST = 1.5;
/** A size this many seconds old is judged, if its frames are plainly too late; or else after FINE. */
const JUDGE = 1;
const FINE = 3;
/** More late frames than this share over the watch, and the picture is drawn smaller. */
const LATE = 0.04;
/** This share late over a burst, or after a new size is first judged, is plainly too many. */
const MANY = 0.3;
/** A larger size holds if no more than this share of its frames is late. */
const FEW = 0.025;
/** A larger size is tried only from one where no more than this share of frames has been late. */
const NONE = 0.01;
/** How long, in seconds, a size is kept before a larger one is tried at all. */
const CALM = 60;
/** How long, in seconds, after a size proved too much it is tried again, and the most that wait grows to. */
const WAIT = 360;
const MOST_WAIT = 1440;
/** A size that has held this many seconds is tried as readily as the first time, should it ever fail. */
const HOLD = 180;
/** How long, in seconds, after drawing smaller bought nothing it is tried again, and the most that grows to. */
const FUTILE = 600;
const MOST_FUTILE = 2400;

/** Frames tallied over one span: how many, how many were late, and how many refreshes they took in all. */
type Tally = { at: number; frames: number; late: number; beats: number };

/** How frames ran at a size on the way down. */
type Reading = { level: number; late: number; beats: number };

/** Whether frames ran about as well in one reading as in another. */
const asGood = (a: Reading, b: Reading) => a.beats <= b.beats * 1.03 + 0.01 && a.late <= b.late + 0.03;

/** What it costs to draw a step, against full size: its pixels, and less again for no smoothing. */
const weight = (step: Step) => step.scale * step.scale * (step.smooth ? 1 : 0.75);

/**
 * The screen's refresh interval in milliseconds, as frame times show it. Frame times cluster at
 * whole refreshes; if every cluster of the short ones lies on a multiple of `beat` it stands. If
 * not, the refresh is the slowest of the screens made whose multiples they all lie on; and if
 * none fits (a screen that waits for each frame), the quickest cluster, or sixty a second if that
 * is quicker still. What frames cannot show is a refresh quicker than every one of them: a machine
 * that takes two refreshes of a screen at a hundred and twenty for every frame looks the same as
 * one that keeps up with a screen at sixty, and is left at an even sixty. Nor can a screen slower
 * than fifty a second be told from a machine that takes two refreshes a frame: drawing smaller
 * finds that out (see `Governor`).
 */
export function refreshOf(frames: readonly number[], beat: number): number {
  const sorted = [...frames].sort((a, b) => a - b);
  const clusters: number[] = [];
  let from = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i]! <= sorted[from]! * 1.08 + 1.2) continue;
    // A cluster of a few frames only is chance; the longer ones say little of the refresh.
    if (i - from >= Math.max(3, sorted.length * 0.03)) {
      let sum = 0;
      for (let j = from; j < i; j++) sum += sorted[j]!;
      const mean = sum / (i - from);
      if (mean <= beat * 4.4) clusters.push(mean);
    }
    from = i;
  }
  if (clusters.length === 0) return beat;
  const fits = (b: number) =>
    clusters.every((c) => {
      const k = Math.round(c / b);
      return k >= 1 && k <= 4 && Math.abs(c - k * b) <= c * 0.03;
    });
  if (fits(beat)) return beat;
  for (const rate of RATES) if (fits(1000 / rate)) return 1000 / rate;
  return Math.min(clusters[0]!, 1000 / 60);
}

export class Governor {
  /**
   * The steps that, on this screen at this quality, each draw less than the one before (see
   * `governorSteps` in post.ts). One that would draw the same picture at the same cost (a quality
   * that has no smoothing of edges to give up, a size already at the least it may go to) is no
   * step: taken, it would buy nothing.
   */
  private steps: readonly Step[] = STEPS;
  private level = 0;
  /** Seconds of frames taken in. A tab in the background is not drawn, and stops this clock. */
  private clock = 0;
  /** The screen's refresh interval in milliseconds, and the frames being gathered to find it. */
  private beat = 1000 / 60;
  private sample: number[] = [];
  private sampled = 0;
  /** A frame's usual length, over the last few, to tell a single long frame from load. */
  private usual = 1000 / 60;
  /** Frames counted since `since`, in spans, the last few seconds of them. */
  private tallies: Tally[] = [];
  private since = GRACE;
  /** When the size last changed. */
  private changed = 0;
  /** Whether a step down, or a step up, is being judged; and each size tried on this way down. */
  private trying: 'down' | 'up' | null = null;
  private path: Reading[] = [];
  /** Whether frames are being counted afresh, to see if a share of late ones just over the line holds. */
  private doubt = false;
  /** For each step, when it may next be tried after proving too much, and how long the wait after that will be. */
  private retry: number[] = [];
  private wait: number[] = [];
  /** Until when drawing smaller is no use, and how long the next such spell is. */
  private futile = 0;
  private futileNext = FUTILE;

  /** The size to draw at: 1 is what the quality setting asks for. */
  get scale(): number {
    return this.steps[this.level]!.scale;
  }

  /** Whether edges are still to be anti-aliased. */
  get smooth(): boolean {
    return this.steps[this.level]!.smooth;
  }

  /** The screen's refresh interval in milliseconds, as found so far. */
  get refresh(): number {
    return this.beat;
  }

  /**
   * Go by these steps from now on (the first is full size). The size drawn at is kept where the
   * new steps have it, or else the nearest larger one is taken. What was learned of the old steps
   * is forgotten: a new list means a new size of window or a new quality, and new costs. Returns
   * true if the size to draw at has changed.
   */
  use(steps: readonly Step[]): boolean {
    if (steps === this.steps || steps.length === 0) return false;
    const { scale, smooth } = this.steps[this.level]!;
    let at = steps.findIndex((s) => s.scale === scale && s.smooth === smooth);
    if (at < 0) at = Math.max(0, steps.filter((s) => s.scale >= scale).length - 1);
    this.steps = steps;
    this.level = at;
    this.forget(GRACE);
    return this.scale !== scale || this.smooth !== smooth;
  }

  /** Begin again at full size, as after a change of quality. The screen's refresh is still what it was. */
  reset(): void {
    this.level = 0;
    this.forget(GRACE);
  }

  private forget(grace: number): void {
    this.tallies = [];
    this.since = this.clock + grace;
    this.trying = null;
    this.path = [];
    this.doubt = false;
    this.retry = [];
    this.wait = [];
    this.futile = 0;
    this.futileNext = FUTILE;
  }

  /** Take in one frame's length in milliseconds. Returns true if the size to draw at has changed. */
  feed(elapsed: number): boolean {
    if (!(elapsed > 0)) return false;
    this.clock += elapsed / 1000;
    // A frame far longer than the screen's refresh and than the frames just before it is a pause
    // (memory collected, a shader built, the tab brought back), not the load: it is let pass.
    const hitch = elapsed > Math.max(4 * this.beat, 3 * this.usual);
    this.usual += (elapsed - this.usual) * 0.1;
    if (hitch) return false;
    // The refresh is found from every frame, those not counted after a change among them.
    if (this.learn(elapsed) && this.clock >= this.since) {
      // Frames counted against the old refresh are counted again.
      this.tallies = [];
      this.since = this.clock;
      return false;
    }
    if (this.clock < this.since) return false;
    this.count(elapsed);
    const seen = this.clock - this.since;
    if (this.trying === 'down') return this.judgeDown(seen);
    if (this.trying === 'up') return this.judgeUp(seen);
    return this.watch();
  }

  /** Gather frames to find the screen's refresh from. Returns true if it is other than was thought. */
  private learn(elapsed: number): boolean {
    this.sample.push(elapsed);
    if (this.clock - this.sampled < SAMPLE || this.sample.length < 24) return false;
    const beat = refreshOf(this.sample, this.beat);
    this.sample = [];
    this.sampled = this.clock;
    if (Math.abs(beat - this.beat) <= this.beat * 0.03) return false;
    this.beat = beat;
    return true;
  }

  private count(elapsed: number): void {
    let last = this.tallies[this.tallies.length - 1];
    if (!last || this.clock - last.at >= SPAN) {
      last = { at: this.clock, frames: 0, late: 0, beats: 0 };
      this.tallies.push(last);
      if (this.tallies.length > WATCH / SPAN) this.tallies.shift();
    }
    const beats = elapsed / this.beat;
    last.frames++;
    last.beats += beats;
    // Shown at the refresh after the one it was meant for, or later.
    if (beats > 1.5) last.late++;
  }

  /** How frames ran over the last `seconds` counted: for how long, how many, the share late, and refreshes a frame. */
  private over(seconds: number): { seconds: number; frames: number; late: number; beats: number } {
    let frames = 0;
    let late = 0;
    let beats = 0;
    for (let i = this.tallies.length - 1; i >= 0; i--) {
      const t = this.tallies[i]!;
      if (t.at < this.clock - seconds) break;
      frames += t.frames;
      late += t.late;
      beats += t.beats;
    }
    return {
      seconds: Math.min(seconds, this.clock - this.since),
      frames,
      late: frames > 0 ? late / frames : 0,
      beats: frames > 0 ? beats / frames : 1,
    };
  }

  /** At a size that is not being judged: draw smaller if too many frames are late, or now and then try larger. */
  private watch(): boolean {
    const last = this.steps.length - 1;
    const now = this.over(WATCH);
    if (now.seconds < FINE || now.frames < 12) return false;
    const burst = this.over(BURST);
    const plainly = burst.seconds >= BURST && burst.frames >= 12 && burst.late >= MANY;
    // A share just over the line is caught at the moment it crosses, and so reads low: frames are
    // counted afresh over a whole watch first, which is what a smaller size is judged against.
    if (now.late > LATE && !plainly && !this.doubt) {
      this.doubt = true;
      this.tallies = [];
      this.since = this.clock;
      return false;
    }
    if (this.doubt && now.seconds >= WATCH - SPAN) this.doubt = false;
    if (now.late > LATE || plainly) {
      if (this.doubt && !plainly) return false;
      this.doubt = false;
      // What a smaller size is judged against: the burst, if that is what was plainly too late.
      const from = plainly && burst.late > now.late ? burst : now;
      if (this.futile > 0) {
        if (this.clock < this.futile) return false;
        // Drawing smaller is tried again, at the least size: one change there and, if it is still
        // no use, one back.
        this.futile = 0;
        if (this.level === last) return false;
        this.path = [{ level: this.level, late: from.late, beats: from.beats }];
        this.fail(this.level);
        this.trying = 'down';
        return this.go(last);
      }
      if (this.level === last) return false;
      this.path = [{ level: this.level, late: from.late, beats: from.beats }];
      return this.down(from.beats);
    }
    const held = this.clock - this.changed;
    // A size that has held a good while is tried as readily as the first time, should it fail again.
    if (held >= HOLD && (this.wait[this.level] ?? WAIT) > WAIT) this.wait[this.level] = WAIT;
    if (this.level > 0 && now.seconds >= WATCH - SPAN && now.late < NONE && held >= CALM && this.clock >= (this.retry[this.level - 1] ?? 0)) {
      this.trying = 'up';
      return this.go(this.level - 1);
    }
    return false;
  }

  /**
   * Step down from here by as many steps as frames this late show are needed at the least: a
   * frame that takes `beats` refreshes cost more than `beats - 1` of them, so a picture drawn
   * smooth must cost less by that much. This size proved too much, and the steps passed over
   * would surely be too much as well: each is waited on before it is tried again.
   */
  private down(beats: number): boolean {
    const last = this.steps.length - 1;
    const need = Math.max(1, (beats - 1) * 0.9);
    const most = weight(this.steps[this.level]!) / need;
    let to = this.level + 1;
    while (to < last && weight(this.steps[to]!) > most) to++;
    for (let i = this.level; i < to; i++) this.fail(i);
    this.trying = 'down';
    return this.go(to);
  }

  /**
   * Judge a step down. Few frames late: this is the size. Still too many: on down, whether or not
   * this step bought anything that shows, since frames that took two refreshes may take two still
   * at a size that costs much less, until the step that brings them under one. At the least size
   * frames are watched for longer, as what is made of them there decides where the size rests.
   */
  private judgeDown(seen: number): boolean {
    const last = this.steps.length - 1;
    const now = this.over(seen);
    if (seen < JUDGE || now.frames < 12) return false;
    const smooth = now.late <= LATE;
    if (seen < (smooth || now.late < MANY ? FINE : JUDGE)) return false;
    if (smooth) {
      this.trying = null;
      this.path = [];
      return false;
    }
    const reading = { level: this.level, late: now.late, beats: now.beats };
    if (this.level < last) {
      this.path.push(reading);
      return this.down(now.beats);
    }
    // Watched for longer, unless as plainly late as where the way began.
    if (seen < WATCH - SPAN && !(seen >= FINE && this.path[0]!.late >= MANY && asGood(this.path[0]!, reading))) return false;
    return this.rest(reading);
  }

  /**
   * The way down has reached the least size and frames are still late there. Rest at the
   * largest size on the way that ran as well. If that is where the way began, the cost is not in
   * the pixels (or the screen refreshes more slowly than was thought), and stepping down is left
   * alone a while; so it is from any size above the least that ran as well.
   */
  private rest(least: Reading): boolean {
    const best = this.path.find((r) => asGood(r, least)) ?? least;
    this.trying = null;
    this.path = [];
    if (best.level < this.steps.length - 1) {
      this.futile = this.clock + this.futileNext;
      this.futileNext = Math.min(MOST_FUTILE, this.futileNext * 2);
    }
    return this.go(best.level);
  }

  /** Judge a step up: back down at once if frames are plainly late, or after a few seconds if more than a few are. */
  private judgeUp(seen: number): boolean {
    const now = this.over(seen);
    const plainly = seen >= 1 && now.frames >= 12 && now.late >= MANY / 2;
    if (!plainly && (seen < FINE || now.frames < 12)) return false;
    this.trying = null;
    if (!plainly && now.late <= FEW) return false;
    this.fail(this.level);
    return this.go(this.level + 1);
  }

  /** This step proved too much: it is not tried again for a while, and for longer each time. */
  private fail(level: number): void {
    const wait = this.wait[level] ?? WAIT;
    this.retry[level] = this.clock + wait;
    this.wait[level] = Math.min(MOST_WAIT, wait * 2);
  }

  private go(level: number): boolean {
    const next = Math.max(0, Math.min(this.steps.length - 1, level));
    this.tallies = [];
    this.doubt = false;
    this.since = this.clock + SETTLE;
    if (next === this.level) return false;
    this.level = next;
    this.changed = this.clock;
    return true;
  }
}
