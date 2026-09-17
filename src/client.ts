/**
 * dsh-mem —— 客户端插件入口。
 *
 * 做两件事：
 *  1. 把「记忆空间」设置分区挂上去（数据从宿主路由 `/dsh-mem/*` 取，见 src/routes.ts）；
 *  2. 往会话右键菜单注入「现在整理记忆」/「跳过整理记忆」（见 src/client-dream-menu.ts）。
 *
 * inject 内含 'slots'（settings.section 由它提供）。
 */
import { installDreamMenu } from './client-dream-menu.js';
import { applySettingsPage } from './settings-page.js';

// 导出纯函数供测试（回归保护：YAML 的 `# 注释` 不得被当成 markdown 标题）
export { renderFileBody } from './settings-page.js';
// 菜单注入里能脱离 DOM 单测的部分：菜单项计划、fiber 取会话 id、注入的幂等性
export {
  dreamMenuPlan,
  injectDreamItems,
  readSessionIdFromRow,
  sessionIdFromTarget,
} from './client-dream-menu.js';

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

  try {
    // 菜单注入失败不能连累设置页 —— 两条链路互不相干，各自兜错。
    disposers.push(installDreamMenu(ctx));
  } catch (e) {
    ctx.logger?.warn(
      `[dsh-mem] 会话菜单注入失败: ${e instanceof Error ? e.message : String(e)}`,
    );
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
