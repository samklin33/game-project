import type { Difficulty } from "./game";

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
    this.showToast(
      `❌ 這是「${actualName}」,差了約 ${dist}(剩 ${attemptsLeft} 次)`,
      "wrong",
      ms,
    );
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
    onPick: (d: Difficulty) => void;
  }): void {
    const buttons = (Object.keys(TIER_LABELS) as Difficulty[])
      .map(
        (t) => `
          <button class="tier" data-tier="${t}">
            <span class="tier-name">${TIER_LABELS[t]}</span>
            <span class="tier-hint">${TIER_HINTS[t]} · 題庫 ${opts.counts[t]} 題</span>
          </button>`,
      )
      .join("");
    this.overlay.innerHTML = `
      <div class="panel">
        <h1 class="logo">找路</h1>
        <p class="tagline">地圖給你路名,你來指出它在哪</p>
        ${buttons}
      </div>
    `;
    this.overlay.hidden = false;
    this.overlay.querySelectorAll<HTMLButtonElement>(".tier").forEach((btn) =>
      btn.addEventListener("click", () => {
        this.overlay.hidden = true;
        opts.onPick(btn.dataset.tier as Difficulty);
      }),
    );
  }

  showSummary(opts: {
    points: number;
    maxPoints: number;
    correct: number;
    total: number;
    bestStreak: number;
    onReplay: () => void;
    onChangeTier: () => void;
  }): void {
    const ratio = opts.points / opts.maxPoints;
    const grade =
      ratio === 1 ? "你就是人肉導航 🧭" :
      ratio >= 0.7 ? "路感很好!" :
      ratio >= 0.4 ? "還行,多走幾趟吧" :
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
