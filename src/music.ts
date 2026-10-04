import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LyricStore, lyricIndex, lyricWords, wordProgress, musicTime, parseLrc, songKey, type Lyrics, type LyricLine, type LyricWord } from "./music-lyrics";
import "./music.css";

interface MediaSnapshot {
  sources: { id: string; appId: string }[];
  selected: string | null;
  title: string; artist: string; cover: string | null; playing: boolean;
  album: string; duration: number | null; position: number | null; sampledAt: number; rate: number;
  canSeek: boolean; stateKnown: boolean; compatibility: boolean;
  canPlay: boolean; canPause: boolean; canPrevious: boolean; canNext: boolean;
  canShuffle: boolean; canRepeat: boolean; shuffle: boolean | null; repeat: number | null;
}

const shapes = {
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.3 3M4.6 14.9a8 8 0 0 0 13.3 3"/>',
  note: '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
  play: '<path d="m9 5 11 7-11 7Z"/>',
  pause: '<path d="M9 5v14M16 5v14"/>',
  previous: '<path d="M5 5v14m14-14L8 12l11 7Z"/>',
  next: '<path d="M19 5v14M5 5l11 7-11 7Z"/>',
  shuffle: '<path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 3-2 4-4m4-4c1-2 2-4 4-4h3m-4-4 4 4-4 4"/>',
  repeat: '<path d="m16 2 4 4-4 4M4 10V8a2 2 0 0 1 2-2h14M8 22l-4-4 4-4m12 0v2a2 2 0 0 1-2 2H4"/>',
  repeatOne: '<path d="m16 2 4 4-4 4M4 10V8a2 2 0 0 1 2-2h14M8 22l-4-4 4-4m12 0v2a2 2 0 0 1-2 2H4m7-8 2-1v6"/>',
};
function svg(name: keyof typeof shapes): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]}</svg>`;
}
async function mediaRequest<T>(command: string, args: Record<string, unknown>): Promise<T> {
  let timeout = 0;
  try {
    return await Promise.race([invoke<T>(command, args), new Promise<never>((_, reject) => {
      timeout = window.setTimeout(() => reject(new Error("播放器响应超时，请稍后重试。")), 15000);
    })]);
  } finally { window.clearTimeout(timeout); }
}
export function mediaSourceName(id: string): string {
  if (/qqmusic/i.test(id)) return "QQ 音乐";
  if (/cloudmusic|netease/i.test(id)) return "网易云音乐";
  if (/spotify/i.test(id)) return "Spotify";
  if (/msedge/i.test(id)) return "Microsoft Edge";
  if (/chrome/i.test(id)) return "Chrome";
  if (/firefox/i.test(id)) return "Firefox";
  return id.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") || "播放器";
}

export class MusicCompanion {
  private snapshot: MediaSnapshot | null = null;
  private preferred: string | null = null;
  private refreshing = false;
  private busy = false;
  private generation = 0;
  private noticeUntil = 0;
  private select: HTMLSelectElement;
  private title: HTMLElement;
  private artist: HTMLElement;
  private status: HTMLElement;
  private cover: HTMLImageElement;
  private controls: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private lyrics = new LyricStore();
  private track = "";
  private lyricContext = "";
  private lyricGeneration = 0;
  private lines: LyricLine[] = [];
  private lineElements: HTMLElement[] = [];
  private currentLine = -2;
  private position: number | null = null;
  private received = 0;
  private online = true;
  private lyricView: HTMLElement;
  private progress: HTMLInputElement;
  private rematchButton: HTMLButtonElement;
  private forceLyrics = false;
  private rematching = false;
  private words: LyricWord[][] = [];
  private wordElements: HTMLElement[][] = [];
  private seeking = false;
  private minimized = false;
  private retryAt = 0;
  private reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  constructor(private root: HTMLElement, private active: () => boolean) {
    root.classList.add("is-idle");
    root.innerHTML = `<div class="music-atmosphere" aria-hidden="true"></div>
      <div class="music-source-row"><span class="music-state"></span><select aria-label="播放来源"><option value="">自动跟随</option></select>
      <button type="button" class="music-button music-refresh" aria-label="重新匹配歌词" title="重新匹配歌词">${svg("refresh")}</button></div>
      <div class="music-main"><div class="music-info"><div class="music-cover">${svg("note")}<img alt="当前歌曲封面" hidden /></div>
      <h3 class="music-title">打开音乐应用，播放一首歌。</h3><p class="music-artist"></p></div>
      <div class="music-words"><div class="music-lyrics" tabindex="0" aria-label="歌词"></div></div></div>
      <div class="music-footer"><div class="music-timeline"><div class="music-rail"><div class="music-water" aria-hidden="true"><div class="music-water-fill"><i></i><i></i></div></div><input type="range" min="0" max="100" value="0" step="1" aria-label="播放进度" disabled /></div><div class="music-times"><span class="music-elapsed">—:—</span><span class="music-duration">—:—</span></div></div>
      <div class="music-controls" hidden></div></div><p class="music-status" role="status" aria-live="polite"></p>`;
    this.select = root.querySelector("select")!;
    this.title = root.querySelector(".music-title")!;
    this.artist = root.querySelector(".music-artist")!;
    this.status = root.querySelector(".music-status")!;
    this.cover = root.querySelector("img")!;
    this.controls = root.querySelector(".music-controls")!;
    this.lyricView = root.querySelector(".music-lyrics")!;
    this.progress = root.querySelector('input[type="range"]')!;
    this.rematchButton = root.querySelector(".music-refresh")!;
    this.rematchButton.addEventListener("click", () => {
      if (this.rematching) return;
      this.forceLyrics = true; this.rematching = true; this.lyricGeneration++;
      this.rematchButton.disabled = true; this.rematchButton.setAttribute("aria-busy", "true");
      void this.refresh();
    });
    this.progress.addEventListener("input", () => { this.seeking = true; this.tick(); });
    this.progress.addEventListener("change", () => void this.seek(Number(this.progress.value)));
    this.progress.addEventListener("blur", () => { this.seeking = false; });
    this.cover.addEventListener("load", () => this.tintCover());
    this.cover.addEventListener("error", () => { this.cover.hidden = true; });
    for (const [action, label] of [["shuffle", "随机播放"], ["previous", "上一首"], ["toggle", "播放"], ["next", "下一首"], ["repeat", "循环播放"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `music-button${action === "toggle" ? " music-play" : ""}`;
      button.setAttribute("aria-label", label); button.title = label;
      button.innerHTML = svg(action === "toggle" ? "play" : action as keyof typeof shapes);
      button.addEventListener("click", () => void this.control(action));
      this.buttons.set(action, button); this.controls.append(button);
    }
    this.select.addEventListener("change", () => {
      this.preferred = this.select.value || null;
      this.root.classList.add("is-idle");
      this.generation++; this.snapshot = null; this.controls.hidden = true;
      this.position = null; this.progress.disabled = true;
      this.lyricGeneration++; this.track = ""; this.showLyricMessage(""); this.activity();
      this.title.textContent = "正在连接…"; this.artist.textContent = "";
      this.cover.hidden = true; this.status.textContent = "";
      void this.refresh();
    });
    window.setInterval(() => { if (this.active() && !document.hidden && !this.minimized) void this.refresh(); }, 2000);
    const nativeWindow = getCurrentWindow();
    void nativeWindow.onResized(() => {
      void nativeWindow.isMinimized().then(minimized => {
        this.minimized = minimized; this.activity();
        if (!minimized && this.active()) void this.refresh();
      }).catch(() => {});
    });
    document.addEventListener("visibilitychange", () => { this.activity(); if (!document.hidden && this.active()) void this.refresh(); });
    new MutationObserver(() => { this.activity(); if (this.active()) void this.refresh(); })
      .observe(document.getElementById("music-module-content")!, { attributes: true, attributeFilter: ["aria-hidden"] });
    window.setInterval(() => { if ((this.snapshot?.playing || this.seeking) && this.active() && !document.hidden && !this.minimized) this.tick(); }, 40);
    new ResizeObserver(() => this.centerLine(false)).observe(this.lyricView);
    if (this.active()) void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || this.busy) return;
    this.refreshing = true;
    const generation = this.generation;
    try {
      const snapshot = await mediaRequest<MediaSnapshot>("media_snapshot", { preferred: this.preferred });
      if (generation !== this.generation) return;
      // A transient accessibility failure does not change a track's known duration.
      // Position is never retained here: unreliable timing must fall back to static lyrics.
      if (snapshot.duration == null && snapshot.selected === this.snapshot?.selected
        && snapshot.title === this.snapshot?.title && snapshot.artist === this.snapshot?.artist)
        snapshot.duration = this.snapshot?.duration ?? null;
      this.snapshot = snapshot; this.render(snapshot);
    } catch (error) {
      if (generation !== this.generation) return;
      this.snapshot = null; this.controls.hidden = true; this.cover.hidden = true;
      this.position = null; this.progress.disabled = true;
      this.root.classList.add("is-idle");
      this.lyricGeneration++; this.track = ""; this.showLyricMessage(""); this.activity();
      this.title.textContent = "连接暂不可用，稍后自动重试。"; this.artist.textContent = "";
      this.status.textContent = String(error);
      this.root.querySelector(".music-state")!.textContent = "";
      this.finishRematch();
    } finally {
      this.refreshing = false;
      if (generation !== this.generation) void this.refresh();
    }
  }

  private render(s: MediaSnapshot): void {
    this.root.classList.toggle("is-idle", !s.selected);
    if (Date.now() >= this.noticeUntil) this.status.textContent = "";
    const sources = [{ id: "", appId: "自动跟随" }, ...s.sources];
    if (this.preferred && !s.sources.some(source => source.id === this.preferred))
      sources.push({ id: this.preferred, appId: "所选播放器已退出" });
    const sourceKey = JSON.stringify(sources);
    if (this.select.dataset.sources !== sourceKey) {
      this.select.replaceChildren(...sources.map(source => new Option(mediaSourceName(source.appId), source.id)));
      this.select.dataset.sources = sourceKey;
    }
    this.select.value = this.preferred ?? "";
    this.select.hidden = !s.sources.length && !this.preferred;
    this.title.textContent = s.selected ? (s.title || "正在播放的媒体") : this.preferred ? "打开所选播放器，或切换为自动跟随。" : "打开音乐应用，播放一首歌。";
    this.title.title = this.title.textContent;
    this.artist.textContent = s.selected ? s.artist || "" : "";
    this.artist.title = [s.artist, s.album].filter(Boolean).join(" · ");
    const source = s.sources.find(source => source.id === s.selected);
    this.root.querySelector(".music-state")!.textContent = source
      ? mediaSourceName(source.appId) : "";
    (this.root.querySelector(".music-state") as HTMLElement).title = s.compatibility ? "网易云兼容模式 · 封面与播放模式暂未开放" : "";
    if (s.cover && this.cover.getAttribute("src") !== s.cover) { this.cover.src = s.cover; this.cover.hidden = false; }
    if (!s.cover) { this.cover.hidden = true; this.cover.removeAttribute("src"); this.root.style.removeProperty("--music-tint"); }
    const key = s.selected && s.title ? songKey(s.title, s.artist) : "";
    const changed = key !== this.track;
    this.position = s.position ?? null; this.received = performance.now();
    this.progress.max = String(s.duration || 100);
    this.progress.disabled = !s.canSeek || !s.duration || this.busy;
    this.progress.title = "享受此刻";
    this.rematchButton.disabled = this.rematching || this.busy;
    const lyricContext = `${key}|${Math.round(s.duration ?? 0)}|${s.position != null}`;
    if (changed || lyricContext !== this.lyricContext || this.forceLyrics) {
      this.lyricContext = lyricContext;
      this.track = key; this.seeking = false;
      if (changed && !this.reduceMotion.matches) this.root.querySelector(".music-main")!.animate([{ opacity: .3 }, { opacity: 1 }], { duration: 420, easing: "ease-out" });
      const force = this.forceLyrics; this.forceLyrics = false;
      void this.loadLyrics(force);
    } else if (this.retryAt && Date.now() >= this.retryAt) { void this.loadLyrics(); }
    this.activity(); this.tick();
    this.controls.hidden = !s.selected;
    this.buttons.get("previous")!.disabled = this.busy || !s.canPrevious;
    this.buttons.get("next")!.disabled = this.busy || !s.canNext;
    const toggle = this.buttons.get("toggle")!;
    toggle.disabled = this.busy || !(s.playing ? s.canPause : s.canPlay);
    toggle.innerHTML = svg(s.playing ? "pause" : "play");
    toggle.title = s.playing ? "暂停" : "播放"; toggle.setAttribute("aria-label", toggle.title);
    const shuffle = this.buttons.get("shuffle")!;
    shuffle.hidden = !s.canShuffle || s.shuffle === null;
    shuffle.disabled = this.busy;
    shuffle.setAttribute("aria-pressed", String(s.shuffle === true));
    shuffle.title = s.shuffle ? "关闭随机播放" : "开启随机播放";
    shuffle.setAttribute("aria-label", shuffle.title);
    const repeat = this.buttons.get("repeat")!;
    repeat.hidden = !s.canRepeat || s.repeat === null; repeat.disabled = this.busy;
    repeat.setAttribute("aria-pressed", String(s.repeat !== null && s.repeat !== 0));
    repeat.innerHTML = svg(s.repeat === 1 ? "repeatOne" : "repeat");
    repeat.title = s.repeat === 1 ? "单曲循环 · 点击关闭" : s.repeat === 2 ? "列表循环 · 点击切换单曲循环" : "开启列表循环";
    repeat.setAttribute("aria-label", repeat.title);
  }

  private activity(): void {
    this.root.classList.toggle("is-flowing", !!this.snapshot?.playing && this.active() && !document.hidden && !this.minimized);
  }

  private cacheKey(): string { return `v2:${this.track}:${this.snapshot?.album ?? ""}:${Math.round(this.snapshot?.duration ?? 0)}`; }

  private finishRematch(): void {
    this.rematching = false; this.forceLyrics = false;
    this.rematchButton.disabled = this.busy; this.rematchButton.setAttribute("aria-busy", "false");
  }

  private showLyricMessage(message: string): void {
    this.lines = []; this.lineElements = []; this.words = []; this.wordElements = []; this.currentLine = -2;
    this.lyricView.classList.remove("is-synced");
    const p = document.createElement("p"); p.className = "music-lyric-empty"; p.textContent = message;
    this.lyricView.replaceChildren(p); this.lyricView.scrollTop = 0;
  }

  private async loadLyrics(force = false): Promise<void> {
    const generation = ++this.lyricGeneration;
    this.retryAt = 0;
    const current = this.snapshot;
    if (!current?.selected || !current.title) { this.showLyricMessage(""); this.finishRematch(); return; }
    const key = this.track, cacheKey = this.cacheKey();
    const cached = force ? undefined : this.lyrics.get(cacheKey) ?? this.lyrics.get(key);
    if (cached) { this.displayLyrics(cached.data); this.finishRematch(); return; }
    if (!this.online) { this.showLyricMessage("在线歌词已关闭"); return; }
    this.showLyricMessage("正在寻找这首歌的文字…");
    let timeout = 0;
    try {
      const request = invoke<Lyrics | null>("music_lyrics", { title: current.title, artist: current.artist, album: current.album || "", duration: current.duration ?? null });
      const lyrics = await Promise.race([request, new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error("Lyrics timeout")), 16000); })]);
      if (generation !== this.lyricGeneration || key !== this.track) return;
      if (!lyrics) { this.showLyricMessage("暂无匹配歌词"); return; }
      try { this.lyrics.put(cacheKey, lyrics, false); } catch { /* rendering remains available if storage is full */ }
      this.displayLyrics(lyrics);
    } catch {
      if (generation !== this.lyricGeneration) return;
      this.showLyricMessage("暂时无法连接歌词服务，稍后自动重试。");
      this.retryAt = Date.now() + 60000;
    } finally { window.clearTimeout(timeout); if (generation === this.lyricGeneration) this.finishRematch(); }
  }

  private displayLyrics(data: Lyrics): void {
    this.showLyricMessage(data.instrumental ? "纯音乐，让旋律继续。" : "暂无匹配歌词");
    this.lines = typeof data.syncedLyrics === "string" ? parseLrc(data.syncedLyrics).slice(0, 1500) : [];
    const synced = this.lines.length > 0 && this.snapshot?.position != null;
    this.lyricView.classList.toggle("is-synced", synced);
    const texts = this.lines.length ? this.lines.map(line => line.text) : (data.plainLyrics || "").split(/\r?\n/).filter(Boolean).slice(0, 1500);
    if (texts.length) {
      this.lineElements = texts.map((text, i) => {
        const p = document.createElement("p"); p.className = "music-lyric-line";
        if (synced && text) {
          this.words[i] = lyricWords(this.lines[i], this.lines[i + 1]?.at, this.snapshot?.duration);
          this.wordElements[i] = this.words[i].map(word => { const span = document.createElement("span"); span.className = "music-word"; span.textContent = word.text; p.append(span); return span; });
        } else p.textContent = text || "· · ·";
        return p;
      });
      this.lyricView.replaceChildren(...this.lineElements);
    }
    this.tick();
  }

  private tick(): void {
    const s = this.snapshot;
    const elapsed = (performance.now() - this.received) / 1000;
    const position = this.position == null ? null : Math.min(s?.duration ?? Infinity, this.position + (s?.playing ? Math.min(elapsed, 5) * (s.rate || 1) : 0));
    const preview = this.seeking ? Number(this.progress.value) : position;
    this.root.querySelector(".music-elapsed")!.textContent = musicTime(preview);
    this.root.querySelector(".music-duration")!.textContent = musicTime(s?.duration);
    if (!this.seeking) this.progress.value = String(position ?? 0);
    this.progress.setAttribute("aria-valuetext", `${musicTime(preview)} / ${musicTime(s?.duration)}`);
    this.root.style.setProperty("--music-progress", `${s?.duration && preview != null ? Math.max(0, Math.min(100, preview / s.duration * 100)) : 0}%`);
    if (!this.lines.length || position == null || !this.lyricView.classList.contains("is-synced")) return;
    const index = lyricIndex(this.lines, position);
    if (index !== this.currentLine) {
      if (this.currentLine >= 0) this.lineElements[this.currentLine]?.classList.remove("is-current");
      this.currentLine = index;
      if (index >= 0) this.lineElements[index]?.classList.add("is-current");
      this.centerLine(true);
    }
    this.words[index]?.forEach((word, i) => this.wordElements[index][i].style.setProperty("--word-progress", `${wordProgress(word, position) * 100}%`));
  }

  private centerLine(smooth: boolean): void {
    if (!this.lyricView.classList.contains("is-synced")) return;
    const line = this.lineElements[Math.max(0, this.currentLine)];
    if (line) this.lyricView.scrollTo({ top: line.offsetTop - (this.lyricView.clientHeight - line.offsetHeight) / 2, behavior: smooth && !this.reduceMotion.matches ? "smooth" : "instant" });
  }

  private async seek(seconds: number): Promise<void> {
    const current = this.snapshot;
    this.seeking = false;
    if (!current?.selected || !current.canSeek || this.busy) return;
    if (!Number.isFinite(seconds) || !current.duration) return;
    seconds = Math.max(0, Math.min(current.duration, seconds));
    this.busy = true; this.generation++; this.select.disabled = true; this.progress.disabled = true;
    const previous = this.position;
    this.position = seconds; this.received = performance.now(); this.tick();
    try { await mediaRequest("media_seek", { id: current.selected, seconds }); }
    catch (error) { this.position = previous; this.noticeUntil = Date.now() + 6000; this.status.textContent = String(error); }
    finally { this.busy = false; this.select.disabled = false; await this.refresh(); }
  }

  private tintCover(): void {
    try {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 12;
      const context = canvas.getContext("2d"); if (!context) return;
      context.drawImage(this.cover, 0, 0, 12, 12);
      const pixels = context.getImageData(0, 0, 12, 12).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < pixels.length; i += 4) { r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; }
      this.root.style.setProperty("--music-tint", `${Math.round(r / 144)} ${Math.round(g / 144)} ${Math.round(b / 144)}`);
    } catch { this.root.style.removeProperty("--music-tint"); }
  }

  private async control(action: string): Promise<void> {
    const current = this.snapshot;
    if (!current?.selected || this.busy) return;
    this.busy = true; this.generation++; this.status.textContent = "";
    this.select.disabled = true;
    try {
      this.render(current);
      await mediaRequest("media_control", { id: current.selected, action: action === "toggle" ? (current.playing ? "pause" : "play") : action });
    } catch (error) { this.noticeUntil = Date.now() + 6000; this.status.textContent = String(error); }
    finally {
      this.busy = false; this.select.disabled = false;
      if (this.snapshot) this.render(this.snapshot);
      await this.refresh();
    }
  }
}
