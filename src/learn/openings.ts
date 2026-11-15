/**
 * The names of the openings. A game that begins from the usual position is
 * watched for its first dozen moves, and when the position on the board is
 * one that has a name, the game says so: a beginner hears what chess players
 * call the thing they have just done.
 *
 * Positions are matched, not move orders, so a line reached by a different
 * road is still recognised. The names are the common English ones.
 */
import { Chess } from 'chess.js';

/** Each line is the moves that reach a named position, and its name. The longest lines are a dozen moves or so. */
const LINES: [string, string][] = [
  // -- the king's pawn, answered in kind
  ['e4', "King's Pawn Opening"],
  ['e4 e5', 'Open Game'],
  ['e4 e5 Nf3', "King's Knight Opening"],
  ['e4 e5 Nf3 Nc6 Bb5', 'Ruy Lopez'],
  ['e4 e5 Nf3 Nc6 Bb5 a6', 'Ruy Lopez, Morphy Defence'],
  ['e4 e5 Nf3 Nc6 Bb5 a6 Bxc6', 'Ruy Lopez, Exchange Variation'],
  ['e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7', 'Ruy Lopez, Closed'],
  ['e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Nxe4', 'Ruy Lopez, Open'],
  ['e4 e5 Nf3 Nc6 Bb5 Nf6', 'Ruy Lopez, Berlin Defence'],
  ['e4 e5 Nf3 Nc6 Bc4', 'Italian Game'],
  ['e4 e5 Nf3 Nc6 Bc4 Bc5', 'Giuoco Piano'],
  ['e4 e5 Nf3 Nc6 Bc4 Bc5 b4', 'Evans Gambit'],
  ['e4 e5 Nf3 Nc6 Bc4 Nf6', 'Two Knights Defence'],
  ['e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5 Nxf7', 'Fried Liver Attack'],
  ['e4 e5 Nf3 Nc6 d4', 'Scotch Game'],
  ['e4 e5 Nf3 Nc6 d4 exd4 Bc4', 'Scotch Gambit'],
  ['e4 e5 Nf3 Nc6 Nc3', 'Three Knights Game'],
  ['e4 e5 Nf3 Nc6 Nc3 Nf6', 'Four Knights Game'],
  ['e4 e5 Nf3 Nc6 c3', 'Ponziani Opening'],
  ['e4 e5 Nf3 Nf6', "Petrov's Defence"],
  ['e4 e5 Nf3 d6', 'Philidor Defence'],
  ['e4 e5 Nf3 f5', 'Latvian Gambit'],
  ['e4 e5 Nf3 d5', 'Elephant Gambit'],
  ['e4 e5 f4', "King's Gambit"],
  ['e4 e5 f4 exf4', "King's Gambit Accepted"],
  ['e4 e5 f4 Bc5', "King's Gambit Declined"],
  ['e4 e5 f4 d5', 'Falkbeer Countergambit'],
  ['e4 e5 Nc3', 'Vienna Game'],
  ['e4 e5 Nc3 Nf6 f4', 'Vienna Gambit'],
  ['e4 e5 Bc4', "Bishop's Opening"],
  ['e4 e5 d4', 'Centre Game'],
  ['e4 e5 d4 exd4 c3', 'Danish Gambit'],
  ['e4 e5 Qh5', 'Wayward Queen Attack'],
  ['e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#', "Scholar's Mate"],
  ['e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#', "Scholar's Mate"],

  // -- the king's pawn, answered otherwise
  ['e4 c5', 'Sicilian Defence'],
  ['e4 c5 Nf3 d6 d4 cxd4 Nxd4', 'Sicilian Defence, Open'],
  ['e4 c5 Nf3 Nc6 d4 cxd4 Nxd4', 'Sicilian Defence, Open'],
  ['e4 c5 Nf3 e6 d4 cxd4 Nxd4', 'Sicilian Defence, Open'],
  ['e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', 'Sicilian Defence, Najdorf Variation'],
  ['e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6', 'Sicilian Defence, Dragon Variation'],
  ['e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6', 'Sicilian Defence, Classical Variation'],
  ['e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6', 'Sicilian Defence, Scheveningen Variation'],
  ['e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5', 'Sicilian Defence, Sveshnikov Variation'],
  ['e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6', 'Sicilian Defence, Accelerated Dragon'],
  ['e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6', 'Sicilian Defence, Kan Variation'],
  ['e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6', 'Sicilian Defence, Taimanov Variation'],
  ['e4 c5 c3', 'Sicilian Defence, Alapin Variation'],
  ['e4 c5 Nc3', 'Sicilian Defence, Closed'],
  ['e4 c5 Nc3 Nc6 f4', 'Sicilian Defence, Grand Prix Attack'],
  ['e4 c5 d4 cxd4 c3', 'Sicilian Defence, Smith-Morra Gambit'],
  ['e4 c5 Nf3 d6 Bb5+', 'Sicilian Defence, Moscow Variation'],
  ['e4 c5 Nf3 Nc6 Bb5', 'Sicilian Defence, Rossolimo Variation'],
  ['e4 c5 b4', 'Sicilian Defence, Wing Gambit'],
  ['e4 e6', 'French Defence'],
  ['e4 e6 d4 d5 e5', 'French Defence, Advance Variation'],
  ['e4 e6 d4 d5 exd5', 'French Defence, Exchange Variation'],
  ['e4 e6 d4 d5 Nd2', 'French Defence, Tarrasch Variation'],
  ['e4 e6 d4 d5 Nc3 Bb4', 'French Defence, Winawer Variation'],
  ['e4 e6 d4 d5 Nc3 Nf6', 'French Defence, Classical Variation'],
  ['e4 e6 d4 d5 Nc3 dxe4', 'French Defence, Rubinstein Variation'],
  ['e4 c6', 'Caro-Kann Defence'],
  ['e4 c6 d4 d5 e5', 'Caro-Kann Defence, Advance Variation'],
  ['e4 c6 d4 d5 exd5 cxd5', 'Caro-Kann Defence, Exchange Variation'],
  ['e4 c6 d4 d5 exd5 cxd5 c4', 'Caro-Kann Defence, Panov Attack'],
  ['e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5', 'Caro-Kann Defence, Classical Variation'],
  ['e4 d5', 'Scandinavian Defence'],
  ['e4 d5 exd5 Nf6', 'Scandinavian Defence, Modern Variation'],
  ['e4 d6', 'Pirc Defence'],
  ['e4 d6 d4 Nf6 Nc3 g6', 'Pirc Defence'],
  ['e4 g6', 'Modern Defence'],
  ['e4 Nf6', "Alekhine's Defence"],
  ['e4 Nc6', 'Nimzowitsch Defence'],
  ['e4 b6', "Owen's Defence"],
  ['e4 a6', 'St George Defence'],

  // -- the queen's pawn
  ['d4', "Queen's Pawn Opening"],
  ['d4 d5', 'Closed Game'],
  ['d4 d5 c4', "Queen's Gambit"],
  ['d4 d5 c4 dxc4', "Queen's Gambit Accepted"],
  ['d4 d5 c4 e6', "Queen's Gambit Declined"],
  ['d4 d5 c4 e6 Nc3 c5', 'Tarrasch Defence'],
  ['d4 d5 c4 c6', 'Slav Defence'],
  ['d4 d5 c4 c6 Nf3 Nf6 Nc3 e6', 'Semi-Slav Defence'],
  ['d4 d5 c4 e5', 'Albin Countergambit'],
  ['d4 d5 c4 Nc6', 'Chigorin Defence'],
  ['d4 d5 Bf4', 'London System'],
  ['d4 d5 Nf3 Nf6 Bf4', 'London System'],
  ['d4 Nf6 Bf4', 'London System'],
  ['d4 Nf6 Nf3 e6 Bf4', 'London System'],
  ['d4 d5 Nf3 Nf6 e3', 'Colle System'],
  ['d4 d5 e4', 'Blackmar-Diemer Gambit'],
  ['d4 Nf6', 'Indian Defence'],
  ['d4 Nf6 c4 e6 Nc3 Bb4', 'Nimzo-Indian Defence'],
  ['d4 Nf6 c4 e6 Nf3 b6', "Queen's Indian Defence"],
  ['d4 Nf6 c4 e6 Nf3 Bb4+', 'Bogo-Indian Defence'],
  ['d4 Nf6 c4 e6 g3', 'Catalan Opening'],
  ['d4 Nf6 c4 g6 Nc3 Bg7', "King's Indian Defence"],
  ['d4 Nf6 c4 g6 Nc3 d5', 'Grünfeld Defence'],
  ['d4 Nf6 c4 c5', 'Benoni Defence'],
  ['d4 Nf6 c4 c5 d5 e6', 'Modern Benoni'],
  ['d4 Nf6 c4 c5 d5 b5', 'Benko Gambit'],
  ['d4 Nf6 c4 e5', 'Budapest Gambit'],
  ['d4 Nf6 Bg5', 'Trompowsky Attack'],
  ['d4 f5', 'Dutch Defence'],
  ['d4 f5 e4', 'Staunton Gambit'],
  ['d4 c5', 'Old Benoni Defence'],
  ['d4 g6', 'Modern Defence'],
  ['d4 b5', 'Polish Defence'],

  // -- from the flank, and the oddities
  ['c4', 'English Opening'],
  ['c4 e5', 'English Opening, Reversed Sicilian'],
  ['c4 c5', 'English Opening, Symmetrical Variation'],
  ['Nf3', 'Zukertort Opening'],
  ['Nf3 d5 c4', 'Réti Opening'],
  ['Nf3 d5 g3', "King's Indian Attack"],
  ['f4', "Bird's Opening"],
  ['f4 e5', "From's Gambit"],
  ['b3', 'Nimzowitsch-Larsen Attack'],
  ['g3', "King's Fianchetto Opening"],
  ['b4', 'Polish Opening'],
  ['g4', "Grob's Attack"],
  ['Nc3', 'Van Geet Opening'],
  ['e3', "Van 't Kruijs Opening"],
  ['d3', 'Mieses Opening'],
  ['a3', "Anderssen's Opening"],
  ['c3', 'Saragossa Opening'],
  ['f3', 'Barnes Opening'],
  ['h3', 'Clemenz Opening'],
  ['a4', 'Ware Opening'],
  ['h4', 'Kádas Opening'],
  ['Na3', 'Durkin Opening'],
  ['Nh3', 'Amar Opening'],
  ['f3 e5 g4 Qh4#', "Fool's Mate"],
];

/** How far into a game the openings are looked for: none of the lines above is longer. */
export const OPENING_PLIES = 12;

/** What tells one position from another here: the stones, whose move it is, and who may still castle. */
function keyOf(fen: string): string {
  return fen.split(' ').slice(0, 3).join(' ');
}

let book: Map<string, string> | null = null;

/** Every named position. Built the first time it is wanted. */
function names(): Map<string, string> {
  if (book) return book;
  book = new Map();
  for (const [line, name] of LINES) {
    const chess = new Chess();
    for (const san of line.split(' ')) chess.move(san);
    book.set(keyOf(chess.fen()), name);
  }
  return book;
}

/** Builds the book now, so that the first move of a game does not stop to build it. */
export function prepareOpenings(): void {
  names();
}

/** The lines and their names, for the tests. */
export function openingLines(): readonly [string, string][] {
  return LINES;
}

/**
 * The opening a game from the usual starting position has reached, given its moves so far in
 * standard notation: the name of the latest position that has one, and how many moves had
 * been played in it. Null before the first move, and for a game that began somewhere else.
 */
export function openingOf(sans: readonly string[]): { name: string; ply: number } | null {
  if (sans.length === 0) return null;
  const known = names();
  const chess = new Chess();
  let found: { name: string; ply: number } | null = null;
  for (let i = 0; i < sans.length && i < OPENING_PLIES; i++) {
    try {
      chess.move(sans[i]!);
    } catch {
      // Not a game from the usual position: its moves do not fit it.
      return null;
    }
    const name = known.get(keyOf(chess.fen()));
    if (name) found = { name, ply: i + 1 };
  }
  return found;
}
