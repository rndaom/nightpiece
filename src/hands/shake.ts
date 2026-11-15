/**
 * Tells a pointer that is being shaken from side to side from one that is only passing: three
 * turns back within a second, each after it has gone a fair way. Fed where the pointer is across
 * the picture (as a share of the picture's height) and the time, each time it moves.
 */
const FAR = 0.012;
const WITHIN = 1;
const TURNS = 3;

export class Shake {
  private last: number | null = null;
  private way = 0;
  private gone = 0;
  private turns: number[] = [];

  /** True when this move of the pointer is the last of a shake: and then it begins again from nothing. */
  feed(x: number, time: number): boolean {
    if (this.last === null) {
      this.last = x;
      return false;
    }
    const by = x - this.last;
    this.last = x;
    if (by === 0) return false;
    const way = Math.sign(by);
    if (way !== this.way) {
      if (this.way !== 0 && this.gone >= FAR) this.turns.push(time);
      this.way = way;
      this.gone = 0;
    }
    this.gone += Math.abs(by);
    while (this.turns.length > 0 && time - this.turns[0]! > WITHIN) this.turns.shift();
    if (this.turns.length < TURNS) return false;
    this.clear();
    return true;
  }

  /** The pointer has gone elsewhere: whatever it had done is forgotten. */
  clear(): void {
    this.last = null;
    this.way = 0;
    this.gone = 0;
    this.turns.length = 0;
  }
}
