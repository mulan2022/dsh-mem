/**
 * dsh-mem —— 记忆空间 UI（设置页顶级分区）。
 *
 * 形态照搬参考实现验证过的契约：
 *  - `ctx.slots.inject('settings.section', () => ctx.slots.register({name, id, order, label, inject}, Component))`
 *    顶级分区，与「通用」「模型」「插件」平级；label 直接返回中文
 *    （第三方 locale 字典在官方外壳没有席位）。
 *  - CSS 以 `<style data-plugin-css=...>` 注入一次，靠该属性防重复。
 *  - 数据从宿主路由取：`GET /dsh-mem/overview|tree|file`。
 *
 * 前端两条踩坑（设计文档 §8）：
 *  1. 只追加/只移除自有节点，绝不 replaceChildren 整个 slot
 *     —— 那会让 React 的 removeChild 抛 NotFoundError 并卸载整棵错误边界内的树。
 *  2. 自有 DOM 打 `data-dsh-mem-*` 标记，移除路径只认自己的标记。
 *  本组件走 React 渲染路径（不是直接操作别人的 slot DOM），天然规避第 1 条。
 */
import * as React from 'react';

const CSS_ID = 'dsh-mem-settings-css';
const SECTION_ID = 'dsh-mem';

const CSS = `
.dshmem_page{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:10px;max-width:860px;padding:4px 0}
.dshmem_title{font-size:14px;font-weight:600;margin:0}
.dshmem_bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshmem_tab{background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11.5px;padding:3px 9px}
.dshmem_tab:hover{border-color:var(--dsw-alias-border-l2);color:inherit}
.dshmem_tab_on{background:color-mix(in srgb,currentColor 8%,transparent);border-color:var(--dsw-alias-border-l2);color:inherit;font-weight:600}
.dshmem_card{background:color-mix(in srgb,currentColor 3%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:10px;display:flex;gap:0;min-height:420px;overflow:hidden}
.dshmem_tree{flex:0 0 200px;border-right:1px solid var(--dsw-alias-border-l3);overflow:auto;padding:8px 4px}
.dshmem_body{flex:1;min-width:0;overflow:auto;padding:12px 14px}
.dshmem_row{align-items:center;border-radius:6px;cursor:pointer;display:flex;gap:6px;font-size:12px;line-height:20px;padding:2px 8px;white-space:nowrap}
.dshmem_row:hover{background:color-mix(in srgb,currentColor 6%,transparent)}
.dshmem_row_on{background:color-mix(in srgb,currentColor 10%,transparent);font-weight:600}
.dshmem_dir{color:var(--dsw-alias-label-secondary)}
.dshmem_caret{color:var(--dsw-alias-label-caption);flex:none;font-size:10px;width:10px}
.dshmem_md{font-size:12px;line-height:1.7}
/* 前缀 .dshmem_page 提高特异性，压过外壳自带的标题样式 */
.dshmem_page .dshmem_md h1{font-size:14px;font-weight:600;margin:12px 0 6px}
.dshmem_page .dshmem_md h2{font-size:13px;font-weight:600;margin:10px 0 5px}
.dshmem_page .dshmem_md h3{font-size:12.5px;font-weight:600;margin:8px 0 4px}
.dshmem_md p{margin:5px 0}
.dshmem_md li{margin:2px 0}
.dshmem_md code{background:color-mix(in srgb,currentColor 8%,transparent);border-radius:4px;font-family:ui-monospace,monospace;font-size:11px;padding:1px 4px}
.dshmem_md pre{background:color-mix(in srgb,currentColor 6%,transparent);border-radius:8px;font-family:ui-monospace,monospace;font-size:11px;overflow:auto;padding:10px}
.dshmem_md blockquote{border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);margin:5px 0;padding-left:10px}
.dshmem_md hr{border:0;border-top:1px solid var(--dsw-alias-border-l3);margin:10px 0}
/* [[实体]] 链接：点进去就是那一页（注意本注释在 JS 模板字符串里，不能用反引号） */
.dshmem_link{border-bottom:1px dashed color-mix(in srgb,#60a5fa 45%,transparent);color:#60a5fa;cursor:pointer}
.dshmem_link:hover{border-bottom-style:solid;color:#93c5fd}
/* 非 markdown 文件（.yaml / .json / …）按【纯文本】渲染。
   否则 YAML 的 "# 注释" 会被 markdown 当成标题，整个文件被渲染成巨大字号。 */
.dshmem_plain{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,monospace;font-size:11px;line-height:1.6;margin:0;overflow:auto;white-space:pre-wrap;word-break:break-word}
.dshmem_err{color:#f43f5e;font-size:12px;margin:0}
.dshmem_muted{color:var(--dsw-alias-label-caption);font-size:12px}
.dshmem_path{color:var(--dsw-alias-label-caption);font-family:ui-monospace,monospace;font-size:11px;margin:0 0 8px}
/* 常驻记忆面板 */
.dshmem_ins_hint{color:var(--dsw-alias-label-caption);font-size:11.5px;line-height:1.6;margin:0 0 8px}
.dshmem_ins_add{display:flex;gap:6px;margin-bottom:10px}
.dshmem_ins_input{background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;color:inherit;flex:1;font-size:12px;min-width:0;padding:5px 9px}
.dshmem_ins_input:focus{border-color:var(--dsw-alias-border-l2);outline:none}
.dshmem_ins_btn{background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:5px 12px;white-space:nowrap}
.dshmem_ins_btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:inherit}
.dshmem_ins_btn:disabled{cursor:not-allowed;opacity:.45}
.dshmem_ins_list{display:flex;flex-direction:column;gap:4px;list-style:none;margin:0;padding:0}
.dshmem_ins_item{align-items:flex-start;background:color-mix(in srgb,currentColor 4%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;display:flex;font-size:12px;gap:8px;line-height:1.6;padding:7px 9px}
.dshmem_ins_idx{color:var(--dsw-alias-label-caption);flex:none;font-size:11px;min-width:16px;text-align:right}
.dshmem_ins_text{flex:1;min-width:0;word-break:break-word}
.dshmem_ins_del{background:transparent;border:0;color:var(--dsw-alias-label-caption);cursor:pointer;flex:none;font-size:14px;line-height:1;padding:0 2px}
.dshmem_ins_del:hover{color:#f43f5e}
.dshmem_ins_count{color:var(--dsw-alias-label-caption);font-size:11.5px;margin:0 0 6px}
.dshmem_ins_warn{color:#f59e0b;font-size:11.5px;margin:0 0 6px}
`;

const el = React.createElement;

// ── 数据获取 ────────────────────────────────────────────────────────────────

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return (await r.json()) as T;
}

interface Overview {
  home: string;
  memRoot: string;
  chat: { dir: string; entries: number };
  projects: Array<{ key: string; dir: string; entries: number }>;
  indexEntries: number;
}

interface TreeNode {
  path: string;
  name: string;
  type: 'dir' | 'file';
  children?: TreeNode[];
}

// ── 极简 markdown 渲染 ──────────────────────────────────────────────────────
// 刻意不引 markdown 库：记忆空间里的文件是我们自己生成的，格式可控。
// 只处理标题 / 列表 / 代码块 / 引用 / 分隔线 / 行内 code 与粗体，**以及 `[[双链]]`**。

/** 点击 `[[实体名]]` 时的回调。 */
export type EntityLinkHandler = (name: string) => void;

function inline(text: string, keyBase: string, onEntity?: EntityLinkHandler): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // `[[X]]` 与行内格式并列解析 —— 它渲染成可点击链接，点进去就是那一页
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('[[')) {
      const name = tok.slice(2, -2).trim();
      out.push(
        el(
          'a',
          {
            key: `${keyBase}-e${i++}`,
            className: 'dshmem_link',
            title: `打开实体：${name}`,
            onClick: onEntity ? () => onEntity(name) : undefined,
          },
          name,
        ),
      );
    } else if (tok.startsWith('**')) {
      out.push(el('strong', { key: `${keyBase}-b${i++}` }, tok.slice(2, -2)));
    } else {
      out.push(el('code', { key: `${keyBase}-c${i++}` }, tok.slice(1, -1)));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(text: string, onEntity?: EntityLinkHandler): React.ReactNode[] {
  const lines = text.split(/\r?\n/);
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  let code: string[] | null = null;

  const flushList = () => {
    if (!list.length) return;
    out.push(
      el(
        'ul',
        { key: `ul${out.length}` },
        ...list.map((t, i) => el('li', { key: i }, ...inline(t, `li${out.length}-${i}`, onEntity))),
      ),
    );
    list = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (code === null) {
        flushList();
        code = [];
      } else {
        out.push(el('pre', { key: `pre${out.length}` }, code.join('\n')));
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      out.push(el(`h${h[1].length}`, { key: `h${out.length}` }, ...inline(h[2], `h${out.length}`, onEntity)));
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      flushList();
      out.push(el('hr', { key: `hr${out.length}` }));
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushList();
      out.push(
        el(
          'blockquote',
          { key: `bq${out.length}` },
          ...inline(line.replace(/^>\s?/, ''), `bq${out.length}`, onEntity),
        ),
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ''));
      continue;
    }
    if (!line.trim()) {
      flushList();
      continue;
    }
    flushList();
    out.push(el('p', { key: `p${out.length}` }, ...inline(line, `p${out.length}`, onEntity)));
  }
  flushList();
  if (code !== null) out.push(el('pre', { key: `pre${out.length}` }, code.join('\n')));
  return out;
}

/**
 * 按扩展名选择渲染方式。
 *
 * **只有 markdown 才走 markdown 渲染器**。这一点必须显式判断：
 * vault 里有 `sections.yaml` 这类 YAML 文件，其中的 `# 注释` 在 markdown 语法里
 * 是标题 —— 误渲染会把整个文件变成巨大的 `<h1>`（实测踩过）。
 */
export function renderFileBody(rel: string, text: string, onEntity?: EntityLinkHandler): React.ReactNode {
  if (/\.(md|markdown)$/i.test(rel)) {
    return el('div', { className: 'dshmem_md' }, ...renderMarkdown(text, onEntity));
  }
  return el('pre', { className: 'dshmem_plain' }, text);
}

// ── 常驻记忆面板（A 层）────────────────────────────────────────────────────

interface InstructionItem {
  index: number;
  text: string;
}
interface InstructionFile {
  items: InstructionItem[];
  full: boolean;
  max: number;
}

export function InstructionsPanel(): React.ReactElement {
  const [file, setFile] = React.useState<InstructionFile | null>(null);
  const [msg, setMsg] = React.useState<{ kind: 'warn' | 'err'; text: string } | null>(null);

  React.useEffect(() => {
    getJson<InstructionFile>('/dsh-mem/instructions')
      .then(setFile)
      .catch((e) => setMsg({ kind: 'err', text: String((e as Error).message ?? e) }));
  }, []);

  const items = file?.items ?? [];
  const max = file?.max ?? 50;

  return el(
    'div',
    null,
    el(
      'p',
      { className: 'dshmem_ins_hint' },
      '你明确要求 AI 始终记住的条目。它们每次会话都会注入上下文，' +
        '并且不参与自动整理——自动整理清库时绝不会动这里。',
    ),
    el(
      'p',
      { className: 'dshmem_ins_hint' },
      '本页只读：常驻记忆只能由 AI 通过工具修改，不接受手动增删。' +
        '要添加就直接对 AI 说「记住……」，要删除就说「忘掉……」。',
    ),
    msg !== null ? el('p', { className: 'dshmem_err' }, msg.text) : null,
    el('p', { className: 'dshmem_ins_count' }, `已保存 ${items.length} / ${max} 条`),
    items.length === 0
      ? el('p', { className: 'dshmem_muted' }, '还没有常驻记忆。对 AI 说「记住……」即可添加。')
      : el(
          'ul',
          { className: 'dshmem_ins_list' },
          ...items.map((it) =>
            el(
              'li',
              { key: `${it.index}-${it.text}`, className: 'dshmem_ins_item' },
              el('span', { className: 'dshmem_ins_idx' }, String(it.index)),
              el('span', { className: 'dshmem_ins_text' }, it.text),
            ),
          ),
        ),
  );
}

// ── 组件 ────────────────────────────────────────────────────────────────────

interface WorkspaceView {
  ok?: boolean;
  error?: string;
  registryPath?: string;
  default?: string;
  spaces?: Record<string, string>;
  partitions?: Array<{ key: string; name: string; path: string; entries: number; timelineCount: number }>;
}

/**
 * 工作区类型面板：**只读**。
 *
 * 与常驻记忆同一条原则：写入口收敛成工具（`mem_space`），UI 只展示。
 * 这里额外给出登记表文件路径 —— 那份文件是给人看、给人改的。
 */
export function WorkspacesPanel(): React.ReactElement {
  const [view, setView] = React.useState<WorkspaceView | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    getJson<WorkspaceView>('/dsh-mem/workspaces')
      .then((d) => (d.ok === false ? setErr(String(d.error ?? '读取失败')) : setView(d)))
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);

  if (err !== null) return el('p', { className: 'dshmem_err' }, err);
  if (view === null) return el('p', { className: 'dshmem_muted' }, '正在读取…');

  const keys = Object.keys(view.spaces ?? {}).sort();
  const partitions = view.partitions ?? [];
  return el(
    'div',
    { className: 'dshmem_page' },
    el('h4', null, '工作区类型'),
    el(
      'p',
      { className: 'dshmem_muted' },
      '一个工作目录的记忆进哪个空间，由「登记表 > 仓库标记（默认 .git）> default」决定。' +
        '登记某个目录，它的所有子目录都算在内。',
    ),
    el('p', { className: 'dshmem_path' }, `default: ${view.default ?? '?'}`),
    view.registryPath ? el('p', { className: 'dshmem_path' }, view.registryPath) : null,
    keys.length === 0
      ? el('p', { className: 'dshmem_muted' }, '还没有登记任何工作区。')
      : el('ul', null, ...keys.map((k) => el('li', { key: k }, `${k} → ${view.spaces?.[k] ?? ''}`))),
    el('h4', null, '已存在的项目分区'),
    partitions.length === 0
      ? el('p', { className: 'dshmem_muted' }, '还没有项目分区。')
      : el(
          'ul',
          null,
          ...partitions.map((p) =>
            el(
              'li',
              { key: p.key },
              `${p.name}${p.path ? `（${p.path}）` : ''} · ${p.entries} 条记忆、${p.timelineCount} 条时间线`,
            ),
          ),
        ),
    el(
      'p',
      { className: 'dshmem_muted' },
      '改类型：让 AI 用 mem_space 登记（例如「把这个目录登记成项目」），或直接改上面那个文件。' +
        'UI 刻意不提供改动入口 —— 与常驻记忆同一条原则。',
    ),
  );
}

export function MemorySpaceSection(): React.ReactElement {
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [space, setSpace] = React.useState<string>('instructions');
  const [tree, setTree] = React.useState<TreeNode[]>([]);
  const [open, setOpen] = React.useState<Record<string, boolean>>({ sections: true, entities: true });
  const [file, setFile] = React.useState<{ rel: string; text: string } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  /** 实体名/别名 → vault 内路径。`[[X]]` 链接靠它解析，不靠猜文件名。 */
  const [entityMap, setEntityMap] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    getJson<Overview>('/dsh-mem/overview')
      .then(setOverview)
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);

  React.useEffect(() => {
    // 常驻记忆是独立面板，不用文件树
    if (space === 'instructions') return;
    setFile(null);
    getJson<{ tree: TreeNode[] }>(`/dsh-mem/tree?space=${encodeURIComponent(space)}`)
      .then((d) => setTree(d.tree))
      .catch((e) => setErr(String(e.message ?? e)));
    // 实体目录：名/别名 → 路径，供 `[[X]]` 跳转
    getJson<{ entities: Array<{ name: string; path: string; aliases?: string[] }> }>(
      `/dsh-mem/entities?space=${encodeURIComponent(space)}`,
    )
      .then((d) => {
        const map: Record<string, string> = {};
        for (const e of d.entities ?? []) {
          map[e.name] = e.path;
          for (const a of e.aliases ?? []) map[a] = e.path;
        }
        setEntityMap(map);
      })
      .catch(() => setEntityMap({}));
  }, [space]);

  const openFile = React.useCallback(
    (rel: string) => {
      getJson<{ rel: string; text: string }>(
        `/dsh-mem/file?space=${encodeURIComponent(space)}&rel=${encodeURIComponent(rel)}`,
      )
        .then((d) => setFile({ rel: d.rel, text: d.text }))
        .catch((e) => setErr(String(e.message ?? e)));
    },
    [space],
  );

  /** 点 `[[X]]`：先查实体目录，查不到再退回同名文件约定。 */
  const openEntity = React.useCallback(
    (name: string) => {
      const rel = entityMap[name] ?? `entities/${name}.md`;
      openFile(rel);
    },
    [entityMap, openFile],
  );

  // **只有三个**：常驻记忆（含全局共用）/ 聊天记忆 / 项目记忆。
  // 项目**不各占一个 tab** —— 它们是「项目记忆」里 `projects/` 下的子目录，
  // 在右侧文件树里点进去。这样 tab 数不随项目数增长。
  const tabs: Array<{ id: string; label: string }> = [
    { id: 'instructions', label: '常驻记忆' },
    { id: 'chat', label: '聊天记忆' },
    { id: 'project', label: '项目记忆' },
  ];

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode[] =>
    nodes.flatMap((n) => {
      const pad = 8 + depth * 12;
      if (n.type === 'dir') {
        const isOpen = open[n.path] ?? false;
        const row = el(
          'div',
          {
            key: n.path,
            className: 'dshmem_row dshmem_dir',
            style: { paddingLeft: `${pad}px` },
            onClick: () => setOpen((prev) => ({ ...prev, [n.path]: !isOpen })),
          },
          el('span', { className: 'dshmem_caret' }, isOpen ? '▾' : '▸'),
          el('span', null, `${n.name}/`),
        );
        return isOpen ? [row, ...renderNodes(n.children ?? [], depth + 1)] : [row];
      }
      const on = file?.rel === n.path;
      return [
        el(
          'div',
          {
            key: n.path,
            className: `dshmem_row${on ? ' dshmem_row_on' : ''}`,
            style: { paddingLeft: `${pad + 10}px` },
            onClick: () => openFile(n.path),
          },
          el('span', null, n.name),
        ),
      ];
    });

  return el(
    'div',
    { className: 'dshmem_page' },
    el('h2', { className: 'dshmem_title' }, '记忆空间'),
    err !== null ? el('p', { className: 'dshmem_err' }, err) : null,
    overview
      ? el(
          'div',
          { className: 'dshmem_bar' },
          ...tabs.map((t) =>
            el(
              'button',
              {
                key: t.id,
                className: `dshmem_tab${space === t.id ? ' dshmem_tab_on' : ''}`,
                onClick: () => setSpace(t.id),
              },
              t.label,
            ),
          ),
          el('span', { className: 'dshmem_muted' }, `索引 ${overview.indexEntries} 条`),
        )
      : el('p', { className: 'dshmem_muted' }, '正在读取…'),
    space === 'instructions'
      ? el('div', { className: 'dshmem_card' }, el('div', { className: 'dshmem_body' }, el(InstructionsPanel, null)))
      : el(
          'div',
          { className: 'dshmem_card' },
          el('div', { className: 'dshmem_tree' }, ...renderNodes(tree, 0)),
          el(
            'div',
            { className: 'dshmem_body' },
            file
              ? el(
                  'div',
                  null,
                  el('p', { className: 'dshmem_path' }, file.rel),
                  renderFileBody(file.rel, file.text, openEntity),
                )
              : el('p', { className: 'dshmem_muted' }, '从左侧选一个文件。'),
          ),
        ),
    // 工作区类型：放在项目记忆这一页的**折叠块**里，不另开一个设置段。
    // 它决定"哪些目录算项目"，与这一页直接相关，放这儿最贴题。
    space === 'project'
      ? el(
          'details',
          { className: 'dshmem_card' },
          el('summary', { className: 'dshmem_muted' }, '工作区类型（哪些目录算项目）'),
          el(WorkspacesPanel, null),
        )
      : null,
  );
}

// ── 挂载 ────────────────────────────────────────────────────────────────────

interface ClientCtx {
  slots: {
    inject(name: string, cb: () => unknown): () => void;
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
  logger?: { info(m: string): void; warn(m: string): void };
}

export function applySettingsPage(ctx: ClientCtx): () => void {
  // CSS 只注入一次，靠 data-plugin-css 属性防重复
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-mem';
    tag.dataset.pluginCss = CSS_ID;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  const disposers: Array<() => void> = [];
  const register = (id: string, order: number, label: string, component: unknown): void => {
    try {
      const d = ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id, order, label: () => label, inject: (): unknown => ({}) },
          component,
        ),
      );
      if (typeof d === 'function') disposers.push(d);
      ctx.logger?.info(`[dsh-mem] 设置段「${label}」已注册`);
    } catch (e) {
      ctx.logger?.warn(`[dsh-mem] 设置段「${label}」注册失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  register(SECTION_ID, 36, '记忆空间', MemorySpaceSection);

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
