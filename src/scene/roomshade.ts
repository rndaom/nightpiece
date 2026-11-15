/**
 * How the board and the room are shaded, beyond what a stock material does.
 *
 * The room's light that never moves is baked by assets/src/environment.py into two atlases, one
 * kind of light to a channel, so each can be coloured and dimmed on its own as the room changes
 * state. The hooks here add that light to a standard material, lay haze over the distance, and
 * draw the things that are not plain stone: the void glass of the dark squares, the sheen of the
 * honed slabs and of the polished floor, and everything in the room that is itself light.
 *
 * Every material made here reads one shared set of uniforms (`RoomLook`), which the chapel
 * drives.
 */
import {
  Color,
  LinearFilter,
  Matrix4,
  MeshStandardMaterial,
  ShaderChunk,
  ShaderMaterial,
  type Texture,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { Assets, Surface } from './assets';
import { FLICKER_GLSL } from './flames';
import { SANE_GLSL } from './post';

/** Which wall light the second channel of the occlusion atlas holds: the slot under the slab on the plinth and frame, Void's ring everywhere else. */
export type Second = 'slot' | 'ring';

/** The room's measurements, as its build wrote them down. */
type Plan = Assets['room'];

export interface RoomLook {
  /** The second atlas: candles, night sky and the key's bounce. */
  tRoomLight: { value: Texture | null };
  /** Colour and strength of each kind of baked light, already divided by what it was stored at. */
  uCandle: { value: Color };
  uSky: { value: Color };
  uBounce: { value: Color };
  uRing: { value: Color };
  uSlot: { value: Color };
  uDisc: { value: Color };
  /** 1 for steady candles, 0 for guttering ones. */
  uCalm: { value: number };
  uTime: { value: number };
  /** The air: its colour toward Ivory's end of the room, toward Void's, and down by the floor. */
  uHazeWarm: { value: Color };
  uHazeCool: { value: Color };
  uHazeLow: { value: Color };
  /** x: how thick the air is; y: how far away it starts; z: how much of the floor's colour it takes low down. */
  uHaze: { value: Vector3 };
  /** What the board mirrors, and the matrix that finds a point of the board in it. */
  tMirror: { value: Texture | null };
  uMirrorMatrix: { value: Matrix4 };
  /** Strength of that reflection. */
  uMirror: { value: number };
  /** How much of the mist under the glass shows, and its colour. */
  uMist: { value: number };
  uMistColour: { value: Color };
  /** Light leaking up through the joints of the board. */
  uJoint: { value: Color };
  /** How each kind of glowing thing looks: the slot, the night sky, Void's rose, Ivory's rose, a lantern's glass. */
  uGlow: { value: Color[] };
  /** How a niche full of candles looks from across the room. */
  uNiche: { value: Color };
  /** Candle wax lit from inside by its own flame. */
  uWax: { value: Color };
}

export function roomLook(light: Texture, occlusion: Texture): RoomLook {
  // The islands of the atlases lie close together, and a smaller copy of either would run them
  // into one another. The light in them is smooth enough not to need one.
  for (const t of [light, occlusion]) {
    t.generateMipmaps = false;
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.needsUpdate = true;
  }
  return {
    tRoomLight: { value: light },
    uCandle: { value: new Color() },
    uSky: { value: new Color() },
    uBounce: { value: new Color() },
    uRing: { value: new Color() },
    uSlot: { value: new Color() },
    uDisc: { value: new Color() },
    uCalm: { value: 1 },
    uTime: { value: 0 },
    uHazeWarm: { value: new Color() },
    uHazeCool: { value: new Color() },
    uHazeLow: { value: new Color() },
    uHaze: { value: new Vector3(0.012, 8, 0) },
    tMirror: { value: null },
    uMirrorMatrix: { value: new Matrix4() },
    uMirror: { value: 0 },
    uMist: { value: 1 },
    uMistColour: { value: new Color() },
    uJoint: { value: new Color() },
    uGlow: { value: [new Color(), new Color(), new Color(), new Color(), new Color()] },
    uNiche: { value: new Color() },
    uWax: { value: new Color() },
  };
}

type Shader = WebGLProgramParametersWithUniforms;

/** Replace one include of a shader with itself and something after it (or, with `before`, something before it). */
function after(source: string, include: string, code: string, before = false): string {
  const tag = `#include <${include}>`;
  if (!source.includes(tag)) throw new Error(`Shader has no ${tag}`);
  return source.replace(tag, before ? `${code}\n${tag}` : `${tag}\n${code}`);
}

const HAZE_PARS = /* glsl */ `
  uniform vec3 uHazeWarm;
  uniform vec3 uHazeCool;
  uniform vec3 uHazeLow;
  uniform vec3 uHaze;
  // The room's air between the eye and a point: far things sink into it, cool toward Void's end
  // of the room and warm toward Ivory's, and it lies thickest along the floor.
  vec3 roomHaze( vec3 colour, vec3 at ) {
    vec3 ray = at - cameraPosition;
    float far = length( ray );
    float veil = 1.0 - exp( - uHaze.x * max( far - uHaze.y, 0.0 ) );
    vec3 air = mix( uHazeCool, uHazeWarm, smoothstep( -0.7, 0.7, ray.z / max( far, 1e-4 ) ) );
    air = mix( air, uHazeLow, uHaze.z * ( 1.0 - smoothstep( -3.0, 4.0, at.y ) ) );
    return mix( colour, air, veil );
  }`;

const HASH_GLSL = /* glsl */ `
  float roomHash( vec2 p ) {
    vec3 q = fract( vec3( p.xyx ) * 0.1031 );
    q += dot( q, q.yzx + 33.33 );
    return fract( ( q.x + q.y ) * q.z );
  }
  vec3 roomHash3( vec2 p ) {
    vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
    q += dot( q, q.yxz + 33.33 );
    return fract( ( q.xxy + q.yzz ) * q.zyx );
  }
  float roomNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( roomHash( i ), roomHash( i + vec2( 1.0, 0.0 ) ), f.x ),
                mix( roomHash( i + vec2( 0.0, 1.0 ) ), roomHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
  }`;

/** Scale a colour down, keeping its hue, so that none of it is brighter than `limit`. */
const HELD_GLSL = /* glsl */ `
  vec3 roomHeld( vec3 c, float limit ) {
    return c * ( limit / max( limit, max( c.r, max( c.g, c.b ) ) ) );
  }`;

const f = (n: number): string => n.toFixed(4);

/**
 * The room as a picture of its lights, known by where they are and not by drawing them: what a
 * line of sight from a point inside it ends on. The polished floor mirrors the room by this, and
 * so does the board where there is no second view of the room to look its reflection up in.
 * Needs `flicker`, `uTime` and `uCalm` declared before it.
 */
function seenPars(room: Plan): string {
  return /* glsl */ `
  uniform vec3 uGlow[ 5 ];
  uniform vec3 uNiche;

  // A band \`width\` either side of its middle, smeared by \`soft\`: how much of it shows \`away\` from the middle.
  float roomBand( float away, float width, float soft ) {
    return clamp( ( width + soft - abs( away ) ) / ( 2.0 * min( width, soft ) ), 0.0, 1.0 ) * min( 1.0, width / soft );
  }

  // How much of a pointed light in a wall shows at (along, y) from its middle: half width \`hw\`,
  // its sill, and where its arch springs. Its arch is equilateral, each side an arc as wide as the light.
  float roomLancet( float along, float y, float hw, float sill, float spring, float across, float up ) {
    float soft = max( across, up );
    float inside = 2.0 * hw - length( vec2( abs( along ) + hw, max( y - spring, 0.0 ) ) );
    return clamp( inside / soft + 0.5, 0.0, 1.0 ) * min( 1.0, hw / soft ) * clamp( ( y - sill ) / up + 0.5, 0.0, 1.0 );
  }

  // A direction is divided by, part by part: none of it may be nothing.
  vec3 roomAim( vec3 dir ) {
    return mix( dir, vec3( 2e-5 ), step( abs( dir ), vec3( 1e-5 ) ) );
  }

  // How far along a line it strikes a block that stands on the floor, or a long way if it misses.
  float roomStrike( vec3 o, vec3 dir, float reach, float height ) {
    vec3 inv = 1.0 / roomAim( dir );
    vec3 lo = ( vec3( - reach, -50.0, - reach ) - o ) * inv;
    vec3 hi = ( vec3( reach, height, reach ) - o ) * inv;
    vec3 a = min( lo, hi );
    vec3 b = max( lo, hi );
    float enter = max( max( a.x, a.y ), a.z );
    float leave = min( min( b.x, b.y ), b.z );
    return leave > max( enter, 0.0 ) ? max( enter, 0.0 ) : 1e4;
  }

  // \`smear\` is how far the picture is smeared, sideways and up and down, for each unit of
  // distance to it: a reflection in a honed surface is a smeared one, and at a glancing angle
  // far more up and down than sideways.
  vec3 roomSeen( vec3 from, vec3 dir, vec2 smear ) {
    dir = roomAim( dir );
    vec2 toWall = ( ${f(room.wall)} * sign( dir.xz ) - from.xz ) / dir.xz;
    float far = min( toWall.x, toWall.y );
    if ( dir.y > 0.0 ) {
      float toCeiling = ( ${f(room.ceiling)} - from.y ) / dir.y;
      if ( toCeiling < far ) {
        // The sky in the oculus.
        vec3 hit = from + dir * toCeiling;
        float soft = max( smear.y * toCeiling, 0.02 );
        return uGlow[ 1 ] * 1.6 * roomBand( hit.x, ${f(room.oculusHalf)}, soft ) * roomBand( hit.z, ${f(room.oculusHalf)}, soft );
      }
    } else if ( ( ${f(room.floorY)} - from.y ) / dir.y < far ) {
      return vec3( 0.0 );
    }
    bool side = toWall.x < toWall.y;
    vec3 hit = from + dir * far;
    float along = side ? hit.z : hit.x;
    float across = max( smear.x * far, 0.02 );
    float up = max( smear.y * far, 0.02 );
    vec3 seen = vec3( 0.0 );

    // Candle niches: three either side of the middle of every wall.
    float bay = floor( along / ${f(room.bay)} );
    float off = ( fract( along / ${f(room.bay)} ) - 0.5 ) * ${f(room.bay)};
    float has = step( 1.0, abs( bay + 0.5 ) ) * step( abs( bay + 0.5 ), 4.0 );
    float rise = hit.y - ${f(room.niche.floor)};
    float wallId = side ? sign( dir.x ) * 17.0 : sign( dir.z ) * 41.0;
    float above = ( rise - 1.4 ) / ( 0.55 + up );
    float flames = exp( - above * above ) * 0.55 / ( 0.55 + up );
    float recess = 0.2 * roomBand( rise - ${f(room.niche.height / 2)}, ${f(room.niche.height / 2)}, up );
    seen += uNiche * has * roomBand( off, ${f(room.niche.width / 2)}, across ) * ( flames + recess ) * flicker( bay * 2.3 + wallId, uTime, uCalm );

    // The night in the tall windows over the niches and the roundels over those, behind their
    // tracery and leads; palest near the ground.
    float sky = mix( 1.0, 0.5, smoothstep( -3.0, 21.0, hit.y ) );
    float glass = roomLancet( off, hit.y, ${f(room.window.half)}, ${f(room.window.sill)}, ${f(room.window.head - room.window.half * Math.sqrt(3))}, across, up )
                 + roomBand( length( vec2( off, hit.y - ${f(room.window.roundel)} ) ), ${f(room.window.roundelRadius)}, sqrt( across * up ) );
    seen += uGlow[ 1 ] * has * glass * sky * 0.18;

    // A lantern on every pier between the middle and the corners, hanging a little off the wall.
    float pier = floor( along / ${f(room.bay)} + 0.5 );
    float hung = ( fract( along / ${f(room.bay)} + 0.5 ) - 0.5 ) * ${f(room.bay)};
    float lit = step( 0.5, abs( pier ) ) * step( abs( pier ), 3.5 );
    seen += uGlow[ 4 ] * lit * roomBand( hung, ${f(room.lantern.radius)}, across ) * roomBand( hit.y - ${f(room.lanterns[0]?.y ?? 3.2)}, ${f(room.lantern.half)}, up )
          * flicker( pier * 3.1 + wallId, uTime, uCalm );

    if ( side ) {
      // The open doorway, and the cross of three lancets over it.
      float door = roomLancet( along, hit.y, ${f(room.door.half)}, ${f(room.floorY - 1)}, ${f(room.door.head - room.door.half * Math.sqrt(3))}, across, up );
      float lancets = max( roomLancet( along, hit.y, ${f(room.cross.half)}, ${f(room.cross.foot)}, ${f(room.cross.head - room.cross.half * Math.sqrt(3))}, across, up ),
                         roomLancet( abs( along ) - ${f(room.cross.armAt)}, hit.y, ${f(room.cross.armHalf)}, ${f(room.cross.armSill)},
                                     ${f(room.cross.armHead - room.cross.armHalf * Math.sqrt(3))}, across, up ) );
      seen += uGlow[ 1 ] * ( door + 0.8 * lancets ) * sky * 0.3;
    } else {
      float soft = sqrt( across * up );
      if ( dir.z < 0.0 ) {
        // Void's rose: a ring of glass behind its spokes.
        float r = length( vec2( along, hit.y - ${f(room.ring.y)} ) );
        seen += uGlow[ 2 ] * 0.6 * roomBand( r - ${f((room.ring.outer + room.ring.inner) / 2)}, ${f((room.ring.outer - room.ring.inner) / 2)}, soft );
      } else {
        // Ivory's rose: glass all through.
        float r = length( vec2( along, hit.y - ${f(room.disc.y)} ) );
        seen += uGlow[ 3 ] * 0.5 * roomBand( r, ${f(room.disc.radius)}, soft );
      }
    }
    return seen;
  }`;
}

export interface BakedOptions {
  second: Second;
  /** The walls: candlelight there moves bay by bay, each with its own niche. */
  bay?: number;
  /** The floor: its joints are drawn here, the chalk ring is part of its colour, and it is polished enough to mirror the room's lights. */
  floor?: { slab: number; sigil: Texture; sigilSize: number; room: Plan };
}

/**
 * Light a standard material with the baked atlases and lay the room's haze over it. The material
 * must carry the occlusion atlas as its `aoMap`: that is what brings the second UV set in.
 */
export function baked(material: MeshStandardMaterial, look: RoomLook, o: BakedOptions): MeshStandardMaterial {
  const sigil = { value: o.floor?.sigil ?? null };
  material.onBeforeCompile = (shader: Shader) => {
    Object.assign(shader.uniforms, look, { tSigil: sigil });
    shader.vertexShader = after(
      after(shader.vertexShader, 'common', 'varying vec3 vRoomPos;'),
      'project_vertex',
      'vRoomPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
    );
    let s = shader.fragmentShader;
    s = after(
      s,
      'common',
      /* glsl */ `
      varying vec3 vRoomPos;
      uniform sampler2D tRoomLight;
      uniform vec3 uCandle;
      uniform vec3 uSky;
      uniform vec3 uBounce;
      uniform vec3 uRing;
      uniform vec3 uSlot;
      uniform vec3 uDisc;
      uniform float uCalm;
      uniform float uTime;
      ${HAZE_PARS}
      ${HASH_GLSL}
      ${FLICKER_GLSL}
      ${
        o.floor
          ? /* glsl */ `
      uniform sampler2D tSigil;
      ${seenPars(o.floor.room)}
      // How much of a pixel a line this far away covers: 1 on it, 0 off it, and less than 1
      // where the pixel is wider than the line.
      float roomLine( float away, float width, float pixel ) {
        return clamp( ( width - away ) / pixel + 0.5, 0.0, 1.0 ) * min( 1.0, 2.0 * width / pixel );
      }`
          : ''
      }`,
    );
    if (o.floor) {
      s = after(
        s,
        'map_fragment',
        /* glsl */ `
        // The floor is laid in square flags on the diagonal, pale and dark by turns: a joint
        // between each, no two of a tone quite the same, and each worn to its own polish.
        vec2 roomDiagonal = vec2( vRoomPos.x + vRoomPos.z, vRoomPos.x - vRoomPos.z ) * 0.70711;
        vec2 roomSlab = roomDiagonal / ${f(o.floor.slab)};
        vec2 roomFlag = floor( roomSlab + 0.5 );
        float roomPour = roomHash( roomFlag + 7.0 );
        float roomPolish = ( 0.35 + 0.65 * roomHash( roomFlag + 3.0 ) ) * ( 0.55 + 0.45 * roomNoise( vRoomPos.xz * 0.21 + 5.0 ) );
        {
          vec2 toJoint = abs( fract( roomSlab + 0.5 ) - 0.5 ) * ${f(o.floor.slab)};
          vec2 pixel = max( fwidth( roomDiagonal ), vec2( 1e-4 ) );
          float joint = max( roomLine( toJoint.x, 0.014, pixel.x ), roomLine( toJoint.y, 0.014, pixel.y ) );
          float dark = mod( roomFlag.x + roomFlag.y, 2.0 );
          // The two tones are close: a pavement noticed on the second look, not a second board.
          diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.84, 0.85, 0.87 ), dark ) * ( 0.92 + 0.16 * roomPour ) * ( 1.0 - 0.72 * joint );
          // Chalk, rubbed into the stone round the altar; nothing shines where it lies.
          float chalk = texture2D( tSigil, vRoomPos.xz / ${o.floor.sigilSize.toFixed(3)} + 0.5 ).a;
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.78, 0.75, 0.68 ), chalk * 0.62 );
          roomPolish *= ( 1.0 - 0.8 * joint ) * ( 1.0 - 0.7 * chalk );
        }`,
      );
    }
    s = after(
      s,
      'aomap_fragment',
      /* glsl */ `
      {
        vec3 roomStored = pow( texture2D( tRoomLight, vAoMapUv ).rgb, vec3( 2.2 ) );
        vec2 roomMore = pow( texture2D( aoMap, vAoMapUv ).gb, vec2( 2.2 ) );
        float roomFlame = 1.0;
        ${
          o.bay
            ? /* glsl */ `
        {
          // Each bay's light moves with the candles in its own niche; between two bays it is a blend of both.
          vec2 reach = abs( vRoomPos.xz );
          bool side = reach.x > reach.y;
          float along = ( side ? vRoomPos.z : vRoomPos.x ) / ${f(o.bay)} - 0.5;
          float wall = side ? sign( vRoomPos.x ) * 17.0 : sign( vRoomPos.z ) * 41.0;
          float bay = floor( along );
          roomFlame = mix( flicker( bay * 2.3 + wall, uTime, uCalm ), flicker( ( bay + 1.0 ) * 2.3 + wall, uTime, uCalm ),
                           smoothstep( 0.35, 0.65, along - bay ) );
        }`
            : ''
        }
        vec3 roomGather = roomStored.r * roomFlame * uCandle + roomStored.g * uSky + roomStored.b * uBounce
                        + roomMore.x * ${o.second === 'slot' ? 'uSlot' : 'uRing'} + roomMore.y * uDisc;
        reflectedLight.indirectDiffuse += roomGather * material.diffuseContribution;
        ${
          o.floor
            ? /* glsl */ `
        {
          // The polished floor mirrors the lights of the room: hardly at all underfoot, strongly
          // far off where the eye skims it. The altar stands in the way of some of them.
          vec3 toEye = normalize( cameraPosition - vRoomPos );
          float cosine = max( toEye.y, 0.02 );
          vec3 sent = reflect( - toEye, vec3( 0.0, 1.0, 0.0 ) );
          float rough = 0.026 * ( 2.2 - roomPolish );
          vec3 seen = roomSeen( vRoomPos, sent, vec2( rough * ( 0.35 + cosine ), rough * 2.0 ) );
          // The altar's steps, its body and mensa, and the case on top.
          float blocked = min( min( roomStrike( vRoomPos, sent, 7.6, -2.8 ), roomStrike( vRoomPos, sent, 7.15, -2.6 ) ),
                               min( roomStrike( vRoomPos, sent, 6.6, -1.0 ), roomStrike( vRoomPos, sent, 4.8, 0.1 ) ) );
          float fresnel = 0.04 + 0.96 * pow( max( 1.0 - cosine, 0.0 ), 5.0 );
          reflectedLight.indirectSpecular += seen * step( 1e3, blocked ) * fresnel * roomPolish;
        }`
            : ''
        }
      }`,
    );
    s = after(s, 'opaque_fragment', 'gl_FragColor.rgb = roomHaze( gl_FragColor.rgb, vRoomPos );');
    shader.fragmentShader = s;
  };
  material.customProgramCacheKey = () => `nightpiece-baked-5-${o.second}-${o.bay ?? 0}-${o.floor ? 1 : 0}`;
  return material;
}

/** What a tile needs before anything else: it can be raised, and it knows where it is and which square it belongs to. */
function tileVertex(shader: Shader, lift: Float32Array, crumble: Float32Array, shut: { value: number }): void {
  shader.uniforms.uLift = { value: lift };
  shader.uniforms.uCrumble = { value: crumble };
  shader.uniforms.uShut = shut;
  let v = shader.vertexShader;
  v = after(
    v,
    'common',
    /* glsl */ `
    attribute vec4 aData;
    uniform float uLift[ 64 ];
    uniform float uCrumble[ 64 ];
    varying float vCrumble;
    varying vec3 vRoomPos;
    varying vec3 vTilePos;
    varying float vTile;
    varying float vRoomUp;
    varying float vTileUp;
    #ifdef ROOM_MIRROR
      uniform mat4 uMirrorMatrix;
      varying vec4 vMirror;
    #endif`,
  );
  v = after(v, 'begin_vertex', 'transformed.y += uLift[ int( floor( aData.r * 63.0 + 0.5 ) ) ];');
  v = after(
    v,
    'project_vertex',
    /* glsl */ `
    vRoomPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    // Where the tile lies in its half of the case, open: the lid's squares keep their places in
    // the pattern while the lid turns.
    vTilePos = transformed;
    vTile = aData.r;
    vCrumble = uCrumble[ int( floor( aData.r * 63.0 + 0.5 ) ) ];
    vec3 roomNormal = mat3( modelMatrix ) * objectNormal;
    vRoomUp = roomNormal.y / max( length( roomNormal ), 1e-6 );
    vTileUp = objectNormal.y / max( length( objectNormal ), 1e-6 );
    #ifdef ROOM_MIRROR
      vMirror = uMirrorMatrix * vec4( vRoomPos, 1.0 );
    #endif`,
  );
  shader.vertexShader = v;
}

/** What both kinds of tile need to mirror the room: the second view of it where there is one, the room as it is known to be laid out where there is not. */
function tileSeenPars(room: Plan): string {
  return /* glsl */ `
    uniform float uTime;
    uniform float uCalm;
    uniform float uMirror;
    #ifdef ROOM_MIRROR
      uniform sampler2D tMirror;
      varying vec4 vMirror;
      ${SANE_GLSL}
      // The second view of the room, as blurred as \`bias\` says. A bad pixel in it is spread by
      // its own smaller copies, so what is read is made safe as the frame itself is.
      vec3 roomMirrored( float bias ) {
        return sane( texture2D( tMirror, vMirror.xy / max( vMirror.w, 1e-4 ), bias ).rgb );
      }
    #else
      ${FLICKER_GLSL}
      ${seenPars(room)}
    #endif
    ${HELD_GLSL}`;
}

/**
 * The ends of the slabs at the hinge line, which are all that shows of them along the folded side
 * of the shut case: the stone's sawn edge, unpolished and dark. `TILE_END` is drawn into the
 * colour, `TILE_END_DULL` takes the polish off.
 */
const TILE_END = /* glsl */ `
      float tileEnd = ( 1.0 - step( 0.5, vTileUp ) ) * ( 1.0 - step( 0.03, abs( vTilePos.z ) ) );
      diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.028, 0.032, 0.032 ), tileEnd );`;
const TILE_END_DULL = /* glsl */ `
      reflectedLight.directSpecular *= 1.0 - tileEnd;
      reflectedLight.indirectSpecular *= 1.0 - tileEnd;`;

/**
 * three's own loop over the lights, for a tile, changed in one place: how dark the key's shadows
 * lie on it. From a seat a stone's shadow across the squares is what stands it on the board. In
 * the plan view, looked at from straight overhead, the same shadow is a grey shape lying over
 * two or three squares that are being read for what stands on them: there it is laid at less
 * than half its strength. (Should three word its shadow differently one day, the shadows are
 * left at full strength in that view, and nothing else changes.)
 */
const TILE_SHADOWS = /(directLight\.color \*= \( directLight\.visible && receiveShadow \) \? )(getShadow\( spotShadowMap\[ i \][^;]*\))( : 1\.0;)/;
export const TILE_LIGHTS = /* glsl */ `
      float tileShadow = 1.0 - 0.58 * smoothstep( 0.9, 0.985, - normalize( vRoomPos - cameraPosition ).y );
      ${ShaderChunk.lights_fragment_begin.replace(TILE_SHADOWS, '$1mix( 1.0, $2, tileShadow )$3')}`;

/**
 * A square a stone has just left breaks up in its middle. `vCrumble` is 0 for a whole square;
 * otherwise its whole part (1 to 7) says how much of the face is let go, and its fraction is how
 * far through the breaking it is (see `BoardFx`). The face is cut into sixteen shards along a
 * ragged grid, each cut from its own slab's pattern. A shard drops when its turn comes, central
 * ones first, lies there as a pit in the stone, and sets itself back; as it goes the cut round it
 * shows as a dark seam with a pale chipped lip. The rim of the face is never let go, so the square
 * stays itself. Nothing is drawn for a whole square.
 */
const CRUMBLE_PARS = /* glsl */ `
      vec2 crumbleHash( vec2 p ) {
        p = vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) );
        return fract( sin( p ) * 43758.5453 );
      }
      float crumbleNoise( vec2 p ) {
        vec2 i = floor( p );
        vec2 f = fract( p );
        f = f * f * ( 3.0 - 2.0 * f );
        return mix( mix( crumbleHash( i ).x, crumbleHash( i + vec2( 1.0, 0.0 ) ).x, f.x ), mix( crumbleHash( i + vec2( 0.0, 1.0 ) ).x, crumbleHash( i + vec2( 1.0, 1.0 ) ).x, f.x ), f.y );
      }`;
const TILE_CRUMBLE = /* glsl */ `
      if ( vCrumble > 0.5 ) {
        float crumbleLevel = floor( vCrumble + 0.01 );
        float crumbleT = clamp( ( vCrumble - crumbleLevel ) / 0.98, 0.0, 1.0 );
        vec2 crumbleAt = fract( vTilePos.xz ) - 0.5;
        float crumbleSlab = floor( vTile * 63.0 + 0.5 );
        vec2 crumbleGrid = ( crumbleAt + 0.5 ) * 4.0;
        // The cuts are not straight: a slow wander and a fine one.
        vec2 crumbleSeed = vec2( crumbleSlab * 1.7, crumbleSlab * 0.9 );
        crumbleGrid += 0.3 * ( vec2( crumbleNoise( crumbleGrid * 2.1 + crumbleSeed ), crumbleNoise( crumbleGrid * 2.1 + crumbleSeed + 17.3 ) ) - 0.5 );
        crumbleGrid += 0.1 * ( vec2( crumbleNoise( crumbleGrid * 7.0 + crumbleSeed ), crumbleNoise( crumbleGrid * 7.0 + crumbleSeed + 5.1 ) ) - 0.5 );
        vec2 crumbleCell = floor( crumbleGrid );
        // The nearest two points of the ragged grid, and which cell each belongs to.
        float near1 = 9.0;
        float near2 = 9.0;
        vec2 cell1 = vec2( 0.0 );
        vec2 cell2 = vec2( 0.0 );
        vec2 point1 = vec2( 0.0 );
        for ( int j = -1; j <= 1; j ++ ) {
          for ( int i = -1; i <= 1; i ++ ) {
            vec2 cell = crumbleCell + vec2( float( i ), float( j ) );
            vec2 point = cell + 0.2 + 0.6 * crumbleHash( cell + crumbleSlab * 7.13 );
            float d = distance( crumbleGrid, point );
            if ( d < near1 ) { near2 = near1; cell2 = cell1; near1 = d; cell1 = cell; point1 = point; }
            else if ( d < near2 ) { near2 = d; cell2 = cell; }
          }
        }
        // Each shard: whether it is let go, when, and for how long it lies.
        vec2 own = crumbleHash( cell1 + crumbleSlab * 3.7 + 11.0 );
        vec2 rest = crumbleHash( cell1 + crumbleSlab * 5.3 + 29.0 );
        float inward = length( point1 / 4.0 - 0.5 ) / 0.55;
        float score = 0.55 * own.x + 0.45 * inward;
        float inCell = step( 0.0, min( cell1.x, cell1.y ) ) * step( max( cell1.x, cell1.y ), 3.0 );
        float inFace = 1.0 - step( 0.42, max( abs( crumbleAt.x ), abs( crumbleAt.y ) ) );
        float loose = inCell * inFace * step( score, crumbleLevel / 8.0 );
        float first = 0.02 + 0.2 * ( 0.6 * inward + 0.4 * own.y );
        float last = 0.5 + 0.28 * rest.x;
        float down = loose * smoothstep( first, first + 0.1, crumbleT ) * ( 1.0 - smoothstep( last, last + 0.2, crumbleT ) );
        // The seam round a shard that is moving: it opens as the shard goes and closes as it comes back.
        float crumbleEdge = ( near2 - near1 ) * 0.5;
        float soft = fwidth( crumbleEdge ) * 0.8 + 0.001;
        float shut = 1.0 - smoothstep( last + 0.04, last + 0.3, crumbleT );
        float gap = loose * smoothstep( first - 0.03, first, crumbleT ) * shut;
        float width = ( 0.04 + 0.1 * down ) * shut;
        float seam = gap * ( 1.0 - smoothstep( width, width + soft, crumbleEdge ) );
        // The lip of the cut is chipped, and pale on the side that faces the light.
        vec2 facing = normalize( crumbleGrid - point1 + 1e-4 );
        float lit = 0.25 + 0.75 * saturate( dot( facing, vec2( -0.6, -0.8 ) ) );
        float lip = gap * smoothstep( width, width + soft, crumbleEdge ) * ( 1.0 - smoothstep( width + 0.1, width + 0.1 + soft, crumbleEdge ) ) * lit;
        #if GLASS_DETAIL > 0
          // Each shard settles at its own tilt, and catches the light accordingly.
          gl_FragColor.rgb *= 1.0 + 0.9 * ( own.y - 0.5 ) * sin( 3.1416 * down );
        #endif
        gl_FragColor.rgb *= 1.0 - 0.9 * down;
        gl_FragColor.rgb += vec3( 0.15, 0.14, 0.115 ) * lip * ( 0.4 + 0.6 * down );
        gl_FragColor.rgb *= 1.0 - 0.96 * seam;
      }`;

/**
 * Shut, the squares are face to face in the dark between the halves, and only a slot of them
 * shows along the hinge side; nothing in there is lit, and nothing in there shines. `uShut` is 1
 * while the case is shut, easing to 0 as the lid lifts.
 */
const TILE_SHUT = /* glsl */ `
      gl_FragColor.rgb *= 1.0 - 0.94 * uShut;`;

/**
 * A light square: polished ivory marble with faint grey veins. Each slab is cut from a different
 * part of the block, so no two are quite the same tone, and its face gives the room back as a
 * sheen where the eye skims it. `lift` holds a height for each of the 64 squares, a1 first; the
 * tiles carry their square's number in their data channel.
 */
export function boneTile(material: MeshStandardMaterial, look: RoomLook, lift: Float32Array, crumble: Float32Array, room: Plan, shut: { value: number }): MeshStandardMaterial {
  material.onBeforeCompile = (shader: Shader) => {
    Object.assign(shader.uniforms, look);
    tileVertex(shader, lift, crumble, shut);
    let s = shader.fragmentShader;
    s = after(
      s,
      'common',
      /* glsl */ `
      varying vec3 vRoomPos;
      varying vec3 vTilePos;
      varying float vTile;
      varying float vTileUp;
      varying float vRoomUp;
      varying float vCrumble;
      uniform float uShut;
      ${CRUMBLE_PARS}
      ${tileSeenPars(room)}
      ${HAZE_PARS}`,
    );
    s = after(
      s,
      'map_fragment',
      /* glsl */ `
      {
        float slab = floor( vTile * 63.0 + 0.5 );
        float bed = fract( sin( slab * 12.9898 ) * 43758.5453 );
        diffuseColor.rgb *= ( 0.94 + 0.12 * bed ) * mix( vec3( 1.03, 1.0, 0.955 ), vec3( 0.985, 1.0, 1.025 ), fract( bed * 7.31 ) );
      }
      ${TILE_END}`,
    );
    s = after(
      s,
      'aomap_fragment',
      /* glsl */ `
      {
        vec3 boneView = normalize( vRoomPos - cameraPosition );
        float steep = saturate( - boneView.y );
        // Straight under the light every tile sits at the mirror angle for the overhead camera; a
        // honed face keeps its sheen for glancing light and gives little back to that. And it
        // gives no light in the room back as a glare.
        reflectedLight.directSpecular = roomHeld( reflectedLight.directSpecular * ( 1.0 - 0.75 * smoothstep( 0.72, 0.95, steep ) ), 0.12 );
        // The room, in the stone: soft, and strongest where the eye skims it.
        #ifdef ROOM_MIRROR
          vec3 seen = roomMirrored( 3.4 );
        #else
          vec3 seen = roomSeen( vRoomPos, reflect( boneView, vec3( 0.0, 1.0, 0.0 ) ), vec2( 0.1, 0.18 ) );
        #endif
        float fresnel = 0.04 + 0.96 * pow( 1.0 - steep, 5.0 );
        // The room is mirrored about the board's plane: only a square lying in it, face up, mirrors
        // it (not one on the lid as it swings).
        float boneFlat = step( 0.9, vTileUp ) * smoothstep( 0.995, 0.9995, vRoomUp ) * ( 1.0 - smoothstep( 0.02, 0.06, abs( vRoomPos.y ) ) );
        reflectedLight.indirectSpecular = reflectedLight.indirectSpecular * 0.35 + roomHeld( seen * uMirror * fresnel, 0.45 ) * boneFlat;
      }
      ${TILE_END_DULL}`,
    );
    s = s.replace('#include <lights_fragment_begin>', TILE_LIGHTS);
    s = after(s, 'opaque_fragment', `${TILE_CRUMBLE}
      ${TILE_SHUT}
      gl_FragColor.rgb = roomHaze( gl_FragColor.rgb, vRoomPos );`);
    shader.fragmentShader = s;
  };
  material.customProgramCacheKey = () => 'nightpiece-bone-10';
  return material;
}

/** How finely the dark squares are drawn: 0 one layer of mist, 1 a second, nearer one, and breath under the stone. */
export type GlassDetail = 0 | 1;

/**
 * A dark square: polished marble, green-black, with crisp white veins. It is a stone first,
 * and reads as one from every seat: the veins are on its face and nothing hides them. Its life
 * is a quieter second layer, deep in the stone between the veins: a slow pale mist that drifts
 * as the eye moves, and now and then, under one square or another, something that breathes and
 * is gone; the veins themselves catch the colour of the room's mood. Polished, it mirrors the
 * room where the eye skims it. Looked at from straight above it mirrors nothing and shows no
 * glare, so the overhead view stays plain; and what it mirrors is held well under the
 * brightness of a flame, so that a reflection never hides a square.
 */
export function voidGlass(material: MeshStandardMaterial, look: RoomLook, lift: Float32Array, crumble: Float32Array, room: Plan, shut: { value: number }): MeshStandardMaterial {
  material.defines = { ...material.defines, GLASS_DETAIL: 1 };
  material.onBeforeCompile = (shader: Shader) => {
    Object.assign(shader.uniforms, look);
    tileVertex(shader, lift, crumble, shut);
    let s = shader.fragmentShader;
    s = after(
      s,
      'common',
      /* glsl */ `
      varying vec3 vRoomPos;
      varying vec3 vTilePos;
      varying float vTile;
      varying float vTileUp;
      varying float vRoomUp;
      varying float vCrumble;
      uniform float uShut;
      uniform float uMist;
      uniform vec3 uMistColour;
      ${CRUMBLE_PARS}
      ${tileSeenPars(room)}
      ${HAZE_PARS}
      ${HASH_GLSL}

      float voidFbm( vec2 p ) {
        float sum = 0.0;
        float gain = 0.5;
        for ( int i = 0; i < 4; i ++ ) {
          sum += gain * roomNoise( p );
          p = p * 2.03 + vec2( 17.1, 5.3 );
          gain *= 0.5;
        }
        return sum;
      }

      // Mist at one depth: a fog that a slower, broader one pushes about, so that it curls
      // instead of sliding by. About 0.47 on average, and never as much as 1.
      float voidMist( vec2 p, float t ) {
        vec2 push = vec2( roomNoise( p * 0.6 + vec2( 0.0, t * 0.7 ) ), roomNoise( p * 0.6 + vec2( 5.2, 3.7 - t * 0.6 ) ) );
        return voidFbm( p + ( push - 0.5 ) * 2.6 + vec2( t, - t * 0.7 ) );
      }`,
    );
    s = after(
      s,
      'map_fragment',
      /* glsl */ `
      vec3 voidView = normalize( vRoomPos - cameraPosition );
      // The veins: the white in the stone, far above its dark ground.
      float voidVein = smoothstep( 0.04, 0.3, dot( diffuseColor.rgb, vec3( 0.3333 ) ) );
      float voidTop = step( 0.9, vTileUp );
      {
        // Each slab cut from its own part of the block: a shade greener or bluer, a shade deeper.
        float slab = floor( vTile * 63.0 + 0.5 );
        float bed = fract( sin( slab * 78.233 ) * 43758.5453 );
        diffuseColor.rgb *= mix( vec3( 0.93, 1.04, 1.0 ), vec3( 1.0, 0.97, 1.06 ), bed ) * ( 0.88 + 0.24 * fract( bed * 5.31 ) );
      }
      ${TILE_END}`,
    );
    s = after(
      s,
      'emissivemap_fragment',
      /* glsl */ `
      float voidCosine = saturate( - voidView.y );
      // Nothing is mirrored for an eye straight overhead: the oculus would sit in the middle of the board.
      float voidLevel = 1.0 - smoothstep( 0.86, 0.97, voidCosine );
      float voidFresnel = 0.04 + 0.96 * pow( 1.0 - voidCosine, 5.0 );
      {
        // Light bends as it goes into the stone, so the deep is seen more nearly straight down than the eye looks.
        vec3 into = refract( voidView, vec3( 0.0, 1.0, 0.0 ), 1.0 / 1.5 );
        vec2 slide = into.xz / max( - into.y, 0.25 );
        vec2 at = vTilePos.xz;
        vec2 cell = fract( at ) - 0.5;
        float drift = uTime * 0.012;
        // Deep down, a pale mist that fills some of the dark and leaves the rest.
        float far = voidMist( ( at + slide * 1.8 ) * 0.55, drift );
        vec3 deep = uMistColour * 0.35 * smoothstep( 0.45, 0.85, far );
        #if GLASS_DETAIL > 0
          // Nearer the face, a finer mist in strands.
          float near = voidMist( ( at + slide * 0.6 ) * 1.3 + 11.0, drift * 1.7 );
          float strand = saturate( 1.0 - abs( near * 2.0 - 0.94 ) );
          deep += uMistColour * 0.3 * strand * strand * strand * far;
          // And something under one square or another breathes: a pale bloom that swells, is
          // held a moment and goes, each square in its own time and most of them seldom.
          vec3 own = roomHash3( floor( at ) + 7.0 );
          float breath = 0.5 + 0.5 * sin( uTime * ( 0.11 + 0.17 * own.x ) + own.y * 6.2832 );
          breath *= breath * breath;
          breath *= breath * step( 0.35, own.z );
          vec2 mouth = cell + slide * 0.03 - ( own.xy - 0.5 ) * 0.36;
          deep += uMistColour * 0.8 * breath * exp( - dot( mouth, mouth ) / 0.03 );
        #endif
        // It is deep in the stone: the veins on its face hide it, and the slab's edges shade it.
        deep *= ( 1.0 - voidVein ) * ( 1.0 - smoothstep( 0.3, 0.49, max( abs( cell.x ), abs( cell.y ) ) ) );
        // The veins catch the colour of the room's mood.
        vec3 veins = uMistColour * voidVein * ( 0.03 + 0.05 * far );
        #ifdef ROOM_MIRROR
          vec3 seen = roomMirrored( 1.6 );
        #else
          vec3 seen = roomSeen( vRoomPos, reflect( voidView, vec3( 0.0, 1.0, 0.0 ) ), vec2( 0.02, 0.04 ) );
        #endif
        // The room is mirrored about the board's plane: only a square lying in it mirrors it.
        float voidFlat = smoothstep( 0.995, 0.9995, vRoomUp ) * ( 1.0 - smoothstep( 0.02, 0.06, abs( vRoomPos.y ) ) );
        totalEmissiveRadiance += ( ( deep * ( 1.0 - voidFresnel ) + veins ) * uMist + roomHeld( seen * uMirror * voidFresnel * voidLevel * 0.8, 0.3 ) * voidFlat ) * voidTop;
      }`,
    );
    s = after(
      s,
      'aomap_fragment',
      /* glsl */ `
      // What the polish mirrors of the room is drawn above. The lights themselves it gives back
      // only as a held sheen: none of them is a thing in the room to be seen, and a glare on a
      // square hides it.
      // And for an eye straight overhead hardly that: the key stands high over the board, and its
      // sheen would lie across the board and turn the dark squares grey in the plan view.
      reflectedLight.directSpecular = roomHeld( reflectedLight.directSpecular, 0.12 * ( 0.1 + 0.9 * voidLevel ) );
      reflectedLight.indirectSpecular *= 1.0 - 0.75 * voidTop;
      ${TILE_END_DULL}`,
    );
    s = s.replace('#include <lights_fragment_begin>', TILE_LIGHTS);
    s = after(s, 'opaque_fragment', `${TILE_CRUMBLE}
      ${TILE_SHUT}
      gl_FragColor.rgb = roomHaze( gl_FragColor.rgb, vRoomPos );`);
    shader.fragmentShader = s;
  };
  material.customProgramCacheKey = () => 'nightpiece-void-11';
  return material;
}

/** Turn the mirror on or off for a tile material, and set how finely the glass is drawn. */
export function setGlass(material: MeshStandardMaterial, mirror: boolean, detail: GlassDetail): void {
  const defines: Record<string, unknown> = { ...material.defines, GLASS_DETAIL: detail };
  if (mirror) defines.ROOM_MIRROR = '';
  else delete defines.ROOM_MIRROR;
  material.defines = defines;
  material.needsUpdate = true;
}

/**
 * The inlay: aged brass. Where the data channel says so (red 1) it is the dark ground a coordinate
 * is cut into, not metal; and the thin blades down in the joints between the squares (red 0.5)
 * are where light comes up through the board when the room asks for it.
 */
export function gilt(material: MeshStandardMaterial, look: RoomLook): MeshStandardMaterial {
  material.onBeforeCompile = (shader: Shader) => {
    Object.assign(shader.uniforms, look);
    shader.vertexShader = after(
      after(
        shader.vertexShader,
        'common',
        /* glsl */ `
        attribute vec4 aData;
        varying vec3 vRoomPos;
        varying float vGround;`,
      ),
      'project_vertex',
      /* glsl */ `
      vRoomPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      vGround = aData.r;`,
    );
    let s = shader.fragmentShader;
    s = after(
      s,
      'common',
      /* glsl */ `
      varying vec3 vRoomPos;
      varying float vGround;
      uniform vec3 uJoint;
      ${HELD_GLSL}
      ${HAZE_PARS}`,
    );
    s = after(
      s,
      'map_fragment',
      /* glsl */ `
      float giltGround = step( 0.75, vGround );
      float giltJoint = step( 0.25, vGround ) * ( 1.0 - giltGround );
      diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.014, 0.013, 0.012 ), max( giltGround, giltJoint ) );`,
    );
    s = after(s, 'metalnessmap_fragment', 'metalnessFactor *= 1.0 - giltGround - giltJoint; roughnessFactor = mix( roughnessFactor, 0.92, giltGround + giltJoint );');
    s = after(
      s,
      'emissivemap_fragment',
      /* glsl */ `
      // Only the blades in the joints: the coordinates stay metal.
      totalEmissiveRadiance += uJoint * giltJoint;`,
    );
    s = after(
      s,
      'aomap_fragment',
      /* glsl */ `
      {
        // Seen from straight overhead the gilt lies at the mirror angle to the key, like the tiles;
        // it is old enough to give that back as a warm line and not as a glare.
        float steep = saturate( - normalize( vRoomPos - cameraPosition ).y );
        reflectedLight.directSpecular = roomHeld( reflectedLight.directSpecular * ( 1.0 - 0.7 * smoothstep( 0.72, 0.95, steep ) ), 0.7 );
      }`,
    );
    s = after(s, 'opaque_fragment', 'gl_FragColor.rgb = roomHaze( gl_FragColor.rgb, vRoomPos );');
    shader.fragmentShader = s;
  };
  material.customProgramCacheKey = () => 'nightpiece-gilt-4';
  return material;
}

/**
 * The case: walnut, with dull pale brass at its corners and hinges and baize in its drawers, as
 * the data channel's red says (0, 0.5, 1). The walnut is the material's own texture; brass and
 * baize are read with the same tiling UVs. Every chamfer (blue) is an arris worn paler by hands,
 * and the walnut darkens toward its outline, as if drawn. It is lit by the room's real lights and
 * its environment, over its own baked occlusion.
 */
export function casework(material: MeshStandardMaterial, look: RoomLook, brass: Surface, baize: Surface): MeshStandardMaterial {
  material.onBeforeCompile = (shader: Shader) => {
    Object.assign(shader.uniforms, look);
    shader.uniforms.tBrass = { value: brass.albedo };
    shader.uniforms.tBaize = { value: baize.albedo };
    shader.vertexShader = after(
      after(
        shader.vertexShader,
        'common',
        /* glsl */ `
        attribute vec4 aData;
        varying vec3 vRoomPos;
        varying vec4 vCase;`,
      ),
      'project_vertex',
      /* glsl */ `
      vRoomPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      vCase = aData;`,
    );
    let s = shader.fragmentShader;
    s = after(
      s,
      'common',
      /* glsl */ `
      varying vec3 vRoomPos;
      varying vec4 vCase;
      uniform sampler2D tBrass;
      uniform sampler2D tBaize;
      ${HELD_GLSL}
      ${HAZE_PARS}`,
    );
    s = after(
      s,
      'map_fragment',
      /* glsl */ `
      float caseBaize = step( 0.75, vCase.r );
      float caseBrass = step( 0.25, vCase.r ) * ( 1.0 - caseBaize );
      float caseWood = 1.0 - caseBrass - caseBaize;
      // Which way this facet faces, as a number from 0 to 1 that changes from facet to facet.
      vec3 caseFlat = normalize( cross( dFdx( vRoomPos ), dFdy( vRoomPos ) ) );
      float caseFacet = fract( sin( dot( floor( caseFlat * 6.0 + 0.5 ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
      {
        // Old brass, dulled with handling: warm, and every facet a slightly different value, so that
        // the faceting shows whatever the light.
        vec3 metal = texture2D( tBrass, vMapUv ).rgb;
        metal = metal * vec3( 1.12, 0.72, 0.3 ) * 0.5;
        diffuseColor.rgb = mix( diffuseColor.rgb, metal * ( 0.8 + 0.4 * caseFacet ), caseBrass );
        diffuseColor.rgb = mix( diffuseColor.rgb, texture2D( tBaize, vMapUv * 2.0 ).rgb, caseBaize );
        // Worn arrises: the walnut rubbed paler along every chamfer, the brass brighter.
        diffuseColor.rgb *= 1.0 + vCase.b * ( 0.6 * caseWood + 0.12 * caseBrass );
      }`,
    );
    s = after(
      s,
      'roughnessmap_fragment',
      'roughnessFactor = mix( roughnessFactor, 0.5 + 0.12 * ( caseFacet - 0.5 ) - 0.08 * vCase.b, caseBrass ); roughnessFactor = mix( roughnessFactor, 0.95, caseBaize );',
    );
    s = after(s, 'metalnessmap_fragment', 'metalnessFactor = 0.6 * caseBrass;');
    s = after(s, 'normal_fragment_maps', 'normal = normalize( mix( normal, nonPerturbedNormal, 0.7 * caseBrass + 0.5 * caseBaize ) );');
    s = after(
      s,
      'aomap_fragment',
      /* glsl */ `
      {
        // The walnut darkens toward its outline, as if drawn with a brush.
        float caseEdge = pow( 1.0 - saturate( abs( dot( normal, geometryViewDir ) ) ), 3.0 ) * caseWood;
        reflectedLight.directDiffuse *= 1.0 - 0.5 * caseEdge;
        reflectedLight.indirectDiffuse *= 1.0 - 0.5 * caseEdge;
        // A candle in polished brass is a warm point, not a white one. And the walnut is waxed, not
        // glass: the key falls straight down, and the bevel round the rim would throw it flat into
        // the Side view as a band of white.
        reflectedLight.directSpecular = roomHeld( reflectedLight.directSpecular, mix( 0.1, 1.2, caseBrass ) );
        // Nor does the cold light from behind Void's seat turn it green: what falls on the brass
        // keeps its strength and takes the metal's colour.
        vec3 caseShine = reflectedLight.directSpecular;
        reflectedLight.directSpecular = mix( caseShine, vec3( dot( caseShine, vec3( 0.2126, 0.7152, 0.0722 ) ) ) * vec3( 1.45, 1.0, 0.5 ), caseBrass );
        vec3 caseFall = reflectedLight.directDiffuse;
        reflectedLight.directDiffuse = mix( caseFall, vec3( dot( caseFall, vec3( 0.2126, 0.7152, 0.0722 ) ) ) * vec3( 1.3, 0.97, 0.48 ), caseBrass );
        // The brass has the room in it, dully, and warmed by the metal: the green of the chapel's
        // light is not to turn it to pewter.
        vec3 caseSeen = reflectedLight.indirectSpecular;
        reflectedLight.indirectSpecular = mix( caseSeen, vec3( dot( caseSeen, vec3( 0.2126, 0.7152, 0.0722 ) ) ) * vec3( 1.45, 1.0, 0.5 ), caseBrass );
        vec3 caseLit = reflectedLight.indirectDiffuse;
        reflectedLight.indirectDiffuse = mix( caseLit, vec3( dot( caseLit, vec3( 0.2126, 0.7152, 0.0722 ) ) ) * vec3( 1.3, 0.97, 0.48 ), caseBrass );
      }`,
    );
    s = after(s, 'opaque_fragment', 'gl_FragColor.rgb = roomHaze( gl_FragColor.rgb, vRoomPos );');
    shader.fragmentShader = s;
  };
  material.customProgramCacheKey = () => 'nightpiece-case-10';
  return material;
}

/** Tallow: lit from inside near its flame, and dark at the wick. */
export function tallow(material: MeshStandardMaterial, look: RoomLook): MeshStandardMaterial {
  material.onBeforeCompile = (shader: Shader) => {
    Object.assign(shader.uniforms, look);
    shader.vertexShader = after(
      after(
        shader.vertexShader,
        'common',
        /* glsl */ `
        attribute vec4 aData;
        varying vec3 vRoomPos;
        varying vec2 vWax;`,
      ),
      'project_vertex',
      /* glsl */ `
      vRoomPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      vWax = aData.rg;`,
    );
    let s = shader.fragmentShader;
    s = after(
      s,
      'common',
      /* glsl */ `
      varying vec3 vRoomPos;
      varying vec2 vWax;
      uniform vec3 uWax;
      ${HAZE_PARS}
      ${HELD_GLSL}`,
    );
    s = after(s, 'map_fragment', 'diffuseColor.rgb *= 1.0 - 0.94 * step( 0.5, vWax.x );');
    s = after(
      s,
      'emissivemap_fragment',
      'totalEmissiveRadiance += uWax * ( 0.06 + 0.94 * vWax.y * vWax.y * vWax.y ) * ( 1.0 - step( 0.5, vWax.x ) );',
    );
    // A flame's own light falls on its candle from a finger's width away: held, or the wax burns out to white.
    s = after(s, 'aomap_fragment', 'reflectedLight.directDiffuse = roomHeld( reflectedLight.directDiffuse, 0.8 );');
    s = after(s, 'opaque_fragment', 'gl_FragColor.rgb = roomHaze( gl_FragColor.rgb, vRoomPos );');
    shader.fragmentShader = s;
  };
  material.customProgramCacheKey = () => 'nightpiece-tallow-3';
  return material;
}

/**
 * Everything in the room that is itself light: the hairline under the altar's mensa, the night
 * behind the windows and doorways, the glass of the two roses, and the lanterns' glass. The
 * mesh's data channel says which each face is (red) and, on a lantern, how near its flame (green).
 */
export function glowMaterial(look: RoomLook, room: Plan): ShaderMaterial {
  return new ShaderMaterial({
    name: 'RoomGlow',
    uniforms: { uGlow: look.uGlow, uTime: look.uTime, uCalm: look.uCalm },
    vertexShader: /* glsl */ `
      attribute vec4 aData;
      varying float vKind;
      varying float vHeat;
      varying vec3 vRoomPos;
      void main() {
        vKind = floor( aData.r * 8.0 + 0.5 );
        vHeat = aData.g;
        vec4 world = modelMatrix * vec4( position, 1.0 );
        vRoomPos = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uGlow[ 5 ];
      uniform float uTime;
      uniform float uCalm;
      varying float vKind;
      varying float vHeat;
      varying vec3 vRoomPos;
      ${HASH_GLSL}
      ${FLICKER_GLSL}
      void main() {
        vec3 colour = vKind < 0.5 ? uGlow[ 0 ] : vKind < 1.5 ? uGlow[ 1 ] : vKind < 2.5 ? uGlow[ 2 ] : vKind < 3.5 ? uGlow[ 3 ] : uGlow[ 4 ];
        if ( vKind > 0.5 && vKind < 3.5 ) {
          // Glass in the walls is leaded in diamond quarries, each pane a little unlike the next.
          vec2 reach = abs( vRoomPos.xz );
          vec2 plane = vec2( reach.x > reach.y ? vRoomPos.z : vRoomPos.x, vRoomPos.y ) / 0.42;
          vec2 diamond = vec2( plane.x + plane.y, plane.x - plane.y );
          vec2 toLead = abs( fract( diamond ) - 0.5 );
          vec2 pixel = max( fwidth( diamond ), vec2( 1e-4 ) );
          float lead = max( smoothstep( 0.5 - 0.06 - pixel.x, 0.5 - 0.06, toLead.x ), smoothstep( 0.5 - 0.06 - pixel.y, 0.5 - 0.06, toLead.y ) );
          colour *= ( 0.82 + 0.3 * roomHash( floor( diamond ) + 11.0 ) ) * mix( 1.0, 0.18, lead * min( 1.0, 0.25 / max( pixel.x, pixel.y ) ) );
        }
        if ( vKind > 0.5 && vKind < 1.5 ) {
          // Through old glass the night is a dim dusk, greyed toward violet and far below the open
          // oculus; a little warmer and brighter toward each sill, as if a town glowed below it.
          float sill = vRoomPos.y < ${f(room.window.sill - 0.6)} ? ${f(room.floorY)} : ${f(room.window.sill - 0.2)};
          float low = 1.0 - smoothstep( sill, sill + 4.5, vRoomPos.y );
          float grey = dot( colour, vec3( 0.3, 0.5, 0.2 ) );
          colour = mix( grey * vec3( 0.66, 0.64, 0.82 ), colour, 0.3 ) * ( 0.22 + 0.16 * low ) * mix( vec3( 1.0 ), vec3( 1.3, 1.02, 0.82 ), low );
        }
        // A lantern's glass is brightest round its flame, and moves with it.
        if ( vKind > 3.5 ) colour *= ( 0.3 + 0.7 * vHeat * vHeat ) * flicker( floor( vRoomPos.x * 0.17 + 0.5 ) * 3.1 + floor( vRoomPos.z * 0.17 + 0.5 ) * 7.3, uTime, uCalm );
        gl_FragColor = vec4( colour, 1.0 );
      }`,
  });
}

/**
 * The room's iron and brass: the lanterns, their rods and brackets, the doors' straps and the
 * candlesticks on the altar. None of it is in the atlases; it is lit by the candles' general
 * glow, by the lantern it belongs to (green in the data channel says how near that is), and by
 * whatever lights the scene has. Red in the data channel says brass.
 */
export function ironwork(look: RoomLook): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.75, envMapIntensity: 0 });
  material.onBeforeCompile = (shader: Shader) => {
    Object.assign(shader.uniforms, look);
    shader.vertexShader = after(
      after(
        shader.vertexShader,
        'common',
        /* glsl */ `
        attribute vec4 aData;
        varying vec3 vRoomPos;
        varying vec2 vMetal;`,
      ),
      'project_vertex',
      /* glsl */ `
      vRoomPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      vMetal = aData.rg;`,
    );
    let s = shader.fragmentShader;
    s = after(
      s,
      'common',
      /* glsl */ `
      varying vec3 vRoomPos;
      varying vec2 vMetal;
      uniform vec3 uCandle;
      uniform vec3 uGlow[ 5 ];
      uniform float uCalm;
      uniform float uTime;
      ${HAZE_PARS}
      ${HASH_GLSL}
      ${FLICKER_GLSL}`,
    );
    s = after(
      s,
      'map_fragment',
      /* glsl */ `
      float roomBrass = step( 0.5, vMetal.x );
      diffuseColor.rgb = mix( vec3( 0.06, 0.055, 0.05 ), vec3( 0.62, 0.46, 0.22 ), roomBrass );`,
    );
    s = after(s, 'roughnessmap_fragment', 'roughnessFactor = mix( 0.62, 0.38, roomBrass );');
    s = after(
      s,
      'aomap_fragment',
      /* glsl */ `
      {
        // The candles' warmth over everything, and the lantern's own light on its frame and rod.
        float near = vMetal.y;
        float flame = flicker( floor( vRoomPos.x * 0.17 + 0.5 ) * 3.1 + floor( vRoomPos.z * 0.17 + 0.5 ) * 7.3, uTime, uCalm );
        vec3 warm = uCandle * 0.05 + uGlow[ 4 ] * near * flame * 0.35;
        reflectedLight.indirectDiffuse += warm * ( diffuseColor.rgb + 0.25 );
        reflectedLight.indirectSpecular += warm * mix( vec3( 0.25 ), diffuseColor.rgb, roomBrass ) * 0.6;
      }`,
    );
    s = after(s, 'opaque_fragment', 'gl_FragColor.rgb = roomHaze( gl_FragColor.rgb, vRoomPos );');
    shader.fragmentShader = s;
  };
  material.customProgramCacheKey = () => 'nightpiece-iron-1';
  return material;
}
