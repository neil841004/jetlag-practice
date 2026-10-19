// ---------------------------------------------------------------------------
// 歌詞資料：解析（純文字 / .lrc）、合併英中、存取
//
// 本程式不內建任何歌詞內容；歌詞與翻譯由使用者自己貼上或放 lyrics.json。
// 資料格式：{ version:1, lines:[ {t:秒|null, en:"…", zh:"…"} | {br:true} ] }
// ---------------------------------------------------------------------------

const LRC_TAG = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const META_TAG = /^\s*\[(ti|ar|al|by|au|la|re|ve|length|offset)\s*:(.*)\]\s*$/i;

// ---------------------------------------------------------------------------
// 從歌詞網頁整段複製下來的文字，通常夾著 [Verse 1] [Chorus] 這類段落標記與
// 頁面雜訊。這裡把它們清掉：段落標記換成空行（變成分句間隔），雜訊整行丟掉。
// ---------------------------------------------------------------------------
// 只認方括號 [] —— 歌詞裡整行括號 (…) 通常是和聲／回應句，要保留
const BRACKET_LINE = /^\s*\[([^\]]*)\]\s*$/;
const NOISE_LINE = [
  /^\d+\s*(contributors?|viewers?)\b/i,
  /^(translations?|read\s*more|embed|lyrics|romanization)\s*$/i,
  /^see .+ live$/i,
  /^get tickets/i,
  /^\d+\s*$/,
  /^share\b/i,
  /^(produced by|written by|release date)\b/i,
];
// 這些標題後面會接一整串推薦歌曲／歌手名，整塊丟到空行為止
const BLOCK_START = /^(you might also like|related songs?|more on genius|see all)/i;
const SECTION_WORD = /^(intro|verse|pre[-\s]?chorus|post[-\s]?chorus|chorus|bridge|hook|refrain|outro|interlude|instrumental|breakdown|solo|ad[-\s]?lib|repeat|coda|背景|前奏|主歌|副歌|導歌|橋段|尾奏)/i;

export function cleanPaste(raw) {
  const src = (raw || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const markers = [];
  let removed = 0;

  let skipping = false;   // 正在略過「推薦歌曲」那一整塊

  src.forEach((line, i) => {
    const s = line.trim();

    if (skipping) {
      // 空行代表那塊結束
      if (!s) { skipping = false; out.push(''); } else { removed++; }
      return;
    }
    if (!s) { out.push(''); return; }

    // 標題行： "Jet Lag Lyrics" 之類（只看最前面幾行）
    if (i < 4 && /\blyrics\b\s*$/i.test(s) && !LRC_TAG.test(s)) { removed++; return; }
    LRC_TAG.lastIndex = 0;

    if (BLOCK_START.test(s)) { skipping = true; removed++; return; }
    if (NOISE_LINE.some(re => re.test(s))) { removed++; return; }

    const br = s.match(BRACKET_LINE);
    if (br && !/\d{1,3}:\d{2}/.test(s)) {
      // [Verse 1: Pierre] / [Chorus] → 當成分句間隔，記下名稱
      const name = br[1].split(':')[0].trim();
      if (SECTION_WORD.test(name) || name.length <= 24) {
        markers.push(name);
        out.push('');
        removed++;
        return;
      }
    }
    out.push(s);
  });

  // 連續空行收成一行、去頭尾空行
  const res = [];
  for (const l of out) {
    if (l === '' && (res.length === 0 || res[res.length - 1] === '')) continue;
    res.push(l);
  }
  while (res.length && res[res.length - 1] === '') res.pop();
  return { text: res.join('\n'), removed, markers, lines: res.filter(l => l !== '').length };
}

/** 把所有已標記的時間整體平移 ms 毫秒 */
export function shiftAll(data, ms) {
  for (const l of data.lines) {
    if (!l.br && typeof l.t === 'number') l.t = Math.max(0, +(l.t + ms / 1000).toFixed(3));
  }
  return data;
}

export function parseText(raw) {
  const text = (raw || '').replace(/\r\n?/g, '\n');
  let metaOffset = 0;
  let hasTime = false;
  const out = [];

  for (const line of text.split('\n')) {
    const meta = line.match(META_TAG);
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') metaOffset = (parseFloat(meta[2]) || 0) / 1000;
      continue;
    }
    LRC_TAG.lastIndex = 0;
    const times = [];
    let m;
    while ((m = LRC_TAG.exec(line)) !== null) {
      times.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')));
    }
    const body = line.replace(LRC_TAG, '').trim();
    if (times.length) {
      hasTime = true;
      for (const t of times) out.push({ t, text: body });
    } else if (!body) {
      out.push({ t: null, text: '', br: true });
    } else {
      out.push({ t: null, text: body });
    }
  }

  if (hasTime) {
    const timed = out.filter(l => l.t !== null && l.text !== '');
    timed.sort((a, b) => a.t - b.t);
    for (const l of timed) l.t = Math.max(0, l.t + metaOffset);
    return { lines: timed, hasTime: true };
  }
  // 純文字：去掉頭尾空行
  while (out.length && out[0].br) out.shift();
  while (out.length && out[out.length - 1].br) out.pop();
  return { lines: out, hasTime: false };
}

export function build(enRaw, zhRaw) {
  const en = parseText(enRaw);
  const zh = parseText(zhRaw);
  const zhLines = zh.lines.filter(l => !l.br);
  const lines = [];
  let zi = 0;
  for (const l of en.lines) {
    if (l.br) { lines.push({ br: true }); continue; }
    let zhText = '';
    if (zh.hasTime && zhLines.length) {
      // 兩邊都有時間標記 → 用時間就近配對
      let best = -1, bd = 1e9;
      for (let i = 0; i < zhLines.length; i++) {
        const d = Math.abs((zhLines[i].t ?? 1e9) - l.t);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0 && bd < 1.2) zhText = zhLines[best].text;
    } else {
      zhText = zhLines[zi] ? zhLines[zi].text : '';
      zi++;
    }
    lines.push({ t: l.t ?? null, en: l.text, zh: zhText });
  }
  return { version: 1, lines };
}

export function normalize(data) {
  if (!data || !Array.isArray(data.lines)) return { version: 1, lines: [] };
  const lines = data.lines.map(l => {
    if (l && l.br) return { br: true };
    return {
      t: (typeof l.t === 'number' && isFinite(l.t)) ? l.t : null,
      en: String(l?.en ?? ''),
      zh: String(l?.zh ?? ''),
    };
  });
  return { version: 1, lines };
}

export function hasAny(data) {
  return !!data && data.lines.some(l => !l.br && (l.en || l.zh));
}

export function isSynced(data) {
  return !!data && data.lines.some(l => !l.br && l.t !== null);
}

/** 可唱的行（有文字），依時間排序後給 UI 用 */
export function timeline(data) {
  return data.lines
    .map((l, i) => ({ ...l, i }))
    .filter(l => !l.br && l.t !== null)
    .sort((a, b) => a.t - b.t);
}

export async function fetchFile(url = 'lyrics.json') {
  try {
    const r = await fetch(url + '?t=' + Date.now());
    if (!r.ok) return null;
    const j = await r.json();
    return hasAny(normalize(j)) ? normalize(j) : null;
  } catch { return null; }
}

export function toText(data) {
  const en = [], zh = [];
  for (const l of data.lines) {
    if (l.br) { en.push(''); zh.push(''); continue; }
    en.push((l.t !== null ? `[${fmtLrc(l.t)}]` : '') + l.en);
    zh.push(l.zh);
  }
  return { en: en.join('\n'), zh: zh.join('\n') };
}

export function fmtLrc(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
