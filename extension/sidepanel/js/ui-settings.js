// 视频讲解器 · 设置 Tab UI（ADR-006 双套配置 + 切换；ADR-011 ASR 语音识别配置）
import { PROVIDERS } from './providers.js';
import { testConnectivity } from './llm.js';
import { asrTestConnectivity } from './asr.js';

let els = {};
let curProv = null; // 首次 render 时从 settings 初始化；此后由点击驱动（原写法在 render 开头重置，导致 DeepSeek 永远选不中——已修）

export function initSettingsTab(deps) {
  els = deps;
  return { render };
}

function render(settings) {
  if (curProv === null) curProv = settings.activeProvider || 'glm';
  els.pane.innerHTML = `
    <div class="settings">
      <div class="sectiontitle">LLM 服务商</div>
      <div class="provider-pick">
        ${Object.values(PROVIDERS).map((p) => `
          <div class="prov ${curProv === p.id ? 'on' : ''}" data-p="${p.id}">
            <div class="pn"><span class="radio"></span>${p.label}</div>
            <div class="pd">当前模型：<b>${escapeAttr(settings.providers[p.id].model)}</b></div>
          </div>`).join('')}
      </div>

      ${Object.values(PROVIDERS).map((p) => providerCard(p, settings.providers[p.id])).join('')}

      <div class="sectiontitle" style="margin-top:18px">🎤 ASR 语音识别（无字幕视频 AI 听录）</div>
      <div class="cfg-card" id="card-asr">
        <div class="field">
          <label>API Key</label>
          <div class="inwrap">
            <input id="key-asr" type="password" value="${escapeAttr(settings.asr.apiKey || '')}" placeholder="智谱 API Key（与 LLM 可相同）">
            <span class="eye" data-for="key-asr">👁</span>
          </div>
          <div class="hint">用于无字幕视频的 AI 听录；按量计费（约 0.72 元/小时），与 Coding Plan 额度分开</div>
        </div>
        <div class="field">
          <label>Base URL</label>
          <div class="inwrap"><input id="url-asr" value="${escapeAttr(settings.asr.baseUrl || 'https://open.bigmodel.cn/api/paas/v4')}"></div>
        </div>
        <div class="field">
          <label>模型名</label>
          <div class="inwrap"><input id="model-asr" value="${escapeAttr(settings.asr.model || 'glm-asr-2512')}"></div>
          <div class="hint">当前仅支持 glm-asr-2512；音频按 28 秒分块上传，无字幕视频页可一键听录</div>
        </div>
        <div class="testrow">
          <button class="testbtn" data-prov="asr">⚡ 连通性测试</button>
          <span class="test-result" id="res-asr"></span>
        </div>
      </div>

      <button class="savebtn" id="saveCfg">保存配置</button>
      <div class="storage-note">🔒 隐私说明：API Key 与对话记录仅存储在浏览器本地（chrome.storage.local），不进代码仓库、不云同步；脚本内容只发送到你配置的 LLM 服务商，无任何遥测。</div>

      <div class="about">
        <img src="../assets/logo-128.png" alt="logo">
        <div>
          <div class="an">视频讲解器 v1.0</div>
          <div class="ad">© 2026 <b>piginzoo</b> · 保留所有权利<br>脚本跟随 × AI 对话 × 一键总结</div>
        </div>
      </div>
    </div>`;

  // 交互绑定
  els.pane.querySelectorAll('.prov').forEach((el) => {
    el.addEventListener('click', () => { curProv = el.dataset.p; render(settings); });
  });
  els.pane.querySelectorAll('.eye').forEach((eye) => {
    eye.addEventListener('click', () => {
      const input = els.pane.querySelector('#' + eye.dataset.for);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });
  els.pane.querySelector('#saveCfg').addEventListener('click', onSave);
  els.pane.querySelectorAll('.testbtn').forEach((btn) => {
    btn.addEventListener('click', () => runTest(btn));
  });
}

function providerCard(p, cfg) {
  return `
    <div class="cfg-card ${curProv !== p.id ? 'hidden' : ''}" id="card-${p.id}">
      <div class="field">
        <label>API Key</label>
        <div class="inwrap">
          <input id="key-${p.id}" type="password" value="${escapeAttr(cfg.apiKey || '')}" placeholder="粘贴你的 ${p.label} API Key">
          <span class="eye" data-for="key-${p.id}">👁</span>
        </div>
        <div class="hint">仅保存在本机 chrome.storage.local，界面掩码显示，可切换明文</div>
      </div>
      <div class="field">
        <label>Base URL</label>
        <div class="inwrap"><input id="url-${p.id}" value="${escapeAttr(cfg.baseUrl || p.defaultBaseUrl)}"></div>
        <div class="hint">${escapeHtml(p.baseUrlHint)}</div>
      </div>
      <div class="field">
        <label>模型名</label>
        <div class="inwrap"><input id="model-${p.id}" value="${escapeAttr(cfg.model || p.defaultModel)}"></div>
      </div>
      <div class="testrow">
        <button class="testbtn" data-prov="${p.id}">⚡ 连通性测试</button>
        <span class="test-result" id="res-${p.id}"></span>
      </div>
    </div>`;
}

async function onSave() {
  const settings = await collectAndMerge();
  await els.saveSettings(settings);
  els.toast('配置已保存（chrome.storage.local）');
}

async function runTest(btn) {
  const provId = btn.dataset.prov;
  const res = els.pane.querySelector(`#res-${provId}`);
  const settings = await collectAndMerge();
  btn.disabled = true;
  res.className = 'test-result';
  res.textContent = '连接中…';
  const r = provId === 'asr'
    ? await asrTestConnectivity(settings)
    : await testConnectivity(settings, provId);
  btn.disabled = false;
  res.className = 'test-result ' + (r.ok ? 'ok' : 'err');
  res.textContent = r.message;
}

async function collectAndMerge() {
  const settings = await els.getSettings();
  settings.activeProvider = curProv;
  for (const p of Object.values(PROVIDERS)) {
    const keyInput = els.pane.querySelector(`#key-${p.id}`);
    const urlInput = els.pane.querySelector(`#url-${p.id}`);
    const modelInput = els.pane.querySelector(`#model-${p.id}`);
    if (!keyInput) continue; // 隐藏卡片的字段仍在 DOM（只是 display:none），querySelector 仍可命中
    settings.providers[p.id] = {
      ...settings.providers[p.id],
      apiKey: keyInput.value.trim(),
      baseUrl: urlInput.value.trim() || p.defaultBaseUrl,
      model: modelInput.value.trim() || p.defaultModel,
    };
  }
  const asrKey = els.pane.querySelector('#key-asr');
  if (asrKey) {
    settings.asr = {
      apiKey: asrKey.value.trim(),
      baseUrl: els.pane.querySelector('#url-asr').value.trim() || 'https://open.bigmodel.cn/api/paas/v4',
      model: els.pane.querySelector('#model-asr').value.trim() || 'glm-asr-2512',
    };
  }
  return settings;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
