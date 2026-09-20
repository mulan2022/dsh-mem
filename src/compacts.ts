/**
 * 增量素材：每个会话的**对话摘要** + 下一次只喂**新增轮次**的窗口。
 *
 * 为什么要有这个：dream 原来是"挑中有新素材的会话 → 整场原文重读一遍"。
 * 一个 50 轮的会话第 41 轮才有新内容，也要把 1–50 轮全读一遍，长会话一场就是
 * 十几万字、还乘两个 agent。所以照 Claude Code 的 compact 那套做增量：
 *
 *   这次 dream：读完这一场 → **顺便留一份摘要**（附上"覆盖到第几轮"）
 *   下次 dream：喂「上次的摘要 + 第 N 轮之后的新增轮次」，不再重读全部
 *
 * 两条纪律：
 *  - **覆盖轮次由宿主盖章，不由 agent 报**。agent 只出摘要文本 —— 让它自己报轮号
 *    是白送一个失败模式（报错一次就会把窗口算歪、要么重复整理要么漏掉一个区间）。
 *  - **摘要按「会话 × 空间」各一份**。两个 agent 视角不同（一个管人、一个管项目），
 *    合成一份既有"谁写"的歧义，也会把两边的重点平均掉。
 *
 * 失败也不致命：摘要是**加速器不是事实源**。它丢了/坏了，下一晚退回"整场重读"，
 * 只是贵一点，不会漏东西。所以读取一律容错，认不出就当没有。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { memRoot } from './paths.js';
import { readTurns, type TurnRecord } from './turns.js';

/** 摘要长度上限 —— 超过就失去"省 token"的意义了。 */
export const COMPACT_MAX_CHARS = 1500;

export type CompactKind = 'chat' | 'project';

export interface SessionCompact {
  /** 这份摘要覆盖到第几轮（含）。下一次从这里往后喂。 */
  coveredThroughTurn: number;
  /** 写这份摘要的时刻（ISO）。 */
  at: string;
  /** 摘要正文。 */
  text: string;
}

function safeSession(session: string): string {
  return session.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** `raw/compacts/<会话>.<空间>.md`。 */
export function compactPath(home: string, session: string, kind: CompactKind): string {
  return join(memRoot(home), 'raw', 'compacts', `${safeSession(session)}.${kind}.md`);
}

/** 增量窗口文件：`raw/window/<会话>.<空间>.jsonl`（**派生、每次覆盖**，不是事实源）。 */
export function windowPath(home: string, session: string, kind: CompactKind): string {
  return join(memRoot(home), 'raw', 'window', `${safeSession(session)}.${kind}.jsonl`);
}

/**
 * 读上一条摘要。**任何异常都当"没有"**（格式不符、数字不对、文件不在）——
 * 摘要是加速器，读不到就退回整场重读，不该因此让 dream 失败。
 */
export function readCompact(home: string, session: string, kind: CompactKind): SessionCompact | null {
  try {
    const text = readFileSync(compactPath(home, session, kind), 'utf8');
    const m = /^<!--\s*覆盖到第\s*(\d+)\s*轮\s*·\s*([^>]*?)\s*-->/.exec(text);
    if (m === null) return null;
    const covered = Number(m[1]);
    if (!Number.isFinite(covered)) return null;
    const body = text.slice(m[0].length).trim();
    if (body === '') return null;
    return { coveredThroughTurn: covered, at: m[2] ?? '', text: body };
  } catch {
    return null;
  }
}

/** 写一条摘要（覆盖）。`coveredThroughTurn` 由宿主盖章。 */
export function writeCompact(
  home: string,
  session: string,
  kind: CompactKind,
  compact: SessionCompact,
): boolean {
  const text = compact.text.trim();
  if (text === '') return false;
  const body = text.length > COMPACT_MAX_CHARS ? `${text.slice(0, COMPACT_MAX_CHARS)}…` : text;
  const file = compactPath(home, session, kind);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `<!-- 覆盖到第 ${compact.coveredThroughTurn} 轮 · ${compact.at} -->\n\n${body}\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

export interface TurnWindow {
  path: string;
  /** 窗口里有多少轮（0 表示没有新增）。 */
  count: number;
  /** 窗口里最大的轮次号。 */
  throughTurn: number;
}

/**
 * 把 `afterTurn` 之后的轮次写成一个增量窗口文件，供下一次 dream 只读这一小段。
 *
 * @returns 没有新增轮次时返回 null（调用方据此仍旧喂全文）
 */
export function writeTurnWindow(
  home: string,
  session: string,
  kind: CompactKind,
  afterTurn: number,
): TurnWindow | null {
  const fresh = readTurns(home, session).filter((t) => typeof t.turn === 'number' && t.turn > afterTurn);
  if (fresh.length === 0) return null;
  const file = windowPath(home, session, kind);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${fresh.map((t) => JSON.stringify(t)).join('\n')}\n`, 'utf8');
  } catch {
    return null;
  }
  const maxTurn = fresh.reduce((n, t) => Math.max(n, typeof t.turn === 'number' ? t.turn : 0), 0);
  return { path: file, count: fresh.length, throughTurn: maxTurn };
}

/** 清掉某个会话的窗口文件（整理完就没用了，避免 raw/ 里越堆越多）。 */
export function clearTurnWindow(home: string, session: string, kind: CompactKind): void {
  try {
    const file = windowPath(home, session, kind);
    if (existsSync(file)) writeFileSync(file, '', 'utf8');
  } catch {
    /* 清不掉不影响正确性 */
  }
}

/** 某个会话当前的最大轮次（宿主盖章用）。 */
export function maxTurnOf(home: string, session: string): number {
  const turns: readonly TurnRecord[] = readTurns(home, session);
  return turns.reduce((n, t) => Math.max(n, typeof t.turn === 'number' ? t.turn : 0), 0);
}

/** `raw/compacts/` 下现有的摘要（排障用）。 */
export function listCompacts(home: string): string[] {
  try {
    return readdirSync(join(memRoot(home), 'raw', 'compacts'));
  } catch {
    return [];
  }
}
