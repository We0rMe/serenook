export const DEFAULT_QUICK_SEARCH_SHORTCUT = "Control+Alt+Space";

type KeyInput = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing" | "keyCode" | "repeat">;

export function recordSearchShortcut(event: KeyInput): string | null {
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.metaKey
    || !event.ctrlKey || (!event.altKey && !event.shiftKey)) return null;
  const key = event.code === "Space" ? "Space"
    : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : null;
  if (!key) return null;
  return ["Control", event.altKey && "Alt", event.shiftKey && "Shift", key].filter(Boolean).join("+");
}

export function displaySearchShortcut(shortcut: string): string {
  return shortcut.replace("Control", "Ctrl").split("+").join(" + ");
}

export function searchNavigationKey(event: Pick<KeyInput, "key" | "isComposing" | "keyCode" | "repeat">): "up" | "down" | "open" | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.key === "ArrowDown") return "down";
  if (event.key === "ArrowUp") return "up";
  if (event.key === "Enter" && !event.repeat) return "open";
  return null;
}

// Every query has one highlighted result, and at most one activation.
export class SearchSelection {
  index = -1;
  private count = 0;
  private committed = false;
  private running = false;

  reset(count: number): void {
    this.count = count;
    this.index = count ? 0 : -1;
    this.committed = false;
  }
  select(index: number): void {
    if (index >= 0 && index < this.count) this.index = index;
  }
  move(step: number): void {
    if (this.count) this.select(Math.max(0, Math.min(this.index + step, this.count - 1)));
  }
  async activate(action: (index: number) => void | Promise<void>): Promise<boolean> {
    if (this.index < 0 || this.committed || this.running) return false;
    this.committed = true;
    this.running = true;
    try { await action(this.index); return true; }
    finally { this.running = false; }
  }
}
