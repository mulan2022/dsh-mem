/**
 * 跨项目检索（P4.6）。
 *
 * 设计文档 §4.2.4：别的项目分区**不主动注入**，但它们必须**搜得到** ——
 * 入口一给轻量指针，入口二才是真取用。所以这里只做检索，不碰注入。
 *
 * 分词：**CJK bigram + Unicode 整词**（[实测] 这是中文检索的正解，绕开 FTS5
 * 把一整串中文当成一个 token 的坑）。切词逻辑很短，自己写比引分词库划算，
 * 也不会因为依赖的词典版本变化而让检索结果漂移。
 *
 * 打分是**第一版够用**的量级，不是调过的：等 P-1 的检索测评集做出来，
 * 该调的权重拿数据说话，而不是凭感觉先调一轮。
 */
import type { IndexedEntry } from './index-db.js';

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const WORD_RE = /[a-z0-9_]/;

/**
 * 切词：ASCII 连字成整词，CJK 连字切成 bigram（单字则保留单字）。
 * 中文没有词边界，bigram 是不依赖词典的近似分词。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  let buf = '';
  let cjk = false;

  const flush = (): void => {
    if (buf === '') return;
    if (cjk) {
      if (buf.length === 1) out.push(buf);
      else for (let i = 0; i + 1 < buf.length; i++) out.push(buf.slice(i, i + 2));
    } else {
      out.push(buf);
    }
    buf = '';
  };

  for (const ch of lower) {
    if (CJK_RE.test(ch)) {
      if (!cjk) {
        flush();
        cjk = true;
      }
      buf += ch;
    } else if (WORD_RE.test(ch)) {
      if (cjk) {
        flush();
        cjk = false;
      }
      buf += ch;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

function dedupe(tokens: readonly string[]): string[] {
  return [...new Set(tokens)];
}

/** 命中位置附近的一段摘要。 */
export function snippetOf(body: string, queryTokens: readonly string[], width = 60): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of queryTokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, width * 2);
  const start = Math.max(0, at - width);
  const end = Math.min(flat.length, at + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export interface SearchHit {
  entry: IndexedEntry;
  score: number;
  snippet: string;
}

export interface SearchOptions {
  k?: number;
  /** 摘要宽度（字符）。 */
  width?: number;
}

/**
 * 在给定条目集合里检索。
 *
 * 打分 = 词频饱和项 × 查询覆盖率 × 长度惩罚（+ 名字命中加成）：
 *  - **词频饱和**（`1 + log(tf)`）：同一个词出现 50 次不该比出现 5 次强 10 倍；
 *  - **覆盖率**：命中的查询词占多大比例 —— 只命中一个常见词的超长文件不该排第一；
 *  - **长度惩罚**：长文档天然更容易撞上查询词；
 *  - **名字加成**：实体名/文件名命中通常就是正解（P3 的结论：名字命中即精确匹配）。
 */
export function searchEntries(
  entries: readonly IndexedEntry[],
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const qTokens = dedupe(tokenize(query));
  if (qTokens.length === 0) return [];
  const k = opts.k ?? 10;
  const width = opts.width ?? 60;

  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const name = entry.name ?? '';
    const text = `${name} ${entry.rel}\n${entry.body}`;
    const tokens = tokenize(text);
    if (tokens.length === 0) continue;

    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    const nameTokens = new Set(tokenize(name));

    let raw = 0;
    let matched = 0;
    let nameHits = 0;
    for (const q of qTokens) {
      const c = counts.get(q);
      if (c === undefined) continue;
      matched++;
      raw += 1 + Math.log(c);
      if (nameTokens.has(q)) nameHits++;
    }
    if (matched === 0) continue;

    const coverage = matched / qTokens.length;
    const lengthPenalty = 1 / (1 + Math.log(1 + tokens.length));
    const score = raw * coverage * lengthPenalty + nameHits * 0.5;
    hits.push({ entry, score, snippet: snippetOf(entry.body, qTokens, width) });
  }

  hits.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  return hits.slice(0, k);
}

/** 条目的归属标签（跨项目检索必须能看出结果来自哪个空间/分区）。 */
export function labelOf(entry: IndexedEntry): string {
  if (entry.space === 'chat') return '聊天空间';
  if (entry.space === 'shared') return '全局层';
  if (entry.space === 'project') return entry.project === null || entry.project === '_shared' ? '项目·跨项目层' : `项目·${entry.project}`;
  return entry.space;
}

/** 把命中渲染成给模型看的紧凑列表。 */
export function renderHits(hits: readonly SearchHit[]): string {
  if (hits.length === 0) return '没有搜到相关记忆。';
  return hits
    .map((h, i) => {
      const e = h.entry;
      const kind = e.kind === 'entity' ? `实体/${e.name ?? ''}` : e.kind;
      return `${i + 1}. [${labelOf(e)}] ${kind} · ${e.rel}（${h.score.toFixed(2)}）\n   ${h.snippet}`;
    })
    .join('\n');
}
