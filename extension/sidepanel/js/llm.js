// 视频讲解器 · LLM 接入层：OpenAI 兼容 /chat/completions + SSE 流式（ADR-006）
import { getProvider, PROVIDERS } from './providers.js';

// providerCfg 允许传 {id:...} 或完整注册项；统一归一到注册表条目
function resolveProv(settings, providerCfg) {
  const id = (providerCfg && providerCfg.id) || settings.activeProvider || 'glm';
  return PROVIDERS[id] || PROVIDERS.glm;
}

export class LLMError extends Error {
  constructor(kind, detail) {
    super(kind);
    this.kind = kind;      // 分类后的用户文案
    this.detail = detail;  // 原始信息（调试用）
  }
}

function classifyStatus(status, bodyText) {
  if (status === 401 || status === 403) return 'API Key 无效或无权限，请到「设置」检查';
  if (status === 429) return '请求过于频繁或额度不足，请稍后重试';
  if (status === 404) return '接口或模型不存在，请检查 Base URL 与模型名';
  if (status >= 500) return '服务商服务异常，请稍后重试';
  let hint = '';
  try { const j = JSON.parse(bodyText); hint = (j.error && (j.error.message || j.error.code)) || ''; } catch (e) { /* */ }
  return `请求失败（HTTP ${status}）${hint ? '：' + hint : ''}`;
}

function fullUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

// 流式对话。onDelta(增量文本) 回调；返回完整文本。
export async function chatStream({ settings, providerCfg, messages, maxTokens = 4000, temperature, signal, onDelta, onReasoning }) {
  const prov = resolveProv(settings, providerCfg);
  // 整体超时：服务端偶发不响应时避免永久转圈
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(new Error('overall_timeout')), 150000);
  const onOuterAbort = () => timeoutCtrl.abort(signal && signal.reason);
  if (signal) {
    if (signal.aborted) timeoutCtrl.abort(signal.reason);
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const body = prov.transformPayload({
    model: settings.providers[prov.id].model,
    messages,
    stream: true,
    max_tokens: maxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
  });
  let res;
  try {
    res = await fetch(fullUrl(settings.providers[prov.id].baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.providers[prov.id].apiKey}`,
      },
      body: JSON.stringify(body),
      signal: timeoutCtrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (signal && signal.removeEventListener) signal.removeEventListener('abort', onOuterAbort);
    if (e.name === 'AbortError') {
      if (signal && signal.aborted) throw new LLMError('已取消', e);
      throw new LLMError('连接超时（150 秒无响应），请重试', e);
    }
    throw new LLMError('网络错误：无法连接到 ' + settings.providers[prov.id].baseUrl, e);
  }
  if (!res.ok) {
    clearTimeout(timer);
    if (signal && signal.removeEventListener) signal.removeEventListener('abort', onOuterAbort);
    const t = await res.text().catch(() => '');
    throw new LLMError(classifyStatus(res.status, t), t.slice(0, 500));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let reasoningFull = '';
  let done = false;
  try {
    while (!done) {
      const { value, done: rdDone } = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('stream_stall')), 60000)),
      ]);
      if (rdDone) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { done = true; break; }
        try {
          const j = JSON.parse(payload);
          const delta = j.choices && j.choices[0] && j.choices[0].delta;
          const piece = delta && delta.content;
          if (piece) {
            full += piece;
            if (onDelta) onDelta(piece, full);
          }
          // 推理模型的思考过程：不进正文/历史，但回调给 UI 做可视化（避免长时间"假死"观感）
          const think = delta && delta.reasoning_content;
          if (think && onReasoning) {
            reasoningFull += think;
            onReasoning(think, reasoningFull);
          }
        } catch (e) { /* 跳过不完整行 */ }
      }
    }
  } catch (e) {
    if (String(e.message || e) === 'stream_stall') {
      throw new LLMError('流式响应中断（60 秒无新内容），请重试', e);
    }
    if (e.name === 'AbortError') {
      if (signal && signal.aborted) throw new LLMError('已取消', e);
      throw new LLMError('连接超时（150 秒无响应），请重试', e);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal && signal.removeEventListener) signal.removeEventListener('abort', onOuterAbort);
  }
  if (!full.trim() && reasoningFull) {
    // 思考模型把 max_tokens 全花在推理上，正文为空
    throw new LLMError('模型思考后未输出正文（推理占满了输出上限），请重试或换用更低思考档', null);
  }
  return full;
}

// 非流式调用（翻译分块 / 连通性测试用）
export async function chatOnce({ settings, providerCfg, messages, maxTokens = 3000, temperature, timeoutMs = 90000, signal }) {
  const prov = resolveProv(settings, providerCfg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(signal && signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const body = prov.transformPayload({
    model: settings.providers[prov.id].model,
    messages,
    stream: false,
    max_tokens: maxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
  });
  try {
    const res = await fetch(fullUrl(settings.providers[prov.id].baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.providers[prov.id].apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new LLMError(classifyStatus(res.status, t), t.slice(0, 500));
    }
    const j = await res.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } catch (e) {
    if (e instanceof LLMError) throw e;
    if (e.name === 'AbortError') {
      const byTimeout = signal && !signal.aborted;
      throw new LLMError(byTimeout ? '连接超时' : '已取消', e);
    }
    throw new LLMError('网络错误：无法连接到服务商', e);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 设置页连通性测试：返回 {ok, message}
export async function testConnectivity(settings, providerId) {
  const t0 = performance.now();
  try {
    const text = await chatOnce({
      settings,
      providerCfg: { id: providerId },
      messages: [{ role: 'user', content: '请只回复两个字：成功' }],
      maxTokens: 64,
      timeoutMs: 20000,
    });
    const ms = Math.round(performance.now() - t0);
    const preview = (text || '').replace(/\s+/g, ' ').slice(0, 24) || '（空回复）';
    return { ok: true, message: `连接成功 · ${ms}ms · 回复「${preview}」` };
  } catch (e) {
    return { ok: false, message: e instanceof LLMError ? `${e.kind}（${e.detail ? String(e.detail).slice(0, 80) : ''}）` : String(e.message || e) };
  }
}
