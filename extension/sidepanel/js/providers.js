// 视频讲解器 · LLM 服务商注册表（ADR-006）
// 新增服务商：在此注册一项即可，其余层无感知。
export const PROVIDERS = {
  glm: {
    id: 'glm',
    label: '智谱 GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3-flash',
    baseUrlHint: '普通 Key 用官方地址；GLM Coding Plan 套餐请改用 https://open.bigmodel.cn/api/coding/paas/v4',
    // glm-5.3-flash 为"始终思考"模型（API 错误码 1210：不支持关闭，仅支持 low/high/max）。
    // 翻译/总结类任务用 low 档：最快出首字，也最省 token。
    transformPayload(payload) {
      return { ...payload, thinking: { type: 'low' } };
    },
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    baseUrlHint: '默认官方地址，可改为中转 / 代理',
    transformPayload(payload) {
      return payload;
    },
  },
};

export function getProvider(settings) {
  const id = settings.activeProvider || 'glm';
  return PROVIDERS[id] || PROVIDERS.glm;
}
