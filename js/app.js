// ---------------------------------------------------------------------------
// Jet Lag 練唱室 — UI
// ---------------------------------------------------------------------------
import { SONG, KIND_COLOR, makeGrid } from './songdata.js';
import { Engine } from './engine.js';
import * as Ly from './lyrics.js';
import * as Store from './store.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const LS_KEY = 'jetlag.practice.v1';
const SPEEDS = [50, 60, 70, 80, 90, 100];
const KEY_MIN = -12, KEY_MAX = 12;

// ---------------------------------------------------------------------- state
const DEF = () => ({
  diff: [], loop: { a: null, b: null, on: false },
  speed: 100, key: 0, vocals: true, lyricMode: 'all', vol: 85,
  syncMs: 0, grid: null, sections: null, lyrics: null,
  snap: 0, shiftMs: 0, lyricSize: 100, muteVoice: '',
});
let S = DEF();
let G, eng, LYR = { version: 1, lines: [] }, TL = [], SEC = [], BARS = 0;
let dragging = null, userScrollUntil = 0, curLine = -1, curBar = -1, curSec = -1;
let forceLine = null;   // 點歌詞後暫時鎖定的高亮行 {k, t}
let cells = [];

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch {}
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) S = Object.assign(DEF(), JSON.parse(raw));
  } catch {}
  if (!Array.isArray(S.diff)) S.diff = [];
  S.diff = [...new Set(S.diff)].filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
}

// ----------------------------------------------------------------- 小節 / 段落
function rebuildGrid() {
  const g = Object.assign({}, SONG.grid, S.grid || {});
  G = makeGrid(g);
  BARS = Math.max(1, Math.floor((eng.duration - G.firstBeat) / G.bar));
  SEC = (S.sections || SONG.sections).map(s => ({ ...s }))
    .filter(s => Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start);
  SEC.forEach((s, i) => {
    s.start = Math.max(0, Math.min(BARS - 1, s.start | 0));
    s.end = (i + 1 < SEC.length) ? SEC[i + 1].start : BARS;   // exclusive
    s.color = KIND_COLOR[s.kind] || KIND_COLOR.other;
  });
  S.diff = S.diff.filter(i => i >= 0 && i < BARS);
}
const barT = (i) => G.firstBeat + i * G.bar;
// +1e-6：剛好 seek 到小節線上時，浮點誤差不要把它算成前一小節
const tBar = (t) => Math.max(0, Math.min(BARS - 1, Math.floor((t - G.firstBeat) / G.bar + 1e-6)));
const secOf = (bar) => { for (let i = SEC.length - 1; i >= 0; i--) if (bar >= SEC[i].start) return i; return 0; };

// ------------------------------------------------------------------ boot
(async function boot() {
  loadState();
  eng = new Engine();
  const bar = $('#loadBar'), msg = $('#loadMsg');
  try {
    await eng.load(SONG, (f, m) => { bar.style.width = (f * 100).toFixed(1) + '%'; msg.textContent = m; });
  } catch (err) {
    if (err && err.name === 'NeedAudioError') { showPicker(); return; }
    $('#loadErr').hidden = false;
    $('#loadErr').innerHTML = `載入失敗：${esc(String(err.message || err))}<br><br>
      本機版請用 <b>start.bat</b> 開啟（直接雙擊 index.html 會因瀏覽器安全限制讀不到音檔）。`;
    msg.textContent = '';
    return;
  }

  rebuildGrid();
  LYR = Ly.normalize(S.lyrics || await Ly.fetchFile() || { lines: [] });
  TL = Ly.timeline(LYR);

  eng.setTempo(S.speed / 100);
  eng.setSemitones(S.key);
  eng.setVolume(S.vol / 100);
  eng.setActive(S.vocals ? 0 : 1);
  eng.setInstOffset(SONG.tracks.inst.offset + S.syncMs / 1000);
  applyLoop(false);

  buildUI();
  window.JL = { eng, state: () => S, grid: () => G, sections: () => SEC, lyrics: () => LYR, frame: tickBody };
  $('#loader').hidden = true;
  $('#app').hidden = false;
  drawStrip();
  requestAnimationFrame(tick);
})();

// --------------------------------------------------- 這台電腦還沒有音檔
function showPicker() {
  $('#loadMsg').textContent = '';
  $('#loadBar').style.width = '0%';
  $('#pickBox').hidden = false;
  const v = $('#pickVocal'), i = $('#pickInst'), go = $('#pickGo');
  const check = () => { go.disabled = !(v.files[0] && i.files[0]); };
  v.onchange = i.onchange = check;
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = '儲存中…';
    try {
      await Store.putAudio('vocal', v.files[0]);
      await Store.putAudio('inst', i.files[0]);
      location.reload();
    } catch (e) {
      go.textContent = '載入並開始';
      go.disabled = false;
      $('#loadErr').hidden = false;
      $('#loadErr').textContent = '存檔失敗（瀏覽器空間不足？）：' + (e.message || e);
    }
  };
}

// ------------------------------------------------------------------ UI build
function buildUI() {
  renderSectionBar();
  renderGridCells();
  renderLyrics();
  bindTransport();
  bindGridMouse();
  bindStripMouse();
  bindPanels();
  bindKeys();
  syncControls();
  new ResizeObserver(() => drawStrip()).observe($('#stripWrap'));
}

function renderSectionBar() {
  const nav = $('#sectionBar');
  nav.innerHTML = '';
  SEC.forEach((s, i) => {
    const b = document.createElement('button');
    b.innerHTML = `${s.name}<i>${s.start + 1}</i>`;
    b.title = `第 ${s.start + 1}–${s.end} 小節　${fmt(barT(s.start))}` + (i < 9 ? `　(${i + 1})` : '');
    b.onclick = () => { eng.seek(barT(s.start)); toast(s.name); };
    nav.appendChild(b);
  });
}

function renderGridCells() {
  const g = $('#grid');
  g.innerHTML = '';
  cells = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < BARS; i++) {
    const si = secOf(i);
    const c = document.createElement('div');
    c.className = 'cell' + (i % 4 === 0 ? ' b4' : '') + (SEC[si].start === i ? ' secstart' : '');
    c.style.setProperty('--secclr', SEC[si].color);
    c.dataset.i = i;
    const label = SEC[si].start === i ? esc(SEC[si].name) : '';
    c.innerHTML = `<div class="fill"></div><div class="pg"></div>`
      + `<span class="sn">${label}</span><span class="n">${i + 1}</span>`;
    c.title = `第 ${i + 1} 小節 · ${SEC[si].name} · ${fmt(barT(i))}`;
    frag.appendChild(c);
    cells.push(c);
  }
  g.appendChild(frag);
  paintGrid();
}

function paintGrid() {
  const dset = new Set(S.diff);
  const { a, b } = loopBars();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    c.classList.toggle('diff', dset.has(i));
    c.classList.toggle('sel', a !== null && i >= a && i <= b);
  }
  // 框選顏色：開循環=黃底，未開=淡藍
  $('#grid').classList.toggle('looping', !!S.loop.on && a !== null);
  $('#diffInfo').textContent = `${S.diff.length} 個`;
  $('#diffInfo').classList.toggle('hot', S.diff.length > 0);
  $('#diffInfo').classList.toggle('dim', S.diff.length === 0);
  const li = $('#loopInfo');
  if (a === null) { li.textContent = '未框選'; li.classList.add('dim'); }
  else { li.textContent = `第 ${a + 1}–${b + 1} 小節`; li.classList.remove('dim'); }
}

// ------------------------------------------------------------------ 歌詞
function renderLyrics() {
  const pad = $('#lyricPad');
  pad.innerHTML = '';
  const any = Ly.hasAny(LYR);
  $('#lyricEmpty').hidden = any;
  if (!any) return;

  let lastSec = -1;
  const frag = document.createDocumentFragment();
  LYR.lines.forEach((l, idx) => {
    if (l.br) {
      const d = document.createElement('div');
      d.className = 'lrow'; d.style.height = '10px';
      frag.appendChild(d); return;
    }
    if (l.t !== null) {
      const si = secOf(tBar(l.t));
      if (si !== lastSec) {
        lastSec = si;
        const h = document.createElement('div');
        h.className = 'lrow sec';
        h.innerHTML = `<span class="tag">${SEC[si].name}</span>`;
        frag.appendChild(h);
      }
    }
    const d = document.createElement('div');
    d.className = 'lrow';
    d.dataset.idx = idx;
    d.innerHTML = `<div class="en"></div><div class="zh"></div>`;
    paintWords(d.querySelector('.en'), l);
    d.querySelector('.zh').textContent = l.zh || '';
    if (l.t !== null) d.onclick = () => {
      // 先 seek（會清掉舊的強制高亮），再把高亮鎖在這一行：
      // 不然 seek 到 t-0.12 時會先亮上一行、0.12 秒後才跳回來。
      eng.seek(Math.max(0, l.t - 0.12));
      const k = TL.findIndex(x => x.i === idx);
      if (k >= 0) forceLine = { k, t: l.t };
      paintLyricHighlight(k);
      if (!eng.playing) eng.play();      // 暫停中點歌詞 → 直接開始播
    };
    frag.appendChild(d);
  });
  pad.appendChild(frag);
  curLine = -1;
  applyLyricMode();
  pad.addEventListener('wheel', () => { userScrollUntil = performance.now() + 2600; }, { passive: true });
  pad.addEventListener('pointerdown', () => { userScrollUntil = performance.now() + 2600; });
}

/** 把一句歌詞逐字塗上聲部顏色（男=藍 女=紅 合唱=綠） */
function paintWords(el, line, onWord) {
  el.textContent = '';
  if (!line.en) { el.textContent = '♪'; return; }
  for (const tok of Ly.words(line.en)) {
    if (!tok.isWord) { el.append(tok.text); continue; }
    const s = document.createElement('span');
    const v = Ly.voiceOf(line, tok.wi);
    s.className = 'w' + (v ? ' v-' + v : '');
    s.textContent = tok.text;
    if (onWord) {
      s.dataset.wi = tok.wi;
      s.classList.add('tap');
      s.onclick = (e) => { e.stopPropagation(); onWord(tok.wi); };
    }
    el.append(s);
  }
}

/** 依 TL 索引套用 cur / past / next 樣式（idx<0 表示還沒到第一句） */
function paintLyricHighlight(idx) {
  const want = idx >= 0 && TL[idx] ? TL[idx].i : -1;
  if (want === curLine) return;
  const pad = $('#lyricPad');
  pad.querySelectorAll('.lrow.cur,.lrow.next,.lrow.past')
    .forEach(e => e.classList.remove('cur', 'next', 'past'));
  for (let k = 0; k <= idx; k++) {
    const e = pad.querySelector(`.lrow[data-idx="${TL[k].i}"]`);
    if (e) e.classList.add(k === idx ? 'cur' : 'past');
  }
  if (idx + 1 < TL.length) {
    const e = pad.querySelector(`.lrow[data-idx="${TL[idx + 1].i}"]`);
    if (e) e.classList.add('next');
  }
  curLine = want;
  markVoiceRow();
}

// ---------------------------------------------------------------- 歌詞字級
const FSZ_MIN = 60, FSZ_MAX = 220, FSZ_STEP = 10;
function applyLyricSize() {
  const v = Math.max(FSZ_MIN, Math.min(FSZ_MAX, S.lyricSize || 100));
  S.lyricSize = v;
  $('#lyricWrap').style.setProperty('--lyr-scale', (v / 100).toFixed(2));
  $('#fszVal').textContent = v + '%';
}
function bumpLyricSize(d) {
  S.lyricSize = Math.max(FSZ_MIN, Math.min(FSZ_MAX, (S.lyricSize || 100) + d * FSZ_STEP));
  applyLyricSize(); save();
  toast(`歌詞 ${S.lyricSize}%`);
}

// -------------------------------------------------------------- 聲部標註
function renderVoiceList() {
  const box = $('#voiceList');
  const rows = textRows();
  box.innerHTML = '';
  if (!rows.length) {
    box.innerHTML = '<p class="dim" style="padding:14px">先在「貼上歌詞」頁匯入歌詞。</p>';
    $('#voiceInfo').textContent = '';
    return;
  }
  rows.forEach((r, n) => {
    const d = document.createElement('div');
    d.className = 'vrow';
    d.dataset.idx = r.i;
    d.innerHTML = `<span class="idx">${n + 1}</span>
      <span class="vbtns">
        <button data-v="m" title="整句男聲">男</button>
        <button data-v="f" title="整句女聲">女</button>
        <button data-v="b" title="整句合唱">合</button>
        <button data-v="" title="整句清除">✕</button>
      </span>
      <span class="vtext"></span>
      <span class="vtime">${r.l.t === null ? '—' : r.l.t.toFixed(1)}</span>`;
    const text = d.querySelector('.vtext');
    paintWords(text, r.l, (wi) => {
      const cur = Ly.voiceOf(r.l, wi);
      const order = [null, 'm', 'f', 'b'];
      const next = order[(order.indexOf(cur) + 1) % order.length];
      Ly.setWordVoice(r.l, wi, next);
      saveVoices();
      renderVoiceList();
    });
    if (r.l.zh) { const s = document.createElement('small'); s.textContent = r.l.zh; text.appendChild(s); }
    d.querySelectorAll('.vbtns button').forEach(b => {
      if (b.dataset.v && r.l.v === b.dataset.v) b.classList.add('on');
      b.onclick = () => { Ly.setLineVoice(r.l, b.dataset.v || null); saveVoices(); renderVoiceList(); };
    });
    if (r.l.t !== null) d.querySelector('.vtime').onclick = () => eng.seek(Math.max(0, r.l.t - 0.3));
    box.appendChild(d);
  });
  const tagged = rows.filter(r => r.l.v || (r.l.w && r.l.w.some(x => x))).length;
  $('#voiceInfo').textContent = `已標 ${tagged} / ${rows.length} 句`;
  markVoiceRow();
}
function saveVoices() {
  S.lyrics = LYR; save();
  applyMute();
  renderLyrics();
  $('#jsonTa').value = JSON.stringify(LYR, null, 1);
}
/** 播放時在聲部清單標出目前這句 */
function markVoiceRow() {
  const box = $('#voiceList');
  if (!box || !box.children.length) return;
  box.querySelectorAll('.vrow.cur').forEach(e => e.classList.remove('cur'));
  if (curLine < 0) return;
  const el = box.querySelector(`.vrow[data-idx="${curLine}"]`);
  if (el) {
    el.classList.add('cur');
    if ($('#lyricPanel').hidden === false) el.scrollIntoView({ block: 'nearest' });
  }
}

function applyLyricMode() {
  const w = $('#lyricWrap');
  w.classList.toggle('hidden', S.lyricMode === 'off');
  w.classList.toggle('zh-cur', S.lyricMode === 'cur');
  w.classList.remove('zh-off');
  const btn = $('#lyricBtn');
  btn.classList.toggle('on', S.lyricMode !== 'off');
  btn.textContent = S.lyricMode === 'all' ? '歌詞+翻譯' : S.lyricMode === 'cur' ? '翻譯僅當句' : '歌詞關閉';
}

// ------------------------------------------------------------------ 總覽軸
function drawStrip() {
  const cv = $('#strip');
  const w = cv.clientWidth, h = 68;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const x = cv.getContext('2d');
  x.scale(dpr, dpr);
  x.clearRect(0, 0, w, h);
  const D = eng.duration;
  const px = (t) => t / D * w;

  // 段落底色
  SEC.forEach(s => {
    const x0 = px(barT(s.start)), x1 = px(Math.min(D, barT(s.end)));
    x.fillStyle = s.color; x.globalAlpha = .55;
    x.fillRect(x0, 0, x1 - x0, h);
    x.globalAlpha = 1;
    x.fillStyle = '#0d1117aa'; x.fillRect(x0, 0, 1, h);
    x.fillStyle = '#cfdae8'; x.font = '10px system-ui';
    if (x1 - x0 > 34) x.fillText(s.name, x0 + 4, 11);
  });

  // 循環區
  const { a, b } = loopBars();
  if (a !== null) {
    const x0 = px(barT(a)), x1 = px(barT(b + 1));
    x.fillStyle = S.loop.on ? 'rgba(255,193,77,.32)' : 'rgba(76,194,255,.22)';
    x.fillRect(x0, 0, x1 - x0, h);
    x.strokeStyle = S.loop.on ? '#ffc14d' : '#4cc2ff';
    x.lineWidth = 1.5;
    x.strokeRect(x0 + .75, .75, x1 - x0 - 1.5, h - 1.5);
  }

  // 波形
  const P = eng.peaks, n = P.length, mid = h / 2 + 5;
  x.strokeStyle = 'rgba(190,215,240,.52)';
  x.beginPath();
  for (let i = 0; i < n; i++) {
    const xx = i / n * w, v = Math.min(1, P[i] * 1.5) * (h / 2 - 9);
    x.moveTo(xx, mid - v); x.lineTo(xx, mid + v);
  }
  x.stroke();

  // 困難小節
  x.fillStyle = '#ff4d5e';
  for (const i of S.diff) {
    const x0 = px(barT(i)), x1 = px(barT(i + 1));
    x.fillRect(x0, h - 4, Math.max(1.5, x1 - x0 - .5), 4);
  }
  // 小節線（每 4 小節）
  x.fillStyle = 'rgba(255,255,255,.07)';
  for (let i = 0; i < BARS; i += 4) x.fillRect(px(barT(i)), h - 9, 1, 5);

  ensurePlayhead();
}

let ph;
function ensurePlayhead() {
  if (!ph) {
    ph = document.createElement('div');
    Object.assign(ph.style, {
      position: 'absolute', top: '8px', width: '2px', height: '68px',
      background: '#fff', boxShadow: '0 0 8px #fff8', pointerEvents: 'none',
      transform: 'translateX(-1px)', left: '16px',
    });
    $('#stripWrap').appendChild(ph);
  }
}

// ------------------------------------------------------------------ 迴圈
function loopBars() {
  const { a, b } = S.loop;
  if (a === null || b === null) return { a: null, b: null };
  return { a: Math.min(a, b), b: Math.max(a, b) };
}
function applyLoop(notify = true) {
  const { a, b } = loopBars();
  if (a !== null && S.loop.on) {
    eng.setLoop({ start: barT(a), end: Math.min(eng.duration, barT(b + 1)) });
  } else {
    eng.setLoop(null);
  }
  $('#loopBtn').classList.toggle('on', !!S.loop.on && a !== null);
  paintGrid(); drawStrip(); save();
  if (notify) toast(a === null ? '沒有框選範圍' : (S.loop.on ? `循環 第 ${a + 1}–${b + 1} 小節` : '循環關閉'));
}
function toggleLoop() {
  const { a } = loopBars();
  if (a === null) { toast('請先在小節區框選要循環的範圍'); return; }
  S.loop.on = !S.loop.on;
  applyLoop();
}
function setSel(a, b, autoLoop = true) {
  S.loop.a = a; S.loop.b = b;
  if (autoLoop && a !== null) S.loop.on = true;
  applyLoop(false);
}

// ------------------------------------------------------------------ 滑鼠
function bindGridMouse() {
  const g = $('#grid');
  g.addEventListener('contextmenu', (e) => {
    const c = e.target.closest('.cell'); if (!c) return;
    e.preventDefault(); toggleDiff(+c.dataset.i);
  });
  g.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.cell'); if (!c || e.button !== 0) return;
    const i = +c.dataset.i;
    if (e.ctrlKey || e.metaKey) { toggleDiff(i); return; }
    dragging = { from: i, to: i, moved: false, kind: 'grid' };
    try { g.setPointerCapture(e.pointerId); } catch {}
  });
  g.addEventListener('pointermove', (e) => {
    if (!dragging || dragging.kind !== 'grid') return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const c = el && el.closest('.cell'); if (!c) return;
    const i = +c.dataset.i;
    if (i !== dragging.to) { dragging.to = i; dragging.moved = true; preview(); }
  });
  g.addEventListener('pointerup', () => endDrag());
  g.addEventListener('pointercancel', () => endDrag());
}
function preview() {
  const a = Math.min(dragging.from, dragging.to), b = Math.max(dragging.from, dragging.to);
  S.loop.a = a; S.loop.b = b;
  paintGrid(); drawStrip();
}
function endDrag() {
  if (!dragging) return;
  const d = dragging; dragging = null;
  if (!d.moved) {
    // 單純點擊：點在框選範圍外 → 取消循環與框選
    const { a, b } = loopBars();
    if (a !== null && (d.from < a || d.from > b)) {
      S.loop.a = S.loop.b = null;
      S.loop.on = false;
      applyLoop(false);
      toast('已取消循環框選');
    }
    if (d.kind === 'grid') eng.seek(barT(d.from));
    else eng.seek(d.t);
    if (!eng.playing) eng.play();        // 暫停中點小節 / 總覽軸 → 直接開始播
  } else {
    S.loop.on = true;
    applyLoop(false);
    const { a, b } = loopBars();
    toast(`循環 第 ${a + 1}–${b + 1} 小節`);
  }
  save();
}

function bindStripMouse() {
  const cv = $('#strip');
  const xToT = (e) => {
    const r = cv.getBoundingClientRect();
    return Math.max(0, Math.min(eng.duration, (e.clientX - r.left) / r.width * eng.duration));
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = xToT(e), i = tBar(t);
    dragging = { from: i, to: i, moved: false, kind: 'strip', t };
    try { cv.setPointerCapture(e.pointerId); } catch {}
  });
  cv.addEventListener('pointermove', (e) => {
    if (!dragging || dragging.kind !== 'strip') return;
    const i = tBar(xToT(e));
    if (i !== dragging.to) { dragging.to = i; dragging.moved = true; preview(); }
  });
  cv.addEventListener('pointerup', () => endDrag());
  cv.addEventListener('pointercancel', () => endDrag());
}

// ------------------------------------------------------------------ 困難標記
function toggleDiff(i) {
  if (!Number.isInteger(i) || i < 0 || i >= BARS) { toast('還沒定位到小節'); return; }
  const k = S.diff.indexOf(i);
  if (k >= 0) S.diff.splice(k, 1); else S.diff.push(i);
  S.diff.sort((a, b) => a - b);
  paintGrid(); drawStrip(); save();
  toast(`${k >= 0 ? '取消' : '標記'}困難：第 ${i + 1} 小節`);
}
function markRange(mark) {
  const { a, b } = loopBars();
  if (a === null) { toggleDiff(curBar); return; }
  const set = new Set(S.diff);
  for (let i = a; i <= b; i++) mark ? set.add(i) : set.delete(i);
  S.diff = [...set].sort((x, y) => x - y);
  paintGrid(); drawStrip(); save();
  toast(`${mark ? '標記' : '取消'}困難：第 ${a + 1}–${b + 1} 小節`);
}
function nextDiff() {
  if (!S.diff.length) { toast('還沒有標記困難小節'); return; }
  const now = curBar;
  let t = S.diff.find(i => i > now);
  if (t === undefined) t = S.diff[0];
  eng.seek(barT(t));
  toast(`第 ${t + 1} 小節`);
}
function renderDiffPanel() {
  const body = $('#diffBody');
  if (!S.diff.length) { body.innerHTML = '<p class="dim">還沒有標記。在小節格上按右鍵，或播到難的地方按 <kbd>D</kbd>。</p>'; return; }
  // 連續小節合併成區段
  const runs = [];
  for (const i of S.diff) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]);
  }
  const box = document.createElement('div');
  box.className = 'difflist';
  runs.forEach(([a, b]) => {
    const btn = document.createElement('button');
    btn.className = a === b ? '' : 'rng';
    btn.textContent = a === b ? `第 ${a + 1} 小節` : `第 ${a + 1}–${b + 1} 小節`;
    btn.title = `${SEC[secOf(a)].name}　${fmt(barT(a))}　(點一下跳過去並框選循環)`;
    btn.onclick = () => { setSel(a, b); eng.seek(barT(a)); closePanels(); };
    box.appendChild(btn);
  });
  body.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'dim';
  p.textContent = '點一下＝跳到那裡並自動框選循環。';
  body.append(p, box);
}

// ------------------------------------------------------------------ transport
function bindTransport() {
  $('#playBtn').onclick = () => eng.toggle();
  $('#prevSec').onclick = () => jumpSec(-1);
  $('#nextSec').onclick = () => jumpSec(1);
  $('#vocalBtn').onclick = () => setVocals(!S.vocals);
  $('#muteBtn').onclick = cycleMute;
  $('#lyricBtn').onclick = () => cycleLyric();
  $('#fszDn').onclick = () => bumpLyricSize(-1);
  $('#fszUp').onclick = () => bumpLyricSize(1);
  $('#loopBtn').onclick = toggleLoop;
  $('#loopClr').onclick = () => { S.loop.a = S.loop.b = null; S.loop.on = false; applyLoop(false); toast('已清除框選'); };
  $('#diffBtn').onclick = () => {
    const { a } = loopBars();
    if (a === null) toggleDiff(curBar);
    else {
      const set = new Set(S.diff);
      const { b } = loopBars();
      let all = true;
      for (let i = a; i <= b; i++) if (!set.has(i)) { all = false; break; }
      markRange(!all);
    }
  };
  $('#diffNext').onclick = nextDiff;
  $('#diffListBtn').onclick = () => { renderDiffPanel(); openPanel('#diffPanel'); };
  $('#spdDn').onclick = () => bumpSpeed(-1);
  $('#spdUp').onclick = () => bumpSpeed(1);
  $('#keyDn').onclick = () => bumpKey(-1);
  $('#keyUp').onclick = () => bumpKey(1);
  $('#vol').oninput = (e) => { S.vol = +e.target.value; eng.setVolume(S.vol / 100); save(); };
  eng.onPlayState = (p) => { $('#playBtn').textContent = p ? '❚❚' : '▶'; };
  eng.onSeek = () => { forceLine = null; };   // 任何其他跳播都解除鎖定
  eng.onEnded = () => toast('播放結束');
}

function setVocals(on) {
  S.vocals = on;
  eng.setActive(on ? 0 : 1);
  const b = $('#vocalBtn');
  b.classList.toggle('on', on);
  b.innerHTML = `人聲 <b>${on ? 'ON' : 'OFF'}</b>`;
  save();
}
/** 依聲部標註把某一邊的人聲換成伴奏（合唱也算在內） */
function applyMute() {
  const m = S.muteVoice || '';
  const ranges = m ? Ly.muteRanges(LYR, m, eng.duration) : [];
  eng.setMuteRanges(ranges);
  const b = $('#muteBtn');
  b.textContent = m === 'm' ? '關男聲' : m === 'f' ? '關女聲' : '雙聲全開';
  b.classList.toggle('on', !!m);
  b.classList.toggle('on-m', m === 'm');
  b.classList.toggle('on-f', m === 'f');
  return ranges;
}
function cycleMute() {
  S.muteVoice = S.muteVoice === '' ? 'm' : S.muteVoice === 'm' ? 'f' : '';
  const ranges = applyMute();
  save();
  if (!S.muteVoice) { toast('兩邊人聲都播'); return; }
  const who = S.muteVoice === 'm' ? '男聲' : '女聲';
  if (!ranges.length) toast(`還沒有標註${who}段落（歌詞編輯 → 聲部標註）`);
  else if (!S.vocals) toast(`已設定關${who}，但現在是伴奏模式（按 V 開人聲）`);
  else toast(`關${who}：那些段落改播伴奏`);
}

function cycleLyric() {
  S.lyricMode = S.lyricMode === 'all' ? 'cur' : S.lyricMode === 'cur' ? 'off' : 'all';
  applyLyricMode(); save();
  toast(S.lyricMode === 'all' ? '歌詞 + 全部翻譯' : S.lyricMode === 'cur' ? '只顯示當句翻譯' : '歌詞隱藏');
}
function bumpSpeed(dir) {
  let i = SPEEDS.indexOf(S.speed);
  if (i < 0) i = SPEEDS.length - 1;
  i = Math.max(0, Math.min(SPEEDS.length - 1, i + dir));
  S.speed = SPEEDS[i];
  eng.setTempo(S.speed / 100); syncControls(); save();
  toast(`速度 ${S.speed}%`);
}
function bumpKey(d) {
  S.key = Math.max(KEY_MIN, Math.min(KEY_MAX, S.key + d));
  eng.setSemitones(S.key); syncControls(); save();
  toast(`Key ${S.key > 0 ? '+' : ''}${S.key} 半音`);
}
function jumpSec(d) {
  let i = secOf(curBar) + d;
  // 往前時若已在段落中段，先回到本段開頭
  if (d < 0 && curBar - SEC[secOf(curBar)].start > 2) i = secOf(curBar);
  i = Math.max(0, Math.min(SEC.length - 1, i));
  eng.seek(barT(SEC[i].start));
  toast(SEC[i].name);
}
function syncControls() {
  $('#spdVal').textContent = S.speed + '%';
  $('#keyVal').textContent = (S.key > 0 ? '+' : S.key < 0 ? '' : '±') + S.key;
  $('#vol').value = S.vol;
  $('#keyVal').style.color = S.key ? 'var(--warn)' : '';
  $('#spdVal').style.color = S.speed !== 100 ? 'var(--warn)' : '';
  setVocals(S.vocals);
  applyLyricMode();
  applyLyricSize();
  applyMute();
}

// ------------------------------------------------------------------ keyboard
function bindKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const k = e.key;
    if (k === ' ') { e.preventDefault(); eng.toggle(); return; }
    if (k === 'Escape') {
      if ($('#modalBg').hidden === false) { closePanels(); return; }
      S.loop.a = S.loop.b = null; S.loop.on = false; applyLoop(false); toast('已清除框選'); return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const d = k === 'ArrowRight' ? 1 : -1;
      if (e.ctrlKey || e.metaKey) { jumpSec(d); return; }
      const step = e.shiftKey ? 4 : 1;
      let b = curBar + d * step;
      if (d < 0 && !e.shiftKey && eng.now - barT(curBar) > 0.35) b = curBar;  // 先回到本小節開頭
      eng.seek(barT(Math.max(0, Math.min(BARS - 1, b))));
      return;
    }
    if (k === 'ArrowUp') { e.preventDefault(); bumpKey(1); return; }
    if (k === 'ArrowDown') { e.preventDefault(); bumpKey(-1); return; }
    if (k === 'Home') { eng.seek(0); return; }
    if (k === '+' || k === '=') { bumpSpeed(1); return; }
    if (k === '-' || k === '_') { bumpSpeed(-1); return; }
    if (k === '0') { S.speed = 100; S.key = 0; eng.setTempo(1); eng.setSemitones(0); syncControls(); save(); toast('速度 100% · Key ±0'); return; }
    if (k >= '1' && k <= '9') { const i = +k - 1; if (SEC[i]) { eng.seek(barT(SEC[i].start)); toast(SEC[i].name); } return; }
    const lower = k.toLowerCase();
    if (lower === 'v') { setVocals(!S.vocals); toast(S.vocals ? '人聲 ON（原曲）' : '人聲 OFF（伴奏）'); return; }
    if (lower === 'b') { cycleMute(); return; }
    if (lower === 'h') { cycleLyric(); return; }
    if (lower === 'l' || lower === 'c') { toggleLoop(); return; }
    if (lower === 'd') { toggleDiff(curBar); return; }
    if (lower === 'n') { nextDiff(); return; }
    if (k === '[') { setSel(curBar, S.loop.b === null ? curBar : Math.max(curBar, S.loop.b)); toast(`循環起點 第 ${curBar + 1} 小節`); return; }
    if (k === ']') { setSel(S.loop.a === null ? curBar : Math.min(curBar, S.loop.a), curBar); toast(`循環終點 第 ${curBar + 1} 小節`); return; }
    if (k === ',' || k === '<') { bumpLyricSize(-1); return; }
    if (k === '.' || k === '>') { bumpLyricSize(1); return; }
    if (k === '?' || k === '/') { openPanel('#helpPanel'); return; }
  });
}

// ------------------------------------------------------------------ 面板
function openPanel(sel) {
  closePanels();
  $('#modalBg').hidden = false;
  $(sel).hidden = false;
}
function closePanels() {
  $('#modalBg').hidden = true;
  $$('.panel').forEach(p => p.hidden = true);
}
function bindPanels() {
  $('#modalBg').onclick = closePanels;
  $$('[data-close]').forEach(b => b.onclick = closePanels);
  $('#helpBtn').onclick = () => openPanel('#helpPanel');
  $('#setBtn').onclick = async () => { await renderSetPanel(); openPanel('#setPanel'); };
  bindSettings();
  $('#secBtn').onclick = () => { renderSecPanel(); openPanel('#secPanel'); };
  $('#syncBtn').onclick = () => { renderSyncPanel(); openPanel('#syncPanel'); };
  $('#editLyricBtn').onclick = openLyricEditor;
  $('#emptyEditBtn').onclick = openLyricEditor;
  $('#diffClear').onclick = () => {
    if (!confirm('清除全部困難標記？')) return;
    S.diff = []; paintGrid(); drawStrip(); save(); renderDiffPanel();
  };

  // --- 對齊 ---
  const setSync = (ms) => {
    S.syncMs = Math.max(-600, Math.min(600, Math.round(ms)));
    eng.setInstOffset(SONG.tracks.inst.offset + S.syncMs / 1000);
    $('#syncVal').textContent = `${S.syncMs > 0 ? '+' : ''}${S.syncMs} ms`;
    $('#syncRange').value = S.syncMs;
    save();
  };
  $$('[data-sync]').forEach(b => b.onclick = () => setSync(S.syncMs + +b.dataset.sync));
  $('#syncRange').oninput = (e) => setSync(+e.target.value);
  $('#syncReset').onclick = () => setSync(0);

  // --- 格線 ---
  $('#gridApply').onclick = () => {
    const bpm = parseFloat($('#bpmIn').value), f = parseFloat($('#firstIn').value), bp = parseInt($('#bpbIn').value, 10);
    if (!(bpm > 20 && bpm < 400) || !(f >= 0) || !(bp >= 1)) { toast('數值不合理'); return; }
    S.grid = { bpm, firstBeat: f, beatsPerBar: bp };
    S.loop = { a: null, b: null, on: false };
    rebuildGrid(); renderSectionBar(); renderGridCells(); renderLyrics(); applyLoop(false); drawStrip(); save();
    toast('格線已更新');
  };
  $('#gridReset').onclick = () => {
    S.grid = null; rebuildGrid(); renderSectionBar(); renderGridCells(); renderLyrics(); drawStrip(); save();
    renderSyncPanel(); toast('格線已還原');
  };

  // --- 段落 ---
  $('#secAdd').onclick = () => { secDraft.push({ name: '新段落', start: Math.min(BARS - 1, curBar), kind: 'other' }); renderSecRows(); };
  $('#secReset').onclick = () => { S.sections = null; rebuildGrid(); renderSectionBar(); renderGridCells(); renderLyrics(); drawStrip(); save(); renderSecPanel(); toast('段落已還原'); };
  $('#secSave').onclick = () => {
    const rows = [...$('#secBody').querySelectorAll('.secrow')].map(r => ({
      name: r.querySelector('.nm').value.trim() || '段落',
      start: Math.max(0, Math.min(BARS - 1, (parseInt(r.querySelector('.st').value, 10) || 1) - 1)),
      kind: r.querySelector('.kd').value,
    })).sort((a, b) => a.start - b.start);
    if (!rows.length) { toast('至少要有一個段落'); return; }
    rows[0].start = 0;
    S.sections = rows;
    rebuildGrid(); renderSectionBar(); renderGridCells(); renderLyrics(); drawStrip(); save();
    closePanels(); toast('段落已儲存');
  };
  bindLyricEditor();
}

// ------------------------------------------------------------------ 設定面板
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
async function renderSetPanel() {
  const info = await Store.audioInfo();
  const srcOf = (k) => (eng.source || []).find(s => s.key === k);
  const row = (k, label) => {
    const saved = info[k], src = srcOf(k);
    if (saved) return `<div>${label}：<b>${esc(saved.name)}</b> ${mb(saved.size)}　<span class="dim">(存在這台電腦)</span></div>`;
    if (src && src.from === 'server') return `<div>${label}：<b>${esc(src.name)}</b>　<span class="dim">(從伺服器載入)</span></div>`;
    return `<div class="miss">${label}：尚未設定</div>`;
  };
  const est = await Store.estimate();
  $('#audioInfo').innerHTML = row('vocal', '原曲') + row('inst', '伴奏')
    + (est ? `<div class="dim">瀏覽器已用 ${mb(est.usage)} / 可用約 ${mb(est.quota)}</div>` : '');
}
function bindSettings() {
  const put = async (key, input, label) => {
    const f = input.files[0];
    if (!f) return;
    try {
      await Store.putAudio(key, f);
      toast(`${label}已更新，重新整理後生效`);
      await renderSetPanel();
      if (confirm(`${label}已更新，現在重新整理？`)) location.reload();
    } catch (e) { toast('存檔失敗：' + (e.message || e)); }
  };
  $('#reVocal').onchange = (e) => put('vocal', e.target, '原曲');
  $('#reInst').onchange = (e) => put('inst', e.target, '伴奏');
  $('#audioClear').onclick = async () => {
    if (!confirm('清除存在這台電腦的音檔？（下次打開要重選）')) return;
    await Store.clearAudio();
    location.reload();
  };
  $('#cfgExport').onclick = () => {
    const data = {
      app: 'jetlag-practice', version: 1,
      exported: new Date().toISOString(),
      song: `${SONG.artist} - ${SONG.title}`,
      state: S,
    };
    const d = new Date();
    const name = `jetlag-settings-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    $('#cfgInfo').textContent = `已匯出 ${name}`;
  };
  $('#cfgImport').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const st = data && (data.state || (data.lines ? null : data));
      if (!st || typeof st !== 'object') throw new Error('格式不對');
      S = Object.assign(DEF(), st);
      save();
      $('#cfgInfo').textContent = '匯入成功，重新整理中…';
      setTimeout(() => location.reload(), 400);
    } catch (err) {
      $('#cfgInfo').textContent = '匯入失敗：' + (err.message || err);
    }
  };
  $('#cfgReset').onclick = () => {
    if (!confirm('清除全部設定（歌詞、段落、困難標記…）？音檔不會被清掉。')) return;
    try { localStorage.removeItem(LS_KEY); } catch {}
    location.reload();
  };
}

function renderSyncPanel() {
  $('#syncVal').textContent = `${S.syncMs > 0 ? '+' : ''}${S.syncMs} ms`;
  $('#syncRange').value = S.syncMs;
  $('#bpmIn').value = G.bpm.toFixed(3);
  $('#firstIn').value = G.firstBeat.toFixed(3);
  $('#bpbIn').value = G.beatsPerBar;
}

let secDraft = [];
function renderSecPanel() { secDraft = SEC.map(s => ({ name: s.name, start: s.start, kind: s.kind || 'other' })); renderSecRows(); }
function renderSecRows() {
  const body = $('#secBody');
  body.innerHTML = '';
  secDraft.sort((a, b) => a.start - b.start).forEach((s, i) => {
    const r = document.createElement('div');
    r.className = 'secrow';
    r.innerHTML = `
      <input class="nm" type="text" value="${esc(s.name)}">
      <input class="st" type="number" min="1" max="${BARS}" value="${s.start + 1}">
      <select class="kd">${Object.keys(KIND_COLOR).map(k => `<option value="${k}"${k === s.kind ? ' selected' : ''}>${k}</option>`).join('')}</select>
      <span class="t">${fmt(barT(s.start))}</span>
      <button class="del" title="刪除">✕</button>`;
    r.querySelector('.st').oninput = (e) => { s.start = Math.max(0, (parseInt(e.target.value, 10) || 1) - 1); r.querySelector('.t').textContent = fmt(barT(s.start)); };
    r.querySelector('.nm').oninput = (e) => s.name = e.target.value;
    r.querySelector('.kd').onchange = (e) => s.kind = e.target.value;
    r.querySelector('.del').onclick = () => { secDraft.splice(i, 1); renderSecRows(); };
    body.appendChild(r);
  });
}

// ------------------------------------------------------------------ 歌詞編輯
let syncIdx = 0;
function openLyricEditor() {
  const t = Ly.toText(LYR);
  $('#enTa').value = t.en;
  $('#zhTa').value = t.zh;
  $('#jsonTa').value = JSON.stringify(LYR, null, 1);
  $('#snapSel').value = String(S.snap || 0);
  $('#shiftInfo').textContent = S.shiftMs ? `累計 ${S.shiftMs > 0 ? '+' : ''}${S.shiftMs} ms` : '';
  renderSyncList();
  openPanel('#lyricPanel');
  showTab(Ly.hasAny(LYR) ? 'sync' : 'paste');
}
function showTab(name) {
  $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tabpane').forEach(p => p.classList.toggle('on', p.dataset.pane === name));
}
function bindLyricEditor() {
  $$('.tab').forEach(b => b.onclick = () => {
    showTab(b.dataset.tab);
    if (b.dataset.tab === 'sync') renderSyncList();
    if (b.dataset.tab === 'voice') renderVoiceList();
  });
  $('#voicePlay').onclick = () => eng.toggle();
  $$('[data-allvoice]').forEach(b => b.onclick = () => {
    const v = b.dataset.allvoice || null;
    if (!v && !confirm('清除全部聲部標註？')) return;
    for (const l of LYR.lines) if (!l.br) Ly.setLineVoice(l, v);
    saveVoices(); renderVoiceList();
    toast(v ? `整首設為${Ly.VOICE_NAME[v]}聲` : '聲部標註已清除');
  });
  $('#pasteApply').onclick = () => {
    let en = $('#enTa').value, zh = $('#zhTa').value, note = '';
    if ($('#cleanChk').checked) {
      const ce = Ly.cleanPaste(en), cz = Ly.cleanPaste(zh);
      en = ce.text; zh = cz.text;
      $('#enTa').value = en; $('#zhTa').value = zh;
      const rm = ce.removed + cz.removed;
      if (rm) note = `　(清掉 ${rm} 行雜訊`
        + (ce.markers.length ? `、${ce.markers.length} 個段落標記` : '') + ')';
    }
    const built = Ly.build(en, zh);
    if (!Ly.hasAny(built)) { toast('沒有讀到任何歌詞'); return; }
    // 重新匯入時沿用既有的聲部標註與打拍時間，不要整組被洗掉
    const { data: d, stats } = Ly.mergeKeep(LYR, built);
    commitLyrics(d);
    const n = d.lines.filter(l => !l.br).length;
    const s = d.lines.filter(l => !l.br && l.t !== null).length;
    const zn = d.lines.filter(l => !l.br && l.zh).length;
    let kept = '';
    if (stats.hadVoice || stats.hadTime) {
      const bits = [];
      if (stats.hadVoice) bits.push(`聲部 ${stats.keptVoice}/${stats.hadVoice}`);
      if (stats.hadTime) bits.push(`時間 ${stats.keptTime}/${stats.hadTime}`);
      kept = `　保留：${bits.join('、')}`;
      if (stats.droppedWords) kept += `（${stats.droppedWords} 句因字數變了，逐字標註改回整句）`;
    }
    toast(`匯入 ${n} 句${kept ? '，' + kept.trim() : `，其中 ${s} 句有時間`}`);
    $('#pasteInfo').textContent = `英文 ${n} 句 · 翻譯 ${zn} 句 · ${s} 句有時間${note}${kept}`
      + (zn && zn !== n ? '　⚠ 兩邊行數不一樣，翻譯可能錯位' : '');
    if (s === 0) { showTab('sync'); renderSyncList(); }
  };
  $('#snapSel').onchange = (e) => { S.snap = +e.target.value; save(); };
  $$('[data-shift]').forEach(b => b.onclick = () => {
    if (!Ly.isSynced(LYR)) { toast('還沒有任何時間標記'); return; }
    Ly.shiftAll(LYR, +b.dataset.shift);
    S.shiftMs = (S.shiftMs || 0) + +b.dataset.shift;
    $('#shiftInfo').textContent = `累計 ${S.shiftMs > 0 ? '+' : ''}${S.shiftMs} ms`;
    afterStampEdit();
  });
  $('#jsonApply').onclick = () => {
    try {
      const d = Ly.normalize(JSON.parse($('#jsonTa').value));
      if (!Ly.hasAny(d)) throw new Error('沒有歌詞內容');
      commitLyrics(d); toast('JSON 已套用');
    } catch (e) { toast('JSON 解析失敗：' + e.message); }
  };
  $('#jsonCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#jsonTa').value); toast('已複製'); }
    catch { $('#jsonTa').select(); toast('請按 Ctrl+C 複製'); }
  };
  $('#jsonDownload').onclick = () => {
    const blob = new Blob([JSON.stringify(LYR, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'lyrics.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  $('#jsonLoadFile').onclick = async () => {
    const d = await Ly.fetchFile();
    if (!d) { toast('找不到或讀不到 lyrics.json'); return; }
    commitLyrics(d);
    $('#jsonTa').value = JSON.stringify(LYR, null, 1);
    const t = Ly.toText(LYR); $('#enTa').value = t.en; $('#zhTa').value = t.zh;
    toast('已從 lyrics.json 重新載入');
  };
  $('#syncPlay').onclick = () => eng.toggle();
  $('#stampBtn').onclick = () => stamp();
  $('#unstampBtn').onclick = () => unstamp();
  $('#lyricPanel').addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return;
    if (e.key === 'Enter') { e.preventDefault(); stamp(); }
    else if (e.key === 'Backspace') { e.preventDefault(); unstamp(); }
    else if (e.key === ' ') { e.preventDefault(); eng.toggle(); }
  });
}
function commitLyrics(d) {
  LYR = Ly.normalize(d);
  TL = Ly.timeline(LYR);
  S.lyrics = LYR; save();
  applyMute();
  renderLyrics();
  $('#jsonTa').value = JSON.stringify(LYR, null, 1);
  renderSyncList();
  renderVoiceList();
}
function textRows() { return LYR.lines.map((l, i) => ({ l, i })).filter(r => !r.l.br); }
function renderSyncList() {
  const box = $('#syncList');
  const rows = textRows();
  box.innerHTML = '';
  if (!rows.length) { box.innerHTML = '<p class="dim" style="padding:14px">先在「貼上歌詞」頁匯入歌詞。</p>'; return; }
  if (syncIdx >= rows.length) syncIdx = rows.length - 1;
  rows.forEach((r, n) => {
    const d = document.createElement('div');
    d.className = 'sline' + (n === syncIdx ? ' cur' : '') + (r.l.t === null ? ' nostamp' : '');
    d.innerHTML = `<span class="idx">${n + 1}</span>
      <input type="number" step="0.01" value="${r.l.t === null ? '' : r.l.t.toFixed(2)}" placeholder="—">
      <button class="mk" title="設為目前播放位置">⟲</button>
      <span class="txt"></span>`;
    d.querySelector('.txt').textContent = r.l.en || '♪';
    if (r.l.zh) { const s = document.createElement('small'); s.textContent = r.l.zh; d.querySelector('.txt').appendChild(s); }
    const inp = d.querySelector('input');
    inp.onchange = () => {
      const v = parseFloat(inp.value);
      LYR.lines[r.i].t = isFinite(v) ? Math.max(0, v) : null;
      afterStampEdit();
    };
    d.querySelector('.mk').onclick = () => { LYR.lines[r.i].t = snapTime(eng.now); syncIdx = n + 1; afterStampEdit(); };
    d.onclick = (e) => { if (e.target === d || e.target.className === 'txt' || e.target.className === 'idx') { syncIdx = n; if (r.l.t !== null) eng.seek(Math.max(0, r.l.t - 0.3)); renderSyncList(); } };
    box.appendChild(d);
  });
  const done = rows.filter(r => r.l.t !== null).length;
  $('#stampInfo').textContent = `已標記 ${done} / ${rows.length}　下一句 #${Math.min(syncIdx + 1, rows.length)}`;
  const cur = box.children[syncIdx];
  if (cur) cur.scrollIntoView({ block: 'center' });
}
function afterStampEdit() {
  TL = Ly.timeline(LYR);
  S.lyrics = LYR; save();
  applyMute();
  renderLyrics(); renderSyncList();
  $('#jsonTa').value = JSON.stringify(LYR, null, 1);
}
/** 把打拍抓到的時間對齊到拍點（S.snap: 0=不對齊, 2=半拍, 1=整拍） */
function snapTime(t) {
  const d = +(S.snap || 0);
  if (!d) return +t.toFixed(2);
  const unit = G.beat / d;
  const k = Math.round((t - G.firstBeat) / unit);
  return +Math.max(0, G.firstBeat + k * unit).toFixed(3);
}
function stamp() {
  const rows = textRows();
  if (!rows.length || syncIdx >= rows.length) return;
  LYR.lines[rows[syncIdx].i].t = snapTime(eng.now);
  syncIdx++;
  afterStampEdit();
}
function unstamp() {
  const rows = textRows();
  syncIdx = Math.max(0, syncIdx - 1);
  if (rows[syncIdx]) {
    LYR.lines[rows[syncIdx].i].t = null;
    const back = rows[Math.max(0, syncIdx - 1)];
    if (back && back.l.t !== null) eng.seek(Math.max(0, back.l.t - 0.3));
  }
  afterStampEdit();
}

// ------------------------------------------------------------------ 每一格
function tick() {
  // 包起來：單一幀出錯不該讓整個畫面從此停止更新
  try { tickBody(); } catch (e) { console.error('tick error:', e); }
  requestAnimationFrame(tick);
}
function tickBody() {
  const t = eng.now;
  const D = eng.duration;

  // 播放頭
  if (ph) {
    // 由 canvas 本身的位置算，版型換欄位 / 改 padding 都不會跑掉
    const cv = $('#strip');
    ph.style.left = (cv.offsetLeft + (t / D) * cv.clientWidth).toFixed(1) + 'px';
    ph.style.top = cv.offsetTop + 'px';
    ph.style.height = cv.clientHeight + 'px';
  }

  // 時間
  $('#time').innerHTML = `${fmt(t)} <i>/ ${fmt(D)}</i>`;

  // 小節
  const b = tBar(t);
  if (b !== curBar) {
    if (cells[curBar]) { cells[curBar].classList.remove('cur'); cells[curBar].querySelector('.pg').style.width = '0%'; }
    curBar = b;
    if (cells[b]) {
      cells[b].classList.add('cur');
      const wrap = $('#gridWrap');
      const r = cells[b].getBoundingClientRect(), rw = wrap.getBoundingClientRect();
      if (r.top < rw.top || r.bottom > rw.bottom) cells[b].scrollIntoView({ block: 'nearest' });
    }
    const si = secOf(b);
    if (si !== curSec) {
      curSec = si;
      $$('#sectionBar button').forEach((x, i) => x.classList.toggle('on', i === si));
      const btn = $$('#sectionBar button')[si];
      if (btn) btn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
    $('#keyTag').textContent = `${SEC[curSec].name} · 第 ${b + 1} 小節`;
  }
  if (cells[curBar]) {
    const f = Math.max(0, Math.min(1, (t - barT(curBar)) / G.bar));
    cells[curBar].querySelector('.pg').style.width = (f * 100).toFixed(1) + '%';
  }

  // 歌詞
  if (S.lyricMode !== 'off' && TL.length) {
    let lo = 0, hi = TL.length - 1, idx = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (TL[m].t <= t + 0.04) { idx = m; lo = m + 1; } else hi = m - 1;
    }
    // 點歌詞跳播時高亮鎖在被點的那一行，直到播放頭真的走到它
    if (forceLine) {
      if (idx >= forceLine.k || t < forceLine.t - 1.2) forceLine = null;
      else idx = forceLine.k;
    }
    paintLyricHighlight(idx);
    // 自動捲動
    if (performance.now() > userScrollUntil && curLine >= 0) {
      const pad = $('#lyricPad');
      const el = pad.querySelector('.lrow.cur');
      if (el) {
        const target = el.offsetTop - pad.clientHeight * 0.42 + el.offsetHeight / 2;
        const now = pad.scrollTop;
        const d = target - now;
        if (Math.abs(d) > 1) pad.scrollTop = now + d * 0.14;
      }
    }
  }
}

// ------------------------------------------------------------------ utils
function fmt(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1500);
}
