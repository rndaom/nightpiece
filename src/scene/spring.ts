/**
 * Values that follow a goal the way a weight on a spring does. Almost
 * everything that moves by itself in the game is one of these: they ease in
 * and out by construction, and a new goal (or a knock) at any moment never
 * causes a jump.
 */
import type { Vector3 } from 'three';

export class Spring {
  value = 0;
  velocity = 0;
  goal = 0;

  constructor(start = 0) {
    this.value = this.goal = start;
  }

  /**
   * Advance by `dt` seconds. `omega` is the stiffness: the value covers most of the distance to
   * its goal in about 3 / omega seconds. `damping` of 1 arrives without overshoot; less than 1
   * overshoots and settles, which suits things that should wobble when knocked.
   */
  step(dt: number, omega: number, damping = 1): void {
    if (dt <= 0) return;
    if (damping === 1) {
      // The exact solution, stable for any step.
      const d = this.value - this.goal;
      const temp = (this.velocity + omega * d) * dt;
      const decay = Math.exp(-omega * dt);
      this.velocity = (this.velocity - omega * temp) * decay;
      this.value = this.goal + (d + temp) * decay;
      return;
    }
    let remaining = dt;
    while (remaining > 1e-7) {
      const h = Math.min(remaining, 1 / 240);
      remaining -= h;
      this.velocity += (-2 * damping * omega * this.velocity - omega * omega * (this.value - this.goal)) * h;
      this.value += this.velocity * h;
    }
  }

  /** Be at a value now, at rest. */
  snap(to: number): void {
    this.value = this.goal = to;
    this.velocity = 0;
  }
}

export class Spring3 {
  readonly x = new Spring();
  readonly y = new Spring();
  readonly z = new Spring();

  step(dt: number, omega: number, damping = 1): void {
    this.x.step(dt, omega, damping);
    this.y.step(dt, omega, damping);
    this.z.step(dt, omega, damping);
  }
  setGoal(v: Vector3): void {
    this.x.goal = v.x;
    this.y.goal = v.y;
    this.z.goal = v.z;
  }
  snap(v: Vector3): void {
    this.x.snap(v.x);
    this.y.snap(v.y);
    this.z.snap(v.z);
  }
  get(out: Vector3): Vector3 {
    return out.set(this.x.value, this.y.value, this.z.value);
  }
  goal(out: Vector3): Vector3 {
    return out.set(this.x.goal, this.y.goal, this.z.goal);
  }
  speed(out: Vector3): Vector3 {
    return out.set(this.x.velocity, this.y.velocity, this.z.velocity);
  }
}
