//! A local companion for the media sessions published by other Windows apps.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::{
    sync::{mpsc, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    Media::{Control::*, MediaPlaybackAutoRepeatMode},
    Storage::Streams::{DataReader, InputStreamOptions},
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};
use windows_future::{AsyncStatus, IAsyncOperation};

#[derive(Default)]
struct Service {
    manager: Option<GlobalSystemMediaTransportControlsSessionManager>,
    sessions: Vec<(String, GlobalSystemMediaTransportControlsSession)>,
    next_id: u64,
    cover_key: String,
    cover: Option<String>,
    cover_checked: Option<Instant>,
}
type MediaJob = Box<dyn FnOnce(&mut Service, bool) + Send>;
static WORKER: OnceLock<mpsc::SyncSender<MediaJob>> = OnceLock::new();

// UI Automation must have a stable MTA owner. Repeatedly tearing down a pool
// thread's apartment can stall RoUninitialize after a cross-process invocation.
// Keep media objects on one dedicated thread, not on Tokio's blocking pool.
async fn on_media_thread<T: Send + 'static>(
    operation: impl FnOnce(&mut Service) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let worker = WORKER.get_or_init(|| {
        let (send, receive) = mpsc::sync_channel::<MediaJob>(2);
        std::thread::Builder::new()
            .name("serenook-media".into())
            .spawn(move || {
                let apartment = Apartment::new();
                let mut service = Service::default();
                while let Ok(job) = receive.recv() {
                    job(&mut service, apartment.is_ok());
                }
            })
            .expect("create media worker");
        send
    });
    let (send, receive) = tokio::sync::oneshot::channel();
    worker
        .try_send(Box::new(move |service, ready| {
            // A request that timed out while queued must not execute later.
            if send.is_closed() {
                return;
            }
            let result = if ready {
                operation(service)
            } else {
                Err("暂时无法连接系统媒体服务。".into())
            };
            let _ = send.send(result);
        }))
        .map_err(|_| "播放器正在响应，请稍后重试。".to_string())?;
    tokio::time::timeout(Duration::from_secs(12), receive)
        .await
        .map_err(|_| "播放器响应超时，请重新打开播放器后重试。".to_string())?
        .map_err(|_| "媒体服务暂不可用。".to_string())?
}

fn wait<T: windows::core::RuntimeType>(operation: IAsyncOperation<T>) -> windows::core::Result<T> {
    let started = Instant::now();
    while operation.Status()? == AsyncStatus::Started {
        if started.elapsed() > Duration::from_secs(4) {
            let _ = operation.Cancel();
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                0x800705B4u32 as i32,
            )));
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    operation.GetResults()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    id: String,
    app_id: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    sources: Vec<Source>,
    selected: Option<String>,
    title: String,
    artist: String,
    album: String,
    duration: Option<f64>,
    position: Option<f64>,
    sampled_at: f64,
    rate: f64,
    can_seek: bool,
    state_known: bool,
    compatibility: bool,
    cover: Option<String>,
    playing: bool,
    can_play: bool,
    can_pause: bool,
    can_previous: bool,
    can_next: bool,
    can_shuffle: bool,
    can_repeat: bool,
    shuffle: Option<bool>,
    repeat: Option<i32>,
}

// The blocking worker owns an initialized apartment for every WinRT operation.
struct Apartment;
impl Apartment {
    fn new() -> windows::core::Result<Self> {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED)?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() }
    }
}

impl Service {
    fn refresh(&mut self) -> windows::core::Result<()> {
        if self.manager.is_none() {
            self.manager = Some(wait(
                GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?,
            )?);
        }
        let list = self.manager.as_ref().unwrap().GetSessions()?;
        let mut sessions = Vec::new();
        for session in list {
            let id = self
                .sessions
                .iter()
                .find(|(_, previous)| previous == &session)
                .map(|(id, _)| id.clone())
                .unwrap_or_else(|| {
                    self.next_id += 1;
                    self.next_id.to_string()
                });
            sessions.push((id, session));
        }
        self.sessions = sessions;
        Ok(())
    }

    fn snapshot(&mut self, preferred: Option<String>) -> windows::core::Result<Snapshot> {
        // A failed/restarted media service must not disable the independent compatibility source.
        if self.refresh().is_err() {
            self.manager = None;
            self.sessions.clear();
        }
        let cloud = crate::media_cloud::discover();
        let native_cloud = self.sessions.iter().any(|(_, s)| is_cloud(s));
        let mut sources: Vec<Source> = self
            .sessions
            .iter()
            .filter_map(|(id, session)| {
                Some(Source {
                    id: id.clone(),
                    app_id: session.SourceAppUserModelId().ok()?.to_string(),
                })
            })
            .collect();
        sources.extend(cloud.iter().filter(|_| !native_cloud).map(|v| Source {
            id: v.id.clone(),
            app_id: "cloudmusic.exe".into(),
        }));
        let playing = |s: &GlobalSystemMediaTransportControlsSession| {
            if is_cloud(s) && cloud.len() == 1 {
                if let Some(playing) = cloud[0].playing {
                    return playing;
                }
            }
            s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).ok()
                == Some(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
        };
        let native_playing = self.sessions.iter().any(|(_, s)| playing(s));
        let fallback = if let Some(id) = preferred.as_ref() {
            cloud.iter().find(|s| &s.id == id)
        } else if native_playing || native_cloud {
            None
        } else {
            cloud.iter().find(|s| s.playing == Some(true)).or_else(|| {
                if native_playing {
                    None
                } else {
                    cloud.first()
                }
            })
        };
        if let Some(cloud) = fallback {
            let timeline =
                crate::media_cloud::timeline("cloudmusic.exe", &cloud.title, &cloud.artist);
            return Ok(Snapshot {
                sources,
                selected: Some(cloud.id.clone()),
                title: cloud.title.clone(),
                artist: cloud.artist.clone(),
                playing: cloud.playing == Some(true),
                state_known: cloud.playing.is_some(),
                compatibility: true,
                can_play: cloud.playing.is_some(),
                can_pause: cloud.playing.is_some(),
                can_previous: cloud.previous,
                can_next: cloud.next,
                position: timeline.as_ref().map(|v| v.position).or(cloud.position),
                duration: timeline.as_ref().map(|v| v.duration).or(cloud.duration),
                can_seek: timeline.as_ref().is_some_and(|v| v.can_seek),
                sampled_at: now_ms(),
                rate: 1.0,
                ..Snapshot::default()
            });
        }
        // A pinned source that has exited must not silently target a different player.
        let selected = if let Some(id) = preferred {
            self.sessions.iter().find(|(key, _)| key == &id)
        } else {
            let current = self
                .manager
                .as_ref()
                .and_then(|m| m.GetCurrentSession().ok());
            self.sessions
                .iter()
                .find(|(_, s)| current.as_ref() == Some(s) && playing(s))
                .or_else(|| self.sessions.iter().find(|(_, s)| playing(s)))
                .or_else(|| {
                    self.sessions
                        .iter()
                        .find(|(_, s)| current.as_ref() == Some(s))
                })
                .or_else(|| self.sessions.first())
        }
        .cloned();
        let mut out = Snapshot {
            sources,
            selected: None,
            title: String::new(),
            artist: String::new(),
            cover: None,
            playing: false,
            can_play: false,
            can_pause: false,
            can_previous: false,
            can_next: false,
            can_shuffle: false,
            can_repeat: false,
            shuffle: None,
            repeat: None,
            ..Snapshot::default()
        };
        let Some((id, session)) = selected else {
            self.cover_key.clear();
            self.cover = None;
            return Ok(out);
        };
        let info = session.GetPlaybackInfo()?;
        let controls = info.Controls()?;
        out.playing = info.PlaybackStatus()?
            == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
        out.state_known = true;
        out.rate = info
            .PlaybackRate()
            .and_then(|v| v.Value())
            .ok()
            .filter(|v| v.is_finite() && *v > 0.0 && *v <= 4.0)
            .unwrap_or(1.0);
        out.sampled_at = now_ms();
        if let Ok(timeline) = session.GetTimelineProperties() {
            if let (Ok(start), Ok(end), Ok(position), Ok(updated)) = (
                timeline.StartTime(),
                timeline.EndTime(),
                timeline.Position(),
                timeline.LastUpdatedTime(),
            ) {
                let duration = (end.Duration - start.Duration) as f64 / 10_000_000.0;
                if duration > 0.0 {
                    // WinRT DateTime is 100 ns ticks since 1601, not the Unix epoch.
                    let elapsed = ((out.sampled_at
                        - (updated.UniversalTime as f64 / 10_000.0 - 11_644_473_600_000.0))
                        / 1000.0)
                        .max(0.0);
                    let base = (position.Duration - start.Duration) as f64 / 10_000_000.0;
                    out.duration = Some(duration);
                    out.position = Some(
                        (base + if out.playing { elapsed * out.rate } else { 0.0 })
                            .clamp(0.0, duration),
                    );
                    out.can_seek = controls.IsPlaybackPositionEnabled().unwrap_or(false);
                }
            }
        }
        let toggle_enabled = controls.IsPlayPauseToggleEnabled().unwrap_or(false);
        out.can_play = controls.IsPlayEnabled().unwrap_or(false) || toggle_enabled;
        out.can_pause = controls.IsPauseEnabled().unwrap_or(false) || toggle_enabled;
        out.can_previous = controls.IsPreviousEnabled().unwrap_or(false);
        out.can_next = controls.IsNextEnabled().unwrap_or(false);
        out.can_shuffle = controls.IsShuffleEnabled().unwrap_or(false);
        out.can_repeat = controls.IsRepeatEnabled().unwrap_or(false);
        out.shuffle = info.IsShuffleActive().and_then(|v| v.Value()).ok();
        out.repeat = info
            .AutoRepeatMode()
            .and_then(|v| v.Value())
            .ok()
            .map(|v| v.0);
        let properties = wait(session.TryGetMediaPropertiesAsync()?)?;
        out.title = properties.Title()?.to_string();
        out.artist = properties.Artist()?.to_string();
        out.album = properties
            .AlbumTitle()
            .map(|v| v.to_string())
            .unwrap_or_default();
        let key = format!(
            "{id}\0{}\0{}\0{}",
            out.title,
            out.artist,
            properties.AlbumTitle()?
        );
        if key != self.cover_key
            || self
                .cover_checked
                .is_none_or(|time| time.elapsed() > Duration::from_secs(20))
        {
            self.cover_checked = Some(Instant::now());
            self.cover = (|| -> windows::core::Result<String> {
                let stream = wait(properties.Thumbnail()?.OpenReadAsync()?)?;
                let size = stream.Size()?;
                if size == 0 || size > 4 * 1024 * 1024 {
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        0x80070057u32 as i32,
                    )));
                }
                let reader = DataReader::CreateDataReader(&stream)?;
                reader.SetInputStreamOptions(InputStreamOptions::None)?;
                let loaded = reader.LoadAsync(size as u32)?.get()?;
                let mut bytes = vec![0; loaded as usize];
                reader.ReadBytes(&mut bytes)?;
                let mime = if bytes.starts_with(b"\x89PNG") {
                    "image/png"
                } else if bytes.starts_with(b"\xff\xd8\xff") {
                    "image/jpeg"
                } else if bytes.starts_with(b"GIF8") {
                    "image/gif"
                } else if bytes.starts_with(b"RIFF") {
                    "image/webp"
                } else {
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        0x80070057u32 as i32,
                    )));
                };
                Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
            })()
            .ok();
            self.cover_key = key;
        }
        out.cover = self.cover.clone();
        // Recent CloudMusic versions publish a cover but may omit their timeline
        // or report stale SMTC state. Supplement only a matching track's fields.
        if is_cloud(&session) {
            if let Some(c) = cloud
                .iter()
                .find(|c| c.title == out.title && c.artist == out.artist)
            {
                if let Some(playing) = c.playing {
                    out.playing = playing;
                    out.can_play = true;
                    out.can_pause = true;
                    out.can_previous |= c.previous;
                    out.can_next |= c.next;
                }
                if out.position.is_none() {
                    out.position = c.position;
                    out.duration = c.duration;
                }
            }
        }
        out.selected = Some(id);
        if out.position.is_none() || !out.can_seek {
            if let Some(timeline) = crate::media_cloud::timeline(
                &session.SourceAppUserModelId()?.to_string(),
                &out.title,
                &out.artist,
            ) {
                // Some QQ versions retain LastUpdatedTime across pause/resume.
                // Prefer the player's visible clock when SMTC has counted paused
                // time as playback, while retaining subsecond SMTC precision normally.
                if out
                    .position
                    .is_none_or(|position| (position - timeline.position).abs() > 2.0)
                {
                    out.position = Some(timeline.position);
                    out.duration = out.duration.or(Some(timeline.duration));
                }
                out.can_seek |= timeline.can_seek;
            }
        }
        Ok(out)
    }

    fn control(&mut self, id: &str, action: &str) -> Result<(), String> {
        if id.starts_with("cloud:") {
            return crate::media_cloud::control(id, action);
        }
        self.refresh().map_err(|_| "暂时无法连接播放器。")?;
        let session = &self
            .sessions
            .iter()
            .find(|(key, _)| key == id)
            .ok_or("这个播放器已经退出，请重新选择。")?
            .1;
        if is_cloud(session) && matches!(action, "play" | "pause" | "previous" | "next") {
            let candidates = crate::media_cloud::discover();
            if candidates.len() == 1 && candidates[0].playing.is_some() {
                return crate::media_cloud::control(&candidates[0].id, action);
            }
        }
        let result = (|| -> windows::core::Result<bool> {
            let info = session.GetPlaybackInfo()?;
            let c = info.Controls()?;
            let playing = info.PlaybackStatus()?
                == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
            match action {
                "play" if playing => Ok(true),
                "pause" if !playing => Ok(true),
                "play" if c.IsPlayEnabled()? => wait(session.TryPlayAsync()?),
                "pause" if c.IsPauseEnabled()? => wait(session.TryPauseAsync()?),
                "play" | "pause" if c.IsPlayPauseToggleEnabled()? => {
                    wait(session.TryTogglePlayPauseAsync()?)
                }
                "previous" if c.IsPreviousEnabled()? => wait(session.TrySkipPreviousAsync()?),
                "next" if c.IsNextEnabled()? => wait(session.TrySkipNextAsync()?),
                "shuffle" if c.IsShuffleEnabled()? => {
                    let active = info.IsShuffleActive()?.Value()?;
                    wait(session.TryChangeShuffleActiveAsync(!active)?)
                }
                "repeat" if c.IsRepeatEnabled()? => {
                    let next = match info.AutoRepeatMode()?.Value()? {
                        MediaPlaybackAutoRepeatMode::None => MediaPlaybackAutoRepeatMode::List,
                        MediaPlaybackAutoRepeatMode::List => MediaPlaybackAutoRepeatMode::Track,
                        _ => MediaPlaybackAutoRepeatMode::None,
                    };
                    wait(session.TryChangeAutoRepeatModeAsync(next)?)
                }
                _ => Ok(false),
            }
        })();
        match result {
            Ok(true) => Ok(()),
            _ => Err("播放器暂未响应此操作。".into()),
        }
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}

fn is_cloud(session: &GlobalSystemMediaTransportControlsSession) -> bool {
    session.SourceAppUserModelId().ok().is_some_and(|s| {
        let name = s.to_string().to_lowercase();
        name.contains("cloudmusic") || name.contains("netease")
    })
}

#[tauri::command]
pub async fn media_seek(id: String, seconds: f64) -> Result<(), String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("无效的播放位置。".into());
    }
    on_media_thread(move |service| {
        if id.starts_with("cloud:") {
            let cloud = crate::media_cloud::discover()
                .into_iter()
                .find(|c| c.id == id)
                .ok_or("播放器已经退出。")?;
            return crate::media_cloud::seek(
                "cloudmusic.exe",
                &cloud.title,
                &cloud.artist,
                seconds,
            );
        }
        service.refresh().map_err(|_| "媒体服务暂不可用。")?;
        let s = &service
            .sessions
            .iter()
            .find(|(key, _)| key == &id)
            .ok_or("播放器已经退出。")?
            .1;
        let run = || -> windows::core::Result<bool> {
            if !s
                .GetPlaybackInfo()?
                .Controls()?
                .IsPlaybackPositionEnabled()?
            {
                return Ok(false);
            }
            let timeline = s.GetTimelineProperties()?;
            let start = timeline.StartTime()?.Duration;
            let end = timeline.EndTime()?.Duration;
            let (min, max) = (
                timeline.MinSeekTime()?.Duration,
                timeline.MaxSeekTime()?.Duration,
            );
            // Some providers expose a valid duration but leave seek bounds at 0.
            let (min, max) = if max > min { (min, max) } else { (start, end) };
            if max <= min {
                return Ok(false);
            }
            let position = start
                .saturating_add((seconds * 10_000_000.0) as i64)
                .clamp(min, max);
            wait(s.TryChangePlaybackPositionAsync(position)?)
        };
        if run().unwrap_or(false) {
            Ok(())
        } else {
            let properties = wait(
                s.TryGetMediaPropertiesAsync()
                    .map_err(|_| "曲目信息暂不可用。")?,
            )
            .map_err(|_| "曲目信息暂不可用。")?;
            crate::media_cloud::seek(
                &s.SourceAppUserModelId()
                    .map_err(|_| "播放器已经退出。")?
                    .to_string(),
                &properties
                    .Title()
                    .map_err(|_| "曲目信息暂不可用。")?
                    .to_string(),
                &properties
                    .Artist()
                    .map_err(|_| "曲目信息暂不可用。")?
                    .to_string(),
                seconds,
            )
        }
    })
    .await
}

#[tauri::command]
pub async fn media_snapshot(preferred: Option<String>) -> Result<Snapshot, String> {
    on_media_thread(move |service| {
        service
            .snapshot(preferred)
            .map_err(|_| "暂时无法读取播放信息，请稍后重试。".to_string())
    })
    .await
}

#[tauri::command]
pub async fn media_control(id: String, action: String) -> Result<(), String> {
    on_media_thread(move |service| service.control(&id, &action)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Briefly resumes a paused QQ track and restores its paused state"]
    fn qq_resume_clock_probe() {
        tauri::async_runtime::block_on(async {
            let first = media_snapshot(None).await.unwrap();
            let id = first
                .sources
                .iter()
                .find(|s| s.app_id.to_lowercase().contains("qqmusic"))
                .expect("QQ required")
                .id
                .clone();
            let before = media_snapshot(Some(id.clone())).await.unwrap();
            assert!(!before.playing, "Start with QQ paused");
            let position = before.position.expect("Known paused time");
            media_control(id.clone(), "play".into()).await.unwrap();
            std::thread::sleep(Duration::from_millis(500));
            let after = media_snapshot(Some(id.clone())).await;
            let restore = media_control(id, "pause".into()).await;
            restore.unwrap();
            let after = after.unwrap();
            assert!(after.playing);
            let resumed = after.position.expect("Known resumed time");
            assert!(
                (resumed - position).abs() < 5.0,
                "Resume must not count paused time: {position} -> {resumed}"
            );
            println!("QQ resume clock: {position:.2} -> {resumed:.2}; paused state restored");
        });
    }

    #[test]
    fn media_commands_keep_one_worker_thread() {
        tauri::async_runtime::block_on(async {
            let first = on_media_thread(|_| Ok(std::thread::current().id()))
                .await
                .unwrap();
            let second = on_media_thread(|_| Ok(std::thread::current().id()))
                .await
                .unwrap();
            assert_eq!(first, second);
            assert_ne!(first, std::thread::current().id());
        });
    }

    #[test]
    #[ignore = "Exercises the actual async command path and restores NetEase playback"]
    fn desktop_cloud_command_probe() {
        tauri::async_runtime::block_on(async {
            let first = media_snapshot(None).await.unwrap();
            let source = first
                .sources
                .iter()
                .find(|s| {
                    let app = s.app_id.to_lowercase();
                    app.contains("cloudmusic") || app.contains("netease")
                })
                .expect("NetEase session required");
            let id = source.id.clone();
            println!(
                "NetEase source: {}; compatibility adapter: {}",
                source.app_id,
                id.starts_with("cloud:")
            );
            let before = media_snapshot(Some(id.clone())).await.unwrap();
            assert!(before.state_known);
            media_control(
                id.clone(),
                if before.playing { "pause" } else { "play" }.into(),
            )
            .await
            .unwrap();
            let mut after = media_snapshot(Some(id.clone())).await.unwrap();
            for _ in 0..12 {
                if after.playing != before.playing {
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
                after = media_snapshot(Some(id.clone())).await.unwrap();
            }
            media_control(
                id.clone(),
                if before.playing { "play" } else { "pause" }.into(),
            )
            .await
            .unwrap();
            assert_ne!(before.playing, after.playing);
            let mut restored = media_snapshot(Some(id.clone())).await.unwrap();
            for _ in 0..12 {
                if restored.playing == before.playing {
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
                restored = media_snapshot(Some(id.clone())).await.unwrap();
            }
            assert_eq!(restored.playing, before.playing);
            println!(
                "Async commands returned; playback changed and was restored; polling still works"
            );
        });
    }

    #[test]
    #[ignore = "Reads live Windows media sessions; run manually on a desktop"]
    fn desktop_media_probe() {
        let _apartment = Apartment::new().unwrap();
        let mut service = Service::default();
        let mut snapshot = service.snapshot(None).unwrap();
        if let Some(source) = snapshot
            .sources
            .iter()
            .find(|s| Some(&s.id) == snapshot.selected.as_ref())
        {
            println!(
                "Player clock: {:?}",
                crate::media_cloud::timeline(&source.app_id, &snapshot.title, &snapshot.artist)
                    .map(|t| (t.position, t.duration, t.can_seek))
            );
        }
        if let Some((_, session)) = service.sessions.first() {
            if let Ok(properties) = wait(session.TryGetMediaPropertiesAsync().unwrap()) {
                match properties
                    .Thumbnail()
                    .and_then(|t| wait(t.OpenReadAsync()?))
                {
                    Ok(stream) => {
                        let reader = DataReader::CreateDataReader(&stream).unwrap();
                        let count = reader.LoadAsync(16).unwrap().get().unwrap();
                        let mut prefix = vec![0; count as usize];
                        reader.ReadBytes(&mut prefix).unwrap();
                        println!(
                            "Thumbnail type: {:?}, size: {:?}, prefix: {:?}",
                            stream.ContentType(),
                            stream.Size(),
                            prefix
                        );
                    }
                    Err(error) => println!("Thumbnail unavailable: {error}"),
                }
            }
        }
        snapshot.cover = snapshot.cover.map(|cover| format!("{} bytes", cover.len()));
        println!("{}", serde_json::to_string_pretty(&snapshot).unwrap());
        let absent = service
            .snapshot(Some("nonexistent-session".into()))
            .unwrap();
        assert!(absent.selected.is_none());
        assert!(!absent.can_play && !absent.can_next);
        assert!(service.control("nonexistent-session", "play").is_err());
    }

    #[test]
    #[ignore = "Toggles and restores the live NetEase player; run manually on a desktop"]
    fn desktop_cloud_control_probe() {
        let _apartment = Apartment::new().unwrap();
        let cloud = crate::media_cloud::discover()
            .into_iter()
            .find(|c| c.playing.is_some())
            .expect("CloudMusic minibar required");
        let action = if cloud.playing == Some(true) {
            "pause"
        } else {
            "play"
        };
        crate::media_cloud::control(&cloud.id, action).unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        let after = crate::media_cloud::discover()
            .into_iter()
            .find(|c| c.id == cloud.id)
            .unwrap();
        let restore = crate::media_cloud::control(
            &cloud.id,
            if cloud.playing == Some(true) {
                "play"
            } else {
                "pause"
            },
        );
        assert_ne!(
            after.playing, cloud.playing,
            "native button invocation must change actual state"
        );
        restore.unwrap();
    }
}
