(() => {
  "use strict";

  const form = document.querySelector("#download-form");
  const urlInput = document.querySelector("#media-url");
  const clearButton = document.querySelector("#clear-url");
  const rightsCheckbox = document.querySelector("#rights-confirm");
  const downloadButton = document.querySelector("#download-button");
  const urlInputWrap = document.querySelector(".url-input-wrap");
  const urlError = document.querySelector("#url-error");
  const fileNamePreview = document.querySelector("#file-name-preview");
  const formatInputs = [...document.querySelectorAll('input[name="format"]')];
  const statusPanel = document.querySelector("#status-panel");
  const statusIcon = document.querySelector("#status-icon");
  const statusKicker = document.querySelector("#status-kicker");
  const statusTitle = document.querySelector("#status-title");
  const statusMessage = document.querySelector("#status-message");
  const statusMeta = document.querySelector("#status-meta");
  const fallbackLink = document.querySelector("#fallback-link");
  const progressWrap = document.querySelector("#progress-wrap");
  const progressTrack = document.querySelector(".progress-track");
  const progressBar = document.querySelector("#progress-bar");
  const progressLabel = document.querySelector("#progress-label");
  const cancelButton = document.querySelector("#cancel-conversion");

  const MEDIA_EXTENSIONS = new Set(["mp4", "mp3"]);
  const MAX_URL_LENGTH = 2048;
  const MAX_INPUT_BYTES = 256 * 1024 * 1024;
  const FFMPEG_CORE_URL = new URL("./vendor/ffmpeg/ffmpeg-core.js", document.baseURI).href;
  const FFMPEG_WASM_URL = new URL("./vendor/ffmpeg/ffmpeg-core.wasm", document.baseURI).href;
  const REMOTE_CORE_URL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js";
  const REMOTE_WASM_URL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm";
  const REMOTE_CORE_SHA256 = "b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21";
  const REMOTE_WASM_SHA256 = "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7";

  const BLOB_WORKER_RUNTIME = `
let ffmpegRuntime = null;
const FFmpegMessage = { LOAD: "LOAD", EXEC: "EXEC", WRITE_FILE: "WRITE_FILE", READ_FILE: "READ_FILE", DELETE_FILE: "DELETE_FILE", ERROR: "ERROR", PROGRESS: "PROGRESS" };
self.onmessage = async ({ data: { id, type, data } }) => {
  let result;
  try {
    if (type !== FFmpegMessage.LOAD && !ffmpegRuntime) throw new Error("ffmpeg is not loaded");
    switch (type) {
      case FFmpegMessage.LOAD:
        ffmpegRuntime = await self.createFFmpegCore({ wasmBinary: data.wasmBinary, mainScriptUrlOrBlob: data.mainScriptUrlOrBlob });
        ffmpegRuntime.setProgress((progress) => self.postMessage({ type: FFmpegMessage.PROGRESS, data: progress }));
        result = true;
        break;
      case FFmpegMessage.EXEC:
        ffmpegRuntime.setTimeout(data.timeout);
        ffmpegRuntime.exec(...data.args);
        result = ffmpegRuntime.ret;
        ffmpegRuntime.reset();
        break;
      case FFmpegMessage.WRITE_FILE:
        ffmpegRuntime.FS.writeFile(data.path, data.data);
        result = true;
        break;
      case FFmpegMessage.READ_FILE:
        result = ffmpegRuntime.FS.readFile(data.path, { encoding: data.encoding });
        break;
      case FFmpegMessage.DELETE_FILE:
        ffmpegRuntime.FS.unlink(data.path);
        result = true;
        break;
      default:
        throw new Error("unknown ffmpeg message");
    }
  } catch (error) {
    self.postMessage({ id, type: FFmpegMessage.ERROR, data: String(error) });
    return;
  }
  const transfer = result instanceof Uint8Array ? [result.buffer] : [];
  self.postMessage({ id, type, data: result }, transfer);
};`;

  let ffmpegInstance = null;
  let ffmpegLoadPromise = null;
  let conversionController = null;
  let activeObjectUrl = null;
  let busy = false;

  function createAppError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function selectedFormat() {
    return formatInputs.find((input) => input.checked)?.value ?? "mp4";
  }

  function extensionFromPath(pathname) {
    const fileName = pathname.split("/").pop() ?? "";
    const match = fileName.match(/\.([a-z0-9]{2,5})$/i);
    return match ? match[1].toLowerCase() : "";
  }

  function safeFileName(url, format) {
    const encodedName = url.pathname.split("/").pop() || "media";
    let rawName = encodedName;

    try {
      rawName = decodeURIComponent(encodedName);
    } catch {
      // Keep the encoded name when a malformed escape sequence is supplied.
    }

    const withoutExtension = rawName.replace(/\.(mp4|mp3)$/i, "");
    const cleaned = withoutExtension
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/[. ]+$/g, "")
      .trim();

    return `${(cleaned || "media").slice(0, 120)}.${format}`;
  }

  function isLocalOrPrivateHost(hostname) {
    const host = hostname.toLowerCase().replace(/\.$/, "");

    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host)
    ) {
      return true;
    }

    const private172 = host.match(/^172\.(\d{1,3})\./);
    return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
  }

  function validateUrl() {
    const rawValue = urlInput.value.trim();

    if (!rawValue) {
      return { error: "URLを入力してください。" };
    }

    if (rawValue.length > MAX_URL_LENGTH) {
      return { error: `URLは${MAX_URL_LENGTH.toLocaleString("ja-JP")}文字以内で入力してください。` };
    }

    let url;
    try {
      url = new URL(rawValue);
    } catch {
      return { error: "URLの形式を確認してください。例: https://example.org/video.mp4" };
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: "http:// または https:// のURLだけ使用できます。" };
    }

    if (url.username || url.password) {
      return { error: "ログイン情報を含むURLは安全のため使用できません。" };
    }

    if (isLocalOrPrivateHost(url.hostname)) {
      return { error: "ローカルネットワーク上のURLは使用できません。公開された配布URLを指定してください。" };
    }

    const format = selectedFormat();
    const sourceExtension = extensionFromPath(url.pathname);

    if (format === "mp4" && sourceExtension === "mp3") {
      return { error: "MP3からMP4への変換は行いません。MP4の直リンクを指定してください。" };
    }

    if (!MEDIA_EXTENSIONS.has(sourceExtension)) {
      return { error: "URLのパス末尾が .mp4 または .mp3 の直リンクを指定してください。" };
    }

    return {
      format,
      mode: format === "mp3" && sourceExtension === "mp4" ? "convert" : "direct",
      sourceExtension,
      url,
      fileName: safeFileName(url, format)
    };
  }

  function updateButtonState() {
    const hasUrl = urlInput.value.trim().length > 0;
    downloadButton.disabled = busy || !hasUrl || !rightsCheckbox.checked;
    clearButton.hidden = !hasUrl;
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
    urlInput.disabled = nextBusy;
    clearButton.disabled = nextBusy;
    rightsCheckbox.disabled = nextBusy;
    formatInputs.forEach((input) => {
      input.disabled = nextBusy;
    });
    downloadButton.querySelector("span").textContent = nextBusy ? "変換しています…" : "保存準備をする";
    updateButtonState();
  }

  function showUrlError(message) {
    urlInputWrap.classList.toggle("has-error", Boolean(message));
    urlError.hidden = !message;
    urlError.textContent = message || "";
  }

  function updatePreview() {
    const rawValue = urlInput.value.trim();
    const format = selectedFormat();

    if (!rawValue) {
      fileNamePreview.textContent = `media.${format}`;
      return;
    }

    try {
      const url = new URL(rawValue);
      fileNamePreview.textContent = safeFileName(url, format);
    } catch {
      fileNamePreview.textContent = `media.${format}`;
    }
  }

  function setProgress(percent, label) {
    const safePercent = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
    progressBar.style.width = `${safePercent}%`;
    progressTrack.setAttribute("aria-valuenow", String(Math.round(safePercent)));
    progressLabel.textContent = label || `${Math.round(safePercent)}%`;
  }

  function setStatus({ state, kicker, title, message, meta, icon, showProgress = false, showCancel = false }) {
    statusPanel.hidden = false;
    statusPanel.dataset.state = state;
    statusKicker.textContent = kicker;
    statusTitle.textContent = title;
    statusMessage.textContent = message;
    statusMeta.textContent = meta || "";
    statusIcon.textContent = icon;
    progressWrap.hidden = !showProgress;
    cancelButton.hidden = !showCancel;
    fallbackLink.hidden = true;
  }

  function setFallbackLink(url, label = "ソースURLを開く ↗") {
    fallbackLink.href = url.href;
    fallbackLink.textContent = label;
    fallbackLink.hidden = false;
  }

  function revokeActiveObjectUrl() {
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
  }

  function triggerBlobDownload(data, fileName) {
    revokeActiveObjectUrl();
    const blob = new Blob([data], { type: "audio/mpeg" });
    activeObjectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = activeObjectUrl;
    anchor.download = fileName;
    anchor.rel = "noopener noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    window.setTimeout(() => {
      revokeActiveObjectUrl();
    }, 60_000);
  }

  function isAbortError(error) {
    return error?.name === "AbortError" || String(error?.message || error).toLowerCase().includes("aborted");
  }

  function conversionErrorMessage(error) {
    switch (error?.code) {
      case "source-too-large":
        return "変換元が大きすぎます。ブラウザ内変換の上限は256MiBです。短い素材か、分割済みの素材を使ってください。";
      case "source-page":
        return "HTMLページが返されました。動画ページではなく、MP4ファイルそのものの直リンクを指定してください。";
      case "source-cors":
        return "変換元の配布元がCORSを許可していないか、ネットワークに接続できません。配布元のCORS設定を確認してください。";
      case "source-response":
        return "変換元を取得できませんでした。URL、公開状態、配布元のアクセス制限を確認してください。";
      case "engine-unavailable":
        return "変換エンジンが読み込めません。同梱ファイルまたは固定版コアの通信状態を確認してください。";
      case "engine-load":
        return "変換エンジンの起動に失敗しました。ブラウザのWebAssemblyまたはWorker設定を確認してください。";
      case "engine-remote":
        return "変換エンジンを取得できませんでした。固定版コアの通信状態を確認し、もう一度試してください。";
      case "engine-integrity":
        return "変換エンジンのハッシュ検証に失敗しました。安全のため変換を中止しました。";
      default:
        return "MP4として読み込めないか、音声トラックがない可能性があります。公開されたMP4直リンクを確認してください。";
    }
  }

  async function readSourceBytes(response, signal, onProgress) {
    const lengthHeader = response.headers.get("content-length");
    const totalBytes = Number(lengthHeader);

    if (Number.isFinite(totalBytes) && totalBytes > MAX_INPUT_BYTES) {
      throw createAppError("source-too-large");
    }

    if (!response.body) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_INPUT_BYTES) {
        throw createAppError("source-too-large");
      }
      onProgress(32);
      return new Uint8Array(buffer);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_INPUT_BYTES) {
          await reader.cancel();
          throw createAppError("source-too-large");
        }

        chunks.push(value);
        const ratio = Number.isFinite(totalBytes) && totalBytes > 0 ? receivedBytes / totalBytes : 0;
        onProgress(8 + Math.min(24, ratio * 24));
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async function fetchSourceBytes(url, signal, onProgress) {
    let response;

    try {
      response = await fetch(url.href, {
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        signal
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw createAppError("source-cors");
    }

    if (!response.ok) {
      throw createAppError("source-response");
    }

    try {
      const finalUrl = new URL(response.url);
      if (isLocalOrPrivateHost(finalUrl.hostname)) {
        throw createAppError("source-response");
      }
    } catch (error) {
      if (error?.code === "source-response") {
        throw error;
      }
      throw createAppError("source-response");
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html") || contentType.includes("application/xhtml") || contentType.includes("application/json")) {
      throw createAppError("source-page");
    }

    try {
      return await readSourceBytes(response, signal, onProgress);
    } catch (error) {
      if (isAbortError(error) || error?.code === "source-too-large") {
        throw error;
      }
      throw createAppError("source-cors");
    }
  }

  async function sha256Hex(value) {
    if (!crypto.subtle) {
      throw createAppError("engine-integrity");
    }

    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function fetchVerifiedRemoteAsset(url, expectedHash, signal) {
    let response;

    try {
      response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        signal
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw createAppError("engine-remote");
    }

    if (!response.ok) {
      throw createAppError("engine-remote");
    }

    const bytes = await response.arrayBuffer();
    if ((await sha256Hex(bytes)) !== expectedHash) {
      throw createAppError("engine-integrity");
    }
    return bytes;
  }

  class BlobFfmpegEngine {
    constructor(worker, workerUrl) {
      this.worker = worker;
      this.workerUrl = workerUrl;
      this.loaded = false;
      this.nextId = 0;
      this.pending = new Map();
      this.progressHandlers = [];
      this.worker.onmessage = ({ data }) => {
        if (data.type === "PROGRESS") {
          this.progressHandlers.forEach((handler) => handler(data.data));
          return;
        }

        const request = this.pending.get(data.id);
        if (!request) {
          return;
        }
        this.pending.delete(data.id);
        request.cleanup();
        if (data.type === "ERROR") {
          request.reject(new Error(data.data));
        } else {
          request.resolve(data.data);
        }
      };
      this.worker.onerror = () => {
        this.rejectPending(new Error("blob-worker-error"));
      };
    }

    on(event, callback) {
      if (event === "progress") {
        this.progressHandlers.push(callback);
      }
    }

    send(type, data, transfer = [], signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }

        const id = this.nextId++;
        const abort = () => {
          this.pending.delete(id);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        const cleanup = () => signal?.removeEventListener("abort", abort);
        this.pending.set(id, { resolve, reject, cleanup });
        signal?.addEventListener("abort", abort, { once: true });

        try {
          this.worker.postMessage({ id, type, data }, transfer);
        } catch (error) {
          this.pending.delete(id);
          cleanup();
          reject(error);
        }
      });
    }

    load(wasmBinary, mainScriptUrlOrBlob, signal) {
      return this.send("LOAD", { wasmBinary, mainScriptUrlOrBlob }, [wasmBinary], signal).then(() => {
        this.loaded = true;
      });
    }

    writeFile(path, data, { signal } = {}) {
      return this.send("WRITE_FILE", { path, data }, [data.buffer], signal);
    }

    exec(args, timeout = -1, { signal } = {}) {
      return this.send("EXEC", { args, timeout }, [], signal);
    }

    readFile(path, encoding = "binary", { signal } = {}) {
      return this.send("READ_FILE", { path, encoding }, [], signal);
    }

    deleteFile(path, { signal } = {}) {
      return this.send("DELETE_FILE", { path }, [], signal);
    }

    rejectPending(error) {
      for (const request of this.pending.values()) {
        request.cleanup();
        request.reject(error);
      }
      this.pending.clear();
    }

    terminate() {
      this.rejectPending(new Error("blob-worker-terminated"));
      this.worker.terminate();
      URL.revokeObjectURL(this.workerUrl);
      this.loaded = false;
    }
  }

  async function createRemoteBlobEngine(wasmBuffer, coreText, signal, onProgress) {
    const coreSource = coreText.replace("var createFFmpegCore =", "self.createFFmpegCore =");
    if (coreSource === coreText) {
      throw createAppError("engine-integrity");
    }

    const workerUrl = URL.createObjectURL(new Blob([coreSource, BLOB_WORKER_RUNTIME], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);
    const engine = new BlobFfmpegEngine(worker, workerUrl);
    engine.on("progress", ({ progress }) => {
      if (Number.isFinite(progress)) {
        onProgress(35 + Math.max(0, Math.min(1, progress)) * 58, `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`);
      }
    });

    try {
      const bootstrapUrl = `${REMOTE_CORE_URL}#${btoa(JSON.stringify({ wasmURL: "", workerURL: "" }))}`;
      await engine.load(wasmBuffer, bootstrapUrl, signal);
      return engine;
    } catch (error) {
      engine.terminate();
      if (isAbortError(error)) {
        throw error;
      }
      throw createAppError("engine-remote");
    }
  }

  async function loadFfmpeg(signal, onProgress) {
    if (ffmpegInstance?.loaded) {
      return ffmpegInstance;
    }

    if (ffmpegLoadPromise) {
      return ffmpegLoadPromise;
    }

    ffmpegLoadPromise = (async () => {
      if (window.FFmpegWASM?.FFmpeg) {
        const instance = new window.FFmpegWASM.FFmpeg();
        instance.on("progress", ({ progress }) => {
          if (Number.isFinite(progress)) {
            onProgress(35 + Math.max(0, Math.min(1, progress)) * 58, `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`);
          }
        });
        ffmpegInstance = instance;

        try {
          await instance.load({ coreURL: FFMPEG_CORE_URL, wasmURL: FFMPEG_WASM_URL }, { signal });
          return instance;
        } catch (error) {
          instance.terminate();
          ffmpegInstance = null;
          if (isAbortError(error)) {
            throw error;
          }
        }
      }

      setProgress(8, "固定版コアを確認");
      const coreBuffer = await fetchVerifiedRemoteAsset(REMOTE_CORE_URL, REMOTE_CORE_SHA256, signal);
      const coreText = new TextDecoder().decode(coreBuffer);
      setProgress(14, "WASMを確認");
      const wasmBuffer = await fetchVerifiedRemoteAsset(REMOTE_WASM_URL, REMOTE_WASM_SHA256, signal);
      setProgress(30, "変換エンジンを起動");
      const remoteEngine = await createRemoteBlobEngine(wasmBuffer, coreText, signal, onProgress);
      ffmpegInstance = remoteEngine;
      return remoteEngine;
    })().catch((error) => {
      ffmpegInstance = null;
      ffmpegLoadPromise = null;
      if (isAbortError(error)) {
        throw error;
      }
      if (error?.code) {
        throw error;
      }
      throw createAppError("engine-load");
    });

    return ffmpegLoadPromise;
  }

  async function convertMp4ToMp3(validation) {
    conversionController = new AbortController();
    const { signal } = conversionController;
    let engine = null;

    setBusy(true);
    setStatus({
      state: "busy",
      kicker: "CONVERTING LOCALLY",
      title: "動画をブラウザ内へ読み込んでいます",
      message: "変換元をメモリへ読み込みます。入力URLは変換サーバーへ送信されません。",
      meta: "CORS対応の公開MP4直リンク · 上限256MiB",
      icon: "…",
      showProgress: true,
      showCancel: true
    });
    setProgress(3, "準備中");

    try {
      const sourceBytes = await fetchSourceBytes(validation.url, signal, (progress) => {
        setProgress(progress, `${Math.round(progress)}%`);
      });

      setStatus({
        state: "busy",
        kicker: "ENGINE READY",
        title: "音声トラックをMP3へ変換しています",
        message: "WebAssembly版FFmpegが端末上で処理しています。素材の長さによって数十秒かかることがあります。",
        meta: `${validation.fileName} · 初回のみ変換エンジン約32MBを読み込みます。`,
        icon: "…",
        showProgress: true,
        showCancel: true
      });
      setProgress(34, "エンジン準備");

      engine = await loadFfmpeg(signal, (progress, label) => {
        setProgress(progress, label);
      });
      await engine.writeFile("input.mp4", sourceBytes, { signal });
      setProgress(42, "変換中");
      await engine.exec(
        ["-i", "input.mp4", "-vn", "-map", "0:a:0", "-codec:a", "libmp3lame", "-q:a", "2", "output.mp3"],
        -1,
        { signal }
      );

      setProgress(96, "保存準備");
      const outputData = await engine.readFile("output.mp3", "binary", { signal });
      if (!(outputData instanceof Uint8Array) || outputData.byteLength === 0) {
        throw createAppError("empty-output");
      }

      triggerBlobDownload(outputData, validation.fileName);
      setProgress(100, "完了");
      setStatus({
        state: "success",
        kicker: "CONVERSION COMPLETE",
        title: "MP3を作成しました",
        message: "変換データはこのブラウザ内で作成し、ダウンロードフォルダへ保存を依頼しました。",
        meta: `${validation.fileName} · 外部の変換サーバーは使用していません。`,
        icon: "✓"
      });
    } catch (error) {
      if (isAbortError(error) || error?.code === "aborted") {
        setStatus({
          state: "warning",
          kicker: "CANCELLED",
          title: "変換を中止しました",
          message: "変換元のデータは保存せず、変換処理を停止しました。",
          meta: "必要なら、もう一度同じURLからやり直せます。",
          icon: "—"
        });
      } else {
        setStatus({
          state: "error",
          kicker: "CONVERSION FAILED",
          title: "MP3を作成できませんでした",
          message: conversionErrorMessage(error),
          meta: "入力URLは保存していません。",
          icon: "!"
        });
        setFallbackLink(validation.url, "変換元URLを開く ↗");
      }
    } finally {
      if (engine) {
        try {
          await engine.deleteFile("input.mp4");
        } catch {
          // Temporary files are inside the in-memory FFmpeg filesystem only.
        }
        try {
          await engine.deleteFile("output.mp3");
        } catch {
          // The output may not exist when conversion fails.
        }
      }
      conversionController = null;
      setBusy(false);
    }
  }

  function directDownload(validation) {
    const anchor = document.createElement("a");
    anchor.href = validation.url.href;
    anchor.download = validation.fileName;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.click();

    setStatus({
      state: "success",
      kicker: "REQUEST SENT",
      title: "ブラウザに保存を依頼しました",
      message: "配布元がダウンロードを許可していれば、保存が始まります。始まらない場合は下のリンクを開き、配布元の正規操作で保存してください。",
      meta: `${validation.fileName} · 入力URLを外部の変換サービスへ送信していません。`,
      icon: "✓"
    });
    setFallbackLink(validation.url);
  }

  async function submitDownload() {
    if (busy) {
      return;
    }

    const validation = validateUrl();

    if (validation.error) {
      showUrlError(validation.error);
      setStatus({
        state: "error",
        kicker: "CHECK REQUIRED",
        title: "入力内容を確認してください",
        message: validation.error,
        meta: "このページ内でURLだけを検証しました。",
        icon: "!"
      });
      urlInput.focus();
      return;
    }

    showUrlError("");

    if (validation.mode === "convert") {
      await convertMp4ToMp3(validation);
      return;
    }

    directDownload(validation);
  }

  urlInput.addEventListener("input", () => {
    showUrlError("");
    updatePreview();
    updateButtonState();
  });

  rightsCheckbox.addEventListener("change", updateButtonState);

  formatInputs.forEach((input) => {
    input.addEventListener("change", () => {
      updatePreview();
      showUrlError("");
    });
  });

  clearButton.addEventListener("click", () => {
    if (busy) {
      return;
    }
    urlInput.value = "";
    showUrlError("");
    updatePreview();
    updateButtonState();
    urlInput.focus();
  });

  cancelButton.addEventListener("click", () => {
    if (!busy || !conversionController) {
      return;
    }
    conversionController.abort();
    ffmpegInstance?.terminate();
    ffmpegInstance = null;
    ffmpegLoadPromise = null;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitDownload();
  });

  updatePreview();
  updateButtonState();
})();
