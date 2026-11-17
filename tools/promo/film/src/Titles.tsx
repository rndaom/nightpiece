import type React from 'react';
import { useCurrentFrame } from 'remotion';
import { around, Burst, Icon } from './art';
import { leave, slap } from './motion';
import { Sheet } from './Sheet';
import { Slip } from './Slip';
import { body, C, display, label } from './theme';
import type { Caption as CaptionSpec, Card as CardSpec, Slam as SlamSpec } from './timeline';

/** Where every caption sits: its bottom left corner, in a picture 1920 by 1080. All of them sit there, and all lie the same way. */
const FOOT: [number, number] = [92, 984];
const LIE = -1.2;

/** The small line over what is said: what it is about. */
function Kicker({ children, size = 22 }: { children: React.ReactNode; size?: number }) {
  return <div style={{ ...label(118, 800), fontSize: size, lineHeight: 1.2, letterSpacing: '0.09em', color: C.spiritDeep, filter: 'url(#boil-fine)', marginBottom: size * 0.32 }}>{children}</div>;
}

/**
 * Words over the picture, on one sheet: a small line saying what they are about, what is said in
 * the display face, and sometimes a plainer line under it. Slapped down at the foot of the
 * picture on the left, always in the same place and lying the same way.
 */
export function Caption({ spec }: { spec: CaptionSpec }) {
  const frame = useCurrentFrame();
  if (frame < spec.from || frame >= spec.to) return null;
  const k = slap(frame, spec.from);
  const gone = spec.whisk === false ? 0 : leave(frame, spec.to);
  return (
    <div
      style={{
        position: 'absolute',
        left: FOOT[0],
        bottom: 1080 - FOOT[1],
        transformOrigin: '0% 100%',
        transform: `translate(${-gone * 150}px, ${-k * 30 + gone * 8}px) rotate(${LIE + k * 4 - gone * 4}deg) scale(${1 + k * 0.3})`,
        opacity: 1 - gone,
      }}
    >
      <Slip id={`caption-${spec.id}`} pad={[40, 22]} sheet={{ shadow: 10, under: C.spiritDeep }}>
        {spec.kicker ? <Kicker>{spec.kicker}</Kicker> : null}
        <div style={{ ...display(144), fontSize: 76, lineHeight: 1.02, color: C.ink, filter: 'url(#boil)', paddingBottom: 6 }}>
          {spec.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
        {spec.note ? <div style={{ ...body(600), fontSize: 31, lineHeight: 1.25, color: C.ink, opacity: 0.86, filter: 'url(#boil-fine)', marginTop: 10, paddingBottom: 2 }}>{spec.note}</div> : null}
      </Slip>
    </div>
  );
}

/**
 * A sheet slapped over the middle of the picture for a moment: what the next shot is, in a few
 * large words, with the game's own sign for it. It is whisked up and away again.
 */
export function Card({ spec }: { spec: CardSpec }) {
  const frame = useCurrentFrame();
  if (frame < spec.from || frame >= spec.to) return null;
  const k = slap(frame, spec.from);
  const gone = leave(frame, spec.to, 9);
  const [w, h] = [1480, 620];
  const [x, y] = [(1920 - w) / 2, (1080 - h) / 2];
  // What is said is set as large as the sheet has room for.
  const longest = Math.max(...spec.lines.map((l) => l.length));
  const size = spec.lines.length > 1 ? 132 : longest > 17 ? 104 : longest > 14 ? 122 : 148;
  return (
    <>
      <div style={{ position: 'absolute', left: x, top: y, transformOrigin: '50% 50%', transform: `translate(${-gone * 380}px, ${-gone * 1150}px) rotate(${LIE + k * 5 - gone * 12}deg) scale(${1 + k * 0.32})` }}>
        <Sheet id={`card-${spec.id}`} w={w} h={h} shadow={16} under={C.spiritDeep} rough={3} lineWidth={3.5}>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', padding: '0 100px', gap: 56 }}>
            {spec.icon ? <Icon name={spec.icon} size={190} /> : null}
            <div>
              {spec.kicker ? <Kicker size={30}>{spec.kicker}</Kicker> : null}
              <div style={{ ...display(144), fontSize: size, lineHeight: 1.0, color: C.ink, filter: 'url(#boil)', whiteSpace: 'nowrap', paddingBottom: 14 }}>
                {spec.lines.map((l) => (
                  <div key={l}>{l}</div>
                ))}
              </div>
            </div>
          </div>
        </Sheet>
      </div>
      <Burst at={spec.from + 2} marks={around(x, y, w, h, 7)} color={C.paper} width={7} length={56} />
    </>
  );
}

/** A word or two, large, slapped down across the lower middle of the picture, and whisked off. */
export function Slam({ spec }: { spec: SlamSpec }) {
  const frame = useCurrentFrame();
  if (frame < spec.from || frame >= spec.to) return null;
  const k = slap(frame, spec.from);
  const gone = leave(frame, spec.to, 8);
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 716, display: 'flex', justifyContent: 'center' }}>
      <div style={{ transformOrigin: '50% 50%', transform: `translate(${-gone * 240}px, ${gone * 20}px) rotate(${LIE + k * 6 - gone * 6}deg) scale(${1 + k * 0.5})`, opacity: 1 - gone }}>
        <Slip id={`slam-${spec.id}`} pad={[64, 26]} sheet={{ shadow: 14, under: C.spiritDeep, rough: 2.8, lineWidth: 3.2 }}>
          <div style={{ ...display(144), fontSize: 168, lineHeight: 1.0, color: C.ink, filter: 'url(#boil)', paddingBottom: 16 }}>{spec.text}</div>
        </Slip>
      </div>
    </div>
  );
}
