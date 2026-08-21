import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

type Mode = "video" | "audio";
type Format = "mp4" | "mp3";
type AppTheme = "light" | "dark";

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

  const [theme, setTheme] = useState<AppTheme>("dark");

  const format: Format = mode === "video" ? "mp4" : "mp3";

  useEffect(() => {
    invoke<string>("get_default_path").then(setOutputDir);
    invoke<boolean>("check_yt_dlp_installed").then(setYtDlpReady);
    invoke<boolean>("check_ffmpeg_installed").then(setFfmpegReady);
    
    document.body.setAttribute("data-theme", theme)

    const unlisten = listen<DownloadProgress>("download-progress", (event) => {
      setLogs((prev) => [...prev.slice(-200), event.payload.line]);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [theme]);

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
      <div className=" w-screen max-w-xl">
        <h1
          className=" font-semibold tracking-tight p-0 m-0 "
          style={{ fontSize: "34px" }}
        >
          YouTube Downloader
        </h1>
        <div className="w-full max-w-xl bg-[var(--bg-t)] rounded-2xl p-8">
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
            className="w-full rounded-lg px-3 py-2 mb-4 text-sm outline-none focus:border-neutral-500 transition-colors disabled:opacity-50"
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
                className="text-sm rounded-lg px-3 py-2 transition-colors disabled:opacity-50 w-full"
              >
                Choose folder
              </button>
            </div>

            <div className="flex items-center gap-2 mb-6 flex-1">
              <button
                onClick={openFolder}
                disabled={isDownloading}
                className="flex-1 rounded-lg py-2 text-sm font-medium border transition-colors"
              >
                Open folder
              </button>
            </div>
          </div>

          {!isDownloading ? (
            <button
              onClick={handleDownload}
              className="w-full active text-white font-medium rounded-lg py-2.5 text-sm transition-colors"
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
                  ? theme == "dark" ? "bg-green-950 border-green-800 text-green-300" : "bg-green-200 border-green-300 text-green-500"
                  : theme == "dark" ? "bg-red-950 border-red-800 text-red-300" :"bg-red-200 border-red-300 text-red-500"
              }`}
            >
              {status.message}
            </div>
          )}
        </div>

        <div className="theme">
          <div className={`themeToggle ${theme}`} onClick={() => setTheme(theme == "dark" ? "light" : "dark")}>
            <div className="toggle">
              {theme == "dark" ? (
                <svg
                  width="24px"
                  height="24px"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <g id="SVGRepo_bgCarrier" stroke-width="0"></g>
                  <g
                    id="SVGRepo_tracerCarrier"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  ></g>
                  <g id="SVGRepo_iconCarrier">
                    {" "}
                    <path
                      fill-rule="evenodd"
                      clip-rule="evenodd"
                      d="M11.203 6.02337C7.59276 6.99074 5.45107 10.6948 6.41557 14.2943C7.38006 17.8938 11.0868 20.0307 14.6971 19.0634C16.1096 18.6849 17.2975 17.8877 18.1626 16.8409C15.1968 17.3646 12.2709 15.546 11.4775 12.585C10.7644 9.92365 12.0047 7.20008 14.3182 5.92871C13.3186 5.72294 12.2569 5.74098 11.203 6.02337ZM4.96668 14.6825C3.78704 10.2801 6.40707 5.75553 10.8148 4.57448C12.968 3.99752 15.1519 4.3254 16.9581 5.32413L16.6781 6.72587C16.4602 6.75011 16.241 6.79108 16.0218 6.8498C13.6871 7.47537 12.303 9.8703 12.9264 12.1968C13.5497 14.5233 15.9459 15.9053 18.2806 15.2797C18.7257 15.1604 19.1351 14.9774 19.5024 14.7435L20.5991 15.6609C19.6542 17.9633 17.6796 19.8171 15.0853 20.5123C10.6776 21.6933 6.14631 19.085 4.96668 14.6825Z"
                      fill="#000000"
                    ></path>{" "}
                  </g>
                </svg>
              ) : (
                <svg
                  fill="#000000"
                  width="24px"
                  height="24px"
                  viewBox="-5.5 0 32 32"
                  version="1.1"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <g id="SVGRepo_bgCarrier" stroke-width="0"></g>
                  <g
                    id="SVGRepo_tracerCarrier"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  ></g>
                  <g id="SVGRepo_iconCarrier">
                    {" "}
                    <title>light</title>{" "}
                    <path d="M11.875 6v2.469c0 0.844-0.375 1.25-1.156 1.25s-1.156-0.406-1.156-1.25v-2.469c0-0.813 0.375-1.219 1.156-1.219s1.156 0.406 1.156 1.219zM14.219 9.25l1.438-2.031c0.469-0.625 1.063-0.75 1.656-0.313s0.656 1 0.188 1.688l-1.438 2c-0.469 0.688-1.031 0.75-1.656 0.313-0.594-0.438-0.656-0.969-0.188-1.656zM5.781 7.25l1.469 2c0.469 0.688 0.406 1.219-0.219 1.656-0.594 0.469-1.156 0.375-1.625-0.313l-1.469-2c-0.469-0.688-0.406-1.219 0.219-1.656 0.594-0.469 1.156-0.375 1.625 0.313zM10.719 11.125c2.688 0 4.875 2.188 4.875 4.875 0 2.656-2.188 4.813-4.875 4.813s-4.875-2.156-4.875-4.813c0-2.688 2.188-4.875 4.875-4.875zM1.594 11.813l2.375 0.75c0.781 0.25 1.063 0.719 0.813 1.469-0.219 0.75-0.75 0.969-1.563 0.719l-2.313-0.75c-0.781-0.25-1.063-0.75-0.844-1.5 0.25-0.719 0.75-0.938 1.531-0.688zM17.5 12.563l2.344-0.75c0.813-0.25 1.313-0.031 1.531 0.688 0.25 0.75-0.031 1.25-0.844 1.469l-2.313 0.781c-0.781 0.25-1.281 0.031-1.531-0.719-0.219-0.75 0.031-1.219 0.813-1.469zM10.719 18.688c1.5 0 2.719-1.219 2.719-2.688 0-1.5-1.219-2.719-2.719-2.719s-2.688 1.219-2.688 2.719c0 1.469 1.188 2.688 2.688 2.688zM0.906 17.969l2.344-0.75c0.781-0.25 1.313-0.063 1.531 0.688 0.25 0.75-0.031 1.219-0.813 1.469l-2.375 0.781c-0.781 0.25-1.281 0.031-1.531-0.719-0.219-0.75 0.063-1.219 0.844-1.469zM18.219 17.219l2.344 0.75c0.781 0.25 1.063 0.719 0.813 1.469-0.219 0.75-0.719 0.969-1.531 0.719l-2.344-0.781c-0.813-0.25-1.031-0.719-0.813-1.469 0.25-0.75 0.75-0.938 1.531-0.688zM3.938 23.344l1.469-1.969c0.469-0.688 1.031-0.781 1.625-0.313 0.625 0.438 0.688 0.969 0.219 1.656l-1.469 1.969c-0.469 0.688-1.031 0.813-1.656 0.375-0.594-0.438-0.656-1.031-0.188-1.719zM16.063 21.375l1.438 1.969c0.469 0.688 0.406 1.281-0.188 1.719s-1.188 0.281-1.656-0.344l-1.438-2c-0.469-0.688-0.406-1.219 0.188-1.656 0.625-0.438 1.188-0.375 1.656 0.313zM11.875 23.469v2.469c0 0.844-0.375 1.25-1.156 1.25s-1.156-0.406-1.156-1.25v-2.469c0-0.844 0.375-1.25 1.156-1.25s1.156 0.406 1.156 1.25z"></path>{" "}
                  </g>
                </svg>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* {logs.length > 0 && ( */}
      <div className=" mt-4 flex flex-1">
        <div className="bg-[var(--logs)] rounded-2xl p-3 h-[450px] w-full overflow-y-auto font-mono text-xs text-neutral-400">
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
