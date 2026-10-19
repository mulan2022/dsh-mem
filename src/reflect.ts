/**
 * 自动写入（设计文档 §5.1）：轮次结束时的一次提炼。
 *
 * 机制上**不做额外的一次模型调用**，而是 steer 一条带标记的消息进当前会话，
 * 让已经拥有全部上下文的那个模型自己判断该不该记、记什么。
 * 这样做的代价是每次触发多花一个 assistant 轮次，收益是提炼时上下文完整
 * （不必把对话再喂一遍给另一个模型），也不需要维护"提炼专用模型"这条链路。
 *
 * 提炼分三档（提示词里写明）：
 *   ① 用户明说的偏好/约束 → 常驻记忆（`mem_remember`）
 *   ② 关于用户/项目/自己的耐久事实 → 待确证观察（`mem_observe`）
 *   ③ 一次性的/临时的/推测的 → 不写
 *
 * 触发条件刻意保守：反思本身要花 token，而且它写下的东西会长期影响后续每一轮。
 * 宁可少记，不可乱记。
 */
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm';

import { PLUGIN_ID, PLUGIN_SOURCE_KIND } from './inject.js';
import {
  asEvents,
  isSubagentSession,
  lastTurnStartIndex,
  sessionEventsOf,
  textOfUserMessage,
  type EventLike,
} from './session.js';
import { TOOL_FORGET, TOOL_OBSERVE, TOOL_REMEMBER } from './tool-names.js';

/** 反思消息的识别标记。既用于防重复反思，也用于"距上次反思几轮"的计数。 */
export const REFLECT_MARKER = '[mem-reflect]';

/** 反思消息的来源标记。 */
export const REFLECT_SOURCE: MessageSource = { kind: PLUGIN_SOURCE_KIND };

/** 写记忆的工具 —— 本轮的最后一个工具是它们之一，说明模型已经主动记过了。 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([TOOL_REMEMBER, TOOL_FORGET, TOOL_OBSERVE]);

/**
 * 「用户明确要求记住」的措辞。
 *
 * **刻意不含「别忘了」**：中文里它绝大多数是**任务提醒**
 * （「别忘了把 meow 的坑加上」「别忘了关灯」），不是记忆请求。
 * 实测被它误触发过一次 —— 用户说「别忘了把 X 加上」，反思就起来了。
 *
 * 其余措辞也宁缺勿滥：漏掉一次显式意图的代价，是用户再说一遍；
 * 误触发的代价，是**在对话中间凭空多插一个轮次** —— 而用户刚明确要求过别这么干。
 */
const EXPLICIT_INTENT_RE = /(记住|记下|以后都|以后不要|从今以后|永远都|remember this)/;

export interface TurnScan {
  /** 本轮轮次号（取不到为 null）。 */
  turn: number | null;
  /** 本轮是否出现了真实用户消息。 */
  sawUser: boolean;
  /** 本轮真实用户消息的文本（截断）。 */
  userText: string;
  /** 本轮是否有工具调用。 */
  sawToolCall: boolean;
  /** 本轮最后一个工具名。 */
  lastToolName: string | undefined;
  /** 本轮是否已经反思过（含反思轮自身）。 */
  sawReflect: boolean;
  /** 本轮内「连续非写记忆工具调用」的最大段长。 */
  toolSteps: number;
  /** 本轮助手文本（截断），留给将来的提炼用。 */
  assistantText: string;
}

const TEXT_BUDGET = 2000;

/**
 * 扫描本轮（最后一个 `turn/start` 之后）的事件。
 *
 * 为什么不看更早的事件：反思的判定是"这一轮做了什么"，
 * 跨轮累积的部分交给 `turnsSinceReflect` 单独算 —— 两件事分开算，
 * 才不会在"会话很长"时把所有阈值都意外满足。
 */
export function scanTurn(events: readonly EventLike[]): TurnScan {
  const start = lastTurnStartIndex(events);
  const from = start < 0 ? 0 : start;
  const turn = start >= 0 ? (events[start]?.data?.turn ?? null) : null;

  let sawUser = false;
  let sawToolCall = false;
  let lastToolName: string | undefined;
  let sawReflect = false;
  let best = 0;
  let cur = 0;
  const userParts: string[] = [];
  const assistantParts: string[] = [];

  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (e?.type === 'user/message') {
      const src = e.data?.source;
      const text = textOfUserMessage(e.data);
      if ((src?.kind === PLUGIN_SOURCE_KIND || (src?.kind === 'plugin' && src.plugin === PLUGIN_ID)) && text.includes(REFLECT_MARKER)) {
        sawReflect = true;
      } else if (src?.kind === 'user') {
        sawUser = true;
        userParts.push(text);
      }
      continue;
    }
    if (e?.type === 'assistant/message') {
      for (const b of e.data?.message?.content ?? []) {
        if (b?.type === 'tool-call' && typeof b.name === 'string') {
          sawToolCall = true;
          lastToolName = b.name;
          if (WRITE_TOOLS.has(b.name)) {
            cur = 0; // 已经主动记过了，连续段在此中断
          } else {
            cur += 1;
            if (cur > best) best = cur;
          }
        } else if (b?.type === 'text' && typeof b.text === 'string') {
          assistantParts.push(b.text);
        }
      }
    }
  }

  return {
    turn,
    sawUser,
    userText: userParts.join('\n').slice(-TEXT_BUDGET),
    sawToolCall,
    lastToolName,
    sawReflect,
    toolSteps: best,
    assistantText: assistantParts.join('\n').slice(-TEXT_BUDGET),
  };
}

/**
 * 判定依据**只看本轮**，不跨轮累积。
 *
 * 刻意不留"距上次反思几轮"这类计数器：轮次级触发已经取消（见 `shouldReflect`），
 * 留着它只会引诱人再把"每隔 N 轮记一笔"加回来。
 */

export interface TriggerVerdict {
  fire: boolean;
  /** 为什么（拒绝也一样要说明，否则调不动就只能靠猜）。 */
  why: string;
}

/**
 * 判定要不要反思。
 *
 * **只在一个条件下触发：用户明确要求记住**（"记住…""以后都…"）。
 *
 * 曾经还有两个触发（连续工具调用 ≥N、距上次反思 ≥N 轮），**已经删掉** ——
 * 用户拍板：「**不要在对话过程中频繁改动 memory**，这个工具除非用户要求改
 * 或者记忆跟之前的有冲突才能碰，不然都由 dream agent 完成」。
 * 轮次级的"顺手记一笔"正是那种频繁改动，交给晚上跑的 dream 更合适。
 *
 * 抑制优先于触发：本轮已经反思过、或本轮最后一个工具就是写记忆的，
 * 都不该再来一次 —— 否则会连环反思。
 */
export function shouldReflect(scan: TurnScan): TriggerVerdict {
  if (scan.sawReflect) return { fire: false, why: '本轮已反思过' };
  const last = scan.lastToolName;
  if (last !== undefined && WRITE_TOOLS.has(last)) {
    return { fire: false, why: `本轮已调用 ${last}` };
  }
  if (scan.sawUser && EXPLICIT_INTENT_RE.test(scan.userText)) {
    return { fire: true, why: '用户明说了要记住' };
  }
  return { fire: false, why: '用户没有要求记住 —— 交给 dream' };
}

/** 反思提示词。文本自己写 —— 与参考实现的措辞、结构都不相同。 */
export function buildReflectPrompt(): string {
  return [
    `${REFLECT_MARKER} 用户这一轮要求记住东西（或者你自己说了要记住）。`,
    '',
    '**只处理这两种情况**：',
    '',
    '① **用户明确要求记住的** → 用 `mem_remember` 写进常驻记忆。',
    '② **与已有记忆冲突的** —— 上下文里的常驻记忆或某个 section 与用户当下所说矛盾',
    '   → **以用户当下所说为准**，用 `mem_remember` 或 `mem_observe` 把它改正。',
    '',
    '③ **其它一切 → 不要写。**',
    '   平时不要在对话过程中改记忆：用户没要求的、你只是"觉得重要"的，',
    '   都留给晚上跑的 dream —— 它会读 `raw/turns/` 里的原始轮次自己提炼。',
    '   对话中写记忆会打断对话节奏，而且当时也判断不准什么才真的重要。',
    '',
    '绝对不写：密钥、健康数据、精确住址，以及仓库里已经记录的代码事实。',
  ].join('\n');
}

/** 组装反思指令消息。 */
export function buildReflectMessage(
  text: string = buildReflectPrompt(),
): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: REFLECT_SOURCE });
}

export interface AutoWriteInput {
  enabled: boolean;
}

interface AutoWriteCtx {
  logger: { info(m: string): void; warn(m: string): void };
  on(event: string, handler: (...args: never[]) => unknown): unknown;
}

/**
 * 装上「用户要求记住」时的提醒：在 `agent/turn-stopping` 上判定并 steer。
 *
 * 注意它**现在只做一件事**：用户明说"记住"时提醒模型落库。
 * 轮次级的"顺手记一笔"已经取消（见 `shouldReflect` 的说明）。
 *
 * 整个回调包在 try/catch 里：它跑在 turn 边界上，
 * 一个异常抛出去会打断 agent loop —— 记忆插件不该有这种能力。
 *
 * @returns 注销函数
 */
export function installAutoWrite(ctx: AutoWriteCtx, input: AutoWriteInput): () => void {
  if (!input.enabled) {
    ctx.logger.info('dsh-mem: 「用户要求记住」的提醒已关闭（autoWrite=false）');
    return () => {};
  }

  ctx.on('agent/turn-stopping', ((payload: { agent?: unknown }) => {
    try {
      const agent = payload?.agent;
      if (!agent) return;
      if (isSubagentSession(agent)) return; // 子代理不参与
      const session = (agent as { session?: unknown }).session;
      const events = asEvents(sessionEventsOf(session));
      if (events.length === 0) return;

      const verdict = shouldReflect(scanTurn(events));
      if (!verdict.fire) return;

      const steer = (agent as { steer?: unknown }).steer;
      if (typeof steer !== 'function') {
        ctx.logger.warn('dsh-mem: agent 上没有 steer，本轮跳过自动反思');
        return;
      }
      (steer as (m: unknown) => void).call(agent, buildReflectMessage());
      ctx.logger.info(`dsh-mem: 已触发自动反思（${verdict.why}）`);
    } catch (e) {
      ctx.logger.warn(`dsh-mem: 自动反思失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }) as never);

  ctx.logger.info('dsh-mem: 「用户要求记住」的提醒已装上（只在用户明说时触发）');
  return () => {
    /* cordis 的 ctx.on 随 effect 域自动注销；这里保持与其它 install 一致的返回形状 */
  };
}
