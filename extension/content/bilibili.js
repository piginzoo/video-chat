// 视频讲解器 · B站 字幕抓取（ADR-004）
// view API 取 cid → player/v2 取字幕轨道（CC 优先、AI 其次，复用页面登录态）→ 拉取字幕正文
(() => {
  const UA_HEADERS = {}; // 页面上下文 fetch 自动携带正确的 UA/Referer/Cookie

  async function jget(url, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { credentials: 'include', signal: ctrl.signal, ...UA_HEADERS });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function getView(bvid) {
    // 支持 BV 和 av 两种编号
    const av = bvid.match(/^av(\d+)$/i);
    const param = av ? `aid=${av[1]}` : `bvid=${encodeURIComponent(bvid)}`;
    const d = await jget(`https://api.bilibili.com/x/web-interface/view?${param}`);
    if (!d || d.code !== 0 || !d.data) throw new Error('view_api_failed');
    const v = d.data;
    return { aid: v.aid, bvid: v.bvid, cid: v.cid, title: v.title, duration: v.duration, pages: v.pages };
  }

  async function getPlayerInfo(aid, cid, bvid) {
    const url = `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}&bvid=${encodeURIComponent(bvid)}`;
    const d = await jget(url);
    if (!d || d.code !== 0 || !d.data) throw new Error('player_api_failed');
    return d.data;
  }

  async function checkLogin() {
    try {
      const d = await jget('https://api.bilibili.com/x/web-interface/nav');
      return !!(d && d.data && d.data.isLogin);
    } catch (e) { return false; }
  }

  async function fetchSubtitleBody(url) {
    const full = url.startsWith('//') ? 'https:' + url : url;
    // 先尝试页面上下文（同站 Cookie/Referer 最完整）；aisubtitle.hdslb.com 是跨域域，
    // 页面直拉会被 CORS 拦（实测 Failed to fetch），此时走扩展后台中转（host_permissions + Cookie）。
    try {
      const d = await jget(full, 15000);
      const body = d && (d.body || (d.data && d.data.body));
      if (Array.isArray(body)) return body;
    } catch (e) { /* 落到后台中转 */ }
    const relay = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ cmd: 'VJX_FETCH_URL', url: full }, (r) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      } catch (e) { resolve(null); }
    });
    if (relay && relay.ok) {
      try {
        const d = JSON.parse(relay.body);
        const body = d && (d.body || (d.data && d.data.body));
        if (Array.isArray(body)) return body;
      } catch (e) { /* */ }
    }
    return null;
  }

  function rowsFromBody(body) {
    return body
      .map((x) => ({ t: Math.round((x.from || 0) * 10) / 10, text: String(x.content || '').trim() }))
      .filter((r) => r.text);
  }

  async function getTranscript() {
    const m = location.pathname.match(/\/video\/(BV[\w]+|av\d+)/i);
    if (!m) return { ok: false, reason: 'not_video_page' };
    const bvid = m[1];
    const p = parseInt(new URLSearchParams(location.search).get('p') || '1', 10) || 1;

    // 分 P 时用当前分 P 的 cid
    let view;
    try { view = await getView(bvid); }
    catch (e) {
      return { ok: false, reason: 'view_failed', message: '获取视频信息失败（可能风控），可稍后重试或用粘贴兜底。' };
    }
    let cid = view.cid;
    if (Array.isArray(view.pages) && view.pages.length > 1) {
      const cur = view.pages.find((pg) => pg.page === p);
      if (cur) cid = cur.cid;
    }

    let info;
    try { info = await getPlayerInfo(view.aid, cid, bvid); }
    catch (e) {
      return { ok: false, reason: 'player_failed', message: '获取字幕列表失败，可稍后重试或用粘贴兜底。' };
    }

    const subs = (info.subtitle && info.subtitle.subtitles) || [];
    if (!subs.length) {
      const isLogin = await checkLogin();
      return {
        ok: false,
        reason: 'no_subtitle',
        needLoginHint: !isLogin,
        message: isLogin
          ? '该视频没有可用的字幕（无 CC 字幕，AI 字幕也未生成）。可使用粘贴脚本兜底。'
          : '该视频无 CC 字幕；AI 字幕需要登录 B站后才能获取（请确认浏览器已登录 B站），或使用粘贴脚本兜底。',
      };
    }

    // CC 优先，AI 其次
    const norm = subs.map((s) => ({
      lan: s.lan, lanDoc: s.lan_doc || s.lan,
      isAI: (s.ai_type || 0) > 0 || /ai/i.test(s.lan || ''),
      url: s.subtitle_url,
    }));
    norm.sort((a, b) => (a.isAI ? 1 : 0) - (b.isAI ? 1 : 0));
    const track = norm[0];

    const body = await fetchSubtitleBody(track.url);
    const rows = body ? rowsFromBody(body) : [];
    if (!rows.length) {
      // 轨道存在但正文为空（AI 字幕生成中/空壳）→ 按无字幕兜底处理
      return { ok: false, reason: 'subtitle_empty', message: '字幕轨道存在但还没有内容（AI 字幕可能生成中）。可稍后重试，或使用粘贴/AI 听录兜底。' };
    }

    const tracks = norm.map((s) => ({ lan: s.lan, name: `${s.lanDoc}${s.isAI ? '（AI）' : ''}`, isAI: s.isAI, url: s.url }));
    return {
      ok: true,
      site: 'bili',
      videoId: bvid,
      p,
      title: view.title,
      duration: view.duration,
      rows: rowsFromBody(body),
      lang: track.lan || 'zh',
      trackName: `${track.lanDoc}${track.isAI ? '（AI）' : ''}`,
      isAuto: track.isAuto,
      tracks,
    };
  }

  async function getTrack(args = {}) {
    const url = args && (args.trackUrl || args.url);
    if (!url) return { ok: false, reason: 'no_url' };
    const body = await fetchSubtitleBody(url);
    if (!body) return { ok: false, reason: 'subtitle_body_failed' };
    return { ok: true, rows: rowsFromBody(body), lang: args.lan || 'zh' };
  }

  // AI 听录（ADR-011）：playurl dash 取最低码率音轨
  async function getAudio() {
    const m = location.pathname.match(/\/video\/(BV[\w]+|av\d+)/i);
    if (!m) return { ok: false, message: 'not_video_page' };
    const bvid = m[1];
    const p = parseInt(new URLSearchParams(location.search).get('p') || '1', 10) || 1;
    const view = await getView(bvid);
    let cid = view.cid;
    if (Array.isArray(view.pages) && view.pages.length > 1) {
      const cur = view.pages.find((pg) => pg.page === p);
      if (cur) cid = cur.cid;
    }
    const url = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&fnver=0&fourk=1`;
    const d = await jget(url);
    if (!d || d.code !== 0 || !d.data) throw new Error('playurl_api_failed');
    const dash = d.data.dash;
    if (!dash || !Array.isArray(dash.audio) || !dash.audio.length) {
      return { ok: false, message: '该视频没有可提取的独立音轨（可能为老格式视频）' };
    }
    const a = dash.audio.slice().sort((x, y) => (x.bandwidth || 0) - (y.bandwidth || 0))[0];
    const full = (a.baseUrl || a.base_url || '').startsWith('//')
      ? 'https:' + (a.baseUrl || a.base_url)
      : (a.baseUrl || a.base_url);
    return { ok: true, url: full, credentials: true, durationSec: view.duration || 0 };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.cmd !== 'VJX_GET_AUDIO') return;
    getAudio().then(
      (res) => sendResponse(res),
      (e) => sendResponse({ ok: false, message: String(e.message || e) })
    );
    return true;
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.cmd !== 'VJX_GET_TRANSCRIPT') return;
    const run = msg.args && msg.args.trackUrl ? getTrack(msg.args) : getTranscript();
    run.then(
      (res) => sendResponse(res),
      (e) => sendResponse({ ok: false, reason: 'exception', message: String(e.message || e) })
    );
    return true;
  });
})();
