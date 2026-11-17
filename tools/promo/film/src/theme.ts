/** The game's own colours (src/ui/hud.css) and typefaces, for the film's titles. */
export const C = {
  ink: '#10130d',
  inkDeep: '#090b07',
  inkRaised: '#1a1d16',
  paper: '#f7ead2',
  paperShade: '#d8cbb0',
  ivory: '#f3dba4',
  gilt: '#c9a45c',
  spirit: '#59e5cc',
  spiritPale: '#c3fbf2',
  spiritDeep: '#17463a',
  violet: '#b99be6',
  violetDeep: '#5b3b8f',
  ember: '#e2714f',
  emberDeep: '#7c2c18',
} as const;

/** The display face, as the game sets its name: heavy, soft, with its odd letters on. */
export const display = (opsz = 144): React.CSSProperties => ({
  fontFamily: 'Fraunces',
  fontWeight: 900,
  fontVariationSettings: `'opsz' ${opsz}, 'SOFT' 100, 'WONK' 1`,
  letterSpacing: '-0.02em',
});

/** The label face: wide, heavy capitals. */
export const label = (width = 122, weight = 800): React.CSSProperties => ({
  fontFamily: 'Archivo',
  fontWeight: weight,
  fontStretch: `${width}%`,
  fontVariationSettings: `'wdth' ${width}`,
  textTransform: 'uppercase',
  letterSpacing: '0.035em',
});

/** The reading face. */
export const body = (weight = 600): React.CSSProperties => ({ fontFamily: 'Figtree', fontWeight: weight });

/** The small face for tags and figures. */
export const mono: React.CSSProperties = { fontFamily: 'DM Mono', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.14em' };
