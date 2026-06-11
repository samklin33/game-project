import type { RoadProps, Tier } from "./hittest";

export type Difficulty = "easy" | "medium" | "hard" | "extreme";

/** One quiz item: the label shown, and which feature names count/light up. */
export interface Prompt {
  label: string;
  targets: string[];
}

export const MAX_ATTEMPTS = 3;
const MIN_ROAD_M = 150;
const MIN_LANE_M = 100;

/**
 * 簡單: arterial roads, whole road (all sections light up).
 * 中等: every road, whole road — no 巷/弄.
 * 困難: roads quizzed per 段, plus curated famous 巷/弄.
 * 極難: everything, per 段, 巷弄 included.
 */
export function buildPools(roads: RoadProps[]): Record<Difficulty, Prompt[]> {
  interface BaseAgg {
    names: string[];
    lenByTier: Partial<Record<Tier, number>>;
    totalLen: number;
    lane: boolean;
  }
  const bases = new Map<string, BaseAgg>();
  for (const r of roads) {
    let b = bases.get(r.base);
    if (!b) {
      b = { names: [], lenByTier: {}, totalLen: 0, lane: !!r.lane };
      bases.set(r.base, b);
    }
    b.names.push(r.name);
    b.totalLen += r.length_m;
    b.lenByTier[r.tier] = (b.lenByTier[r.tier] ?? 0) + r.length_m;
  }

  const pools: Record<Difficulty, Prompt[]> = { easy: [], medium: [], hard: [], extreme: [] };
  for (const [base, b] of bases) {
    if (b.lane || b.totalLen < MIN_ROAD_M) continue;
    const prompt = { label: base, targets: b.names };
    const dominant = (Object.entries(b.lenByTier) as [Tier, number][]).reduce((a, c) =>
      c[1] > a[1] ? c : a,
    )[0];
    if (dominant === "easy") pools.easy.push(prompt);
    pools.medium.push(prompt);
  }
  for (const r of roads) {
    const single = { label: r.name, targets: [r.name] };
    if (r.lane) {
      if (r.famous) {
        pools.hard.push(single);
        pools.extreme.push(single);
      } else if (r.length_m >= MIN_LANE_M) {
        pools.extreme.push(single);
      }
    } else if (r.length_m >= MIN_ROAD_M) {
      pools.hard.push(single);
      pools.extreme.push(single);
    }
  }
  return pools;
}

export type TapOutcome =
  | { kind: "correct"; targets: string[]; points: number }
  | { kind: "wrong"; name: string; attemptsLeft: number }
  | { kind: "reveal"; label: string; targets: string[] }
  | { kind: "ignored" };

export class Session {
  readonly totalRounds: number;
  round = 0;
  points = 0;
  correctCount = 0;
  streak = 0;
  bestStreak = 0;
  attempts = 0;
  target: Prompt | null = null;
  private remaining: Prompt[];

  constructor(pool: Prompt[], totalRounds = 10) {
    this.remaining = [...pool];
    this.totalRounds = Math.min(totalRounds, pool.length);
  }

  get maxPoints(): number {
    return this.totalRounds * MAX_ATTEMPTS;
  }

  nextRound(): Prompt | null {
    if (this.round >= this.totalRounds) {
      this.target = null;
      return null;
    }
    this.round += 1;
    this.attempts = 0;
    const i = Math.floor(Math.random() * this.remaining.length);
    this.target = this.remaining.splice(i, 1)[0];
    return this.target;
  }

  /**
   * Intersections yield several names — if any matches the prompt it
   * counts (the overlap isn't the player's fault). First hit = 3 pts,
   * second = 2, third = 1; three misses reveals the answer for 0.
   */
  handleTap(names: string[]): TapOutcome {
    if (!this.target || names.length === 0) return { kind: "ignored" };
    if (names.some((n) => this.target!.targets.includes(n))) {
      const earned = MAX_ATTEMPTS - this.attempts;
      this.points += earned;
      this.correctCount += 1;
      this.streak += 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      return { kind: "correct", targets: this.target.targets, points: earned };
    }
    this.attempts += 1;
    if (this.attempts >= MAX_ATTEMPTS) return this.reveal();
    return { kind: "wrong", name: names[0], attemptsLeft: MAX_ATTEMPTS - this.attempts };
  }

  /** Player gives up (看答案) or runs out of attempts. */
  reveal(): TapOutcome {
    if (!this.target) return { kind: "ignored" };
    this.streak = 0;
    return { kind: "reveal", label: this.target.label, targets: this.target.targets };
  }

  get done(): boolean {
    return this.round >= this.totalRounds && this.target === null;
  }
}
