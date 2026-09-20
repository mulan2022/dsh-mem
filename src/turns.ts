/**
 * 原始轮次采集 —— 给 dream 的素材。
 *
 * **为什么需要它**：用户拍板「**不要在对话过程中频繁改动 memory**，这个工具
 * 除非用户要求改或者记忆跟之前的有冲突才能碰，不然都由 dream agent 完成」。
 * 判断推迟到晚上没问题，但**素材不能丢** —— 不然 dream 就没东西可整理。
 *
 * 所以轮次结束时把这一轮的对话原文**追加**下来：
 * **没有 LLM 调用、没有 steer、不做任何判断**。它不是"记忆"，
 * 而是给 dream 读的原始素材，所以放 `raw/` 下 —— 不参与注入、不参与检索排序。
 *
 * 存放：`<vault>/raw/turns/<sessionId>.jsonl`，一行一轮。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { attachmentObjectPath, turnsDir } from './paths.js';
import {
  asEvents,
  attachmentsOfUserMessage,
  isSubagentSession,
  lastTurnStartIndex,
  sessionEventsOf,
  sessionIdOf,
  textOfUserMessage,
  type EventLike,
  type TurnAttachment,
} from './session.js';

export const TURNS_DIR = 'turns';

/** 单个文本字段的字符上限 —— 素材是给人/给模型扫的，不是完整备份。 */
export const TURN_TEXT_MAX = 4000;

/** 一个会话最多保留多少轮原始素材（超出丢最旧的，避免无限增长）。 */
export const TURNS_PER_SESSION_MAX = 500;

export interface TurnRecord {
  /** 会话 id。 */
  session: string;
  /** 轮次号；取不到为 null。 */
  turn: number | null;
  at: string;
  /** 工作目录 —— dream 靠它判断内容该归哪个空间。 */
  cwd: string | null;
  /** 当时判定出来的空间。**只是"当时"，内容归属由 dream 再判**。 */
  space: 'chat' | 'project';
  /** 本轮用户说的话。 */
  user: string;
  /** 本轮助手的文本。 */
  assistant: string;
  /** 本轮调用的工具名（只记名字，改动细节在 raw/timeline/ 里）。 */
  tools: string[];
  /**
   * 用户这一轮**发过来的附件**（图片 / 文件）—— 只记元数据 + 一个指向原件的路径。
   *
   * **字节不在库里**：DSH 的附件库按内容寻址（`<home>/attachments/v1/objects/<sha>`），
   * 这里只留指针。dream 据此判断它重不重要；要留就在实体页的附录里写这条路径，
   * 以后 `mem_search` 命中实体页就能顺着路径去读原件。
   *
   * 没有附件时**不写这个字段**（保持 jsonl 干净）。
   */
  files?: TurnFile[];
}

/** 一条附件：元数据 + 解出来的原件路径（解不出为 null）。 */
export interface TurnFile extends TurnAttachment {
  /** 附件库里的绝对路径；`attachmentId` 认不出时为 null。 */
  path: string | null;
}

function clamp(s: string, max = TURN_TEXT_MAX): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n…（截断，原长 ${t.length} 字符）`;
}

/**
 * 从事件流里收出**本轮**的记录。纯函数，便于测试。
 *
 * @returns 本轮没有任何内容（既没说话也没调工具）时返回 null —— 不写空记录
 */
export function collectTurn(
  events: readonly EventLike[],
  opts: { session: string; cwd: string | null; space: 'chat' | 'project'; at?: Date; home?: string },
): TurnRecord | null {
  const start = lastTurnStartIndex(events);
  const from = start < 0 ? 0 : start;
  const turn = start >= 0 ? (events[start]?.data?.turn ?? null) : null;

  const userParts: string[] = [];
  const assistantParts: string[] = [];
  const tools: string[] = [];
  const files: TurnFile[] = [];
  const seenFile = new Set<string>();

  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (e?.type === 'user/message') {
      // 本插件自己插进去的快照/指令不算"用户说的话"，也不算用户发的附件
      if (e.data?.source?.kind === 'user') {
        userParts.push(textOfUserMessage(e.data));
        for (const a of attachmentsOfUserMessage(e.data)) {
          if (seenFile.has(a.id)) continue; // 同一张图发两次只记一条
          seenFile.add(a.id);
          files.push({
            ...a,
            path: opts.home === undefined ? null : attachmentObjectPath(opts.home, a.id),
          });
        }
      }
      continue;
    }
    if (e?.type === 'assistant/message') {
      for (const b of e.data?.message?.content ?? []) {
        if (b?.type === 'tool-call' && typeof b.name === 'string') tools.push(b.name);
        else if (b?.type === 'text' && typeof b.text === 'string') assistantParts.push(b.text);
      }
    }
  }

  const user = clamp(userParts.join('\n'));
  const assistant = clamp(assistantParts.join('\n'));
  // 只发了一张图、一句话没说 —— 这轮**仍然要记**（附件本身就是这一轮的全部内容）
  if (user === '' && assistant === '' && tools.length === 0 && files.length === 0) return null;

  return {
    session: opts.session,
    turn,
    at: (opts.at ?? new Date()).toISOString(),
    cwd: opts.cwd,
    space: opts.space,
    user,
    assistant,
    tools,
    ...(files.length > 0 ? { files } : {}),
  };
}

/**
 * 一个会话一个文件；会话 id 里可能有奇怪字符，换成安全字符。
 *
 * 对外导出是为了让**历史回填**能定位/清除某个会话的素材文件。
 */
export function turnsFile(home: string, session: string): string {
  return join(turnsDir(home), `${session.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
}

/**
 * 按**轮次号**去重，同一轮只留一份。
 *
 * 为什么需要它（实测踩过）：两条写入路径的 `at` **天然不同** ——
 * 在线采集写的是"写入时刻"，历史回填写的是"日志里 `turn/start` 的时刻"（早几十秒）。
 * 而 `turns` 表的主键是 `(session, at)`，于是**同一轮被当成两个键、双双落库**
 * （实测 `a5ed8d4e`：表里 65 行，真实只有 59 轮，6 个轮次各重复一次）。
 *
 * 保留**更全的那一份**（`ai_compact` 更长）；一样长时保留 `at` 较早的。
 * `turn` 为 null 的行无法判重，原样都留着（它们本来就是"没轮次号"的边角）。
 */
export function dedupeTurns(records: readonly TurnRecord[]): TurnRecord[] {
  const byTurn = new Map<number, TurnRecord>();
  const out: TurnRecord[] = [];
  for (const r of records) {
    if (r.turn === null) {
      out.push(r);
      continue;
    }
    const prev = byTurn.get(r.turn);
    if (prev === undefined) {
      byTurn.set(r.turn, r);
      out.push(r);
      continue;
    }
    // 更全的胜出；一样全就保留早的（不替换）
    if ((r.assistant?.length ?? 0) > (prev.assistant?.length ?? 0)) {
      const at = out.indexOf(prev);
      if (at >= 0) out[at] = r;
      byTurn.set(r.turn, r);
    }
  }
  return out;
}

/** 追加一轮。写入失败返回 false（调用方只记日志，不该打断 agent loop）。 */
export function appendTurn(home: string, rec: TurnRecord): boolean {
  const abs = turnsFile(home, rec.session);
  try {
    // **写入口也判重**：同一轮已经有记录就不再写。
    // 光靠主键 `(session, at)` 挡不住 —— 两条路径的 `at` 不是同一个时刻（见 `dedupeTurns`）。
    if (rec.turn !== null && existsSync(abs)) {
      const seen = readTurnFile(abs).some((t) => t.turn === rec.turn);
      if (seen) return true; // 当成功处理：内容已在库里，调用方不必知道细节
    }
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, `${JSON.stringify(rec)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 读一个素材文件（坏行跳过）。**不做去重** —— 去重是 `dedupeTurns` 的事。 */
export function readTurnFile(abs: string): TurnRecord[] {
  const out: TurnRecord[] = [];
  try {
    for (const line of readFileSync(abs, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as TurnRecord;
        if (typeof o?.session === 'string') out.push(o);
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * 读某个会话的全部原始轮次（坏行跳过），**按时间正序**。
 *
 * 排序放在"读"这一层而不是"写"那一层：历史回填（§5.9）会把**更早**的轮次追加到文件尾部，
 * 于是文件里的物理顺序不再等于时间顺序 —— 而 append-only 这件事本身值得保留。
 * 去重同样放在这一层：文件里可能已经躺着历史遗留的重复行（`dedupeTurns` 里说了原因）。
 */
export function readTurns(home: string, session: string): TurnRecord[] {
  const abs = turnsFile(home, session);
  if (!existsSync(abs)) return [];
  return dedupeTurns(readTurnFile(abs)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * 全部会话的素材文件（绝对路径，按名排序）。
 *
 * 给 `rebuildTurns` 用：`turns` 表是**派生索引**，从这些文件重建 ——
 * 与 `idx_entries` 同一条原则（删掉 index.db 不丢数据）。
 */
export function turnFiles(home: string): string[] {
  const dir = turnsDir(home);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

export interface TurnCaptureInput {
  enabled: boolean;
  /** dsh home —— 素材落在 `<home>/.dsh-mem/raw/turns/`，**中立位置，不按空间分**。 */
  home: string;
}

interface TurnCaptureCtx {
  logger: { info(m: string): void; warn(m: string): void };
  on(event: string, handler: (...args: never[]) => unknown): unknown;
}

/**
 * 装上轮次采集。
 *
 * 与自动写入一样包在 try/catch 里：它跑在 turn 边界上，
 * 抛异常会打断 agent loop。
 */
export function installTurnCapture(ctx: TurnCaptureCtx, input: TurnCaptureInput): () => void {
  if (!input.enabled) {
    ctx.logger.info('dsh-mem: 原始轮次采集已关闭（captureTurns=false）');
    return () => {};
  }

  ctx.on('agent/turn-stopping', ((payload: { agent?: unknown }) => {
    try {
      const agent = payload?.agent;
      if (!agent) return;
      // 第 1 条防御：**dream 自己的子代理会话绝不进素材**。
      // 否则"整理"这件事本身会变成下一轮整理的素材 → 套娃 → 无限膨胀。
      if (isSubagentSession(agent)) return;
      const session = (agent as { session?: unknown }).session;
      const sid = sessionIdOf(agent);
      if (sid === null) return;

      const events = asEvents(sessionEventsOf(session));
      if (events.length === 0) return;

      const header = (agent as { session?: { header?: { cwd?: unknown } } }).session?.header;
      const cwd = typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null;

      // `space` 只记"当时按 cwd 判成了什么" —— 它是**线索不是结论**。
      // 真正的归属由 dream 的两个 agent 按内容判断（项目目录里的闲聊该进聊天区）。
      const space: 'chat' | 'project' = cwd === null ? 'chat' : 'project';
      const rec = collectTurn(events, { session: sid, cwd, space, home: input.home });
      if (rec === null) return;
      if (!appendTurn(input.home, rec)) {
        ctx.logger.warn('dsh-mem: 原始轮次写入失败（不影响本轮）');
      }
    } catch (e) {
      ctx.logger.warn(`dsh-mem: 原始轮次采集失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }) as never);

  ctx.logger.info(`dsh-mem: 原始轮次采集已装上（→ ${TURNS_DIR}/<会话>.jsonl，未归属，给 dream 读）`);
  return () => {
    /* cordis 的 ctx.on 随 effect 域自动注销 */
  };
}
