/**
 * 宿主侧 HTTP 数据面：记忆空间 UI 通过它读取 vault。
 *
 * 机制（照搬参考实现验证过的做法）：
 *  - `ctx.get('webServer')` 是**可选服务**，可能晚于本插件就绪（fiber 并发启动竞态，
 *    实测 3080 重启后 apply 时 webServer 尚未注册）；所以要**重试**，不能假设它已在。
 *  - 注册形状：`webServer.register({ kind: 'exact', path, handler(req, res) })`，
 *    handler 拿的是 Node 原生 req/res。
 *  - 所有响应 `cache-control: no-store`：vault 是用户可手改的文件，缓存会显示陈旧内容。
 */
import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { scanEntities } from './entities.js';
import { readInstructions } from './instructions.js';
import type { VaultApi } from './vault-api.js';

const PREFIX = '/dsh-mem';

/** webServer 服务的最小形状（第三方插件不引它的类型，只按需窄化）。 */
interface RouteRegistrar {
  register(route: {
    kind: 'exact';
    path: string;
    handler: (req: unknown, res: unknown) => void;
  }): unknown;
}

interface NodeReq {
  method?: string;
  url?: string;
  on?(event: string, listener: (chunk?: unknown) => void): void;
}
interface NodeRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/** POST 体的字符上限 —— 这里只会收到 `{action, sessionId}`，超过就是异常输入。 */
const BODY_LIMIT = 8 * 1024;

/**
 * 读 POST 体并解析成对象。
 *
 * 解析失败一律给空对象（而不是抛）：这条链路的输入来自我们自己的前端，
 * **宁可当作"参数没给"走 400，也不要让一个畸形请求把 handler 打挂**。
 */
function readJsonBody(req: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const r = req as NodeReq;
    if (typeof r.on !== 'function') return resolve({});
    let text = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        const parsed: unknown = JSON.parse(text === '' ? '{}' : text);
        resolve(parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    };
    r.on('data', (chunk) => {
      text += String(chunk ?? '');
      if (text.length > BODY_LIMIT) finish();
    });
    r.on('end', finish);
    r.on('error', finish);
  });
}

function writeJson(res: unknown, status: number, body: unknown): void {
  const r = res as NodeRes;
  try {
    r.statusCode = status;
    r.setHeader('content-type', 'application/json; charset=utf-8');
    r.setHeader('cache-control', 'no-store');
    r.end(JSON.stringify(body));
  } catch {
    /* 连接已断，忽略 */
  }
}

function query(req: unknown): URLSearchParams {
  const url = (req as NodeReq).url ?? '/';
  try {
    return new URL(url, 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * 解析 `space` 参数为实际目录。
 *
 * **只有三个**，与 UI 的三个 tab 一一对应：
 *  - `shared`   常驻记忆 + 全局共用（所有会话都注入）
 *  - `chat`     聊天记忆
 *  - `project`  项目记忆（**一个**容器；各项目是它下面 `projects/` 的子目录）
 *
 * 项目不再各占一个 `space` —— 前端拿 `project` 的目录树就能一路点进去。
 * 拒绝任何越界 —— 目录由前端传入，按不可信输入处理。
 */
export function resolveSpaceDir(api: VaultApi, space: string): string | null {
  if (space === 'shared') return api.sharedDir;
  if (space === 'chat') return api.chatDir;
  if (space === 'project') return api.projectDir;
  return null;
}

/**
 * dream 的控制面（会话右键菜单用）。
 *
 * 这是本插件**唯一一组写路由** —— 与「常驻记忆只读」并不矛盾：常驻记忆的正文
 * 只有 `mem_remember` / `mem_forget` 能改，而这里改的是**整理调度**（跳过名单 / 现在跑一次），
 * 不是记忆内容。清单本身仍然落在 `state.json`，AI 侧走 `mem_dream` 工具，
 * 两条入口共用 `dream.ts` 同一套读写。
 */
export interface DreamRoutesApi {
  /** 当前跳过名单 + 待整理名单 + 是否正在整理。 */
  state(): { skipped: string[]; pending: string[]; running: boolean };
  /** 返回更新后的跳过名单。 */
  setSkip(sessionId: string, skip: boolean): string[];
  /**
   * 起一次整理。**立刻返回，不等它跑完** —— 整理是几十秒到几分钟的多轮子 agent 协作，
   * 让 HTTP 挂那么久只会超时。跑没跑完看 `state().running`。
   */
  start(sessionIds: string[]): { ok: boolean; started: boolean; text?: string; error?: string };
}

/**
 * 路由之外的只读视图提供者。
 *
 * 让 routes.ts 不必知道"工作区怎么判定"—— 那是 workspaces.ts 的事。
 * 这里只负责把它读出来给 UI。
 */
export interface VaultRoutesExtras {
  /** 工作区登记视图（只读）。 */
  workspaceView?: () => unknown;
  /** dream 控制面；未配置时相关路由返回明确原因，而不是 404。 */
  dream?: DreamRoutesApi;
}

/**
 * 注册读路由。带重试：webServer 未就绪时每秒重试，最长 20 秒。
 *
 * @returns 注销函数（幂等）
 */
export function registerVaultRoutes(
  ctx: Context,
  api: VaultApi,
  extras: VaultRoutesExtras = {},
): () => void {
  const disposers: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const routes = [
    {
      path: `${PREFIX}/overview`,
      handler: (_req: unknown, res: unknown) => writeJson(res, 200, api.overview()),
    },
    {
      path: `${PREFIX}/tree`,
      handler: (req: unknown, res: unknown) => {
        const space = query(req).get('space') ?? 'chat';
        const dir = resolveSpaceDir(api, space);
        if (!dir) return writeJson(res, 404, { ok: false, error: `unknown space: ${space}` });
        writeJson(res, 200, { ok: true, space, dir, tree: api.tree(dir) });
      },
    },
    {
      path: `${PREFIX}/file`,
      handler: (req: unknown, res: unknown) => {
        const q = query(req);
        const space = q.get('space') ?? 'chat';
        const rel = q.get('rel') ?? '';
        const dir = resolveSpaceDir(api, space);
        if (!dir) return writeJson(res, 404, { ok: false, error: `unknown space: ${space}` });
        const text = api.read(dir, rel);
        if (text === null) return writeJson(res, 404, { ok: false, error: `not found: ${rel}` });
        writeJson(res, 200, { ok: true, space, rel, text });
      },
    },
    {
      // 实体目录：供 UI 把正文里的 `[[X]]` 解析成可点击链接。
      // 返回 name → path 映射，而不是让前端去猜文件叫什么。
      path: `${PREFIX}/entities`,
      handler: (req: unknown, res: unknown) => {
        const space = query(req).get('space') ?? 'chat';
        const dir = resolveSpaceDir(api, space);
        if (!dir) return writeJson(res, 404, { ok: false, error: `unknown space: ${space}` });
        const entities = scanEntities(dir).map((e) => ({
          name: e.name,
          path: e.path,
          kind: e.kind,
          status: e.status,
          aliases: e.aliases,
        }));
        writeJson(res, 200, { ok: true, space, entities });
      },
    },
    {
      // 常驻记忆（A 层）：**只读**。
      //
      // 刻意没有写接口 —— 常驻记忆只能由 AI 通过 `mem_remember` / `mem_forget`
      // 工具修改，且只在用户明确要求时。把写入口收敛成工具、这里只留读，
      // 这条约束就由**结构**保证，而不是靠"约定别乱写"（同"隔离靠硬代码"的原则）。
      path: `${PREFIX}/instructions`,
      handler: (_req: unknown, res: unknown) => {
        writeJson(res, 200, { ok: true, ...readInstructions(api.sharedDir) });
      },
    },
    {
      // 工作区登记表：同样**只读**。
      // 改类型走 `mem_space` 工具（用户明确表态时）或直接手改文件 ——
      // 与常驻记忆同一条原则：写入口收敛，UI 只展示。
      path: `${PREFIX}/workspaces`,
      handler: (_req: unknown, res: unknown) => {
        if (extras.workspaceView === undefined) {
          return writeJson(res, 200, { ok: false, error: '工作区视图未配置' });
        }
        writeJson(res, 200, { ok: true, ...(extras.workspaceView() as Record<string, unknown>) });
      },
    },
    {
      // dream 控制面：会话右键菜单的「现在整理」与「跳过整理」。
      //
      // GET  → `{ skipped, pending, running }`（菜单打开时用来定标题与图标）
      // POST → `{ action: 'skip' | 'unskip' | 'run', sessionId, sessionIds? }`
      //
      // 没有任何"直接写记忆"的能力 —— 这里只动整理调度。
      path: `${PREFIX}/dream`,
      handler: (req: unknown, res: unknown) => {
        const dream = extras.dream;
        if (dream === undefined) {
          return writeJson(res, 200, { ok: false, error: 'dream 控制面未配置' });
        }
        const method = ((req as NodeReq).method ?? 'GET').toUpperCase();
        if (method === 'GET') {
          return writeJson(res, 200, { ok: true, ...dream.state() });
        }
        if (method !== 'POST') {
          return writeJson(res, 405, { ok: false, error: `method not allowed: ${method}` });
        }

        void (async () => {
          const body = await readJsonBody(req);
          const action = typeof body.action === 'string' ? body.action : '';
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';

          if (action === 'skip' || action === 'unskip') {
            if (sessionId === '') {
              return writeJson(res, 400, { ok: false, error: 'skip/unskip 需要 sessionId' });
            }
            try {
              const skipped = dream.setSkip(sessionId, action === 'skip');
              return writeJson(res, 200, { ok: true, skipped });
            } catch (e) {
              return writeJson(res, 500, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          if (action === 'run') {
            const asked = Array.isArray(body.sessionIds)
              ? body.sessionIds.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
              : [];
            const target = asked.length > 0 ? asked : sessionId !== '' ? [sessionId] : [];
            try {
              const out = dream.start(target);
              return writeJson(res, out.ok ? 200 : 409, out);
            } catch (e) {
              return writeJson(res, 500, {
                ok: false,
                started: false,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          return writeJson(res, 400, { ok: false, error: `unknown action: ${action}` });
        })();
      },
    },
  ];

  const tryRegister = (attempt: number): void => {
    if (stopped) return;
    const ws = (ctx as unknown as { get?: (n: string) => unknown }).get?.('webServer') as
      | RouteRegistrar
      | undefined;

    if (!ws || typeof ws.register !== 'function') {
      if (attempt >= 20) {
        ctx.logger.warn(
          `dsh-mem: webServer 服务 20s 内未就绪，记忆空间数据路由 ${PREFIX}/* 未注册`,
        );
        return;
      }
      timer = setTimeout(() => tryRegister(attempt + 1), 1000);
      return;
    }

    for (const route of routes) {
      try {
        const d = ws.register({ kind: 'exact', path: route.path, handler: route.handler });
        if (typeof d === 'function') disposers.push(d as () => void);
      } catch (e) {
        ctx.logger.warn(
          `dsh-mem: 路由 ${route.path} 注册失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    ctx.logger.info(`dsh-mem: 记忆空间数据路由已注册（${routes.length} 条，前缀 ${PREFIX}）`);
  };

  tryRegister(0);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch {
        /* 注销失败不阻塞其余 */
      }
    }
  };
}
