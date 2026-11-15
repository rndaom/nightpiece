/**
 * Materials for the Blender-built assets. The six finishes come from the
 * style bible, section 4: board-formed concrete, bush-hammered limestone,
 * honed basalt, dull brass, flat light and (from milestone 4) void glass.
 */
import { Color, MeshStandardMaterial, ShaderChunk, type Texture, Vector2, Vector3, Vector4 } from 'three';
import type { Side } from '../core/game';
import type { Assets, Surface } from './assets';
import { baked, boneTile, casework, gilt, glowMaterial, ironwork, roomLook, tallow, voidGlass } from './roomshade';

interface SurfaceOptions {
  tint?: number;
  /** Multiplies the roughness stored in the texture (the result is clamped to 1). */
  roughness?: number;
  /** Ignore the texture's roughness and use this value everywhere. */
  flatRoughness?: number;
  metalness?: number;
  /** Strength of the surface relief. */
  relief?: number;
  ao?: Texture;
  aoIntensity?: number;
  envIntensity?: number;
}

export function surfaceMaterial(surface: Surface, o: SurfaceOptions = {}): MeshStandardMaterial {
  const relief = o.relief ?? 1;
  return new MeshStandardMaterial({
    map: surface.albedo,
    color: o.tint ?? 0xffffff,
    normalMap: surface.normal,
    // The textures are sampled with glTF's flipped V, which mirrors the green channel.
    normalScale: new Vector2(relief, -relief),
    roughnessMap: o.flatRoughness === undefined ? surface.orm : null,
    roughness: o.flatRoughness ?? o.roughness ?? 1,
    metalnessMap: surface.orm,
    metalness: o.metalness ?? 0,
    aoMap: o.ao ?? null,
    aoMapIntensity: o.aoIntensity ?? 1,
    envMapIntensity: o.envIntensity ?? 1,
  });
}

/** Light from inside each side's stone: candle gold for Ivory, spirit mint for Void. In linear HDR. */
export const GLOW: Record<Side, Color> = {
  w: new Color(1.0, 0.56, 0.2).multiplyScalar(1.7),
  b: new Color(0.16, 0.92, 0.74).multiplyScalar(1.8),
};

/**
 * How each side's set is dressed. Ivory is old bone: cream, satin, its shadows warm, its worn edges
 * a shade paler, and its light carried a little way into it. Void is ebony: near black, polished,
 * read by its edges, which catch the room in a cool blue-grey, and by the light in its joints.
 */
const STONE: Record<
  Side,
  {
    tint: number;
    roughness: number;
    relief: number;
    env: number;
    /** Grazing sheen in the glow colour (strength, falloff), then what a chamfer does to colour and to roughness. */
    sheen: [number, number, number, number];
    /** Brightness of seams and of marks next to an eye at 1; how strongly they light the stone; how much of that ignores the stone's own colour. */
    spill: [number, number, number, number];
    /** Light the stone gives off by itself, and how deeply crevices shade direct light. */
    body: [number, number];
    /** The cast the stone gives to the room it mirrors. */
    gloss: number;
    /**
     * What becomes of the low light from the other player's end of the room, which falls full on
     * this side's faces: the colour it is turned toward, and how far. It keeps its strength.
     */
    rim: [number, number];
    /** A light of the stone's own along its chamfers, strongest where they look up and away: the colour, and how much. */
    edge: [number, number];
  }
> = {
  w: {
    tint: 0xdcd1bf,
    roughness: 1.0,
    relief: 0.3,
    env: 0.55,
    sheen: [0.03, 3.5, 1.12, 0.8],
    spill: [0.6, 0.7, 1.3, 0.0],
    body: [0.012, 0.4],
    gloss: 0xffffff,
    // Void's green on bone is celadon, and Ivory seen from Void's seat was no longer ivory.
    rim: [0xfff0d8, 0.8],
    edge: [0xfff0d8, 0],
  },
  // Ebony is polished, but its chamfers are no smoother than its faces: a polished edge turns every
  // candle into a white spark, brighter than the light in the joints. It mirrors only a little of the
  // green room, and that in a cool grey, so that its black stays black and not teal; what tells its
  // shape is a cool blue-grey light along the chamfers, where the arrises catch. The mint is kept to
  // the joints and the eyes.
  b: {
    tint: 0xffffff,
    roughness: 1.25,
    relief: 0.4,
    env: 1.0,
    sheen: [0.008, 4.5, 2.0, 0.9],
    spill: [0.42, 0.6, 0.6, 0.03],
    body: [0.0, 0.3],
    gloss: 0x9c9fbc,
    // Ivory's gold on ebony is bronze at the corners, which is welcome.
    rim: [0xffffff, 0],
    edge: [0x9fb2d0, 0.08],
  },
};

/**
 * three's own loop over the lights, changed in two places. The key leans (chapel.ts, KEY_LEAN), so
 * a piece has a lit side and a dark one and lays its shadow on its neighbours: that shadow is the
 * shadow map's, on every face. What each piece was baked with, how open each part of it is to a
 * light from overhead (`pieceKeyOpen`), was made for a plumb key; it is kept in part, as the
 * shade a collar or a crown lays on what is under it, softer than the map draws it.
 *
 * The key is told from the room's other spot lights (the low ones behind the players) by what
 * only it does: it casts shadows, and it shines through a drawn square.
 *
 * Of those low lights, the one at the far end of the room from a side is the one that lights its
 * faces, in the other side's colour. On pale stone that colour is all that is seen, so it is
 * turned toward a colour of the stone's own choosing (`uRim`), keeping its strength.
 */
/** How much of the baked shade from overhead is kept on the key (see below). */
const PIECE_KEY_BAKED = 0.4;
/** The most of the room's lights that a stone gives back as a highlight, in each of red, green and blue. */
const PIECE_SHINE = 0.5;
const PIECE_LIGHTS = ShaderChunk.lights_fragment_begin
  .replace(
    '#undef SPOT_LIGHT_MAP_INDEX',
    `#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS ) || ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			directLight.color *= mix( 1.0, pieceKeyOpen, ${PIECE_KEY_BAKED.toFixed(2)} );
		#else
			directLight.color = mix( directLight.color, uRim.rgb * dot( directLight.color, vec3( 0.2126, 0.7152, 0.0722 ) ), uRim.a * smoothstep( 0.0, 0.25, dot( directLight.direction, pieceFarEnd ) ) );
		#endif
		#undef SPOT_LIGHT_MAP_INDEX`,
  );

/** A colour as a light's cast: scaled so that it is as bright as white, with how far a light is turned toward it. */
function rimCast(hex: number, amount: number): Vector4 {
  const c = new Color(hex);
  const brightness = Math.max(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, 1e-4);
  return new Vector4(c.r / brightness, c.g / brightness, c.b / brightness, amount);
}

/** A colour and how much of it, as one uniform. */
function edgeLight(hex: number, amount: number): Vector4 {
  const c = new Color(hex);
  return new Vector4(c.r, c.g, c.b, amount);
}

/** Pieces made so far; each is cut from a different part of the stone. */
let cut = 0;

export interface PieceUniforms {
  /** Brightness of seams, eyes and marks. 1 at rest. */
  uEnergy: { value: number };
  /** How far each block has risen above the one below, in squares. Drives breathing. */
  uBreath: { value: number };
  /** Brightness of the eye, on the scale where a seam at rest is `uSpill.x`. */
  uEye: { value: number };
  uGlowColor: { value: Color };
  /** See `STONE`. Fixed for each side. */
  uSheen: { value: Vector4 };
  uSpill: { value: Vector4 };
  uBody: { value: Vector2 };
  uGloss: { value: Color };
  /** See `STONE.rim`: the colour, scaled to be as bright as white, and how far the light is turned toward it. */
  uRim: { value: Vector4 };
  /** The end of the room that light comes from: 1 for Ivory's (+z), -1 for Void's. */
  uRimFrom: { value: number };
  /** See `STONE.edge`: the colour, and how much. */
  uEdge: { value: Vector4 };
  uSpillMap: { value: Texture };
  /** Where in the stone texture this piece was cut from. */
  uStone: { value: Vector2 };
  /**
   * How the piece holds itself: x is how far its head is turned (radians), y how much it is
   * squashed, and z, w how far it leans along its own x and z for each unit of height.
   */
  uPose: { value: Vector4 };
  /** The first block, counting from the foot, that turns with the head. */
  uHead: { value: number };
  /** The line the head turns about: a unit vector, and a point it passes through. Straight up through the foot unless the piece says otherwise. */
  uAxis: { value: Vector3 };
  uPivot: { value: Vector3 };
}

export type PieceMaterial = MeshStandardMaterial & { userData: { uniforms: PieceUniforms } };

/**
 * A piece's stone. One material per piece, so each can breathe and flare on
 * its own; they all share a single compiled shader.
 *
 * The mesh's `aData` attribute drives the extras: red is the block (module)
 * index, green marks glowing parts (0.6 at a part's rim, rising to 1 at its
 * heart), blue marks chamfers, alpha tells an eye from a mark from a seam.
 * The atlas read through UV1 holds ambient occlusion in red, each part's
 * openness to the key light in green, and in blue whether it is clear of the
 * piece's own shadow.
 */
export function pieceMaterial(assets: Assets, side: Side): PieceMaterial {
  const stone = side === 'w' ? assets.surfaces.pieces_bone : assets.surfaces.pieces_ebony;
  const dress = STONE[side];
  const material = surfaceMaterial(stone, {
    tint: dress.tint,
    // Each set's stored roughness is used as it is: bone satin, ebony polished.
    roughness: dress.roughness,
    relief: dress.relief,
    ao: assets.piecesAo,
    aoIntensity: 1.0,
    envIntensity: dress.env,
  }) as PieceMaterial;

  // Steps of one over the plastic number and one over its square: successive cuts land far apart.
  cut += 1;
  const uniforms: PieceUniforms = {
    uEnergy: { value: 1 },
    uBreath: { value: 0 },
    uEye: { value: 1.5 },
    uGlowColor: { value: GLOW[side].clone() },
    uSheen: { value: new Vector4(...dress.sheen) },
    uSpill: { value: new Vector4(...dress.spill) },
    uBody: { value: new Vector2(...dress.body) },
    uGloss: { value: new Color(dress.gloss) },
    uRim: { value: rimCast(...dress.rim) },
    uRimFrom: { value: side === 'w' ? -1 : 1 },
    uEdge: { value: edgeLight(...dress.edge) },
    uSpillMap: { value: assets.piecesGlow },
    uStone: { value: new Vector2((cut * 0.7548776662) % 1, (cut * 0.569840291) % 1) },
    uPose: { value: new Vector4() },
    uHead: { value: 1 },
    uAxis: { value: new Vector3(0, 1, 0) },
    uPivot: { value: new Vector3() },
  };
  material.userData.uniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aData;
        uniform float uBreath;
        uniform vec4 uPose;
        uniform float uHead;
        uniform vec3 uAxis;
        uniform vec3 uPivot;
        uniform vec2 uStone;
        varying vec3 vPieceData;
        // Turn a vector about the head's axis, given the cosine and sine of the angle.
        vec3 pieceTurned( vec3 v, float c, float s ) {
          return v * c + cross( uAxis, v ) * s + uAxis * dot( uAxis, v ) * ( 1.0 - c );
        }`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        // No two pieces are cut from the same part of the stone.
        #ifdef USE_MAP
          vMapUv += uStone;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv += uStone;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv += uStone;
        #endif
        #ifdef USE_METALNESSMAP
          vMetalnessMapUv += uStone;
        #endif`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        // The head (the block with the eye, and everything above it) turns about its own axis.
        float pieceBlock = floor( aData.r * 8.0 + 0.5 );
        float pieceTurn = pieceBlock >= uHead ? uPose.x : 0.0;
        float pieceCos = cos( pieceTurn );
        float pieceSin = sin( pieceTurn );
        objectNormal = pieceTurned( objectNormal, pieceCos, pieceSin );`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // Each block rides a little higher than the one below; the seams are skinned to both and stretch.
        transformed.y += pieceBlock * uBreath;
        transformed = uPivot + pieceTurned( transformed - uPivot, pieceCos, pieceSin );
        // A flinch squashes the whole stack and spreads it a little; a lean shears it from the foot.
        transformed.y *= 1.0 - uPose.y;
        transformed.xz *= 1.0 + uPose.y * 0.4;
        transformed.xz += uPose.zw * transformed.y;
        vPieceData = aData.gba;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uGlowColor;
        uniform float uEnergy;
        uniform float uEye;
        uniform vec4 uSheen;
        uniform vec4 uSpill;
        uniform vec2 uBody;
        uniform vec3 uGloss;
        uniform vec4 uRim;
        uniform float uRimFrom;
        uniform vec4 uEdge;
        uniform sampler2D uSpillMap;
        varying vec3 vPieceData;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float glow = step( 0.5, vPieceData.x );
        // What the corners hand down can be read a hair outside its triangle, so it is kept in range.
        float chamfer = saturate( vPieceData.y ) * ( 1.0 - glow );
        // Chamfers are honed: a shade brighter and smoother. Glowing parts carry no stone colour at all.
        diffuseColor.rgb *= mix( 1.0, uSheen.z, chamfer ) * ( 1.0 - glow );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor *= mix( 1.0, uSheen.w, chamfer );`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // Seams are embers, marks a little more, and the eye is the lamp. Each burns brightest at
        // its heart (the data channel fades toward the rim) and when looked at squarely.
        float kind = vPieceData.z;
        float level = kind > 0.9 ? uEye : ( kind > 0.4 ? uSpill.y : uSpill.x );
        float heat = smoothstep( 0.6, 1.0, vPieceData.x );
        // Never a division by nothing here, nor (for the sheen below) a power of less than nothing:
        // one pixel that is not a number is spread over the whole picture by the bloom.
        vec3 pieceView = vViewPosition / max( length( vViewPosition ), 1e-4 );
        float facing = saturate( dot( normal, pieceView ) );
        totalEmissiveRadiance += uGlowColor * glow * uEnergy * level * mix( 0.16, 1.0, heat ) * mix( 0.55, 1.0, facing );
        // The stone beside them is lit by them, and carries some of that light a little way inside.
        vec3 spill = texture2D( uSpillMap, vAoMapUv ).rgb;
        spill *= spill;
        float lit = ( spill.r * uSpill.x + spill.b * uSpill.y + spill.g * uEye ) * uSpill.z * uEnergy;
        // Baked with the piece: how open each part is to the room (red) and to a light from overhead (green).
        vec4 pieceBake = texture2D( aoMap, vAoMapUv );
        float pieceKeyOpen = pieceBake.g;
        // The way to the other player's end of the room, as the camera sees it.
        vec3 pieceFarEnd = ( viewMatrix * vec4( 0.0, 0.0, uRimFrom, 0.0 ) ).xyz;
        // A thin sheen in the side's colour where a face turns away, less of it down in the joints.
        float rim = pow( max( 1.0 - facing, 0.0 ), uSheen.y ) * uSheen.x * ( 0.35 + 0.65 * pieceBake.r );
        totalEmissiveRadiance += uGlowColor * ( 1.0 - glow ) * ( lit * mix( diffuseColor.rgb, vec3( 1.0 ), uSpill.w ) + rim + uBody.x * diffuseColor.rgb );
        // The stone's own light along its chamfers: most where one looks up toward the lamps overhead
        // and where it turns from the eye, least down in the joints.
        float pieceUp = dot( normal, ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
        totalEmissiveRadiance += uEdge.rgb * uEdge.a * chamfer * smoothstep( -0.4, 0.9, pieceUp ) * ( 0.45 + 0.55 * ( 1.0 - facing ) ) * pieceBake.r;`,
      )
      .replace('#include <lights_fragment_begin>', PIECE_LIGHTS)
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        // The joints are deep: they shade the light that falls straight on the stone, too.
        float cavity = mix( 1.0, ambientOcclusion, uBody.y );
        reflectedLight.directDiffuse *= cavity;
        // And no light in the room is given back by a stone as a glare: the low light behind a side
        // stands in line with its own rook and the other player's shoulder, and without this the
        // rook's crown shone there like a stone that had been chosen.
        vec3 pieceShine = reflectedLight.directSpecular * cavity;
        reflectedLight.directSpecular = pieceShine * ( ${PIECE_SHINE.toFixed(2)} / max( ${PIECE_SHINE.toFixed(2)}, max( pieceShine.r, max( pieceShine.g, pieceShine.b ) ) ) );
        reflectedLight.indirectSpecular *= uGloss;`,
      );
  };
  material.customProgramCacheKey = () => 'nightpiece-piece-13';
  return material;
}

/**
 * The fixed materials of the board and room, built once. `sigil` is the chalk drawn on the floor
 * round the altar. What each is beyond a stock material (baked light, haze, the void glass) is
 * in roomshade.ts; `look` is the one set of values they all read, which the chapel drives.
 */
export function roomMaterials(assets: Assets, sigil: Texture) {
  const s = assets.surfaces;
  const tileLift = new Float32Array(64);
  const tileCrumble = new Float32Array(64);
  const caseShut = { value: 0 };
  const look = roomLook(assets.roomLight, assets.roomAo);
  // The room's own light is baked into it. The environment is for what is not: the tiles and the pieces.
  const lit = { ao: assets.roomAo, envIntensity: 0 };
  return {
    look,
    /** How high each square's tile stands above its seat. Written by the board's effects. */
    tileLift,
    /** How far each square's face has got in breaking up, or 0 for a whole one (see `TILE_CRUMBLE`). Written by the board's effects. */
    tileCrumble,
    /** 1 while the case is shut, easing to 0 as the lid lifts: the squares between the halves are in the dark. Written by the world. */
    caseShut,
    // Light squares: polished pale marble with faint grey veins, a step darker and cooler than the pieces that stand on them.
    tilesLight: boneTile(surfaceMaterial(s.marble_light, { tint: 0xb4b3ac, roughness: 0.9, relief: 0.2, envIntensity: 1 }), look, tileLift, tileCrumble, assets.room, caseShut),
    // Dark squares: polished green-black marble with crisp white veins, and something alive deep in it.
    tilesDark: voidGlass(surfaceMaterial(s.marble_dark, { tint: 0xffffff, roughness: 0.8, relief: 0.2, envIntensity: 1 }), look, tileLift, tileCrumble, assets.room, caseShut),
    inlay: gilt(surfaceMaterial(s.brass, { tint: 0xeadfca, metalness: 0.62, roughness: 0.8, relief: 0.6, envIntensity: 1.3 }), look),
    // The case: walnut with dull, pale brass at its corners, and baize in its drawers. Its own
    // occlusion is baked; the room's lights and the environment do the rest.
    case: casework(surfaceMaterial(s.walnut, { roughness: 1.0, relief: 0.5, ao: assets.caseAo, envIntensity: 0.8 }), look, s.brass, s.baize),
    // The altar: the walls' sandstone, held a shade down so that the case on it is what catches the eye.
    plinth: baked(surfaceMaterial(s.sandstone, { tint: 0x968e80, relief: 0.8, ...lit }), look, { second: 'slot' }),
    // Flags of grey limestone, laid on the diagonal in two tones; the shader lays them.
    floor: baked(surfaceMaterial(s.flagstone, { tint: 0xaaa499, relief: 0.7, ...lit }), look, {
      second: 'ring',
      floor: { slab: assets.room.bay / 2, sigil, sigilSize: 22, room: assets.room },
    }),
    shell: baked(surfaceMaterial(s.sandstone, { tint: 0xa39a88, relief: 1.0, ...lit }), look, { second: 'ring', bay: assets.room.bay }),
    // The doors' oak, lit by the same atlases as the stone.
    timber: baked(surfaceMaterial(s.oak, { tint: 0x9a8a78, relief: 0.8, ...lit }), look, { second: 'ring', bay: assets.room.bay }),
    // Iron and brass: red in the data channel says which; green how near the lantern's flame.
    metal: ironwork(look),
    wax: tallow(new MeshStandardMaterial({ map: s.limestone_honed.albedo, color: 0xf0dfba, roughness: 0.5, envMapIntensity: 0 }), look),
    /** Everything in the room that is itself light. */
    glow: glowMaterial(look, assets.room),
  };
}
