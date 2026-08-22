from __future__ import annotations

import logging
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
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
JOB_RETENTION_SECONDS = 15 * 60
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
YOUTUBE_PLAYER_CLIENTS = (
    "default",
    "android_vr",
    "mweb",
)
VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{6,32}$")
DOWNLOAD_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_DOWNLOADS)
RATE_LIMIT_LOCK = threading.Lock()
RATE_LIMIT_HISTORY: dict[str, deque[float]] = defaultdict(deque)
JOB_LOCK = threading.Lock()
DOWNLOAD_JOBS: dict[str, "DownloadJob"] = {}
JOB_EXECUTOR = ThreadPoolExecutor(
    max_workers=MAX_CONCURRENT_DOWNLOADS,
    thread_name_prefix="media-download",
)
LOGGER = logging.getLogger("youtubedownloader")


class RequestError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass
class DownloadJob:
    job_id: str
    media_format: Literal["mp4", "mp3"]
    created_at: float
    status: Literal["queued", "processing", "ready", "failed", "delivering"] = "queued"
    output_path: Path | None = None
    work_dir: Path | None = None
    error: RequestError | None = None
    finished_at: float | None = None


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


def build_ytdlp_command(
    url: str,
    media_format: str,
    work_dir: Path,
    *,
    player_clients: str | None = None,
) -> list[str]:
    selected_clients = player_clients or YOUTUBE_PLAYER_CLIENTS[0]
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
        "--js-runtimes",
        "node",
        "--remote-components",
        "ejs:github",
        "--extractor-args",
        f"youtube:player_client={selected_clients}",
        "--max-filesize",
        "256M",
        "--print",
        "after_move:filepath",
        "--output",
        output_template,
    ]

    pot_provider_url = os.getenv("YTDLP_POT_PROVIDER_URL", "").strip()
    if pot_provider_url:
        command.extend(
            [
                "--extractor-args",
                f"youtubepot-bgutilhttp:base_url={pot_provider_url}",
            ]
        )

    if media_format == "mp4":
        command.extend(
            [
                "--format",
                "bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/bv*+ba/b",
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
    if "http error 403" in message:
        return "media-forbidden", "選択した形式をYouTube側が許可しませんでした。別の形式で再試行してください。"
    if "confirm you're not a bot" in message or "confirm you’re not a bot" in message:
        return "youtube-bot-check", "YouTube側の自動取得制限により処理できませんでした。時間を置いて再試行してください。"
    if "private video" in message or "sign in" in message or "login" in message:
        return "restricted-video", "非公開またはログインが必要な動画には対応していません。"
    if "drm" in message or "protected" in message:
        return "drm-video", "DRMで保護された動画には対応していません。"
    if "playlist" in message and "video" not in message:
        return "playlist-not-supported", "Playlistではなく、1本の動画ページURLを指定してください。"
    if "requested format is not available" in message or "unable to download video data" in message:
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


def download_media(
    url: str,
    media_format: str,
    *,
    slot_acquired: bool = False,
) -> tuple[Path, Path]:
    if not slot_acquired and not DOWNLOAD_SLOTS.acquire(blocking=False):
        raise RequestError(
            "busy",
            "現在ほかの変換処理が実行中です。少し待ってから再試行してください。",
            429,
        )

    work_dir: Path | None = None
    try:
        work_dir = Path(tempfile.mkdtemp(prefix="youtubedownloader-"))
        deadline = time.monotonic() + DOWNLOAD_TIMEOUT_SECONDS
        for attempt, player_clients in enumerate(YOUTUBE_PLAYER_CLIENTS):
            command = build_ytdlp_command(
                url,
                media_format,
                work_dir,
                player_clients=player_clients,
            )
            remaining_timeout = max(1, int(deadline - time.monotonic()))
            completed = subprocess.run(
                command,
                cwd=work_dir,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=remaining_timeout,
                check=False,
            )
            if completed.returncode == 0:
                output_path = find_output_file(work_dir, completed.stdout)
                break

            code, message = classify_downloader_error(completed.stderr)
            should_retry = code in {"youtube-bot-check", "format-unavailable", "media-forbidden"}
            if not should_retry or attempt == len(YOUTUBE_PLAYER_CLIENTS) - 1:
                LOGGER.warning("yt-dlp failed: returncode=%s code=%s", completed.returncode, code)
                raise RequestError(code, message, 502)

            LOGGER.warning(
                "yt-dlp %s: retrying with player_client=%s",
                code,
                YOUTUBE_PLAYER_CLIENTS[attempt + 1],
            )

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
        if not slot_acquired:
            DOWNLOAD_SLOTS.release()


def prune_download_jobs() -> None:
    now = time.monotonic()
    expired_work_dirs: list[Path] = []
    with JOB_LOCK:
        expired_ids = [
            job_id
            for job_id, job in DOWNLOAD_JOBS.items()
            if job.finished_at is not None
            and job.status in {"ready", "failed"}
            and now - job.finished_at >= JOB_RETENTION_SECONDS
        ]
        for job_id in expired_ids:
            job = DOWNLOAD_JOBS.pop(job_id)
            if job.work_dir is not None:
                expired_work_dirs.append(job.work_dir)

    for work_dir in expired_work_dirs:
        remove_work_dir(str(work_dir))


def serialize_download_job(job: DownloadJob) -> dict[str, object]:
    payload: dict[str, object] = {
        "job_id": job.job_id,
        "format": job.media_format,
        "status": job.status,
        "status_url": f"/api/download-jobs/{job.job_id}",
        "download_url": None,
        "error": None,
    }
    if job.status == "ready":
        payload["download_url"] = f"/api/download-jobs/{job.job_id}/file"
    if job.error is not None:
        payload["error"] = {"code": job.error.code, "message": job.error.message}
    return payload


def run_download_job(job_id: str, url: str, media_format: str) -> None:
    with JOB_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
        if job is None:
            DOWNLOAD_SLOTS.release()
            return
        job.status = "processing"

    try:
        output_path, work_dir = download_media(url, media_format, slot_acquired=True)
    except RequestError as error:
        with JOB_LOCK:
            job = DOWNLOAD_JOBS.get(job_id)
            if job is not None:
                job.status = "failed"
                job.error = error
                job.finished_at = time.monotonic()
    except Exception:
        LOGGER.exception("download job failed unexpectedly: job_id=%s", job_id)
        error = RequestError("server-error", "変換サーバーで予期しないエラーが発生しました。", 500)
        with JOB_LOCK:
            job = DOWNLOAD_JOBS.get(job_id)
            if job is not None:
                job.status = "failed"
                job.error = error
                job.finished_at = time.monotonic()
    else:
        with JOB_LOCK:
            job = DOWNLOAD_JOBS.get(job_id)
            if job is not None:
                job.status = "ready"
                job.output_path = output_path
                job.work_dir = work_dir
                job.finished_at = time.monotonic()
    finally:
        DOWNLOAD_SLOTS.release()


def start_download_job(url: str, media_format: Literal["mp4", "mp3"]) -> DownloadJob:
    prune_download_jobs()
    if not DOWNLOAD_SLOTS.acquire(blocking=False):
        raise RequestError(
            "busy",
            "現在ほかの変換処理が実行中です。少し待ってから再試行してください。",
            429,
        )

    job = DownloadJob(
        job_id=secrets.token_urlsafe(18),
        media_format=media_format,
        created_at=time.monotonic(),
    )
    with JOB_LOCK:
        DOWNLOAD_JOBS[job.job_id] = job

    try:
        JOB_EXECUTOR.submit(run_download_job, job.job_id, url, media_format)
    except Exception:
        with JOB_LOCK:
            DOWNLOAD_JOBS.pop(job.job_id, None)
        DOWNLOAD_SLOTS.release()
        LOGGER.exception("failed to queue download job: job_id=%s", job.job_id)
        raise RequestError("server-error", "変換処理を開始できませんでした。", 500) from None
    return job


def validate_download_request(request: Request, payload: DownloadRequest) -> str:
    if not payload.rights_confirmed:
        raise RequestError(
            "rights-required",
            "著作権フリー、パブリックドメイン、または利用許諾済みの素材だけ使用してください。",
        )

    normalized_url = validate_youtube_url(payload.url)
    client_key = request.client.host if request.client else "unknown"
    enforce_rate_limit(client_key)
    return normalized_url


def media_response_details(media_format: str) -> tuple[str, str]:
    if media_format == "mp4":
        return "video.mp4", "video/mp4"
    return "audio.mp3", "audio/mpeg"


def finish_download_job(job_id: str, work_dir: str) -> None:
    remove_work_dir(work_dir)
    with JOB_LOCK:
        DOWNLOAD_JOBS.pop(job_id, None)


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


@app.post("/api/download-jobs", status_code=202)
async def create_download_job(request: Request, payload: DownloadRequest):
    try:
        normalized_url = validate_download_request(request, payload)
        job = start_download_job(normalized_url, payload.format)
    except RequestError as error:
        return error_response(error)

    with JOB_LOCK:
        return JSONResponse(status_code=202, content=serialize_download_job(job))


@app.get("/api/download-jobs/{job_id}")
async def download_job_status(job_id: str):
    prune_download_jobs()
    with JOB_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
        if job is None:
            return error_response(RequestError("job-not-found", "変換処理が見つかりません。", 404))
        return serialize_download_job(job)


@app.get("/api/download-jobs/{job_id}/file")
async def download_job_file(job_id: str):
    prune_download_jobs()
    with JOB_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
        if job is None:
            return error_response(RequestError("job-not-found", "変換処理が見つかりません。", 404))
        if job.status == "failed" and job.error is not None:
            return error_response(job.error)
        if job.status != "ready" or job.output_path is None or job.work_dir is None:
            return error_response(
                RequestError("job-not-ready", "変換処理がまだ完了していません。", 409)
            )
        if not job.output_path.is_file():
            job.status = "failed"
            job.error = RequestError("empty-output", "動画の出力ファイルを作成できませんでした。", 502)
            job.finished_at = time.monotonic()
            return error_response(job.error)

        job.status = "delivering"
        output_path = job.output_path
        work_dir = job.work_dir
        filename, media_type = media_response_details(job.media_format)

    return FileResponse(
        output_path,
        media_type=media_type,
        filename=filename,
        background=BackgroundTask(finish_download_job, job_id, str(work_dir)),
    )


@app.post("/api/download")
async def download(request: Request, payload: DownloadRequest):
    try:
        normalized_url = validate_download_request(request, payload)
        output_path, work_dir = await run_in_threadpool(download_media, normalized_url, payload.format)
    except RequestError as error:
        return error_response(error)

    filename, media_type = media_response_details(payload.format)
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


@app.get("/api-config.js")
async def api_config() -> FileResponse:
    return FileResponse(ROOT / "api-config.js", media_type="application/javascript; charset=utf-8")
