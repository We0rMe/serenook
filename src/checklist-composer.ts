export interface TaskDraft {
  open: boolean;
  content: string;
  important: boolean;
  saving: boolean;
}

// One session draft per checklist, shared by the card and its expanded view.
// This never creates a task until submit is explicitly requested.
export class ChecklistComposer {
  private drafts = new Map<string, TaskDraft>();
  private pending = new Map<string, Promise<boolean>>();
  private tail: Promise<unknown> = Promise.resolve();

  get(id: string): TaskDraft {
    let draft = this.drafts.get(id);
    if (!draft) {
      draft = { open: false, content: "", important: false, saving: false };
      this.drafts.set(id, draft);
    }
    return draft;
  }

  setOpen(id: string, open: boolean): void {
    const draft = this.get(id);
    if (!draft.saving) draft.open = open;
  }

  update(id: string, change: Partial<Pick<TaskDraft, "content" | "important">>): void {
    const draft = this.get(id);
    if (!draft.saving) Object.assign(draft, change);
  }

  submit(id: string, save: (content: string, important: boolean) => Promise<boolean>): Promise<boolean> {
    if (this.pending.has(id)) return this.pending.get(id)!;
    const draft = this.get(id);
    const content = draft.content.trim();
    if (!content) return Promise.resolve(false);
    const important = draft.important;
    draft.saving = true;
    const request = this.tail.then(async () => {
      try {
        const saved = await save(content, important);
        if (saved) {
          draft.content = "";
          draft.important = false;
        }
        return saved;
      } finally {
        draft.saving = false;
        this.pending.delete(id);
      }
    });
    this.pending.set(id, request);
    this.tail = request.catch(() => {});
    return request;
  }

  async flush(): Promise<void> {
    const results = await Promise.all(this.pending.values());
    if (results.some(saved => !saved)) throw new Error("任务尚未保存，请重试后再关闭。");
  }
}
