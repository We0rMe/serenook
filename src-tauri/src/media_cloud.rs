//! Compatibility for CloudMusic versions that do not publish an SMTC session.
//! Reads only the player's own minibar; never installs a plugin or sends global keys.
use windows::{
    core::{Interface, BOOL},
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        System::{
            Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            Variant::VARIANT,
        },
        UI::{Accessibility::*, WindowsAndMessaging::*},
    },
};

#[derive(Clone, Default)]
pub struct Cloud {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub playing: Option<bool>,
    pub position: Option<f64>,
    pub duration: Option<f64>,
    pub previous: bool,
    pub next: bool,
}

fn split_title(value: &str) -> Option<(String, String)> {
    let value = value.trim().trim_end_matches(" - 网易云音乐");
    let (title, artist) = value.rsplit_once(" - ")?;
    if title.is_empty() || artist.is_empty() {
        return None;
    }
    Some((title.to_owned(), artist.to_owned()))
}

pub fn clock(value: &str) -> Option<f64> {
    let parts: Vec<_> = value.trim().split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds = 0u32;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let number = part.parse::<u32>().ok()?;
        if i > 0 && number >= 60 {
            return None;
        }
        seconds = seconds.checked_mul(60)?.checked_add(number)?;
    }
    Some(seconds as f64)
}

struct PlayerWindows {
    suffix: &'static str,
    rows: Vec<(HWND, Cloud)>,
}

unsafe extern "system" fn enumerate(hwnd: HWND, context: LPARAM) -> BOOL {
    let target = &mut *(context.0 as *mut PlayerWindows);
    // Hidden main windows are deliberately included (the player may be in its tray).
    let mut buffer = [0u16; 1024];
    let length = GetWindowTextW(hwnd, &mut buffer);
    if length <= 0 {
        return BOOL(1);
    }
    let value = String::from_utf16_lossy(&buffer[..length as usize]);
    let Some((title, artist)) = split_title(&value) else {
        return BOOL(1);
    };
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        let mut path = [0u16; 2048];
        let mut size = path.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(path.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(process);
        if result.is_ok()
            && String::from_utf16_lossy(&path[..size as usize])
                .to_lowercase()
                .ends_with(target.suffix)
        {
            target.rows.push((
                hwnd,
                Cloud {
                    id: format!("cloud:{pid}:{}", hwnd.0 as usize),
                    title,
                    artist,
                    ..Cloud::default()
                },
            ));
        }
    }
    BOOL(1)
}

fn player_windows(suffix: &'static str) -> Vec<(HWND, Cloud)> {
    let mut target = PlayerWindows {
        suffix,
        rows: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(enumerate), LPARAM(&mut target as *mut _ as isize));
    }
    target.rows
}

pub struct Timeline {
    pub position: f64,
    pub duration: f64,
    pub can_seek: bool,
}

// Read the two time labels in the verified player's footer, never infer time
// from app uptime. Only a RangeValue control between those labels is seekable.
unsafe fn footer_timeline(
    hwnd: HWND,
    qq: bool,
) -> windows::core::Result<(Timeline, Option<IUIAutomationRangeValuePattern>)> {
    let automation: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
    let limits: IUIAutomation2 = automation.cast()?;
    limits.SetConnectionTimeout(800)?;
    limits.SetTransactionTimeout(800)?;
    let root = automation.ElementFromHandle(hwnd)?;
    let condition = automation.CreatePropertyCondition(
        if qq {
            UIA_NamePropertyId
        } else {
            UIA_AutomationIdPropertyId
        },
        &VARIANT::from(if qq {
            "下一曲"
        } else {
            "btn_pc_minibar_play"
        }),
    )?;
    let anchor = root.FindFirst(TreeScope_Descendants, &condition)?;
    let walker = automation.ControlViewWalker()?;
    let mut parent = walker.GetParentElement(&anchor)?;
    for _ in 0..4 {
        let elements = parent.FindAll(TreeScope_Descendants, &automation.CreateTrueCondition()?)?;
        if elements.Length()? > 160 {
            break;
        }
        let mut times = Vec::new();
        let mut ranges = Vec::new();
        for i in 0..elements.Length()? {
            let e = elements.GetElement(i)?;
            let name = e.CurrentName()?.to_string();
            if e.CurrentControlType()? == UIA_TextControlTypeId {
                if let Some(time) = clock(&name) {
                    times.push((time, e.CurrentBoundingRectangle()?));
                }
            }
            if let Ok(range) =
                e.GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
            {
                if !range.CurrentIsReadOnly()?.as_bool() && e.CurrentIsEnabled()?.as_bool() {
                    ranges.push((range, e.CurrentBoundingRectangle()?));
                }
            }
        }
        if times.len() == 2 && times[1].0 > 0.0 && times[0].0 <= times[1].0 {
            let (left, right) = (times[0].1, times[1].1);
            let range = ranges
                .into_iter()
                .find(|(range, rect)| {
                    rect.right > rect.left
                        && rect.left >= left.right - 4
                        && rect.right <= right.left + 4
                        && rect.top < left.bottom + 8
                        && rect.bottom > left.top - 8
                        && range
                            .CurrentMinimum()
                            .ok()
                            .zip(range.CurrentMaximum().ok())
                            .is_some_and(|(min, max)| {
                                min.is_finite() && max.is_finite() && max > min
                            })
                })
                .map(|(range, _)| range);
            return Ok((
                Timeline {
                    position: times[0].0,
                    duration: times[1].0,
                    can_seek: range.is_some(),
                },
                range,
            ));
        }
        parent = walker.GetParentElement(&parent)?;
    }
    Err(windows::core::Error::from_hresult(windows::core::HRESULT(
        0x80004005u32 as i32,
    )))
}

fn matching_window(app_id: &str, title: &str, artist: &str) -> Option<(HWND, bool)> {
    let app = app_id.to_lowercase();
    let qq = app.contains("qqmusic");
    let suffix = if qq {
        "\\qqmusic.exe"
    } else if app.contains("cloudmusic") || app.contains("netease") {
        "\\cloudmusic.exe"
    } else {
        return None;
    };
    let mut windows = player_windows(suffix).into_iter().filter(|(hwnd, c)| {
        c.title == title && c.artist == artist && unsafe { IsWindowVisible(*hwnd).as_bool() }
    });
    let (hwnd, _) = windows.next()?;
    if windows.next().is_some() {
        return None;
    }
    Some((hwnd, qq))
}

pub fn timeline(app: &str, title: &str, artist: &str) -> Option<Timeline> {
    let (hwnd, qq) = matching_window(app, title, artist)?;
    unsafe { footer_timeline(hwnd, qq).ok().map(|(timeline, _)| timeline) }
}

pub fn seek(app: &str, title: &str, artist: &str, seconds: f64) -> Result<(), String> {
    let (hwnd, qq) = matching_window(app, title, artist).ok_or("播放器已经切换曲目，请重试。")?;
    unsafe {
        let (timeline, range) =
            footer_timeline(hwnd, qq).map_err(|_| "播放器暂不支持调整进度。")?;
        let range = range.ok_or("播放器暂不支持调整进度。")?;
        let min = range.CurrentMinimum().map_err(|_| "进度暂不可用。")?;
        let max = range.CurrentMaximum().map_err(|_| "进度暂不可用。")?;
        range
            .SetValue(min + (max - min) * (seconds / timeline.duration).clamp(0.0, 1.0))
            .map_err(|_| "播放器暂未响应进度调整。".to_owned())
    }
}

unsafe fn minibar(
    hwnd: HWND,
) -> windows::core::Result<(IUIAutomation, IUIAutomationElement, IUIAutomationElement)> {
    let automation: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
    let limits: IUIAutomation2 = automation.cast()?;
    limits.SetConnectionTimeout(1200)?;
    limits.SetTransactionTimeout(1200)?;
    let root = automation.ElementFromHandle(hwnd)?;
    let condition = automation.CreatePropertyCondition(
        UIA_AutomationIdPropertyId,
        &VARIANT::from("btn_pc_minibar_play"),
    )?;
    let play = root.FindFirst(TreeScope_Descendants, &condition)?;
    let walker = automation.ControlViewWalker()?;
    let mut parent = walker.GetParentElement(&play)?;
    // Stop at the footer, not at the page (whose recommendations also have play buttons).
    for _ in 0..5 {
        if parent.CurrentLocalizedControlType()?.to_string() == "内容信息" {
            return Ok((automation, parent, play));
        }
        if parent.CurrentControlType()? == UIA_GroupControlTypeId
            || parent.CurrentLocalizedControlType()?.to_string() == "内容信息"
        {
            let all = parent.FindAll(TreeScope_Descendants, &automation.CreateTrueCondition()?)?;
            if (0..all.Length()?.min(100)).any(|i| {
                all.GetElement(i)
                    .and_then(|e| e.CurrentName())
                    .ok()
                    .is_some_and(|s| clock(&s.to_string()).is_some())
            }) {
                return Ok((automation, parent, play));
            }
        }
        parent = walker.GetParentElement(&parent)?;
    }
    Err(windows::core::Error::from_hresult(windows::core::HRESULT(
        0x80004005u32 as i32,
    )))
}

unsafe fn read(hwnd: HWND, cloud: &mut Cloud) {
    let Ok((automation, footer, play)) = minibar(hwnd) else {
        return;
    };
    let name = play
        .CurrentName()
        .map(|s| s.to_string())
        .unwrap_or_default();
    cloud.playing = match name.as_str() {
        "pause" => Some(true),
        "play" => Some(false),
        _ => None,
    };
    let Ok(condition) = automation.CreateTrueCondition() else {
        return;
    };
    let Ok(cache) = automation.CreateCacheRequest() else {
        return;
    };
    for property in [
        UIA_NamePropertyId,
        UIA_ControlTypePropertyId,
        UIA_IsEnabledPropertyId,
    ] {
        if cache.AddProperty(property).is_err() {
            return;
        }
    }
    let Ok(elements) = footer.FindAllBuildCache(TreeScope_Descendants, &condition, &cache) else {
        return;
    };
    let mut times = Vec::new();
    for i in 0..elements.Length().unwrap_or(0).min(150) {
        let Ok(e) = elements.GetElement(i) else {
            continue;
        };
        let name = e.CachedName().map(|s| s.to_string()).unwrap_or_default();
        if e.CachedControlType().ok() == Some(UIA_TextControlTypeId) {
            if let Some(value) = clock(&name) {
                times.push(value);
            }
        }
        if e.CachedControlType().ok() == Some(UIA_ButtonControlTypeId)
            && e.CachedIsEnabled().unwrap_or_default().as_bool()
        {
            cloud.previous |= name == "pre";
            cloud.next |= name == "next";
        }
    }
    if times.len() == 2 && times[1] > 0.0 && times[0] <= times[1] {
        cloud.position = Some(times[0]);
        cloud.duration = Some(times[1]);
    }
}

pub fn discover() -> Vec<Cloud> {
    let rows = player_windows("\\cloudmusic.exe");
    // One main player window per process; prefer one exposing the actual minibar.
    let mut result = Vec::<Cloud>::new();
    for (hwnd, mut cloud) in rows.into_iter().take(8) {
        unsafe {
            read(hwnd, &mut cloud);
        }
        if let Some(old) = result
            .iter_mut()
            .find(|v| v.id.split(':').nth(1) == cloud.id.split(':').nth(1))
        {
            if cloud.playing.is_some() {
                *old = cloud;
            }
        } else {
            result.push(cloud);
        }
    }
    result
}

pub fn control(id: &str, action: &str) -> Result<(), String> {
    // Re-discover before every command; an obsolete/reused HWND must never receive it.
    let rows = player_windows("\\cloudmusic.exe");
    let (hwnd, _) = rows
        .into_iter()
        .find(|(_, v)| v.id == id)
        .ok_or("网易云音乐已退出或播放栏暂不可用。")?;
    unsafe {
        let (automation, footer, play) =
            minibar(hwnd).map_err(|_| "网易云播放栏暂不可用，请打开播放器后重试。")?;
        let playing = match play
            .CurrentName()
            .map(|n| n.to_string())
            .unwrap_or_default()
            .as_str()
        {
            "pause" => Some(true),
            "play" => Some(false),
            _ => None,
        };
        let button = match action {
            "play" if playing == Some(false) => play,
            "pause" if playing == Some(true) => play,
            "play" | "pause" if playing.is_some() => return Ok(()),
            "previous" | "next" => {
                let name = if action == "previous" { "pre" } else { "next" };
                let condition = automation
                    .CreatePropertyCondition(UIA_NamePropertyId, &VARIANT::from(name))
                    .map_err(|_| "播放控制暂不可用。")?;
                footer
                    .FindFirst(TreeScope_Descendants, &condition)
                    .map_err(|_| "播放器不支持此操作。")?
            }
            _ => return Err("播放器不支持此操作。".into()),
        };
        button
            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .and_then(|p| p.Invoke())
            .map_err(|_| "播放器暂未响应此操作。".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Reads the current QQ footer without changing playback"]
    fn qq_timeline_probe() {
        unsafe {
            windows::Win32::System::WinRT::RoInitialize(
                windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
            )
            .unwrap();
        }
        let rows = player_windows("\\qqmusic.exe");
        println!("QQ candidate windows: {}", rows.len());
        for (hwnd, cloud) in rows {
            println!(
                "Window {} track {} by {}",
                hwnd.0 as usize, cloud.title, cloud.artist
            );
            match unsafe { footer_timeline(hwnd, true) } {
                Ok((t, _)) => println!(
                    "UIA clock {} / {}, seek={}",
                    t.position, t.duration, t.can_seek
                ),
                Err(e) => println!("UIA error: {e}"),
            }
        }
    }
    #[test]
    fn titles_and_times() {
        assert_eq!(
            split_title("Song - Live - Artist"),
            Some(("Song - Live".into(), "Artist".into()))
        );
        assert_eq!(split_title("网易云音乐"), None);
        assert_eq!(clock("02:57"), Some(177.0));
        assert_eq!(clock(" 00:27 "), Some(27.0));
        assert_eq!(clock("01:02:03"), Some(3723.0));
        assert_eq!(clock("12:99"), None);
        assert_eq!(clock("search"), None);
    }
}
