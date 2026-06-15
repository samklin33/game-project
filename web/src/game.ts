import type { RoadProps, Tier } from "./hittest";

export type Difficulty = "easy" | "medium" | "hard" | "extreme";

/** One quiz item: the label shown, and which feature names count/light up. */
export interface Prompt {
  label: string;
  targets: string[];
  hint?: string; // district(s) the road passes through, e.g. 大安、信義區
}

export const MAX_ATTEMPTS = 3;
const MIN_ROAD_M = 150;
const MIN_LANE_M = 100;
const MEDIUM_MIN_M = 500; // 中等 floor — drop obscure sub-500m stubs
// 簡單: prominent = arterial-or-secondary class AND at least this long.
// Pure trunk/primary is only ~40 roads in Taipei because OSM tags famous
// streets like 信義路/南京東路 as secondary — too thin a pool on its own.
const EASY_MIN_M = 1500;
// Long ≠ famous: hill highways, tunnels, service roads are barred from
// 簡單 even when they pass the length bar (中湖戰備道路, 陽金公路…).
// Mirrored in scripts/build_roads.py stats.
const EASY_EXCLUDE = /(公路|隧道|地下道|高架|戰備|產業道路)/;

/** "大安、信義、松山區" from ["大安區","信義區","松山區"]; undefined if empty. */
function formatDistricts(names: string[]): string | undefined {
  const uniq = [...new Set(names.filter(Boolean))];
  if (uniq.length === 0) return undefined;
  const suffix = uniq[0].slice(-1);
  if (uniq.every((d) => d.endsWith(suffix))) {
    return uniq.map((d) => d.slice(0, -1)).join("、") + suffix;
  }
  return uniq.join("、");
}

/**
 * 簡單: long arterial/secondary roads, whole road (all sections light up).
 * 中等: roads ≥500m, whole road — no 巷/弄, no junk names.
 * 困難: roads quizzed per 段, plus curated famous 巷/弄.
 * 極難: everything, per 段, 巷弄 included.
 */
export function buildPools(roads: RoadProps[]): Record<Difficulty, Prompt[]> {
  interface BaseAgg {
    names: string[];
    lenByTier: Partial<Record<Tier, number>>;
    distLen: Map<string, number>; // district -> summed length, for the corridor hint
    totalLen: number;
    lane: boolean;
  }
  const bases = new Map<string, BaseAgg>();
  for (const r of roads) {
    let b = bases.get(r.base);
    if (!b) {
      b = { names: [], lenByTier: {}, distLen: new Map(), totalLen: 0, lane: !!r.lane };
      bases.set(r.base, b);
    }
    b.names.push(r.name);
    b.totalLen += r.length_m;
    b.lenByTier[r.tier] = (b.lenByTier[r.tier] ?? 0) + r.length_m;
    if (r.district) b.distLen.set(r.district, (b.distLen.get(r.district) ?? 0) + r.length_m);
  }

  const pools: Record<Difficulty, Prompt[]> = { easy: [], medium: [], hard: [], extreme: [] };
  for (const [base, b] of bases) {
    if (b.lane) continue;
    const corridor = [...b.distLen.entries()].sort((a, c) => c[1] - a[1]).map((e) => e[0]);
    const prompt: Prompt = { label: base, targets: b.names, hint: formatDistricts(corridor) };
    const dominant = (Object.entries(b.lenByTier) as [Tier, number][]).reduce((a, c) =>
      c[1] > a[1] ? c : a,
    )[0];
    const notJunk = !EASY_EXCLUDE.test(base);
    if (dominant !== "hard" && b.totalLen >= EASY_MIN_M && notJunk) pools.easy.push(prompt);
    if (b.totalLen >= MEDIUM_MIN_M && notJunk) pools.medium.push(prompt);
  }
  for (const r of roads) {
    const single: Prompt = {
      label: r.name,
      targets: [r.name],
      hint: formatDistricts(r.district ? [r.district] : []),
    };
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

export interface SessionOptions {
  rounds: number;
  maxAttempts: number; // Infinity = only 看答案 ends a round
}

export class Session {
  readonly totalRounds: number;
  readonly maxAttempts: number;
  round = 0;
  points = 0;
  correctCount = 0;
  streak = 0;
  bestStreak = 0;
  attempts = 0;
  hintUsed = false;
  target: Prompt | null = null;
  private remaining: Prompt[];

  constructor(pool: Prompt[], opts: SessionOptions = { rounds: 10, maxAttempts: MAX_ATTEMPTS }) {
    this.remaining = [...pool];
    this.totalRounds = Math.min(opts.rounds, pool.length);
    this.maxAttempts = opts.maxAttempts;
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
    this.hintUsed = false;
    const i = Math.floor(Math.random() * this.remaining.length);
    this.target = this.remaining.splice(i, 1)[0];
    return this.target;
  }

  /** Reveal the district hint; caps this round's score at 1. Returns it. */
  useHint(): string | null {
    if (!this.target?.hint) return null;
    this.hintUsed = true;
    return this.target.hint;
  }

  /**
   * Intersections yield several names — if any matches the prompt it
   * counts (the overlap isn't the player's fault). First hit = 3 pts,
   * second = 2, any later = 1; a used hint caps the round at 1; running
   * out of attempts reveals for 0.
   */
  handleTap(names: string[]): TapOutcome {
    if (!this.target || names.length === 0) return { kind: "ignored" };
    if (names.some((n) => this.target!.targets.includes(n))) {
      const earned = this.hintUsed ? 1 : Math.max(MAX_ATTEMPTS - this.attempts, 1);
      this.points += earned;
      this.correctCount += 1;
      this.streak += 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      return { kind: "correct", targets: this.target.targets, points: earned };
    }
    this.attempts += 1;
    if (this.attempts >= this.maxAttempts) return this.reveal();
    return { kind: "wrong", name: names[0], attemptsLeft: this.maxAttempts - this.attempts };
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
