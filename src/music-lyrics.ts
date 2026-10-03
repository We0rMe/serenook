export interface LyricWord { text: string; at: number; end: number }
export interface LyricLine { at: number; text: string; words?: { text: string; at: number }[] }
export interface Lyrics { plainLyrics?: string | null; syncedLyrics?: string | null; instrumental?: boolean }

export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] ?? 0) / 1000;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)];
    const content = raw.replace(/\[[^\]]*\]/g, "").trim();
    const wordTags = [...content.matchAll(/<(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?>([^<]*)/g)];
    const words = wordTags.map(t => ({ at: Math.max(0, Number(t[1]) * 60 + Number(t[2]) + Number(`0.${t[3] ?? 0}`) - offset), text: t[4] }));
    for (const t of times) {
      const at = Math.max(0, Number(t[1]) * 60 + Number(t[2]) + Number(`0.${t[3] ?? 0}`) - offset);
      const line: LyricLine = { at, text: content.replace(/<\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?>/g, "") };
      if (words.length && times.length === 1 && words.map(w => w.text).join("") === line.text && words[0].at >= at && words.every((w, i) => !i || w.at >= words[i - 1].at)) line.words = words;
      lines.push(line);
    }
  }
  const merged: LyricLine[] = [];
  for (const line of lines.sort((a, b) => a.at - b.at)) {
    const last = merged.at(-1);
    if (last?.at === line.at) { if (line.text && !last.text.split("\n").includes(line.text)) { last.text = [last.text, line.text].filter(Boolean).join("\n"); delete last.words; } }
    else merged.push({ ...line });
  }
  return merged;
}

// Enhanced LRC uses real word timestamps. Ordinary LRC only supports an estimated
// reading sweep between line anchors; never invent the player's playback clock.
export function lyricWords(line: LyricLine, next?: number, duration?: number | null): LyricWord[] {
  const end = Math.max(line.at + .1, Math.min(next ?? duration ?? line.at + 6, line.at + 12));
  if (line.words?.length) return line.words.map((w, i) => ({ ...w, end: Math.max(w.at + .05, line.words![i + 1]?.at ?? end) })).filter(w => w.text);
  const parts = line.text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}]+(?:['’][\p{L}]+)*|[^\p{L}\p{N}\p{M}]+/gu) ?? [];
  const weight = (text: string) => /[\p{L}\p{N}]/u.test(text) ? Math.max(1, Math.sqrt([...text].length)) : .15;
  const total = parts.reduce((sum, text) => sum + weight(text), 0);
  let cursor = line.at;
  return parts.map(text => { const at = cursor; cursor += (end - line.at) * weight(text) / total; return { text, at, end: cursor }; });
}

export function wordProgress(word: LyricWord, position: number): number {
  return Math.max(0, Math.min(1, (position - word.at) / Math.max(.05, word.end - word.at)));
}

export function lyricIndex(lines: LyricLine[], position: number): number {
  let low = 0, high = lines.length;
  while (low < high) { const mid = (low + high) >>> 1; if (lines[mid].at <= position) low = mid + 1; else high = mid; }
  return low - 1;
}
export function musicTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—:—";
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
export function songKey(title: string, artist: string): string {
  return JSON.stringify([title.trim().toLocaleLowerCase(), artist.trim().toLocaleLowerCase()]);
}

// Separate local imports from evictable online results; neither alters workspace records.
export class LyricStore {
  private storageKey = "serenook.music.lyrics.v1";
  private read(): Record<string, { data: Lyrics; local: boolean; saved: number }> {
    try { const value = JSON.parse(localStorage.getItem(this.storageKey) || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  }
  get(key: string): { data: Lyrics; local: boolean } | undefined {
    const value = this.read()[key];
    if (!value?.data || typeof value.local !== "boolean") return;
    if (!value.local && Date.now() - value.saved > 30 * 86400000) return;
    return value;
  }
  put(key: string, data: Lyrics, local: boolean): void {
    const all = this.read();
    if (!local && all[key]?.local) return;
    all[key] = { data, local, saved: Date.now() };
    const online = Object.entries(all).filter(([, v]) => !v.local).sort((a, b) => b[1].saved - a[1].saved);
    for (const [old] of online.slice(80)) delete all[old];
    localStorage.setItem(this.storageKey, JSON.stringify(all));
  }
  remove(key: string): void { const all = this.read(); delete all[key]; localStorage.setItem(this.storageKey, JSON.stringify(all)); }
}
