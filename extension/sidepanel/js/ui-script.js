// 视频讲解器 · 脚本 Tab UI（跟随引擎交互层）
import { escapeHtml, fmtT } from './render.js';

const els = {
  pane: null,
  transcript: null,
  followPill: null,
};

let curRow = -1;
let followPaused = false;
let pauseTimer = null;
let programmatic = false;
let rows = [];
let mode = 'video'; // video | paste | none

export function initScriptTab(deps) {
  els.pane = deps.pane;
  return {
    renderLoading, renderEmpty, renderRefreshHint, renderNoSubtitle, renderScript, renderPasteView,
    setRows, setProgress, setTranslating, setTranslateDone, setTranslateError,
    getFollowPaused, resetFollow, updateZhRow, asrStatus,
  };
}

// ---------- 状态渲染 ----------
function renderLoading(title) {
  els.pane.innerHTML = `
    <div class="info-card">
      <div class="t">${escapeHtml(title || '正在识别当前页面…')}</div>
      <div class="meta"><span class="skeleton badge" style="width:60px"></span><span class="skeleton badge" style="width:80px"></span></div>
      <div class="trans-progress"><div class="label"><span>正在获取字幕…</span></div><div class="pbar"><i class="indeterminate"></i></div></div>
    </div>
    <div class="transcript">${'<div class="skeletonrow"><i style="width:34px"></i><i style="width:88%"></i></div>'.repeat(8)}</div>`;
}

function renderEmpty() {
  mode = 'none';
  els.pane.innerHTML = `
    <div class="empty-state">
      <img src="../assets/logo-128.png" alt="">
      <h3>请打开一个视频页面</h3>
      <p>侧边栏会自动识别当前标签页。<br>打开支持的页面后，这里会自动加载该视频的脚本与对话。</p>
      <div class="sites">✓ YouTube（youtube.com/watch）　✓ B站（bilibili.com/video）</div>
    </div>`;
}

// 视频页符合条件但桥接不上（典型：插件比页面后安装/更新）→ 明确提示刷新
function renderRefreshHint() {
  mode = 'none';
  els.pane.innerHTML = `
    <div class="empty-state">
      <img src="../assets/logo-128.png" alt="">
      <h3>视频页未连接</h3>
      <p>这个页面是在插件安装/更新之前打开的。<br><b>刷新一下这个视频页面</b>，脚本就会自动加载。</p>
    </div>`;
}

function renderNoSubtitle(info) {
  mode = 'none';
  const paste = info && info.pasteText || '';
  const days = info && info.checkedAtDays;
  const checkedHint = (days !== null && days !== undefined)
    ? `<div class="recheck-hint">本视频 ${days === 0 ? '今天' : days + ' 天前'}已检测过无字幕（30 天后会自动重检），期间不再重复请求。</div>`
    : '';
  els.pane.innerHTML = `
    <div class="script-wrap">
      <div class="nosub-card">
        <h4>⚠ 该视频没有可用字幕</h4>
        <p>${escapeHtml((info && info.message) || '未找到可用字幕。')}<br>
        两种补救方式：① 把脚本/字幕文本粘贴到下面；② <b>🎤 AI 听录</b>——下载音轨用语音识别生成带时间戳的脚本（按量计费，约 0.72 元/小时）。</p>
        <textarea id="pasteBox" placeholder="把脚本文本粘贴到这里……">${escapeHtml(paste)}</textarea>
        <button class="go" id="pasteGo">使用这段脚本</button>
        <div class="asr-zone">
          <button class="asrbtn" id="asrGo">🎤 AI 听录生成字幕</button>
          <div class="asr-status" id="asrStatus"></div>
          <button class="recheck" id="recheckBtn">🔄 重新检测字幕</button>
          ${checkedHint}
        </div>
        ${paste ? '<div class="pasted-note">✓ 已使用粘贴脚本（总结 / 结构树 / 对话 可用；跟随、时间戳跳转、翻译不可用）。</div>' : ''}
      </div>
      ${paste ? `<div class="plainlist">${paste.split(/\n+/).filter(Boolean).map((l) => `<div class="pline">${escapeHtml(l)}</div>`).join('')}</div>` : ''}
    </div>`;
  const btn = els.pane.querySelector('#pasteGo');
  const box = els.pane.querySelector('#pasteBox');
  if (btn) btn.addEventListener('click', () => {
    const text = (box.value || '').trim();
    if (!text) return;
    if (info && info.onPaste) info.onPaste(text);
  });
  const asrBtn = els.pane.querySelector('#asrGo');
  if (asrBtn) asrBtn.addEventListener('click', () => {
    if (uiHooks.onAsr) uiHooks.onAsr();
  });
  const reBtn = els.pane.querySelector('#recheckBtn');
  if (reBtn) reBtn.addEventListener('click', () => {
    if (uiHooks.onRecheck) uiHooks.onRecheck();
  });
}

// AI 听录阶段提示（busy=true 时按钮禁用 + 进度展示；err 时显示错误）
function asrStatus(phaseOrMsg, info, busy) {
  const box = els.pane.querySelector('#asrStatus');
  const goBtn = els.pane.querySelector('#asrGo');
  if (!box) return;
  if (goBtn) goBtn.disabled = !!busy;
  if (!busy) {
    box.innerHTML = `<span class="asr-err">✕ ${escapeHtml(phaseOrMsg)}</span>`;
    return;
  }
  let text = '';
  let pct = null;
  switch (phaseOrMsg) {
    case 'preparing': text = '准备中…'; break;
    case 'downloading': text = '① 下载音轨中…（取决于视频时长与网络）'; break;
    case 'decoding': text = '② 解码音频（数十秒，请稍候）…'; break;
    case 'slicing': text = `② 切片编码 ${info.done}/${info.total}…`; pct = info.total ? info.done / info.total : 0; break;
    case 'transcribing': text = `③ 语音识别 ${info.done}/${info.total || '?'}…`; pct = info.total ? info.done / info.total : 0; break;
    default: text = phaseOrMsg;
  }
  box.innerHTML = `<div class="trans-progress"><div class="label"><span>${escapeHtml(text)}</span></div>${pct === null ? '<div class="pbar"><i class="indeterminate"></i></div>' : `<div class="pbar"><i style="width:${Math.round(pct * 100)}%"></i></div>`}</div>`;
}

function renderPasteView(pasteText) {
  mode = 'paste';
  els.pane.innerHTML = `
    <div class="script-wrap">
      <div class="info-card">
        <div class="t">粘贴脚本模式</div>
        <div class="meta">
          <span class="badge lang">无时间轴</span>
          <span class="badge">${pasteText.length} 字</span>
          <span class="follow-pill paused">跟随不可用</span>
        </div>
        <div class="infobar"><button class="langtoggle" id="repasteBtn">重新粘贴</button></div>
      </div>
      <div class="plainlist">${pasteText.split(/\n+/).filter(Boolean).map((l) => `<div class="pline">${escapeHtml(l)}</div>`).join('')}</div>
    </div>`;
  const btn = els.pane.querySelector('#repasteBtn');
  if (btn) btn.addEventListener('click', () => { if (uiHooks.onRepaste) uiHooks.onRepaste(); });
}

function renderScript(meta) {
  mode = 'video';
  const langBadge = meta.needTranslate ? '需翻译' : '中文字幕';
  els.pane.innerHTML = `
    <div class="script-wrap ${onlyEn ? 'only-en' : ''}">
      <div class="info-card">
        <div class="t">${escapeHtml(meta.title || '')}</div>
        <div class="meta">
          <span class="badge lang">${escapeHtml(langBadge)}</span>
          <span class="badge">${fmtT(meta.duration || 0)}</span>
          <span class="badge">${rows.length} 行</span>
          ${meta.isAuto ? '<span class="badge">自动生成</span>' : ''}
          <span class="follow-pill" id="followPill">跟随中</span>
        </div>
        ${meta.trackSelectorHtml || ''}
        <div id="transStatus"></div>
      </div>
      <div class="transcript" id="transcript"></div>
    </div>`;
  els.transcript = els.pane.querySelector('#transcript');
  els.followPill = els.pane.querySelector('#followPill');
  paintRows();
  els.transcript.addEventListener('scroll', onManualScroll);
  if (uiHooks.onToggleTrackSelector) uiHooks.onToggleTrackSelector(meta);
}

function paintRows() {
  if (!els.transcript) return;
  els.transcript.innerHTML = rows.map((r, i) => {
    const ts = r.t == null ? '' : `<span class="ts">${fmtT(r.t)}</span>`;
    const orig = `<div class="en">${escapeHtml(r.text)}</div>`;
    const zhHtml = r.zh !== undefined
      ? `<div class="zh ${r.zh ? '' : 'pending'}" data-zh="${i}">${r.zh ? escapeHtml(r.zh) : '翻译中……'}</div>`
      : '';
    return `<div class="row" data-i="${i}">${ts}${orig}${zhHtml}</div>`;
  }).join('');
  els.transcript.querySelectorAll('.row').forEach((el) => {
    el.addEventListener('click', () => {
      const i = +el.dataset.i;
      if (rows[i] && rows[i].t != null && uiHooks.onSeek) uiHooks.onSeek(rows[i].t);
    });
  });
}

let onlyEn = false;
const uiHooks = {};

export function bindUiHooks(hooks) { Object.assign(uiHooks, hooks); }

// ---------- 跟随引擎 ----------
function rowIndexAt(t) {
  // 二分：最大的满足 rows[i].t <= t 的 i
  let lo = 0, hi = rows.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t != null && rows[mid].t <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function setProgress(t, playing) {
  if (mode !== 'video' || !rows.length) return;
  const i = rowIndexAt(t);
  if (i === curRow) { setFollowPill(playing); return; }
  curRow = i;
  els.transcript.querySelectorAll('.row.cur').forEach((el) => el.classList.remove('cur'));
  const el = els.transcript.querySelector(`[data-i="${i}"]`);
  if (el) {
    el.classList.add('cur');
    if (!followPaused) {
      programmatic = true;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => { programmatic = false; }, 650);
    }
  }
  setFollowPill(playing);
}

function onManualScroll() {
  if (programmatic) return;
  followPaused = true;
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => { followPaused = false; setFollowPill(); }, 3000);
  setFollowPill();
}

function setFollowPill(playing) {
  if (!els.followPill) return;
  if (!playing) {
    els.followPill.textContent = '已暂停播放';
    els.followPill.className = 'follow-pill paused';
  } else if (followPaused) {
    els.followPill.textContent = '手动滚动 · 3秒后恢复跟随';
    els.followPill.className = 'follow-pill paused';
  } else {
    els.followPill.textContent = '跟随中';
    els.followPill.className = 'follow-pill';
  }
}

function setRows(newRows) {
  rows = newRows || [];
  curRow = -1;
  paintRows();
}

function setTranslating(done, total) {
  const box = els.pane.querySelector('#transStatus');
  if (!box) return;
  box.innerHTML = `<div class="trans-progress"><div class="label"><span id="transLb">翻译中 ${done}/${total}</span><span>LLM 批量预翻译 · 渐进填充</span></div><div class="pbar"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div></div>`;
}

function setTranslateDone() {
  const box = els.pane.querySelector('#transStatus');
  if (box) box.innerHTML = `<div class="trans-progress"><div class="label"><span>英中对照 · 已缓存 ✓ 二次打开秒出</span><span class="done">完成</span></div><div class="pbar"><i style="width:100%"></i></div></div>`;
}

function setTranslateError(msg) {
  const box = els.pane.querySelector('#transStatus');
  if (box) box.innerHTML = `<div class="trans-progress"><div class="label"><span style="color:#b45309">翻译失败：${escapeHtml(msg)}</span></div><div class="pbar"><i style="width:0%"></i></div></div>`;
}

function getFollowPaused() { return followPaused; }
function resetFollow() { curRow = -1; followPaused = false; clearTimeout(pauseTimer); }

// 翻译完成后单行更新（不整列表重绘，避免滚动位置跳动）
function updateZhRow(i, zh) {
  if (!els.transcript) return;
  const cell = els.transcript.querySelector(`[data-zh="${i}"]`);
  if (!cell) return;
  cell.classList.remove('pending');
  cell.textContent = zh;
}
