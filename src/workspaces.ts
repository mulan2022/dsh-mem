/**
 * 工作区类型登记表（P4.6，设计文档 §4.2 / §4.2.7）。
 *
 * 回答的问题：**这个工作目录的记忆该进哪个空间？**
 *
 * 判定顺序（`resolveWorkspace`）：
 *   1. 登记表里有 → 用登记的类型（**显式压过一切**，包括仓库标记）
 *   2. 没登记，但 cwd 向上能找到项目根标记（默认 `.git`）→ 项目
 *   3. 都没命中 → 按 `default`：`chat` / `project` / `ask`
 *
 * `ask` 的语义是"**首次进入时问一次**"，问过就记进 `state.json`，不再反复打扰
 * （反复问等于每次开会话都念一遍，用户会直接把这个插件关掉）。
 * 在用户回答之前，按**聊天空间**兜底 —— 那是破坏性最小的选择：
 * 记错成聊天只是散一点，记错成项目会把内容关进一个用户根本不知道的分区。
 *
 * 这张表**可以手改**（改完下次会话生效），也可以由 AI 在用户明确表态时
 * 通过 `mem_space` 工具写入。刻意不提供 HTTP 写接口 —— 与常驻记忆同样的理由。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readState, updateState } from './state.js';

import { findProjectRootOrNull, normalizeWorkspacePath, projectKey, workspacesYamlPath } from './paths.js';

export type WorkspaceKind = 'chat' | 'project';

/**
 * 「聊天模式」agent preset 的 id（= `.agent-presets/` 下的目录名，**不是显示名**）。
 *
 * 用户选了这个 preset 就是**明确声明**"这是聊天" —— 比从 cwd 猜准得多。
 * preset 是用户声明的意图，压过登记表与仓库标记（见 README「聊天 / 项目两套记忆空间」）。
 */
export const CHAT_PRESET_ID = 'chat';
export type DefaultPolicy = 'ask' | 'chat' | 'project';

export interface WorkspaceRegistry {
  /** 规范化路径（盘符小写、正斜杠）→ 类型。 */
  spaces: Record<string, WorkspaceKind>;
  default: DefaultPolicy;
}

export const EMPTY_REGISTRY: WorkspaceRegistry = { spaces: {}, default: 'ask' };

/**
 * 登记表用的路径键：统一正斜杠 + **盘符小写**。
 *
 * 只小写盘符、不整条小写：Windows 路径大小写不敏感，盘符大小写几乎必然不一致；
 * 而整条小写会在 Linux 上把两个只差大小写的目录悄悄并成一个 —— 静默合并比不匹配更糟。
 */
export function registryKey(p: string): string {
  return normalizeWorkspacePath(p).replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);
}

function isKind(v: string): v is WorkspaceKind {
  return v === 'chat' || v === 'project';
}

function isPolicy(v: string): v is DefaultPolicy {
  return v === 'ask' || v === 'chat' || v === 'project';
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * 解析登记表。刻意不引 YAML 依赖 —— 这是我们自己定义、自己写、形状极规整的文件。
 * 认不出的行**跳过而不是抛**：用户手改文件时打错一行，不该让整个插件起不来。
 */
export function parseRegistry(text: string): WorkspaceRegistry {
  const reg: WorkspaceRegistry = { spaces: {}, default: 'ask' };
  let inSpaces = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      inSpaces = /^spaces\s*:/.test(body);
      if (!inSpaces) {
        const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(body);
        if (m && m[1] === 'default' && isPolicy(unquote(m[2]))) reg.default = unquote(m[2]) as DefaultPolicy;
      }
      continue;
    }
    if (!inSpaces) continue;

    const m = /^(".*?"|'.*?'|\S+)\s*:\s*(\S+)\s*$/.exec(body);
    if (!m) continue;
    const key = unquote(m[1]);
    const kind = unquote(m[2]);
    if (!key || !isKind(kind)) continue;
    reg.spaces[registryKey(key)] = kind;
  }
  return reg;
}

/** 渲染登记表（带解释性注释，因为它是给人看、给人改的）。 */
export function renderRegistry(reg: WorkspaceRegistry): string {
  const keys = Object.keys(reg.spaces).sort();
  const lines = [
    '# dsh-mem 工作区类型登记表',
    '#',
    '# 决定"这个工作目录的记忆进哪个空间"：',
    '#   project → 项目空间（按目录分区，项目之间互不注入）',
    '#   chat    → 聊天空间（价值观、态度、沟通风格）',
    '#',
    '# 判定顺序：登记表 > 仓库标记（默认 .git）> default。',
    '# 登记了某个目录，它的所有子目录都算登记在内。',
    '#',
    '# 这张表可以手改（改完下次会话生效），也可以让 AI 用 mem_space 工具写。',
    '#',
    '# default 是未登记工作区的兜底：',
    '#   ask     → 首次进入时在会话里问一次（问过就不再问）',
    '#   chat    → 一律当聊天空间',
    '#   project → 一律当项目空间',
    '',
    `default: ${reg.default}`,
    '',
    'spaces:',
  ];
  for (const k of keys) lines.push(`  "${k}": ${reg.spaces[k]}`);
  return `${lines.join('\n')}\n`;
}

export function readRegistry(home: string): WorkspaceRegistry {
  const path = workspacesYamlPath(home);
  try {
    return parseRegistry(readFileSync(path, 'utf8'));
  } catch {
    return { spaces: {}, default: 'ask' };
  }
}

export function writeRegistry(home: string, reg: WorkspaceRegistry): boolean {
  const path = workspacesYamlPath(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderRegistry(reg), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 若文件不存在则写下带注释的骨架（让用户/开发者一眼看懂格式）。 */
export function ensureRegistryFile(home: string): boolean {
  const path = workspacesYamlPath(home);
  if (existsSync(path)) return false;
  return writeRegistry(home, EMPTY_REGISTRY);
}

/** 登记一个工作区（覆盖旧的类型）。 */
export function setWorkspaceKind(
  home: string,
  workspacePath: string,
  kind: WorkspaceKind,
): { ok: boolean; key: string; registry: WorkspaceRegistry } {
  const key = registryKey(workspacePath);
  const reg = readRegistry(home);
  reg.spaces[key] = kind;
  const ok = writeRegistry(home, reg);
  return { ok, key, registry: reg };
}

/** 取消登记。 */
export function removeWorkspace(home: string, workspacePath: string): { ok: boolean; key: string } {
  const key = registryKey(workspacePath);
  const reg = readRegistry(home);
  const existed = Object.prototype.hasOwnProperty.call(reg.spaces, key);
  delete reg.spaces[key];
  return { ok: existed && writeRegistry(home, reg), key };
}

export interface WorkspaceResolution {
  kind: WorkspaceKind;
  /** 判定来源。`unregistered` = 没登记、没标记、兜底是 ask。 */
  source: 'preset' | 'explicit' | 'marker' | 'default' | 'unregistered';
  /** 登记表里命中的那个路径（归一化后）；没有则 null。 */
  registeredPath: string | null;
  /** 项目根（kind=project 时）；聊天空间为 null。 */
  root: string | null;
  /** 项目分区 key（kind=project 时）。 */
  key: string | null;
  /** 这个路径是否出现在登记表里。 */
  registered: boolean;
}

/**
 * 在登记表里向上找匹配（登记了某目录，其子目录也算登记）。
 *
 * @returns 命中的登记路径与类型；没有则 null
 */
export function matchRegistered(
  reg: WorkspaceRegistry,
  cwd: string,
): { path: string; kind: WorkspaceKind } | null {
  let dir = resolve(cwd);
  for (;;) {
    const key = registryKey(dir);
    const kind = reg.spaces[key];
    if (kind !== undefined) return { path: key, kind };
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 判定一个工作目录该用哪个空间。**这是唯一入口** ——
 * 观察的落点、时间线的落点、注入哪些 vault，全部走这里，
 * 不允许调用方各自再推一遍（各写一套迟早会分叉）。
 */
export function resolveWorkspace(
  home: string,
  cwd: string | null,
  markers: readonly string[],
  agentPreset: string | null = null,
): WorkspaceResolution {
  // ★ preset 优先于一切（§4.2.7）：选 preset 是**用户声明的意图**，
  // 而登记表/仓库标记是"这个目录属于谁"的**环境事实** —— 两者不冲突时意图该赢。
  // 读不到 preset 时传 null（老客户端、投影未就绪），原样走下面那套。
  if (agentPreset === CHAT_PRESET_ID) {
    return {
      kind: 'chat',
      source: 'preset',
      registeredPath: null,
      root: null,
      key: null,
      registered: false,
    };
  }

  if (cwd === null || cwd.length === 0) {
    return { kind: 'chat', source: 'default', registeredPath: null, root: null, key: null, registered: false };
  }

  const reg = readRegistry(home);
  const hit = matchRegistered(reg, cwd);
  if (hit !== null) {
    if (hit.kind === 'chat') {
      return {
        kind: 'chat',
        source: 'explicit',
        registeredPath: hit.path,
        root: null,
        key: null,
        registered: true,
      };
    }
    // 显式登记为项目时，**登记的那个路径就是项目根** —— 不再往下找 `.git`。
    // 否则"登记了 D:/demo/x，但里面某个子目录恰好有 .git"会把一个项目劈成两半。
    const root = hit.path;
    return {
      kind: 'project',
      source: 'explicit',
      registeredPath: hit.path,
      root,
      key: projectKey(root),
      registered: true,
    };
  }

  const markerRoot = findProjectRootOrNull(cwd, markers);
  if (markerRoot !== null) {
    return {
      kind: 'project',
      source: 'marker',
      registeredPath: null,
      root: markerRoot,
      key: projectKey(markerRoot),
      registered: false,
    };
  }

  if (reg.default === 'project') {
    const root = normalizeWorkspacePath(cwd);
    return {
      kind: 'project',
      source: 'default',
      registeredPath: null,
      root,
      key: projectKey(root),
      registered: false,
    };
  }
  if (reg.default === 'chat') {
    return { kind: 'chat', source: 'default', registeredPath: null, root: null, key: null, registered: false };
  }
  // default: ask —— 在用户回答之前按聊天空间兜底（破坏性最小的那个选择）
  return { kind: 'chat', source: 'unregistered', registeredPath: null, root: null, key: null, registered: false };
}

// ---------------------------------------------------------------------------
// 「问过就不再问」的状态（不是记忆，是插件状态，所以不放 vault）
//
// 真正的读写收敛在 `state.ts` —— dream 也要写同一个文件，
// 两边各写各的读-改-写会互相盖掉。
// ---------------------------------------------------------------------------

export function wasAsked(home: string, cwd: string): boolean {
  return readState(home).asked[registryKey(cwd)] !== undefined;
}

export function markAsked(home: string, cwd: string): void {
  updateState(home, (s) => {
    s.asked[registryKey(cwd)] = new Date().toISOString();
  });
}
