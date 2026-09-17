/**
 * 从 DSH 官方会话日志取原文（设计文档 §5.9）。
 *
 * **归档不在我们这儿。** 完整原文（含工具结果）在
 * `<dsh home>/sessions/<工作区>/<会话>/session.v3.jsonl.zstd`，由 DSH 保证只增不减
 * （`dsh-session` 是 append-only；持久化层明写「Nothing deletes session files」）。
 * 我们只存两样：`raw/turns/`（在线采集，自己的稳定格式）与 `turns` 表（派生索引）。
 * 所以需要一个**按 `(session, turn)` 回到日志取原文**的入口 —— 就是本文件。
 *
 * 它同时是两条链路的落点：
 *  - §5.8 RCC 补丁链路第 4 步「取该场全部 user_text」；
 *  - §5.5 「锚点重访」（拿锚点重建当时的上下文）。
 *
 * **★ 日志是多帧 zstd**：每个事件块一帧，而 `zstdDecompressSync` **只解第一帧** ——
 * 实测 18399 bytes 的日志只解出 200 字符。所以必须逐帧解，见 `decodeZstdFrames`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { historyStatePath, sessionsRootDir } from './paths.js';
import {
  appendTurn,
  collectTurn,
  readTurns,
  turnsFile,
  type TurnRecord,
} from './turns.js';

/** zstd 帧的 magic number（`0x28 0xB5 0x2F 0xFD`）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 官方日志的文件名，按优先级。当前代际是 v3；旧的没迁移过的才是前者。 */
const LOG_FILES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd'] as const;

/** 日志里一行事件（只声明我们读的字段，别的原样留着）。 */
interface LogEvent {
  type?: string;
  seq?: number;
  time?: number;
  /**
   * ★ `session` 事件把头信息放在**顶层**，没有 `data` 壳
   * （实测：`{"type":"session","version":3,"id":"session-…","cwd":"D:\\…","agentPreset":"standard"}`）。
   * 别的读法都会静默拿到 `undefined` —— 而目录名又常常恰好等于会话 id，兜底值会把错误伪装成正确。
   */
  id?: string;
  cwd?: string;
  version?: number;
  createdAt?: number;
  agentPreset?: string;
  /** `> 0` = 子代理会话（dream 派出去的）。实测确实在**顶层**。 */
  delegationDepth?: number;
  data?: {
    turn?: number;
    cwd?: string;
    id?: string;
    agentPreset?: string;
    /** 兜底位置：实测在顶层，这里也接受一份（宽容读取）。 */
    delegationDepth?: number;
    content?: Array<{ type?: string; text?: string; name?: string }>;
    source?: { kind?: string };
    message?: { content?: Array<{ type?: string; text?: string; name?: string }> };
  };
}

/**
 * 解一个**多帧** zstd 文件。
 *
 * DSH 的会话日志按事件块分帧写，而 Node 的 `zstdDecompressSync` 只解**第一帧**
 * —— 直接用它只会拿到开头一小段（实测 18399 bytes → 200 字符），而且**不报错**。
 * 所以这里扫 magic、从每个偏移各解一次再拼接；假 magic 会解失败，跳过即可。
 *
 * 文件没压缩（没有 magic）时按纯文本返回，免得调用方还要判断。
 */
export function decodeZstdFrames(buf: Buffer): string {
  const first = buf.indexOf(ZSTD_MAGIC);
  if (first < 0) return buf.toString('utf8');
  const parts: string[] = [];
  for (let at = first; at >= 0; at = buf.indexOf(ZSTD_MAGIC, at + 4)) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(at)).toString('utf8'));
    } catch {
      /* 假 magic，或末尾被截断的帧 */
    }
  }
  return parts.join('');
}

/** 一个官方会话日志。 */
export interface SessionLog {
  /** 会话 id（**取自日志内 `session` 事件**，不是目录名 —— 旧布局目录名不带 `session-` 前缀）。 */
  session: string;
  path: string;
  size: number;
  cwd: string | null;
  createdAt: number | null;
  /**
   * `session` 事件里的 `delegationDepth`：**> 0 就是子代理会话**。
   *
   * 它必须被挡在素材之外 —— 否则 dream 派出去的子 agent 的提示词会被当成"用户发言"
   * 回填进来，RCC 就等于在给模型看**它自己的整理指令**（自噬）。
   */
  delegationDepth: number;
}

/** 读日志的事件流（坏行跳过）。文件不存在返回空数组。 */
export function readSessionEvents(path: string): LogEvent[] {
  let text: string;
  try {
    text = decodeZstdFrames(readFileSync(path));
  } catch {
    return [];
  }
  const out: LogEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as LogEvent;
      if (o !== null && typeof o === 'object') out.push(o);
    } catch {
      /* 坏行跳过 —— 一行损坏不该让整个会话读不出来 */
    }
  }
  return out;
}

/**
 * 列出全部官方会话日志。
 *
 * **刻意不去反推"工作区目录名 → 路径"的编码**（`--D-demo-MemoryChat--` 那种）：
 * 那是个我们会猜错的私有规则。改成从日志目录正着扫，扫到什么就是什么。
 */
export function listSessionLogs(home: string): SessionLog[] {
  const root = sessionsRootDir(home);
  let workspaces: string[];
  try {
    workspaces = readdirSync(root);
  } catch {
    return []; // 没装过 dsh / 没跑过会话
  }
  const out: SessionLog[] = [];
  for (const ws of workspaces) {
    const wsDir = join(root, ws);
    let sessions: string[];
    try {
      sessions = readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const dir of sessions) {
      for (const file of LOG_FILES) {
        const path = join(wsDir, dir, file);
        if (!existsSync(path)) continue;
        const events = readSessionEvents(path);
        const head = events.find((e) => e.type === 'session');
        let size = 0;
        try {
          size = statSync(path).size;
        } catch {
          /* 读不到大小就算了 */
        }
        out.push({
          session: head?.id ?? dir,
          path,
          size,
          cwd: typeof head?.cwd === 'string' ? head.cwd : null,
          createdAt:
            typeof head?.createdAt === 'number'
              ? head.createdAt
              : typeof head?.time === 'number'
                ? head.time
                : null,
          delegationDepth:
            typeof head?.delegationDepth === 'number'
              ? head.delegationDepth
              : typeof head?.data?.delegationDepth === 'number'
                ? head.data.delegationDepth
                : 0,
        });
        break; // 一个会话只认一个文件
      }
    }
  }
  return out;
}

/** 按会话 id 找它的官方日志；找不到返回 null。 */
export function findSessionLog(home: string, session: string): SessionLog | null {
  return listSessionLogs(home).find((l) => l.session === session) ?? null;
}

/**
 * 把事件流按轮切开。
 *
 * 每个切片从**它自己的 `turn/start`** 开始 —— 这样 `collectTurn` 切片后仍能认出轮次号，
 * 而且轮次之间的事件不会串味。第一个 `turn/start` 之前的事件（`session` / `permission/preset`
 * / `sandbox/mode` …）不属于任何一轮，丢掉。
 */
export function turnSlices(events: readonly LogEvent[]): LogEvent[][] {
  const out: LogEvent[][] = [];
  let cur: LogEvent[] | null = null;
  for (const e of events) {
    if (e.type === 'turn/start') {
      if (cur !== null) out.push(cur);
      cur = [e];
      continue;
    }
    if (cur !== null) cur.push(e);
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** 一轮里用户**说**的话（只认 `source.kind === 'user'` 的真实用户消息）。 */
function userTextOf(events: readonly LogEvent[]): string {
  const parts: string[] = [];
  for (const e of events) {
    if (e.type !== 'user/message' || e.data?.source?.kind !== 'user') continue;
    for (const b of e.data?.content ?? []) {
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n').trim();
}

/** 一轮里助手说的话与调过的工具（`reasoning` 块不算"说的话"）。 */
function assistantOf(events: readonly LogEvent[]): { text: string; tools: string[] } {
  const parts: string[] = [];
  const tools: string[] = [];
  for (const e of events) {
    if (e.type !== 'assistant/message') continue;
    for (const b of e.data?.message?.content ?? []) {
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b?.type === 'tool-call' && typeof b.name === 'string') tools.push(b.name);
    }
  }
  return { text: parts.join('\n').trim(), tools };
}

/** 取回的结果：**完整原文**，不做 `TURN_TEXT_MAX` 截断（这是"取原文"的意义所在）。 */
export interface RecallResult {
  ok: boolean;
  reason?: string;
  session?: string;
  turn?: number;
  at?: string;
  cwd?: string | null;
  user?: string;
  assistant?: string;
  tools?: string[];
}

/**
 * 按 `(session, turn)` 回官方日志取那一轮的**完整原文**。
 *
 * 这是 §5.9 的"按指针取回"。**不做截断** —— `raw/turns` 那边每轮截到 4000 字是为了省空间，
 * 而这里存在的理由恰恰是"要看全"。
 */
export function recallTurn(home: string, session: string, turn: number): RecallResult {
  const log = findSessionLog(home, session);
  if (log === null) {
    return { ok: false, reason: `官方日志里没有会话 \`${session}\`（可能删过，或不是本机跑过的会话）。` };
  }
  const slices = turnSlices(readSessionEvents(log.path));
  const slice = slices.find((s) => s[0]?.data?.turn === turn);
  if (slice === undefined) {
    const known = slices.map((s) => s[0]?.data?.turn).filter((t): t is number => typeof t === 'number');
    return {
      ok: false,
      reason: `日志里没有第 ${turn} 轮。现有：${known.join('、') || '（空）'}`,
    };
  }
  const { text: assistant, tools } = assistantOf(slice);
  const start = slice[0];
  return {
    ok: true,
    session,
    turn,
    at: typeof start?.time === 'number' ? new Date(start.time).toISOString() : '',
    cwd: log.cwd,
    user: userTextOf(slice),
    assistant,
    tools,
  };
}

/** 历史回填的账本：`<会话 id> → 上次处理时日志的字节数`。 */
export type HistoryState = Record<string, number>;

function readHistoryState(home: string): HistoryState {
  try {
    const parsed = JSON.parse(readFileSync(historyStatePath(home), 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: HistoryState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeHistoryState(home: string, state: HistoryState): void {
  const path = historyStatePath(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 1)}\n`, 'utf8');
  } catch {
    /* 账本写不进去只是下次重跑，不该打断启动 */
  }
}

export interface BackfillReport {
  /** 扫到的官方日志数。 */
  scanned: number;
  /** 其中因为"日志没变过"跳过的。 */
  skipped: number;
  /** 真正补进 `raw/turns/` 的轮次数。 */
  added: number;
  /** 有动静的会话数。 */
  touched: number;
  /** 因为"是子代理会话"而**清掉**的素材文件数（见下）。 */
  pruned: number;
  failed: string[];
}

/**
 * 从官方日志**回填** `raw/turns/`。
 *
 * 为什么需要它：`raw/turns` 只在插件在线期间采集（实测 5/28），历史会话一条都没有 ——
 * 而 RCC 要的是"最近 40 场"，13 个会话的空洞会让它名不副实。
 *
 * 两条设计取舍：
 *  - **只补缺的轮次**（按 `turn` 去重），已有的一律不动 —— 在线采的那份带着**当时的 cwd/space**，
 *    比从日志反推更可信，不该被覆盖。
 *  - **日志字节数没变就跳过**（账本记在 `raw/history-state.json`）—— 否则每次启动都要
 *    解压几十 MB。日志是 append-only，所以"大小没变"就等于"没有新轮次"。
 */
export function backfillRawTurns(home: string): BackfillReport {
  const report: BackfillReport = { scanned: 0, skipped: 0, added: 0, touched: 0, pruned: 0, failed: [] };
  const state = readHistoryState(home);
  let logs: SessionLog[];
  try {
    logs = listSessionLogs(home);
  } catch (e) {
    report.failed.push(`枚举会话日志失败：${e instanceof Error ? e.message : String(e)}`);
    return report;
  }

  for (const log of logs) {
    report.scanned++;
    // ★ dream 自己的子代理会话**绝不进素材**（v11 的防御）。
    //   在线采集那边有 `isSubagentSession` 挡着，**回填这条路也必须挡** ——
    //   否则 dream 派出去的 agent 的提示词会被当成"用户发言"回填进来，
    //   RCC 就等于在给模型看**它自己的整理指令**（自噬）。
    //   实测踩过：7 个 `delegationDepth=1` 的会话各带 1 轮 dream 提示词进了 turns 表。
    //   这里顺手把**已经脏了的**素材文件清掉（自愈），光挡新的不够。
    if (log.delegationDepth > 0) {
      const stale = turnsFile(home, log.session);
      if (existsSync(stale)) {
        try {
          rmSync(stale);
          report.pruned++;
        } catch (e) {
          report.failed.push(`${log.session}：清理子代理素材失败（${e instanceof Error ? e.message : String(e)}）`);
        }
      }
      state[log.session] = log.size;
      continue;
    }
    if (state[log.session] === log.size) {
      report.skipped++;
      continue;
    }
    try {
      const have = new Set(readTurns(home, log.session).map((t) => t.turn));
      const space: TurnRecord['space'] = log.cwd === null ? 'chat' : 'project';
      let added = 0;
      for (const slice of turnSlices(readSessionEvents(log.path))) {
        const startTime = slice[0]?.time;
        const rec = collectTurn(slice as never, {
          session: log.session,
          cwd: log.cwd,
          space,
          at: typeof startTime === 'number' ? new Date(startTime) : new Date(),
        });
        if (rec === null) continue;
        if (rec.turn !== null && have.has(rec.turn)) continue; // 只补缺
        if (appendTurn(home, rec)) added++;
      }
      state[log.session] = log.size;
      if (added > 0) {
        report.added += added;
        report.touched++;
      }
    } catch (e) {
      report.failed.push(`${log.session}：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  writeHistoryState(home, state);
  return report;
}
