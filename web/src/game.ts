import type { RoadProps, Tier } from "./hittest";
import { TIER_POOLS } from "./hittest";

export type TapOutcome =
  | { kind: "correct"; name: string }
  | { kind: "wrong"; name: string; missesLeft: number }
  | { kind: "reveal"; answer: string; wrongName: string }
  | { kind: "ignored" };

export const MAX_MISSES = 3;

export class Session {
  readonly pool: RoadProps[];
  readonly totalRounds: number;
  round = 0;
  score = 0;
  streak = 0;
  bestStreak = 0;
  misses = 0;
  target: RoadProps | null = null;
  private remaining: RoadProps[];

  constructor(roads: RoadProps[], tier: Tier, totalRounds = 10) {
    const classes = new Set<Tier>(TIER_POOLS[tier]);
    this.pool = roads.filter((r) => classes.has(r.tier));
    this.totalRounds = Math.min(totalRounds, this.pool.length);
    this.remaining = [...this.pool];
  }

  /** Advance to the next round; returns the new target, or null when done. */
  nextRound(): RoadProps | null {
    if (this.round >= this.totalRounds) {
      this.target = null;
      return null;
    }
    this.round += 1;
    this.misses = 0;
    const i = Math.floor(Math.random() * this.remaining.length);
    this.target = this.remaining.splice(i, 1)[0];
    return this.target;
  }

  /**
   * Resolve tapped road names. Intersections yield several names — if any
   * matches the prompt it counts as correct (the overlap isn't the
   * player's fault, SPEC §4).
   */
  handleTap(names: string[]): TapOutcome {
    if (!this.target || names.length === 0) return { kind: "ignored" };
    if (names.includes(this.target.name)) {
      this.score += 1;
      this.streak += 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      return { kind: "correct", name: this.target.name };
    }
    this.misses += 1;
    if (this.misses >= MAX_MISSES) {
      this.streak = 0;
      return { kind: "reveal", answer: this.target.name, wrongName: names[0] };
    }
    return { kind: "wrong", name: names[0], missesLeft: MAX_MISSES - this.misses };
  }

  get done(): boolean {
    return this.round >= this.totalRounds && this.target === null;
  }
}
