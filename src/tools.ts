/**
 * 模型工具面。
 *
 * ① 常驻记忆（A 层）：**唯一的写入路径**。
 *    为什么只有工具没有 HTTP 写接口：常驻记忆由**用户明确命令**驱动（"记住 X"），
 *    不由人手动编辑文件，也不由 AI 自作主张添加。把写入口收敛成工具、删掉 HTTP 写路由，
 *    这条约束就由**结构**保证，而不是靠"约定别乱写"（同"隔离靠硬代码"的原则）。
 *
 * ② 待确证观察（B 层，P4）：耐久事实的暂存区。与 ① 的关键差别是
 *    **它不常驻注入**，所以往里写不需要"用户明说"这个前提 —— 但代价是
 *    每条必须带来源锚点，且可能永远不被晋升。
 *
 * ③ 实体查阅（P3）：vault 是文档而非原子事实，开局只给**名字目录**，
 *    正文按需翻 —— 照搬"文献综述看到引用再去翻原文"。
 *
 * 工具名常量在 `tool-names.ts`（那里说明了为什么要单独放）。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { join } from 'node:path';

import { appendAnchor, detailPathFor, findAnchor, readAnchors } from './anchors.js';
import { expandOneHop, renderEntity, type EntityIndex } from './entities.js';
import { addInstruction, MAX_INSTRUCTIONS, readInstructions, removeInstruction } from './instructions.js';
import { clampText } from './markdown.js';
import { appendObservation, precheckObservation } from './observations.js';
import { renderHits, type SearchHit } from './search.js';
import { currentTurnOf, sessionCwdOf, sessionIdOf } from './session.js';
import { TOOL_DIFF, TOOL_ENTITY, TOOL_FORGET, TOOL_OBSERVE, TOOL_REMEMBER, TOOL_SEARCH, TOOL_SPACE } from './tool-names.js';
import { readVaultFile } from './vault.js';
import { listProjectBriefs, ensureProjectMeta, type ProjectBrief } from './projects.js';
import {
  readRegistry,
  resolveWorkspace,
  setWorkspaceKind,
  type WorkspaceKind,
  type WorkspaceResolution,
} from './workspaces.js';
import { listPartitionKeys, ensureProjectEntry } from './vault-api.js';
import { projectKey } from './paths.js';

export { TOOL_DIFF, TOOL_ENTITY, TOOL_FORGET, TOOL_OBSERVE, TOOL_REMEMBER, TOOL_SEARCH, TOOL_SPACE } from './tool-names.js';

/** `mem_diff` 单次返回的字符上限兜底。 */
export const DEFAULT_DIFF_MAX_CHARS = 6000;

/**
 * 工具执行时可以拿到的上下文。
 *
 * 只声明我们实际读的字段，不引 `ToolRunContext` 的具体类型 ——
 * 这样测试传一个 `{ agent: fakeAgent }` 就够了，不必伪造整条执行链。
 */
interface ToolExecLike {
  agent?: unknown;
}

/** 自动写入该落到哪个 vault。 */
export interface ObserveSpace {
  kind: 'chat' | 'project';
  dir: string;
}

export interface ToolContext {
  /** 共享层 vault（常驻记忆文件在这里）。 */
  sharedDir: string;
  /** 实体索引 —— 与注入共用同一个实例，避免两边扫出不同结果。 */
  index?: EntityIndex;
  /**
   * 读当前会话的 agent preset id（§4.2.7）：`'chat'` → 聊天空间。
   * 由宿主提供（读 `sessionProjections` 的 `agentPreset` 投影）。
   * 不提供或读不到时返回 null —— 空间判定回退到 cwd 那套（降级路径）。
   */
  presetOf?: (agent: unknown) => string | null;
  /**
   * 待确证观察的落点解析：答"这是关于**谁**的事实"。
   * 不提供时 `mem_observe` 一律拒绝写入。
   */
  observeResolver?: (cwd: string | null, agentPreset?: string | null) => ObserveSpace;
  /**
   * 时间线详情的落点解析：答"这是**哪个目录**里的改动"。
   * 与 `observeResolver` 是两个问题，所以是两个入口 —— 见 `timeline.ts` 的说明。
   */
  timelineResolver?: (cwd: string | null, agentPreset?: string | null) => string | null;
  /** `mem_diff` 单次返回的字符预算。 */
  diffMaxChars?: number;
  /**
   * 跨项目检索入口（P4.6）。由宿主提供，内部先刷新索引再查。
   * 不提供时 `mem_search` 明确拒绝，而不是偷偷退化成"只搜当前空间"。
   */
  search?: (query: string, opts: {
    k: number;
    scope: 'all' | 'current';
    cwd: string | null;
    /** 当前会话的 agent preset（§4.2.7）；`'chat'` 时"当前空间"是聊天空间。 */
    agentPreset?: string | null;
  }) => SearchHit[];
  /** 工作区登记所需的信息（P4.6）。 */
  workspaces?: {
    home: string;
    markers: readonly string[];
    /** 项目记忆的 `projects/` 目录。 */
    entriesDir: string;
  };
}

function rememberTool(sharedDir: string): ToolDefinition {
  return {
    name: TOOL_REMEMBER,
    description: [
      '写入一条**常驻记忆**：它每次会话都会注入上下文，并且不参与自动整理（dream）的淘汰。',
      `上限 ${MAX_INSTRUCTIONS} 条，满了会被拒绝（不会自动淘汰旧的），所以只写真正长期有效的。`,
      '',
      '**只在用户明确要求记住时调用**，例如「记住 X」「别忘了 X」「以后都 X」。',
      '不要在对话过程中自作主张往里加内容 —— 平时的整理交给晚上跑的 dream。',
      '临时任务状态、密钥、健康数据、仓库里已记录的东西都不要写。',
      '如果只是"觉得这件事比较重要"，**也先别写**，留给 dream 判断。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: '要长期记住的那句话。写成单行、自包含、脱离上下文也看得懂的陈述。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'count', 'max'],
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          max: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: unknown; count?: unknown; max?: unknown; reason?: unknown };
        return [
          {
            type: 'text' as const,
            text: v.ok
              ? `已写入常驻记忆（${String(v.count)}/${String(v.max)} 条）。`
              : `未写入常驻记忆：${String(v.reason ?? '未知原因')}`,
          },
        ];
      },
    },
    async execute(args: unknown): Promise<{ ok: boolean; count: number; max: number; reason?: string }> {
      const parsed = (args ?? {}) as { text?: unknown };
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      const r = addInstruction(sharedDir, text);
      if (!r.ok) {
        const reason =
          r.reason === 'full'
            ? `已达上限 ${MAX_INSTRUCTIONS} 条，拒绝新增。这是刻意的：满了不会自动淘汰最旧的。请让用户先指定一条删除，或者把新内容并入已有条目。`
            : r.reason === 'duplicate'
              ? '这条已经在常驻记忆里了，无需重复写入。'
              : '内容不能为空。';
        return { ok: false, count: r.file.items.length, max: MAX_INSTRUCTIONS, reason };
      }
      return { ok: true, count: r.file.items.length, max: MAX_INSTRUCTIONS };
    },
  };
}

function forgetTool(sharedDir: string): ToolDefinition {
  return {
    name: TOOL_FORGET,
    description: [
      '从**常驻记忆**里删除一条。',
      '**只在用户明确要求忘掉/取消时调用**，例如「忘掉 X」「不用记 X 了」。',
      '`text` 必须与列表中已有条目**完全一致**（去掉首尾空白后）。',
      '若不确定原文，先看上下文里注入的常驻记忆列表；删除失败时本次结果会回带当前全部条目供你核对。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '要删除的那条常驻记忆的原文。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'count', 'max'],
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          max: { type: 'integer' },
          reason: { type: 'string' },
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: unknown; count?: unknown; items?: unknown };
        const lines = [v.ok ? `已删除（剩 ${String(v.count)} 条）。` : '未找到那条常驻记忆。'];
        if (Array.isArray(v.items)) {
          lines.push('当前全部条目：', ...v.items.map((t, i) => `${i + 1}. ${String(t)}`));
        }
        return [{ type: 'text' as const, text: lines.join('\n') }];
      },
    },
    async execute(args: unknown): Promise<{
      ok: boolean;
      count: number;
      max: number;
      reason?: string;
      items?: string[];
    }> {
      const parsed = (args ?? {}) as { text?: unknown };
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      const r = removeInstruction(sharedDir, text);
      if (!r.ok) {
        // 回带当前全部条目：模型据此核对原文后可以重试，避免它反复猜
        return {
          ok: false,
          count: r.file.items.length,
          max: MAX_INSTRUCTIONS,
          reason: '没找到与 text 完全一致的条目。',
          items: r.file.items.map((it) => it.text),
        };
      }
      return { ok: true, count: r.file.items.length, max: MAX_INSTRUCTIONS };
    },
  };
}

const OBSERVE_REASON: Record<string, string> = {
  empty: '内容不能为空。',
  duplicate: '这条已经在待确证观察里了，无需重复写入。',
  'no-anchor': '拿不到来源锚点，拒绝写入 —— 查不到出处的记忆不如不记。',
  'write-failed': '写入失败（vault 不可写）。',
};

/**
 * 待确证观察（P4）。
 *
 * **v11 起它的定位变了**：不再是"轮次结束顺手记一笔"的日常出口。
 * 用户拍板：「不要在对话过程中频繁改动 memory，这个工具**除非用户要求改
 * 或者记忆跟之前的有冲突**才能碰，不然都由 dream agent 完成」。
 * 所以它的 description 第一句就写死了这两个前提。
 */
function observeTool(ctx: ToolContext): ToolDefinition {
  return {
    name: TOOL_OBSERVE,
    description: [
      '写入一条**待确证观察**：关于用户 / 项目 / 你自己的耐久事实。',
      '',
      '## 什么时候才调用它（**重要**）',
      '',
      '**不要在对话过程中主动记东西。** 只有这两种情况才调用：',
      '',
      '1. **用户明确要求**（「记住 X」「以后都 X」）—— 这种情况优先用 `mem_remember`；',
      '2. **与已有记忆冲突** —— 上下文里的常驻记忆或某个 section 与用户当下所说矛盾，',
      '   需要改正。**以用户当下所说为准。**',
      '',
      '其余一切（你只是"觉得这条挺重要"）**都不要写** —— 留给晚上跑的 dream。',
      '它会读 `raw/turns/` 里的原始轮次自己提炼，判断得比当时更准，',
      '而且不会打断对话节奏。',
      '',
      '## 它是什么',
      '',
      '暂存区：**不会被主动注入上下文**，也不进 README；',
      '后续整理若发现它被反复印证，才会晋升成正式记忆。',
      '',
      '**每条观察都会自动带上来源锚点**（当前会话 + 轮次），',
      '拿不到来源时会拒绝写入 —— 这是刻意的，查不到出处的记忆不如不记。',
      '',
      '不要写：密钥、健康数据、精确住址、仓库里已经记录的代码事实、一次性的任务状态。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: '一条耐久事实。写成单行、自包含的陈述，脱离当前上下文也看得懂。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'count'],
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          reason: { type: 'string' },
          anchorId: { type: 'integer' },
          space: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: unknown; count?: unknown; reason?: unknown; anchorId?: unknown; space?: unknown };
        if (!v.ok) return [{ type: 'text' as const, text: `未写入待确证观察：${String(v.reason ?? '未知原因')}` }];
        return [
          {
            type: 'text' as const,
            text:
              `已写入待确证观察（${String(v.space ?? '')}空间，共 ${String(v.count)} 条，` +
              `来源锚点 [^${String(v.anchorId ?? '')}]）。\n` +
              '注意：它不会主动注入上下文，要等整理环节确证后才会晋升。',
          },
        ];
      },
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<{
      ok: boolean;
      count: number;
      reason?: string;
      anchorId?: number;
      space?: string;
    }> {
      const parsed = (args ?? {}) as { text?: unknown };
      const text = typeof parsed.text === 'string' ? parsed.text : '';

      const resolver = ctx.observeResolver;
      if (resolver === undefined) {
        return { ok: false, count: 0, reason: '自动写入的落点未配置（observeResolver 缺失）。' };
      }
      const cwd = sessionCwdOf(exec?.agent);
      const space = resolver(cwd, ctx.presetOf?.(exec?.agent) ?? null);

      // 先纯读校验，再写锚点：锚点必须在正文之前写（正文要引用它的号），
      // 所以注定会被拒的正文不该先消耗掉一个号。
      const pre = precheckObservation(space.dir, text);
      if (pre !== null) {
        return { ok: false, count: 0, reason: OBSERVE_REASON[pre] ?? pre };
      }

      const session = sessionIdOf(exec?.agent);
      const turn = currentTurnOf(exec?.agent);
      if (session === null || turn === null) {
        return { ok: false, count: 0, reason: OBSERVE_REASON['no-anchor'] };
      }
      const anchor = appendAnchor(space.dir, {
        session,
        turn,
        at: new Date().toISOString(),
        kind: 'observe',
      });
      if (anchor === null) {
        return { ok: false, count: 0, reason: '锚点写入失败，正文未写入。' };
      }

      const r = appendObservation(space.dir, text, anchor.id);
      if (!r.ok) {
        return { ok: false, count: r.count, reason: OBSERVE_REASON[r.reason ?? ''] ?? '写入被拒。' };
      }
      return { ok: true, count: r.count, anchorId: anchor.id, space: space.kind };
    },
  };
}

/**
 * 时间线详情按需取（P4.5）。
 *
 * **两层都不主动注入**（v10：项目记忆整体不注入，摘要也不在上下文里）：
 * `timeline.md` 只写着"改了哪几个文件"，真正的改前 / 改后躺在 `raw/timeline/<id>.md`。
 * 这个工具是那道"第二层"的门 —— 只有当模型自己判断某个旧改动还影响到现在时才开。
 *
 * 三种失败都返回**具体**原因，不猜、也不编：
 * 指针号不存在 / 该锚点没有详情文件 / 锚点在但详情文件被清理了。
 */
function diffTool(ctx: ToolContext): ToolDefinition {
  const maxChars = ctx.diffMaxChars ?? DEFAULT_DIFF_MAX_CHARS;
  return {
    name: TOOL_DIFF,
    description: [
      '按指针取一条**时间线详情**（`timeline.md` 里 `[→ id]` 指向的完整改动）。',
      '',
      '摘要**不在你的上下文里**（项目记忆整体不注入）——先用 `mem_search` 把时间线调出来，那一行只写了"改了哪几个文件"。',
      '当你需要确认真实改动内容时再来取 —— 例如判断某个旧改动是否还在影响现在。',
      '返回当时记录下来的改前 / 改后文本。',
      '不要去猜指针号：拿不到就先看摘要里列出的那几个。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: {
          type: 'integer',
          description: '时间线条目里的指针号，例如 `[→12]` 就传 12。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'text'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'integer' },
          text: { type: 'string' },
          session: { type: 'string' },
          turn: { type: 'integer' },
          at: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: unknown; id?: unknown; text?: unknown; reason?: unknown };
        return [
          {
            type: 'text' as const,
            text: v.ok
              ? `时间线 [→${String(v.id)}]\n\n${String(v.text ?? '')}`
              : `未能取到时间线 [→${String(v.id)}]：${String(v.reason ?? '未知原因')}`,
          },
        ];
      },
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<{
      ok: boolean;
      id: number;
      text: string;
      session?: string;
      turn?: number;
      at?: string;
      reason?: string;
    }> {
      const parsed = (args ?? {}) as { id?: unknown };
      const id = typeof parsed.id === 'number' ? parsed.id : Number(parsed.id);
      if (!Number.isFinite(id) || id <= 0) {
        return { ok: false, id: 0, text: '', reason: 'id 必须是正整数。' };
      }

      const resolver = ctx.timelineResolver;
      if (resolver === undefined) {
        return { ok: false, id, text: '', reason: '时间线未配置（timelineResolver 缺失）。' };
      }
      const vaultDir = resolver(
        sessionCwdOf(exec?.agent),
        ctx.presetOf?.(exec?.agent) ?? null,
      );
      if (vaultDir === null) {
        return { ok: false, id, text: '', reason: '拿不到工作目录，无法确定去哪个项目分区取。' };
      }

      const anchors = readAnchors(vaultDir);
      const anchor = findAnchor(anchors, id);
      if (anchor === null) {
        const others = anchors.filter((a) => a.kind === 'diff').map((a) => a.id).slice(-20);
        return {
          ok: false,
          id,
          text: '',
          reason: others.length
            ? `这个分区里没有 [→${id}]。现有：${others.join('、')}`
            : '这个分区里还没有时间线条目。',
        };
      }
      const rel = detailPathFor(anchor);
      if (rel === null) {
        return { ok: false, id, text: '', reason: `[→${id}] 是「${anchor.kind}」类锚点，没有详情文件。` };
      }
      const raw = readVaultFile(vaultDir, rel);
      if (raw === null) {
        return { ok: false, id, text: '', reason: `锚点在，但详情文件 ${rel} 不在了（可能已被清理）。` };
      }
      return {
        ok: true,
        id,
        text: clampText(raw, maxChars),
        session: anchor.session,
        turn: anchor.turn,
        at: anchor.at,
      };
    },
  };
}

/** 把"判定结果"讲成一句人话（`mem_space` 与日志都用它）。 */
export function describeResolution(r: WorkspaceResolution): string {
  const via =
    r.source === 'explicit'
      ? '登记表'
      : r.source === 'marker'
        ? '仓库标记'
        : r.source === 'default'
          ? 'default 兜底'
          : '未登记（default=ask）';
  if (r.kind === 'project') {
    return `项目分区 \`${r.key ?? '?'}\`（依据：${via}${r.root ? `，根 \`${r.root}\`` : ''}）`;
  }
  return `聊天空间（依据：${via}）`;
}

function renderSpaceList(
  registry: { spaces: Record<string, WorkspaceKind>; default: string },
  current: WorkspaceResolution,
  cwd: string | null,
  briefs: readonly ProjectBrief[],
): string {
  const lines = [
    `当前工作目录：\`${cwd ?? '(未知)'}\``,
    `判定结果：${describeResolution(current)}`,
    `default 策略：\`${registry.default}\``,
    '',
    '已登记的工作区：',
  ];
  const keys = Object.keys(registry.spaces).sort();
  if (keys.length === 0) lines.push('- （还没有登记任何工作区）');
  else for (const k of keys) lines.push(`- \`${k}\` → ${registry.spaces[k]}`);

  lines.push('', '已存在的项目分区：');
  if (briefs.length === 0) lines.push('- （还没有项目分区）');
  else {
    for (const b of briefs) {
      lines.push(
        `- **${b.name}**${b.path ? `（${b.path}）` : ''} · ${b.entries} 条记忆、${b.timelineCount} 条时间线`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * 跨项目检索（P4.6）。
 *
 * 设计文档 §4.2.4 的"入口二"：别的项目分区不注入，但必须搜得到。
 * 结果**带归属标注** —— 跨项目检索最容易犯的错就是把 A 项目的记忆
 * 当成当前项目的，所以每条都标明它来自哪个空间。
 */
function searchTool(ctx: ToolContext): ToolDefinition {
  return {
    name: TOOL_SEARCH,
    description: [
      '跨**所有空间与项目分区**检索记忆 —— 包括**其它项目**的。',
      '',
      '默认全搜；`scope: "current"` 只搜当前会话所属的空间。',
      '结果带归属标注（来自哪个空间 / 分区），正文是命中位置附近的摘要。',
      '需要整页时再用 `mem_entity`（实体页）或 `mem_diff`（时间线详情）取。',
      '',
      '别的项目**不会**被主动注入你的上下文；想知道那边有什么，就来这里搜。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '检索词。中文直接写词即可（内部按 bigram 切）。' },
        k: { type: 'integer', description: '返回条数，默认 10，上限 50。' },
        scope: {
          type: 'string',
          enum: ['all', 'current'],
          description: '检索范围：all=全部空间与分区（默认），current=只搜当前会话所属空间。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'count', 'text'],
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          text: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: unknown; text?: unknown; reason?: unknown };
        return [
          {
            type: 'text' as const,
            text: v.ok ? String(v.text ?? '') : `检索失败：${String(v.reason ?? '')}`,
          },
        ];
      },
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<{
      ok: boolean;
      count: number;
      text: string;
      reason?: string;
    }> {
      const parsed = (args ?? {}) as { query?: unknown; k?: unknown; scope?: unknown };
      const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
      if (!query) return { ok: false, count: 0, text: '', reason: 'query 不能为空。' };

      const run = ctx.search;
      if (run === undefined) return { ok: false, count: 0, text: '', reason: '检索入口未配置。' };

      const k =
        typeof parsed.k === 'number' && Number.isFinite(parsed.k) && parsed.k > 0
          ? Math.min(50, Math.floor(parsed.k))
          : 10;
      const scope: 'all' | 'current' = parsed.scope === 'current' ? 'current' : 'all';
      const hits = run(query, {
        k,
        scope,
        cwd: sessionCwdOf(exec?.agent),
        agentPreset: ctx.presetOf?.(exec?.agent) ?? null,
      });
      return { ok: true, count: hits.length, text: renderHits(hits) };
    },
  };
}

/**
 * 工作区类型登记（P4.6）。
 *
 * 与常驻记忆同样的取舍：**写入只在用户明确表态时发生**。
 * 区别在于写的是配置（`workspaces.yaml`）而不是记忆 —— 配置可以手改，
 * 也应该让 AI 能在用户说"这个目录是项目"时顺手记下来。
 */
function spaceTool(ctx: ToolContext): ToolDefinition {
  return {
    name: TOOL_SPACE,
    description: [
      '查看或登记**工作区类型**：某个工作目录的记忆进哪个空间。',
      '',
      '- `action: "list"`（默认）—— 列出已登记的工作区、已存在的项目分区，',
      '  以及**当前**工作目录被判定成了什么、依据是什么。',
      '- `action: "set"` —— 把某个目录登记为 `chat` 或 `project`。',
      '',
      '**只在用户明确表态时用 set**（例如「这个目录是项目」「以后这个算聊天」）。',
      '`project`：该目录及其子目录进它自己的项目分区，与其它项目互不注入；',
      '`chat`：进聊天空间（价值观、态度那类）。',
      '',
      '不传 `path` 时针对当前会话的工作目录。登记一个目录等于登记它的所有子目录。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'set'], description: 'list 查看，set 登记。' },
        path: { type: 'string', description: '要登记的工作目录；不传则用当前会话的工作目录。' },
        kind: { type: 'string', enum: ['chat', 'project'], description: 'set 时的目标类型。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'text'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          text: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: unknown; text?: unknown; reason?: unknown };
        return [
          {
            type: 'text' as const,
            text: v.ok ? String(v.text ?? '') : `未完成：${String(v.reason ?? '')}`,
          },
        ];
      },
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<{
      ok: boolean;
      action: string;
      text: string;
      reason?: string;
    }> {
      const ws = ctx.workspaces;
      if (ws === undefined) return { ok: false, action: 'list', text: '', reason: '工作区登记未配置。' };

      const parsed = (args ?? {}) as { action?: unknown; path?: unknown; kind?: unknown };
      const action = parsed.action === 'set' ? 'set' : 'list';
      const cwd = sessionCwdOf(exec?.agent);

      if (action === 'list') {
        const registry = readRegistry(ws.home);
        const current = resolveWorkspace(ws.home, cwd, ws.markers);
        const briefs = listProjectBriefs(ws.entriesDir, listPartitionKeys(ws.home));
        return { ok: true, action, text: renderSpaceList(registry, current, cwd, briefs) };
      }

      const explicit = typeof parsed.path === 'string' && parsed.path.trim() !== '' ? parsed.path.trim() : null;
      const target = explicit ?? cwd;
      if (target === null) {
        return { ok: false, action, text: '', reason: '没给 path，也拿不到当前会话的工作目录。' };
      }
      const kind = parsed.kind;
      if (kind !== 'chat' && kind !== 'project') {
        return { ok: false, action, text: '', reason: 'kind 必须是 chat 或 project。' };
      }

      const r = setWorkspaceKind(ws.home, target, kind);
      if (!r.ok) {
        return { ok: false, action, text: '', reason: '写入 workspaces.yaml 失败（目录不可写？）。' };
      }

      // 登记成项目就**立刻把项目目录建出来**：登记是个明确动作，
      // 用户期待"登完就能在记忆空间 → 项目记忆 里看到它"，而不是等第一次写入才凭空出现。
      let extra = '';
      if (kind === 'project') {
        const e = ensureProjectEntry(ws.home, projectKey(r.key), r.key);
        extra = `\n\n项目目录已建立：\`projects/${e.name}/\``;
      }

      const after = resolveWorkspace(ws.home, cwd, ws.markers);
      return {
        ok: true,
        action,
        text: [
          `已把 \`${r.key}\` 登记为 **${kind}**。${extra}`,
          '',
          `当前会话判定：${describeResolution(after)}`,
          '',
          '登记于**下一次会话**生效（本次会话的注入已经发生过了）。',
        ].join('\n'),
      };
    },
  };
}

/** 当前常驻记忆的只读快照（供测试与其他工具复用）。 */
export function snapshot(sharedDir: string): { items: string[]; max: number } {
  const f = readInstructions(sharedDir);
  return { items: f.items.map((i) => i.text), max: MAX_INSTRUCTIONS };
}

/**
 * 实体查阅工具（P3）。
 *
 * 会话开始时注入的只是**名字目录**；正文要主动来取。这就是"看到引用再去翻原文"。
 * 顺带把一跳邻居也带上 —— 提到 A 时，A 链到的 B 往往正是下一步需要的。
 */
function entityTool(index: EntityIndex): ToolDefinition {
  return {
    name: TOOL_ENTITY,
    description: [
      '查阅记忆空间里的一个**实体页**（人 / 项目 / 概念 / 地点）。',
      '会话开始时只会给你实体**名字目录**，正文要在这里取。',
      '当你觉得某个实体的细节对当前任务有用时调用（例如用户聊到那个项目、那个概念）。',
      '返回该实体页正文，外加它 `[[链接]]` 到的**一跳邻居**。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: '实体名，照记忆空间里列出的名字写。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'name', 'text'],
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          text: { type: 'string' },
          neighbors: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: unknown; name?: unknown; text?: unknown; reason?: unknown };
        return [
          {
            type: 'text' as const,
            text: v.ok ? String(v.text ?? '') : `未能查到实体「${String(v.name ?? '')}」：${String(v.reason ?? '')}`,
          },
        ];
      },
    },
    async execute(args: unknown): Promise<{
      ok: boolean;
      name: string;
      text: string;
      neighbors?: string[];
      reason?: string;
    }> {
      const parsed = (args ?? {}) as { name?: unknown };
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      if (!name) return { ok: false, name: '', text: '', reason: 'name 不能为空。' };

      const all = index.rebuild();
      // 主名或别名命中
      const target =
        all.find((e) => e.name === name) ?? all.find((e) => e.aliases.includes(name)) ?? null;
      if (!target) {
        const available = all.map((e) => e.name).slice(0, 20);
        return {
          ok: false,
          name,
          text: '',
          reason: available.length
            ? `没有这个实体。现有：${available.join('、')}`
            : '记忆空间里还没有实体页。',
        };
      }

      const neighbors = expandOneHop([target], all);
      const parts = [renderEntity(target)];
      if (neighbors.length > 0) {
        parts.push(
          `#### 一跳邻居\n` + neighbors.map((n) => `- ${n.name}（${n.kind} · ${n.status}）`).join('\n'),
        );
      }
      return { ok: true, name: target.name, text: parts.join('\n\n'), neighbors: neighbors.map((n) => n.name) };
    },
  };
}

/**
 * 注册模型工具。返回的 disposer 由调用方通过 `ctx.tools.register` 收集。
 */
export function registerMemTools(
  register: (t: ToolDefinition) => unknown,
  ctx: ToolContext,
): void {
  register(rememberTool(ctx.sharedDir));
  register(forgetTool(ctx.sharedDir));
  register(observeTool(ctx));
  register(diffTool(ctx));
  register(searchTool(ctx));
  register(spaceTool(ctx));
  if (ctx.index) register(entityTool(ctx.index));
}
