// 视频讲解器 · YouTube MAIN world 脚本
// 职责（ADR-003）：在页面世界尽早 hook fetch/XHR 拦截播放器自己的 timedtext 响应（S2）；
// 提供 ytInitialPlayerResponse 读取（S1 数据源）、强制加载字幕（触发 S2）、InnerTube player API（S3）。
// 与隔离世界通过 CustomEvent 协议通信：VJX_CMD（入） / VJX_EVT（出）。
(() => {
  if (window.__VJX_MAIN__) return; // 防重复注入（SPA 场景 manifest 会再次注入）
  window.__VJX_MAIN__ = true;

  // ---------- S2：timedtext 响应拦截缓存 ----------
  const captionCache = new Map(); // key: lang -> {lang, kind, type, body, url, at}

  function cacheCaption(url, bodyText) {
    try {
      if (!bodyText || bodyText.length < 2) return;
      const u = new URL(url, location.origin);
      if (!u.pathname.includes('/api/timedtext')) return;
      const lang = u.searchParams.get('lang') || '??';
      const kind = u.searchParams.get('kind') || 'manual';
      let type = 'raw';
      const head = bodyText.trim()[0];
      if (head === '{') type = 'json3';
      else if (head === '<') type = 'xml';
      captionCache.set(lang, { lang, kind, type, body: bodyText, url, at: Date.now() });
    } catch (e) { /* 忽略非 timedtext 的解析错误 */ }
  }

  // 捕获播放器自己的请求 URL（无论其响应我们能否直接读到，URL 都可重放）
  const captionUrls = new Set(); // timedtext
  const audioUrls = new Set();   // videoplayback 音频分片（DASH 音轨，AI 听录用）
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.name) continue;
        if (e.name.includes('/api/timedtext')) captionUrls.add(e.name);
        if (e.name.includes('/videoplayback') && /mime=audio/i.test(e.name)) audioUrls.add(e.name);
      }
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) { /* 老内核无此 API */ }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (url.includes('/api/timedtext')) {
        res.clone().text().then((t) => cacheCaption(url, t)).catch(() => {});
      }
    } catch (e) { /* */ }
    return res;
  };

  const OrigXHR = window.XMLHttpRequest;
  function XHR() {
    const xhr = new OrigXHR();
    let hookedUrl = '';
    let hooked = false;
    const origOpen = xhr.open;
    xhr.open = function (method, url, ...rest) {
      hookedUrl = String(url || '');
      hooked = hookedUrl.includes('/api/timedtext');
      return origOpen.call(this, method, url, ...rest);
    };
    const tryCache = () => {
      if (!hooked) return;
      try {
        const rt = xhr.responseType;
        let body = null;
        if (rt === 'text' || rt === '') body = xhr.responseText;
        else if (rt === 'json') body = xhr.response ? JSON.stringify(xhr.response) : null;
        // arraybuffer / blob 为二进制格式，不处理（走 PerformanceObserver URL 重放兜底）
        if (body) cacheCaption(hookedUrl, body);
      } catch (e) { /* */ }
    };
    xhr.addEventListener('load', tryCache);
    xhr.addEventListener('error', tryCache);
    return xhr;
  }
  XHR.prototype = OrigXHR.prototype;
  // 保持静态属性（UNSENT 等常量）
  for (const k of Object.getOwnPropertyNames(OrigXHR)) {
    if (!(k in XHR)) { try { XHR[k] = OrigXHR[k]; } catch (e) { /* */ } }
  }
  window.XMLHttpRequest = XHR;

  // ---------- ytInitialPlayerResponse 提取 ----------
  function parseBalanced(text, start) {
    // 从 text[start]（应为 '{'）开始做字符串感知的配平扫描
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }

  function prFromScripts() {
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      const i = t.indexOf('ytInitialPlayerResponse');
      if (i < 0) continue;
      const j = t.indexOf('{', i);
      if (j < 0) continue;
      const raw = parseBalanced(t, j);
      if (!raw) continue;
      try { return JSON.parse(raw); } catch (e) { /* 下一个 script */ }
    }
    return null;
  }

  function currentPR() {
    const pr = window.ytInitialPlayerResponse;
    if (pr && pr.videoId) return pr;
    return prFromScripts();
  }

  function normalizeTracks(pr) {
    const renderer = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    const tracks = (renderer && renderer.captionTracks) || [];
    return tracks.map((t) => ({
      lang: t.languageCode,
      kind: t.kind === 'asr' ? 'asr' : 'manual',
      name: (t.name && (t.name.simpleText ||
        (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode,
      baseUrl: t.baseUrl,
    }));
  }

  // 从页面播放器实时读取当前视频的字幕轨道（SPA 切换视频后 ytInitialPlayerResponse 是陈旧的！）
  // 真实字段结构（2026-11 实测）：{ languageCode, displayName, kind: ''|'ASR', is_servable, vss_id }
  function playerData() {
    try {
      const p = document.getElementById('movie_player');
      if (!p || typeof p.getOption !== 'function') return null;
      const vd = typeof p.getVideoData === 'function' ? p.getVideoData() : null;
      const list = p.getOption('captions', 'tracklist') || [];
      const tracks = list.map((t) => ({
        lang: t.languageCode || t.lang_code || '',
        kind: (t.kind || '').toUpperCase() === 'ASR' ? 'asr' : 'manual',
        name: t.displayName || t.languageName || t.languageCode || '',
        baseUrl: null, // 播放器轨道没有 baseUrl；拉取走 S2 拦截
      })).filter((t) => t.lang);
      return { videoId: vd && vd.video_id, title: vd && vd.title, tracks };
    } catch (e) { return null; }
  }

  function currentVideoIdFromUrl() {
    return new URLSearchParams(location.search).get('v') || '';
  }

  // ---------- S3：InnerTube player ----------
  // 注意：无字幕视频没有 data.captions 字段——绝不能因此抛错（AI 听录需要的是 streamingData 音轨，与字幕无关）
  async function innertubePlayer(videoId) {
    const ytcfg = window.ytcfg;
    const key = ytcfg && (ytcfg.get ? ytcfg.get('INNERTUBE_API_KEY') : ytcfg.data_ && ytcfg.data_.INNERTUBE_API_KEY);
    const ctx = ytcfg && (ytcfg.get ? ytcfg.get('INNERTUBE_CONTEXT') : ytcfg.data_ && ytcfg.data_.INNERTUBE_CONTEXT);
    if (!key || !ctx) throw new Error('no_innertube_cfg');
    const res = await origFetch(`/youtubei/v1/player?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ context: ctx, videoId }),
    });
    const data = await res.json();
    if (!data || data.error) throw new Error((data && data.error && data.error.message) || 'innertube_failed');
    return data;
  }

  // ---------- 强制加载字幕（触发拦截层） ----------
  // 关键实测结论：播放器 PAUSED 时不会拉取字幕数据（字幕随播放流加载）。
  // 所以 nudge 后若处于暂停态，做一次「静音快闪播放」~2.5s 触发字幕加载，然后恢复原状。
  let probing = false;

  function scheduleQuietProbe(p) {
    if (!p || typeof p.playVideo !== 'function' || probing) return;
    try {
      const st = typeof p.getPlayerState === 'function' ? p.getPlayerState() : -1;
      if (st === 1) return; // 正在播放，无需探测
    } catch (e) { /* */ }
    probing = true;
    setTimeout(() => {
      let restore = null;
      try {
        restore = {
          t: typeof p.getCurrentTime === 'function' ? p.getCurrentTime() : 0,
          muted: typeof p.isMuted === 'function' ? p.isMuted() : false,
        };
        if (!restore.muted && p.mute) p.mute();
        p.playVideo();
      } catch (e) { probing = false; return; }
      setTimeout(() => {
        try {
          p.pauseVideo();
          if (restore && restore.t > 0.3 && p.seekTo) p.seekTo(Math.max(0, restore.t - 2.8), true);
          if (restore && !restore.muted && p.unMute) p.unMute();
        } catch (e) { /* */ }
        probing = false;
      }, 2600);
    }, 200);
  }

  function nudgeCaptions(lang) {
    let triggered = false;
    const p = document.getElementById('movie_player');
    if (p && typeof p.getOption === 'function') {
      try {
        const tracklist = p.getOption('captions', 'tracklist') || [];
        let target = null;
        if (lang) {
          target = tracklist.find((t) => (t.languageCode || '') === lang)
            || tracklist.find((t) => (t.languageCode || '').startsWith(String(lang).slice(0, 2)));
        }
        target = target || tracklist.find((t) => (t.kind || '').toUpperCase() !== 'ASR') || tracklist[0];
        p.setOption('captions', 'track', target || {});
        triggered = true;
      } catch (e) { /* */ }
    } else {
      try {
        const btn = document.querySelector('.ytp-subtitles-button');
        if (btn && btn.getAttribute('aria-pressed') !== 'true') { btn.click(); triggered = true; }
      } catch (e) { /* */ }
    }
    scheduleQuietProbe(p);
    return triggered;
  }

  // ---------- AI 听录：页面内实时音轨捕获（ADR-011 v3） ----------
  const ASR_TARGET_RATE = 16000;

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
    ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samplesFloat32[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Uint8Array(buf);
  }

  function downsampleTo16k(f32, srcRate) {
    const target = ASR_TARGET_RATE;
    const ratio = srcRate / target;
    const outLen = Math.floor(f32.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = Math.floor(i * ratio);
      out[i] = f32[idx] || 0;
    }
    return out;
  }

  let capture = null; // {ctx, src, processor, sink, video, chunkSec, pcm[], pcmRate, tStart}

  function startCapture(chunkSec) {
    const video = document.querySelector('video');
    if (!video) throw new Error('no_video_element');
    if (capture) return { already: true, duration: video.duration || 0 };
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaElementSource(video);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0; // 捕获走旁路，输出静音（不影响用户看画面）
    src.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    capture = {
      ctx, src, processor, sink, video,
      chunkSec: chunkSec || 28,
      pcm: [],
      pcmRate: ctx.sampleRate,
      tStart: video.currentTime,
      lastFlushAt: Date.now(),
    };
    // 没在播放就没有 PCM → 自动开始播放（元音频已走旁路，用户听不到声音）
    if (video.paused) video.play().catch(() => {});
    processor.onaudioprocess = (e) => {
      if (!capture) return;
      const inBuf = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < inBuf.length; i++) capture.pcm.push(inBuf[i]);
      const want = capture.chunkSec * capture.pcmRate;
      if (capture.pcm.length >= want) flushChunk();
    };
    function flushChunk() {
      const c = capture;
      if (!c || !c.pcm.length) return;
      const mono = new Float32Array(c.pcm);
      c.pcm = [];
      const down = downsampleTo16k(mono, c.pcmRate);
      const tEnd = c.video.currentTime;
      const tStart = c.tStart;
      c.tStart = tEnd;
      const wav = encodeWav(down, ASR_TARGET_RATE);
      window.dispatchEvent(new CustomEvent('VJX_ASR_PCM', {
        detail: { b64: b64FromBytes(wav), tStart, tEnd },
      }));
    }
    window.__vjxFlushAsr = flushChunk;
    return { started: true, duration: video.duration || 0 };
  }

  function stopCapture() {
    if (!capture) return { stopped: false };
    try { window.__vjxFlushAsr && window.__vjxFlushAsr(); } catch (e) { /* */ }
    try { capture.processor.disconnect(); capture.src.disconnect(); capture.sink.disconnect(); capture.ctx.close(); } catch (e) { /* */ }
    capture = null;
    return { stopped: true };
  }

  window.addEventListener('VJX_ASR_PCM', (e) => {
    const d = e.detail || {};
    window.dispatchEvent(new CustomEvent('VJX_CMD_RELAY', { detail: { relay: 'asrPcm', data: d } }));
  });

  // ---------- 命令协议 ----------
  const handlers = {
    getPR: () => {
      const urlVid = currentVideoIdFromUrl();
      // 播放器实时数据优先（SPA 切换后 ytInitialPlayerResponse 是陈旧的，必须校验）
      const pd = playerData();
      const pr = currentPR();
      const prUsable = pr && pr.videoId && (!urlVid || pr.videoId === urlVid);
      let src = null;
      if (pd && pd.tracks.length) {
        src = { videoId: pd.videoId || urlVid, title: pd.title, tracks: pd.tracks, livePlayer: true };
      } else if (prUsable) {
        src = { videoId: pr.videoId, title: pr.videoDetails && pr.videoDetails.title, tracks: normalizeTracks(pr) };
      }
      if (!src) return { ok: false, videoId: urlVid };
      return {
        ok: true,
        videoId: src.videoId,
        title: src.title,
        tracks: src.tracks,
        livePlayer: !!src.livePlayer,
      };
    },
    getCaptionCache: () => [...captionCache.values()],
    getCaptionUrls: () => [...captionUrls],
    getAudioUrls: () => [...audioUrls],
    nudgePlayback: () => { scheduleQuietProbe(document.getElementById('movie_player')); return true; },
    asrStartCapture: (args) => startCapture(args && args.chunkSec),
    asrStopCapture: () => stopCapture(),
    nudgeCaptions: (args) => nudgeCaptions(args && args.lang),
    innertubePlayer: (args) => innertubePlayer(args && args.videoId).then((d) => {
      // 音轨地址（AI 听录用）：adaptiveFormats 里挑码率最低的纯音频流
      let audioStream = null;
      const fmts = (d.streamingData && d.streamingData.adaptiveFormats) || [];
      for (const f of fmts) {
        if (String(f.mimeType || '').startsWith('audio/')) {
          if (!audioStream || (f.bitrate || 1e9) < (audioStream.bitrate || 1e9)) audioStream = f;
        }
      }
      const ps = d.playabilityStatus || {};
      return {
        ok: true,
        videoId: d.videoId,
        title: d.videoDetails && d.videoDetails.title,
        tracks: d.captions ? normalizeTracks(d) : [],
        playability: ps.status || 'OK',
        playabilityReason: ps.reason || '',
        audioStream: audioStream ? {
          url: audioStream.url,
          size: parseInt(audioStream.contentLength || '0', 10) || 0,
          bitrate: audioStream.bitrate || 0,
          durationSec: Math.round(parseInt(audioStream.approxDurationMs || '0', 10) / 1000),
        } : null,
      };
    }),
  };

  let reqSeq = 0;
  window.addEventListener('VJX_CMD', async (e) => {
    const { cmd, args } = e.detail || {};
    const reqId = e.detail && e.detail.reqId != null ? e.detail.reqId : ++reqSeq;
    let data = null, err = null;
    try {
      const h = handlers[cmd];
      data = h ? await h(args) : { ok: false, err: 'unknown_cmd' };
    } catch (ex) {
      err = String((ex && ex.message) || ex);
    }
    window.dispatchEvent(new CustomEvent('VJX_EVT', { detail: { cmd, reqId, data, err } }));
  });
})();
