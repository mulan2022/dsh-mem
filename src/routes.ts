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
}
interface NodeRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
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
 * 路由之外的只读视图提供者。
 *
 * 让 routes.ts 不必知道"工作区怎么判定"—— 那是 workspaces.ts 的事。
 * 这里只负责把它读出来给 UI。
 */
export interface VaultRoutesExtras {
  /** 工作区登记视图（只读）。 */
  workspaceView?: () => unknown;
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
