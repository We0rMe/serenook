import { locateText, revealTextareaMatch, textFingerprint } from "./text-location";

interface ScratchpadRecord { content: string }
interface ScratchpadView { fingerprint: string; start: number; end: number; top: number }
type ScratchpadInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** A single native-backed page. Writes are serialized so an older save cannot win. */
export class ScratchpadEditor {
  private loaded = false;
  private saved = "";
  private composing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private view: ScratchpadView | null = null;
  private restoringView = false;
  private viewTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private input: HTMLTextAreaElement,
    private status: HTMLElement,
    private retry: HTMLButtonElement,
    private invoke: ScratchpadInvoke,
  ) {
    input.disabled = true;
    input.addEventListener("input", () => { this.schedule(); this.rememberView(); });
    for (const event of ["select", "keyup", "pointerup", "scroll"]) {
      input.addEventListener(event, () => this.rememberView());
    }
    input.addEventListener("compositionstart", () => {
      this.composing = true;
      clearTimeout(this.timer);
    });
    input.addEventListener("compositionend", () => {
      this.composing = false;
      this.schedule();
    });
    input.addEventListener("blur", () => { void this.flush().catch(() => {}); });
    retry.addEventListener("click", () => {
      void (this.loaded ? this.flush() : this.initialize()).catch(() => {});
    });
  }

  async initialize(): Promise<void> {
    this.retry.hidden = true;
    this.status.textContent = "正在读取…";
    try {
      const page = await this.invoke<ScratchpadRecord>("load_scratchpad");
      this.input.value = this.saved = page.content;
      this.loaded = true;
      this.input.disabled = false;
      try {
        const view = JSON.parse(localStorage.getItem("serenook-scratchpad-view-v1") ?? "null") as ScratchpadView | null;
        if (view && view.fingerprint === textFingerprint(page.content)
          && [view.start, view.end, view.top].every(Number.isFinite)
          && view.start >= 0 && view.end >= view.start && view.end <= page.content.length && view.top >= 0) {
          this.view = view;
        }
      } catch { /* View state is optional and must never block the page. */ }
      this.status.textContent = page.content ? "已保存到本地" : "自动保存到本地";
    } catch {
      // A read failure must never turn into an empty overwrite.
      this.status.textContent = "暂时无法读取，原有内容未改动。";
      this.retry.hidden = false;
    }
  }

  private schedule(): void {
    if (!this.loaded) return;
    clearTimeout(this.timer);
    this.status.textContent = this.input.value === this.saved ? "已保存到本地" : "等待保存…";
    if (!this.composing) {
      this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 650);
    }
  }

  get content(): string { return this.loaded ? this.input.value : ""; }

  restoreView(): void {
    if (!this.view || !this.loaded) return;
    this.restoringView = true;
    this.input.setSelectionRange(this.view.start, this.view.end);
    this.input.scrollTop = this.view.top;
    // Selection restoration does not focus the textarea or move the workspace.
    requestAnimationFrame(() => { this.restoringView = false; });
  }

  reveal(terms: string[]): void {
    const match = locateText(this.content, terms);
    if (!match) return;
    revealTextareaMatch(this.input, match);
    this.rememberView();
  }

  private rememberView(immediate = false): void {
    if (!this.loaded || this.restoringView || this.composing) return;
    // Collapsing a module can emit scroll events while its layout is disappearing.
    if (this.input.closest?.("[inert]")) return;
    clearTimeout(this.viewTimer);
    const record = () => {
      this.view = {
        fingerprint: textFingerprint(this.input.value),
        start: this.input.selectionStart, end: this.input.selectionEnd, top: this.input.scrollTop,
      };
      try { localStorage.setItem("serenook-scratchpad-view-v1", JSON.stringify(this.view)); }
      catch { /* Native content saving remains independent of view-state storage. */ }
    };
    if (immediate) record();
    else this.viewTimer = setTimeout(record, 120);
  }

  async flush(): Promise<void> {
    this.rememberView(true);
    clearTimeout(this.timer);
    if (!this.loaded) return;
    const pending = this.queue.catch(() => {}).then(async () => {
      // Read at execution time, not queue time: keep the latest edit, including an empty page.
      while (this.input.value !== this.saved) {
        const content = this.input.value;
        this.status.textContent = "正在保存…";
        try {
          await this.invoke<void>("save_scratchpad", { page: { content } });
          this.saved = content;
        } catch (error) {
          this.status.textContent = "尚未保存，请重试；文字仍保留在此处。";
          this.retry.hidden = false;
          throw error;
        }
      }
      this.status.textContent = "已保存到本地";
      this.retry.hidden = true;
    });
    this.queue = pending;
    await pending;
  }
}
