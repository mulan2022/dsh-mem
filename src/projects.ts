/**
 * 项目分区元信息 + 其它项目的**轻量指针**（P4.6，设计文档 §4.2.4）。
 *
 * 设计文档原本写的是 mem 根下一个中心化的 `projects.yaml`（分区 key → path/name）。
 * 实现改成**每个分区自带一份 `meta.yaml`**：
 * 分区被搬走、备份、复制时元信息跟着走；也不会出现"注册表说有这个项目、
 * 目录却不在了"这种两边对不上的状态。少一个会失同步的文件，就少一类 bug。
 *
 * 指针是"其它项目分区不主动注入"这个约束的**出口**：用户提到别的项目时，
 * 只给一行摘要（有几条记忆、几条时间线），正文要靠 AI 主动 `mem_search` 取。
 * 这样既不污染上下文，又不至于让 AI 完全不知道那个项目的存在。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { listVaultTree, readVaultFile, VAULT, writeVaultFile } from './vault.js';

export const META_FILE = 'meta.yaml';

export interface ProjectMeta {
  key: string;
  /** 项目根的规范化路径。 */
  path: string;
  /** 显示名（默认取 path 的最后一段）。 */
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

/** 从分区目录名推一个可读的默认名（`D--demo-MemoryChat` → `MemoryChat`）。 */
export function defaultProjectName(key: string): string {
  const seg = key.split('-').filter((s) => s !== '');
  return seg.length > 0 ? seg[seg.length - 1] : key;
}

function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function readProjectMeta(vaultDir: string): ProjectMeta | null {
  const text = readVaultFile(vaultDir, META_FILE);
  if (text === null) return null;
  const a = parseFlatYaml(text);
  if (!a.key) return null;
  return {
    key: a.key,
    path: a.path ?? '',
    name: a.name ?? defaultProjectName(a.key),
    createdAt: a.created_at ?? '',
    lastSeenAt: a.last_seen_at ?? '',
  };
}

/** 确保分区里有 meta.yaml；已存在则只刷新 `last_seen_at`。 */
export function ensureProjectMeta(vaultDir: string, key: string, root: string, now = new Date()): ProjectMeta {
  const iso = now.toISOString();
  const existing = readProjectMeta(vaultDir);
  const meta: ProjectMeta = existing
    ? { ...existing, key, path: root, lastSeenAt: iso }
    : {
        key,
        path: root,
        name: root ? basename(root.replace(/[\\/]+$/, '')) || defaultProjectName(key) : defaultProjectName(key),
        createdAt: iso,
        lastSeenAt: iso,
      };
  writeVaultFile(
    vaultDir,
    META_FILE,
    [
      '# 项目分区元信息（由 dsh-mem 维护；删掉会在下次进入时重建）',
      `key: ${meta.key}`,
      `path: ${meta.path}`,
      `name: ${meta.name}`,
      `created_at: ${meta.createdAt}`,
      `last_seen_at: ${meta.lastSeenAt}`,
      '',
    ].join('\n'),
  );
  return meta;
}

/** 一个分区的概览：给"其它项目指针"用。 */
export interface ProjectBrief {
  key: string;
  dir: string;
  name: string;
  path: string;
  /** 顶层文件/目录数（vault 的体量感）。 */
  entries: number;
  /** 时间线条目数（timeline.md 里的 `- ` 行）。 */
  timelineCount: number;
  /** 是否已经初始化过（有 meta.yaml 或 README）。 */
  initialized: boolean;
}

/**
 * 列出所有项目概览。
 *
 * @param entriesDir 项目记忆的 `projects/` 目录
 * @param entryNames 各项目目录名（= 人类可读的项目名）
 *
 * **`key` 取的是 meta.yaml 里的分区 key，不是目录名** —— 现在目录名是
 * `MemoryChat` 这类人类可读的名字，两者不再相同。名字变了但 key 没变，
 * 所以拿目录名当 key 会让"当前项目"判定默默失配。
 */
export function listProjectBriefs(entriesDir: string, entryNames: readonly string[]): ProjectBrief[] {
  return entryNames.map((entryName) => {
    const dir = join(entriesDir, entryName);
    const meta = readProjectMeta(dir);
    const timeline = readVaultFile(dir, 'timeline.md') ?? '';
    const timelineCount = timeline.split(/\r?\n/).filter((l) => l.startsWith('- ')).length;
    return {
      key: meta?.key ?? entryName,
      dir,
      name: meta?.name ?? defaultProjectName(entryName),
      path: meta?.path ?? '',
      entries: listVaultTree(dir).length,
      timelineCount,
      initialized: meta !== null || existsSync(join(dir, VAULT.readme)),
    };
  });
}

/**
 * 判断用户这条消息提到的是哪个**别的**项目。
 *
 * 命中口径：项目名 / 项目路径 / 分区 key 出现在消息里。
 * 名字太短（<2 字符）不参与 —— 那会到处误命中。
 */
export function mentionedProjects(
  briefs: readonly ProjectBrief[],
  currentKey: string | null,
  userText: string,
): ProjectBrief[] {
  if (!userText) return [];
  const lower = userText.toLowerCase();
  const out: ProjectBrief[] = [];
  for (const b of briefs) {
    if (b.key === currentKey) continue;
    if (!b.initialized) continue; // 空分区不值得提
    const keys = [b.name, b.path, b.key].filter((k) => k.trim().length >= 2);
    if (keys.some((k) => lower.includes(k.toLowerCase()))) out.push(b);
  }
  return out;
}

/**
 * 渲染「其它项目的轻量指针」。
 *
 * 刻意**只给规模与入口，不给正文**：正文要用 `mem_search` 主动取。
 * 这正是"别的项目不主动注入"与"但要知道它存在"之间的那条线。
 */
export function renderPointers(briefs: readonly ProjectBrief[]): string | null {
  if (briefs.length === 0) return null;
  const lines = briefs.map((b) => {
    const where = b.path ? `（${b.path}）` : '';
    return `- **${b.name}**${where}：${b.entries} 条记忆、${b.timelineCount} 条时间线记录`;
  });
  return [
    '你提到了下列**其它项目**。它们的正文**没有**被放进上下文（项目之间互不注入），',
    '这里只给规模。需要细节时用 `mem_search` 跨项目检索。',
    '',
    ...lines,
  ].join('\n');
}

/** 供测试：把 meta 里的字段读回来（不经过文件系统）。 */
export function parseProjectMetaText(text: string, key: string): ProjectMeta {
  const a = parseFlatYaml(text);
  return {
    key: a.key ?? key,
    path: a.path ?? '',
    name: a.name ?? defaultProjectName(a.key ?? key),
    createdAt: a.created_at ?? '',
    lastSeenAt: a.last_seen_at ?? '',
  };
}

/** 读原始 meta 文本（测试用）。 */
export function readMetaText(vaultDir: string): string | null {
  try {
    return readFileSync(join(vaultDir, META_FILE), 'utf8');
  } catch {
    return null;
  }
}
