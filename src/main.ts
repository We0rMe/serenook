import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import "./styles.css";

type IconName = "app" | "chat" | "code" | "compass" | "folder" | "document" | "sheet";
type ShortcutKind = "local" | "web";
type ThemePreference = "system" | "light" | "dark";

interface AppShortcut {
  id: string;
  name: string;
  target: string;
  icon: IconName;
  kind: ShortcutKind;
  sleeping: boolean;
}

interface AppSettings {
  signature: string;
  launchOnStartup: boolean;
  hasCompletedWelcome: boolean;
  theme: ThemePreference;
}

const DEFAULT_SIGNATURE = "慢一点，也是在向前。";
const LAUNCH_INTERVAL_MS = 650;
const RUNNING_POLL_INTERVAL_MS = 10_000;
const GREETING_BOUNDARY_HOURS = [6, 11, 14, 18, 24];
const FILE_ICON_SVG = '<svg class="file-icon-glyph" viewBox="0 0 24 24"><path d="M6.75 3.5h7l3.5 3.5v13.5H6.75v-17Z"/><path d="M13.75 3.5V7h3.5"/><path d="M9.25 12h5.5M9.25 15.5h4"/></svg>';
const SHEET_ICON_SVG = '<svg class="file-icon-glyph" viewBox="0 0 24 24"><path d="M6.75 3.5h7l3.5 3.5v13.5H6.75v-17Z"/><path d="M13.75 3.5V7h3.5"/><path class="sheet-grid" d="M9 11h6v6H9zM9 14h6M12 11v6"/></svg>';

const ICONS: Record<string, string> = {
  app: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M20 11.5a7.8 7.8 0 0 1-8 7.5 9.4 9.4 0 0 1-3.5-.7L4 20l1.5-3.7A7.2 7.2 0 0 1 4 12c0-4.1 3.6-7.5 8-7.5s8 3 8 7Z"/><path d="M8.5 11.8h.01M12 11.8h.01M15.5 11.8h.01"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M14 4l-4 16"/></svg>',
  compass: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6.5Z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="m4 20 4.2-1 10.5-10.5a2 2 0 0 0-2.8-2.8L5.4 16.2 4 20Z"/><path d="m14.7 6.9 2.8 2.8"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
  maximize: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24"><path d="m12 3 1.3 3.7L17 8l-3.7 1.3L12 13l-1.3-3.7L7 8l3.7-1.3L12 3ZM18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14ZM5 13l.7 1.8 1.8.7-1.8.7L5 18l-.7-1.8-1.8-.7 1.8-.7L5 13Z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4V8Z"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M19 15.5A8 8 0 0 1 8.5 5 8 8 0 1 0 19 15.5Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
  signature: '<svg viewBox="0 0 24 24"><path d="M4 17c3-6 5-9 7-9 3 0-1 8 2 8 2 0 3-4 5-4 1.5 0 .3 4 2 4"/><path d="M4 20h16"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="m12 4 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/></svg>',
  document: FILE_ICON_SVG,
  sheet: SHEET_ICON_SVG,
  book: '<svg viewBox="0 0 24 24"><path d="M4 5.5c3.2-.8 5.8-.2 8 1.7v12c-2.2-1.9-4.8-2.5-8-1.7v-12Z"/><path d="M20 5.5c-3.2-.8-5.8-.2-8 1.7v12c2.2-1.9 4.8-2.5 8-1.7v-12Z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M14 7l5 5-5 5"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M19 12H5M10 7l-5 5 5 5"/></svg>',
  startup: '<svg viewBox="0 0 24 24"><path d="M12 3v9M8.5 6.2A7.5 7.5 0 1 0 15.5 6"/></svg>',
};

const appWindow = getCurrentWindow();
const mainView = document.querySelector<HTMLElement>("main")!;
const pageTitle = element<HTMLElement>("page-title");
const shortcutGrid = element<HTMLElement>("shortcut-grid");
const emptyState = element<HTMLElement>("empty-state");
const editButton = element<HTMLButtonElement>("edit-button");
const editLabel = editButton.querySelector<HTMLElement>(".edit-label")!;
const launchAllButton = element<HTMLButtonElement>("launch-all-button");
const launchAllLabel = element<HTMLElement>("launch-all-label");
const sleepSection = element<HTMLElement>("sleep-section");
const sleepToggle = element<HTMLButtonElement>("sleep-toggle");
const sleepContent = element<HTMLElement>("sleep-content");
const sleepGrid = element<HTMLElement>("sleep-grid");
const sleepCount = element<HTMLElement>("sleep-count");
const dialog = element<HTMLDialogElement>("shortcut-dialog");
const form = element<HTMLFormElement>("shortcut-form");
const dialogTitle = element<HTMLElement>("dialog-title");
const idInput = element<HTMLInputElement>("shortcut-id");
const nameInput = element<HTMLInputElement>("shortcut-name");
const targetInput = element<HTMLInputElement>("shortcut-target");
const targetLabel = element<HTMLLabelElement>("shortcut-target-label");
const targetRow = element<HTMLElement>("target-row");
const targetHint = element<HTMLElement>("target-hint");
const browseButton = element<HTMLButtonElement>("browse-button");
const sleepButton = element<HTMLButtonElement>("sleep-button");
const sleepButtonLabel = element<HTMLElement>("sleep-button-label");
const deleteButton = element<HTMLButtonElement>("delete-button");
const formError = element<HTMLElement>("form-error");
const toast = element<HTMLElement>("toast");
const settingsButton = element<HTMLButtonElement>("settings-button");
const settingsCloseButton = element<HTMLButtonElement>("settings-close-button");
const settingsBackdrop = element<HTMLElement>("settings-backdrop");
const settingsPanel = element<HTMLElement>("settings-panel");
const signatureSettingButton = element<HTMLButtonElement>("signature-setting-button");
const signatureEditor = element<HTMLElement>("signature-editor");
const signatureForm = element<HTMLFormElement>("signature-form");
const signatureInput = element<HTMLInputElement>("signature-input");
const signatureError = element<HTMLElement>("signature-error");
const signatureText = element<HTMLElement>("signature-text");
const bulkSettingButton = element<HTMLButtonElement>("bulk-setting-button");
const bulkEditor = element<HTMLElement>("bulk-editor");
const sleepAllButton = element<HTMLButtonElement>("sleep-all-button");
const wakeAllButton = element<HTMLButtonElement>("wake-all-button");
const themeSettingButton = element<HTMLButtonElement>("theme-setting-button");
const themeEditor = element<HTMLElement>("theme-editor");
const themeToggle = element<HTMLButtonElement>("theme-toggle");
const guideSettingButton = element<HTMLButtonElement>("guide-setting-button");
const guideView = element<HTMLElement>("guide-view");
const guideBackButton = element<HTMLButtonElement>("guide-back-button");
const startupSettingButton = element<HTMLButtonElement>("startup-setting-button");
const startupEditor = element<HTMLElement>("startup-editor");
const startupToggle = element<HTMLButtonElement>("startup-toggle");
const welcomeBackdrop = element<HTMLElement>("welcome-backdrop");
const welcomeCard = element<HTMLElement>("welcome-card");
const welcomeSkipButton = element<HTMLButtonElement>("welcome-skip-button");
const welcomeReadButton = element<HTMLButtonElement>("welcome-read-button");
const updateDialog = element<HTMLDialogElement>("update-dialog");
const updateVersion = element<HTMLElement>("update-version");
const updateNotes = element<HTMLElement>("update-notes");
const updateStatus = element<HTMLElement>("update-status");
const updateLaterButton = element<HTMLButtonElement>("update-later-button");
const updateInstallButton = element<HTMLButtonElement>("update-install-button");

let shortcuts: AppShortcut[] = [];
let settings: AppSettings = {
  signature: DEFAULT_SIGNATURE,
  launchOnStartup: false,
  hasCompletedWelcome: false,
  theme: "system",
};
const appIcons = new Map<string, string | null>();
const runningTargets = new Set<string>();
let editing = false;
let sleepExpanded = false;
let launchingAll = false;
let newShortcutSleeping = false;
let runningDetectionPending = true;
let runningDetectionInFlight = false;
let runningPollTimer: number | undefined;
let greetingTimer: number | undefined;
let toastTimer: number | undefined;
let welcomeOpen = false;
let availableUpdate: Update | null = null;
let updateCheckStarted = false;

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

function icon(name: string): HTMLSpanElement {
  const holder = document.createElement("span");
  holder.className = "inline-icon";
  holder.setAttribute("aria-hidden", "true");
  holder.innerHTML = ICONS[name] ?? ICONS.app;
  return holder;
}

function hydrateStaticIcons(): void {
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((holder) => {
    holder.innerHTML = ICONS[holder.dataset.icon ?? "app"] ?? ICONS.app;
  });
}

function shortcutKind(shortcut: AppShortcut): ShortcutKind {
  return shortcut.kind === "web" ? "web" : "local";
}

function iconCacheKey(shortcut: AppShortcut): string {
  return shortcutKind(shortcut) === "web" ? "__edge_web_icon__" : shortcut.target;
}

function supportsRunningDetection(shortcut: AppShortcut): boolean {
  return shortcutKind(shortcut) === "local" && /\.exe$/i.test(shortcut.target);
}

function isShortcutRunning(shortcut: AppShortcut): boolean {
  return supportsRunningDetection(shortcut) && runningTargets.has(shortcut.target);
}

function selectedShortcutKind(): ShortcutKind {
  const selected = form.querySelector<HTMLInputElement>('input[name="shortcut-kind"]:checked');
  return selected?.value === "web" ? "web" : "local";
}

function setTargetMode(kind: ShortcutKind, clearTarget = false): void {
  if (clearTarget) targetInput.value = "";
  const isWeb = kind === "web";
  targetInput.readOnly = !isWeb;
  targetInput.placeholder = isWeb ? "https://example.com" : "";
  browseButton.hidden = isWeb;
  targetRow.classList.toggle("is-web", isWeb);
  targetLabel.textContent = isWeb ? "网址" : "程序位置";
  targetHint.textContent = isWeb
    ? "请输入以 http:// 或 https:// 开头的完整网址"
    : "支持应用、快捷方式以及 .txt、.csv、.xlsx 文档";
}

function updateGreeting(now = new Date()): void {
  const weekdayGreetings = [
    "周日好，留一点从容。",
    "新的一周，稳稳开始。",
    "周二好，沿着节奏继续。",
    "周三好，已经走到一周中间。",
    "周四好，再向前一点。",
    "周五快乐！",
    "周六好，做一点想做的事。",
  ];
  const hour = now.getHours();
  const greeting = hour < 6
    ? "夜深了，先照顾好自己。"
    : hour < 11
      ? weekdayGreetings[now.getDay()]
      : hour < 14
        ? "中午好，短暂小憩再行动吧～"
        : hour < 18
          ? "下午好，继续做点什么？"
          : "晚上好，安静地完成一件事。";
  pageTitle.textContent = greeting;
}

function scheduleGreetingUpdate(now = new Date()): void {
  updateGreeting(now);
  window.clearTimeout(greetingTimer);
  const nextBoundary = new Date(now);
  const nextHour = GREETING_BOUNDARY_HOURS.find((hour) => hour > now.getHours()) ?? 24;
  if (nextHour === 24) {
    nextBoundary.setDate(nextBoundary.getDate() + 1);
    nextBoundary.setHours(0, 0, 0, 0);
  } else {
    nextBoundary.setHours(nextHour, 0, 0, 0);
  }
  greetingTimer = window.setTimeout(() => scheduleGreetingUpdate(), nextBoundary.getTime() - now.getTime() + 1_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function inferIcon(name: string, target: string, kind: ShortcutKind): IconName {
  if (kind === "web") return "compass";
  const value = `${name} ${target}`.toLowerCase();
  if (/\.(csv|xlsx)$/i.test(target)) return "sheet";
  if (/\.txt$/i.test(target)) return "document";
  if (/(wechat|微信|qq|telegram|slack|teams)/.test(value)) return "chat";
  if (/(code|studio|idea|pycharm|webstorm|dev)/.test(value)) return "code";
  if (/(chrome|edge|firefox|browser|浏览器)/.test(value)) return "compass";
  if (/(explorer|folder|文件)/.test(value)) return "folder";
  return "app";
}

function fileTypeMarker(shortcut: AppShortcut): "TXT" | "CSV" | "XLSX" | null {
  if (shortcutKind(shortcut) !== "local") return null;
  const extension = shortcut.target.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
  if (extension === "txt") return "TXT";
  if (extension === "csv") return "CSV";
  if (extension === "xlsx") return "XLSX";
  return null;
}

function showToast(message: string, isError = false): void {
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function errorMessage(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "发生了未知错误。";
}

function createShortcutCard(shortcut: AppShortcut): HTMLElement {
  const card = document.createElement("button");
  const kind = shortcutKind(shortcut);
  const fileMarker = fileTypeMarker(shortcut);
  const running = isShortcutRunning(shortcut);
  card.type = "button";
  card.className = `shortcut-card icon-${shortcut.icon}`;
  if (shortcut.sleeping) card.classList.add("sleeping-card");
  if (kind === "web") card.classList.add("online-card");
  if (running) card.classList.add("running-card");
  card.setAttribute(
    "aria-label",
    shortcut.sleeping
      ? `管理睡眠中的 ${shortcut.name}`
      : editing
        ? `编辑 ${shortcut.name}`
        : running
          ? `${shortcut.name} 已在运行`
          : `打开 ${shortcut.name}`,
  );

  const iconHolder = document.createElement("span");
  iconHolder.className = "app-icon";
  const usesBuiltInFileIcon = fileMarker !== null || shortcut.icon === "document" || shortcut.icon === "sheet";
  const iconData = usesBuiltInFileIcon ? null : appIcons.get(iconCacheKey(shortcut));
  if (usesBuiltInFileIcon) {
    iconHolder.classList.add("is-file-icon");
    iconHolder.innerHTML = shortcut.icon === "sheet" || fileMarker === "CSV" || fileMarker === "XLSX"
      ? SHEET_ICON_SVG
      : FILE_ICON_SVG;
  } else if (iconData) {
    const image = document.createElement("img");
    image.className = "app-icon-image";
    image.src = iconData;
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    iconHolder.append(image);
  } else {
    iconHolder.classList.add("is-fallback");
    iconHolder.append(icon(shortcut.icon));
  }

  const name = document.createElement("strong");
  name.className = "shortcut-name";
  name.textContent = shortcut.name;
  card.append(iconHolder, name);

  if (kind === "web") {
    const marker = document.createElement("span");
    marker.className = "online-marker";
    marker.textContent = "WEB";
    marker.setAttribute("aria-hidden", "true");
    card.append(marker);
  }

  if (fileMarker) {
    const marker = document.createElement("span");
    marker.className = "online-marker file-marker";
    marker.textContent = fileMarker;
    marker.setAttribute("aria-hidden", "true");
    card.append(marker);
  }

  if (running) {
    const marker = document.createElement("span");
    marker.className = "online-marker running-marker";
    marker.textContent = "运行中";
    marker.setAttribute("aria-hidden", "true");
    card.append(marker);
  }

  if (shortcut.sleeping || editing) {
    card.classList.add("has-corner");
    const corner = document.createElement("span");
    corner.className = "shortcut-corner";
    corner.append(icon(shortcut.sleeping ? "moon" : "edit"));
    card.append(corner);
  }

  card.addEventListener("click", () => {
    if (shortcut.sleeping || editing) openEditor(shortcut);
    else if (running) showToast(`${shortcut.name} 已在运行`);
    else void launch(shortcut);
  });
  return card;
}

function createAddCard(): HTMLElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "shortcut-card add-card";
  card.setAttribute("aria-label", "添加应用");
  const iconHolder = document.createElement("span");
  iconHolder.className = "app-icon";
  iconHolder.append(icon("plus"));
  const name = document.createElement("strong");
  name.className = "shortcut-name";
  name.textContent = "添加应用";
  const hint = document.createElement("span");
  hint.className = "shortcut-hint";
  hint.textContent = "本地应用或在线网址";
  card.append(iconHolder, name, hint);
  card.addEventListener("click", () => openEditor());
  return card;
}

function render(): void {
  const awake = shortcuts.filter((shortcut) => !shortcut.sleeping);
  const launchable = awake.filter((shortcut) => !isShortcutRunning(shortcut));
  const sleeping = shortcuts.filter((shortcut) => shortcut.sleeping);

  shortcutGrid.replaceChildren(...awake.map(createShortcutCard));
  if (editing) shortcutGrid.append(createAddCard());
  shortcutGrid.hidden = awake.length === 0 && !editing;
  emptyState.hidden = awake.length > 0 || editing;

  sleepGrid.replaceChildren(...sleeping.map(createShortcutCard));
  sleepSection.hidden = sleeping.length === 0;
  sleepContent.classList.toggle("is-open", sleepExpanded);
  sleepContent.setAttribute("aria-hidden", String(!sleepExpanded));
  sleepContent.inert = !sleepExpanded;
  sleepCount.textContent = String(sleeping.length);
  sleepToggle.setAttribute("aria-expanded", String(sleepExpanded));

  document.body.classList.toggle("editing", editing);
  editButton.setAttribute("aria-pressed", String(editing));
  editLabel.textContent = editing ? "完成" : "编辑";
  launchAllButton.hidden = awake.length === 0 || editing;
  launchAllButton.disabled = launchingAll || runningDetectionPending || launchable.length === 0;
  launchAllButton.setAttribute("aria-busy", String(launchingAll || runningDetectionPending));
  launchAllLabel.textContent = runningDetectionPending
    ? "检查中…"
    : launchingAll
      ? "打开中…"
      : launchable.length === 0
        ? "已运行"
        : "全开";
  sleepAllButton.disabled = shortcuts.length === 0 || shortcuts.every((shortcut) => shortcut.sleeping);
  wakeAllButton.disabled = shortcuts.length === 0 || shortcuts.every((shortcut) => !shortcut.sleeping);
  signatureText.textContent = settings.signature;
}

async function persist(): Promise<void> {
  await invoke("save_apps", { shortcuts });
}

async function launch(shortcut: AppShortcut): Promise<void> {
  try {
    await invoke("launch_app", { target: shortcut.target, kind: shortcutKind(shortcut) });
    if (supportsRunningDetection(shortcut)) {
      window.setTimeout(() => void refreshRunningApps(), 800);
    }
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

async function launchAll(): Promise<void> {
  if (launchingAll || runningDetectionPending) return;
  const awake = shortcuts.filter((shortcut) => !shortcut.sleeping && !isShortcutRunning(shortcut));
  if (awake.length === 0) return;
  launchingAll = true;
  render();
  let failed = 0;
  try {
    for (const [index, shortcut] of awake.entries()) {
      try {
        await invoke("launch_app", { target: shortcut.target, kind: shortcutKind(shortcut) });
      } catch {
        failed += 1;
      }
      if (index < awake.length - 1) await delay(LAUNCH_INTERVAL_MS);
    }
  } finally {
    launchingAll = false;
    render();
  }
  if (failed > 0) showToast(`有 ${failed} 个应用未能打开。`, true);
  window.setTimeout(() => void refreshRunningApps(), 800);
}

async function refreshRunningApps(initial = false): Promise<void> {
  if (runningDetectionInFlight) return;
  const targets = shortcuts.filter(supportsRunningDetection).map((shortcut) => shortcut.target);
  if (initial) {
    runningDetectionPending = true;
    render();
  }
  if (targets.length === 0) {
    runningTargets.clear();
    runningDetectionPending = false;
    render();
    return;
  }

  runningDetectionInFlight = true;
  try {
    const running = await invoke<string[]>("detect_running_apps", { targets });
    runningTargets.clear();
    running.forEach((target) => runningTargets.add(target));
  } catch (error) {
    if (initial) showToast(errorMessage(error), true);
  } finally {
    runningDetectionInFlight = false;
    runningDetectionPending = false;
    render();
  }
}

async function hydrateAppIcons(items: AppShortcut[]): Promise<void> {
  const keys = new Set<string>();
  const pending = items.filter((shortcut) => {
    if (shortcut.icon === "document" || shortcut.icon === "sheet") return false;
    const key = iconCacheKey(shortcut);
    if (appIcons.has(key) || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  if (pending.length === 0) return;

  await Promise.all(
    pending.map(async (shortcut) => {
      const key = iconCacheKey(shortcut);
      try {
        const data = await invoke<string | null>("get_app_icon", {
          target: shortcut.target,
          kind: shortcutKind(shortcut),
        });
        appIcons.set(key, data);
      } catch {
        appIcons.set(key, null);
      }
    }),
  );
  render();
}

function openEditor(shortcut?: AppShortcut): void {
  form.reset();
  formError.hidden = true;
  const kind = shortcut ? shortcutKind(shortcut) : "local";
  const kindInput = form.querySelector<HTMLInputElement>(`input[name="shortcut-kind"][value="${kind}"]`);
  if (kindInput) kindInput.checked = true;
  setTargetMode(kind);
  idInput.value = shortcut?.id ?? "";
  nameInput.value = shortcut?.name ?? "";
  targetInput.value = shortcut?.target ?? "";
  dialogTitle.textContent = shortcut ? "修改这个入口" : "添加一个入口";
  sleepButton.hidden = false;
  sleepButton.classList.toggle("is-switch", !shortcut);
  deleteButton.hidden = !shortcut;
  if (shortcut) {
    sleepButton.setAttribute("aria-pressed", "false");
    sleepButtonLabel.textContent = shortcut.sleeping ? "苏醒" : "睡眠";
    sleepButton.classList.toggle("is-wake", shortcut.sleeping);
    sleepButton.classList.remove("is-enabled");
    const iconHolder = sleepButton.querySelector<HTMLElement>("[data-icon]");
    if (iconHolder) iconHolder.innerHTML = ICONS[shortcut.sleeping ? "sun" : "moon"];
  } else {
    newShortcutSleeping = false;
    updateNewShortcutSleepButton();
  }
  dialog.showModal();
  window.setTimeout(() => (shortcut ? nameInput : element<HTMLButtonElement>("browse-button")).focus(), 0);
}

function updateNewShortcutSleepButton(): void {
  sleepButtonLabel.textContent = "睡眠";
  sleepButton.setAttribute("aria-pressed", String(newShortcutSleeping));
  sleepButton.classList.remove("is-wake");
  sleepButton.classList.toggle("is-enabled", newShortcutSleeping);
  const iconHolder = sleepButton.querySelector<HTMLElement>("[data-icon]");
  if (iconHolder) iconHolder.innerHTML = ICONS.moon;
}

function handleSleepButton(): void {
  if (idInput.value) {
    void toggleSleepCurrent();
    return;
  }
  newShortcutSleeping = !newShortcutSleeping;
  updateNewShortcutSleepButton();
}

function closeEditor(): void {
  dialog.close();
  editButton.focus();
}

async function chooseTarget(): Promise<void> {
  if (selectedShortcutKind() !== "local") return;
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "应用与文档", extensions: ["exe", "lnk", "bat", "cmd", "url", "txt", "csv", "xlsx"] }],
  });
  if (typeof selected !== "string") return;

  targetInput.value = selected;
  if (!nameInput.value.trim()) {
    const filename = selected.split(/[\\/]/).pop() ?? "新应用";
    nameInput.value = filename.replace(/\.(exe|lnk|bat|cmd|url|txt|csv|xlsx)$/i, "");
  }
  formError.hidden = true;
}

async function saveFromForm(): Promise<void> {
  const name = nameInput.value.trim();
  const target = targetInput.value.trim();
  const kind = selectedShortcutKind();
  if (!name || !target) {
    formError.textContent = kind === "web" ? "请填写名称和完整网址。" : "请填写名称并选择程序文件。";
    formError.hidden = false;
    return;
  }
  if (kind === "web") {
    try {
      const url = new URL(target);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      formError.textContent = "网址必须以 http:// 或 https:// 开头。";
      formError.hidden = false;
      return;
    }
  }

  const existingIndex = shortcuts.findIndex((shortcut) => shortcut.id === idInput.value);
  const next: AppShortcut = {
    id: existingIndex >= 0 ? shortcuts[existingIndex].id : crypto.randomUUID(),
    name,
    target,
    icon: inferIcon(name, target, kind),
    kind,
    sleeping: existingIndex >= 0 ? shortcuts[existingIndex].sleeping : newShortcutSleeping,
  };

  const previous = shortcuts;
  shortcuts = existingIndex >= 0
    ? shortcuts.map((shortcut, index) => (index === existingIndex ? next : shortcut))
    : [...shortcuts, next];

  try {
    await persist();
    closeEditor();
    render();
    void hydrateAppIcons([next]);
    void refreshRunningApps();
    showToast(existingIndex >= 0 ? `已更新 ${name}` : `已添加 ${name}`);
  } catch (error) {
    shortcuts = previous;
    formError.textContent = errorMessage(error);
    formError.hidden = false;
  }
}

async function toggleSleepCurrent(): Promise<void> {
  const index = shortcuts.findIndex((shortcut) => shortcut.id === idInput.value);
  if (index < 0) return;
  const previous = shortcuts;
  const current = shortcuts[index];
  const sleeping = !current.sleeping;
  shortcuts = shortcuts.map((shortcut, shortcutIndex) =>
    shortcutIndex === index ? { ...shortcut, sleeping } : shortcut,
  );

  try {
    await persist();
    closeEditor();
    render();
    showToast(sleeping ? `${current.name} 已进入睡眠区` : `${current.name} 已苏醒`);
  } catch (error) {
    shortcuts = previous;
    formError.textContent = errorMessage(error);
    formError.hidden = false;
  }
}

async function removeCurrent(): Promise<void> {
  const index = shortcuts.findIndex((shortcut) => shortcut.id === idInput.value);
  if (index < 0) return;
  const removed = shortcuts[index];
  const previous = shortcuts;
  shortcuts = shortcuts.filter((_, shortcutIndex) => shortcutIndex !== index);
  try {
    await persist();
    closeEditor();
    render();
    showToast(`已移除 ${removed.name}`);
  } catch (error) {
    shortcuts = previous;
    formError.textContent = errorMessage(error);
    formError.hidden = false;
  }
}

function openSettings(): void {
  settingsBackdrop.hidden = false;
  settingsPanel.classList.add("is-open");
  settingsPanel.setAttribute("aria-hidden", "false");
  settingsButton.setAttribute("aria-expanded", "true");
  window.setTimeout(() => signatureSettingButton.focus(), 0);
}

function setSettingsEditor(button: HTMLButtonElement, editor: HTMLElement, open: boolean): void {
  editor.classList.toggle("is-open", open);
  editor.setAttribute("aria-hidden", String(!open));
  editor.inert = !open;
  button.setAttribute("aria-expanded", String(open));
}

function closeSettings(): void {
  settingsPanel.classList.remove("is-open");
  settingsPanel.setAttribute("aria-hidden", "true");
  settingsButton.setAttribute("aria-expanded", "false");
  settingsBackdrop.hidden = true;
  setSettingsEditor(signatureSettingButton, signatureEditor, false);
  setSettingsEditor(bulkSettingButton, bulkEditor, false);
  setSettingsEditor(themeSettingButton, themeEditor, false);
  setSettingsEditor(startupSettingButton, startupEditor, false);
  settingsButton.focus();
}

function closeOtherSettingsEditors(except: "signature" | "bulk" | "theme" | "startup"): void {
  if (except !== "signature") setSettingsEditor(signatureSettingButton, signatureEditor, false);
  if (except !== "bulk") setSettingsEditor(bulkSettingButton, bulkEditor, false);
  if (except !== "theme") setSettingsEditor(themeSettingButton, themeEditor, false);
  if (except !== "startup") setSettingsEditor(startupSettingButton, startupEditor, false);
}

function toggleSignatureEditor(): void {
  const opening = !signatureEditor.classList.contains("is-open");
  closeOtherSettingsEditors("signature");
  setSettingsEditor(signatureSettingButton, signatureEditor, opening);
  signatureError.hidden = true;
  if (opening) {
    signatureInput.value = settings.signature;
    window.setTimeout(() => {
      signatureInput.focus();
      signatureInput.select();
    }, 0);
  }
}

function toggleBulkEditor(): void {
  const opening = !bulkEditor.classList.contains("is-open");
  closeOtherSettingsEditors("bulk");
  setSettingsEditor(bulkSettingButton, bulkEditor, opening);
  if (opening) {
    const firstAction = sleepAllButton.disabled ? wakeAllButton : sleepAllButton;
    window.setTimeout(() => firstAction.focus(), 0);
  }
}

function toggleStartupEditor(): void {
  const opening = !startupEditor.classList.contains("is-open");
  closeOtherSettingsEditors("startup");
  setSettingsEditor(startupSettingButton, startupEditor, opening);
  if (opening) window.setTimeout(() => startupToggle.focus(), 0);
}

function toggleThemeEditor(): void {
  const opening = !themeEditor.classList.contains("is-open");
  closeOtherSettingsEditors("theme");
  setSettingsEditor(themeSettingButton, themeEditor, opening);
  if (opening) window.setTimeout(() => themeToggle.focus(), 0);
}

function effectiveTheme(): "light" | "dark" {
  if (settings.theme === "light" || settings.theme === "dark") return settings.theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function renderThemeSetting(): void {
  const theme = effectiveTheme();
  if (settings.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
}

async function toggleTheme(): Promise<void> {
  const previous = settings;
  settings = { ...settings, theme: effectiveTheme() === "dark" ? "light" : "dark" };
  renderThemeSetting();
  themeToggle.disabled = true;
  try {
    await invoke("save_settings", { settings });
    showToast(settings.theme === "dark" ? "已切换至深色模式" : "已切换至浅色模式");
  } catch (error) {
    settings = previous;
    renderThemeSetting();
    showToast(errorMessage(error), true);
  } finally {
    themeToggle.disabled = false;
  }
}

function renderStartupSetting(): void {
  startupToggle.setAttribute("aria-pressed", String(settings.launchOnStartup));
}

async function toggleStartup(): Promise<void> {
  const previous = settings;
  settings = { ...settings, launchOnStartup: !settings.launchOnStartup };
  renderStartupSetting();
  startupToggle.disabled = true;
  try {
    await invoke("save_settings", { settings });
    showToast(settings.launchOnStartup ? "已开启开机自启" : "已关闭开机自启");
  } catch (error) {
    settings = previous;
    renderStartupSetting();
    showToast(errorMessage(error), true);
  } finally {
    startupToggle.disabled = false;
  }
}

function openGuide(): void {
  closeSettings();
  mainView.inert = true;
  settingsButton.disabled = true;
  guideView.inert = false;
  guideView.setAttribute("aria-hidden", "false");
  guideView.classList.remove("is-closing");
  document.body.classList.add("guide-open");
  window.setTimeout(() => {
    guideView.classList.add("is-open");
    guideBackButton.focus();
  }, 20);
}

function closeGuide(): void {
  guideView.classList.add("is-closing");
  guideView.classList.remove("is-open");
  window.setTimeout(() => {
    guideView.classList.remove("is-closing");
    guideView.setAttribute("aria-hidden", "true");
    guideView.inert = true;
    mainView.inert = false;
    settingsButton.disabled = false;
    document.body.classList.remove("guide-open");
    settingsButton.focus();
  }, 820);
}

function completeWelcome(readGuide: boolean): void {
  if (!welcomeOpen) return;
  welcomeOpen = false;
  welcomeCard.classList.remove("is-open");
  window.setTimeout(() => {
    welcomeCard.setAttribute("aria-hidden", "true");
    welcomeCard.inert = true;
    welcomeBackdrop.hidden = true;
    mainView.inert = false;
    settingsButton.disabled = false;
    welcomeSkipButton.disabled = false;
    welcomeReadButton.disabled = false;
    if (readGuide) openGuide();
    else editButton.focus();
  }, 360);
}

async function openWelcomeOnce(): Promise<void> {
  const previous = settings;
  settings = { ...settings, hasCompletedWelcome: true };
  try {
    await invoke("save_settings", { settings });
  } catch (error) {
    settings = previous;
    showToast(errorMessage(error), true);
  }

  welcomeOpen = true;
  welcomeBackdrop.hidden = false;
  welcomeCard.inert = false;
  welcomeCard.setAttribute("aria-hidden", "false");
  mainView.inert = true;
  settingsButton.disabled = true;
  window.setTimeout(() => {
    welcomeCard.classList.add("is-open");
    welcomeReadButton.focus();
  }, 30);
}

async function checkForUpdates(): Promise<void> {
  if (updateCheckStarted) return;
  updateCheckStarted = true;
  try {
    const update = await check({ timeout: 12_000 });
    if (!update) return;
    availableUpdate = update;
    updateVersion.textContent = `Serenook ${update.version}`;
    updateNotes.textContent = update.body?.trim() || "这一版带来了一些安静而细小的改进。";
    updateStatus.textContent = "准备好时，可以在这里完成更新。";
    updateInstallButton.disabled = false;
    updateLaterButton.disabled = false;
    updateDialog.showModal();
  } catch (error) {
    console.info("Update check unavailable", error);
  }
}

function closeUpdateDialog(): void {
  if (updateInstallButton.disabled) return;
  updateDialog.close();
}

async function installAvailableUpdate(): Promise<void> {
  if (!availableUpdate) return;
  updateInstallButton.disabled = true;
  updateLaterButton.disabled = true;
  let downloaded = 0;
  let contentLength = 0;
  try {
    await availableUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength ?? 0;
        updateStatus.textContent = "正在安静地准备更新…";
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (contentLength > 0) {
          const progress = Math.min(100, Math.round((downloaded / contentLength) * 100));
          updateStatus.textContent = `正在下载 ${progress}%`;
        }
      } else if (event.event === "Finished") {
        updateStatus.textContent = "更新已经就绪，正在重新打开 Serenook…";
      }
    });
    await relaunch();
  } catch (error) {
    updateStatus.textContent = `暂时未能完成更新：${errorMessage(error)}`;
    updateInstallButton.disabled = false;
    updateLaterButton.disabled = false;
  }
}

async function setAllSleeping(sleeping: boolean): Promise<void> {
  const changed = shortcuts.some((shortcut) => shortcut.sleeping !== sleeping);
  if (!changed) return;

  const previous = shortcuts;
  shortcuts = shortcuts.map((shortcut) => ({ ...shortcut, sleeping }));
  try {
    await persist();
    sleepExpanded = false;
    closeSettings();
    render();
    showToast(sleeping ? "所有入口已进入睡眠区" : "所有入口已苏醒");
  } catch (error) {
    shortcuts = previous;
    render();
    showToast(errorMessage(error), true);
  }
}

async function saveSignature(): Promise<void> {
  const signature = signatureInput.value.trim();
  if (!signature || [...signature].length > 48) {
    signatureError.textContent = "签名应为 1 到 48 个字符。";
    signatureError.hidden = false;
    return;
  }

  const previous = settings;
  settings = { ...settings, signature };
  signatureText.textContent = signature;
  try {
    await invoke("save_settings", { settings });
    setSettingsEditor(signatureSettingButton, signatureEditor, false);
    showToast("签名已更新");
  } catch (error) {
    settings = previous;
    signatureText.textContent = previous.signature;
    signatureError.textContent = errorMessage(error);
    signatureError.hidden = false;
  }
}

async function initialize(): Promise<void> {
  hydrateStaticIcons();
  scheduleGreetingUpdate();
  const [appsResult, settingsResult] = await Promise.allSettled([
    invoke<AppShortcut[]>("load_apps"),
    invoke<AppSettings>("load_settings"),
  ]);

  if (appsResult.status === "fulfilled") shortcuts = appsResult.value;
  else showToast(errorMessage(appsResult.reason), true);

  if (settingsResult.status === "fulfilled") settings = settingsResult.value;
  else showToast(errorMessage(settingsResult.reason), true);

  render();
  renderStartupSetting();
  renderThemeSetting();
  if (!settings.hasCompletedWelcome) await openWelcomeOnce();
  void hydrateAppIcons(shortcuts);
  await refreshRunningApps(true);
  runningPollTimer = window.setInterval(() => void refreshRunningApps(), RUNNING_POLL_INTERVAL_MS);
  if (!welcomeOpen) window.setTimeout(() => void checkForUpdates(), 4_000);
}

editButton.addEventListener("click", () => {
  editing = !editing;
  render();
});
launchAllButton.addEventListener("click", () => void launchAll());
sleepToggle.addEventListener("click", () => {
  sleepExpanded = !sleepExpanded;
  render();
});
settingsButton.addEventListener("click", openSettings);
settingsCloseButton.addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);
signatureSettingButton.addEventListener("click", toggleSignatureEditor);
bulkSettingButton.addEventListener("click", toggleBulkEditor);
themeSettingButton.addEventListener("click", toggleThemeEditor);
guideSettingButton.addEventListener("click", () => openGuide());
guideBackButton.addEventListener("click", closeGuide);
welcomeSkipButton.addEventListener("click", () => completeWelcome(false));
welcomeReadButton.addEventListener("click", () => completeWelcome(true));
welcomeCard.addEventListener("transitionend", () => {
  if (!welcomeOpen && !updateCheckStarted) window.setTimeout(() => void checkForUpdates(), 1_000);
});
updateLaterButton.addEventListener("click", closeUpdateDialog);
updateInstallButton.addEventListener("click", () => void installAvailableUpdate());
updateDialog.addEventListener("cancel", (event) => {
  if (updateInstallButton.disabled) event.preventDefault();
});
startupSettingButton.addEventListener("click", toggleStartupEditor);
startupToggle.addEventListener("click", () => void toggleStartup());
themeToggle.addEventListener("click", () => void toggleTheme());
sleepAllButton.addEventListener("click", () => void setAllSleeping(true));
wakeAllButton.addEventListener("click", () => void setAllSleeping(false));
element<HTMLButtonElement>("signature-cancel-button").addEventListener("click", toggleSignatureEditor);
signatureForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSignature();
});
element<HTMLButtonElement>("empty-add-button").addEventListener("click", () => openEditor());
browseButton.addEventListener("click", () => void chooseTarget());
form.querySelectorAll<HTMLInputElement>('input[name="shortcut-kind"]').forEach((input) => {
  input.addEventListener("change", () => setTargetMode(selectedShortcutKind(), true));
});
element<HTMLButtonElement>("dialog-close-button").addEventListener("click", closeEditor);
element<HTMLButtonElement>("cancel-button").addEventListener("click", closeEditor);
sleepButton.addEventListener("click", handleSleepButton);
deleteButton.addEventListener("click", () => void removeCurrent());
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveFromForm();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && welcomeOpen) completeWelcome(false);
  else if (event.key === "Escape" && settingsPanel.classList.contains("is-open")) closeSettings();
  else if (event.key === "Escape" && guideView.classList.contains("is-open")) closeGuide();
});
window.addEventListener("focus", () => scheduleGreetingUpdate());
window.addEventListener("beforeunload", () => {
  window.clearInterval(runningPollTimer);
  window.clearTimeout(greetingTimer);
});
element<HTMLButtonElement>("minimize-button").addEventListener("click", () => void appWindow.minimize());
element<HTMLButtonElement>("maximize-button").addEventListener("click", () => void appWindow.toggleMaximize());
element<HTMLButtonElement>("close-button").addEventListener("click", () => void appWindow.close());

void initialize();
