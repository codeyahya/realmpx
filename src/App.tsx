import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

type Mode = "video" | "audio";
type Format = "mp4" | "mp3";

interface DownloadProgress {
  line: string;
}

function App() {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("video");
  const [outputDir, setOutputDir] = useState<string>(
    "C:\\Users\\HP\\Downloads",
  );
  const [logs, setLogs] = useState<string[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [status, setStatus] = useState<{
    type: "idle" | "success" | "error";
    message: string;
  }>({
    type: "idle",
    message: "",
  });
  const [ytDlpReady, setYtDlpReady] = useState<boolean | null>(null);
  const [ffmpegReady, setFfmpegReady] = useState<boolean | null>(null);

  const format: Format = mode === "video" ? "mp4" : "mp3";

  useEffect(() => {
    invoke<boolean>("check_yt_dlp_installed").then(setYtDlpReady);
    invoke<boolean>("check_ffmpeg_installed").then(setFfmpegReady);

    const unlisten = listen<DownloadProgress>("download-progress", (event) => {
      setLogs((prev) => [...prev.slice(-200), event.payload.line]);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function pickFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setOutputDir(dir);
  }

  async function openFolder() {
    await invoke("open_result_dir", { dir: outputDir });
  }

  async function handleDownload() {
    if (!url.trim()) {
      setStatus({ type: "error", message: "Paste a YouTube URL first." });
      return;
    }
    if (!outputDir) {
      setStatus({ type: "error", message: "Choose a download folder first." });
      return;
    }

    setIsDownloading(true);
    setIsPaused(false);
    setLogs([]);
    setStatus({ type: "idle", message: "" });

    try {
      const result = await invoke<{ success: boolean; message: string }>(
        "download_media",
        {
          request: { url, mode, format, output_dir: outputDir },
        },
      );
      setStatus({
        type: result.success ? "success" : "error",
        message: result.message,
      });
    } catch (err) {
      setStatus({ type: "error", message: String(err) });
    } finally {
      setIsDownloading(false);
      setIsPaused(false);
    }
  }

  async function handleCancel() {
    try {
      await invoke("cancel_download");
    } catch (err) {
      setStatus({ type: "error", message: String(err) });
    }
  }

  async function handleTogglePause() {
    try {
      if (isPaused) {
        await invoke("resume_download");
        setIsPaused(false);
      } else {
        await invoke("pause_download");
        setIsPaused(true);
      }
    } catch (err) {
      setStatus({ type: "error", message: String(err) });
    }
  }

  return (
    <div className="min-h-screen  text-neutral-100 flex items-center gap-3 p-6">
      <div className="w-full max-w-xl">
        <h1
          className=" font-semibold tracking-tight p-0 m-0 "
          style={{ fontSize: "34px" }}
        >
          YouTube Downloader
        </h1>
        <div className="w-full max-w-xl bg-[var(--bg-t)]  rounded-2xl p-8">
          {ytDlpReady === false && (
            <div className="mb-4 text-sm bg-red-950 border border-red-800 text-red-300 rounded-lg px-3 py-2">
              yt-dlp wasn't found on your PATH. Install it and restart the app.
            </div>
          )}
          {ffmpegReady === false && (
            <div className="mb-4 text-sm bg-red-950 border border-red-800 text-red-300 rounded-lg px-3 py-2">
              ffmpeg wasn't found on your PATH — video downloads need it to
              merge audio and video into a single file. Install ffmpeg and
              restart the app.
            </div>
          )}

          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isDownloading}
            placeholder="https://www.youtube.com/watch?v=..."
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 mb-4 text-sm outline-none focus:border-neutral-500 transition-colors disabled:opacity-50"
          />

          <div className="flex gap-3 mb-4">
            <button
              onClick={() => setMode("video")}
              disabled={isDownloading}
              className={`flex-1 rounded-lg py-2 text-sm font-medium border transition-colors disabled:opacity-50 ${
                mode === "video" ? "active" : ""
              }`}
            >
              Video (MP4)
            </button>
            <button
              onClick={() => setMode("audio")}
              disabled={isDownloading}
              className={`flex-1 rounded-lg py-2 text-sm font-medium border transition-colors disabled:opacity-50 ${
                mode === "audio" ? "active" : ""
              }`}
            >
              Audio (MP3)
            </button>
          </div>

          <span className="text-xs text-neutral-500 truncate">
            {outputDir || "No folder selected"}
          </span>

          <div className="flex items-center gap-3">
            <div className="flex flex-col mb-6 flex-1">
              <button
                onClick={pickFolder}
                disabled={isDownloading}
                className="text-sm bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 hover:border-neutral-500 transition-colors disabled:opacity-50 w-full"
              >
                Choose folder
              </button>
            </div>

            <div className="flex items-center gap-2 mb-6 flex-1">
              <button
                onClick={openFolder}
                disabled={isDownloading}
                className="text-sm bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 hover:border-neutral-500 transition-colors disabled:opacity-50 w-full"
              >
                Open folder
              </button>
            </div>
          </div>

          {!isDownloading ? (
            <button
              onClick={handleDownload}
              className="w-full bg-[var(--accent)]! text-white font-medium rounded-lg py-2.5 text-sm transition-colors"
            >
              Download {format.toUpperCase()}
            </button>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={handleTogglePause}
                className="flex-1 bg-amber-500 hover:bg-amber-400 text-white font-medium rounded-lg py-2.5 text-sm transition-colors"
              >
                {isPaused ? "Resume" : "Pause"}
              </button>
              <button
                onClick={handleCancel}
                className="flex-1 bg-red-600 hover:bg-red-500 text-white font-medium rounded-lg py-2.5 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          {status.type !== "idle" && (
            <div
              className={`mt-4 text-sm rounded-lg px-3 py-2 border ${
                status.type === "success"
                  ? "bg-green-950 border-green-800 text-green-300"
                  : "bg-red-950 border-red-800 text-red-300"
              }`}
            >
              {status.message}
            </div>
          )}
        </div>
      </div>

      {logs.length > 0 && (
        <div className="overflow-hidden mt-4">
          <div className=" bg-black/40 border border-neutral-800 rounded-lg p-3 h-[450px] overflow-y-auto font-mono text-xs text-neutral-400">
            {logs.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
