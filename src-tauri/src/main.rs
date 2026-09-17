#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::os::windows::ffi::OsStrExt;
use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};
use windows::{
    core::{HSTRING, PCWSTR, PWSTR},
    Management::Deployment::PackageManager,
    Win32::{
        Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS},
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
        },
        Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
        System::{
            Com::{CoTaskMemFree, IBindCtx},
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Registry::{
                RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegEnumKeyExW, RegOpenKeyExW,
                RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
                KEY_ENUMERATE_SUB_KEYS, KEY_QUERY_VALUE, KEY_SET_VALUE, KEY_WOW64_32KEY,
                KEY_WOW64_64KEY, REG_DWORD, REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE, REG_SZ,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Shell::{
                Common::ITEMIDLIST, SHGetFileInfoW, SHParseDisplayName, ShellExecuteW, SHFILEINFOW,
                SHGFI_ICON, SHGFI_LARGEICON, SHGFI_PIDL,
            },
            WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON, SW_SHOWNORMAL},
        },
    },
};

const MAX_SHORTCUTS: usize = 500;
const MAX_CHECKLISTS: usize = 24;
const MAX_TASKS_PER_CHECKLIST: usize = 100;
const MAX_CHECKLIST_NAME_CHARACTERS: usize = 32;
const MAX_TASK_CONTENT_CHARACTERS: usize = 200;
const MAX_DIARY_TITLE_CHARACTERS: usize = 80;
const MAX_DIARY_CONTENT_CHARACTERS: usize = 5_000;
const MAX_ANNIVERSARY_NAME_CHARACTERS: usize = 7;
const DEFAULT_ANNIVERSARY_NAME: &str = "Love";
const WORKSPACE_MODULES: [&str; 4] = ["shortcuts", "checklists", "diaries", "scratchpad"];
const ALLOWED_EXTENSIONS: &[&str] = &[
    "exe", "lnk", "bat", "cmd", "url", "txt", "md", "rtf", "pdf", "xps", "doc", "docx", "docm",
    "odt", "wps", "csv", "xls", "xlsx", "xlsm", "ods", "et", "ppt", "pptx", "pptm", "odp", "dps",
    "epub", "mobi", "one", "htm", "html",
];
const ALLOWED_ICONS: &[&str] = &[
    "app",
    "chat",
    "code",
    "compass",
    "folder",
    "document",
    "sheet",
    "pdf",
    "presentation",
];
const STARTUP_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_VALUE_NAME: &str = "Serenook";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ShortcutKind {
    #[default]
    Local,
    Web,
    Folder,
    App,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppShortcut {
    id: String,
    name: String,
    target: String,
    icon: String,
    #[serde(default)]
    kind: ShortcutKind,
    #[serde(default)]
    sleeping: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wake_days: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledAppCandidate {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<ShortcutKind>,
    source: &'static str,
}

#[derive(Clone, Debug)]
struct StartMenuShortcut {
    normalized_name: String,
    path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChecklistTask {
    id: String,
    content: String,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    important: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shortcut_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Checklist {
    id: String,
    name: String,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    daily_reset: bool,
    #[serde(default)]
    last_reset_date: Option<String>,
    #[serde(default)]
    tasks: Vec<ChecklistTask>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiaryEntry {
    id: String,
    title: String,
    content: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default)]
    launch_on_startup: bool,
    #[serde(default = "existing_user_has_completed_welcome")]
    has_completed_welcome: bool,
    #[serde(default)]
    theme: ThemePreference,
    #[serde(default)]
    anniversary_date: Option<String>,
    #[serde(default = "default_anniversary_name")]
    anniversary_name: String,
    #[serde(default = "default_workspace_order")]
    workspace_order: Vec<String>,
    #[serde(default)]
    collapsed_modules: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

fn existing_user_has_completed_welcome() -> bool {
    true
}

fn default_anniversary_name() -> String {
    DEFAULT_ANNIVERSARY_NAME.into()
}

fn default_workspace_order() -> Vec<String> {
    WORKSPACE_MODULES
        .iter()
        .map(|module| (*module).to_string())
        .collect()
}

fn normalize_workspace_preferences(settings: &mut AppSettings) {
    let mut seen = HashSet::new();
    settings.workspace_order.retain(|module| {
        WORKSPACE_MODULES.contains(&module.as_str()) && seen.insert(module.clone())
    });
    for module in WORKSPACE_MODULES {
        if seen.insert(module.to_string()) {
            settings.workspace_order.push(module.to_string());
        }
    }

    let mut collapsed = HashSet::new();
    settings.collapsed_modules.retain(|module| {
        WORKSPACE_MODULES.contains(&module.as_str()) && collapsed.insert(module.clone())
    });
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            launch_on_startup: false,
            has_completed_welcome: false,
            theme: ThemePreference::System,
            anniversary_date: None,
            anniversary_name: default_anniversary_name(),
            workspace_order: default_workspace_order(),
            collapsed_modules: Vec::new(),
        }
    }
}

fn config_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法确定配置目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建配置目录：{error}"))?;
    storage::recover_pending(&directory)?;
    Ok(directory)
}

fn shortcuts_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_directory(app)?.join("shortcuts.json"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_directory(app)?.join("settings.json"))
}

fn checklists_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_directory(app)?.join("checklists.json"))
}

fn diaries_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_directory(app)?.join("diaries.json"))
}

fn wide_string(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn startup_registry_key(
    access: windows::Win32::System::Registry::REG_SAM_FLAGS,
) -> Result<HKEY, String> {
    let subkey = wide_string(OsStr::new(STARTUP_KEY));
    let mut key = HKEY::default();
    let status = unsafe {
        if access == KEY_SET_VALUE {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(subkey.as_ptr()),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                access,
                None,
                &mut key,
                None,
            )
        } else {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(subkey.as_ptr()),
                None,
                access,
                &mut key,
            )
        }
    };
    if status != ERROR_SUCCESS {
        return Err(format!("无法访问开机启动设置：Windows 错误 {}。", status.0));
    }
    Ok(key)
}

fn is_launch_on_startup_enabled() -> Result<bool, String> {
    let key = match startup_registry_key(KEY_QUERY_VALUE) {
        Ok(key) => key,
        Err(_) => return Ok(false),
    };
    let name = wide_string(OsStr::new(STARTUP_VALUE_NAME));
    let status = unsafe { RegQueryValueExW(key, PCWSTR(name.as_ptr()), None, None, None, None) };
    let _ = unsafe { RegCloseKey(key) };
    Ok(status == ERROR_SUCCESS)
}

fn set_launch_on_startup(enabled: bool) -> Result<(), String> {
    let key = startup_registry_key(KEY_SET_VALUE)?;
    let name = wide_string(OsStr::new(STARTUP_VALUE_NAME));
    let status = if enabled {
        let executable =
            env::current_exe().map_err(|error| format!("无法确定 Serenook 位置：{error}"))?;
        let command = format!(r#""{}""#, executable.display());
        let wide_command = wide_string(OsStr::new(&command));
        let bytes = unsafe {
            std::slice::from_raw_parts(
                wide_command.as_ptr().cast::<u8>(),
                wide_command.len() * std::mem::size_of::<u16>(),
            )
        };
        unsafe { RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(bytes)) }
    } else {
        let result = unsafe { RegDeleteValueW(key, PCWSTR(name.as_ptr())) };
        if result == ERROR_FILE_NOT_FOUND {
            ERROR_SUCCESS
        } else {
            result
        }
    };
    let _ = unsafe { RegCloseKey(key) };
    if status != ERROR_SUCCESS {
        return Err(format!("无法更新开机启动设置：Windows 错误 {}。", status.0));
    }
    Ok(())
}

fn registry_string(key: HKEY, name: &str) -> Option<String> {
    let name = wide_string(OsStr::new(name));
    let mut value_type = Default::default();
    let mut byte_count = 0_u32;
    let status = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut value_type),
            None,
            Some(&mut byte_count),
        )
    };
    if status != ERROR_SUCCESS || !matches!(value_type, REG_SZ | REG_EXPAND_SZ) || byte_count < 2 {
        return None;
    }

    let mut buffer = vec![0_u16; byte_count as usize / 2 + 1];
    let status = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut value_type),
            Some(buffer.as_mut_ptr().cast::<u8>()),
            Some(&mut byte_count),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let length = buffer
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..length])
        .trim()
        .to_string();
    (!value.is_empty()).then_some(value)
}

fn registry_dword(key: HKEY, name: &str) -> Option<u32> {
    let name = wide_string(OsStr::new(name));
    let mut value_type = Default::default();
    let mut value = 0_u32;
    let mut byte_count = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut value_type),
            Some((&mut value as *mut u32).cast::<u8>()),
            Some(&mut byte_count),
        )
    };
    (status == ERROR_SUCCESS && value_type == REG_DWORD && byte_count == 4).then_some(value)
}

fn expand_environment_variables(value: &str) -> String {
    let mut expanded = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(open) = rest.find('%') {
        expanded.push_str(&rest[..open]);
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('%') else {
            expanded.push_str(&rest[open..]);
            return expanded;
        };
        let variable = &after_open[..close];
        match env::vars_os().find(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case(variable))
        {
            Some((_, value)) => expanded.push_str(&value.to_string_lossy()),
            None => expanded.push_str(&rest[open..open + close + 2]),
        }
        rest = &after_open[close + 1..];
    }
    expanded.push_str(rest);
    expanded
}

fn display_icon_path(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    let path = if let Some(quoted) = trimmed.strip_prefix('"') {
        quoted.split('"').next().unwrap_or(quoted)
    } else if let Some((path, index)) = trimmed.rsplit_once(',') {
        if index.trim().parse::<i32>().is_ok() {
            path
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    let path = PathBuf::from(expand_environment_variables(path.trim().trim_matches('"')));
    let launchable = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "exe" | "lnk"));
    (launchable && path.is_file()).then_some(path)
}

fn normalized_app_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn collect_start_menu_shortcuts(directory: &Path, depth: u8, output: &mut Vec<StartMenuShortcut>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_start_menu_shortcuts(&path, depth + 1, output);
            continue;
        }
        if !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
        {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        let lower = name.to_lowercase();
        if [
            "uninstall",
            "remove",
            "help",
            "readme",
            "website",
            "卸载",
            "帮助",
        ]
        .iter()
        .any(|word| lower.contains(word))
        {
            continue;
        }
        let normalized_name = normalized_app_name(name);
        if !normalized_name.is_empty() {
            output.push(StartMenuShortcut {
                normalized_name,
                path,
            });
        }
    }
}

fn start_menu_shortcuts() -> Vec<StartMenuShortcut> {
    let mut shortcuts = Vec::new();
    for (variable, suffix) in [
        ("APPDATA", r"Microsoft\Windows\Start Menu\Programs"),
        ("PROGRAMDATA", r"Microsoft\Windows\Start Menu\Programs"),
    ] {
        if let Some(root) = env::var_os(variable) {
            collect_start_menu_shortcuts(&PathBuf::from(root).join(suffix), 0, &mut shortcuts);
        }
    }
    shortcuts
}

fn matching_start_menu_shortcut(name: &str, shortcuts: &[StartMenuShortcut]) -> Option<PathBuf> {
    let normalized = normalized_app_name(name);
    shortcuts
        .iter()
        .find(|shortcut| shortcut.normalized_name == normalized)
        .or_else(|| {
            shortcuts
                .iter()
                .filter(|shortcut| {
                    normalized
                        .chars()
                        .count()
                        .min(shortcut.normalized_name.chars().count())
                        >= 6
                        && (normalized.contains(&shortcut.normalized_name)
                            || shortcut.normalized_name.contains(&normalized))
                })
                .min_by_key(|shortcut| {
                    normalized
                        .chars()
                        .count()
                        .abs_diff(shortcut.normalized_name.chars().count())
                })
        })
        .map(|shortcut| shortcut.path.clone())
}

fn matching_install_location_executable(name: &str, location: &str) -> Option<PathBuf> {
    let directory = PathBuf::from(expand_environment_variables(location));
    let normalized = normalized_app_name(name);
    let entries = fs::read_dir(directory).ok()?;
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        })
        .filter_map(|path| {
            let stem = path.file_stem()?.to_str()?;
            let candidate = normalized_app_name(stem);
            let lower = stem.to_ascii_lowercase();
            if [
                "unins",
                "uninstall",
                "update",
                "helper",
                "crash",
                "report",
                "service",
            ]
            .iter()
            .any(|word| lower.contains(word))
            {
                return None;
            }
            let score = if candidate == normalized {
                0
            } else if normalized.contains(&candidate) || candidate.contains(&normalized) {
                1
            } else {
                2
            };
            Some((score, path))
        })
        .min_by_key(|(score, _)| *score)
        .and_then(|(score, path)| (score < 2).then_some(path))
}

fn enumerate_uninstall_key(
    hive: HKEY,
    hive_name: &str,
    view_name: &str,
    view: windows::Win32::System::Registry::REG_SAM_FLAGS,
    start_menu: &[StartMenuShortcut],
    output: &mut Vec<InstalledAppCandidate>,
) {
    let uninstall_path = wide_string(OsStr::new(
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
    ));
    let mut key = HKEY::default();
    let status = unsafe {
        RegOpenKeyExW(
            hive,
            PCWSTR(uninstall_path.as_ptr()),
            None,
            KEY_ENUMERATE_SUB_KEYS | view,
            &mut key,
        )
    };
    if status != ERROR_SUCCESS {
        return;
    }

    let mut index = 0_u32;
    loop {
        let mut buffer = vec![0_u16; 512];
        let mut length = (buffer.len() - 1) as u32;
        let status = unsafe {
            RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(buffer.as_mut_ptr())),
                &mut length,
                None,
                None,
                None,
                None,
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        index += 1;
        if status != ERROR_SUCCESS {
            continue;
        }
        let subkey_name = String::from_utf16_lossy(&buffer[..length as usize]);
        let subkey_wide = wide_string(OsStr::new(&subkey_name));
        let mut subkey = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(
                key,
                PCWSTR(subkey_wide.as_ptr()),
                None,
                KEY_QUERY_VALUE | view,
                &mut subkey,
            )
        };
        if status != ERROR_SUCCESS {
            continue;
        }

        let name = registry_string(subkey, "DisplayName");
        let hidden = registry_dword(subkey, "SystemComponent") == Some(1)
            || registry_dword(subkey, "NoDisplay") == Some(1)
            || registry_string(subkey, "ParentKeyName").is_some()
            || registry_string(subkey, "ReleaseType").is_some_and(|release_type| {
                let release_type = release_type.to_ascii_lowercase();
                ["update", "hotfix", "security update"]
                    .iter()
                    .any(|kind| release_type.contains(kind))
            });
        if let Some(name) = name.filter(|_| !hidden) {
            let target = matching_start_menu_shortcut(&name, start_menu)
                .or_else(|| {
                    registry_string(subkey, "DisplayIcon")
                        .and_then(|value| display_icon_path(&value))
                })
                .or_else(|| {
                    registry_string(subkey, "InstallLocation")
                        .and_then(|location| matching_install_location_executable(&name, &location))
                });
            output.push(InstalledAppCandidate {
                id: format!("desktop:{hive_name}:{view_name}:{subkey_name}"),
                name,
                publisher: registry_string(subkey, "Publisher"),
                version: registry_string(subkey, "DisplayVersion"),
                target: target
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                kind: target.map(|_| ShortcutKind::Local),
                source: "desktop",
            });
        }
        let _ = unsafe { RegCloseKey(subkey) };
    }
    let _ = unsafe { RegCloseKey(key) };
}

fn packaged_app_candidates() -> Vec<InstalledAppCandidate> {
    let mut candidates = Vec::new();
    let Ok(manager) = PackageManager::new() else {
        return candidates;
    };
    let Ok(packages) = manager.FindPackagesByUserSecurityId(&HSTRING::new()) else {
        return candidates;
    };
    for package in packages {
        if package.IsFramework().unwrap_or(false) || package.IsResourcePackage().unwrap_or(false) {
            continue;
        }
        let publisher = package
            .PublisherDisplayName()
            .ok()
            .map(|value| value.to_string())
            .filter(|value| !value.trim().is_empty());
        let version = package
            .Id()
            .ok()
            .and_then(|id| id.Version().ok())
            .map(|version| {
                format!(
                    "{}.{}.{}.{}",
                    version.Major, version.Minor, version.Build, version.Revision
                )
            });
        let Ok(entries) = package.GetAppListEntries() else {
            continue;
        };
        for entry in entries {
            let Ok(app_user_model_id) = entry.AppUserModelId() else {
                continue;
            };
            let target = app_user_model_id.to_string();
            let name = entry
                .DisplayInfo()
                .and_then(|display| display.DisplayName())
                .map(|value| value.to_string())
                .unwrap_or_default();
            if name.trim().is_empty() || target.trim().is_empty() {
                continue;
            }
            candidates.push(InstalledAppCandidate {
                id: format!("store:{target}"),
                name,
                publisher: publisher.clone(),
                version: version.clone(),
                target: Some(target),
                kind: Some(ShortcutKind::App),
                source: "store",
            });
        }
    }
    candidates
}

#[tauri::command]
fn list_installed_apps() -> Result<Vec<InstalledAppCandidate>, String> {
    let start_menu = start_menu_shortcuts();
    let mut candidates = Vec::new();
    enumerate_uninstall_key(
        HKEY_CURRENT_USER,
        "current-user",
        "native",
        Default::default(),
        &start_menu,
        &mut candidates,
    );
    enumerate_uninstall_key(
        HKEY_LOCAL_MACHINE,
        "local-machine",
        "64",
        KEY_WOW64_64KEY,
        &start_menu,
        &mut candidates,
    );
    enumerate_uninstall_key(
        HKEY_LOCAL_MACHINE,
        "local-machine",
        "32",
        KEY_WOW64_32KEY,
        &start_menu,
        &mut candidates,
    );
    candidates.extend(packaged_app_candidates());

    candidates.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.publisher.cmp(&right.publisher))
    });
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut deduplicated: Vec<InstalledAppCandidate> = Vec::new();
    for candidate in candidates {
        let key = format!(
            "{}\u{0}{}\u{0}{}",
            candidate.name.to_lowercase(),
            candidate.publisher.as_deref().unwrap_or("").to_lowercase(),
            candidate.version.as_deref().unwrap_or("").to_lowercase(),
        );
        if let Some(index) = positions.get(&key).copied() {
            if deduplicated[index].target.is_none() && candidate.target.is_some() {
                deduplicated[index] = candidate;
            }
        } else {
            positions.insert(key, deduplicated.len());
            deduplicated.push(candidate);
        }
    }
    Ok(deduplicated)
}

fn validate_app_target(target: &str) -> Result<String, String> {
    let trimmed = target.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 512
        || trimmed.chars().any(char::is_control)
        || !trimmed.contains('!')
    {
        return Err("已安装应用的启动标识无效。".into());
    }
    Ok(trimmed.to_string())
}

fn validate_target(target: &str, require_exists: bool) -> Result<PathBuf, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("请选择本地文件。".into());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("程序位置必须是绝对路径。".into());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "无法识别该文件类型。".to_string())?;

    if !ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("仅支持常见应用、快捷方式与文档文件。".into());
    }

    if require_exists && !path.is_file() {
        return Err("找不到该文件，请在编辑模式中重新选择。".into());
    }

    Ok(path)
}

fn validate_folder_target(target: &str, require_exists: bool) -> Result<PathBuf, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("请选择本地文件夹。".into());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("文件夹位置必须是绝对路径。".into());
    }
    if require_exists && !path.is_dir() {
        return Err("找不到该文件夹，请在编辑模式中重新选择。".into());
    }

    Ok(path)
}

fn validate_web_url(target: &str) -> Result<String, String> {
    let trimmed = target.trim();
    let lower = trimmed.to_ascii_lowercase();
    let address = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or_else(|| "网址必须以 http:// 或 https:// 开头。".to_string())?;

    if address.is_empty() || address.starts_with('/') || trimmed.chars().any(char::is_whitespace) {
        return Err("请输入完整、有效的网址。".into());
    }
    if trimmed.chars().count() > 2048 {
        return Err("网址过长。".into());
    }
    Ok(trimmed.to_string())
}

fn normalize_windows_path(path: &Path) -> String {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let value = resolved.to_string_lossy().replace('/', r"\");
    let without_prefix = value.strip_prefix(r"\\?\").unwrap_or(&value);
    without_prefix.to_ascii_lowercase()
}

#[tauri::command]
fn detect_running_apps(targets: Vec<String>) -> Result<Vec<String>, String> {
    if targets.len() > MAX_SHORTCUTS {
        return Err("需要检查的应用数量过多。".into());
    }

    let mut candidates: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for target in targets {
        let Ok(path) = validate_target(&target, true) else {
            continue;
        };
        if !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        candidates
            .entry(file_name.to_ascii_lowercase())
            .or_default()
            .push((normalize_windows_path(&path), target));
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| format!("无法读取当前进程：{error}"))?;
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let first_result = unsafe { Process32FirstW(snapshot, &mut entry) };
    if let Err(error) = first_result {
        let _ = unsafe { CloseHandle(snapshot) };
        return Err(format!("无法读取当前进程：{error}"));
    }

    let mut running = HashSet::new();
    loop {
        let name_length = entry
            .szExeFile
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(entry.szExeFile.len());
        let process_name =
            String::from_utf16_lossy(&entry.szExeFile[..name_length]).to_ascii_lowercase();

        if let Some(matches) = candidates.get(&process_name) {
            if let Ok(process) = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION,
                    false,
                    entry.th32ProcessID,
                )
            } {
                let mut buffer = vec![0_u16; 32768];
                let mut buffer_length = buffer.len() as u32;
                if unsafe {
                    QueryFullProcessImageNameW(
                        process,
                        PROCESS_NAME_WIN32,
                        PWSTR(buffer.as_mut_ptr()),
                        &mut buffer_length,
                    )
                }
                .is_ok()
                {
                    let process_path =
                        PathBuf::from(String::from_utf16_lossy(&buffer[..buffer_length as usize]));
                    let normalized = normalize_windows_path(&process_path);
                    for (candidate, original) in matches {
                        if *candidate == normalized {
                            running.insert(original.clone());
                        }
                    }
                }
                let _ = unsafe { CloseHandle(process) };
            }
        }

        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            break;
        }
    }
    let _ = unsafe { CloseHandle(snapshot) };
    Ok(running.into_iter().collect())
}

fn validate_shortcuts(shortcuts: &[AppShortcut]) -> Result<(), String> {
    if shortcuts.len() > MAX_SHORTCUTS {
        return Err(format!("最多可以保存 {MAX_SHORTCUTS} 个入口。"));
    }

    let mut ids = HashSet::with_capacity(shortcuts.len());
    for shortcut in shortcuts {
        let name = shortcut.name.trim();
        if shortcut.id.trim().is_empty() || !ids.insert(shortcut.id.as_str()) {
            return Err("入口标识无效或重复。".into());
        }
        if name.is_empty() || name.chars().count() > 64 {
            return Err("入口名称应为 1 到 64 个字符。".into());
        }
        if !ALLOWED_ICONS.contains(&shortcut.icon.as_str()) {
            return Err("入口图标类型无效。".into());
        }
        if let Some(wake_days) = &shortcut.wake_days {
            let unique_days: HashSet<u8> = wake_days.iter().copied().collect();
            if wake_days.len() > 7
                || unique_days.len() != wake_days.len()
                || wake_days.iter().any(|day| *day > 6)
            {
                return Err("入口作息中的星期设置无效。".into());
            }
        }
        match shortcut.kind {
            ShortcutKind::Local => {
                validate_target(&shortcut.target, false)?;
            }
            ShortcutKind::Web => {
                validate_web_url(&shortcut.target)?;
            }
            ShortcutKind::Folder => {
                validate_folder_target(&shortcut.target, false)?;
            }
            ShortcutKind::App => {
                validate_app_target(&shortcut.target)?;
            }
        }
    }

    Ok(())
}

fn validate_checklists(checklists: &[Checklist]) -> Result<(), String> {
    if checklists.len() > MAX_CHECKLISTS {
        return Err(format!("最多可以保存 {MAX_CHECKLISTS} 个清单。"));
    }

    let mut checklist_ids = HashSet::with_capacity(checklists.len());
    for checklist in checklists {
        if checklist.id.trim().is_empty() || !checklist_ids.insert(checklist.id.as_str()) {
            return Err("清单标识无效或重复。".into());
        }
        let name = checklist.name.trim();
        if name.is_empty() || name.chars().count() > MAX_CHECKLIST_NAME_CHARACTERS {
            return Err(format!(
                "清单名称应为 1 到 {MAX_CHECKLIST_NAME_CHARACTERS} 个字符。"
            ));
        }
        if checklist.tasks.len() > MAX_TASKS_PER_CHECKLIST {
            return Err(format!(
                "每个清单最多可以保存 {MAX_TASKS_PER_CHECKLIST} 个任务。"
            ));
        }
        if checklist
            .last_reset_date
            .as_deref()
            .is_some_and(|date| !is_valid_calendar_date(date))
        {
            return Err("清单的重置日期无效。".into());
        }

        let mut task_ids = HashSet::with_capacity(checklist.tasks.len());
        for task in &checklist.tasks {
            if task.id.trim().is_empty() || !task_ids.insert(task.id.as_str()) {
                return Err("任务标识无效或重复。".into());
            }
            let content = task.content.trim();
            if task
                .shortcut_id
                .as_deref()
                .is_some_and(|id| id.trim().is_empty() || id.len() > 256)
            {
                return Err("关联入口的标识无效。".into());
            }
            if content.is_empty() || content.chars().count() > MAX_TASK_CONTENT_CHARACTERS {
                return Err(format!(
                    "任务内容应为 1 到 {MAX_TASK_CONTENT_CHARACTERS} 个字符。"
                ));
            }
        }
    }

    Ok(())
}

fn is_valid_utc_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
        || !bytes[0..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
        || !bytes[11..13].iter().all(u8::is_ascii_digit)
        || !bytes[14..16].iter().all(u8::is_ascii_digit)
        || !bytes[17..19].iter().all(u8::is_ascii_digit)
        || !bytes[20..23].iter().all(u8::is_ascii_digit)
        || !is_valid_calendar_date(&value[0..10])
    {
        return false;
    }
    let hour = value[11..13].parse::<u8>().unwrap_or(24);
    let minute = value[14..16].parse::<u8>().unwrap_or(60);
    let second = value[17..19].parse::<u8>().unwrap_or(60);
    hour < 24 && minute < 60 && second < 60
}

fn validate_diaries(diaries: &[DiaryEntry]) -> Result<(), String> {
    let mut ids = HashSet::with_capacity(diaries.len());
    for entry in diaries {
        if entry.id.trim().is_empty() || !ids.insert(entry.id.as_str()) {
            return Err("日记标识无效或重复。".into());
        }
        let title = entry.title.trim();
        if title.is_empty() || title.chars().count() > MAX_DIARY_TITLE_CHARACTERS {
            return Err(format!(
                "日记标题应为 1 到 {MAX_DIARY_TITLE_CHARACTERS} 个字符。"
            ));
        }
        let content = entry.content.trim();
        if content.is_empty() || content.chars().count() > MAX_DIARY_CONTENT_CHARACTERS {
            return Err(format!(
                "日记内容应为 1 到 {MAX_DIARY_CONTENT_CHARACTERS} 个字符。"
            ));
        }
        if !is_valid_utc_timestamp(&entry.created_at)
            || !is_valid_utc_timestamp(&entry.updated_at)
            || entry.updated_at < entry.created_at
        {
            return Err("日记时间无效。".into());
        }
    }
    Ok(())
}

fn is_valid_calendar_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes[0..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    if !(1900..=9999).contains(&year) || !(1..=12).contains(&month) {
        return false;
    }
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days_in_month).contains(&day)
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    if settings
        .anniversary_date
        .as_deref()
        .is_some_and(|date| !is_valid_calendar_date(date))
    {
        return Err("纪念日日期无效。".into());
    }
    let anniversary_name = settings.anniversary_name.trim();
    if anniversary_name.is_empty()
        || anniversary_name.len() > MAX_ANNIVERSARY_NAME_CHARACTERS
        || !anniversary_name
            .bytes()
            .all(|character| character.is_ascii_alphabetic())
    {
        return Err(format!(
            "纪念日名称应为 1 到 {MAX_ANNIVERSARY_NAME_CHARACTERS} 个英文字母。"
        ));
    }
    let workspace_order: HashSet<&str> = settings
        .workspace_order
        .iter()
        .map(String::as_str)
        .collect();
    if settings.workspace_order.len() != WORKSPACE_MODULES.len()
        || workspace_order.len() != WORKSPACE_MODULES.len()
        || workspace_order
            .iter()
            .any(|module| !WORKSPACE_MODULES.contains(module))
    {
        return Err("工作区顺序无效。".into());
    }
    let collapsed_modules: HashSet<&str> = settings
        .collapsed_modules
        .iter()
        .map(String::as_str)
        .collect();
    if collapsed_modules.len() != settings.collapsed_modules.len()
        || collapsed_modules
            .iter()
            .any(|module| !WORKSPACE_MODULES.contains(module))
    {
        return Err("工作区折叠状态无效。".into());
    }
    Ok(())
}

fn rgba_png_data_url(width: u32, height: u32, rgba: &[u8]) -> Result<String, String> {
    let mut png_data = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_data, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("无法准备应用图标：{error}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|error| format!("无法生成应用图标：{error}"))?;
    }
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png_data)
    ))
}

fn edge_executable() -> Option<PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]
        .iter()
        .filter_map(env::var_os)
        .map(PathBuf::from)
        .map(|base| base.join(r"Microsoft\Edge\Application\msedge.exe"))
        .find(|path| path.is_file())
}

fn open_web_url(target: &str) -> Result<(), String> {
    let url = validate_web_url(target)?;
    let operation: Vec<u16> = OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let wide_url: Vec<u16> = OsStr::new(&url)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(wide_url.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        return Err("无法使用默认浏览器打开该网址。".into());
    }
    Ok(())
}

fn stylize_line_art(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let width = width as usize;
    let height = height as usize;
    let mut luminance = vec![255_f32; width * height];
    let mut coverage = vec![0_f32; width * height];

    for (index, pixel) in rgba.chunks_exact(4).enumerate() {
        let alpha = pixel[3] as f32 / 255.0;
        let color = 0.299 * pixel[0] as f32 + 0.587 * pixel[1] as f32 + 0.114 * pixel[2] as f32;
        luminance[index] = color * alpha + 255.0 * (1.0 - alpha);
        coverage[index] = pixel[3] as f32;
    }

    let mut softened = luminance.clone();
    let kernel = [[1_f32, 2.0, 1.0], [2.0, 4.0, 2.0], [1.0, 2.0, 1.0]];
    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let mut sum = 0_f32;
            for (kernel_y, row) in kernel.iter().enumerate() {
                for (kernel_x, weight) in row.iter().enumerate() {
                    let source_x = x + kernel_x - 1;
                    let source_y = y + kernel_y - 1;
                    sum += luminance[source_y * width + source_x] * weight;
                }
            }
            softened[y * width + x] = sum / 16.0;
        }
    }

    let mut edges = vec![0_u8; width * height];
    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let top_left = (y - 1) * width + x - 1;
            let top = (y - 1) * width + x;
            let top_right = (y - 1) * width + x + 1;
            let left = y * width + x - 1;
            let right = y * width + x + 1;
            let bottom_left = (y + 1) * width + x - 1;
            let bottom = (y + 1) * width + x;
            let bottom_right = (y + 1) * width + x + 1;

            let luma_x = -softened[top_left] + softened[top_right] - 2.0 * softened[left]
                + 2.0 * softened[right]
                - softened[bottom_left]
                + softened[bottom_right];
            let luma_y = -softened[top_left] - 2.0 * softened[top] - softened[top_right]
                + softened[bottom_left]
                + 2.0 * softened[bottom]
                + softened[bottom_right];
            let alpha_x = -coverage[top_left] + coverage[top_right] - 2.0 * coverage[left]
                + 2.0 * coverage[right]
                - coverage[bottom_left]
                + coverage[bottom_right];
            let alpha_y = -coverage[top_left] - 2.0 * coverage[top] - coverage[top_right]
                + coverage[bottom_left]
                + 2.0 * coverage[bottom]
                + coverage[bottom_right];

            let color_edge = luma_x.hypot(luma_y);
            let silhouette_edge = alpha_x.hypot(alpha_y);
            let strength = color_edge * 0.62 + silhouette_edge * 0.72;
            edges[y * width + x] = ((strength - 64.0) * 0.7).clamp(0.0, 230.0) as u8;
        }
    }

    let mut output = vec![0_u8; width * height * 4];
    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let target = (y * width + x) * 4;
            output[target..target + 4].copy_from_slice(&[255, 255, 255, edges[y * width + x]]);
        }
    }
    output
}

fn icon_handle_data_url(icon: HICON) -> Result<String, String> {
    const ICON_SIZE: i32 = 64;
    unsafe {
        let device_context = CreateCompatibleDC(None);
        if device_context.0.is_null() {
            let _ = DestroyIcon(icon);
            return Err("无法创建应用图标画布。".into());
        }

        let bitmap_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: ICON_SIZE,
                biHeight: -ICON_SIZE,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels_pointer = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(
            Some(device_context),
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut pixels_pointer,
            None,
            0,
        ) {
            Ok(bitmap) => bitmap,
            Err(error) => {
                let _ = DeleteDC(device_context);
                let _ = DestroyIcon(icon);
                return Err(format!("无法创建应用图标位图：{error}"));
            }
        };

        let previous_object = SelectObject(device_context, HGDIOBJ(bitmap.0));
        let draw_result = DrawIconEx(
            device_context,
            0,
            0,
            icon,
            ICON_SIZE,
            ICON_SIZE,
            0,
            None,
            DI_NORMAL,
        );

        let byte_count = (ICON_SIZE * ICON_SIZE * 4) as usize;
        let mut bgra = vec![0_u8; byte_count];
        if draw_result.is_ok() && !pixels_pointer.is_null() {
            std::ptr::copy_nonoverlapping(
                pixels_pointer.cast::<u8>(),
                bgra.as_mut_ptr(),
                byte_count,
            );
        }

        let _ = SelectObject(device_context, previous_object);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(device_context);
        let _ = DestroyIcon(icon);
        draw_result.map_err(|error| format!("无法绘制应用图标：{error}"))?;

        let has_alpha = bgra.chunks_exact(4).any(|pixel| pixel[3] != 0);
        let mut rgba = Vec::with_capacity(byte_count);
        for pixel in bgra.chunks_exact(4) {
            let alpha = if has_alpha {
                pixel[3]
            } else if pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0 {
                255
            } else {
                0
            };
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], alpha]);
        }

        let line_art = stylize_line_art(ICON_SIZE as u32, ICON_SIZE as u32, &rgba);
        rgba_png_data_url(ICON_SIZE as u32, ICON_SIZE as u32, &line_art)
    }
}

fn extract_icon_data_url(path: &PathBuf) -> Result<String, String> {
    let wide_path = wide_string(path.as_os_str());
    let mut file_info = SHFILEINFOW::default();
    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide_path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut file_info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if result == 0 || file_info.hIcon.0.is_null() {
        return Err("Windows 未返回该应用的图标。".into());
    }
    icon_handle_data_url(file_info.hIcon)
}

fn extract_packaged_app_icon_data_url(target: &str) -> Result<String, String> {
    let target = validate_app_target(target)?;
    let parsing_name = wide_string(OsStr::new(&format!(r"shell:AppsFolder\{target}")));
    let mut item_id_list: *mut ITEMIDLIST = std::ptr::null_mut();
    unsafe {
        SHParseDisplayName(
            PCWSTR(parsing_name.as_ptr()),
            None::<&IBindCtx>,
            &mut item_id_list,
            0,
            None,
        )
        .map_err(|error| format!("Windows 未找到该应用图标：{error}"))?;
    }
    if item_id_list.is_null() {
        return Err("Windows 未返回该应用图标。".into());
    }

    let mut file_info = SHFILEINFOW::default();
    let result = unsafe {
        let result = SHGetFileInfoW(
            PCWSTR(item_id_list.cast::<u16>()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut file_info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON | SHGFI_PIDL,
        );
        CoTaskMemFree(Some(item_id_list.cast()));
        result
    };
    if result == 0 || file_info.hIcon.0.is_null() {
        return Err("Windows 未返回该应用图标。".into());
    }
    icon_handle_data_url(file_info.hIcon)
}

#[tauri::command]
fn load_apps(app: AppHandle) -> Result<Vec<AppShortcut>, String> {
    let path = shortcuts_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path).map_err(|error| format!("无法读取应用配置：{error}"))?;
    let shortcuts: Vec<AppShortcut> =
        serde_json::from_str(&content).map_err(|error| format!("应用配置格式无效：{error}"))?;
    validate_shortcuts(&shortcuts)?;
    Ok(shortcuts)
}

#[tauri::command]
fn save_apps(app: AppHandle, shortcuts: Vec<AppShortcut>) -> Result<(), String> {
    validate_shortcuts(&shortcuts)?;
    let content = serde_json::to_string_pretty(&shortcuts)
        .map_err(|error| format!("无法整理应用配置：{error}"))?;
    storage::save_file(&shortcuts_path(&app)?, content.as_bytes())
}

#[tauri::command]
fn load_checklists(app: AppHandle) -> Result<Vec<Checklist>, String> {
    let path = checklists_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path).map_err(|error| format!("无法读取清单：{error}"))?;
    let checklists: Vec<Checklist> =
        serde_json::from_str(&content).map_err(|error| format!("清单格式无效：{error}"))?;
    validate_checklists(&checklists)?;
    Ok(checklists)
}

#[tauri::command]
fn save_checklists(app: AppHandle, mut checklists: Vec<Checklist>) -> Result<(), String> {
    for checklist in &mut checklists {
        checklist.name = checklist.name.trim().to_string();
        for task in &mut checklist.tasks {
            task.content = task.content.trim().to_string();
        }
    }
    validate_checklists(&checklists)?;
    let content = serde_json::to_string_pretty(&checklists)
        .map_err(|error| format!("无法整理清单：{error}"))?;
    storage::save_file(&checklists_path(&app)?, content.as_bytes())
}

#[tauri::command]
fn load_diaries(app: AppHandle) -> Result<Vec<DiaryEntry>, String> {
    let path = diaries_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path).map_err(|error| format!("无法读取日记：{error}"))?;
    let diaries: Vec<DiaryEntry> =
        serde_json::from_str(&content).map_err(|error| format!("日记格式无效：{error}"))?;
    validate_diaries(&diaries)?;
    Ok(diaries)
}

#[tauri::command]
fn save_diaries(app: AppHandle, mut diaries: Vec<DiaryEntry>) -> Result<(), String> {
    for entry in &mut diaries {
        entry.title = entry.title.trim().to_string();
        entry.content = entry.content.trim().to_string();
    }
    validate_diaries(&diaries)?;
    let content =
        serde_json::to_string_pretty(&diaries).map_err(|error| format!("无法整理日记：{error}"))?;
    storage::save_file(&diaries_path(&app)?, content.as_bytes())
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        let mut settings = AppSettings::default();
        settings.launch_on_startup = is_launch_on_startup_enabled()?;
        return Ok(settings);
    }

    let content = fs::read_to_string(path).map_err(|error| format!("无法读取设置：{error}"))?;
    let mut settings: AppSettings =
        serde_json::from_str(&content).map_err(|error| format!("设置格式无效：{error}"))?;
    normalize_workspace_preferences(&mut settings);
    settings.launch_on_startup = is_launch_on_startup_enabled()?;
    if settings.launch_on_startup {
        set_launch_on_startup(true)?;
    }
    validate_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
fn save_settings(app: AppHandle, mut settings: AppSettings) -> Result<(), String> {
    settings.anniversary_name = settings.anniversary_name.trim().to_string();
    validate_settings(&settings)?;
    set_launch_on_startup(settings.launch_on_startup)?;
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("无法整理设置：{error}"))?;
    storage::save_file(&settings_path(&app)?, content.as_bytes())
}

#[tauri::command]
fn get_app_icon(target: String, kind: ShortcutKind) -> Result<Option<String>, String> {
    let path = match kind {
        ShortcutKind::Local => validate_target(&target, true)?,
        ShortcutKind::Web => {
            validate_web_url(&target)?;
            let Some(path) = edge_executable() else {
                return Ok(None);
            };
            path
        }
        ShortcutKind::Folder => {
            validate_folder_target(&target, true)?;
            return Ok(None);
        }
        ShortcutKind::App => {
            return Ok(extract_packaged_app_icon_data_url(&target).ok());
        }
    };
    Ok(extract_icon_data_url(&path).ok())
}

#[derive(Debug, Serialize)]
struct LaunchError {
    code: &'static str,
    message: String,
}

impl From<String> for LaunchError {
    fn from(message: String) -> Self {
        Self {
            code: "open_failed",
            message,
        }
    }
}

fn local_launch_target(target: &str, kind: ShortcutKind) -> Result<PathBuf, LaunchError> {
    let path = match kind {
        ShortcutKind::Local => validate_target(target, false)?,
        ShortcutKind::Folder => validate_folder_target(target, false)?,
        ShortcutKind::Web | ShortcutKind::App => {
            return Err("这个入口无需重新定位。".to_string().into())
        }
    };
    let metadata = fs::metadata(&path).map_err(|error| LaunchError {
        code: if error.kind() == std::io::ErrorKind::NotFound {
            "target_missing"
        } else {
            "open_failed"
        },
        message: "暂时无法访问这个位置。".into(),
    })?;
    if (matches!(kind, ShortcutKind::Folder) && !metadata.is_dir())
        || (matches!(kind, ShortcutKind::Local) && !metadata.is_file())
    {
        return Err("请选择相同类型的本地目标。".to_string().into());
    }
    Ok(path)
}

#[tauri::command]
fn validate_relocation(target: String, kind: ShortcutKind) -> Result<(), LaunchError> {
    local_launch_target(&target, kind).map(|_| ())
}

#[tauri::command]
fn launch_app(target: String, kind: ShortcutKind) -> Result<(), LaunchError> {
    if matches!(kind, ShortcutKind::Web) {
        return open_web_url(&target).map_err(Into::into);
    }
    if matches!(kind, ShortcutKind::App) {
        let target = validate_app_target(&target)?;
        return Command::new("explorer.exe")
            .arg(format!(r"shell:AppsFolder\{target}"))
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("无法打开这个应用：{error}").into());
    }
    let path = local_launch_target(&target, kind)?;
    Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开这个入口：{error}").into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_apps,
            save_apps,
            load_checklists,
            save_checklists,
            load_diaries,
            save_diaries,
            load_settings,
            save_settings,
            storage::load_drafts,
            storage::save_drafts,
            storage::load_scratchpad,
            storage::save_scratchpad,
            storage::list_backups,
            storage::export_backup,
            storage::inspect_backup,
            storage::restore_backup,
            storage::export_diary,
            list_installed_apps,
            get_app_icon,
            detect_running_apps,
            launch_app,
            validate_relocation
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Serenook");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_app_scan_returns_ordered_candidates_with_valid_launch_targets() {
        let candidates = list_installed_apps().unwrap();
        assert!(!candidates.is_empty());
        assert!(candidates
            .windows(2)
            .all(|pair| { pair[0].name.to_lowercase() <= pair[1].name.to_lowercase() }));
        if let Some(target) = candidates
            .iter()
            .find(|candidate| candidate.kind == Some(ShortcutKind::App))
            .and_then(|candidate| candidate.target.as_deref())
        {
            assert!(extract_packaged_app_icon_data_url(target).is_ok());
        }
        for candidate in candidates {
            match (candidate.kind, candidate.target) {
                (Some(ShortcutKind::Local), Some(target)) => {
                    assert!(validate_target(&target, true).is_ok());
                }
                (Some(ShortcutKind::App), Some(target)) => {
                    assert!(validate_app_target(&target).is_ok());
                }
                (None, None) => {}
                _ => panic!("installed application target and kind must be paired"),
            }
        }
    }

    #[test]
    fn display_icon_parser_accepts_a_quoted_executable_with_an_index() {
        let executable = env::current_exe().unwrap();
        let display_icon = format!(r#""{}",0"#, executable.display());
        assert_eq!(display_icon_path(&display_icon), Some(executable));
    }

    #[test]
    fn relocation_distinguishes_missing_targets_and_rejects_wrong_types() {
        let executable = env::current_exe().unwrap();
        assert!(local_launch_target(executable.to_str().unwrap(), ShortcutKind::Local).is_ok());
        assert!(local_launch_target(
            executable.parent().unwrap().to_str().unwrap(),
            ShortcutKind::Folder
        )
        .is_ok());
        assert_eq!(
            local_launch_target(executable.to_str().unwrap(), ShortcutKind::Folder)
                .unwrap_err()
                .code,
            "open_failed"
        );
        let missing = executable.join("serenook-missing-target.txt");
        assert!(local_launch_target(missing.to_str().unwrap(), ShortcutKind::Local).is_err());
        let absent = env::temp_dir().join(format!(
            "serenook-relocate-{}-missing.txt",
            std::process::id()
        ));
        assert_eq!(
            local_launch_target(absent.to_str().unwrap(), ShortcutKind::Local)
                .unwrap_err()
                .code,
            "target_missing"
        );
        assert_eq!(
            local_launch_target("https://example.com", ShortcutKind::Web)
                .unwrap_err()
                .code,
            "open_failed"
        );
    }

    fn shortcut(id: &str, name: &str, target: &str) -> AppShortcut {
        AppShortcut {
            id: id.into(),
            name: name.into(),
            target: target.into(),
            icon: "app".into(),
            kind: ShortcutKind::Local,
            sleeping: false,
            wake_days: None,
        }
    }

    fn checklist(id: &str, name: &str, content: &str) -> Checklist {
        Checklist {
            id: id.into(),
            name: name.into(),
            archived: false,
            daily_reset: true,
            last_reset_date: Some("2026-08-29".into()),
            tasks: vec![ChecklistTask {
                id: format!("{id}-task"),
                content: content.into(),
                completed: false,
                important: false,
                shortcut_id: None,
            }],
        }
    }

    fn diary(id: &str, title: &str, content: &str) -> DiaryEntry {
        DiaryEntry {
            id: id.into(),
            title: title.into(),
            content: content.into(),
            created_at: "2026-08-30T01:02:03.000Z".into(),
            updated_at: "2026-08-30T02:03:04.000Z".into(),
        }
    }

    #[test]
    fn accepts_supported_absolute_paths() {
        assert!(validate_target(r"C:\Tools\Example.exe", false).is_ok());
        assert!(validate_target(r"D:\Links\Example.lnk", false).is_ok());
        assert!(validate_target(r"D:\Notes\Example.txt", false).is_ok());
        assert!(validate_target(r"D:\Notes\Example.csv", false).is_ok());
        assert!(validate_target(r"D:\Notes\Example.xlsx", false).is_ok());
        assert!(validate_target(r"D:\Notes\Example.docx", false).is_ok());
        assert!(validate_target(r"D:\Notes\Example.pdf", false).is_ok());
        assert!(validate_target(r"D:\Notes\Example.pptx", false).is_ok());
    }

    #[test]
    fn rejects_relative_or_unsupported_paths() {
        assert!(validate_target(r"Tools\Example.exe", false).is_err());
        assert!(validate_target(r"C:\Tools\Example.zip", false).is_err());
    }

    #[test]
    fn accepts_only_absolute_folder_paths() {
        assert!(validate_folder_target(r"C:\Users\Example\Documents", false).is_ok());
        assert!(validate_folder_target(r"Documents", false).is_err());
    }

    #[test]
    fn accepts_only_http_web_urls() {
        assert!(validate_web_url("https://example.com/work").is_ok());
        assert!(validate_web_url("http://localhost:1420").is_ok());
        assert!(validate_web_url("file:///C:/secret.txt").is_err());
        assert!(validate_web_url("example.com").is_err());
    }

    #[test]
    fn rejects_duplicate_ids() {
        let shortcuts = vec![
            shortcut("same", "One", r"C:\Tools\One.exe"),
            shortcut("same", "Two", r"C:\Tools\Two.exe"),
        ];
        assert!(validate_shortcuts(&shortcuts).is_err());
    }

    #[test]
    fn encodes_rgba_as_png_data_url() {
        let data_url = rgba_png_data_url(1, 1, &[204, 120, 92, 255]).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,iVBORw0KGgo"));
    }

    #[test]
    fn defaults_legacy_shortcuts_to_awake() {
        let shortcut: AppShortcut = serde_json::from_str(
            r#"{"id":"legacy","name":"Legacy","target":"C:\\Tools\\Legacy.exe","icon":"app"}"#,
        )
        .unwrap();
        assert!(!shortcut.sleeping);
        assert_eq!(shortcut.kind, ShortcutKind::Local);
        assert!(shortcut.wake_days.is_none());
    }

    #[test]
    fn validates_weekly_wake_days() {
        let mut valid = shortcut("valid", "Valid", r"C:\Tools\Valid.exe");
        valid.wake_days = Some(vec![1, 3, 5]);
        assert!(validate_shortcuts(&[valid]).is_ok());

        let mut duplicate = shortcut("duplicate", "Duplicate", r"C:\Tools\Duplicate.exe");
        duplicate.wake_days = Some(vec![1, 1]);
        assert!(validate_shortcuts(&[duplicate]).is_err());

        let mut out_of_range = shortcut("range", "Range", r"C:\Tools\Range.exe");
        out_of_range.wake_days = Some(vec![7]);
        assert!(validate_shortcuts(&[out_of_range]).is_err());
    }

    #[test]
    fn validates_checklist_names_tasks_and_ids() {
        let valid = checklist("today", "今日", "整理桌面");
        assert!(validate_checklists(&[valid]).is_ok());

        let duplicate = vec![
            checklist("same", "清单一", "任务一"),
            checklist("same", "清单二", "任务二"),
        ];
        assert!(validate_checklists(&duplicate).is_err());

        let mut empty_task = checklist("empty", "清单", "任务");
        empty_task.tasks[0].content = "  ".into();
        assert!(validate_checklists(&[empty_task]).is_err());
    }

    #[test]
    fn defaults_legacy_tasks_to_not_important() {
        let task: ChecklistTask =
            serde_json::from_str(r#"{"id":"legacy","content":"旧任务","completed":false}"#)
                .unwrap();
        assert!(!task.important);
    }

    #[test]
    fn validates_diaries_and_utc_timestamps() {
        assert!(validate_diaries(&[diary("one", "此刻", "安静地写下一页。")]).is_ok());
        assert!(is_valid_utc_timestamp("2026-08-30T01:02:03.004Z"));
        assert!(!is_valid_utc_timestamp("2026-08-30 01:02:03"));

        let mut invalid = diary("bad", " ", "内容");
        invalid.updated_at = "2026-08-29T01:02:03.000Z".into();
        assert!(validate_diaries(&[invalid]).is_err());
    }

    #[test]
    fn validates_anniversary_names() {
        let mut settings = AppSettings::default();
        settings.anniversary_name = "Birth".into();
        assert!(validate_settings(&settings).is_ok());

        settings.anniversary_name = "TooLongName".into();
        assert!(validate_settings(&settings).is_err());

        settings.anniversary_name = "Dog 1".into();
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn validates_real_anniversary_dates() {
        assert!(is_valid_calendar_date("2024-02-29"));
        assert!(!is_valid_calendar_date("2023-02-29"));
        assert!(!is_valid_calendar_date("2024-13-01"));
        assert!(!is_valid_calendar_date("24-02-29"));
    }

    #[test]
    fn defaults_legacy_settings_to_no_startup() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"signature":"旧版签名会被安静忽略"}"#).unwrap();
        assert!(!settings.launch_on_startup);
        assert!(settings.has_completed_welcome);
        assert_eq!(settings.theme, ThemePreference::System);
        assert!(settings.anniversary_date.is_none());
        assert_eq!(settings.anniversary_name, DEFAULT_ANNIVERSARY_NAME);
        assert_eq!(settings.workspace_order, default_workspace_order());
        assert!(settings.collapsed_modules.is_empty());
    }

    #[test]
    fn validates_workspace_module_preferences() {
        let mut settings = AppSettings::default();
        settings.workspace_order = vec![
            "diaries".into(),
            "checklists".into(),
            "shortcuts".into(),
            "scratchpad".into(),
        ];
        settings.collapsed_modules = vec!["shortcuts".into()];
        assert!(validate_settings(&settings).is_ok());

        settings.workspace_order = vec!["shortcuts".into(), "shortcuts".into()];
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn normalizes_legacy_workspace_module_preferences() {
        let mut settings = AppSettings::default();
        settings.workspace_order = vec!["checklists".into(), "shortcuts".into()];
        normalize_workspace_preferences(&mut settings);
        assert_eq!(
            settings.workspace_order,
            vec!["checklists", "shortcuts", "diaries", "scratchpad"]
        );
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn turns_icon_shapes_into_transparent_line_art() {
        let mut source = vec![0_u8; 7 * 7 * 4];
        for y in 2..5 {
            for x in 2..5 {
                let index = (y * 7 + x) * 4;
                source[index..index + 4].copy_from_slice(&[30, 40, 50, 255]);
            }
        }
        let result = stylize_line_art(7, 7, &source);
        assert!(result.chunks_exact(4).any(|pixel| pixel[3] > 0));
        assert_eq!(result[(3 * 7 + 3) * 4 + 3], 0);
    }

    #[test]
    fn detects_the_current_executable_by_full_path() {
        let current = env::current_exe().unwrap();
        let target = current.to_string_lossy().to_string();
        let running = detect_running_apps(vec![target.clone()]).unwrap();
        assert!(running.contains(&target));
    }
}
