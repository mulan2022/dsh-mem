/**
 * `mem_dream` —— 「现在整理一次」的手动入口（P6）。
 *
 * 平时整理是**每晚自动跑**的；这个工具是"别等晚上了，现在就整理"。
 * 两种触发共用同一套编排代码（`dream-run.ts`），区别只在**拿谁当父 agent**：
 *
 *  - 手动：**当前会话的 agent**（`exec.agent`）—— 所以现在就能跑，不用等凌晨；
 *  - 定时：凌晨没有活会话，得先 `ctx.agents.create()` 造一个。
 *
 * 「跳过整理」的语义在这里也体现出来：**名单只挡自动**，
 * 手动触发时如果用户点名要整理某个被跳过的会话，**照样整理**。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { DreamRunReport } from './dream-run.js';
import { TOOL_DREAM } from './tool-names.js';

/** 由宿主注入的能力集合（工具本身不碰 ctx / 文件系统）。 */
export interface DreamCapability {
  /** 有素材待整理的会话（已排除跳过名单）。 */
  pending(): string[];
  /** 当前被标"跳过整理"的会话。 */
  skipped(): string[];
  setSkip(sessionId: string, skip: boolean): string[];
  /** 跑一次。parent 由调用方给（手动触发时是当前会话的 agent）。 */
  run(sessionIds: string[], parent: unknown): Promise<DreamRunReport>;
}

interface ToolExecLike {
  agent?: unknown;
}

export function dreamTool(cap: DreamCapability): ToolDefinition {
  return {
    name: TOOL_DREAM,
    description: [
      '整理记忆：把「原始轮次」提炼成观察、晋升进 sections/entities、写 README。',
      '',
      '- `action: "status"`（默认）—— 看看有哪些会话待整理、哪些被标了跳过。',
      '- `action: "run"` —— **现在整理一次**（平时是每晚自动跑的）。',
      '  可以传 `sessionIds` 只整理其中几个；不传就整理全部待整理的。',
      '- `action: "skip"` / `"unskip"` —— 标记/取消某个会话「跳过自动整理」',
      '  （等价于会话右键菜单里那一项）。**只挡自动，手动 run 照样会整理它。**',
      '',
      '整理是**多轮子 agent 协作**，会比较慢（几十秒到几分钟）。',
      '**只在用户明确要求"现在整理"时调用 `run`** —— 平时别自作主张跑。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'run', 'skip', 'unskip'],
          description: 'status 查看 / run 现在整理 / skip 跳过 / unskip 取消跳过',
        },
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'run 时只想整理哪几个会话；不传=全部待整理的',
        },
        sessionId: { type: 'string', description: 'skip / unskip 针对的会话 id' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'text'],
        properties: {
          ok: { type: 'boolean' },
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
    async execute(args: unknown, exec: ToolExecLike): Promise<{ ok: boolean; text: string; reason?: string }> {
      const parsed = (args ?? {}) as { action?: unknown; sessionIds?: unknown; sessionId?: unknown };
      const action =
        parsed.action === 'run' || parsed.action === 'skip' || parsed.action === 'unskip'
          ? parsed.action
          : 'status';

      if (action === 'status') {
        const pending = cap.pending();
        const skipped = cap.skipped();
        // 会话 id 形如 `session-1c4b2f55-…`，直接 slice(0,8) 会得到一堆 "session-"
        const short = (s: string): string => s.replace(/^session-/, '').slice(0, 8);
        return {
          ok: true,
          text: [
            `待整理：${pending.length} 个会话${pending.length > 0 ? `（${pending.map(short).join('、')}）` : ''}`,
            `已跳过：${skipped.length} 个${skipped.length > 0 ? `（${skipped.map(short).join('、')}）` : ''}`,
          ].join('\n'),
        };
      }

      if (action === 'skip' || action === 'unskip') {
        const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
        if (sid === '') return { ok: false, text: '', reason: 'skip/unskip 需要 sessionId。' };
        const list = cap.setSkip(sid, action === 'skip');
        return {
          ok: true,
          text: `${action === 'skip' ? '已标记跳过' : '已取消跳过'}：\`${sid.slice(0, 8)}\`\n当前跳过名单：${list.length} 个`,
        };
      }

      // run
      const asked = Array.isArray(parsed.sessionIds)
        ? parsed.sessionIds.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        : [];
      const pending = cap.pending();
      const target = asked.length > 0 ? asked : pending;
      if (target.length === 0) {
        return { ok: true, text: '没有待整理的会话 —— 不用跑（不烧钱）。' };
      }
      if (exec?.agent === undefined) {
        return { ok: false, text: '', reason: '拿不到当前会话的 agent，无法派子 agent。' };
      }

      const report = await cap.run(target, exec.agent);
      const lines = [
        `${report.outcome === 'ok' ? '整理完成' : `整理**未成功**（${report.outcome}）`}`,
        `- 会话：${report.sessions.map((s) => s.slice(0, 8)).join('、')}`,
        `- 阶段 A 产出：${report.extracts} 份 / ${report.observations} 条观察`,
      ];
      if (report.droppedForBadAnchor > 0) {
        lines.push(`- 剔除了 ${report.droppedForBadAnchor} 条**锚点编造**的观察`);
      }
      if (report.failed.length > 0) {
        lines.push(`- 失败 ${report.failed.length} 路：`, ...report.failed.map((f) => `  - ${f}`));
      }
      return { ok: report.outcome === 'ok', text: lines.join('\n') };
    },
  };
}
