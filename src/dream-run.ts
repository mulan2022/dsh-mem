/**
 * dream 的编排：把「判定」和「纯逻辑」串成一次真正的整理。
 *
 * 两段式（设计文档 §5.6.2）：
 *
 * ```
 * 阶段 A（并行 · 只读）   每个会话两个 agent：闲聊 + 项目
 *        读同一份未归属素材，各捞各的，只吐 JSON，**不写任何文件**
 *              │  等全部收齐
 *              ▼
 * 阶段 B（串行 · 唯一写者） 一个 agent，按 space 归拢落库
 * ```
 *
 * **"怎么派 agent"被抽成 `spawn` 回调** —— 编排层因此不依赖 `ctx.subagents`，
 * 能用假的 spawn 完整单测（测"两个 agent 各捞各的""坏 JSON 不炸整轮""编造的锚点被丢掉"）。
 * 真实实现由调用方给：手动触发时用**当前会话的 agent** 当 parent，
 * 定时触发时得先 `agents.create` 造一个（凌晨没有活会话）。
 */
import { readAnchors } from './anchors.js';
import {
  dedupeObservations,
  extractJson,
  groupBySpace,
  missingAnchors,
  renderTemplate,
  validateExtract,
  type ExtractResult,
} from './dream-json.js';
import type { DreamOutcome } from './dream.js';
import { localDate } from './markdown.js';
import { readTurns } from './turns.js';

/** 一次"派个 agent 去干活"的请求。 */
export interface DreamSpawnRequest {
  label: string;
  prompt: string;
}

/** 派一个 agent，返回它的最终文本输出。 */
export type DreamSpawn = (req: DreamSpawnRequest) => Promise<string>;

export interface DreamRunDeps {
  home: string;
  logger: { info(m: string): void; warn(m: string): void };
  /** 派 agent（真实实现由调用方提供）。 */
  spawn: DreamSpawn;
  /** 读提示词模板：给名字（如 `dream-extract-chat`）返回正文。 */
  template: (name: string) => string;
  /** 目标项目名（项目记忆侧的路标）；聊天侧为 null。 */
  projectName?: string | null;
}

/** 阶段 A 要派的两类 agent。 */
export const EXTRACT_KINDS = ['chat', 'project'] as const;
export type ExtractKind = (typeof EXTRACT_KINDS)[number];

/** 给模板追加一段"本次任务"的具体路标（模板本身是通用的，不带具体路径）。 */
export function buildExtractPrompt(
  template: string,
  args: { home: string; session: string; kind: ExtractKind; projectName: string | null },
): string {
  const turnsPath = `${args.home}/.dsh-mem/raw/turns/${args.session}.jsonl`;
  return [
    template,
    '',
    '---',
    '',
    '## 本次任务（具体路标）',
    '',
    `- 会话 id：\`${args.session}\``,
    `- 你的那份原始轮次：\`${turnsPath}\``,
    `- 你负责的空间：\`${args.kind}\``,
    args.kind === 'project'
      ? `- 项目名：\`${args.projectName ?? '(未知)'}\``
      : '- 项目名：（不适用 —— 你是闲聊 agent）',
    '',
    '产出**只输出一个 JSON 对象**，前后不要有别的话。',
  ].join('\n');
}

/** 阶段 B 的提示词：把各空间归拢好的材料交给写者。 */
export function buildMergePrompt(
  template: string,
  args: { home: string; extracts: readonly ExtractResult[]; now: Date },
): string {
  const bySpace = groupBySpace(args.extracts);
  // 「本月」的滚动要靠它 —— 不注入日期，agent 只能靠感觉判断"现在是不是新的一个月"。
  const today = localDate(args.now);
  const thisMonth = today.slice(0, 7);
  const block = (name: string, list: readonly ExtractResult[]): string => {
    if (list.length === 0) return `### ${name}\n（无）`;
    const deduped = dedupeObservations(list);
    return [
      `### ${name}`,
      `来源会话：${[...new Set(list.map((r) => r.session))].join('、')}`,
      '',
      '合并去重后的观察：',
      ...deduped.map(
        (d) =>
          `- ${d.text}（kind=${d.kind}，confidence=${d.confidence}，被 ${d.seenIn} 个会话提到，` +
          `anchors=[${d.anchors.join(',')}]）`,
      ),
      '',
      '各 agent 交上来的完整 JSON：',
      '```json',
      JSON.stringify(list.map((r) => r.raw), null, 1),
      '```',
    ].join('\n');
  };
  return [
    template,
    '',
    '---',
    '',
    '## 本次任务（具体路标）',
    '',
    `- 素材根目录：\`${args.home}/.dsh-mem/raw/turns/\``,
    `- **今天：${today}** —— 所以「本月」= \`${thisMonth}\`。` +
      '跨月时要把「本月」里已经过去的月份滚进「早期月份」（见提示词正文）。',
    '- 两批 agent 的产出（已经过宿主校验：编造的锚点已被剔除）：',
    '',
    block('聊天记忆（spaces/chat/）', bySpace.chat),
    '',
    block('项目记忆（spaces/project/projects/<项目名>/）', bySpace.project),
    '',
    '做完所有写入后，**只输出一个 JSON 回执**（格式见上面的提示词正文）。',
  ].join('\n');
}

/** 一次整理的结果，供调用方记账/排障。 */
export interface DreamRunReport {
  outcome: DreamOutcome;
  sessions: string[];
  extracts: number;
  observations: number;
  /** 被丢掉的观察数（锚点是编的）。 */
  droppedForBadAnchor: number;
  /** 哪些 agent 的输出没法用。 */
  failed: string[];
}

/**
 * 跑一次完整的整理。
 *
 * **单点失败不拖垮整轮**：某个 agent 吐了坏 JSON，只把那一路标记失败，
 * 其余照常交给阶段 B —— 否则一个会话出问题，整晚的整理就没了。
 */
export async function runDream(deps: DreamRunDeps, pending: readonly string[]): Promise<DreamRunReport> {
  const extracts: ExtractResult[] = [];
  const failed: string[] = [];
  let droppedForBadAnchor = 0;

  // 有多少锚点可用（校验编造的锚点用）—— 两个空间各自的 vault 各读一次
  const anchorsBySpace: Record<ExtractKind, ReturnType<typeof readAnchors>> = {
    chat: readAnchors(`${deps.home}/.dsh-mem/spaces/chat`),
    project: readAnchors(
      `${deps.home}/.dsh-mem/spaces/project/projects/${deps.projectName ?? ''}`,
    ),
  };

  // ── 阶段 A：每个会话 × 两个空间 ──
  const jobs: Array<Promise<void>> = [];
  for (const session of pending) {
    for (const kind of EXTRACT_KINDS) {
      jobs.push(
        (async () => {
          const label = `dream:${kind}:${session.slice(0, 8)}`;
          let text = '';
          try {
            text = await deps.spawn({
              label,
              prompt: buildExtractPrompt(deps.template(`dream-extract-${kind}`), {
                home: deps.home,
                session,
                kind,
                projectName: deps.projectName ?? null,
              }),
            });
          } catch (e) {
            failed.push(`${label}（抛出：${e instanceof Error ? e.message : String(e)}）`);
            return;
          }
          const report = validateExtract(extractJson(text), session);
          if (!report.ok || report.result === null) {
            failed.push(`${label}（${report.errors.join('；')}）`);
            return;
          }
          // 编造的锚点 → 那一条不要（设计里的硬规矩：没出处的记忆不如不记）
          const bad = new Set(missingAnchors(report.result, anchorsBySpace[report.result.space]));
          if (bad.size > 0) {
            const before = report.result.observations.length;
            report.result.observations = report.result.observations.filter(
              (o) => o.anchor === null || !bad.has(o.anchor),
            );
            droppedForBadAnchor += before - report.result.observations.length;
            deps.logger.warn(`${label}: 丢掉 ${bad.size} 个编造的锚点 [${[...bad].join(',')}]`);
          }
          extracts.push(report.result);
        })(),
      );
    }
  }
  await Promise.all(jobs); // barrier

  const observations = extracts.reduce((n, e) => n + e.observations.length, 0);
  deps.logger.info(
    `dsh-mem: 阶段 A 完成 —— ${extracts.length} 份产出 / ${observations} 条观察` +
      (failed.length > 0 ? ` / ${failed.length} 路失败` : ''),
  );

  if (extracts.length === 0) {
    // 一路都没成：**不算成功**，让调度器下轮重试（而不是记"今天跑过了"）
    return { outcome: 'error', sessions: [...pending], extracts: 0, observations: 0, droppedForBadAnchor, failed };
  }

  // ── 阶段 B：唯一写者 ──
  try {
    const receipt = await deps.spawn({
      label: 'dream:merge',
      prompt: buildMergePrompt(deps.template('dream-merge'), {
        home: deps.home,
        extracts,
        now: new Date(),
      }),
    });
    const parsed = extractJson(receipt);
    if (parsed === null) {
      // 文件可能已经写了，但回执读不出来 —— 记失败，下轮重来（宁可重也不静默）
      deps.logger.warn('dsh-mem: 阶段 B 的回执不是 JSON，按失败处理');
      return { outcome: 'error', sessions: [...pending], extracts: extracts.length, observations, droppedForBadAnchor, failed };
    }
    deps.logger.info(`dsh-mem: 阶段 B 完成 —— ${JSON.stringify(parsed.health ?? {}).slice(0, 200)}`);
  } catch (e) {
    deps.logger.warn(`dsh-mem: 阶段 B 失败: ${e instanceof Error ? e.message : String(e)}`);
    return { outcome: 'error', sessions: [...pending], extracts: extracts.length, observations, droppedForBadAnchor, failed };
  }

  return {
    outcome: 'ok',
    sessions: [...pending],
    extracts: extracts.length,
    observations,
    droppedForBadAnchor,
    failed,
  };
}

// 保留引用，避免 renderTemplate 被摇树（阶段 B 的调用方可能用得到）
export { renderTemplate };
