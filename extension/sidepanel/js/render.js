// 视频讲解器 · 极简渲染器（ADR-002 / ADR-009）
// 全量 HTML 转义（防注入）→ [m:ss] 时间戳链接化 → 换行 → tree 缩进块识别
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TS_RE = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;

function isTreeText(text) {
  const lines = String(text).split('\n').filter((l) => l.trim());
  if (lines.length < 3) return false;
  const treeLines = lines.filter((l) => /^\s*[|`]?[│├└─—-]{1,3}/.test(l)).length;
  return treeLines >= Math.max(3, Math.floor(lines.length / 2));
}

// 渲染模型回复。onTsClick 由调用方通过事件委托处理（a.ts[data-t]）。
export function renderRich(text) {
  const raw = String(text);
  if (isTreeText(raw)) {
    // 模型有时会给 tree 外层套 ``` 围栏，剥掉
    const stripped = raw.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    return `<pre class="tree">${escapeHtml(stripped)}</pre>`;
  }
  let html = escapeHtml(raw);
  html = html.replace(TS_RE, (m, mm, ss, hh) => {
    const total = hh !== undefined ? (+mm) * 3600 + (+ss) * 60 + (+hh) : (+mm) * 60 + (+ss);
    const label = hh !== undefined ? `${mm}:${ss}:${hh}` : `${mm}:${ss}`;
    return `<a class="ts" data-t="${total}" title="跳转到 ${label}">[${label}]</a>`;
  });
  html = html.replace(/\n/g, '<br>');
  return html;
}

// 脚本行时间展示格式 0:00 / 12:34
export function fmtT(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function parseTsToSec(label) {
  const parts = String(label).split(':').map((x) => parseInt(x, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}
