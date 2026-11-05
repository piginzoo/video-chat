// 视频讲解器 · 对话 Tab UI
import { escapeHtml, renderRich, fmtT } from './render.js';

let pane = null;
let streaming = false;
let videoMeta = null; // {title, mode, rowCount, scriptChars, needTranslate}

const uiHooks = {};
export function bindChatHooks(hooks) { Object.assign(uiHooks, hooks); }

export function initChatTab(deps) {
  pane = deps.pane;
  return { render, setStreaming, getContextInfo };
}

export function setVideoMeta(meta) { videoMeta = meta; }
export function getContextInfo() { return videoMeta; }

// ---------- 渲染 ----------
function render(meta, messages) {
  setVideoMeta(meta);
  const ctxText = meta.mode === 'paste'
    ? `上下文：粘贴脚本 · ${meta.scriptChars || 0} 字 · 无时间轴`
    : meta.mode === 'video'
      ? `上下文已加载 · ${meta.rowCount} 行${meta.needTranslate ? ' · 双语' : ''}`
      : '暂无脚本上下文';
  const keyMissing = uiHooks.isKeyMissing ? uiHooks.isKeyMissing() : false;
  pane.innerHTML = `
    <div class="chat-wrap">
      <div class="ctx-chip">📎 ${escapeHtml(ctxText)}<span class="clr" id="clrChat">清空对话</span></div>
      ${keyMissing ? '<div class="keywarn">⚠ 未配置 API Key，请先到「设置」页配置并保存后再对话。</div>' : ''}
      <div class="msgs" id="msgsBox"></div>
      <div class="chat-input-zone">
        <div class="quickbtns">
          <button class="qbtn" id="qSummary" ${keyMissing || meta.mode === 'none' ? 'disabled' : ''}>✦ 总结</button>
          <button class="qbtn" id="qTree" ${keyMissing || meta.mode === 'none' ? 'disabled' : ''}>🌳 视频结构</button>
          <span class="modeltag" id="modelTag"></span>
        </div>
        <div class="inputrow">
          <textarea id="chatInput" placeholder="${keyMissing ? '请先在设置页配置 API Key' : '针对视频内容提问… 回车发送'}" ${meta.mode === 'none' ? 'disabled' : ''}></textarea>
          <button class="sendbtn" id="sendBtn" ${keyMissing || meta.mode === 'none' ? 'disabled' : ''}>发送</button>
        </div>
      </div>
    </div>`;

  paintMessages(messages);

  pane.querySelector('#clrChat').addEventListener('click', () => uiHooks.onClearChat && uiHooks.onClearChat());
  pane.querySelector('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUser(); }
  });
  pane.querySelector('#sendBtn').addEventListener('click', sendUser);
  pane.querySelector('#qSummary').addEventListener('click', () => quick('summary'));
  pane.querySelector('#qTree').addEventListener('click', () => quick('tree'));

  // 时间戳点击（事件委托）
  const box = pane.querySelector('#msgsBox');
  box.addEventListener('click', (e) => {
    const a = e.target.closest('a.ts');
    if (a && uiHooks.onSeek) {
      const t = parseFloat(a.dataset.t) || 0;
      uiHooks.onSeek(t);
      if (uiHooks.toast) uiHooks.toast(`视频跳转到 ${fmtT(t)}`);
    }
  });

  if (uiHooks.modelLabel) pane.querySelector('#modelTag').textContent = uiHooks.modelLabel();
}

function paintMessages(messages) {
  const box = pane.querySelector('#msgsBox');
  box.innerHTML = (messages || []).map(msgHtml).join('')
    || '<div class="chat-hint">开始针对这个视频提问吧 ↓</div>';
  box.scrollTop = box.scrollHeight;
}

function msgHtml(m) {
  return `<div class="msg ${m.role === 'user' ? 'u' : 'a'}">
    <div class="who">${m.role === 'user' ? '你' : '讲解助手'}</div>
    <div class="bubble">${m.role === 'user' ? escapeHtml(m.content).replace(/\n/g, '<br>') : renderRich(m.content)}</div>
  </div>`;
}

// ---------- 发送入口 ----------
function sendUser() {
  if (streaming) return;
  const input = pane.querySelector('#chatInput');
  const text = (input.value || '').trim();
  if (!text) return;
  input.value = '';
  if (uiHooks.onUserSend) uiHooks.onUserSend(text);
}

function quick(kind) {
  if (streaming) return;
  if (uiHooks.onQuick) uiHooks.onQuick(kind);
}

// ---------- 流式气泡 ----------
export function startStreamBubble() {
  const box = pane.querySelector('#msgsBox');
  const hint = box.querySelector('.chat-hint');
  if (hint) hint.remove();
  box.insertAdjacentHTML('beforeend',
    `<div class="msg a streaming"><div class="who">讲解助手</div><div class="bubble"><span class="thinkline"></span><span class="tx"></span><span class="cursor"></span></div></div>`);
  box.scrollTop = box.scrollHeight;
  const wrap = box.lastElementChild;
  let sawContent = false;
  return {
    append(piece, full) {
      sawContent = true;
      const tl = wrap.querySelector('.thinkline');
      if (tl) tl.textContent = '';
      wrap.querySelector('.tx').textContent = full;
      box.scrollTop = box.scrollHeight;
    },
    think(tail) {
      if (sawContent) return;
      const tl = wrap.querySelector('.thinkline');
      if (tl) tl.textContent = '💭 思考中… ' + tail.slice(-60);
      box.scrollTop = box.scrollHeight;
    },
    fail(text) {
      wrap.classList.remove('streaming');
      const tl = wrap.querySelector('.thinkline');
      if (tl) tl.textContent = '';
      const c = wrap.querySelector('.cursor');
      if (c) c.remove();
      wrap.querySelector('.bubble').innerHTML = `<span class="errmsg">✕ ${escapeHtml(text)}</span>`;
    },
    finalize(full) {
      wrap.classList.remove('streaming');
      const tl = wrap.querySelector('.thinkline');
      if (tl) tl.textContent = '';
      const c = wrap.querySelector('.cursor');
      if (c) c.remove();
      wrap.querySelector('.bubble').innerHTML = renderRich(full);
      box.scrollTop = box.scrollHeight;
    },
  };
}

export function setStreaming(v) {
  streaming = v;
  pane.querySelectorAll('.qbtn, .sendbtn').forEach((b) => { b.disabled = v; });
  const input = pane.querySelector('#chatInput');
  if (input) input.disabled = v;
}
