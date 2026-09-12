import { Menu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";

export interface TaskDestination { id: string; name: string; archived?: boolean; tasks: unknown[] }

export function taskFromSelection(text: string): string {
  return text.trim().replace(/\s*\r?\n\s*/g, " ");
}

export function taskDestinationError(lists: TaskDestination[], id: string, text: string): string {
  if (!text.trim()) return "请写下一件事。";
  if (text.trim().length > 200) return "请将任务缩短至 200 个字符以内。";
  const list = lists.find((item) => item.id === id && !item.archived);
  if (!list) return "请先创建或恢复一张清单。";
  if (list.tasks.length >= 100) return "这张清单已满，请选择其他清单。";
  return "";
}

/** One selected passage becomes one task; the source page is never edited. */
export class ScratchpadTaskComposer {
  private menu: Promise<Menu> | undefined;
  private selection = "";
  private composing = false;
  private popupOpen = false;
  private pending: Promise<void> | undefined;
  private saveError: unknown;
  private dialog = document.getElementById("scratchpad-task-dialog") as HTMLDialogElement;
  private form = document.getElementById("scratchpad-task-form") as HTMLFormElement;
  private select = document.getElementById("scratchpad-task-list") as HTMLSelectElement;
  private content = document.getElementById("scratchpad-task-content") as HTMLTextAreaElement;
  private error = document.getElementById("scratchpad-task-error") as HTMLElement;
  private save = document.getElementById("scratchpad-task-save") as HTMLButtonElement;
  private close = document.getElementById("scratchpad-task-close") as HTMLButtonElement;

  constructor(input: HTMLTextAreaElement, private lists: () => TaskDestination[],
    private add: (listId: string, content: string) => Promise<void>, private notify: (message: string) => void) {
    input.addEventListener("compositionstart", () => { this.composing = true; });
    input.addEventListener("compositionend", () => { this.composing = false; });
    input.addEventListener("contextmenu", (event) => {
      const selected = input.value.slice(input.selectionStart, input.selectionEnd);
      if (input.disabled || this.composing || !selected.trim()) return;
      event.preventDefault();
      if (this.popupOpen || this.dialog.open) return;
      this.selection = selected;
      const bounds = input.getBoundingClientRect();
      const position = event.clientX || event.clientY
        ? new LogicalPosition(event.clientX, event.clientY)
        : new LogicalPosition(bounds.left + 24, Math.max(24, bounds.top + 24));
      void this.popup(position);
    });
    this.close.addEventListener("click", () => { if (!this.pending) this.dialog.close(); });
    this.dialog.addEventListener("cancel", (event) => { if (this.pending) event.preventDefault(); });
    this.dialog.addEventListener("close", () => input.focus({ preventScroll: true }));
    this.content.addEventListener("input", () => this.validate());
    this.select.addEventListener("change", () => this.validate());
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.pending || this.composing || !this.validate()) return;
      this.saveError = undefined;
      this.save.disabled = this.close.disabled = this.select.disabled = this.content.disabled = true;
      this.save.textContent = "正在加入…";
      this.pending = this.submit().finally(() => {
        this.pending = undefined;
        this.close.disabled = this.select.disabled = this.content.disabled = false;
        this.save.textContent = "加入";
        // Keep any save error visible until the user changes something or retries.
        this.save.disabled = Boolean(taskDestinationError(this.lists(), this.select.value, this.content.value));
      });
    });
  }

  private async popup(position: LogicalPosition): Promise<void> {
    this.popupOpen = true;
    try {
      this.menu ??= Menu.new({ items: [
        { id: "scratchpad-add-task", text: "加入清单…", action: () => { window.setTimeout(() => this.open(), 0); } },
        { item: "Separator" },
        { item: "Cut", text: "剪切" }, { item: "Copy", text: "复制" },
        { item: "Paste", text: "粘贴" }, { item: "SelectAll", text: "全选" },
        { item: "Separator" }, { item: "Undo", text: "撤销" }, { item: "Redo", text: "重做" },
      ] }).catch((error) => { this.menu = undefined; throw error; });
      await (await this.menu).popup(position);
    } catch { this.notify("暂时无法打开菜单，请再试一次。"); }
    finally { this.popupOpen = false; }
  }

  private open(): void {
    if (this.dialog.open || document.querySelector("dialog[open]")) return;
    const lists = this.lists().filter((list) => !list.archived);
    this.select.replaceChildren(...lists.map((list) => {
      const option = new Option(list.name + (list.tasks.length >= 100 ? " · 已满" : ""), list.id);
      option.disabled = list.tasks.length >= 100;
      return option;
    }));
    this.select.value = lists.find((list) => list.tasks.length < 100)?.id ?? "";
    this.content.value = taskFromSelection(this.selection);
    this.validate();
    this.dialog.showModal();
  }

  private validate(): boolean {
    const message = taskDestinationError(this.lists(), this.select.value, this.content.value);
    this.error.textContent = message;
    this.error.hidden = !message;
    this.save.disabled = Boolean(message) || Boolean(this.pending);
    return !message;
  }

  private async submit(): Promise<void> {
    try {
      await this.add(this.select.value, this.content.value.trim());
      this.dialog.close();
    } catch (error) {
      this.saveError = error;
      this.error.textContent = typeof error === "string" ? error : error instanceof Error ? error.message : "未能加入，请再试一次。";
      this.error.hidden = false;
    }
  }

  async flush(): Promise<void> {
    if (!this.pending) return;
    await this.pending;
    if (this.saveError) throw this.saveError;
  }
}
