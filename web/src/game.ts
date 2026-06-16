import type { RoadProps, Tier } from "./hittest";

export type Difficulty = "easy" | "medium" | "hard" | "extreme";

/** One quiz item: the label shown, which feature names count/light up,
 *  the area hint, and the primary district (for balanced selection). */
export interface Prompt {
  label: string;
  targets: string[];
  hint?: string;
  district?: string;
}

export const MAX_ATTEMPTS = 3;
const MIN_ROAD_M = 150;
const MIN_LANE_M = 100;
const EASY_MIN_M = 1500; // 簡單 = arterial/secondary AND at least this long
const MEDIUM_MIN_M = 500; // 中等 secondary/tertiary floor
const MEDIUM_RESID_MIN_M = 1000; // 中等 also takes long, recognizable residential roads

// Names that aren't "find this road" material in 簡單/中等: highways,
// tunnels, underpasses, riverside/cycle/scooter paths, levee roads.
const JUNK_NAME =
  /(公路|隧道|地下道|高架|戰備|產業道路|機慢車道|慢車道|機車道|自行車|堤外|河濱|越堤|步道|人行|便道|登山)/;

// Scoring by attempt number (0-indexed): 1st correct tap = 10, then
// 8/5/3/1, flooring at 1 for any later attempt. A used hint caps the
// round at HINT_POINTS.
const ATTEMPT_POINTS = [10, 8, 5, 3, 1];
const HINT_POINTS = 3;
const pointsForAttempt = (attempt: number): number =>
  ATTEMPT_POINTS[Math.min(attempt, ATTEMPT_POINTS.length - 1)];

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

/** "公館、景美一帶" from sub-district names; undefined if empty. */
function formatAreas(names: string[]): string | undefined {
  const uniq = [...new Set(names.filter(Boolean))];
  return uniq.length ? uniq.join("、") + "一帶" : undefined;
}

/** Prefer the finer sub-district hint; fall back to the 區 corridor. */
function areaHint(areas: string[], districts: string[]): string | undefined {
  return formatAreas(areas) ?? formatDistricts(districts);
}

/**
 * 簡單: long arterial/secondary roads, whole road (all sections light up).
 * 中等: secondary/tertiary ≥500m + long (≥1000m) recognizable residential
 *       roads, whole road — no 巷/弄, no junk names.
 * 困難: roads quizzed per 段, plus curated famous 巷/弄.
 * 極難: everything, per 段, 巷弄 included.
 */
export function buildPools(roads: RoadProps[]): Record<Difficulty, Prompt[]> {
  interface BaseAgg {
    names: string[];
    lenByTier: Partial<Record<Tier, number>>;
    distLen: Map<string, number>; // district -> summed length, for the corridor hint
    areaLen: Map<string, number>; // sub-district -> summed length
    totalLen: number;
    lane: boolean;
  }
  const bases = new Map<string, BaseAgg>();
  for (const r of roads) {
    let b = bases.get(r.base);
    if (!b) {
      b = { names: [], lenByTier: {}, distLen: new Map(), areaLen: new Map(), totalLen: 0, lane: !!r.lane };
      bases.set(r.base, b);
    }
    b.names.push(r.name);
    b.totalLen += r.length_m;
    b.lenByTier[r.tier] = (b.lenByTier[r.tier] ?? 0) + r.length_m;
    if (r.district) b.distLen.set(r.district, (b.distLen.get(r.district) ?? 0) + r.length_m);
    if (r.area) b.areaLen.set(r.area, (b.areaLen.get(r.area) ?? 0) + r.length_m);
  }
  // Top-3 contributors by length — long corridors otherwise list too many.
  const byLenDesc = (m: Map<string, number>) =>
    [...m.entries()].sort((a, c) => c[1] - a[1]).slice(0, 3).map((e) => e[0]);

  const pools: Record<Difficulty, Prompt[]> = { easy: [], medium: [], hard: [], extreme: [] };
  for (const [base, b] of bases) {
    if (b.lane) continue;
    const distCorridor = byLenDesc(b.distLen);
    const prompt: Prompt = {
      label: base,
      targets: b.names,
      hint: areaHint(byLenDesc(b.areaLen), distCorridor),
      district: distCorridor[0],
    };
    if (JUNK_NAME.test(base)) continue;
    const dominant = (Object.entries(b.lenByTier) as [Tier, number][]).reduce((a, c) =>
      c[1] > a[1] ? c : a,
    )[0];
    if (dominant !== "hard") {
      // proper district roads (幹道/次要/tertiary)
      if (b.totalLen >= EASY_MIN_M) pools.easy.push(prompt);
      if (b.totalLen >= MEDIUM_MIN_M) pools.medium.push(prompt);
    } else if (b.totalLen >= MEDIUM_RESID_MIN_M) {
      // long residential/unclassified roads are usually real arterials
      // OSM mis-tagged (內湖路, 迪化街…); short ones stay in 困難.
      pools.medium.push(prompt);
    }
  }
  for (const r of roads) {
    const single: Prompt = {
      label: r.name,
      targets: [r.name],
      hint: areaHint(r.area ? [r.area] : [], r.district ? [r.district] : []),
      district: r.district,
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

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
  // Prompts bucketed by district; each round picks a random non-empty
  // district then a random road in it, so large districts (士林, 北投)
  // don't dominate the questions.
  private buckets: Prompt[][];

  constructor(pool: Prompt[], opts: SessionOptions = { rounds: 10, maxAttempts: MAX_ATTEMPTS }) {
    const byDistrict = new Map<string, Prompt[]>();
    for (const p of shuffle([...pool])) {
      const k = p.district ?? "其他";
      const arr = byDistrict.get(k);
      if (arr) arr.push(p);
      else byDistrict.set(k, [p]);
    }
    this.buckets = [...byDistrict.values()];
    this.totalRounds = Math.min(opts.rounds, pool.length);
    this.maxAttempts = opts.maxAttempts;
  }

  get maxPoints(): number {
    return this.totalRounds * ATTEMPT_POINTS[0];
  }

  nextRound(): Prompt | null {
    this.buckets = this.buckets.filter((b) => b.length > 0);
    if (this.round >= this.totalRounds || this.buckets.length === 0) {
      this.target = null;
      return null;
    }
    this.round += 1;
    this.attempts = 0;
    this.hintUsed = false;
    const bucket = this.buckets[Math.floor(Math.random() * this.buckets.length)];
    this.target = bucket.pop()!; // bucket was shuffled at construction
    return this.target;
  }

  /** Reveal the area hint; caps this round's score at HINT_POINTS. Returns it. */
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
      const base = pointsForAttempt(this.attempts);
      const earned = this.hintUsed ? Math.min(base, HINT_POINTS) : base;
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
