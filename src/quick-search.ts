import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { DEFAULT_QUICK_SEARCH_SHORTCUT, displaySearchShortcut, recordSearchShortcut } from "./search-interaction";

export class QuickSearchSettings {
  private toggle = document.querySelector<HTMLButtonElement>("#quick-search-toggle")!;
  private input = document.querySelector<HTMLInputElement>("#quick-search-key")!;
  private apply = document.querySelector<HTMLButtonElement>("#quick-search-apply")!;
  private status = document.querySelector<HTMLElement>("#quick-search-status")!;
  private active: string | null = null;
  private candidate = DEFAULT_QUICK_SEARCH_SHORTCUT;
  private saving: Promise<void> | null = null;
  private unlisten?: UnlistenFn;
  private ready = false;
  private error = "";

  constructor(
    private getSetting: () => string | null,
    private saveSetting: (shortcut: string | null) => Promise<void>,
    private summon: () => boolean,
  ) {
    this.toggle.addEventListener("click", () => { void this.save(this.active || this.getSetting() ? null : this.candidate); });
    this.apply.addEventListener("click", () => { void this.save(this.candidate); });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Tab") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        this.candidate = this.active ?? this.getSetting() ?? DEFAULT_QUICK_SEARCH_SHORTCUT;
        this.error = "";
        this.render();
        this.input.blur();
        return;
      }
      if (["Control", "Alt", "Shift", "Meta"].includes(event.key) || event.isComposing || event.repeat) return;
      const shortcut = recordSearchShortcut(event);
      if (!shortcut) { this.error = "请使用 Ctrl + Alt 或 Ctrl + Shift，再加字母、数字或空格。"; }
      else { this.candidate = shortcut; this.error = ""; }
      this.render();
    });
    this.render();
  }

  async initialize(): Promise<void> {
    this.candidate = this.getSetting() ?? DEFAULT_QUICK_SEARCH_SHORTCUT;
    this.unlisten = await listen("serenook://quick-search", () => {
      if (this.saving || document.activeElement === this.input || !this.summon()) {
        void this.finish(false);
      }
    });
    try {
      const configured = this.getSetting();
      await invoke("set_quick_search_shortcut", { shortcut: configured });
      this.active = configured;
    } catch (error) { this.error = String(error); }
    this.ready = true;
    this.render();
  }

  private async save(shortcut: string | null): Promise<void> {
    if (this.saving || !this.ready) return;
    const previous = this.active;
    let registered = false;
    this.saving = (async () => {
      try {
        await invoke("set_quick_search_shortcut", { shortcut });
        registered = true;
        await this.saveSetting(shortcut);
        this.active = shortcut;
        this.error = "";
      } catch (error) {
        this.error = String(error);
        if (registered) {
          try { await invoke("set_quick_search_shortcut", { shortcut: previous }); }
          catch { this.active = shortcut; this.error += " 原快捷键暂未恢复，请重新设置。"; }
        }
      }
    })();
    this.render();
    try { await this.saving; }
    finally { this.saving = null; this.render(); }
  }

  private render(): void {
    const busy = this.saving !== null || !this.ready;
    this.toggle.disabled = busy;
    this.toggle.setAttribute("aria-pressed", String(this.active !== null || this.getSetting() !== null));
    this.input.disabled = busy;
    this.input.value = displaySearchShortcut(this.candidate);
    this.apply.disabled = busy || (!this.active && !this.getSetting()) || this.candidate === this.active;
    this.status.textContent = this.error;
    this.status.hidden = !this.error;
  }

  async finish(returnToPrevious: boolean): Promise<void> {
    await invoke("finish_quick_search", { returnToPrevious });
  }
  async flush(): Promise<void> { await this.saving; }
  dispose(): void { this.unlisten?.(); }
}
