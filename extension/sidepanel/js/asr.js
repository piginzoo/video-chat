// 视频讲解器 · ASR 听录管线（ADR-011）
// offscreen 解码（28s WAV 块）→ 并发上传 glm-asr → 块内时间插值 → rows
// 余额不足/配额错误友好提示；缓存由 app.js 落 storage。

const CONCURRENCY = 3;

export class ASRError extends Error {
  constructor(kind, friendly) {
    super(kind);
    this.friendly = friendly || kind;
  }
}

function friendlyAsrError(status, bodyText) {
  const t = bodyText || '';
  let detail = '';
  try {
    const j = JSON.parse(t);
    detail = (j.error && (j.error.message || j.error.code)) || '';
  } catch (e) { detail = t.slice(0, 80); }
  if (/余额|欠费|balance|arrears|recharge/i.test(detail) || status === 402) {
    return 'ASR 余额不足：请到智谱开放平台控制台给账户充值（按量计费部分，与 Coding Plan 分开）';
  }
  if (/未认证|unauthorized|invalid api key|token/i.test(detail) || status === 401) {
    return 'ASR Key 无效，请检查「设置」里 ASR 语音识别的 API Key';
  }
  if (status === 429) return 'ASR 请求过于频繁，请稍后重试';
  return `ASR 服务错误（HTTP ${status}）：${detail || '未知'}`;
}

// 小型 WAV 合成（连通性测试用）：0.6 秒 16k mono 静音+微噪声
export function tinyTestWav() {
  const rate = 16000;
  const n = Math.floor(rate * 0.6);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) { v.setInt16(off, Math.round(300 * Math.sin((i / rate) * 440 * 2 * Math.PI)), true); off += 2; }
  return new Uint8Array(buf);
}

async function transcribeChunk(wavBlob, settings, signal) {
  const cfg = settings.asr;
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const fd = new FormData();
  fd.append('file', wavBlob, 'chunk.wav');
  fd.append('model', cfg.model || 'glm-asr-2512');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: fd,
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ASRError(`http_${res.status}`, friendlyAsrError(res.status, text));
  }
  try {
    const j = JSON.parse(text);
    return String(j.text || '').trim();
  } catch (e) {
    throw new ASRError('parse', 'ASR 响应解析失败：' + text.slice(0, 80));
  }
}

// 连通性测试：{ok, message}
export async function asrTestConnectivity(settings) {
  try {
    const blob = new Blob([tinyTestWav()], { type: 'audio/wav' });
    const text = await transcribeChunk(blob, settings, undefined);
    return { ok: true, message: `连接成功 · 模型 ${settings.asr.model} · 返回「${(text || '（空）').slice(0, 12)}」` };
  } catch (e) {
    const msg = e instanceof ASRError ? e.friendly : String(e.message || e);
    return { ok: false, message: msg };
  }
}

// —— 主管线 ——
// getAudioUrl: () => Promise<{url, credentials}> 由 app 注入（site 相关）
// onPhase(phase, info): 'downloading' {received,total} | 'decoding' | 'slicing' {done,total} | 'transcribing' {done,total}
export async function runAsrPipeline({ settings, getAudioUrl, durationSec, signal, onPhase }) {
  // 0. 前置检查
  if (!settings.asr.apiKey) {
    throw new ASRError('no_key', '请先在「设置」的 ASR 语音识别区填入 API Key');
  }
  if (durationSec > 3600) {
    throw new ASRError('too_long', 'AI 听录暂不支持超过 60 分钟的视频（解码内存限制），敬请期待后续版本');
  }

  // 1. 拿音轨地址
  onPhase('preparing');
  const audio = await getAudioUrl();
  if (!audio || !audio.url) {
    throw new ASRError('no_audio', '无法获取该视频的音轨地址（可能需要登录或视频格式不支持）');
  }

  // 2. 确保 offscreen 解码器存在
  await ensureOffscreen();

  // 3. 消息通道准备（chunk 队列）
  const chunkQueue = [];
  let encodeDone = false;
  let pipelineError = null;
  const state = { rows: [], transcribed: 0, total: 0 };

  const listener = (msg) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'VJX_ASR_DECODED':
        onPhase('decoding', { durationSec: msg.durationSec });
        break;
      case 'VJX_ASR_CHUNK':
        chunkQueue.push(msg);
        break;
      case 'VJX_ASR_SLICED':
        onPhase('slicing', { done: msg.done, total: msg.total });
        break;
      case 'VJX_ASR_ENCODE_DONE':
        encodeDone = true;
        break;
      case 'VJX_ASR_ERROR':
        pipelineError = msg.message;
        break;
    }
  };
  chrome.runtime.onMessage.addListener(listener);

  try {
    // 触发 offscreen 管线
    await chrome.runtime.sendMessage({
      cmd: 'VJX_ASR_START',
      url: audio.url,
      credentials: !!audio.credentials,
      chunkSec: 28,
    }).catch(() => {});

    // 4. 下载进度（粗粒度：offscreen 内部下载，这里展示阶段动画）
    onPhase('downloading', {});

    // 5. 消费队列并发上传
    let cursor = 0;
    const failures = [];
    const worker = async () => {
      while (true) {
        if (signal && signal.aborted) return;
        if (pipelineError) throw new ASRError('pipeline', pipelineError);
        if (cursor >= chunkQueue.length) {
          if (encodeDone) return;
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        const item = chunkQueue[cursor++];
        const bytes = Uint8Array.from(atob(item.wavB64), (ch) => ch.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'audio/wav' });
        let text = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            text = await transcribeChunk(blob, settings, signal);
            break;
          } catch (e) {
            if (signal && signal.aborted) throw e;
            if (attempt === 1) {
              failures.push(item.index);
              logFail(e);
              break;
            }
            await new Promise((r) => setTimeout(r, 800));
          }
        }
        if (text) {
          appendBlockRows(state.rows, item.startSec, item.durationSec, text);
        }
        state.transcribed++;
        if (onPhase) onPhase('transcribing', { done: state.transcribed, total: Math.max(state.total, chunkQueue.length), text });
      }
    };
    const logFail = (e) => {
      const m = e instanceof ASRError ? e.friendly : String(e.message || e);
      state.rows.__lastError = m;
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (signal && signal.aborted) throw new ASRError('cancelled', '已取消');
    if (pipelineError) throw new ASRError('pipeline', pipelineError);
    if (!state.rows.length) {
      throw new ASRError('empty', state.rows.__lastError || '音轨识别完成但没有得到文本（可能是纯音乐/无语音视频）');
    }
    state.rows.sort((a, b) => a.t - b.t);
    // 语言探测：转写文本以中文字符为主 → 无需翻译；否则（如英文语音）标记为需翻译
    const sample = state.rows.slice(0, 40).map((r) => r.text).join('');
    const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
    const lang = cjk / Math.max(1, sample.length) > 0.25 ? 'asr-zh' : 'asr-en';
    return { rows: state.rows, failedChunks: failures.length, durationSec, lang };
  } finally {
    chrome.runtime.onMessage.removeListener(listener);
    closeOffscreen().catch(() => {});
  }
}

// —— YouTube 实时捕获管线（ADR-011 v3）——
// SABR 时代拿不到音频直链 → 页面内捕获 <video> 音频（自动静音）→ 28s WAV 块上传。
// 耗时 ≈ 视频时长（用户可同步观看画面）；时间戳直接取视频 currentTime，精确。
// startCapture/stopCapture: 由 app 注入（tabs.sendMessage → content script）
export async function runAsrLiveCapture({ settings, durationSec, chunkSec = 28, signal, onPhase, startCapture, stopCapture }) {
  if (!settings.asr.apiKey) {
    throw new ASRError('no_key', '请先在「设置」的 ASR 语音识别区填入 API Key');
  }
  if (durationSec > 3600) {
    throw new ASRError('too_long', 'AI 听录暂不支持超过 60 分钟的视频，敬请期待后续版本');
  }

  const rows = [];
  const queue = [];
  let cursor = 0;
  let seenEnd = false;
  let transcribed = 0;
  let lastActivity = Date.now();

  const listener = (msg) => {
    if (!msg || msg.type !== 'VJX_ASR_PCM' || !msg.data) return;
    queue.push(msg.data);
    lastActivity = Date.now();
    if (msg.data.tEnd >= durationSec - 2.5) seenEnd = true;
    if (onPhase) onPhase('recording', { tEnd: msg.data.tEnd, durationSec, transcribed });
  };
  chrome.runtime.onMessage.addListener(listener);

  try {
    const started = await startCapture(chunkSec);
    if (started && started.already) {
      throw new ASRError('capture_busy', '音轨捕获已在进行中，请刷新视频页面后重试');
    }
    onPhase('recording', { tEnd: 0, durationSec, transcribed: 0 });

    let hintShown = false;
    while (true) {
      if (signal && signal.aborted) throw new ASRError('cancelled', '已取消');

      if (cursor < queue.length) {
        const item = queue[cursor++];
        const bytes = Uint8Array.from(atob(item.b64), (ch) => ch.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'audio/wav' });
        let text = '';
        try {
          text = await transcribeChunk(blob, settings, signal);
        } catch (e) {
          if (signal && signal.aborted) throw e;
          const msg = e instanceof ASRError ? e.friendly : String(e.message || e);
          if (/余额|balance/i.test(msg)) throw new ASRError('balance', msg);
          text = '';
        }
        if (text) appendBlockRows(rows, item.tStart, Math.max(0.1, item.tEnd - item.tStart), text);
        transcribed++;
        if (onPhase) onPhase('recording', { tEnd: item.tEnd, durationSec, transcribed });
        lastActivity = Date.now();
      } else if (seenEnd) {
        break;
      } else {
        if (!hintShown && Date.now() - lastActivity > 15000) {
          onPhase('hint_play', { durationSec });
          hintShown = true;
        }
        if (Date.now() - lastActivity > Math.max(180000, durationSec * 1000 * 1.5)) {
          throw new ASRError('stall', '听录超时：视频似乎没有在播放。请播放视频（将自动静音），完成后脚本自动生成');
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!rows.length) {
      throw new ASRError('empty', '听录完成但没有得到文本（可能是纯音乐/无语音视频）');
    }
    rows.sort((a, b) => a.t - b.t);
    const sample = rows.slice(0, 40).map((r) => r.text).join('');
    const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
    const lang = cjk / Math.max(1, sample.length) > 0.25 ? 'asr-zh' : 'asr-en';
    return { rows, lang, durationSec };
  } finally {
    chrome.runtime.onMessage.removeListener(listener);
    if (stopCapture) await stopCapture().catch(() => {});
  }
}

function appendBlockRows(rows, startSec, blockDur, text) {
  // 按句切分，块内按字符占比线性插值时间
  const sentences = String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？.!?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const totalChars = sentences.reduce((a, s) => a + s.length, 0) || 1;
  let acc = 0;
  for (const s of sentences) {
    const frac = acc / totalChars;
    rows.push({ t: Math.round((startSec + blockDur * frac) * 10) / 10, text: s });
    acc += s.length;
  }
  if (!rows.length) return;
}

async function ensureOffscreen() {
  const has = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  }).then((ctxs) => ctxs.length > 0).catch(() => false);
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/asr-decode.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'AI 听录：解码视频音轨并切片为 WAV',
  });
}

async function closeOffscreen() {
  try {
    const has = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    }).then((ctxs) => ctxs.length > 0).catch(() => false);
    if (has) await chrome.offscreen.closeDocument();
  } catch (e) { /* */ }
}
