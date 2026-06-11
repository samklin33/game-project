/** DOM-only HUD: prompt card, wrong-tap toast. No map knowledge here. */
export class GameUI {
  private root: HTMLElement;
  private card: HTMLElement;
  private promptEl: HTMLElement;
  private roundEl: HTMLElement;
  private toast: HTMLElement;
  private toastTimer: number | undefined;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="card" id="prompt-card" hidden>
        <div class="round" id="round"></div>
        <div class="ask">找出這條路：</div>
        <div class="prompt" id="prompt"></div>
      </div>
      <div class="toast" id="toast" hidden></div>
    `;
    this.card = this.must("#prompt-card");
    this.promptEl = this.must("#prompt");
    this.roundEl = this.must("#round");
    this.toast = this.must("#toast");
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

  /** Red toast naming the road the player actually hit (1.5s, SPEC §1). */
  flashWrong(actualName: string, ms = 1500): void {
    this.showToast(`❌ 這是「${actualName}」`, "wrong", ms);
  }

  showToast(text: string, kind: "wrong" | "ok" | "info", ms: number): void {
    window.clearTimeout(this.toastTimer);
    this.toast.textContent = text;
    this.toast.className = `toast ${kind}`;
    this.toast.hidden = false;
    this.toastTimer = window.setTimeout(() => (this.toast.hidden = true), ms);
  }
}
