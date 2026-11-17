import type React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { around, Burst, Seal, Wordmark } from './art';
import { clamp, leave, slap } from './motion';
import { Sheet } from './Sheet';
import { Slip } from './Slip';
import { C, display, label, mono } from './theme';
import { END_STEPS } from './timeline';

/** Something slapped down at frame `at`: there at once, large and askew, landed a few frames on. */
function Slapped(props: { at: number; tilt?: number; from?: number; turn?: number; origin?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  const frame = useCurrentFrame();
  if (frame < props.at) return null;
  const k = slap(frame, props.at);
  return (
    <div style={{ transformOrigin: props.origin ?? '50% 50%', transform: `rotate(${(props.tilt ?? 0) + k * (props.turn ?? 6)}deg) scale(${1 + k * (props.from ?? 0.4)})`, ...props.style }}>
      {props.children}
    </div>
  );
}

/** A small dark slip with a few words in wide capitals. */
function Chip({ id, children, color = C.ink, ink = C.paper, size = 26 }: { id: string; children: React.ReactNode; color?: string; ink?: string; size?: number }) {
  return (
    <Slip id={id} pad={[size * 0.8, size * 0.36]} sheet={{ color, line: color === C.ink ? null : C.ink, lineWidth: 1.8, shadow: 5, shadowColor: color === C.ink ? C.spiritDeep : C.ink, rough: 1.5, grain: 0.7 }}>
      <div style={{ ...label(125, 800), fontSize: size, lineHeight: 1.15, color: ink, filter: 'url(#boil-fine)' }}>{children}</div>
    </Slip>
  );
}

/**
 * The film's name, on a sheet slapped over the picture: the name as the game's title screen sets
 * it, the seal struck beside it, and what it is. It is whisked off again after two beats.
 */
export function TitleCard({ from, to }: { from: number; to: number }) {
  const frame = useCurrentFrame();
  if (frame < from || frame >= to) return null;
  const k = slap(frame, from);
  const gone = leave(frame, to, 9);
  const [x, y, w, h] = [200, 120, 1520, 830];
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          transformOrigin: '50% 50%',
          transform: `translate(${-gone * 420}px, ${-gone * 1250}px) rotate(${-1.4 + k * 5 - gone * 14}deg) scale(${1 + k * 0.32})`,
        }}
      >
        <Sheet id="title" w={w} h={h} shadow={16} under={C.spiritDeep} rough={3} lineWidth={3.5}>
          <div style={{ position: 'absolute', left: 250, top: 150, transform: 'rotate(-3deg)', transformOrigin: '0 100%' }}>
            <Wordmark size={330} />
          </div>
          <Slapped at={from + 9} tilt={-9} from={1.3} turn={38} style={{ position: 'absolute', left: 1010, top: 96 }}>
            <Seal size={250} face={C.ink} ink={C.paper} shadow={C.spiritDeep} id="title-seal" />
          </Slapped>
          <Slapped at={from + 17} tilt={2.2} origin="100% 50%" style={{ position: 'absolute', right: 110, bottom: 82 }}>
            <Chip id="title-what" color={C.spirit} ink={C.ink} size={38}>
              A game of chess
            </Chip>
          </Slapped>
        </Sheet>
      </div>
      <Burst at={from + 2} marks={around(x, y, w, h, 7)} color={C.paper} width={7} length={60} />
    </>
  );
}

/**
 * The last card: the name and the seal, that the game is free and runs in a browser, where it
 * is, and what need not be done to play it. The card comes down on the music's last chord and its
 * parts after it, one at a time, the address last. It stays.
 */
export function EndCard({ from, to, address }: { from: number; to: number; address: string }) {
  const frame = useCurrentFrame();
  if (frame < from || frame >= to) return null;
  const k = slap(frame, from);
  const [x, y, w, h] = [150, 96, 1620, 888];
  const drift = interpolate(frame, [from, from + 400], [0, 1], clamp);
  const left = 118;
  return (
    <>
      <div style={{ position: 'absolute', left: x, top: y, transformOrigin: '50% 50%', transform: `rotate(${-1 + k * 5 + drift * 0.2}deg) scale(${1 + k * 0.32 + drift * 0.012})` }}>
        <Sheet id="end" w={w} h={h} shadow={16} under={C.spiritDeep} rough={3} lineWidth={3.5}>
          <div style={{ position: 'absolute', left, top: 78, transform: 'rotate(-3deg)', transformOrigin: '0 100%' }}>
            <Wordmark size={204} />
          </div>
          <Slapped at={from + END_STEPS.seal} tilt={-9} from={1.3} turn={38} style={{ position: 'absolute', right: 160, top: 74 }}>
            <Seal size={280} face={C.ink} ink={C.paper} shadow={C.spiritDeep} id="end-seal" />
          </Slapped>
          <Slapped at={from + END_STEPS.line} origin="0 50%" turn={3} style={{ position: 'absolute', left, top: 468 }}>
            <div style={{ ...display(144), fontSize: 94, lineHeight: 1, color: C.ink, filter: 'url(#boil)', whiteSpace: 'nowrap' }}>Play it free, in your browser.</div>
          </Slapped>
          <div style={{ position: 'absolute', left: left + 2, top: 728, display: 'flex', gap: 24 }}>
            {['Nothing to install', 'No account', 'Lessons, if you are new'].map((c, i) => (
              <Slapped key={c} at={from + END_STEPS.chips + i * 8} turn={4}>
                <Chip id={`end-chip-${i}`} size={27}>
                  {c}
                </Chip>
              </Slapped>
            ))}
          </div>
          <Slapped at={from + END_STEPS.address} from={0.7} turn={-6} origin="0% 50%" style={{ position: 'absolute', left, top: 592 }}>
            <Slip id="end-address" pad={[42, 20]} sheet={{ color: C.spirit, shadow: 10, shadowColor: C.ink, lineWidth: 3 }}>
              <div style={{ ...label(118, 800), textTransform: 'none', letterSpacing: '0.01em', fontSize: 66, lineHeight: 1.1, color: C.ink, filter: 'url(#boil)' }}>{address}</div>
            </Slip>
          </Slapped>
          <div style={{ position: 'absolute', left: left + 2, bottom: 46, ...mono, fontSize: 17, letterSpacing: '0.1em', color: C.ink, opacity: 0.62 }}>
            Music: “Spy Glass” by Kevin MacLeod (incompetech.com) · CC BY 4.0
          </div>
        </Sheet>
      </div>
      <Burst at={from + 2} marks={around(x, y, w, h, 7)} color={C.paper} width={7} length={60} />
    </>
  );
}
