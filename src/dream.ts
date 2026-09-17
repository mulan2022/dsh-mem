/**
 * dream —— 每晚的整理（P6）。
 *
 * 用户拍板：**把"空闲 180min 触发"改成统一晚上处理**，所以这里没有"闲置多久就跑"，
 * 而是"每晚到点检查一次，能跑就跑"。
 *
 * 这个文件是**确定性内核**：什么时候跑、能不能跑、跑没跑成。
 * 真正派 agent 干活的编排通过 `run` 注入 —— 内核不依赖任何 LLM，
 * 所以能被完整单测。**meow-memory 那 7 条真机事故里有 4 条就出在这一层**：
 *
 *  · 第 2 条 **一次断网永久吞掉**：失败若也记"今天跑过了"，那这一晚就再也不会重试。
 *    → 失败**只释放租约，不写 `lastRunAt`**；只有成功才记账。
 *  · 第 5 条 **窗口永远年轻 / dream 无限重启**：插件自己的消息刷新了活跃度。
 *    → **只认 `source.kind === 'user'`** 的消息才算活跃。
 *  · 第 6 条 **重复烧钱**：成功后 6h 冷却（叠加"一天一次"，双保险）。
 *  · 第 7 条 **中止导致租约残留 30min**：`aborted` / `interrupted` 时**立即释放租约**。
 *  · 第 1 条 **子代理无限套娃**：`origin === 'subagent'` 的会话既不算活跃、
 *    也不进素材（见 `turns.ts`），双重点排除。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { turnsDir } from './paths.js';
import { readState, updateState } from './state.js';

/** 租约有效期：超过这个时长就认为持有者已经死了，可以抢。 */
export const LEASE_MINUTES = 30;

export interface Clock {
  hour: number;
  minute: number;
}

/** 解析 `HH:MM`（24 小时制）。格式不对返回 null —— 调用方回退到默认值。 */
export function parseClock(s: string): Clock | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** 本地日期键 `YYYY-MM-DD`（判断"今天跑过没"要用本地日期，不是 UTC）。 */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 现在该不该跑。
 *
 * 三条都要满足：① 已经过了今天的 `at`；② 今天还没**成功**跑过；
 * ③ 距上次成功跑够久（冷却）。失败不算"跑过" —— 那是第 2 条防御。
 */
export function isDue(
  now: Date,
  clock: Clock,
  lastRunAt: string | null,
  cooldownHours: number,
): boolean {
  const scheduled = new Date(now);
  scheduled.setHours(clock.hour, clock.minute, 0, 0);
  if (now.getTime() < scheduled.getTime()) return false; // 今天还没到点

  if (lastRunAt !== null) {
    const last = new Date(lastRunAt);
    if (!Number.isNaN(last.getTime())) {
      // 今天（本地）已经成功跑过 → 今天不再跑
      if (dayKey(last) === dayKey(now) && last.getTime() >= scheduled.getTime()) return false;
      // 冷却：距上次成功不足 cooldownHours → 不跑（第 6 条防御）
      if (now.getTime() - last.getTime() < cooldownHours * 3600_000) return false;
    }
  }
  return true;
}

/** 最近有没有人在用。`lastActivityAt = 0` 表示从未有过真实用户消息。 */
export function isIdle(lastActivityAt: number, now: Date, idleMinutes: number): boolean {
  return now.getTime() - lastActivityAt >= idleMinutes * 60_000;
}

/** 租约是否被**有效地**持有（过期的租约不算，见第 7 条防御）。 */
export function leaseHeld(home: string, now: Date): boolean {
  const lease = readState(home).dream.lease;
  if (lease === null) return false;
  const at = Date.parse(lease.at);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at < LEASE_MINUTES * 60_000;
}

export function acquireLease(home: string, by: string, now = new Date()): boolean {
  if (leaseHeld(home, now)) return false;
  updateState(home, (s) => {
    s.dream.lease = { at: now.toISOString(), by };
  });
  return true;
}

export function releaseLease(home: string): void {
  updateState(home, (s) => {
    s.dream.lease = null;
  });
}

/** 记一次**成功**。失败绝不调它 —— 调了就等于"一次断网永久吞掉"。 */
export function recordSuccess(home: string, now = new Date()): void {
  updateState(home, (s) => {
    s.dream.lastRunAt = now.toISOString();
    s.dream.lastOutcome = 'ok';
    s.dream.lease = null;
  });
}

/** 记失败：**只清租约与结果，不动 `lastRunAt`**，下一轮自动重试。 */
export function recordFailure(home: string, outcome: 'error' | 'aborted'): void {
  updateState(home, (s) => {
    s.dream.lastOutcome = outcome;
    s.dream.lease = null;
  });
}

/**
 * 哪些会话有新素材要整理。
 *
 * 判据是 `raw/turns/<会话>.jsonl` 的 mtime 晚于上次成功跑的时间。
 * **没素材就直接跳过整晚** —— 不能为了"跑一次 dream"去烧钱。
 */
/**
 * mtime 与状态时间戳的**精度差宽限**。
 *
 * `statSync().mtimeMs` 是亚毫秒精度，而 `lastRunAt` 存的 ISO 串只到毫秒。
 * 直接比大小的话，同一瞬间写下的素材会算出 `mtime > lastRunAt` ——
 * 于是**每次 dream 都把刚整理过的同一批素材再整理一遍**。
 * （这个坑是写测试时撞出来的：断言"跑过就不用重跑"直接红了。）
 */
export const MTIME_GRACE_MS = 2000;

/** 被用户标了「跳过整理」的会话（会话右键菜单里点出来的）。 */
export function readDreamSkip(home: string): string[] {
  return readState(home).dreamSkip;
}

/**
 * 标记 / 取消「跳过整理」。
 *
 * **只挡自动整理** —— 用户手动点「现在整理」时**照样会整理它**（那是他明确要的），
 * 跟 meow 的语义一致：这个开关是"别背着我自动动它"，不是"永远别碰它"。
 */
export function setDreamSkip(home: string, sessionId: string, skip: boolean): string[] {
  return updateState(home, (s) => {
    const set = new Set(s.dreamSkip);
    if (skip) set.add(sessionId);
    else set.delete(sessionId);
    s.dreamSkip = [...set].sort();
  }).dreamSkip;
}

export function listPendingSessions(home: string, lastRunAt: string | null): string[] {
  const dir = turnsDir(home);
  if (!existsSync(dir)) return [];
  const since = lastRunAt !== null ? Date.parse(lastRunAt) : 0;
  const threshold = (Number.isNaN(since) ? 0 : since) + MTIME_GRACE_MS;
  // 跳过的会话不进候选 —— 用户在菜单里点过"别整理这条"
  const skip = new Set(readDreamSkip(home));
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  for (const n of names) {
    const sid = n.replace(/\.jsonl$/, '');
    if (skip.has(sid)) continue;
    try {
      if (statSync(join(dir, n)).mtimeMs > threshold) out.push(sid);
    } catch {
      /* 竞态：文件刚好被删 */
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------

export type DreamOutcome = 'ok' | 'error' | 'aborted';

export interface DreamInput {
  enabled: boolean;
  home: string;
  /** 每晚什么时候检查（`HH:MM`，本地时间）。 */
  at: Clock;
  /** 最近多少分钟有活动就推迟。 */
  idleMinutes: number;
  /** 成功后多久内不再跑。 */
  cooldownHours: number;
  /** 检查间隔（毫秒）。 */
  tickMs?: number;
  /**
   * 真正的整理动作。**目前可能没实现** —— 不传就只做判定、什么都不跑。
   * 返回 `ok` 才会记账；`error` / `aborted` 都只释放租约。
   */
  run?: (pending: string[]) => Promise<DreamOutcome>;
}

export interface DreamVerdict {
  proceed: boolean;
  why: string;
  pending: string[];
}

/** 判定一次（纯逻辑，不含副作用）。单独导出是为了能直接测。 */
export function judge(
  home: string,
  input: { at: Clock; idleMinutes: number; cooldownHours: number },
  now: Date,
  lastActivityAt: number,
): DreamVerdict {
  const st = readState(home).dream;
  if (!isDue(now, input.at, st.lastRunAt, input.cooldownHours)) {
    return { proceed: false, why: '未到点 / 今天已跑过 / 冷却中', pending: [] };
  }
  if (!isIdle(lastActivityAt, now, input.idleMinutes)) {
    return { proceed: false, why: `最近 ${input.idleMinutes} 分钟还有活动`, pending: [] };
  }
  if (leaseHeld(home, now)) {
    return { proceed: false, why: '租约被持有（另一次 dream 正在跑）', pending: [] };
  }
  const pending = listPendingSessions(home, st.lastRunAt);
  if (pending.length === 0) {
    return { proceed: false, why: '没有新素材 —— 直接跳过，不烧钱', pending: [] };
  }
  return { proceed: true, why: `${pending.length} 个会话有新素材`, pending };
}

interface DreamCtx {
  logger: { info(m: string): void; warn(m: string): void };
  on(event: string, handler: (...args: never[]) => unknown): unknown;
}

/**
 * 装上 dream 的调度。
 *
 * @returns 注销函数
 */
export function installDream(ctx: DreamCtx, input: DreamInput): () => void {
  if (!input.enabled) {
    ctx.logger.info('dsh-mem: dream 已关闭（dream=false）');
    return () => {};
  }

  // 编排还没接上定时路径时**不启动定时器** —— 空转一夜、每 5 分钟喊一句只会制造噪声。
  // 注意：**手动「现在整理」不受影响**（它用当前会话的 agent 当 parent，不需要这个）。
  if (input.run === undefined) {
    ctx.logger.info(
      'dsh-mem: dream 只装了判定、未装定时执行 —— 凌晨没有活会话，需要先 agents.create 造父 agent。' +
        '手动「现在整理」（mem_dream）可用。',
    );
    return () => {};
  }

  // 收窄成常量：闭包里 TS 不再认得上面那次 undefined 早退
  const run = input.run;

  // 活跃度：**只认真实用户消息**。
  // 第 5 条防御 —— 如果连插件自己的消息（注入快照、反思指令）也算活跃，
  // 那 dream 一跑就把自己唤醒，窗口永远年轻，永远跑不起来。
  let lastActivityAt = 0;
  ctx.on('session/event', ((_session: unknown, event: unknown) => {
    const e = event as { type?: unknown; data?: { source?: { kind?: unknown } } } | undefined;
    if (e?.type !== 'user/message') return;
    if (e.data?.source?.kind !== 'user') return;
    lastActivityAt = Date.now();
  }) as never);

  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    const now = new Date();
    const verdict = judge(input.home, input, now, lastActivityAt);
    if (!verdict.proceed) return;

    if (!acquireLease(input.home, 'dream', now)) return;
    running = true;
    ctx.logger.info(`dsh-mem: dream 开始（${verdict.why}）`);
    let outcome: DreamOutcome = 'error';
    try {
      outcome = await run(verdict.pending);
    } catch (e) {
      ctx.logger.warn(`dsh-mem: dream 抛异常: ${e instanceof Error ? e.message : String(e)}`);
      outcome = 'error';
    } finally {
      running = false;
    }

    if (outcome === 'ok') {
      recordSuccess(input.home);
      ctx.logger.info('dsh-mem: dream 完成');
    } else {
      // 失败/中止：**只释放租约，不写 lastRunAt** —— 下个周期还会重试。
      // 这就是 meow 那条"一次断网永久吞掉窗口"的防御。
      recordFailure(input.home, outcome);
      ctx.logger.warn(`dsh-mem: dream ${outcome}，已释放租约，下个周期重试`);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, input.tickMs ?? 5 * 60_000);
  // 不要让这个定时器拖住进程退出
  (timer as unknown as { unref?: () => void }).unref?.();

  ctx.logger.info(
    `dsh-mem: dream 调度已装上（每晚 ${input.at.hour}:${String(input.at.minute).padStart(2, '0')} 检查，` +
      `闲置 ${input.idleMinutes} 分钟才跑）`,
  );

  return () => {
    clearInterval(timer);
  };
}
