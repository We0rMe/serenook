import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { dailyQuote } from "./daily-quotes";
import { holidayForDate, holidayGreeting } from "./holiday-greetings";
import { ScratchpadEditor } from "./scratchpad";
import { ScratchpadTaskComposer, taskDestinationError } from "./scratchpad-task";
import { locateText, textExcerpt } from "./text-location";
import { MusicCompanion } from "./music";
import "./styles.css";
import "./workspace.css";

type IconName = "app" | "chat" | "code" | "compass" | "folder" | "document" | "sheet" | "pdf" | "presentation";
type ShortcutKind = "local" | "web" | "folder" | "app";
type ThemePreference = "system" | "light" | "dark";
type WorkspaceModuleId = "shortcuts" | "checklists" | "diaries" | "scratchpad" | "music";

interface AppShortcut {
  id: string;
  name: string;
  target: string;
  icon: IconName;
  kind: ShortcutKind;
  sleeping: boolean;
  wakeDays?: number[];
}

interface InstalledAppCandidate {
  id: string;
  name: string;
  publisher?: string;
  version?: string;
  target?: string;
  kind?: ShortcutKind;
  source: "desktop" | "store";
}

interface AppSettings {
  launchOnStartup: boolean;
  hasCompletedWelcome: boolean;
  theme: ThemePreference;
  anniversaryDate: string | null;
  anniversaryName: string;
  workspaceOrder: WorkspaceModuleId[];
  collapsedModules: WorkspaceModuleId[];
  hiddenModules: WorkspaceModuleId[];
}

interface ChecklistTask {
  id: string;
  content: string;
  completed: boolean;
  important: boolean;
  shortcutId?: string;
}

interface Checklist {
  id: string;
  name: string;
  archived?: boolean;
  dailyReset: boolean;
  lastResetDate: string | null;
  tasks: ChecklistTask[];
}

interface DiaryEntry {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface DiaryDraft {
  entryId: string | null;
  title: string;
  content: string;
  savedAt: string;
}

interface BackupSummary {
  path: string;
  createdAt: number;
  shortcuts: number;
  checklists: number;
  diaries: number;
  drafts: number;
  scratchpadCharacters: number | null;
}

const DEFAULT_ANNIVERSARY_NAME = "Love";
const MAX_SHORTCUTS = 500;
const MAX_ANNIVERSARY_NAME_LENGTH = 7;
const MAX_CHECKLIST_NAME_LENGTH = 32;
const MAX_TASK_CONTENT_LENGTH = 200;
const MAX_DIARY_TITLE_LENGTH = 80;
const MAX_DIARY_CONTENT_LENGTH = 5_000;
const DIARY_READER_CLOSE_DELAY_MS = 440;
const DIARY_READER_SETTLE_DELAY_MS = 500;
const WORKSPACE_MODULE_IDS: WorkspaceModuleId[] = ["shortcuts", "checklists", "diaries", "scratchpad", "music"];
const LAUNCH_INTERVAL_MS = 650;
const RUNNING_POLL_INTERVAL_MS = 10_000;
const MILLISECONDS_PER_DAY = 86_400_000;
const DIARY_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const DIARY_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const WEEKDAYS = [
  { value: 1, short: "一" },
  { value: 2, short: "二" },
  { value: 3, short: "三" },
  { value: 4, short: "四" },
  { value: 5, short: "五" },
  { value: 6, short: "六" },
  { value: 0, short: "日" },
] as const;
const SPECIAL_ANNIVERSARY_GREETINGS: Record<number, string> = {
  52: "第五十二天，喜欢在寻常里悄悄长成。",
  100: "一百天，时光把心意写成了温柔的篇章。",
  520: "五百二十天，爱意不必喧哗，也一直在。",
  1000: "一千天，漫长的陪伴有了温柔的名字。",
  2000: "两千天，日子走了很远，我们仍在彼此身边。",
  3000: "三千天，岁月深处，仍有初见时的光。",
  4000: "四千天，平凡相伴，已是生活最动人的答案。",
  5200: "五千二百天，爱藏在每一个普通却相守的今天。",
  10000: "一万天，万千日夜，终成一生珍藏的温柔。",
  52000: "五万二千天，时间很长，爱比时间更长。",
};
const GREETING_BOUNDARIES = [
  { hour: 6, minute: 0 },
  { hour: 9, minute: 30 },
  { hour: 11, minute: 30 },
  { hour: 13, minute: 30 },
  { hour: 17, minute: 30 },
  { hour: 20, minute: 30 },
  { hour: 24, minute: 0 },
];
const LOCAL_FILE_EXTENSIONS = [
  "exe", "lnk", "bat", "cmd", "url",
  "txt", "md", "rtf", "pdf", "xps", "doc", "docx", "docm", "odt", "wps",
  "csv", "xls", "xlsx", "xlsm", "ods", "et",
  "ppt", "pptx", "pptm", "odp", "dps",
  "epub", "mobi", "one", "htm", "html",
];
const DOCUMENT_EXTENSIONS = new Set(LOCAL_FILE_EXTENSIONS.slice(5));
const SHEET_EXTENSIONS = new Set(["csv", "xls", "xlsx", "xlsm", "ods", "et"]);
const PRESENTATION_EXTENSIONS = new Set(["ppt", "pptx", "pptm", "odp", "dps"]);
const PDF_EXTENSIONS = new Set(["pdf", "xps"]);
const FILE_ICON_SVG = '<svg class="file-icon-glyph" viewBox="0 0 24 24"><path d="M6.75 3.5h7l3.5 3.5v13.5H6.75v-17Z"/><path d="M13.75 3.5V7h3.5"/><path d="M9.25 12h5.5M9.25 15.5h4"/></svg>';
const SHEET_ICON_SVG = '<svg class="file-icon-glyph" viewBox="0 0 24 24"><path d="M6.75 3.5h7l3.5 3.5v13.5H6.75v-17Z"/><path d="M13.75 3.5V7h3.5"/><path class="sheet-grid" d="M9 11h6v6H9zM9 14h6M12 11v6"/></svg>';
const PDF_ICON_SVG = '<svg class="file-icon-glyph" viewBox="0 0 24 24"><path d="M6.75 3.5h7l3.5 3.5v13.5H6.75v-17Z"/><path d="M13.75 3.5V7h3.5"/><path d="M9 16.5c1.8-2.7 3-5.3 3-7.7 0 3 1.2 5.2 3.2 6.5-2.4-.6-4.5-.3-6.2 1.2Z"/></svg>';
const PRESENTATION_ICON_SVG = '<svg class="file-icon-glyph" viewBox="0 0 24 24"><path d="M5.5 4.5h13v11h-13zM12 15.5v4M9.5 19.5h5"/><path d="M9 8h3v3H9zM12 8a3 3 0 0 1 3 3h-3V8Z"/></svg>';

const ICONS: Record<string, string> = {
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="m10 13 4-4M8.5 15l-1.4 1.4a3.9 3.9 0 0 1-5.5-5.5l4-4a3.9 3.9 0 0 1 5.5 0M15.5 9l1.4-1.4a3.9 3.9 0 0 1 5.5 5.5l-4 4a3.9 3.9 0 0 1-5.5 0" transform="translate(0 -1)"/></svg>',
  archive: '<svg viewBox="0 0 24 24"><path d="M5 8v12h14V8M3.5 4h17v4h-17zM9 12h6"/></svg>',
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
  layers: '<svg viewBox="0 0 24 24"><path d="m12 4 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/></svg>',
  document: FILE_ICON_SVG,
  sheet: SHEET_ICON_SVG,
  pdf: PDF_ICON_SVG,
  presentation: PRESENTATION_ICON_SVG,
  book: '<svg viewBox="0 0 24 24"><path d="M4 5.5c3.2-.8 5.8-.2 8 1.7v12c-2.2-1.9-4.8-2.5-8-1.7v-12Z"/><path d="M20 5.5c-3.2-.8-5.8-.2-8 1.7v12c2.2-1.9 4.8-2.5 8-1.7v-12Z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M14 7l5 5-5 5"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M19 12H5M10 7l-5 5 5 5"/></svg>',
  startup: '<svg viewBox="0 0 24 24"><path d="M12 3v9M8.5 6.2A7.5 7.5 0 1 0 15.5 6"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M8 3.5v4M16 3.5v4M4 9.5h16M8 13h.01M12 13h.01M16 13h.01M8 16.5h.01M12 16.5h.01"/></svg>',
  flower: '<svg viewBox="0 0 24 24"><path d="M12 21v-8M12 17c-3-3-6-3-8-1 2 3 5 4 8 1ZM12 15c3-3 6-3 8-1-2 3-5 4-8 1Z"/><path d="M12 5c1.5-3 5-1.5 4 1.2 3-.6 3.8 3 .9 3.8.4 3-3.3 3.5-4 1-2 2.3-4.8-.1-3.1-2.4-2.8-1.2-1.5-4.7 1.2-4.2.2-2.4 3.7-3.2 4-1Z"/></svg>',
  grip: '<svg class="grip-icon" viewBox="0 0 24 24"><circle cx="8.5" cy="6" r="1.35"/><circle cx="15.5" cy="6" r="1.35"/><circle cx="8.5" cy="12" r="1.35"/><circle cx="15.5" cy="12" r="1.35"/><circle cx="8.5" cy="18" r="1.35"/><circle cx="15.5" cy="18" r="1.35"/></svg>',
  checklist: '<svg viewBox="0 0 24 24"><path d="M9 6h10M9 12h10M9 18h10"/><path d="m4.5 6 1 1 2-2M4.5 12l1 1 2-2M4.5 18l1 1 2-2"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4.5h6V7M7.5 7l.7 13h7.6l.7-13M10 11v5M14 11v5"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3.8 2.45 4.96 5.47.8-3.96 3.85.94 5.44L12 16.28l-4.9 2.57.94-5.44-3.96-3.85 5.47-.8L12 3.8Z"/></svg>',
};

const appWindow = getCurrentWindow();
const mainView = document.querySelector<HTMLElement>("main")!;
const pageTitle = element<HTMLElement>("page-title");
const intro = pageTitle.closest<HTMLElement>(".intro")!;
const workspaceSections = element<HTMLElement>("workspace-sections");
const shortcutsModule = element<HTMLElement>("shortcuts-module");
const shortcutsModuleToggle = element<HTMLButtonElement>("shortcuts-module-toggle");
const shortcutsModuleContent = element<HTMLElement>("shortcuts-module-content");
const checklistsModule = element<HTMLElement>("checklists-module");
const checklistsModuleToggle = element<HTMLButtonElement>("checklists-module-toggle");
const checklistsModuleContent = element<HTMLElement>("checklists-module-content");
const diariesModule = element<HTMLElement>("diaries-module");
const diariesModuleToggle = element<HTMLButtonElement>("diaries-module-toggle");
const diariesModuleContent = element<HTMLElement>("diaries-module-content");
const shortcutGrid = element<HTMLElement>("shortcut-grid");
const emptyState = element<HTMLElement>("empty-state");
const editButton = element<HTMLButtonElement>("edit-button");
const editLabel = editButton.querySelector<HTMLElement>(".edit-label")!;
const launchAllButton = element<HTMLButtonElement>("launch-all-button");
const launchAllLabel = element<HTMLElement>("launch-all-label");
const scheduleButton = element<HTMLButtonElement>("schedule-button");
const scheduleLabel = scheduleButton.querySelector<HTMLElement>(".schedule-label")!;
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
const workspaceSettingButton = element<HTMLButtonElement>("workspace-setting-button");
const workspaceEditor = element<HTMLElement>("workspace-editor");
const workspaceVisibilityButtons = [...workspaceEditor.querySelectorAll<HTMLButtonElement>("[data-workspace-visibility]")];
const dailyQuoteText = element<HTMLElement>("daily-quote");
const anniversarySettingButton = element<HTMLButtonElement>("anniversary-setting-button");
const anniversaryEditor = element<HTMLElement>("anniversary-editor");
const anniversaryForm = element<HTMLFormElement>("anniversary-form");
const anniversaryNameInput = element<HTMLInputElement>("anniversary-name-input");
const anniversaryInput = element<HTMLInputElement>("anniversary-input");
const anniversaryError = element<HTMLElement>("anniversary-error");
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
const scheduleDialog = element<HTMLDialogElement>("schedule-dialog");
const scheduleForm = element<HTMLFormElement>("schedule-form");
const scheduleAppName = element<HTMLElement>("schedule-app-name");
const scheduleRemoveButton = element<HTMLButtonElement>("schedule-remove-button");
const scheduleDayInputs = [...scheduleForm.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const anniversaryPlant = element<HTMLButtonElement>("anniversary-plant");
const footerName = element<SVGTextElement>("footer-name");
const footerNameFlourish = element<SVGPathElement>("footer-name-flourish");
const footerDrawing = element<SVGSVGElement>("footer-drawing");
const checklistGrid = element<HTMLElement>("checklist-grid");
const checklistEmptyState = element<HTMLElement>("checklist-empty-state");
const addChecklistButton = element<HTMLButtonElement>("add-checklist-button");
const emptyChecklistAddButton = element<HTMLButtonElement>("empty-checklist-add-button");
const checklistDialog = element<HTMLDialogElement>("checklist-dialog");
const checklistForm = element<HTMLFormElement>("checklist-form");
const checklistNameInput = element<HTMLInputElement>("checklist-name-input");
const checklistDailyResetInput = element<HTMLInputElement>("checklist-daily-reset-input");
const checklistFormError = element<HTMLElement>("checklist-form-error");
const diaryGrid = element<HTMLElement>("diary-grid");
const diaryEmptyState = element<HTMLElement>("diary-empty-state");
const addDiaryButton = element<HTMLButtonElement>("add-diary-button");
const emptyDiaryAddButton = element<HTMLButtonElement>("empty-diary-add-button");
const diaryDialog = element<HTMLDialogElement>("diary-dialog");
const diaryForm = element<HTMLFormElement>("diary-form");
const diaryDialogTitle = element<HTMLElement>("diary-dialog-title");
const diaryIdInput = element<HTMLInputElement>("diary-id-input");
const diaryTitleInput = element<HTMLInputElement>("diary-title-input");
const diaryContentInput = element<HTMLTextAreaElement>("diary-content-input");
const diaryDialogTimes = element<HTMLElement>("diary-dialog-times");
const diaryFormError = element<HTMLElement>("diary-form-error");
const diaryDeleteButton = element<HTMLButtonElement>("diary-delete-button");
const diarySaveButton = element<HTMLButtonElement>("diary-save-button");
const diaryReaderDialog = element<HTMLDialogElement>("diary-reader-dialog");
const diaryReaderTitle = element<HTMLElement>("diary-reader-title");
const diaryReaderTimes = element<HTMLElement>("diary-reader-times");
const diaryReaderContent = element<HTMLElement>("diary-reader-content");

let shortcuts: AppShortcut[] = [];
let checklists: Checklist[] = [];
let diaries: DiaryEntry[] = [];
let settings: AppSettings = {
  launchOnStartup: false,
  hasCompletedWelcome: false,
  theme: "system",
  anniversaryDate: null,
  anniversaryName: DEFAULT_ANNIVERSARY_NAME,
  workspaceOrder: [...WORKSPACE_MODULE_IDS],
  collapsedModules: [],
  hiddenModules: [],
};
let settingsSaveQueue: Promise<void> = Promise.resolve();
let workspacePreferencesSaving = false;
const appIcons = new Map<string, string | null>();
const runningTargets = new Set<string>();
let editing = false;
let scheduling = false;
let sleepExpanded = false;
let launchingAll = false;
let newShortcutSleeping = false;
let runningDetectionPending = true;
let runningDetectionInFlight = false;
let runningPollTimer: number | undefined;
let greetingTimer: number | undefined;
let dailyQuoteTimer: number | undefined;
let checklistResetTimer: number | undefined;
let toastTimer: number | undefined;
let welcomeOpen = false;
let availableUpdate: Update | null = null;
let updateCheckStarted = false;
let scheduledShortcutId = "";
let footerSignatureTimer: number | undefined;
let plantBloomTimer: number | undefined;
let editingChecklistId: string | null = null;
let diaryReaderReturnTarget: HTMLElement | null = null;
let diaryReaderCloseTimer: number | undefined;
let diaryReaderSettleTimer: number | undefined;
let diaryReaderReveal: (() => void) | undefined;
let drafts: DiaryDraft[] = [];
let draftsLoaded = false;
let draftSaveQueue: Promise<void> = Promise.resolve();
let draftSaveTimer: number | undefined;
let diarySaving = false;
let diaryDraftKey: string | null = null;
let diaryMonth = "";
let readingDiaryId: string | null = null;
let readerOriginDiaryId: string | null = null;
let diaryListScroll = 0;
let focusedChecklistId: string | null = null;
let checklistReturnTarget: HTMLElement | null = null;
let linkingTask: { checklistId: string; taskId: string } | null = null;
const collapsedCompleted = new Set<string>();
let undoTimer: number | undefined;
let updateCheckPending = false;
let selectedBackup: string | null = null;
let restoringBackup = false;
let installedAppCandidates: InstalledAppCandidate[] = [];
const selectedInstalledAppIds = new Set<string>();
let installedAppsLoading = false;
let installedAppsImporting = false;
let installedAppsLoadError = "";
const searchDialog = element<HTMLDialogElement>("search-dialog");
const searchInput = element<HTMLInputElement>("search-input");
const searchResults = element<HTMLElement>("search-results");
const checklistFocusDialog = element<HTMLDialogElement>("checklist-focus-dialog");
const checklistFocusContent = element<HTMLElement>("checklist-focus-content");
const taskLinkDialog = element<HTMLDialogElement>("task-link-dialog");
const backupDialog = element<HTMLDialogElement>("backup-dialog");
const installedAppsSettingButton = element<HTMLButtonElement>("installed-apps-setting-button");
const installedAppsDialog = element<HTMLDialogElement>("installed-apps-dialog");
const installedAppsSearchInput = element<HTMLInputElement>("installed-apps-search-input");
const installedAppsList = element<HTMLElement>("installed-apps-list");
const installedAppsResultCount = element<HTMLElement>("installed-apps-result-count");
const installedAppsStatus = element<HTMLElement>("installed-apps-status");
const installedAppsSelection = element<HTMLElement>("installed-apps-selection");
const installedAppsSelectAll = element<HTMLButtonElement>("installed-apps-select-all");
const installedAppsClear = element<HTMLButtonElement>("installed-apps-clear");
const installedAppsImport = element<HTMLButtonElement>("installed-apps-import");
const diaryMonthSelect = element<HTMLSelectElement>("diary-month-select");
const scratchpadEditor = new ScratchpadEditor(
  element<HTMLTextAreaElement>("scratchpad-input"),
  element<HTMLElement>("scratchpad-status"),
  element<HTMLButtonElement>("scratchpad-retry"),
  invoke,
);
type ReorderLayout = "vertical" | "grid";
const scratchpadTaskComposer = new ScratchpadTaskComposer(
  element<HTMLTextAreaElement>("scratchpad-input"), () => checklists, addScratchpadTask,
  (message) => showToast(message, true),
);

async function addScratchpadTask(listId: string, content: string): Promise<void> {
  await scratchpadEditor.flush();
  const error = taskDestinationError(checklists, listId, content);
  if (error) throw new Error(error);
  const previous = checklists;
  const destination = checklists.find((list) => list.id === listId)!;
  const task: ChecklistTask = { id: crypto.randomUUID(), content, completed: false, important: false };
  checklists = checklists.map((list) => list.id === listId ? { ...list, tasks: [...list.tasks, task] } : list);
  try { await invoke("save_checklists", { checklists }); }
  catch (error) { checklists = previous; throw error; }
  renderChecklists();
  showToast(`已加入「${destination.name}」`);
}

type ReorderPreviewKind = "module" | "shortcut" | "checklist" | "task";

interface LiveReorderState {
  source: HTMLElement;
  handle: HTMLElement;
  container: HTMLElement;
  preview: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  itemSelector: string;
  layout: ReorderLayout;
}

interface ModuleDragState {
  live: LiveReorderState;
  previousOrder: WorkspaceModuleId[];
}

let moduleDragState: ModuleDragState | null = null;

interface ChecklistCardDragState {
  live: LiveReorderState;
  previousOrder: string[];
}

interface ShortcutCardDragState {
  live: LiveReorderState;
  previousOrder: string[];
  sleeping: boolean;
}

interface ChecklistTaskDragState {
  live: LiveReorderState;
  checklistId: string;
  previousOrder: string[];
}

let checklistCardDragState: ChecklistCardDragState | null = null;
let shortcutCardDragState: ShortcutCardDragState | null = null;
let checklistTaskDragState: ChecklistTaskDragState | null = null;

function element<T extends Element>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as unknown as T;
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

function stripDragPreviewSemantics(preview: HTMLElement): void {
  preview.removeAttribute("id");
  preview.setAttribute("aria-hidden", "true");
  preview.querySelectorAll<HTMLElement>("[id]").forEach((element) => element.removeAttribute("id"));
  preview.querySelectorAll<HTMLElement>("button, input, [tabindex]").forEach((element) => {
    element.setAttribute("tabindex", "-1");
  });
}

function hasSameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return expected.size === right.length && left.every((id) => expected.has(id));
}

function hasSameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function beginLiveReorder(
  event: PointerEvent,
  source: HTMLElement,
  handle: HTMLElement,
  container: HTMLElement,
  itemSelector: string,
  layout: ReorderLayout,
  previewKind: ReorderPreviewKind,
  previewSource = source,
): LiveReorderState | null {
  if (
    event.button !== 0
    || moduleDragState
    || checklistCardDragState
    || shortcutCardDragState
    || checklistTaskDragState
  ) return null;
  event.preventDefault();
  event.stopPropagation();

  const bounds = previewSource.getBoundingClientRect();
  const preview = previewSource.cloneNode(true) as HTMLElement;
  stripDragPreviewSemantics(preview);
  preview.classList.add("reorder-preview", `reorder-preview-${previewKind}`);
  preview.style.left = `${bounds.left}px`;
  preview.style.top = `${bounds.top}px`;
  preview.style.width = `${bounds.width}px`;
  preview.style.height = `${bounds.height}px`;
  preview.style.transform = "translate3d(0, 0, 0) scale(1.012)";
  // Keep the live preview above a modal's top layer when editing an expanded list.
  (source.closest("dialog[open]") ?? document.body).append(preview);

  source.classList.add("is-reorder-source");
  handle.classList.add("is-dragging");
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add("is-reordering");
  return {
    source,
    handle,
    container,
    preview,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    itemSelector,
    layout,
  };
}

function animateReorderShift(state: LiveReorderState, move: () => void): void {
  const items = [...state.container.querySelectorAll<HTMLElement>(state.itemSelector)]
    .filter((item) => item !== state.source && !item.hidden);
  items.forEach((item) => item.getAnimations().forEach((animation) => animation.cancel()));
  const before = new Map(items.map((item) => [item, item.getBoundingClientRect()]));
  move();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  for (const item of items) {
    const previous = before.get(item);
    if (!previous) continue;
    const current = item.getBoundingClientRect();
    const deltaX = previous.left - current.left;
    const deltaY = previous.top - current.top;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
    item.animate(
      [
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
        { transform: "translate3d(0, 0, 0)" },
      ],
      { duration: 170, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }
}

function reorderTargetBounds(state: LiveReorderState, item: HTMLElement): DOMRect {
  if (state.itemSelector === ".workspace-module") {
    const heading = item.querySelector<HTMLElement>(".workspace-module-heading");
    if (heading) return heading.getBoundingClientRect();
  }
  return item.getBoundingClientRect();
}

function closestReorderTarget(state: LiveReorderState, clientX: number, clientY: number): HTMLElement | null {
  const direct = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(state.itemSelector);
  if (direct && direct !== state.source && direct.parentElement === state.container) return direct;

  const candidates = [...state.container.querySelectorAll<HTMLElement>(state.itemSelector)]
    .filter((item) => item !== state.source && !item.hidden);
  let nearest: HTMLElement | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const bounds = reorderTargetBounds(state, candidate);
    const deltaX = clientX - (bounds.left + bounds.width / 2);
    const deltaY = clientY - (bounds.top + bounds.height / 2);
    const distance = deltaX * deltaX + deltaY * deltaY;
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function scrollDuringReorder(state: LiveReorderState, clientY: number): void {
  const scrollHost = state.container.closest<HTMLElement>(".checklist-task-frame") ?? mainView;
  const bounds = scrollHost.getBoundingClientRect();
  const edge = Math.min(44, bounds.height * 0.18);
  if (clientY < bounds.top + edge) scrollHost.scrollTop -= 14;
  else if (clientY > bounds.bottom - edge) scrollHost.scrollTop += 14;
}

function moveLiveReorder(event: PointerEvent, state: LiveReorderState): void {
  if (state.pointerId !== event.pointerId) return;
  event.preventDefault();
  const deltaX = event.clientX - state.startX;
  const deltaY = event.clientY - state.startY;
  state.preview.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) scale(1.012)`;
  scrollDuringReorder(state, event.clientY);

  const containerBounds = state.container.getBoundingClientRect();
  if (
    event.clientX < containerBounds.left - 36
    || event.clientX > containerBounds.right + 36
    || event.clientY < containerBounds.top - 36
    || event.clientY > containerBounds.bottom + 36
  ) return;

  const target = closestReorderTarget(state, event.clientX, event.clientY);
  if (!target) return;
  const bounds = reorderTargetBounds(state, target);
  const after = state.layout === "vertical"
    ? event.clientY > bounds.top + bounds.height / 2
    : Math.abs(event.clientY - (bounds.top + bounds.height / 2)) > bounds.height / 2
      ? event.clientY > bounds.top + bounds.height / 2
      : event.clientX > bounds.left + bounds.width / 2;
  const reference = after ? target.nextElementSibling : target;
  if (reference === state.source || state.source.nextElementSibling === reference) return;
  animateReorderShift(state, () => state.container.insertBefore(state.source, reference));
}

function clearLiveReorder(state: LiveReorderState): void {
  state.preview.remove();
  state.source.classList.remove("is-reorder-source");
  state.handle.classList.remove("is-dragging");
  if (state.handle.hasPointerCapture(state.pointerId)) state.handle.releasePointerCapture(state.pointerId);
  document.body.classList.remove("is-reordering");
}

function shortcutKind(shortcut: AppShortcut): ShortcutKind {
  if (shortcut.kind === "web") return "web";
  if (shortcut.kind === "folder") return "folder";
  if (shortcut.kind === "app") return "app";
  return "local";
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
  if (selected?.value === "web") return "web";
  if (selected?.value === "folder") return "folder";
  if (selected?.value === "app") return "app";
  return "local";
}

function setTargetMode(kind: ShortcutKind, clearTarget = false): void {
  if (clearTarget) targetInput.value = "";
  const isWeb = kind === "web";
  const isFolder = kind === "folder";
  const isApp = kind === "app";
  targetInput.readOnly = !isWeb;
  targetInput.placeholder = isWeb ? "https://example.com" : "";
  browseButton.hidden = isWeb || isApp;
  targetRow.classList.toggle("is-web", isWeb || isApp);
  targetLabel.textContent = isWeb ? "网址" : isFolder ? "文件夹位置" : isApp ? "应用标识" : "程序位置";
  targetHint.textContent = isWeb
    ? "请输入以 http:// 或 https:// 开头的网址"
    : isFolder
      ? "选择一个常用文件夹"
      : isApp
        ? "由 Windows 提供的应用入口"
        : "支持常见应用与文档";
}

function isoDateForInput(date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function calendarDateInstant(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900) return null;
  const instant = Date.UTC(year, month - 1, day);
  const parsed = new Date(instant);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? instant
    : null;
}

function anniversaryDayCount(now = new Date()): number | null {
  if (!settings.anniversaryDate) return null;
  const start = calendarDateInstant(settings.anniversaryDate);
  if (start === null) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  if (today < start) return null;
  return Math.floor((today - start) / MILLISECONDS_PER_DAY) + 1;
}

function specialAnniversaryGreeting(now = new Date()): string | null {
  if (settings.anniversaryName.toLowerCase() !== DEFAULT_ANNIVERSARY_NAME.toLowerCase()) return null;
  const days = anniversaryDayCount(now);
  return days === null ? null : SPECIAL_ANNIVERSARY_GREETINGS[days] ?? null;
}

function scheduleSummary(wakeDays: number[] | undefined): string {
  if (wakeDays === undefined) return "未安排";
  if (wakeDays.length === 0) return "保持睡眠";
  if (wakeDays.length === 7) return "每天苏醒";
  return WEEKDAYS
    .filter(({ value }) => wakeDays.includes(value))
    .map(({ short }) => `周${short}`)
    .join(" · ");
}

function applyWeeklySchedules(items: AppShortcut[], weekday: number): AppShortcut[] {
  return items.map((shortcut) => shortcut.wakeDays === undefined
    ? shortcut
    : { ...shortcut, sleeping: !shortcut.wakeDays.includes(weekday) });
}

function setGreeting(message: string): void {
  const length = Array.from(message).length;
  pageTitle.textContent = message;
  intro.classList.toggle("is-long-greeting", length > 14);
  intro.classList.toggle("is-extra-long-greeting", length > 21);
}

function updateGreeting(now = new Date()): void {
  const festivalGreeting = holidayGreeting(now);
  if (festivalGreeting) {
    setGreeting(festivalGreeting);
    return;
  }
  const anniversaryGreeting = specialAnniversaryGreeting(now);
  if (anniversaryGreeting) {
    setGreeting(anniversaryGreeting);
    return;
  }
  const weekdayGreetings = [
    "周日安好，宜感受自然。",
    "新的一周，稳稳开始。",
    "周二好，沿着节奏继续。",
    "周三好，已经走到一周中间。",
    "周四好，再向前一点。",
    "周五快乐！",
    "周六好，做一点想做的事。",
  ];
  const minutes = now.getHours() * 60 + now.getMinutes();
  const greeting = minutes < 6 * 60
    ? "夜深了，让今天轻轻落下。"
    : minutes < 9 * 60 + 30
      ? weekdayGreetings[now.getDay()]
      : minutes < 11 * 60 + 30
        ? "上午好，拾起一件小事。"
        : minutes < 13 * 60 + 30
          ? "中午好，宜小憩~"
          : minutes < 17 * 60 + 30
            ? "下午好，安静地继续。"
            : minutes < 20 * 60 + 30
              ? "傍晚好，把余光留给从容。"
              : "晚上好，做完便好好休息。";
  setGreeting(greeting);
}

function scheduleGreetingUpdate(now = new Date()): void {
  updateGreeting(now);
  window.clearTimeout(greetingTimer);
  const nextBoundary = new Date(now);
  if (holidayForDate(now)) {
    const nextHour = now.getHours() < 12 ? 12 : now.getHours() < 18 ? 18 : 24;
    if (nextHour === 24) {
      nextBoundary.setDate(nextBoundary.getDate() + 1);
      nextBoundary.setHours(0, 0, 0, 0);
    } else {
      nextBoundary.setHours(nextHour, 0, 0, 0);
    }
    greetingTimer = window.setTimeout(
      () => scheduleGreetingUpdate(),
      nextBoundary.getTime() - now.getTime() + 1_000,
    );
    return;
  }
  if (specialAnniversaryGreeting(now)) {
    nextBoundary.setDate(nextBoundary.getDate() + 1);
    nextBoundary.setHours(0, 0, 0, 0);
    greetingTimer = window.setTimeout(
      () => scheduleGreetingUpdate(),
      nextBoundary.getTime() - now.getTime() + 1_000,
    );
    return;
  }
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const next = GREETING_BOUNDARIES.find(({ hour, minute }) => hour * 60 + minute > currentMinutes)
    ?? GREETING_BOUNDARIES[GREETING_BOUNDARIES.length - 1];
  if (next.hour === 24) {
    nextBoundary.setDate(nextBoundary.getDate() + 1);
    nextBoundary.setHours(0, 0, 0, 0);
  } else {
    nextBoundary.setHours(next.hour, next.minute, 0, 0);
  }
  greetingTimer = window.setTimeout(() => scheduleGreetingUpdate(), nextBoundary.getTime() - now.getTime() + 1_000);
}

function scheduleDailyQuoteUpdate(now = new Date()): void {
  dailyQuoteText.textContent = dailyQuote(now);
  window.clearTimeout(dailyQuoteTimer);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  dailyQuoteTimer = window.setTimeout(
    () => scheduleDailyQuoteUpdate(),
    tomorrow.getTime() - now.getTime() + 1_000,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function targetExtension(target: string): string | null {
  return target.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase() ?? null;
}

function fileIconForTarget(target: string): string | null {
  const extension = targetExtension(target);
  if (!extension || !DOCUMENT_EXTENSIONS.has(extension)) return null;
  if (SHEET_EXTENSIONS.has(extension)) return SHEET_ICON_SVG;
  if (PRESENTATION_EXTENSIONS.has(extension)) return PRESENTATION_ICON_SVG;
  if (PDF_EXTENSIONS.has(extension)) return PDF_ICON_SVG;
  return FILE_ICON_SVG;
}

function inferIcon(name: string, target: string, kind: ShortcutKind): IconName {
  if (kind === "web") return "compass";
  if (kind === "folder") return "folder";
  if (kind === "app") return "app";
  const value = `${name} ${target}`.toLowerCase();
  const extension = targetExtension(target);
  if (extension && SHEET_EXTENSIONS.has(extension)) return "sheet";
  if (extension && PRESENTATION_EXTENSIONS.has(extension)) return "presentation";
  if (extension && PDF_EXTENSIONS.has(extension)) return "pdf";
  if (extension && DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (/(wechat|微信|qq|telegram|slack|teams)/.test(value)) return "chat";
  if (/(code|studio|idea|pycharm|webstorm|dev)/.test(value)) return "code";
  if (/(chrome|edge|firefox|browser|浏览器)/.test(value)) return "compass";
  if (/(explorer|folder|文件)/.test(value)) return "folder";
  return "app";
}

function fileTypeMarker(shortcut: AppShortcut): string | null {
  const kind = shortcutKind(shortcut);
  if (kind === "folder") return "DIR";
  if (kind !== "local") return null;
  const extension = targetExtension(shortcut.target);
  return extension && DOCUMENT_EXTENSIONS.has(extension) ? extension.toUpperCase() : null;
}

function showToast(message: string, isError = false): void {
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : error instanceof Error ? error.message : "发生了未知错误。";
}

function offerUndo(message: string, restore: () => Promise<boolean>): void {
  const notice = element<HTMLElement>("undo-notice");
  (checklistFocusDialog.open ? checklistFocusDialog : element<HTMLElement>("app-shell")).append(notice);
  const button = element<HTMLButtonElement>("undo-button");
  window.clearTimeout(undoTimer);
  element<HTMLElement>("undo-message").textContent = message;
  notice.hidden = false;
  button.disabled = false;
  button.onclick = async () => {
    window.clearTimeout(undoTimer);
    button.disabled = true;
    try {
      if (await restore()) { notice.hidden = true; showToast("已恢复"); }
      else button.disabled = false;
    } catch (error) { button.disabled = false; showToast(errorMessage(error), true); }
  };
  undoTimer = window.setTimeout(() => { notice.hidden = true; button.onclick = null; }, 10_000);
}

function rememberDrafts(): void {
  try { localStorage.setItem("serenook-drafts-v1", JSON.stringify(drafts)); }
  catch { /* Native persistence remains available when the webview cache is full. */ }
}

function captureDiaryDraft(): void {
  if (!draftsLoaded || !diaryDialog.open || diarySaving) return;
  const entryId = diaryDraftKey;
  const title = diaryTitleInput.value;
  const content = diaryContentInput.value;
  const original = diaries.find((entry) => entry.id === entryId);
  const previous = drafts.find((draft) => draft.entryId === entryId);
  const needsDraft = Boolean(title || content) && !(original?.title === title && original.content === content);
  if (needsDraft && previous?.title === title && previous.content === content) return;
  drafts = drafts.filter((draft) => draft.entryId !== entryId);
  if (needsDraft) {
    drafts.push({ entryId, title, content, savedAt: new Date().toISOString() });
  }
  rememberDrafts();
  renderDraftNotice();
}

function persistDrafts(): Promise<void> {
  window.clearTimeout(draftSaveTimer);
  if (!draftsLoaded) return Promise.resolve();
  const snapshot = JSON.parse(JSON.stringify(drafts)) as DiaryDraft[];
  const pending = draftSaveQueue.catch(() => {}).then(() => invoke<void>("save_drafts", { drafts: snapshot }));
  draftSaveQueue = pending;
  return pending;
}

function scheduleDraftSave(): void {
  captureDiaryDraft();
  resetDiscardDraftButton();
  element<HTMLElement>("diary-draft-status").textContent = "正在保留草稿…";
  window.clearTimeout(draftSaveTimer);
  draftSaveTimer = window.setTimeout(() => {
    void persistDrafts().then(() => {
      element<HTMLElement>("diary-draft-status").textContent = "草稿已保留";
    }).catch(() => {
      element<HTMLElement>("diary-draft-status").textContent = "草稿尚未写入文件，请稍后重试保存。";
    });
  }, 650);
}

async function flushDiaryDraft(): Promise<void> {
  captureDiaryDraft();
  await persistDrafts();
}

async function flushWorkspaceEdits(): Promise<void> {
  await Promise.all([flushDiaryDraft(), scratchpadEditor.flush(), scratchpadTaskComposer.flush()]);
}

function renderDraftNotice(): void {
  const button = element<HTMLButtonElement>("diary-draft-resume");
  button.hidden = drafts.length === 0;
  button.textContent = drafts.length > 1 ? `继续未写完的一页 · ${drafts.length}` : "继续未写完的一页";
}

async function loadDiaryDrafts(): Promise<void> {
  drafts = await invoke<DiaryDraft[]>("load_drafts");
  try {
    const cached: unknown = JSON.parse(localStorage.getItem("serenook-drafts-v1") ?? "[]");
    if (Array.isArray(cached)) for (const candidate of cached) {
      if (!candidate || !(candidate.entryId === null || typeof candidate.entryId === "string")
        || typeof candidate.title !== "string" || typeof candidate.content !== "string"
        || candidate.title.length > MAX_DIARY_TITLE_LENGTH || candidate.content.length > MAX_DIARY_CONTENT_LENGTH
        || typeof candidate.savedAt !== "string" || Number.isNaN(Date.parse(candidate.savedAt))) continue;
      const saved = drafts.find((draft) => draft.entryId === candidate.entryId);
      if (!saved || saved.savedAt < candidate.savedAt) {
        drafts = [...drafts.filter((draft) => draft.entryId !== candidate.entryId), candidate];
      }
    }
  } catch { /* A damaged cache must never replace the validated native drafts. */ }
  draftsLoaded = true;
  rememberDrafts();
  renderDraftNotice();
}

function isWorkspaceModuleId(value: unknown): value is WorkspaceModuleId {
  return typeof value === "string" && WORKSPACE_MODULE_IDS.includes(value as WorkspaceModuleId);
}

function normalizeWorkspaceOrder(value: unknown): WorkspaceModuleId[] {
  const order: WorkspaceModuleId[] = [];
  if (Array.isArray(value)) {
    for (const module of value) {
      if (isWorkspaceModuleId(module) && !order.includes(module)) order.push(module);
    }
  }
  return [...order, ...WORKSPACE_MODULE_IDS.filter((module) => !order.includes(module))];
}

function normalizeModuleSelection(value: unknown): WorkspaceModuleId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isWorkspaceModuleId))];
}

// Merge each change with the last successful save, not a stale settings snapshot.
function saveSettingsPatch(patch: Partial<AppSettings>): Promise<void> {
  const save = settingsSaveQueue.then(async () => {
    const next = { ...settings, ...patch };
    await invoke("save_settings", { settings: next });
    settings = next;
  });
  settingsSaveQueue = save.catch(() => {});
  return save;
}

function isWorkspaceModuleActive(moduleId: WorkspaceModuleId, preferences = settings): boolean {
  return !preferences.hiddenModules.includes(moduleId) && !preferences.collapsedModules.includes(moduleId);
}

function workspaceModuleElements(moduleId: WorkspaceModuleId): {
  module: HTMLElement;
  toggle: HTMLButtonElement;
  content: HTMLElement;
} {
  if (moduleId === "shortcuts") {
    return { module: shortcutsModule, toggle: shortcutsModuleToggle, content: shortcutsModuleContent };
  }
  if (moduleId === "checklists") {
    return { module: checklistsModule, toggle: checklistsModuleToggle, content: checklistsModuleContent };
  }
  if (moduleId === "scratchpad" || moduleId === "music") {
    return {
      module: element<HTMLElement>(`${moduleId}-module`),
      toggle: element<HTMLButtonElement>(`${moduleId}-module-toggle`),
      content: element<HTMLElement>(`${moduleId}-module-content`),
    };
  }
  return { module: diariesModule, toggle: diariesModuleToggle, content: diariesModuleContent };
}

function applyWorkspaceOrder(): void {
  settings.workspaceOrder.forEach((moduleId, index) => {
    const module = workspaceModuleElements(moduleId).module;
    const current = workspaceSections.children.item(index);
    if (current !== module) workspaceSections.insertBefore(module, current);
  });
}

function renderWorkspaceModules(): void {
  for (const moduleId of WORKSPACE_MODULE_IDS) {
    const { module, toggle, content } = workspaceModuleElements(moduleId);
    const expanded = isWorkspaceModuleActive(moduleId);
    module.hidden = settings.hiddenModules.includes(moduleId);
    module.inert = module.hidden;
    module.classList.toggle("is-collapsed", !expanded);
    toggle.setAttribute("aria-disabled", String(workspacePreferencesSaving));
    toggle.setAttribute("aria-expanded", String(expanded));
    const handle = module.querySelector<HTMLButtonElement>(".module-drag-handle");
    if (handle) handle.setAttribute("aria-disabled", String(workspacePreferencesSaving));
    content.classList.toggle("is-open", expanded);
    content.setAttribute("aria-hidden", String(!expanded));
    content.inert = !expanded;
  }
  workspaceSections.hidden = WORKSPACE_MODULE_IDS.every((id) => settings.hiddenModules.includes(id));
  for (const button of workspaceVisibilityButtons) {
    const moduleId = button.dataset.workspaceVisibility as WorkspaceModuleId;
    button.setAttribute("aria-pressed", String(!settings.hiddenModules.includes(moduleId)));
    button.setAttribute("aria-disabled", String(workspacePreferencesSaving));
  }
}

async function changeWorkspacePreferences(
  patch: Pick<Partial<AppSettings>, "hiddenModules" | "collapsedModules" | "workspaceOrder">,
): Promise<boolean> {
  if (workspacePreferencesSaving || moduleDragState) return false;
  workspacePreferencesSaving = true;
  const scratchpadWasActive = isWorkspaceModuleActive("scratchpad");
  renderWorkspaceModules();
  try {
    if (scratchpadWasActive && !isWorkspaceModuleActive("scratchpad", { ...settings, ...patch })) {
      await scratchpadEditor.flush();
    }
    await saveSettingsPatch(patch);
    if (!scratchpadWasActive && isWorkspaceModuleActive("scratchpad")) {
      requestAnimationFrame(() => scratchpadEditor.restoreView());
    }
    return true;
  } catch (error) {
    showToast(errorMessage(error), true);
    return false;
  } finally {
    workspacePreferencesSaving = false;
    applyWorkspaceOrder();
    renderWorkspaceModules();
  }
}

async function toggleWorkspaceModule(moduleId: WorkspaceModuleId): Promise<void> {
  const collapsed = new Set(settings.collapsedModules);
  if (collapsed.has(moduleId)) collapsed.delete(moduleId);
  else collapsed.add(moduleId);
  await changeWorkspacePreferences({ collapsedModules: [...collapsed] });
}

async function toggleWorkspaceVisibility(moduleId: WorkspaceModuleId): Promise<void> {
  const hidden = new Set(settings.hiddenModules);
  if (hidden.has(moduleId)) hidden.delete(moduleId);
  else hidden.add(moduleId);
  await changeWorkspacePreferences({ hiddenModules: [...hidden] });
}

async function revealWorkspaceModule(moduleId: WorkspaceModuleId): Promise<boolean> {
  if (isWorkspaceModuleActive(moduleId)) return true;
  return changeWorkspacePreferences({
    hiddenModules: settings.hiddenModules.filter((id) => id !== moduleId),
    collapsedModules: settings.collapsedModules.filter((id) => id !== moduleId),
  });
}

function clearModuleDragState(): void {
  const state = moduleDragState;
  if (!state) return;
  clearLiveReorder(state.live);
  moduleDragState = null;
}

function beginModuleDrag(event: PointerEvent): void {
  if (event.button !== 0 || moduleDragState || workspacePreferencesSaving) return;
  const handle = event.currentTarget as HTMLButtonElement;
  const moduleId = handle.dataset.moduleId as WorkspaceModuleId;
  const module = workspaceModuleElements(moduleId).module;
  const heading = module.querySelector<HTMLElement>(".workspace-module-heading") ?? module;
  const live = beginLiveReorder(
    event,
    module,
    handle,
    workspaceSections,
    ".workspace-module",
    "vertical",
    "module",
    heading,
  );
  if (!live) return;
  moduleDragState = {
    live,
    previousOrder: [...workspaceSections.querySelectorAll<HTMLElement>(".workspace-module")]
      .map((item) => item.dataset.moduleId)
      .filter(isWorkspaceModuleId),
  };
}

function moveModuleDrag(event: PointerEvent): void {
  const state = moduleDragState;
  if (!state) return;
  moveLiveReorder(event, state.live);
}

async function finishModuleDrag(event: PointerEvent): Promise<void> {
  const state = moduleDragState;
  if (!state || state.live.pointerId !== event.pointerId) return;

  const visibleOrder = [...workspaceSections.querySelectorAll<HTMLElement>(".workspace-module")]
    .filter((module) => !module.hidden)
    .map((module) => module.dataset.moduleId)
    .filter(isWorkspaceModuleId);
  clearModuleDragState();
  const previousVisibleOrder = state.previousOrder.filter((id) => !settings.hiddenModules.includes(id));
  if (!hasSameIds(visibleOrder, previousVisibleOrder)) {
    applyWorkspaceOrder();
    showToast("未能完成排序，请再试一次。", true);
    return;
  }
  if (hasSameOrder(visibleOrder, previousVisibleOrder)) {
    applyWorkspaceOrder();
    return;
  }
  // Hidden modules keep their slots while visible modules exchange places.
  let visibleIndex = 0;
  const workspaceOrder = state.previousOrder.map((id) => settings.hiddenModules.includes(id) ? id : visibleOrder[visibleIndex++]);
  await changeWorkspacePreferences({ workspaceOrder });
}

function cancelModuleDrag(event: PointerEvent): void {
  const state = moduleDragState;
  if (!state || state.live.pointerId !== event.pointerId) return;
  clearModuleDragState();
  applyWorkspaceOrder();
}

function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function applyDailyChecklistResets(now = new Date()): boolean {
  const today = localDateKey(now);
  let changed = false;
  checklists = checklists.map((checklist) => {
    if (checklist.archived || !checklist.dailyReset || checklist.lastResetDate === today) return checklist;
    changed = true;
    return {
      ...checklist,
      lastResetDate: today,
      tasks: checklist.tasks.map((task) => task.completed ? { ...task, completed: false } : task),
    };
  });
  return changed;
}

async function persistChecklistChanges(previous: Checklist[], successMessage?: string): Promise<boolean> {
  try {
    await invoke("save_checklists", { checklists });
    if (successMessage) showToast(successMessage);
    return true;
  } catch (error) {
    checklists = previous;
    renderChecklists();
    showToast(errorMessage(error), true);
    return false;
  }
}

function scheduleChecklistReset(now = new Date()): void {
  window.clearTimeout(checklistResetTimer);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 1, 0);
  checklistResetTimer = window.setTimeout(() => void refreshDailyChecklists(), tomorrow.getTime() - now.getTime());
}

async function refreshDailyChecklists(now = new Date()): Promise<void> {
  const previous = checklists;
  if (applyDailyChecklistResets(now)) {
    renderChecklists();
    await persistChecklistChanges(previous);
  }
  scheduleChecklistReset(now);
}

function openChecklistDialog(): void {
  checklistForm.reset();
  checklistFormError.hidden = true;
  checklistDialog.showModal();
  window.setTimeout(() => checklistNameInput.focus(), 0);
}

function closeChecklistDialog(): void {
  checklistDialog.close();
  addChecklistButton.focus();
}

async function addChecklistFromForm(): Promise<void> {
  const name = checklistNameInput.value.trim();
  if (!name) {
    checklistFormError.textContent = "请为这张清单写一个名称。";
    checklistFormError.hidden = false;
    return;
  }

  const previous = checklists;
  const dailyReset = checklistDailyResetInput.checked;
  const checklist: Checklist = {
    id: crypto.randomUUID(),
    name,
    dailyReset,
    lastResetDate: dailyReset ? localDateKey() : null,
    tasks: [],
  };
  checklists = [...checklists, checklist];
  renderChecklists();
  try {
    await invoke("save_checklists", { checklists });
    closeChecklistDialog();
    showToast(`已添加清单「${name}」`);
  } catch (error) {
    checklists = previous;
    renderChecklists();
    checklistFormError.textContent = errorMessage(error);
    checklistFormError.hidden = false;
  }
}

async function renameChecklist(checklistId: string, name: string, input: HTMLInputElement): Promise<void> {
  const trimmed = name.trim();
  const current = checklists.find((checklist) => checklist.id === checklistId);
  if (!current) return;
  if (!trimmed) {
    input.value = current.name;
    showToast("清单名称不能为空。", true);
    return;
  }
  if (trimmed === current.name) return;

  const previous = checklists;
  checklists = checklists.map((checklist) =>
    checklist.id === checklistId ? { ...checklist, name: trimmed } : checklist);
  input.value = trimmed;
  await persistChecklistChanges(previous);
}

async function toggleChecklistDailyReset(checklistId: string): Promise<void> {
  const previous = checklists;
  const today = localDateKey();
  checklists = checklists.map((checklist) => checklist.id === checklistId
    ? {
        ...checklist,
        dailyReset: !checklist.dailyReset,
        lastResetDate: checklist.dailyReset ? null : today,
      }
    : checklist);
  renderChecklists();
  await persistChecklistChanges(previous);
}

async function addChecklistTask(
  checklistId: string,
  input: HTMLInputElement,
  importantButton: HTMLButtonElement,
): Promise<void> {
  const content = input.value.trim();
  if (!content) return;
  const important = importantButton.getAttribute("aria-pressed") === "true";
  const previous = checklists;
  checklists = checklists.map((checklist) => checklist.id === checklistId
    ? { ...checklist, tasks: [...checklist.tasks, { id: crypto.randomUUID(), content, completed: false, important }] }
    : checklist);
  renderChecklists();
  if (await persistChecklistChanges(previous)) {
    window.setTimeout(() => activeChecklistRoot().querySelector<HTMLInputElement>(`[data-task-input="${checklistId}"]`)?.focus(), 0);
  }
}

async function renameChecklistTask(
  checklistId: string,
  taskId: string,
  content: string,
  input: HTMLInputElement,
): Promise<void> {
  const checklist = checklists.find((item) => item.id === checklistId);
  const task = checklist?.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const trimmed = content.trim();
  if (!trimmed) {
    input.value = task.content;
    showToast("任务内容不能为空。", true);
    return;
  }
  if (trimmed === task.content) return;

  const previous = checklists;
  checklists = checklists.map((item) => item.id === checklistId
    ? {
        ...item,
        tasks: item.tasks.map((candidate) => candidate.id === taskId ? { ...candidate, content: trimmed } : candidate),
      }
    : item);
  input.value = trimmed;
  await persistChecklistChanges(previous);
}

async function toggleChecklistTaskImportance(checklistId: string, taskId: string): Promise<void> {
  const previous = checklists;
  checklists = checklists.map((checklist) => checklist.id === checklistId
    ? {
        ...checklist,
        tasks: checklist.tasks.map((task) => task.id === taskId ? { ...task, important: !task.important } : task),
      }
    : checklist);
  renderChecklists();
  await persistChecklistChanges(previous);
}

async function toggleChecklistTask(checklistId: string, taskId: string): Promise<void> {
  const previous = checklists;
  checklists = checklists.map((checklist) => checklist.id === checklistId
    ? {
        ...checklist,
        tasks: checklist.tasks.map((task) => task.id === taskId ? { ...task, completed: !task.completed } : task),
      }
    : checklist);
  renderChecklists();
  await persistChecklistChanges(previous);
}

async function removeChecklistTask(checklistId: string, taskId: string): Promise<void> {
  const originalList = checklists.find((list) => list.id === checklistId);
  const index = originalList?.tasks.findIndex((task) => task.id === taskId) ?? -1;
  const removed = originalList?.tasks[index];
  if (!removed) return;
  const previous = checklists;
  checklists = checklists.map((checklist) => checklist.id === checklistId
    ? { ...checklist, tasks: checklist.tasks.filter((task) => task.id !== taskId) }
    : checklist);
  renderChecklists();
  if (await persistChecklistChanges(previous)) offerUndo("已移除任务", async () => {
    const current = checklists.find((list) => list.id === checklistId);
    if (!current) { showToast("所属清单已不存在，请从备份恢复。", true); return false; }
    if (current.tasks.some((task) => task.id === taskId)) return true;
    const before = checklists;
    const tasks = [...current.tasks];
    tasks.splice(Math.min(index, tasks.length), 0, removed);
    checklists = checklists.map((list) => list.id === checklistId ? { ...list, tasks } : list);
    renderChecklists();
    return persistChecklistChanges(before);
  });
}

async function removeChecklist(checklistId: string): Promise<void> {
  const removed = checklists.find((checklist) => checklist.id === checklistId);
  if (!removed) return;
  const removedIndex = checklists.indexOf(removed);
  const previous = checklists;
  checklists = checklists.filter((checklist) => checklist.id !== checklistId);
  editingChecklistId = null;
  renderChecklists();
  if (await persistChecklistChanges(previous)) offerUndo(`已移除「${removed.name}」`, async () => {
    if (checklists.some((list) => list.id === removed.id)) return true;
    const before = checklists;
    checklists = [...checklists];
    checklists.splice(Math.min(removedIndex, checklists.length), 0, removed);
    renderChecklists();
    return persistChecklistChanges(before);
  });
}

function clearChecklistCardDragState(): void {
  const state = checklistCardDragState;
  if (!state) return;
  clearLiveReorder(state.live);
  checklistCardDragState = null;
}

function beginChecklistCardDrag(
  event: PointerEvent,
  card: HTMLElement,
  handle: HTMLElement,
): void {
  if (event.button !== 0 || checklistCardDragState) return;
  const live = beginLiveReorder(
    event,
    card,
    handle,
    checklistGrid,
    ".checklist-card",
    "grid",
    "checklist",
  );
  if (!live) return;
  checklistCardDragState = {
    live,
    previousOrder: [...checklistGrid.querySelectorAll<HTMLElement>(".checklist-card")]
      .map((item) => item.dataset.checklistId)
      .filter((id): id is string => Boolean(id)),
  };
}

function moveChecklistCardDrag(event: PointerEvent): void {
  const state = checklistCardDragState;
  if (!state) return;
  moveLiveReorder(event, state.live);
}

async function finishChecklistCardDrag(event: PointerEvent): Promise<void> {
  const state = checklistCardDragState;
  if (!state || state.live.pointerId !== event.pointerId) return;
  const nextOrder = [...checklistGrid.querySelectorAll<HTMLElement>(".checklist-card")]
    .map((item) => item.dataset.checklistId)
    .filter((id): id is string => Boolean(id));
  clearChecklistCardDragState();
  if (!hasSameIds(nextOrder, state.previousOrder)) {
    renderChecklists();
    showToast("未能完成排序，请再试一次。", true);
    return;
  }
  if (hasSameOrder(nextOrder, state.previousOrder)) return;

  const previous = checklists;
  const byId = new Map(checklists.map((checklist) => [checklist.id, checklist]));
  // Reorder only visible cards, retaining stored lists in their original slots.
  let nextIndex = 0;
  checklists = checklists.map((list) => list.archived ? list : byId.get(nextOrder[nextIndex++])!);
  renderChecklists();
  await persistChecklistChanges(previous);
}

function cancelChecklistCardDrag(event: PointerEvent): void {
  const state = checklistCardDragState;
  if (!state || state.live.pointerId !== event.pointerId) return;
  clearChecklistCardDragState();
  renderChecklists();
}

function clearChecklistTaskDragState(): void {
  const state = checklistTaskDragState;
  if (!state) return;
  clearLiveReorder(state.live);
  checklistTaskDragState = null;
}

function beginChecklistTaskDrag(
  event: PointerEvent,
  checklistId: string,
  item: HTMLElement,
  handle: HTMLElement,
): void {
  if (event.button !== 0 || checklistTaskDragState || !(item.parentElement instanceof HTMLElement)) return;
  const list = item.parentElement;
  const live = beginLiveReorder(
    event,
    item,
    handle,
    list,
    ".checklist-task",
    "vertical",
    "task",
  );
  if (!live) return;
  checklistTaskDragState = {
    live,
    checklistId,
    previousOrder: [...list.querySelectorAll<HTMLElement>(".checklist-task")]
      .map((task) => task.dataset.taskId)
      .filter((id): id is string => Boolean(id)),
  };
}

function moveChecklistTaskDrag(event: PointerEvent): void {
  const state = checklistTaskDragState;
  if (!state) return;
  moveLiveReorder(event, state.live);
}

async function finishChecklistTaskDrag(event: PointerEvent): Promise<void> {
  const state = checklistTaskDragState;
  if (!state || state.live.pointerId !== event.pointerId) return;
  const nextOrder = [...state.live.container.querySelectorAll<HTMLElement>(".checklist-task")]
    .map((task) => task.dataset.taskId)
    .filter((id): id is string => Boolean(id));
  clearChecklistTaskDragState();
  if (!hasSameIds(nextOrder, state.previousOrder)) {
    renderChecklists();
    showToast("未能完成排序，请再试一次。", true);
    return;
  }
  if (hasSameOrder(nextOrder, state.previousOrder)) return;

  const checklist = checklists.find((item) => item.id === state.checklistId);
  if (!checklist) {
    renderChecklists();
    return;
  }
  const previous = checklists;
  const byId = new Map(checklist.tasks.map((task) => [task.id, task]));
  const tasks = nextOrder.map((id) => byId.get(id)).filter((task): task is ChecklistTask => Boolean(task));
  checklists = checklists.map((item) => item.id === checklist.id ? { ...item, tasks } : item);
  renderChecklists();
  await persistChecklistChanges(previous);
}

function cancelChecklistTaskDrag(event: PointerEvent): void {
  const state = checklistTaskDragState;
  if (!state || state.live.pointerId !== event.pointerId) return;
  clearChecklistTaskDragState();
  renderChecklists();
}

function createChecklistCard(checklist: Checklist, expanded = false): HTMLElement {
  const editingChecklist = !checklist.archived && editingChecklistId === checklist.id;
  const card = document.createElement("article");
  card.className = "checklist-card";
  card.classList.toggle("is-editing", editingChecklist);
  card.dataset.checklistId = checklist.id;

  const header = document.createElement("header");
  header.className = "checklist-card-heading";
  if (editingChecklist && !expanded) {
    const dragHandle = document.createElement("span");
    dragHandle.className = "checklist-card-drag-handle reorder-handle";
    dragHandle.title = "拖动清单排序";
    dragHandle.setAttribute("aria-label", `拖动清单「${checklist.name}」排序`);
    dragHandle.append(icon("grip"));
    dragHandle.addEventListener("pointerdown", (event) => beginChecklistCardDrag(event, card, dragHandle));
    header.append(dragHandle);
  }
  const titleRow = document.createElement("div");
  titleRow.className = "checklist-title-row";
  if (editingChecklist) {
    const titleInput = document.createElement("input");
    titleInput.className = "checklist-title-input";
    titleInput.value = checklist.name;
    titleInput.maxLength = MAX_CHECKLIST_NAME_LENGTH;
    titleInput.setAttribute("aria-label", "清单名称");
    titleInput.addEventListener("change", () => void renameChecklist(checklist.id, titleInput.value, titleInput));
    titleInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") titleInput.blur();
      if (event.key === "Escape") {
        titleInput.value = checklist.name;
        titleInput.blur();
      }
    });
    titleRow.append(titleInput);
  } else {
    const title = document.createElement("h3");
    const titleButton = document.createElement("button");
    titleButton.type = "button";
    titleButton.className = "checklist-title-button";
    titleButton.textContent = checklist.name;
    titleButton.setAttribute("aria-label", `展开清单「${checklist.name}」`);
    titleButton.addEventListener("click", () => openChecklistFocus(checklist.id, titleButton));
    title.append(titleButton);
    titleRow.append(title);
  }

  const remaining = checklist.tasks.filter((task) => !task.completed).length;
  const count = document.createElement("span");
  count.className = "checklist-count";
  count.textContent = String(remaining);
  count.setAttribute("aria-label", `${remaining} 个未完成任务`);
  titleRow.append(count);

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "checklist-edit-button";
  edit.hidden = Boolean(checklist.archived);
  edit.append(icon("edit"));
  edit.setAttribute("aria-label", editingChecklist ? `完成编辑 ${checklist.name}` : `编辑 ${checklist.name}`);
  edit.setAttribute("aria-pressed", String(editingChecklist));
  edit.addEventListener("click", () => {
    editingChecklistId = editingChecklist ? null : checklist.id;
    renderChecklists();
    if (!editingChecklist) {
      window.setTimeout(() => activeChecklistRoot().querySelector<HTMLInputElement>(`[data-task-input="${checklist.id}"]`)?.focus(), 0);
    }
  });
  header.append(titleRow, edit);
  card.append(header);

  if (checklist.dailyReset && !editingChecklist) {
    const resetNote = document.createElement("span");
    resetNote.className = "checklist-reset-note";
    resetNote.textContent = checklist.archived ? "已收存 · 每日重置已暂停" : "每日重置";
    card.append(resetNote);
  }

  const taskFrame = document.createElement("div");
  taskFrame.className = "checklist-task-frame";
  if (checklist.tasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "checklist-task-empty";
    empty.textContent = editingChecklist ? "在下方写下第一件事。" : "还没有任务。";
    taskFrame.append(empty);
  } else {
    const list = document.createElement("ol");
    list.className = "checklist-task-list";
    for (const task of checklist.tasks) {
      const item = document.createElement("li");
      item.className = "checklist-task";
      item.classList.toggle("is-completed", task.completed);
      item.classList.toggle("is-important", task.important);
      item.hidden = !editingChecklist && task.completed && collapsedCompleted.has(checklist.id);
      item.dataset.taskId = task.id;

      if (editingChecklist) {
        const dragHandle = document.createElement("span");
        dragHandle.className = "task-drag-handle reorder-handle";
        dragHandle.title = "拖动排序";
        dragHandle.setAttribute("aria-label", `拖动任务「${task.content}」排序`);
        dragHandle.append(icon("grip"));
        dragHandle.addEventListener("pointerdown", (event) => beginChecklistTaskDrag(event, checklist.id, item, dragHandle));
        item.append(dragHandle);
      }

      const completion = document.createElement("button");
      completion.type = "button";
      completion.className = "task-completion";
      completion.disabled = Boolean(checklist.archived);
      completion.classList.toggle("is-important", task.important);
      completion.classList.toggle("is-completed", task.completed);
      completion.setAttribute("aria-pressed", String(task.completed));
      completion.setAttribute("aria-label", task.completed ? `将「${task.content}」标为未完成` : `完成「${task.content}」`);
      if (task.important) completion.append(icon("star"));
      completion.addEventListener("click", () => void toggleChecklistTask(checklist.id, task.id));

      const content = editingChecklist ? document.createElement("input") : document.createElement("span");
      content.className = editingChecklist ? "task-content-input" : "task-content";
      if (content instanceof HTMLInputElement) {
        content.value = task.content;
        content.maxLength = MAX_TASK_CONTENT_LENGTH;
        content.setAttribute("aria-label", `修改任务「${task.content}」`);
        content.addEventListener("change", () => void renameChecklistTask(checklist.id, task.id, content.value, content));
        content.addEventListener("keydown", (event) => {
          if (event.key === "Enter") content.blur();
          if (event.key === "Escape") {
            content.value = task.content;
            content.blur();
          }
        });
      } else {
        content.textContent = task.content;
      }
      item.append(completion);
      const linked = shortcuts.find((shortcut) => shortcut.id === task.shortcutId);
      if (editingChecklist) {
        const editor = document.createElement("div");
        editor.className = "task-content-editor";
        const link = document.createElement("button");
        link.type = "button";
        link.className = "task-link-edit text-action";
        link.textContent = linked?.name ?? (task.shortcutId ? "入口已移除" : "关联入口");
        link.setAttribute("aria-label", `为任务「${task.content}」关联入口`);
        link.addEventListener("click", () => openTaskLink(checklist.id, task.id));
        editor.append(content, link);
        item.append(editor);
      } else {
        item.append(content);
        if (linked) {
          const link = document.createElement("button");
          link.type = "button";
          link.className = "task-linked-open quiet-icon-button";
          link.append(icon("arrow"));
          link.title = `打开 ${linked.name}`;
          link.setAttribute("aria-label", `打开关联入口 ${linked.name}`);
          link.addEventListener("click", () => void launch(linked));
          item.classList.add("has-linked-shortcut");
          item.append(link);
        }
      }

      if (editingChecklist) {
        const important = document.createElement("button");
        important.type = "button";
        important.className = "task-important-toggle";
        important.setAttribute("aria-pressed", String(task.important));
        important.setAttribute("aria-label", task.important ? `取消重要任务「${task.content}」` : `设为重要任务「${task.content}」`);
        important.append(icon("star"));
        important.addEventListener("click", () => void toggleChecklistTaskImportance(checklist.id, task.id));

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "task-remove-button";
        remove.append(icon("trash"));
        remove.setAttribute("aria-label", `删除任务「${task.content}」`);
        remove.addEventListener("click", () => void removeChecklistTask(checklist.id, task.id));
        item.append(important, remove);
      }
      list.append(item);
    }
    taskFrame.append(list);
  }
  card.append(taskFrame);
  const completedCount = checklist.tasks.filter((task) => task.completed).length;
  if (completedCount && !editingChecklist) {
    const completedToggle = document.createElement("button");
    completedToggle.type = "button";
    completedToggle.className = "completed-toggle text-action";
    completedToggle.textContent = `已完成 · ${completedCount}`;
    completedToggle.setAttribute("aria-expanded", String(!collapsedCompleted.has(checklist.id)));
    completedToggle.addEventListener("click", () => {
      if (collapsedCompleted.has(checklist.id)) collapsedCompleted.delete(checklist.id);
      else collapsedCompleted.add(checklist.id);
      renderChecklists();
    });
    card.append(completedToggle);
  }

  if (editingChecklist) {
    const composer = document.createElement("form");
    composer.className = "task-composer";
    const input = document.createElement("input");
    input.className = "task-composer-input";
    input.dataset.taskInput = checklist.id;
    input.maxLength = MAX_TASK_CONTENT_LENGTH;
    input.placeholder = "添加一项任务";
    input.setAttribute("aria-label", `为 ${checklist.name} 添加任务`);
    const important = document.createElement("button");
    important.type = "button";
    important.className = "task-composer-important";
    important.setAttribute("aria-pressed", "false");
    important.setAttribute("aria-label", "将新任务设为重要");
    important.title = "设为重要";
    important.append(icon("star"));
    important.addEventListener("click", () => {
      const selected = important.getAttribute("aria-pressed") !== "true";
      important.setAttribute("aria-pressed", String(selected));
      important.setAttribute("aria-label", selected ? "取消新任务的重要标记" : "将新任务设为重要");
      important.title = selected ? "已设为重要" : "设为重要";
    });
    const add = document.createElement("button");
    add.type = "submit";
    add.className = "task-add-button";
    add.append(icon("plus"));
    add.setAttribute("aria-label", "添加任务");
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void addChecklistTask(checklist.id, input, important);
    });
    composer.append(input, important, add);

    const footer = document.createElement("div");
    footer.className = "checklist-edit-footer";
    const dailyReset = document.createElement("button");
    dailyReset.type = "button";
    dailyReset.className = "checklist-daily-toggle";
    dailyReset.setAttribute("aria-pressed", String(checklist.dailyReset));
    dailyReset.setAttribute("aria-label", checklist.dailyReset ? "关闭每日重置" : "开启每日重置");
    const dailyText = document.createElement("span");
    dailyText.textContent = "每日重置";
    const switchTrack = document.createElement("span");
    switchTrack.className = "setting-switch";
    switchTrack.setAttribute("aria-hidden", "true");
    const switchKnob = document.createElement("span");
    switchKnob.className = "setting-switch-knob";
    switchTrack.append(switchKnob);
    dailyReset.append(dailyText, switchTrack);
    dailyReset.addEventListener("click", () => void toggleChecklistDailyReset(checklist.id));

    const removeList = document.createElement("button");
    removeList.type = "button";
    removeList.className = "checklist-remove-button";
    removeList.setAttribute("aria-label", `移除清单「${checklist.name}」`);
    removeList.append(icon("trash"), document.createTextNode("移除清单"));
    removeList.addEventListener("click", () => {
      if (!removeList.classList.contains("is-confirming")) {
        removeList.classList.add("is-confirming");
        removeList.replaceChildren(icon("trash"), document.createTextNode("确认移除"));
        removeList.setAttribute("aria-label", `再次点击，确认移除清单「${checklist.name}」`);
        return;
      }
      void removeChecklist(checklist.id);
    });
    const archive = document.createElement("button");
    archive.type = "button";
    archive.className = "text-action checklist-store-button";
    archive.textContent = "收存";
    archive.setAttribute("aria-label", `收存清单「${checklist.name}」`);
    archive.addEventListener("click", () => void setChecklistArchived(checklist.id, true));
    footer.append(dailyReset, archive, removeList);
    card.append(composer, footer);
  }

  if (checklist.archived) {
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "text-action checklist-restore-button";
    restore.textContent = "恢复到工作台";
    restore.addEventListener("click", () => void setChecklistArchived(checklist.id, false));
    card.append(restore);
  }
  return card;
}

async function setChecklistArchived(id: string, archived: boolean): Promise<void> {
  const list = checklists.find((item) => item.id === id);
  if (!list || Boolean(list.archived) === archived) return;
  const previous = checklists;
  checklists = checklists.map((item) => item.id === id ? {
    ...item, archived,
    lastResetDate: !archived && item.dailyReset ? localDateKey() : item.lastResetDate,
  } : item);
  if (!await persistChecklistChanges(previous)) return;
  editingChecklistId = null;
  if (focusedChecklistId === id) closeChecklistFocus();
  renderChecklists();
  showToast(archived ? `已收存「${list.name}」` : `已恢复「${list.name}」`);
}

function renderStoredChecklists(): void {
  const stored = checklists.filter((list) => list.archived);
  const content = element<HTMLElement>("stored-checklist-list");
  content.replaceChildren();
  if (!stored.length) {
    const empty = document.createElement("p");
    empty.className = "field-hint";
    empty.textContent = "还没有收存的清单";
    content.append(empty);
  }
  for (const list of stored) {
    const row = document.createElement("div");
    row.className = "stored-checklist-row";
    const view = document.createElement("button");
    view.type = "button";
    view.className = "stored-checklist-view";
    const title = document.createElement("span");
    title.textContent = list.name;
    const detail = document.createElement("small");
    detail.textContent = `${list.tasks.length} 项任务 · ${list.tasks.filter((task) => task.completed).length} 项完成`;
    view.append(title, detail);
    view.setAttribute("aria-label", `查看已收存清单「${list.name}」`);
    view.addEventListener("click", () => {
      element<HTMLDialogElement>("stored-checklist-dialog").close();
      openChecklistFocus(list.id, element<HTMLButtonElement>("stored-checklist-button"));
    });
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "text-action";
    restore.textContent = "恢复";
    restore.setAttribute("aria-label", `恢复清单「${list.name}」`);
    restore.addEventListener("click", () => void setChecklistArchived(list.id, false));
    row.append(view, restore);
    content.append(row);
  }
}

function renderChecklists(): void {
  if (checklistCardDragState || checklistTaskDragState) return;
  if (editingChecklistId && !checklists.some((checklist) => checklist.id === editingChecklistId)) {
    editingChecklistId = null;
  }
  const scrollPositions = new Map<string, number>();
  document.querySelectorAll<HTMLElement>(".checklist-card").forEach((card) => {
    scrollPositions.set(card.dataset.checklistId!, card.querySelector(".checklist-task-frame")?.scrollTop ?? 0);
  });
  const active = checklists.filter((list) => !list.archived);
  checklistGrid.replaceChildren(...active.map((list) => createChecklistCard(list)));
  checklistGrid.hidden = active.length === 0;
  checklistEmptyState.hidden = active.length > 0;
  renderStoredChecklists();
  if (focusedChecklistId) {
    const focused = checklists.find((list) => list.id === focusedChecklistId);
    if (focused) checklistFocusContent.replaceChildren(createChecklistCard(focused, true));
    else closeChecklistFocus();
  }
  document.querySelectorAll<HTMLElement>(".checklist-card").forEach((card) => {
    const frame = card.querySelector(".checklist-task-frame");
    if (frame) frame.scrollTop = scrollPositions.get(card.dataset.checklistId!) ?? 0;
  });
}

function activeChecklistRoot(): HTMLElement {
  return checklistFocusDialog.open ? checklistFocusContent : checklistGrid;
}

function openChecklistFocus(id: string, source?: HTMLElement): void {
  focusedChecklistId = id;
  checklistReturnTarget = source ?? document.activeElement as HTMLElement;
  renderChecklists();
  if (!checklistFocusDialog.open) checklistFocusDialog.showModal();
}

function closeChecklistFocus(): void {
  const id = focusedChecklistId;
  focusedChecklistId = null;
  checklistFocusDialog.close();
  element<HTMLElement>("app-shell").append(element<HTMLElement>("undo-notice"));
  checklistFocusContent.replaceChildren();
  const target = checklistReturnTarget?.isConnected ? checklistReturnTarget
    : checklistGrid.querySelector<HTMLElement>(`[data-checklist-id="${CSS.escape(id ?? "")}"] .checklist-title-button`);
  target?.focus({ preventScroll: true });
}

function openTaskLink(checklistId: string, taskId: string): void {
  linkingTask = { checklistId, taskId };
  const task = checklists.find((list) => list.id === checklistId)?.tasks.find((item) => item.id === taskId);
  const select = element<HTMLSelectElement>("task-link-select");
  select.replaceChildren(new Option("不关联", ""), ...shortcuts.map((shortcut) => new Option(shortcut.name, shortcut.id)));
  select.value = shortcuts.some((shortcut) => shortcut.id === task?.shortcutId) ? task!.shortcutId! : "";
  taskLinkDialog.showModal();
}

async function saveTaskLink(): Promise<void> {
  if (!linkingTask) return;
  const { checklistId, taskId } = linkingTask;
  const shortcutId = element<HTMLSelectElement>("task-link-select").value || undefined;
  const previous = checklists;
  checklists = checklists.map((list) => list.id === checklistId ? { ...list,
    tasks: list.tasks.map((task) => task.id === taskId ? { ...task, shortcutId } : task),
  } : list);
  if (await persistChecklistChanges(previous)) { taskLinkDialog.close(); renderChecklists(); }
}

function formatDiaryTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const datePart = DIARY_DATE_FORMATTER.format(date).replaceAll("/", ".");
  const timePart = DIARY_TIME_FORMATTER.format(date);
  return `${datePart} ${timePart}`;
}

function diaryTimeElement(label: string, value: string): HTMLTimeElement {
  const time = document.createElement("time");
  time.dateTime = value;
  time.textContent = `${label} ${formatDiaryTimestamp(value)}`;
  return time;
}

async function persistDiaryChanges(previous: DiaryEntry[], successMessage?: string): Promise<boolean> {
  try {
    await invoke("save_diaries", { diaries });
    if (successMessage) showToast(successMessage);
    return true;
  } catch (error) {
    diaries = previous;
    renderDiaries();
    showToast(errorMessage(error), true);
    return false;
  }
}

function openDiaryDialog(entry?: DiaryEntry): void {
  diaryForm.reset();
  diaryFormError.hidden = true;
  diaryIdInput.value = entry?.id ?? "";
  diaryDraftKey = entry?.id ?? null;
  resetDiaryDeleteConfirmation();
  diaryTitleInput.value = entry?.title ?? "";
  diaryContentInput.value = entry?.content ?? "";
  const draft = drafts.find((candidate) => candidate.entryId === (entry?.id ?? null));
  if (draft) { diaryTitleInput.value = draft.title; diaryContentInput.value = draft.content; }
  element<HTMLElement>("diary-draft-status").textContent = draft ? "已接续上次的草稿" : "输入后自动保留草稿";
  resetDiscardDraftButton();
  diaryDialogTitle.textContent = entry ? "修改这一页" : "记录此刻";
  diaryDeleteButton.hidden = !entry;
  diarySaveButton.textContent = entry ? "保存修改" : "保存";
  diaryDialogTimes.replaceChildren();
  diaryDialogTimes.hidden = !entry;
  if (entry) {
    diaryDialogTimes.append(
      diaryTimeElement("创建", entry.createdAt),
      diaryTimeElement("修改", entry.updatedAt),
    );
  }
  diaryDialog.showModal();
  window.setTimeout(() => diaryTitleInput.focus(), 0);
}

function closeDiaryDialog(preserveDraft = true): void {
  if (diarySaving) return;
  if (preserveDraft) {
    captureDiaryDraft();
    void persistDrafts().catch((error) => showToast(errorMessage(error), true));
  }
  resetDiaryDeleteConfirmation();
  diaryDialog.close();
  addDiaryButton.focus({ preventScroll: true });
}

function resetDiaryDeleteConfirmation(): void {
  diaryDeleteButton.classList.remove("is-confirming");
  diaryDeleteButton.textContent = "移除";
  const entry = diaries.find((candidate) => candidate.id === diaryIdInput.value);
  diaryDeleteButton.setAttribute("aria-label", entry ? `移除日记「${entry.title}」` : "移除日记");
}

function resetDiscardDraftButton(): void {
  const button = element<HTMLButtonElement>("diary-discard-draft");
  button.textContent = "放弃草稿";
  button.classList.remove("is-confirming");
  button.hidden = !drafts.some((draft) => draft.entryId === diaryDraftKey);
}

async function discardDiaryDraft(): Promise<void> {
  if (diarySaving) return;
  const button = element<HTMLButtonElement>("diary-discard-draft");
  if (!button.classList.contains("is-confirming")) {
    button.textContent = "确认放弃"; button.classList.add("is-confirming"); return;
  }
  drafts = drafts.filter((draft) => draft.entryId !== diaryDraftKey);
  rememberDrafts(); renderDraftNotice();
  try { await persistDrafts(); closeDiaryDialog(false); }
  catch (error) { showToast(errorMessage(error), true); }
}

function finishClosingDiaryReader(): void {
  window.clearTimeout(diaryReaderCloseTimer);
  window.clearTimeout(diaryReaderSettleTimer);
  diaryReaderCloseTimer = undefined;
  diaryReaderSettleTimer = undefined;
  if (diaryReaderDialog.open) diaryReaderDialog.close();
  diaryReaderDialog.classList.remove("is-open", "is-closing", "is-settled");
  diaryReaderDialog.style.removeProperty("--reader-shift-x");
  diaryReaderDialog.style.removeProperty("--reader-shift-y");
  diaryReaderDialog.style.removeProperty("--reader-scale");
  const returnTarget = diaryReaderReturnTarget;
  diaryReaderReturnTarget = null;
  const target = returnTarget?.isConnected ? returnTarget
    : diaryGrid.querySelector<HTMLElement>(`[data-diary-id="${CSS.escape(readerOriginDiaryId ?? "")}"]`);
  target?.focus({ preventScroll: true });
  mainView.scrollTop = diaryListScroll;
  readingDiaryId = null;
  readerOriginDiaryId = null;
}

function closeDiaryReader(): void {
  diaryReaderReveal = undefined;
  if (!diaryReaderDialog.open || diaryReaderDialog.classList.contains("is-closing")) return;
  window.clearTimeout(diaryReaderSettleTimer);
  diaryReaderSettleTimer = undefined;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finishClosingDiaryReader();
    return;
  }
  diaryReaderDialog.classList.remove("is-settled");
  void diaryReaderDialog.offsetWidth;
  diaryReaderDialog.classList.add("is-closing");
  diaryReaderDialog.classList.remove("is-open");
  diaryReaderCloseTimer = window.setTimeout(finishClosingDiaryReader, DIARY_READER_CLOSE_DELAY_MS);
}

function openDiaryReader(entry: DiaryEntry, sourceCard: HTMLElement, searchTerms: string[] = []): void {
  diaryListScroll = mainView.scrollTop;
  readerOriginDiaryId = entry.id;
  readingDiaryId = entry.id;
  window.clearTimeout(diaryReaderCloseTimer);
  window.clearTimeout(diaryReaderSettleTimer);
  diaryReaderCloseTimer = undefined;
  diaryReaderSettleTimer = undefined;
  diaryReaderReturnTarget = sourceCard;
  diaryReaderTitle.textContent = entry.title;
  diaryReaderTimes.replaceChildren(
    diaryTimeElement("创建", entry.createdAt),
    diaryTimeElement("修改", entry.updatedAt),
  );
  diaryReaderContent.textContent = entry.content;
  updateDiaryReaderNavigation();
  diaryReaderDialog.classList.remove("is-open", "is-closing", "is-settled");
  diaryReaderDialog.showModal();
  diaryReaderDialog.querySelector<HTMLElement>(".diary-reader-sheet")!.scrollTop = 0;
  const revealMatch = () => {
    if (!searchTerms.length || readingDiaryId !== entry.id || !diaryReaderDialog.open
      || diaryReaderDialog.classList.contains("is-closing")) return;
    const bodyMatch = locateText(entry.content, searchTerms);
    const target = bodyMatch ? diaryReaderContent : diaryReaderTitle;
    const text = bodyMatch ? entry.content : entry.title;
    const match = bodyMatch ?? locateText(text, searchTerms);
    if (!match) return;
    const mark = document.createElement("mark");
    mark.className = "matched-text";
    mark.textContent = text.slice(match.start, match.end);
    target.replaceChildren(document.createTextNode(text.slice(0, match.start)), mark, document.createTextNode(text.slice(match.end)));
    const sheet = diaryReaderDialog.querySelector<HTMLElement>(".diary-reader-sheet")!;
    sheet.scrollTop += mark.getBoundingClientRect().top - sheet.getBoundingClientRect().top - sheet.clientHeight / 2;
  };
  diaryReaderReveal = revealMatch;

  const sourceRect = sourceCard.getBoundingClientRect();
  const readerRect = diaryReaderDialog.getBoundingClientRect();
  const sourceCenterX = sourceRect.left + sourceRect.width / 2;
  const sourceCenterY = sourceRect.top + sourceRect.height / 2;
  const readerCenterX = readerRect.left + readerRect.width / 2;
  const readerCenterY = readerRect.top + readerRect.height / 2;
  const scale = Math.max(0.48, Math.min(0.78, sourceRect.width / readerRect.width));
  diaryReaderDialog.style.setProperty("--reader-shift-x", `${sourceCenterX - readerCenterX}px`);
  diaryReaderDialog.style.setProperty("--reader-shift-y", `${sourceCenterY - readerCenterY}px`);
  diaryReaderDialog.style.setProperty("--reader-scale", String(scale));

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    diaryReaderDialog.classList.add("is-open", "is-settled");
    settleDiaryReader();
    return;
  }

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!diaryReaderDialog.open) return;
      diaryReaderDialog.classList.add("is-open");
      diaryReaderSettleTimer = window.setTimeout(settleDiaryReader, DIARY_READER_SETTLE_DELAY_MS);
    });
  });
}

function settleDiaryReader(): void {
  window.clearTimeout(diaryReaderSettleTimer);
  diaryReaderSettleTimer = undefined;
  if (
    diaryReaderDialog.open
    && diaryReaderDialog.classList.contains("is-open")
    && !diaryReaderDialog.classList.contains("is-closing")
  ) {
    diaryReaderDialog.classList.add("is-settled");
    const reveal = diaryReaderReveal;
    diaryReaderReveal = undefined;
    reveal?.();
  }
}

async function removeDiaryFromForm(): Promise<void> {
  if (diarySaving) return;
  const existing = diaries.find((entry) => entry.id === diaryIdInput.value);
  if (!existing) return;
  if (!diaryDeleteButton.classList.contains("is-confirming")) {
    diaryFormError.hidden = true;
    diaryDeleteButton.classList.add("is-confirming");
    diaryDeleteButton.textContent = "确认移除";
    diaryDeleteButton.setAttribute("aria-label", `再次点击，确认移除日记「${existing.title}」`);
    return;
  }

  const previous = diaries;
  const removedIndex = diaries.indexOf(existing);
  diaries = diaries.filter((entry) => entry.id !== existing.id);
  renderDiaries();
  if (await persistDiaryChanges(previous)) {
    closeDiaryDialog(false);
    const removedDraft = drafts.find((draft) => draft.entryId === existing.id);
    drafts = drafts.filter((draft) => draft.entryId !== existing.id);
    rememberDrafts();
    renderDraftNotice();
    void persistDrafts().catch((error) => showToast(errorMessage(error), true));
    offerUndo(`已移除「${existing.title}」`, async () => {
      if (diaries.some((entry) => entry.id === existing.id)) return true;
      const before = diaries;
      diaries = [...diaries];
      diaries.splice(Math.min(removedIndex, diaries.length), 0, existing);
      renderDiaries();
      if (!await persistDiaryChanges(before)) return false;
      if (removedDraft) { drafts.push(removedDraft); rememberDrafts(); renderDraftNotice(); await persistDrafts(); }
      return true;
    });
  } else {
    resetDiaryDeleteConfirmation();
  }
}

async function saveDiaryFromForm(): Promise<void> {
  if (diarySaving) return;
  const title = diaryTitleInput.value.trim();
  const content = diaryContentInput.value.trim();
  if (!title || !content) {
    diaryFormError.textContent = !title ? "请为这一页写一个标题。" : "请写下这一刻的内容。";
    diaryFormError.hidden = false;
    return;
  }
  if (title.length > MAX_DIARY_TITLE_LENGTH || content.length > MAX_DIARY_CONTENT_LENGTH) {
    diaryFormError.textContent = "这一页的文字太长了，请稍作删减。";
    diaryFormError.hidden = false;
    return;
  }

  const existing = diaries.find((entry) => entry.id === diaryIdInput.value);
  if (existing && existing.title === title && existing.content === content) {
    closeDiaryDialog();
    return;
  }

  const previous = diaries;
  captureDiaryDraft();
  diarySaving = true;
  diarySaveButton.disabled = true;
  diaryTitleInput.readOnly = true;
  diaryContentInput.readOnly = true;
  const now = new Date().toISOString();
  if (existing) {
    diaries = diaries.map((entry) => entry.id === existing.id
      ? { ...entry, title, content, updatedAt: now }
      : entry);
  } else {
    diaries = [{ id: crypto.randomUUID(), title, content, createdAt: now, updatedAt: now }, ...diaries];
  }
  if (!existing) diaryMonth = localDateKey(new Date(now)).slice(0, 7);
  renderDiaries();
  if (await persistDiaryChanges(previous)) {
    drafts = drafts.filter((draft) => draft.entryId !== diaryDraftKey);
    rememberDrafts();
    renderDraftNotice();
    await persistDrafts().catch((error) => showToast(errorMessage(error), true));
    diarySaving = false;
    closeDiaryDialog(false);
    showToast(existing ? `已修改「${title}」` : `已记录「${title}」`);
  }
  diarySaving = false;
  diarySaveButton.disabled = false;
  diaryTitleInput.readOnly = false;
  diaryContentInput.readOnly = false;
}

function createDiaryCard(entry: DiaryEntry): HTMLElement {
  const card = document.createElement("article");
  card.className = "diary-card";
  card.dataset.diaryId = entry.id;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `浏览日记「${entry.title}」`);

  const header = document.createElement("header");
  header.className = "diary-card-heading";
  const title = document.createElement("h3");
  title.textContent = entry.title;
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "diary-edit-button";
  edit.setAttribute("aria-label", `修改日记「${entry.title}」`);
  edit.append(icon("edit"));
  edit.addEventListener("click", (event) => {
    event.stopPropagation();
    openDiaryDialog(entry);
  });
  header.append(title, edit);

  const content = document.createElement("p");
  content.className = "diary-card-content";
  content.textContent = entry.content;

  const times = document.createElement("footer");
  times.className = "diary-card-times";
  times.append(
    diaryTimeElement("创建", entry.createdAt),
    diaryTimeElement("修改", entry.updatedAt),
  );
  card.append(header, content, times);
  card.addEventListener("click", () => openDiaryReader(entry, card));
  card.addEventListener("keydown", (event) => {
    if (event.target !== card || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    openDiaryReader(entry, card);
  });
  return card;
}

function renderDiaries(): void {
  const months = diaryMonths();
  if (!months.includes(diaryMonth)) diaryMonth = months[0] ?? "";
  diaryMonthSelect.replaceChildren(...months.map((month) => new Option(`${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`, month)));
  diaryMonthSelect.value = diaryMonth;
  element<HTMLElement>("diary-month-navigation").hidden = months.length === 0;
  element<HTMLButtonElement>("diary-month-previous").disabled = months.indexOf(diaryMonth) >= months.length - 1;
  element<HTMLButtonElement>("diary-month-next").disabled = months.indexOf(diaryMonth) <= 0;
  diaryGrid.replaceChildren(...orderedDiaries().filter((entry) => diaryMonthKey(entry) === diaryMonth).map(createDiaryCard));
  diaryGrid.hidden = diaries.length === 0;
  diaryEmptyState.hidden = diaries.length > 0;
}

function diaryMonthKey(entry: DiaryEntry): string { return localDateKey(new Date(entry.createdAt)).slice(0, 7); }
function diaryMonths(): string[] { return [...new Set(diaries.map(diaryMonthKey))].sort().reverse(); }
function orderedDiaries(): DiaryEntry[] { return [...diaries].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)); }

function changeDiaryMonth(direction: number): void {
  const months = diaryMonths();
  diaryMonth = months[months.indexOf(diaryMonth) + direction] ?? diaryMonth;
  renderDiaries();
}

function updateDiaryReaderNavigation(): void {
  const index = orderedDiaries().findIndex((entry) => entry.id === readingDiaryId);
  element<HTMLButtonElement>("diary-reader-previous").disabled = index <= 0;
  element<HTMLButtonElement>("diary-reader-next").disabled = index < 0 || index >= diaries.length - 1;
}

function turnDiaryPage(direction: number): void {
  const entries = orderedDiaries();
  const entry = entries[entries.findIndex((candidate) => candidate.id === readingDiaryId) + direction];
  if (!entry) return;
  readingDiaryId = entry.id;
  diaryReaderTitle.textContent = entry.title;
  diaryReaderContent.textContent = entry.content;
  diaryReaderTimes.replaceChildren(diaryTimeElement("创建", entry.createdAt), diaryTimeElement("修改", entry.updatedAt));
  diaryReaderDialog.querySelector(".diary-reader-sheet")!.scrollTop = 0;
  updateDiaryReaderNavigation();
}

async function exportCurrentDiary(): Promise<void> {
  const entry = diaries.find((candidate) => candidate.id === readingDiaryId);
  if (!entry) return;
  try {
    const path = await save({ defaultPath: `${entry.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").slice(0, 60)}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }, { name: "纯文本", extensions: ["txt"] }] });
    if (path) { await invoke("export_diary", { id: entry.id, path }); showToast("这一页已导出"); }
  } catch (error) { showToast(errorMessage(error), true); }
}

function clearShortcutCardDragState(): void {
  const state = shortcutCardDragState;
  if (!state) return;
  clearLiveReorder(state.live);
  shortcutCardDragState = null;
}

function beginShortcutCardDrag(
  event: PointerEvent,
  card: HTMLElement,
  shortcut: AppShortcut,
  handle: HTMLElement,
): void {
  if (event.button !== 0 || shortcutCardDragState || !(card.parentElement instanceof HTMLElement)) return;
  const grid = card.parentElement;
  const live = beginLiveReorder(
    event,
    card,
    handle,
    grid,
    ".shortcut-card[data-shortcut-id]",
    "grid",
    "shortcut",
  );
  if (!live) return;
  shortcutCardDragState = {
    live,
    previousOrder: [...grid.querySelectorAll<HTMLElement>(".shortcut-card[data-shortcut-id]")]
      .map((item) => item.dataset.shortcutId)
      .filter((id): id is string => Boolean(id)),
    sleeping: shortcut.sleeping,
  };
}

function moveShortcutCardDrag(event: PointerEvent): void {
  const state = shortcutCardDragState;
  if (!state) return;
  moveLiveReorder(event, state.live);
}

async function finishShortcutCardDrag(event: PointerEvent): Promise<void> {
  const state = shortcutCardDragState;
  if (!state || state.live.pointerId !== event.pointerId) return;
  const nextOrder = [...state.live.container.querySelectorAll<HTMLElement>(".shortcut-card[data-shortcut-id]")]
    .map((item) => item.dataset.shortcutId)
    .filter((id): id is string => Boolean(id));
  clearShortcutCardDragState();
  if (!hasSameIds(nextOrder, state.previousOrder)) {
    render();
    showToast("未能完成排序，请再试一次。", true);
    return;
  }
  if (hasSameOrder(nextOrder, state.previousOrder)) return;

  const previous = shortcuts;
  const byId = new Map(shortcuts.map((shortcut) => [shortcut.id, shortcut]));
  const reorderedZone = nextOrder.map((id) => byId.get(id)).filter((shortcut): shortcut is AppShortcut => Boolean(shortcut));
  let zoneIndex = 0;
  shortcuts = shortcuts.map((shortcut) => shortcut.sleeping === state.sleeping ? reorderedZone[zoneIndex++] : shortcut);
  render();
  try {
    await persist();
  } catch (error) {
    shortcuts = previous;
    render();
    showToast(errorMessage(error), true);
  }
}

function cancelShortcutCardDrag(event: PointerEvent): void {
  const state = shortcutCardDragState;
  if (!state || state.live.pointerId !== event.pointerId) return;
  clearShortcutCardDragState();
  render();
}

function createShortcutCard(shortcut: AppShortcut): HTMLElement {
  const card = document.createElement("button");
  const kind = shortcutKind(shortcut);
  const fileMarker = fileTypeMarker(shortcut);
  const fileIconSvg = kind === "local" ? fileIconForTarget(shortcut.target) : null;
  const running = isShortcutRunning(shortcut);
  card.type = "button";
  card.className = `shortcut-card icon-${shortcut.icon}`;
  card.dataset.shortcutId = shortcut.id;
  if (shortcut.sleeping) card.classList.add("sleeping-card");
  if (kind === "web") card.classList.add("online-card");
  if (running) card.classList.add("running-card");
  card.setAttribute(
    "aria-label",
    scheduling
      ? `安排 ${shortcut.name} 的每周作息`
      : shortcut.sleeping
        ? `管理睡眠中的 ${shortcut.name}`
        : editing
          ? `编辑 ${shortcut.name}`
          : running
            ? `${shortcut.name} 已在运行`
            : `打开 ${shortcut.name}`,
  );

  const iconHolder = document.createElement("span");
  iconHolder.className = "app-icon";
  const iconData = (fileIconSvg || kind === "folder") ? null : appIcons.get(iconCacheKey(shortcut));
  if (fileIconSvg) {
    iconHolder.classList.add("is-file-icon");
    iconHolder.innerHTML = fileIconSvg;
  } else if (kind === "folder") {
    iconHolder.classList.add("is-fallback");
    iconHolder.append(icon("folder"));
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

  if (editing) {
    card.classList.add("is-reorderable");
    const dragHandle = document.createElement("span");
    dragHandle.className = "shortcut-drag-handle reorder-handle";
    dragHandle.title = "拖动入口排序";
    dragHandle.setAttribute("aria-label", `拖动入口「${shortcut.name}」排序`);
    dragHandle.append(icon("grip"));
    dragHandle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    dragHandle.addEventListener("pointerdown", (event) => beginShortcutCardDrag(event, card, shortcut, dragHandle));
    card.append(dragHandle);
  }

  if (scheduling) {
    const summary = document.createElement("span");
    summary.className = "schedule-summary";
    summary.textContent = scheduleSummary(shortcut.wakeDays);
    card.append(summary);
  }

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

  if (scheduling || shortcut.sleeping || editing) {
    card.classList.add("has-corner");
    const corner = document.createElement("span");
    corner.className = "shortcut-corner";
    corner.append(icon(scheduling ? "calendar" : shortcut.sleeping ? "moon" : "edit"));
    card.append(corner);
  }

  card.addEventListener("click", () => {
    if (scheduling) openScheduleEditor(shortcut);
    else if (shortcut.sleeping || editing) openEditor(shortcut);
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
  hint.textContent = "应用、文档、文件夹或网址";
  card.append(iconHolder, name, hint);
  card.addEventListener("click", () => openEditor());
  return card;
}

function render(): void {
  if (shortcutCardDragState) return;
  const awake = shortcuts.filter((shortcut) => !shortcut.sleeping);
  const launchable = awake.filter((shortcut) => !isShortcutRunning(shortcut));
  const sleeping = shortcuts.filter((shortcut) => shortcut.sleeping);

  shortcutGrid.replaceChildren(...awake.map(createShortcutCard));
  if (editing) shortcutGrid.append(createAddCard());
  shortcutGrid.hidden = awake.length === 0 && !editing;
  emptyState.hidden = awake.length > 0 || editing || scheduling;

  sleepGrid.replaceChildren(...sleeping.map(createShortcutCard));
  sleepSection.hidden = sleeping.length === 0;
  sleepContent.classList.toggle("is-open", sleepExpanded);
  sleepContent.setAttribute("aria-hidden", String(!sleepExpanded));
  sleepContent.inert = !sleepExpanded;
  sleepCount.textContent = String(sleeping.length);
  sleepToggle.setAttribute("aria-expanded", String(sleepExpanded));

  document.body.classList.toggle("editing", editing);
  document.body.classList.toggle("scheduling", scheduling);
  editButton.setAttribute("aria-pressed", String(editing));
  editLabel.textContent = editing ? "完成" : "编辑";
  scheduleButton.setAttribute("aria-pressed", String(scheduling));
  scheduleLabel.textContent = scheduling ? "完成" : "作息";
  scheduleButton.hidden = shortcuts.length === 0;
  launchAllButton.hidden = awake.length === 0 || editing || scheduling;
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
  renderWorkspaceModules();
}

async function persist(): Promise<void> {
  await invoke("save_apps", { shortcuts });
}

function isMissingTarget(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "target_missing");
}

function offerRelocation(missing: AppShortcut[]): void {
  document.getElementById("relocation-notice")?.remove();
  const pending = missing.filter((old) => shortcuts.some((item) => item.id === old.id && item.target === old.target));
  const current = pending[0];
  if (!current) return;
  const notice = document.createElement("div");
  notice.id = "relocation-notice";
  notice.className = "undo-notice relocation-notice";
  notice.setAttribute("role", "status");
  const message = document.createElement("span");
  message.textContent = `找不到「${current.name}」的位置${pending.length > 1 ? `（另有 ${pending.length - 1} 个）` : ""}`;
  const locate = document.createElement("button");
  locate.type = "button";
  locate.className = "text-action";
  locate.textContent = "重新定位";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "text-action";
  dismiss.textContent = "稍后";
  dismiss.onclick = () => notice.remove();
  locate.onclick = async () => {
    locate.disabled = true;
    dismiss.disabled = true;
    try {
      const kind = shortcutKind(current);
      const selected = await open(kind === "folder"
        ? { title: `重新定位 · ${current.name}`, multiple: false, directory: true }
        : { title: `重新定位 · ${current.name}`, multiple: false, directory: false,
            filters: [{ name: "应用与文档", extensions: LOCAL_FILE_EXTENSIONS }] });
      if (typeof selected !== "string") return;
      await invoke("validate_relocation", { target: selected, kind });
      // Read the latest record after the native picker closes; never resurrect a removed entry.
      const latest = shortcuts.find((item) => item.id === current.id);
      if (!latest || latest.target !== current.target) { notice.remove(); return; }
      const replacement = { ...latest, target: selected, icon: inferIcon(latest.name, selected, kind) };
      const previous = shortcuts;
      shortcuts = shortcuts.map((item) => item.id === latest.id ? replacement : item);
      try { await persist(); }
      catch (error) { shortcuts = previous; throw error; }
      render();
      void hydrateAppIcons([replacement]);
      void refreshRunningApps();
      notice.remove();
      showToast(`已更新「${latest.name}」的位置`);
      offerRelocation(pending.slice(1));
    } catch (error) {
      message.textContent = `${errorMessage(error)} 原入口未改动。`;
    } finally {
      locate.disabled = false;
      dismiss.disabled = false;
    }
  };
  notice.append(message, locate, dismiss);
  (document.querySelector("dialog[open]") ?? element<HTMLElement>("app-shell")).append(notice);
}

async function launch(shortcut: AppShortcut): Promise<void> {
  try {
    await invoke("launch_app", { target: shortcut.target, kind: shortcutKind(shortcut) });
    if (supportsRunningDetection(shortcut)) {
      window.setTimeout(() => void refreshRunningApps(), 800);
    }
  } catch (error) {
    if (isMissingTarget(error) && shortcutKind(shortcut) !== "web") offerRelocation([shortcut]);
    else showToast(errorMessage(error), true);
  }
}

async function launchAll(): Promise<void> {
  if (launchingAll || runningDetectionPending) return;
  const awake = shortcuts.filter((shortcut) => !shortcut.sleeping && !isShortcutRunning(shortcut));
  if (awake.length === 0) return;
  launchingAll = true;
  render();
  let failed = 0;
  const missing: AppShortcut[] = [];
  try {
    for (const [index, shortcut] of awake.entries()) {
      try {
        await invoke("launch_app", { target: shortcut.target, kind: shortcutKind(shortcut) });
      } catch (error) {
        failed += 1;
        if (isMissingTarget(error)) missing.push(shortcut);
      }
      if (index < awake.length - 1) await delay(LAUNCH_INTERVAL_MS);
    }
  } finally {
    launchingAll = false;
    render();
  }
  if (failed > 0) showToast(`有 ${failed} 个入口未能打开。`, true);
  if (missing.length) offerRelocation(missing);
  window.setTimeout(() => void refreshRunningApps(), 800);
}

async function refreshRunningApps(initial = false): Promise<void> {
  if (runningDetectionInFlight) return;
  const targets = [...new Set(shortcuts.filter(supportsRunningDetection).map((shortcut) => shortcut.target))];
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
    if (shortcutKind(shortcut) === "folder" || fileIconForTarget(shortcut.target)) return false;
    const key = iconCacheKey(shortcut);
    if (appIcons.has(key) || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  if (pending.length === 0) return;

  const queue = [...pending];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const shortcut = queue.shift();
      if (!shortcut) break;
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
    }
  });
  await Promise.all(workers);
  render();
}

function openEditor(shortcut?: AppShortcut): void {
  form.reset();
  formError.hidden = true;
  const kind = shortcut ? shortcutKind(shortcut) : "local";
  const installedKindOption = element<HTMLElement>("installed-app-kind-option");
  form.querySelector<HTMLElement>(".shortcut-kind-selector")?.classList.toggle("is-installed", kind === "app");
  installedKindOption.hidden = kind !== "app";
  form.querySelectorAll<HTMLElement>(".shortcut-kind-selector .kind-option:not(#installed-app-kind-option)")
    .forEach((option) => { option.hidden = kind === "app"; });
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
  const kind = selectedShortcutKind();
  if (kind === "web" || kind === "app") return;
  const selected = await open(kind === "folder"
    ? { multiple: false, directory: true }
    : {
        multiple: false,
        directory: false,
        filters: [{ name: "应用与文档", extensions: LOCAL_FILE_EXTENSIONS }],
      });
  if (typeof selected !== "string") return;

  targetInput.value = selected;
  if (!nameInput.value.trim()) {
    const filename = selected.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
      ?? (kind === "folder" ? "新文件夹" : "新入口");
    nameInput.value = kind === "folder" ? filename : filename.replace(/\.[^.]+$/, "");
  }
  formError.hidden = true;
}

async function saveFromForm(): Promise<void> {
  const name = nameInput.value.trim();
  const target = targetInput.value.trim();
  const kind = selectedShortcutKind();
  if (!name || !target) {
    formError.textContent = kind === "web"
      ? "请填写名称和完整网址。"
      : kind === "folder"
        ? "请填写名称并选择文件夹。"
        : "请填写名称并选择本地文件。";
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
    ...(existingIndex >= 0 && shortcuts[existingIndex].wakeDays !== undefined
      ? { wakeDays: shortcuts[existingIndex].wakeDays }
      : {}),
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
    renderChecklists();
    offerUndo(`已移除 ${removed.name}`, async () => {
      if (shortcuts.some((shortcut) => shortcut.id === removed.id)) return true;
      const before = shortcuts;
      shortcuts = [...shortcuts];
      shortcuts.splice(Math.min(index, shortcuts.length), 0, removed);
      try { await persist(); render(); renderChecklists(); return true; }
      catch (error) { shortcuts = before; showToast(errorMessage(error), true); return false; }
    });
  } catch (error) {
    shortcuts = previous;
    formError.textContent = errorMessage(error);
    formError.hidden = false;
  }
}

function openScheduleEditor(shortcut: AppShortcut): void {
  scheduledShortcutId = shortcut.id;
  scheduleAppName.textContent = shortcut.name;
  const selectedDays = shortcut.wakeDays
    ?? (shortcut.sleeping ? [] : WEEKDAYS.map(({ value }) => value));
  scheduleDayInputs.forEach((input) => {
    input.checked = selectedDays.includes(Number(input.value));
  });
  scheduleRemoveButton.hidden = shortcut.wakeDays === undefined;
  scheduleDialog.showModal();
  window.setTimeout(() => scheduleDayInputs[0]?.focus(), 0);
}

function closeScheduleEditor(): void {
  scheduleDialog.close();
  scheduleButton.focus();
}

async function saveSchedule(): Promise<void> {
  const index = shortcuts.findIndex((shortcut) => shortcut.id === scheduledShortcutId);
  if (index < 0) return;
  const previous = shortcuts;
  const wakeDays = scheduleDayInputs
    .filter((input) => input.checked)
    .map((input) => Number(input.value));
  const current = shortcuts[index];
  shortcuts = shortcuts.map((shortcut, shortcutIndex) =>
    shortcutIndex === index ? { ...shortcut, wakeDays } : shortcut,
  );

  try {
    await persist();
    closeScheduleEditor();
    render();
    showToast(`${current.name} 的作息已保存，下次打开时生效`);
  } catch (error) {
    shortcuts = previous;
    showToast(errorMessage(error), true);
  }
}

async function removeSchedule(): Promise<void> {
  const index = shortcuts.findIndex((shortcut) => shortcut.id === scheduledShortcutId);
  if (index < 0) return;
  const previous = shortcuts;
  const current = shortcuts[index];
  const next = { ...current };
  delete next.wakeDays;
  shortcuts = shortcuts.map((shortcut, shortcutIndex) => shortcutIndex === index ? next : shortcut);

  try {
    await persist();
    closeScheduleEditor();
    render();
    showToast(`已取消 ${current.name} 的作息`);
  } catch (error) {
    shortcuts = previous;
    showToast(errorMessage(error), true);
  }
}

function installedCandidateIdentity(candidate: InstalledAppCandidate): string | null {
  if (!candidate.kind || !candidate.target) return null;
  return `${candidate.kind}:${candidate.target.trim().toLowerCase()}`;
}

function existingShortcutIdentities(): Set<string> {
  return new Set(shortcuts.map((shortcut) =>
    `${shortcutKind(shortcut)}:${shortcut.target.trim().toLowerCase()}`));
}

function visibleInstalledAppCandidates(): InstalledAppCandidate[] {
  const query = installedAppsSearchInput.value.trim().toLocaleLowerCase("zh-CN");
  if (!query) return installedAppCandidates;
  return installedAppCandidates.filter((candidate) =>
    [candidate.name, candidate.publisher ?? "", candidate.version ?? ""]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(query)));
}

function renderInstalledApps(): void {
  if (installedAppsLoading) {
    const loading = document.createElement("div");
    loading.className = "installed-apps-loading";
    loading.textContent = "正在整理本机应用…";
    installedAppsList.replaceChildren(loading);
    installedAppsList.setAttribute("aria-busy", "true");
    installedAppsResultCount.textContent = "";
    installedAppsSelection.textContent = "尚未选择";
    installedAppsSelectAll.disabled = true;
    installedAppsClear.disabled = true;
    installedAppsImport.disabled = true;
    return;
  }

  installedAppsList.setAttribute("aria-busy", "false");
  if (installedAppsLoadError) {
    const empty = document.createElement("div");
    empty.className = "installed-apps-empty";
    empty.textContent = "暂时无法读取本机应用。";
    installedAppsList.replaceChildren(empty);
    installedAppsResultCount.textContent = "读取未完成";
    installedAppsStatus.textContent = installedAppsLoadError;
    installedAppsSelection.textContent = "尚未选择";
    installedAppsSelectAll.disabled = true;
    installedAppsClear.disabled = true;
    installedAppsImport.disabled = true;
    return;
  }
  const previousScrollTop = installedAppsList.scrollTop;
  const existing = existingShortcutIdentities();
  const visible = visibleInstalledAppCandidates();
  installedAppsResultCount.textContent = `${visible.length} 个应用`;

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "installed-apps-empty";
    empty.textContent = installedAppCandidates.length ? "没有找到相符的应用。" : "没有读取到可显示的应用。";
    installedAppsList.replaceChildren(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (const candidate of visible) {
      const identity = installedCandidateIdentity(candidate);
      const alreadyAdded = identity ? existing.has(identity) : false;
      const selectable = Boolean(identity) && !alreadyAdded;
      const row = document.createElement("label");
      row.className = "installed-app-row";
      if (!selectable) row.classList.add("is-unavailable");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedInstalledAppIds.has(candidate.id);
      checkbox.disabled = !selectable || installedAppsImporting;
      checkbox.setAttribute("aria-label", `选择 ${candidate.name}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          const remaining = Math.max(0, MAX_SHORTCUTS - shortcuts.length);
          if (selectedInstalledAppIds.size >= remaining) {
            checkbox.checked = false;
            installedAppsStatus.textContent = `常用入口最多可保存 ${MAX_SHORTCUTS} 个。`;
            return;
          }
          selectedInstalledAppIds.add(candidate.id);
        } else {
          selectedInstalledAppIds.delete(candidate.id);
        }
        installedAppsStatus.textContent = "";
        renderInstalledApps();
      });

      const iconHolder = document.createElement("span");
      iconHolder.className = "installed-app-row-icon";
      iconHolder.append(icon("app"));

      const copy = document.createElement("span");
      copy.className = "installed-app-row-copy";
      const name = document.createElement("strong");
      name.textContent = candidate.name;
      const details = document.createElement("small");
      const source = candidate.source === "store" ? "Microsoft Store" : "桌面应用";
      details.textContent = [candidate.publisher, candidate.version, source].filter(Boolean).join(" · ");
      copy.append(name, details);

      const state = document.createElement("span");
      state.className = "installed-app-row-state";
      state.textContent = alreadyAdded ? "已加入" : identity ? "" : "暂无启动入口";
      row.append(checkbox, iconHolder, copy, state);
      fragment.append(row);
    }
    installedAppsList.replaceChildren(fragment);
  }

  const selectableVisible = visible.filter((candidate) => {
    const identity = installedCandidateIdentity(candidate);
    return identity && !existing.has(identity);
  });
  const unavailable = installedAppCandidates.filter((candidate) => !installedCandidateIdentity(candidate)).length;
  installedAppsStatus.textContent = unavailable
    ? `${unavailable} 个系统记录未提供可靠的启动入口，暂不支持导入。`
    : "";
  installedAppsSelection.textContent = selectedInstalledAppIds.size
    ? `已选择 ${selectedInstalledAppIds.size} 个`
    : "尚未选择";
  installedAppsSelectAll.disabled = installedAppsImporting
    || selectableVisible.every((candidate) => selectedInstalledAppIds.has(candidate.id));
  installedAppsClear.disabled = installedAppsImporting || selectedInstalledAppIds.size === 0;
  installedAppsImport.disabled = installedAppsImporting || selectedInstalledAppIds.size === 0;
  installedAppsImport.textContent = installedAppsImporting ? "正在导入…" : "导入睡眠区";
  installedAppsList.scrollTop = previousScrollTop;
}

async function openInstalledAppsDialog(): Promise<void> {
  closeSettings();
  selectedInstalledAppIds.clear();
  installedAppCandidates = [];
  installedAppsSearchInput.value = "";
  installedAppsStatus.textContent = "";
  installedAppsLoadError = "";
  installedAppsLoading = true;
  installedAppsDialog.showModal();
  renderInstalledApps();
  try {
    installedAppCandidates = await invoke<InstalledAppCandidate[]>("list_installed_apps");
  } catch (error) {
    installedAppsLoadError = errorMessage(error);
  } finally {
    installedAppsLoading = false;
    renderInstalledApps();
    window.setTimeout(() => installedAppsSearchInput.focus(), 0);
  }
}

function closeInstalledAppsDialog(): void {
  if (installedAppsImporting) return;
  installedAppsDialog.close();
  installedAppsSettingButton.focus();
}

function selectAllVisibleInstalledApps(): void {
  const existing = existingShortcutIdentities();
  let availableSlots = Math.max(0, MAX_SHORTCUTS - shortcuts.length - selectedInstalledAppIds.size);
  for (const candidate of visibleInstalledAppCandidates()) {
    const identity = installedCandidateIdentity(candidate);
    if (!identity || existing.has(identity) || selectedInstalledAppIds.has(candidate.id)) continue;
    if (availableSlots <= 0) break;
    selectedInstalledAppIds.add(candidate.id);
    availableSlots -= 1;
  }
  if (availableSlots === 0 && MAX_SHORTCUTS - shortcuts.length > 0) {
    renderInstalledApps();
    installedAppsStatus.textContent = `已达到 ${MAX_SHORTCUTS} 个入口的上限。`;
    return;
  }
  renderInstalledApps();
}

async function importSelectedInstalledApps(): Promise<void> {
  if (installedAppsImporting || !selectedInstalledAppIds.size) return;
  const existing = existingShortcutIdentities();
  const selected = installedAppCandidates.filter((candidate) => {
    const identity = installedCandidateIdentity(candidate);
    return selectedInstalledAppIds.has(candidate.id) && identity && !existing.has(identity);
  });
  const remaining = Math.max(0, MAX_SHORTCUTS - shortcuts.length);
  if (!selected.length || remaining === 0) {
    installedAppsStatus.textContent = remaining === 0
      ? `常用入口最多可保存 ${MAX_SHORTCUTS} 个。`
      : "所选应用已经加入常用入口。";
    return;
  }

  const additions: AppShortcut[] = selected.slice(0, remaining).map((candidate) => ({
    id: crypto.randomUUID(),
    name: candidate.name,
    target: candidate.target!,
    icon: inferIcon(candidate.name, candidate.target!, candidate.kind!),
    kind: candidate.kind!,
    sleeping: true,
  }));
  const previous = shortcuts;
  installedAppsImporting = true;
  renderInstalledApps();
  shortcuts = [...shortcuts, ...additions];
  try {
    await persist();
    sleepExpanded = true;
    installedAppsImporting = false;
    installedAppsDialog.close();
    render();
    void hydrateAppIcons(additions);
    showToast(`已将 ${additions.length} 个应用放入睡眠区`);
  } catch (error) {
    shortcuts = previous;
    installedAppsImporting = false;
    installedAppsStatus.textContent = errorMessage(error);
    renderInstalledApps();
  }
}

function openSettings(): void {
  settingsBackdrop.hidden = false;
  settingsPanel.classList.add("is-open");
  settingsPanel.setAttribute("aria-hidden", "false");
  settingsButton.setAttribute("aria-expanded", "true");
  window.setTimeout(() => workspaceSettingButton.focus(), 0);
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
  setSettingsEditor(workspaceSettingButton, workspaceEditor, false);
  setSettingsEditor(anniversarySettingButton, anniversaryEditor, false);
  setSettingsEditor(bulkSettingButton, bulkEditor, false);
  setSettingsEditor(themeSettingButton, themeEditor, false);
  setSettingsEditor(startupSettingButton, startupEditor, false);
  settingsButton.focus();
}

function closeOtherSettingsEditors(except: "workspace" | "anniversary" | "bulk" | "theme" | "startup"): void {
  if (except !== "workspace") setSettingsEditor(workspaceSettingButton, workspaceEditor, false);
  if (except !== "anniversary") setSettingsEditor(anniversarySettingButton, anniversaryEditor, false);
  if (except !== "bulk") setSettingsEditor(bulkSettingButton, bulkEditor, false);
  if (except !== "theme") setSettingsEditor(themeSettingButton, themeEditor, false);
  if (except !== "startup") setSettingsEditor(startupSettingButton, startupEditor, false);
}

function toggleWorkspaceEditor(): void {
  const opening = !workspaceEditor.classList.contains("is-open");
  closeOtherSettingsEditors("workspace");
  setSettingsEditor(workspaceSettingButton, workspaceEditor, opening);
  if (opening) window.setTimeout(() => workspaceVisibilityButtons[0]?.focus(), 0);
}

function toggleAnniversaryEditor(): void {
  const opening = !anniversaryEditor.classList.contains("is-open");
  closeOtherSettingsEditors("anniversary");
  setSettingsEditor(anniversarySettingButton, anniversaryEditor, opening);
  anniversaryError.hidden = true;
  if (opening) {
    anniversaryInput.max = isoDateForInput();
    anniversaryNameInput.value = settings.anniversaryName;
    anniversaryInput.value = settings.anniversaryDate ?? "";
    window.setTimeout(() => {
      anniversaryNameInput.focus();
      anniversaryNameInput.select();
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
  themeToggle.disabled = true;
  try {
    await saveSettingsPatch({ theme: effectiveTheme() === "dark" ? "light" : "dark" });
    renderThemeSetting();
    showToast(settings.theme === "dark" ? "已切换至深色模式" : "已切换至浅色模式");
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    themeToggle.disabled = false;
  }
}

function renderStartupSetting(): void {
  startupToggle.setAttribute("aria-pressed", String(settings.launchOnStartup));
}

async function toggleStartup(): Promise<void> {
  startupToggle.disabled = true;
  try {
    await saveSettingsPatch({ launchOnStartup: !settings.launchOnStartup });
    renderStartupSetting();
    showToast(settings.launchOnStartup ? "已开启开机自启" : "已关闭开机自启");
  } catch (error) {
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
  try {
    await saveSettingsPatch({ hasCompletedWelcome: true });
  } catch (error) {
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

async function checkForUpdates(manual = false): Promise<void> {
  if (updateCheckPending || (!manual && updateCheckStarted)) return;
  updateCheckStarted = true;
  if (manual && availableUpdate) { showAvailableUpdate(); return; }
  updateCheckPending = true;
  const button = element<HTMLButtonElement>("check-update-button");
  const status = element<HTMLElement>("settings-update-status");
  button.disabled = true;
  if (manual) status.textContent = "正在检查…";
  try {
    const update = await check({ timeout: 12_000 });
    if (!update) { if (manual) status.textContent = "已是最新版本"; return; }
    availableUpdate = update;
    settingsButton.classList.add("has-update");
    settingsButton.setAttribute("aria-label", "打开设置，有新版本可用");
    button.textContent = "查看更新";
    status.textContent = `Serenook ${update.version} 已可更新`;
    if (manual) showAvailableUpdate();
  } catch (error) {
    console.info("Update check unavailable", error);
    if (manual) status.textContent = "暂时无法连接，请稍后重试。";
  } finally {
    updateCheckPending = false;
    button.disabled = false;
  }
}

function showAvailableUpdate(): void {
  if (!availableUpdate) return;
  updateVersion.textContent = `Serenook ${availableUpdate.version}`;
  renderUpdateNotes(availableUpdate.body?.trim() || "这一版带来了一些安静而细小的改进。");
  updateStatus.textContent = "";
  updateInstallButton.disabled = false;
  updateLaterButton.disabled = false;
  updateDialog.showModal();
}

function openSearch(): void {
  if (searchDialog.open) { searchDialog.close(); return; }
  if (document.querySelector("dialog[open]") || welcomeOpen) return;
  closeSettings();
  if (guideView.classList.contains("is-open")) closeGuide();
  searchInput.value = "";
  renderSearchResults();
  searchDialog.showModal();
  searchInput.focus();
}

function renderSearchResults(): void {
  const query = searchInput.value.normalize("NFKC").trim().toLocaleLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  searchResults.replaceChildren();
  if (!terms.length) { element<HTMLElement>("search-status").textContent = ""; return; }
  const matches = (text: string) => terms.every((term) => text.normalize("NFKC").toLocaleLowerCase().includes(term));
  const results: { title: string; detail: string; kind: string; action: () => void | Promise<void> }[] = [];
  for (const shortcut of shortcuts) if (matches(`${shortcut.name} ${shortcut.target}`)) results.push({
    title: shortcut.name, detail: shortcut.sleeping ? "常用入口 · 睡眠中" : "常用入口", kind: "folder",
    action: () => launch(shortcut),
  });
  for (const list of checklists) for (const task of list.tasks) if (matches(`${list.name} ${task.content}`)) results.push({
    title: task.content, detail: `${list.name}${list.archived ? " · 已收存" : ""} · ${task.completed ? "已完成" : "未完成"}`, kind: "checklist",
    action: async () => {
      if (!await revealWorkspaceModule("checklists")) return;
      collapsedCompleted.delete(list.id);
      editingChecklistId = null;
      openChecklistFocus(list.id);
      window.requestAnimationFrame(() => {
        const row = checklistFocusContent.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(task.id)}"]`);
        row?.scrollIntoView({ block: "center" });
        row?.classList.add("search-highlight");
      });
    },
  });
  for (const entry of orderedDiaries()) if (matches(`${entry.title} ${entry.content}`)) {
    results.push({ title: entry.title, detail: `${formatDiaryTimestamp(entry.createdAt).slice(0, 10)} · ${textExcerpt(entry.content, locateText(entry.content, terms))}`, kind: "book",
      action: async () => {
        if (!await revealWorkspaceModule("diaries")) return;
        diaryMonth = diaryMonthKey(entry);
        renderDiaries();
        const card = diaryGrid.querySelector<HTMLElement>(`[data-diary-id="${CSS.escape(entry.id)}"]`);
        if (card) openDiaryReader(entry, card, terms);
      },
    });
  }
  if (scratchpadEditor.content && matches(scratchpadEditor.content)) results.push({
    title: "随手记", detail: textExcerpt(scratchpadEditor.content, locateText(scratchpadEditor.content, terms)), kind: "document",
    action: async () => {
      if (!await revealWorkspaceModule("scratchpad")) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        element<HTMLElement>("scratchpad-input").scrollIntoView({ block: "center" });
        scratchpadEditor.reveal(terms);
      }));
    },
  });
  element<HTMLElement>("search-status").textContent = results.length ? `${results.length} 项结果${results.length > 40 ? " · 显示前 40 项，可继续细化关键词" : ""}` : "还没有找到，试试另一个关键词。";
  for (const result of results.slice(0, 40)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    title.textContent = result.title;
    detail.textContent = result.detail;
    copy.append(title, detail);
    button.append(icon(result.kind), copy);
    button.addEventListener("click", () => { searchDialog.close(); void result.action(); });
    searchResults.append(button);
  }
}

async function openBackupDialog(): Promise<void> {
  selectedBackup = null;
  element<HTMLElement>("backup-preview").hidden = true;
  element<HTMLElement>("backup-status").textContent = "";
  backupDialog.showModal();
  const list = element<HTMLElement>("backup-list");
  list.replaceChildren();
  try {
    const backups = await invoke<BackupSummary[]>("list_backups");
    if (!backups.length) { list.textContent = "记录变更时会自动建立备份。"; return; }
    for (const backup of backups) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "backup-row";
      const date = document.createElement("span");
      date.textContent = formatDiaryTimestamp(new Date(backup.createdAt).toISOString());
      const count = document.createElement("small");
      count.textContent = `${backup.shortcuts} 个入口 · ${backup.checklists} 张清单 · ${backup.diaries} 篇日记`
        + (backup.scratchpadCharacters == null ? "" : ` · 随手记 ${backup.scratchpadCharacters} 字`);
      button.append(date, count);
      button.addEventListener("click", () => previewBackup(backup));
      list.append(button);
    }
  } catch (error) { element<HTMLElement>("backup-status").textContent = errorMessage(error); }
}

function previewBackup(backup: BackupSummary): void {
  selectedBackup = backup.path;
  element<HTMLElement>("backup-preview").hidden = false;
  element<HTMLElement>("backup-preview-copy").textContent = `${formatDiaryTimestamp(new Date(backup.createdAt).toISOString())}：${backup.shortcuts} 个入口、${backup.checklists} 张清单、${backup.diaries} 篇日记、${backup.drafts} 份草稿。`
    + (backup.scratchpadCharacters == null ? "旧备份不含随手记，将保留当前页。" : `随手记 ${backup.scratchpadCharacters} 字，将替换当前页。`);
  element<HTMLElement>("backup-preview").scrollIntoView({ block: "nearest" });
}

async function exportWorkspaceBackup(): Promise<void> {
  try {
    const path = await save({ defaultPath: `Serenook-${localDateKey()}.json`, filters: [{ name: "Serenook 备份", extensions: ["json"] }] });
    if (!path) return;
    await flushWorkspaceEdits();
    await invoke("export_backup", { path });
    element<HTMLElement>("backup-status").textContent = "备份已导出";
  } catch (error) { element<HTMLElement>("backup-status").textContent = errorMessage(error); }
}

async function selectWorkspaceBackup(): Promise<void> {
  try {
    const path = await open({ multiple: false, filters: [{ name: "Serenook 备份", extensions: ["json"] }] });
    if (typeof path === "string") previewBackup(await invoke<BackupSummary>("inspect_backup", { path }));
  } catch (error) { selectedBackup = null; element<HTMLElement>("backup-preview").hidden = true; element<HTMLElement>("backup-status").textContent = errorMessage(error); }
}

async function restoreWorkspaceBackup(): Promise<void> {
  if (!selectedBackup || restoringBackup) return;
  restoringBackup = true;
  const controls = [...backupDialog.querySelectorAll<HTMLButtonElement>("button")];
  controls.forEach((button) => { button.disabled = true; });
  try {
    await flushWorkspaceEdits();
    await invoke("restore_backup", { path: selectedBackup });
    localStorage.removeItem("serenook-drafts-v1");
    window.location.reload();
  } catch (error) {
    restoringBackup = false;
    controls.forEach((button) => { button.disabled = false; });
    element<HTMLElement>("backup-status").textContent = errorMessage(error);
  }
}

function renderUpdateNotes(notes: string): void {
  const content: HTMLElement[] = [];
  let list: HTMLUListElement | undefined;

  for (const sourceLine of notes.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const line = sourceLine.replace(/\\$/, "");
    const listItem = line.match(/^[•*-]\s*(.+)$/)?.[1];
    if (listItem) {
      if (!list) {
        list = document.createElement("ul");
        list.className = "update-note-list";
        content.push(list);
      }
      const item = document.createElement("li");
      item.className = "update-note-line";
      item.textContent = listItem;
      list.append(item);
      continue;
    }

    list = undefined;
    const copy = document.createElement("p");
    const plainLine = line.replace(/^#{1,6}\s+/, "");
    copy.className = /^(更新内容|本次更新)[:：]?$/.test(plainLine)
      ? "update-note-heading"
      : "update-note-copy";
    copy.textContent = plainLine;
    content.push(copy);
  }

  updateNotes.replaceChildren(...content);
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
    await flushWorkspaceEdits();
    await availableUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength ?? 0;
        updateStatus.textContent = "正在准备更新…";
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (contentLength > 0) {
          const progress = Math.min(100, Math.round((downloaded / contentLength) * 100));
          updateStatus.textContent = `正在下载 ${progress}%`;
        }
      } else if (event.event === "Finished") {
        updateStatus.textContent = "更新就绪，正在重启…";
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

async function saveAnniversary(): Promise<void> {
  const anniversaryName = anniversaryNameInput.value.trim();
  if (!new RegExp(`^[A-Za-z]{1,${MAX_ANNIVERSARY_NAME_LENGTH}}$`).test(anniversaryName)) {
    anniversaryError.textContent = `名称请使用 1–${MAX_ANNIVERSARY_NAME_LENGTH} 个英文字母。`;
    anniversaryError.hidden = false;
    return;
  }
  const anniversaryDate = anniversaryInput.value;
  const instant = calendarDateInstant(anniversaryDate);
  const today = calendarDateInstant(isoDateForInput());
  if (instant === null || today === null || instant > today) {
    anniversaryError.textContent = "请选择一个不晚于今天的真实日期。";
    anniversaryError.hidden = false;
    return;
  }

  try {
    await saveSettingsPatch({ anniversaryDate, anniversaryName });
    setSettingsEditor(anniversarySettingButton, anniversaryEditor, false);
    const message = anniversaryMessage();
    if (message) transitionFooterMessage(message);
    scheduleGreetingUpdate();
    showToast(`${anniversaryName} 的第一天已经记下`);
  } catch (error) {
    anniversaryError.textContent = errorMessage(error);
    anniversaryError.hidden = false;
  }
}

function anniversaryMessage(): string | null {
  const days = anniversaryDayCount();
  return settings.anniversaryDate && days !== null
    ? `${settings.anniversaryName} Days: ${days}天`
    : null;
}

function placeFooterMessage(message: string, animate: boolean): void {
  footerName.textContent = message;
  footerName.setAttribute("x", "85");
  footerName.setAttribute("text-anchor", "middle");
  footerName.classList.remove("is-leaving", "is-opening", "is-pending");
  footerName.classList.add("is-message");
  footerName.classList.toggle("is-entering", animate);
  footerName.classList.add("is-anniversary-message");
  footerName.classList.toggle("is-compact-message", [...message].length > 18);
  footerNameFlourish.classList.remove("is-leaving", "is-pending");
  footerNameFlourish.classList.add("is-hidden");
  footerDrawing.setAttribute("aria-label", `一本打开的书、一株新芽和手写字样 ${message}`);
}

function initializeFooterSignature(): void {
  const message = anniversaryMessage();
  if (!message) {
    footerName.textContent = "JuvenileScholar";
    footerName.classList.remove(
      "is-message",
      "is-anniversary-message",
      "is-compact-message",
      "is-entering",
      "is-leaving",
      "is-opening",
      "is-pending",
    );
    footerNameFlourish.classList.remove("is-hidden", "is-leaving", "is-pending");
    footerDrawing.setAttribute("aria-label", "一本打开的书、一株新芽和 JuvenileScholar 手写署名");
    return;
  }

  footerName.textContent = message;
  footerName.classList.remove("is-entering", "is-leaving", "is-pending");
  footerName.classList.add("is-message", "is-anniversary-message", "is-opening");
  footerName.classList.toggle("is-compact-message", [...message].length > 18);
  footerNameFlourish.classList.remove("is-leaving", "is-pending");
  footerNameFlourish.classList.add("is-hidden");
  footerDrawing.setAttribute("aria-label", `一本打开的书、一株新芽和手写字样 ${message}`);
}

function transitionFooterMessage(message: string): void {
  window.clearTimeout(footerSignatureTimer);
  footerName.classList.remove("is-opening", "is-entering");
  footerName.classList.add("is-leaving");
  footerNameFlourish.classList.add("is-leaving");

  const swapDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 720;
  footerSignatureTimer = window.setTimeout(() => {
    placeFooterMessage(message, true);
    footerSignatureTimer = undefined;
  }, swapDelay);
}

function playPlantBloom(): void {
  window.clearTimeout(plantBloomTimer);
  anniversaryPlant.classList.remove("is-blooming");
  void anniversaryPlant.offsetWidth;
  anniversaryPlant.classList.add("is-blooming");
  plantBloomTimer = window.setTimeout(() => {
    anniversaryPlant.classList.remove("is-blooming");
    plantBloomTimer = undefined;
  }, 1_600);
}

async function initialize(): Promise<void> {
  hydrateStaticIcons();
  void getVersion().then((version) => { element<HTMLElement>("settings-version").textContent = `Serenook ${version}`; });
  const [appsResult, settingsResult, checklistsResult, diariesResult] = await Promise.allSettled([
    invoke<AppShortcut[]>("load_apps"),
    invoke<AppSettings>("load_settings"),
    invoke<Checklist[]>("load_checklists"),
    invoke<DiaryEntry[]>("load_diaries"),
  ]);

  if (appsResult.status === "fulfilled") shortcuts = applyWeeklySchedules(appsResult.value, new Date().getDay());
  else showToast(errorMessage(appsResult.reason), true);

  if (settingsResult.status === "fulfilled") {
    settings = {
      ...settingsResult.value,
      anniversaryDate: settingsResult.value.anniversaryDate ?? null,
      anniversaryName: settingsResult.value.anniversaryName?.trim() || DEFAULT_ANNIVERSARY_NAME,
      workspaceOrder: normalizeWorkspaceOrder(settingsResult.value.workspaceOrder),
      collapsedModules: normalizeModuleSelection(settingsResult.value.collapsedModules),
      hiddenModules: normalizeModuleSelection(settingsResult.value.hiddenModules),
    };
  }
  else showToast(errorMessage(settingsResult.reason), true);

  initializeFooterSignature();

  if (checklistsResult.status === "fulfilled") checklists = checklistsResult.value;
  else showToast(errorMessage(checklistsResult.reason), true);

  if (diariesResult.status === "fulfilled") diaries = diariesResult.value;
  else showToast(errorMessage(diariesResult.reason), true);
  await loadDiaryDrafts().catch((error) => showToast(errorMessage(error), true));
  await scratchpadEditor.initialize();
  new MusicCompanion(element<HTMLElement>("music-card"), () => isWorkspaceModuleActive("music"));

  const checklistsBeforeReset = checklists;
  const checklistResetNeeded = applyDailyChecklistResets();

  applyWorkspaceOrder();
  scheduleGreetingUpdate();
  scheduleDailyQuoteUpdate();
  render();
  renderChecklists();
  renderDiaries();
  renderStartupSetting();
  requestAnimationFrame(() => scratchpadEditor.restoreView());
  renderThemeSetting();
  if (checklistResetNeeded) await persistChecklistChanges(checklistsBeforeReset);
  scheduleChecklistReset();
  if (!settings.hasCompletedWelcome) await openWelcomeOnce();
  void hydrateAppIcons(shortcuts);
  await refreshRunningApps(true);
  runningPollTimer = window.setInterval(() => void refreshRunningApps(), RUNNING_POLL_INTERVAL_MS);
  if (!welcomeOpen) window.setTimeout(() => void checkForUpdates(), 4_000);
}

editButton.addEventListener("click", () => {
  editing = !editing;
  if (editing) scheduling = false;
  render();
});
element<HTMLButtonElement>("search-button").addEventListener("click", openSearch);
element<HTMLButtonElement>("search-close-button").addEventListener("click", () => searchDialog.close());
searchInput.addEventListener("input", renderSearchResults);
searchDialog.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  const buttons = [...searchResults.querySelectorAll<HTMLButtonElement>("button")];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowDown") { event.preventDefault(); buttons[Math.min(index + 1, buttons.length - 1)]?.focus(); }
  if (event.key === "ArrowUp") { event.preventDefault(); if (index <= 0) searchInput.focus(); else buttons[index - 1]?.focus(); }
  if (event.key === "Enter" && document.activeElement === searchInput) { event.preventDefault(); buttons[0]?.click(); }
});
element<HTMLButtonElement>("checklist-focus-close").addEventListener("click", closeChecklistFocus);
checklistFocusDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeChecklistFocus(); });
element<HTMLButtonElement>("task-link-close").addEventListener("click", () => taskLinkDialog.close());
element<HTMLButtonElement>("task-link-save").addEventListener("click", () => void saveTaskLink());
diaryTitleInput.addEventListener("input", scheduleDraftSave);
diaryContentInput.addEventListener("input", scheduleDraftSave);
element<HTMLButtonElement>("diary-draft-resume").addEventListener("click", () => {
  const latest = [...drafts].sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
  if (!latest) return;
  const entry = diaries.find((candidate) => candidate.id === latest.entryId);
  openDiaryDialog(entry);
  // A draft whose original entry was removed can be saved as a new page.
  if (latest.entryId && !entry) {
    diaryDraftKey = latest.entryId;
    diaryTitleInput.value = latest.title;
    diaryContentInput.value = latest.content;
    resetDiscardDraftButton();
  }
});
diaryMonthSelect.addEventListener("change", () => { diaryMonth = diaryMonthSelect.value; renderDiaries(); });
element<HTMLButtonElement>("diary-month-previous").addEventListener("click", () => changeDiaryMonth(1));
element<HTMLButtonElement>("diary-month-next").addEventListener("click", () => changeDiaryMonth(-1));
element<HTMLButtonElement>("diary-reader-previous").addEventListener("click", () => turnDiaryPage(-1));
element<HTMLButtonElement>("diary-reader-next").addEventListener("click", () => turnDiaryPage(1));
element<HTMLButtonElement>("diary-export-button").addEventListener("click", () => void exportCurrentDiary());
diaryReaderDialog.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") { event.preventDefault(); turnDiaryPage(-1); }
  if (event.key === "ArrowRight") { event.preventDefault(); turnDiaryPage(1); }
});
element<HTMLButtonElement>("backup-setting-button").addEventListener("click", () => void openBackupDialog());
element<HTMLButtonElement>("backup-close").addEventListener("click", () => { if (!restoringBackup) backupDialog.close(); });
backupDialog.addEventListener("cancel", (event) => { if (restoringBackup) event.preventDefault(); });
element<HTMLButtonElement>("backup-export").addEventListener("click", () => void exportWorkspaceBackup());
element<HTMLButtonElement>("backup-import").addEventListener("click", () => void selectWorkspaceBackup());
element<HTMLButtonElement>("backup-restore").addEventListener("click", () => void restoreWorkspaceBackup());
installedAppsSettingButton.addEventListener("click", () => void openInstalledAppsDialog());
element<HTMLButtonElement>("installed-apps-close").addEventListener("click", closeInstalledAppsDialog);
element<HTMLButtonElement>("installed-apps-cancel").addEventListener("click", closeInstalledAppsDialog);
installedAppsDialog.addEventListener("cancel", (event) => {
  if (installedAppsImporting) event.preventDefault();
});
installedAppsSearchInput.addEventListener("input", renderInstalledApps);
installedAppsSelectAll.addEventListener("click", selectAllVisibleInstalledApps);
installedAppsClear.addEventListener("click", () => {
  selectedInstalledAppIds.clear();
  installedAppsStatus.textContent = "";
  renderInstalledApps();
});
installedAppsImport.addEventListener("click", () => void importSelectedInstalledApps());
element<HTMLButtonElement>("check-update-button").addEventListener("click", () => void checkForUpdates(true));
shortcutsModuleToggle.addEventListener("click", () => void toggleWorkspaceModule("shortcuts"));
checklistsModuleToggle.addEventListener("click", () => void toggleWorkspaceModule("checklists"));
diariesModuleToggle.addEventListener("click", () => void toggleWorkspaceModule("diaries"));
element<HTMLButtonElement>("scratchpad-module-toggle").addEventListener("click", () => void toggleWorkspaceModule("scratchpad"));
element<HTMLButtonElement>("music-module-toggle").addEventListener("click", () => void toggleWorkspaceModule("music"));
document.querySelectorAll<HTMLButtonElement>(".module-drag-handle").forEach((handle) => {
  handle.addEventListener("pointerdown", beginModuleDrag);
});
window.addEventListener("pointermove", (event) => {
  moveModuleDrag(event);
  moveChecklistCardDrag(event);
  moveChecklistTaskDrag(event);
  moveShortcutCardDrag(event);
});
window.addEventListener("pointerup", (event) => {
  void finishModuleDrag(event);
  void finishChecklistCardDrag(event);
  void finishChecklistTaskDrag(event);
  void finishShortcutCardDrag(event);
});
window.addEventListener("pointercancel", (event) => {
  cancelModuleDrag(event);
  cancelChecklistCardDrag(event);
  cancelChecklistTaskDrag(event);
  cancelShortcutCardDrag(event);
});
scheduleButton.addEventListener("click", () => {
  scheduling = !scheduling;
  if (scheduling) {
    editing = false;
    sleepExpanded = true;
  }
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
workspaceSettingButton.addEventListener("click", toggleWorkspaceEditor);
for (const button of workspaceVisibilityButtons) {
  button.addEventListener("click", () => {
    const moduleId = button.dataset.workspaceVisibility;
    if (isWorkspaceModuleId(moduleId)) void toggleWorkspaceVisibility(moduleId);
  });
}
anniversarySettingButton.addEventListener("click", toggleAnniversaryEditor);
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
element<HTMLButtonElement>("anniversary-cancel-button").addEventListener("click", toggleAnniversaryEditor);
anniversaryNameInput.addEventListener("input", () => {
  const lettersOnly = anniversaryNameInput.value
    .replace(/[^A-Za-z]/g, "")
    .slice(0, MAX_ANNIVERSARY_NAME_LENGTH);
  if (lettersOnly !== anniversaryNameInput.value) {
    anniversaryNameInput.value = lettersOnly;
    anniversaryError.textContent = `名称仅支持 1–${MAX_ANNIVERSARY_NAME_LENGTH} 个英文字母。`;
    anniversaryError.hidden = false;
  } else {
    anniversaryError.hidden = true;
  }
});
anniversaryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveAnniversary();
});
element<HTMLButtonElement>("empty-add-button").addEventListener("click", () => openEditor());
addChecklistButton.addEventListener("click", openChecklistDialog);
element<HTMLButtonElement>("stored-checklist-button").addEventListener("click", () => {
  renderStoredChecklists();
  element<HTMLDialogElement>("stored-checklist-dialog").showModal();
});
element<HTMLButtonElement>("stored-checklist-close").addEventListener("click", () => element<HTMLDialogElement>("stored-checklist-dialog").close());
emptyChecklistAddButton.addEventListener("click", openChecklistDialog);
element<HTMLButtonElement>("checklist-dialog-close-button").addEventListener("click", closeChecklistDialog);
element<HTMLButtonElement>("checklist-cancel-button").addEventListener("click", closeChecklistDialog);
checklistForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void addChecklistFromForm();
});
addDiaryButton.addEventListener("click", () => openDiaryDialog());
emptyDiaryAddButton.addEventListener("click", () => openDiaryDialog());
element<HTMLButtonElement>("diary-dialog-close-button").addEventListener("click", () => closeDiaryDialog());
element<HTMLButtonElement>("diary-cancel-button").addEventListener("click", () => closeDiaryDialog());
element<HTMLButtonElement>("diary-discard-draft").addEventListener("click", () => void discardDiaryDraft());
diaryDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDiaryDialog(); });
diaryDeleteButton.addEventListener("click", () => void removeDiaryFromForm());
diaryTitleInput.addEventListener("input", resetDiaryDeleteConfirmation);
diaryContentInput.addEventListener("input", resetDiaryDeleteConfirmation);
diaryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveDiaryFromForm();
});
element<HTMLButtonElement>("diary-reader-close-button").addEventListener("click", closeDiaryReader);
diaryReaderDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDiaryReader();
});
diaryReaderDialog.addEventListener("click", (event) => {
  if (event.target === diaryReaderDialog) closeDiaryReader();
});
diaryReaderDialog.addEventListener("transitionend", (event) => {
  if (
    event.target === diaryReaderDialog
    && event.propertyName === "transform"
    && diaryReaderDialog.open
    && diaryReaderDialog.classList.contains("is-open")
    && !diaryReaderDialog.classList.contains("is-closing")
  ) {
    settleDiaryReader();
  }
});
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
element<HTMLButtonElement>("schedule-close-button").addEventListener("click", closeScheduleEditor);
element<HTMLButtonElement>("schedule-cancel-button").addEventListener("click", closeScheduleEditor);
scheduleRemoveButton.addEventListener("click", () => void removeSchedule());
scheduleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSchedule();
});
anniversaryPlant.addEventListener("click", playPlantBloom);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault(); openSearch(); return;
  }
  if (document.querySelector("dialog[open]")) return;
  if (event.key === "Escape" && welcomeOpen) completeWelcome(false);
  else if (event.key === "Escape" && settingsPanel.classList.contains("is-open")) closeSettings();
  else if (event.key === "Escape" && guideView.classList.contains("is-open")) closeGuide();
});
window.addEventListener("focus", () => {
  scheduleGreetingUpdate();
  scheduleDailyQuoteUpdate();
  void refreshDailyChecklists();
});
window.addEventListener("beforeunload", () => {
  window.clearInterval(runningPollTimer);
  window.clearTimeout(greetingTimer);
  window.clearTimeout(dailyQuoteTimer);
  window.clearTimeout(checklistResetTimer);
  window.clearTimeout(footerSignatureTimer);
  window.clearTimeout(plantBloomTimer);
  window.clearTimeout(diaryReaderCloseTimer);
  window.clearTimeout(diaryReaderSettleTimer);
});
element<HTMLButtonElement>("minimize-button").addEventListener("click", () => void appWindow.minimize());
element<HTMLButtonElement>("maximize-button").addEventListener("click", () => void appWindow.toggleMaximize());
element<HTMLButtonElement>("close-button").addEventListener("click", () => void appWindow.close());

void initialize();

let closingWindow = false;
void appWindow.onCloseRequested(async (event) => {
  if (closingWindow || diarySaving || restoringBackup) {
    event.preventDefault();
    showToast("正在保存，请稍候。", true);
    return;
  }
  closingWindow = true;
  try {
    await flushWorkspaceEdits();
    // The window API waits for this handler before finishing the close.
  } catch (error) {
    event.preventDefault();
    showToast(errorMessage(error), true);
  } finally { closingWindow = false; }
});
