/**
 * dsh-mem —— 客户端插件入口。
 *
 * 只做一件事：把「记忆空间」设置分区挂上去。
 * 数据从宿主路由 `/dsh-mem/*` 取（见 src/routes.ts）。
 *
 * inject 内含 'slots'（settings.section 由它提供）。
 */
import { applySettingsPage } from './settings-page.js';

// 导出纯渲染函数供测试（回归保护：YAML 的 `# 注释` 不得被当成 markdown 标题）
export { renderFileBody } from './settings-page.js';

export const name = 'dsh-mem';

export const inject = ['slots'];

interface ClientCtx {
  slots: {
    inject(name: string, cb: () => unknown): () => void;
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
  logger?: { info(m: string): void; warn(m: string): void };
}

export function apply(ctx: ClientCtx): () => void {
  const disposers: Array<() => void> = [];

  try {
    disposers.push(applySettingsPage(ctx));
    ctx.logger?.info('[dsh-mem] client plugin loaded');
  } catch (e) {
    ctx.logger?.warn(`[dsh-mem] client plugin 初始化失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  return () => {
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch {
        /* 卸载失败不阻塞其余 */
      }
    }
  };
}
