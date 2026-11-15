/**
 * Development only. The capture rig for the promotional film: it drives the dev build in
 * headless Chromium (through tools/dev/look.mjs), takes the camera and the lens away from the
 * game for the length of a shot, and saves the shot as a run of frames with motion blur.
 * Nothing opens on screen. The shots themselves are in shots.mjs; this file is only the rig.
 *
 * How a frame is made. Time is stepped. A frame at 60 a second is 1/60 s long and the shutter is
 * open for half of it (180 degrees). The open half is drawn many times (sixteen, and more in a
 * frame where something crosses the picture fast), the game stepped a little between each, and
 * the pictures are averaged in linear light, before the game's own grade
 * (vignette, contrast, tone mapping, the sRGB transfer, grain) is applied once to the average.
 * Each of those pictures is also drawn a fraction of a pixel aside and its depth of field
 * gathered at a different turn, so the average is finer than any one of them. The other half of
 * the frame is stepped without being drawn.
 *
 * Everything is done from outside, in the page: nothing in src/ is changed. What is patched, on
 * the objects the dev handle (window.__nightpiece) gives, is listed at `install` below.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../dev/look.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../..');

/** Picture sizes, in real pixels. */
const SIZES = {
  '4k': [3840, 2160],
  '1440p': [2560, 1440],
  '1080p': [1920, 1080],
  '540p': [960, 540],
};
/**
 * The page's size in its own (CSS) pixels, unless a shot says otherwise (`layout`). The picture is this
 * page drawn with as many real pixels to each of its own as the size asked for needs: two for 4k, a half
 * for a 540p draft. So the interface is laid out the same at every size, and a draft is the final, small.
 */
const LAYOUT = [1920, 1080];

/**
 * Read the command line. Every shot script takes the same options:
 *
 *   --url http://127.0.0.1:5173/   the dev server to film
 *   --out tmp/promo/shots          where the shots go (a folder each)
 *   --size 4k|1440p|1080p|540p     the picture's size (4k)
 *   --sub 16                       pictures averaged for each frame, at the least
 *   --most 384                     and at the most: a frame in which something crosses the picture fast is given more,
 *   --apart 1                      enough that the fastest thing moves about this many pixels from one picture to the next
 *   --shutter 180                  degrees of each frame the shutter is open
 *   --fps 60
 *   --draft                        quick look: 540p (or the --size given), 3 pictures a frame, JPEG, under <out>/_draft
 *   --every 6                      save only every sixth frame (the game is still stepped through all of them)
 *   --stills 1.2,2.5               save only the frames at these seconds of the scene
 *   --window 0.5,3                 film this part of the scene instead of the shot's own
 *   --frames 56,155                save only these frames of the shot, the first and the last, numbered as the whole shot numbers them
 *   --drawn 42                     draw the frames from this one on, though only those of --frames are saved: as a take that began there drew them
 *   --clock 2.35                   the game's own clock, in seconds, at the moment it is held. The resting hands' drift, the flames, the dust
 *                                  and the light go by it, and it has run for however long the page took to load: so two takes of a shot
 *                                  differ in those unless they are given the same. A take's record says what its own was (`clock`).
 *   --aged 12                      how many sixtieths of a second the hands have been in the room at that moment: when each next shifts a
 *                                  finger and when a mote next comes off an arm are counted from then. The page is begun again for it,
 *                                  held from before its first frame. With --clock, a take comes out the same every time.
 *   --motes 1,1                    with --aged: how many motes further on Ivory's and Void's trails of motes are, in the run of random
 *                                  numbers that places them, than stepping evenly to that age leaves them. To match a take that was
 *                                  not begun this way, whose hands arrived by the browser's own uneven frames.
 *   --sheet 6                      every which frame goes on the contact sheet
 *   --replace                      film over a take that is already there (a shot's folder is emptied before it is filmed,
 *                                  so without this a folder that holds frames is left alone and the shot is not filmed)
 *   --engine                       let the chess engine judge the moves (off: the film must come out the same every time)
 *
 * Anything else on the line is the name of a shot to film (all of them if none is named).
 */
export function options(argv = process.argv.slice(2)) {
  const o = { url: 'http://127.0.0.1:5173/', out: path.join(ROOT, 'tmp/promo/shots'), size: null, sub: 16, most: 384, apart: 1, shutter: 180, fps: 60, draft: false, every: 1, stills: null, window: null, frames: null, drawn: null, clock: null, aged: null, motes: null, sheet: 6, replace: false, engine: false, only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') o.url = next();
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--size') o.size = next();
    else if (a === '--sub') o.sub = Number(next());
    else if (a === '--most') o.most = Number(next());
    else if (a === '--apart') o.apart = Number(next());
    else if (a === '--shutter') o.shutter = Number(next());
    else if (a === '--fps') o.fps = Number(next());
    else if (a === '--draft') o.draft = true;
    else if (a === '--every') o.every = Number(next());
    else if (a === '--stills') o.stills = next().split(',').map(Number);
    else if (a === '--window') o.window = next().split(',').map(Number);
    else if (a === '--frames') o.frames = next().split(',').map(Number);
    else if (a === '--drawn') o.drawn = Number(next());
    else if (a === '--clock') o.clock = Number(next());
    else if (a === '--aged') o.aged = Number(next());
    else if (a === '--motes') o.motes = next().split(',').map(Number);
    else if (a === '--sheet') o.sheet = Number(next());
    else if (a === '--replace') o.replace = true;
    else if (a === '--engine') o.engine = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else o.only.push(a);
  }
  o.size ??= o.draft ? '540p' : '4k';
  if (o.draft) {
    o.sub = Math.min(o.sub, 3);
    o.most = Math.min(o.most, 6);
    o.out = path.join(o.out, '_draft');
  }
  if (!SIZES[o.size]) throw new Error(`Unknown size ${o.size}: one of ${Object.keys(SIZES).join(', ')}`);
  return o;
}

/**
 * What runs in the page. It is sent as text, so it may use nothing from this file.
 *
 * Patched, all on live objects and only for this page's life:
 *   app.tick            counts the scene's time
 *   app.rig.update      after the game's own camera has been worked out, the shot's camera replaces it (the thud is kept)
 *   app.rig.cut         the game's own cuts to a close view can be left out, for a shot from the player's seat
 *   world.focusLens     the shot sets the lens
 *   world.post          one pass added before the grade (the average), the grade made to read it, `render` able to skip drawing
 *   the depth of field's gathering shader: its ring of taps is turned a different way for each picture averaged
 *   world.sound         every method wrapped, to be written down
 *   world.director.beat, world.setMood, app.rig.thud: wrapped, to be written down
 *   world.keepClear     the picture is not slid aside for a card of text unless the interface is shown
 *   world.stage.silhouette.draw   the picture the hands' glowing edges are found in is kept at full size
 *   for a shot that shows the interface (`P.ownTime`): setTimeout, setInterval, requestAnimationFrame
 *   and the CSS animations, all made to go by the scene's clock
 */
function install() {
  const handle = window.__nightpiece;
  const app = handle.app;
  const ui = handle.ui;
  const world = app.world;
  const rig = app.rig;
  const camera = world.camera;
  const post = world.post;
  const composer = post.composer;
  const renderer = world.renderer;
  const Vec3 = camera.position.constructor;
  const Quat = camera.quaternion.constructor;

  const P = {
    /** Seconds of the scene. Nought is where the scene's own action begins. */
    t: 0,
    ticks: 0,
    cues: [],
    cameraFn: null,
    state: {},
    log: [],
    recording: false,
    skipDraw: false,
    sub: { index: 0, count: 1 },
    last: null,
    dt: 0,
    /** How fast the interface's clock runs against the scene's (see `P.ownTime`). */
    clockRate: 1,
  };

  // -- helpers the shot's camera is given -------------------------------------------------------
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const H = {
    app,
    ui,
    clamp01,
    mix: (a, b, u) => a + (b - a) * u,
    mix3: (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
    length: (a) => Math.hypot(a[0], a[1], a[2]),
    /** How far through a stretch of time, 0 to 1, clamped. */
    seg: (t, from, to) => clamp01((t - from) / (to - from)),
    /** Eases: each goes from 0 to 1, arriving and leaving at rest. */
    cubic: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
    quint: (u) => (u < 0.5 ? 16 * u * u * u * u * u : 1 - Math.pow(-2 * u + 2, 5) / 2),
    smooth: (u) => u * u * (3 - 2 * u),
    smoother: (u) => u * u * u * (u * (u * 6 - 15) + 10),
    sine: (u) => 0.5 - 0.5 * Math.cos(Math.PI * u),
    outCubic: (u) => 1 - Math.pow(1 - u, 3),
    outQuint: (u) => 1 - Math.pow(1 - u, 5),
    /** The middle of a square, as [x, y, z]. */
    sq: (name) => [name.charCodeAt(0) - 97 - 3.5, 0, 3.5 - (Number(name[1]) - 1)],
    /** A point on a sphere round `centre`: `azimuth` from +z toward +x, `elevation` up from the level, both in radians. */
    orbit: (centre, azimuth, elevation, radius) => [
      centre[0] + Math.sin(azimuth) * Math.cos(elevation) * radius,
      centre[1] + Math.sin(elevation) * radius,
      centre[2] + Math.cos(azimuth) * Math.cos(elevation) * radius,
    ],
    /** Where a stone is this instant (it may be in a hand), by the square it stands on or its number. */
    stone: (which) => {
      const puppet = typeof which === 'number' ? world.pieces.puppet(which) : world.pieces.puppetAt(which);
      if (!puppet) return null;
      const p = puppet.group.position;
      return [p.x, p.y, p.z];
    },
    /** The number of the stone on a square, to follow it by once it has left. */
    idAt: (square) => world.pieces.puppetAt(square)?.id ?? null,
    /** Where a hand's palm is: side 'w' | 'b', which 'right' | 'left'. */
    palm: (side, which) => {
      const p = world.stage.hands[side][which].hand.toWorld(new Vec3(0, -0.55, -1.5));
      return [p.x, p.y, p.z];
    },
    /**
     * A value (a number or a point) that follows a goal as a weight on a spring does, critically
     * damped: it never jumps and never overshoots. `rate` is the stiffness; it covers most of
     * the way in about 3 / rate seconds. Kept by `key` from one step to the next.
     */
    follow: (key, goal, rate) => {
      const many = Array.isArray(goal);
      const g = many ? goal : [goal];
      let s = P.state[key];
      if (!s) s = P.state[key] = { value: g.slice(), velocity: g.map(() => 0) };
      const dt = P.dt;
      if (dt > 0) {
        const decay = Math.exp(-rate * dt);
        for (let i = 0; i < g.length; i++) {
          const d = s.value[i] - g[i];
          const temp = (s.velocity[i] + rate * d) * dt;
          s.velocity[i] = (s.velocity[i] - rate * temp) * decay;
          s.value[i] = g[i] + (d + temp) * decay;
        }
      }
      return many ? s.value.slice() : s.value[0];
    },
    /** Somewhere to keep a thing from one step to the next (the number of a stone, say). */
    keep: (key, make) => (key in P.state ? P.state[key] : (P.state[key] = make())),
  };
  P.H = H;

  // -- time, and things that happen at a time ----------------------------------------------------
  const tick = app.tick.bind(app);
  app.tick = (dt) => {
    P.dt = dt;
    P.t += dt;
    P.ticks++;
    tick(dt);
    if (P.clock) P.clock.step(dt * 1000 * P.clockRate);
  };

  // -- the interface's own time -------------------------------------------------------------------
  // The interface counts in real time: a banner is taken down by a timer, its edges boil by a CSS
  // animation. Filmed, a second of the scene may take a minute to draw. So, for a shot that shows
  // the interface, the page's timers, its animation frames and its CSS animations are all made to
  // go by the scene's clock instead. It is done before the game is begun, so that every timer the
  // interface ever sets is one of these.
  P.clock = null;
  P.ownTime = () => {
    if (P.clock) return;
    const real = { clearTimeout: window.clearTimeout.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) };
    const clock = { now: 0, timers: new Map(), frames: new Map(), next: 1e9, born: new WeakMap() };
    const set = (fn, ms, args, every) => {
      const id = clock.next++;
      const wait = Math.max(0, Number(ms) || 0);
      clock.timers.set(id, { at: clock.now + wait, fn, args, every: every ? Math.max(1, wait) : 0 });
      return id;
    };
    window.setTimeout = (fn, ms, ...args) => set(fn, ms, args, false);
    window.setInterval = (fn, ms, ...args) => set(fn, ms, args, true);
    window.clearTimeout = window.clearInterval = (id) => {
      if (!clock.timers.delete(id)) real.clearTimeout(id);
    };
    window.requestAnimationFrame = (fn) => {
      const id = clock.next++;
      clock.frames.set(id, fn);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!clock.frames.delete(id)) real.cancelAnimationFrame(id);
    };
    /** Hold every CSS animation and transition where the scene's clock puts it. */
    clock.hold = () => {
      for (const a of document.getAnimations()) {
        if (a.playState === 'finished') continue;
        let born = clock.born.get(a);
        if (born === undefined) clock.born.set(a, (born = clock.now));
        a.pause();
        const at = clock.now - born;
        const end = a.effect?.getComputedTiming().endTime ?? Infinity;
        if (at >= end) a.finish();
        else a.currentTime = at;
      }
    };
    clock.step = (ms) => {
      clock.now += ms;
      // The frames asked for before this step, and then every timer that has fallen due, in order,
      // those set by the ones before them included.
      const frames = [...clock.frames.values()];
      clock.frames.clear();
      for (const fn of frames) fn(clock.now);
      for (let guard = 0; guard < 2000; guard++) {
        let due = null;
        for (const [id, timer] of clock.timers) if (timer.at <= clock.now + 1e-6 && (!due || timer.at < due[1].at)) due = [id, timer];
        if (!due) break;
        if (due[1].every) due[1].at += due[1].every;
        else clock.timers.delete(due[0]);
        if (typeof due[1].fn === 'function') due[1].fn(...due[1].args);
      }
      clock.hold();
    };
    P.clock = clock;
  };
  const yieldTask = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(0);
    });
  const runCues = async () => {
    while (P.cues.length && P.cues[0].t <= P.t + 1e-9) {
      const cue = P.cues.shift();
      note('cue', [cue.name ?? cue.js.slice(0, 60)], 'promo');
      await new Function('app', 'ui', 'P', 'H', `return (async () => { ${cue.js} })();`)(app, ui, P, H);
    }
  };
  /** Step the game on by `seconds` in steps of `step`, as the game's own `advance` does, running cues as they fall due. */
  P.advance = async (seconds, step) => {
    const steps = Math.round(seconds / step);
    for (let i = 0; i < steps; i++) {
      await runCues();
      app.tick(step);
      await yieldTask();
    }
  };

  // -- the camera ---------------------------------------------------------------------------------
  const forward = new Vec3();
  const upward = new Vec3();
  const target = new Vec3();
  const roll = new Quat();
  /** Offsets of a fraction of a pixel, one for each picture averaged: a Halton run, about the middle. */
  const halton = (i, base) => {
    let f = 1;
    let r = 0;
    for (let n = i; n > 0; n = Math.floor(n / base)) {
      f /= base;
      r += f * (n % base);
    }
    return r;
  };
  const applyCamera = () => {
    const c = P.cameraFn(P.t, H);
    P.last = c;
    const fov = c.fov ?? 35;
    camera.position.set(c.pos[0], c.pos[1], c.pos[2]);
    camera.up.set(0, 1, 0);
    target.set(c.target[0], c.target[1], c.target[2]);
    camera.lookAt(target);
    if (c.roll) {
      camera.getWorldDirection(forward);
      camera.quaternion.premultiply(roll.setFromAxisAngle(forward, c.roll));
    }
    // The thud: the picture dips and springs back, by the game's own spring, as a share of what the lens sees at its subject.
    if (rig.dip !== 0 && c.thud !== 0) {
      const tall = 2 * camera.position.distanceTo(target) * Math.tan((fov * Math.PI) / 360);
      camera.position.addScaledVector(upward.set(0, 1, 0).applyQuaternion(camera.quaternion), rig.dip * tall * (c.thud ?? 1));
    }
    camera.fov = fov;
    camera.updateProjectionMatrix();
    if (P.recording && P.sub.count > 1) {
      const i = P.sub.index + 1;
      const m = camera.projectionMatrix.elements;
      m[8] += (2 * (halton(i, 2) - 0.5)) / renderer.domElement.width;
      m[9] += (2 * (halton(i, 3) - 0.5)) / renderer.domElement.height;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
    camera.updateMatrixWorld();
  };
  const rigUpdate = rig.update.bind(rig);
  rig.update = (dt, aspect) => {
    rigUpdate(dt, aspect);
    // Where the game itself has just put the camera: a shot may start from that (H.own).
    camera.getWorldDirection(forward);
    P.own = { pos: [camera.position.x, camera.position.y, camera.position.z], forward: [forward.x, forward.y, forward.z], fov: camera.fov };
    if (P.cameraFn) applyCamera();
  };
  H.own = () => P.own;
  // The game cuts to a close view of its own for a capture, a check and a mate. A shot that shows
  // the game as it is played from its seat asks for none (`cuts: false`).
  const cut = rig.cut.bind(rig);
  P.cuts = true;
  rig.cut = (...args) => {
    if (P.cuts) cut(...args);
  };

  // -- the lens -----------------------------------------------------------------------------------
  const focusLens = world.focusLens.bind(world);
  world.focusLens = (dt) => {
    const c = P.cameraFn ? P.last : null;
    if (!c || c.lens === 'own') return focusLens(dt);
    let focus = c.focus ?? 10;
    if (c.focusAt) {
      // Depth along the lens's own axis, which is what the blur measures.
      camera.getWorldDirection(forward);
      focus = (c.focusAt[0] - camera.position.x) * forward.x + (c.focusAt[1] - camera.position.y) * forward.y + (c.focusAt[2] - camera.position.z) * forward.z;
    }
    c.focusUsed = focus;
    post.setFocus(focus, c.range ?? 1.5, c.amount ?? 0.014);
  };

  // -- the picture's middle, and the hands' edges --------------------------------------------------
  // The game slides the picture aside to keep a card of text clear of the board (when a game ends,
  // for one). With the interface put away there is no card, and the picture stays where it is.
  const keepClear = world.keepClear.bind(world);
  P.cards = false;
  world.keepClear = (pixels) => keepClear(P.cards ? pixels : 0);
  // The glow at a hand's edge is found in a picture of how far away the hands are, which the game
  // keeps at half size once the frame is taller than 1300 pixels. At 2160 the halves show as steps
  // in the glow. Asked for a frame twice the size, it keeps the picture whole.
  const shape = world.stage?.silhouette;
  if (shape && typeof shape.draw === 'function') {
    const draw = shape.draw.bind(shape);
    shape.draw = (r, eye, width, height) => (height > 1300 ? draw(r, eye, width * 2, height * 2) : draw(r, eye, width, height));
  }

  // -- the average --------------------------------------------------------------------------------
  const Target = composer.renderTarget1.constructor;
  const Quad = post.grade.quad.constructor;
  const Raw = post.grade.quad.material.constructor;
  const exact = renderer.extensions.has('EXT_color_buffer_float') && renderer.extensions.has('EXT_float_blend');
  // 1015 is three's FloatType, 1006 its LinearFilter: a full float where the card can blend into one, or else the frame's own half float.
  P.exact = exact;
  const sum = new Target(1, 1, { type: exact ? 1015 : composer.renderTarget1.texture.type, depthBuffer: false, minFilter: 1006, magFilter: 1006 });
  const adder = new Quad(
    new Raw({
      name: 'PromoAverage',
      uniforms: { tDiffuse: { value: null }, uWeight: { value: 1 } },
      vertexShader: `
        precision highp float;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        attribute vec3 position;
        attribute vec2 uv;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float uWeight;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D( tDiffuse, vUv ).rgb;
          float most = max( c.r, max( c.g, c.b ) );
          if ( ! ( c.r == c.r && c.g == c.g && c.b == c.b && most < 1.0e4 ) ) c = vec3( 0.0 );
          gl_FragColor = vec4( clamp( c, 0.0, 64.0 ) * uWeight, 1.0 );
        }`,
      depthTest: false,
      depthWrite: false,
    }),
  );
  // Added to what is there (three's CustomBlending, one times the new plus one times the old), except the first, which replaces it.
  adder.material.blendSrc = 201;
  adder.material.blendDst = 201;
  adder.material.blendSrcAlpha = 201;
  adder.material.blendDstAlpha = 201;
  const average = {
    isPass: true,
    enabled: false,
    needsSwap: false,
    clear: false,
    renderToScreen: false,
    setSize: (w, h) => sum.setSize(w, h),
    render: (r, _write, read) => {
      adder.material.uniforms.tDiffuse.value = read.texture;
      adder.material.uniforms.uWeight.value = 1 / P.sub.count;
      adder.material.blending = P.sub.index === 0 ? 0 : 5;
      const clears = r.autoClear;
      r.autoClear = false;
      r.setRenderTarget(sum);
      adder.render(r);
      r.autoClear = clears;
    },
    dispose: () => {
      sum.dispose();
      adder.material.dispose();
      adder.dispose();
    },
  };
  const grade = post.grade;
  composer.insertPass(average, composer.passes.indexOf(grade));
  average.setSize(renderer.domElement.width, renderer.domElement.height);
  const gradeRender = grade.render.bind(grade);
  grade.render = (r, write, read) => gradeRender(r, write, average.enabled ? { texture: sum.texture } : read);
  const postRender = post.render.bind(post);
  post.render = (dt) => {
    if (P.skipDraw) {
      post.time += dt;
      return;
    }
    average.enabled = P.recording;
    // Only the last picture of a frame goes on through the grade to the screen.
    grade.enabled = !P.recording || P.sub.index === P.sub.count - 1;
    postRender(dt);
    grade.enabled = true;
  };

  // The depth of field gathers along a ring of taps turned by an angle of each pixel's own. Turned a
  // different way for each picture averaged, the grain of it averages away with them.
  const focusPass = post.focus;
  if (focusPass) {
    const blur = focusPass.blur.material;
    blur.uniforms.uTurn = { value: 0 };
    blur.fragmentShader = blur.fragmentShader
      .replace('uniform float uTexel;', 'uniform float uTexel;\n          uniform float uTurn;')
      .replace('float turn = 6.2831853 * fract(', 'float turn = 6.2831853 * uTurn + 6.2831853 * fract(');
    blur.needsUpdate = true;
    const focusRender = focusPass.render.bind(focusPass);
    focusPass.render = (...args) => {
      blur.uniforms.uTurn.value = P.recording ? (P.sub.index * 0.61803398875) % 1 : 0;
      focusRender(...args);
    };
  }

  // -- what is written down -----------------------------------------------------------------------
  const plain = (v, depth = 0) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Math.round(v * 1000) / 1000;
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'function') return 'function';
    if (Array.isArray(v)) return depth > 2 ? 'array' : v.slice(0, 12).map((x) => plain(x, depth + 1));
    if (typeof v === 'object') {
      if (typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') return { x: plain(v.x), y: plain(v.y), z: plain(v.z) };
      if (depth > 1) return v.constructor?.name ?? 'object';
      const out = {};
      for (const k of Object.keys(v).slice(0, 12)) out[k] = plain(v[k], depth + 1);
      return out;
    }
    return String(v);
  };
  let depth = 0;
  let parent = null;
  const note = (method, args, source, inside = null) => {
    P.log.push({ t: P.t, tick: P.ticks, source, method, args: args.map((a) => plain(a)), depth, parent: inside });
  };
  P.note = note;
  /** Wrap every method an object has, its own and its class's, so that each call is written down. */
  const wrapAll = (object, source) => {
    const names = new Set();
    for (let o = object; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const name of Object.getOwnPropertyNames(o)) {
        if (name === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(o, name);
        if (d && typeof d.value === 'function') names.add(name);
      }
    }
    for (const name of names) {
      const original = object[name];
      object[name] = function (...args) {
        note(name, args, source, parent);
        const was = parent;
        parent = name;
        depth++;
        try {
          return original.apply(this, args);
        } finally {
          depth--;
          parent = was;
        }
      };
    }
    return [...names];
  };
  /** Start the game's sound as the first click would, and write down every call made to it from here on. */
  P.listen = () => {
    if (!world.sound) app.wakeSound();
    const sound = world.sound;
    if (!sound) return null;
    if (sound.__promo) return sound.__promo;
    sound.__promo = wrapAll(sound, 'sound');
    // The heartbeat has no method of its own: it is struck inside `update`, when its timer is wound again.
    const update = sound.update;
    if (typeof update === 'function' && sound.heart) {
      sound.update = function (dt) {
        const heart = this.heart;
        const before = heart.timer;
        const out = update.call(this, dt);
        if (heart.on && heart.timer > before + 0.5) P.log.push({ t: P.t, tick: P.ticks, source: 'sound', method: 'heartbeat', args: [], depth: 0, parent: null });
        return out;
      };
    }
    return sound.__promo;
  };
  const wrapOne = (object, name, source) => {
    const original = object[name];
    if (typeof original !== 'function') return;
    object[name] = function (...args) {
      note(name, args, source);
      return original.apply(this, args);
    };
  };
  if (world.director) {
    const beat = world.director.beat.bind(world.director);
    world.director.beat = (e, part, which) => {
      note('beat', [part, which, `${e.piece.from}${e.piece.to}`], 'game');
      return beat(e, part, which);
    };
  }
  wrapOne(world, 'setMood', 'game');
  wrapOne(rig, 'thud', 'game');

  // -- how fast things cross the picture -----------------------------------------------------------
  // A thing that crosses many pixels while the shutter is open needs as many pictures averaged, or
  // its edge shows as a row of edges. So each frame it is measured how far the hands, the stones
  // and the room moved across the picture, and the next frame is given pictures enough for that.
  const seen = new Vec3();
  const onHand = [
    [0, -0.55, -1.5],
    [0, -1.0, -2.1],
    [0.45, -0.6, -1.8],
    [-0.45, -0.6, -1.8],
    [0, 0, 0],
  ];
  const inRoom = [
    [5.09, 0.6, 5.05],
    [-5.09, 0.6, 5.05],
    [5.09, 0.6, -5.05],
    [-5.09, 0.6, -5.05],
    [4.5, 0, 4.5],
    [-4.5, 0, 4.5],
    [4.5, 0, -4.5],
    [-4.5, 0, -4.5],
    [0, 3, 14],
    [0, 3, -14],
    [14, 3, 0],
    [-14, 3, 0],
  ];
  /** Where each watched point is in the picture, in pixels; nothing for one that is out of it. */
  const where = () => {
    const out = new Map();
    const w = renderer.domElement.width / 2;
    const h = renderer.domElement.height / 2;
    const put = (key, x, y, z) => {
      seen.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      if (seen.z > -0.2) return;
      seen.applyMatrix4(camera.projectionMatrix);
      if (Math.abs(seen.x) < 1.2 && Math.abs(seen.y) < 1.2) out.set(key, [seen.x * w, seen.y * h]);
    };
    for (const side of ['w', 'b']) {
      for (const which of ['right', 'left']) {
        const hand = world.stage?.hands?.[side]?.[which]?.hand;
        if (!hand) continue;
        onHand.forEach((l, i) => {
          const p = hand.toWorld(new Vec3(l[0], l[1], l[2]));
          put(`${side}${which}${i}`, p.x, p.y, p.z);
        });
      }
    }
    for (const stones of [world.pieces?.views, world.pieces?.trophies]) {
      if (!stones) continue;
      for (const [id, stone] of stones) {
        const p = stone.group.position;
        put(`s${id}a`, p.x, p.y + 0.1, p.z);
        put(`s${id}b`, p.x, p.y + 1.2, p.z);
      }
    }
    inRoom.forEach((r, i) => put(`r${i}`, r[0], r[1], r[2]));
    return out;
  };
  const farthest = (a, b) => {
    let most = 0;
    for (const [key, p] of a) {
      const q = b.get(key);
      if (q) most = Math.max(most, Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    return most;
  };

  // -- filming --------------------------------------------------------------------------------------
  /** Draw nothing while the game is stepped (to get somewhere fast), or draw again. */
  P.blind = (on) => {
    P.skipDraw = on;
    if (!on) world.refreshShadows();
  };
  /**
   * One frame: the half of the last frame in which the shutter was shut (stepped, not drawn), then
   * the open half of this one, drawn `sub` times and averaged. Leaves the frame on the canvas.
   * A frame that is not wanted is stepped the same way and not drawn.
   */
  P.frame = async (first, sub, open, shut, wanted) => {
    if (!first && shut > 0) {
      P.skipDraw = true;
      await runCues();
      app.tick(shut);
      await yieldTask();
      P.skipDraw = false;
    }
    await runCues();
    const at = P.t;
    P.recording = wanted;
    P.skipDraw = !wanted;
    P.sub.count = sub;
    let opened = null;
    let moved = 0;
    for (let i = 0; i < sub; i++) {
      P.sub.index = i;
      app.tick(open / sub);
      if (i === 0) opened = where();
      else if (i === sub - 1) moved = (farthest(opened, where()) * sub) / (sub - 1);
      // The camera as the frame is opened: where sound is heard from.
      if (i === 0) {
        camera.getWorldDirection(forward);
        upward.set(0, 1, 0).applyQuaternion(camera.quaternion);
        P.pose = {
          seconds: at,
          position: [camera.position.x, camera.position.y, camera.position.z],
          forward: [forward.x, forward.y, forward.z],
          up: [upward.x, upward.y, upward.z],
          fov: camera.fov,
          focus: P.last?.focusUsed ?? null,
          range: P.last?.range ?? null,
          amount: P.last?.amount ?? null,
        };
      }
      await yieldTask();
    }
    // What the interface began in answer to the last step is held at its beginning, not left to run while the frame is saved.
    if (P.clock) P.clock.hold();
    P.recording = false;
    P.skipDraw = false;
    P.sub.count = 1;
    P.sub.index = 0;
    P.pose.moved = moved;
    return P.pose;
  };

  /** What the picture is being drawn at: the game may have made it smaller to keep up, and a film must not be. */
  P.drawn = () => ({
    buffer: [renderer.domElement.width, renderer.domElement.height],
    target: [composer.renderTarget1.width, composer.renderTarget1.height],
    scale: world.renderScale,
    ratio: renderer.getPixelRatio(),
    quality: ui.quality.value,
    fonts: document.fonts.status,
  });

  window.__promo = P;
  return { exact, passes: composer.passes.length, buffer: [renderer.domElement.width, renderer.domElement.height], pixelRatio: renderer.getPixelRatio(), quality: ui.quality.value };
}

/**
 * Open the game, ready to film: the finished room at the highest quality, time held, the rig
 * installed, the interface put away. Returns look.mjs's handle with more on it.
 *
 * `hud` opens it for a shot that shows the interface: the interface is left up, and made to go
 * by the scene's clock from before the game is begun (see `P.ownTime`). `css` is more style
 * for that shot, to put away the parts of the interface it has no use for.
 */
export async function open(o, { hud = false, css = '', layout = LAYOUT } = {}) {
  const [wide, tall] = SIZES[o.size];
  const size = { width: layout[0], height: layout[1], scale: wide / layout[0] };
  if (Math.abs(size.scale * layout[1] - tall) > 1e-6) throw new Error(`A page ${layout.join(' x ')} is not the shape of a picture ${wide} x ${tall}.`);
  // Without the engine the room goes by what it can see on the board, which is the same every time.
  const g = await launch({ url: o.url, out: o.out, width: size.width, height: size.height, scale: size.scale, quality: 'high', block: o.engine ? [] : ['/engine/stockfish'] });
  // The game draws at most two real pixels to each of the page's. A page laid out smaller than half the
  // picture needs more, and is given them: the table the game reads its limit from is the dev server's own
  // module, and the same one the game has.
  const lift = async () => {
    if (size.scale <= 2) return;
    await g.ev(`const { QUALITY } = await import('/src/scene/post.ts'); QUALITY.high.pixelRatio = args[0]; app.world.resize(true);`, size.scale);
  };
  await lift();
  // Before the game is held it has gone by the browser's own frames for as long as the page took to load, which is
  // not the same twice; and two things are left over from that. The game's clock stands somewhere: the resting hands'
  // drift, the flames, the dust and the light go by it. And the hands have been in the room for some of that time:
  // when each next shifts a finger, and when a mote next comes off an arm, are counted from when they came.
  // A take that must come out as another did is given both. For the second the page is begun again, held from before
  // its first frame, and then stepped on by so many sixtieths, which is what the hands would have seen.
  if (o.aged !== null) {
    await g.page.evaluateOnNewDocument(() => {
      let handle;
      Object.defineProperty(window, '__nightpiece', {
        configurable: true,
        get: () => handle,
        set: (v) => {
          handle = v;
          if (v?.app) v.app.held = true;
        },
      });
    });
    await g.page.reload({ waitUntil: 'networkidle2' });
    await g.page.waitForFunction(`window.__nightpiece && window.__nightpiece.ui && window.__nightpiece.ui.ready.value === true`, { timeout: 60000 });
    await g.ev(`app.setQuality('high');`);
    await lift();
  }
  await g.hold();
  g.clock = await g.ev(
    `const hands = app.world.stage ? Object.values(app.world.stage.hands).flatMap((p) => [p.right, p.left]).map((arm) => arm.hand) : [];
     const found = { clock: app.time, hands: hands.map((h) => h.fidget.age) };
     if (args[1] !== null) {
       if (app.time !== 0) throw new Error('the game had begun before it was held: its clock stood at ' + app.time);
       for (let i = 0; i < args[1]; i++) app.tick(1 / 60);
     }
     if (args[0] !== null) { app.time = args[0]; if (app.world.post) app.world.post.time = args[0]; }
     // Each side's motes are placed by a run of random numbers (hands/trail.ts), nine to a mote. Stepped evenly, the hands
     // let go a mote or so fewer as they arrive than they did by the browser's uneven frames: the run is put on by that many.
     if (args[2] !== null && app.world.stage) {
       const step = (r) => (r * 9301 + 0.2113) % 1;
       ['w', 'b'].forEach((side, i) => {
         const trail = app.world.stage.trails[side];
         let r = 0.37;
         let n = 0;
         while (r !== trail.roll && n < 1e6) { r = step(r); n++; }
         if (r !== trail.roll) throw new Error('the motes are not where their run of random numbers begins from');
         r = 0.37;
         for (let k = 0; k < n + 9 * args[2][i]; k++) r = step(r);
         trail.roll = r;
       });
     }
     return { held: app.time, set: args[0] !== null, aged: args[1], motes: args[2], found };`,
    o.clock ?? null,
    o.aged ?? null,
    o.motes ?? null,
  );
  // The game may have drawn itself smaller while it loaded, to keep up; a film has no need to keep up.
  // No question is asked before a move and no rule explained after it, and a chosen stone shows its own square and not where it may go.
  await g.ev(`app.world.setRenderScale(1, true); for (const aid of ['warn', 'explain', 'moves', 'danger', 'hints']) app.setAid(aid, false); app.setCinematic(true);`);
  g.info = await g.page.evaluate(install);
  if (hud) await g.page.evaluate(() => window.__promo.ownTime());
  // The sound is started here, as a player's first click starts it, and not later: starting it puts the room back to rest.
  g.info.sound = await g.page.evaluate(() => window.__promo.listen());
  g.o = o;
  g.final = [wide, tall];
  if (g.info.buffer[0] !== g.final[0] || g.info.buffer[1] !== g.final[1]) console.log(`[promo] the picture is ${g.info.buffer.join('x')}, not the ${g.final.join('x')} asked for`);
  /** Run a snippet in the page with `app`, `ui`, `P` (the rig) and `H` (its helpers) in scope. */
  g.run = (body, ...args) => g.page.evaluate(new Function('...args', `const h = window.__nightpiece; const app = h.app; const ui = h.ui; const P = window.__promo; const H = P.H; return (async () => { ${body} })();`), ...args);
  /** Show the interface, or put it away. Put away it is not laid out at all, so nothing of it can show. */
  g.hud = (on) =>
    g.run(
      `let s = document.getElementById('promo-hud'); if (!s) { s = document.createElement('style'); s.id = 'promo-hud'; document.head.append(s); }
       s.textContent = args[0] ? args[1] : '#hud { display: none !important; }'; P.cards = !!args[0];`,
      on,
      css,
    );
  await g.hud(hud);
  /**
   * Put the pointer somewhere on the page (in the page's own pixels), for a shot that shows someone using the
   * interface. The browser's own pointer is moved there, so that what is pointed at answers as it does for a
   * player; and since a photograph of the page has no pointer in it, one is drawn there too. `press` draws it pressed.
   */
  g.pointer = async (x, y, press = false) => {
    await g.page.mouse.move(x, y);
    await g.run(
      `let p = document.getElementById('promo-pointer');
       if (!p) {
         p = document.createElement('div');
         p.id = 'promo-pointer';
         p.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:26px;height:26px;transform-origin:0 0;filter:drop-shadow(0 2px 2px rgba(0,0,0,.55))';
         p.innerHTML = '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M2 1.5 L2 20.2 L6.9 15.9 L10.3 23.6 L13.6 22.1 L10.2 14.6 L16.8 14.4 Z" fill="#f7ead2" stroke="#10130d" stroke-width="1.5" stroke-linejoin="round"/></svg>';
         document.body.append(p);
       }
       p.style.transform = 'translate(' + args[0] + 'px,' + args[1] + 'px) scale(' + (args[2] ? 0.88 : 1) + ')';`,
      x,
      y,
      press,
    );
  };
  /**
   * The mark that shows where typing goes in a field. The browser's own blinks by the real clock, which a film
   * stepped a frame at a time would show flickering: it is hidden, and one is drawn that goes by the scene's clock.
   * `on` is whether it shows at this instant; with no selector it is taken away.
   */
  g.caret = (selector, on = true) =>
    g.run(
      `let c = document.getElementById('promo-caret');
       const el = args[0] ? document.querySelector(args[0]) : null;
       if (!el) { c?.remove(); return; }
       if (!c) { c = document.createElement('div'); c.id = 'promo-caret'; c.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:1.5px;background:#f7ead2'; document.body.append(c); }
       el.style.caretColor = 'transparent';
       const cs = getComputedStyle(el);
       const r = el.getBoundingClientRect();
       const ctx = (P.measure ??= document.createElement('canvas').getContext('2d'));
       ctx.font = cs.font;
       const spacing = parseFloat(cs.letterSpacing) || 0;
       const w = ctx.measureText(el.value).width + spacing * el.value.length;
       const h = parseFloat(cs.fontSize) * 1.2;
       c.style.left = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + w + 1 + 'px';
       c.style.top = r.top + (r.height - h) / 2 + 'px';
       c.style.height = h + 'px';
       c.style.opacity = args[1] ? '1' : '0';`,
      selector,
      on,
    );
  /** Step the game. `blind` steps it without drawing, to reach a position quickly. */
  g.step = (seconds, { blind = false, step = 1 / 60 } = {}) => g.run(`P.blind(args[2]); await P.advance(args[0], args[1]); P.blind(false);`, seconds, step, blind);
  /**
   * Play a move by its two squares, straight to the hands (no stone is chosen first), and step
   * through it. Where the engine is on, its opinion is waited for first, so that the room
   * answers on the same step every time.
   */
  g.play = async (from, to, seconds = 3.6, { blind = true } = {}) => {
    await g.run(`P.moving = app.play(args[0], args[1]); P.moving.catch((e) => console.error('move refused', args[0], args[1], String(e)));`, from, to);
    if (o.engine) await g.verdict();
    await g.step(seconds, { blind });
  };
  /** Wait, in real time, until the engine has said what it makes of the last move (or five seconds have gone). */
  g.verdict = async () => {
    for (let i = 0; i < 100; i++) {
      const known = await g.run(`const e = app.game.lastMove(); return ui.engine.value === 'failed' || !e || app.verdicts.has(e) ? (app.verdicts.get(e)?.kind ?? 'none') : null;`);
      if (known !== null) return known;
      await g.wait(50);
    }
    return 'late';
  };
  return g;
}

const round = (v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v);

/**
 * Film one shot.
 *
 *   name      the folder the frames go in
 *   camera    (t, H) => ({ pos, target, fov, roll, focus | focusAt, range, amount, thud }): where the camera is at
 *             second `t` of the scene. It runs in the page, so it may use only `t` and `H` (the helpers in `install`).
 *             `H.own()` is where the game itself has the camera, and `lens: 'own'` leaves the lens to the game too.
 *   from, to  the part of the scene delivered, in seconds of the scene (handles included)
 *   cut       [in, out]: the part meant to be used, in seconds of the scene, for the record
 *   lead      seconds stepped with the shot's camera before `from`, so that nothing is still settling in the first frame
 *   cues      [{ t, js, name }]: things done in the page at a second of the scene
 *   hud       whether the interface is shown
 *   cuts      false to keep the game from cutting to its own close views (it does for a capture, a check and a mate)
 *   settle    seconds the scene is left to come to rest before the shot (six, unless the shot says)
 *   hudRate   for a shot that shows the interface, how fast the interface's own clock runs while the game is played up
 *             to the scene (scenes.mjs, `reach`); the scene's first cue sets it true again
 *   layout    [width, height]: the page's size in its own pixels, where it is not the usual one (`open`)
 *   act       async (g, t, frame) => {}: done from outside the page before each frame is drawn (and once before the lead, with
 *             frame -1), `t` being the scene's second: where the pointer is (`g.pointer`), a button pressed, a key typed
 *   fine      [[from, to, pictures], ...]: stretches of the scene, in its seconds, where at least so many pictures are averaged
 *             for each frame, whatever is measured (see --most)
 */
export async function film(g, shot) {
  const o = g.o;
  const [from, to] = o.window ?? [shot.from, shot.to];
  const fps = o.fps;
  const frames = Math.round((to - from) * fps);
  const open = o.shutter / 360 / fps;
  const shut = 1 / fps - open;
  const dir = path.join(o.out, shot.name);
  // A take already there is not filmed over unless that is asked for: the edit may be cut from it.
  if (!o.replace && existsSync(dir) && readdirSync(dir).some((f) => f.startsWith('frame_'))) {
    throw new Error(`${dir} already holds a take. Film into another folder (--out), or say --replace to film over this one.`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ext = o.draft ? 'jpg' : 'png';

  await g.hud(!!shot.hud);
  await g.run(`P.cuts = args[0];`, shot.cuts !== false);
  const lead = shot.lead ?? 1;
  const cues = shot.cues ?? [];
  // The scene is always played from its first cue, however late the shot begins, so that every
  // shot of a scene sees the same scene: what comes before the lead is stepped without being drawn.
  const start = Math.min(from - lead, ...cues.map((c) => c.t));
  await g.run(
    `P.t = args[0]; P.state = {}; P.log = []; P.cues = args[2].slice().sort((a, b) => a.t - b.t);
     P.cameraFn = new Function('return (' + args[1] + ')')(); P.listen();`,
    start,
    shot.camera ? shot.camera.toString() : 'null',
    cues,
  );
  if (from - lead > start) await g.run(`P.blind(true); await P.advance(args[0], 1 / 60); P.blind(false);`, from - lead - start);
  // What a shot does from outside the page (the pointer, a key pressed) is done before the lead, and then before each frame.
  if (shot.act) await shot.act(g, from - lead, -1);
  await g.run(`await P.advance(args[0], 1 / 60);`, lead);
  // The lead is stepped in sixtieths; put the clock exactly on the first frame.
  await g.run(`P.t = args[0];`, from);

  // Only a run of the shot's frames may be asked for: the scene is stepped the same up to the first of them, and they keep their numbers.
  const [first, last] = o.frames ? [Math.max(0, o.frames[0]), Math.min(frames - 1, o.frames[1])] : [0, frames - 1];
  const want = (i) => i >= first && i <= last && (o.stills ? o.stills.some((s) => Math.round((s - from) * fps) === i) : i % o.every === 0);
  // Frames may be drawn without being saved, as the take they continue drew them.
  const draw = (i) => want(i) || (o.drawn !== null && i >= o.drawn && i <= last);
  const drawnBefore = await g.run(`return P.drawn();`);
  // Where something crosses the picture very fast, eight pictures to a frame show as eight edges, not as a blur: more are averaged there.
  const fine = (shot.fine ?? []).map(([a, b, n]) => [a, b, Math.min(o.most, Math.max(o.sub, n))]);
  const subAt = (t) => fine.find(([a, b]) => t >= a - 1e-9 && t < b - 1e-9)?.[2] ?? o.sub;
  // The photograph. Where a shot has the pointer on the page it is asked of the browser directly: asked the usual way, the
  // browser is told again where the pointer is, in the wrong measure, and what the pointer rests on thinks it has left and come back.
  const kind = { format: o.draft ? 'jpeg' : 'png', ...(o.draft ? { quality: 90 } : {}), captureBeyondViewport: false };
  if (shot.act) g.wire ??= await g.page.createCDPSession();
  const [across, down] = shot.layout ?? LAYOUT;
  const area = { x: 0, y: 0, width: across, height: down, scale: g.final[0] / across };
  const shoot = shot.act
    ? async (file) => writeFileSync(file, Buffer.from((await g.wire.send('Page.captureScreenshot', { ...kind, clip: area })).data, 'base64'))
    : (file) => g.page.screenshot({ path: file, type: kind.format, ...(o.draft ? { quality: 90 } : {}), captureBeyondViewport: false });
  const poses = [];
  const started = Date.now();
  let saved = 0;
  const ticksBefore = await g.run(`return P.ticks;`);
  // How far the fastest thing crossed the picture in the last frame and the one before, in pixels with the shutter open.
  let moved = [0, 0];
  let most = o.sub;
  for (let i = 0; i <= last; i++) {
    const wanted = want(i);
    if (shot.act) await shot.act(g, from + i / fps, i);
    // Pictures enough that the fastest thing moves about `o.apart` pixels from one to the next, going by the last frame and how it was gathering speed.
    const coming = Math.max(moved[0], 2 * moved[0] - moved[1]) * 1.25;
    const sub = Math.min(o.most, Math.max(subAt(from + i / fps), 4 * Math.ceil(coming / o.apart / 4)));
    most = Math.max(most, sub);
    const pose = await g.run(`return await P.frame(args[0], args[1], args[2], args[3], args[4]);`, i === 0, sub, open, shut, draw(i));
    moved = [pose.moved, moved[0]];
    poses.push({ frame: i, seconds: round(pose.seconds - from), position: pose.position.map(round), forward: pose.forward.map(round), up: pose.up.map(round), fov: round(pose.fov), focus: round(pose.focus), range: round(pose.range), amount: round(pose.amount), pictures: sub });
    if (wanted) {
      const file = path.join(dir, `frame_${String(i).padStart(5, '0')}.${ext}`);
      await shoot(file);
      saved++;
    }
    if (i % 30 === 29) process.stdout.write(`\r[${shot.name}] ${i + 1}/${last + 1}`);
  }
  // The shut half of the last frame, so that the scene's clock ends on a whole frame.
  await g.run(`P.blind(true); await P.advance(args[0], args[0]); P.blind(false); P.cameraFn = null;`, shut);
  const seconds = (Date.now() - started) / 1000;
  process.stdout.write(`\r[${shot.name}] ${last + 1} frames (${saved} saved) in ${seconds.toFixed(0)} s, ${o.sub} to ${most} pictures a frame\n`);
  // The picture must have been drawn whole from the first frame to the last.
  const drawn = await g.run(`return P.drawn();`);
  for (const d of [drawnBefore, drawn]) {
    // (A page drawn with a number of pixels to each of its own that is not whole gives the buffers a size a hair off whole.)
    if (d.buffer[0] !== g.final[0] || d.buffer[1] !== g.final[1] || Math.abs(d.target[0] - g.final[0]) > 0.01 || Math.abs(d.target[1] - g.final[1]) > 0.01 || d.scale !== 1 || d.quality !== 'high') {
      throw new Error(`[${shot.name}] the picture was not drawn whole: ${JSON.stringify(d)}, and ${g.final.join('x')} at the highest quality was asked for`);
    }
  }

  // What was heard and what happened, by the frame it fell in.
  const log = await g.run(`return P.log;`);
  const counts = {};
  for (const e of log) if (e.source === 'sound') counts[e.method] = (counts[e.method] ?? 0) + 1;
  // What is called on most steps is housekeeping (where the listener is, the passing of time), and is only counted.
  const steps = (await g.run(`return P.ticks;`)) - ticksBefore + Math.round((from - start) * 60);
  const everyStep = new Set(Object.keys(counts).filter((m) => counts[m] > steps * 0.5));
  const stamp = (e) => ({ frame: Math.floor((e.t - from) * fps + 1e-6), seconds: round(e.t - from), method: e.method, args: e.args });
  const sounds = log.filter((e) => e.source === 'sound' && !everyStep.has(e.method) && (e.depth === 0 || everyStep.has(e.parent))).map(stamp);
  const happened = log.filter((e) => e.source !== 'sound').map((e) => ({ ...stamp(e), source: e.source }));
  const record = {
    shot: shot.name,
    about: shot.about ?? '',
    fps,
    frames,
    size: g.final,
    scene: { from, to },
    cut: shot.cut ? { in: Math.round((shot.cut[0] - from) * fps), out: Math.round((shot.cut[1] - from) * fps) } : null,
    shutter: o.shutter,
    averaged: [o.sub, most],
    averagedIn: (await g.run(`return P.exact;`)) ? 'float32' : 'float16',
    saved: saved === frames ? 'all' : { first, last, count: saved },
    drawnFrom: o.drawn,
    clock: g.clock,
    drawn,
    averagedMore: fine.map(([a, b, n]) => ({ frames: [Math.round((a - from) * fps), Math.round((b - from) * fps)], pictures: n })),
    note: "frame and seconds count from the first frame delivered; a negative frame fell in the lead, before it. `events` are calls to the game's sound; `game` is what the game did (a hand's beats, the room's state, the thud).",
    everyStep: Object.fromEntries([...everyStep].map((m) => [m, counts[m]])),
    events: sounds,
    game: happened,
  };
  // A shot filmed whole has events.json and camera.json; one filmed in part says so in the names.
  const whole = saved === frames;
  writeFileSync(path.join(dir, whole ? 'events.json' : 'events.partial.json'), JSON.stringify(record, null, 1));
  writeFileSync(path.join(dir, whole ? 'camera.json' : 'camera.partial.json'), JSON.stringify({ shot: shot.name, fps, frames: poses }));
  if (saved > 1) sheet(dir, ext, o.stills || o.every !== 1 ? 1 : o.sheet);
  return { dir, frames, seconds, record };
}

/** Lay every `nth` frame of a shot out as one sheet, sheet.jpg in its folder. */
export function sheet(dir, ext = 'png', nth = 6, columns = 6, width = 480) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('frame_') && f.endsWith(`.${ext}`))
    .sort();
  const picked = files.filter((_, i) => i % nth === 0);
  const temp = mkdtempSync(path.join(os.tmpdir(), 'promo-sheet-'));
  try {
    for (const f of picked) symlinkSync(path.resolve(dir, f), path.join(temp, f));
    const out = execFileSync('python3', [path.join(ROOT, 'tools/dev/sheet.py'), path.join(temp, 'frame_'), '--out', path.resolve(dir, 'sheet.jpg'), '--columns', String(columns), '--width', String(width)], { encoding: 'utf8' });
    console.log(out.trim());
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
