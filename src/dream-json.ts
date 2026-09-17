/**
 * dream 阶段 A/B 的**纯逻辑**：提示词渲染、模型输出的解析与校验。
 *
 * 刻意与"派 agent"那层分开：派 agent 要碰 `ctx.agents` / `ctx.subagents`，
 * 只能真机验；而这一层（拼提示词、从一堆解释性文字里抠出 JSON、按 schema 校验、
 * 核对锚点、按 space 归拢去重）**是纯函数，能被完整单测** ——
 * 而"模型吐了个坏 JSON"恰恰是这类流程最常挂的地方。
 *
 * 一句话：**把能测的都拉到能测的这一边来。**
 */
import type { Anchor } from './anchors.js';

/** 模板变量替换：`{{key}}` → 值。认不出的占位符原样留着（好过静默消失）。 */
export function renderTemplate(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}

/**
 * 从模型输出里抠出 JSON 对象。
 *
 * 真实输出经常长这样：正文里带一段解释 + ```json 围栏 + 结尾再来一句总结。
 * 所以**不能直接 JSON.parse**。策略：先剥围栏，再找第一个 `{` 与它配对的 `}`，
 * 只解析那一段。
 *
 * @returns 解析出的对象，或 null
 */
export function extractJson(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.trim() === '') return null;

  // ① 优先取围栏里的内容（最可能是模型"正式"给出的那份）
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates: string[] = [];
  if (fenced !== null) candidates.push(fenced[1]);

  // ② 再退到"扫描每一个 `{`，找它配对的 `}`"
  //     **要遍历所有起点**：模型常在 JSON 前面先写个 `{占位符}` 之类的东西，
  //     只看第一个花括号就会把那一段拿去 parse、失败后就放弃（真踩过）。
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') inStr = !inStr;
      else if (!inStr && c === '{') depth += 1;
      else if (!inStr && c === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }

  for (const c of candidates) {
    try {
      const o = JSON.parse(c) as unknown;
      if (o !== null && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

export interface ExtractObservation {
  text: string;
  anchor: number | null;
  kind: string;
  confidence: string;
  alreadyKnown: boolean;
}

export interface ExtractResult {
  session: string;
  space: 'chat' | 'project';
  project: string | null;
  observations: ExtractObservation[];
  /** 该 agent 主动跳过的东西（带理由）—— 用来区分"真没东西"和"偷懒"。 */
  skipped: Array<{ turn?: number; why: string }>;
  /** 原始 JSON，交给阶段 B 自己去看它关心的其它字段。 */
  raw: Record<string, unknown>;
}

export interface ValidateReport {
  ok: boolean;
  errors: string[];
  result: ExtractResult | null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 校验并归一化阶段 A 的一份输出。
 *
 * **宽容但明确**：字段缺失就补默认值（模型漏字段比乱填字段常见），
 * 但几件致命的事必须报错：`space` 不合法、`observations` 不是数组。
 */
export function validateExtract(raw: Record<string, unknown> | null, fallbackSession: string): ValidateReport {
  const errors: string[] = [];
  if (raw === null) return { ok: false, errors: ['没有解析出 JSON'], result: null };

  const space = raw.space === 'project' ? 'project' : raw.space === 'chat' ? 'chat' : null;
  if (space === null) errors.push(`space 必须是 chat 或 project，收到 ${JSON.stringify(raw.space)}`);

  const rawObs = raw.observations;
  if (rawObs !== undefined && !Array.isArray(rawObs)) errors.push('observations 必须是数组');

  if (errors.length > 0) return { ok: false, errors, result: null };

  const observations: ExtractObservation[] = (Array.isArray(rawObs) ? rawObs : [])
    .filter((o): o is Record<string, unknown> => o !== null && typeof o === 'object')
    .map((o) => ({
      text: asString(o.text).trim(),
      anchor: typeof o.anchor === 'number' && Number.isFinite(o.anchor) ? o.anchor : null,
      kind: asString(o.kind) || 'fact',
      confidence: ['low', 'medium', 'high'].includes(asString(o.confidence)) ? asString(o.confidence) : 'low',
      alreadyKnown: o.alreadyKnown === true,
    }))
    .filter((o) => o.text !== ''); // 空文本的观察直接丢掉

  const skipped = (Array.isArray(raw.skipped) ? raw.skipped : [])
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
    .map((s) => ({
      turn: typeof s.turn === 'number' ? s.turn : undefined,
      why: asString(s.why) || '（没写理由）',
    }));

  return {
    ok: true,
    errors: [],
    result: {
      session: asString(raw.session) || fallbackSession,
      space: space as 'chat' | 'project',
      project: typeof raw.project === 'string' ? raw.project : null,
      observations,
      skipped,
      raw,
    },
  };
}

/**
 * 核对锚点：哪些 `anchor` 在 vault 里**并不存在**。
 *
 * 这是设计里那条硬规矩的落点 ——「写进 sections/entities 的断言必须有来源锚点」。
 * 模型编一个号出来是很容易的，所以**必须由宿主验**，不能信它。
 */
export function missingAnchors(result: ExtractResult, anchors: readonly Anchor[]): number[] {
  const known = new Set(anchors.map((a) => a.id));
  const missing = new Set<number>();
  for (const o of result.observations) {
    if (o.anchor !== null && !known.has(o.anchor)) missing.add(o.anchor);
  }
  return [...missing].sort((a, b) => a - b);
}

/** 按 `space` 归拢多份 extract（阶段 B 的输入）。 */
export function groupBySpace(results: readonly ExtractResult[]): {
  chat: ExtractResult[];
  project: ExtractResult[];
} {
  return {
    chat: results.filter((r) => r.space === 'chat'),
    project: results.filter((r) => r.space === 'project'),
  };
}

/**
 * 跨会话去重：同一件事被两个会话各自报了一次 → 合成一条并**升级信度**。
 *
 * 归一化只做"去空白 + 转小写"，不做语义判断 —— 那是阶段 B 那个 agent 的活。
 * 这里只负责"明显重复的不要重复计数"。
 */
export function dedupeObservations(results: readonly ExtractResult[]): {
  text: string;
  kind: string;
  confidence: string;
  seenIn: number;
  anchors: number[];
}[] {
  const byKey = new Map<string, { text: string; kind: string; confidence: string; seenIn: number; anchors: number[] }>();
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
  for (const r of results) {
    for (const o of r.observations) {
      const key = o.text.replace(/\s+/g, '').toLowerCase();
      if (key === '') continue;
      const hit = byKey.get(key);
      if (hit === undefined) {
        byKey.set(key, {
          text: o.text,
          kind: o.kind,
          confidence: o.confidence,
          seenIn: 1,
          anchors: o.anchor !== null ? [o.anchor] : [],
        });
        continue;
      }
      hit.seenIn += 1;
      if ((rank[o.confidence] ?? 0) > (rank[hit.confidence] ?? 0)) hit.confidence = o.confidence;
      if (o.anchor !== null && !hit.anchors.includes(o.anchor)) hit.anchors.push(o.anchor);
    }
  }
  return [...byKey.values()];
}
