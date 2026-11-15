/**
 * Void glass: what the hands are made of (style bible, sections 4 and 6.4).
 *
 * A hand is an apparition, not a glove. Its body is night, but a veil of it
 * and not a wall: the room is seen through the middle of it, more of the
 * room while the hand waits and less when it acts, and never through its
 * edges. It is most itself in its fingers, and there is less of it back
 * along the limb. Round it runs one thin drawn line in the player's colour,
 * the same width whatever the distance, with a slow pulse of light
 * travelling from the wrist to the fingertips. Just inside the line the same
 * light hugs the edge and is gone a little way in; just outside it, a halo
 * that is given off in tongues that climb, like flame. What is seen through
 * the dark is a place beyond the hand: a slow smoke with no points of light
 * in it (a cold mist that hangs for Void, candle smoke that rises for
 * Ivory), which stays where it is while the hand moves across it; and a
 * current of the hand's own light that runs in it out to the fingertips,
 * where a hand at work holds it. Nothing is reflected in the hand: it has
 * no surface for the room to shine on. The cord and the plumb weight are no
 * more of this world than the hand is.
 * The forearm runs on from the cord as wide as an arm is, and no end of it
 * is to be seen. A little way past the cord it begins to go, in long streaks
 * that drift down it as smoke is drawn off: first its line, and then the
 * dark itself, which is seen through more and more and is nothing well
 * before the skin stops (assets/src/hands.py). The smoke it goes in carries
 * a little of the hand's light along either side, so that it is as wide as
 * an arm for as long as anything of it is to be seen. Close to the eye,
 * where an arm fills much of the picture, it keeps its line as long as it
 * keeps its dark, and the line goes in the same streaks: so near, a dark
 * with no edge drawn round it would be a sheet of smoked glass in the shape
 * of a cone, not an arm. An eye that looks
 * along the arm from behind it, and would have the arm between it and the
 * hand, sees none of that: for it the hand comes out of nothing in wisps on
 * the way to the knuckles, with no wrist to stop at and no inside to look
 * into; the dark goes in those wisps a little before the line does, so
 * that what is left by the wrist is drawn, not a dark lump.
 *
 * A hand is drawn in up to six passes over the same skin:
 *   0. (full detail) its distance from the eye, into the small picture that
 *      silhouette.ts keeps, so that passes 3 and 4 can tell where its edge is;
 *   1. depth only, where there is enough of the dark to be a body, so that
 *      the hand has one surface however the fingers overlap;
 *   2. depth again wherever the hand is a veil, which pass 1 leaves out: set
 *      as far behind its skin as there is little of it there, so that the
 *      lens and the air, which go by depth, lose the hand as gradually as
 *      the eye does, and the room seen through it is as soft as the room
 *      round it;
 *   3. the veil itself, coloured only where it is the nearest surface and
 *      laid over what is behind it; and, in front of that, the forearm where
 *      it is going;
 *   4. (full detail) the halo: the skin turned inside out and pushed out a
 *      little way, lit by how near the hand's edge each point of it is;
 *   5. the line: the skin turned inside out and pushed out by a fixed number
 *      of pixels, so that only a rim of it shows past the body, and past any
 *      finger that lies in front of another part of the hand. Unlike a glow
 *      that depends on the viewing angle, this stays a line when a flat palm
 *      is seen edge-on.
 *
 * Four controls shape a hand's state. `uFill` is how solid the dark body is:
 * thinned, it is smoked glass that the board shows through, darker toward
 * its edges, and it keeps its lights. `uOutline` is how strong the line is.
 * `uEnergy` runs from a hand at rest (dim, slow) to one at work (bright,
 * quick). `uDissolve` takes the whole hand away, from the far end of its
 * forearm toward the fingertips, and brings it the other way.
 *
 * The mesh's `aData` attribute says where on the hand a vertex is; its
 * layout is described in assets/src/hands.py.
 */
import { AdditiveBlending, BackSide, Color, DoubleSide, MathUtils, Matrix4, NoBlending, ShaderMaterial, type Texture, Vector2, Vector3 } from 'three';
import type { Side } from '../core/game';
import type { HandMeta } from './rig';
import { SILHOUETTE_FAR } from './silhouette';

/**
 * Each side's light, in linear light: candle gold for Ivory, spirit teal for Void. They are more
 * saturated than the colours they come out as, because the picture's tone curve pales whatever is bright.
 * The two are as bright as each other to the eye (green counts for most of that, so the gold is
 * the larger number): which side's hands are the brighter says whose turn it is, and nothing else,
 * and the bloom takes hold of both alike wherever its threshold is set.
 */
export const RIM: Record<Side, Color> = {
  w: new Color(1.3, 0.62, 0.155),
  b: new Color(0.065, 1.0, 0.68),
};

/** What is seen through each side's hands: the colour of its smoke. Pale, as breath is: tallow smoke for Ivory, a cold mist for Void. */
const DEEP: Record<Side, Color> = {
  w: new Color(1.0, 0.56, 0.3),
  b: new Color(0.3, 0.72, 0.68),
};
/** The body itself: never neutral black (style bible, 3.3). */
const NIGHT: Record<Side, Color> = {
  w: new Color(0.0052, 0.0042, 0.0034),
  b: new Color(0.0026, 0.0048, 0.0044),
};
/** The cord and the plumb weight: old thread and dull metal, not light. */
const THREAD: Record<Side, Color> = {
  w: new Color(0.3, 0.165, 0.05),
  b: new Color(0.035, 0.2, 0.17),
};

export type HandDetail = 'low' | 'full';

/** How far past the wrist the forearm is whole, and how far short of its far end nothing is left of it, in squares. */
export const ARM_WHOLE_TO = 0.3;
export const ARM_GONE_BEFORE = 0.1;
/** The same for an eye that looks along the arm from behind it: whole to here, and nothing left this much farther on. */
export const NEAR_WHOLE_TO = 0.2;
export const NEAR_GONE_IN = 0.85;
/** Where along the forearm its own line is taken from, to tell where an eye is by it: just past the cord. */
export const ARM_FROM = 0.45;
/**
 * With less of the forearm left than this at a point, it is not a body there any longer: it has no
 * line and no lights, it is seen through, and it stands in front of nothing.
 */
const ARM_BODY = '0.72';
/**
 * The picture of the hands keeps the forearm a little longer than that, to this much left: where
 * the picture stops is an edge to whatever reads it, and no edge is wanted where the body stops.
 */
const ARM_SHAPE = '0.45';
/**
 * How large one square of the room looks at a point of a forearm, as a share of the height of the
 * picture, where the arm starts to be close to the eye, and where it is wholly so: about ten
 * squares away and about seven, through the usual lens. A close arm keeps its line as long as it
 * keeps its dark (`armLined`). Every camera that shows the whole board stands farther off than the
 * first; the eyes and the shoulder have a working hand's arm well inside it, or coming toward them
 * (`TOWARD_FROM`).
 */
export const CLOSE_FROM = 0.135;
export const CLOSE_TO = 0.19;

/** How large one square looks that far from the eye, as a share of the height of the picture, through a lens that takes in so many degrees from top to bottom. */
export function squareShare(distance: number, fov: number): number {
  return 1 / (2 * Math.max(distance, 1e-4) * Math.tan(MathUtils.degToRad(fov) / 2));
}

/**
 * An arm that comes toward the eye is seen as a cone, its far end nearer and wider than the wrist,
 * from however far off: it keeps its line as a close arm does. The cosine of the angle between the
 * arm's way and the way to the eye where it starts to count, and where it counts wholly. (Nearer
 * still to its line the eye is behind the arm, and sees none of it past the cord: `BEHIND_BEYOND`.)
 * An eye that looks across the board sees every arm run across or away from it.
 */
export const TOWARD_FROM = 0.45;
export const TOWARD_TO = 0.75;

/** How nearly the arm runs toward the eye, 0 to 1, from the arm's own line in the room as `eyeBehindArm` takes it. The same sum as `towardArm` in the shader. */
export function eyeAlongArm(eye: Vector3, from: Vector3, way: Vector3): number {
  const x = eye.x - from.x;
  const y = Math.abs(eye.y) - from.y;
  const z = eye.z - from.z;
  const lined = (x * way.x + y * way.y + z * way.z) / Math.max(Math.hypot(x, y, z), 1e-4);
  return MathUtils.smoothstep(lined, TOWARD_FROM, TOWARD_TO);
}

/** How close to the eye a point of a forearm is, 0 to 1, by how large a square looks there (`squareShare`) and how nearly the arm comes toward the eye (`eyeAlongArm`). The same sum as `armClose` in the shader. */
export function armCloseness(share: number, toward = 0): number {
  return Math.max(MathUtils.smoothstep(share, CLOSE_FROM, CLOSE_TO), toward);
}

/** How much of its dark the forearm has at a point with so much of it left, seen squarely from outside: the same sum as the start of `armThere` in the shader. */
export function armShade(left: number): number {
  if (left >= Number(ARM_BODY)) return 1;
  const there = Math.sqrt(MathUtils.clamp(left / Number(ARM_BODY), 0, 1));
  return there * there * (3 - 2 * there);
}

/**
 * How far the pushed-out skin of a close arm may be turned away from the eye (the cosine of its
 * facing, away) and still carry the longer line, all of it and none.
 */
export const RIM_TURNED: readonly [number, number] = [0.15, 0.4];

/**
 * How much of the line is drawn along the forearm with so much of it left, as close to the eye as
 * `close` says, on skin turned so far away from the eye (`away`, 0 at the edge as seen): the same
 * sum as `armLined` in the shader.
 */
export function armLine(left: number, close: number, away = 0): number {
  const edged = MathUtils.smoothstep(left, Number(ARM_BODY), 0.95);
  const rim = 1 - MathUtils.smoothstep(away, RIM_TURNED[0], RIM_TURNED[1]);
  return Math.max(edged, MathUtils.clamp(close, 0, 1) * armEdgeShade(left) * rim);
}

/** How much of its dark the forearm has at its edge as seen, where the eye looks along the skin, with so much of it left: the same sum as `armThere` there (and as the start of `armLined`). */
export function armEdgeShade(left: number): number {
  return armShade(left) ** 4;
}

/**
 * For an eye behind the arm, how far toward the eye's end of the hand a point is when its line is
 * gone, and when its dark is: the dark starts to go first and is gone first, so that the line is
 * always round whatever dark is left. In squares along the limb from the cord, before the wisps.
 */
export const OPEN_LINE: readonly [number, number] = [-0.35, 0.3];
export const OPEN_DARK: readonly [number, number] = [-0.45, 0.2];

/** How much of the line (`OPEN_LINE`) or of the dark (`OPEN_DARK`) is left at `along` on the limb, plus its wisp, for an eye so far behind the arm: the same sums as `openEnd` and `shown`. */
export function openTo(span: readonly [number, number], along: number, behind: number): number {
  return 1 - MathUtils.smoothstep(MathUtils.clamp(behind, 0, 1), 0, 0.6) * MathUtils.smoothstep(along, span[0], span[1]);
}
/**
 * For the lens and the air, which go by how far away a thing is, the forearm where it is seen
 * through is behind its own skin: no way behind with all of the dark there, this far with half
 * of it there, in squares, and as far as can be with none.
 */
const VEIL_BACK = '8.0';
/**
 * With at least this much of the dark at a point, the hand is a body there and stands where its
 * skin is; with less, it is a veil, and is set back as the forearm is where it is going.
 */
const SOLID = '0.85';
/** And with no more of the dark than this, it is as good as the room behind it to the lens and the air. */
const THIN = '0.62';

export interface HandUniforms {
  uRim: { value: Color };
  uDeep: { value: Color };
  uNight: { value: Color };
  uThread: { value: Color };
  /** 0 for a cold mist that hangs, 1 for candle smoke that rises. */
  uWarm: { value: number };
  uFill: { value: number };
  uOutline: { value: number };
  /** 0 at rest to 1 at work. */
  uEnergy: { value: number };
  uTime: { value: number };
  /** 0 whole to 1 gone. */
  uDissolve: { value: number };
  /** Where past the wrist the forearm begins to thin, and how far on from there nothing is left of it, in squares. */
  uWrist: { value: Vector2 };
  /** A point on the forearm's own line just past the cord, in the room, and the way the arm runs on from there. */
  uArmFrom: { value: Vector3 };
  uArmWay: { value: Vector3 };
  /** Takes a point of the room to where it is on the forearm's resting skin: `Hand.armToWorld` the other way. */
  uArmRest: { value: Matrix4 };
  /** How many times as wide as it is deep the forearm is. */
  uArmFlat: { value: number };
  /** Makes each hand's pulse, and the streaks its forearm thins in, its own. */
  uSeed: { value: number };
  /** The line's width in pixels, and the distance from the eye at which it is exactly that wide. */
  uLine: { value: Vector2 };
  /** The size of the picture in pixels. */
  uViewport: { value: Vector2 };
  /** The picture of how far away the hands are (silhouette.ts). Read only at full detail. */
  uShape: { value: Texture | null };
}

export type HandMaterial = ShaderMaterial & { uniforms: HandUniforms };

/** How far in from its edge a hand's inner light reaches, and how far out its halo does, in squares. */
const BAND = '0.05';
const HALO_REACH = '0.13';
/** A step in distance bigger than this, from one point of the picture to the next, is an edge and not a slope. */
const LEAP = '0.035';
/** A fall in the skin shallower than this is a fold in it, not an edge. */
const FOLD = '0.12';
/** How far behind the body its pushed-out skin is set, as a share of its distance from the eye. */
const SET_BACK = '0.003';

/**
 * Nothing in these shaders may come out as not a number. The bloom takes one such pixel and
 * spreads it over the whole picture, for as long as the hand is drawn; and a value carried from
 * the corners of a triangle can be read a hair outside it, where it is not what any corner said.
 * So: a direction is made with `unit`, which has an answer where there is no direction; a
 * divisor that might be nothing goes through `divisor`; and a power is taken of nothing below zero.
 */
const SOUND = /* glsl */ `
  vec3 unit( vec3 v, vec3 otherwise ) {
    float size = length( v );
    return size > 1e-6 ? v / size : otherwise;
  }
  float divisor( float w ) {
    return abs( w ) > 1e-6 ? w : 1e-6;
  }`;

/** An eye within the first of these angles of an arm's line is behind it, and one beyond the second is not at all. In radians. */
const BEHIND_WITHIN = 0.15;
const BEHIND_BEYOND = 0.45;
/**
 * And so is an eye that the arm itself comes this near to, in squares, whatever the angle: the eye
 * at a player's shoulder, which the arm on that side runs back past.
 */
const BEHIND_NEAR = 3.0;
const BEHIND_FAR = 4.0;

/**
 * An eye that is behind an arm and looks along it has the arm between it and the hand, and sees
 * the arm end-on: the inside of a wide sleeve, as big as the hand is, with the fingers showing
 * under it. So for that eye the forearm thins away just past the cord (`leftAt`), with no line
 * drawn round what is left of it (`openEnd`), and the hand is seen. An eye that the arm passes
 * close by is no better placed, at any angle: the arm runs out of the picture beside it, as wide
 * as the picture is, and what it looks down into is the same sleeve. `behindArm` says how nearly
 * behind the arm the eye is, from 0 to 1; an eye anywhere else sees the arm as it is.
 */
const BEHIND = /* glsl */ `
  uniform vec3 uArmFrom;
  uniform vec3 uArmWay;
  uniform vec2 uWrist;
  float behindArm() {
    // The eye under the board, whose view the dark squares mirror, stands for the eye above it, and must see the same arm.
    vec3 toEye = vec3( cameraPosition.x, abs( cameraPosition.y ), cameraPosition.z ) - uArmFrom;
    float lined = dot( toEye, uArmWay ) / max( length( toEye ), 1e-4 );
    float along = 1.0 - smoothstep( ${BEHIND_WITHIN.toFixed(2)}, ${BEHIND_BEYOND.toFixed(2)}, acos( clamp( lined, -1.0, 1.0 ) ) );
    // How near the eye is to the arm's own line, anywhere from just past the cord to its far end.
    float reach = clamp( dot( toEye, uArmWay ), 0.0, max( uWrist.x + uWrist.y + ${(ARM_GONE_BEFORE - ARM_FROM).toFixed(2)}, 0.0 ) );
    float near = 1.0 - smoothstep( ${BEHIND_NEAR.toFixed(1)}, ${BEHIND_FAR.toFixed(1)}, length( toEye - uArmWay * reach ) );
    return max( along, near );
  }
  /** How nearly the arm runs from the cord toward the eye, 0 to 1. (See eyeAlongArm.) */
  float towardArm() {
    vec3 toEye = vec3( cameraPosition.x, abs( cameraPosition.y ), cameraPosition.z ) - uArmFrom;
    float lined = dot( toEye, uArmWay ) / max( length( toEye ), 1e-4 );
    return smoothstep( ${TOWARD_FROM.toFixed(2)}, ${TOWARD_TO.toFixed(2)}, lined );
  }`;

/**
 * The same sum as `behindArm`, for whoever has to know outside the shader what an eye sees of an
 * arm: `from` and `way` are the arm's own line in the room (`uArmFrom`, `uArmWay`), and `long` is
 * how far along that line the arm runs.
 */
export function eyeBehindArm(eye: Vector3, from: Vector3, way: Vector3, long: number): number {
  const x = eye.x - from.x;
  const y = Math.abs(eye.y) - from.y;
  const z = eye.z - from.z;
  const ahead = x * way.x + y * way.y + z * way.z;
  const lined = ahead / Math.max(Math.hypot(x, y, z), 1e-4);
  const along = 1 - MathUtils.smoothstep(Math.acos(MathUtils.clamp(lined, -1, 1)), BEHIND_WITHIN, BEHIND_BEYOND);
  const reach = MathUtils.clamp(ahead, 0, Math.max(long, 0));
  const near = 1 - MathUtils.smoothstep(Math.hypot(x - way.x * reach, y - way.y * reach, z - way.z * reach), BEHIND_NEAR, BEHIND_FAR);
  return Math.max(along, near);
}

/**
 * `SWELL` is defined for the passes that push the skin outward on the screen: by the line's width,
 * or with `HALO` by the halo's.
 */
const VERTEX = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  ${SOUND}
  ${BEHIND}
  attribute vec4 aData;
  uniform vec2 uLine;
  uniform vec2 uViewport;
  varying vec3 vViewNormal;
  varying vec3 vViewPosition;
  varying vec4 vData;
  varying vec3 vRest;
  varying vec3 vWorld;
  varying vec2 vScreen;
  varying float vPixel;
  varying float vReach;
  varying float vBehind;
  varying float vToward;
  void main() {
    #include <skinbase_vertex>
    #include <beginnormal_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    // Where it is in the room, and which way it faces there.
    vec3 world = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    vec3 facing = mat3( modelMatrix ) * objectNormal;
    vBehind = behindArm();
    vToward = towardArm();
    vec4 mvPosition = viewMatrix * vec4( world, 1.0 );
    vViewNormal = unit( mat3( viewMatrix ) * facing, vec3( 0.0, 0.0, 1.0 ) );
    gl_Position = projectionMatrix * mvPosition;
    // Which way is outward on the screen, measured there so that it is as true at the edge of
    // the picture as in the middle of it. In pixels, and not yet of any particular length.
    vec4 ahead = projectionMatrix * vec4( mvPosition.xyz + vViewNormal * 0.02, 1.0 );
    vScreen = ( ahead.xy / divisor( ahead.w ) - gl_Position.xy / divisor( gl_Position.w ) ) * uViewport;
    float range = max( 0.5, -mvPosition.z );
    // How much of the room one pixel covers at this distance.
    vPixel = range * 2.0 / max( abs( projectionMatrix[ 1 ][ 1 ] ) * uViewport.y, 1e-4 );
    vReach = 0.0;
    #ifdef SWELL
      // The pushed-out skin is set a little farther from the eye than the body. Where skin lies
      // folded against skin it would otherwise come through in threads along the folds. Set
      // back, it shows only past the body's edge, and a finger still gets its line wherever it
      // stands clear of what is behind it.
      float back = ${SET_BACK};
      #ifdef HALO
        // The halo is a part of the hand, so it is sized in the room; but it is never lost to distance.
        vReach = max( ${HALO_REACH} / vPixel, 5.0 );
      #else
        // A little wider close to the eye and a little finer far from it: it is a line in the room, not on the lens.
        vReach = uLine.x * clamp( pow( max( uLine.y / range, 0.0 ), 0.45 ), 0.75, 1.6 );
      #endif
      // Moved along the line of sight, and put through the whole projection: the eye under the
      // board, whose view the dark squares mirror, does not measure depth the usual way.
      vec4 moved = projectionMatrix * vec4( mvPosition.xyz * ( 1.0 + range * back / max( 1e-4, -mvPosition.z ) ), 1.0 );
      gl_Position.z = moved.z / divisor( moved.w ) * gl_Position.w;
      gl_Position.xy += vScreen / max( length( vScreen ), 1e-5 ) * ( 2.0 * vReach / uViewport ) * gl_Position.w;
    #endif
    vViewPosition = -mvPosition.xyz;
    vData = aData;
    vRest = position;
    vWorld = world;
  }`;

/** Past this much gone, the body has ended; past the second, so has the line. */
const BODY_END = '0.5';
const LINE_END = '0.92';

const SHARED = /* glsl */ `
  #include <packing>
  ${SOUND}
  uniform vec3 uRim;
  uniform float uFill;
  uniform float uOutline;
  uniform float uEnergy;
  uniform float uTime;
  uniform float uDissolve;
  uniform float uSeed;
  uniform vec2 uViewport;
  uniform vec2 uWrist;
  uniform mat4 uArmRest;
  uniform float uArmFlat;
  varying vec3 vViewNormal;
  varying vec3 vViewPosition;
  varying vec4 vData;
  varying vec3 vRest;
  varying vec3 vWorld;
  varying vec2 vScreen;
  varying float vPixel;
  varying float vReach;
  varying float vBehind;
  varying float vToward;

  float hash13( vec3 p ) {
    p = fract( p * 0.1031 );
    p += dot( p, p.zyx + 31.32 );
    return fract( ( p.x + p.y ) * p.z );
  }
  vec3 hash33( vec3 p ) {
    p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
    p += dot( p, p.yxz + 33.33 );
    return fract( ( p.xxy + p.yxx ) * p.zyx );
  }
  float noise3( vec3 p ) {
    vec3 i = floor( p );
    vec3 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix(
      mix( mix( hash13( i ), hash13( i + vec3( 1, 0, 0 ) ), f.x ), mix( hash13( i + vec3( 0, 1, 0 ) ), hash13( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
      mix( mix( hash13( i + vec3( 0, 0, 1 ) ), hash13( i + vec3( 1, 0, 1 ) ), f.x ), mix( hash13( i + vec3( 0, 1, 1 ) ), hash13( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
      f.z );
  }
  /**
   * How much of the forearm is left at a point of its resting skin: all of it on the hand and to
   * a little way past the cord, then less and less, in long streaks that drift slowly down the
   * arm, and nothing before the skin stops. For an eye behind the arm it is gone just past the cord.
   */
  float leftAt( vec3 p, float behind ) {
    float along = ( p.z - mix( uWrist.x, ${NEAR_WHOLE_TO.toFixed(2)}, behind ) ) / max( mix( uWrist.y, ${NEAR_GONE_IN.toFixed(2)}, behind ), 1e-4 );
    if ( along <= 0.0 ) return 1.0;
    if ( along >= 1.0 ) return 0.0;
    vec3 q = vec3( p.xy * 2.4, p.z * 0.45 - uTime * 0.13 ) + uSeed * 5.1;
    float streaks = noise3( q ) * 0.75 + noise3( q * vec3( 2.6, 2.6, 2.1 ) + 1.9 ) * 0.25;
    float thinned = along + ( streaks - 0.5 ) * 0.5 * smoothstep( 0.0, 0.2, along );
    return ( 1.0 - smoothstep( 0.0, 1.0, thinned ) ) * ( 1.0 - smoothstep( 0.7, 1.0, along ) );
  }
  /**
   * Where the line of sight through a point on the far side of the arm came in through the near
   * side of it, on the resting skin. (Drawn out in depth until it is as deep as it is wide, the
   * arm is as good as a round pipe; and the part of a line that lies inside a round pipe has its
   * middle where the line passes nearest the middle of the pipe.) The point itself, where the
   * line of sight has not yet passed the middle of the arm.
   */
  vec3 nearSide( vec3 p ) {
    vec3 fit = vec3( 1.0, max( uArmFlat, 0.1 ), 1.0 );
    vec3 eye = ( uArmRest * vec4( cameraPosition, 1.0 ) ).xyz * fit;
    vec3 here = p * fit;
    vec3 way = here - eye;
    float range = length( way );
    if ( range < 1e-4 ) return p;
    way /= range;
    float past = range + dot( way.xy, eye.xy ) / max( 1.0 - way.z * way.z, 1e-3 );
    if ( past <= 0.0 ) return p;
    return ( here - way * ( 2.0 * past ) ) / fit;
  }
  /**
   * How much of the forearm is left at this point. The arm goes by its outside, the side of it
   * that the eye is on: what faces away from the eye (the inside of the far side, and the skin
   * that the line and the halo push out from there) has left what the near side has left on the
   * same line of sight, so that the far side is never seen, or drawn round, through a near side
   * that is going. Only an eye behind the arm looks into it, and for that eye each side goes by
   * itself; so do the hand and the wrist for every eye, since they are no pipe to be seen through.
   */
  float armLeft() {
    float behind = clamp( vBehind, 0.0, 1.0 );
    float own = leftAt( vRest, behind );
    if ( own <= 0.0 ) return 0.0;
    // Not on the hand, which is no pipe, nor on the wrist, nor for a little way past the cord:
    // an eye that looks into the arm from behind finds it closed by the dark inside the hand,
    // not open to the board beyond. (And the farther behind the arm the eye is, the more of the
    // inside it has.)
    float beyond = ( 1.0 - behind ) * smoothstep( 0.3, 1.0, vRest.z );
    #ifndef SWELL
      if ( gl_FrontFacing ) beyond = 0.0;
    #endif
    if ( beyond <= 0.0 ) return own;
    float front = leftAt( nearSide( vRest ), behind );
    // Where the near side is taken to be is only near enough: sooner too little left than too much.
    float less = 1.0 - min( ( 1.0 - front ) * 2.2, 1.0 );
    #ifdef SWELL
      // The pushed-out skin all faces away. At the very edge of what is seen, where the two sides
      // of the arm are one, it is the line, and has left what is left there; only farther in
      // from that edge is anything taken off for safety.
      float away = -dot( unit( vViewNormal, vec3( 0.0, 0.0, 1.0 ) ), unit( vViewPosition, vec3( 0.0, 0.0, 1.0 ) ) );
      front = mix( front, less, smoothstep( 0.3, 0.6, away ) );
    #else
      front = less;
    #endif
    return mix( own, min( own, front ), beyond );
  }
  /** Past this much of the forearm gone, it has no edge: no line round it, no light along it, no halo. */
  float armEdged( float left ) {
    return smoothstep( ${ARM_BODY}, 0.95, left );
  }
  /**
   * An eye behind the arm looks along it into the wrist, and whatever stopped there would be a
   * lid, or the mouth of a glove. So for that eye the hand does not stop: it comes out of nothing
   * on the way from the eye to the knuckles, in wisps. How far a point is toward the eye's end of
   * that, by where it is along the limb: the same slow wisps for all that goes by it.
   */
  float towardEye( float from, float to ) {
    vec3 q = vec3( vRest.xy * 2.4, vRest.z * 0.7 - uTime * 0.1 ) + uSeed * 5.1;
    return smoothstep( from, to, vRest.z + ( noise3( q ) - 0.5 ) * 0.5 );
  }
  /**
   * For an eye behind the arm, the hand by its wrist has no line round it, no halo and no light
   * on its skin: where it stops is not an edge of the hand. 1 where there is an edge to draw.
   */
  float openEnd() {
    return 1.0 - smoothstep( 0.0, 0.6, clamp( vBehind, 0.0, 1.0 ) ) * towardEye( ${OPEN_LINE[0].toFixed(2)}, ${OPEN_LINE[1].toFixed(2)} );
  }
  /**
   * How close to the eye this point of the hand is, 0 to 1, by how large a square of the room looks
   * there (\`vPixel\` is how much of the room one pixel covers); or by how nearly its arm comes toward
   * the eye, which makes a cone of an arm seen from any way off. (See armCloseness, eyeAlongArm.)
   */
  float armClose() {
    return max( smoothstep( ${CLOSE_FROM.toFixed(3)}, ${CLOSE_TO.toFixed(3)}, 1.0 / max( vPixel * uViewport.y, 1e-4 ) ), vToward );
  }
  /** How much of the dark the forearm has where so much of it is left, seen squarely from outside: all of it while the arm is a body, and none with nothing left. */
  float armShade( float left ) {
    if ( left >= ${ARM_BODY} ) return 1.0;
    float there = sqrt( clamp( left / ${ARM_BODY}, 0.0, 1.0 ) );
    return there * there * ( 3.0 - 2.0 * there );
  }
  /**
   * How much of the line is drawn round the forearm where so much of it is left. Away from the eye
   * the line goes first, and the dark after it. Close to the eye the arm is as wide as much of the
   * picture, and the dark left without an edge would be a sheet of smoked glass: there the line
   * lasts as long as the dark does, and goes in the same streaks. (For the pushed-out skin of the
   * line. That longer line is only where the skin lies along the eye's line of sight, at the edge
   * of the arm as it is seen: where the near side of the arm is going, the inside of its far side
   * is in plain sight, turned away from the eye, and that is no edge.)
   */
  float armLined( float left ) {
    float away = -dot( unit( vViewNormal, vec3( 0.0, 0.0, 1.0 ) ), unit( vViewPosition, vec3( 0.0, 0.0, 1.0 ) ) );
    float rim = 1.0 - smoothstep( ${RIM_TURNED[0].toFixed(2)}, ${RIM_TURNED[1].toFixed(2)}, away );
    // As much as there is of the dark at the arm's edge as seen, which is less than in the middle
    // of it (see armThere): a line brighter than that would be a beam of light, not an edge.
    float shade = armShade( left );
    shade *= shade;
    return max( armEdged( left ), armClose() * shade * shade * rim );
  }
  /**
   * How much of the dark is there at a point of the forearm with so much of it left, seen from
   * \`outside\` (1) or from within (0), and squarely (\`ndv\` 1) or along the skin (0). All of it
   * while the arm is a body.
   */
  float armThere( float left, float outside, float ndv ) {
    if ( left >= ${ARM_BODY} ) return 1.0;
    float behind = clamp( vBehind, 0.0, 1.0 );
    float there = armShade( left );
    // The inside of it is for an eye behind the arm, which looks into the wrist; any other has
    // only so much of the inside as keeps where it stops from being a hard edge, should it ever
    // be seen. And it is there to close an arm that is solid. One thinned to smoked glass is
    // seen through wherever the eye looks, and its inside would only be a second pane of the
    // same glass: the wrist of a hand in thought would be darker than the hand.
    there *= mix( mix( behind, 1.0, there * there * there ) * smoothstep( 0.6, 0.95, uFill ), 1.0, outside );
    // The less of it there is, the more it is smoke and the less glass: thickest where the eye
    // looks through the middle of it, and with no edge of its own. (From outside. What is seen
    // from within is the dark inside the arm, and that is as thick as it is.)
    there *= mix( 1.0, mix( ndv * ndv, 1.0, there * there * there ), outside );
    return there;
  }
  /**
   * A hand is most itself in its fingers. Toward the wrist there is less of it, and at the cord it
   * is already half way to the smoke its forearm is: 1 in the fingers, less back along the limb.
   */
  float limb() {
    return 1.0 - 0.3 * smoothstep( -1.3, 0.9, vRest.z );
  }
  /**
   * The inside of the skin is nothing to an apparition: it is drawn only for an eye behind the
   * arm, which looks in at the wrist and would otherwise see the room through the hand. How much
   * of a point is to be drawn at all: all of the outside, and of the inside so much.
   */
  float shown( float outside ) {
    float behind = clamp( vBehind, 0.0, 1.0 );
    // (And for that eye the outside is not all there by the wrist either: see towardEye. It goes in
    // the same wisps as the line, a little before it, so that the line is round what is left.)
    if ( outside > 0.5 ) return 1.0 - smoothstep( 0.0, 0.6, behind ) * towardEye( ${OPEN_DARK[0].toFixed(2)}, ${OPEN_DARK[1].toFixed(2)} );
    return 0.0;
  }
  /**
   * How much of the dark there is at a point: the body is a veil, not a wall. The room is seen
   * through the middle of it, more of the room while the hand waits and less when it acts, and
   * never through its edges; there is less of it back along the limb, and less again where the
   * forearm is going (\`left\`). Slow billows of thicker and thinner dark go through it, as
   * through anything made of smoke.
   */
  float darkAt( float left, float outside, float ndv ) {
    float billow = noise3( vec3( vRest.xy * 1.7, vRest.z * 1.1 - uTime * 0.09 ) + uSeed * 2.9 );
    float veil = mix( 0.58, 0.82, clamp( uEnergy, 0.0, 1.0 ) ) * ( 0.84 + 0.32 * billow ) * limb();
    float fill = clamp( uFill, 0.0, 1.0 );
    // Thick along its edges, where the eye looks along the skin: but not round the forearm for an
    // eye behind it, which looks along the whole of that skin and would see the mouth of a sleeve.
    float edged = outside * ( 1.0 - clamp( vBehind, 0.0, 1.0 ) * smoothstep( 0.0, 0.3, vRest.z ) );
    veil = mix( min( veil, 1.0 ) * fill, 1.0, mix( 0.6, 0.85, fill ) * pow( max( 1.0 - ndv, 0.0 ), 1.5 ) * step( 0.004, fill ) * edged );
    return clamp( veil * armThere( left, outside, ndv ) * shown( outside ), 0.0, 1.0 );
  }
  /**
   * How far behind its own skin a point with so much of the dark is, in squares, for the lens and
   * the air: they go by how far away a thing is, and cannot be told that a thing is half there.
   * No way behind where the hand is a body, and as far as can be well before there is nothing
   * there: what is seen through a thin veil is mostly the room, and has to be as soft as the room
   * round it is, or the hand is a window with the room sharp in it.
   */
  float setBack( float there ) {
    float share = clamp( ( there - ${THIN} ) / ( ${SOLID} - ${THIN} ), 0.0, 1.0 );
    return ${VEIL_BACK} * ( 1.0 - share ) / max( share, 0.02 );
  }
  /**
   * How far gone the hand is at this point when the whole of it is sent away, from the far end
   * of its forearm toward the fingertips. Below ${BODY_END} the body is whole; from there to ${LINE_END} only its line
   * and a few strokes are left; past that, nothing. (stage.ts sheds motes where the body ends,
   * and does the same sum to find the place.)
   */
  float vanish() {
    if ( uDissolve < 0.001 ) return 0.0;
    vec3 q = vec3( vRest.xy * 3.3, vRest.z * 0.75 - uTime * 0.11 ) + uSeed * 7.3;
    float tongues = noise3( q ) * 0.7 + noise3( q * vec3( 2.3, 2.3, 1.9 ) + 3.7 ) * 0.3 - 0.5;
    return uDissolve * 2.2 - vData.g * 0.95 + tongues * 0.5 * smoothstep( 0.0, 0.12, uDissolve );
  }
  /** The pulse of light that runs from the wrist to the fingertips, slowly at rest and quicker at work: 0 to 1. */
  float pulse() {
    float beat = sin( 6.2832 * ( vData.g * 1.6 - uTime * ( 0.22 + 0.24 * uEnergy ) ) + uSeed );
    return smoothstep( 0.3, 1.0, beat );
  }`;

/** Reading the picture that silhouette.ts keeps. */
const SHAPE = /* glsl */ `
  uniform sampler2D uShape;
  /** How far away the nearest hand is at a point of the picture, in squares; as far as can be where there is none. */
  float shapeDepth( vec2 uv ) {
    return unpackRGBAToDepth( texture2D( uShape, uv ) ) * ${SILHOUETTE_FAR.toFixed(1)};
  }`;

/** What the frame keeps as the depth of a point on this line of sight, that far from the eye. */
const DEPTH_AT = /* glsl */ `
  uniform mat4 projectionMatrix;
  float depthAt( float distance ) {
    vec4 clip = projectionMatrix * vec4( -vViewPosition * ( distance / max( vViewPosition.z, 1e-4 ) ), 1.0 );
    return clamp( 0.5 * clip.z / divisor( clip.w ) + 0.5, 0.0, 1.0 );
  }`;

/**
 * Pass 1 needs to know only where there is still something to stand in front of. With `SHAPE`
 * it is pass 0 instead, and writes down how far away the body is; with `VEIL` it is pass 2, and
 * says how far the eye sees into the forearm where it is going.
 */
const DEPTH = /* glsl */ `
  ${SHARED}
  #ifdef VEIL
    ${DEPTH_AT}
  #endif
  void main() {
    if ( max( uFill, uOutline ) < 0.02 ) discard;
    float left = armLeft();
    float gone = vanish();
    #ifdef SHAPE
      // The picture is of the body proper: where only the drawing of it is left it has no edge to
      // speak of, and nor has a forearm where it is going.
      if ( left < ${ARM_SHAPE} || gone > ${BODY_END} ) discard;
      gl_FragColor = packDepthToRGBA( clamp( vViewPosition.z / ${SILHOUETTE_FAR.toFixed(1)}, 0.0, 0.99999 ) );
    #else
      float outside = gl_FrontFacing ? 1.0 : 0.0;
      vec3 v = unit( vViewPosition, vec3( 0.0, 0.0, 1.0 ) );
      float ndv = clamp( dot( unit( vViewNormal, v ) * ( outside * 2.0 - 1.0 ), v ), 0.0, 1.0 );
      float there = darkAt( left, outside, ndv );
      #ifndef THIN
        // Without the picture of the hands to go by, the line is kept off the body by the body's
        // standing in front of it: so the whole of the body stands where its skin is, veil or not,
        // and only the forearm where it is going is set back.
        there = left < ${ARM_BODY} ? min( there, 0.99 * ${SOLID} ) : 1.0;
      #endif
      #ifdef VEIL
        // Wherever the hand is a veil, and nothing else of it. The lens and the air go by how
        // far away a thing is, and cannot be told that a thing is half there: so the skin is set
        // back behind itself by as much as there is little of the dark, from no way at all where
        // the hand is a body to out of the room where nothing is left of it. They are shown no
        // place where the hand stops; what they are given grows deeper as evenly as the dark
        // grows thin. (Glass that was half there and still stood in front of the room would
        // leave the room sharp and clear behind it in the middle of the lens's blur, the shape of
        // a hand. And never nearer than the skin, by more than the skin slopes across one point
        // of the picture: pass 3 is in front of this wherever it draws.)
        if ( gone > ${BODY_END} || there >= ${SOLID} || there < 0.004 ) discard;
        float slope = min( 2.0 * fwidth( vViewPosition.z ), 0.5 ) + 0.01;
        gl_FragDepth = depthAt( vViewPosition.z + slope + setBack( there ) );
      #else
        // Where the hand is a body it stands in front of what is behind it; and so does the
        // drawing of it that is left for a moment when the body has gone.
        #ifdef THIN
          if ( gone > ${LINE_END} || shown( outside ) < 0.01 ) discard;
        #else
          // (Without the picture of the hands, what keeps the line off the far side of the hand,
          // for an eye behind the arm that looks in at the wrist, is the inside of the skin
          // standing in front of it there: drawn or not.)
          if ( gone > ${LINE_END} || ( outside < 0.5 && ( vBehind < 0.01 || vRest.z > 0.45 ) ) ) discard;
        #endif
        if ( gone > ${BODY_END} ? left < ${ARM_BODY} : there < ${SOLID} ) discard;
      #endif
      gl_FragColor = vec4( 0.0 );
    #endif
  }`;

const GLASS = /* glsl */ `
  ${SHARED}
  uniform vec3 uDeep;
  uniform vec3 uNight;
  uniform vec3 uThread;
  uniform float uWarm;

  #ifdef EDGES
    ${SHAPE}
    /**
     * How near the edge of the hand is, as the eye sees it: 1 on the edge, 0 a band's width in
     * from it. It walks outward across the picture the way the skin faces, and stops where the
     * hand does: where what is seen steps away to something farther. A slope is not a step, so
     * a flat palm seen from the side stays dark; and a finger lying over the palm has an edge
     * though the palm is behind it.
     */
    float nearEdge( float ndv ) {
      float reach = max( ${BAND} / max( vPixel, 1e-5 ), 3.0 );
      vec2 way = vScreen * ( gl_FrontFacing ? 1.0 : -1.0 );
      float steep = length( way );
      if ( steep < 1e-4 ) return 0.0;
      vec2 pace = way / ( steep * uViewport );
      vec2 here = gl_FragCoord.xy / uViewport;
      float stride = reach / 6.0;
      float last = vViewPosition.z;
      // What one stride along a surface that simply carries on would add to the distance.
      float rise = stride * vPixel * min( sqrt( max( 1.0 - ndv * ndv, 0.0 ) ) / max( ndv, 0.1 ), 4.0 );
      float lo = 0.0;
      float hi = -1.0;
      float drop = 0.0;
      for ( int i = 1; i <= 6; i ++ ) {
        float r = stride * float( i );
        float jump = shapeDepth( here + pace * r ) - last;
        // Skin that curves away from the eye falls off faster with every stride, and fastest just
        // before its own edge: only a fall well past the last one, and deep enough to be an edge
        // at all, is a step.
        float leap = ${LEAP} + 3.0 * max( rise, 0.0 );
        if ( jump > leap && jump > ${FOLD} ) { hi = r; drop = jump; break; }
        // Something much nearer lies across the way: whatever edge there is, is behind it.
        // (A little nearer is only a ripple in the skin.)
        if ( jump < -( leap + 0.06 ) ) return 0.0;
        rise = jump;
        last += jump;
        lo = r;
      }
      if ( hi < 0.0 ) return 0.0;
      // Twice more, between the last point that was still on the skin and the first that was not.
      for ( int k = 0; k < 2; k ++ ) {
        float mid = 0.5 * ( lo + hi );
        float jump = shapeDepth( here + pace * mid ) - last;
        if ( jump > 0.5 * drop ) hi = mid;
        else { lo = mid; last += jump; }
      }
      // Past the hand's own outline there is nothing for a long way. An edge with more hand
      // behind it counts only if that is well behind: a fold in the skin is not an edge.
      float standing = drop > 40.0 ? 1.0 : smoothstep( ${FOLD}, 0.3, drop );
      return ( 1.0 - 0.5 * ( lo + hi ) / reach ) * standing;
    }
  #endif

  /** Fine parallel strokes where planes through the hand cut its skin, a pixel or so wide whatever the distance. */
  float strokes( vec3 direction, float spacing ) {
    float u = dot( vRest, direction ) / spacing;
    float w = fwidth( u );
    float d = abs( fract( u ) - 0.5 ) / max( w, 1e-5 );
    // Strokes that would fall closer than a few pixels apart are left out, not smeared together.
    return ( 1.0 - smoothstep( 0.4, 1.1, d ) ) * ( 1.0 - smoothstep( 0.16, 0.34, w ) );
  }

  void main() {
    float outside = gl_FrontFacing ? 1.0 : 0.0;
    // Of what pass 1 kept, the nearest is all that gets past it; what it kept nothing of is not
    // here either.
    if ( max( uFill, uOutline ) < 0.02 ) discard;
    float gone = vanish();
    if ( gone > ${LINE_END} ) discard;
    // And in front of that there is only the forearm where it is going, which pass 1 left out
    // and pass 2 set back: seen through, by as much as there is little of it there.
    float left = armLeft();
    vec3 v = unit( vViewPosition, vec3( 0.0, 0.0, 1.0 ) );
    vec3 n = unit( vViewNormal, v ) * ( outside * 2.0 - 1.0 );
    float ndv = clamp( dot( n, v ), 0.0, 1.0 );
    float wane = armThere( left, outside, ndv );
    if ( wane < 0.004 ) discard;
    // (The inside of the skin is only for an eye behind the arm: see \`shown\`.)
    float inner = shown( outside );
    if ( inner < 0.01 ) discard;
    #ifdef EDGES
      // And only where it is the nearest of the hand that there is: behind a veil of its own
      // outside, the inside would be a second veil, and the wrist darker than the hand.
      if ( outside < 0.5 && vViewPosition.z > shapeDepth( gl_FragCoord.xy / uViewport ) + 0.02 + 2.0 * fwidth( vViewPosition.z ) ) discard;
    #endif

    // The light from overhead: the cord takes a little of it, and nothing else of the hand does.
    vec3 light = unit( ( viewMatrix * vec4( 0.07, 1.0, 0.1, 0.0 ) ).xyz, vec3( 0.0, 1.0, 0.0 ) );
    float lifted = max( dot( n, light ), 0.0 );

    // -- the cord ------------------------------------------------------------------
    // Thread, not light: it is jewellery, and must not compete with the line. Dark, twisted,
    // and bright only along the top of each turn where the light from overhead catches it.
    // (Half its thickness is sunk in the skin, and would show inside the wrist where that is open
    // to the eye. Its facing is the wrist's own, outward, and the wrist widens toward the arm: seen
    // from within, or as good as along the skin, it is skin from within.)
    if ( vData.a > 0.5 && dot( n, v ) < 0.15 ) outside = 0.0;
    else if ( vData.a > 0.5 ) {
      float kept = max( uFill, uOutline ) * ( 1.0 - smoothstep( 0.3, 0.6, uDissolve ) );
      if ( kept < 0.01 ) discard;
      float turn = atan( vRest.y, divisor( vRest.x ) ) * 44.0 + vRest.z * 250.0;
      float ply = 0.5 + 0.5 * sin( turn );
      // The twist is only drawn where there is room for it.
      ply = mix( 0.6, ply, 1.0 - smoothstep( 0.6, 1.6, fwidth( turn ) ) );
      // What binds an apparition is no more of this world than it is: dark thread with the hand's
      // own light caught along each turn of it, and no more solid than the wrist it is tied round.
      vec3 thread = uThread * ( 0.03 + 0.16 * lifted * lifted ) * ( 0.45 + 0.55 * ply );
      thread += uRim * ( 0.05 + 0.1 * uEnergy ) * ply * ply * ( 0.6 + 0.4 * pulse() );
      thread += uRim * pow( max( 1.0 - ndv, 0.0 ), 3.0 ) * 0.08;
      // The wrist is seen through, and the far side of the cord with it: a hoop. Only the half of
      // it that lies on the eye's side of the wrist is drawn.
      vec3 eye = ( uArmRest * vec4( cameraPosition.x, abs( cameraPosition.y ), cameraPosition.z, 1.0 ) ).xyz;
      float near = dot( unit( vec3( vRest.xy, 0.0 ), vec3( 0.0, 1.0, 0.0 ) ), unit( eye - vRest, vec3( 0.0, 1.0, 0.0 ) ) );
      kept = min( kept, 1.0 ) * 0.8 * smoothstep( -0.05, 0.4, near );
      // And little of it for an eye behind the arm, which looks along the wrist and has the whole
      // round of the cord before it: the rim of a lid.
      kept *= 1.0 - 0.75 * clamp( vBehind, 0.0, 1.0 );
      // And it goes with the wrist it is tied round, where that goes for such an eye.
      kept *= shown( 1.0 );
      if ( kept < 0.01 ) discard;
      gl_FragColor = vec4( max( thread, vec3( 0.0 ) ) * kept, kept );
      return;
    }

    // -- the edge, from inside -------------------------------------------------------
    #ifdef EDGES
      float edge = nearEdge( ndv ) * outside;
    #else
      // Without the picture of the hands to go by, the angle of the skin has to do.
      float edge = pow( max( 1.0 - ndv, 0.0 ), 3.0 ) * 0.8 * outside;
    #endif
    float hug = edge * edge;
    hug *= hug;

    // -- what is seen through it ----------------------------------------------------------
    // Not something inside the hand but a place beyond it: it stays where it is while the hand
    // moves across it, and turns only when the eye does. What is there is smoke. No points of
    // light: a hand is a thing from a grave, not a window on the stars.
    vec3 ray = unit( vWorld - cameraPosition, vec3( 0.0, 0.0, -1.0 ) );
    // Candle smoke rises; the cold mist hardly stirs.
    vec3 c = ray * 9.0 + vec3( 0.0, - uTime * mix( 0.012, 0.034, uWarm ), - uTime * 0.005 );
    float broad = noise3( c );
    // Drawn out into strands by a second, finer smoke that the first pushes about.
    vec3 w = c * 2.3 + vec3( broad, noise3( c * 0.6 + 7.3 ), broad ) * 2.4 + 5.2;
    float fine = noise3( w );
    #ifdef DETAIL_FULL
      fine = fine * 0.65 + noise3( w * 2.1 + 3.0 ) * 0.35;
    #endif
    float strand = clamp( 1.0 - abs( fine * 2.0 - 1.0 ), 0.0, 1.0 );
    strand *= strand * strand;
    // Broad and soft: breath on cold air. Drawn too fine it is the veining of a stone.
    float cloud = smoothstep( 0.25, 0.8, broad );
    cloud = cloud * ( 0.62 + 0.38 * strand ) + 0.05 * strand;
    // And a current of the hand's own, that runs in it from the wrist out to the fingertips: it
    // goes with the hand, as the smoke beyond does not, and quickens when the hand has work to do.
    vec3 s = vec3( vRest.xy * 2.2, vRest.z * 0.9 + uTime * ( 0.1 + 0.22 * uEnergy ) ) + uSeed * 4.3;
    float current = noise3( s + vec3( 0.0, 0.0, noise3( s * 1.9 + 2.7 ) * 0.9 ) );
    current = smoothstep( 0.42, 0.9, current );
    // A hand at work holds light in its fingertips.
    float digit = vData.r;
    float tips = digit * digit * digit;

    float lively = 0.6 + 0.4 * uEnergy;
    // What is beyond the hand is seen as well through the inside of it, where it is open to the eye:
    // an open wrist is a window on the same night, not a hole.
    vec3 glow = uDeep * cloud * mix( 0.075, 0.045, uWarm ) * lively;
    glow += uRim * current * ( 0.012 + 0.03 * uEnergy ) * ( 0.35 + 0.65 * digit );
    // What lies on its skin is only on the outside of it. Nothing is reflected in it: it has no
    // surface for the room to shine on, and a shine is what makes a glove of a hand. Its light is
    // its own, thickest where the eye looks along the skin, and gathered in the fingertips.
    float rimward = pow( max( 1.0 - ndv, 0.0 ), 2.4 );
    vec3 skin = uRim * ( hug * ( 0.2 + 0.25 * uEnergy ) + edge * edge * ( 0.03 + 0.04 * uEnergy ) + rimward * ( 0.018 + 0.03 * uEnergy ) + tips * ( 0.012 + 0.05 * uEnergy ) );
    // (And none of it where the forearm is going: that has no edge and no surface, only less of itself.)
    glow += skin * outside * armEdged( left ) * openEnd();
    // But the forearm is not only dark, or in a dark room there would be no arm: a hand, and
    // nothing behind it. The smoke it goes away in carries a little of the hand's light, most
    // where the eye looks through the most of it, along either side: so that it is as wide as an
    // arm for as long as anything of it is to be seen, and has no line to stop.
    float past = smoothstep( 0.1, 0.9, vRest.z );
    vec3 r = vec3( vRest.xy * 2.1, vRest.z * 0.5 - uTime * 0.16 ) + uSeed * 8.7;
    float drawnOff = 0.55 + 0.9 * noise3( r + vec3( 0.0, 0.0, noise3( r * 2.3 ) ) );
    // (Not for an eye behind the arm, which has the arm between it and the hand: lit, that would be a ring round the wrist.)
    glow += uRim * past * outside * drawnOff * ( pow( max( 1.0 - ndv, 0.0 ), 1.6 ) * 0.2 + 0.014 ) * ( 0.65 + 0.35 * uEnergy ) * ( 1.0 - clamp( vBehind, 0.0, 1.0 ) );

    // -- where the body ends ---------------------------------------------------------
    // A clean cut, with the line drawn along it.
    float soft = max( fwidth( gone ), 1e-4 );
    float body = 1.0 - smoothstep( ${BODY_END} - soft, ${BODY_END} + soft, gone );
    float cut = ( 1.0 - smoothstep( 0.0, 1.3 * soft, abs( gone - ${BODY_END} ) ) ) * step( 0.02, gone );
    // Past the cut the hand is a drawing of itself: a few long strokes that run with the fingers.
    float sketch = smoothstep( ${BODY_END}, ${BODY_END} + 0.04, gone ) * ( 1.0 - smoothstep( 0.56, 0.84, gone ) );
    float hatch = strokes( normalize( vec3( 1.0, 0.45, 0.06 ) ), 0.12 ) * sketch * 0.42 * outside;
    float drawn = clamp( cut + hatch, 0.0, 1.0 ) * uOutline;

    // What is inside a thinned body thins with it, but not as fast: a hand in thought keeps its lights.
    float ghost = 1.0 - clamp( uFill, 0.0, 1.0 );
    vec3 lit = ( glow * body * mix( 1.0, 0.6, ghost ) + uRim * drawn * ( 0.9 + 0.7 * uEnergy ) ) * wane * inner;
    // Smoked glass is darkest where the eye looks along it: a thinned hand keeps its shape. (Its
    // outside does. The inside of a wrist, looked into from behind the arm, lies along the eye's
    // line all the way round, and would be a dark hoop.)
    // And the body itself is a veil, not a wall: see darkAt, which the depth passes go by too.
    float there = body * darkAt( left, outside, ndv );
    if ( there < 0.004 && dot( lit, vec3( 1.0 ) ) < 0.004 ) discard;
    // Light is added to what is behind; the dark body covers it. (Never more than covers it, and
    // never less than no light: what is behind is kept as a number that may be large, and is not
    // brought back into range for us.)
    there = clamp( there, 0.0, 1.0 );
    gl_FragColor = vec4( max( uNight * there + lit, vec3( 0.0 ) ), there );
  }`;

/**
 * How much of the line is left where the hand is going: it outlasts the body, then breaks into
 * dashes and goes. Along a forearm it is the other way about. The line is the first of it to go,
 * and the dark is left to go after it with no edge drawn round it; except close to the eye, where
 * the two go together (`armLined`): `left` is how much of the arm is left there.
 */
const LINE_KEPT = /* glsl */ `
  float lineKept( float gone, float left ) {
    float grain = noise3( vec3( vRest.xy * 7.0, vRest.z * 3.1 - uTime * 0.4 ) + uSeed * 3.0 );
    float kept = ( 1.0 - smoothstep( 0.56, 0.84, gone + ( grain - 0.5 ) * 0.5 * step( ${BODY_END}, gone ) ) ) * ( 1.0 - step( ${LINE_END}, gone ) );
    return kept * armLined( left );
  }`;

/**
 * The pushed-out skin is only a line, or a halo, where it stands clear outside the hand. Where the
 * skin has folded on itself (the web of the thumb in a tight grip) a part of it can come out in
 * front of the body instead; that part faces the eye, which a rim never does, and has the body
 * close behind it.
 */
const CLEAR = /* glsl */ `
  #ifdef EDGES
    ${DEPTH_AT}
    /**
     * True where a hand's body is in front of this piece of pushed-out skin, or lies against it:
     * the skin is a line only where it shows past the body.
     */
    bool covered() {
      return shapeDepth( gl_FragCoord.xy / uViewport ) < vViewPosition.z + max( 0.5, vViewPosition.z ) * ${SET_BACK};
    }
    /**
     * How far from the eye the hand's skin is just inside the edge that this point lies outside
     * of, so many pixels back the way the skin was pushed out. Its own distance, if no skin of
     * the same part of the hand is to be found there.
     */
    float edgeSkin( float inside ) {
      float steep = length( vScreen );
      if ( steep < 1e-4 ) return vViewPosition.z;
      float skin = shapeDepth( gl_FragCoord.xy / uViewport - vScreen / ( steep * uViewport ) * inside );
      return skin > vViewPosition.z - 0.2 && skin < vViewPosition.z + 0.05 ? skin : vViewPosition.z;
    }
    // (With \`depthAt\`, a line is given the depth of the edge it is drawn round, not that of the
    // pushed-out skin: that skin slants steeply away, a different way in every facet, and
    // whatever the hand touches would cut the line into teeth where the two cross.)
  #endif
  float standsClear( float from, float to, out float inner ) {
    float facing = dot( unit( vViewNormal, vec3( 0.0, 0.0, 1.0 ) ), unit( vViewPosition, vec3( 0.0, 0.0, 1.0 ) ) );
    float clear = 1.0 - smoothstep( 0.1, 0.4, facing );
    inner = 0.0;
    #ifdef EDGES
      // What the picture of the hands has here is in front of this point where the hand's own edge
      // crosses the pixel: that is the line's proper place, and the depth test has already shaped it.
      float behind = shapeDepth( gl_FragCoord.xy / uViewport );
      float gap = behind - vViewPosition.z;
      if ( gap > 0.0 ) {
        clear *= smoothstep( from, to, gap );
        inner = step( behind, ${(SILHOUETTE_FAR * 0.9).toFixed(1)} );
      }
    #endif
    return clear;
  }
`;

const LINE = /* glsl */ `
  ${SHARED}
  #ifdef EDGES
    ${SHAPE}
  #endif
  ${LINE_KEPT}
  ${CLEAR}
  void main() {
    if ( vData.a > 0.5 ) discard;
    #ifdef EDGES
      if ( covered() ) discard;
    #endif
    // (Where the arm is going and stands in front of nothing, the far side of this skin is in
    // plain sight through it: but there is no line on what has no near side left, see armLeft.)
    float left = armLeft();
    float inner;
    float strength = uOutline * lineKept( vanish(), left ) * standsClear( 0.03, 0.09, inner );
    // A hand thinned by thought is drawn by its outer edge; the lines where one finger crosses
    // another, seen through the glass with all the rest, would make a cage of it.
    strength *= 1.0 - 0.75 * inner * ( 1.0 - clamp( uFill, 0.0, 1.0 ) );
    strength *= openEnd();
    if ( strength < 0.01 ) discard;
    float shiver = noise3( vec3( vData.g * 46.0 - uTime * 2.2, uSeed * 9.0, 0.5 ) );
    // Twice as bright at work as asleep, and no more: past that the bloom takes the line for a lamp
    // and fills the hand with its haze, and the hand is not black any longer.
    float level = mix( 1.0, 2.0, clamp( uEnergy, 0.0, 1.0 ) ) * ( 1.0 + pulse() * mix( 0.35, 0.45, uEnergy ) + ( shiver - 0.5 ) * 0.2 );
    // There is less of the line too, back along the limb: it is drawn hardest round the fingers.
    // (Not close to the eye, where the limb is as wide as much of the picture and its line is what
    // makes an arm of it.)
    strength *= mix( mix( 0.6, 1.0, ( limb() - 0.7 ) / 0.3 ), 1.0, armClose() );
    gl_FragColor = vec4( uRim * max( level, 0.0 ), min( strength, 1.0 ) );
    #ifdef EDGES
      gl_FragDepth = depthAt( edgeSkin( vReach + 1.5 ) );
    #endif
  }`;

const HALO = /* glsl */ `
  #define EDGES
  ${SHARED}
  ${SHAPE}
  ${CLEAR}
  void main() {
    if ( vData.a > 0.5 || covered() ) discard;
    float gone = vanish();
    // The halo belongs to the body: where only the drawing is left, there is none.
    float inner;
    float strength = uOutline * ( 1.0 - smoothstep( ${BODY_END} - 0.15, ${BODY_END} + 0.05, gone ) ) * armEdged( armLeft() ) * standsClear( 0.03, 0.1, inner );
    strength *= openEnd();
    if ( strength < 0.01 ) discard;
    // How far outside the hand this point is, as seen: walk back toward the hand until it is there.
    float steep = length( vScreen );
    if ( steep < 1e-4 ) discard;
    vec2 pace = -vScreen / ( steep * uViewport );
    vec2 here = gl_FragCoord.xy / uViewport;
    float limit = vViewPosition.z + 0.02;
    float reach = max( vReach, 1.0 );
    float stride = reach / 5.0;
    float lo = 0.0;
    float hi = -1.0;
    for ( int i = 1; i <= 5; i ++ ) {
      float r = stride * float( i );
      if ( shapeDepth( here + pace * r ) < limit ) { hi = r; break; }
      lo = r;
    }
    if ( hi < 0.0 ) discard;
    for ( int k = 0; k < 2; k ++ ) {
      float mid = 0.5 * ( lo + hi );
      if ( shapeDepth( here + pace * mid ) < limit ) hi = mid;
      else lo = mid;
    }
    float away = clamp( 0.5 * ( lo + hi ) / reach, 0.0, 1.0 );
    float fall = 1.0 - away;
    // Tight against the line, with a long faint skirt.
    float shine = fall * fall * fall * 0.35 + exp( -away * 7.0 ) * fall * 0.65;
    // It is not a glow laid evenly round the hand but something given off by it: tongues of it
    // that climb, tight to the line where they are thin and standing off it where they are full.
    vec3 f = vec3( vWorld.xz * 4.2, vWorld.y * 2.6 - uTime * ( 0.34 + 0.3 * uEnergy ) ) + uSeed * 6.1;
    float tongue = noise3( f + vec3( noise3( f * 0.5 + 4.0 ) * 1.4, 0.0, 0.0 ) );
    tongue = smoothstep( 0.2, 0.85, tongue );
    shine = mix( shine * 0.35, pow( fall, 1.6 ) * 0.9 + shine * 0.5, tongue );
    float level = mix( 0.1, 0.2, uEnergy ) * ( 1.0 + pulse() * 0.6 ) * mix( 0.6, 1.0, ( limb() - 0.7 ) / 0.3 );
    gl_FragColor = vec4( uRim * max( level * shine * strength, 0.0 ), 1.0 );
    gl_FragDepth = depthAt( edgeSkin( 0.5 * ( lo + hi ) + 1.5 ) );
  }`;

/** The plumb weight and its line: the same thread and dull metal as the cord. */
const PLUMB_VERTEX = /* glsl */ `
  varying vec3 vViewNormal;
  varying vec3 vViewPosition;
  ${SOUND}
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
    vViewNormal = unit( normalMatrix * normal, vec3( 0.0, 0.0, 1.0 ) );
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }`;
const PLUMB_FRAGMENT = /* glsl */ `
  uniform vec3 uThread;
  uniform vec3 uRim;
  uniform float uFill;
  uniform float uOutline;
  uniform float uDissolve;
  varying vec3 vViewNormal;
  varying vec3 vViewPosition;
  ${SOUND}
  void main() {
    vec3 v = unit( vViewPosition, vec3( 0.0, 0.0, 1.0 ) );
    vec3 n = unit( vViewNormal, v );
    float ndv = clamp( dot( n, v ), 0.0, 1.0 );
    vec3 light = unit( ( viewMatrix * vec4( 0.07, 1.0, 0.1, 0.0 ) ).xyz, vec3( 0.0, 1.0, 0.0 ) );
    float facing = max( dot( n, unit( light + v, n ) ), 0.0 );
    float lifted = 0.5 + 0.5 * dot( n, light );
    float kept = max( uFill, uOutline ) * ( 1.0 - smoothstep( 0.3, 0.6, uDissolve ) );
    if ( kept < 0.01 ) discard;
    // Of the hand's own stuff, as the cord is: dark, seen through a little, its edge its own light.
    vec3 colour = uThread * ( 0.03 + 0.2 * lifted * lifted * lifted );
    colour += vec3( 0.75, 0.86, 0.92 ) * pow( max( facing, 0.0 ), 28.0 ) * 0.08;
    colour += uRim * ( pow( max( 1.0 - ndv, 0.0 ), 2.0 ) * 0.3 + 0.02 );
    kept = min( kept, 1.0 ) * 0.8;
    gl_FragColor = vec4( max( colour, vec3( 0.0 ) ) * kept, kept );
  }`;

export interface HandMaterials {
  /** Pass 1: depth only. */
  depth: ShaderMaterial;
  /** Pass 2: depth again, set back, for the forearm where it is going. */
  veil: ShaderMaterial;
  /** Pass 3: the glass. Its uniforms are shared by all the passes. */
  glass: HandMaterial;
  /** Pass 5: the drawn line. */
  line: ShaderMaterial;
  /** Pass 4: the halo. Only drawn at full detail; it reads the picture of the hands. */
  halo: ShaderMaterial;
  /** Pass 0: what draws the hand into the picture of the hands. */
  shape: ShaderMaterial;
}

/** The materials a hand is drawn with. They share one set of uniforms, so they always agree about what is there. */
export function handMaterials(side: Side, seed: number, meta: HandMeta, detail: HandDetail = 'full'): HandMaterials {
  const uniforms: HandUniforms = {
    uRim: { value: RIM[side].clone() },
    uDeep: { value: DEEP[side].clone() },
    uNight: { value: NIGHT[side].clone() },
    uThread: { value: THREAD[side].clone() },
    uWarm: { value: side === 'w' ? 1 : 0 },
    uFill: { value: 1 },
    uOutline: { value: 1 },
    uEnergy: { value: 0 },
    uTime: { value: 0 },
    uDissolve: { value: 0 },
    uWrist: { value: new Vector2(ARM_WHOLE_TO, meta.forearmLength - ARM_GONE_BEFORE - ARM_WHOLE_TO) },
    // Where the arm is in the room is set each frame (hand.ts). Until it is, no eye is behind it.
    uArmFrom: { value: new Vector3() },
    uArmWay: { value: new Vector3() },
    uArmRest: { value: new Matrix4() },
    uArmFlat: { value: meta.forearmEnd[0] / Math.max(meta.forearmEnd[1], 1e-3) },
    uSeed: { value: seed },
    uLine: { value: new Vector2(1.7, 12) },
    uViewport: { value: new Vector2(1920, 1080) },
    uShape: { value: null },
  };
  const shared = uniforms as unknown as ShaderMaterial['uniforms'];
  const depth = new ShaderMaterial({
    name: 'VoidGlassDepth',
    uniforms: shared,
    vertexShader: VERTEX,
    fragmentShader: DEPTH,
    colorWrite: false,
    // Both faces, so that the inside of the hand is something too where it is open to the eye.
    side: DoubleSide,
    forceSinglePass: true,
    // Sorted with the see-through things, so that it runs just before the passes that need it.
    transparent: true,
  });
  const veil = new ShaderMaterial({
    name: 'VoidGlassVeil',
    uniforms: shared,
    defines: { VEIL: '' },
    vertexShader: VERTEX,
    fragmentShader: DEPTH,
    colorWrite: false,
    side: DoubleSide,
    forceSinglePass: true,
    transparent: true,
  });
  const glass = new ShaderMaterial({
    name: 'VoidGlass',
    uniforms: shared,
    defines: detail === 'full' ? { DETAIL_FULL: '' } : {},
    vertexShader: VERTEX,
    fragmentShader: GLASS,
    side: DoubleSide,
    forceSinglePass: true,
    transparent: true,
    premultipliedAlpha: true,
    // At what passes 1 and 2 wrote or in front of it, and they wrote nothing in front of the nearest they kept.
    depthWrite: false,
  }) as HandMaterial;
  const line = new ShaderMaterial({
    name: 'VoidGlassLine',
    uniforms: shared,
    defines: { SWELL: '' },
    vertexShader: VERTEX,
    fragmentShader: LINE,
    side: BackSide,
    transparent: true,
    depthWrite: false,
  });
  const halo = new ShaderMaterial({
    name: 'VoidGlassHalo',
    uniforms: shared,
    defines: { SWELL: '', HALO: '' },
    vertexShader: VERTEX,
    fragmentShader: HALO,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const shape = new ShaderMaterial({
    name: 'VoidGlassShape',
    uniforms: shared,
    defines: { SHAPE: '' },
    vertexShader: VERTEX,
    fragmentShader: DEPTH,
    side: DoubleSide,
    blending: NoBlending,
  });
  return { depth, veil, glass, line, halo, shape };
}

/** The material for a hand's plumb weight. It fades with the hand it hangs from. */
export function plumbMaterial(glass: HandMaterial): ShaderMaterial {
  return new ShaderMaterial({
    name: 'VoidGlassPlumb',
    uniforms: glass.uniforms as unknown as ShaderMaterial['uniforms'],
    vertexShader: PLUMB_VERTEX,
    fragmentShader: PLUMB_FRAGMENT,
    transparent: true,
    premultipliedAlpha: true,
  });
}
