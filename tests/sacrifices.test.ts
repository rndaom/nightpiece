/**
 * A sacrifice that wins is not a blunder. The famous games are replayed
 * against the real engine, each move judged as the game judges it (a quick
 * look, then a deeper one before anything is called a slip or a blunder),
 * and the winner's sacrifices must come through unmarked; while the moves
 * that really did lose those games, and the plain blunders of the shortest
 * games there are, are still marked.
 *
 * The searches are bounded by depth and by positions searched, never by the
 * clock, so that the answers are the same however busy the machine is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Game } from '../src/core/game.ts';
import { type Analysis, Engine, type EngineMove, type Score, type Setting } from '../src/engine/uci.ts';
import { FIRST_LOOK, judge, reconsider, SECOND_LOOK, type Verdict, type VerdictKind } from '../src/engine/verdict.ts';
import { nodePort } from './helpers/node-engine.ts';

/** Morphy against the Duke of Brunswick and Count Isouard, Paris 1858. */
const OPERA = 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#';
/** Réti against Tartakower, Vienna 1910: the queen given on d8 for a mate in two more. */
const RETI = 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nf6 Qd3 e5 dxe5 Qa5+ Bd2 Qxe5 O-O-O Nxe4 Qd8+ Kxd8 Bg5+ Kc7 Bd8#';
/** Légal's mate, Paris 1750: the queen left to be taken, and mate for it. */
const LEGAL = 'e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6 Nxe5 Bxd1 Bxf7+ Ke7 Nd5#';
/**
 * Anderssen against Kieseritzky, London 1851, the Immortal Game. Both rooks and the queen are given,
 * though not every move of the winner's stands up to an engine: 18.Bd6 should not have won.
 */
const IMMORTAL = 'e4 e5 f4 exf4 Bc4 Qh4+ Kf1 b5 Bxb5 Nf6 Nf3 Qh6 d3 Nh5 Nh4 Qg5 Nf5 c6 g4 Nf6 Rg1 cxb5 h4 Qg6 h5 Qg5 Qf3 Ng8 Bxf4 Qf6 Nc3 Bc5 Nd5 Qxb2 Bd6 Bxg1 e5 Qxa1+ Ke2 Na6 Nxg7+ Kd8 Qf6+ Nxf6 Be7#';
/** Anderssen against Dufresne, Berlin 1852, the Evergreen Game; again, sound at the end more than on the way. */
const EVERGREEN = 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O d3 Qb3 Qf6 e5 Qg6 Re1 Nge7 Ba3 b5 Qxb5 Rb8 Qa4 Bb6 Nbd2 Bb7 Ne4 Qf5 Bxd3 Qh5 Nf6+ gxf6 exf6 Rg8 Rad1 Qxf3 Rxe7+ Nxe7 Qxd7+ Kxd7 Bf5+ Ke8 Bd7+ Kf8 Bxe7#';
/** The quickest mates there are, each let in by a real blunder. */
const SCHOLAR = 'e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#';
const FOOL = 'f3 e5 g4 Qh4#';

/** The quick look as the game asks for it, but bounded by depth alone: the time limit is what a busy machine runs into. */
const QUICK = { ...FIRST_LOOK, movetime: undefined };

interface Judged {
  /** As the record numbers it: "15." for White's fifteenth move, "15..." for Black's. */
  label: string;
  san: string;
  side: 'w' | 'b';
  verdict: Verdict | null;
  checkmate: boolean;
}

/** Play a game through, judging every move as the game does. */
async function judgeGame(engine: Engine, moves: string): Promise<Judged[]> {
  await engine.newGame();
  const look = async (line: Setting, how: object): Promise<Analysis | null> => {
    const found = await engine.analyse(line.fen, { ...how, moves: line.moves });
    return found.lines.length > 0 ? found : null;
  };
  const game = new Game();
  let lineBefore = game.engineLine();
  let before = await look(lineBefore, QUICK);
  const judged: Judged[] = [];
  for (const [i, san] of moves.split(' ').entries()) {
    const move = game.readMove(san);
    if (!move) throw new Error(`${san} is not a move after ${game.fen()}`);
    const prior = game.lastMove();
    const e = game.move(move.from, move.to, move.promotion);
    const lineAfter = e.status.over ? null : game.engineLine();
    const after = lineAfter ? await look(lineAfter, QUICK) : null;
    const facts = { result: e.status.result, recapture: !!(e.captured && prior?.captured && prior.piece.to === e.piece.to) };
    const verdict = await reconsider(judge(before, after, move, facts), (line) => look(line, SECOND_LOOK), lineBefore, lineAfter, move, facts);
    judged.push({ label: `${Math.floor(i / 2) + 1}${i % 2 ? '...' : '.'}`, san, side: e.side, verdict, checkmate: e.status.result === 'checkmate' });
    before = after;
    if (lineAfter) lineBefore = lineAfter;
  }
  return judged;
}

const marked = (kind: VerdictKind | undefined) => kind === 'slip' || kind === 'blunder';
/** The moves of one side that were marked as mistakes, as the record would show them. */
const mistakes = (judged: Judged[], side: 'w' | 'b') => judged.filter((j) => j.side === side && marked(j.verdict?.kind)).map((j) => `${j.label}${j.san} (${j.verdict!.kind})`);
const find = (judged: Judged[], label: string) => judged.find((j) => `${j.label}${j.san}` === label)!;

const mv = (text: string): EngineMove => ({ from: text.slice(0, 2), to: text.slice(2, 4) }) as EngineMove;
const search = (...lines: [string, Score][]): Analysis => ({ best: lines[0] ? mv(lines[0][0]) : null, lines: lines.map(([m, score]) => ({ move: mv(m), score })), depth: 10 });
const plain = { result: null, recapture: false } as const;
const nowhere: Setting = { fen: 'any', moves: [] };

describe('a second look before a move is called a mistake', () => {
  it('lets the deeper search overturn the quick one, either way', async () => {
    // The quick look thinks the bishop thrown away; the deeper one finds it the best move by far.
    const quick = judge(search(['g5f6', { cp: 774 }], ['b3e6', { cp: 536 }]), search(['f6d7', { cp: -346 }]), mv('b5d7'), plain);
    expect(quick!.kind).toBe('slip');
    const looked: Setting[] = [];
    const deep = async (line: Setting) => (looked.push(line), search(['b5d7', { cp: 1149 }], ['g5f6', { cp: 781 }]));
    const before: Setting = { fen: 'before', moves: [] };
    expect(await reconsider(quick, deep, before, { fen: 'after', moves: [] }, mv('b5d7'), plain)).toMatchObject({ kind: 'strong', wasBest: true, loss: 0 });
    // The move was ranked by the deeper search of the position it was played in: the one it led to was not needed.
    expect(looked).toEqual([before]);
    // And a real blunder stays one, measured by the deeper search of where it led.
    const blunder = judge(search(['e2e4', { cp: 40 }], ['d2d4', { cp: 35 }]), search(['d8h4', { cp: 500 }]), mv('f2f3'), plain);
    const deeper = async (line: Setting) => (line.fen === 'before' ? search(['e2e4', { cp: 30 }], ['d2d4', { cp: 25 }]) : search(['d8h4', { mate: 3 }]));
    expect(await reconsider(blunder, deeper, before, { fen: 'after', moves: [] }, mv('f2f3'), plain)).toMatchObject({ kind: 'blunder', wasBest: false });
  });

  it('says nothing of a move it could not look at again, rather than guess', async () => {
    const quick = judge(search(['e2e4', { cp: 40 }], ['d2d4', { cp: 35 }]), search(['d8h4', { cp: 500 }]), mv('f2f3'), plain);
    expect(quick!.kind).toBe('blunder');
    expect(await reconsider(quick, async () => null, nowhere, nowhere, mv('f2f3'), plain)).toBeNull();
  });

  it('does not look again at a move it praised or let pass', async () => {
    const never = async (): Promise<Analysis> => {
      throw new Error('not asked');
    };
    const strong = judge(search(['f3h4', { cp: 620 }], ['d2d4', { cp: -40 }]), null, mv('f3h4'), plain);
    expect(await reconsider(strong, never, nowhere, nowhere, mv('f3h4'), plain)).toBe(strong);
    const sound = judge(search(['e2e4', { cp: 30 }], ['d2d4', { cp: 25 }]), null, mv('d2d4'), plain);
    expect(await reconsider(sound, never, nowhere, nowhere, mv('d2d4'), plain)).toBe(sound);
    expect(await reconsider(null, never, nowhere, nowhere, mv('d2d4'), plain)).toBeNull();
  });

  it('measures a mistake by the fall in the mover\'s chances, and calls letting in a mate a blunder', () => {
    // Four pawns given up from a level game is a blunder; from fourteen pawns up, it still wins as easily.
    expect(judge(search(['e2e4', { cp: 0 }], ['d2d4', { cp: -5 }]), search(['e7e5', { cp: 400 }]), mv('g2g4'), plain)!.kind).toBe('blunder');
    expect(judge(search(['g5f6', { cp: 1400 }], ['b3e6', { cp: 1300 }]), search(['f6d7', { cp: -1000 }]), mv('b5d7'), plain)!.kind).toBe('sound');
    // Four pawns down, but with no mate against it until the move: letting one in is a blunder.
    expect(judge(search(['e8e7', { cp: -470 }], ['e8f8', { cp: -520 }]), search(['d1d7', { mate: 4 }]), mv('f6e7'), plain)!.kind).toBe('blunder');
    // Hopeless already: being mated sooner is nothing to remark on.
    expect(judge(search(['e8e7', { cp: -1400 }], ['e8f8', { cp: -1450 }]), search(['d1d7', { mate: 2 }]), mv('f6e7'), plain)!.kind).toBe('sound');
  });
});

describe('the famous sacrifices, judged by the real engine', () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = new Engine(nodePort());
    await engine.start();
  }, 30000);
  afterAll(() => engine.close());

  it('the Opera Game: none of the winner\'s moves is a mistake, the bishop given on d7 is strong, and it ends in mate', async () => {
    const judged = await judgeGame(engine, OPERA);
    expect(mistakes(judged, 'w')).toEqual([]);
    for (const sacrifice of ['10.Nxb5', '13.Rxd7', '15.Bxd7+', '16.Qb8+']) expect(find(judged, sacrifice).verdict, sacrifice).not.toBeNull();
    expect(find(judged, '15.Bxd7+').verdict!.kind).toBe('strong');
    const last = judged[judged.length - 1]!;
    expect(`${last.label}${last.san}`).toBe('17.Rd8#');
    expect(last.checkmate).toBe(true);
    expect(last.verdict!.kind).toBe('strong');
  }, 60000);

  it('Réti against Tartakower and Légal\'s mate: the queen given for mate is no mistake, and the losers\' blunders are marked', async () => {
    const reti = await judgeGame(engine, RETI);
    expect(mistakes(reti, 'w')).toEqual([]);
    expect(find(reti, '9.Qd8+').verdict!.kind).toBe('strong');
    expect(reti[reti.length - 1]!.checkmate).toBe(true);
    const legal = await judgeGame(engine, LEGAL);
    expect(mistakes(legal, 'w')).toEqual([]);
    expect(find(legal, '5...Bxd1').verdict!.kind).toBe('blunder');
  }, 60000);

  it('the Immortal and the Evergreen: the mating sacrifices are not marked down, and the moves that lost are', async () => {
    const immortal = await judgeGame(engine, IMMORTAL);
    for (const label of ['21.Nxg7+', '22.Qf6+', '23.Be7#']) expect(marked(find(immortal, label).verdict?.kind), label).toBe(false);
    expect(find(immortal, '20...Na6').verdict!.kind).toBe('blunder');
    const evergreen = await judgeGame(engine, EVERGREEN);
    for (const label of ['20.Rxe7+', '21.Qxd7+', '22.Bf5+', '23.Bd7+', '24.Bxe7#']) expect(marked(find(evergreen, label).verdict?.kind), label).toBe(false);
    expect(find(evergreen, '21.Qxd7+').verdict!.kind).toBe('strong');
    expect(find(evergreen, '20...Nxe7').verdict!.kind).toBe('blunder');
  }, 90000);

  it('still calls a real blunder a blunder', async () => {
    expect(mistakes(await judgeGame(engine, SCHOLAR), 'b')).toEqual(['3...Nf6 (blunder)']);
    expect(mistakes(await judgeGame(engine, FOOL), 'w')).toEqual(['2.g4 (blunder)']);
  }, 30000);
});
