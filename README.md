# 本棚

読んだ本・読んでいる本を、表紙つきで管理する本棚アプリ（PWA）。
公開先は https://kazukitakeru-dotcom.github.io/hondana/

## できること

- **表紙画像** — 本ごとに表紙を撮影・選択して登録。棚がひと目でわかる
- **読了チェック** — カード上の ✓ ボタンでワンタップ、未読／読書中／読了を管理
- **お気に入り** — カード上の ★ ボタンでワンタップ登録、フィルタで絞り込み
- **電子栞** — 「今のページ／総ページ数」を記録して読書の進み具合をカードに表示
- **評価・メモ** — 5段階評価と感想メモ
- **検索・絞り込み** — タイトル／著者で検索、状態・お気に入りでフィルタ
- **複数端末同期** — Supabase 経由でログインした端末どうしを同期
- **バックアップ／復元** — JSON での書き出し・取り込み

## 構成

| ファイル | 中身 |
|---|---|
| `index.html` / `styles.css` | 画面 |
| `app.js` | 全ロジック（DB・描画・表紙画像の縮小・バックアップ） |
| `sync.js` | 複数端末同期（Supabase） |
| `sw.js` / `manifest.json` / `icon.png` / `icons/` | PWA |
| `supabase.sql` | Supabase のテーブル定義。ダッシュボードの SQL Editor に貼って実行する |

## データ

IndexedDB `hondana-db`（**v1**）。`keyPath: 'id'`。

- `books` … 本1冊ごとに1レコード
  `{ id, title, author, cover(表紙のdata URL), status('unread'|'reading'|'done'),
     favorite, bookmarkPage(今のページ), totalPages(総ページ数), rating(0-5), memo, createdAt }`

同期のための内部ストア（バックアップの書き出し・復元の対象外）：

- `tombstones` … 消した本の墓標
- `_sync` … 取り込み前の控え（表紙画像込みで大きくなるので IndexedDB 側に置く）

## セットアップ

1. GitHub Pages で公開、またはローカルで `python -m http.server` → localhost で開く
   （file:// だと Service Worker が動かない）
2. 複数端末で同期したい場合だけ、`supabase.sql` を Supabase ダッシュボードの
   SQL Editor で実行してテーブルを作る
3. 設定 → 複数端末で同期 から、他アプリ（買い物メモ／クエストリスト等）と
   同じアカウントでログインすれば同期が始まる。ログインしなければ端末内だけで動く

## 改修時の注意

- **ファイルを更新したら `sw.js` の `CACHE_NAME` を必ず上げる。**
  上げないと古いキャッシュが配られて変更が届かない。新しいファイルは `FILES_TO_CACHE` にも足す。
- 表紙は選択時に長辺640px・JPEG品質0.85まで自動縮小してから保存している
  （`app.js` の `readAndResizeImage`）。同期の送信量を抑えるため。
- 消すときは `dbDelete` / `dbClear` を通す。墓標を自動で残す。
