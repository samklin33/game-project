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
const MEDIUM_MRT_MIN_M = 200; // 中等 also takes short central roads next to an MRT station
// "Urban-ness": avg number of distinct roads sharing a ~250m cell with this
// road. Mountain/rural roads sit near ~1; urban arterials 3-12. A floor on
// this keeps 簡單/中等 to inhabited grids (works for no-MRT 五股/泰山/林口
// too) and drops isolated hill roads. Cheap to retune — no data rebuild.
const DENSITY_CELL = 0.0025;
const DENSITY_MIN = 2.0;

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

/** "捷運市政府站、光華商場附近" from references; undefined if empty. */
function formatAreas(names: string[]): string | undefined {
  const uniq = [...new Set(names.filter(Boolean))];
  return uniq.length ? uniq.join("、") + "附近" : undefined;
}

/** Prefer the finer sub-district hint; fall back to the 區 corridor. */
function areaHint(areas: string[], districts: string[]): string | undefined {
  return formatAreas(areas) ?? formatDistricts(districts);
}

/**
 * 簡單: long arterial/secondary roads, whole road (all sections light up).
 * 中等: secondary/tertiary ≥500m + long (≥1000m) residential roads +
 *       short central roads next to an MRT station (館前路, 峨眉街…),
 *       whole road — no 巷/弄, no junk names.
 * 困難: roads quizzed per 段, plus curated famous 巷/弄.
 * 極難: everything, per 段, 巷弄 included.
 */
export function buildPools(features: GeoJSON.Feature[]): Record<Difficulty, Prompt[]> {
  const roads = features.map((f) => f.properties as RoadProps);

  // Density grid: per ~250m cell, the set of distinct base roads passing
  // through it. A base's urban-ness = avg distinct roads over its cells.
  const cellRoads = new Map<string, Set<string>>();
  const baseCells = new Map<string, Set<string>>();
  for (const f of features) {
    const base = (f.properties as RoadProps).base;
    const geom = f.geometry;
    if (geom.type !== "MultiLineString") continue;
    let bc = baseCells.get(base);
    if (!bc) baseCells.set(base, (bc = new Set()));
    for (const line of geom.coordinates) {
      for (const [x, y] of line) {
        const key = `${Math.floor(x / DENSITY_CELL)},${Math.floor(y / DENSITY_CELL)}`;
        bc.add(key);
        let cr = cellRoads.get(key);
        if (!cr) cellRoads.set(key, (cr = new Set()));
        cr.add(base);
      }
    }
  }
  const baseDensity = (base: string): number => {
    const cells = baseCells.get(base);
    if (!cells || cells.size === 0) return 0;
    let sum = 0;
    for (const c of cells) sum += cellRoads.get(c)!.size;
    return sum / cells.size;
  };

  interface BaseAgg {
    names: string[];
    lenByTier: Partial<Record<Tier, number>>;
    distLen: Map<string, number>; // district -> summed length, for the corridor hint
    areaLen: Map<string, number>; // reference (MRT/suburb) -> summed length
    totalLen: number;
    lane: boolean;
    nearMrt: boolean;
  }
  const bases = new Map<string, BaseAgg>();
  for (const r of roads) {
    let b = bases.get(r.base);
    if (!b) {
      b = { names: [], lenByTier: {}, distLen: new Map(), areaLen: new Map(), totalLen: 0, lane: !!r.lane, nearMrt: false };
      bases.set(r.base, b);
    }
    b.names.push(r.name);
    b.totalLen += r.length_m;
    b.lenByTier[r.tier] = (b.lenByTier[r.tier] ?? 0) + r.length_m;
    if (r.district) b.distLen.set(r.district, (b.distLen.get(r.district) ?? 0) + r.length_m);
    if (r.area) b.areaLen.set(r.area, (b.areaLen.get(r.area) ?? 0) + r.length_m);
    if (r.near_mrt) b.nearMrt = true;
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
    // Urban = embedded in a dense road grid, or next to an MRT station.
    // Keeps no-MRT urban districts (五股/泰山/林口), drops isolated hill roads.
    const urban = b.nearMrt || baseDensity(base) >= DENSITY_MIN;
    let inMedium = false;
    if (urban) {
      if (dominant !== "hard") {
        // proper district roads (幹道/次要/tertiary)
        if (b.totalLen >= EASY_MIN_M) pools.easy.push(prompt);
        if (b.totalLen >= MEDIUM_MIN_M) inMedium = true;
      } else if (b.totalLen >= MEDIUM_RESID_MIN_M) {
        // long residential roads are usually real arterials OSM mis-tagged
        // (內湖路, 迪化街…); short ones stay in 困難.
        inMedium = true;
      }
      // short central roads next to an MRT station are notable (館前路, 峨眉街)
      if (b.nearMrt && b.totalLen >= MEDIUM_MRT_MIN_M) inMedium = true;
    }
    if (inMedium) pools.medium.push(prompt);
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
  // Prompts bucketed by district; each round picks a district weighted by
  // size^0.5 then a random road in it. The sqrt dampens both extremes:
  // big districts (士林) don't dominate, and tiny rural ones (石門, 1 road)
  // don't get equal airtime to 板橋 (which made 簡單 feel mountain-heavy).
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
    // Weighted pick: P(district) ∝ remaining size^0.5.
    const weights = this.buckets.map((b) => Math.sqrt(b.length));
    let r = Math.random() * weights.reduce((a, w) => a + w, 0);
    let i = 0;
    while (i < weights.length - 1 && (r -= weights[i]) >= 0) i++;
    const bucket = this.buckets[i];
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
