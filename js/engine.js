// ---------------------------------------------------------------------------
// 音訊引擎（主執行緒）：載入、解碼、餵給 worklet、位置推算
// ---------------------------------------------------------------------------

import * as Store from './store.js';

const DEC = 8; // 與 worklet 內的 DEC 一致

/** 兩個音檔都找不到時丟這個，UI 會改成顯示「選擇本機音檔」 */
export class NeedAudioError extends Error {
  constructor(missing) {
    super('need audio files: ' + missing.join(', '));
    this.name = 'NeedAudioError';
    this.missing = missing;
  }
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.duration = 0;
    this.peaks = null;        // 波形（原曲）
    this.tempo = 1;
    this.semitones = 0;
    this.activeIdx = 0;       // 0 = 原曲, 1 = 伴奏
    this.loop = null;
    this.playing = false;
    this._pos = { t: 0, ct: 0, playing: false };
    this.onEnded = null;
    this.onPlayState = null;
    this.offsets = [0, 0];
  }

  async load(song, onProgress) {
    const names = ['vocal', 'inst'];
    const urls = names.map(n => song.tracks[n].url);
    this.offsets = names.map(n => song.tracks[n].offset);

    // 1) 取得音檔：先看這台電腦存過的，沒有才去伺服器抓
    const bufs = [];
    const missing = [];
    this.source = [];
    for (let i = 0; i < urls.length; i++) {
      const key = names[i];
      const label = song.tracks[key].label;
      const saved = await Store.getAudio(key);
      if (saved && saved.blob) {
        onProgress((i + 0.5) / urls.length * 0.55, `讀取已存的${label} …`);
        bufs.push(await saved.blob.arrayBuffer());
        this.source.push({ key, from: 'local', name: saved.name });
        continue;
      }
      try {
        onProgress(i / urls.length * 0.55, `下載 ${urls[i]} …`);
        bufs.push(await fetchWithProgress(urls[i], (frac, mb) => {
          onProgress((i + frac) / urls.length * 0.55, `下載 ${urls[i]} … ${mb}`);
        }));
        this.source.push({ key, from: 'server', name: urls[i] });
      } catch {
        bufs.push(null);
        missing.push(key);
      }
    }
    if (missing.length) throw new NeedAudioError(missing);

    // 2) AudioContext + worklet
    onProgress(0.58, '啟動音訊引擎 …');
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 44100, latencyHint: 'interactive',
    });
    await this.ctx.audioWorklet.addModule('js/stretch-worklet.js');

    // 3) 解碼
    const decoded = [];
    for (let i = 0; i < bufs.length; i++) {
      onProgress(0.6 + i * 0.16, `解碼 ${urls[i]} …`);
      decoded.push(await this.ctx.decodeAudioData(bufs[i]));
      bufs[i] = null;
    }

    // 4) 時間軸長度 = 兩軌都還有內容的範圍
    this.duration = Math.min(
      decoded[0].duration,
      decoded[1].duration - this.offsets[1]
    );

    // 5) 波形峰值（給總覽軸用）
    onProgress(0.92, '分析波形 …');
    this.peaks = buildPeaks(decoded[0], 2400);

    // 6) 搬進 worklet
    onProgress(0.95, '準備播放 …');
    const payload = [];
    const transfer = [];
    for (let i = 0; i < decoded.length; i++) {
      const ab = decoded[i];
      const ch = [];
      for (let c = 0; c < 2; c++) {
        const src = ab.getChannelData(Math.min(c, ab.numberOfChannels - 1));
        const copy = new Float32Array(src);       // 需要可轉移的 buffer
        ch.push(copy.buffer);
        transfer.push(copy.buffer);
      }
      const dec = buildDecimated(ab, DEC);
      transfer.push(dec.buffer);
      payload.push({ ch, dec: dec.buffer, offset: this.offsets[i] });
      decoded[i] = null;
    }

    this.node = new AudioWorkletNode(this.ctx, 'stretch', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pos') {
        this._pos = m;
        if (m.playing !== this.playing) {
          this.playing = m.playing;
          this.onPlayState && this.onPlayState(m.playing);
        }
      } else if (m.type === 'ended') {
        this.playing = false;
        this.onPlayState && this.onPlayState(false);
        this.onEnded && this.onEnded();
      }
    };
    this.node.connect(this.ctx.destination);
    this.node.port.postMessage({
      type: 'load', tracks: payload, duration: this.duration, active: this.activeIdx,
    }, transfer);

    onProgress(1, '完成');
    return this;
  }

  // ---- 位置 ----
  get now() {
    const p = this._pos;
    let t = p.t;
    if (p.playing && this.ctx) {
      const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
      t += (this.ctx.currentTime - p.ct - lat) * this.tempo;
      if (this.loop) {
        const len = this.loop.end - this.loop.start;
        if (len > 0 && t > this.loop.end) {
          t = this.loop.start + ((t - this.loop.start) % len);
        }
      }
    }
    return Math.max(0, Math.min(this.duration, t));
  }

  // ---- 控制 ----
  async play() {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.now >= this.duration - 0.05) this.seek(this.loop ? this.loop.start : 0);
    this.playing = true;
    this.send({ type: 'play', on: true });
    this.onPlayState && this.onPlayState(true);
  }
  pause() {
    this.playing = false;
    this.send({ type: 'play', on: false });
    this.onPlayState && this.onPlayState(false);
  }
  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    t = Math.max(0, Math.min(this.duration, t));
    this._pos = { t, ct: this.ctx ? this.ctx.currentTime : 0, playing: this.playing };
    this.send({ type: 'seek', t });
    this.onSeek && this.onSeek(t);
  }
  setTempo(v) { this.tempo = v; this.send({ type: 'tempo', v }); }
  setSemitones(n) {
    this.semitones = n;
    this.send({ type: 'pitch', v: Math.pow(2, n / 12) });
  }
  setActive(i) { this.activeIdx = i; this.send({ type: 'active', i }); }
  setVolume(v) { this.send({ type: 'vol', v }); }
  setLoop(loop) { this.loop = loop; this.send({ type: 'loop', loop }); }
  setInstOffset(sec) {
    this.offsets[1] = sec;
    this.send({ type: 'offset', i: 1, v: sec });
  }
  send(m) { this.node && this.node.port.postMessage(m); }
}

// ---------------------------------------------------------------------------
async function fetchWithProgress(url, onProg) {
  const res = await fetch(encodeURI(url));
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const total = +(res.headers.get('content-length') || 0);
  if (!res.body || !total) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProg(got / total, `${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

function buildPeaks(ab, n) {
  const L = ab.getChannelData(0);
  const R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L;
  const step = Math.floor(L.length / n);
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = i * step, b = Math.min(L.length, a + step);
    for (let j = a; j < b; j += 3) {
      const v = Math.abs(L[j] + R[j]) * 0.5;
      if (v > m) m = v;
    }
    peaks[i] = m;
  }
  return peaks;
}

function buildDecimated(ab, dec) {
  const L = ab.getChannelData(0);
  const R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L;
  const n = Math.floor(L.length / dec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * dec;
    for (let k = 0; k < dec; k++) s += (L[o + k] + R[o + k]) * 0.5;
    out[i] = s / dec;
  }
  return out;
}
