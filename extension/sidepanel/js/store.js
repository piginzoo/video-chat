// 视频讲解器 · 存储层（chrome.storage.local + LRU 淘汰，ADR-005）
export const DEFAULT_SETTINGS = {
  activeProvider: 'glm',
  providers: {
    glm: { apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash' },
    deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  },
  asr: { apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-asr-2512' },
};

const TR_LIMIT = 30;   // 保留最近 30 个视频的脚本/翻译缓存
const CHAT_LIMIT = 50; // 保留最近 50 个视频的对话

const area = chrome.storage.local;

export async function getSettings() {
  const d = await area.get('settings');
  const s = d.settings || {};
  // 浅合并，保证新版本新增字段有默认值
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    providers: {
      glm: { ...DEFAULT_SETTINGS.providers.glm, ...(s.providers && s.providers.glm) },
      deepseek: { ...DEFAULT_SETTINGS.providers.deepseek, ...(s.providers && s.providers.deepseek) },
    },
    asr: { ...DEFAULT_SETTINGS.asr, ...(s.asr || {}) },
  };
}
export async function saveSettings(settings) {
  await area.set({ settings });
}

export async function getTranscript(videoKey) {
  const key = `tr:${videoKey}`;
  const d = await area.get(key);
  const rec = d[key];
  if (!rec) return null;
  // 触达时间刷新（LRU）
  rec.updatedAt = Date.now();
  await area.set({ [key]: rec });
  return rec;
}

export async function saveTranscript(videoKey, rec) {
  const key = `tr:${videoKey}`;
  rec.updatedAt = Date.now();
  await area.set({ [key]: rec });
  trimLRU('tr:', TR_LIMIT);
}

export async function getChat(videoKey) {
  const key = `chat:${videoKey}`;
  const d = await area.get(key);
  const rec = d[key];
  if (!rec) return [];
  rec.updatedAt = Date.now();
  await area.set({ [key]: rec });
  return rec.messages || [];
}

export async function saveChat(videoKey, messages) {
  const key = `chat:${videoKey}`;
  await area.set({ [key]: { messages, updatedAt: Date.now() } });
  trimLRU('chat:', CHAT_LIMIT);
}

export async function clearChat(videoKey) {
  await area.remove(`chat:${videoKey}`);
}

async function trimLRU(prefix, limit) {
  const all = await area.get(null);
  const items = Object.entries(all)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => ({ k, at: (v && v.updatedAt) || 0 }));
  if (items.length <= limit) return;
  items.sort((a, b) => a.at - b.at);
  const drop = items.slice(0, items.length - limit).map((x) => x.k);
  await area.remove(drop);
}
