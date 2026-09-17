/**
 * 会话右键菜单注入：「现在整理」+「跳过整理」。
 *
 * 为什么走 DOM 注入而不是设置页列表：**用户在会话上想到的是"这场别整理 / 这场现在就整理"，
 * 这个动作天然属于那一行会话**。设置页里再列一遍会话名单，是同一件事换个更远的地方做。
 * （这是已经权衡过的选择，别再改成设置页方案。）
 *
 * 做法照搬参考实现验证过的路子，因为这个外壳没有给插件留菜单 API：
 *  1. 菜单是 React 渲染的，插件拿不到它 —— 只能**克隆菜单里已有的 `menuitem`** 改标题；
 *  2. 会话 id 不在 DOM 属性上，只能**顺着 React fiber 往上找一个字符串 `key`**；
 *  3. 菜单是**点开时挂载**的，所以用 `MutationObserver` 盯 `[role="menu"]`，
 *     并在 `pointerdown`（捕获阶段）记下"点的是哪一行"，因为菜单出现时那一行已经找不到了。
 *
 * 全部选择器都按 CSS Modules 的**类名后缀**匹配（`_sessionRow` / `_rowActions` / `_menuOpen`），
 * 这是外壳的稳定部分；`[role=...]` 是 ARIA 语义，比类名更稳。
 */

const ITEM_ATTR = 'data-dshmem-dream-item';
const SID_ATTR = 'data-dshmem-session-id';

/** 会话行上的「…」按钮容器 —— 用它的存在确认"点的确实是会话行上的操作区"。 */
const ROW_ACTIONS_SEL = '[class*="_rowActions"]';
const SESSION_ROW_SEL = '[role="treeitem"][class*="_sessionRow"]';
/** 菜单打开时那一行会被加上 `_menuOpen`，这是**唯一能反查"菜单属于哪一行"的信号**。 */
const MENU_OPEN_ROW_SEL = '[role="treeitem"][class*="_sessionRow"][class*="_menuOpen"]';
const MENU_SEL = '[role="menu"]';
const MENU_ITEM_SEL = '[role="menuitem"]';

/** pointerdown 记下的行，最多等这么久；超时就不认（避免误挂到别的行的菜单上）。 */
const MENU_WINDOW_MS = 1500;

/** React 挂在 DOM 节点上的内部键。 */
const FIBER_KEY_RE = /^__reactFiber\$/;

const ICON_RUN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>';

const ICON_SKIP =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

const ICON_UNSKIP =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

export interface DreamMenuItemPlan {
  /** 稳定标识，同时用作 `ITEM_ATTR` 的值。 */
  key: 'run' | 'toggle';
  label: string;
  icon: string;
}

/**
 * 该往菜单里放哪几项。
 *
 * 纯函数（不碰 DOM）—— 冒烟测试直接断言它。
 * **「现在整理」与「跳过整理」是并列的两个动作，不是互斥开关**：
 * 被跳过的会话手动「现在整理」照样整理（跳过名单只挡自动整理）。
 */
export function dreamMenuPlan(skipped: boolean): DreamMenuItemPlan[] {
  return [
    { key: 'run', label: '现在整理记忆', icon: ICON_RUN },
    {
      key: 'toggle',
      label: skipped ? '取消跳过整理记忆' : '跳过整理记忆',
      icon: skipped ? ICON_UNSKIP : ICON_SKIP,
    },
  ];
}

/**
 * 顺着 React fiber 往上找一个非空字符串 `key` —— 那就是会话 id。
 *
 * 为什么要这么绕：会话 id 不在任何 DOM 属性里，而外壳的 React 会把 `key`
 * 挂在 fiber 节点上，逐级往上找总能碰到（实测在 8 层内）。
 */
export function readSessionIdFromRow(row: unknown): string | null {
  if (row === null || typeof row !== 'object') return null;
  const rec = row as Record<string, unknown>;
  let fiber: unknown = null;
  for (const key of Object.keys(rec)) {
    if (FIBER_KEY_RE.test(key)) {
      fiber = rec[key];
      break;
    }
  }
  let cur = fiber as { key?: unknown; return?: unknown } | null;
  for (let depth = 0; depth < 8 && cur !== null && cur !== undefined; depth += 1) {
    if (typeof cur.key === 'string' && cur.key.length > 0) return cur.key;
    cur = (cur.return ?? null) as { key?: unknown; return?: unknown } | null;
  }
  return null;
}

interface ElementLike {
  closest(sel: string): ElementLike | null;
  querySelector(sel: string): ElementLike | null;
  querySelectorAll(sel: string): ArrayLike<ElementLike>;
  appendChild(node: ElementLike): unknown;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  remove(): void;
  addEventListener(type: string, fn: (e: unknown) => void, capture?: boolean): void;
  cloneNode(deep: boolean): ElementLike;
  textContent: string | null;
  outerHTML: string;
  children: ArrayLike<ElementLike>;
  matches(sel: string): boolean;
}

/** 从被点的元素反查会话 id：必须是会话行「…」按钮里的元素。 */
export function sessionIdFromTarget(target: unknown): string | null {
  const el = target as ElementLike | null;
  if (el === null || el === undefined || typeof el.closest !== 'function') return null;
  if (el.closest(ROW_ACTIONS_SEL) === null) return null;
  const row = el.closest(SESSION_ROW_SEL);
  if (row === null) return null;
  return readSessionIdFromRow(row);
}

/** 把标题写到最深的那层叶子节点上（菜单项的文字包在嵌套 span 里）。 */
function retitleLeaf(root: ElementLike, text: string): boolean {
  let leaf: ElementLike | null = null;
  const walk = (el: ElementLike): void => {
    let hasElementChild = false;
    const kids = el.children;
    for (let i = 0; i < kids.length; i += 1) {
      hasElementChild = true;
      walk(kids[i] as ElementLike);
    }
    if (!hasElementChild && (el.textContent ?? '').trim().length > 0) leaf = el;
  };
  walk(root);
  if (leaf === null) return false;
  (leaf as ElementLike).textContent = text;
  return true;
}

function setIcon(item: ElementLike, svg: string): void {
  const icon = item.querySelector('svg');
  if (icon !== null) icon.outerHTML = svg;
}

export interface DreamMenuHost {
  /** 读当前跳过名单（同步，来自本地缓存）。 */
  isSkipped(sessionId: string): boolean;
  /** 跳过一次；失败时调 rollback 让 UI 回滚。 */
  toggle(sessionId: string, next: boolean, rollback: () => void): void;
  /** 现在整理这一场。 */
  run(sessionId: string): void;
}

/** 往一个已打开的菜单里注入两项。返回是否注入了。 */
export function injectDreamItems(
  menu: ElementLike,
  sessionId: string,
  host: DreamMenuHost,
): boolean {
  // ★ 已经为这一场注入过 → 直接返回。
  //
  // 这一步**不是优化，是防死循环**：我们往菜单里加节点这件事本身就会触发
  // MutationObserver，如果每次都"先删旧项、再插新项"，就会
  // 删→触发→插→触发→删… 无限转下去。顺手清掉属于**别的会话**的残留
  // （菜单被复用到另一行时才会出现）。
  const existing = menu.querySelectorAll(`[${ITEM_ATTR}]`);
  let alreadyInjected = false;
  for (let i = 0; i < existing.length; i += 1) {
    const el = existing[i] as ElementLike;
    if (el.getAttribute(SID_ATTR) === sessionId) alreadyInjected = true;
    else el.remove();
  }
  if (alreadyInjected) return true;

  const template = menu.querySelector(MENU_ITEM_SEL);
  if (template === null) return false;

  const skipped = host.isSkipped(sessionId);
  for (const plan of dreamMenuPlan(skipped)) {
    const item = template.cloneNode(true) as ElementLike;
    // 克隆出来的节点带着模板的 id，必须清掉，否则菜单里会出现重复 id。
    item.removeAttribute('id');
    const withId = item.querySelectorAll('[id]');
    for (let i = 0; i < withId.length; i += 1) (withId[i] as ElementLike).removeAttribute('id');
    item.setAttribute('role', 'menuitem');
    item.setAttribute(ITEM_ATTR, plan.key);
    item.setAttribute(SID_ATTR, sessionId);
    if (!retitleLeaf(item, plan.label)) return false;
    setIcon(item, plan.icon);

    item.addEventListener(
      'click',
      (e: unknown) => {
        const ev = e as { stopPropagation?: () => void; preventDefault?: () => void };
        ev.stopPropagation?.();
        ev.preventDefault?.();
        if (plan.key === 'run') {
          host.run(sessionId);
          return;
        }
        const next = !host.isSkipped(sessionId);
        host.toggle(sessionId, next, () => {
          /* 回滚由 host 负责重绘，这里不用做 */
        });
        // 就地改标题与图标，省得等菜单重开（也不重新插节点，避免触发 observer）
        const now = dreamMenuPlan(next);
        retitleLeaf(item, now[1]!.label);
        setIcon(item, now[1]!.icon);
      },
      true,
    );
    // 不让 pointerdown 冒到行上（否则会触发整行的点击/拖拽）
    item.addEventListener('pointerdown', (e: unknown) => {
      (e as { stopPropagation?: () => void }).stopPropagation?.();
    });
    menu.appendChild(item);
  }
  return true;
}

interface ClientCtx {
  logger?: { info(m: string): void; warn(m: string): void };
}

/** `fetch` 的最小形状（测试时可以不提供，注入器整体降级为"只读本地缓存"）。 */
interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; cache?: string }): Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>;
}

export interface InstallDeps {
  doc?: Document;
  fetchImpl?: FetchLike;
  base?: string;
}

/**
 * 装上菜单注入。返回卸载函数（disconnect observer + 摘掉监听 + 清掉注入过的项）。
 */
export function installDreamMenu(ctx: ClientCtx, deps: InstallDeps = {}): () => void {
  const doc = deps.doc ?? (globalThis as { document?: Document }).document;
  const doFetch = deps.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  const base = deps.base ?? '/dsh-mem/dream';

  if (doc === undefined) return () => undefined;
  const body = (doc as unknown as { body?: ElementLike }).body;
  if (body === undefined || body === null) return () => undefined;

  const skipped = new Set<string>();
  let pendingSid: string | null = null;
  let pendingAt = 0;
  let debounce = 0;
  let observer: { disconnect(): void; observe(t: unknown, o: unknown): void } | null = null;

  const readSkipped = (sid: string): boolean => skipped.has(sid);

  const toggle = (sessionId: string, next: boolean, rollback: () => void): void => {
    if (next) skipped.add(sessionId);
    else skipped.delete(sessionId);
    if (doFetch === undefined) return;
    void (async () => {
      try {
        const resp = await doFetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: next ? 'skip' : 'unskip', sessionId }),
        });
        if (!resp.ok) throw new Error(String(resp.ok));
      } catch {
        // 服务端没落库就回滚本地状态，绝不留下"看着关了其实没关"的假象
        if (next) skipped.delete(sessionId);
        else skipped.add(sessionId);
        rollback();
        ctx.logger?.warn(`dsh-mem: 跳过整理写库失败，已回滚（${sessionId.slice(0, 8)}）`);
      }
    })();
  };

  const run = (sessionId: string): void => {
    if (doFetch === undefined) return;
    void (async () => {
      try {
        await doFetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'run', sessionId }),
        });
      } catch {
        ctx.logger?.warn(`dsh-mem: 「现在整理」请求失败（${sessionId.slice(0, 8)}）`);
      }
    })();
  };

  const host: DreamMenuHost = { isSkipped: readSkipped, toggle, run };

  const resolveMenuSessionId = (): string | null => {
    const withinWindow = pendingSid !== null && Date.now() - pendingAt <= MENU_WINDOW_MS;
    const openRow = (doc as unknown as { querySelector(s: string): ElementLike | null }).querySelector(
      MENU_OPEN_ROW_SEL,
    );
    if (openRow === null) return null;
    const sid = readSessionIdFromRow(openRow);
    return sid ?? (withinWindow ? pendingSid : null);
  };

  const syncOpenMenus = (): void => {
    const sid = resolveMenuSessionId();
    if (sid === null) return;
    const menus = (doc as unknown as { querySelectorAll(s: string): ArrayLike<ElementLike> }).querySelectorAll(
      MENU_SEL,
    );
    for (let i = 0; i < menus.length; i += 1) {
      const menu = menus[i] as ElementLike;
      // 同一个菜单重复注入会堆叠，先清掉我们自己的旧项
      const old = menu.querySelectorAll(`[${ITEM_ATTR}]`);
      for (let j = 0; j < old.length; j += 1) (old[j] as ElementLike).remove();
      injectDreamItems(menu, sid, host);
    }
  };

  const onPointerDown = (e: unknown): void => {
    const sid = sessionIdFromTarget((e as { target?: unknown }).target);
    if (sid === null) return;
    pendingSid = sid;
    pendingAt = Date.now();
  };

  const refresh = (): void => {
    if (doFetch === undefined) return;
    void (async () => {
      try {
        const resp = await doFetch(base, { cache: 'no-store' });
        if (!resp.ok) return;
        const data = (await resp.json()) as { skipped?: unknown };
        skipped.clear();
        if (Array.isArray(data.skipped)) {
          for (const id of data.skipped) if (typeof id === 'string') skipped.add(id);
        }
      } catch {
        /* 读不到就按"都没跳过"显示，写的时候服务端才是权威 */
      }
    })();
  };

  const MutationObserverCtor = (globalThis as { MutationObserver?: new (cb: () => void) => {
    observe(t: unknown, o: unknown): void;
    disconnect(): void;
  } }).MutationObserver;

  if (MutationObserverCtor !== undefined) {
    observer = new MutationObserverCtor(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(syncOpenMenus, 120) as unknown as number;
    });
    observer.observe(body, { childList: true, subtree: true });
  }

  (doc as unknown as { addEventListener(t: string, f: (e: unknown) => void, c?: boolean): void }).addEventListener(
    'pointerdown',
    onPointerDown,
    true,
  );
  refresh();

  return () => {
    observer?.disconnect();
    if (debounce) clearTimeout(debounce);
    (doc as unknown as { removeEventListener(t: string, f: (e: unknown) => void, c?: boolean): void }).removeEventListener(
      'pointerdown',
      onPointerDown,
      true,
    );
    const leftovers = (doc as unknown as { querySelectorAll(s: string): ArrayLike<ElementLike> }).querySelectorAll(
      `[${ITEM_ATTR}]`,
    );
    for (let i = 0; i < leftovers.length; i += 1) (leftovers[i] as ElementLike).remove();
  };
}
