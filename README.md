# まっすぐ保存

権利フリー・利用許諾済みのYouTube動画ページURLを、サーバー側でMP4またはMP3として取得するWebツールです。画面はFastAPIが配信し、yt-dlpとFFmpegがサーバー内で処理します。

## 対応範囲

- 対応URL: `youtube.com` / `youtu.be` の1本の公開動画ページ
- 対応形式: MP4、MP3
- 非対応: Playlist、チャンネル、検索URL、ログイン必須動画、DRM動画、ライブ配信の特殊形式
- 上限: 1リクエスト256MiB、同時処理2件、処理時間5分

動画ページURLだけでは著作権やライセンスを判定できません。著作権フリー、パブリックドメイン、または利用許諾を得た素材だけに使ってください。

## 動かし方

`index.html` を直接開く方式ではありません。FastAPIサーバーから開いてください。

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

ブラウザで <http://127.0.0.1:8000/> を開きます。FFmpegがPATHに必要です。

## Docker / Render

ルートの `Dockerfile` と `render.yaml` はRender Web Service用です。Render DashboardでこのGitHubリポジトリを選び、BlueprintまたはDocker Web Serviceとして作成してください。Renderが`PORT`を渡し、`/healthz`をヘルスチェックします。

```powershell
docker build -t youtubedownloader .
docker run --rm -p 10000:10000 -e PORT=10000 youtubedownloader
```

アプリケーションは動画URLをDBや作業ログへ保存しません。取得・変換中だけ一時ディレクトリを使い、レスポンス後に削除します。Renderなどホスティング基盤のアクセスログは別途そのサービスの設定に従います。

## 使い方

1. YouTubeの公開動画ページURLを入力する
2. MP4またはMP3を選ぶ
3. 利用権限の確認にチェックを入れて「ダウンロードする」を押す

## できること / できないこと

- できること: YouTube / youtu.beの公開動画ページから、サーバー側でMP4またはMP3を作成する
- できないこと: ログイン制限・DRM・Playlist・チャンネル・検索URLの回避や処理
- できないこと: 任意ホストのURLをサーバーから取得すること

## 同梱ライセンス

サーバー側依存関係のライセンスは [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を確認してください。
