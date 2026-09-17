/**
 * 客户端 bundle 的冒烟测试。
 *
 * lib/client.js 是 `window.__ModuleLoader__.load({id, factory})` 格式的 CJS 包，
 * 所以这里造一个最小的 ModuleLoader + React 桩，把 factory 跑起来，
 * 然后直接调用导出的纯渲染函数做断言。
 *
 * 重点回归保护：**YAML 的 `# 注释` 不得被当成 markdown 标题**。
 * 这个 bug 真实发生过 —— 记忆空间里打开 sections.yaml，整个文件被渲染成巨大的 <h1>。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let failures = 0;
function check(label, cond, detail = '') {
  const mark = cond ? '✅' : '❌';
  if (!cond) failures++;
  console.log(`  ${mark} ${label}${detail ? `  ${detail}` : ''}`);
}

// ---- 最小 React 桩：createElement 返回可断言的普通对象 ----
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  useMemo: (f) => f(),
  useRef: (v) => ({ current: v }),
};
React.__esModule = true;
React.default = React;

// ---- 最小 ModuleLoader 桩：捕获 factory 并执行 ----
let mod = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      mod = { id, exports: factory((name) => (name === 'react' ? React : require(name))) };
    },
  },
};
globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} } };

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'document', code)(globalThis.window, globalThis.document);

console.log('=== 客户端 bundle 冒烟测试 ===\n');

check('ModuleLoader 注册的 id 为 dsh-mem', mod?.id === 'dsh-mem', mod?.id);
check('导出了 apply', typeof mod?.exports?.apply === 'function');
check('导出了 inject', Array.isArray(mod?.exports?.inject));
check('inject 含 slots', mod?.exports?.inject?.includes('slots'));
check('导出了 renderFileBody', typeof mod?.exports?.renderFileBody === 'function');

const { renderFileBody } = mod.exports;

// ---- 1. YAML 必须走纯文本 ----
console.log('\n=== 1. 非 markdown 文件按纯文本渲染（回归保护）===');
const yaml = '# 聊天空间的 section 定义\n#\n# 这里定义"聊天记忆都整理哪些东西"\nsections:\n  - name: 价值观与人生观\n';
const yamlOut = renderFileBody('sections.yaml', yaml);
check('sections.yaml → <pre>', yamlOut?.type === 'pre', String(yamlOut?.type));
check('sections.yaml 用了 dshmem_plain 样式', yamlOut?.props?.className === 'dshmem_plain');
check('sections.yaml 未产生任何 h1', !JSON.stringify(yamlOut).includes('"h1"'));

const jsonOut = renderFileBody('data.json', '{\n  "a": 1\n}\n');
check('data.json → <pre>', jsonOut?.type === 'pre');

const txtOut = renderFileBody('notes.txt', '# not a heading\n');
check('notes.txt → <pre>', txtOut?.type === 'pre');

// ---- 2. markdown 仍按 markdown 渲染（正向对照）----
console.log('\n=== 2. markdown 仍正常渲染（正向对照）===');
const mdOut = renderFileBody('README.md', '# 标题\n\n正文 **粗体** 与 `code`\n\n- 项一\n- 项二\n');
check('README.md → <div class=dshmem_md>', mdOut?.type === 'div' && mdOut?.props?.className === 'dshmem_md');
const flat = JSON.stringify(mdOut);
check('README.md 产生了 h1', flat.includes('"h1"'));
check('README.md 产生了 ul', flat.includes('"ul"'));
check('.markdown 后缀同样识别', renderFileBody('a.markdown', '# T\n')?.type === 'div');

// ---- 3. 行内元素 ----
console.log('\n=== 3. 行内渲染 ===');
const inlineOut = JSON.stringify(renderFileBody('x.md', '有 **粗体** 和 `代码`\n'));
check('解析出 strong', inlineOut.includes('"strong"'));
check('解析出 code', inlineOut.includes('"code"'));

// ---- 4. [[实体]] 渲染成可点击链接 ----
console.log('\n=== 4. [[实体]] → 可点击链接 ===');
const clicked = [];
const linkOut = renderFileBody('s.md', '他提到的 [[攀岩项目]] 和 [[意识之镜]] 都在这。\n', (n) => clicked.push(n));
const linkFlat = JSON.stringify(linkOut);
check('渲染出 a 元素', linkFlat.includes('"a"'));
check('用了 dshmem_link 样式', linkFlat.includes('dshmem_link'));
check('链接显示实体名', linkFlat.includes('攀岩项目') && linkFlat.includes('意识之镜'));
check('方括号没留在文本里', !linkFlat.includes('[['), linkFlat.slice(0, 120));

/** 找到所有 a 元素（stub createElement 产出的是普通对象）。 */
const anchors = [];
const walk = (n) => {
  if (!n || typeof n !== 'object') return;
  if (n.type === 'a') anchors.push(n);
  for (const c of n.children ?? []) walk(c);
};
walk(linkOut);
check('解析出 2 个链接', anchors.length === 2, String(anchors.length));
anchors[0]?.props?.onClick?.();
check('点击回调带出实体名', clicked[0] === '攀岩项目', JSON.stringify(clicked));

// 列表里的链接也要能点（不能只处理段落）
const listLink = renderFileBody('s.md', '- 相关：[[高斯泼溅]]\n');
check('列表项里的链接同样渲染', JSON.stringify(listLink).includes('dshmem_link'));

// 没有回调时不应崩（只读场景）
check('无回调时也能渲染', (() => { try { renderFileBody('s.md', '见 [[X]]\n'); return true; } catch { return false; } })());

// ---- 5. 空内容不炸 ----
console.log('\n=== 5. 边界 ===');
check('空字符串不抛错', (() => { try { renderFileBody('a.md', ''); return true; } catch { return false; } })());
check('未闭合代码块不抛错', (() => { try { renderFileBody('a.md', '```js\nlet x=1'); return true; } catch { return false; } })());

// ---- 6. 会话右键菜单：菜单项计划 ----
// 这里只测**能脱离 DOM 的部分**。真正的 DOM 注入（克隆 menuitem、MutationObserver）
// 依赖外壳的 React 渲染，只能在真机点一次验证；纯逻辑部分全部在这里锁住。
console.log('\n=== 6. 会话右键菜单的菜单项 ===');
const { dreamMenuPlan, readSessionIdFromRow, sessionIdFromTarget } = mod.exports;

const planOff = dreamMenuPlan(false);
check('未跳过 → 两项', planOff.length === 2, String(planOff.length));
check('第一项是「现在整理」', planOff[0].key === 'run' && planOff[0].label === '现在整理记忆', planOff[0].label);
check('第二项是「跳过整理」', planOff[1].key === 'toggle' && planOff[1].label === '跳过整理记忆', planOff[1].label);
check('两项各自带 svg 图标', planOff.every((p) => p.icon.startsWith('<svg')));

const planOn = dreamMenuPlan(true);
check('已跳过 → 第二项变「取消跳过」', planOn[1].label === '取消跳过整理记忆', planOn[1].label);
check('已跳过时「现在整理」仍在（跳过名单只挡自动整理）', planOn[0].label === '现在整理记忆');
check('两种状态的图标不同', planOn[1].icon !== planOff[1].icon);

// ---- 7. 会话 id 提取（顺 React fiber 往上找字符串 key）----
console.log('\n=== 7. 会话 id 提取 ===');
const fiberRow = { __reactFiber$abc123: { key: null, return: { key: 'session-1c4b2f55-aaaa' } } };
check('顺 fiber 往上取到 id', readSessionIdFromRow(fiberRow) === 'session-1c4b2f55-aaaa', String(readSessionIdFromRow(fiberRow)));
check('第一层就有 key 也能取到', readSessionIdFromRow({ __reactFiber$x: { key: 'session-zzz' } }) === 'session-zzz');
check('fiber 里没有字符串 key → null', readSessionIdFromRow({ __reactFiber$x: { key: 1, return: { key: 2 } } }) === null);
check('没有 fiber → null', readSessionIdFromRow({}) === null);
check('非对象不抛错', readSessionIdFromRow(null) === null && readSessionIdFromRow(undefined) === null);
check('fiber 链有环也不死循环', readSessionIdFromRow((() => { const f = { key: null }; f.return = f; return { __reactFiber$c: f }; })()) === null);

const fakeRow = { __reactFiber$z: { key: 'session-deadbeef-1111' } };
const onRowActions = {
  closest(sel) {
    if (sel.includes('_rowActions')) return {};
    if (sel.includes('_sessionRow')) return fakeRow;
    return null;
  },
};
check('点会话行「…」→ 取到 id', sessionIdFromTarget(onRowActions) === 'session-deadbeef-1111', String(sessionIdFromTarget(onRowActions)));
check('点的地方不在「…」按钮里 → null', sessionIdFromTarget({ closest: () => null }) === null);
check('目标非元素不抛错', sessionIdFromTarget(null) === null && sessionIdFromTarget(42) === null);

// ---- 8. 菜单注入：幂等（防 MutationObserver 自激）----
// ★ 这一节锁的是一个真实踩过的坑：往菜单里加节点本身会触发 observer，
//   若"先删旧项再插新项"，就会 删→触发→插→触发 无限转。所以必须幂等。
console.log('\n=== 8. 菜单注入：幂等与点击行为 ===');
const { injectDreamItems } = mod.exports;
const ITEM_ATTR = 'data-dshmem-dream-item';
const SID_ATTR = 'data-dshmem-session-id';

/** 迷你 DOM 桩：只实现 injectDreamItems 用到的那几个方法。 */
function makeEl(tag) {
  const attrs = {};
  const kids = [];
  const el = {
    tag,
    children: kids,
    textContent: '',
    outerHTML: '',
    listeners: {},
    parent: null,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    remove() { const i = el.parent?.children.indexOf(el) ?? -1; if (i >= 0) el.parent.children.splice(i, 1); },
    addEventListener(t, fn) { (el.listeners[t] ??= []).push(fn); },
    appendChild(n) { n.parent = el; kids.push(n); return n; },
    matches(sel) { return matchesSel(el, sel); },
    querySelector(sel) { return queryAll(el, sel)[0] ?? null; },
    querySelectorAll(sel) { return queryAll(el, sel); },
    cloneNode() {
      const c = makeEl(tag);
      c.textContent = el.textContent;
      c.outerHTML = el.outerHTML;
      for (const k of Object.keys(attrs)) c.setAttribute(k, attrs[k]);
      for (const kid of kids) c.appendChild(kid.cloneNode(true));
      return c;
    },
  };
  return el;
}
function matchesSel(el, sel) {
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const body = sel.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) return el.getAttribute(body) !== null;
    const k = body.slice(0, eq);
    const v = body.slice(eq + 1).replace(/^"|"$/g, '');
    return el.getAttribute(k) === v;
  }
  return el.tag === sel;
}
function queryAll(root, sel) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (matchesSel(c, sel)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}
/** 一个菜单：里面有一个模板 menuitem（文字 span + svg）。 */
function buildMenu() {
  const menu = makeEl('div');
  const tpl = makeEl('div');
  tpl.setAttribute('role', 'menuitem');
  const span = makeEl('span');
  span.textContent = '重命名';
  const svg = makeEl('svg');
  svg.outerHTML = '<svg id="tpl-icon"></svg>';
  tpl.appendChild(span);
  tpl.appendChild(svg);
  menu.appendChild(tpl);
  return { menu, span };
}

const calls = [];
const host = {
  isSkipped: () => false,
  toggle: (sid, next) => calls.push(['toggle', sid, next]),
  run: (sid) => calls.push(['run', sid]),
};

const b1 = buildMenu();
injectDreamItems(b1.menu, 'session-1', host);
const first = b1.menu.querySelectorAll(`[${ITEM_ATTR}]`).length;
injectDreamItems(b1.menu, 'session-1', host);
const second = b1.menu.querySelectorAll(`[${ITEM_ATTR}]`).length;
check('首次注入 2 项', first === 2, String(first));
check('★ 重复注入不翻倍（否则 observer 自激死循环）', second === 2, String(second));

const b2 = buildMenu();
injectDreamItems(b2.menu, 'session-9', host);
const items = b2.menu.querySelectorAll(`[${ITEM_ATTR}]`);
check('第一项标记为 run', items[0]?.getAttribute(ITEM_ATTR) === 'run');
check('第二项标记为 toggle', items[1]?.getAttribute(ITEM_ATTR) === 'toggle');
check('两项都带会话 id', items.every((i) => i.getAttribute(SID_ATTR) === 'session-9'));
check('克隆的模板项不再是模板（id 已清）', !JSON.stringify(items.map((i) => i.outerHTML)).includes('tpl-icon'));

items[0].listeners.click[0]({ stopPropagation() {}, preventDefault() {} });
check('点「现在整理」→ 调 run 且带会话 id', calls[0]?.[0] === 'run' && calls[0]?.[1] === 'session-9', JSON.stringify(calls));

items[1].listeners.click[0]({ stopPropagation() {}, preventDefault() {} });
check('点「跳过整理」→ 调 toggle(true)', calls[1]?.[0] === 'toggle' && calls[1]?.[2] === true, JSON.stringify(calls));
check('点完就地改成「取消跳过整理记忆」', items[1].querySelector('span')?.textContent === '取消跳过整理记忆', items[1].querySelector('span')?.textContent);

// 菜单被复用到另一行时，旧项要被清掉
injectDreamItems(b2.menu, 'session-other', host);
const swapped = b2.menu.querySelectorAll(`[${ITEM_ATTR}]`);
check('换一场会话 → 清掉旧项、只留新的', swapped.length === 2 && swapped[0].getAttribute(SID_ATTR) === 'session-other', `${swapped.length}`);

check('菜单里没有 menuitem 模板时安全返回', (() => {
  const empty = makeEl('div');
  try { return injectDreamItems(empty, 's', host) === false; } catch { return false; }
})());

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
