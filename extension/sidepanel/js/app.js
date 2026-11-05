// 视频讲解器 · 侧边栏总调度（app.js）
// 职责：tab 路由、当前视频检测与注入恢复、脚本加载/缓存、翻译流水线编排、
//       跟随进度路由、对话上下文构建与流式发送、设置页。
import {
  getSettings, saveSettings,
  getTranscript, saveTranscript,
  getChat, saveChat, clearChat,
} from './store.js';
import { PROVIDERS } from './providers.js';
import { chatStream, LLMError } from './llm.js';
import { translateRows } from './translate.js';
import { runAsrPipeline, runAsrLiveCapture, ASRError } from './asr.js';
import { fmtT } from './render.js';
import { initScriptTab, bindUiHooks } from './ui-script.js';
import { initChatTab, bindChatHooks, startStreamBubble, setStreaming as chatSetStreaming } from './ui-chat.js';
import { initSettingsTab } from './ui-settings.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const paneScript = $('pane-script');
const paneChat = $('pane-chat');
const paneSettings = $('pane-settings');

// ---------- 状态 ----------
const state = {
  videoKey: null,
  tabId: null,
  rec: null,          // transcript 记录（storage schema）
  rows: [],
  settings: null,
  lastT: 0,
  lastPlaying: false,
  transAbort: null,   // 翻译中断控制器
  sendAbort: null,    // 对话中断控制器
  chatBusy: false,
  refreshTimer: null,
};

// ---------- UI 实例 ----------
const scriptUI = initScriptTab({ pane: paneScript });
const chatUI = initChatTab({ pane: paneChat });
const settingsUI = initSettingsTab({ pane: paneSettings, getSettings, saveSettings, toast });

bindUiHooks({
  onSeek: (t) => seek(t),
  onRepaste: () => showRepaste(),
  onAsr: () => void onAsr(),
  onRecheck: () => void recheckSubtitles(),
});
bindChatHooks({
  onSeek: (t) => seek(t),
  toast,
  onClearChat: () => onClearChat(),
  onUserSend: (text) => sendChat(text, { display: true }),
  onQuick: (kind) => onQuick(kind),
  isKeyMissing: () => {
    const s = state.settings;
    return !s || !s.providers[s.activeProvider].apiKey;
  },
  modelLabel: () => {
    const s = state.settings;
    const p = PROVIDERS[s.activeProvider];
    return `${p.label} · ${s.providers[s.activeProvider].model}`;
  },
});

// ---------- 工具 ----------
function toast(msg, ms = 2200) {
  let el = $('vjx-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'vjx-toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

function askTab(tabId, msg, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    } catch (e) {
      clearTimeout(timer);
      if (!settled) { settled = true; resolve(null); }
    }
  });
}

async function tryInject(tab) {
  if (!tab || !tab.url) return false;
  const filesBridge = ['content/bridge.js'];
  try {
    if (tab.url.includes('youtube.com')) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['content/yt-main.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [...filesBridge, 'content/youtube.js'] });
      return true;
    }
    if (tab.url.includes('bilibili.com')) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [...filesBridge, 'content/bilibili.js'] });
      return true;
    }
  } catch (e) { /* 受限页面（商店/文档等）静默失败 */ }
  return false;
}

function needTranslate(rec) {
  // 'zh'/'zh-Hans'/'ai-zh' 等都算中文（AI 中文字幕不翻译）；其余语言才翻译
  return rec.mode === 'video' && !/zh/i.test(rec.lang || '');
}

// ---------- 当前视频检测 ----------
const VIDEO_TAB_PATTERNS = ['https://www.youtube.com/watch*', 'https://www.bilibili.com/video*'];
const NOSUB_CHECK_TTL = 30 * 24 * 60 * 60 * 1000; // 无字幕检测结果缓存 30 天（用户反馈 #16）

async function probeTab(tab) {
  let st = await askTab(tab.id, { cmd: 'VJX_STATE' }, 2500);
  if (!st && await tryInject(tab)) st = await askTab(tab.id, { cmd: 'VJX_STATE' }, 2500);
  return st && st.isVideoPage ? st : null;
}

async function isActiveVideoUrl(tab) {
  try {
    const vtabs = await chrome.tabs.query({ url: VIDEO_TAB_PATTERNS });
    return vtabs.some((t) => t.id === tab.id);
  } catch (e) { return false; }
}

async function refreshForTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) { setNoVideo(); return; }
    state.tabId = tab.id;

    // 面板页自身被当作普通 tab 打开（自动化/调试场景）→ 允许回退到其他窗口的视频页
    const ownPage = !!(tab.url && tab.url.startsWith(location.origin));
    let st = await probeTab(tab);

    if (!st && !ownPage) {
      // 激活页不是可接入的视频页：明确空态/刷新提示，绝不抓其他窗口的视频（用户反馈 #1/#2）
      if (await isActiveVideoUrl(tab)) {
        scriptUI.renderRefreshHint();
        chatUI.render({ mode: 'none' }, []);
      } else {
        setNoVideo();
      }
      return;
    }
    if (!st && ownPage) {
      const vtabs = await chrome.tabs.query({ url: VIDEO_TAB_PATTERNS });
      vtabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      for (const t of vtabs) {
        st = await probeTab(t);
        if (st) { state.tabId = t.id; break; }
      }
      if (!st) { setNoVideo(); return; }
    }
    if (!st) { setNoVideo(); return; }

    if (st.videoKey === state.videoKey) {
      state.lastT = st.t || state.lastT;
      state.lastPlaying = !!st.playing;
      return; // 同一视频，保持现有状态
    }
    await loadVideo(st);
  } catch (e) {
    setNoVideo();
  }
}

function setNoVideo() {
  if (state.transAbort) state.transAbort.abort();
  state.videoKey = null;
  state.rec = null;
  state.rows = [];
  scriptUI.renderEmpty();
  chatUI.render({ mode: 'none' }, []);
}

// ---------- 视频加载 ----------
window.__vjx_trace = window.__vjx_trace || [];
function trace(m) { try { window.__vjx_trace.push(new Date().toISOString().slice(11,19) + ' ' + m); } catch (e) {} }

async function loadVideo(st) {
  trace('loadVideo ' + st.videoKey);
  if (state.transAbort) state.transAbort.abort();
  if (state.sendAbort) state.sendAbort.abort();
  state.videoKey = st.videoKey;
  state.lastT = st.t || 0;
  state.lastPlaying = !!st.playing;
  state.rows = [];
  state.rec = null;

  scriptUI.renderLoading(st.title || '正在获取字幕…');

  const cached = await getTranscript(state.videoKey);
  trace('缓存: mode=' + (cached && cached.mode) + ' rows=' + ((cached && cached.rows) || []).length);
  if (cached && cached.mode === 'video' && (cached.rows || []).length) {
    adoptRecord(cached);
    return;
  }
  if (cached && cached.mode === 'paste') {
    adoptRecord(cached);
    return;
  }
  if (cached && cached.mode === 'nosub') {
    // 无字幕检测结果缓存 30 天（用户反馈：别重复检测）；过期自动重检一次
    const checkedAt = (cached.noSubtitle && cached.noSubtitle.checkedAt) || cached.updatedAt || 0;
    if (Date.now() - checkedAt < NOSUB_CHECK_TTL) {
      adoptRecord(cached);
      return;
    }
    trace('无字幕缓存已过期，重新检测');
  }

  // 首次：向 content script 抓取（ok 但 0 行也按无字幕兜底——轨道空壳场景）
  const res = await askTab(state.tabId, { cmd: 'VJX_GET_TRANSCRIPT', args: {} }, 120000);
  trace('抓取: ok=' + (res && res.ok) + ' rows=' + (res && res.rows ? res.rows.length : 'null') + ' reason=' + (res && res.reason));
  if (!res || !res.ok || !res.rows || !res.rows.length) {
    const rec = {
      mode: 'nosub',
      site: st.site, videoId: st.videoId, p: st.p,
      title: (res && res.title) || st.title || '',
      noSubtitle: {
        reason: (res && res.reason) || 'unknown',
        message: (res && res.message) || '获取字幕失败，可稍后重试或使用粘贴脚本兜底。',
        needLoginHint: !!(res && res.needLoginHint),
        checkedAt: Date.now(), // 无字幕检测结果缓存 30 天（期间不再重复检测）
      },
      rows: [],
      pasteText: (cached && cached.pasteText) || '',
    };
    await saveTranscript(state.videoKey, rec); // 两个站都缓存（30 天 TTL，期间直接出听录/粘贴卡片）
    adoptRecord(rec);
    return;
  }
  const rec = {
    mode: 'video',
    site: res.site, videoId: res.videoId, p: res.p || st.p,
    title: res.title || st.title || '',
    duration: res.duration || st.dur || 0,
    lang: res.lang, trackName: res.trackName, isAuto: !!res.isAuto,
    tracks: res.tracks || [],
    layer: res.layer,
    rows: res.rows,
  };
  await saveTranscript(state.videoKey, rec);
  adoptRecord(rec);
}

async function adoptRecord(rec) {
  trace('adoptRecord mode=' + rec.mode + ' rows=' + ((rec.rows) || []).length);
  state.rec = rec;
  state.rows = rec.rows || [];
  const nt = needTranslate(rec);
  const messages = state.videoKey ? await getChat(state.videoKey) : [];

  if (rec.mode === 'nosub') {
    const checkedAt = (rec.noSubtitle && rec.noSubtitle.checkedAt) || rec.updatedAt || 0;
    scriptUI.renderNoSubtitle({
      message: rec.noSubtitle && rec.noSubtitle.message,
      pasteText: rec.pasteText || '',
      checkedAtDays: checkedAt ? Math.floor((Date.now() - checkedAt) / 86400000) : null,
      onPaste: (text) => applyPaste(text),
    });
    chatUI.render(chatMeta(), messages);
    return;
  }
  if (rec.mode === 'paste') {
    scriptUI.renderPasteView(rec.pasteText || '');
    chatUI.render(chatMeta(), messages);
    return;
  }

  // video 模式：需要翻译的行先放 zh 占位（翻译完成后逐行回填）
  if (nt) {
    state.rows.forEach((r) => { if (r.text && r.zh === undefined) r.zh = ''; });
  } else {
    // 非翻译视频：清掉可能的历史占位，避免显示"翻译中……"
    state.rows.forEach((r) => { if (r.zh === '') delete r.zh; });
  }
  const selectorHtml = buildTrackSelectorHtml(rec);
  scriptUI.renderScript({
    title: rec.title,
    duration: rec.duration || 0,
    needTranslate: nt,
    isAuto: rec.isAuto,
    trackSelectorHtml: selectorHtml,
  });
  scriptUI.setRows(state.rows);
  bindSelector(rec);
  scriptUI.setProgress(state.lastT, state.lastPlaying);

  chatUI.render(chatMeta(), messages);
  startTranslationIfNeeded();
}

function chatMeta() {
  const rec = state.rec;
  if (!rec) return { mode: 'none' };
  if (rec.mode === 'paste') {
    return { mode: 'paste', scriptChars: (rec.pasteText || '').length };
  }
  if (rec.mode === 'video') {
    return { mode: 'video', rowCount: state.rows.length, needTranslate: needTranslate(rec) };
  }
  return { mode: 'none' };
}

function buildTrackSelectorHtml(rec) {
  const tracks = rec.tracks || [];
  if (tracks.length < 2) return '';
  const isYt = rec.site === 'yt';
  const options = tracks.map((t, i) => {
    const val = isYt ? t.lang : t.url;
    const selected = (isYt && t.lang === rec.lang) || (!isYt && t.name === rec.trackName) ? 'selected' : '';
    return `<option value="${i}" ${selected}>${escapeH(t.name || t.lan)}</option>`;
  }).join('');
  return `<div class="infobar"><select class="trackselect" id="trackSel">${options}</select><button class="langtoggle" id="langToggle">仅原文</button></div>`;
}

function bindSelector(rec) {
  const sel = $('trackSel');
  if (sel) {
    sel.addEventListener('change', () => {
      const t = (rec.tracks || [])[+sel.value];
      if (!t) return;
      const args = rec.site === 'yt' ? { lang: t.lang } : { trackUrl: t.url, lan: t.lan };
      void switchTrack(args);
    });
  }
  const lt = $('langToggle');
  if (lt) {
    lt.addEventListener('click', () => {
      const wrap = paneScript.querySelector('.script-wrap');
      const on = wrap.classList.toggle('only-en');
      lt.textContent = on ? '双语对照' : '仅原文';
    });
  }
}

async function switchTrack(args) {
  toast('切换字幕轨道，重新拉取…');
  const res = await askTab(state.tabId, { cmd: 'VJX_GET_TRANSCRIPT', args }, 60000);
  if (!res || !res.ok) { toast('该轨道拉取失败'); return; }
  if (state.transAbort) state.transAbort.abort();
  state.rec.rows = res.rows;
  state.rec.lang = res.lang || state.rec.lang;
  state.rec.trackName = res.trackName || '';
  state.rec.isAuto = !!res.isAuto;
  state.rec.layer = res.layer;
  state.rows = res.rows;
  await saveTranscript(state.videoKey, state.rec);
  adoptRecord(state.rec);
  toast('已切换轨道');
}

// ---------- 粘贴兜底 ----------
function applyPaste(text) {
  const rec = state.rec || {};
  rec.mode = 'paste';
  rec.pasteText = text;
  rec.rows = text.split(/\n+/).filter(Boolean).map((l, i) => ({ t: null, text: l, _i: i }));
  if (!rec.title) rec.title = '粘贴脚本';
  void saveTranscript(state.videoKey, rec);
  adoptRecord(rec);
  toast('脚本已就绪，对话/总结可用');
}

function showRepaste() {
  scriptUI.renderNoSubtitle({
    message: '重新粘贴脚本内容。',
    pasteText: '',
    onPaste: (text) => applyPaste(text),
  });
}

// ---------- AI 听录（ADR-011）----------
// 只在「无字幕」卡片里出现；有字幕的视频永远不会触发下载音轨（用户明确要求：不浪费钱）
let asrAbort = null;
let asrBusy = false;
let rechecking = false;

async function onAsr() {
  if (asrBusy || !state.videoKey || !state.rec || state.rec.mode !== 'nosub') return;
  const s = state.settings;
  if (!s.asr.apiKey) {
    toast('请先在「设置」的 ASR 语音识别区填入 API Key');
    activateTab('settings');
    return;
  }
  asrBusy = true;
  asrAbort = new AbortController();
  scriptUI.asrStatus('preparing', {}, true);
  try {
    let res;
    if (state.rec.site === 'yt') {
      // YouTube：SABR 时代无音频直链 → 页面内实时捕获（视频静音播放，耗时≈视频时长）
      res = await runAsrLiveCapture({
        settings: s,
        durationSec: state.lastDur || 0,
        signal: asrAbort.signal,
        onPhase: (ph, info) => scriptUI.asrStatus(ph, info || {}, true),
        startCapture: (chunkSec) => askTab(state.tabId, { cmd: 'VJX_MAIN_CMD', subCmd: 'asrStartCapture', args: { chunkSec } }, 30000),
        stopCapture: () => askTab(state.tabId, { cmd: 'VJX_MAIN_CMD', subCmd: 'asrStopCapture' }, 15000),
      });
    } else {
      // B站：dash 音轨直链下载 → 解码切块 → 上传
      res = await runAsrPipeline({
        settings: s,
        durationSec: state.lastDur || 0,
        signal: asrAbort.signal,
        getAudioUrl: async () => {
          const r = await askTab(state.tabId, { cmd: 'VJX_GET_AUDIO' }, 60000);
          if (!r || !r.ok) throw new ASRError('no_audio', (r && r.message) || '无法获取音轨地址');
          return { url: r.url, credentials: r.credentials };
        },
        onPhase: (ph, info) => scriptUI.asrStatus(ph, info || {}, true),
      });
    }
    if (state.rec && state.rec.mode === 'nosub') {
      const rec = {
        mode: 'video',
        site: state.rec.site, videoId: state.rec.videoId, p: state.rec.p || 1,
        title: state.rec.title || 'AI 听录',
        duration: res.durationSec || state.lastDur || 0,
        lang: res.lang || 'asr', trackName: 'AI 听录', isAuto: true,
        tracks: [],
        layer: 'ASR',
        rows: res.rows,
      };
      await saveTranscript(state.videoKey, rec);
      adoptRecord(rec);
      toast(`听录完成，已缓存 ✓`);
    }
  } catch (e) {
    const msg = e instanceof ASRError ? e.friendly : String(e.message || e);
    scriptUI.asrStatus(msg, null, false);
    toast(msg);
  } finally {
    asrBusy = false;
  }
}

// ---------- 翻译流水线 ----------
function startTranslationIfNeeded() {
  if (!state.rec || state.rec.mode !== 'video' || !needTranslate(state.rec)) return;
  const pending = state.rows.some((r) => r.text && !r.zh);
  if (!pending) { scriptUI.setTranslateDone(); return; }

  const cfg = state.settings.providers[state.settings.activeProvider];
  if (!cfg.apiKey) {
    scriptUI.setTranslateError('未配置 API Key，到「设置」页配置后重开本视频自动翻译');
    return;
  }

  const total = state.rows.filter((r) => r.text && !r.zh).length;
  scriptUI.setTranslating(0, total);
  state.transAbort = new AbortController();

  translateRows(state.rows, state.settings, {
    signal: state.transAbort.signal,
    onProgress: ({ done, total: tt }) => scriptUI.setTranslating(done, tt),
    onChunk: async (_idxs, _map) => {
      // 渐进落盘（断点续翻），并按行更新 DOM
      if (state.videoKey) await saveTranscript(state.videoKey, state.rec);
      state.rows.forEach((r, i) => { if (r.zh) scriptUI.updateZhRow(i, r.zh); });
    },
  }).then(async () => {
    if (state.videoKey && state.rec) await saveTranscript(state.videoKey, state.rec);
    if (state.transAbort && !state.transAbort.signal.aborted) scriptUI.setTranslateDone();
  }).catch((e) => {
    if (state.transAbort && state.transAbort.signal.aborted) return;
    scriptUI.setTranslateError(e instanceof LLMError ? e.kind : String(e.message || e));
  });
}

// ---------- 进度与导航消息 ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'VJX_PROGRESS') {
    if (msg.videoKey === state.videoKey) {
      state.lastT = msg.t || 0;
      state.lastPlaying = !!msg.playing;
      scriptUI.setProgress(msg.t, msg.playing);
      // 无字幕卡片：不再随播放自动重试（结果已缓存 30 天，用户可手动「重新检测」）
    }
  } else if (msg.type === 'VJX_NAV') {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => void refreshForTab(), 250);
  }
});

// 手动「重新检测字幕」：清掉无字幕缓存并重新抓取
async function recheckSubtitles() {
  if (asrBusy || rechecking || !state.videoKey || !state.rec || state.rec.mode !== 'nosub') return;
  rechecking = true;
  const oldPaste = state.rec.pasteText || '';
  scriptUI.renderLoading(state.rec.title || '正在重新检测字幕…');
  const st = {
    videoKey: state.videoKey, site: state.rec.site, videoId: state.rec.videoId,
    p: state.rec.p || 1, title: state.rec.title || '', dur: state.lastDur || 0,
    t: state.lastT, playing: state.lastPlaying,
  };
  state.rec = null;
  state.rows = [];
  const res = await askTab(state.tabId, { cmd: 'VJX_GET_TRANSCRIPT', args: {} }, 120000);
  if (res && res.ok && res.rows && res.rows.length) {
    const rec = {
      mode: 'video',
      site: res.site, videoId: res.videoId, p: res.p || st.p,
      title: res.title || st.title || '',
      duration: res.duration || st.dur || 0,
      lang: res.lang, trackName: res.trackName, isAuto: !!res.isAuto,
      tracks: res.tracks || [],
      layer: res.layer,
      rows: res.rows,
    };
    await saveTranscript(state.videoKey, rec);
    adoptRecord(rec);
    toast('检测到字幕，已加载 ✓');
  } else {
    const rec = {
      mode: 'nosub',
      site: st.site, videoId: st.videoId, p: st.p,
      title: (res && res.title) || st.title,
      noSubtitle: {
        reason: (res && res.reason) || 'unknown',
        message: (res && res.message) || '仍未检测到字幕（结果已缓存 30 天）。',
        needLoginHint: !!(res && res.needLoginHint),
        checkedAt: Date.now(),
      },
      rows: [],
      pasteText: oldPaste,
    };
    await saveTranscript(state.videoKey, rec);
    adoptRecord(rec);
    toast('仍未检测到字幕（已缓存 30 天）');
  }
  rechecking = false;
}

chrome.tabs.onActivated.addListener(() => void refreshForTab());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && tabId === state.tabId) void refreshForTab();
});

function seek(t) {
  if (state.tabId == null || typeof t !== 'number') return;
  chrome.tabs.sendMessage(state.tabId, { cmd: 'VJX_SEEK', t }, () => void chrome.runtime.lastError);
  if (state.rec && state.rec.mode === 'video') {
    state.lastT = t;
    scriptUI.setProgress(t, state.lastPlaying);
  }
}

// ---------- 对话 ----------
const QUICK_PROMPTS = {
  summary: '请用不超过300字的中文，把这个视频讲了什么讲清楚。严格要求：总字数（含标点）不得超过300字。',
  tree: '请把整个视频的内容结构整理成一棵层级结构树：仿 Linux tree 命令的缩进格式（使用 ├── └── │ 等字符），中文，总字数不超过500字，只输出结构树本身，不要代码块围栏，不要其他解释。',
};

function systemPrompt() {
  const rec = state.rec;
  if (!rec) return null;
  let scriptBlock;
  if (rec.mode === 'paste') {
    if (!rec.pasteText) return null;
    scriptBlock = `【用户粘贴的脚本】（无时间轴；回答时禁止编造时间戳）\n${rec.pasteText}`;
  } else if (rec.mode === 'video') {
    if (!state.rows.length) return null;
    let lines = state.rows.map((r) => `[${fmtT(r.t)}] ${r.text}${r.zh ? '｜' + r.zh : ''}`);
    let text = lines.join('\n');
    if (text.length > 60000) {
      text = text.slice(0, 58000) + '\n…（脚本过长，后半部分已截断）';
    }
    scriptBlock = `【视频脚本】每行格式：[m:ss] 原文｜中文翻译\n${text}`;
  } else {
    return null;
  }
  const siteName = rec.site === 'yt' ? 'YouTube' : 'B站';
  return `你是视频内容讲解助手。用户正在观看：
《${rec.title || '未知标题'}》（站点：${siteName}）

${scriptBlock}

回答规则：
1. 始终用简体中文回答（专有名词可保留英文）。
2. 引用视频内容时标注时间戳，格式如 [3:05]；只允许使用脚本中出现的时间戳，严禁编造。（粘贴脚本模式无时间轴，直接回答即可。）
3. 以脚本内容为主要依据；脚本外的补充知识请注明是扩展。
4. 回答结构清晰、简洁。`;
}

async function sendChat(userText, { display }) {
  if (state.chatBusy || !state.videoKey) return;
  const settings = state.settings;
  const cfg = settings.providers[settings.activeProvider];
  if (!cfg.apiKey) {
    toast('请先在「设置」页配置 API Key');
    activateTab('settings');
    return;
  }
  const sys = systemPrompt();
  if (!sys) { toast('没有可用的脚本上下文'); return; }

  state.chatBusy = true;
  chatSetStreaming(true);
  const history = await getChat(state.videoKey);
  const messages = [
    { role: 'system', content: sys },
    ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];
  if (display) {
    // 手动输入：追加用户气泡
    const box = $('msgsBox');
    if (box) {
      box.querySelector('.chat-hint')?.remove();
      box.insertAdjacentHTML('beforeend',
        `<div class="msg u"><div class="who">你</div><div class="bubble">${escapeH(userText).replace(/\n/g, '<br>')}</div></div>`);
      box.scrollTop = box.scrollHeight;
    }
  }
  const bubble = startStreamBubble();
  state.sendAbort = new AbortController();
  let full = '';
  try {
    full = await chatStream({
      settings,
      messages,
      maxTokens: 8000, // 推理模型的思考也计入输出上限，留足余量
      signal: state.sendAbort.signal,
      onDelta: (piece, f) => bubble.append(piece, f),
      onReasoning: (_p, reasoningFull) => bubble.think(reasoningFull),
    });
    bubble.finalize(full);
    history.push({ role: 'user', content: userText }, { role: 'assistant', content: full });
    await saveChat(state.videoKey, history);
  } catch (e) {
    const aborted = state.sendAbort.signal.aborted;
    if (aborted) bubble.fail('已中断');
    else bubble.fail(e instanceof LLMError ? e.kind : String(e.message || e));
  } finally {
    state.chatBusy = false;
    chatSetStreaming(false);
  }
}

function onQuick(kind) {
  const prompt = QUICK_PROMPTS[kind];
  if (prompt) void sendChat(prompt, { display: false });
}

async function onClearChat() {
  if (!state.videoKey) return;
  await clearChat(state.videoKey);
  chatUI.render(chatMeta(), []);
  toast('本视频对话已清空');
}

// ---------- 设置页 ----------
async function refreshSettingsPane() {
  state.settings = await getSettings();
  settingsUI.render(state.settings);
}

// ---------- Tab 路由 ----------
function activateTab(name) {
  document.querySelectorAll('.tabs .tab').forEach((el) => {
    el.classList.toggle('on', el.dataset.tab === name);
  });
  document.querySelectorAll('.tabpane').forEach((el) => el.classList.remove('on'));
  $(`pane-${name}`).classList.add('on');
}

document.querySelectorAll('.tabs .tab').forEach((el) => {
  el.addEventListener('click', () => activateTab(el.dataset.tab));
});
$('closeBtn').addEventListener('click', () => window.close());

function escapeH(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- 启动 ----------
(async () => {
  await refreshSettingsPane();
  await refreshForTab();
})();
