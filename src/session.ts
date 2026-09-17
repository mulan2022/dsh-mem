/**
 * 会话读取的小工具：从 agent / session 上取我们要的几样东西。
 *
 * 集中在一个模块里的理由：这些取值**在 dsh 的版本之间变过形态**
 * （`Session.events` 属性在某次重构后变成 `ownEvents()` 方法），而且
 * 从 agent 往下摸到 session、再摸到 header 的路径容易被记错。
 * 与其在注入、工具、反思三处各写一遍（还要各修一遍），不如只写一遍。
 *
 * 全部按 fail-closed 写：取不到就返回 null / 空数组，绝不抛异常 ——
 * 这些函数跑在 turn 边界上，抛出去会打断整个 agent loop。
 */

/** 当前会话的事件流。两种形态都探测，都没有则空数组。 */
export function sessionEventsOf(session: unknown): readonly unknown[] {
  if (session === null || session === undefined) return [];
  const s = session as { events?: unknown; ownEvents?: unknown };
  if (typeof s.ownEvents === 'function') {
    try {
      const evs = (s.ownEvents as () => unknown)();
      if (Array.isArray(evs)) return evs;
    } catch {
      /* 方法存在但抛了 —— 回退到属性探测 */
    }
  }
  return Array.isArray(s.events) ? s.events : [];
}

interface AgentLike {
  session?: {
    header?: { id?: unknown; cwd?: unknown; origin?: unknown };
  };
}

/** 会话 id。取不到返回 null（拿不到 id 就不该往 vault 里写东西）。 */
export function sessionIdOf(agent: unknown): string | null {
  const id = (agent as AgentLike | undefined)?.session?.header?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** 会话的工作目录。取不到返回 null（调用方自行决定回退到哪个空间）。 */
export function sessionCwdOf(agent: unknown): string | null {
  const cwd = (agent as AgentLike | undefined)?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

/**
 * 是否为子代理会话。
 *
 * 子代理不参与反思 —— 它的产物会回到父代理的上下文里，
 * 在子代理里写记忆等于让一次内部探索污染长期画像。
 */
export function isSubagentSession(agent: unknown): boolean {
  return (agent as AgentLike | undefined)?.session?.header?.origin === 'subagent';
}

/** 当前轮次号：最后一个 `turn/start` 事件带的 turn。取不到返回 null。 */
export function currentTurnOf(agent: unknown): number | null {
  const events = sessionEventsOf((agent as AgentLike | undefined)?.session);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: unknown; data?: { turn?: unknown } } | undefined;
    if (e?.type !== 'turn/start') continue;
    const t = e.data?.turn;
    if (typeof t === 'number' && Number.isFinite(t)) return t;
    return null;
  }
  return null;
}

/** 一条会话事件的窄视图（只声明我们实际读的字段）。 */
export interface EventLike {
  type?: string;
  data?: {
    turn?: number;
    source?: { kind?: string; plugin?: string };
    content?: Array<{ type?: string; text?: string }>;
    message?: { content?: Array<{ type?: string; name?: string; text?: string }> };
    reason?: { kind?: string };
  };
}

/** 把事件流窄化 —— 只为省掉每个调用点的重复断言。 */
export function asEvents(events: readonly unknown[]): EventLike[] {
  return events as EventLike[];
}

/** 事件里最后一个 `turn/start` 的下标；没有则 -1。 */
export function lastTurnStartIndex(events: readonly EventLike[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') return i;
  }
  return -1;
}

/** 一条 user 消息里所有 text 块的拼接。 */
export function textOfUserMessage(data: EventLike['data']): string {
  return (data?.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('\n');
}
