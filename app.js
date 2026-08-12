// ══════════════════════════════════════════════
//  本棚 — app.js
// ══════════════════════════════════════════════

'use strict';

// ── PWA Service Worker ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ── DB ──
const DB_NAME = 'hondana-db';
const DB_VERSION = 1;
const STORES = { books: 'books' };
const DATA_STORES = Object.values(STORES);

// 同期のための内部ストア。バックアップの書き出し・復元の対象にはしない。
//   tombstones … 消したものの墓標。これが無いと、消した本が、まだ持っている端末から
//                押し戻されて復活する。
//   _sync      … 取り込み前の控えなど、同期まわりの大きめの控え置き場。
//                表紙画像込みだと localStorage に収まらないのでこちらに置く。
const TOMB_STORE = 'tombstones';
const SYNC_STORE = '_sync';

// 墓標は同期し終われば用済みだが、長く開いていなかった端末が後から繋がる場合に備えて1年持つ。
const TOMB_KEEP_MS = 365 * 24 * 60 * 60 * 1000;

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      [...DATA_STORES, TOMB_STORE, SYNC_STORE].forEach((name) => {
        if (!d.objectStoreNames.contains(name))
          d.createObjectStore(name, { keyPath: 'id' });
      });
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function dbAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbCount(storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(storeName, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── 生の読み書き（墓標を動かさない。同期の内部処理用） ──
function dbRawPut(storeName, obj) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put(obj);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbRawDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── アプリが使う入口。ここで墓標の面倒を見るので、呼ぶ側は今までどおりでよい ──
function tombKey(storeName, id) { return `${storeName}:${id}`; }

async function dbPut(storeName, obj) {
  await dbRawPut(storeName, obj);
  if (DATA_STORES.includes(storeName)) await dbRawDelete(TOMB_STORE, tombKey(storeName, obj.id));
  notifyLocalChange();
}

async function dbDelete(storeName, id) {
  await dbRawDelete(storeName, id);
  if (DATA_STORES.includes(storeName)) {
    await dbRawPut(TOMB_STORE, { id: tombKey(storeName, id), store: storeName, itemId: id, at: Date.now() });
  }
  notifyLocalChange();
}

async function dbClear(storeName) {
  if (DATA_STORES.includes(storeName)) {
    const at = Date.now();
    for (const item of await dbAll(storeName)) {
      await dbRawPut(TOMB_STORE, { id: tombKey(storeName, item.id), store: storeName, itemId: item.id, at });
    }
  }
  await new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  notifyLocalChange();
}

// sync.js が読み込まれていれば同期を予約させる。
// 未ログイン／sync.js 無しなら何も起きない＝導入前とまったく同じ挙動。
function notifyLocalChange() {
  if (typeof window.hondanaOnLocalChange === 'function') {
    try { window.hondanaOnLocalChange(); } catch (e) {}
  }
}

async function pruneTombstones() {
  const limit = Date.now() - TOMB_KEEP_MS;
  for (const t of await dbAll(TOMB_STORE)) {
    if (!t || !DATA_STORES.includes(t.store)) continue;
    if (!(Number(t.at) > limit)) await dbRawDelete(TOMB_STORE, t.id);
  }
}

// ── State ──
let books = [];
let currentFilter = 'all';
let searchQuery = '';
let editingBookId = null;
let pendingCoverDataUrl = null;
let confirmCallback = null;
let toastTimer = null;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function loadAll() {
  books = await dbAll(STORES.books);
}

// ── Toast ──
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ── Confirm dialog ──
function showConfirm(title, msg, okLabel = '削除する') {
  return new Promise((resolve) => {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent = msg;
    document.getElementById('confirmOkBtn').textContent = okLabel;
    const overlay = document.getElementById('confirmOverlay');
    overlay.classList.add('open');
    confirmCallback = (ok) => {
      overlay.classList.remove('open');
      resolve(ok);
    };
  });
}

document.getElementById('confirmOkBtn').addEventListener('click', () => confirmCallback && confirmCallback(true));
document.getElementById('confirmCancelBtn').addEventListener('click', () => confirmCallback && confirmCallback(false));

// ── Modal helpers ──
function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// ── 画像の読み込み＋縮小 ──
// 表紙はスマホのカメラで撮ったそのままだと数MBになりがちで、同期の送信量を圧迫する。
// 長辺 640px・JPEG 0.85 にそろえてから data URL として保存する。
function readAndResizeImage(file, maxSize = 640, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          if (width > height) { height = Math.round(height * maxSize / width); width = maxSize; }
          else { width = Math.round(width * maxSize / height); height = maxSize; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('画像を読み込めませんでした'));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ── 検索 ──
const searchBtn = document.getElementById('searchBtn');
const searchBar = document.getElementById('searchBar');
const searchInput = document.getElementById('searchInput');
searchBtn.addEventListener('click', () => {
  searchBar.classList.toggle('hidden');
  if (!searchBar.classList.contains('hidden')) {
    searchInput.focus();
  } else {
    searchInput.value = '';
    searchQuery = '';
    renderBooks();
  }
});
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderBooks();
});

// ── 状態フィルター ──
document.querySelectorAll('#statusFilter .filter-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    currentFilter = pill.dataset.filter;
    document.querySelectorAll('#statusFilter .filter-pill').forEach((p) => p.classList.toggle('active', p === pill));
    renderBooks();
  });
});

// ── 設定 ──
document.getElementById('settingsBtn').addEventListener('click', () => {
  openModal('settingsModal');
  if (typeof updateSyncUI === 'function') updateSyncUI();
});
document.getElementById('closeSettingsBtn').addEventListener('click', () => closeModal('settingsModal'));

// ── 追加ボタン ──
document.getElementById('fabBtn').addEventListener('click', () => openBookModal(null));

// ── 本棚の描画 ──
const STATUS_LABEL = { unread: '未読', reading: '読書中', done: '読了' };

function renderBooks() {
  const grid = document.getElementById('bookGrid');
  const empty = document.getElementById('bookEmpty');
  const emptyText = document.getElementById('bookEmptyText');

  const q = searchQuery.trim();
  const filtered = books.filter((b) => {
    let matchFilter = true;
    if (currentFilter === 'reading') matchFilter = b.status === 'reading';
    else if (currentFilter === 'unread') matchFilter = b.status === 'unread';
    else if (currentFilter === 'done') matchFilter = b.status === 'done';
    else if (currentFilter === 'favorite') matchFilter = !!b.favorite;
    const matchQ = !q || (b.title || '').includes(q) || (b.author || '').includes(q);
    return matchFilter && matchQ;
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (!filtered.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    emptyText.innerHTML = books.length
      ? '該当する本が見つかりません。'
      : '本棚はまだ空です。<br>＋ボタンで本を追加しましょう。';
    return;
  }
  empty.classList.add('hidden');

  grid.innerHTML = filtered.map((b) => {
    const hasProgress = b.status === 'reading' && b.totalPages && b.bookmarkPage;
    const pct = hasProgress ? Math.min(100, Math.round((b.bookmarkPage / b.totalPages) * 100)) : null;
    return `<div class="book-card" data-id="${b.id}">
      <div class="book-cover-wrap">
        <div class="book-cover">
          ${b.cover ? `<img src="${b.cover}" alt="${escHtml(b.title)}">` : bookIcon()}
        </div>
        <button class="book-fav-btn ${b.favorite ? 'active' : ''}" data-fav="${b.id}" title="お気に入り" aria-label="お気に入り">★</button>
        <button class="book-done-btn ${b.status === 'done' ? 'active' : ''}" data-done="${b.id}" title="読了にする" aria-label="読了にする">✓</button>
        ${pct !== null ? `<div class="book-progress-track"><div class="book-progress-fill" style="width:${pct}%"></div></div>` : ''}
      </div>
      <div class="book-title">${escHtml(b.title)}</div>
      ${b.author ? `<div class="book-author">${escHtml(b.author)}</div>` : ''}
      ${b.status === 'reading' && b.bookmarkPage ? `<div class="book-status-tag">🔖 ${b.bookmarkPage}${b.totalPages ? ' / ' + b.totalPages : ''}p</div>` : ''}
    </div>`;
  }).join('');

  grid.querySelectorAll('.book-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.book-fav-btn') || e.target.closest('.book-done-btn')) return;
      openBookModal(card.dataset.id);
    });
  });

  grid.querySelectorAll('.book-fav-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const b = books.find((x) => x.id === btn.dataset.fav);
      if (!b) return;
      b.favorite = !b.favorite;
      await dbPut(STORES.books, b);
      renderBooks();
    });
  });

  grid.querySelectorAll('.book-done-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const b = books.find((x) => x.id === btn.dataset.done);
      if (!b) return;
      if (b.status === 'done') {
        b.status = (b.bookmarkPage && b.bookmarkPage > 0) ? 'reading' : 'unread';
      } else {
        b.status = 'done';
        if (b.totalPages) b.bookmarkPage = b.totalPages;
      }
      await dbPut(STORES.books, b);
      showToast(b.status === 'done' ? '読了にしました' : '読了を解除しました');
      renderBooks();
    });
  });
}

function bookIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>`;
}

// ── 本の追加・編集モーダル ──
function openBookModal(id) {
  editingBookId = id;
  pendingCoverDataUrl = null;
  const b = id ? books.find((x) => x.id === id) : null;

  document.getElementById('bookModalTitle').textContent = b ? '本を編集' : '本を追加';
  document.getElementById('bookTitleInput').value = b ? b.title : '';
  document.getElementById('bookAuthorInput').value = b ? (b.author || '') : '';
  document.getElementById('bookMemoInput').value = b ? (b.memo || '') : '';
  document.getElementById('bookBookmarkInput').value = b && b.bookmarkPage ? b.bookmarkPage : '';
  document.getElementById('bookTotalPagesInput').value = b && b.totalPages ? b.totalPages : '';
  document.getElementById('bookFavoriteInput').checked = !!(b && b.favorite);
  document.getElementById('deleteBookBtn').style.display = b ? '' : 'none';

  const status = (b && b.status) || 'unread';
  document.querySelectorAll('#bookStatusSelector .status-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === status);
  });

  const rating = (b && b.rating) || 0;
  document.querySelectorAll('#bookRatingSelector .rating-star').forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.dataset.value, 10) <= rating);
  });

  const area = document.getElementById('coverUploadArea');
  const existingImg = area.querySelector('img');
  if (existingImg) existingImg.remove();
  if (b && b.cover) {
    const img = document.createElement('img');
    img.src = b.cover;
    area.appendChild(img);
    pendingCoverDataUrl = b.cover;
  }

  updateProgressHint();
  openModal('bookModal');
  setTimeout(() => document.getElementById('bookTitleInput').focus(), 300);
}

// 状態ボタン（未読／読書中／読了）
document.querySelectorAll('#bookStatusSelector .status-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#bookStatusSelector .status-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// 評価の★（今と同じ★をもう一度押すと0に戻す）
document.querySelectorAll('#bookRatingSelector .rating-star').forEach((btn) => {
  btn.addEventListener('click', () => {
    const val = parseInt(btn.dataset.value, 10);
    const stars = document.querySelectorAll('#bookRatingSelector .rating-star');
    const current = [...stars].filter((s) => s.classList.contains('active')).length;
    const next = current === val ? 0 : val;
    stars.forEach((s) => s.classList.toggle('active', parseInt(s.dataset.value, 10) <= next));
  });
});

// 電子栞（今のページ／総ページ数）の進捗表示
function updateProgressHint() {
  const cur = parseInt(document.getElementById('bookBookmarkInput').value, 10) || 0;
  const total = parseInt(document.getElementById('bookTotalPagesInput').value, 10) || 0;
  const hint = document.getElementById('bookProgressHint');
  if (total > 0 && cur > 0) {
    const pct = Math.min(100, Math.round((cur / total) * 100));
    hint.textContent = `進捗 ${pct}%（${cur} / ${total} ページ）`;
  } else if (cur > 0) {
    hint.textContent = `${cur} ページまで読みました`;
  } else {
    hint.textContent = '';
  }
}
document.getElementById('bookBookmarkInput').addEventListener('input', updateProgressHint);
document.getElementById('bookTotalPagesInput').addEventListener('input', updateProgressHint);

// 表紙画像
document.getElementById('coverUploadArea').addEventListener('click', () => {
  document.getElementById('coverFileInput').click();
});
document.getElementById('coverFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await readAndResizeImage(file);
    pendingCoverDataUrl = dataUrl;
    const area = document.getElementById('coverUploadArea');
    const existing = area.querySelector('img');
    if (existing) existing.remove();
    const img = document.createElement('img');
    img.src = dataUrl;
    area.appendChild(img);
  } catch (err) {
    showToast('画像の読み込みに失敗しました');
  }
  e.target.value = '';
});

// 保存
document.getElementById('saveBookBtn').addEventListener('click', async () => {
  const title = document.getElementById('bookTitleInput').value.trim();
  if (!title) {
    document.getElementById('bookTitleInput').classList.add('error');
    setTimeout(() => document.getElementById('bookTitleInput').classList.remove('error'), 400);
    showToast('タイトルを入力してください');
    return;
  }
  const author = document.getElementById('bookAuthorInput').value.trim();
  const memo = document.getElementById('bookMemoInput').value.trim();
  const favorite = document.getElementById('bookFavoriteInput').checked;
  const bookmarkPage = parseInt(document.getElementById('bookBookmarkInput').value, 10) || 0;
  const totalPages = parseInt(document.getElementById('bookTotalPagesInput').value, 10) || 0;
  const statusBtn = document.querySelector('#bookStatusSelector .status-btn.active');
  const status = statusBtn ? statusBtn.dataset.value : 'unread';
  const rating = document.querySelectorAll('#bookRatingSelector .rating-star.active').length;

  if (editingBookId) {
    const b = books.find((x) => x.id === editingBookId);
    Object.assign(b, {
      title, author, memo, favorite, status, rating,
      bookmarkPage: bookmarkPage || null,
      totalPages: totalPages || null,
      cover: pendingCoverDataUrl || b.cover || null,
    });
    await dbPut(STORES.books, b);
    showToast('本を更新しました');
  } else {
    const b = {
      id: uid(), title, author, memo, favorite, status, rating,
      bookmarkPage: bookmarkPage || null,
      totalPages: totalPages || null,
      cover: pendingCoverDataUrl || null,
      createdAt: Date.now(),
    };
    books.push(b);
    await dbPut(STORES.books, b);
    showToast('本を追加しました');
  }
  closeModal('bookModal');
  renderBooks();
});

// 削除
document.getElementById('deleteBookBtn').addEventListener('click', async () => {
  if (!editingBookId) return;
  const ok = await showConfirm('本を削除', 'この本を本棚から削除しますか？', '削除する');
  if (!ok) return;
  books = books.filter((x) => x.id !== editingBookId);
  await dbDelete(STORES.books, editingBookId);
  showToast('削除しました');
  closeModal('bookModal');
  renderBooks();
});

document.getElementById('cancelBookBtn').addEventListener('click', () => closeModal('bookModal'));

// ── バックアップ ──
document.getElementById('exportBtn').addEventListener('click', () => {
  const data = { app: 'hondana', version: 1, exportedAt: new Date().toISOString(), books };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hondana-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('バックアップを保存しました');
});

// ── 復元 ──
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFileInput').click();
});
document.getElementById('importFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ok = await showConfirm('データを復元', '現在のデータを上書きしてバックアップから復元しますか？', '復元する');
  if (!ok) { e.target.value = ''; return; }

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await dbClear(STORES.books);
    books = Array.isArray(data.books) ? data.books : [];
    for (const item of books) await dbPut(STORES.books, item);
    showToast('データを復元しました');
    renderBooks();
  } catch (err) {
    showToast('ファイルの読み込みに失敗しました');
  }
  e.target.value = '';
});

// ── 全削除 ──
document.getElementById('clearAllBtn').addEventListener('click', async () => {
  const ok = await showConfirm('全データを削除', '本棚のすべての本を削除しますか？この操作は取り消せません。');
  if (!ok) return;
  await dbClear(STORES.books);
  books = [];
  showToast('全データを削除しました');
  renderBooks();
});

// ── Helpers ──
function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ──
(async () => {
  await openDB();
  await pruneTombstones();
  await loadAll();
  renderBooks();
  // sync.js が読み込まれていれば、ここから同期を始めさせる
  if (typeof window.hondanaOnReady === 'function') {
    try { window.hondanaOnReady(); } catch (e) {}
  }
})();
