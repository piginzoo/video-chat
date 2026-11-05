// 视频讲解器 · content script 公共桥（隔离世界）
// 职责（ADR-008）：播放进度上报、seek 执行、SPA 路由监听（videoKey 变化）、
// 与 side panel 的基础信息通道（PING/INFO）、MAIN world 协议客户端。
(() => {
  if (window.__VJX_BRIDGE__) return;
  window.__VJX_BRIDGE__ = true;

  const SITE = location.hostname.includes('youtube') ? 'yt' : 'bili';

  // ---------- MAIN world 协议客户端 ----------
  const mainWaiters = new Map();
  window.addEventListener('VJX_EVT', (e) => {
    const d = e.detail || {};
    const w = mainWaiters.get(d.reqId);
    if (!w) return;
    mainWaiters.delete(d.reqId);
    clearTimeout(w.timer);
    if (d.err) w.reject(new Error(d.err));
    else w.resolve(d.data);
  });

  function cmdToMain(cmd, args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const reqId = `rq${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      const timer = setTimeout(() => {
        mainWaiters.delete(reqId);
        reject(new Error('main_world_timeout'));
      }, timeoutMs);
      mainWaiters.set(reqId, { resolve, reject, timer });
      window.dispatchEvent(new CustomEvent('VJX_CMD', { detail: { cmd, args, reqId } }));
    });
  }
  // 同一隔离世界（bridge.js + youtube.js）直接共享 API。
  // 注意：不能用 chrome.runtime.sendMessage —— 它只会路由到扩展页面（SW/面板），
  // 永远不会回到本 tab 的 content script，这是实测踩过的坑。
  window.__VJX_BRIDGE_API__ = { cmdToMain };

  // ---------- videoKey ----------
  function parseVideoKey() {
    if (SITE === 'yt') {
      const v = new URLSearchParams(location.search).get('v');
      if (v) return { videoKey: `yt:${v}`, videoId: v, p: 0, isVideoPage: true };
      return { isVideoPage: false };
    }
    const m = location.pathname.match(/\/video\/(BV[\w]+|av\d+)/i);
    if (!m) return { isVideoPage: false };
    const p = parseInt(new URLSearchParams(location.search).get('p') || '1', 10) || 1;
    return { videoKey: `bili:${m[1]}:p${p}`, videoId: m[1], p, isVideoPage: true };
  }

  function pageTitle() {
    if (SITE === 'yt') {
      const m = document.title.replace(/\s*-\s*YouTube\s*$/i, '');
      return m || document.title;
    }
    return document.title.replace(/_哔哩哔哩_bilibili.*$/i, '').replace(/_哔哩哔哩.*$/i, '');
  }

  // ---------- 视频元素与进度上报 ----------
  let lastT = -1;
  function getVideo() {
    const vs = document.querySelectorAll('video');
    // 优先正在播放/面积最大的
    let best = null;
    for (const v of vs) {
      if (v.videoWidth === 0 && v.readyState === 0) continue;
      if (!best || (v.videoWidth * v.videoHeight) > (best.videoWidth * best.videoHeight)) best = v;
    }
    return best;
  }

  function reportProgress(force) {
    const v = getVideo();
    if (!v || v.currentTime === lastT) { if (!force) return; }
    const k = parseVideoKey();
    if (!k.isVideoPage) return;
    lastT = v.currentTime;
    chrome.runtime.sendMessage({
      type: 'VJX_PROGRESS',
      videoKey: k.videoKey,
      t: v.currentTime,
      dur: v.duration || 0,
      playing: !v.paused,
    }).catch(() => {});
  }

  function watchVideo() {
    let attached = null;
    setInterval(() => {
      const v = getVideo();
      if (v !== attached) {
        if (attached) attached.removeEventListener('timeupdate', onTU);
        attached = v;
        if (v) {
          v.addEventListener('timeupdate', onTU);
          v.addEventListener('seeked', onTU);
        }
      }
    }, 1000);
    setInterval(() => { if (document.visibilityState === 'visible') reportProgress(false); }, 1000);
  }
  function onTU() { reportProgress(false); }

  // ---------- SPA 路由监听 ----------
  let lastKey = null;
  function checkNav() {
    const k = parseVideoKey();
    const key = k.isVideoPage ? k.videoKey : null;
    if (key !== lastKey) {
      const first = lastKey === null;
      lastKey = key;
      chrome.runtime.sendMessage({
        type: 'VJX_NAV',
        videoKey: key,
        isVideoPage: k.isVideoPage,
        first,
      }).catch(() => {});
    }
  }
  function watchNav() {
    if (SITE === 'yt') window.addEventListener('yt-navigate-finish', () => setTimeout(checkNav, 300));
    setInterval(checkNav, 800);
    checkNav();
  }

  // ASR 实时捕获：MAIN world 的 PCM 块转发给 sidepanel
  window.addEventListener('VJX_ASR_PCM', (e) => {
    const d = e.detail || {};
    chrome.runtime.sendMessage({ type: 'VJX_ASR_PCM', data: d }).catch(() => {});
  });

  // ---------- side panel → content 命令 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.cmd) return;
    switch (msg.cmd) {
      case 'VJX_PING':
        sendResponse({ pong: true, site: SITE });
        return;
      case 'VJX_SEEK': {
        const v = getVideo();
        if (v && typeof msg.t === 'number') { v.currentTime = msg.t; sendResponse({ ok: true }); }
        else sendResponse({ ok: false, err: 'no_video' });
        return;
      }
      case 'VJX_STATE': {
        const v = getVideo();
        const k = parseVideoKey();
        sendResponse({
          ok: true,
          site: SITE,
          ...k,
          title: pageTitle(),
          t: v ? v.currentTime : 0,
          dur: v ? (v.duration || 0) : 0,
          playing: v ? !v.paused : false,
        });
        return;
      }
      case 'VJX_MAIN_CMD':
        // 注意：不能通过 window 属性判断 MAIN world 是否就绪（两个 JS 世界状态隔离，
        // 隔离世界永远看不到 MAIN world 写的变量）。直接发协议，超时即认为不可用。
        cmdToMain(msg.subCmd, msg.args).then(
          (data) => sendResponse({ ok: true, data }),
          (e) => sendResponse({ ok: false, err: String(e.message || e) })
        );
        return true; // 异步
    }
  });

  watchVideo();
  watchNav();
})();
