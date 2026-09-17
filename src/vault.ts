/**
 * Vault：markdown 文件是**唯一事实源**，SQLite 只是可重建的派生索引。
 *
 * 设计文档 §4 / §3 的三层置信度：
 *   raw/               原始素材（未加工）
 *   observations.md    暂存区：信号弱、未确证 —— 不常驻、不进 README
 *   sections/ entities/ + README.md + index.md   确证区
 *
 * 本模块只负责**文件层的读写与目录约定**，不做任何语义加工。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** vault 内部固定文件名与目录，集中在这里避免各处硬编码。 */
export const VAULT = {
  readme: 'README.md',
  index: 'index.md',
  observations: 'observations.md',
  log: 'log.md',
  sectionsYaml: 'sections.yaml',
  sectionsDir: 'sections',
  entitiesDir: 'entities',
  rawDir: 'raw',
  timelineDir: 'raw/timeline',
  timelineSummary: 'timeline.md',
} as const;

/** 一个 vault 目录的标准子目录（初始化时创建）。 */
const VAULT_DIRS = [
  VAULT.sectionsDir,
  VAULT.entitiesDir,
  VAULT.rawDir,
  VAULT.timelineDir,
] as const;

export interface TreeNode {
  /** vault 内相对路径，统一正斜杠 */
  path: string;
  name: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: number;
  children?: TreeNode[];
}

/**
 * 确保一个 vault 目录具备标准结构。
 *
 * @param dir - vault 根目录（如 `spaces/chat`）
 * @param seed - 需要写入的初始文件（只在文件**不存在**时写，绝不覆盖用户内容）
 * @returns 本次实际创建的文件相对路径
 */
export function ensureVaultLayout(
  dir: string,
  seed: Readonly<Record<string, string>> = {},
): string[] {
  mkdirSync(dir, { recursive: true });
  for (const sub of VAULT_DIRS) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  const created: string[] = [];
  for (const [rel, text] of Object.entries(seed)) {
    const abs = join(dir, rel);
    if (existsSync(abs)) continue;
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text, 'utf8');
    created.push(rel);
  }
  return created;
}

/**
 * 把用户/插件给出的相对路径限制在 vault 内。
 * 拒绝绝对路径与任何逃逸（`..`）—— 文件树由前端传入，必须当作不可信输入。
 *
 * @returns 绝对路径，或 null 表示越界
 */
export function resolveInsideVault(vaultDir: string, rel: string): string | null {
  if (!rel) return null;
  if (rel.includes('\0')) return null;
  const root = resolve(vaultDir);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/** 读取 vault 内的一个文本文件。越界或非文件返回 null。 */
export function readVaultFile(vaultDir: string, rel: string): string | null {
  const abs = resolveInsideVault(vaultDir, rel);
  if (!abs) return null;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** 写入 vault 内的一个文本文件（自动建父目录）。越界返回 false。 */
export function writeVaultFile(vaultDir: string, rel: string, text: string): boolean {
  const abs = resolveInsideVault(vaultDir, rel);
  if (!abs) return false;
  try {
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text, 'utf8');
    return true;
  } catch {
    return false;
  }
}

const IGNORED_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store']);

/**
 * 递归列出一棵目录树，供记忆空间 UI 的文件树使用。
 *
 * 排序：目录在前，同级按名称；两次遍历（先目录后文件）保证稳定。
 */
export function listVaultTree(vaultDir: string, maxDepth = 6): TreeNode[] {
  if (!existsSync(vaultDir)) return [];

  function walk(dir: string, depth: number): TreeNode[] {
    if (depth > maxDepth) return [];
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs: TreeNode[] = [];
    const files: TreeNode[] = [];
    for (const e of entries) {
      if (IGNORED_ENTRIES.has(e.name)) continue;
      const abs = join(dir, e.name);
      const rel = relative(vaultDir, abs).split(sep).join('/');
      if (e.isDirectory()) {
        dirs.push({ path: rel, name: e.name, type: 'dir', children: walk(abs, depth + 1) });
      } else if (e.isFile()) {
        let size: number | undefined;
        let mtime: number | undefined;
        try {
          const st = statSync(abs);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          /* 竞态：文件刚好被删，忽略元数据 */
        }
        files.push({ path: rel, name: e.name, type: 'file', size, mtime });
      }
    }
    const collate = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, 'zh');
    return [...dirs.sort(collate), ...files.sort(collate)];
  }

  return walk(vaultDir, 1);
}

/** vault 内所有 markdown 文件的相对路径（索引重建用）。 */
export function walkMarkdown(vaultDir: string, skipDirs: readonly string[] = ['raw']): string[] {
  const out: string[] = [];
  if (!existsSync(vaultDir)) return out;
  const skip = new Set(skipDirs.map((d) => d.replace(/\/+$/, '')));

  function walk(dir: string): void {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORED_ENTRIES.has(e.name)) continue;
      const abs = join(dir, e.name);
      const rel = relative(vaultDir, abs).split(sep).join('/');
      if (e.isDirectory()) {
        if (skip.has(rel) || skip.has(e.name)) continue;
        walk(abs);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(rel);
      }
    }
  }

  walk(vaultDir);
  return out.sort();
}
