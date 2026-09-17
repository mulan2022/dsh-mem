/**
 * 项目时间线（P4.5）。
 *
 * ```
 * timeline.md             摘要：一轮一行 + [→id] 指针
 *    │ [→ id]
 * raw/timeline/<id>.md    详情：完整 FileDiff 的改前 / 改后
 * ```
 *
 * 这与「三层置信度」「来源锚点」共用同一个结构（第一层粗粒度 + 指针 → 第二层按需取），
 * 所以指针机制也共用 `anchors.ts` 的同一张 ids 表 —— 只是 `kind='diff'` 时
 * 详情落在 `raw/timeline/<id>.md`（见 `detailPathFor`）。
 *
 * **数据来源不用自己算**：`write` / `edit` 本来就把 `meta.diffs` 附在结果上，
 * 我们只需要在 `tools/result` 上把它抄下来，省掉了"自己 diff / 做文件快照"整块工作。
 *
 * **一层也不主动注入**（v10 起）：项目记忆整体不进上下文，摘要和详情都要 AI
 * 调 `mem_search` / `mem_diff` 自己取。所以下面"一轮一行"的理由**不是**省注入预算，
 * 而是**省 AI 翻找的成本** —— 一百轮里挑一条，摘要比原始 diff 好扫得多。
 * 采集时按会话缓冲、到轮次结束才聚合成一条，就是在维持这个"好扫"的性质。
 */
import { appendAnchor, renderPointerMarker, type Anchor } from './anchors.js';
import { clampText, fenced, insertUnderDate, localDate, localStamp } from './markdown.js';
import { currentTurnOf, isSubagentSession, sessionCwdOf, sessionIdOf } from './session.js';
import { readVaultFile, VAULT, writeVaultFile } from './vault.js';

/** 单侧文本（改前 / 改后）的最大字符数。 */
export const DETAIL_SIDE_MAX = 4000;
/** 详情里最多保留多少处 diff（超出的只计数，不落正文）。 */
export const DETAIL_MAX_HUNKS = 40;

/** 一次改动。与 `dsh-tools` 的 `FileDiff` 同形，但**自己校验**而不是引它的类型。 */
export interface CapturedDiff {
  path: string;
  /** 新增/覆盖时为 null（调用时拿不到原内容）。 */
  oldText: string | null;
  newText: string;
}

/**
 * 会改动文件系统、但**不一定**附带 diff 的工具。
 *
 * 这类工具没带 diff 时退化成记一条"调用记录"（设计文档里的"回退 `exec.arguments`"）。
 * 刻意**不含 shell 类工具**：`bash` 一次调用未必改文件，收进来会让时间线变成
 * 命令流水账，把真正有用的改动淹掉。命令行间接改动的漏采是已知边界（README 有记）。
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'multiedit',
  'multi_edit',
  'apply_patch',
  'patch',
  'move',
  'rename',
  'delete',
  'remove',
  'rm',
  'mkdir',
  'create',
]);

/**
 * 从工具结果里窄化出 diff 列表。
 *
 * 自己校验而不是 `import { diffsFromMeta } from '@deepseek-ai/dsh-tool-fs'`：
 * 那是另一个插件的内部模块，跟着它的重构走不值当。这里要的只是
 * 「有没有 `meta.diffs`、形状对不对」，十几行就够，而且**坏了也只坏自己**。
 */
export function validateDiffs(meta: unknown): CapturedDiff[] {
  if (meta === null || typeof meta !== 'object') return [];
  const list = (meta as { diffs?: unknown }).diffs;
  if (!Array.isArray(list)) return [];
  const out: CapturedDiff[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const o = raw as { path?: unknown; oldText?: unknown; newText?: unknown };
    if (typeof o.path !== 'string' || typeof o.newText !== 'string') continue;
    out.push({
      path: o.path,
      oldText: typeof o.oldText === 'string' ? o.oldText : null,
      newText: o.newText,
    });
  }
  return out;
}

/** 摘要里最多显示几个文件名。 */
export const SUMMARY_MAX_PATHS = 3;
/** 摘要里单个文件名的字符上限。 */
export const SUMMARY_PATH_MAX = 44;

/**
 * 把路径压短，供摘要行使用。
 *
 * 为什么必须压：摘要是**给人/给 AI 扫的一行**，而真机实测第一版直接列了
 * `FileDiff.path`（模型可见的绝对路径），一行就 ~150 字符 ——
 * 一百轮下来那条时间线根本扫不动，等于白记。
 *
 * 两刀：① 在 cwd 之下的转成相对路径；② 还是太长的只留末尾两段。
 */
export function shortPath(p: string, cwd: string | null): string {
  let out = p.replace(/\\/g, '/');
  if (cwd !== null && cwd !== '') {
    const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    const lower = out.toLowerCase();
    const baseLower = base.toLowerCase();
    if (lower === baseLower) out = '.';
    else if (lower.startsWith(`${baseLower}/`)) out = out.slice(base.length + 1);
  }
  if (out.length <= SUMMARY_PATH_MAX) return out;
  const parts = out.split('/').filter((s) => s !== '');
  if (parts.length >= 2) return `…/${parts.slice(-2).join('/')}`;
  return `…${out.slice(-(SUMMARY_PATH_MAX - 1))}`;
}

export function summarizeEntry(
  diffs: readonly CapturedDiff[],
  calls: readonly string[],
  at: Date,
  cwd: string | null = null,
): string {
  const stamp = localStamp(at);
  if (diffs.length > 0) {
    const paths = [...new Set(diffs.map((d) => shortPath(d.path, cwd)))];
    const shown = paths.slice(0, SUMMARY_MAX_PATHS).join('、');
    const more = paths.length > SUMMARY_MAX_PATHS ? ` 等 ${paths.length} 个` : '';
    return `${stamp} · ${paths.length} 个文件 · ${shown}${more}`;
  }
  return `${stamp} · ${[...new Set(calls)].join('、')}（未附 diff）`;
}

/** 详情文件正文。 */
export function renderDetail(
  anchor: Anchor,
  diffs: readonly CapturedDiff[],
  calls: readonly string[],
  cwd: string | null,
): string {
  const head = [
    `# 时间线详情 [→${anchor.id}]`,
    '',
    `- 会话：\`${anchor.session}\``,
    `- 轮次：${anchor.turn}`,
    `- 记录时刻：${anchor.at}`,
  ];
  if (cwd !== null) head.push(`- 工作目录：\`${cwd}\``);
  head.push(
    `- 改动：${diffs.length} 处 diff` +
      (calls.length > 0 ? `，另有 ${calls.length} 次改动类工具调用（未附 diff）` : ''),
    '',
    '> 本文件**不会**被主动注入上下文，只在需要核实时按需读取。',
    '',
  );

  const body: string[] = [];
  if (diffs.length > DETAIL_MAX_HUNKS) {
    body.push(
      `> 本轮的 diff 共 ${diffs.length} 处，超过 ${DETAIL_MAX_HUNKS} 处上限，` +
        `只落前 ${DETAIL_MAX_HUNKS} 处正文。`,
      '',
    );
  }

  const byPath = new Map<string, CapturedDiff[]>();
  for (const d of diffs.slice(0, DETAIL_MAX_HUNKS)) {
    const list = byPath.get(d.path);
    if (list === undefined) byPath.set(d.path, [d]);
    else list.push(d);
  }

  for (const [path, list] of byPath) {
    body.push(`## ${path}`, '');
    list.forEach((d, i) => {
      body.push(`### 改动 ${i + 1}`, '');
      if (d.oldText === null) {
        body.push(
          '**新增或整体覆盖**（调用时拿不到改前内容）',
          '',
          fenced(clampText(d.newText, DETAIL_SIDE_MAX)),
          '',
        );
      } else {
        body.push(
          '**改前**',
          '',
          fenced(clampText(d.oldText, DETAIL_SIDE_MAX)),
          '',
          '**改后**',
          '',
          fenced(clampText(d.newText, DETAIL_SIDE_MAX)),
          '',
        );
      }
    });
  }

  if (calls.length > 0) {
    body.push(
      '## 未附 diff 的改动类调用',
      '',
      ...calls.map((c) => `- \`${c}\``),
      '',
    );
  }

  return [...head, ...body].join('\n');
}

/** timeline.md 缺失时的骨架（正常情况下由 vault 模板种下）。 */
export function seedTimeline(): string {
  return [
    '# 项目时间线',
    '',
    '每条一行摘要 + `[→ id]` 指针；完整改动在 `raw/timeline/`，按需取。',
    '',
    '---',
    '',
  ].join('\n');
}

/** 往摘要文件追加一行。 */
export function appendTimelineEntry(
  vaultDir: string,
  summary: string,
  anchorId: number,
  now: Date = new Date(),
): boolean {
  const cur = readVaultFile(vaultDir, VAULT.timelineSummary) ?? seedTimeline();
  const bullet = `- ${summary} ${renderPointerMarker(anchorId)}`;
  return writeVaultFile(vaultDir, VAULT.timelineSummary, insertUnderDate(cur, localDate(now), bullet));
}

/** 读摘要文件的原始文本（测试与数据面用）。 */
export function readTimeline(vaultDir: string): string | null {
  return readVaultFile(vaultDir, VAULT.timelineSummary);
}

/** 详情文件相对路径。 */
export function detailPath(id: number): string {
  return `${VAULT.timelineDir}/${id}.md`;
}

// ---------------------------------------------------------------------------
// 采集：tools/result 缓冲 → turn-stopping 落盘
// ---------------------------------------------------------------------------

interface TurnBuffer {
  turn: number;
  cwd: string | null;
  diffs: CapturedDiff[];
  calls: string[];
}

/** 单会话缓冲的 diff 上限 —— 失控的循环不该把内存吃光。 */
const BUFFER_MAX_HUNKS = 200;

export interface TimelineInput {
  enabled: boolean;
  /**
   * cwd → 该记到哪个 vault；返回 null 表示**不记**（拿不到工作目录时不猜）。
   *
   * 与 `mem_observe` 的落点规则**故意不同**：那边问的是"这是关于谁的事实"，
   * 答不出来就归到聊天空间；这边问的是"这是哪个目录里的改动"，
   * 而改动一定发生在某个目录里，所以它落到那个目录对应的分区
   * （没有仓库标记时按目录本身分区），而不是被丢进聊天空间。
   */
  resolveVault: (cwd: string | null) => string | null;
}

interface TimelineCtx {
  logger: { info(m: string): void; warn(m: string): void };
  on(event: string, handler: (...args: never[]) => unknown): unknown;
}

/**
 * 装上时间线采集。
 *
 * @returns 注销函数
 */
export function installTimeline(ctx: TimelineCtx, input: TimelineInput): () => void {
  if (!input.enabled) {
    ctx.logger.info('dsh-mem: 时间线采集已关闭（timeline=false）');
    return () => {};
  }

  const buffers = new Map<string, TurnBuffer>();

  const flush = (sid: string, why: string): void => {
    const buf = buffers.get(sid);
    if (buf === undefined) return;
    buffers.delete(sid);
    if (buf.diffs.length === 0 && buf.calls.length === 0) return;

    const vaultDir = input.resolveVault(buf.cwd);
    if (vaultDir === null) {
      ctx.logger.warn(`dsh-mem: 时间线未记录（${why}）：拿不到工作目录，不猜落点`);
      return;
    }
    const now = new Date();
    const anchor = appendAnchor(vaultDir, {
      session: sid,
      turn: buf.turn,
      at: now.toISOString(),
      kind: 'diff',
    });
    if (anchor === null) {
      ctx.logger.warn(`dsh-mem: 时间线未记录（${why}）：锚点写入失败`);
      return;
    }
    if (!writeVaultFile(vaultDir, detailPath(anchor.id), renderDetail(anchor, buf.diffs, buf.calls, buf.cwd))) {
      ctx.logger.warn(`dsh-mem: 时间线详情写入失败（[→${anchor.id}]）`);
      return;
    }
    const summary = summarizeEntry(buf.diffs, buf.calls, now, buf.cwd);
    appendTimelineEntry(vaultDir, summary, anchor.id, now);
    ctx.logger.info(`dsh-mem: 时间线 +1 · ${summary} [→${anchor.id}]`);
  };

  ctx.on('tools/result', ((exec: unknown, result: unknown) => {
    try {
      const e = (exec ?? {}) as { agent?: unknown; name?: unknown };
      const agent = e.agent;
      if (isSubagentSession(agent)) return;
      const sid = sessionIdOf(agent);
      if (sid === null) return;

      const name = typeof e.name === 'string' ? e.name : '';
      const diffs = validateDiffs((result as { meta?: unknown } | null)?.meta);
      if (diffs.length === 0 && !MUTATING_TOOLS.has(name)) return; // 读类工具不进时间线

      const turn = currentTurnOf(agent) ?? 0;
      let buf = buffers.get(sid);
      // 轮次对不上说明上一轮的 turn-stopping 没跑到（中止/崩溃）：
      // 先把旧的落盘再开新的，宁可多写一条，也不把两轮的改动混成一条。
      if (buf !== undefined && buf.turn !== turn) {
        flush(sid, '轮次切换');
        buf = undefined;
      }
      if (buf === undefined) {
        buf = { turn, cwd: sessionCwdOf(agent), diffs: [], calls: [] };
        buffers.set(sid, buf);
      }
      if (diffs.length > 0) {
        for (const d of diffs) {
          if (buf.diffs.length >= BUFFER_MAX_HUNKS) break;
          buf.diffs.push(d);
        }
      } else {
        buf.calls.push(name);
      }
    } catch (err) {
      ctx.logger.warn(`dsh-mem: 时间线采集失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }) as never);

  ctx.on('agent/turn-stopping', ((payload: { agent?: unknown }) => {
    try {
      const sid = sessionIdOf(payload?.agent);
      if (sid !== null) flush(sid, '轮次结束');
    } catch (err) {
      ctx.logger.warn(`dsh-mem: 时间线落盘失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }) as never);

  ctx.logger.info('dsh-mem: 时间线采集已装上（一轮一条摘要 + raw/timeline/ 详情）');
  return () => {
    buffers.clear();
  };
}
