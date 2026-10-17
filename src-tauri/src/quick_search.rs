use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow, SetForegroundWindow},
};

#[derive(Default)]
pub struct QuickSearch {
    operation: Mutex<()>,
    state: Mutex<SearchState>,
}

#[derive(Default)]
struct SearchState {
    registered: Option<String>,
    return_target: Option<ReturnTarget>,
}

struct ReturnTarget {
    window: isize,
    minimized: bool,
}

// Deliberately exclude Windows keys, single-modifier shortcuts and system keys.
// This reduces common conflicts; only the OS can decide whether registration succeeds.
pub fn validate(shortcut: Option<&str>) -> Result<(), String> {
    let Some(shortcut) = shortcut else {
        return Ok(());
    };
    let parts: Vec<_> = shortcut.split('+').collect();
    let modifiers = &parts[..parts.len().saturating_sub(1)];
    let key = parts.last().copied().unwrap_or_default();
    let valid_modifiers = matches!(
        modifiers,
        ["Control", "Alt"] | ["Control", "Shift"] | ["Control", "Alt", "Shift"]
    );
    let valid_key = key == "Space"
        || (key.len() == 1
            && key
                .bytes()
                .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit()));
    if !valid_modifiers || !valid_key || shortcut.parse::<Shortcut>().is_err() {
        return Err("请使用 Ctrl + Alt 或 Ctrl + Shift，再加一个字母、数字或空格。".into());
    }
    Ok(())
}

trait Registrar {
    fn register(&self, shortcut: &str) -> Result<(), String>;
    fn unregister(&self, shortcut: &str) -> Result<(), String>;
}

impl Registrar for AppHandle {
    fn register(&self, shortcut: &str) -> Result<(), String> {
        self.global_shortcut()
            .register(shortcut)
            .map_err(|_| "这个快捷键可能已被其他程序占用，或系统未允许注册。请换一组按键。".into())
    }
    fn unregister(&self, shortcut: &str) -> Result<(), String> {
        self.global_shortcut()
            .unregister(shortcut)
            .map_err(|_| "暂时无法释放快捷键，请重试。".into())
    }
}

fn replace_registration(
    registrar: &impl Registrar,
    current: &mut Option<String>,
    next: Option<String>,
) -> Result<(), String> {
    validate(next.as_deref())?;
    if *current == next {
        return Ok(());
    }
    // Reserve the replacement first: a conflict must not disable the working shortcut.
    if let Some(shortcut) = next.as_deref() {
        registrar.register(shortcut)?;
    }
    if let Some(shortcut) = current.as_deref() {
        if let Err(error) = registrar.unregister(shortcut) {
            if let Some(new) = next.as_deref() {
                let _ = registrar.unregister(new);
            }
            return Err(error);
        }
    }
    *current = next;
    Ok(())
}

#[tauri::command]
pub async fn set_quick_search_shortcut(
    app: AppHandle,
    shortcut: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<QuickSearch>();
        let _operation = shared
            .operation
            .lock()
            .map_err(|_| "快捷键设置暂不可用。")?;
        let mut current = shared
            .state
            .lock()
            .map_err(|_| "快捷键设置暂不可用。")?
            .registered
            .clone();
        // Do not hold the state lock while the plugin dispatches to the main thread.
        replace_registration(&app, &mut current, shortcut)?;
        shared
            .state
            .lock()
            .map_err(|_| "快捷键设置暂不可用。")?
            .registered = current;
        Ok(())
    })
    .await
    .map_err(|_| "快捷键设置暂不可用。".to_string())?
}

pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let shared = app.state::<QuickSearch>();
    {
        let Ok(mut state) = shared.state.lock() else {
            return;
        };
        if state
            .registered
            .as_deref()
            .and_then(|key| key.parse::<Shortcut>().ok())
            .as_ref()
            != Some(shortcut)
        {
            return;
        }
        if state.return_target.is_none() {
            let foreground = unsafe { GetForegroundWindow() };
            let main = window.hwnd().ok();
            if main != Some(foreground) {
                state.return_target = Some(ReturnTarget {
                    window: foreground.0 as isize,
                    minimized: window.is_minimized().unwrap_or(false),
                });
            }
        }
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("serenook://quick-search", ());
}

#[tauri::command]
pub fn finish_quick_search(app: AppHandle, return_to_previous: bool) {
    let shared = app.state::<QuickSearch>();
    let target = shared
        .state
        .lock()
        .ok()
        .and_then(|mut state| state.return_target.take());
    if !return_to_previous {
        return;
    }
    if let Some(target) = target {
        if target.minimized {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.minimize();
            }
        }
        let previous = HWND(target.window as *mut std::ffi::c_void);
        if unsafe { IsWindow(Some(previous)).as_bool() } {
            let _ = unsafe { SetForegroundWindow(previous) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeRegistrar {
        calls: RefCell<Vec<String>>,
        blocked: Option<&'static str>,
        fail_release: bool,
    }
    impl Registrar for FakeRegistrar {
        fn register(&self, key: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("register:{key}"));
            if self.blocked == Some(key) {
                Err("occupied".into())
            } else {
                Ok(())
            }
        }
        fn unregister(&self, key: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("unregister:{key}"));
            if self.fail_release && key == "Control+Alt+Space" {
                Err("busy".into())
            } else {
                Ok(())
            }
        }
    }
    #[test]
    fn shortcut_validation_excludes_common_and_system_combinations() {
        for key in [
            "Control+Alt+Space",
            "Control+Shift+K",
            "Control+Alt+Shift+1",
        ] {
            assert!(validate(Some(key)).is_ok());
        }
        for key in [
            "",
            "Control+K",
            "Alt+Space",
            "Super+R",
            "Control+Alt+F4",
            "Control+Shift+F12",
            "Control+Alt+Alt+K",
            "Control+Alt+Delete",
        ] {
            assert!(validate(Some(key)).is_err(), "{key}");
        }
        assert!(validate(None).is_ok());
    }
    #[test]
    fn conflict_keeps_previous_registration_and_success_releases_it() {
        let mut current = Some("Control+Alt+Space".into());
        let registrar = FakeRegistrar {
            blocked: Some("Control+Shift+K"),
            ..Default::default()
        };
        assert!(
            replace_registration(&registrar, &mut current, Some("Control+Shift+K".into())).is_err()
        );
        assert_eq!(current.as_deref(), Some("Control+Alt+Space"));
        assert_eq!(registrar.calls.borrow().len(), 1);
        let registrar = FakeRegistrar::default();
        replace_registration(&registrar, &mut current, Some("Control+Shift+K".into())).unwrap();
        assert_eq!(
            *registrar.calls.borrow(),
            ["register:Control+Shift+K", "unregister:Control+Alt+Space"]
        );
        replace_registration(&registrar, &mut current, None).unwrap();
        assert_eq!(current, None);
    }
    #[test]
    fn failed_release_rolls_back_replacement() {
        let registrar = FakeRegistrar {
            fail_release: true,
            ..Default::default()
        };
        let mut current = Some("Control+Alt+Space".into());
        assert!(
            replace_registration(&registrar, &mut current, Some("Control+Shift+K".into())).is_err()
        );
        assert_eq!(current.as_deref(), Some("Control+Alt+Space"));
        assert_eq!(
            registrar.calls.borrow().last().unwrap(),
            "unregister:Control+Shift+K"
        );
    }
}
