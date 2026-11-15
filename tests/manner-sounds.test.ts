/**
 * The hands' manners have sounds of their own (assets/src/sound/build.py, `make_manners`): what
 * the hands raise as heard is played with them, each in its place; and every one the game asks
 * for is in the bank that is sent with it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sound } from '../src/audio/sound.ts';
import { Game } from '../src/core/game.ts';
import type { Heard } from '../src/hands/stage.ts';
import { BoardFx } from '../src/life/boardfx.ts';
import { Director } from '../src/life/director.ts';
import { squareCenter } from '../src/scene/layout.ts';
import { PieceLayer } from '../src/scene/pieces.ts';
import { Tweens } from '../src/scene/tween.ts';
import { DT, handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);

const MANNERS = ['rail', 'pat', 'knuckle', 'snap', 'meet', 'rap', 'drag', 'burn'] as const;

/** A director with something to listen to it: every call made of the sound engine, with what it was given. */
function listening() {
  const calls: { name: string; args: unknown[] }[] = [];
  const sound = new Proxy({}, { get: (_, name: string) => (...args: unknown[]) => void calls.push({ name, args }) }) as unknown as Sound;
  const game = new Game();
  const tweens = new Tweens();
  const pieces = new PieceLayer(tweens);
  pieces.reset(game.pieces());
  const director = new Director({ pieces, fx: new BoardFx(new Float32Array(64)), setMood: () => undefined }, () => sound);
  director.reset(game.status());
  calls.length = 0;
  const hear = (what: Heard, at: Vector3, strength: number) => {
    calls.length = 0;
    director.heard(what, at, strength);
    return calls.map((c) => (c.name === 'manner' ? `manner:${String(c.args[0])}` : c.name));
  };
  return { hear, calls };
}

describe('what the hands make heard', () => {
  const rail = new Vector3(3.4, 0.1, 4.4);
  const crown = squareCenter('e1').setY(1.2);

  it('is a fingertip on wood out on the rail of the case, and a fingertip on stone over the squares', () => {
    const { hear } = listening();
    expect(hear('tap', rail, 0.8)).toEqual(['manner:rail']);
    expect(hear('tap', crown, 0.7)).toEqual(['manner:pat']);
    // Out past the squares at the side of the case as well as at its ends.
    expect(hear('tap', new Vector3(-4.4, 0.1, 1), 0.8)).toEqual(['manner:rail']);
  });

  it('is nothing at all for a finger that only comes to rest', () => {
    const { hear } = listening();
    expect(hear('tap', rail, 0.4)).toEqual([]);
  });

  it.each([
    ['meet', 'meet'],
    ['knock', 'rap'],
    ['snap', 'snap'],
    ['crack', 'knuckle'],
    ['burn', 'burn'],
    ['drag', 'drag'],
  ] as const)('plays what is raised as %s with the sound of its own, %s, where it happened', (what, sound) => {
    const { hear, calls } = listening();
    const at = new Vector3(1, 0.5, 2);
    expect(hear(what, at, 0.6)).toEqual([`manner:${sound}`]);
    expect(calls[0]!.args[1]).toBe(at);
    // Done harder, it is asked for louder.
    const soft = Number(calls[0]!.args[2]);
    hear(what, at, 1);
    expect(Number(calls[0]!.args[2])).toBeGreaterThan(soft);
  });

  it('leaves the glass the hands strike on one another in a scuffle as glass, a different note each time', () => {
    const { hear, calls } = listening();
    expect(hear('chime', crown, 0.5)).toEqual(['glass']);
    const first = calls[0]!.args[1];
    hear('chime', crown, 0.5);
    expect(calls[0]!.args[1]).not.toBe(first);
  });
});

describe('the bank', () => {
  const bank = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../public/assets/sound/sounds.json'), 'utf8')) as { files: Record<string, string>; clips: Record<string, { file: string; takes: [number, number][] }> };

  it.each(MANNERS)('has the hands\' %s, in more takes than one, each short', (what) => {
    const clip = bank.clips[`hand.${what}`];
    expect(clip).toBeDefined();
    expect(bank.files[clip!.file]).toBeDefined();
    expect(clip!.takes.length).toBeGreaterThanOrEqual(2);
    for (const [start, length] of clip!.takes) {
      expect(start).toBeGreaterThan(0);
      expect(length).toBeGreaterThan(0.03);
      expect(length).toBeLessThan(0.7);
    }
  });

  it('is asked for nothing of the hands\' that it does not have', () => {
    const engine = readFileSync(path.resolve(import.meta.dirname, '../src/audio/sound.ts'), 'utf8');
    const asked = /manner\(what: ([^,]+),/.exec(engine)![1]!.split('|').map((s) => s.trim().replace(/'/g, ''));
    expect(asked.sort()).toEqual([...MANNERS].sort());
  });
});

describe('a pawn pushed', { timeout: 60000 }, () => {
  it('is heard dragged, once, from where it stood, as it sets off', async () => {
    const rig = handsRig();
    rig.stage.reset();
    rig.stage.setTurn('w');
    await rig.run(1.5);
    const heard: { what: string; at: Vector3 }[] = [];
    rig.stage.heard = (what, at) => heard.push({ what, at: at.clone() });
    const table = rig.stage.manners;
    const asked = table.choose.bind(table);
    table.choose = (at, facts) => (at === 'set' ? 'push' : asked(at, facts));
    const e = rig.game.move('e2', 'e3');
    let done = false;
    void rig.stage.playMove(e).then(() => (done = true));
    for (let t = 0; !done && t < 12; t += DT) await rig.run(DT);
    expect(done).toBe(true);
    const drags = heard.filter((h) => h.what === 'drag');
    expect(drags).toHaveLength(1);
    expect(drags[0]!.at.distanceTo(squareCenter('e2'))).toBeLessThan(0.2);
  });
});
