import type { Tier } from "./hittest";

export const TIER_LABELS: Record<Tier, string> = {
  easy: "簡單",
  medium: "中等",
  hard: "困難",
};

const TIER_HINTS: Record<Tier, string> = {
  easy: "主要幹道",
  medium: "加上區域道路",
  hard: "巷弄地獄",
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

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="card" id="prompt-card" hidden>
        <div class="round" id="round"></div>
        <div class="ask">找出這條路：</div>
        <div class="prompt" id="prompt"></div>
        <div class="stats"><span id="score"></span><span id="streak"></span></div>
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
  }

  private must(sel: string): HTMLElement {
    const el = this.root.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`missing UI element ${sel}`);
    return el;
  }

  showPrompt(name: string, round: number, total: number): void {
    this.card.hidden = false;
    this.promptEl.textContent = name;
    this.roundEl.textContent = `第 ${round} / ${total} 題`;
  }

  hidePrompt(): void {
    this.card.hidden = true;
  }

  setScore(score: number, streak: number): void {
    this.scoreEl.textContent = `得分 ${score}`;
    this.streakEl.textContent = streak > 1 ? `🔥 連勝 ${streak}` : "";
  }

  /** Red toast naming the road the player actually hit (1.5s, SPEC §1). */
  flashWrong(actualName: string, missesLeft: number, ms = 1500): void {
    this.showToast(`❌ 這是「${actualName}」，再 ${missesLeft} 次就揭曉`, "wrong", ms);
  }

  flashReveal(answer: string, ms = 2500): void {
    this.showToast(`答案是亮起來的「${answer}」`, "info", ms);
  }

  showStart(opts: { counts: Record<Tier, number>; onPick: (tier: Tier) => void }): void {
    const buttons = (Object.keys(TIER_LABELS) as Tier[])
      .map(
        (t) => `
          <button class="tier" data-tier="${t}">
            <span class="tier-name">${TIER_LABELS[t]}</span>
            <span class="tier-hint">${TIER_HINTS[t]} · ${opts.counts[t]} 條路</span>
          </button>`,
      )
      .join("");
    this.overlay.innerHTML = `
      <div class="panel">
        <h1 class="logo">找路</h1>
        <p class="tagline">地圖給你路名，你來指出它在哪</p>
        ${buttons}
      </div>
    `;
    this.overlay.hidden = false;
    this.overlay.querySelectorAll<HTMLButtonElement>(".tier").forEach((btn) =>
      btn.addEventListener("click", () => {
        this.overlay.hidden = true;
        opts.onPick(btn.dataset.tier as Tier);
      }),
    );
  }

  showSummary(opts: {
    score: number;
    total: number;
    bestStreak: number;
    onReplay: () => void;
    onChangeTier: () => void;
  }): void {
    const grade =
      opts.score === opts.total ? "你就是人肉導航 🧭" :
      opts.score >= opts.total * 0.7 ? "路感很好！" :
      opts.score >= opts.total * 0.4 ? "還行，多走幾趟吧" :
      "建議先別關導航 😅";
    this.overlay.innerHTML = `
      <div class="panel">
        <h2>本局結束</h2>
        <div class="big">${opts.score} / ${opts.total}</div>
        <div class="sub">最高連勝 ${opts.bestStreak}</div>
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

  showToast(text: string, kind: "wrong" | "ok" | "info", ms: number): void {
    window.clearTimeout(this.toastTimer);
    this.toast.textContent = text;
    this.toast.className = `toast ${kind}`;
    this.toast.hidden = false;
    this.toastTimer = window.setTimeout(() => (this.toast.hidden = true), ms);
  }
}
