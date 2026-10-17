import type { DragDropEvent } from "@tauri-apps/api/window";

export interface LocalShortcutDraft {
  name: string;
  target: string;
  kind: "local" | "folder";
}

export type ShortcutDropTarget = "awake" | "sleep";

interface DropOptions {
  available: () => boolean;
  scale: () => number;
  hitTest: (x: number, y: number) => ShortcutDropTarget | null;
  feedback: (target: ShortcutDropTarget | null, message?: string) => void;
  inspect: (path: string) => Promise<LocalShortcutDraft>;
  problem: (draft: LocalShortcutDraft) => string | null;
  open: (draft: LocalShortcutDraft, sleeping: boolean) => void;
  notify: (message: string) => void;
}

// Compare Windows paths without treating a shortcut file as its executable.
// Keeping the .lnk itself preserves its arguments and working directory.
export function localEntryIdentity(target: string, kind: string): string | null {
  if (kind !== "local" && kind !== "folder") return null;
  const path = target.trim().replace(/\//g, "\\")
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\+$/, "").toLowerCase();
  return `${kind}:${path}`;
}

export class ShortcutDropController {
  private paths: string[] = [];
  private request = 0;
  private pending = false;
  private disposed = false;

  constructor(private readonly options: DropOptions) {}

  // A later click or keystroke takes priority over a slow filesystem response.
  cancel(): void {
    this.request++;
    this.pending = false;
    this.paths = [];
    this.options.feedback(null);
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  async handle(event: DragDropEvent): Promise<void> {
    if (this.disposed) return;
    if (event.type === "leave") {
      this.paths = [];
      if (!this.pending) this.options.feedback(null);
      return;
    }
    if (this.pending) return;
    if (event.type === "enter") this.paths = event.paths;
    const scale = this.options.scale();
    const x = event.position.x / scale;
    const y = event.position.y / scale;
    const target = this.options.available() && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(scale) && scale > 0
      ? this.options.hitTest(x, y) : null;
    if (event.type !== "drop") {
      this.options.feedback(target, this.paths.length !== 1 ? "一次拖入一个入口"
        : target === "sleep" ? "松手放入睡眠区" : "松手添加入口");
      return;
    }
    this.paths = [];
    this.options.feedback(null);
    if (!target) return;
    if (event.paths.length !== 1) {
      this.options.notify("这次请拖入一个应用、文档或文件夹。");
      return;
    }

    const request = ++this.request;
    this.pending = true;
    this.options.feedback(target, "正在读取入口…");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const draft = await Promise.race([
        this.options.inspect(event.paths[0]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("读取未完成，请重试或使用“浏览…”选择。")), 8_000);
        }),
      ]);
      if (request !== this.request || this.disposed || !this.options.available()) return;
      const problem = this.options.problem(draft);
      if (problem) this.options.notify(problem);
      else this.options.open(draft, target === "sleep");
    } catch (error) {
      if (request === this.request && !this.disposed && this.options.available()) {
        this.options.notify(typeof error === "string" ? error : error instanceof Error ? error.message : "暂时无法读取这个入口。");
      }
    } finally {
      clearTimeout(timeout);
      if (request === this.request) {
        this.pending = false;
        this.options.feedback(null);
      }
    }
  }
}
