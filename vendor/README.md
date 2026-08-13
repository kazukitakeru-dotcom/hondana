# vendor/ — 外部ライブラリ

**このフォルダの中身は自分で書いたコードではない。** 他のアプリ（買い物メモ・クエストリスト等）は
外部ライブラリを一切使わない方針だが、本棚だけは例外的に1つ入れている。

## zxing.min.js

| | |
|---|---|
| 名前 | [@zxing/library](https://github.com/zxing-js/library) |
| バージョン | 0.23.0 |
| 取得元 | `https://unpkg.com/@zxing/library@0.23.0/umd/index.min.js`（npm公式CDN） |
| サイズ | 362,150 バイト（約354KB） |
| ライセンス | Apache-2.0（`zxing-LICENSE.txt`） |
| グローバル | `window.ZXing` |

### なぜ入れたか

iPhone（Safari / iOS）はブラウザ標準の `BarcodeDetector` に対応していないため、
このライブラリが無いと iPhone でバーコードを読めず、ISBN 13桁の手打ちしかできなかった。

`BarcodeDetector` が使える端末（Android・PCのChrome等）では**そちらを優先**し、
このライブラリは対応していない端末でだけ読み込む（`app.js` の `ensureZXing()`）。

### 注意

- **CDNから読み込まずファイルを同梱している。** オフラインで完結させるため、
  また「入れた時点のコードで固定する」ため。CDN参照にしないこと。
- 更新するときは上記URLのバージョン部分を変えて取り直し、この表も直すこと。
  npm / ビルドツールは使わない（ビルド不要を維持するため）。
- `sw.js` の `FILES_TO_CACHE` にも入っている。差し替えたら `CACHE_NAME` をバンプすること。
