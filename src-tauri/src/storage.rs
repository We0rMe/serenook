use crate::{
    config_directory, is_valid_utc_timestamp, validate_checklists, validate_diaries,
    validate_settings, validate_shortcuts, wide_string, AppSettings, AppShortcut, Checklist,
    DiaryEntry, MAX_DIARY_CONTENT_CHARACTERS, MAX_DIARY_TITLE_CHARACTERS,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use windows::{
    core::PCWSTR,
    Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
};

static STORAGE_LOCK: Mutex<()> = Mutex::new(());
const BACKUP_LIMIT: usize = 7;
const CHECKPOINT_INTERVAL_MS: u64 = 3_600_000;
const RECORD_FILES: [&str; 6] = [
    "shortcuts.json",
    "checklists.json",
    "diaries.json",
    "settings.json",
    "drafts.json",
    "scratchpad.json",
];

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Scratchpad {
    pub content: String,
}

impl Scratchpad {
    fn validate(&self) -> Result<(), String> {
        // Match textarea maxlength, including supplementary Unicode characters.
        if self.content.encode_utf16().count() > 50_000 {
            return Err("随手记最多保留 50,000 个字符。请先整理部分内容。".into());
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
struct RestoreJournal {
    files: Vec<(String, Option<Vec<u8>>)>,
}

impl RestoreJournal {
    fn capture(directory: &Path) -> Result<Self, String> {
        let files = RECORD_FILES
            .iter()
            .map(|name| {
                let bytes = match fs::read(directory.join(name)) {
                    Ok(bytes) => Some(bytes),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(format!("无法保留恢复前的记录：{error}")),
                };
                Ok((name.to_string(), bytes))
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self { files })
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiaryDraft {
    pub entry_id: Option<String>,
    pub title: String,
    pub content: String,
    pub saved_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBackup {
    format: String,
    version: u32,
    created_at: u64,
    shortcuts: Vec<AppShortcut>,
    checklists: Vec<Checklist>,
    diaries: Vec<DiaryEntry>,
    settings: AppSettings,
    drafts: Vec<DiaryDraft>,
    // Legacy backups have no scratchpad. Restoring those must leave the new page intact.
    #[serde(default)]
    scratchpad: Option<Scratchpad>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    path: String,
    created_at: u64,
    shortcuts: usize,
    checklists: usize,
    diaries: usize,
    drafts: usize,
    scratchpad_characters: Option<usize>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn read_or_default<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            format!(
                "{} 的内容无法读取，请先恢复备份。",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(format!("无法读取本地记录：{error}")),
    }
}

fn validate_drafts(drafts: &[DiaryDraft]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for draft in drafts {
        if !ids.insert(draft.entry_id.as_deref())
            || draft
                .entry_id
                .as_deref()
                .is_some_and(|id| id.trim().is_empty())
            || draft.title.chars().count() > MAX_DIARY_TITLE_CHARACTERS
            || draft.content.chars().count() > MAX_DIARY_CONTENT_CHARACTERS
            || !is_valid_utc_timestamp(&draft.saved_at)
        {
            return Err("草稿内容或时间无效。".into());
        }
    }
    Ok(())
}

impl WorkspaceBackup {
    fn migrate(&mut self) {
        let order = &mut self.settings.workspace_order;
        if order.len() == 3
            && ["shortcuts", "checklists", "diaries"]
                .iter()
                .all(|id| order.iter().any(|item| item == id))
        {
            order.push("scratchpad".into());
        }
        if order.len() == 4
            && ["shortcuts", "checklists", "diaries", "scratchpad"]
                .iter()
                .all(|id| order.iter().any(|item| item == id))
        {
            order.push("music".into());
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.format != "serenook-workspace" || self.version != 1 {
            return Err("这不是支持的 Serenook 备份文件。".into());
        }
        validate_shortcuts(&self.shortcuts)?;
        validate_checklists(&self.checklists)?;
        validate_diaries(&self.diaries)?;
        validate_settings(&self.settings)?;
        validate_drafts(&self.drafts)?;
        if let Some(page) = &self.scratchpad {
            page.validate()?;
        }
        Ok(())
    }

    fn summary(&self, path: &Path) -> BackupSummary {
        BackupSummary {
            path: path.to_string_lossy().into_owned(),
            created_at: self.created_at,
            shortcuts: self.shortcuts.len(),
            checklists: self.checklists.len(),
            diaries: self.diaries.len(),
            drafts: self.drafts.len(),
            scratchpad_characters: self
                .scratchpad
                .as_ref()
                .map(|page| page.content.chars().count()),
        }
    }
}

fn read_workspace(directory: &Path) -> Result<WorkspaceBackup, String> {
    let mut backup = WorkspaceBackup {
        format: "serenook-workspace".into(),
        version: 1,
        created_at: now_ms(),
        shortcuts: read_or_default(&directory.join("shortcuts.json"))?,
        checklists: read_or_default(&directory.join("checklists.json"))?,
        diaries: read_or_default(&directory.join("diaries.json"))?,
        settings: read_or_default(&directory.join("settings.json"))?,
        drafts: read_or_default(&directory.join("drafts.json"))?,
        scratchpad: Some(read_or_default(&directory.join("scratchpad.json"))?),
    };
    backup.migrate();
    backup.validate()?;
    Ok(backup)
}

fn read_backup(path: &Path) -> Result<WorkspaceBackup, String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取备份：{error}"))?;
    let mut backup: WorkspaceBackup =
        serde_json::from_slice(&bytes).map_err(|_| "备份文件格式无效。".to_string())?;
    backup.migrate();
    backup.validate()?;
    Ok(backup)
}

fn json_bytes(value: &impl Serialize) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(|error| format!("无法整理记录：{error}"))
}

// Sync the replacement before atomically replacing the existing file on Windows.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_extension(format!("serenook-{suffix}.pending"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let from = wide_string(temporary.as_os_str());
        let to = wide_string(path.as_os_str());
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(std::io::Error::other)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("无法保存本地记录：{error}"))
}

fn backup_paths(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let history = directory.join("backups");
    if !history.exists() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(history)
        .map_err(|error| format!("无法读取备份目录：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "json")
                && path
                    .file_stem()
                    .is_some_and(|stem| stem.to_string_lossy().starts_with("workspace-"))
        })
        .collect::<Vec<_>>();
    paths.sort_by(|a, b| b.cmp(a));
    Ok(paths)
}

fn checkpoint(directory: &Path, force: bool) -> Result<(), String> {
    let paths = backup_paths(directory)?;
    let latest = paths.iter().find_map(|path| read_backup(path).ok());
    if !force
        && latest.as_ref().is_some_and(|backup| {
            now_ms().saturating_sub(backup.created_at) < CHECKPOINT_INTERVAL_MS
        })
    {
        return Ok(());
    }
    let backup = read_workspace(directory)?;
    if !force {
        if let Some(previous) = latest {
            let mut current = serde_json::to_value(&backup).map_err(|error| error.to_string())?;
            let mut previous = serde_json::to_value(previous).map_err(|error| error.to_string())?;
            current.as_object_mut().unwrap().remove("createdAt");
            previous.as_object_mut().unwrap().remove("createdAt");
            if current == previous {
                return Ok(());
            }
        }
    }
    let history = directory.join("backups");
    fs::create_dir_all(&history).map_err(|error| format!("无法建立本地备份：{error}"))?;
    let path = history.join(format!("workspace-{}.json", backup.created_at));
    atomic_write(&path, &json_bytes(&backup)?)?;
    for stale in backup_paths(directory)?.into_iter().skip(BACKUP_LIMIT) {
        fs::remove_file(stale).map_err(|error| format!("无法整理旧备份：{error}"))?;
    }
    Ok(())
}

pub fn save_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let _guard = STORAGE_LOCK.lock().map_err(|_| "本地记录暂时不可用。")?;
    let directory = path.parent().ok_or("记录路径无效。")?;
    recover_unlocked(directory)?;
    let next: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "记录格式无效。")?;
    match fs::read(path) {
        Ok(current) => {
            let current: serde_json::Value =
                serde_json::from_slice(&current).map_err(|_| "当前记录无法读取，请先恢复备份。")?;
            if current == next {
                return Ok(());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if path
                .file_name()
                .is_some_and(|name| name == "scratchpad.json")
                && next == serde_json::json!({ "content": "" })
            {
                return Ok(());
            }
            // Missing collections already load as empty; closing without a draft changes nothing.
            if RECORD_FILES
                .iter()
                .filter(|name| **name != "settings.json")
                .any(|name| path.file_name().is_some_and(|file| file == *name))
                && next == serde_json::json!([])
            {
                return Ok(());
            }
        }
        Err(error) => return Err(format!("无法读取当前记录：{error}")),
    }
    checkpoint(directory, false)?;
    atomic_write(path, bytes)
}

fn install_workspace(directory: &Path, backup: &WorkspaceBackup) -> Result<(), String> {
    for (name, bytes) in [
        ("shortcuts.json", json_bytes(&backup.shortcuts)?),
        ("checklists.json", json_bytes(&backup.checklists)?),
        ("diaries.json", json_bytes(&backup.diaries)?),
        ("settings.json", json_bytes(&backup.settings)?),
        ("drafts.json", json_bytes(&backup.drafts)?),
    ] {
        atomic_write(&directory.join(name), &bytes)?;
    }
    if let Some(page) = &backup.scratchpad {
        atomic_write(&directory.join("scratchpad.json"), &json_bytes(page)?)?;
    }
    Ok(())
}

fn recover_unlocked(directory: &Path) -> Result<(), String> {
    let journal = directory.join("restore-journal.json");
    if journal.exists() {
        let previous: RestoreJournal =
            serde_json::from_slice(&fs::read(&journal).map_err(|error| error.to_string())?)
                .map_err(|_| "恢复记录无法读取。")?;
        let names = previous
            .files
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<HashSet<_>>();
        // An interrupted restore from an earlier version contains the original five files.
        if names.len() != previous.files.len()
            || names.iter().any(|name| !RECORD_FILES.contains(name))
            || RECORD_FILES
                .iter()
                .filter(|name| **name != "scratchpad.json")
                .any(|name| !names.contains(name))
        {
            return Err("恢复记录不完整。".into());
        }
        for (name, bytes) in previous.files {
            let path = directory.join(name);
            if let Some(bytes) = bytes {
                atomic_write(&path, &bytes)?;
            } else if path.exists() {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
        }
        fs::remove_file(journal).map_err(|error| format!("无法完成记录恢复：{error}"))?;
    }
    Ok(())
}

pub fn recover_pending(directory: &Path) -> Result<(), String> {
    let _guard = STORAGE_LOCK.lock().map_err(|_| "本地记录暂时不可用。")?;
    recover_unlocked(directory)
}

fn restore_workspace(directory: &Path, backup: &WorkspaceBackup) -> Result<(), String> {
    backup.validate()?;
    let previous = RestoreJournal::capture(directory)?;
    if read_workspace(directory).is_ok() {
        checkpoint(directory, true)?;
    } else {
        // Preserve damaged files byte-for-byte, so a valid backup can still be restored.
        let history = directory.join("backups");
        fs::create_dir_all(&history).map_err(|error| error.to_string())?;
        atomic_write(
            &history.join(format!("before-recovery-{}.json", now_ms())),
            &json_bytes(&previous)?,
        )?;
    }
    let journal = directory.join("restore-journal.json");
    atomic_write(&journal, &json_bytes(&previous)?)?;
    if let Err(error) = install_workspace(directory, backup) {
        recover_unlocked(directory)?;
        return Err(error);
    }
    fs::remove_file(journal).map_err(|error| format!("无法完成记录恢复：{error}"))
}

#[tauri::command]
pub fn load_scratchpad(app: AppHandle) -> Result<Scratchpad, String> {
    let page: Scratchpad = read_or_default(&config_directory(&app)?.join("scratchpad.json"))?;
    page.validate()?;
    Ok(page)
}

#[tauri::command]
pub fn save_scratchpad(app: AppHandle, page: Scratchpad) -> Result<(), String> {
    page.validate()?;
    save_file(
        &config_directory(&app)?.join("scratchpad.json"),
        &json_bytes(&page)?,
    )
}

#[tauri::command]
pub fn load_drafts(app: AppHandle) -> Result<Vec<DiaryDraft>, String> {
    let drafts = read_or_default::<Vec<DiaryDraft>>(&config_directory(&app)?.join("drafts.json"))?;
    validate_drafts(&drafts)?;
    Ok(drafts)
}

#[tauri::command]
pub fn save_drafts(app: AppHandle, drafts: Vec<DiaryDraft>) -> Result<(), String> {
    validate_drafts(&drafts)?;
    save_file(
        &config_directory(&app)?.join("drafts.json"),
        &json_bytes(&drafts)?,
    )
}

#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<BackupSummary>, String> {
    let directory = config_directory(&app)?;
    let _guard = STORAGE_LOCK.lock().map_err(|_| "本地记录暂时不可用。")?;
    Ok(backup_paths(&directory)?
        .iter()
        .filter_map(|path| read_backup(path).ok().map(|backup| backup.summary(path)))
        .collect())
}

#[tauri::command]
pub fn export_backup(app: AppHandle, path: PathBuf) -> Result<(), String> {
    let directory = config_directory(&app)?;
    if !path.is_absolute() || path.starts_with(&directory) {
        return Err("请选择应用数据目录之外的备份位置。".into());
    }
    let _guard = STORAGE_LOCK.lock().map_err(|_| "本地记录暂时不可用。")?;
    atomic_write(&path, &json_bytes(&read_workspace(&directory)?)?)
}

#[tauri::command]
pub fn inspect_backup(path: PathBuf) -> Result<BackupSummary, String> {
    Ok(read_backup(&path)?.summary(&path))
}

#[tauri::command]
pub fn restore_backup(app: AppHandle, path: PathBuf) -> Result<(), String> {
    let directory = config_directory(&app)?;
    let backup = read_backup(&path)?;
    let _guard = STORAGE_LOCK.lock().map_err(|_| "本地记录暂时不可用。")?;
    restore_workspace(&directory, &backup)
}

#[tauri::command]
pub fn export_diary(app: AppHandle, id: String, path: PathBuf) -> Result<(), String> {
    let directory = config_directory(&app)?;
    if !path.is_absolute() || path.starts_with(&directory) {
        return Err("请选择应用数据目录之外的导出位置。".into());
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "md" && extension != "txt" {
        return Err("请选择 .md 或 .txt 格式。".into());
    }
    let _guard = STORAGE_LOCK.lock().map_err(|_| "本地记录暂时不可用。")?;
    let diary = read_workspace(&directory)?
        .diaries
        .into_iter()
        .find(|diary| diary.id == id)
        .ok_or("这篇日记已不存在。")?;
    let prefix = if extension == "md" { "# " } else { "" };
    let content = format!(
        "{prefix}{}\n\n创建：{}\n修改：{}\n\n{}\n",
        diary.title, diary.created_at, diary.updated_at, diary.content
    );
    atomic_write(&path, content.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "serenook-storage-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn scratchpad_round_trip_preserves_whitespace_and_empty_edits() {
        let directory = TestDirectory::new();
        let path = directory.0.join("scratchpad.json");
        save_file(&path, &json_bytes(&Scratchpad::default()).unwrap()).unwrap();
        assert!(!path.exists());
        let content = "  开学，适应ing......\n无事发生......🌱\n";
        let page = Scratchpad {
            content: content.into(),
        };
        save_file(&path, &json_bytes(&page).unwrap()).unwrap();
        let backup = read_workspace(&directory.0).unwrap();
        assert_eq!(backup.scratchpad.as_ref().unwrap().content, content);
        save_file(&path, &json_bytes(&Scratchpad::default()).unwrap()).unwrap();
        assert!(read_workspace(&directory.0)
            .unwrap()
            .scratchpad
            .unwrap()
            .content
            .is_empty());
        restore_workspace(&directory.0, &backup).unwrap();
        assert_eq!(
            read_workspace(&directory.0)
                .unwrap()
                .scratchpad
                .unwrap()
                .content,
            content
        );
    }

    #[test]
    fn legacy_backup_migrates_modules_without_erasing_scratchpad() {
        let directory = TestDirectory::new();
        let mut old = serde_json::to_value(read_workspace(&directory.0).unwrap()).unwrap();
        old.as_object_mut().unwrap().remove("scratchpad");
        old["settings"]
            .as_object_mut()
            .unwrap()
            .remove("hiddenModules");
        old["settings"]["workspaceOrder"] =
            serde_json::json!(["diaries", "shortcuts", "checklists"]);
        let source = directory.0.join("legacy.json");
        fs::write(&source, json_bytes(&old).unwrap()).unwrap();
        let backup = read_backup(&source).unwrap();
        assert!(backup.settings.hidden_modules.is_empty());
        assert_eq!(
            backup.settings.workspace_order,
            vec!["diaries", "shortcuts", "checklists", "scratchpad", "music"]
        );
        assert!(backup.summary(&source).scratchpad_characters.is_none());
        fs::write(
            directory.0.join("settings.json"),
            json_bytes(&old["settings"]).unwrap(),
        )
        .unwrap();
        let page = Scratchpad {
            content: "新写的一页".into(),
        };
        save_file(
            &directory.0.join("scratchpad.json"),
            &json_bytes(&page).unwrap(),
        )
        .unwrap();
        restore_workspace(&directory.0, &backup).unwrap();
        assert_eq!(
            read_workspace(&directory.0)
                .unwrap()
                .scratchpad
                .unwrap()
                .content,
            page.content
        );
    }

    #[test]
    fn music_migration_keeps_v13_order_and_rejects_duplicate_modules() {
        let directory = TestDirectory::new();
        let mut backup = read_workspace(&directory.0).unwrap();
        backup.settings.workspace_order = vec![
            "scratchpad".into(),
            "diaries".into(),
            "shortcuts".into(),
            "checklists".into(),
        ];
        backup.settings.collapsed_modules = vec!["diaries".into()];
        backup.migrate();
        assert_eq!(
            backup.settings.workspace_order,
            vec!["scratchpad", "diaries", "shortcuts", "checklists", "music"]
        );
        assert_eq!(backup.settings.collapsed_modules, vec!["diaries"]);
        assert!(backup.validate().is_ok());
        backup.settings.workspace_order = vec!["shortcuts".into(); 4];
        backup.migrate();
        assert!(backup.validate().is_err());
    }

    #[test]
    fn restore_journal_recovers_scratchpad_and_accepts_legacy_journals() {
        let directory = TestDirectory::new();
        let path = directory.0.join("scratchpad.json");
        let page = Scratchpad {
            content: "原来的文字".into(),
        };
        fs::write(&path, json_bytes(&page).unwrap()).unwrap();
        let journal = RestoreJournal::capture(&directory.0).unwrap();
        fs::write(
            directory.0.join("restore-journal.json"),
            json_bytes(&journal).unwrap(),
        )
        .unwrap();
        fs::write(&path, b"broken").unwrap();
        recover_pending(&directory.0).unwrap();
        assert_eq!(
            read_workspace(&directory.0)
                .unwrap()
                .scratchpad
                .unwrap()
                .content,
            page.content
        );
        let mut legacy = RestoreJournal::capture(&directory.0).unwrap();
        legacy.files.retain(|(name, _)| name != "scratchpad.json");
        fs::write(
            directory.0.join("restore-journal.json"),
            json_bytes(&legacy).unwrap(),
        )
        .unwrap();
        recover_pending(&directory.0).unwrap();
        assert_eq!(
            read_workspace(&directory.0)
                .unwrap()
                .scratchpad
                .unwrap()
                .content,
            page.content
        );
    }

    #[test]
    fn scratchpad_limits_match_utf16_and_reject_damaged_records() {
        assert!(Scratchpad {
            content: "🌱".repeat(25_000)
        }
        .validate()
        .is_ok());
        assert!(Scratchpad {
            content: "🌱".repeat(25_001)
        }
        .validate()
        .is_err());
        let directory = TestDirectory::new();
        fs::write(directory.0.join("scratchpad.json"), b"broken").unwrap();
        assert!(save_file(
            &directory.0.join("scratchpad.json"),
            &json_bytes(&Scratchpad::default()).unwrap()
        )
        .is_err());
        assert_eq!(
            fs::read(directory.0.join("scratchpad.json")).unwrap(),
            b"broken"
        );
    }

    #[test]
    fn replacing_a_file_keeps_valid_json_and_a_previous_snapshot() {
        let directory = TestDirectory::new();
        let mut settings = AppSettings::default();
        save_file(
            &directory.0.join("settings.json"),
            &json_bytes(&settings).unwrap(),
        )
        .unwrap();
        settings.anniversary_name = "Dog".into();
        save_file(
            &directory.0.join("settings.json"),
            &json_bytes(&settings).unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_workspace(&directory.0)
                .unwrap()
                .settings
                .anniversary_name,
            "Dog"
        );
        assert_eq!(backup_paths(&directory.0).unwrap().len(), 1);
        assert!(!directory.0.join("diaries.pending").exists());
    }

    #[test]
    fn unchanged_records_and_absent_empty_drafts_do_not_create_backups() {
        let directory = TestDirectory::new();
        save_file(&directory.0.join("drafts.json"), b"[]").unwrap();
        assert!(!directory.0.join("drafts.json").exists());
        fs::write(directory.0.join("diaries.json"), b"[ ]").unwrap();
        save_file(&directory.0.join("diaries.json"), b"[]").unwrap();
        assert_eq!(fs::read(directory.0.join("diaries.json")).unwrap(), b"[ ]");
        assert!(backup_paths(&directory.0).unwrap().is_empty());
    }

    #[test]
    fn identical_snapshots_are_skipped_but_forced_restore_snapshots_are_kept() {
        let directory = TestDirectory::new();
        let mut previous = read_workspace(&directory.0).unwrap();
        previous.created_at = 1;
        let history = directory.0.join("backups");
        fs::create_dir(&history).unwrap();
        fs::write(
            history.join("workspace-1.json"),
            json_bytes(&previous).unwrap(),
        )
        .unwrap();
        checkpoint(&directory.0, false).unwrap();
        assert_eq!(backup_paths(&directory.0).unwrap().len(), 1);
        checkpoint(&directory.0, true).unwrap();
        assert_eq!(backup_paths(&directory.0).unwrap().len(), 2);
    }

    #[test]
    fn stored_checklists_round_trip_with_task_states_and_links() {
        let directory = TestDirectory::new();
        let mut backup = read_workspace(&directory.0).unwrap();
        let legacy = serde_json::json!({"id":"list", "name":"清单", "dailyReset":true,
            "tasks":[{"id":"task", "content":"记录", "completed":true, "important":true, "shortcutId":"entry"}]});
        let mut list: Checklist = serde_json::from_value(legacy).unwrap();
        assert!(!list.archived);
        list.archived = true;
        backup.checklists.push(list);
        restore_workspace(&directory.0, &backup).unwrap();
        let restored = read_workspace(&directory.0).unwrap();
        assert!(restored.checklists[0].archived);
        assert!(restored.checklists[0].tasks[0].completed);
        assert!(restored.checklists[0].tasks[0].important);
        assert_eq!(
            restored.checklists[0].tasks[0].shortcut_id.as_deref(),
            Some("entry")
        );
    }

    #[test]
    fn invalid_backup_does_not_overwrite_existing_records() {
        let directory = TestDirectory::new();
        let mut backup = read_workspace(&directory.0).unwrap();
        backup.version = 99;
        assert!(restore_workspace(&directory.0, &backup).is_err());
        assert!(!directory.0.join("settings.json").exists());
    }

    #[test]
    fn interrupted_restore_rolls_back_all_files() {
        let directory = TestDirectory::new();
        let previous = RestoreJournal::capture(&directory.0).unwrap();
        atomic_write(
            &directory.0.join("restore-journal.json"),
            &json_bytes(&previous).unwrap(),
        )
        .unwrap();
        fs::write(directory.0.join("settings.json"), "incomplete").unwrap();
        recover_pending(&directory.0).unwrap();
        let recovered = read_workspace(&directory.0).unwrap();
        assert_eq!(recovered.settings.anniversary_name, "Love");
        assert!(!directory.0.join("restore-journal.json").exists());
    }

    #[test]
    fn draft_allows_partial_text_and_rejects_duplicate_entry_ids() {
        let draft = DiaryDraft {
            entry_id: None,
            title: String::new(),
            content: "还没写完".into(),
            saved_at: "2026-09-06T10:00:00.000Z".into(),
        };
        assert!(validate_drafts(&[draft.clone()]).is_ok());
        assert!(validate_drafts(&[draft.clone(), draft]).is_err());
    }

    #[test]
    fn restore_round_trips_drafts_and_keeps_a_pre_restore_backup() {
        let directory = TestDirectory::new();
        let mut backup = read_workspace(&directory.0).unwrap();
        backup.settings.anniversary_name = "Dog".into();
        backup.settings.hidden_modules = vec!["music".into(), "diaries".into()];
        backup.settings.collapsed_modules = vec!["diaries".into()];
        backup.drafts.push(DiaryDraft {
            entry_id: None,
            title: "此刻".into(),
            content: "未完成".into(),
            saved_at: "2026-09-06T10:00:00.000Z".into(),
        });
        restore_workspace(&directory.0, &backup).unwrap();
        let restored = read_workspace(&directory.0).unwrap();
        assert_eq!(restored.drafts.len(), 1);
        assert_eq!(restored.settings.anniversary_name, "Dog");
        assert_eq!(restored.settings.hidden_modules, vec!["music", "diaries"]);
        assert_eq!(restored.settings.collapsed_modules, vec!["diaries"]);
        let old = read_backup(&backup_paths(&directory.0).unwrap()[0]).unwrap();
        assert_eq!(old.settings.anniversary_name, "Love");
        assert!(old.settings.hidden_modules.is_empty());
    }

    #[test]
    fn valid_backup_can_restore_a_damaged_workspace_without_losing_original_bytes() {
        let directory = TestDirectory::new();
        let backup = read_workspace(&directory.0).unwrap();
        fs::write(directory.0.join("diaries.json"), "broken original").unwrap();
        restore_workspace(&directory.0, &backup).unwrap();
        assert!(read_workspace(&directory.0).is_ok());
        let raw = fs::read_dir(directory.0.join("backups"))
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("before-recovery-")
            })
            .unwrap();
        let original: RestoreJournal =
            serde_json::from_slice(&fs::read(raw.path()).unwrap()).unwrap();
        assert_eq!(
            original
                .files
                .into_iter()
                .find(|(name, _)| name == "diaries.json")
                .unwrap()
                .1
                .unwrap(),
            b"broken original"
        );
    }
}
