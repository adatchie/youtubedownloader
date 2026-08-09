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

  const MAX_URL_LENGTH = 2048;
  const configuredApiBaseUrl = typeof window.MEDIA_API_BASE_URL === "string"
    ? window.MEDIA_API_BASE_URL.trim().replace(/\/+$/, "")
    : "";
  const YOUTUBE_HOSTS = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be"
  ]);
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;
  let busy = false;
  let requestController = null;
  let activeObjectUrl = null;

  function selectedFormat() {
    return formatInputs.find((input) => input.checked)?.value ?? "mp4";
  }

  function fileNameForFormat(format) {
    return format === "mp3" ? "audio.mp3" : "video.mp4";
  }

  function videoPageError(url) {
    if (window.location.protocol !== "http:" && window.location.protocol !== "https:") {
      return "このページはサーバーから開いてください。index.htmlの直接起動には対応していません。";
    }

    if (!urlInput.value.trim()) {
      return "動画ページURLを入力してください。";
    }

    if (urlInput.value.trim().length > MAX_URL_LENGTH) {
      return `URLは${MAX_URL_LENGTH.toLocaleString("ja-JP")}文字以内で入力してください。`;
    }

    if (url.protocol !== "https:") {
      return "安全のためHTTPSの動画ページURLだけ使用できます。";
    }

    if (url.username || url.password || (url.port && url.port !== "443")) {
      return "ログイン情報や特殊なポートを含むURLは使用できません。";
    }

    const query = new URLSearchParams(url.search);
    if (["list", "playlist", "index"].some((key) => query.has(key))) {
      return "Playlistではなく、1本の動画ページURLを指定してください。";
    }

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!YOUTUBE_HOSTS.has(hostname)) {
      return "現在はYouTube / youtu.beの動画ページURLだけ対応しています。";
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    let videoId = "";
    if (hostname === "youtu.be" || hostname === "www.youtu.be") {
      videoId = pathParts.length === 1 ? pathParts[0] : "";
    } else if (url.pathname.replace(/\/$/, "") === "/watch") {
      videoId = query.get("v") ?? "";
      const allVideoIds = query.getAll("v");
      if (allVideoIds.length !== 1) {
        videoId = "";
      }
    } else if (pathParts.length === 2 && ["shorts", "embed", "live"].includes(pathParts[0])) {
      videoId = pathParts[1];
    }

    if (!VIDEO_ID_PATTERN.test(videoId)) {
      return "YouTubeの動画ページURLを指定してください。Playlist・チャンネル・検索URLは対応していません。";
    }

    return "";
  }

  function validateUrl() {
    const rawValue = urlInput.value.trim();
    if (!rawValue) {
      return { error: "動画ページURLを入力してください。" };
    }

    if (rawValue.length > MAX_URL_LENGTH) {
      return { error: `URLは${MAX_URL_LENGTH.toLocaleString("ja-JP")}文字以内で入力してください。` };
    }

    let url;
    try {
      url = new URL(rawValue);
    } catch {
      return { error: "動画ページURLの形式を確認してください。例: https://www.youtube.com/watch?v=..." };
    }

    const error = videoPageError(url);
    if (error) {
      return { error };
    }

    return { url: url.href, format: selectedFormat() };
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
    downloadButton.querySelector("span").textContent = nextBusy ? "サーバーで処理中…" : "ダウンロードする";
    updateButtonState();
  }

  function showUrlError(message) {
    urlInputWrap.classList.toggle("has-error", Boolean(message));
    urlError.hidden = !message;
    urlError.textContent = message || "";
  }

  function updatePreview() {
    fileNamePreview.textContent = fileNameForFormat(selectedFormat());
  }

  function setStatus({ state, kicker, title, message, meta, icon }) {
    statusPanel.hidden = false;
    statusPanel.dataset.state = state;
    statusKicker.textContent = kicker;
    statusTitle.textContent = title;
    statusMessage.textContent = message;
    statusMeta.textContent = meta || "";
    statusIcon.textContent = icon;
  }

  function revokeActiveObjectUrl() {
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
  }

  function triggerBlobDownload(blob, fileName) {
    revokeActiveObjectUrl();
    activeObjectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = activeObjectUrl;
    anchor.download = fileName;
    anchor.rel = "noopener noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(revokeActiveObjectUrl, 60_000);
  }

  async function readServerError(response) {
    try {
      const payload = await response.json();
      const message = payload?.detail?.message;
      if (typeof message === "string" && message.length <= 300) {
        return message;
      }
    } catch {
      // Use the generic message below when the server response is not JSON.
    }
    return "サーバーで動画を処理できませんでした。公開状態とURLを確認してください。";
  }

  async function downloadFromServer(validation) {
    requestController = new AbortController();
    setBusy(true);
    setStatus({
      state: "busy",
      kicker: "SERVER PROCESSING",
      title: "動画を取得・変換しています",
      message: "サーバー側でYouTubeから動画を取得し、選択した形式に変換しています。完了まで画面を閉じないでください。",
      meta: "公開動画のみ · Playlist・ログイン必須・DRM動画は非対応",
      icon: "…"
    });

    try {
      const response = await fetch(`${configuredApiBaseUrl}/api/download`, {
        method: "POST",
        headers: {
          Accept: "application/octet-stream, application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: validation.url,
          format: validation.format,
          rights_confirmed: rightsCheckbox.checked
        }),
        signal: requestController.signal
      });

      if (!response.ok) {
        throw new Error(await readServerError(response));
      }

      const blob = await response.blob();
      if (blob.size === 0) {
        throw new Error("サーバーから空のファイルが返されました。もう一度試してください。");
      }

      triggerBlobDownload(blob, fileNameForFormat(validation.format));
      setStatus({
        state: "success",
        kicker: "DOWNLOAD COMPLETE",
        title: `${validation.format.toUpperCase()}を作成しました`,
        message: "サーバーで作成したファイルを、ブラウザのダウンロードフォルダへ保存しました。",
        meta: "入力URLと変換途中のファイルは処理後に保存しません。",
        icon: "✓"
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        setStatus({
          state: "warning",
          kicker: "CANCELLED",
          title: "通信を中止しました",
          message: "ブラウザへのファイル受信を中止しました。サーバー側の処理が完了する場合があります。",
          meta: "必要なら、時間を置いてもう一度試してください。",
          icon: "—"
        });
      } else {
        setStatus({
          state: "error",
          kicker: "DOWNLOAD FAILED",
          title: "ダウンロードできませんでした",
          message: error?.message || "サーバーで動画を処理できませんでした。",
          meta: "ログイン情報や動画URLは保存していません。",
          icon: "!"
        });
      }
    } finally {
      requestController = null;
      setBusy(false);
    }
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
        meta: "YouTube / youtu.beの公開動画ページURLを指定してください。",
        icon: "!"
      });
      urlInput.focus();
      return;
    }

    showUrlError("");
    await downloadFromServer(validation);
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

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitDownload();
  });

  updatePreview();
  updateButtonState();
})();
