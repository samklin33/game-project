import type { Difficulty, SessionOptions } from "./game";

const ROUND_CHOICES = [10, 20, 50];
const ATTEMPT_CHOICES: { label: string; value: number }[] = [
  { label: "3", value: 3 },
  { label: "5", value: 5 },
  { label: "10", value: 10 },
  { label: "∞", value: Infinity },
];

// Grade cutoffs (top / great / ok) scale with difficulty — 20/30 in 極難
// is heroic and deserves better than 「建議先別關導航」.
const GRADE_CUTS: Record<Difficulty, [number, number, number]> = {
  easy: [1, 0.7, 0.4],
  medium: [0.85, 0.55, 0.3],
  hard: [0.6, 0.4, 0.2],
  extreme: [0.4, 0.25, 0.1],
};

export const TIER_LABELS: Record<Difficulty, string> = {
  easy: "簡單",
  medium: "中等",
  hard: "困難",
  extreme: "極難",
};

const TIER_HINTS: Record<Difficulty, string> = {
  easy: "知名大路",
  medium: "所有道路,不含巷弄",
  hard: "分段考驗+知名巷弄",
  extreme: "巷弄地獄,分段考",
};

/** DOM-only HUD: start screen, prompt card, toast, summary. No map knowledge here. */
export class GameUI {
  private root: HTMLElement;
  private card: HTMLElement;
  private promptEl: HTMLElement;
  private roundEl: HTMLElement;
  private scoreEl: HTMLElement;
  private streakEl: HTMLElement;
  private toast: HTMLElement;
  private overlay: HTMLElement;
  private toastTimer: number | undefined;

  onGiveUp: () => void = () => {};
  onQuit: () => void = () => {};

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="card" id="prompt-card" hidden>
        <div class="round" id="round"></div>
        <div class="ask">找出這條路:</div>
        <div class="prompt" id="prompt"></div>
        <div class="stats"><span id="score"></span><span id="streak"></span></div>
        <div class="actions">
          <button id="give-up" class="chip">看答案</button>
          <button id="quit" class="chip">換難度</button>
        </div>
      </div>
      <div class="toast" id="toast" hidden></div>
      <div class="overlay" id="overlay" hidden></div>
    `;
    this.card = this.must("#prompt-card");
    this.promptEl = this.must("#prompt");
    this.roundEl = this.must("#round");
    this.scoreEl = this.must("#score");
    this.streakEl = this.must("#streak");
    this.toast = this.must("#toast");
    this.overlay = this.must("#overlay");
    this.must("#give-up").addEventListener("click", () => this.onGiveUp());
    this.must("#quit").addEventListener("click", () => this.onQuit());
  }

  private must(sel: string): HTMLElement {
    const el = this.root.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`missing UI element ${sel}`);
    return el;
  }

  showPrompt(label: string, round: number, total: number): void {
    this.card.hidden = false;
    this.promptEl.textContent = label;
    this.roundEl.textContent = `第 ${round} / ${total} 題`;
  }

  hidePrompt(): void {
    this.card.hidden = true;
  }

  setScore(points: number, streak: number): void {
    this.scoreEl.textContent = `得分 ${points}`;
    this.streakEl.textContent = streak > 1 ? `🔥 連勝 ${streak}` : "";
  }

  /** Red toast naming the road actually hit + how far off it was. */
  flashWrong(actualName: string, attemptsLeft: number, distM: number, ms = 2000): void {
    const dist =
      distM >= 1000 ? `${(distM / 1000).toFixed(1)} km` : `${Math.round(distM)} m`;
    const tail = Number.isFinite(attemptsLeft) ? `(剩 ${attemptsLeft} 次)` : "";
    this.showToast(`❌ 這是「${actualName}」,差了約 ${dist}${tail}`, "wrong", ms);
  }

  flashReveal(label: string, ms = 3000): void {
    this.showToast(`答案是亮起來的「${label}」`, "info", ms);
  }

  showToast(text: string, kind: "wrong" | "ok" | "info", ms: number): void {
    window.clearTimeout(this.toastTimer);
    this.toast.textContent = text;
    this.toast.className = `toast ${kind}`;
    this.toast.hidden = false;
    this.toastTimer = window.setTimeout(() => (this.toast.hidden = true), ms);
  }

  showStart(opts: {
    counts: Record<Difficulty, number>;
    defaults: SessionOptions;
    onPick: (d: Difficulty, session: SessionOptions) => void;
  }): void {
    const chosen: SessionOptions = { ...opts.defaults };
    const buttons = (Object.keys(TIER_LABELS) as Difficulty[])
      .map(
        (t) => `
          <button class="tier" data-tier="${t}">
            <span class="tier-name">${TIER_LABELS[t]}</span>
            <span class="tier-hint">${TIER_HINTS[t]} · 題庫 ${opts.counts[t]} 題</span>
          </button>`,
      )
      .join("");
    const roundChips = ROUND_CHOICES.map(
      (n) => `<button class="chip opt${n === chosen.rounds ? " sel" : ""}" data-rounds="${n}">${n}</button>`,
    ).join("");
    const attemptChips = ATTEMPT_CHOICES.map(
      (a) =>
        `<button class="chip opt${a.value === chosen.maxAttempts ? " sel" : ""}" data-attempts="${a.value}">${a.label}</button>`,
    ).join("");
    this.overlay.innerHTML = `
      <div class="panel">
        <h1 class="logo">找路</h1>
        <p class="tagline">地圖給你路名,你來指出它在哪</p>
        <div class="opt-row"><span class="opt-label">題數</span>${roundChips}</div>
        <div class="opt-row"><span class="opt-label">每題機會</span>${attemptChips}</div>
        ${buttons}
      </div>
    `;
    this.overlay.hidden = false;
    const select = (btn: HTMLButtonElement) => {
      btn.parentElement!.querySelectorAll(".chip").forEach((c) => c.classList.remove("sel"));
      btn.classList.add("sel");
    };
    this.overlay.querySelectorAll<HTMLButtonElement>("[data-rounds]").forEach((btn) =>
      btn.addEventListener("click", () => {
        chosen.rounds = Number(btn.dataset.rounds);
        select(btn);
      }),
    );
    this.overlay.querySelectorAll<HTMLButtonElement>("[data-attempts]").forEach((btn) =>
      btn.addEventListener("click", () => {
        chosen.maxAttempts = Number(btn.dataset.attempts);
        select(btn);
      }),
    );
    this.overlay.querySelectorAll<HTMLButtonElement>(".tier").forEach((btn) =>
      btn.addEventListener("click", () => {
        this.overlay.hidden = true;
        opts.onPick(btn.dataset.tier as Difficulty, chosen);
      }),
    );
  }

  showSummary(opts: {
    points: number;
    maxPoints: number;
    correct: number;
    total: number;
    bestStreak: number;
    difficulty: Difficulty;
    onReplay: () => void;
    onChangeTier: () => void;
  }): void {
    const ratio = opts.points / opts.maxPoints;
    const [top, great, ok] = GRADE_CUTS[opts.difficulty];
    const harsh = opts.difficulty === "hard" || opts.difficulty === "extreme";
    const grade =
      ratio >= top ? "你就是人肉導航 🧭" :
      ratio >= great ? "路感很好!" :
      ratio >= ok ? "還行,多走幾趟吧" :
      harsh ? "這難度本來就是地獄,正常發揮 🫡" :
      "建議先別關導航 😅";
    this.overlay.innerHTML = `
      <div class="panel">
        <h2>本局結束</h2>
        <div class="big">${opts.points} <span class="dim">/ ${opts.maxPoints} 分</span></div>
        <div class="sub">答對 ${opts.correct} / ${opts.total} 題 · 最高連勝 ${opts.bestStreak}</div>
        <div class="sub grade">${grade}</div>
        <button id="replay">再玩一次</button>
        <button id="change-tier" class="secondary">換難度</button>
      </div>
    `;
    this.overlay.hidden = false;
    this.must("#replay").addEventListener("click", () => {
      this.overlay.hidden = true;
      opts.onReplay();
    });
    this.must("#change-tier").addEventListener("click", () => {
      this.overlay.hidden = true;
      opts.onChangeTier();
    });
  }
}
