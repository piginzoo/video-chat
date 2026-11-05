// 视频讲解器 · 批量翻译流水线（ADR-007）
// 分块（≤40 行且 ≤3500 字符）→ 并发 2 → JSON 行级解析 → 失败单块重试 → 渐进回调
import { chatOnce, LLMError } from './llm.js';

const CHUNK_LINES = 40;
const CHUNK_CHARS = 3500;

export function buildChunks(indices, rows) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  for (const i of indices) {
    const len = (rows[i].text || '').length;
    if (cur.length >= CHUNK_LINES || chars + len > CHUNK_CHARS) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const SYS = '你是专业的字幕翻译引擎。把给定的字幕行从原文翻译成简体中文：' +
  '口语化、准确、简洁，保留专有名词与技术术语（可用「中文(English)」形式）。' +
  '严格输出 JSON 数组，格式为 [{"i":<原行号>,"zh":"<译文>"}]，' +
  '数组长度必须与输入行数一致，i 与输入一致。禁止输出任何解释、注释或代码块标记。';

function parseTranslation(text, chunkIdxs) {
  if (!text) throw new Error('empty_translation');
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const s = t.indexOf('[');
  const e = t.lastIndexOf(']');
  if (s < 0 || e <= s) throw new Error('no_json_array');
  const arr = JSON.parse(t.slice(s, e + 1));
  const map = {};
  for (const item of arr) {
    if (item && typeof item.i !== 'undefined' && typeof item.zh === 'string') map[item.i] = item.zh.trim();
  }
  if (!Object.keys(map).length) throw new Error('empty_map');
  return map;
}

async function translateChunk(chunkIdxs, rows, settings, signal) {
  const input = chunkIdxs.map((i) => ({ i, en: rows[i].text }));
  const user = JSON.stringify(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await chatOnce({
        settings,
        messages: [
          { role: 'system', content: attempt === 0 ? SYS : SYS + '（注意：上一次输出不合规。只输出 JSON 数组本体。）' },
          { role: 'user', content: user },
        ],
        maxTokens: Math.max(800, chunkIdxs.length * 120),
        temperature: 0.2,
        timeoutMs: 90000,
        signal,
      });
      return parseTranslation(text, chunkIdxs);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (attempt === 1) throw e;
    }
  }
}

// rows: [{t, text, zh?, tr?}]；只翻译没有 zh 的行。
// onProgress({done, total})、onChunk(chunkIdxs, map) 每块完成回调。
// 返回 {translated: N, failed: [行索引]}
export async function translateRows(rows, settings, { concurrency = 2, signal, onProgress, onChunk } = {}) {
  const indices = rows.map((r, i) => (r.text && !r.zh ? i : -1)).filter((i) => i >= 0);
  const total = indices.length;
  if (!total) return { translated: 0, failed: [] };

  const chunks = buildChunks(indices, rows);
  const failed = [];
  let done = 0;
  let cursor = 0;
  const workerCount = Math.min(concurrency, chunks.length);

  async function worker() {
    while (cursor < chunks.length) {
      if (signal && signal.aborted) return;
      const idx = cursor++;
      const chunkIdxs = chunks[idx];
      try {
        const map = await translateChunk(chunkIdxs, rows, settings, signal);
        for (const i of chunkIdxs) {
          if (map[i]) {
            rows[i].zh = map[i];
            rows[i].tr = true;
          } else {
            rows[i].tr = true;
            failed.push(i);
          }
        }
        if (onChunk) onChunk(chunkIdxs, map);
      } catch (e) {
        if (signal && signal.aborted) return;
        for (const i of chunkIdxs) { rows[i].tr = true; failed.push(i); }
      }
      done += chunkIdxs.length;
      if (onProgress) onProgress({ done, total });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return { translated: total - failed.length, failed };
}
