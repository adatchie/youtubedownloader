# Third-party notices

このフォルダに同梱しているFFmpeg WebAssembly実行ファイルについての記録です。

## @ffmpeg/ffmpeg 0.12.15

- License: MIT
- Upstream: https://github.com/ffmpegwasm/ffmpeg.wasm
- Files: `vendor/ffmpeg/ffmpeg.js`, `vendor/ffmpeg/814.ffmpeg.js`

## @ffmpeg/core 0.12.10

- License: GPL-2.0-or-later
- Upstream: https://github.com/ffmpegwasm/ffmpeg.wasm
- Files: `vendor/ffmpeg/ffmpeg-core.js`, `vendor/ffmpeg/ffmpeg-core.wasm`

`@ffmpeg/core` はGPL-2.0-or-laterの条件で配布されます。再配布・公開する場合は、GPLの条件、対応するソースコードの提供義務、著作権表示を確認してください。公式ライセンス本文は [GNU GPL version 2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) で確認できます。

このプロジェクトでは、FFmpegの実行ファイルをブラウザ内の変換にだけ使用し、変換元のメディアを外部へ送信しません。

## file:// fallback fetch

通常のHTTP(S)ページでは同梱ファイルを使います。`index.html` を `file://` で直接開いたときだけ、ブラウザのWorker制約を避けるため、次の固定URLからコアを取得します。

- Core JS: `https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js`
- Core WASM: `https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm`
- SHA-256 (Core JS): `b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21`
- SHA-256 (Core WASM): `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7`

ハッシュが一致しない場合は安全のため変換を実行しません。
