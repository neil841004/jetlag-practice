// ---------------------------------------------------------------------------
// 雙軌 WSOLA 時間伸縮 / 移調引擎  (AudioWorkletProcessor)
//
// 兩個音軌（原曲 / 伴奏）共用同一條時間軸 timeline（以原曲時間為基準），
// 各自用自己的 offset 去讀取樣本，所以切換人聲只是增益淡入淡出，位置不會跳。
//
// 速度 (tempo T) 與 移調 (pitch P = 2^(半音/12)) 互相獨立：
//   * 每個 synthesis hop 輸出 HOP 個樣本，來源位置前進 T*HOP 個樣本  → 速度 = T
//   * frame 內以 stride P 重新取樣                                   → 音高 = P
//   * WSOLA：在理想位置 ±SEEK 內找與前一個 frame 尾端最相似的起點，
//     用 Hann 窗 50% overlap-add 接起來（窗和恆為 1，不會有音量起伏）
//   * T=1 且 P=1 時完全跳過搜尋 → δ=0，overlap-add 等於原樣重建（無損）
// ---------------------------------------------------------------------------

const FRAME = 2048;        // 46 ms @44.1k
const HOP = FRAME >> 1;    // 23 ms，Hann 50% overlap → COLA
const SEEK = 640;          // WSOLA 搜尋範圍 ±14.5 ms
const DEC = 8;             // 粗搜尋抽樣率
const MDEC = HOP / DEC;    // 粗搜尋長度 (128)
const FADE = 0.014;        // 播放/暫停淡化秒數
const XFADE = 0.07;        // 人聲切換淡化秒數

class Track {
  constructor(chans, dec, offset) {
    this.ch = chans;                       // [Float32Array L, Float32Array R]
    this.dec = dec;                        // 抽樣後的單聲道（WSOLA 粗搜尋用）
    this.offset = offset;                  // 相對於 timeline 的時間位移（秒）
    this.len = chans[0].length;
    this.accL = new Float32Array(FRAME);   // overlap-add 累加區
    this.accR = new Float32Array(FRAME);
    this.outL = new Float32Array(HOP);     // 本 hop 可輸出的樣本
    this.outR = new Float32Array(HOP);
    this.tail = new Float32Array(HOP);     // 前一 frame 的單聲道尾端（輸出域）
    this.tailDec = new Float32Array(MDEC);
    this.hasTail = false;
    this.gain = 0;
    this.target = 0;
  }
}

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.tracks = [];
    this.win = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME);
    this.mono = new Float32Array(FRAME);

    this.timeline = 0;      // 目前播放位置（原曲時間，秒）
    this.hopTime = 0;       // 本 hop 第一個輸出樣本對應的 timeline
    this.hopDt = 0;         // 本 hop 涵蓋的 timeline 長度
    this.duration = 0;
    this.playing = false;
    this.tempo = 1;
    this.pitch = 1;
    this.vol = 0.85;
    this.loop = null;       // {start,end}
    this.q = HOP;           // 輸出游標（= HOP 表示需要產生新 hop）
    this.env = 0;           // 播放淡化包絡
    this.skipSearch = true;
    this.userActive = 0;   // 使用者選的音軌（0=原曲 1=伴奏）
    this.mute = [];        // 依聲部標註要改放伴奏的 [start,end] 區間
    this.ready = false;
    this.tick = 0;

    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    switch (m.type) {
      case 'load': {
        this.tracks = m.tracks.map(t => new Track(
          t.ch.map(b => new Float32Array(b)),
          new Float32Array(t.dec),
          t.offset));
        this.duration = m.duration;
        this.userActive = m.active | 0;
        this.tracks.forEach((t, i) => { t.gain = t.target = (i === this.userActive ? 1 : 0); });
        this.ready = true;
        this.q = HOP;
        break;
      }
      case 'play':   this.playing = !!m.on; if (m.on) this.skipSearch = true; break;
      case 'seek':
        this.timeline = Math.max(0, Math.min(this.duration, m.t));
        this.skipSearch = true;
        // 讓回報位置立刻反映新位置（下一個 hop 產生前 hopTime 仍是舊值）
        this.hopTime = this.timeline;
        this.hopDt = 0;
        this.applyTargets();
        if (!this.playing) this.clearAcc();
        this.post();
        break;
      case 'tempo':  this.tempo = m.v; break;
      case 'pitch':  this.pitch = m.v; break;
      case 'vol':    this.vol = m.v; break;
      case 'active':
        this.userActive = m.i;
        this.applyTargets();
        break;
      case 'mute':                       // 依聲部要改放伴奏的時間區間
        this.mute = Array.isArray(m.ranges) ? m.ranges : [];
        this.applyTargets();
        break;
      case 'loop':   this.loop = m.loop; break;
      case 'offset':
        if (this.tracks[m.i]) { this.tracks[m.i].offset = m.v; this.skipSearch = true; }
        break;
    }
  }

  /** 目前這個時間點該放哪一軌：人聲關掉、或落在被關掉的聲部區間 → 伴奏 */
  wantTrack(t) {
    if (this.userActive !== 0) return this.userActive;
    return this.inMute(t) ? 1 : 0;
  }
  inMute(t) {
    const r = this.mute;
    if (!r || !r.length) return false;
    let lo = 0, hi = r.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (t < r[m][0]) hi = m - 1;
      else if (t >= r[m][1]) lo = m + 1;
      else return true;
    }
    return false;
  }
  applyTargets() {
    const want = this.wantTrack(this.timeline);
    for (let i = 0; i < this.tracks.length; i++) {
      this.tracks[i].target = (i === want) ? 1 : 0;
    }
  }

  clearAcc() {
    for (const t of this.tracks) { t.accL.fill(0); t.accR.fill(0); t.hasTail = false; }
  }

  // ---- 取一個 frame：以 stride P 線性內插重新取樣，順便疊進 acc 與算 mono ----
  readFrame(tr, pos, P) {
    const L = tr.ch[0], R = tr.ch[1], n = tr.len;
    const aL = tr.accL, aR = tr.accR, w = this.win, mo = this.mono;
    if (P === 1) {
      const base = Math.round(pos);
      for (let k = 0; k < FRAME; k++) {
        const i = base + k;
        const l = (i >= 0 && i < n) ? L[i] : 0;
        const r = (i >= 0 && i < n) ? R[i] : 0;
        mo[k] = (l + r) * 0.5;
        const ww = w[k];
        aL[k] += l * ww; aR[k] += r * ww;
      }
      return;
    }
    for (let k = 0; k < FRAME; k++) {
      const s = pos + k * P;
      let l = 0, r = 0;
      if (s >= 0 && s < n - 1) {
        const i = s | 0, f = s - i;
        l = L[i] + (L[i + 1] - L[i]) * f;
        r = R[i] + (R[i + 1] - R[i]) * f;
      }
      mo[k] = (l + r) * 0.5;
      const ww = w[k];
      aL[k] += l * ww; aR[k] += r * ww;
    }
  }

  // ---- WSOLA：在 ideal ±SEEK 找最佳 δ ----
  search(tr, ideal, P) {
    if (!tr.hasTail) return 0;
    const dec = tr.dec, nd = dec.length, td = tr.tailDec;
    let bestC = -1e30, bestD = 0;
    for (let d = -SEEK; d <= SEEK; d += DEC) {
      const base = (ideal + d) / DEC;
      let num = 0, den = 1e-9;
      for (let j = 0; j < MDEC; j++) {
        const idx = (base + j * P) | 0;
        const v = (idx >= 0 && idx < nd) ? dec[idx] : 0;
        num += v * td[j]; den += v * v;
      }
      const c = num / Math.sqrt(den);
      if (c > bestC) { bestC = c; bestD = d; }
    }
    // 全取樣率細修
    const L = tr.ch[0], R = tr.ch[1], n = tr.len, tail = tr.tail;
    let bC = -1e30, bD = bestD;
    for (let d = bestD - DEC; d <= bestD + DEC; d++) {
      const p = ideal + d;
      let num = 0, den = 1e-9;
      for (let j = 0; j < HOP; j += 4) {
        const s = p + j * P;
        let v = 0;
        if (s >= 0 && s < n - 1) {
          const i = s | 0, f = s - i;
          v = ((L[i] + (L[i + 1] - L[i]) * f) + (R[i] + (R[i + 1] - R[i]) * f)) * 0.5;
        }
        num += v * tail[j]; den += v * v;
      }
      const c = num / Math.sqrt(den);
      if (c > bC) { bC = c; bD = d; }
    }
    return bD;
  }

  genHop() {
    const sr = this.sr;
    const identity = (this.tempo === 1 && this.pitch === 1);
    let dt = HOP * this.tempo / sr;
    let wrap = false;

    if (this.loop && this.timeline + dt > this.loop.end - 1e-9) {
      dt = Math.max(0, this.loop.end - this.timeline);
      wrap = true;
    }
    let ending = false;
    if (!wrap && this.timeline + dt >= this.duration) { ending = true; }

    this.hopTime = this.timeline;
    this.hopDt = dt;
    this.applyTargets();

    for (const tr of this.tracks) {
      const ideal = (this.timeline + tr.offset) * sr;
      const d = (identity || this.skipSearch) ? 0 : this.search(tr, ideal, this.pitch);
      this.readFrame(tr, ideal + d, this.pitch);

      // 輸出已完成的前 HOP 個樣本，acc 左移
      const aL = tr.accL, aR = tr.accR;
      tr.outL.set(aL.subarray(0, HOP));
      tr.outR.set(aR.subarray(0, HOP));
      aL.copyWithin(0, HOP); aR.copyWithin(0, HOP);
      aL.fill(0, HOP); aR.fill(0, HOP);

      // 留下尾端給下一 hop 做 WSOLA 比對
      const mo = this.mono;
      for (let j = 0; j < HOP; j++) tr.tail[j] = mo[HOP + j];
      for (let j = 0; j < MDEC; j++) {
        let s = 0;
        const o = HOP + j * DEC;
        for (let k = 0; k < DEC; k++) s += mo[o + k];
        tr.tailDec[j] = s / DEC;
      }
      tr.hasTail = true;
    }

    this.skipSearch = false;
    this.timeline += dt;
    if (wrap) { this.timeline = this.loop.start; this.skipSearch = true; }
    if (ending) {
      this.timeline = this.duration;
      this.playing = false;
      this.port.postMessage({ type: 'ended' });
    }
  }

  post() {
    this.port.postMessage({
      type: 'pos',
      t: this.hopTime + (this.q / HOP) * this.hopDt,
      playing: this.playing,
      ct: currentTime,
    });
  }

  process(_in, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;
    if (!this.ready) return true;

    const fadeStep = 1 / (FADE * this.sr);
    const xStep = 1 / (XFADE * this.sr);
    const tgt = this.playing ? 1 : 0;
    const trs = this.tracks, nt = trs.length;

    for (let i = 0; i < n; i++) {
      // 播放包絡
      if (this.env < tgt) this.env = Math.min(tgt, this.env + fadeStep);
      else if (this.env > tgt) this.env = Math.max(tgt, this.env - fadeStep);

      if (this.env <= 0 && !this.playing) { oL[i] = 0; oR[i] = 0; continue; }

      if (this.q >= HOP) { this.genHop(); this.q = 0; }

      let l = 0, r = 0;
      const q = this.q;
      for (let k = 0; k < nt; k++) {
        const tr = trs[k];
        if (tr.gain < tr.target) tr.gain = Math.min(tr.target, tr.gain + xStep);
        else if (tr.gain > tr.target) tr.gain = Math.max(tr.target, tr.gain - xStep);
        const g = tr.gain;
        if (g > 0) { l += tr.outL[q] * g; r += tr.outR[q] * g; }
      }
      const v = this.vol * this.env;
      oL[i] = l * v; oR[i] = r * v;
      this.q++;
    }

    if ((this.tick++ & 15) === 0) this.post();
    return true;
  }
}

registerProcessor('stretch', StretchProcessor);
