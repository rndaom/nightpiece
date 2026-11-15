/**
 * The room as it is got ready and kept: it is shown after a few seconds however the building of
 * what it draws stands, and the player's wish for less movement is asked once and heard whenever it
 * changes, by everything that goes by it alike.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { World, watchStillness } from '../src/scene/world.ts';

/** A world without a picture: only what is named is there. */
function bare(parts: Record<string, unknown>): World {
  return Object.assign(Object.create(World.prototype) as World, parts);
}

const never = () => new Promise<void>(() => undefined);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('getting the room ready', () => {
  it('shows it after a few seconds even if what it draws is never ready to be built (as after a lost context)', async () => {
    vi.useFakeTimers();
    const world = bare({ stage: { warm() {}, warmPictures: never }, post: { warm: never }, markers: { warm() {} }, sendAhead() {} });
    let shown = false;
    void world.warm().then(() => (shown = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(shown).toBe(true);
  });

  it('says so if building ahead fails, and does not keep the room waiting for it', async () => {
    const world = bare({ stage: { warm() {}, warmPictures: () => Promise.reject(new Error('lost')) }, post: { warm: never }, markers: { warm() {} }, sendAhead() {} });
    await expect(world.warm()).rejects.toThrow('lost');
  });
});

describe('less movement', () => {
  /** A system whose preference can be changed, and how often it has been asked. */
  function system(reduce: boolean) {
    const heard: ((e: { matches: boolean }) => void)[] = [];
    let asked = 0;
    vi.stubGlobal('matchMedia', () => {
      asked++;
      return { matches: reduce, addEventListener: (_: string, f: (e: { matches: boolean }) => void) => heard.push(f) };
    });
    return {
      change: (to: boolean) => {
        reduce = to;
        for (const f of heard) f({ matches: to });
      },
      asked: () => asked,
    };
  }

  it('is asked once, and heard again whenever it changes', () => {
    const sys = system(false);
    const told: boolean[] = [];
    watchStillness((still) => told.push(still));
    sys.change(true);
    sys.change(false);
    expect(told).toEqual([false, true, false]);
    expect(sys.asked()).toBe(1);
  });

  it('is told, as it changes, to the board, the hands and the frame alike, and the frame does not ask the system for it', () => {
    const sys = system(false);
    const fx = { still: false };
    const stage = { quiet: false };
    const world = bare({ fx, stage }) as unknown as { setStill(still: boolean): void; stillness(): boolean };
    watchStillness((still) => world.setStill(still));
    const asked = sys.asked();
    expect(world.stillness()).toBe(false);
    sys.change(true);
    expect([fx.still, stage.quiet, world.stillness()]).toEqual([true, true, true]);
    sys.change(false);
    expect([fx.still, stage.quiet, world.stillness()]).toEqual([false, false, false]);
    expect(sys.asked()).toBe(asked);
  });
});
