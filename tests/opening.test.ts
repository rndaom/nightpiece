/**
 * The case opening at the start of a game, as the controller drives it: when there is one and
 * which, that nothing is played while it runs, and that a press, a key or a new game finishes it.
 * The opening itself, the lid, drawers and stones, is tested in src/scene/opening.test.ts; here
 * the world is the stand-in of tests/helpers/app-rig.ts, whose opening takes as long as it is told.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, type Rig, stubBrowser } from './helpers/app-rig.ts';

vi.mock('../src/scene/world.ts', async () => ({ World: (await import('./helpers/app-rig.ts')).FakeWorld }));
vi.mock('../src/scene/post.ts', () => ({ suggestQuality: () => 'low', QUALITY: {} }));
vi.mock('../src/scene/assets.ts', () => ({ loadAssets: () => Promise.reject(new Error('no assets under test')) }));
vi.mock('../src/hands/hand.ts', () => ({ loadHandTemplate: () => Promise.reject(new Error('no hands under test')) }));
vi.mock('../src/audio/sound.ts', () => ({ Sound: class {} }));
vi.mock('../src/engine/browser.ts', async () => {
  const { shared } = await import('./helpers/app-rig.ts');
  return { startEngine: () => shared.startEngine() };
});

/** As long as the real openings take, near enough. */
const OPENING = { full: 4.5, short: 1.5 };

const moves = (rig: Rig) => rig.app.game.history().map((e) => e.san);
const play = (rig: Rig, from: string, to: string) => {
  rig.app.click(from as 'e2');
  rig.app.click(to as 'e4');
};

beforeAll(() => {
  stubBrowser();
  const warn = console.warn.bind(console);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && /Could not load the (hands|finished assets)|chess engine could not be started/.test(args[0])) return;
    warn(...args);
  });
});

describe('the case opening at the start of a game', () => {
  it('stands shut behind the choice of game, opens whole for the first game, and holds the moves back till it is done', async () => {
    const rig = await boot({ opening: OPENING });
    expect(rig.world.packed).toBe(true);
    expect(rig.world.unpacked).toEqual([]);
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    expect(rig.world.unpacked).toEqual(['full']);
    expect(rig.world.unpacking).toBe(true);
    play(rig, 'e2', 'e4');
    await rig.run(1);
    expect(moves(rig)).toEqual([]);
    await rig.run(3.7);
    expect(rig.world.unpacking).toBe(false);
    expect(rig.world.cut).toBe(0);
    play(rig, 'e2', 'e4');
    await rig.until(() => moves(rig).length === 1);
  });

  it('opens only the drawers for the next game, the case being open', async () => {
    const rig = await boot({ opening: OPENING });
    rig.app.startTable();
    await rig.run(5);
    const noted = rig.world.remembered;
    rig.app.newGame();
    expect(rig.world.unpacked).toEqual(['full', 'short']);
    // The stones of the game before were noted, to go back into the drawers first.
    expect(rig.world.remembered).toBe(noted + 1);
    await rig.run(1.7);
    expect(rig.world.unpacking).toBe(false);
  });

  it('is finished at once by a press on the board, which chooses nothing', async () => {
    const rig = await boot({ opening: OPENING });
    rig.app.startTable();
    await rig.run(0.5);
    rig.fire('canvas', 'pointerdown', { button: 0, clientX: 400, clientY: 300, pointerId: 1, pointerType: 'mouse' });
    expect(rig.world.unpacking).toBe(false);
    expect(rig.world.cut).toBe(1);
    await rig.settle();
    play(rig, 'e2', 'e4');
    await rig.until(() => moves(rig).length === 1);
  });

  it('is finished at once by a key, which does nothing else', async () => {
    const rig = await boot({ opening: OPENING });
    rig.app.startTable();
    await rig.run(0.5);
    const camera = rig.ui.cameraMode.value;
    rig.fire('window', 'keydown', { key: camera === 'top' ? '2' : '1', target: null });
    expect(rig.world.unpacking).toBe(false);
    expect(rig.world.cut).toBe(1);
    expect(rig.ui.cameraMode.value).toBe(camera);
  });

  it('is finished by a new game begun while it runs, whose own opening then holds the moves', async () => {
    const rig = await boot({ opening: OPENING });
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await rig.run(1);
    rig.app.newGame();
    expect(rig.world.cut).toBe(1);
    expect(rig.world.unpacked).toEqual(['full', 'short']);
    // The first opening's end, kept as it was cut short, does not let moves through the second.
    await rig.settle();
    expect(rig.world.unpacking).toBe(true);
    play(rig, 'e2', 'e4');
    await rig.run(0.5);
    expect(moves(rig)).toEqual([]);
    await rig.run(1.2);
    play(rig, 'e2', 'e4');
    await rig.until(() => moves(rig).length === 1);
  });

  it('lets the computer move first only once the stones are out', async () => {
    const rig = await boot({ opening: OPENING });
    rig.app.startComputer('casual', 'b');
    await rig.run(3);
    expect(moves(rig)).toEqual([]);
    await rig.until(() => moves(rig).length === 1);
    expect(rig.world.unpacking).toBe(false);
  });

  it('has no opening at all for a player who has asked for less movement', async () => {
    const rig = await boot({ opening: OPENING, reducedMotion: true });
    rig.app.startTable();
    expect(rig.world.unpacked).toEqual(['none']);
    expect(rig.world.unpacking).toBe(false);
    expect(rig.world.packed).toBe(false);
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    play(rig, 'e2', 'e4');
    await rig.until(() => moves(rig).length === 1);
    rig.app.newGame();
    expect(rig.world.unpacked).toEqual(['none', 'none']);
  });

  it('opens for the lessons when they come first, and not again between their steps', async () => {
    const rig = await boot({ opening: OPENING });
    rig.app.startLessons();
    expect(rig.world.unpacked).toEqual(['full']);
    await rig.run(5);
    rig.app.nextStep();
    expect(rig.world.unpacked.at(-1)).toBe('none');
    expect(rig.world.unpacking).toBe(false);
  });
});
