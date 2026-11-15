/**
 * How gentle is each of the computer's levels? Plays it against a model of
 * someone who has only just learned the moves and reports how the games go.
 *
 *     npx tsx tools/dev/gentle.ts [level] [games]
 *
 * The beginner here does three things and nothing else: takes a piece when
 * the board shows it can be taken for nothing, does not put a piece where
 * the board marks it as lost, and otherwise moves at random. That is what
 * the game's own square markers tell a new player without any thought of
 * their own. They play Ivory. A game is stopped after 160 moves each.
 */
import { createRequire } from 'node:module';
import { Game, VALUE, type MoveOption, type Side } from '../../src/core/game.ts';
import { chooseMove } from '../../src/engine/opponent.ts';
import { Engine, LEVELS, type UciPort } from '../../src/engine/uci.ts';

const require = createRequire(import.meta.url);

function nodePort(): UciPort {
  let onLine: (line: string) => void = () => {};
  const engine = require('stockfish')('lite-single', (line: string) => onLine(line)) as { processCommand(c: string): void; terminate(): void };
  return { send: (line) => engine.processCommand(line), listen: (fn) => (onLine = fn), close: () => engine.terminate() };
}

/** A small repeatable source of random numbers, so that a run can be compared with the last. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function beginnerMove(game: Game, roll: () => number): MoveOption {
  const side = game.turn();
  const options = game
    .pieces()
    .filter((p) => p.side === side)
    .flatMap((p) => game.movesFrom(p.square));
  const worth = (o: MoveOption) => VALUE[game.pieceAt(o.to)?.kind ?? 'p'];
  const free = options.filter((o) => o.capture && !o.risky).sort((a, b) => worth(b) - worth(a));
  if (free.length > 0) return free[0]!;
  const safe = options.filter((o) => !o.risky);
  const pool = safe.length > 0 ? safe : options;
  return pool[Math.floor(roll() * pool.length)]!;
}

function material(game: Game, side: Side): number {
  return game
    .pieces()
    .filter((p) => p.side === side && p.kind !== 'k')
    .reduce((sum, p) => sum + VALUE[p.kind], 0);
}

const level = LEVELS.find((l) => l.id === (process.argv[2] ?? 'first')) ?? LEVELS[0]!;
const games = Number(process.argv[3] ?? 6);
const engine = new Engine(nodePort());
await engine.start();

console.log(`The level "${level.label}" against a beginner who only follows the board's markers, ${games} games:`);
let ahead = 0;
let lost = 0;
for (let g = 0; g < games; g++) {
  const roll = random(1000 + g);
  const game = new Game();
  while (!game.status().over && game.history().length < 320) {
    if (game.turn() === 'w') {
      const m = beginnerMove(game, roll);
      game.move(m.from, m.to, m.promotion ? 'q' : undefined);
    } else {
      const m = await chooseMove(engine, game.fen(), game.moves(), level, roll);
      game.move(m!.from, m!.to, m!.promotion);
    }
  }
  const s = game.status();
  const balance = material(game, 'w') - material(game, 'b');
  if (balance > 0) ahead++;
  if (s.winner === 'b') lost++;
  const end = s.result === 'checkmate' ? `${s.winner === 'w' ? 'the beginner' : 'the computer'} mates` : s.over ? `drawn (${s.drawReason})` : 'stopped';
  console.log(`  game ${g + 1}: ${String(Math.ceil(game.history().length / 2)).padStart(3)} moves, ${end}; the beginner is ${balance >= 0 ? `${balance} up` : `${-balance} down`} in material`);
}
console.log(`The beginner ended ahead in material in ${ahead} of ${games}, and was mated in ${lost}.`);
engine.close();
