/**
 * The Opera Game typed in at one screen, as a player would, with the real
 * engine judging each move as it comes: the record must show none of the
 * winner's moves as a mistake, though three of them give up material and
 * one of them looks, to a quick search, like a bishop thrown away. The
 * controller runs on the stand-ins of tests/helpers/app-rig.ts, all but
 * the engine, which is the real one.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../src/engine/uci.ts';
import { boot, type Rig, stubBrowser } from './helpers/app-rig.ts';
import { nodePort } from './helpers/node-engine.ts';

vi.mock('../src/scene/world.ts', async () => ({ World: (await import('./helpers/app-rig.ts')).FakeWorld }));
vi.mock('../src/scene/post.ts', () => ({ suggestQuality: () => 'low', QUALITY: {} }));
vi.mock('../src/scene/assets.ts', () => ({ loadAssets: () => Promise.reject(new Error('no assets under test')) }));
vi.mock('../src/hands/hand.ts', () => ({ loadHandTemplate: () => Promise.reject(new Error('no hands under test')) }));
vi.mock('../src/audio/sound.ts', () => ({ Sound: class {} }));
vi.mock('../src/engine/browser.ts', async () => {
  const { shared } = await import('./helpers/app-rig.ts');
  return { startEngine: () => shared.startEngine() };
});

/** Morphy against the Duke of Brunswick and Count Isouard, Paris 1858. */
const OPERA = 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#';

describe('the record of a game played at one screen', () => {
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  /** Keep the game's clock and the real one moving together until `test` holds. */
  async function eventually(rig: Rig, test: () => boolean, limit = 20000): Promise<void> {
    const began = Date.now();
    while (!test() && Date.now() - began < limit) {
      await rig.run(0.1);
      await pause(8);
    }
    if (!test()) throw new Error('It never happened');
  }

  beforeAll(() => {
    stubBrowser();
    const warn = console.warn.bind(console);
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && /Could not load the (hands|finished assets)|chess engine could not be started/.test(args[0])) return;
      warn(...args);
    });
  });

  it('marks none of Morphy\'s moves in the Opera Game, typed in one after another with the real engine judging', async () => {
    const rig = await boot({ engine: 'fails' });
    await rig.settle();
    const { shared } = await import('./helpers/app-rig.ts');
    const { Engine: EngineClass } = await import('../src/engine/uci.ts');
    let real: Engine | null = null;
    shared.startEngine = async () => {
      real = new EngineClass(nodePort());
      await real.start();
      return real;
    };
    try {
      // An engine that failed to load is asked for again when a game against the computer is chosen; then the game is played at one screen instead.
      rig.app.startComputer('casual', 'w');
      rig.app.startTable();
      rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
      await eventually(rig, () => rig.ui.engine.value === 'ready');
      for (const san of OPERA.split(' ')) {
        const count = rig.app.game.history().length;
        // The next move is typed as soon as the last has landed and been judged, as a player quick with the keys would.
        let typed = false;
        await eventually(rig, () => typed || (typed = rig.app.typeMove(san) === null));
        await eventually(rig, () => rig.app.game.history().length === count + 1);
        const e = rig.app.game.history()[count]!;
        await eventually(rig, () => rig.app.verdicts.has(e));
      }
      const history = rig.app.game.history();
      expect(history.map((e) => e.san).join(' ')).toBe(OPERA);
      const kinds = history.map((e, i) => `${Math.floor(i / 2) + 1}${i % 2 ? '...' : '.'}${e.san} ${rig.app.verdicts.get(e)?.kind ?? '-'}`);
      expect(kinds.filter((k, i) => i % 2 === 0 && / (slip|blunder)$/.test(k))).toEqual([]);
      // Every one of the winner's moves was judged: none went unmarked for want of an answer.
      expect(kinds.filter((k, i) => i % 2 === 0 && k.endsWith(' -'))).toEqual([]);
      expect(rig.app.verdicts.get(history[28]!)?.kind).toBe('strong');
      expect(rig.ui.status.value).toMatchObject({ result: 'checkmate', winner: 'w' });
    } finally {
      (real as Engine | null)?.close();
    }
  }, 120000);
});
