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
let currentTagFilter = null;
let searchQuery = '';
// 並び替えモードは「今回どの順で見るか」なので端末をまたいで持ち歩く必要はなく、
// localStorage にだけ覚えておく（Supabase同期の対象にはしない）。
const SORT_MODE_KEY = 'hondana_sort_mode_v1';
const SORT_MODES = ['added', 'title', 'progress', 'manual'];
let sortMode = SORT_MODES.includes(localStorage.getItem(SORT_MODE_KEY)) ? localStorage.getItem(SORT_MODE_KEY) : 'added';
let reorderEditing = false; // 「✎ 並び替え」で棚順を直接編集中かどうか（sortMode==='manual'のときだけ意味を持つ）
let editingBookId = null;
let pendingCoverDataUrl = null;
let confirmCallback = null;
let toastTimer = null;
let scanStream = null;

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

// ── タグフィルター（本の登録内容から動的に作る） ──
function renderTagFilter() {
  const row = document.getElementById('tagFilter');
  const tags = [...new Set(books.flatMap((b) => b.tags || []))].sort((a, b) => a.localeCompare(b, 'ja'));
  // 隠すのは「矢印で棚順を編集している間」だけ。sortMode で判定すると、手動（棚順）で
  // 普通に見ているときまでタグ行が消え、タグで絞ったまま手動に切り替えると
  // 絞り込みを解除する手段が画面から無くなってしまう（本が消えたように見える）。
  if (!tags.length || reorderEditing) {
    row.classList.add('hidden');
    row.innerHTML = '';
    return;
  }
  row.classList.remove('hidden');
  row.innerHTML = `<button class="filter-pill ${!currentTagFilter ? 'active' : ''}" data-tag="">すべてのタグ</button>` +
    tags.map((t) => `<button class="filter-pill ${currentTagFilter === t ? 'active' : ''}" data-tag="${escHtml(t)}">#${escHtml(t)}</button>`).join('');
  row.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      currentTagFilter = pill.dataset.tag || null;
      renderTagFilter();
      renderBooks();
    });
  });
}

// ── 並び替え ──
function isBarcodeSupported() { return 'BarcodeDetector' in window; }

// 棚順を編集し始めるときに、order を 0,1,2… の連番に整える。
// order を持っていない本（旧データ・バックアップからの復元）に番号を振るのと、
// 本を消したあとに空いた番号を詰めるのを兼ねる。変わった本だけ書き込む。
async function backfillOrder() {
  const ordered = books.slice().sort((a, b) => {
    const oa = (a.order === undefined || a.order === null) ? Infinity : a.order;
    const ob = (b.order === undefined || b.order === null) ? Infinity : b.order;
    if (oa !== ob) return oa - ob;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].order !== i) {
      ordered[i].order = i;
      await dbPut(STORES.books, ordered[i]);
    }
  }
}

// sortMode は「今どの並びで見るか」そのもの（一覧の見た目に常に反映される）。
// reorderEditing は「手動（棚順）を今まさに手で直しているか」という別のフラグで、
// 「✎ 並び替え」を押したときだけ立つ。これを分けたのは、以前は手動を選んだ瞬間に
// 矢印編集モードへ強制的に入り、「完了」を押すと追加順に戻ってしまっていたため
// （＝せっかく並べ替えても普段の表示には反映されない、という不具合だった）。
function updateReorderUI() {
  const manual = sortMode === 'manual';
  document.getElementById('sortModeBar').classList.toggle('hidden', !reorderEditing);
  document.getElementById('shelfStats').classList.toggle('hidden', reorderEditing);
  document.getElementById('sortControls').classList.toggle('hidden', reorderEditing);
  document.getElementById('reorderEditBtn').classList.toggle('hidden', !manual || reorderEditing);
  document.getElementById('statusFilter').classList.toggle('disabled-row', reorderEditing);
  document.getElementById('tagFilter').classList.toggle('disabled-row', reorderEditing);
  document.getElementById('searchBtn').disabled = reorderEditing;
}

async function setSortMode(mode) {
  sortMode = mode;
  localStorage.setItem(SORT_MODE_KEY, mode);
  if (mode !== 'manual' && reorderEditing) reorderEditing = false;
  updateReorderUI();
  renderTagFilter();
  renderBooks();
}

async function enterReorderEditing() {
  // 矢印での入れ替えは「今見えている並び全部」に対して行うので、絞り込みが効いたままだと
  // 順番の意味が曖昧になる。編集中だけ絞り込みを外す（絞り込み自体は編集後も残さない）。
  currentFilter = 'all';
  currentTagFilter = null;
  searchQuery = '';
  searchInput.value = '';
  searchBar.classList.add('hidden');
  document.querySelectorAll('#statusFilter .filter-pill').forEach((p) => p.classList.toggle('active', p.dataset.filter === 'all'));
  await backfillOrder();
  reorderEditing = true;
  updateReorderUI();
  renderBooks();
}

function exitReorderEditing() {
  reorderEditing = false;
  updateReorderUI();
  renderTagFilter();
  renderBooks();
  // 編集中は同期を見送っている（sync.js の syncNow を参照）ので、抜けたところで改めて促す
  notifyLocalChange();
}

document.getElementById('sortSelect').addEventListener('change', (e) => setSortMode(e.target.value));
document.getElementById('reorderEditBtn').addEventListener('click', enterReorderEditing);
document.getElementById('sortDoneBtn').addEventListener('click', exitReorderEditing);

function progressScore(b) {
  if (b.status === 'done') return 1;
  if (b.totalPages && b.bookmarkPage) return Math.min(0.999, b.bookmarkPage / b.totalPages);
  if (b.bookmarkPage) return Math.min(0.5, b.bookmarkPage / 1000);
  return 0;
}

async function moveBookOrder(id, dir, list) {
  const idx = list.findIndex((b) => b.id === id);
  const newIdx = idx + dir;
  if (idx < 0 || newIdx < 0 || newIdx >= list.length) return;
  const arr = list.slice();
  const [item] = arr.splice(idx, 1);
  arr.splice(newIdx, 0, item);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].order !== i) {
      arr[i].order = i;
      await dbPut(STORES.books, arr[i]);
    }
  }
  renderBooks();
}

// ── 設定 ──
document.getElementById('settingsBtn').addEventListener('click', () => {
  openModal('settingsModal');
  if (typeof updateSyncUI === 'function') updateSyncUI();
});
document.getElementById('closeSettingsBtn').addEventListener('click', () => closeModal('settingsModal'));

// ── 追加ボタン ──
document.getElementById('fabBtn').addEventListener('click', () => openBookModal(null));

// ── 本棚の描画 ──
// 本を3冊ずつ棚板（shelf-plank）で区切り、実際の本棚のように見せている。
const SHELF_COLS = 3;

function updateShelfStats() {
  const el = document.getElementById('shelfStats');
  if (!el) return;
  // 「欲しいリスト」はまだ持っていない本なので、所有冊数のカウントには含めない
  const owned = books.filter((b) => b.status !== 'wishlist');
  const done = owned.filter((b) => b.status === 'done').length;
  const wishlist = books.length - owned.length;
  const parts = [];
  if (owned.length) parts.push(`📚 全 ${owned.length}冊 ・ 読了 ${done}冊`);
  if (wishlist) parts.push(`🛒 欲しい ${wishlist}冊`);
  el.textContent = parts.join(' ・ ');
}

function renderBooks() {
  const grid = document.getElementById('bookGrid');
  const empty = document.getElementById('bookEmpty');
  const emptyText = document.getElementById('bookEmptyText');
  const manual = sortMode === 'manual';
  const showArrows = manual && reorderEditing;

  renderTagFilter();
  updateShelfStats();

  const q = searchQuery.trim();
  let list = books.filter((b) => {
    if (showArrows) return true; // 編集中は絞り込みを無視して全冊を対象にする
    let matchFilter = true;
    if (currentFilter === 'wishlist') matchFilter = b.status === 'wishlist';
    else if (currentFilter === 'reading') matchFilter = b.status === 'reading';
    else if (currentFilter === 'unread') matchFilter = b.status === 'unread';
    else if (currentFilter === 'done') matchFilter = b.status === 'done';
    else if (currentFilter === 'favorite') matchFilter = !!b.favorite;
    const matchTag = !currentTagFilter || (b.tags || []).includes(currentTagFilter);
    const matchQ = !q || (b.title || '').includes(q) || (b.author || '').includes(q);
    return matchFilter && matchTag && matchQ;
  });

  if (manual) {
    // 手動（棚順）は普段の閲覧でもそのまま使う並び。絞り込みと組み合わせても崩れない。
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  } else if (sortMode === 'title') {
    list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
  } else if (sortMode === 'progress') {
    list.sort((a, b) => progressScore(b) - progressScore(a));
  } else {
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  if (!list.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    emptyText.innerHTML = books.length
      ? '該当する本が見つかりません。'
      : '本棚はまだ空です。<br>＋ボタンで本を追加しましょう。';
    return;
  }
  empty.classList.add('hidden');

  let html = '';
  for (let i = 0; i < list.length; i += SHELF_COLS) {
    const row = list.slice(i, i + SHELF_COLS);
    html += `<div class="shelf-row">${row.map((b) => renderBookCard(b, showArrows)).join('')}</div><div class="shelf-plank"></div>`;
  }
  grid.innerHTML = html;

  attachBookCardHandlers(grid, list, showArrows);
}

function renderBookCard(b, showArrows) {
  const hasProgress = b.status === 'reading' && b.totalPages && b.bookmarkPage;
  const pct = hasProgress ? Math.min(100, Math.round((b.bookmarkPage / b.totalPages) * 100)) : null;
  const tagsHtml = (b.tags && b.tags.length)
    ? `<div class="book-tags">${b.tags.slice(0, 2).map((t) => `<span class="book-tag-chip">${escHtml(t)}</span>`).join('')}</div>`
    : '';
  // 読了のオン/オフはカード上のワンタップにはしていない（誤操作の元になるため）。
  // 状態を変えたいときは、本を開いて編集画面の「状態」から選ぶ。
  const moveHtml = showArrows
    ? `<button class="book-move-btn book-move-prev" data-move="${b.id}" data-dir="-1" title="前へ" aria-label="前へ">◀</button>
       <button class="book-move-btn book-move-next" data-move="${b.id}" data-dir="1" title="次へ" aria-label="次へ">▶</button>`
    : '';

  return `<div class="book-card" data-id="${b.id}">
    <div class="book-cover-wrap ${b.status === 'wishlist' ? 'wishlist' : ''}">
      <div class="book-cover">
        ${b.cover ? `<img src="${escHtml(b.cover)}" alt="${escHtml(b.title)}" loading="lazy">` : bookIcon()}
      </div>
      <button class="book-fav-btn ${b.favorite ? 'active' : ''}" data-fav="${b.id}" title="お気に入り" aria-label="お気に入り">★</button>
      ${moveHtml}
      ${pct !== null ? `<div class="book-progress-track"><div class="book-progress-fill" style="width:${pct}%"></div></div>` : ''}
    </div>
    <div class="book-title">${escHtml(b.title)}</div>
    ${b.author ? `<div class="book-author">${escHtml(b.author)}</div>` : ''}
    ${b.status === 'reading' && b.bookmarkPage ? `<div class="book-status-tag">🔖 ${b.bookmarkPage}${b.totalPages ? ' / ' + b.totalPages : ''}p</div>` : ''}
    ${b.status === 'done' ? `<div class="book-status-tag done">✓ 読了</div>` : ''}
    ${b.status === 'wishlist' ? `<div class="book-status-tag wishlist">🛒 欲しい</div>` : ''}
    ${tagsHtml}
  </div>`;
}

function attachBookCardHandlers(grid, list, showArrows) {
  // 表紙が読み込めなかったときは本のアイコンに差し替える。
  // openBD の表紙は外部URLで Service Worker のキャッシュ対象外なので、
  // オフラインだと読み込めない。これが無いと、ただの空欄になってしまう。
  grid.querySelectorAll('.book-cover img').forEach((img) => {
    img.addEventListener('error', () => {
      const wrap = img.closest('.book-cover');
      if (wrap) wrap.innerHTML = bookIcon();
    });
  });

  grid.querySelectorAll('.book-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.book-fav-btn') || e.target.closest('.book-move-btn')) return;
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

  if (showArrows) {
    grid.querySelectorAll('.book-move-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        moveBookOrder(btn.dataset.move, parseInt(btn.dataset.dir, 10), list);
      });
    });
  }
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
  document.getElementById('bookTagsInput').value = b && b.tags ? b.tags.join(', ') : '';
  document.getElementById('bookMemoInput').value = b ? (b.memo || '') : '';
  document.getElementById('bookBookmarkInput').value = b && b.bookmarkPage ? b.bookmarkPage : '';
  document.getElementById('bookTotalPagesInput').value = b && b.totalPages ? b.totalPages : '';
  document.getElementById('bookFavoriteInput').checked = !!(b && b.favorite);
  document.getElementById('deleteBookBtn').style.display = b ? '' : 'none';
  document.getElementById('isbnInput').value = '';

  const status = (b && b.status) || 'unread';
  document.querySelectorAll('#bookStatusSelector .status-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === status);
  });
  updateFieldVisibilityForStatus(status);

  const rating = (b && b.rating) || 0;
  document.querySelectorAll('#bookRatingSelector .rating-star').forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.dataset.value, 10) <= rating);
  });

  setCoverPreview(b ? b.cover : null);

  updateProgressHint();
  openModal('bookModal');
  setTimeout(() => document.getElementById('bookTitleInput').focus(), 300);
}

// 状態ボタン（欲しい／未読／読書中／読了）
document.querySelectorAll('#bookStatusSelector .status-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#bookStatusSelector .status-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    updateFieldVisibilityForStatus(btn.dataset.value);
  });
});

// 「欲しい（まだ持っていない）」本には、電子栞や評価は意味を持たないので隠す。
// ただし隠すだけで、すでに入っている値は消さない（保存処理の isWishlist 分岐を参照）。
function updateFieldVisibilityForStatus(status) {
  const isWishlist = status === 'wishlist';
  document.getElementById('bookmarkFieldGroup').classList.toggle('hidden', isWishlist);
  document.getElementById('ratingFieldGroup').classList.toggle('hidden', isWishlist);
}

// 表紙プレビューの唯一の入口。pendingCoverDataUrl が「保存されるときの表紙」そのものになる。
// null を渡すと表紙なしになる（＝「表紙を削除」もこれで表現できる）。
function setCoverPreview(value) {
  pendingCoverDataUrl = value || null;
  const area = document.getElementById('coverUploadArea');
  const existing = area.querySelector('img');
  if (existing) existing.remove();
  if (pendingCoverDataUrl) {
    const img = document.createElement('img');
    img.src = pendingCoverDataUrl;
    area.appendChild(img);
  }
  document.getElementById('coverRemoveBtn').classList.toggle('hidden', !pendingCoverDataUrl);
}

document.getElementById('coverRemoveBtn').addEventListener('click', (e) => {
  e.stopPropagation(); // 表紙エリアのクリック（＝ファイル選択）に伝播させない
  setCoverPreview(null);
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

// ── ISBNから取得 ──
// openBD の author は "姓,名,生年-没年" や "著者1/著者2/著" のような生の書誌形式で返ってくるので、
// 生没年や「著」「訳」「編」だけの断片を落として読みやすくする。
function cleanAuthorName(raw) {
  return String(raw)
    .split('/')
    .map((part) => part.split(',')
      .map((s) => s.trim())
      .filter((s) => s && !/^\d{3,4}-\d{0,4}$/.test(s) && !['著', '訳', '編', '監修'].includes(s))
      .join(' '))
    .filter(Boolean)
    .join('、');
}

// 表紙のURLを取ってきて、アップロード画像と同じように縮小した data URL にする。
// 取り込めない（CORS拒否・オフライン等）ときは例外を投げるので、呼び出し側でURLのまま扱う。
async function localizeCoverUrl(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error('空の画像');
  return await readAndResizeImage(blob);
}

// openBD（https://openbd.jp/）は国内書誌データベース。APIキー不要・CORS対応。
async function handleIsbnLookup(rawIsbn) {
  const isbn = String(rawIsbn).replace(/[^0-9Xx]/g, '');
  if (isbn.length < 9) { showToast('ISBNの形式が正しくありません'); return; }
  showToast('書籍情報を検索中…');
  try {
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`);
    const data = await res.json();
    const rec = data && data[0];
    if (!rec || !rec.summary) { showToast('見つかりませんでした。手入力してください'); return; }
    const s = rec.summary;
    if (s.title) document.getElementById('bookTitleInput').value = s.title;
    if (s.author) document.getElementById('bookAuthorInput').value = cleanAuthorName(s.author);
    if (s.cover) {
      // できれば表紙を端末に取り込む（縮小済みの data URL にする）。
      // こうしておくとオフラインでも表示できるし、openBD 側のリンクが切れても残る。
      // CORS で取り込めなかった場合だけ、URL のまま持つ（その場合オフラインでは
      // 表示できないが、カード側で本のアイコンにフォールバックする）。
      let cover = s.cover;
      try { cover = await localizeCoverUrl(s.cover); } catch (e) { /* URLのまま使う */ }
      setCoverPreview(cover);
    }
    showToast('書籍情報を取得しました');
  } catch (err) {
    showToast('検索に失敗しました（オフラインの可能性があります）');
  }
}

document.getElementById('isbnLookupBtn').addEventListener('click', () => {
  const v = document.getElementById('isbnInput').value.trim();
  if (!v) { showToast('ISBNを入力してください'); return; }
  handleIsbnLookup(v);
});

// ── バーコード読み取り ──
// ブラウザ標準の Shape Detection API（BarcodeDetector）を使う。外部ライブラリは使わない。
// 対応していない端末（iOS Safari など）では scanIsbnBtn 自体を隠すので、この関数は呼ばれない。
async function startBarcodeScan() {
  if (!isBarcodeSupported()) { showToast('この端末はバーコード読み取りに対応していません'); return; }
  const overlay = document.getElementById('scanOverlay');
  const video = document.getElementById('scanVideo');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    showToast('カメラを使用できませんでした');
    return;
  }
  video.srcObject = scanStream;
  await video.play();
  overlay.classList.remove('hidden');

  const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8'] });
  let stopped = false;
  document.getElementById('scanCloseBtn').onclick = () => { stopped = true; stopBarcodeScan(); };

  const tick = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length) {
        stopped = true;
        const value = codes[0].rawValue;
        stopBarcodeScan();
        await handleIsbnLookup(value);
        return;
      }
    } catch (e) { /* 検出失敗はそのまま次のフレームへ */ }
    requestAnimationFrame(tick);
  };
  tick();
}

function stopBarcodeScan() {
  document.getElementById('scanOverlay').classList.add('hidden');
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
}

document.getElementById('scanIsbnBtn').addEventListener('click', startBarcodeScan);

// 表紙画像
document.getElementById('coverUploadArea').addEventListener('click', () => {
  document.getElementById('coverFileInput').click();
});
document.getElementById('coverFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    setCoverPreview(await readAndResizeImage(file));
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
  const statusBtn = document.querySelector('#bookStatusSelector .status-btn.active');
  const status = statusBtn ? statusBtn.dataset.value : 'unread';
  const existing = editingBookId ? books.find((x) => x.id === editingBookId) : null;
  // 「欲しい」のときは電子栞と評価の入力欄を隠している。隠れている＝画面の値が当てにならないので、
  // 元々入っていた値をそのまま持ち越す（消さない）。間違えて「欲しい」にして保存しても、
  // 読みかけのページ数や評価が失われないようにするため。
  const isWishlist = status === 'wishlist';
  const bookmarkPage = isWishlist
    ? (existing && existing.bookmarkPage) || 0
    : parseInt(document.getElementById('bookBookmarkInput').value, 10) || 0;
  const totalPages = isWishlist
    ? (existing && existing.totalPages) || 0
    : parseInt(document.getElementById('bookTotalPagesInput').value, 10) || 0;
  const rating = isWishlist
    ? (existing && existing.rating) || 0
    : document.querySelectorAll('#bookRatingSelector .rating-star.active').length;
  const tagsRaw = document.getElementById('bookTagsInput').value.trim();
  const tags = tagsRaw ? [...new Set(tagsRaw.split(/[,、]+/).map((t) => t.trim()).filter(Boolean))] : [];

  if (editingBookId) {
    const b = existing;
    Object.assign(b, {
      title, author, memo, favorite, status, rating, tags,
      bookmarkPage: bookmarkPage || null,
      totalPages: totalPages || null,
      // pendingCoverDataUrl が「保存される表紙」そのもの（setCoverPreview が唯一の更新元）。
      // b.cover へのフォールバックを入れると、表紙を削除しても消せなくなる。
      cover: pendingCoverDataUrl || null,
    });
    await dbPut(STORES.books, b);
    showToast('本を更新しました');
  } else {
    const maxOrder = books.reduce((m, x) => Math.max(m, x.order ?? -1), -1);
    const b = {
      id: uid(), title, author, memo, favorite, status, rating, tags,
      bookmarkPage: bookmarkPage || null,
      totalPages: totalPages || null,
      cover: pendingCoverDataUrl || null,
      order: maxOrder + 1,
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
  if (!isBarcodeSupported()) document.getElementById('scanIsbnBtn').classList.add('hidden');
  document.getElementById('sortSelect').value = sortMode;
  updateReorderUI();
  await openDB();
  await pruneTombstones();
  await loadAll();
  renderBooks();
  // sync.js が読み込まれていれば、ここから同期を始めさせる
  if (typeof window.hondanaOnReady === 'function') {
    try { window.hondanaOnReady(); } catch (e) {}
  }
})();
