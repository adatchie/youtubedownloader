# Third-party notices

このアプリはサーバー側で次のオープンソースソフトウェアを使用します。

## yt-dlp 2026.7.4

- License: Unlicense
- Upstream: https://github.com/yt-dlp/yt-dlp
- Use: YouTube動画ページの情報取得・ダウンロード

## FastAPI 0.141.1 / Uvicorn 0.52.1

- FastAPI: MIT License
- Uvicorn: BSD 3-Clause License
- Upstream: https://github.com/fastapi/fastapi / https://github.com/encode/uvicorn
- Use: HTTP APIと静的画面の配信

## FFmpeg

Dockerイメージ内で、ベースOSのパッケージマネージャーからFFmpegをインストールします。FFmpegはビルド構成によりライセンスが変わるため、配布・運用時はDockerイメージのパッケージ情報とFFmpegのライセンス表示を確認してください。

このプロジェクトは、動画ページURLを処理するためにサーバーへ送信します。動画の取得・変換中だけ一時ファイルを作成し、レスポンス後に削除します。
