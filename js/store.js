// ---------------------------------------------------------------------------
// 本機音檔保存（IndexedDB）
//
// 網頁版（GitHub Pages）不附音檔，由使用者在自己的電腦上選一次檔案，
// 之後就存在這台電腦的瀏覽器裡，不會上傳到任何地方。
// ---------------------------------------------------------------------------

const DB_NAME = 'jetlag';
const STORE = 'audio';
const VERSION = 1;

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function getAudio(key) {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const r = tx(db, 'readonly').get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  } catch { return null; }
}

// 注意：要等 transaction 的 oncomplete，不是 request 的 onsuccess。
// onsuccess 時交易還沒提交，若馬上 location.reload() 會被中止，檔案就沒存到。
export async function putAudio(key, file) {
  const db = await openDB();
  const rec = { blob: file, name: file.name, size: file.size, at: Date.now() };
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(rec, key);
    t.oncomplete = () => res(rec);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('IndexedDB 交易被中止'));
  });
}

export async function clearAudio() {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).clear();
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('IndexedDB 交易被中止'));
    });
    return true;
  } catch { return false; }
}

/** 回傳 {vocal:{name,size}|null, inst:{…}|null} */
export async function audioInfo() {
  const out = {};
  for (const k of ['vocal', 'inst']) {
    const r = await getAudio(k);
    out[k] = r ? { name: r.name, size: r.size, at: r.at } : null;
  }
  return out;
}

export async function estimate() {
  try {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    return { usage: e.usage, quota: e.quota };
  } catch { return null; }
}
