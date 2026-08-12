'use strict';

/* ==========================================================================
   本棚 — 複数端末同期（Supabase）

   「IDを持つレコードの集合」なので、行単位の last-write-wins ＋ 墓標。
   本棚は「消したら消えたまま」であってほしいアプリなので、墓標が一番大事。
   墓標が無いと、まだ持っている端末から消した本が押し戻されて復活する。
   app.js の dbDelete / dbClear が自動で墓標を残す。

   買い物メモ／クエストリスト他と同じ Supabase プロジェクトに相乗りしている。
   外部ライブラリは使わない（PWAをオフラインで完結させるため fetch で直接叩く）。
   ========================================================================== */

const SB_URL = 'https://kafaarlosuvqxxlxpvgg.supabase.co';
const SB_KEY = 'sb_publishable_nSwOQo-YbEtDN_KTjBf80w_D6o0iLoA';

// ログイン状態は他アプリと共通。同じオリジンなので localStorage を共有できる。
const SESSION_KEY    = 'sb_session_v1';
const SYNC_STATE_KEY = 'hondana_sync_state_v1';
const ROLLBACK_KEY   = 'hondana_rollback_v1';

// サーバー時刻でも「commit の順番」と now() は完全には一致しないので、
// 前回取得位置を少しだけ巻き戻して取りこぼしを防ぐ。重複して取っても害はない。
const PULL_MARGIN_MS = 5000;
const PAGE_SIZE = 1000; // PostgREST の1回あたり上限に合わせる

// 表紙画像が入るので1回の送信量が大きくなりやすい。少なめに刻む。
const PUSH_CHUNK = 50;

// 墓標として送った項目の目印
const DELETED_SIG = 'X';

// ========== セッション ==========
function sbLoadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch (e) { return null; }
}
function sbSaveSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
function sbIsLoggedIn() { return !!(sbLoadSession() || {}).refresh_token; }

function _storeSession(json) {
  if (!json || !json.access_token) return null;
  const prev = sbLoadSession() || {};
  const s = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
    user_id: (json.user && json.user.id) || prev.user_id || null,
    email: (json.user && json.user.email) || prev.email || null,
  };
  sbSaveSession(s);
  return s;
}

async function _authFetch(path, body) {
  const res = await fetch(`${SB_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.msg || json.message || `HTTP ${res.status}`);
  }
  return json;
}

async function sbSignUp(email, password) {
  const json = await _authFetch('signup', { email, password });
  if (!json.access_token) return { needsConfirmation: true }; // メール確認が有効な場合
  _storeSession(json);
  return { needsConfirmation: false };
}

async function sbSignIn(email, password) {
  _storeSession(await _authFetch('token?grant_type=password', { email, password }));
}

function sbSignOut() {
  sbSaveSession(null);
  _saveSyncState(null);
}

// 有効なアクセストークンを返す（期限が近ければ更新する）
async function sbAccessToken() {
  const s = sbLoadSession();
  if (!s || !s.refresh_token) return null;
  if (s.access_token && Date.now() < s.expires_at - 60000) return s.access_token;
  try {
    const json = await _authFetch('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
    return _storeSession(json).access_token;
  } catch (e) {
    if (/invalid|expired|not found/i.test(e.message)) sbSaveSession(null);
    throw e;
  }
}

// ========== データAPI ==========
async function _rest(path, { method = 'GET', body = null, prefer = null } = {}) {
  const token = await sbAccessToken();
  if (!token) throw new Error('ログインしていません');
  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status} ${t.slice(0, 200)}`);
  }
  if (method === 'GET') return res.json().catch(() => []);
  return null;
}

// 1回のGETには件数上限があるので、全部取れるまでページを送る。
async function _restAll(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await _rest(`${path}&limit=${PAGE_SIZE}&offset=${offset}`);
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
  }
}

async function _restUpsert(path, rows) {
  for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
    await _rest(path, {
      method: 'POST',
      body: rows.slice(i, i + PUSH_CHUNK),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }
}

// ========== 変更検出 ==========
function _hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 + c) * 31 + (h2 << 3)) >>> 0;
  }
  return h1.toString(36) + '-' + h2.toString(36) + '-' + str.length.toString(36);
}

// Postgres の jsonb はキーの並び順を保たない。
// 素の JSON.stringify で比べると、中身が同じでも「変わった」と誤判定して
// 送り直しが起き続けるので、キーを並べ替えてから文字列にする。
function _stable(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_stable).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .map(k => JSON.stringify(k) + ':' + _stable(v[k])).join(',') + '}';
}
function _sig(v) { return _hash(_stable(v)); }

function _key(store, id) { return `${store}:${id}`; }

function _emptySyncState() {
  return {
    initialized: false,
    lastPulledAt: null,
    // 'store:id' -> サーバーと一致していると分かっている内容のハッシュ（削除なら 'X'）
    items: {},
    lastSyncedAt: null,
  };
}
function _loadSyncState() {
  try {
    const s = JSON.parse(localStorage.getItem(SYNC_STATE_KEY) || 'null');
    return (s && typeof s === 'object') ? Object.assign(_emptySyncState(), s) : _emptySyncState();
  } catch (e) { return _emptySyncState(); }
}
function _saveSyncState(s) {
  if (s) localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(s));
  else localStorage.removeItem(SYNC_STATE_KEY);
}

// ========== 取り込み前の巻き戻し用スナップショット ==========
// クラウドの内容を反映する直前に、この端末のデータを丸ごと控えておく。
// 表紙画像込みだと localStorage に収まらないことがあるので、IndexedDB に置く。
async function saveRollback(reason) {
  try {
    const snap = { id: 'rollback', at: Date.now(), reason, stores: {} };
    let total = 0;
    for (const s of DATA_STORES) {
      snap.stores[s] = await dbAll(s);
      total += snap.stores[s].length;
    }
    if (!total) return; // 空を控えても意味がない
    await dbRawPut(SYNC_STORE, { id: ROLLBACK_KEY, snapshot: snap });
  } catch (e) { /* 保険が取れなくても本処理は止めない */ }
}

async function loadRollback() {
  try {
    const row = await dbGet(SYNC_STORE, ROLLBACK_KEY);
    return (row && row.snapshot) || null;
  } catch (e) { return null; }
}

async function restoreRollback() {
  const snap = await loadRollback();
  if (!snap) { alert('戻せる控えがありません。'); return; }
  const when = new Date(snap.at).toLocaleString('ja-JP');
  const n = (snap.stores.books || []).length;
  if (!confirm(`${when} 時点の内容（本 ${n}件）に戻します。\n今この端末にあるデータは置き換わります。よろしいですか？`)) return;

  for (const s of DATA_STORES) {
    for (const item of await dbAll(s)) await dbRawDelete(s, item.id);
    for (const item of snap.stores[s] || []) await dbRawPut(s, item);
  }
  // 送信済みの目印を消して、戻した内容を改めてクラウドへ反映させる
  _saveSyncState(null);
  alert('戻しました。再読み込みします。');
  location.reload();
}

// ========== 同期本体 ==========
let _syncing = false;
let _syncTimer = null;
let _lastSyncError = null;

function scheduleSync(delay = 2500) {
  if (!sbIsLoggedIn()) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

// app.js の dbPut / dbDelete / dbClear から呼ばれる
window.hondanaOnLocalChange = function () { scheduleSync(); };

// app.js の初期化が終わったら呼ばれる
window.hondanaOnReady = function () {
  updateSyncUI();
  scheduleSync(1200);
};

// この端末で初めて同期するときだけ、合流するか置き換えるかを決める。
async function firstSyncSetup(sync) {
  if (sync.initialized) return;

  const n = (await dbAll(STORES.books)).length;
  if (n > 0) {
    await saveRollback('初回同期の前');
    const merge = confirm(
      `この端末には ${n}件 の本があります。\n\n` +
      `［OK］この端末の内容もクラウドに合流させる\n` +
      `［キャンセル］クラウドの内容だけを取り込む\n\n` +
      `どちらを選んでも、今の内容は控えに保存され、あとから戻せます。`
    );
    if (!merge) {
      for (const s of DATA_STORES) {
        for (const item of await dbAll(s)) await dbRawDelete(s, item.id);
      }
      // 置き換えを選んだので、消した記録（墓標）も引き継がない
      for (const t of await dbAll(TOMB_STORE)) await dbRawDelete(TOMB_STORE, t.id);
    }
  }
  sync.initialized = true;
  _saveSyncState(sync);
}

// app.js が IndexedDB を開き終わるのを待つ
async function _waitForDb() {
  for (let i = 0; i < 100 && !db; i++) await new Promise(r => setTimeout(r, 100));
  if (!db) throw new Error('データベースを開けていません');
}

async function syncNow(opts = {}) {
  if (_syncing) return;
  if (!sbIsLoggedIn()) return;
  if (!navigator.onLine) { _lastSyncError = 'オフライン'; updateSyncUI(); return; }

  _syncing = true;
  updateSyncUI();
  try {
    await _waitForDb();
    const sync = _loadSyncState();
    await firstSyncSetup(sync);
    await _pull(sync);
    await _push(sync);
    sync.lastSyncedAt = Date.now();
    _saveSyncState(sync);
    _lastSyncError = null;
    if (opts.toast) showToast('同期しました');
  } catch (e) {
    _lastSyncError = e.message || String(e);
    if (opts.toast) alert('同期に失敗しました：' + _lastSyncError);
  } finally {
    _syncing = false;
    updateSyncUI();
  }
}

// この端末での「今の姿」。サーバーと一致しているかの判定に使う。
// 消してある場合は 'X'、そもそも無い場合は null。
async function _localSig(store, id) {
  const item = await dbGet(store, id);
  if (item) return _sig(item);
  const tomb = await dbGet(TOMB_STORE, tombKey(store, id));
  return tomb ? DELETED_SIG : null;
}

// ---- 取得 ----
async function _pull(sync) {
  // 手元が空なのに同期の記録だけ残っている＝ブラウザに保存領域を回収されたなど、
  // 消えるはずのない消え方をした状態。差分だけ取っても戻らないので全件取り直す。
  if (sync.lastPulledAt && Object.keys(sync.items).length) {
    let n = 0;
    for (const s of DATA_STORES) n += await dbCount(s);
    if (n === 0) sync.lastPulledAt = null;
  }
  const since = sync.lastPulledAt ? `&updated_at=gt.${encodeURIComponent(sync.lastPulledAt)}` : '';
  const rows = await _restAll(
    `hondana_items?select=store,id,data,deleted,updated_at&order=updated_at.asc,id.asc${since}`
  );
  if (!rows.length) return;

  // これから端末のデータを書き換えるので、直前の状態を控えておく
  await saveRollback('取り込み前');

  let newest = null;
  const bump = ts => { if (ts && (!newest || ts > newest)) newest = ts; };

  for (const row of rows) {
    bump(row.updated_at);
    if (!DATA_STORES.includes(row.store)) continue;
    const k = _key(row.store, row.id);

    // この端末にまだ送っていない変更があるなら、そちらを残す。
    // 送信側でサーバーに反映されるので、結局は新しい方に揃う。
    // ただし sig が null（手元に無く、墓標も無い）ときは「消したから無い」のではなく
    // 「理由なく消えている」状態なので、ローカル変更とは見なさずサーバーの内容を取り戻す。
    const sig = await _localSig(row.store, row.id);
    if (sig !== null && sync.items[k] !== undefined && sync.items[k] !== sig) continue;

    if (row.deleted) {
      await dbRawDelete(row.store, row.id);
      // 手元にも墓標を残す。残さないと次回こちらから押し戻してしまう。
      await dbRawPut(TOMB_STORE, {
        id: k, store: row.store, itemId: row.id,
        at: Date.parse(row.updated_at) || Date.now(),
      });
      sync.items[k] = DELETED_SIG;
    } else {
      await dbRawPut(row.store, row.data);
      await dbRawDelete(TOMB_STORE, k);
      sync.items[k] = _sig(row.data);
    }
  }

  if (newest) {
    sync.lastPulledAt = new Date(Date.parse(newest) - PULL_MARGIN_MS).toISOString();
  }

  await loadAll();
  try { renderBooks(); } catch (e) {}
}

// ---- 送信 ----
async function _push(sync) {
  const userId = (sbLoadSession() || {}).user_id;
  if (!userId) throw new Error('ユーザーIDが取れません');

  const rows = [];

  // --- 手元にある項目のうち、サーバーと違うもの ---
  for (const store of DATA_STORES) {
    for (const item of await dbAll(store)) {
      const k = _key(store, item.id);
      const sig = _sig(item);
      if (sync.items[k] === sig) continue;
      rows.push({ user_id: userId, store, id: item.id, data: item, deleted: false });
    }
  }

  // --- 消した項目（墓標をまだ送っていないもの） ---
  for (const t of await dbAll(TOMB_STORE)) {
    if (!DATA_STORES.includes(t.store)) continue;
    if (sync.items[t.id] === DELETED_SIG) continue;
    rows.push({ user_id: userId, store: t.store, id: t.itemId, data: {}, deleted: true });
  }

  if (rows.length) {
    await _restUpsert('hondana_items?on_conflict=user_id,store,id', rows);
    for (const r of rows) {
      sync.items[_key(r.store, r.id)] = r.deleted ? DELETED_SIG : _sig(r.data);
    }
  }
}

// ========== 同期のきっかけ ==========
window.addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync(300);
});

// ========== 画面 ==========
const $h = id => document.getElementById(id);

async function updateSyncUI() {
  const box = $h('sync-status');
  if (!box) return;
  const s = sbLoadSession();

  $h('sync-login-form').classList.toggle('hidden', !!s);
  $h('sync-logged-in').classList.toggle('hidden', !s);

  const snap = db ? await loadRollback() : null;
  const rb = $h('sync-rollback-btn');
  if (rb) {
    rb.classList.toggle('hidden', !snap);
    if (snap) rb.textContent = `取り込み前（本 ${(snap.stores.books || []).length}件）に戻す`;
  }

  box.className = 'sync-status';
  if (!s) { box.textContent = 'ログインしていません（この端末だけに保存されます）'; return; }
  if (_syncing) { box.textContent = '同期中…'; return; }
  if (_lastSyncError) {
    box.textContent = `${s.email}／同期できていません（${_lastSyncError}）`;
    box.className = 'sync-status error';
    return;
  }
  const t = _loadSyncState().lastSyncedAt;
  box.textContent = `${s.email}／最終同期 ${t ? new Date(t).toLocaleString('ja-JP') : 'まだ'}`;
  box.className = 'sync-status ok';
}

async function submitSyncLogin(mode) {
  const email = $h('sync-email').value.trim();
  const password = $h('sync-password').value;
  const msg = $h('sync-login-msg');
  if (!email || !password) { msg.textContent = 'メールアドレスとパスワードを入力してください'; return; }
  if (mode === 'signup' && password.length < 8) {
    msg.textContent = 'パスワードは8文字以上にしてください'; return;
  }
  msg.textContent = mode === 'signup' ? '登録中…' : 'ログイン中…';
  try {
    if (mode === 'signup') {
      const r = await sbSignUp(email, password);
      if (r.needsConfirmation) {
        msg.textContent = '確認メールを送りました。リンクを開いてから「ログイン」してください。';
        return;
      }
    } else {
      await sbSignIn(email, password);
    }
    msg.textContent = '';
    $h('sync-password').value = '';
    await updateSyncUI();
    await syncNow({ toast: true });
  } catch (e) {
    msg.textContent = 'できませんでした：' + (e.message || e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const on = (id, fn) => { const el = $h(id); if (el) el.addEventListener('click', fn); };
  on('sync-do-login', () => submitSyncLogin('login'));
  on('sync-do-signup', () => submitSyncLogin('signup'));
  on('sync-now-btn', () => syncNow({ toast: true }));
  on('sync-rollback-btn', restoreRollback);
  on('sync-logout-btn', () => {
    if (!confirm('ログアウトします。ログインを共有している他のアプリもログアウトになります。\nこの端末のデータはそのまま残ります。よろしいですか？')) return;
    sbSignOut();
    updateSyncUI();
    showToast('ログアウトしました');
  });
  updateSyncUI();
});
