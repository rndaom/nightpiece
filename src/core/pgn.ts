/**
 * A game written out in Portable Game Notation, the plain text that every other chess program
 * reads: seven lines of tags, the position it began from if that was not the usual one, the
 * moves, and the result.
 */
import { START_FEN, type Game, type Status } from './game';

export interface PgnTags {
  event?: string;
  site?: string;
  /** The day the game was played. Today, if it is not said. */
  date?: Date;
  round?: string;
  white?: string;
  black?: string;
}

export type PgnResult = '1-0' | '0-1' | '1/2-1/2' | '*';

/** The four ways the notation can end a game: White won, Black won, a draw, or not finished. */
export function pgnResult(status: Status): PgnResult {
  if (!status.over) return '*';
  if (status.winner === 'w') return '1-0';
  if (status.winner === 'b') return '0-1';
  return '1/2-1/2';
}

/** Lines are kept under this many characters, as the notation asks of anything written for others to read. */
const WIDTH = 80;

function tag(name: string, value: string): string {
  return `[${name} "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

export function writePgn(game: Game, tags: PgnTags = {}): string {
  const status = game.status();
  const result = pgnResult(status);
  const date = tags.date ?? new Date();
  const head = [
    tag('Event', tags.event ?? '?'),
    tag('Site', tags.site ?? '?'),
    tag('Date', `${date.getFullYear()}.${two(date.getMonth() + 1)}.${two(date.getDate())}`),
    tag('Round', tags.round ?? '-'),
    tag('White', tags.white ?? '?'),
    tag('Black', tags.black ?? '?'),
    tag('Result', result),
  ];
  const from = game.startFen();
  if (from !== START_FEN) head.push(tag('SetUp', '1'), tag('FEN', from));

  const words: string[] = [];
  let number = game.start().moveNumber;
  game.history().forEach((e, i) => {
    // White's moves carry the number. Black's does only where the game begins with it.
    if (e.side === 'w') words.push(`${number}.`);
    else if (i === 0) words.push(`${number}...`);
    words.push(e.san);
    if (e.side === 'b') number += 1;
  });
  // The two endings that are not on the board are said in words as well, for a person reading it.
  if (status.result === 'resigned' && status.winner) words.push(status.winner === 'w' ? '{Black resigns}' : '{White resigns}');
  else if (status.drawReason === 'agreement') words.push('{Draw agreed}');
  // So are the draws that were claimed, which a program reading the moves alone would not see ended there.
  else if (status.drawReason === 'threefold') words.push('{Draw claimed by threefold repetition}');
  else if (status.drawReason === 'fifty-move') words.push('{Draw claimed under the fifty-move rule}');
  else if (status.drawReason === 'timeout') words.push('{Time forfeit, but no mate was possible: draw}');
  words.push(result);

  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return `${head.join('\n')}\n\n${lines.join('\n')}\n`;
}
