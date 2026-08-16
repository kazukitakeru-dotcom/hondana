// ══════════════════════════════════════════════
//  本棚 — app.js
// ══════════════════════════════════════════════

'use strict';

// 画面に出す版。**`sw.js` の CACHE_NAME と必ず揃えること。**
// 「直したはずの機能が出てこない」がキャッシュのせいなのか作りのせいなのかを
// 端末側で判別できるようにするためにある。
const APP_VERSION = 'v20';

// ── PWA Service Worker ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// キャッシュを捨てて読み直す。保存データ（IndexedDB）には触らない。
async function forceUpdate() {
  try {
    if ('serviceWorker' in navigator) {
      for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
    }
    if (window.caches) {
      for (const key of await caches.keys()) await caches.delete(key);
    }
  } catch (e) { /* 消せなくても読み直しは試す */ }
  // 同じURLだと機種によっては読み直さないので、印を付けて開き直す
  location.replace(location.pathname + '?u=' + Date.now());
}

// ── DB ──
const DB_NAME = 'hondana-db';
// v2 で shelves（棚）を追加。sync.js は DATA_STORES を総なめする作りなので、
// ストアを足すだけで同期にも自動的に乗る（Supabase 側も store 列で区別しているso変更不要）。
const DB_VERSION = 2;
const STORES = { books: 'books', shelves: 'shelves' };
const DATA_STORES = Object.values(STORES);

// 初回起動時に用意する棚。空の棚も持てるように、本とは別のストアで管理している
// （タグのように本から動的に集める方式だと、中身が0冊の棚を作れないため）。
const DEFAULT_SHELVES = ['漫画棚', '小説棚', '絵本棚'];

// 電子書籍ストアの選択肢。国内で使われている主なところ＋「その他」。
// 自由入力にすると表記ゆれ（Kindle / きんどる / アマゾン）で集計も絞り込みもできなくなるので、
// 決め打ちの一覧から選ぶ形にしている。
const EBOOK_STORES = [
  'Kindle', '楽天Kobo', 'BOOK☆WALKER', 'ebookjapan', 'honto',
  'DMMブックス', 'コミックシーモア', 'Apple Books', 'Google Play ブックス',
  'めちゃコミック', 'LINEマンガ', 'ピッコマ', 'ジャンプ+', 'その他',
];

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
let shelves = [];
let currentFilter = 'all';
let currentShelfFilter = null; // null=すべての棚 / 棚id / '__none__'=棚なし
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
let scanStream = null;   // 自分で開いたカメラ（BarcodeDetector経路）
let zxingReader = null;  // ZXingが開いたカメラ（ZXing経路）

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function loadAll() {
  books = await dbAll(STORES.books);
  shelves = (await dbAll(STORES.shelves)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// 初回だけ既定の棚を作る。ユーザーが全部消した状態と区別するため、
// 「一度でも棚を作ったか」を localStorage に残して二度目以降は復活させない。
const SHELVES_SEEDED_KEY = 'hondana_shelves_seeded_v1';
async function seedDefaultShelvesOnce() {
  if (localStorage.getItem(SHELVES_SEEDED_KEY)) return;
  localStorage.setItem(SHELVES_SEEDED_KEY, '1');
  if (shelves.length) return;
  for (let i = 0; i < DEFAULT_SHELVES.length; i++) {
    const shelf = { id: uid(), name: DEFAULT_SHELVES[i], order: i };
    shelves.push(shelf);
    await dbPut(STORES.shelves, shelf);
  }
}

function shelfName(id) {
  const s = shelves.find((x) => x.id === id);
  return s ? s.name : null;
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
// 打った通りでなくても当たるようにする。以前は title と author に対する
// そのままの部分一致だけで、次のどれも外れていた：
//   ・「尾田栄一郎」… openBD の著者は「尾田 栄一郎」と空白入りで入る
//   ・「ONE PIECE」「one piece」… 大文字小文字を区別していた
//   ・タグ・メモ・ISBN・棚名・電子ストア … そもそも対象外
function normalizeSearch(s) {
  return String(s || '')
    .normalize('NFKC')                 // 全角英数→半角、半角カナ→全角カナ
    .toLowerCase()
    .replace(/[\s　]+/g, '')       // 空白は無視（「尾田 栄一郎」＝「尾田栄一郎」）
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)); // ひらがな→カタカナ
}

// 1冊ぶんの「検索の対象になる文字列」をまとめて作る。
// kana は openBD の読み仮名（collationkey）。これがあると「おだ」で「尾田」が引ける。
function searchableText(b) {
  const parts = [
    b.title, b.author, b.memo, b.isbn, b.store,
    b.titleKana, b.authorKana,
    ...(b.tags || []),
    shelfName(b.shelfId),
  ];
  if (b.volumeNo) parts.push(`${b.volumeNo}巻`);
  return normalizeSearch(parts.filter(Boolean).join(' '));
}

// 空白区切りの語は「全部含む」で絞る（「尾田 海賊」で両方を含む本）
function matchesSearch(b, rawQuery) {
  const terms = String(rawQuery || '').split(/[\s　]+/).map(normalizeSearch).filter(Boolean);
  if (!terms.length) return true;
  const hay = searchableText(b);
  return terms.every((t) => hay.includes(t));
}

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

// ── 棚フィルター ──
function renderShelfFilter() {
  const row = document.getElementById('shelfFilter');
  const hasUnshelved = books.some((b) => !b.shelfId || !shelfName(b.shelfId));
  if (!shelves.length || reorderEditing) {
    row.classList.add('hidden');
    row.innerHTML = '';
    return;
  }
  row.classList.remove('hidden');
  const pill = (val, label, active) =>
    `<button class="filter-pill ${active ? 'active' : ''}" data-shelf="${escHtml(val)}">${escHtml(label)}</button>`;
  row.innerHTML =
    pill('', 'すべての棚', !currentShelfFilter) +
    shelves.map((s) => pill(s.id, s.name, currentShelfFilter === s.id)).join('') +
    (hasUnshelved ? pill('__none__', '棚なし', currentShelfFilter === '__none__') : '');
  row.querySelectorAll('.filter-pill').forEach((p) => {
    p.addEventListener('click', () => {
      currentShelfFilter = p.dataset.shelf || null;
      renderBooks();
    });
  });
}

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

// ── シリーズの巻数 ──
// 「1-105」「1-10, 12-20」のような入力を巻番号の配列にする。
// 抜けている巻を出したいので、範囲のまま持たず1巻ずつに展開している。
const VOLUME_MAX_SPAN = 3000; // 打ち間違い（1-99999 等）でメモリを食い潰さないための上限

function parseVolumes(str) {
  const set = new Set();
  for (const part of String(str || '').split(/[,、\s]+/)) {
    if (!part) continue;
    const range = part.match(/^(\d+)\s*[-–—~〜]\s*(\d+)$/);
    if (range) {
      let a = parseInt(range[1], 10);
      let b = parseInt(range[2], 10);
      if (a > b) [a, b] = [b, a];
      if (b - a > VOLUME_MAX_SPAN) continue;
      for (let i = a; i <= b; i++) set.add(i);
    } else if (/^\d+$/.test(part)) {
      set.add(parseInt(part, 10));
    }
  }
  return [...set].sort((a, b) => a - b);
}

// 巻番号の配列を「1〜4, 6〜8」の形に畳む。
// これは**全体を一目で見るとき専用**の書き方。1冊ずつの一覧では畳まずに 1 2 3 … と並べる
// （畳んだ表記だけだと「持ち物」に見えない、という指摘を受けたため）。
function formatVolumeRanges(vols) {
  const out = [];
  let start = null, prev = null;
  const push = () => out.push(start === prev ? `${start}` : `${start}〜${prev}`);
  for (const v of vols) {
    if (start === null) { start = prev = v; continue; }
    if (v === prev + 1) { prev = v; continue; }
    push();
    start = prev = v;
  }
  if (start !== null) push();
  return out.join(', ');
}

// ── シリーズは「入れ物」、巻は「1冊ずつの本」 ──
//
// 以前はシリーズ本に '1-105' という文字列を持たせるだけだった。それだと
//   ・すでに棚にある2巻を後からシリーズへ入れられない
//   ・1冊ずつの持ち物として見えない（棚として機能しない）
// ので、巻を普通の本のレコードにして seriesId でシリーズ本にぶら下げる形にした。
// 巻の本は本棚の一覧には出さず、シリーズを開いたときだけ並ぶ。

function seriesVolumes(seriesId) {
  return books.filter((b) => b.seriesId === seriesId)
    .sort((a, b) => (a.volumeNo || 0) - (b.volumeNo || 0));
}

// missing（抜け）は**持っている範囲の中の穴だけ**。
// 全巻数から見た未購入分（20巻まで持っていて全72巻なら以降）は remaining として別に返す。
// 混ぜると「買い逃した巻」と「まだそこまで集めていない」が同じ表示になって読めなくなる。
function seriesInfo(series) {
  const vols = seriesVolumes(series.id);
  const nums = vols.map((v) => v.volumeNo).filter((n) => n > 0);
  const owned = new Set(nums);
  const min = nums.length ? nums[0] : 0;
  const max = nums.length ? nums[nums.length - 1] : 0;
  const missing = [];
  for (let i = min; i < max; i++) if (!owned.has(i)) missing.push(i);
  const total = series.totalVolumes || 0;
  const remaining = total > max ? total - max : 0;
  const complete = total > 0 && !missing.length && max >= total;
  return {
    vols, nums, count: nums.length, min, max, missing, remaining, total, complete,
    ranges: formatVolumeRanges(nums),
    // 次に買うのは、間が抜けていればその最初の巻、無ければ続きの巻
    next: complete ? null : (missing.length ? missing[0] : max + 1),
  };
}

// シリーズに属する1冊を作る。
// 読み取りから来た場合は extra で ISBN や表紙が渡ってくるので、それを残す
// （せっかく取得した情報を捨てて「◯◯ 3」だけの空レコードにしないため）。
function makeVolumeRecord(series, no, extra = {}) {
  return Object.assign({
    id: uid(),
    seriesId: series.id,
    volumeNo: no,
    title: `${series.title} ${no}`,
    author: series.author || '',
    shelfId: series.shelfId || null,
    status: 'unread',
    tags: [],
    cover: null,
    isSeries: false,
    // 巻ごとに紙/電子は違いうるが、たいていは揃うのでシリーズの設定を引き継ぐ
    format: series.format || 'paper',
    store: series.store || null,
    createdAt: Date.now(),
  }, extra);
}

async function addVolumeRecord(series, no, extra = {}) {
  if (!no || seriesVolumes(series.id).some((v) => v.volumeNo === no)) return null;
  const v = makeVolumeRecord(series, no, extra);
  books.push(v);
  await dbPut(STORES.books, v);
  return v;
}

// 旧形式（volumes に '1-105' の文字列）を1冊ずつのレコードに移す。
// 何度走っても同じ結果になるようにしてある。
async function migrateSeriesVolumes() {
  for (const s of books.filter((b) => b.isSeries && b.volumes)) {
    for (const n of parseVolumes(s.volumes)) await addVolumeRecord(s, n);
    s.volumes = '';
    await dbPut(STORES.books, s);
  }
}

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

// ── 棚の管理（設定画面） ──
function renderShelfManager() {
  const list = document.getElementById('shelfManagerList');
  if (!shelves.length) {
    list.innerHTML = `<p class="sync-hint">棚がありません。下から追加できます。</p>`;
    return;
  }
  list.innerHTML = shelves.map((s, i) => {
    const count = books.filter((b) => b.shelfId === s.id).length;
    return `<div class="shelf-manage-row" data-shelf-id="${escHtml(s.id)}">
      <span class="shelf-manage-name">${escHtml(s.name)}<span class="shelf-manage-count">${count}冊</span></span>
      <button class="shelf-manage-btn" data-move="${escHtml(s.id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="上へ">▲</button>
      <button class="shelf-manage-btn" data-move="${escHtml(s.id)}" data-dir="1" ${i === shelves.length - 1 ? 'disabled' : ''} aria-label="下へ">▼</button>
      <button class="shelf-manage-btn" data-rename="${escHtml(s.id)}" aria-label="名前を変える">✎</button>
      <button class="shelf-manage-btn danger" data-del="${escHtml(s.id)}" aria-label="削除">✕</button>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-move]').forEach((btn) => {
    btn.addEventListener('click', () => moveShelf(btn.dataset.move, parseInt(btn.dataset.dir, 10)));
  });
  list.querySelectorAll('[data-rename]').forEach((btn) => {
    btn.addEventListener('click', () => renameShelf(btn.dataset.rename));
  });
  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => deleteShelf(btn.dataset.del));
  });
}

async function addShelf() {
  const input = document.getElementById('newShelfInput');
  const name = input.value.trim();
  if (!name) return;
  if (shelves.some((s) => s.name === name)) { showToast('同じ名前の棚があります'); return; }
  const shelf = { id: uid(), name, order: shelves.length };
  shelves.push(shelf);
  await dbPut(STORES.shelves, shelf);
  input.value = '';
  renderShelfManager();
  renderBooks();
  showToast(`「${name}」を追加しました`);
}

async function renameShelf(id) {
  const shelf = shelves.find((s) => s.id === id);
  if (!shelf) return;
  const name = (prompt('棚の名前', shelf.name) || '').trim();
  if (!name || name === shelf.name) return;
  if (shelves.some((s) => s.name === name && s.id !== id)) { showToast('同じ名前の棚があります'); return; }
  shelf.name = name;
  await dbPut(STORES.shelves, shelf);
  renderShelfManager();
  renderBooks();
}

async function moveShelf(id, dir) {
  const idx = shelves.findIndex((s) => s.id === id);
  const newIdx = idx + dir;
  if (idx < 0 || newIdx < 0 || newIdx >= shelves.length) return;
  const [item] = shelves.splice(idx, 1);
  shelves.splice(newIdx, 0, item);
  for (let i = 0; i < shelves.length; i++) {
    if (shelves[i].order !== i) {
      shelves[i].order = i;
      await dbPut(STORES.shelves, shelves[i]);
    }
  }
  renderShelfManager();
  renderBooks();
}

// 棚を消しても、中の本は消さない（「棚なし」に戻すだけ）。
async function deleteShelf(id) {
  const shelf = shelves.find((s) => s.id === id);
  if (!shelf) return;
  const count = books.filter((b) => b.shelfId === id).length;
  const ok = await showConfirm(
    '棚を削除',
    count
      ? `「${shelf.name}」を削除します。中の ${count}冊 は本棚に残り、「棚なし」になります。`
      : `「${shelf.name}」を削除します。`,
    '削除する'
  );
  if (!ok) return;
  for (const b of books.filter((x) => x.shelfId === id)) {
    b.shelfId = null;
    await dbPut(STORES.books, b);
  }
  shelves = shelves.filter((s) => s.id !== id);
  await dbDelete(STORES.shelves, id);
  if (currentShelfFilter === id) currentShelfFilter = null;
  renderShelfManager();
  renderBooks();
  showToast('棚を削除しました');
}

document.getElementById('addShelfBtn').addEventListener('click', addShelf);
document.getElementById('newShelfInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addShelf();
});

// ── 設定 ──
document.getElementById('settingsBtn').addEventListener('click', () => {
  renderShelfManager();
  updateKanaStatus();
  document.getElementById('appVersionLabel').textContent = APP_VERSION;
  openModal('settingsModal');
  if (typeof updateSyncUI === 'function') updateSyncUI();
});

// 既に登録済みの本にも読み仮名を入れる。
// 読み取りのときしか読みが手に入らないので、これが無いと今ある本は読みで引けないままになる。
function booksNeedingKana() {
  return books.filter((b) => b.isbn && !b.titleKana && !b.authorKana);
}

function updateKanaStatus() {
  const el = document.getElementById('kanaStatus');
  if (!el) return;
  const need = booksNeedingKana().length;
  const have = books.filter((b) => b.titleKana || b.authorKana).length;
  el.textContent = need
    ? `読みがな未取得の本が ${need}冊 あります（取得済み ${have}冊）`
    : (have ? `すべて取得済みです（${have}冊）` : 'ISBNのある本がまだありません');
}

document.getElementById('fetchKanaBtn').addEventListener('click', async () => {
  const targets = booksNeedingKana();
  if (!targets.length) { showToast('取得が必要な本はありません'); return; }
  if (!navigator.onLine) { showToast('オフラインでは取得できません'); return; }

  const CHUNK = 20; // openBD はカンマ区切りでまとめて引ける
  let got = 0;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const batch = targets.slice(i, i + CHUNK);
    showToast(`読みがなを取得中… ${i}/${targets.length}`);
    try {
      const url = `https://api.openbd.jp/v1/get?isbn=${batch.map((b) => encodeURIComponent(b.isbn)).join(',')}`;
      const recs = await (await fetch(url)).json();
      for (let j = 0; j < batch.length; j++) {
        const r = recs[j];
        if (!r) continue;
        const { titleKana, authorKana } = extractReadings(r);
        if (!titleKana && !authorKana) continue;
        batch[j].titleKana = titleKana;
        batch[j].authorKana = authorKana;
        await dbPut(STORES.books, batch[j]);
        got++;
      }
    } catch (e) { /* 取れなかった塊は飛ばす */ }
  }
  updateKanaStatus();
  showToast(got ? `${got}冊の読みがなを取得しました` : '読みがなを取得できませんでした');
});

document.getElementById('forceUpdateBtn').addEventListener('click', async () => {
  const ok = await showConfirm('最新に更新', 'アプリを最新に更新します。保存した本はそのまま残ります。', '更新する');
  if (!ok) return;
  showToast('更新しています…');
  await forceUpdate();
});
document.getElementById('closeSettingsBtn').addEventListener('click', () => closeModal('settingsModal'));

// ── 追加ボタン ──
// 本1冊とシリーズは作り方も後の扱いも違うので、入口から分ける。
// （以前はシリーズを作るのに「本を追加 → 奥のトグルを探す」必要があった）
function toggleFabMenu(show) {
  const menu = document.getElementById('fabMenu');
  const open = show === undefined ? menu.classList.contains('hidden') : show;
  menu.classList.toggle('hidden', !open);
  document.getElementById('fabBtn').classList.toggle('open', open);
}

document.getElementById('fabBtn').addEventListener('click', () => toggleFabMenu());
document.getElementById('fabAddBook').addEventListener('click', () => {
  toggleFabMenu(false);
  openBookModal(null);
});
document.getElementById('fabAddSeries').addEventListener('click', () => {
  toggleFabMenu(false);
  createSeriesFlow();
});
// 余白を触ったら閉じる
document.addEventListener('click', (e) => {
  if (e.target.closest('#fabMenu') || e.target.closest('#fabBtn')) return;
  if (!document.getElementById('fabMenu').classList.contains('hidden')) toggleFabMenu(false);
});

// シリーズを作ってすぐ中身を開く。巻はシリーズ画面から入れる。
async function createSeriesFlow() {
  openBookModal(null);
  document.getElementById('bookModalTitle').textContent = 'シリーズを追加';
  document.getElementById('bookSeriesInput').checked = true;
  updateModalFieldVisibility();
  updateVolumeHint();
}

// ── 本棚の描画 ──
// 本を3冊ずつ棚板（shelf-plank）で区切り、実際の本棚のように見せている。
const SHELF_COLS = 3;

// ── シリーズを棚の上で開く ──
// シリーズを1枚のカード＋要約テキストだけにしていたら「文字でしか確認できず、
// 持っている実感が無い」と言われた。棚の上でそのまま巻を並べて見せられるようにする。
// 開いた状態は覚えておく（毎回開き直すのは面倒なので）。
const EXPANDED_KEY = 'hondana_expanded_series_v1';

function loadExpandedSeries() {
  try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
let expandedSeries = loadExpandedSeries();

function isSeriesExpanded(id) { return expandedSeries.has(id); }

function toggleSeriesExpanded(id) {
  if (expandedSeries.has(id)) expandedSeries.delete(id);
  else expandedSeries.add(id);
  localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedSeries]));
  renderBooks();
}

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

  renderShelfFilter();
  renderTagFilter();
  updateShelfStats();

  const q = searchQuery.trim();
  const passes = (b) => {
    let matchShelf = true;
    if (currentShelfFilter === '__none__') matchShelf = !b.shelfId || !shelfName(b.shelfId);
    else if (currentShelfFilter) matchShelf = b.shelfId === currentShelfFilter;
    const matchTag = !currentTagFilter || (b.tags || []).includes(currentTagFilter);
    // シリーズは中の巻にも当てる（巻の題名やISBNで探してもシリーズが出るように）
    const matchQ = !q || matchesSearch(b, q)
      || (b.isSeries && seriesVolumes(b.id).some((v) => matchesSearch(v, q)));
    return passesStatusFilter(b) && matchShelf && matchTag && matchQ;
  };

  let list = books.filter((b) => {
    // シリーズの巻は、そのシリーズを開いているときだけ棚に出す
    if (b.seriesId) return false;
    if (showArrows) return true; // 編集中は絞り込みを無視して全冊を対象にする
    return passes(b);
  });

  sortBookList(list);

  if (!list.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    emptyText.innerHTML = books.length
      ? '該当する本が見つかりません。'
      : '本棚はまだ空です。<br>＋ボタンで本を追加しましょう。';
    return;
  }
  empty.classList.add('hidden');

  // 棚ごとに区切って描く。棚が1つも無いか、特定の棚だけを見ているときは区切らない
  // （見出しを出しても情報が増えないので）。並び替えの編集中も全冊を平らに並べる。
  const grouped = shelves.length && !currentShelfFilter && !showArrows;
  grid.innerHTML = grouped ? renderGroupedShelves(list, showArrows) : renderShelfSection(list, showArrows);

  attachBookCardHandlers(grid, list, showArrows);
}

function sortBookList(list) {
  if (sortMode === 'manual') {
    // 手動（棚順）は普段の閲覧でもそのまま使う並び。絞り込みと組み合わせても崩れない。
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  } else if (sortMode === 'title') {
    list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
  } else if (sortMode === 'progress') {
    list.sort((a, b) => progressScore(b) - progressScore(a));
  } else {
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  return list;
}

// 棚の並び順どおりに見出し＋本を出し、最後に「棚なし」をまとめる
function renderGroupedShelves(list, showArrows) {
  let html = '';
  for (const shelf of shelves) {
    const inShelf = list.filter((b) => b.shelfId === shelf.id);
    if (!inShelf.length) continue;
    html += `<div class="shelf-label">${escHtml(shelf.name)}<span class="shelf-label-count">${inShelf.length}</span></div>`;
    html += renderShelfSection(inShelf, showArrows);
  }
  const unshelved = list.filter((b) => !b.shelfId || !shelfName(b.shelfId));
  if (unshelved.length) {
    // 棚が1つも使われていないなら、見出しを出さずそのまま並べる（導入直後の見た目を保つ）
    if (html) html += `<div class="shelf-label">棚なし<span class="shelf-label-count">${unshelved.length}</span></div>`;
    html += renderShelfSection(unshelved, showArrows);
  }
  return html;
}

// 状態（未読/読了など）だけの判定。棚にも巻にも使うので外に出してある。
function passesStatusFilter(b) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'favorite') return !!b.favorite;
  // シリーズ本体は状態を持たない（持つのは巻の方）。
  // 本体で判定すると、5巻まで読了でもシリーズごと消えて読了の巻まで見えなくなる。
  // 中の巻がひとつでも当てはまれば出す。
  if (b.isSeries) {
    const vols = seriesVolumes(b.id);
    if (vols.length) return vols.some((v) => v.status === currentFilter);
  }
  return b.status === currentFilter;
}

// 開いているシリーズの巻は**横スクロールの帯**にする。
// 3冊ずつ下に伸ばすと、100巻あれば34段になって他の本が押し流されてしまう。
function renderVolumeStrip(series) {
  const vols = seriesVolumes(series.id).filter(passesStatusFilter);
  if (!vols.length) {
    return `<div class="volume-strip-empty">この絞り込みに当てはまる巻はありません</div>`;
  }
  return `<div class="volume-strip-wrap">
      <div class="volume-strip">${vols.map((v) => renderBookCard(v, false)).join('')}</div>
      <div class="shelf-plank"></div>
    </div>`;
}

// 本を SHELF_COLS 冊ずつの段に分け、各段の下に棚板を敷く。
// その段に開いているシリーズがあれば、直後に巻の帯を差し込む。
function renderShelfSection(list, showArrows) {
  let html = '';
  for (let i = 0; i < list.length; i += SHELF_COLS) {
    const row = list.slice(i, i + SHELF_COLS);
    html += `<div class="shelf-row">${row.map((b) => renderBookCard(b, showArrows)).join('')}</div><div class="shelf-plank"></div>`;
    if (!showArrows) {
      for (const b of row) {
        if (b.isSeries && isSeriesExpanded(b.id)) html += renderVolumeStrip(b);
      }
    }
  }
  return html;
}

// カードの状態表示は1行にまとめる。シリーズだけ3行に増えると、棚に並べたとき
// カードの背丈が揃わなくなるため（巻の範囲・次の巻・抜けを「・」でつないで詰める）。
function bookStatusLine(b, vi) {
  if (vi) {
    if (!vi.count) return { text: '巻がありません', cls: 'missing' };
    const bits = [`${vi.ranges}巻`];
    if (vi.complete) bits.push('✓全巻');
    else if (vi.next) bits.push(`次${vi.next}`);
    return { text: bits.join(' ・ '), cls: vi.complete ? 'done' : (vi.missing.length ? 'missing' : '') };
  }
  if (b.status === 'wishlist') {
    return { text: `🛒 欲しい${b.price ? `　¥${Number(b.price).toLocaleString()}` : ''}`, cls: 'wishlist' };
  }
  if (b.status === 'done') return { text: '✓ 読了', cls: 'done' };
  if (b.status === 'reading' && b.bookmarkPage) {
    return { text: `🔖 ${b.bookmarkPage}${b.totalPages ? ' / ' + b.totalPages : ''}p`, cls: '' };
  }
  return { text: '', cls: '' };
}

// 紙か電子かを表紙の左下に小さく出す。
// シリーズは巻ごとに違うことがある（1〜5巻は紙、6巻から電子など）ので、
// 中身を見て「紙」「電子」「紙+電子」を出し分ける。
const FORMAT_MARK = { paper: '📕', ebook: '📱', both: '📕📱' };

function formatBadge(b, vi) {
  let format = b.format;
  if (vi && vi.count) {
    const set = new Set(vi.vols.map((v) => v.format || 'paper'));
    if (set.has('both') || (set.has('paper') && set.has('ebook'))) format = 'both';
    else format = [...set][0];
  }
  if (!format || format === 'paper') return ''; // 紙は既定なので出さない（うるさくなる）
  return `<div class="book-format-badge">${FORMAT_MARK[format] || ''}</div>`;
}

function renderBookCard(b, showArrows) {
  const hasProgress = b.status === 'reading' && b.totalPages && b.bookmarkPage;
  const pct = hasProgress ? Math.min(100, Math.round((b.bookmarkPage / b.totalPages) * 100)) : null;
  const vi = b.isSeries ? seriesInfo(b) : null;
  // シリーズの表紙が未設定なら、持っている巻の表紙を借りる
  const cover = b.cover || (vi ? (vi.vols.find((v) => v.cover) || {}).cover : null);
  const tagsHtml = `<div class="book-tags">${(b.tags || []).slice(0, 2)
    .map((t) => `<span class="book-tag-chip">${escHtml(t)}</span>`).join('')}</div>`;
  // 読了のオン/オフはカード上のワンタップにはしていない（誤操作の元になるため）。
  // 状態を変えたいときは、本を開いて編集画面の「状態」から選ぶ。
  const moveHtml = showArrows
    ? `<button class="book-move-btn book-move-prev" data-move="${b.id}" data-dir="-1" title="前へ" aria-label="前へ">◀</button>
       <button class="book-move-btn book-move-next" data-move="${b.id}" data-dir="1" title="次へ" aria-label="次へ">▶</button>`
    : '';

  const status = bookStatusLine(b, vi);
  const isVolume = !!b.seriesId;
  const expanded = vi && isSeriesExpanded(b.id);

  return `<div class="book-card ${isVolume ? 'is-volume' : ''}" data-id="${b.id}">
    <div class="book-cover-wrap ${b.status === 'wishlist' ? 'wishlist' : ''} ${expanded ? 'expanded' : ''}">
      <div class="book-cover">
        ${cover ? `<img src="${escHtml(cover)}" alt="${escHtml(b.title)}" loading="lazy">` : bookIcon()}
      </div>
      <button class="book-fav-btn ${b.favorite ? 'active' : ''}" data-fav="${b.id}" title="お気に入り" aria-label="お気に入り">★</button>
      ${vi ? `<button class="book-series-btn" data-series-manage="${b.id}" title="シリーズを管理" aria-label="シリーズを管理">⚙</button>` : ''}
      ${moveHtml}
      ${formatBadge(b, vi)}
      ${vi ? `<div class="book-volume-badge">${vi.count}冊</div>` : ''}
      ${isVolume ? `<div class="book-volume-badge vol">${b.volumeNo}巻</div>` : ''}
      ${pct !== null ? `<div class="book-progress-track"><div class="book-progress-fill" style="width:${pct}%"></div></div>` : ''}
    </div>
    <div class="book-title">${escHtml(isVolume ? `${b.volumeNo}巻` : b.title)}</div>
    <div class="book-author">${isVolume ? '' : (b.author ? escHtml(b.author) : '')}</div>
    <div class="book-status-tag ${status.cls}">${escHtml(status.text)}</div>
    ${vi ? `<div class="book-expand-hint">${expanded ? '▲ 閉じる' : '▼ 全巻を見る'}</div>` : tagsHtml}
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
      if (e.target.closest('.book-fav-btn') || e.target.closest('.book-move-btn')
          || e.target.closest('.book-series-btn')) return;
      const b = books.find((x) => x.id === card.dataset.id);
      if (!b) return;
      // シリーズは棚の上でそのまま開閉する（表紙で見たいので）。管理は⚙から。
      if (b.isSeries) toggleSeriesExpanded(b.id);
      // 巻は軽いシートで（本の編集画面は重すぎる）
      else if (b.seriesId) openVolumeSheet(b.id);
      else openBookModal(b.id);
    });
  });

  grid.querySelectorAll('[data-series-manage]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSeriesModal(btn.dataset.seriesManage);
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

// ══════════════════════════════════════════════
//  シリーズの中身（巻の一覧）
// ══════════════════════════════════════════════
let openSeriesId = null;

function openSeriesModal(seriesId) {
  openSeriesId = seriesId;
  renderSeriesModal();
  openModal('seriesModal');
}

function renderSeriesModal() {
  const series = books.find((b) => b.id === openSeriesId);
  if (!series) { closeModal('seriesModal'); return; }
  const info = seriesInfo(series);

  document.getElementById('seriesModalTitle').textContent = series.title;

  const bits = [];
  if (info.count) {
    bits.push(`<strong>${info.count}冊</strong> 持っています（${escHtml(info.ranges)}巻）`);
    if (info.missing.length) bits.push(`抜けているのは <strong>${escHtml(formatVolumeRanges(info.missing))}巻</strong>`);
    if (info.complete) bits.push('全巻そろっています');
    else if (info.next) bits.push(`次に買うのは <span class="next">${info.next}巻</span>`);
    if (info.remaining) bits.push(`全${info.total}巻まで残り ${info.remaining}冊`);
    // 紙と電子が混ざっているときだけ内訳を出す
    const paper = info.vols.filter((v) => v.format === 'paper' || !v.format || v.format === 'both').length;
    const ebook = info.vols.filter((v) => v.format === 'ebook' || v.format === 'both').length;
    if (paper && ebook) bits.push(`📕 紙 ${paper}冊 ・ 📱 電子 ${ebook}冊`);
  } else {
    bits.push('まだ1冊も入っていません。下のボタンから巻を追加できます。');
  }
  document.getElementById('seriesSummary').innerHTML = bits.join('<br>');

  // 巻の一覧。持っている巻に加えて、間の抜けと（全巻数が分かっていれば）その先も出す。
  // 抜けが一目で分かり、そのままタップで足せるようにするため。
  const upper = Math.max(info.max, info.total || 0);
  const owned = new Map(info.vols.map((v) => [v.volumeNo, v]));
  const cells = [];
  for (let n = 1; n <= upper; n++) {
    const v = owned.get(n);
    if (v) {
      const mark = v.format === 'ebook' ? '📱' : (v.format === 'both' ? '📕📱' : '');
      const state = v.status === 'done' ? 'read' : (v.status === 'reading' ? 'reading' : '');
      cells.push(`<button class="volume-chip owned ${state}" data-vol-open="${escHtml(v.id)}">${n}${mark ? `<span class="vol-mark">${mark}</span>` : ''}</button>`);
    } else if (n >= info.min) {
      cells.push(`<button class="volume-chip missing" data-vol-add="${n}">${n}</button>`);
    }
  }
  // 持っている先の巻を足せるように末尾に＋を置く。
  // これが無いと、5巻まで持っている状態から20巻を足す手段が無かった。
  if (!info.complete) cells.push(`<button class="volume-chip add" data-vol-add="${(info.max || 0) + 1}" title="次の巻を追加">＋</button>`);
  document.getElementById('volumeGrid').innerHTML = cells.join('');

  document.getElementById('volumeGrid').querySelectorAll('[data-vol-open]').forEach((el) => {
    el.addEventListener('click', () => openVolumeSheet(el.dataset.volOpen));
  });
  document.getElementById('volumeGrid').querySelectorAll('[data-vol-add]').forEach((el) => {
    el.addEventListener('click', async () => {
      await addVolumeRecord(series, parseInt(el.dataset.volAdd, 10));
      renderSeriesModal();
      renderBooks();
    });
  });

  renderAbsorbList(series);
}

// シリーズを作る前に1冊ずつ登録していた本を、あとからシリーズへ入れられるようにする。
// 題名がシリーズ名で始まっていて、巻数が読み取れる本を候補に出す。
function absorbCandidates(series) {
  const key = normalizeTitleKey(splitTitleVolume(series.title).base || series.title);
  if (!key) return [];
  return books.filter((b) => {
    if (b.seriesId || b.isSeries || b.id === series.id) return false;
    const { base, vol } = splitTitleVolume(b.title);
    return vol && normalizeTitleKey(base) === key;
  }).map((b) => ({ book: b, vol: splitTitleVolume(b.title).vol }))
    .sort((a, b) => a.vol - b.vol);
}

function renderAbsorbList(series) {
  const group = document.getElementById('absorbGroup');
  const list = document.getElementById('absorbList');
  const cands = absorbCandidates(series);
  group.classList.toggle('hidden', !cands.length);
  if (!cands.length) return;

  list.innerHTML = cands.map(({ book, vol }) =>
    `<div class="absorb-row">
      <span class="absorb-name">${escHtml(book.title)}</span>
      <button class="absorb-btn" data-absorb="${escHtml(book.id)}" data-vol="${vol}">${vol}巻として入れる</button>
    </div>`).join('');

  list.querySelectorAll('[data-absorb]').forEach((el) => {
    el.addEventListener('click', () => absorbBookIntoSeries(el.dataset.absorb, parseInt(el.dataset.vol, 10)));
  });
}

// すでに棚にある本をシリーズの1冊にする。本は消さず、付け替えるだけ。
async function absorbBookIntoSeries(bookId, vol) {
  const series = books.find((b) => b.id === openSeriesId);
  const book = books.find((b) => b.id === bookId);
  if (!series || !book) return;
  if (seriesVolumes(series.id).some((v) => v.volumeNo === vol)) {
    showToast(`${vol}巻はすでにシリーズにあります`);
    return;
  }
  book.seriesId = series.id;
  book.volumeNo = vol;
  if (!book.shelfId) book.shelfId = series.shelfId || null;
  await dbPut(STORES.books, book);
  renderSeriesModal();
  renderBooks();
  showToast(`「${book.title}」を${vol}巻として入れました`);
}

// ── 1巻ぶんの軽い操作 ──
// 巻をタップして本の編集画面（ISBN・棚・タグ・評価・メモまである）が開くのは重すぎるので、
// よく使う「状態」と「紙/電子」と「外す」だけを出す。細かい編集はそこから辿れる。
let openVolumeId = null;

function openVolumeSheet(volumeId) {
  const v = books.find((b) => b.id === volumeId);
  if (!v) return;
  openVolumeId = volumeId;
  document.getElementById('volumeModalTitle').textContent = `${v.volumeNo}巻`;
  document.querySelectorAll('#volumeStatusSelector .status-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === (v.status || 'unread'));
  });
  document.querySelectorAll('#volumeFormatSelector .status-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === (v.format || 'paper'));
  });
  openModal('volumeModal');
}

async function updateOpenVolume(patch) {
  const v = books.find((b) => b.id === openVolumeId);
  if (!v) return;
  Object.assign(v, patch);
  await dbPut(STORES.books, v);
  renderSeriesModal();
  renderBooks();
}

document.querySelectorAll('#volumeStatusSelector .status-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('#volumeStatusSelector .status-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    await updateOpenVolume({ status: btn.dataset.value });
  });
});
document.querySelectorAll('#volumeFormatSelector .status-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('#volumeFormatSelector .status-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    await updateOpenVolume({ format: btn.dataset.value });
  });
});

document.getElementById('volumeCloseBtn').addEventListener('click', () => closeModal('volumeModal'));
document.getElementById('volumeDetailBtn').addEventListener('click', () => {
  const id = openVolumeId;
  closeModal('volumeModal');
  closeModal('seriesModal');
  openBookModal(id);
});
document.getElementById('volumeDeleteBtn').addEventListener('click', async () => {
  const v = books.find((b) => b.id === openVolumeId);
  if (!v) return;
  const ok = await showConfirm('巻を外す', `${v.volumeNo}巻をシリーズから外して削除しますか？`, '外す');
  if (!ok) return;
  books = books.filter((b) => b.id !== v.id);
  await dbDelete(STORES.books, v.id);
  closeModal('volumeModal');
  renderSeriesModal();
  renderBooks();
  showToast(`${v.volumeNo}巻を外しました`);
});

// ── まとめて操作 ──
// 「105巻まで読んだ」を1冊ずつ設定するのは現実的でないので、まとめて変えられるようにする。
document.getElementById('bulkReadBtn').addEventListener('click', async () => {
  const series = books.find((b) => b.id === openSeriesId);
  const upto = parseInt(document.getElementById('bulkReadTo').value, 10);
  if (!series || !upto) { showToast('巻を入力してください'); return; }
  const targets = seriesVolumes(series.id).filter((v) => v.volumeNo <= upto && v.status !== 'done');
  if (!targets.length) { showToast('変わる巻がありません'); return; }
  for (const v of targets) { v.status = 'done'; await dbPut(STORES.books, v); }
  renderSeriesModal();
  renderBooks();
  showToast(`${upto}巻までを読了にしました（${targets.length}冊）`);
});

document.getElementById('bulkAddBtn').addEventListener('click', async () => {
  const series = books.find((b) => b.id === openSeriesId);
  const from = parseInt(document.getElementById('bulkAddFrom').value, 10);
  const to = parseInt(document.getElementById('bulkAddTo').value, 10);
  if (!series || !from || !to) { showToast('範囲を入力してください'); return; }
  const [a, b] = from <= to ? [from, to] : [to, from];
  if (b - a > VOLUME_MAX_SPAN) { showToast('範囲が広すぎます'); return; }
  let added = 0;
  for (let n = a; n <= b; n++) if (await addVolumeRecord(series, n)) added++;
  document.getElementById('bulkAddFrom').value = '';
  document.getElementById('bulkAddTo').value = '';
  renderSeriesModal();
  renderBooks();
  showToast(added ? `${added}冊を追加しました` : 'すでにすべてあります');
});

// ── 棚にある本を選んでシリーズに入れる ──
// 題名が一致する本しか候補に出さず、しかも候補が無いと欄ごと消える作りだったので、
// 「どうやって入れるのか分からない」状態になっていた。
// ここでは**棚にある本を全部出す**（題名が違っても自分で選べる）。
// 巻数は題名から推測して入れておくが、その場で直せる。
let pickerSearch = '';

function eligibleBooksForSeries(series) {
  return books.filter((b) => !b.seriesId && !b.isSeries && b.id !== series.id);
}

function renderBookPicker() {
  const series = books.find((b) => b.id === openSeriesId);
  if (!series) return;
  const list = document.getElementById('pickerList');
  const q = pickerSearch.trim();
  const info = seriesInfo(series);
  const taken = new Set(info.nums);
  const seriesKey = normalizeTitleKey(splitTitleVolume(series.title).base || series.title);

  let cands = eligibleBooksForSeries(series);
  if (q) cands = cands.filter((b) => matchesSearch(b, q));

  // 題名がシリーズ名で始まる本を上に出す（たいていはこれを探しているので）
  const scored = cands.map((b) => {
    const { base, vol } = splitTitleVolume(b.title);
    const suggested = normalizeTitleKey(base) === seriesKey;
    return { book: b, vol: vol || null, suggested };
  }).sort((a, b) => (b.suggested - a.suggested) || ((a.vol || 9999) - (b.vol || 9999)));

  if (!scored.length) {
    list.innerHTML = `<p class="picker-empty">${q ? '見つかりませんでした。' : '入れられる本が棚にありません。'}</p>`;
    return;
  }

  // 巻数の初期値：題名から読めればそれ、読めなければ空いている一番小さい番号
  let fallback = 1;
  const nextFree = () => { while (taken.has(fallback)) fallback++; return fallback; };

  list.innerHTML = scored.map(({ book, vol, suggested }) => {
    const v = vol && !taken.has(vol) ? vol : nextFree();
    return `<div class="picker-row ${suggested ? 'picker-suggested' : ''}">
      <div class="picker-info">
        <div class="picker-name">${escHtml(book.title)}</div>
        <div class="picker-sub">${escHtml(book.author || '著者なし')}</div>
      </div>
      <input class="form-input picker-vol" type="number" min="1" inputmode="numeric"
             value="${v}" data-vol-for="${escHtml(book.id)}">
      <button class="picker-add" data-pick-book="${escHtml(book.id)}">巻として入れる</button>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-pick-book]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.pickBook;
      const input = list.querySelector(`[data-vol-for="${CSS.escape(id)}"]`);
      const vol = parseInt(input.value, 10);
      if (!vol) { showToast('巻数を入れてください'); return; }
      await absorbBookIntoSeries(id, vol);
      renderBookPicker();
    });
  });
}

document.getElementById('seriesPickBtn').addEventListener('click', () => {
  pickerSearch = '';
  document.getElementById('pickerSearch').value = '';
  renderBookPicker();
  openModal('bookPickerModal');
});
document.getElementById('pickerSearch').addEventListener('input', (e) => {
  pickerSearch = e.target.value;
  renderBookPicker();
});
document.getElementById('pickerCloseBtn').addEventListener('click', () => closeModal('bookPickerModal'));

document.getElementById('seriesCloseBtn').addEventListener('click', () => closeModal('seriesModal'));

document.getElementById('seriesAddNextBtn').addEventListener('click', async () => {
  const series = books.find((b) => b.id === openSeriesId);
  if (!series) return;
  const info = seriesInfo(series);
  if (!info.next) { showToast('全巻そろっています'); return; }
  await addVolumeRecord(series, info.next);
  renderSeriesModal();
  renderBooks();
  showToast(`${info.next}巻を追加しました`);
});

document.getElementById('seriesEditBtn').addEventListener('click', () => {
  const id = openSeriesId;
  closeModal('seriesModal');
  openBookModal(id);
});

// ── 本の追加・編集モーダル ──
function openBookModal(id) {
  editingBookId = id;
  pendingCoverDataUrl = null;
  pendingLabelHint = null; // 前回読み取ったレーベルを引きずらない（棚の学習が汚れるため）
  pendingReadings = null;
  const b = id ? books.find((x) => x.id === id) : null;

  document.getElementById('bookModalTitle').textContent = b ? '本を編集' : '本を追加';
  document.getElementById('bookTitleInput').value = b ? b.title : '';
  document.getElementById('bookAuthorInput').value = b ? (b.author || '') : '';
  renderShelfPicker(b ? b.shelfId : defaultShelfIdForNewBook(null));
  setFormat(b ? b.format : 'paper');
  renderStorePicker(b ? b.store : null);
  document.getElementById('bookTagsInput').value = b && b.tags ? b.tags.join(', ') : '';
  document.getElementById('bookMemoInput').value = b ? (b.memo || '') : '';
  document.getElementById('bookBookmarkInput').value = b && b.bookmarkPage ? b.bookmarkPage : '';
  document.getElementById('bookTotalPagesInput').value = b && b.totalPages ? b.totalPages : '';
  document.getElementById('bookFavoriteInput').checked = !!(b && b.favorite);
  document.getElementById('bookSeriesInput').checked = !!(b && b.isSeries);
  document.getElementById('bookTotalVolumesInput').value = b && b.totalVolumes ? b.totalVolumes : '';
  document.getElementById('bookPriceInput').value = b && b.price ? b.price : '';
  document.getElementById('deleteBookBtn').style.display = b ? '' : 'none';
  document.getElementById('isbnInput').value = b && b.isbn ? b.isbn : '';
  hideDuplicateWarning();

  const status = (b && b.status) || 'unread';
  document.querySelectorAll('#bookStatusSelector .status-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === status);
  });
  updateModalFieldVisibility();
  updateVolumeHint();

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
    updateModalFieldVisibility();
  });
});

function currentModalStatus() {
  const btn = document.querySelector('#bookStatusSelector .status-btn.active');
  return btn ? btn.dataset.value : 'unread';
}

// ── 紙 / 電子 ──
let pendingFormat = 'paper';
let pendingStore = null;

function setFormat(format) {
  pendingFormat = format || 'paper';
  document.querySelectorAll('#bookFormatSelector .status-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === pendingFormat);
  });
  updateModalFieldVisibility();
}

document.querySelectorAll('#bookFormatSelector .status-btn').forEach((btn) => {
  btn.addEventListener('click', () => setFormat(btn.dataset.value));
});

function renderStorePicker(selected) {
  pendingStore = EBOOK_STORES.includes(selected) ? selected : null;
  const picker = document.getElementById('bookStorePicker');
  picker.innerHTML = EBOOK_STORES.map((s) =>
    `<button type="button" class="store-pick-btn ${pendingStore === s ? 'active' : ''}" data-store="${escHtml(s)}">${escHtml(s)}</button>`
  ).join('');
  picker.querySelectorAll('.store-pick-btn').forEach((el) => {
    el.addEventListener('click', () => {
      // もう一度押したら選択を外せる
      pendingStore = pendingStore === el.dataset.store ? null : el.dataset.store;
      picker.querySelectorAll('.store-pick-btn')
        .forEach((x) => x.classList.toggle('active', x.dataset.store === pendingStore));
    });
  });
}

// 状態とシリーズ設定に応じて、意味を持たない入力欄を隠す。
// **隠すだけで値は消さない**（保存処理側で、隠れている項目は既存値を持ち越す）。
function updateModalFieldVisibility() {
  const isWishlist = currentModalStatus() === 'wishlist';
  const isSeries = document.getElementById('bookSeriesInput').checked;
  // ストアは電子を持っているときだけ聞く
  document.getElementById('storeFieldGroup')
    .classList.toggle('hidden', pendingFormat !== 'ebook' && pendingFormat !== 'both');
  // シリーズは入れ物なので、1冊ぶんの項目（電子栞・ISBN）は意味を持たない。
  // 状態や紙/電子も巻ごとに持つので、入れ物側では聞かない。
  document.getElementById('bookmarkFieldGroup').classList.toggle('hidden', isWishlist || isSeries);
  document.getElementById('ratingFieldGroup').classList.toggle('hidden', isWishlist);
  document.getElementById('priceFieldGroup').classList.toggle('hidden', !isWishlist);
  document.getElementById('seriesFieldGroup').classList.toggle('hidden', !isSeries);
  document.getElementById('isbnFieldGroup').classList.toggle('hidden', isSeries);
}

document.getElementById('bookSeriesInput').addEventListener('change', () => {
  updateModalFieldVisibility();
  updateVolumeHint();
});

// 編集画面には全巻数しか無い（巻の出し入れはシリーズを開いて行う）ので、
// 今どうなっているかだけを一言で出す。
function updateVolumeHint() {
  const hint = document.getElementById('volumeHint');
  const series = editingBookId ? books.find((b) => b.id === editingBookId) : null;
  if (!series || !series.isSeries) {
    hint.textContent = '保存したあと、シリーズを開いて巻を追加できます。';
    return;
  }
  const info = seriesInfo({ ...series, totalVolumes: parseInt(document.getElementById('bookTotalVolumesInput').value, 10) || 0 });
  if (!info.count) { hint.textContent = 'まだ巻が入っていません。シリーズを開いて追加できます。'; return; }
  const parts = [`${info.count}冊（${info.ranges}巻）`];
  if (info.missing.length) parts.push(`抜け: ${formatVolumeRanges(info.missing)}巻`);
  if (info.complete) parts.push('全巻そろっています');
  else if (info.next) parts.push(`次は ${info.next}巻`);
  if (info.remaining) parts.push(`全${info.total}巻まで残り ${info.remaining}冊`);
  hint.textContent = parts.join(' ・ ');
}
document.getElementById('bookTotalVolumesInput').addEventListener('input', updateVolumeHint);

// 編集画面の棚選び。棚が1つも無ければ行ごと隠す。
// 以前は小さな <select> だったが「見逃しやすい」ため、状態と同じ大きさのボタンに変えた。
let pendingShelfId = null;

function renderShelfPicker(selectedId) {
  const group = document.getElementById('shelfFieldGroup');
  const picker = document.getElementById('bookShelfPicker');
  group.classList.toggle('hidden', !shelves.length);
  pendingShelfId = selectedId && shelves.some((s) => s.id === selectedId) ? selectedId : null;

  const btn = (val, label) =>
    `<button type="button" class="shelf-pick-btn ${pendingShelfId === val ? 'active' : ''}" data-pick="${escHtml(val || '')}">${escHtml(label)}</button>`;
  picker.innerHTML = shelves.map((s) => btn(s.id, s.name)).join('') + btn('', '棚に入れない');

  picker.querySelectorAll('.shelf-pick-btn').forEach((el) => {
    el.addEventListener('click', () => {
      pendingShelfId = el.dataset.pick || null;
      picker.querySelectorAll('.shelf-pick-btn').forEach((x) => x.classList.toggle('active', x === el));
    });
  });
}

// 新しい本をどの棚に入れるか、なるべく選ばせずに決める。
//   1. その棚を見ているところなら、その棚
//   2. openBD のレーベル名から推測（「〜コミックス」なら漫画の棚）
//   3. 前回入れた棚
// あくまで初期値。ボタンは大きく出ているので、違えばその場で押し替えられる。
const LAST_SHELF_KEY = 'hondana_last_shelf_v1';
const LABEL_SHELF_KEY = 'hondana_label_shelf_v1';

// 読み取った本のレーベル名（「ジャンプ・コミックス」等）。棚を覚えるときの手がかりに使う。
let pendingLabelHint = null;
// 読み取った本の読み仮名。保存時に本へ持たせる。
let pendingReadings = null;

// openBD にはジャンル分類（Cコード）が入っていないので、正しく自動判別する手段は無い。
// 代わりに**使っているうちに覚える**ようにしてある。
// 「このレーベルの本はこの棚に入れた」を記録し、次に同じレーベルを読んだらそこを初期値にする。
function loadLabelShelfMap() {
  try { return JSON.parse(localStorage.getItem(LABEL_SHELF_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}

function rememberLabelShelf(label, shelfId) {
  if (!label || !shelfId) return;
  const map = loadLabelShelfMap();
  map[String(label).trim()] = shelfId;
  localStorage.setItem(LABEL_SHELF_KEY, JSON.stringify(map));
}

function guessShelfIdFromLabel(label) {
  if (!label) return null;
  // まず「前にこのレーベルを入れた棚」。使うほど当たるようになる
  const learned = loadLabelShelfMap()[String(label).trim()];
  if (learned && shelves.some((s) => s.id === learned)) return learned;
  // 覚えが無ければレーベル名からの当てずっぽう
  const isComic = /コミック|comics?|manga/i.test(label);
  const isPicture = /絵本|童話|picture ?book/i.test(label);
  const isNovel = /文庫|新書|小説|fiction|novel/i.test(label);
  const find = (re) => (shelves.find((s) => re.test(s.name)) || {}).id || null;
  if (isComic) return find(/漫画|マンガ|まんが|コミック/);
  if (isPicture) return find(/絵本|童話/);
  if (isNovel) return find(/小説|文庫/);
  return null;
}

function defaultShelfIdForNewBook(labelHint) {
  if (currentShelfFilter && currentShelfFilter !== '__none__'
      && shelves.some((s) => s.id === currentShelfFilter)) return currentShelfFilter;
  const guessed = guessShelfIdFromLabel(labelHint || pendingLabelHint);
  if (guessed) return guessed;
  const last = localStorage.getItem(LAST_SHELF_KEY);
  return last && shelves.some((s) => s.id === last) ? last : null;
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

// openBD は書誌は良いが**表紙がほぼ空**（実際に漫画・文庫・絵本で確認して3冊とも空だった）。
// なので表紙は Google Books を控えとして引く。こちらはキー不要で ISBN 検索ができる。
// 見つからない・繋がらない場合は静かに諦める（表紙は無くても本棚は成り立つ）。
async function fetchFromGoogleBooks(isbn) {
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const info = data.items && data.items[0] && data.items[0].volumeInfo;
  if (!info) throw new Error('見つかりません');
  const link = info.imageLinks && (info.imageLinks.thumbnail || info.imageLinks.smallThumbnail);
  return {
    title: info.title || null,
    // http で返ってくることがある。edge=curl はページの折れ角の装飾なので外す。
    url: link ? link.replace(/^http:/, 'https:').replace(/&edge=curl/, '') : null,
    categories: info.categories || null,
  };
}

// openBD は ASCII の題名を「先頭だけ大文字」に正規化して持っている。
// 実データで確認: ONE PIECE→"One piece" / WILD HALF→"Wild half" / HUNTER×HUNTER→"Hunter×hunter"。
// 図書館の目録の作法なので openBD 側では直らない。
// そこで Google Books が**同じ本**を返したときだけ、大文字が多い方（元の表記に近い方）を採る。
// 別の本にすり替わらないよう、英数字だけを取り出した並びが一致する場合に限る。
function betterCasedTitle(openbdTitle, googleTitle) {
  if (!openbdTitle) return googleTitle || '';
  if (!googleTitle) return openbdTitle;
  const key = (s) => (String(s).match(/[A-Za-z0-9]/g) || []).join('').toUpperCase();
  if (!key(openbdTitle) || key(openbdTitle) !== key(googleTitle)) return openbdTitle;
  const caps = (s) => (String(s).match(/[A-Z]/g) || []).length;
  return caps(googleTitle) > caps(openbdTitle) ? googleTitle : openbdTitle;
}

// openBD には「I''s」のようにアポストロフィが重なっている題名がある
function tidyTitle(t) {
  return String(t || '').replace(/''/g, "'").replace(/\s+/g, ' ').trim();
}

// openBD の onix から読み仮名（collationkey）を取り出す。
// 例）尾田栄一郎 → 「オダ, エイイチロウ」 / 吾輩は猫である → 「ワガハイ ワ ネコ デ アル」
// これを持っておくと「おだ」「わがはい」のような読みで引ける（読み辞書は要らない）。
// ただし ASCII の題名（One piece）には読みが入らないので「ワンピース」では引けない。
function extractReadings(rec) {
  const dd = (rec && rec.onix && rec.onix.DescriptiveDetail) || {};
  const tt = ((dd.TitleDetail || {}).TitleElement || {}).TitleText || {};
  const person = ((dd.Contributor || [])[0] || {}).PersonName || {};
  const clean = (s) => String(s || '')
    .replace(/,?\s*\d{3,4}-\d{0,4}\s*$/, '') // 「, 1867-1916」のような生没年を落とす
    .replace(/[,、]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    titleKana: clean(tt.collationkey) || null,
    authorKana: clean(person.collationkey) || null,
  };
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

// ── 重複チェック ──
// 書店で「これ持ってたっけ？」を防ぐのが目的なので、読み取った直後に知らせる。
// ISBNが一致すれば確実。手で登録した本はISBNを持たないので、タイトル一致も見る。
function findDuplicateBook(isbn, title) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  if (isbn) {
    const byIsbn = books.find((b) => b.isbn && b.isbn === isbn && b.id !== editingBookId);
    if (byIsbn) return byIsbn;
  }
  if (title) {
    const t = norm(title);
    return books.find((b) => norm(b.title) === t && b.id !== editingBookId) || null;
  }
  return null;
}

function hideDuplicateWarning() {
  document.getElementById('dupWarning').classList.add('hidden');
}

// 追加画面の上に出す「一言＋ボタン」の共通の入れ物（重複警告・シリーズへの追加で使う）
function showBanner(html, buttonLabel, onClick) {
  const box = document.getElementById('dupWarning');
  document.getElementById('dupWarningText').innerHTML = html;
  const btn = document.getElementById('dupWarningBtn');
  btn.textContent = buttonLabel;
  btn.onclick = onClick;
  box.classList.remove('hidden');
}

// ── シリーズの巻を拾う ──
// 「One piece 巻1」「ONE PIECE 106」「◯◯ 第3巻」から作品名と巻数に分ける。
// 「1Q84」のような題名を誤って分けることもあるが、既存のシリーズと名前が一致したときしか
// 使わないので実害は出ない。
function splitTitleVolume(title) {
  const t = String(title || '').trim();
  const m = t.match(/^(.+?)[\s　]*(?:第|vol\.?|巻)?[\s　]*(\d{1,4})[\s　]*巻?$/i);
  if (!m) return { base: t, vol: null };
  const base = m[1].replace(/[\s　,、.。:：\-–—]+$/, '').trim();
  const vol = parseInt(m[2], 10);
  if (!base || !vol) return { base: t, vol: null };
  return { base, vol };
}

function normalizeTitleKey(s) {
  return String(s || '').toLowerCase().replace(/[\s　・･:：\-–—~〜]/g, '');
}

// 読み取った本が、すでに登録してあるシリーズの1冊かどうかを探す
function findSeriesForTitle(title) {
  const { base, vol } = splitTitleVolume(title);
  if (!vol || !base) return null;
  const key = normalizeTitleKey(base);
  const book = books.find((b) => b.isSeries && b.id !== editingBookId
    && normalizeTitleKey(splitTitleVolume(b.title).base || b.title) === key);
  return book ? { book, vol } : null;
}

// 読み取った巻を、確認を挟まずシリーズへ入れる。
// 入れた結果はシリーズ画面を開いて見せ、間違いならその場で「外す」で戻せる。
async function autoAddScannedVolume(series, vol, scanned = {}) {
  const extra = {};
  if (scanned.isbn) extra.isbn = scanned.isbn;
  if (scanned.cover) extra.cover = scanned.cover;
  const added = await addVolumeRecord(series, vol, extra);
  if (!added) return;
  hideDuplicateWarning();
  closeModal('bookModal');
  renderBooks();
  openSeriesModal(series.id);
  showToast(`「${series.title}」に${vol}巻を入れました`);
}

// シリーズに1巻ぶん足す（1冊のレコードとして作る）
async function addVolumeToSeries(series, vol) {
  const added = await addVolumeRecord(series, vol);
  if (!added) { showToast(`「${series.title}」の${vol}巻はすでにあります`); return; }
  hideDuplicateWarning();
  closeModal('bookModal');
  renderBooks();
  showToast(`「${series.title}」に${vol}巻を追加しました（${seriesVolumes(series.id).length}冊）`);
}

const DUP_STATUS_LABEL = { wishlist: '欲しいリスト', unread: '未読', reading: '読書中', done: '読了' };

function showDuplicateWarning(dup) {
  const label = DUP_STATUS_LABEL[dup.status] || dup.status;
  if (dup.status === 'wishlist') {
    showBanner(
      `<strong>${escHtml(dup.title)}</strong> は欲しいリストに入っています。`,
      '買ったので未読にする',
      async () => {
        dup.status = 'unread';
        await dbPut(STORES.books, dup);
        hideDuplicateWarning();
        closeModal('bookModal');
        renderBooks();
        showToast('「未読」に変えました');
      }
    );
  } else {
    showBanner(
      `<strong>${escHtml(dup.title)}</strong> はすでに本棚にあります（${escHtml(label)}）。`,
      'その本を開く',
      () => { hideDuplicateWarning(); openBookModal(dup.id); }
    );
  }
}

// 読み取った本が「◯◯ 106」のように巻数を持っていたときの導線。
//   ・同じ作品のシリーズが既にある → その巻を足す（1タップ）
//   ・まだ無い → その本をシリーズの始まりとしてまとめる
// 巻ごとに1冊ずつ登録すると棚が埋まってしまうので、数字を手で打たずに済むようにしてある。
function offerSeriesAction(rawTitle, scanned = {}) {
  const hit = findSeriesForTitle(rawTitle);
  if (hit) {
    const already = seriesVolumes(hit.book.id).some((v) => v.volumeNo === hit.vol);
    if (already) {
      showBanner(
        `<strong>${escHtml(hit.book.title)}</strong> の ${hit.vol}巻 はすでに持っています。`,
        'シリーズを開く',
        () => { hideDuplicateWarning(); closeModal('bookModal'); openSeriesModal(hit.book.id); }
      );
      return;
    }
    // 作品名も巻数も一致しているので、確認を挟まずそのまま入れる。
    // 押し間違いではなく「読み取った本を棚に入れる」だけなので、取り消せれば十分。
    autoAddScannedVolume(hit.book, hit.vol, scanned);
    return;
  }

  const { base, vol } = splitTitleVolume(rawTitle);
  if (!vol) return;
  showBanner(
    `<strong>${escHtml(base)}</strong> の ${vol}巻 のようです。シリーズとしてまとめますか？`,
    'シリーズにする',
    // シリーズ本を作り、その場で読み取った巻を1冊目として入れる
    async () => {
      const series = {
        id: uid(), title: base, isSeries: true,
        author: document.getElementById('bookAuthorInput').value.trim(),
        shelfId: pendingShelfId || null,
        status: 'unread', tags: [],
        // 読み取った表紙はシリーズの顔として使う（1巻の表紙になることが多い）
        cover: scanned.cover || null,
        format: pendingFormat || 'paper',
        store: pendingStore || null,
        order: books.reduce((m, x) => Math.max(m, x.order ?? -1), -1) + 1,
        createdAt: Date.now(),
      };
      books.push(series);
      await dbPut(STORES.books, series);
      await addVolumeRecord(series, vol, scanned.isbn ? { isbn: scanned.isbn, cover: scanned.cover || null } : {});
      hideDuplicateWarning();
      closeModal('bookModal');
      renderBooks();
      openSeriesModal(series.id);
      showToast(`「${base}」を作って${vol}巻を入れました`);
    }
  );
}

// openBD（https://openbd.jp/）は国内書誌データベース。APIキー不要・CORS対応。
async function handleIsbnLookup(rawIsbn) {
  const isbn = String(rawIsbn).replace(/[^0-9Xx]/g, '');
  if (isbn.length < 9) { showToast('ISBNの形式が正しくありません'); return; }
  document.getElementById('isbnInput').value = isbn;

  // 通信の前に、ISBNだけで分かる重複を先に知らせる（圏外でも効くように）
  const knownByIsbn = findDuplicateBook(isbn, null);
  if (knownByIsbn) showDuplicateWarning(knownByIsbn);
  else hideDuplicateWarning();

  showToast('書籍情報を検索中…');
  try {
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`);
    const data = await res.json();
    const rec = data && data[0];
    if (!rec || !rec.summary) { showToast('見つかりませんでした。手入力してください'); return; }
    const s = rec.summary;
    // タイトルが分かったので、ISBNを持たない手入力の本とも突き合わせる
    let dup = knownByIsbn;
    if (!dup) {
      dup = findDuplicateBook(isbn, s.title);
      if (dup) showDuplicateWarning(dup);
    }
    let title = tidyTitle(s.title);
    if (s.author) document.getElementById('bookAuthorInput').value = cleanAuthorName(s.author);
    // 読み仮名を控えておく（保存時に本へ持たせる）。「おだ」で「尾田」が引けるようになる。
    pendingReadings = extractReadings(rec);

    // 棚は、読み取ったレーベル名（「ジャンプ・コミックス」等）も手がかりにして先に選んでおく
    pendingLabelHint = s.series || null;

    // 表紙と題名の表記は Google Books にも当たる。
    // openBD は表紙がほぼ空で、題名も ASCII を「先頭だけ大文字」に正規化してしまうため。
    let coverUrl = s.cover || null;
    try {
      const g = await fetchFromGoogleBooks(isbn);
      title = betterCasedTitle(title, tidyTitle(g.title));
      if (!coverUrl) coverUrl = g.url;
      if (g.categories) pendingLabelHint = (pendingLabelHint || '') + ' ' + g.categories.join(' ');
    } catch (e) { /* 繋がらなくても openBD の内容だけで成立する */ }

    if (title) document.getElementById('bookTitleInput').value = title;
    if (!editingBookId) renderShelfPicker(defaultShelfIdForNewBook(pendingLabelHint));

    // できれば表紙を端末に取り込む（縮小済みの data URL）。そうすればオフラインでも見えるし、
    // 相手側のリンクが切れても残る。取り込めなければURLのまま持つ
    // （その場合オフラインでは出ないが、カード側で本のアイコンに落ちる）。
    if (coverUrl) {
      let cover = coverUrl;
      try { cover = await localizeCoverUrl(coverUrl); } catch (e) { /* URLのまま使う */ }
      setCoverPreview(cover);
    }

    // 巻数が読み取れたら、シリーズにまとめる導線を出す。
    // 同じ本が既にある（＝重複）ときは、そちらの案内を優先する。
    // 表紙まで揃えてから呼ぶので、シリーズへ入る巻にも表紙とISBNが残る。
    if (!dup) offerSeriesAction(title, { isbn, cover: pendingCoverDataUrl });

    showToast(coverUrl ? '書籍情報を取得しました' : '書籍情報を取得しました（表紙は見つかりませんでした）');
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
// 2通りの経路がある。
//   1. ブラウザ標準の BarcodeDetector（Shape Detection API）— Android/PCのChromeなど
//   2. 同梱の ZXing（vendor/zxing.min.js）— iPhone(Safari)のように 1 が無い端末
// 1 が使えるならそちらを優先し、ZXing は読み込まない（354KBを無駄に解析しないため）。

// 日本の書籍のバーコードは2段組で、上段が 978/979 で始まるISBN、
// 下段は 192… で始まる分類・価格コード。下段を読んでも書誌は引けないので採用しない
// （読み飛ばして、上段が読めるまでスキャンを続ける）。
function isIsbnBarcode(value) {
  return /^97[89]\d{10}$/.test(String(value || '').trim());
}

function isCameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

// ZXing は使うときになって初めて読み込む。
// Service Worker がプリキャッシュしているので、2回目以降とオフラインでも読める。
let _zxingLoading = null;
function ensureZXing() {
  if (window.ZXing) return Promise.resolve();
  if (_zxingLoading) return _zxingLoading;
  _zxingLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/zxing.min.js';
    s.onload = () => resolve();
    s.onerror = () => { _zxingLoading = null; reject(new Error('読み取り用ファイルを読み込めませんでした')); };
    document.head.appendChild(s);
  });
  return _zxingLoading;
}

let _scanStopped = false;
// ホーム画面から読み取ったときは、成功して初めて追加画面を開く。
// 先に開いてしまうと、読み取りをやめたときに空の追加画面が残って邪魔になる。
let _scanOpensModal = false;

async function startBarcodeScan(opts = {}) {
  if (!isCameraSupported()) { showToast('この端末ではカメラを使えません'); return; }
  _scanOpensModal = !!opts.openModal;
  const video = document.getElementById('scanVideo');
  _scanStopped = false;
  document.getElementById('scanOverlay').classList.remove('hidden');
  document.getElementById('scanCloseBtn').onclick = stopBarcodeScan;

  try {
    if (isBarcodeSupported()) await scanWithBarcodeDetector(video);
    else await scanWithZXing(video);
  } catch (e) {
    stopBarcodeScan();
    showToast(/Permission|NotAllowed/i.test(String(e && e.name) + String(e && e.message))
      ? 'カメラの使用が許可されませんでした'
      : 'カメラを使用できませんでした');
  }
}

// 見つかったコードを受け取る共通処理。ISBN以外なら false を返して読み取りを続けさせる。
function onBarcodeFound(value) {
  if (_scanStopped || !isIsbnBarcode(value)) return false;
  stopBarcodeScan();
  // openBookModal は入力欄を初期化するので、必ず読み取り結果を入れる前に呼ぶ
  if (_scanOpensModal) openBookModal(null);
  handleIsbnLookup(value);
  return true;
}

async function scanWithBarcodeDetector(video) {
  scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  video.srcObject = scanStream;
  await video.play();

  const detector = new BarcodeDetector({ formats: ['ean_13'] });
  const tick = async () => {
    if (_scanStopped) return;
    try {
      for (const code of await detector.detect(video)) {
        if (onBarcodeFound(code.rawValue)) return;
      }
    } catch (e) { /* 検出失敗はそのまま次のフレームへ */ }
    requestAnimationFrame(tick);
  };
  tick();
}

async function scanWithZXing(video) {
  await ensureZXing();
  if (_scanStopped) return; // 読み込んでいる間に閉じられた
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]);
  zxingReader = new ZXing.BrowserMultiFormatReader(hints);
  // カメラの開閉は ZXing 側に任せる（stopBarcodeScan の reset() で止まる）
  await zxingReader.decodeFromConstraints(
    { video: { facingMode: 'environment' } },
    video,
    (result) => { if (result) onBarcodeFound(result.getText()); }
  );
}

function stopBarcodeScan() {
  _scanStopped = true;
  document.getElementById('scanOverlay').classList.add('hidden');
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
  if (zxingReader) {
    try { zxingReader.reset(); } catch (e) { /* すでに停止済み */ }
    zxingReader = null;
  }
  document.getElementById('scanVideo').srcObject = null;
}

// 追加画面の中から（すでに画面が開いているので開き直さない）
document.getElementById('scanIsbnBtn').addEventListener('click', () => startBarcodeScan());
// ホーム画面から（書店で「持ってたっけ？」を確認する用。読み取れたら追加画面が開く）
document.getElementById('headerScanBtn').addEventListener('click', () => startBarcodeScan({ openModal: true }));

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
  // 価格の欄は欲しいリストのときしか出していないので、それ以外は既存値を持ち越す
  const price = isWishlist
    ? parseInt(document.getElementById('bookPriceInput').value, 10) || 0
    : (existing && existing.price) || 0;
  const tagsRaw = document.getElementById('bookTagsInput').value.trim();
  const tags = tagsRaw ? [...new Set(tagsRaw.split(/[,、]+/).map((t) => t.trim()).filter(Boolean))] : [];
  const shelfId = pendingShelfId || null;
  if (shelfId) {
    localStorage.setItem(LAST_SHELF_KEY, shelfId);
    // 「このレーベルはこの棚」を覚えて、次に同じレーベルを読んだとき自動で選べるようにする
    rememberLabelShelf(pendingLabelHint, shelfId);
  }
  // 読み仮名は読み取ったときだけ入る。手で題名を直しても、既にある読みは残す。
  const titleKana = (pendingReadings && pendingReadings.titleKana) || (existing && existing.titleKana) || null;
  const authorKana = (pendingReadings && pendingReadings.authorKana) || (existing && existing.authorKana) || null;
  const format = pendingFormat || 'paper';
  // ストアの欄は電子のときしか出していないので、紙にしたら既存値を持ち越す
  const store = (format === 'ebook' || format === 'both')
    ? pendingStore
    : ((existing && existing.store) || null);
  const isbn = document.getElementById('isbnInput').value.replace(/[^0-9Xx]/g, '') || null;
  const isSeries = document.getElementById('bookSeriesInput').checked;
  const totalVolumes = isSeries
    ? parseInt(document.getElementById('bookTotalVolumesInput').value, 10) || 0
    : (existing && existing.totalVolumes) || 0;

  if (editingBookId) {
    const b = existing;
    Object.assign(b, {
      title, author, memo, favorite, status, rating, tags, shelfId, isbn,
      isSeries, totalVolumes: totalVolumes || null, format, store, titleKana, authorKana,
      price: price || null,
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
      id: uid(), title, author, memo, favorite, status, rating, tags, shelfId, isbn,
      isSeries, totalVolumes: totalVolumes || null, format, store, titleKana, authorKana,
      price: price || null,
      bookmarkPage: bookmarkPage || null,
      totalPages: totalPages || null,
      cover: pendingCoverDataUrl || null,
      order: maxOrder + 1,
      createdAt: Date.now(),
    };
    books.push(b);
    await dbPut(STORES.books, b);
    if (isSeries) {
      // 作った直後は必ず巻を入れたいので、そのまま中身を開く
      closeModal('bookModal');
      renderBooks();
      openSeriesModal(b.id);
      showToast('シリーズを作りました。巻を追加してください');
      return;
    }
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
  const data = { app: 'hondana', version: 2, exportedAt: new Date().toISOString(), books, shelves };
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
    await dbClear(STORES.shelves);
    books = Array.isArray(data.books) ? data.books : [];
    // 棚を持たない古いバックアップ（version 1）からでも復元できるようにする
    shelves = Array.isArray(data.shelves) ? data.shelves : [];
    for (const item of books) await dbPut(STORES.books, item);
    for (const item of shelves) await dbPut(STORES.shelves, item);
    showToast('データを復元しました');
    renderBooks();
  } catch (err) {
    showToast('ファイルの読み込みに失敗しました');
  }
  e.target.value = '';
});

// ── 全削除 ──
document.getElementById('clearAllBtn').addEventListener('click', async () => {
  const ok = await showConfirm('全データを削除', '本棚のすべての本と棚を削除しますか？この操作は取り消せません。');
  if (!ok) return;
  await dbClear(STORES.books);
  await dbClear(STORES.shelves);
  books = [];
  shelves = [];
  currentShelfFilter = null;
  renderShelfManager();
  showToast('全データを削除しました');
  renderBooks();
});

// ── Helpers ──
function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ──
(async () => {
  // ZXing を同梱したので、BarcodeDetector が無い端末（iPhone）でも読み取れる。
  // 隠すのはカメラそのものが使えないときだけ。
  if (!isCameraSupported()) {
    document.getElementById('scanIsbnBtn').classList.add('hidden');
    document.getElementById('headerScanBtn').classList.add('hidden');
  }
  document.getElementById('sortSelect').value = sortMode;
  updateReorderUI();
  await openDB();
  await pruneTombstones();
  await loadAll();
  await seedDefaultShelvesOnce();
  await migrateSeriesVolumes(); // 旧形式（'1-105' の文字列）を1冊ずつのレコードに移す
  renderBooks();
  // sync.js が読み込まれていれば、ここから同期を始めさせる
  if (typeof window.hondanaOnReady === 'function') {
    try { window.hondanaOnReady(); } catch (e) {}
  }
})();
