/**
 * The game's controller, run for real under Node: what a click does, what
 * the computer, the server and a lesson's script do in the middle of other
 * things, and what the player is told. See tests/helpers/app-rig.ts for what
 * is stood in for (the 3D world and the engine's worker) and what is not
 * (everything else).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Running, startServer } from '../server/main.ts';
import { Game } from '../src/core/game.ts';
import { type ClientMessage, newRoomName, type RoomState, type ServerMessage } from '../src/net/protocol.ts';
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

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Keep the game's clock and the real one moving together until `test` holds. For anything that waits on the network or a timer. */
async function eventually(rig: Rig, test: () => boolean, limit = 6000): Promise<void> {
  const began = Date.now();
  while (!test() && Date.now() - began < limit) {
    await rig.run(0.1);
    await pause(8);
  }
  if (!test()) throw new Error('It never happened');
}

const moves = (rig: Rig) => rig.app.game.history().map((e) => e.san);
/** Choose a stone and a square, as two clicks. */
const play = (rig: Rig, from: string, to: string) => {
  rig.app.click(from as 'e2');
  rig.app.click(to as 'e4');
};

beforeAll(() => {
  stubBrowser();
  // The asset loaders are made to fail on purpose; their warnings are not news.
  const warn = console.warn.bind(console);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && /Could not load the (hands|finished assets)|chess engine could not be started/.test(args[0])) return;
    warn(...args);
  });
});

describe('two players at one screen', () => {
  it('opens on the choice of game, and plays moves by clicks once one is chosen', async () => {
    const rig = await boot();
    expect(rig.ui.opening.value).toBe(true);
    expect(rig.ui.menuOpen.value).toBe(true);
    rig.app.startTable();
    expect(rig.ui.menuOpen.value).toBe(false);
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    play(rig, 'e2', 'e4');
    await rig.until(() => moves(rig).length === 1);
    await rig.run(1.5);
    play(rig, 'e7', 'e5');
    await rig.run(1.5);
    expect(moves(rig)).toEqual(['e4', 'e5']);
    expect(rig.world.shown).toEqual(['e4', 'e5']);
    void rig.app.takeBack();
    await rig.run(2);
    expect(moves(rig)).toEqual(['e4']);
    expect(rig.world.shown).toEqual(['e4', 'e5', 'undo e5']);
  });

  it('does not hold a move back while the engine is still on its way', async () => {
    // The engine's program is still downloading (or never will arrive): there is nothing to ask yet.
    const rig = await boot({ engine: 'never' });
    rig.app.startTable();
    expect(rig.ui.engine.value).toBe('loading');
    play(rig, 'e2', 'e4');
    await rig.settle();
    expect(moves(rig)).toEqual(['e4']);
  });

  it('still catches a stone put where it will simply be taken, without the engine', async () => {
    const rig = await boot({ engine: 'never' });
    rig.app.startTable('4k3/8/4p3/8/8/8/8/3QK3 w - - 0 1');
    play(rig, 'd1', 'd5');
    await rig.settle();
    expect(moves(rig)).toEqual([]);
    expect(rig.ui.warning.value?.text).toMatch(/Your queen can be taken there/);
    rig.app.answerWarning(true);
    await rig.settle();
    expect(moves(rig)).toEqual(['Qd5']);
  });

  it('warns before a move that would draw a won game by repeating the position', async () => {
    const rig = await boot();
    // The engine thinks Ivory, a queen up, is winning easily whoever is to move.
    rig.port.script = (fen, lines) => {
      const winning = fen.split(' ')[1] === 'w' ? 600 : -600;
      return new Game(fen)
        .moves()
        .slice(0, lines)
        .map((m, i) => ({ move: m.from + m.to, cp: winning - i }));
    };
    rig.app.startTable('7k/8/8/8/8/8/8/2Q1K3 w - - 0 1');
    await rig.settle();
    // Back and forth. The position after Ivory's first move comes up again after their third.
    for (const [from, to] of [['c1', 'd2'], ['h8', 'g8'], ['d2', 'd1'], ['g8', 'h8'], ['d1', 'd2'], ['h8', 'g8'], ['d2', 'd1'], ['g8', 'h8']] as const) {
      play(rig, from, to);
      const before = moves(rig).length;
      await eventually(rig, () => moves(rig).length > before || rig.ui.warning.value !== null);
      expect(rig.ui.warning.value, `${from}${to}`).toBeNull();
      await rig.run(1.5);
    }
    expect(moves(rig)).toHaveLength(8);
    // The same move again would bring that position about for the third time, and end the game as a draw.
    play(rig, 'd1', 'd2');
    await eventually(rig, () => rig.ui.warning.value !== null || moves(rig).length > 8);
    expect(moves(rig)).toHaveLength(8);
    expect(rig.ui.warning.value?.text).toMatch(/third time.*draw/);
    rig.app.answerWarning(false);
    expect(rig.app.game.status().over).toBe(false);
  });

  it('lets the picture feel a stone come down, unless the camera has been asked to keep still', async () => {
    const rig = await boot();
    const felt = vi.spyOn(rig.app.rig, 'thud');
    const world = rig.world as unknown as { onThud: ((strength: number) => void) | null };
    expect(world.onThud).toBeTypeOf('function');
    world.onThud?.(1.3);
    expect(felt).toHaveBeenCalledWith(1.3);
    // The player who has turned the moving camera off keeps a still one.
    rig.app.setCinematic(false);
    world.onThud?.(1.3);
    expect(felt).toHaveBeenCalledTimes(1);
    rig.app.setCinematic(true);
    // And so does the one whose system asks for less movement.
    const asked = vi.fn((query: string) => ({ matches: query.includes('prefers-reduced-motion') }));
    const page = globalThis as { matchMedia?: unknown };
    const was = page.matchMedia;
    page.matchMedia = asked;
    try {
      world.onThud?.(1.3);
      expect(asked).toHaveBeenCalled();
      expect(felt).toHaveBeenCalledTimes(1);
    } finally {
      if (was === undefined) delete page.matchMedia;
      else page.matchMedia = was;
    }
    world.onThud?.(0.6);
    expect(felt).toHaveBeenCalledTimes(2);
  });
});

describe('against the computer', () => {
  it('answers each move, and takes back a move with its answer', async () => {
    const rig = await boot();
    rig.app.startComputer('casual', 'w');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    play(rig, 'e2', 'e4');
    await eventually(rig, () => moves(rig).length === 2 && rig.ui.canTakeBack.value && !rig.ui.thinking.value);
    await rig.run(1.5);
    expect(rig.app.game.turn()).toBe('w');
    void rig.app.takeBack();
    await rig.run(3);
    expect(moves(rig)).toEqual([]);
    // It does not then move by itself: it is the player's turn.
    await rig.run(3);
    expect(moves(rig)).toEqual([]);
  });

  it('moves first when the player takes Void', async () => {
    const rig = await boot();
    rig.app.startComputer('casual', 'b');
    await eventually(rig, () => moves(rig).length === 1);
    expect(rig.app.game.turn()).toBe('b');
    expect(rig.ui.you.value).toBe('b');
  });

  it('says so when the engine cannot be had, and tries again for the next game', async () => {
    const rig = await boot({ engine: 'fails' });
    await rig.settle();
    expect(rig.ui.engine.value).toBe('failed');
    rig.app.startComputer('casual', 'b');
    await eventually(rig, () => rig.ui.notice.value !== null);
    expect(rig.ui.notice.value).toMatch(/engine could not be loaded/);
    expect(rig.ui.thinking.value).toBe(false);
    // The trouble passes (the connection comes back); asking for a game asks for the engine again.
    const { shared } = await import('./helpers/app-rig.ts');
    const { Engine } = await import('../src/engine/uci.ts');
    shared.startEngine = async () => {
      const engine = new Engine(rig.port);
      await engine.start();
      return engine;
    };
    rig.app.startComputer('casual', 'b');
    await eventually(rig, () => moves(rig).length === 1);
    expect(rig.ui.engine.value).toBe('ready');
  });

  it('starts the next game at the level being played, whatever was looked at in the menu meanwhile', async () => {
    const rig = await boot();
    rig.app.startComputer('first', 'w');
    // The player opens the choice of game, looks at Master, and goes back without starting anything.
    rig.ui.menuOpen.value = true;
    rig.ui.computer.value = { level: 'master', side: 'w' };
    rig.ui.menuOpen.value = false;
    rig.app.newGame();
    expect(rig.ui.mode.value).toEqual({ kind: 'computer', level: 'first', side: 'w' });
  });
});

describe('the lessons', () => {
  it('teaches a step, puts a wrong move back, and goes on when the right one is made', async () => {
    const rig = await boot();
    rig.app.startLessons();
    expect(rig.ui.lesson.value).toMatchObject({ lesson: 1, number: 1, state: 'task' });
    play(rig, 'e1', 'd1');
    await rig.until(() => rig.ui.lesson.value?.state === 'wrong');
    await rig.until(() => rig.ui.lesson.value?.state === 'task');
    expect(moves(rig)).toEqual([]);
    expect(rig.ui.lesson.value?.line).toMatch(/That was your king/);
    play(rig, 'e2', 'e4');
    await rig.until(() => rig.ui.lesson.value?.state === 'done');
    // The other side's scripted answer follows.
    await rig.until(() => moves(rig).length === 2);
    expect(moves(rig)).toEqual(['e4', 'Kd7']);
    rig.app.nextStep();
    expect(rig.ui.lesson.value).toMatchObject({ number: 2, state: 'task' });
    expect(rig.app.game.fen()).toMatch(/^8\/3k4\/8\/8\/4P3\/8\/8\/4K3 w/);
  });

  it('sets up the second step for itself when the first is skipped', async () => {
    const rig = await boot();
    rig.app.startLessons();
    rig.app.nextStep();
    expect(rig.ui.lesson.value).toMatchObject({ number: 2, state: 'task' });
    // The card says the pawn has left its first square, so it has.
    expect(rig.app.game.fen()).toMatch(/^8\/3k4\/8\/8\/4P3\/8\/8\/4K3 w/);
    expect(rig.app.game.movesFrom('e4').map((o) => o.to)).toEqual(['e5']);
  });

  it('does not credit a move still in the air to the step that is skipped to', async () => {
    const rig = await boot();
    rig.app.startLessons();
    play(rig, 'e2', 'e4');
    await rig.run(0.3);
    rig.app.nextStep();
    await rig.run(4);
    expect(rig.ui.lesson.value).toMatchObject({ number: 2, state: 'task', line: null });
    expect(rig.app.game.turn()).toBe('w');
  });

  it('comes back to the second step, from the lesson after, with its own position', async () => {
    const rig = await boot();
    rig.app.startLessons(1);
    rig.app.previousStep();
    expect(rig.ui.lesson.value).toMatchObject({ lesson: 1, number: 2 });
    expect(rig.app.game.fen()).toMatch(/^8\/3k4\/8\/8\/4P3\/8\/8\/4K3 w/);
  });

  it('does not play a chosen stone once the lessons are over', async () => {
    const rig = await boot();
    rig.app.startLessons(11);
    await rig.until(() => moves(rig).length === 1 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    rig.app.click('e5');
    // Skip: the last step gives way to the closing card, with the pawn still chosen.
    rig.app.nextStep();
    expect(rig.ui.lesson.value?.state).toBe('finished');
    rig.app.click('d6');
    await rig.run(3);
    expect(moves(rig)).toHaveLength(1);
    expect(rig.ui.lesson.value?.state).toBe('finished');
  });
});

// -- giving up, looking back, carrying on -----------------------------------------

const SLOT = 'nightpiece.game.v1';
const kept = () => {
  const raw = (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(SLOT);
  return raw ? (JSON.parse(raw) as { kind: string; moves: unknown[]; level?: string; side?: string }) : null;
};
/** Play moves at a shared screen, one after the other, waiting for each to land. */
async function playAll(rig: Rig, list: string): Promise<void> {
  for (const text of list.split(' ')) {
    const before = moves(rig).length;
    play(rig, text.slice(0, 2), text.slice(2, 4));
    await rig.until(() => moves(rig).length === before + 1);
    await rig.run(1.5);
  }
}

describe('giving the game up', () => {
  it('asks first, and ends the game for the other side when the answer is yes', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    // There is nothing to give up before a move has been made.
    expect(rig.app.canResign()).toBe(false);
    rig.app.askResign();
    expect(rig.ui.asking.value).toBeNull();

    await playAll(rig, 'e2e4');
    expect(rig.ui.canResign.value).toBe(true);
    rig.app.askResign();
    expect(rig.ui.asking.value).toBe('resign');
    // Nothing on the board answers a click while the question is up.
    rig.app.click('e7');
    rig.app.click('e5');
    await rig.run(1.5);
    expect(moves(rig)).toEqual(['e4']);
    // No.
    rig.app.answerAsk(false);
    expect(rig.ui.asking.value).toBeNull();
    expect(rig.app.game.status().over).toBe(false);

    // Yes. At a shared screen it is the side to move that gives up: Void.
    rig.app.askResign();
    rig.app.answerAsk(true);
    expect(rig.ui.asking.value).toBeNull();
    expect(rig.ui.status.value).toMatchObject({ over: true, result: 'resigned', winner: 'w' });
    expect(rig.ui.canResign.value).toBe(false);
    // The card comes after a moment, not on top of the stone falling.
    expect(rig.ui.resultVisible.value).toBe(false);
    await rig.run(1.5);
    expect(rig.ui.resultVisible.value).toBe(true);
    // And nothing more is played.
    play(rig, 'e7', 'e5');
    await rig.run(1.5);
    expect(moves(rig)).toEqual(['e4']);
  });

  it('can be taken back, and the game goes on from where it was', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'e2e4');
    expect(kept()).toMatchObject({ kind: 'table' });
    rig.app.resign();
    await rig.run(1.5);
    // A game that is over is not one to come back to.
    expect(kept()).toBeNull();
    expect(rig.ui.canTakeBack.value).toBe(true);
    void rig.app.takeBack();
    await rig.run(1);
    // Only the giving up is taken back: the move stays.
    expect(moves(rig)).toEqual(['e4']);
    expect(rig.world.shown).toEqual(['e4']);
    expect(rig.ui.status.value).toMatchObject({ over: false, result: null });
    expect(rig.ui.resultVisible.value).toBe(false);
    expect(kept()).toMatchObject({ kind: 'table' });
    await playAll(rig, 'e7e5');
    expect(moves(rig)).toEqual(['e4', 'e5']);
  });

  it('is the player who gives up against the computer, even on its move, and it then stops', async () => {
    const rig = await boot();
    rig.port.delay = 150;
    rig.app.startComputer('casual', 'w');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    play(rig, 'e2', 'e4');
    await rig.until(() => moves(rig).length === 1);
    await rig.run(1.5);
    // The computer is thinking about its answer.
    expect(rig.app.game.turn()).toBe('b');
    rig.app.resign();
    expect(rig.ui.status.value).toMatchObject({ result: 'resigned', winner: 'b' });
    expect(rig.ui.thinking.value).toBe(false);
    // Its answer, when it comes, is not played.
    await pause(400);
    await rig.run(3);
    expect(moves(rig)).toEqual(['e4']);
    expect(rig.ui.resultVisible.value).toBe(true);
    // Taking it back takes the game up again, and the computer answers after all.
    void rig.app.takeBack();
    await eventually(rig, () => moves(rig).length === 2);
    expect(rig.ui.status.value.over).toBe(false);
  });

  it('is not offered in a lesson', async () => {
    const rig = await boot();
    rig.app.startLessons();
    await rig.settle();
    expect(rig.app.canResign()).toBe(false);
    rig.app.askResign();
    expect(rig.ui.asking.value).toBeNull();
  });
});

describe('a question asked while the engine is still looking at a move', () => {
  /**
   * A game at one screen in which some moves have been played, and the engine is slow to say
   * what it makes of the next one: Void's e5 after e4, unless told otherwise.
   */
  async function held(played = 'e2e4', next: [string, string] = ['e7', 'e5']): Promise<Rig> {
    const rig = await boot();
    rig.app.startTable();
    await rig.settle();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, played);
    const before = moves(rig);
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: true };
    rig.port.delay = 400;
    play(rig, next[0], next[1]);
    await rig.settle(2);
    expect(moves(rig)).toEqual(before);
    return rig;
  }

  it('lets the move go, so that the side that asked to give up is the side that does', async () => {
    const rig = await held();
    // Void, whose move it still is, presses Resign while the engine looks.
    rig.app.askResign();
    expect(rig.ui.asking.value).toBe('resign');
    await pause(600);
    await rig.run(1.5);
    // The move was not played under the question.
    expect(moves(rig)).toEqual(['e4']);
    expect(rig.ui.asking.value).toBe('resign');
    rig.app.answerAsk(true);
    expect(rig.ui.status.value).toMatchObject({ over: true, result: 'resigned', winner: 'w' });
  });

  it('plays the move after all if the answer is no before the engine has spoken', async () => {
    const rig = await held();
    rig.app.askResign();
    rig.app.answerAsk(false);
    await eventually(rig, () => moves(rig).length === 2);
    expect(moves(rig)).toEqual(['e4', 'e5']);
  });

  it('ends the game at once on a yes, and the move held back is neither played nor an error', async () => {
    const rejections: unknown[] = [];
    const note = (reason: unknown) => void rejections.push(reason);
    process.on('unhandledRejection', note);
    try {
      const rig = await held();
      rig.world.stood.length = 0;
      rig.app.askResign();
      rig.app.answerAsk(true);
      expect(rig.ui.status.value).toMatchObject({ over: true, result: 'resigned', winner: 'w' });
      await pause(700);
      await rig.run(1.5);
      expect(moves(rig)).toEqual(['e4']);
      expect(rejections).toEqual([]);
      // The room is told, once, that the game has this moment been given up.
      expect(rig.world.stood.filter((happened) => happened)).toHaveLength(1);
      await eventually(rig, () => rig.ui.resultVisible.value);
    } finally {
      process.off('unhandledRejection', note);
    }
  });

  it('lets a draw be agreed that was asked for while the engine looked, and the move is not played after it', async () => {
    const rig = await held('e2e4 e7e5', ['g1', 'f3']);
    rig.world.stood.length = 0;
    rig.app.askDraw();
    expect(rig.ui.asking.value).toBe('draw');
    await pause(600);
    await rig.run(1.5);
    expect(moves(rig)).toEqual(['e4', 'e5']);
    expect(rig.ui.asking.value).toBe('draw');
    rig.app.answerAsk(true);
    expect(rig.ui.status.value).toMatchObject({ over: true, result: 'draw', drawReason: 'agreement' });
    await rig.run(1.5);
    expect(moves(rig)).toEqual(['e4', 'e5']);
    expect(rig.world.stood.filter((happened) => happened)).toHaveLength(1);
  });
});

describe('a hint that comes late', () => {
  it('is not laid over an earlier position the player has gone back to look at', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await rig.settle();
    await playAll(rig, 'e2e4');
    // The engine is slow on the next position: the hint waits for it.
    rig.port.delay = 500;
    await playAll(rig, 'e7e5');
    void rig.app.hint();
    rig.app.view(0);
    expect(rig.ui.viewing.value).toBe(0);
    await pause(700);
    await rig.run(0.3);
    expect(rig.ui.viewing.value).toBe(0);
    expect(rig.ui.hint.value).toBeNull();
    expect(rig.world.marks.get('hint') ?? []).toEqual([]);
    // Back at the game, it can be asked for again and comes.
    rig.app.view(null);
    rig.port.delay = 0;
    await rig.app.hint();
    expect(rig.ui.hint.value).not.toBeNull();
  });
});

describe('the engine is told how the game got there', () => {
  it('for a hint, with the moves since the last capture or pawn move, and none for a position that was set up', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await rig.settle();
    await playAll(rig, 'g1f3');
    await playAll(rig, 'g8f6');
    await playAll(rig, 'f3g1');
    await playAll(rig, 'f6g8');
    await rig.app.hint();
    const last = rig.port.positions[rig.port.positions.length - 1]!;
    expect(last).toBe('position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 moves g1f3 g8f6 f3g1 f6g8');
    // A pawn move cannot be undone: nothing before it is told.
    await playAll(rig, 'e2e4');
    await rig.app.hint();
    expect(rig.port.positions[rig.port.positions.length - 1]).toMatch(/^position fen \S+ b KQkq - 0 3$/);
  });

  it('for the blunder warning, whose search of the move includes the move itself', async () => {
    const rig = await boot();
    rig.app.startTable();
    await rig.settle();
    await playAll(rig, 'g1f3');
    await playAll(rig, 'g8f6');
    await playAll(rig, 'f3g1');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: true };
    // Asked as the player makes the move: the search is of the position it would lead to, and the line includes the move.
    play(rig, 'f6', 'g8');
    await eventually(rig, () => rig.port.positions.some((l) => l.endsWith('moves g1f3 g8f6 f3g1 f6g8')));
    expect(rig.port.positions).toContain('position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 moves g1f3 g8f6 f3g1 f6g8');
  });

  it('for the strongest computer, and not for a gentle one', async () => {
    // A gentle computer now and then plays a move it chose with no search at all (its slip, a chance of 12 in 100 for the casual one). The draw is fixed to one that never comes, so that the search is always there to be looked at.
    const draw = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      for (const [level, told] of [['master', true], ['casual', false]] as const) {
        const rig = await boot();
        rig.app.startComputer(level, 'w');
        rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
        play(rig, 'g1', 'f3');
        await eventually(rig, () => moves(rig).length === 2 && !rig.ui.thinking.value);
        // The position the computer's own search was sent: the one that goes with the level's kind of search (the judging of moves is a search of its own, always shown the line).
        const own = level === 'master' ? 'movetime 1200' : 'depth 3';
        let position = '';
        const searches: string[] = [];
        for (const line of rig.port.sent) {
          if (line.startsWith('position')) position = line;
          else if (line.startsWith('go') && line.includes(own)) searches.push(position);
        }
        expect(searches.length, level).toBeGreaterThan(0);
        for (const line of searches) expect(line.includes(' moves g1f3'), `${level}: ${line}`).toBe(told);
      }
    } finally {
      draw.mockRestore();
    }
  });
});

describe('agreeing a draw', () => {
  it('is asked first at a shared screen, ends the game with nobody winning, and can be taken back', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    // Not before both sides have moved.
    await playAll(rig, 'e2e4');
    expect(rig.ui.canDraw.value).toBe(false);
    rig.app.askDraw();
    expect(rig.ui.asking.value).toBeNull();
    await playAll(rig, 'e7e5');
    expect(rig.ui.canDraw.value).toBe(true);

    rig.app.askDraw();
    expect(rig.ui.asking.value).toBe('draw');
    // No.
    rig.app.answerAsk(false);
    expect(rig.ui.asking.value).toBeNull();
    expect(rig.app.game.status().over).toBe(false);
    // Having said no, it can be asked again: nothing was offered.
    expect(rig.ui.canDraw.value).toBe(true);

    // Yes.
    rig.app.askDraw();
    rig.app.answerAsk(true);
    expect(rig.ui.status.value).toMatchObject({ over: true, result: 'draw', drawReason: 'agreement', winner: null });
    expect(rig.ui.canDraw.value).toBe(false);
    expect(rig.ui.canResign.value).toBe(false);
    expect(rig.ui.resultVisible.value).toBe(false);
    await rig.run(1.5);
    expect(rig.ui.resultVisible.value).toBe(true);
    // A game that is over is not one to come back to, and nothing more is played in it.
    expect(kept()).toBeNull();
    play(rig, 'g1', 'f3');
    await rig.run(1.5);
    expect(moves(rig)).toEqual(['e4', 'e5']);

    // Taking it back takes the game up again; the moves stay.
    expect(rig.ui.canTakeBack.value).toBe(true);
    void rig.app.takeBack();
    await rig.run(1);
    expect(moves(rig)).toEqual(['e4', 'e5']);
    expect(rig.ui.status.value).toMatchObject({ over: false, result: null, drawReason: null });
    expect(rig.ui.resultVisible.value).toBe(false);
    await playAll(rig, 'g1f3');
    expect(moves(rig)).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('can be reached from the question that giving up asks', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'e2e4 e7e5');
    rig.app.askResign();
    expect(rig.ui.asking.value).toBe('resign');
    rig.app.askDraw();
    expect(rig.ui.asking.value).toBe('draw');
    rig.app.answerAsk(true);
    expect(rig.ui.status.value).toMatchObject({ result: 'draw', drawReason: 'agreement' });
  });

  it('shows the agreement at the end of the game when it is looked back over, and nowhere before', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'e2e4 e7e5');
    rig.app.offerDraw();
    await rig.run(1.5);
    rig.app.view(1);
    expect(rig.app.board.status()).toMatchObject({ over: false, result: null });
    rig.app.view(2);
    expect(rig.ui.viewing.value).toBe(2);
    expect(rig.app.board.status()).toMatchObject({ over: true, result: 'draw', drawReason: 'agreement' });
    rig.app.view(null);
    expect(rig.ui.resultVisible.value).toBe(true);
  });

  it('is turned down by the computer while the game is young, and no more than once a move', async () => {
    const rig = await boot();
    rig.app.startComputer('casual', 'w');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    play(rig, 'e2', 'e4');
    await eventually(rig, () => moves(rig).length === 2 && rig.app.game.turn() === 'w');
    await rig.run(2.5);
    expect(rig.ui.canDraw.value).toBe(true);
    rig.app.askDraw();
    expect(rig.ui.asking.value).toBe('draw');
    rig.app.answerAsk(true);
    // It takes a moment over it.
    expect(rig.ui.notice.value).toBeNull();
    await eventually(rig, () => rig.ui.notice.value !== null);
    expect(rig.ui.notice.value).toMatch(/would rather play on.*young/);
    expect(rig.ui.status.value.over).toBe(false);
    // Asked and answered: not again on this move.
    expect(rig.ui.canDraw.value).toBe(false);
    rig.app.askDraw();
    expect(rig.ui.asking.value).toBeNull();
    // After the next move, and its answer, it can be.
    play(rig, 'g1', 'f3');
    await eventually(rig, () => moves(rig).length === 4 && rig.app.game.turn() === 'w');
    await rig.run(2.5);
    expect(rig.ui.notice.value).toBeNull();
    expect(rig.ui.canDraw.value).toBe(true);
  });

  it('can be offered again a move after one that was taken back, and not two moves after', async () => {
    const rig = await boot();
    rig.app.startComputer('casual', 'w');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    for (const [from, to, plies] of [['e2', 'e4', 2], ['g1', 'f3', 4]] as const) {
      play(rig, from, to);
      await eventually(rig, () => moves(rig).length === plies && rig.app.game.turn() === 'w');
      await rig.run(2.5);
    }
    rig.app.offerDraw();
    await eventually(rig, () => rig.ui.notice.value !== null);
    expect(rig.ui.canDraw.value).toBe(false);
    // The move it was asked on is taken back, with the answer to the one before.
    void rig.app.takeBack();
    await eventually(rig, () => moves(rig).length === 2);
    await rig.run(1);
    expect(rig.ui.canDraw.value).toBe(false);
    play(rig, 'd2', 'd4');
    await eventually(rig, () => moves(rig).length === 4 && rig.app.game.turn() === 'w');
    await rig.run(2.5);
    expect(rig.ui.canDraw.value).toBe(true);
  });

  /** Rook and king each, well into a game, the computer playing Void. `cp` is how the engine sees every position, for the side to move. */
  async function rookEnding(cp: (fen: string) => number): Promise<Rig> {
    const rig = await boot();
    rig.port.script = (fen, lines) =>
      new Game(fen)
        .moves()
        .slice(0, lines)
        .map((m) => ({ move: m.from + m.to, cp: cp(fen) }));
    rig.app.startComputer('casual', 'w', '4k3/7r/8/8/8/8/R7/4K3 w - - 0 40');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await rig.settle();
    // On the player's first turn here nothing has been played yet: both sides have to have moved.
    expect(rig.ui.canDraw.value).toBe(false);
    play(rig, 'a2', 'a3');
    await eventually(rig, () => moves(rig).length === 2 && rig.app.game.turn() === 'w');
    await rig.run(2.5);
    return rig;
  }

  it('is agreed to by the computer in a level ending, and can be taken back', async () => {
    const rig = await rookEnding(() => 0);
    expect(rig.ui.canDraw.value).toBe(true);
    rig.app.offerDraw();
    await eventually(rig, () => rig.ui.status.value.over);
    expect(rig.ui.status.value).toMatchObject({ result: 'draw', drawReason: 'agreement', winner: null });
    expect(rig.ui.notice.value).toBeNull();
    await eventually(rig, () => rig.ui.resultVisible.value);
    // The computer does not then move in a game that is over.
    await pause(60);
    await rig.run(2);
    expect(moves(rig)).toHaveLength(2);
    void rig.app.takeBack();
    await rig.run(1);
    expect(rig.ui.status.value.over).toBe(false);
    expect(moves(rig)).toHaveLength(2);
  });

  it('is turned down by the computer when it thinks it is winning, however old the game', async () => {
    // Every position is 300 to the good for Void, whoever is to move in it.
    const rig = await rookEnding((fen) => (fen.split(' ')[1] === 'w' ? -300 : 300));
    rig.app.offerDraw();
    await eventually(rig, () => rig.ui.notice.value !== null);
    expect(rig.ui.notice.value).toMatch(/would rather play on.*likes its position/);
    expect(rig.ui.status.value.over).toBe(false);
  });

  it('is agreed to by the computer when it is the one losing', async () => {
    const rig = await rookEnding((fen) => (fen.split(' ')[1] === 'w' ? 400 : -400));
    rig.app.offerDraw();
    await eventually(rig, () => rig.ui.status.value.over);
    expect(rig.ui.status.value).toMatchObject({ result: 'draw', drawReason: 'agreement' });
  });

  it('is forgotten if the player moves on while the computer is thinking it over', async () => {
    const rig = await rookEnding(() => 0);
    rig.app.offerDraw();
    play(rig, 'a3', 'a4');
    await eventually(rig, () => moves(rig).length === 4 && rig.app.game.turn() === 'w');
    await rig.run(2.5);
    expect(rig.ui.status.value.over).toBe(false);
    expect(rig.ui.notice.value).toBeNull();
  });

  it('cannot be offered to the computer on its own move, nor in a lesson, nor with no engine to ask', async () => {
    const rig = await boot();
    rig.port.delay = 200;
    rig.app.startComputer('casual', 'w');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    play(rig, 'e2', 'e4');
    await eventually(rig, () => moves(rig).length === 2 && rig.app.game.turn() === 'w');
    await rig.run(2.5);
    play(rig, 'g1', 'f3');
    await rig.until(() => moves(rig).length === 3);
    // The computer is thinking about its answer.
    expect(rig.app.game.turn()).toBe('b');
    expect(rig.app.canDraw()).toBe(false);

    const lessons = await boot();
    lessons.app.startLessons();
    await lessons.settle();
    expect(lessons.app.canDraw()).toBe(false);
    lessons.app.askDraw();
    expect(lessons.ui.asking.value).toBeNull();
  });
});

describe('a draw that is coming by itself', () => {
  it('is said before it happens, and unsaid when the move that brought it near is taken back', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    expect(rig.ui.drawNear.value).toBeNull();
    await playAll(rig, 'g1f3 g8f6 f3g1');
    expect(rig.ui.drawNear.value).toBeNull();
    // The knights are all home: the first position again.
    await playAll(rig, 'f6g8');
    expect(rig.ui.drawNear.value).toEqual({ by: 'threefold' });
    void rig.app.takeBack();
    await rig.run(4);
    expect(moves(rig)).toEqual(['Nf3', 'Nf6', 'Ng1']);
    expect(rig.ui.drawNear.value).toBeNull();
  });

  it('is not said of a game that has ended, nor of a new one', async () => {
    const rig = await boot();
    rig.app.startTable('4k3/8/8/8/8/8/8/R3K3 w - - 96 70');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    expect(rig.ui.drawNear.value).toEqual({ by: 'fifty-move', plies: 4 });
    await playAll(rig, 'a1a2 e8d8 a2a1');
    expect(rig.ui.drawNear.value).toEqual({ by: 'fifty-move', plies: 1 });
    await playAll(rig, 'd8e8');
    // The fifty are up: a draw may be claimed (the game goes on until it is), and nothing more is coming.
    expect(rig.ui.status.value).toMatchObject({ over: false, claimable: 'fifty-move' });
    expect(rig.ui.drawNear.value).toBeNull();
    rig.app.startTable();
    expect(rig.ui.drawNear.value).toBeNull();
  });
});

describe('the game written out to take away', () => {
  it('names the two sides, and says how a game given up ended', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'e2e4 e7e5');
    let text = rig.app.record();
    expect(text).toContain('[Event "Nightpiece"]');
    expect(text).toContain('[White "Ivory"]');
    expect(text).toContain('[Black "Void"]');
    expect(text).toContain('[Result "*"]');
    expect(text.endsWith('\n\n1. e4 e5 *\n')).toBe(true);
    rig.app.askResign();
    rig.app.answerAsk(true);
    await rig.run(1);
    text = rig.app.record();
    expect(text).toContain('[Result "0-1"]');
    expect(text.endsWith('1. e4 e5 {White resigns} 0-1\n')).toBe(true);
  });

  it('says which side the computer played, and how strongly', async () => {
    const rig = await boot();
    rig.app.startComputer('club', 'b');
    const text = rig.app.record();
    expect(text).toContain('[White "Ivory (computer, Club)"]');
    expect(text).toContain('[Black "Void"]');
  });

  it('gives the position a game was set up from', async () => {
    const rig = await boot();
    rig.app.startTable('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'e2e4');
    const text = rig.app.record();
    expect(text).toContain('[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]');
    expect(text.endsWith('\n\n1. e4 *\n')).toBe(true);
  });
});

describe('a frame that goes wrong', () => {
  it('is not the last one: the next is asked for, and the fault is said once', async () => {
    const rig = await boot();
    rig.app.startTable();
    await rig.settle();
    const asked = vi.fn(() => 0);
    vi.stubGlobal('requestAnimationFrame', asked);
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const world = rig.world as unknown as { render: (dt: number) => void };
    const render = world.render;
    try {
      // The app as the browser drives it: its own frames, not the stepping the tests use.
      const frame = (rig.app as unknown as { frame: (now: number) => void }).frame;
      rig.app.held = false;
      let faulty = true;
      world.render = (dt) => {
        if (faulty) throw new Error('the picture could not be drawn');
        render.call(rig.world, dt);
      };
      expect(() => frame(1000)).not.toThrow();
      expect(() => frame(1016)).not.toThrow();
      expect(() => frame(1033)).not.toThrow();
      // Each frame asked for the next, and the same fault was said the once.
      expect(asked).toHaveBeenCalledTimes(3);
      expect(said).toHaveBeenCalledTimes(1);
      expect(String(said.mock.calls[0]![1])).toContain('the picture could not be drawn');
      // The fault passes, and the game is as playable as it was.
      faulty = false;
      expect(() => frame(1050)).not.toThrow();
      expect(asked).toHaveBeenCalledTimes(4);
      rig.app.held = true;
      await playAll(rig, 'e2e4');
      expect(moves(rig)).toEqual(['e4']);
    } finally {
      rig.app.held = true;
      world.render = render;
      said.mockRestore();
      vi.stubGlobal('requestAnimationFrame', () => 0);
    }
  });
});

describe('the interface put away, to look at the board alone', () => {
  it('goes and comes back, and the game can still be played by its stones', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    expect(rig.ui.bare.value).toBe(false);
    rig.app.setBare(true);
    expect(rig.ui.bare.value).toBe(true);
    await playAll(rig, 'e2e4 e7e5');
    expect(moves(rig)).toEqual(['e4', 'e5']);
    expect(rig.ui.bare.value).toBe(true);
    rig.app.setBare(false);
    expect(rig.ui.bare.value).toBe(false);
  });

  it('closes the settings it was asked from', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.settingsOpen.value = true;
    rig.app.setBare(true);
    expect(rig.ui.settingsOpen.value).toBe(false);
    expect(rig.ui.bare.value).toBe(true);
  });

  it('is not put away while something on it wants reading or answering', async () => {
    const rig = await boot();
    // The choice of game, before anything has been chosen.
    rig.app.setBare(true);
    expect(rig.ui.bare.value).toBe(false);

    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'e2e4');
    rig.app.askResign();
    rig.app.setBare(true);
    expect(rig.ui.bare.value).toBe(false);
    rig.app.answerAsk(false);
    rig.app.setBare(true);
    expect(rig.ui.bare.value).toBe(true);
  });

  it('comes back by itself for a question, and for how the game ended', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'f2f3 e7e5 g2g4');
    rig.app.setBare(true);
    rig.app.askResign();
    expect(rig.ui.asking.value).toBe('resign');
    expect(rig.ui.bare.value).toBe(false);
    rig.app.answerAsk(false);

    rig.app.setBare(true);
    await playAll(rig, 'd8h4');
    expect(rig.ui.status.value.result).toBe('checkmate');
    await eventually(rig, () => rig.ui.resultVisible.value);
    expect(rig.ui.bare.value).toBe(false);
    // And it stays, with the result up.
    rig.app.setBare(true);
    expect(rig.ui.bare.value).toBe(false);
  });

  it('comes back for a warning about a move, and for the menu', async () => {
    const rig = await boot({ engine: 'never' });
    rig.app.startTable('4k3/8/4p3/8/8/8/8/3QK3 w - - 0 1');
    rig.app.setBare(true);
    // The queen put where a pawn takes it: the warning has to be read.
    play(rig, 'd1', 'd5');
    await rig.settle();
    expect(rig.ui.warning.value?.text).toMatch(/Your queen can be taken there/);
    expect(rig.ui.bare.value).toBe(false);
    rig.app.answerWarning(false);

    rig.app.setBare(true);
    expect(rig.ui.bare.value).toBe(true);
    rig.ui.menuOpen.value = true;
    expect(rig.ui.bare.value).toBe(false);
  });
});

describe('a move typed at the keyboard', () => {
  it('is played as two clicks would play it', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    for (const text of ['e4', 'e7e5', 'nf3', 'Nc6']) {
      const before = moves(rig).length;
      expect(rig.app.typeMove(text), text).toBeNull();
      await rig.until(() => moves(rig).length === before + 1);
      await rig.run(1.5);
    }
    expect(moves(rig)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('says what is wrong when it cannot be made, and plays nothing', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    expect(rig.app.typeMove('  ')).toBeNull();
    expect(rig.app.typeMove('Ke2')).toMatch(/“Ke2” is not a move here/);
    expect(rig.app.typeMove('hello')).toMatch(/not a move here/);
    await rig.run(1);
    expect(moves(rig)).toEqual([]);

    await playAll(rig, 'e2e4 e7e5');
    // Looking back, nothing is played.
    rig.app.view(1);
    expect(rig.app.typeMove('Nf3')).toMatch(/looking back/);
    rig.app.view(null);
    // Nor while a question is on the screen.
    rig.app.askResign();
    expect(rig.app.typeMove('Nf3')).toMatch(/question/);
    rig.app.answerAsk(false);
    // Nor once the game is over.
    rig.app.askResign();
    rig.app.answerAsk(true);
    expect(rig.app.typeMove('Nf3')).toBe('The game is over.');
    await rig.run(1);
    expect(moves(rig)).toEqual(['e4', 'e5']);
  });

  it('is refused when it is the computer that is to move', async () => {
    const rig = await boot();
    rig.app.startComputer('novice', 'b');
    // Ivory, the computer, moves first.
    expect(rig.app.typeMove('e5')).toBe('It is not your move.');
    await eventually(rig, () => moves(rig).length === 1);
    await rig.run(2);
    const typed = rig.app.game.moves()[0]!;
    expect(rig.app.typeMove(typed.from + typed.to)).toBeNull();
    await eventually(rig, () => moves(rig).length >= 2);
  });

  it('is warned about as a clicked move is', async () => {
    const rig = await boot({ engine: 'never' });
    rig.app.startTable('4k3/8/4p3/8/8/8/8/3QK3 w - - 0 1');
    expect(rig.app.typeMove('Qd5')).toBeNull();
    await rig.settle();
    expect(moves(rig)).toEqual([]);
    expect(rig.ui.warning.value?.text).toMatch(/Your queen can be taken there/);
    rig.app.answerWarning(true);
    await rig.settle();
    expect(moves(rig)).toEqual(['Qd5']);
  });

  it('makes the pawn into what was typed, and asks when nothing was', async () => {
    const rig = await boot();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    rig.app.startTable('7k/P7/8/8/8/8/8/K7 w - - 0 1');
    expect(rig.app.typeMove('a8=R')).toBeNull();
    expect(rig.ui.promotion.value).toBeNull();
    await rig.until(() => moves(rig).length === 1);
    expect(moves(rig)).toEqual(['a8=R+']);

    rig.app.startTable('7k/P7/8/8/8/8/8/K7 w - - 0 1');
    expect(rig.app.typeMove('a8')).toBeNull();
    expect(rig.ui.promotion.value).toMatchObject({ from: 'a7', to: 'a8' });
    rig.app.choosePromotion('n');
    await rig.until(() => moves(rig).length === 1);
    expect(moves(rig)).toEqual(['a8=N']);
  });
});

describe('looking back through the game', () => {
  it('shows an earlier position without changing the game, and comes back', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'e2e4 e7e5 g1f3');
    const now = rig.app.game.fen();

    rig.app.view(1);
    expect(rig.ui.viewing.value).toBe(1);
    expect(rig.app.board.fen()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(rig.app.board.pieceAt('e4')).toMatchObject({ kind: 'p', side: 'w' });
    expect(rig.app.board.pieceAt('f3')).toBeNull();
    // The game itself has not moved.
    expect(rig.app.game.fen()).toBe(now);
    expect(moves(rig)).toEqual(['e4', 'e5', 'Nf3']);

    // What is being looked at cannot be played on, nor hinted at.
    play(rig, 'b8', 'c6');
    await rig.run(1.5);
    expect(moves(rig)).toEqual(['e4', 'e5', 'Nf3']);
    expect(rig.ui.viewing.value).toBe(1);
    expect(rig.ui.canHint.value).toBe(false);

    rig.app.stepView(1);
    expect(rig.ui.viewing.value).toBe(2);
    rig.app.stepView(-5);
    expect(rig.ui.viewing.value).toBe(0);
    expect(rig.app.board.fen()).toBe(new Game().fen());
    // The last position of a game still being played is the present.
    rig.app.view(3);
    expect(rig.ui.viewing.value).toBeNull();
    expect(rig.app.board).toBe(rig.app.game);
    await playAll(rig, 'b8c6');
    expect(moves(rig)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('has nothing to look back at before the first move, nor in a lesson', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.app.view(0);
    expect(rig.ui.viewing.value).toBeNull();
    rig.app.startLessons();
    await rig.settle();
    rig.app.view(0);
    rig.app.stepView(-1);
    expect(rig.ui.viewing.value).toBeNull();
  });

  it('comes back to the present for a move that arrives, and for a take-back', async () => {
    const rig = await boot();
    rig.port.delay = 250;
    rig.app.startComputer('casual', 'w');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    play(rig, 'e2', 'e4');
    await rig.until(() => moves(rig).length === 1);
    await rig.run(1.5);
    // While the computer thinks, the player looks at how the board began.
    rig.app.view(0);
    expect(rig.ui.viewing.value).toBe(0);
    await eventually(rig, () => moves(rig).length === 2);
    expect(rig.ui.viewing.value).toBeNull();
    await eventually(rig, () => rig.ui.canTakeBack.value && !rig.ui.thinking.value);
    await rig.run(1.5);

    rig.app.view(1);
    expect(rig.ui.viewing.value).toBe(1);
    void rig.app.takeBack();
    expect(rig.ui.viewing.value).toBeNull();
    await rig.run(3);
    expect(moves(rig)).toEqual([]);
  });

  it('plays a finished game back, and puts the result away while it does', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'f2f3 e7e5 g2g4 d8h4');
    await rig.until(() => rig.ui.resultVisible.value);
    rig.app.view(0);
    expect(rig.ui.viewing.value).toBe(0);
    expect(rig.ui.resultVisible.value).toBe(false);
    expect(rig.app.board.status().over).toBe(false);
    // The last position of a game that is over can be looked at like any other.
    rig.app.view(4);
    expect(rig.ui.viewing.value).toBe(4);
    expect(rig.app.board.status()).toMatchObject({ result: 'checkmate', winner: 'b' });
    rig.app.stepView(1);
    expect(rig.ui.viewing.value).toBe(4);
    rig.app.view(null);
    expect(rig.ui.viewing.value).toBeNull();
    expect(rig.ui.resultVisible.value).toBe(true);
  });

  it('shows what would have been better, at the position a blunder was made in', async () => {
    const rig = await boot();
    const start = new Game().fen();
    rig.port.script = (fen, lines) => {
      // At the start the engine likes e4 best and d4 next. After a3 it thinks Void is well ahead.
      if (fen === start) return [{ move: 'e2e4', cp: 50 }, { move: 'd2d4', cp: 40 }].slice(0, lines);
      if (fen.startsWith('rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b')) return [{ move: 'e7e5', cp: 400 }, { move: 'd7d5', cp: 380 }].slice(0, lines);
      return null;
    };
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await rig.settle();
    await playAll(rig, 'a2a3');
    const first = () => rig.app.verdicts.get(rig.app.game.history()[0]!);
    await eventually(rig, () => first() != null);
    expect(first()).toMatchObject({ kind: 'blunder', best: { from: 'e2', to: 'e4' } });
    await playAll(rig, 'e7e5');
    await eventually(rig, () => rig.app.verdicts.get(rig.app.game.history()[1]!) != null);

    // The position the blunder was made in: the better move is marked and said.
    rig.app.view(0);
    expect(rig.ui.hint.value).toEqual({ stage: 2, label: 'Better', text: 'Ivory played a3 here, a blunder. Better: pawn to e4. It claims the middle of the board.' });
    expect(rig.world.marks.get('hint')).toMatchObject([{ square: 'e2' }, { square: 'e4' }]);
    // The move that followed the next position was a sound one: there is nothing to add.
    rig.app.view(1);
    expect(rig.ui.hint.value).toBeNull();
    expect(rig.world.marks.get('hint')).toEqual([]);
    rig.app.view(0);
    expect(rig.ui.hint.value).not.toBeNull();
    // Back at the game, it is gone.
    rig.app.view(null);
    expect(rig.ui.hint.value).toBeNull();
    expect(rig.world.marks.get('hint')).toEqual([]);
    // It is a kind of hint: with hints turned off, looking back says nothing.
    rig.app.setAid('hints', false);
    rig.app.view(0);
    expect(rig.ui.viewing.value).toBe(0);
    expect(rig.ui.hint.value).toBeNull();
  });

  it('shows who gave up only at the end of a game that was given up', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'e2e4 e7e5');
    rig.app.resign();
    await rig.run(1.5);
    rig.app.view(1);
    expect(rig.app.board.status().over).toBe(false);
    rig.app.view(2);
    expect(rig.ui.viewing.value).toBe(2);
    expect(rig.app.board.status()).toMatchObject({ result: 'resigned', winner: 'b' });
  });
});

describe('carrying a game on', () => {
  it('keeps a game at this screen, and offers it when the page is opened again', async () => {
    let rig = await boot();
    expect(rig.ui.saved.value).toBeNull();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    expect(kept()).toBeNull();
    await playAll(rig, 'e2e4 e7e5 g1f3');
    expect(kept()).toMatchObject({ kind: 'table', moves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }, { from: 'g1', to: 'f3' }] });

    // The page is closed and opened again.
    rig = await boot({ keepStorage: true });
    expect(rig.ui.opening.value).toBe(true);
    expect(rig.ui.saved.value).toMatchObject({ kind: 'table', moves: 2 });
    expect(moves(rig)).toEqual([]);
    rig.app.resume();
    expect(rig.ui.menuOpen.value).toBe(false);
    expect(rig.ui.mode.value).toEqual({ kind: 'table' });
    expect(moves(rig)).toEqual(['e4', 'e5', 'Nf3']);
    expect(rig.app.game.turn()).toBe('b');
    // It is the game being played now, not one to be offered.
    expect(rig.ui.saved.value).toBeNull();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'b8c6');
    expect(kept()!.moves).toHaveLength(4);
    // What was played before the page was closed can be looked back at, and taken back.
    rig.app.view(1);
    expect(rig.ui.viewing.value).toBe(1);
    rig.app.view(null);
    void rig.app.takeBack();
    await rig.run(2);
    expect(moves(rig)).toEqual(['e4', 'e5', 'Nf3']);
    expect(kept()!.moves).toHaveLength(3);
  });

  it('carries on against the computer at the same level and side, and it moves if it is its turn', async () => {
    const store = (globalThis as unknown as { localStorage: Storage }).localStorage;
    store.clear();
    store.setItem(SLOT, JSON.stringify({ kind: 'computer', level: 'club', side: 'b', asked: 'either', startFen: new Game().fen(), moves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }], seat: 'b', at: Date.now() }));
    const rig = await boot({ keepStorage: true });
    expect(rig.ui.saved.value).toMatchObject({ kind: 'computer', level: 'club', side: 'b', moves: 1 });
    rig.app.resume();
    expect(rig.ui.mode.value).toEqual({ kind: 'computer', level: 'club', side: 'b' });
    expect(rig.ui.you.value).toBe('b');
    expect(rig.ui.seat.value).toBe('b');
    expect(moves(rig)).toEqual(['e4', 'e5']);
    // Ivory, the computer, is to move.
    await eventually(rig, () => moves(rig).length === 3);
    expect(rig.app.game.turn()).toBe('b');
    // The next game is drawn by lot again, as this one was.
    await eventually(rig, () => kept()?.moves.length === 3);
    expect(kept()).toMatchObject({ kind: 'computer', level: 'club', side: 'b' });
  });

  it('goes on offering the game until another has its first move', async () => {
    let rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'd2d4');
    rig = await boot({ keepStorage: true });
    // A different game is started instead, and left without a move being made.
    rig.app.startComputer('casual', 'w');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    expect(rig.ui.saved.value).toMatchObject({ kind: 'table', moves: 1 });
    expect(kept()).toMatchObject({ kind: 'table' });
    // Its first move makes it the game that is kept.
    play(rig, 'e2', 'e4');
    await rig.until(() => moves(rig).length === 1);
    expect(rig.ui.saved.value).toBeNull();
    expect(kept()).toMatchObject({ kind: 'computer', level: 'casual', side: 'w' });
  });

  it('does not keep a game that has ended, nor one taken back to before its first move', async () => {
    let rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'e2e4');
    expect(kept()).not.toBeNull();
    void rig.app.takeBack();
    await rig.run(2);
    expect(kept()).toBeNull();

    await playAll(rig, 'f2f3 e7e5 g2g4 d8h4');
    expect(rig.ui.status.value.result).toBe('checkmate');
    expect(kept()).toBeNull();
    rig = await boot({ keepStorage: true });
    expect(rig.ui.saved.value).toBeNull();
  });

  it('throws away what it cannot read, and says nothing', async () => {
    const store = (globalThis as unknown as { localStorage: Storage }).localStorage;
    store.clear();
    store.setItem(SLOT, '{"kind":"table","startFen":"nonsense","moves":[{"from":"e2","to":"e4"}]}');
    const rig = await boot({ keepStorage: true });
    expect(rig.ui.saved.value).toBeNull();
    expect(kept()).toBeNull();
    rig.app.resume();
    expect(rig.ui.opening.value).toBe(true);
    expect(rig.ui.notice.value).toBeNull();
  });

  it('leaves lessons and their boards out of it', async () => {
    const rig = await boot();
    rig.app.startLessons();
    await rig.settle();
    rig.app.click('e2');
    rig.app.click('e4');
    await rig.run(3);
    expect(kept()).toBeNull();
  });
});

// -- a draw the player to move may claim ------------------------------------------

describe('a draw that may be claimed', () => {
  it('turns the Draw button into a claim on the move of the player who may claim, and draws the game when it is made', async () => {
    const rig = await boot();
    // Fifty moves each have passed without a capture or a pawn move: Ivory, to move, may claim.
    rig.app.startTable('4k3/8/8/8/8/8/8/R3K3 w - - 100 70');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await rig.settle();
    expect(rig.ui.status.value).toMatchObject({ over: false, claimable: 'fifty-move' });
    expect(rig.ui.canClaim.value).toBe('fifty-move');
    rig.app.askDraw();
    expect(rig.ui.asking.value).toBe('claim');
    // Kept playing: nothing is claimed, and the claim is still there to be made.
    rig.app.answerAsk(false);
    expect(rig.ui.status.value.over).toBe(false);
    rig.app.askDraw();
    rig.app.answerAsk(true);
    await rig.run(1.5);
    expect(rig.ui.status.value).toMatchObject({ over: true, result: 'draw', drawReason: 'fifty-move' });
    expect(rig.ui.canClaim.value).toBeNull();
    expect(rig.ui.resultVisible.value).toBe(true);
    const { outcome } = await import('../src/app/store.ts');
    expect(outcome.value).toMatchObject({ result: 'draw', winner: null, cause: 'fifty' });
    // Written out, the record says so, as it says a resignation.
    const text = rig.app.record();
    expect(text).toContain('[Result "1/2-1/2"]');
    expect(text).toContain('{Draw claimed under the fifty-move rule} 1/2-1/2');
    // And it can be taken back at one screen, like a resignation.
    void rig.app.takeBack();
    await rig.run(1);
    expect(rig.ui.status.value).toMatchObject({ over: false, claimable: 'fifty-move' });
  });

  it('may be claimed when a position has stood three times, and is said under whose move it is', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await playAll(rig, 'g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1');
    expect(rig.ui.canClaim.value).toBeNull();
    await playAll(rig, 'f6g8');
    // The first position, for the third time: whoever is to move may claim (and the game goes on until they do).
    expect(rig.ui.status.value).toMatchObject({ over: false, claimable: 'threefold' });
    expect(rig.ui.canClaim.value).toBe('threefold');
    expect(rig.ui.drawNear.value).toBeNull();
    // Played on instead: the claim goes with the position.
    await playAll(rig, 'e2e4');
    expect(rig.ui.canClaim.value).toBeNull();
  });

  it('is not offered to a player for the other side to claim, nor while looking back', async () => {
    const rig = await boot({ engine: 'never' });
    // Against the computer, Void to move may claim: the computer, not the player.
    rig.app.startComputer('casual', 'w', '4k3/8/8/8/8/8/8/R3K3 b - - 100 70');
    await rig.settle();
    expect(rig.ui.status.value.claimable).toBe('fifty-move');
    expect(rig.app.canClaim()).toBeNull();
    rig.app.askDraw();
    expect(rig.ui.asking.value).not.toBe('claim');

    const table = await boot();
    table.app.startTable('4k3/8/8/8/8/8/8/R3K3 w - - 98 70');
    table.ui.aids.value = { ...table.ui.aids.value, warn: false };
    await playAll(table, 'a1a2 e8d8');
    expect(table.ui.canClaim.value).toBe('fifty-move');
    table.app.view(1);
    expect(table.ui.canClaim.value).toBeNull();
    table.app.view(null);
    expect(table.ui.canClaim.value).toBe('fifty-move');
  });

  it('is claimed by the computer on its own move when it does not think itself better off', async () => {
    // With no word from the engine on how the game stands, it claims.
    const rig = await boot({ engine: 'never' });
    rig.app.startComputer('casual', 'w', '4k3/8/8/8/8/8/8/R3K3 w - - 99 70');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await rig.settle();
    play(rig, 'a1', 'a2');
    await rig.until(() => rig.ui.status.value.over, 10);
    expect(rig.ui.status.value).toMatchObject({ result: 'draw', drawReason: 'fifty-move' });
    expect(moves(rig)).toEqual(['Ra2']);
  });

  it('is not claimed by the computer when it thinks it stands better, and it plays on', async () => {
    const rig = await boot({ engine: 'never' });
    rig.app.startComputer('casual', 'w', '4k3/8/8/8/8/8/8/R3K3 w - - 99 70');
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    await rig.settle();
    play(rig, 'a1', 'a2');
    // The engine's last word: Void (the computer) five pawns up.
    rig.ui.balance.value = { ply: 1, cp: -500 };
    await rig.run(4);
    expect(rig.ui.status.value.over).toBe(false);
    expect(rig.ui.thinking.value).toBe(true);
  });

  it('is carried by a game read back and by the look back at its end', async () => {
    const rig = await boot();
    rig.app.startTable();
    const restore = (rig.app as unknown as { restore: (record: object) => boolean }).restore.bind(rig.app);
    restore({ startFen: '4k3/8/8/8/8/8/8/R3K3 w - - 99 70', moves: [{ from: 'a1', to: 'a2' }], claimed: 'fifty-move' });
    expect(rig.app.game.status()).toMatchObject({ over: true, drawReason: 'fifty-move' });
    rig.app.view(0);
    expect(rig.app.board.status().over).toBe(false);
    rig.app.view(1);
    // The end of the game, looked at, is the end as it was: claimed drawn.
    expect(rig.app.board.status()).toMatchObject({ over: true, drawReason: 'fifty-move' });
    // A draw because time ran out against a side that could not be mated, as the server keeps it.
    restore({ startFen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', moves: [{ from: 'a1', to: 'a2' }], ended: 'time', resigned: null });
    expect(rig.app.game.status()).toMatchObject({ over: true, drawReason: 'timeout' });
    expect(rig.app.record()).toContain('{Time forfeit, but no mate was possible: draw} 1/2-1/2');
  });
});

describe('a player who has asked for less movement', () => {
  it('gets a camera that does not push in or drift, unless they turn it on themselves', async () => {
    const moving = await boot();
    expect(moving.ui.cinematic.value).toBe(true);
    expect(moving.app.rig.drift).toBeGreaterThan(0);
    // Without the wish, a capture is pushed in on.
    const cuts = vi.spyOn(moving.app.rig, 'cut');
    moving.app.startTable();
    moving.ui.aids.value = { ...moving.ui.aids.value, warn: false };
    await playAll(moving, 'e2e4 d7d5 e4d5');
    expect(cuts).toHaveBeenCalledWith('capture', 'd5');

    const still = await boot({ reducedMotion: true });
    expect(still.ui.cinematic.value).toBe(false);
    expect(still.app.rig.drift).toBe(0);
    // Turned on by the player: on it stays. But the push-ins themselves still wait on the system's wish.
    const chosen = await boot({ reducedMotion: true, settings: { cinematic: true, cinematicChosen: true } });
    expect(chosen.ui.cinematic.value).toBe(true);
    const cut = vi.spyOn(chosen.app.rig, 'cut');
    chosen.app.startTable();
    chosen.ui.aids.value = { ...chosen.ui.aids.value, warn: false };
    await playAll(chosen, 'e2e4 d7d5 e4d5');
    expect(cut).not.toHaveBeenCalled();
  });

  it('keeps an old setting that turned the camera off, and lets one that was only the default follow the system', async () => {
    const off = await boot({ settings: { cinematic: false } });
    expect(off.ui.cinematic.value).toBe(false);
    const leftAlone = await boot({ reducedMotion: true, settings: { cinematic: true } });
    expect(leftAlone.ui.cinematic.value).toBe(false);
    leftAlone.app.setCinematic(true);
    const kept = JSON.parse((globalThis as unknown as { localStorage: Storage }).localStorage.getItem('nightpiece.settings.v1')!) as { cinematic: boolean; cinematicChosen?: boolean };
    expect(kept).toMatchObject({ cinematic: true, cinematicChosen: true });
  });
});

describe('the picture quality', () => {
  it('can be given back to the game to choose, which forgets the player\'s choice and lowers it by itself again', async () => {
    const rig = await boot();
    const { qualityIsChosen } = await import('../src/app/store.ts');
    rig.app.setQuality('high');
    expect(qualityIsChosen()).toBe(true);
    rig.app.setQualityAuto();
    expect(qualityIsChosen()).toBe(false);
    // The stand-in machine is found to suit Low.
    expect(rig.ui.quality.value).toBe('low');
    const kept = JSON.parse((globalThis as unknown as { localStorage: Storage }).localStorage.getItem('nightpiece.settings.v1')!) as { quality?: string };
    expect(kept.quality).toBeUndefined();
  });
});

describe('the sounds', () => {
  it('are not waited for by the loading screen, and are fetched once, at a touch if that comes first', async () => {
    const fetches: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      fetches.push(String(url));
      // A slow line: nothing comes back.
      return new Promise(() => {});
    });
    try {
      const rig = await boot();
      expect(rig.ui.ready.value).toBe(true);
      expect(fetches.filter((u) => u.endsWith('sounds.json'))).toHaveLength(1);
      rig.fire('window', 'pointerdown', { pointerType: 'touch' });
      expect(fetches.filter((u) => u.endsWith('sounds.json'))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      stubBrowser();
    }
  });
});

describe('a finger on the board', () => {
  const press = (rig: Rig, type: string, at: { x: number; y: number }, extra: object = {}) =>
    rig.fire('canvas', type, { button: 0, pointerId: 1, pointerType: 'touch', clientX: at.x, clientY: at.y, timeStamp: 0, ...extra });
  /** Where a square's middle is on the canvas, and a point a fraction of a square from it towards Void. */
  const spot = async (rig: Rig, square: string, up = 0) => {
    const { squareCenter } = await import('../src/scene/layout.ts');
    const { onScreen } = await import('./helpers/app-rig.ts');
    const c = squareCenter(square as 'e4');
    return onScreen(rig.world.camera, c.x, c.z - up);
  };
  const selected = (rig: Rig) => (rig.app as unknown as { selected: string | null }).selected;
  async function fromAbove(): Promise<Rig> {
    const rig = await boot();
    rig.app.startTable();
    rig.ui.aids.value = { ...rig.ui.aids.value, warn: false };
    rig.app.setCamera('top');
    await rig.run(3);
    return rig;
  }

  it("prefers the player's own stone that can move to one standing in front of it", async () => {
    const rig = await fromAbove();
    // From the Shoulder view the king on e1 stands in front of the pawn on e2.
    rig.world.inFront.set('e2', 'e1');
    const e2 = await spot(rig, 'e2');
    // A mouse is taken at its word: the king, which is what it is on.
    press(rig, 'pointerdown', e2, { pointerType: 'mouse' });
    press(rig, 'pointerup', e2, { pointerType: 'mouse' });
    expect(selected(rig)).toBe('e1');
    rig.app.click(null);
    // A finger means the pawn: the king has nowhere to go.
    press(rig, 'pointerdown', e2);
    press(rig, 'pointerup', e2);
    expect(selected(rig)).toBe('e2');
  });

  it("lands a tap just beside a square the chosen stone may go to on that square, and never on a stone it cannot move standing in front of one", async () => {
    const rig = await fromAbove();
    const e2 = await spot(rig, 'e2');
    press(rig, 'pointerdown', e2);
    press(rig, 'pointerup', e2);
    expect(selected(rig)).toBe('e2');
    // Over the line into e5, a little more than half a square from the middle of e4.
    const near = await spot(rig, 'e4', 0.56);
    press(rig, 'pointerdown', near);
    press(rig, 'pointerup', near);
    await rig.until(() => moves(rig).length === 1);
    expect(moves(rig)).toEqual(['e4']);
    await rig.run(1.5);
    // Void's pawn on d7, chosen; a stone of Ivory's stands in front of d5 as a low camera sees it.
    rig.world.inFront.set('d5', 'e4');
    const d7 = await spot(rig, 'd7');
    press(rig, 'pointerdown', d7);
    press(rig, 'pointerup', d7);
    const d5 = await spot(rig, 'd5');
    press(rig, 'pointerdown', d5);
    press(rig, 'pointerup', d5);
    await rig.until(() => moves(rig).length === 2);
    expect(moves(rig)).toEqual(['e4', 'd5']);
  });

  it('does not reach a square well away from any the stone may go to: the tap lets it go', async () => {
    const rig = await fromAbove();
    const e2 = await spot(rig, 'e2');
    press(rig, 'pointerdown', e2);
    press(rig, 'pointerup', e2);
    const far = await spot(rig, 'e4', 0.9);
    press(rig, 'pointerdown', far);
    press(rig, 'pointerup', far);
    await rig.run(1);
    expect(moves(rig)).toEqual([]);
    expect(selected(rig)).toBeNull();
  });

  it('carries a stone held above the finger, so that the finger does not hide where it is going', async () => {
    const rig = await fromAbove();
    const e2 = await spot(rig, 'e2');
    const e4 = await spot(rig, 'e4');
    // The finger goes to fifty pixels below e4: the stone it carries is over e4.
    const finger = { x: e4.x, y: e4.y + 50 };
    press(rig, 'pointerdown', e2);
    press(rig, 'pointermove', { x: e2.x, y: e2.y - 8 });
    // Eight pixels is a finger not quite still, not a drag.
    expect((rig.app as unknown as { press: { dragging: boolean } }).press.dragging).toBe(false);
    press(rig, 'pointermove', finger);
    expect((rig.app as unknown as { hovered: string | null }).hovered).toBe('e4');
    press(rig, 'pointerup', finger);
    await rig.until(() => moves(rig).length === 1);
    expect(moves(rig)).toEqual(['e4']);
  });

  it('is a drag for a mouse at six pixels, and for a finger only past ten', async () => {
    const rig = await fromAbove();
    const e2 = await spot(rig, 'e2');
    const state = () => (rig.app as unknown as { press: { dragging: boolean } }).press;
    press(rig, 'pointerdown', e2, { pointerType: 'mouse' });
    press(rig, 'pointermove', { x: e2.x + 8, y: e2.y }, { pointerType: 'mouse' });
    expect(state().dragging).toBe(true);
    press(rig, 'pointerup', { x: e2.x + 8, y: e2.y }, { pointerType: 'mouse' });
    press(rig, 'pointerdown', e2);
    press(rig, 'pointermove', { x: e2.x + 8, y: e2.y });
    expect(state().dragging).toBe(false);
    press(rig, 'pointermove', { x: e2.x + 11, y: e2.y });
    expect(state().dragging).toBe(true);
  });

  it('with a second finger pinches the free view nearer or further, and puts back a stone the first had taken up', async () => {
    const rig = await boot();
    rig.app.startTable();
    rig.app.setCamera('orbit');
    await rig.run(2);
    const orbit = (rig.app.rig as unknown as { orbit: { radius: number } }).orbit;
    const before = orbit.radius;
    press(rig, 'pointerdown', { x: 600, y: 360 }, { pointerId: 1 });
    press(rig, 'pointerdown', { x: 700, y: 360 }, { pointerId: 2 });
    // Spread from a hundred pixels apart to a hundred and fifty: nearer, by as much as a wheel would bring it.
    press(rig, 'pointermove', { x: 750, y: 360 }, { pointerId: 2 });
    expect(orbit.radius).toBeCloseTo(Math.max(8.5, (before * 100) / 150), 5);
    const nearer = orbit.radius;
    press(rig, 'pointermove', { x: 650, y: 360 }, { pointerId: 2 });
    expect(orbit.radius).toBeGreaterThan(nearer);
    press(rig, 'pointerup', { x: 650, y: 360 }, { pointerId: 2 });
    press(rig, 'pointerup', { x: 600, y: 360 }, { pointerId: 1 });
    // Neither finger played anything.
    expect(moves(rig)).toEqual([]);

    const top = await fromAbove();
    const e2 = await spot(top, 'e2');
    press(top, 'pointerdown', e2, { pointerId: 1 });
    expect(selected(top)).toBe('e2');
    press(top, 'pointerdown', { x: 100, y: 100 }, { pointerId: 2 });
    expect(selected(top)).toBeNull();
    press(top, 'pointerup', { x: 100, y: 100 }, { pointerId: 2 });
    press(top, 'pointerup', e2, { pointerId: 1 });
    expect(selected(top)).toBeNull();
    expect(moves(top)).toEqual([]);
  });
});

describe('coming back to the page', () => {
  it('starts the sound again if the system stopped it, Safari\'s "interrupted" included', async () => {
    const rig = await boot();
    const resume = vi.fn(() => Promise.resolve());
    (rig.world as unknown as { sound: unknown }).sound = { ctx: { state: 'interrupted', resume } };
    rig.fire('document', 'visibilitychange');
    expect(resume).toHaveBeenCalledTimes(1);
    // And at the next touch too, whatever the state is called that is not playing.
    rig.fire('window', 'pointerdown', { pointerType: 'touch' });
    expect(resume).toHaveBeenCalledTimes(2);
    (rig.world as unknown as { sound: { ctx: { state: string } } }).sound.ctx.state = 'running';
    rig.fire('document', 'visibilitychange');
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('has the connections to the server checked at once', async () => {
    const rig = await boot();
    const net = { wake: vi.fn() };
    const hall = { wake: vi.fn() };
    Object.assign(rig.app as unknown as object, { net, hall });
    rig.fire('document', 'visibilitychange');
    expect(net.wake).toHaveBeenCalledTimes(1);
    expect(hall.wake).toHaveBeenCalledTimes(1);
  });
});

// -- online, against the real server ---------------------------------------------

/** The other player: a bare connection that says only what the test tells it to. */
class Opponent {
  seat: string | null = null;
  state: RoomState | null = null;
  heard: ServerMessage[] = [];
  private socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(port: number, room: string, watch = false) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ready = new Promise((resolve) => {
      this.socket.addEventListener('open', () => this.send({ t: 'join', room, ...(watch ? { watch: true } : {}) }));
      this.socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        this.heard.push(message);
        if ('state' in message) this.state = message.state;
        if (message.t === 'joined' || message.t === 'seated') this.seat = message.you;
        if (message.t === 'joined') resolve();
      });
    });
  }
  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }
  move(text: string, ply: number): void {
    this.send({ t: 'move', ply, move: { from: text.slice(0, 2) as 'e2', to: text.slice(2, 4) as 'e4' } });
  }
  close(): void {
    this.socket.close();
  }
}

describe('online, through the real server', () => {
  let running: Running;
  const others: Opponent[] = [];
  const meet = async (room: string, watch = false) => {
    const o = new Opponent(running.port, room, watch);
    others.push(o);
    await o.ready;
    return o;
  };
  const address = (room: string) => `http://127.0.0.1:${running.port}/?room=${room}`;

  beforeAll(async () => {
    running = await startServer({ port: 0, root: 'no-such-folder' });
  });
  afterAll(async () => {
    for (const o of others) o.close();
    await running.close();
  });

  /** A game between this screen (Ivory) and a bare connection (Void), played to a quick mate for Void. */
  async function foolsMate(): Promise<{ rig: Rig; other: Opponent; room: string }> {
    const room = newRoomName();
    const rig = await boot({ address: address(room) });
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    const other = await meet(room);
    await eventually(rig, () => rig.ui.online.value?.taken.b === true);
    play(rig, 'f2', 'f3');
    await eventually(rig, () => other.state !== null && other.heard.some((m) => m.t === 'moved'));
    other.move('e7e5', 1);
    await eventually(rig, () => moves(rig).length === 2 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    play(rig, 'g2', 'g4');
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 3);
    other.move('d8h4', 3);
    await eventually(rig, () => rig.app.game.status().over);
    await eventually(rig, () => rig.ui.resultVisible.value);
    return { rig, other, room };
  }

  it("joins by the link, shows the other player's moves, and sends its own", async () => {
    const { rig, other } = await foolsMate();
    expect(moves(rig)).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
    expect(other.heard.filter((m) => m.t === 'moved')).toHaveLength(4);
    expect(rig.ui.status.value).toMatchObject({ result: 'checkmate', winner: 'b' });
  });

  it('brings the card back when the other player asks for another game after it was closed', async () => {
    const { rig, other } = await foolsMate();
    // The loser closes the card to look at the board. The winner asks for another game.
    rig.ui.resultVisible.value = false;
    other.send({ t: 'again' });
    await eventually(rig, () => rig.ui.online.value?.again.b === true);
    expect(rig.ui.resultVisible.value).toBe(true);
    // And agreeing starts it, colours swapped.
    rig.app.newGame();
    await eventually(rig, () => rig.ui.online.value?.seat === 'b');
    expect(moves(rig)).toEqual([]);
    expect(rig.ui.resultVisible.value).toBe(false);
  });

  /** A game between this screen (Ivory) and a bare connection (Void), one move each in. */
  async function underWay(): Promise<{ rig: Rig; other: Opponent }> {
    const room = newRoomName();
    const rig = await boot({ address: address(room) });
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    // Nobody to give the game up to yet.
    expect(rig.app.canResign()).toBe(false);
    const other = await meet(room);
    await eventually(rig, () => rig.ui.online.value?.taken.b === true);
    play(rig, 'e2', 'e4');
    await eventually(rig, () => other.heard.some((m) => m.t === 'moved'));
    other.move('e7e5', 1);
    await eventually(rig, () => moves(rig).length === 2 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    return { rig, other };
  }

  it('gives the game up through the server, which tells the other player', async () => {
    const { rig, other } = await underWay();
    expect(rig.app.canResign()).toBe(true);
    rig.app.askResign();
    rig.app.answerAsk(true);
    // It is the server's word that ends the game, not the press.
    await eventually(rig, () => rig.ui.status.value.over);
    expect(rig.ui.status.value).toMatchObject({ result: 'resigned', winner: 'b' });
    expect(other.state).toMatchObject({ resigned: 'w', moves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }] });
    await eventually(rig, () => rig.ui.resultVisible.value);
    // Online, what is done is done.
    expect(rig.ui.canTakeBack.value).toBe(false);
    void rig.app.takeBack();
    await rig.run(1);
    expect(rig.ui.status.value.result).toBe('resigned');
  });

  it('is told when the other player gives up, after their last move has been shown', async () => {
    const { rig, other } = await underWay();
    play(rig, 'g1', 'f3');
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 3);
    // Void answers and gives up in the same breath.
    other.move('b8c6', 3);
    other.send({ t: 'resign' });
    await eventually(rig, () => rig.ui.status.value.over);
    expect(moves(rig)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(rig.world.shown).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(rig.ui.status.value).toMatchObject({ result: 'resigned', winner: 'w' });
    await eventually(rig, () => rig.ui.resultVisible.value);
    // And the next game starts clean.
    rig.app.newGame();
    other.send({ t: 'again' });
    await eventually(rig, () => rig.ui.online.value?.seat === 'b');
    expect(rig.ui.status.value).toMatchObject({ over: false, result: null });
    expect(moves(rig)).toEqual([]);
  });

  it('offers a draw through the server, and the game ends when the other player agrees', async () => {
    const { rig, other } = await underWay();
    expect(rig.ui.canDraw.value).toBe(true);
    rig.app.askDraw();
    expect(rig.ui.asking.value).toBe('draw');
    rig.app.answerAsk(true);
    // It is only an offer: the game goes on until it is answered.
    await eventually(rig, () => rig.ui.online.value?.offer === 'w');
    expect(other.state).toMatchObject({ drawOffer: 'w', agreed: false });
    expect(rig.ui.status.value.over).toBe(false);
    // While it stands there is nothing more to offer.
    expect(rig.ui.canDraw.value).toBe(false);
    other.send({ t: 'draw' });
    await eventually(rig, () => rig.ui.status.value.over);
    expect(rig.ui.status.value).toMatchObject({ result: 'draw', drawReason: 'agreement', winner: null });
    expect(rig.ui.online.value?.offer).toBeNull();
    expect(rig.ui.notice.value).toBeNull();
    await eventually(rig, () => rig.ui.resultVisible.value);
    // Online, what is done is done.
    expect(rig.ui.canTakeBack.value).toBe(false);
    // And the next game starts clean.
    rig.app.newGame();
    other.send({ t: 'again' });
    await eventually(rig, () => rig.ui.online.value?.seat === 'b');
    expect(rig.ui.status.value).toMatchObject({ over: false, result: null, drawReason: null });
    expect(rig.ui.online.value?.offer).toBeNull();
  });

  it('is told when its offer of a draw is turned down, in words or by a move, but not when it takes it back', async () => {
    const { rig, other } = await underWay();
    rig.app.offerDraw();
    await eventually(rig, () => rig.ui.online.value?.offer === 'w');
    other.send({ t: 'nodraw' });
    await eventually(rig, () => rig.ui.online.value?.offer === null);
    expect(rig.ui.notice.value).toBe('Void would rather play on.');
    expect(rig.ui.status.value.over).toBe(false);
    // One offer a move: the next has to wait.
    expect(rig.ui.canDraw.value).toBe(false);
    play(rig, 'g1', 'f3');
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 3);
    expect(rig.ui.notice.value).toBeNull();
    other.move('b8c6', 3);
    await eventually(rig, () => moves(rig).length === 4 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    expect(rig.ui.canDraw.value).toBe(true);

    // Offered again, and this time taken back from here: that is not news.
    rig.app.offerDraw();
    await eventually(rig, () => rig.ui.online.value?.offer === 'w');
    rig.app.answerDraw(false);
    await eventually(rig, () => rig.ui.online.value?.offer === null);
    expect(other.state).toMatchObject({ drawOffer: null, agreed: false });
    expect(rig.ui.notice.value).toBeNull();

    // Offered a third time, two moves on, and answered by a move.
    play(rig, 'f1', 'c4');
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 5);
    other.move('g8f6', 5);
    await eventually(rig, () => moves(rig).length === 6 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    rig.app.offerDraw();
    await eventually(rig, () => rig.ui.online.value?.offer === 'w');
    play(rig, 'd2', 'd3');
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 7);
    // Its own move does not answer its own offer.
    expect(other.state).toMatchObject({ drawOffer: 'w' });
    other.move('f8c5', 7);
    await eventually(rig, () => moves(rig).length === 8 && rig.app.game.turn() === 'w');
    await eventually(rig, () => rig.ui.online.value?.offer === null);
    expect(rig.ui.notice.value).toBe('Void would rather play on.');
  });

  it('is shown a draw the other player offers, and can agree to it, decline it, or play on', async () => {
    const { rig, other } = await underWay();
    other.send({ t: 'draw' });
    await eventually(rig, () => rig.ui.online.value?.offer === 'b');
    // Theirs is answered, not met with another.
    expect(rig.ui.canDraw.value).toBe(false);
    rig.app.answerDraw(false);
    await eventually(rig, () => rig.ui.online.value?.offer === null);
    expect(other.state).toMatchObject({ drawOffer: null, agreed: false });
    expect(rig.ui.notice.value).toBeNull();
    expect(rig.ui.status.value.over).toBe(false);

    // Offered again two moves later, and left unanswered: to play on is to say no.
    play(rig, 'g1', 'f3');
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 3);
    other.move('b8c6', 3);
    await eventually(rig, () => moves(rig).length === 4 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    other.send({ t: 'draw' });
    await eventually(rig, () => rig.ui.online.value?.offer === 'b');
    play(rig, 'f1', 'c4');
    await eventually(rig, () => rig.ui.online.value?.offer === null);
    expect(rig.ui.status.value.over).toBe(false);

    // And a third time, with the question of offering one being asked here as it arrives: it gives way.
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 5);
    other.move('g8f6', 5);
    await eventually(rig, () => moves(rig).length === 6 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    rig.app.askDraw();
    expect(rig.ui.asking.value).toBe('draw');
    other.send({ t: 'draw' });
    await eventually(rig, () => rig.ui.online.value?.offer === 'b');
    expect(rig.ui.asking.value).toBeNull();
    rig.app.answerDraw(true);
    await eventually(rig, () => rig.ui.status.value.over);
    expect(rig.ui.status.value).toMatchObject({ result: 'draw', drawReason: 'agreement' });
    expect(other.state).toMatchObject({ agreed: true, drawOffer: null });
  });

  it('finds a draw agreed, or one offered, while it was away', async () => {
    const { rig, other } = await underWay();
    const room = new URL((globalThis as unknown as { location: { href: string } }).location.href).searchParams.get('room')!;
    other.send({ t: 'draw' });
    await eventually(rig, () => rig.ui.online.value?.offer === 'b');
    // The page is opened again on the same room: the offer is still there to be answered.
    const again = await boot({ address: address(room), keepStorage: true });
    await eventually(again, () => again.ui.online.value?.seat === 'w');
    await eventually(again, () => again.ui.online.value?.offer === 'b');
    again.app.answerDraw(true);
    await eventually(again, () => again.ui.status.value.over);
    // And once more: the game is found as it ended.
    const third = await boot({ address: address(room), keepStorage: true });
    await eventually(third, () => third.ui.online.value?.seat === 'w');
    await eventually(third, () => third.ui.status.value.over);
    expect(moves(third)).toEqual(['e4', 'e5']);
    expect(third.ui.status.value).toMatchObject({ result: 'draw', drawReason: 'agreement' });
  });

  it('finds a game given up while it was away', async () => {
    const { rig, other } = await underWay();
    const room = new URL((globalThis as unknown as { location: { href: string } }).location.href).searchParams.get('room')!;
    other.send({ t: 'resign' });
    await eventually(rig, () => rig.ui.status.value.over);
    // The page is opened again on the same room.
    const again = await boot({ address: address(room), keepStorage: true });
    await eventually(again, () => again.ui.online.value?.seat === 'w');
    await eventually(again, () => again.ui.status.value.over);
    expect(moves(again)).toEqual(['e4', 'e5']);
    expect(again.ui.status.value).toMatchObject({ result: 'resigned', winner: 'w' });
  });

  it('tells a visitor that the room is full', async () => {
    const room = newRoomName();
    await meet(room);
    await meet(room);
    // Every place to watch from is taken too.
    await Promise.all(Array.from({ length: 40 }, () => meet(room, true)));
    const rig = await boot({ address: address(room) });
    await eventually(rig, () => rig.ui.online.value?.note !== null && rig.ui.online.value?.note !== undefined);
    expect(rig.ui.online.value).toMatchObject({ seat: null, note: 'This room is full.' });
  });

  it('brings the interface back, when it has been put away, for a draw the other player offers', async () => {
    const { rig, other } = await underWay();
    rig.app.setBare(true);
    expect(rig.ui.bare.value).toBe(true);
    other.send({ t: 'draw' });
    await eventually(rig, () => rig.ui.online.value?.offer === 'b');
    expect(rig.ui.bare.value).toBe(false);
    // And it cannot be put away again while the offer waits for an answer.
    rig.app.setBare(true);
    expect(rig.ui.bare.value).toBe(false);
    rig.app.answerDraw(false);
    await eventually(rig, () => rig.ui.online.value?.offer === null);
    rig.app.setBare(true);
    expect(rig.ui.bare.value).toBe(true);
  });

  it('does not leave the question of giving up over a game the other player has just won', async () => {
    const room = newRoomName();
    const rig = await boot({ address: address(room) });
    await eventually(rig, () => rig.ui.online.value?.seat === 'w');
    const other = await meet(room);
    await eventually(rig, () => rig.ui.online.value?.taken.b === true);
    play(rig, 'f2', 'f3');
    await eventually(rig, () => other.heard.some((m) => m.t === 'moved'));
    other.move('e7e5', 1);
    await eventually(rig, () => moves(rig).length === 2 && rig.app.game.turn() === 'w');
    await rig.run(1.5);
    play(rig, 'g2', 'g4');
    await eventually(rig, () => other.heard.filter((m) => m.t === 'moved').length === 3);
    await rig.run(1.5);
    // Ivory thinks of giving up; Void mates meanwhile.
    rig.app.askResign();
    expect(rig.ui.asking.value).toBe('resign');
    other.move('d8h4', 3);
    await eventually(rig, () => rig.app.game.status().over);
    expect(rig.ui.asking.value).toBeNull();
    await eventually(rig, () => rig.ui.resultVisible.value);
    expect(rig.ui.status.value).toMatchObject({ result: 'checkmate', winner: 'b' });
  });

  it('is not told its move was illegal when the other player gave up just before it arrived', async () => {
    const { rig, other } = await underWay();
    // What the server says is kept from this screen until its move is on its way, so that the
    // server is sure to have the resignation first and this screen sure not to know of it.
    // (Sent one after the other on two lines, either could arrive first.)
    const socket = (rig.app as unknown as { net: { socket: WebSocket } }).net.socket;
    const deliver = socket.dispatchEvent.bind(socket);
    const kept: Event[] = [];
    socket.dispatchEvent = (event: Event) => (event.type === 'message' ? (kept.push(event), true) : deliver(event));
    other.send({ t: 'resign' });
    await eventually(rig, () => other.state?.resigned === 'b');
    expect(rig.app.game.status().over).toBe(false);
    play(rig, 'g1', 'f3');
    socket.dispatchEvent = deliver;
    for (const event of kept) deliver(event);
    await eventually(rig, () => rig.app.game.status().over);
    await rig.run(1.5);
    expect(rig.ui.status.value).toMatchObject({ result: 'resigned', winner: 'w' });
    expect(moves(rig)).toEqual(['e4', 'e5']);
    expect(rig.ui.notice.value).toBeNull();
  });

  it('does not make an offer of its own out of a yes that crossed the offer being taken back', async () => {
    const { rig, other } = await underWay();
    other.send({ t: 'draw' });
    await eventually(rig, () => rig.ui.online.value?.offer === 'b');
    // Void takes the offer back as Ivory agrees to it.
    other.send({ t: 'nodraw' });
    rig.app.answerDraw(true);
    await eventually(rig, () => rig.ui.online.value?.offer === null);
    await pause(150);
    await rig.run(0.5);
    expect(rig.ui.online.value?.offer).toBeNull();
    expect(other.state?.drawOffer ?? null).toBeNull();
    expect(rig.ui.status.value.over).toBe(false);
    expect(rig.ui.notice.value).toBe('Void took the offer back.');
  });

  it('agrees a draw the other player has offered', async () => {
    const { rig, other } = await underWay();
    other.send({ t: 'draw' });
    await eventually(rig, () => rig.ui.online.value?.offer === 'b');
    rig.app.answerDraw(true);
    await eventually(rig, () => rig.ui.status.value.over);
    expect(rig.ui.status.value).toMatchObject({ result: 'draw', drawReason: 'agreement' });
    expect(other.state).toMatchObject({ agreed: true });
  });
});
