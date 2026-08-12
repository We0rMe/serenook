#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::CloseHandle,
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
        },
        Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Shell::{SHGetFileInfoW, ShellExecuteW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON},
            WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, SW_SHOWNORMAL},
        },
    },
};

const MAX_SHORTCUTS: usize = 40;
const MAX_SIGNATURE_CHARACTERS: usize = 48;
const DEFAULT_SIGNATURE: &str = "慢一点，也是在向前。";
const ALLOWED_EXTENSIONS: [&str; 5] = ["exe", "lnk", "bat", "cmd", "url"];
const ALLOWED_ICONS: [&str; 5] = ["app", "chat", "code", "compass", "folder"];

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ShortcutKind {
    #[default]
    Local,
    Web,
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    signature: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            signature: DEFAULT_SIGNATURE.into(),
        }
    }
}

fn config_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法确定配置目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建配置目录：{error}"))?;
    Ok(directory)
}

fn shortcuts_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_directory(app)?.join("shortcuts.json"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_directory(app)?.join("settings.json"))
}

fn validate_target(target: &str, require_exists: bool) -> Result<PathBuf, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("请选择应用程序文件。".into());
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
        return Err("仅支持 .exe、.lnk、.bat、.cmd 和 .url 文件。".into());
    }

    if require_exists && !path.is_file() {
        return Err("找不到该应用程序，请在编辑模式中重新选择。".into());
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
        return Err(format!("最多可以保存 {MAX_SHORTCUTS} 个应用。"));
    }

    let mut ids = HashSet::with_capacity(shortcuts.len());
    for shortcut in shortcuts {
        let name = shortcut.name.trim();
        if shortcut.id.trim().is_empty() || !ids.insert(shortcut.id.as_str()) {
            return Err("应用标识无效或重复。".into());
        }
        if name.is_empty() || name.chars().count() > 64 {
            return Err("应用名称应为 1 到 64 个字符。".into());
        }
        if !ALLOWED_ICONS.contains(&shortcut.icon.as_str()) {
            return Err("应用图标类型无效。".into());
        }
        match shortcut.kind {
            ShortcutKind::Local => {
                validate_target(&shortcut.target, false)?;
            }
            ShortcutKind::Web => {
                validate_web_url(&shortcut.target)?;
            }
        }
    }

    Ok(())
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    let length = settings.signature.trim().chars().count();
    if length == 0 || length > MAX_SIGNATURE_CHARACTERS {
        return Err(format!("签名应为 1 到 {MAX_SIGNATURE_CHARACTERS} 个字符。"));
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

fn extract_icon_data_url(path: &PathBuf) -> Result<String, String> {
    const ICON_SIZE: i32 = 64;

    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut file_info = SHFILEINFOW::default();
        let result = SHGetFileInfoW(
            PCWSTR(wide_path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut file_info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if result == 0 || file_info.hIcon.0.is_null() {
            return Err("Windows 未返回该应用的图标。".into());
        }

        let icon = file_info.hIcon;
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
    fs::write(shortcuts_path(&app)?, content).map_err(|error| format!("无法保存应用配置：{error}"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let content = fs::read_to_string(path).map_err(|error| format!("无法读取设置：{error}"))?;
    let settings: AppSettings =
        serde_json::from_str(&content).map_err(|error| format!("设置格式无效：{error}"))?;
    validate_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
fn save_settings(app: AppHandle, mut settings: AppSettings) -> Result<(), String> {
    settings.signature = settings.signature.trim().to_string();
    validate_settings(&settings)?;
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("无法整理设置：{error}"))?;
    fs::write(settings_path(&app)?, content).map_err(|error| format!("无法保存设置：{error}"))
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
    };
    Ok(extract_icon_data_url(&path).ok())
}

#[tauri::command]
fn launch_app(target: String, kind: ShortcutKind) -> Result<(), String> {
    match kind {
        ShortcutKind::Local => {
            let path = validate_target(&target, true)?;
            Command::new("explorer.exe")
                .arg(path)
                .spawn()
                .map(|_| ())
                .map_err(|error| format!("无法启动应用：{error}"))
        }
        ShortcutKind::Web => open_web_url(&target),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_apps,
            save_apps,
            load_settings,
            save_settings,
            get_app_icon,
            detect_running_apps,
            launch_app
        ])
        .run(tauri::generate_context!())
        .expect("failed to run JuvenileScholar");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shortcut(id: &str, name: &str, target: &str) -> AppShortcut {
        AppShortcut {
            id: id.into(),
            name: name.into(),
            target: target.into(),
            icon: "app".into(),
            kind: ShortcutKind::Local,
            sleeping: false,
        }
    }

    #[test]
    fn accepts_supported_absolute_paths() {
        assert!(validate_target(r"C:\Tools\Example.exe", false).is_ok());
        assert!(validate_target(r"D:\Links\Example.lnk", false).is_ok());
    }

    #[test]
    fn rejects_relative_or_unsupported_paths() {
        assert!(validate_target(r"Tools\Example.exe", false).is_err());
        assert!(validate_target(r"C:\Tools\Example.txt", false).is_err());
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
    }

    #[test]
    fn validates_custom_signature() {
        assert!(validate_settings(&AppSettings::default()).is_ok());
        assert!(validate_settings(&AppSettings {
            signature: " ".into()
        })
        .is_err());
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
