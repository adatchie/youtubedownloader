from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool


ROOT = Path(__file__).resolve().parent
MAX_URL_LENGTH = 2048
MAX_FILE_BYTES = 256 * 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 300
MAX_CONCURRENT_DOWNLOADS = 2
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_REQUESTS = 3

YOUTUBE_HOSTS = frozenset(
    {
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
        "www.youtu.be",
    }
)
VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{6,32}$")
DOWNLOAD_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_DOWNLOADS)
RATE_LIMIT_LOCK = threading.Lock()
RATE_LIMIT_HISTORY: dict[str, deque[float]] = defaultdict(deque)
LOGGER = logging.getLogger("youtubedownloader")


class RequestError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class DownloadRequest(BaseModel):
    url: str = Field(default="", max_length=MAX_URL_LENGTH)
    format: Literal["mp4", "mp3"]
    rights_confirmed: bool = False


def error_response(error: RequestError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={"detail": {"code": error.code, "message": error.message}},
    )


def validate_youtube_url(raw_url: str) -> str:
    value = raw_url.strip()
    if not value:
        raise RequestError("missing-url", "動画ページURLを入力してください。")
    if len(value) > MAX_URL_LENGTH:
        raise RequestError("url-too-long", "URLは2,048文字以内で入力してください。")

    try:
        parsed = urlsplit(value)
        hostname = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
    except ValueError:
        raise RequestError("invalid-url", "動画ページURLの形式を確認してください。") from None

    if parsed.scheme.lower() != "https":
        raise RequestError("invalid-scheme", "安全のためHTTPSの動画ページURLだけ使用できます。")
    if hostname not in YOUTUBE_HOSTS:
        raise RequestError("unsupported-host", "現在はYouTube / youtu.beの動画ページURLだけ対応しています。")
    if parsed.username or parsed.password or (port is not None and port != 443):
        raise RequestError("invalid-url", "ログイン情報や特殊なポートを含むURLは使用できません。")

    query = parse_qs(parsed.query, keep_blank_values=True)
    if any(key in query for key in {"list", "playlist", "index"}):
        raise RequestError("playlist-not-supported", "Playlistではなく、1本の動画ページURLを指定してください。")

    path_parts = [part for part in parsed.path.split("/") if part]
    video_id = ""

    if hostname in {"youtu.be", "www.youtu.be"}:
        if len(path_parts) == 1:
            video_id = path_parts[0]
    elif parsed.path.rstrip("/") == "/watch":
        values = query.get("v", [])
        if len(values) == 1:
            video_id = values[0]
    elif len(path_parts) == 2 and path_parts[0] in {"shorts", "embed", "live"}:
        video_id = path_parts[1]

    if not VIDEO_ID_PATTERN.fullmatch(video_id):
        raise RequestError(
            "video-url-required",
            "YouTubeの動画ページURLを指定してください。Playlist・チャンネル・検索URLは対応していません。",
        )

    # Fragments are browser-only state and must not be forwarded to the extractor.
    return parsed._replace(fragment="").geturl()


def enforce_rate_limit(client_key: str) -> None:
    now = time.monotonic()
    with RATE_LIMIT_LOCK:
        history = RATE_LIMIT_HISTORY[client_key]
        cutoff = now - RATE_LIMIT_WINDOW_SECONDS
        while history and history[0] <= cutoff:
            history.popleft()
        if len(history) >= RATE_LIMIT_REQUESTS:
            raise RequestError(
                "rate-limited",
                "短時間の変換回数が上限に達しました。しばらく待ってから再試行してください。",
                429,
            )
        history.append(now)


def build_ytdlp_command(url: str, media_format: str, work_dir: Path) -> list[str]:
    output_template = str(work_dir / "%(id)s.%(ext)s")
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--ignore-config",
        "--no-playlist",
        "--no-cache-dir",
        "--no-warnings",
        "--no-progress",
        "--restrict-filenames",
        "--no-part",
        "--socket-timeout",
        "30",
        "--retries",
        "2",
        "--fragment-retries",
        "2",
        "--max-filesize",
        "256M",
        "--print",
        "after_move:filepath",
        "--output",
        output_template,
    ]

    if media_format == "mp4":
        command.extend(
            [
                "--format",
                "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]",
                "--merge-output-format",
                "mp4",
                "--remux-video",
                "mp4",
            ]
        )
    elif media_format == "mp3":
        command.extend(
            [
                "--format",
                "ba/b",
                "--extract-audio",
                "--audio-format",
                "mp3",
                "--audio-quality",
                "192K",
            ]
        )
    else:
        raise RequestError("invalid-format", "保存形式はMP4またはMP3だけ指定できます。")

    command.append(url)
    return command


def classify_downloader_error(stderr: str) -> tuple[str, str]:
    message = stderr.lower()
    if "private video" in message or "sign in" in message or "login" in message:
        return "restricted-video", "非公開またはログインが必要な動画には対応していません。"
    if "drm" in message or "protected" in message:
        return "drm-video", "DRMで保護された動画には対応していません。"
    if "playlist" in message and "video" not in message:
        return "playlist-not-supported", "Playlistではなく、1本の動画ページURLを指定してください。"
    if "requested format is not available" in message:
        return "format-unavailable", "この動画では選択した形式を作成できません。"
    return "download-failed", "動画を取得できませんでした。公開状態とURLを確認してください。"


def find_output_file(work_dir: Path, stdout: str) -> Path:
    root = work_dir.resolve()
    for line in reversed(stdout.splitlines()):
        candidate_text = line.strip()
        if not candidate_text:
            continue
        candidate = Path(candidate_text)
        if not candidate.is_absolute():
            candidate = work_dir / candidate
        try:
            resolved = candidate.resolve()
            resolved.relative_to(root)
        except (OSError, ValueError):
            continue
        if resolved.is_file() and resolved.stat().st_size > 0:
            return resolved

    raise RequestError("empty-output", "動画の出力ファイルを作成できませんでした。", 502)


def remove_work_dir(work_dir: str) -> None:
    shutil.rmtree(work_dir, ignore_errors=True)


def download_media(url: str, media_format: str) -> tuple[Path, Path]:
    if not DOWNLOAD_SLOTS.acquire(blocking=False):
        raise RequestError(
            "busy",
            "現在ほかの変換処理が実行中です。少し待ってから再試行してください。",
            429,
        )

    work_dir: Path | None = None
    try:
        work_dir = Path(tempfile.mkdtemp(prefix="youtubedownloader-"))
        command = build_ytdlp_command(url, media_format, work_dir)
        completed = subprocess.run(
            command,
            cwd=work_dir,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0:
            code, message = classify_downloader_error(completed.stderr)
            LOGGER.warning("yt-dlp failed: returncode=%s code=%s", completed.returncode, code)
            raise RequestError(code, message, 502)

        output_path = find_output_file(work_dir, completed.stdout)
        if output_path.stat().st_size > MAX_FILE_BYTES:
            raise RequestError(
                "output-too-large",
                "出力ファイルが大きすぎます。256MiB以下の動画を使用してください。",
                413,
            )
        return output_path, work_dir
    except subprocess.TimeoutExpired:
        if work_dir is not None:
            remove_work_dir(str(work_dir))
        raise RequestError(
            "download-timeout",
            "取得処理が時間制限を超えました。短い動画で再試行してください。",
            504,
        ) from None
    except RequestError:
        if work_dir is not None:
            remove_work_dir(str(work_dir))
        raise
    except OSError:
        if work_dir is not None:
            remove_work_dir(str(work_dir))
        LOGGER.exception("failed to start or run yt-dlp")
        raise RequestError("server-error", "変換サーバーを起動できませんでした。", 500) from None
    finally:
        DOWNLOAD_SLOTS.release()


app = FastAPI(
    title="まっすぐ保存",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=False,
        allow_methods=["POST", "GET"],
        allow_headers=["Content-Type", "Accept"],
    )


@app.exception_handler(RequestValidationError)
async def request_validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
    return error_response(RequestError("invalid-request", "URLと保存形式を確認してください。"))


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/download")
async def download(request: Request, payload: DownloadRequest):
    if not payload.rights_confirmed:
        return error_response(
            RequestError(
                "rights-required",
                "著作権フリー、パブリックドメイン、または利用許諾済みの素材だけ使用してください。",
            )
        )

    try:
        normalized_url = validate_youtube_url(payload.url)
        client_key = request.client.host if request.client else "unknown"
        enforce_rate_limit(client_key)
        output_path, work_dir = await run_in_threadpool(download_media, normalized_url, payload.format)
    except RequestError as error:
        return error_response(error)

    filename = f"video.{payload.format}" if payload.format == "mp4" else "audio.mp3"
    media_type = "video/mp4" if payload.format == "mp4" else "audio/mpeg"
    return FileResponse(
        output_path,
        media_type=media_type,
        filename=filename,
        background=BackgroundTask(remove_work_dir, str(work_dir)),
    )


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(ROOT / "index.html", media_type="text/html; charset=utf-8")


@app.get("/styles.css")
async def styles() -> FileResponse:
    return FileResponse(ROOT / "styles.css", media_type="text/css; charset=utf-8")


@app.get("/app.js")
async def script() -> FileResponse:
    return FileResponse(ROOT / "app.js", media_type="application/javascript; charset=utf-8")
