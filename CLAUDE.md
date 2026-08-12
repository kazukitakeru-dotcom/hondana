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
  - 読了ボタンはワンタップで確定してしまうため、`showUndoToast()` で数秒だけ取り消せるようにしてある
    （誤タップ対策。お気に入り★は取り消し不要な軽い操作なのでそのまま即トグル）
  - `tags` … カンマ区切り入力をパースした string[]。タグの管理画面は無く、全本の `tags` から
    `renderTagFilter()` が動的にタグ一覧を作る（正規化された「タグ管理」ではなく素朴な実装）
  - `order` … 「手動（棚順）」用。初めて手動モードに入ったときだけ `backfillOrder()` で
    既存の本に連番を振る。以後は移動のたびに表示中の並びへ連番を振り直す
- `tombstones` / `_sync` … 同期用の内部ストア（`sync.js` 参照）

## 本棚UI（棚板レイアウト）

`renderBooks()` は本を3冊ずつ `.shelf-row` にまとめ、その直後に `.shelf-plank`（木の棚板、CSSのみ）を
挟んで出力している。列数は `SHELF_COLS = 3` で固定（`#app` の `max-width:480px` に対して調整した値）。
レスポンシブな `auto-fill` グリッドにしていないのは、棚板を挟む都合上、列数を固定して
「何冊ごとに区切るか」をJS側で把握する必要があるため。

## 並び替え

`sortSelect` の値がそのまま `sortMode`（'added' | 'title' | 'progress' | 'manual'）になる。
`'manual'` を選んだ瞬間が「並び替えモード」で、他の絞り込み（状態フィルタ・タグ・検索）は
強制的に解除し、カード上のボタンも ★/✓ から ◀▶（前後に1つ移動）に差し替える。
筋を通すため、`'manual'` の間はフィルタ行に `disabled-row` を付けて触れなくしている。
「完了」（`sortDoneBtn`）を押すと `sortMode` を `'added'` に戻すだけで、`order` 自体はそのまま残る
（次に手動モードへ入ればまたその並びから続きを直せる）。

## ISBN / バーコード

- 手入力：`handleIsbnLookup()` が openBD（`https://api.openbd.jp/v1/get?isbn=...`、キー不要・CORS対応）
  を叩いてタイトル・著者・表紙を埋める。著者は `姓,名,生年-没年` のような生データなので
  `cleanAuthorName()` で生没年と「著/訳/編/監修」の断片を落としている
- カメラ読み取り：ブラウザ標準の `BarcodeDetector`（Shape Detection API）のみを使う。外部ライブラリは無し。
  **iOS Safari は未対応**なので `isBarcodeSupported()` で判定し、非対応なら `scanIsbnBtn` 自体を隠す
  （手入力＋取得ボタンは常にどの端末でも使える）
- 表紙は openBD が返す画像URLをそのまま `cover` に保存する（`readAndResizeImage` を通さない）。
  data URL 化するとCORSでcanvasが汚染されて失敗しうるため。オフライン時は表紙が読み込めないが、
  手動で表紙をアップロードし直せばいつでも縮小済みの自前画像に置き換えられる

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

## あえてやっていないこと

- 読書ログ（読了日ごとの記録・年間集計など）は作っていない。「総読了数だけでいい」という方針で、
  `updateShelfStats()` が `books` から都度数えて出すだけ。専用のログストアは無い
- タグの管理画面（作成・削除・リネームのUI）は無い。本の `tags` から動的に集合を作っているだけなので、
  全部の本からあるタグを消せばフィルタからも自然に消える
- 棚順のドラッグ&ドロップは無い（タッチ環境での実装コストに対して効果が薄いため）。
  ◀▶ボタンでの1つずつの移動にしてある
