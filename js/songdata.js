// ---------------------------------------------------------------------------
// Jet Lag 練唱室 — 歌曲資料
//
// 下面的數值都是用 ffmpeg + 頻譜/節奏分析從這兩個音檔實測出來的，不是猜的：
//   * BPM 145.0 (4/4)，第 1 小節起點 0.582 s，全曲 120 小節
//   * 伴奏 (無人聲 wav) 比原曲 (mp3) 晚 2.825 s，整首一致、沒有漂移
//     (伴奏開頭多了 4 拍 count-in；兩軌速度與調性相同)
//   * 段落起點由自相似矩陣 / 新奇度曲線偵測，可在 UI 的「段落」面板修正
// ---------------------------------------------------------------------------

export const SONG = {
  title: 'Jet Lag',
  artist: 'Simple Plan',

  // 時間軸以「原曲 mp3」為基準
  tracks: {
    vocal: { url: 'Jet Lag.mp3',        offset: 0,     label: '原曲' },
    inst:  { url: 'Jet Lag無人聲.wav',  offset: 2.825, label: '伴奏' },
  },

  grid: {
    bpm: 144.998,       // 實測
    beatsPerBar: 4,
    firstBeat: 0.582145, // 第 1 小節的起點（秒）
    bars: 120,
  },

  // start = 起始小節 (0-based)
  sections: [
    { name: '前奏',   start: 0,   kind: 'intro'  },
    { name: '主歌 1', start: 8,   kind: 'verse'  },
    { name: '導歌 1', start: 24,  kind: 'pre'    },
    { name: '副歌 1', start: 32,  kind: 'chorus' },
    { name: '主歌 2', start: 42,  kind: 'verse'  },
    { name: '導歌 2', start: 58,  kind: 'pre'    },
    { name: '副歌 2', start: 66,  kind: 'chorus' },
    { name: '橋段',   start: 76,  kind: 'bridge' },
    { name: '副歌 3', start: 92,  kind: 'chorus' },
    { name: '副歌 4', start: 108, kind: 'chorus' },
    { name: '尾奏',   start: 116, kind: 'outro'  },
  ],
};

export const KIND_COLOR = {
  intro:  '#2f3a49',
  verse:  '#1f4356',
  pre:    '#2b3f62',
  chorus: '#4a2f5e',
  bridge: '#2c4a3e',
  outro:  '#3a3a46',
  other:  '#2b3645',
};

// 小節格線工具 ------------------------------------------------------------
export function makeGrid(g) {
  const beat = 60 / g.bpm;
  const bar = beat * g.beatsPerBar;
  return {
    ...g,
    beat, bar,
    barTime: (i) => g.firstBeat + i * bar,
    // 給定時間 → 小節序號（可為負，播放到第 1 小節之前時）
    timeBar: (t) => Math.floor((t - g.firstBeat) / bar),
    clampBar: (i) => Math.max(0, Math.min(g.bars - 1, i)),
  };
}
