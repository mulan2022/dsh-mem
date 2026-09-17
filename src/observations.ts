/**
 * 待确证观察（设计文档 §3 的中间层）。
 *
 * 三层置信度的中间那层：信号出现了，但还不够强 —— 只说过一次、可能是随口一提、
 * 还可能被后面的对话推翻。这一层的作用是**让弱信号先有个地方待着**，
 * 而不是逼着提炼环节当场做"永久记住 / 彻底丢掉"的二选一。
 *
 * 两条硬规则（都在代码里，不靠约定）：
 *  1. **本文件不参与常驻注入**，也不进 README —— 防止一次性的随口一提污染长期画像。
 *  2. **每条必须带来源锚点**。锚点写不进去，正文就不写 —— 见 anchors.ts 的说明。
 */
import { parseAnchorMarkers, renderAnchorMarker, stripAnchorMarkers } from './anchors.js';
import { insertUnderDate, localDate } from './markdown.js';
import { seedObservations } from './sections.js';
import { readVaultFile, VAULT, writeVaultFile } from './vault.js';

export interface Observation {
  /** 去掉角标的正文。 */
  text: string;
  /** 来源锚点号；解析不出则为 null（历史遗留行）。 */
  anchorId: number | null;
  /** 所在日期分组的 `YYYY-MM-DD`。 */
  date: string;
}

/** 读全部观察（按文件顺序，即写入顺序）。 */
export function readObservations(vaultDir: string): Observation[] {
  const raw = readVaultFile(vaultDir, VAULT.observations);
  if (raw === null) return [];
  const out: Observation[] = [];
  let date = '';
  for (const line of raw.split(/\r?\n/)) {
    const h = /^##\s+(\S+)\s*$/.exec(line);
    if (h !== null) {
      date = h[1];
      continue;
    }
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m === null) continue;
    const body = m[1].trim();
    if (!body) continue;
    const ids = parseAnchorMarkers(body);
    out.push({
      text: stripAnchorMarkers(body),
      anchorId: ids.length > 0 ? ids[ids.length - 1] : null,
      date,
    });
  }
  return out;
}

/** 判重用：忽略角标与首尾空白。 */
function normalize(text: string): string {
  return stripAnchorMarkers(text).replace(/\s+/g, ' ').trim();
}

/**
 * 写入前的纯读校验。
 *
 * 存在的理由不是为了省事，而是为了**别浪费锚点号**：
 * 锚点必须在正文之前写（正文要引用它的号），所以如果正文注定会被拒
 * （重复 / 空），那就该在分配锚点之前拒掉。
 */
export function precheckObservation(vaultDir: string, text: string): 'empty' | 'duplicate' | null {
  const body = normalize(text);
  if (!body) return 'empty';
  if (readObservations(vaultDir).some((o) => normalize(o.text) === body)) return 'duplicate';
  return null;
}

export interface AppendResult {
  ok: boolean;
  reason?: 'empty' | 'duplicate' | 'no-anchor' | 'write-failed';
  /** 写入后的总条数（失败时为现有条数）。 */
  count: number;
  anchorId?: number;
}

/**
 * 追加一条观察。
 *
 * @param anchorId 来源锚点号。**没有锚点直接拒绝** —— 断链的记忆不如不记。
 */
export function appendObservation(
  vaultDir: string,
  text: string,
  anchorId: number | null,
  now: Date = new Date(),
): AppendResult {
  const existing = readObservations(vaultDir);
  const body = normalize(text);
  if (!body) return { ok: false, reason: 'empty', count: existing.length };

  // 调用方必须**先写锚点再写正文**（正文要引用锚点分配的号）。
  // 顺序反过来的话，写锚点失败就会留下一条指向不存在锚点的正文 —— 那正是断链。
  // 反过来（锚点写了、正文没写）只浪费一个号，不影响任何引用。
  if (anchorId === null || !Number.isFinite(anchorId)) {
    return { ok: false, reason: 'no-anchor', count: existing.length };
  }

  if (existing.some((o) => normalize(o.text) === body)) {
    return { ok: false, reason: 'duplicate', count: existing.length };
  }

  const current = readVaultFile(vaultDir, VAULT.observations) ?? seedObservations();
  const bullet = `- ${body} ${renderAnchorMarker(anchorId)}`;
  const next = insertUnderDate(current, localDate(now), bullet);
  if (!writeVaultFile(vaultDir, VAULT.observations, next)) {
    return { ok: false, reason: 'write-failed', count: existing.length };
  }
  return { ok: true, count: existing.length + 1, anchorId };
}
