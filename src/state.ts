/**
 * 插件状态：`<home>/.dsh-mem/state.json`。
 *
 * **它不是记忆** —— 是插件自己的运行状态（"问过哪些工作区""dream 上次什么时候跑的"）。
 * 所以它放在 `.dsh-mem/` 根下，不进任何 vault：vault 里的东西是给人和 AI 看的记忆，
 * 这里是机器状态，混进去只会让人误以为它也是记忆的一部分。
 *
 * 单独成模块，是因为**两个模块都要读写它**（`workspaces` 记"问过谁"、
 * `dream` 记"上次跑没跑"）。各写各的读-改-写会互相盖掉 ——
 * 读改写必须收敛到这一处。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DreamState {
  /** 上次**成功**跑完的时间（ISO）。失败不写它 —— 见 dream.ts 的第 2 条防御。 */
  lastRunAt: string | null;
  /** 上次的结果，供排障。`ok` / `error` / `aborted`。 */
  lastOutcome: 'ok' | 'error' | 'aborted' | null;
  /** 租约：正在跑时的持有标记。 */
  lease: { at: string; by: string } | null;
}

export interface PluginState {
  /** 工作区 key → 首次询问时间（"问过一次就不再问"）。 */
  asked: Record<string, string>;
  dream: DreamState;
  /**
   * **跳过整理的会话**（用户在会话菜单里点过「跳过梦境整理记忆」）。
   *
   * 与 `dream` 分开放，是因为它的语义不同：`dream` 记的是"跑没跑"这个全局状态，
   * 这份名单是**逐会话的排除项**。放在一起读起来会以为是同一类东西。
   */
  dreamSkip: string[];
}

export const EMPTY_STATE: PluginState = {
  asked: {},
  dream: { lastRunAt: null, lastOutcome: null, lease: null },
  dreamSkip: [],
};

export function statePath(home: string): string {
  return join(home, '.dsh-mem', 'state.json');
}

/** 读状态。文件坏了/缺字段都**兜底成空**，绝不抛 —— 最坏结果是多问一次、重跑一次 dream。 */
export function readState(home: string): PluginState {
  let raw: unknown;
  try {
    if (!existsSync(statePath(home))) {
      return { asked: {}, dream: { ...EMPTY_STATE.dream }, dreamSkip: [] };
    }
    raw = JSON.parse(readFileSync(statePath(home), 'utf8'));
  } catch {
    return { asked: {}, dream: { ...EMPTY_STATE.dream }, dreamSkip: [] };
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const asked =
    o.asked !== null && typeof o.asked === 'object' ? (o.asked as Record<string, string>) : {};
  const d = (o.dream !== null && typeof o.dream === 'object' ? o.dream : {}) as Record<string, unknown>;
  const dreamSkip = Array.isArray(o.dreamSkip)
    ? o.dreamSkip.filter((x): x is string => typeof x === 'string')
    : [];
  const leaseRaw = d.lease;
  const lease =
    leaseRaw !== null && typeof leaseRaw === 'object' && typeof (leaseRaw as { at?: unknown }).at === 'string'
      ? {
          at: String((leaseRaw as { at: unknown }).at),
          by: typeof (leaseRaw as { by?: unknown }).by === 'string' ? String((leaseRaw as { by: unknown }).by) : '',
        }
      : null;
  return {
    asked,
    dream: {
      lastRunAt: typeof d.lastRunAt === 'string' ? d.lastRunAt : null,
      lastOutcome:
        d.lastOutcome === 'ok' || d.lastOutcome === 'error' || d.lastOutcome === 'aborted'
          ? d.lastOutcome
          : null,
      lease,
    },
    dreamSkip,
  };
}

/**
 * 读-改-写。
 *
 * 全程同步（Node 单线程），所以同一个进程里不会交错；跨进程并发不在本插件的假设内
 * （单机单 dsh 实例）。
 */
export function updateState(home: string, mutate: (s: PluginState) => void): PluginState {
  const s = readState(home);
  mutate(s);
  try {
    const p = statePath(home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
  } catch {
    /* 写不进去不该抛：状态丢了最坏是重问一次 / 重跑一次 */
  }
  return s;
}
