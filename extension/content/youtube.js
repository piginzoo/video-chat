// 视频讲解器 · YouTube 字幕抓取（ADR-003 三层降级）
// S2 播放器拦截+URL重放（主路径，实测有效）→ S3 InnerTube → 兜底失败
(() => {
  // 与 bridge.js 同处一个隔离世界，直接调用其 MAIN world 协议客户端
  const CMD = (subCmd, args) => {
    const api = window.__VJX_BRIDGE_API__;
    if (!api) return Promise.reject(new Error('bridge_not_ready'));
    return api.cmdToMain(subCmd, args);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 解析 ----------
  function parseJson3(bodyText) {
    const data = JSON.parse(bodyText);
    const rows = [];
    let prevText = null;
    for (const e of data.events || []) {
      if (!e.segs) continue;
      let text = e.segs.map((s) => s.utf8 || '').join('');
      text = text.replace(/\n/g, ' ').trim();
      if (!text || text === prevText) continue;
      prevText = text;
      rows.push({ t: Math.round((e.tStartMs || 0) / 100) / 10, text });
    }
    return rows;
  }

  function parseXml(bodyText) {
    const doc = new DOMParser().parseFromString(bodyText, 'text/xml');
    const rows = [];
    for (const el of doc.querySelectorAll('text')) {
      const text = (el.textContent || '').replace(/\n/g, ' ').trim();
      if (!text) continue;
      rows.push({ t: Math.round(parseFloat(el.getAttribute('start') || '0') * 10) / 10, text });
    }
    return rows;
  }

  function parseCaption(entry) {
    if (entry.type === 'json3') return parseJson3(entry.body);
    if (entry.type === 'xml') return parseXml(entry.body);
    // 未知格式：尝试 json3 再 xml
    try { return parseJson3(entry.body); } catch (e) { return parseXml(entry.body); }
  }

  // ---------- 拉取（页面同源上下文，自动带 Cookie） ----------
  async function fetchText(url, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        credentials: 'include',
        signal: ctrl.signal,
      });
      const body = await res.text();
      if (!body || body.length < 2) return null; // 已知的封禁失败模式：200 + 空体
      return body;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // S1 用：captionTracks 的 baseUrl 需要追加 fmt；S2 的 URL 重放必须原样（签名参数不可改！）
  async function fetchTrackBody(baseUrl, timeoutMs = 12000) {
    return fetchText(baseUrl + '&fmt=json3', timeoutMs);
  }

  function pickDefaultTrack(tracks, langWanted) {
    if (langWanted) {
      const hit = tracks.find((t) => t.lang === langWanted);
      if (hit) return hit;
    }
    const manual = tracks.filter((t) => t.kind === 'manual');
    const pool = manual.length ? manual : tracks;
    // 优先英语/原语言，其次第一条
    return pool.find((t) => t.lang && t.lang.startsWith('en')) || pool[0] || null;
  }

  // ---------- S2.5：官方「显示文字记录」面板刮取（全量脚本，最可靠） ----------
  async function scrapeTranscriptPanel(timeoutMs = 12000) {
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      // 1. 展开描述区（若折叠）
      const expander = document.querySelector('#description-inline-expander #expand')
        || document.querySelector('#expand');
      if (expander && expander.offsetParent !== null) {
        try { expander.click(); } catch (e) { /* */ }
        await sleepMs(600);
      }
      // 2. 点击「显示文字记录」按钮（选择器多路尝试，规避语言差异）
      const btnCandidates = [
        'ytd-video-description-transcript-section-renderer button',
        'ytd-video-description-transcript-section-renderer yt-button-shape button',
        '#primary-button ytd-button-renderer button',
      ];
      let clicked = false;
      for (const sel of btnCandidates) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          btn.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) return null;

      // 3. 等待分段渲染（新旧两种元素名都试，含 shadow DOM 兜底）
      const grabRows = () => {
        const segs = document.querySelectorAll('ytd-transcript-segment-renderer, yt-transcript-segment-renderer');
        if (!segs.length) return null;
        const rows = [];
        for (const seg of segs) {
          let txt = seg.textContent || (seg.shadowRoot && seg.shadowRoot.textContent) || '';
          txt = txt.replace(/\s+/g, ' ').trim();
          const m = txt.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.*)$/);
          if (!m) continue;
          const t = m[3] !== undefined
            ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
            : (+m[1]) * 60 + (+m[2]);
          const text = m[4].trim();
          if (text) rows.push({ t, text });
        }
        return rows.length ? rows : null;
      };

      const deadline = Date.now() + timeoutMs;
      let rows = null;
      while (Date.now() < deadline) {
        rows = grabRows();
        if (rows && rows.length > 3) break; // 少于 4 行可能是渲染中
        await sleepMs(800);
      }
      if (!rows) return null;

      // 4. 收起面板（还原图标状态）
      try {
        const closeBtn = document.querySelector(
          'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #visibility-button button'
        ) || document.querySelector('ytd-engagement-panel-section-list-renderer #visibility-button button');
        if (closeBtn) closeBtn.click();
      } catch (e) { /* */ }

      return rows;
    } catch (e) {
      return null;
    }
  }

  // ---------- 三层策略 ----------
  async function getTranscript(args = {}) {
    const lang = args.lang || null;
    // videoId 以 URL 为准（SPA 实时性最好）；PR/播放器数据只用于轨道与标题
    const urlVid = new URLSearchParams(location.search).get('v');

    // 首次 getPR（页面刚加载时可能未就绪，快速重试几次拿轨道信息）
    let pr = null;
    for (let i = 0; i < 5; i++) {
      try { pr = await CMD('getPR'); } catch (e) { pr = null; }
      if (pr && pr.ok && (pr.tracks || []).length) break;
      await sleep(1200);
    }

    let tracks = pr && pr.ok ? pr.tracks : [];
    const videoId = urlVid || (pr && pr.ok && pr.videoId) || '';
    const title = pr && pr.ok ? pr.title : null;
    let track = pickDefaultTrack(tracks, lang);

    // S2：播放器拦截 + URL 重放（主路径，ADR-003）
    // 立刻 nudge（不等页面完全就绪），长轮询，周期性补 nudge。
    const readSources = async () => {
      try {
        const entries = await CMD('getCaptionCache');
        const urls = await CMD('getCaptionUrls');
        return { entries: entries || [], urls: urls || [] };
      } catch (e) { return { entries: [], urls: [] }; }
    };

    const pickEntry = (entries) => {
      if (!entries.length) return null;
      let pool = entries;
      if (lang) {
        const pref = entries.filter((e2) => e2.lang === lang || e2.lang.startsWith(String(lang).slice(0, 2)));
        if (pref.length) pool = pref;
      }
      pool.sort((a, b) => (a.kind === 'manual' ? -1 : 1) - (b.kind === 'manual' ? -1 : 1) || b.at - a.at);
      return pool[0] || null;
    };

    const tryUrls = async (urls) => {
      const sorted = [...urls];
      if (lang) {
        sorted.sort((a, b) => {
          const am = a.includes(`lang=${lang}`) ? -1 : a.includes(`lang=${String(lang).slice(0, 2)}`) ? 0 : 1;
          const bm = b.includes(`lang=${lang}`) ? -1 : b.includes(`lang=${String(lang).slice(0, 2)}`) ? 0 : 1;
          return am - bm;
        });
      }
      for (const u of sorted.slice(0, 4)) {
        const body = await fetchText(u, 10000); // URL 原样重放（播放器刚成功用过的，签名参数一个都不能改）
        if (!body) continue;
        try {
          const rows = parseJson3(body);
          if (rows.length) return { rows, url: u };
        } catch (e) {
          try {
            const rows = parseXml(body);
            if (rows.length) return { rows, url: u };
          } catch (e2) { /* 下一个 URL */ }
        }
      }
      return null;
    };

    const attemptSources = async (tag) => {
      const s = await readSources();
      const entry = pickEntry(s.entries);
      if (entry) {
        try {
          const rows = parseCaption(entry);
          if (rows.length) return ok(videoId, title, rows, tracks, track, tag);
        } catch (e) { /* 缓存体解析失败，试 URL */ }
      }
      const hit = await tryUrls(s.urls);
      if (hit) return ok(videoId, title, hit.rows, tracks, track, tag + '-url');
      return null;
    };

    // 快路径：拦截层已有数据（CC 曾开过）
    const fast = await attemptSources('S2');
    if (fast && fast.rows && fast.rows.length > 12) return fast; // 片段化的拦截数据太少时继续走全量路径

    // S2.5：官方文字记录面板（全量脚本，最可靠）——与 nudge 并行受益于 CC 开启
    CMD('nudgeCaptions', { lang: track ? track.lang : (lang || 'en') }).catch(() => {});
    const panelRows = await scrapeTranscriptPanel(12000);
    if (panelRows && panelRows.length) {
      return ok(videoId, title, panelRows, tracks, track, 'S25-panel');
    }

    // S2：拦截长轮询（20 秒，期间两次补 nudge）
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const hit = await attemptSources('S2-nudged');
      if (hit) return hit;
      if (i === 6 || i === 13) CMD('nudgeCaptions', { lang: track ? track.lang : (lang || 'en') }).catch(() => {});
      // 轨道信息中途就绪则补齐（供轨道选择器与语言匹配）
      if ((!track || !tracks.length) && i % 4 === 3) {
        try {
          const p2 = await CMD('getPR');
          if (p2 && p2.ok && (p2.tracks || []).length) {
            tracks = p2.tracks;
            track = pickDefaultTrack(tracks, lang);
          }
        } catch (e) { /* */ }
      }
    }

    // S3 完整重试：InnerTube 拿 tracks 再走 S1 拉取
    try {
      const it = await CMD('innertubePlayer', { videoId });
      if (it && it.ok && it.tracks.length) {
        const t3 = pickDefaultTrack(it.tracks, lang);
        if (t3) {
          const body = await fetchTrackBody(t3.baseUrl);
          if (body) {
            const rows = parseJson3(body);
            if (rows.length) return ok(videoId, title, rows, it.tracks, t3, 'S3');
          }
        }
      }
    } catch (e) { /* 全部失败 */ }

    return {
      ok: false,
      reason: 'youtube_no_transcript',
      message: '未能获取 YouTube 字幕（三种方式均失败）。可尝试刷新页面重试，或使用粘贴脚本兜底。',
      videoId,
      title,
    };
  }

  function ok(videoId, title, rows, tracks, track, layer) {
    // 轨道列表（供选择器）：去重
    const seen = new Set();
    const trackList = (tracks || []).filter((t) => {
      const k = `${t.lang}|${t.kind}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return {
      ok: true,
      site: 'yt',
      videoId,
      title,
      rows,
      lang: track ? track.lang : 'en',
      trackName: track ? track.name : '',
      isAuto: track ? track.kind === 'asr' : false,
      tracks: trackList,
      layer,
    };
  }

  // ---------- 命令入口 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === 'VJX_GET_TRANSCRIPT') {
      getTranscript(msg.args || {}).then(
        (res) => sendResponse(res),
        (e) => sendResponse({ ok: false, reason: 'exception', message: String(e.message || e) })
      );
      return true; // 异步
    }
    if (msg.cmd === 'VJX_GET_AUDIO') {
      // AI 听录（ADR-011 v2）：InnerTube 已不再下发音频直链（PO-Token 时代，实测无 url 字段）。
      // 主路径 = 捕获播放器自己的 videoplayback 音频分片 URL（含合法签名）→ 原样重放下载。
      // 页面暂停/未加载音频时 → 静音快闪播放触发分片请求。
      let lastErr = '无法获取音轨地址';
      const readUrls = async () => {
        try { return await CMD('getAudioUrls'); } catch (e) { return []; }
      };
      (async () => {
        for (let round = 0; round < 8; round++) {
          const urls = await readUrls();
          const audioUrl = urls.filter((u) => /mime=audio/i.test(u)).pop() || urls[urls.length - 1];
          if (audioUrl) {
            sendResponse({ ok: true, url: audioUrl, credentials: false, durationSec: 0 });
            return;
          }
          // 触发播放（静音快闪）→ 播放器加载音频分片
          try { await CMD('nudgePlayback'); } catch (e) { /* */ }
          await new Promise((r) => setTimeout(r, 2000));
          lastErr = '等待播放器加载音轨…';
        }
        // 兜底：部分旧客户端 InnerTube 仍带 url
        try {
          const it = await CMD('innertubePlayer', { videoId: new URLSearchParams(location.search).get('v') });
          if (it && it.ok && it.audioStream && it.audioStream.url) {
            sendResponse({ ok: true, url: it.audioStream.url, credentials: false, durationSec: it.audioStream.durationSec || 0 });
            return;
          }
        } catch (e) { /* */ }
        sendResponse({ ok: false, message: '无法获取音轨地址（已触发播放仍未捕获音频流；请确认视频可正常播放，或稍后重试）' });
      })();
      return true;
    }
  });
})();
