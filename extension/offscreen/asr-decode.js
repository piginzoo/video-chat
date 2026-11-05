// 视频讲解器 · offscreen 音频解码器
// 在独立进程里：下载音轨 → decodeAudioData → 28s 切片 → 重采样 16k mono → 编码 WAV
// 每片以 base64 发回 sidepanel 上传。独立进程避免大解码阻塞面板 UI。

const CHUNK_SEC = 28;
const TARGET_RATE = 16000;

function b64FromBytes(u8) {
  let s = '';
  const STEP = 0x8000;
  for (let i = 0; i < u8.length; i += STEP) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + STEP));
  }
  return btoa(s);
}

function encodeWav(samplesFloat32, sampleRate) {
  const n = samplesFloat32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  ws(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);       // PCM
  v.setUint16(22, 1, true);       // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ws(36, 'data');
  v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samplesFloat32[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

async function resampleChunk(fullBuffer, startSec, durSec) {
  const rate = TARGET_RATE;
  const len = Math.max(1, Math.floor(durSec * rate));
  const octx = new OfflineAudioContext(1, len, rate);
  const src = octx.createBufferSource();
  src.buffer = fullBuffer;
  const startAt = Math.min(startSec, Math.max(0, fullBuffer.duration - 0.01));
  const playDur = Math.min(durSec, fullBuffer.duration - startAt);
  src.connect(octx.destination);
  src.start(0, startAt, playDur);
  const rendered = await octx.startRendering();
  return rendered.getChannelData(0);
}

async function runPipeline({ url, credentials, chunkSec }) {
  // 1. 下载（捕获的播放器分片 URL 可能带 range= 参数，剥掉以拉取完整文件）
  let dlUrl = url;
  try {
    const u = new URL(dlUrl);
    if (u.searchParams.has('range')) {
      u.searchParams.delete('range');
      dlUrl = u.toString();
    }
  } catch (e) { /* 保底原样 */ }
  const resp = await fetch(dlUrl, { credentials: credentials ? 'include' : 'same-origin' });
  if (!resp.ok) throw new Error(`音轨下载失败 HTTP ${resp.status}`);
  const ab = await resp.arrayBuffer();
  // 2. 解码
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let full;
  try {
    full = await ctx.decodeAudioData(ab);
  } finally {
    ctx.close().catch(() => {});
  }
  const dur = full.duration;
  await chrome.runtime.sendMessage({ type: 'VJX_ASR_DECODED', durationSec: dur, sizeBytes: ab.byteLength });

  // 3. 切片 + 编码 + 回传
  const total = Math.ceil(dur / chunkSec);
  for (let i = 0; i < total; i++) {
    const startSec = i * chunkSec;
    const pcm = await resampleChunk(full, startSec, chunkSec);
    const wav = encodeWav(pcm, TARGET_RATE);
    await chrome.runtime.sendMessage({
      type: 'VJX_ASR_CHUNK',
      index: i,
      startSec,
      durationSec: chunkSec,
      wavB64: b64FromBytes(wav),
    });
    await chrome.runtime.sendMessage({ type: 'VJX_ASR_SLICED', done: i + 1, total });
  }
  await chrome.runtime.sendMessage({ type: 'VJX_ASR_ENCODE_DONE', total });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.cmd !== 'VJX_ASR_START') return;
  runPipeline({ url: msg.url, credentials: !!msg.credentials, chunkSec: msg.chunkSec || CHUNK_SEC })
    .catch((e) => {
      chrome.runtime.sendMessage({ type: 'VJX_ASR_ERROR', message: String((e && e.message) || e) }).catch(() => {});
    });
});
