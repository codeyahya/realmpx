use serde::{Deserialize, Serialize};
use std::fmt::format;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug, Deserialize)]
pub struct DownloadRequest {
    url: String,
    mode: String,
    format: String,
    output_dir: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DownloadProgress {
    line: String,
}

#[derive(Debug, Serialize)]
pub struct DownloadResult {
    success: bool,
    message: String,
}

// Tracks the currently running yt-dlp process so cancel/pause commands
// can reach it from a separate invoke call.
#[derive(Default)]
pub struct DownloadState {
    pid: Arc<AsyncMutex<Option<u32>>>,
    cancelled: Arc<AtomicBool>,
}

fn is_valid_youtube_url(url: &str) -> bool {
    let url = url.trim();
    url.starts_with("https://www.youtube.com/watch")
        || url.starts_with("https://youtube.com/watch")
        || url.starts_with("https://youtu.be/")
        || url.starts_with("https://m.youtube.com/watch")
        || url.starts_with("http://www.youtube.com/watch")
        || url.starts_with("https://www.youtube.com/shorts/")
}

#[cfg(unix)]
fn send_signal(pid: u32, sig: nix::sys::signal::Signal) -> Result<(), String> {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), sig).map_err(|e| e.to_string())
}

#[cfg(windows)]
async fn kill_windows_process(pid: u32) -> Result<(), String> {
    Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_media(
    app: tauri::AppHandle,
    state: tauri::State<'_, DownloadState>,
    request: DownloadRequest,
) -> Result<DownloadResult, String> {
    if !is_valid_youtube_url(&request.url) {
        return Err("That doesn't look like a valid YouTube URL.".into());
    }

    let mut args: Vec<String> = vec![request.url.clone()];

    match (request.mode.as_str(), request.format.as_str()) {
        ("audio", "mp3") => {
            args.push("-x".into());
            args.push("--audio-format".into());
            args.push("mp3".into());
            args.push("--audio-quality".into());
            args.push("0".into());
        }
        ("video", "mp4") => {
            args.push("-f".into());
            args.push("bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best".into());
            args.push("--merge-output-format".into());
            args.push("mp4".into());
            args.push("--abort-on-error".into());
            args.push("--js-runtimes".into());
            args.push("deno".into());
        }
        _ => return Err("Unsupported mode/format combination.".into()),
    }

    args.push("-o".into());
    args.push(format!("{}/%(title)s.%(ext)s", request.output_dir));
    args.push("--newline".into());
    args.push("--no-playlist".into());

    let mut child = Command::new("yt-dlp")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start yt-dlp (is it installed and on PATH?): {e}"))?;

    // Reset control flags for this run and publish the PID so
    // cancel_download/pause_download/resume_download can reach it.
    state.cancelled.store(false, Ordering::SeqCst);
    if let Some(pid) = child.id() {
        *state.pid.lock().await = Some(pid);
    }

    let stdout = child.stdout.take().ok_or("Could not capture stdout")?;
    let stderr = child.stderr.take().ok_or("Could not capture stderr")?;

    let app_clone = app.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone.emit("download-progress", DownloadProgress { line });
        }
    });

    let app_clone2 = app.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone2.emit("download-progress", DownloadProgress { line });
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Error waiting on yt-dlp: {e}"))?;

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    // Clear the tracked PID now that the process has exited.
    *state.pid.lock().await = None;

    if status.success() {
        Ok(DownloadResult {
            success: true,
            message: "Download complete.".into(),
        })
    } else if state.cancelled.load(Ordering::SeqCst) {
        Ok(DownloadResult {
            success: false,
            message: "Download cancelled.".into(),
        })
    } else {
        Err(format!("yt-dlp exited with status: {status}"))
    }
}

#[tauri::command]
async fn cancel_download(state: tauri::State<'_, DownloadState>) -> Result<(), String> {
    let pid = *state.pid.lock().await;
    let pid = pid.ok_or("No active download to cancel.")?;

    state.cancelled.store(true, Ordering::SeqCst);

    #[cfg(unix)]
    {
        send_signal(pid, nix::sys::signal::Signal::SIGKILL)?;
    }
    #[cfg(windows)]
    {
        kill_windows_process(pid).await?;
    }

    Ok(())
}

#[tauri::command]
async fn pause_download(state: tauri::State<'_, DownloadState>) -> Result<(), String> {
    let pid = *state.pid.lock().await;
    let pid = pid.ok_or("No active download to pause.")?;

    #[cfg(unix)]
    {
        send_signal(pid, nix::sys::signal::Signal::SIGSTOP)?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let _ = pid;
        Err("Pausing isn't supported on Windows yet — use Cancel instead.".into())
    }
}

#[tauri::command]
async fn resume_download(state: tauri::State<'_, DownloadState>) -> Result<(), String> {
    let pid = *state.pid.lock().await;
    let pid = pid.ok_or("No active download to resume.")?;

    #[cfg(unix)]
    {
        send_signal(pid, nix::sys::signal::Signal::SIGCONT)?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let _ = pid;
        Err("Pausing isn't supported on Windows yet.".into())
    }
}

#[tauri::command]
fn get_default_path(app: tauri::AppHandle) -> String {
    if let Ok(download_dir) = app.path().download_dir() {
        return download_dir.to_string_lossy().into_owned();
    }
    String::from("")
}

#[tauri::command]
fn open_result_dir(dir: String) {
    let arg = format!("explorer {}", dir);
    let _ = Command::new("pwsh")
        .args(["/c"])
        .arg(arg)
        .spawn()
        .map_err(|e| e.to_string());
}

#[tauri::command]
async fn check_yt_dlp_installed() -> bool {
    Command::new("yt-dlp")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
async fn check_ffmpeg_installed() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DownloadState::default())
        .invoke_handler(tauri::generate_handler![
            download_media,
            cancel_download,
            pause_download,
            resume_download,
            check_yt_dlp_installed,
            check_ffmpeg_installed,
            open_result_dir,
            get_default_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
