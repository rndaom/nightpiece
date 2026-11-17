import type React from 'react';
import { staticFile } from 'remotion';
import { cutEdge, hash, pathOf, random, useBoil } from './boil';
import { C } from './theme';

export const GRAIN = staticFile('tex/grain.png');

/**
 * A sheet of paper cut by hand and laid on the picture: its colour, the paper's grain over it,
 * a hard shadow thrown down and to the right, and an inked outline that boils. The sheet itself
 * keeps its shape; only the line round it is drawn afresh.
 */
export function Sheet(props: {
  id: string;
  w: number;
  h: number;
  color?: string;
  line?: string | null;
  lineWidth?: number;
  shadow?: number;
  shadowColor?: string;
  under?: string | null;
  rough?: number;
  grain?: number;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const { id, w, h, color = C.paper, line = C.ink, lineWidth = 2.5, shadow = 9, shadowColor = C.ink, under = null, rough = 2.2, grain = 0.9 } = props;
  const step = useBoil(hash(id) % 6);
  const seed = hash(id);
  if (w <= 0 || h <= 0) return <div style={{ position: 'relative', ...props.style }}>{props.children}</div>;
  const edge = pathOf(cutEdge(w, h, rough, seed));
  const drawn = pathOf(cutEdge(w, h, rough * 0.8, seed + 1 + step));
  const again = pathOf(cutEdge(w, h, rough * 1.1, seed + 977 + step));
  const r = random(seed + step * 31);
  const [gx, gy] = [Math.floor(r() * 512), Math.floor(r() * 512)];
  const pad = 40;
  return (
    <div style={{ position: 'relative', width: w, height: h, ...props.style }}>
      <svg width={w + pad * 2} height={h + pad * 2} viewBox={`${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`} style={{ position: 'absolute', left: -pad, top: -pad, overflow: 'visible' }}>
        <defs>
          <pattern id={`grain-${id}`} width={512} height={512} patternUnits="userSpaceOnUse" patternTransform={`translate(${gx} ${gy})`}>
            <image href={GRAIN} width={512} height={512} />
          </pattern>
        </defs>
        {under ? <path d={edge} fill={under} transform={`translate(${shadow * 2} ${shadow * 2})`} /> : null}
        {shadow > 0 ? <path d={edge} fill={shadowColor} transform={`translate(${shadow} ${shadow})`} /> : null}
        <path d={edge} fill={color} />
        {grain > 0 ? <path d={edge} fill={`url(#grain-${id})`} opacity={grain} style={{ mixBlendMode: 'multiply' }} /> : null}
        {line ? (
          <>
            <path d={drawn} fill="none" stroke={line} strokeWidth={lineWidth} strokeLinejoin="round" />
            <path d={again} fill="none" stroke={line} strokeWidth={lineWidth * 0.45} strokeLinejoin="round" opacity={0.7} />
          </>
        ) : null}
      </svg>
      <div style={{ position: 'absolute', inset: 0 }}>{props.children}</div>
    </div>
  );
}

/**
 * The filter that makes inked lettering and drawings boil: each drawing pushes the ink about by
 * a pixel or two, a different way. One for the whole picture; things ask for it by `url(#boil)`
 * (`url(#boil-fine)` for small lettering, `url(#boil-loose)` for drawings).
 */
export function BoilDefs() {
  const step = useBoil();
  const filter = (id: string, frequency: number, scale: number, offset: number) => (
    <filter id={id} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency={frequency} numOctaves={2} seed={step * 7 + offset} result="n" />
      <feDisplacementMap in="SourceGraphic" in2="n" scale={scale} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
  return (
    <svg width={0} height={0} style={{ position: 'absolute' }}>
      <defs>
        {filter('boil', 0.022, 3.2, 1)}
        {filter('boil-fine', 0.035, 1.6, 2)}
        {filter('boil-loose', 0.014, 6, 3)}
      </defs>
    </svg>
  );
}
