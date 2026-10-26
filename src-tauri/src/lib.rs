use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Builds a tokio Command configured to avoid flashing a console window
/// on Windows when spawning a child process from a GUI app.
fn new_command(program: impl AsRef<Path>) -> Command {
    let mut cmd = Command::new(program.as_ref());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn bundled_tool(app: &tauri::AppHandle, tool: &str) -> Result<(PathBuf, PathBuf), String> {
    let filename = if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    };
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("bin"));
        candidates.push(resource_dir);
    }
    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir.join("resources").join("bin"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("bin"),
    );

    for tools_dir in candidates {
        let path = tools_dir.join(&filename);
        if path.is_file() {
            return Ok((path, tools_dir));
        }
    }

    Err(format!(
        "Bundled tool '{filename}' was not found. Reinstall the application."
    ))
}

fn bundled_command(app: &tauri::AppHandle, tool: &str) -> Result<Command, String> {
    let (path, tools_dir) = bundled_tool(app, tool)?;
    let mut command = new_command(path);
    let mut paths = vec![tools_dir];
    if let Some(existing_path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&existing_path));
    }
    let path = env::join_paths(paths).map_err(|error| {
        format!("Could not configure the bundled tools PATH: {error}")
    })?;
    command.env("PATH", path);
    Ok(command)
}

#[derive(Debug, Deserialize)]
pub struct DownloadRequest {
    url: String,
    mode: String,
    format: String,
    output_dir: String,
    #[serde(default)]
    cookies_from_browser: Option<String>,
    #[serde(default = "default_quality")]
    quality: String,
}

fn default_quality() -> String {
    "highest".into()
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

#[cfg(unix)]
fn send_signal(pid: u32, sig: nix::sys::signal::Signal) -> Result<(), String> {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), sig).map_err(|e| e.to_string())
}

#[cfg(windows)]
async fn kill_windows_process(pid: u32) -> Result<(), String> {
    new_command("taskkill")
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
    if request.url.trim().is_empty() {
        return Err("URL is not valid.".into());
    }

    let mut args: Vec<String> = vec![request.url.clone()];

    if let Some(browser) = request.cookies_from_browser.as_deref() {
        let browser = browser.trim();
        if !browser.is_empty() {
            args.push("--cookies-from-browser".into());
            args.push(browser.into());
        }
    }

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
            args.push(video_format(&request.quality)?);
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

    let mut child = bundled_command(&app, "yt-dlp")?
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start the bundled yt-dlp: {e}"))?;

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
        let _ = app
            .notification()
            .builder()
            .title("Download complete")
            .body(format!("Finished downloading: {}", request.url))
            .show();
        Ok(DownloadResult {
            success: true,
            message: "Download complete.".into(),
        })
    } else if state.cancelled.load(Ordering::SeqCst) {
        let _ = app
            .notification()
            .builder()
            .title("Download cancelled")
            .body(format!("Cancelled: {}", request.url))
            .show();
        Ok(DownloadResult {
            success: false,
            message: "Download cancelled.".into(),
        })
    } else {
        let _ = app
            .notification()
            .builder()
            .title("Download failed")
            .body(format!("yt-dlp exited with status: {status}"))
            .show();
        Err(format!("yt-dlp exited with status: {status}"))
    }
}

fn video_format(quality: &str) -> Result<String, String> {
    match quality {
        "lowest" => Ok("worstvideo+worstaudio/worst".into()),
        "highest" => Ok("bestvideo+bestaudio/best".into()),
        "360" | "480" | "720" | "1080" | "1440" | "2160" => Ok(format!(
            "bestvideo[height<={quality}]+bestaudio/best[height<={quality}]/best"
        )),
        _ => Err("Unsupported video quality.".into()),
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
    // Launch explorer directly with the path as its own argument rather than
    // building a shell command string — avoids quoting/injection issues and
    // the extra pwsh dependency, and doesn't flash a console window.
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd.arg(dir).spawn();
}

#[tauri::command]
async fn check_yt_dlp_installed(app: tauri::AppHandle) -> bool {
    check_bundled_tool(&app, "yt-dlp", "--version").await
}

#[tauri::command]
async fn check_ffmpeg_installed(app: tauri::AppHandle) -> bool {
    check_bundled_tool(&app, "ffmpeg", "-version").await
}

#[tauri::command]
async fn check_ffprobe_installed(app: tauri::AppHandle) -> bool {
    check_bundled_tool(&app, "ffprobe", "-version").await
}

#[tauri::command]
async fn check_deno_installed(app: tauri::AppHandle) -> bool {
    check_bundled_tool(&app, "deno", "--version").await
}

async fn check_bundled_tool(app: &tauri::AppHandle, tool: &str, version_arg: &str) -> bool {
    match bundled_command(app, tool) {
        Ok(mut command) => command
            .arg(version_arg)
            .output()
            .await
            .map(|output| output.status.success())
            .unwrap_or(false),
        Err(_) => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(DownloadState::default())
        .invoke_handler(tauri::generate_handler![
            download_media,
            cancel_download,
            pause_download,
            resume_download,
            check_yt_dlp_installed,
            check_ffmpeg_installed,
            check_ffprobe_installed,
            check_deno_installed,
            open_result_dir,
            get_default_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}