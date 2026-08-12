-- ============================================================================
-- 本棚 — Supabase テーブル定義
-- 買い物メモ／クエストリスト／わんにゃんメモリー他と同じプロジェクトに相乗りするため、
-- 「authenticated に grant / anon から revoke / RLS＋ポリシー」を毎回明示する。
-- Supabase ダッシュボード → SQL Editor に貼って実行する。
-- 何度実行しても壊れないように書いてある。
--
-- ※ SQL Editor は必ずタブの「＋」で新しいクエリを作ってから貼ること
--   （既存の「無題のクエリ」を上書きしてしまわないように）。
-- ============================================================================

-- ── 0) updated_at をサーバー時刻で入れるための共通トリガ関数 ──
-- 端末の時計で updated_at を入れると、時計がずれた端末の行が
-- 「前回より新しい行だけ取る」差分同期の網から永久に漏れる。
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── 1) 本棚の本 ──
-- 「IDを持つレコードの集合」なので、store 列で区別する形にしておく
-- （今は 'books' だけだが、他アプリと同じ形にしておくと後で増やしやすい）。
create table if not exists public.hondana_items (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  store      text        not null,               -- 'books'
  id         text        not null,               -- アプリが作るID
  data       jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, store, id)
);

create index if not exists hondana_items_user_updated_idx
  on public.hondana_items (user_id, updated_at asc);

drop trigger if exists hondana_items_touch on public.hondana_items;
create trigger hondana_items_touch before insert or update on public.hondana_items
  for each row execute function public.set_updated_at();

-- ── RLS ──
alter table public.hondana_items enable row level security;

drop policy if exists hondana_items_own on public.hondana_items;

create policy hondana_items_own on public.hondana_items
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 権限（anon は完全に締め出す。自動設定に頼らず明示する） ──
revoke all on public.hondana_items from anon;

grant select, insert, update, delete on public.hondana_items to authenticated;

-- ── 確認用（anon で叩くと permission denied になるのが正しい） ──
-- select * from public.hondana_items limit 1;
