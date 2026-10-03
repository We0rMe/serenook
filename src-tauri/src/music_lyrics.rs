use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use windows::Win32::{
    Foundation::LPARAM,
    Globalization::{
        LCMapStringEx, LCMAP_SIMPLIFIED_CHINESE, LCMAP_TRADITIONAL_CHINESE, LOCALE_NAME_INVARIANT,
    },
};

#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    #[serde(default)]
    track_name: String,
    #[serde(default)]
    artist_name: String,
    #[serde(default)]
    album_name: String,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    instrumental: bool,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
}

fn chinese(text: &str, flags: u32) -> String {
    let source: Vec<u16> = text.encode_utf16().collect();
    if source.is_empty() {
        return String::new();
    }
    unsafe {
        let count = LCMapStringEx(
            LOCALE_NAME_INVARIANT,
            flags,
            &source,
            None,
            None,
            None,
            LPARAM(0),
        );
        if count <= 0 {
            return text.to_owned();
        }
        let mut target = vec![0u16; count as usize];
        if LCMapStringEx(
            LOCALE_NAME_INVARIANT,
            flags,
            &source,
            Some(&mut target),
            None,
            None,
            LPARAM(0),
        ) <= 0
        {
            return text.to_owned();
        }
        String::from_utf16_lossy(&target)
    }
}

fn normalized(text: &str) -> String {
    chinese(text, LCMAP_SIMPLIFIED_CHINESE)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn matches(row: &Lyrics, title: &str, artist: &str, duration: Option<f64>) -> bool {
    normalized(&row.track_name) == normalized(title)
        && normalized(&row.artist_name) == normalized(artist)
        && duration.is_none_or(|d| (row.duration - d).abs() <= 3.0)
}

async fn json(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let mut response = response
        .error_for_status()
        .map_err(|_| "歌词服务暂不可用。")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "歌词读取中断，请稍后重试。")?
    {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("歌词响应过大。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "歌词格式暂不支持。".into())
}

fn select_lyrics(
    rows: Vec<Lyrics>,
    title: &str,
    artist: &str,
    album: &str,
    duration: Option<f64>,
) -> Option<Lyrics> {
    let mut rows: Vec<_> = rows
        .into_iter()
        .filter(|row| matches(row, title, artist, duration))
        .collect();
    // Missing player duration does not justify discarding timing when the album
    // identifies one recording, or all candidates agree on recording length.
    if duration.is_none() && rows.len() > 1 {
        let album_rows: Vec<_> = rows
            .iter()
            .filter(|r| !album.is_empty() && normalized(&r.album_name) == normalized(album))
            .cloned()
            .collect();
        if !album_rows.is_empty() {
            rows = album_rows;
        }
        let low = rows
            .iter()
            .map(|r| r.duration)
            .fold(f64::INFINITY, f64::min);
        let high = rows.iter().map(|r| r.duration).fold(0.0, f64::max);
        if high - low > 3.0 || low <= 0.0 {
            let mut groups = std::collections::HashMap::<String, (usize, String)>::new();
            for row in &rows {
                if let Some(text) = row.plain_lyrics.as_ref().filter(|s| !s.trim().is_empty()) {
                    let entry = groups.entry(normalized(text)).or_insert((0, text.clone()));
                    entry.0 += 1;
                }
            }
            return groups
                .into_values()
                .max_by_key(|(count, _)| *count)
                .filter(|(count, _)| count * 4 >= rows.len() * 3)
                .map(|(_, text)| Lyrics {
                    track_name: title.to_owned(),
                    artist_name: artist.to_owned(),
                    plain_lyrics: Some(text),
                    ..Default::default()
                });
        }
    }
    let timed = |row: &Lyrics| {
        row.synced_lyrics
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty())
    };
    rows.sort_by(|a, b| {
        let album_rank =
            |row: &Lyrics| !album.is_empty() && normalized(&row.album_name) != normalized(album);
        (!timed(a))
            .cmp(&(!timed(b)))
            .then_with(|| album_rank(a).cmp(&album_rank(b)))
            .then_with(|| {
                (a.duration - duration.unwrap_or(a.duration))
                    .abs()
                    .total_cmp(&(b.duration - duration.unwrap_or(b.duration)).abs())
            })
    });
    rows.into_iter().next()
}

#[tauri::command]
pub async fn music_lyrics(
    title: String,
    artist: String,
    album: String,
    duration: Option<f64>,
) -> Result<Option<Lyrics>, String> {
    if title.trim().is_empty()
        || artist.trim().is_empty()
        || title.len() > 512
        || artist.len() > 512
        || album.len() > 512
    {
        return Ok(None);
    }
    let duration = duration.filter(|v| v.is_finite() && *v > 0.0);
    // The updater also uses ring, but may not initialize it until much later.
    // Lyrics must work on a fresh launch, independently of checking for updates.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Serenook/0.15.0 (desktop lyrics companion)")
        .build()
        .map_err(|_| "歌词服务暂不可用。")?;
    // Search both scripts when necessary; artist matching remains exact locally.
    // A simplified artist filter upstream would hide traditional-name recordings.
    let traditional = chinese(&title, LCMAP_TRADITIONAL_CHINESE);
    let simplified = chinese(&title, LCMAP_SIMPLIFIED_CHINESE);
    let alternate = if traditional != title {
        traditional
    } else {
        simplified
    };
    let mut titles = vec![title.clone()];
    if alternate != title {
        titles.push(alternate);
    }
    let mut rows = Vec::new();
    let mut failure = None;
    for query in titles {
        let mut url = reqwest::Url::parse("https://lrclib.net/api/search").unwrap();
        url.query_pairs_mut().append_pair("track_name", &query);
        let fetched = async {
            let response = client
                .get(url)
                .send()
                .await
                .map_err(|_| "暂时无法连接歌词服务，请稍后重试。".to_string())?;
            serde_json::from_value::<Vec<Lyrics>>(json(response).await?)
                .map_err(|_| "歌词格式暂不支持。".to_string())
        }
        .await;
        match fetched {
            Ok(mut found) => rows.append(&mut found),
            Err(e) => {
                failure = Some(e);
                continue;
            }
        }
        if let Some(result) = select_lyrics(rows.clone(), &title, &artist, &album, duration) {
            if result
                .synced_lyrics
                .as_ref()
                .is_some_and(|s| !s.trim().is_empty())
            {
                return Ok(Some(result));
            }
        }
    }
    let result = select_lyrics(rows, &title, &artist, &album, duration);
    // Do not cache a plain-only fallback for 30 days when the timed alternate
    // merely failed temporarily (e.g. LRCLIB 503); let the caller retry instead.
    if result
        .as_ref()
        .is_none_or(|r| r.synced_lyrics.as_ref().is_none_or(|s| s.trim().is_empty()))
    {
        if let Some(e) = failure {
            return Err(e);
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn music_import_lyrics(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("lrc"))
        {
            return Err("请选择 .lrc 歌词文件。".into());
        }
        let file = std::fs::File::open(path).map_err(|_| "无法读取歌词文件。")?;
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取歌词文件。")?;
        if bytes.len() > 256 * 1024 {
            return Err("歌词文件需小于 256 KB。".into());
        }
        let text = if bytes.starts_with(&[0xff, 0xfe]) {
            let bytes = &bytes[2..];
            if bytes.len() % 2 != 0 {
                return Err("歌词文件编码不完整。".into());
            }
            String::from_utf16(
                &bytes
                    .chunks_exact(2)
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .collect::<Vec<_>>(),
            )
            .map_err(|_| "请使用 UTF-8 或 UTF-16 歌词。")?
        } else {
            String::from_utf8(bytes).map_err(|_| "请将歌词另存为 UTF-8 后导入。")?
        };
        Ok(text.trim_start_matches('\u{feff}').to_owned())
    })
    .await
    .map_err(|_| "无法读取歌词文件。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn simplified_traditional_and_recording_confidence() {
        assert_eq!(
            normalized("人來人往 · 陳奕迅"),
            normalized("人来人往 陈奕迅")
        );
        let row = Lyrics {
            track_name: "人來人往".into(),
            artist_name: "陳奕迅".into(),
            album_name: "Studio".into(),
            duration: 233.0,
            synced_lyrics: Some("[00:01]Text".into()),
            plain_lyrics: Some("Text".into()),
            ..Default::default()
        };
        let mut live = row.clone();
        live.album_name = "Live".into();
        live.duration = 271.0;
        assert!(select_lyrics(
            vec![row.clone(), live.clone()],
            "人来人往",
            "陈奕迅",
            "Studio",
            None
        )
        .unwrap()
        .synced_lyrics
        .is_some());
        assert!(
            select_lyrics(vec![row.clone(), live], "人来人往", "陈奕迅", "", None)
                .unwrap()
                .synced_lyrics
                .is_none()
        );
        let mut plain = row.clone();
        plain.synced_lyrics = None;
        assert!(
            select_lyrics(vec![plain, row], "人来人往", "陈奕迅", "", Some(234.0))
                .unwrap()
                .synced_lyrics
                .is_some()
        );
    }
    #[test]
    #[ignore = "Queries public Chinese track metadata and lyrics"]
    fn chinese_lyrics_probe() {
        let row = tauri::async_runtime::block_on(music_lyrics(
            "人来人往".into(),
            "陈奕迅".into(),
            String::new(),
            Some(233.0),
        ))
        .unwrap()
        .expect("matching Chinese lyrics");
        println!(
            "Traditional query: {}; result title={}, artist={}, duration={}, timed={}",
            chinese("人来人往", LCMAP_TRADITIONAL_CHINESE),
            row.track_name,
            row.artist_name,
            row.duration,
            row.synced_lyrics.as_ref().map_or(0, String::len)
        );
        assert!(row.synced_lyrics.as_ref().is_some_and(|s| !s.is_empty()));
        println!(
            "Matched Chinese recording: duration={}s; synced=true",
            row.duration
        );
    }
    #[test]
    #[ignore = "Queries LRCLIB with a public sample track"]
    fn online_lyrics_probe() {
        let row = tauri::async_runtime::block_on(music_lyrics(
            "Until I Found You".into(),
            "Stephen Sanchez".into(),
            String::new(),
            Some(177.0),
        ))
        .unwrap()
        .expect("matching lyrics");
        assert!(row.synced_lyrics.is_some());
        let plain = tauri::async_runtime::block_on(music_lyrics(
            "Until I Found You".into(),
            "Stephen Sanchez".into(),
            String::new(),
            None,
        ))
        .unwrap()
        .expect("plain lyrics consensus");
        assert!(plain.plain_lyrics.is_some());
        assert!(
            plain.synced_lyrics.is_none(),
            "unknown duration must not guess recording timestamps"
        );
        println!(
            "Matched duration {} s; timed lyrics available",
            row.duration
        );
    }
    #[test]
    fn avoids_wrong_recordings() {
        let row = Lyrics {
            track_name: "Night Changes".into(),
            artist_name: "One Direction".into(),
            duration: 226.0,
            ..Default::default()
        };
        assert!(matches(&row, "Night Changes", "One Direction", Some(225.0)));
        assert!(!matches(
            &row,
            "Night Changes (Live)",
            "One Direction",
            Some(225.0)
        ));
        assert!(!matches(&row, "Night Changes", "Other Artist", Some(225.0)));
        assert!(!matches(
            &row,
            "Night Changes",
            "One Direction",
            Some(250.0)
        ));
    }
}
