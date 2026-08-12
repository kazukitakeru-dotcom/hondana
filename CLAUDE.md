# 本棚 — 作業メモ

GitHub Pages 想定の**静的サイト（ビルド無し・バックエンド無し）**。
iPhone のホーム画面に追加して使う。classic script なので `import` は使わない。
買い物メモ／クエストリスト等と同じ構成（PWA + IndexedDB + Supabase同期）を踏襲している。

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | 画面のマークアップ（本棚グリッド・本の追加/編集モーダル・設定モーダル） |
| `styles.css` | スタイル一式。暖色系（茶・金）の紙・本棚らしい配色 |
| `app.js` | 画面とデータの本体 |
| `sync.js` | Supabase同期。外部ライブラリを使わず `fetch` で直接叩く |
| `supabase.sql` | 同期用テーブル定義。何度実行しても壊れない |

## データ（IndexedDB `hondana-db` v1）

- `books` … 本のレコード。`status` は `'unread' | 'reading' | 'done'`
  - `bookmarkPage` が「電子栞」＝今どこまで読んだか。`totalPages` と合わせて進捗％を出す
  - 読了ボタンを押すと `status='done'` にし、`totalPages` があれば `bookmarkPage` もそこに揃える
  - 読了を解除すると、`bookmarkPage` が残っていれば `'reading'`、無ければ `'unread'` に戻す
- `tombstones` / `_sync` … 同期用の内部ストア（`sync.js` 参照）

## 改修時の注意

- **`sw.js` の `CACHE_NAME` を必ずバンプする。** 上げないと古いキャッシュが配られる。
  新しいファイルは `FILES_TO_CACHE` 配列にも追加すること。
- **HTMLに値を埋めるときは必ず `escHtml()` を通す。** タイトルや著者に `"` `<` が入ると壊れる。
- 表紙画像は `readAndResizeImage()` で長辺640px・JPEG 0.85 に縮小してから `cover` に
  data URL のまま保存する。生の写真をそのまま入れると同期の送信量が跳ね上がる。
- 保存系の関数（`dbPut` / `dbDelete` / `dbClear`）は自動で `notifyLocalChange()` を呼ぶ。
  sync.js の `window.hondanaOnLocalChange` がそれを拾って同期を予約する。
- ローカル確認は `python -m http.server` → **localhost** で開く。file:// だと Service Worker が動かない。

## 同期（Supabase）

買い物メモ・クエストリスト・わんにゃんメモリー他と**同じプロジェクトに相乗り**している
（`https://kafaarlosuvqxxlxpvgg.supabase.co`）。publishable key は公開前提なのでソースに直書きでよい。
ログインは他アプリと共通（同一オリジンの localStorage を共有）。

- テーブル: `hondana_items`（`store` 列は今のところ `'books'` のみ。行単位の LWW ＋ 墓標）
- 表紙画像が乗る分ペイロードが大きくなりやすいので、送信は `PUSH_CHUNK=50` 件ずつに刻んでいる
- **新しいテーブルを足すときは毎回**「authenticated に grant ／ anon から revoke ／ RLS＋ポリシー」を
  明示的に書くこと（自動設定に頼らない構成にしてある）
- 無料枠の実質的な制約は容量ではなく**7日間無操作でプロジェクト一時停止**
  （判定はプロジェクト単位なので、相乗りしている別アプリが叩いていれば止まらない）

## 今後の拡張候補（未実装）

- 並び替え（タイトル順・追加順・進捗順）、手動ドラッグでの棚順変更
- ジャンル・タグ管理と絞り込み
- ISBN/バーコード読み取りでの自動タイトル入力
- 読書ログ（読了日の記録・年間読了数などの統計）
