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

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
