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
    content?: Array<{
      type?: string;
      text?: string;
      /** 附件块（image / file）带的是这个 —— 见 `attachmentsOfUserMessage`。 */
      attachment?: {
        attachmentId?: string;
        mediaType?: string;
        name?: string;
        bytes?: number;
        width?: number;
        height?: number;
      };
    }>;
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

/** 一条附件的元数据。**字节不在这里** —— 在 DSH 的附件库里，按 id 寻址。 */
export interface TurnAttachment {
  /** `image` 还是别的文件。 */
  kind: 'image' | 'file';
  /** 内容寻址 id：`sha256:<64 位 hex>`。 */
  id: string;
  mediaType: string | null;
  name: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
}

/**
 * 取出一条用户消息里的附件元数据。
 *
 * ⚠️ **这是附件唯一会进我们库的入口。** 在它之前只有 `textOfUserMessage`，
 * 而那个函数只挑 `type === 'text'` 的块 —— image / file 块被**静默丢掉**，
 * 于是"用户发过一张图"这件事在 `raw/turns` 里连痕迹都没有（实测：本会话发过图的
 * 那些轮次，全文搜 attachment / png / image 一处都没有），dream 也就无从判断
 * 它重不重要。
 *
 * 只记元数据、不搬字节：字节在附件库里按内容寻址，**指向原件就够了**。
 */
export function attachmentsOfUserMessage(data: EventLike['data']): TurnAttachment[] {
  const out: TurnAttachment[] = [];
  for (const b of data?.content ?? []) {
    if (b?.type !== 'image' && b?.type !== 'file') continue;
    const a = b.attachment;
    if (a === undefined || a === null || typeof a.attachmentId !== 'string') continue;
    out.push({
      kind: b.type,
      id: a.attachmentId,
      mediaType: typeof a.mediaType === 'string' ? a.mediaType : null,
      name: typeof a.name === 'string' ? a.name : null,
      bytes: typeof a.bytes === 'number' ? a.bytes : null,
      width: typeof a.width === 'number' ? a.width : null,
      height: typeof a.height === 'number' ? a.height : null,
    });
  }
  return out;
}
